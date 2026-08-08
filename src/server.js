import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, MAX_BOOK_BYTES, MAX_JSON_BYTES, MAX_VOICE_BYTES, MAX_VOICE_SOURCE_BYTES,
  MAX_VOICE_CLIP_MS, MIN_VOICE_CLIP_MS, PROJECTS_DIR, PUBLIC_DIR, TTS_ENGINES,
  VOICES_DIR, EXPORTS_DIR, EMOTIONS
} from './lib/config.js';
import { engineCompatibility, getSystemProfile } from './lib/system.js';
import {
  createProject, createVoice, deleteVoice, findVoiceReferences, getProject, getSettings, getVoice, initStore, listProjects,
  listVoices, mergeRoles, mutateProject, replaceProjectSource, summarizeProject, updateSettings
} from './lib/store.js';
import { decodeBook, normalizeNovelText } from './lib/novel.js';
import {
  chapterToScriptSnapshot, convertChapter, createCodexPackage, normalizeImportedScript, runCodexSession
} from './lib/script-engine.js';
import {
  appendCodexTurn, createCodexSession, findCodexSession, publicCodexSession,
  publicCodexSessions, saveCodexSession
} from './lib/codex-sessions.js';
import {
  assertLocalHostRequest, assertLoopbackRequest, assertSameOriginRequest, CodexLoginManager
} from './lib/codex-login.js';
import { CodexProgressManager } from './lib/codex-progress.js';
import {
  codexTimeoutMinutesToMs,
  DEFAULT_CODEX_TIMEOUT_MINUTES,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes
} from './lib/codex-options.js';
import {
  codexActivitySensitiveTexts,
  createCodexRedactionContext,
  normalizeCodexDetailLevel,
  sanitizeCodexActivitySummary
} from './lib/codex-activity.js';
import { JobManager } from './lib/jobs.js';
import { exportProjectWav, renderLines } from './lib/tts.js';
import {
  claimVoiceSource, deleteVoiceSource, extractVoiceFromSource, resetVoiceSourceWorkspace,
  saveVoiceSource, validateVoiceExtraction
} from './lib/video-voice.js';
import {
  clamp, decodeBase64Payload, isPathInside, json, mediaType, nowIso, parseJsonBody, safeName, text
} from './lib/utils.js';

const jobs = new JobManager(path.join(DATA_DIR, 'jobs.json'));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const codexSessionLocks = new Map();

function assertLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const url = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw Object.assign(new Error('拒绝非本地页面发起的写入请求'), { statusCode: 403 });
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error('Origin 无效'), { statusCode: 403 });
  }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const expression = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  })}$`);
  const match = pathname.match(expression);
  if (!match) return null;
  return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
}

async function sendFile(req, res, filePath, { cache = false } = {}) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
  const type = mediaType(filePath);
  const range = req.headers.range;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cache ? 'no-cache' : 'no-store'
  };
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(filePath, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(filePath), res);
}

function findChapter(project, chapterId) {
  const chapter = project.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw Object.assign(new Error('章节不存在'), { statusCode: 404 });
  return chapter;
}

function findLine(project, lineId) {
  for (const chapter of project.chapters) {
    for (const scene of chapter.scenes || []) {
      const line = scene.lines?.find((item) => item.id === lineId);
      if (line) return { chapter, scene, line };
    }
  }
  throw Object.assign(new Error('台词不存在'), { statusCode: 404 });
}

function withCodexSessionLock(key, operation) {
  const previous = codexSessionLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  codexSessionLocks.set(key, next);
  return next.finally(() => {
    if (codexSessionLocks.get(key) === next) codexSessionLocks.delete(key);
  });
}

function codexChapterVersion(chapter) {
  return JSON.stringify({
    title: chapter.title,
    sourceText: chapter.sourceText,
    scenes: chapter.scenes || [],
    scriptWarnings: chapter.scriptWarnings || [],
    scriptedAt: chapter.scriptedAt || null,
    status: chapter.status || null
  });
}

function assertCodexChapterUnchanged(chapter, expectedVersion) {
  if (codexChapterVersion(chapter) === expectedVersion) return;
  throw Object.assign(new Error('Codex 处理期间本章剧本已被修改。为保护最新手工稿，本轮结果没有覆盖项目；请确认当前内容后重新发送。'), {
    statusCode: 409,
    code: 'CODEX_CHAPTER_CHANGED'
  });
}

function codexMode(value) {
  return ['faithful', 'polished', 'drama'].includes(value) ? value : 'faithful';
}

function codexModel(value) {
  return normalizeCodexModel(value);
}

function codexPrompt(value, { required = false } = {}) {
  const prompt = String(value || '').trim();
  if (required && !prompt) throw Object.assign(new Error('请输入本轮调整要求'), { statusCode: 400, code: 'CODEX_PROMPT_REQUIRED' });
  if (prompt.length > 4000) throw Object.assign(new Error('单轮调整要求不能超过 4000 字'), { statusCode: 400, code: 'CODEX_PROMPT_TOO_LONG' });
  return prompt;
}

async function codexRuntimeSettings(settings) {
  const profile = await getSystemProfile(settings, { refresh: true });
  const tool = profile.tools?.codex || {};
  if (!tool.runnable) {
    const message = tool.state === 'authRequired'
      ? 'Codex CLI 尚未登录。请先在本机终端运行 codex login，登录完成后再试。'
      : tool.error || 'Codex CLI 当前不可用，请在模型中心检查命令路径。';
    throw Object.assign(new Error(message), {
      statusCode: 409,
      code: tool.state === 'authRequired' ? 'CODEX_AUTH_REQUIRED' : 'CODEX_UNAVAILABLE'
    });
  }
  const command = tool.resolvedCommand || tool.resolvedPath || tool.path || settings.codexCommand || 'codex';
  return { ...settings, codexCommand: command };
}

function resolveCodexLogin(profile) {
  const tool = profile?.tools?.codex || {};
  if (tool.runnable || tool.state === 'ready') return { authenticated: true };
  if (tool.state !== 'authRequired' || !tool.resolvedCommand) {
    throw Object.assign(new Error('Codex CLI 当前不可用，请先在模型中心检查安装状态。'), {
      statusCode: 409, code: 'CODEX_UNAVAILABLE'
    });
  }
  return { authenticated: false, command: tool.resolvedCommand };
}

async function assertNoCodexAuthOptions(req) {
  const body = await parseJsonBody(req, 1_024);
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
    throw Object.assign(new Error('Codex 登录不接受命令、参数或其他客户端选项。'), {
      statusCode: 400, code: 'CODEX_AUTH_OPTIONS_NOT_ALLOWED'
    });
  }
}

function codexFailureStatus(error, timeoutMinutes = DEFAULT_CODEX_TIMEOUT_MINUTES) {
  const code = String(error?.code || 'CODEX_REQUEST_FAILED').toUpperCase();
  const safeTimeoutMinutes = normalizeCodexTimeoutMinutes(timeoutMinutes);
  const statusCode = error?.statusCode
    || (code.startsWith('CODEX_TIMEOUT') ? 504 : code === 'CODEX_UNAVAILABLE' ? 503 : 502);
  const messages = {
    CODEX_AUTH_REQUIRED: 'Codex CLI 尚未登录，请先完成本机登录。',
    CODEX_CANCELLED: 'Codex 请求已因服务关闭而取消。',
    CODEX_CHAPTER_CHANGED: '处理期间本章已被修改，本轮结果没有覆盖最新内容。',
    CODEX_TIMEOUT: `Codex 未能在 ${safeTimeoutMinutes} 分钟内完成处理，请稍后重试。`,
    CODEX_TIMEOUT_ACTIVE: `Codex 已开始生成，但未在 ${safeTimeoutMinutes} 分钟内完成，请缩短章节、降低推理强度或延长超时后重试。`,
    CODEX_TIMEOUT_STARTING: `Codex 未能在 ${safeTimeoutMinutes} 分钟内开始响应，请检查网络、登录状态和模型可用性。`,
    CODEX_UNAVAILABLE: 'Codex CLI 当前不可用，请检查模型中心状态。',
    SCRIPT_SCHEMA_INVALID: 'Codex 返回的剧本结构未通过校验，当前章节未被覆盖。'
  };
  return Object.assign(new Error(messages[code] || 'Codex 本轮处理失败，请检查状态后重试。'), {
    statusCode,
    code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'CODEX_REQUEST_FAILED'
  });
}

function assertCodexWorkspaceRequest(req) {
  assertLoopbackRequest(req);
  assertLocalHostRequest(req);
  assertSameOriginRequest(req);
}

function codexAsyncRequested(body) {
  return body?.stream === true;
}

function codexAccepted(progress) {
  return {
    progressId: progress.progressId,
    detailLevel: progress.detailLevel,
    model: progress.model,
    reasoningEffort: progress.reasoningEffort,
    timeoutMinutes: progress.timeoutMinutes,
    state: progress.state,
    eventsUrl: progress.eventsUrl
  };
}

function assertCodexRunActive(signal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('Codex 请求已因服务关闭而取消。'), {
    statusCode: 503,
    code: 'CODEX_CANCELLED'
  });
}

function trackCodexOperation(progressManager, progress, scope, operation) {
  const task = Promise.resolve().then(operation);
  progressManager.track(progress.progressId, scope.projectId, scope.chapterId, task);
  return task;
}

function runCodexInBackground(progressManager, progress, scope, operation) {
  const progressId = progress.progressId;
  const task = trackCodexOperation(progressManager, progress, scope, operation).then(
    () => progressManager.complete(progressId),
    (error) => progressManager.fail(progressId, error?.code)
  );
  void task.catch(() => {});
  return task;
}

const CODEX_RUNNER_PROGRESS = new Set([
  'thread:started', 'turn:started', 'turn:completed',
  'stage:analyzing', 'stage:drafting', 'stage:processing', 'stage:validating'
]);

const CODEX_RUNNER_ACTIVITY = new Map([
  ['reasoning_summary:reasoning_summary', 'reasoning_summary'],
  ['activity:command', 'command'],
  ['activity:file', 'file'],
  ['activity:mcp', 'mcp'],
  ['activity:web', 'web'],
  ['activity:collaboration', 'collaboration'],
  ['activity:plan', 'plan'],
  ['activity:tool', 'tool']
]);

function publishCodexRunnerProgress(progressManager, progressId, event, redactionContext) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const phase = typeof event?.phase === 'string' ? event.phase : '';
  if (CODEX_RUNNER_PROGRESS.has(`${type}:${phase}`)) {
    progressManager.publish(progressId, { type, phase });
    return;
  }
  if (type !== 'activity') return;
  const category = typeof event?.category === 'string' ? event.category : '';
  if (CODEX_RUNNER_ACTIVITY.get(`${phase}:${category}`) !== category) return;
  if (category === 'reasoning_summary') {
    const safeText = sanitizeCodexActivitySummary(event?.text, { redactionContext });
    if (!safeText) return;
    progressManager.publish(progressId, { type: 'activity', phase: 'reasoning_summary', category, text: safeText });
    return;
  }
  progressManager.publish(progressId, { type: 'activity', phase: 'activity', category });
}

function assertUsableScript(script, chapter, statusCode = 422) {
  const lines = (Array.isArray(script?.scenes) ? script.scenes : [])
    .flatMap((scene) => Array.isArray(scene?.lines) ? scene.lines : []);
  const readable = lines.some((line) => ['narration', 'dialogue'].includes(line?.kind) && String(line?.spokenText || '').trim());
  if (!String(chapter?.sourceText || '').trim() || readable) return;
  throw Object.assign(new Error('剧本结果没有可朗读的旁白或对白，已保留当前章节'), {
    statusCode,
    code: 'SCRIPT_SCHEMA_INVALID'
  });
}

function applyScript(project, chapter, script) {
  assertUsableScript(script, chapter);
  const roleMap = mergeRoles(project, script.roles);
  const narrator = project.characters.find((role) => role.isNarrator);
  chapter.scenes = script.scenes.map((scene) => ({
    ...scene,
    lines: scene.lines.map((line) => {
      const role = roleMap.get(line.speaker.toLowerCase()) || narrator;
      return { ...line, speakerId: role?.id || 'role_narrator' };
    })
  }));
  chapter.scriptWarnings = script.warnings;
  chapter.scriptedAt = nowIso();
  chapter.status = 'scripted';
}

function chapterSessionSnapshot(project, chapter) {
  const snapshot = chapterToScriptSnapshot(chapter, project);
  snapshot.scenes = snapshot.scenes.map((scene, sceneIndex) => ({
    ...scene,
    id: chapter.scenes?.[sceneIndex]?.id,
    lines: scene.lines.map((line, lineIndex) => ({
      ...line,
      id: chapter.scenes?.[sceneIndex]?.lines?.[lineIndex]?.id
    }))
  }));
  return snapshot;
}

function pruneUnusedRoles(project) {
  const used = new Set(project.chapters.flatMap((chapter) => (chapter.scenes || [])
    .flatMap((scene) => (scene.lines || []).map((line) => line.speakerId))));
  project.characters = project.characters.filter((role) => role.isNarrator || role.voiceId || used.has(role.id));
}

function publicProject(project) {
  if (!project || !Array.isArray(project.chapters)) return project;
  return {
    ...project,
    chapters: project.chapters.map((chapter) => ({
      ...chapter,
      codexSessions: Array.isArray(chapter.codexSessions)
        ? chapter.codexSessions.map(publicCodexSession)
        : chapter.codexSessions
    }))
  };
}

async function getBootstrap() {
  const settings = await getSettings();
  const [profile, projects, voices] = await Promise.all([
    getSystemProfile(settings), listProjects(), listVoices()
  ]);
  return {
    app: {
      name: '声绘 Studio', version: '0.1.0',
      limits: {
        voiceSourceBytes: MAX_VOICE_SOURCE_BYTES,
        voiceClipMinMs: MIN_VOICE_CLIP_MS,
        voiceClipMaxMs: MAX_VOICE_CLIP_MS
      }
    },
    settings,
    system: profile,
    engines: engineCompatibility(profile, settings.selectedEngine, settings.qualityMode),
    projects,
    voices,
    emotions: EMOTIONS,
    jobs: jobs.list()
  };
}

async function handleApi(req, res, url, {
  codexRunner = runCodexSession,
  codexSettingsResolver = codexRuntimeSettings,
  codexLoginManager: loginManager,
  codexProgressManager: progressManager,
  systemProfileResolver = getSystemProfile
} = {}) {
  const { pathname } = url;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') assertLocalOrigin(req);

  if (method === 'GET' && pathname === '/api/bootstrap') return json(res, 200, await getBootstrap());
  if (method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, time: nowIso() });
  if (method === 'GET' && pathname === '/api/projects') return json(res, 200, await listProjects());
  if (method === 'GET' && pathname === '/api/voices') return json(res, 200, await listVoices());
  if (method === 'GET' && pathname === '/api/jobs') return json(res, 200, jobs.list());
  if (method === 'GET' && pathname === '/api/system') {
    const settings = await getSettings();
    const profile = await getSystemProfile(settings, { refresh: url.searchParams.get('refresh') === '1' });
    return json(res, 200, { profile, engines: engineCompatibility(profile, settings.selectedEngine, settings.qualityMode) });
  }
  if (pathname === '/api/codex/auth/login') {
    assertLoopbackRequest(req);
    assertLocalHostRequest(req);
    if (method === 'GET') return json(res, 200, { login: loginManager.snapshot() });
    if (method === 'DELETE') {
      assertSameOriginRequest(req);
      await assertNoCodexAuthOptions(req);
      return json(res, 200, { login: loginManager.cancel() });
    }
    if (method === 'POST') {
      assertSameOriginRequest(req);
      await assertNoCodexAuthOptions(req);
      const login = await loginManager.start({
        resolveCommand: async () => {
          const settings = await getSettings();
          return resolveCodexLogin(await systemProfileResolver(settings, { refresh: true }));
        },
        verifyAuthenticated: async () => {
          const settings = await getSettings();
          const profile = await systemProfileResolver(settings, { refresh: true });
          return profile?.tools?.codex?.runnable === true || profile?.tools?.codex?.state === 'ready';
        }
      });
      return json(res, login.state === 'succeeded' ? 200 : 202, { login });
    }
    throw Object.assign(new Error('请求方法不支持'), { statusCode: 405, code: 'METHOD_NOT_ALLOWED' });
  }
  let params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-progress/:progressId');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    findChapter(project, params.chapterId);
    return progressManager.subscribe(req, res, {
      ...params,
      lastEventId: req.headers['last-event-id']
    });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-progress');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    findChapter(project, params.chapterId);
    return json(res, 200, { progress: progressManager.latest(params.projectId, params.chapterId) });
  }

  if (method === 'PATCH' && pathname === '/api/settings') {
    const settings = await updateSettings(await parseJsonBody(req, MAX_JSON_BYTES));
    return json(res, 200, settings);
  }
  if (method === 'POST' && pathname === '/api/projects') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    let sourceText = '';
    let originalBuffer;
    if (body.contentBase64) {
      originalBuffer = decodeBase64Payload(body.contentBase64, MAX_BOOK_BYTES);
      sourceText = normalizeNovelText(decodeBook(originalBuffer, body.fileName));
    } else if (body.sourceText) {
      sourceText = normalizeNovelText(String(body.sourceText).slice(0, MAX_BOOK_BYTES));
    }
    const project = await createProject({
      title: body.title, author: body.author, fileName: body.fileName, sourceText
    });
    if (originalBuffer) {
      const sourceDir = path.join(PROJECTS_DIR, project.id, 'source');
      await fsp.writeFile(path.join(sourceDir, `original${path.extname(body.fileName).toLowerCase()}`), originalBuffer);
    }
    return json(res, 201, publicProject(project));
  }
  if (method === 'POST' && pathname === '/api/voices') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    let audio;
    if (body.audioBase64) {
      const buffer = decodeBase64Payload(body.audioBase64, MAX_VOICE_BYTES);
      audio = { buffer, ext: path.extname(body.fileName || '').toLowerCase() };
    }
    const voice = await createVoice({ ...body, audio });
    return json(res, 201, voice);
  }
  if (method === 'POST' && pathname === '/api/voice-sources') {
    const source = await saveVoiceSource(req, {
      fileName: url.searchParams.get('fileName'),
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length']
    });
    return json(res, 201, source);
  }

  params = routeMatch(pathname, '/api/jobs/:jobId');
  if (params && method === 'GET') return json(res, 200, jobs.get(params.jobId));

  params = routeMatch(pathname, '/api/voice-sources/:sourceId/extract');
  if (params && method === 'POST') {
    const voiceInput = validateVoiceExtraction(await parseJsonBody(req, MAX_JSON_BYTES));
    const settings = await getSettings();
    const profile = await getSystemProfile(settings, { refresh: true });
    if (!profile.worker?.online) {
      throw Object.assign(new Error('模型工作器未启动，无法裁剪视频或音频'), { code: 'WORKER_OFFLINE', statusCode: 503 });
    }
    if (!profile.worker.ffmpeg) {
      throw Object.assign(new Error('模型工作器中没有 FFmpeg，无法裁剪视频或音频'), { code: 'FFMPEG_UNAVAILABLE', statusCode: 503 });
    }
    if (!profile.worker.ffprobe) {
      throw Object.assign(new Error('模型工作器中没有 FFprobe，无法读取媒体时长'), { code: 'FFPROBE_UNAVAILABLE', statusCode: 503 });
    }
    const source = await claimVoiceSource(params.sourceId);
    let job;
    try {
      job = jobs.create(
        'voice_extract',
        { sourceId: source.id, name: voiceInput.name, startMs: voiceInput.startMs, endMs: voiceInput.endMs },
        (update) => extractVoiceFromSource(source, voiceInput, { settings, profile }, update),
        { media: true }
      );
    } catch (error) {
      await deleteVoiceSource(source.id, { allowClaimed: true, missingOk: true }).catch(() => {});
      throw error;
    }
    return json(res, 202, job);
  }

  params = routeMatch(pathname, '/api/voice-sources/:sourceId');
  if (params && method === 'DELETE') {
    await deleteVoiceSource(params.sourceId);
    res.writeHead(204);
    return res.end();
  }

  params = routeMatch(pathname, '/api/projects/:projectId');
  if (params && method === 'GET') return json(res, 200, publicProject(await getProject(params.projectId)));
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const project = await mutateProject(params.projectId, (draft) => {
      for (const field of ['title', 'author', 'description']) {
        if (field in body) draft[field] = String(body[field]).trim().slice(0, field === 'description' ? 1000 : 120);
      }
      if (body.engineId && (body.engineId === 'auto' || TTS_ENGINES.some((engine) => engine.id === body.engineId))) {
        draft.production.engineId = body.engineId;
      }
    });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/import');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const originalBuffer = decodeBase64Payload(body.contentBase64, MAX_BOOK_BYTES);
    const sourceText = normalizeNovelText(decodeBook(originalBuffer, body.fileName));
    const project = await replaceProjectSource(params.projectId, { fileName: body.fileName, sourceText, originalBuffer });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/script');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const settings = await getSettings();
    const project = await getProject(params.projectId);
    const chapterIds = Array.isArray(body.chapterIds) && body.chapterIds.length
      ? new Set(body.chapterIds)
      : new Set(project.chapters.map((chapter) => chapter.id));
    const provider = ['rules', 'codex', 'ollama'].includes(body.provider) ? body.provider : settings.scriptProvider;
    const job = jobs.create('script', { projectId: project.id, chapterIds: [...chapterIds], provider }, async (update) => {
      const targetIds = project.chapters.filter((chapter) => chapterIds.has(chapter.id)).map((chapter) => chapter.id);
      for (let index = 0; index < targetIds.length; index += 1) {
        const current = await getProject(project.id);
        const chapter = findChapter(current, targetIds[index]);
        update((index / targetIds.length) * 100, `正在剧本化：${chapter.title}`);
        const script = await convertChapter(chapter, { provider, settings, mode: body.mode || 'faithful' });
        await mutateProject(project.id, (draft) => applyScript(draft, findChapter(draft, chapter.id), script));
      }
      const summary = await mutateProject(project.id, (draft) => {
        pruneUnusedRoles(draft);
        draft.status = 'scripted';
        return summarizeProject(draft);
      });
      return { project: summary, chapterCount: targetIds.length, provider };
    });
    await mutateProject(project.id, (draft) => { draft.production.lastJobId = job.id; });
    return json(res, 202, job);
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/activate');
  if (params && method === 'POST') {
    assertCodexWorkspaceRequest(req);
    const latest = progressManager.latest(params.projectId, params.chapterId);
    if (latest && !latest.terminal) {
      throw Object.assign(new Error('本章正在处理 Codex 请求，完成后才能切换版本。'), {
        statusCode: 409, code: 'CODEX_PROGRESS_ACTIVE'
      });
    }
    const result = await mutateProject(params.projectId, (draft) => {
      const chapter = findChapter(draft, params.chapterId);
      const targetSession = findCodexSession(chapter, params.sessionId);
      if (chapter.activeCodexSessionId === targetSession.id) {
        return { project: draft, session: publicCodexSession(targetSession) };
      }
      if (!targetSession.scriptSnapshot?.scenes?.length) {
        throw Object.assign(new Error('这个旧 Session 没有可恢复的剧本快照。'), {
          statusCode: 409, code: 'CODEX_SESSION_VERSION_UNAVAILABLE'
        });
      }
      const currentSession = (chapter.codexSessions || [])
        .find((session) => session.id === chapter.activeCodexSessionId);
      if (currentSession) currentSession.scriptSnapshot = chapterSessionSnapshot(draft, chapter);
      applyScript(draft, chapter, structuredClone(targetSession.scriptSnapshot));
      chapter.activeCodexSessionId = targetSession.id;
      pruneUnusedRoles(draft);
      draft.status = 'scripted';
      return { project: draft, session: publicCodexSession(targetSession) };
    });
    return json(res, 200, { project: publicProject(result.project), session: result.session });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/messages');
  if (params && method === 'POST') {
    assertCodexWorkspaceRequest(req);
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const detailLevel = normalizeCodexDetailLevel(body.detailLevel);
    const prompt = codexPrompt(body.prompt, { required: true });
    const scopeProject = await getProject(params.projectId);
    const scopeChapter = findChapter(scopeProject, params.chapterId);
    const scopeSession = findCodexSession(scopeChapter, params.sessionId);
    const model = codexModel(Object.hasOwn(body, 'model') ? body.model : scopeSession.model);
    const reasoningEffort = normalizeCodexReasoningEffort(
      Object.hasOwn(body, 'reasoningEffort') ? body.reasoningEffort : scopeSession.reasoningEffort
    );
    let inheritedTimeoutMinutes = DEFAULT_CODEX_TIMEOUT_MINUTES;
    try { inheritedTimeoutMinutes = normalizeCodexTimeoutMinutes(scopeSession.timeoutMinutes); } catch { /* legacy */ }
    const timeoutMinutes = normalizeCodexTimeoutMinutes(
      body.timeoutMinutes === undefined || body.timeoutMinutes === null
        ? inheritedTimeoutMinutes
        : body.timeoutMinutes
    );
    const timeoutMs = codexTimeoutMinutesToMs(timeoutMinutes);
    const progress = progressManager.create({
      ...params, detailLevel, model, reasoningEffort, timeoutMinutes
    });
    const signal = progressManager.signal(progress.progressId, params.projectId, params.chapterId);
    const lockKey = `${params.projectId}:${params.chapterId}`;
    const operation = () => withCodexSessionLock(lockKey, async () => {
      assertCodexRunActive(signal);
      progressManager.publish(progress.progressId, { type: 'starting', phase: 'preparing' });
      const settings = await codexSettingsResolver(await getSettings());
      const project = await getProject(params.projectId);
      const chapter = findChapter(project, params.chapterId);
      const session = findCodexSession(chapter, params.sessionId);
      const chapterVersion = codexChapterVersion(chapter);
      if (!session.codexThreadId) {
        throw Object.assign(new Error('这个会话缺少可续接的 Codex Session ID，请新建会话。'), {
          statusCode: 409, code: 'CODEX_THREAD_MISSING'
        });
      }
      const redactionContext = detailLevel === 'summary'
        ? createCodexRedactionContext(codexActivitySensitiveTexts(chapter, prompt, project))
        : undefined;
      assertCodexRunActive(signal);
      const turn = await codexRunner({
        chapter, project, settings, mode: session.mode, model,
        sessionId: session.codexThreadId, prompt,
        detailLevel, reasoningEffort,
        timeoutMinutes, timeoutMs,
        signal,
        onProgress: (event) => publishCodexRunnerProgress(
          progressManager, progress.progressId, event, redactionContext
        )
      });
      assertCodexRunActive(signal);
      assertUsableScript(turn.script, chapter, 502);
      progressManager.publish(progress.progressId, { type: 'stage', phase: 'saving' });
      return mutateProject(params.projectId, (draft) => {
        assertCodexRunActive(signal);
        const targetChapter = findChapter(draft, params.chapterId);
        assertCodexChapterUnchanged(targetChapter, chapterVersion);
        const targetSession = findCodexSession(targetChapter, params.sessionId);
        applyScript(draft, targetChapter, turn.script);
        appendCodexTurn(targetSession, {
          prompt, model, reasoningEffort, timeoutMinutes, script: turn.script, usage: turn.usage
        });
        saveCodexSession(targetChapter, targetSession);
        pruneUnusedRoles(draft);
        draft.status = 'scripted';
        return { project: draft, session: publicCodexSession(targetSession) };
      });
    });
    if (codexAsyncRequested(body)) {
      runCodexInBackground(progressManager, progress, params, operation);
      return json(res, 202, codexAccepted(progress));
    }
    try {
      const result = await trackCodexOperation(progressManager, progress, params, operation);
      progressManager.complete(progress.progressId);
      return json(res, 200, {
        ...result, project: publicProject(result.project), progressId: progress.progressId,
        detailLevel, model, reasoningEffort, timeoutMinutes
      });
    } catch (error) {
      const failure = codexFailureStatus(error, timeoutMinutes);
      progressManager.fail(progress.progressId, failure.code);
      failure.progressId = progress.progressId;
      throw failure;
    }
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    const chapter = findChapter(project, params.chapterId);
    return json(res, 200, { activeSessionId: chapter.activeCodexSessionId || null, sessions: publicCodexSessions(chapter) });
  }
  if (params && method === 'POST') {
    assertCodexWorkspaceRequest(req);
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const detailLevel = normalizeCodexDetailLevel(body.detailLevel);
    const mode = codexMode(body.mode);
    const model = codexModel(body.model);
    const reasoningEffort = normalizeCodexReasoningEffort(body.reasoningEffort);
    const timeoutMinutes = normalizeCodexTimeoutMinutes(body.timeoutMinutes);
    const timeoutMs = codexTimeoutMinutesToMs(timeoutMinutes);
    const prompt = codexPrompt(body.prompt);
    const scopeProject = await getProject(params.projectId);
    findChapter(scopeProject, params.chapterId);
    const progress = progressManager.create({
      ...params, detailLevel, model, reasoningEffort, timeoutMinutes
    });
    const signal = progressManager.signal(progress.progressId, params.projectId, params.chapterId);
    const lockKey = `${params.projectId}:${params.chapterId}`;
    const operation = () => withCodexSessionLock(lockKey, async () => {
      assertCodexRunActive(signal);
      progressManager.publish(progress.progressId, { type: 'starting', phase: 'preparing' });
      const settings = await codexSettingsResolver(await getSettings());
      const project = await getProject(params.projectId);
      const chapter = findChapter(project, params.chapterId);
      const chapterVersion = codexChapterVersion(chapter);
      const redactionContext = detailLevel === 'summary'
        ? createCodexRedactionContext(codexActivitySensitiveTexts(chapter, prompt, project))
        : undefined;
      assertCodexRunActive(signal);
      const turn = await codexRunner({
        chapter, project, settings, mode, model, prompt,
        detailLevel, reasoningEffort,
        timeoutMinutes, timeoutMs,
        signal,
        onProgress: (event) => publishCodexRunnerProgress(
          progressManager, progress.progressId, event, redactionContext
        )
      });
      assertCodexRunActive(signal);
      assertUsableScript(turn.script, chapter, 502);
      if (!turn.threadId) {
        throw Object.assign(new Error('Codex 没有返回可续接的 Session ID，请更新 Codex CLI 后重试。'), {
          statusCode: 502, code: 'CODEX_THREAD_MISSING'
        });
      }
      progressManager.publish(progress.progressId, { type: 'stage', phase: 'saving' });
      return mutateProject(params.projectId, (draft) => {
        assertCodexRunActive(signal);
        const targetChapter = findChapter(draft, params.chapterId);
        assertCodexChapterUnchanged(targetChapter, chapterVersion);
        const previousSession = (targetChapter.codexSessions || [])
          .find((session) => session.id === targetChapter.activeCodexSessionId);
        if (previousSession) previousSession.scriptSnapshot = chapterSessionSnapshot(draft, targetChapter);
        applyScript(draft, targetChapter, turn.script);
        const session = createCodexSession({
          threadId: turn.threadId, model, reasoningEffort, timeoutMinutes, mode, prompt,
          script: turn.script, usage: turn.usage
        });
        saveCodexSession(targetChapter, session);
        pruneUnusedRoles(draft);
        draft.status = 'scripted';
        return { project: draft, session: publicCodexSession(session) };
      });
    });
    if (codexAsyncRequested(body)) {
      runCodexInBackground(progressManager, progress, params, operation);
      return json(res, 202, codexAccepted(progress));
    }
    try {
      const result = await trackCodexOperation(progressManager, progress, params, operation);
      progressManager.complete(progress.progressId);
      return json(res, 201, {
        ...result, project: publicProject(result.project), progressId: progress.progressId,
        detailLevel, model, reasoningEffort, timeoutMinutes
      });
    } catch (error) {
      const failure = codexFailureStatus(error, timeoutMinutes);
      progressManager.fail(progress.progressId, failure.code);
      failure.progressId = progress.progressId;
      throw failure;
    }
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-package');
  if (params && method === 'GET') {
    const project = await getProject(params.projectId);
    const chapter = findChapter(project, params.chapterId);
    return json(res, 200, createCodexPackage(chapter, url.searchParams.get('mode') || 'faithful'));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/script-import');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const project = await mutateProject(params.projectId, (draft) => {
      const chapter = findChapter(draft, params.chapterId);
      let raw = body.script ?? body;
      if (typeof raw === 'string') raw = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
      applyScript(draft, chapter, normalizeImportedScript(raw, chapter));
      pruneUnusedRoles(draft);
      draft.status = 'scripted';
    });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/lines/:lineId');
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const project = await mutateProject(params.projectId, (draft) => {
      const { line } = findLine(draft, params.lineId);
      const textFields = ['spokenText', 'emotionNote'];
      const numberFields = ['intensity', 'pace', 'pauseAfterMs'];
      for (const field of textFields) if (field in body) line[field] = String(body[field]).slice(0, 5000);
      const bounds = { intensity: [0, 1], pace: [0.6, 1.6], pauseAfterMs: [0, 5000] };
      for (const field of numberFields) {
        if (!(field in body) || !Number.isFinite(Number(body[field]))) continue;
        line[field] = clamp(body[field], ...bounds[field]);
        if (field === 'pauseAfterMs') line[field] = Math.round(line[field]);
      }
      if (body.emotion && EMOTIONS.some((emotion) => emotion.id === body.emotion)) line.emotion = body.emotion;
      if (body.speakerId) {
        const role = draft.characters.find((item) => item.id === body.speakerId);
        if (!role) throw Object.assign(new Error('角色不存在'), { statusCode: 400 });
        line.speakerId = role.id;
        line.speaker = role.name;
        line.needsReview = false;
      }
      line.render = { status: 'stale' };
    });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/characters/:roleId');
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    if (body.voiceId) await getVoice(body.voiceId);
    const project = await mutateProject(params.projectId, (draft) => {
      const role = draft.characters.find((item) => item.id === params.roleId);
      if (!role) throw Object.assign(new Error('角色不存在'), { statusCode: 404 });
      if ('voiceId' in body) {
        const nextVoiceId = body.voiceId || null;
        if (role.voiceId !== nextVoiceId) {
          role.voiceId = nextVoiceId;
          for (const chapter of draft.chapters) for (const scene of chapter.scenes || []) for (const line of scene.lines || []) {
            if (line.speakerId === role.id) line.render = { status: 'stale' };
          }
        }
      }
      if ('description' in body) role.description = String(body.description).slice(0, 300);
      if ('name' in body) {
        const oldName = role.name;
        role.name = safeName(body.name, oldName).slice(0, 30);
        for (const { line } of draft.chapters.flatMap((chapter) => chapter.scenes.flatMap((scene) => scene.lines.map((line) => ({ line }))))) {
          if (line.speakerId === role.id) line.speaker = role.name;
        }
      }
    });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/render');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const settings = await getSettings();
    const profile = await getSystemProfile(settings, { refresh: true });
    const job = jobs.create('render', { projectId: params.projectId, lineIds: body.lineIds || [] },
      (update) => renderLines(params.projectId, { lineIds: body.lineIds, demoFallback: Boolean(body.demoFallback), settings, profile }, update),
      { gpu: true });
    await mutateProject(params.projectId, (draft) => { draft.production.lastJobId = job.id; });
    return json(res, 202, job);
  }

  params = routeMatch(pathname, '/api/projects/:projectId/export');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    if (body.format && body.format !== 'wav') throw Object.assign(new Error('当前无 FFmpeg，首版直接导出支持 WAV'), { statusCode: 400 });
    const job = jobs.create('export', { projectId: params.projectId, format: 'wav' },
      (update) => exportProjectWav(params.projectId, update, { allowPartial: body.allowPartial === true }));
    await mutateProject(params.projectId, (draft) => { draft.production.lastJobId = job.id; });
    return json(res, 202, job);
  }

  params = routeMatch(pathname, '/api/voices/:voiceId');
  if (params && method === 'DELETE') {
    const references = await findVoiceReferences(params.voiceId);
    if (references.length) throw Object.assign(new Error(`音色仍绑定 ${references.length} 个角色，请先解除绑定`), { statusCode: 409 });
    await deleteVoice(params.voiceId);
    res.writeHead(204);
    return res.end();
  }

  throw Object.assign(new Error('API 路径不存在'), { statusCode: 404 });
}

async function handleMedia(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let base;
  let relativeParts;
  if (parts[1] === 'voices') { base = VOICES_DIR; relativeParts = parts.slice(2); }
  else if (parts[1] === 'projects') { base = PROJECTS_DIR; relativeParts = parts.slice(2); }
  else if (parts[1] === 'exports') { base = EXPORTS_DIR; relativeParts = parts.slice(2); }
  else throw Object.assign(new Error('媒体路径无效'), { statusCode: 404 });
  const filePath = path.resolve(base, ...relativeParts);
  if (!isPathInside(base, filePath)) throw Object.assign(new Error('媒体路径无效'), { statusCode: 403 });
  return sendFile(req, res, filePath);
}

async function handleStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw Object.assign(new Error('URL 编码无效'), { statusCode: 400 }); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let filePath = path.resolve(PUBLIC_DIR, relative);
  if (!isPathInside(PUBLIC_DIR, filePath)) throw Object.assign(new Error('路径无效'), { statusCode: 403 });
  try {
    return await sendFile(req, res, filePath, { cache: !filePath.endsWith('index.html') });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.statusCode !== 404) throw error;
    filePath = path.join(PUBLIC_DIR, 'index.html');
    return sendFile(req, res, filePath);
  }
}

export function createServer(options = {}) {
  const serverOptions = {
    ...options,
    codexLoginManager: options.codexLoginManager || new CodexLoginManager(),
    codexProgressManager: options.codexProgressManager || new CodexProgressManager()
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, serverOptions);
      if (url.pathname.startsWith('/media/')) return await handleMedia(req, res, url.pathname);
      return await handleStatic(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
      if (status >= 500) console.error(error);
      const body = { error: error.code || 'REQUEST_FAILED', message: error.message || '未知错误' };
      if (/^codexprog_[0-9a-f]{32}$/.test(String(error.progressId || ''))) body.progressId = error.progressId;
      return json(res, status, body);
    }
  });
  let managersClosed = false;
  let managersShutdown = Promise.resolve();
  const shutdownManagers = () => {
    if (managersClosed) return managersShutdown;
    managersClosed = true;
    managersShutdown = Promise.resolve(serverOptions.codexProgressManager.shutdown()).catch(() => {});
    serverOptions.codexLoginManager.shutdown();
    return managersShutdown;
  };
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    const pending = shutdownManagers();
    return closeServer((error) => {
      void pending.then(() => callback?.(error));
    });
  };
  server.once('close', shutdownManagers);
  return server;
}

async function main() {
  await initStore();
  // 上传 token 只存在于当前浏览器会话；进程重启后，遗留来源和裁剪结果都不可恢复。
  await resetVoiceSourceWorkspace();
  await jobs.init();
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n声绘 Studio 已启动：http://${HOST}:${PORT}`);
    console.log(`数据目录：${DATA_DIR}\n`);
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      await jobs.flush().catch((error) => console.error('保存任务状态失败', error));
      process.exit(0);
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
