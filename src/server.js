import http from 'node:http';
import crypto from 'node:crypto';
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
  chapterToScriptSnapshot, convertChapter, createCodexPackage, normalizeImportedScript,
  runCodexSession, runOllamaSession
} from './lib/script-engine.js';
import {
  beginCodexSessionRun, COLLABORATION_PROVIDERS,
  completeCodexSessionRun, createCodexSession, createCodexSessionId, createPendingCodexSession,
  failCodexSessionRun, findCodexSession, interruptCodexSessionRun, markCodexSessionRunning,
  normalizeScriptSessionProvider, publicCodexSession, publicCodexSessions,
  saveCodexSession, scriptSessionProvider
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
  normalizeCodexTimeoutMinutes,
  normalizeOllamaModel
} from './lib/codex-options.js';
import {
  codexActivitySensitiveTexts,
  createCodexRedactionContext,
  normalizeCodexDetailLevel,
  sanitizeCodexActivitySummary
} from './lib/codex-activity.js';
import { assertScriptStructureLimits } from './lib/script-limits.js';
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

function createMutationLock() {
  let pending = Promise.resolve();
  return (operation) => {
    const current = pending.catch(() => {}).then(operation);
    pending = current;
    return current;
  };
}

const withGlobalVoiceMutationLock = createMutationLock();

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

function codexChapterHash(chapter) {
  return `sha256:${crypto.createHash('sha256').update(codexChapterVersion(chapter)).digest('hex')}`;
}

function strictScriptMode(value, fallback = 'faithful') {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'string' || !['faithful', 'polished', 'drama'].includes(selected)) {
    throw Object.assign(new Error('剧本模式无效。'), { statusCode: 400, code: 'SCRIPT_MODE_INVALID' });
  }
  return selected;
}

function collaborationProvider(value, fallback = 'codex') {
  return normalizeScriptSessionProvider(value, {
    fallback,
    allowed: COLLABORATION_PROVIDERS
  });
}

function scriptJobProvider(value, fallback = 'rules') {
  return normalizeScriptSessionProvider(value, {
    fallback,
    allowed: ['rules', 'codex', 'ollama']
  });
}

function collaborationModel(provider, body, settings, session = null) {
  if (Object.hasOwn(body, 'model') && body.model !== null && body.model !== '') {
    return provider === 'ollama'
      ? normalizeOllamaModel(body.model)
      : normalizeCodexModel(body.model);
  }
  if (session && scriptSessionProvider(session) === provider && session.model) {
    return provider === 'ollama'
      ? normalizeOllamaModel(session.model)
      : normalizeCodexModel(session.model);
  }
  return provider === 'ollama'
    ? normalizeOllamaModel(settings?.ollamaModel)
    : normalizeCodexModel(undefined);
}

function collaborationReasoningEffort(provider, body, session = null) {
  if (provider === 'ollama') {
    if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && body.reasoningEffort !== '') {
      throw Object.assign(new Error('Ollama provider 不接受 Codex reasoningEffort。'), {
        statusCode: 400, code: 'SCRIPT_SESSION_OPTION_INVALID'
      });
    }
    return null;
  }
  return normalizeCodexReasoningEffort(
    Object.hasOwn(body, 'reasoningEffort') ? body.reasoningEffort : session?.reasoningEffort
  );
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

function codexFailureStatus(error, timeoutMinutes = DEFAULT_CODEX_TIMEOUT_MINUTES, provider = 'codex') {
  const requestedCode = String(error?.code || 'CODEX_REQUEST_FAILED').toUpperCase();
  const safeTimeoutMinutes = normalizeCodexTimeoutMinutes(timeoutMinutes);
  const messages = {
    CODEX_AUTH_REQUIRED: 'Codex CLI 尚未登录，请先完成本机登录。',
    CODEX_CANCELLED: 'Codex 请求已因服务关闭而取消。',
    CODEX_CHAPTER_CHANGED: '处理期间本章已被修改，本轮结果没有覆盖最新内容。',
    CODEX_TIMEOUT: `Codex 未能在 ${safeTimeoutMinutes} 分钟内完成处理，请稍后重试。`,
    CODEX_TIMEOUT_ACTIVE: `Codex 已开始生成，但未在 ${safeTimeoutMinutes} 分钟内完成，请缩短章节、降低推理强度或延长超时后重试。`,
    CODEX_TIMEOUT_STARTING: `Codex 未能在 ${safeTimeoutMinutes} 分钟内开始响应，请检查网络、登录状态和模型可用性。`,
    CODEX_UNAVAILABLE: 'Codex CLI 当前不可用，请检查模型中心状态。',
    OLLAMA_FAILED: 'Ollama 本地模型未能完成本轮剧本处理，请检查模型与服务状态。',
    OLLAMA_TIMEOUT: `Ollama 未能在 ${safeTimeoutMinutes} 分钟内完成处理，可延长超时或缩短章节后重试。`,
    OLLAMA_UNAVAILABLE: '无法连接本机 Ollama 服务，请确认 Ollama 已启动且模型可用。',
    SCRIPT_SCHEMA_INVALID: `${provider === 'ollama' ? 'Ollama' : 'Codex'} 返回的剧本结构未通过校验，当前章节未被覆盖。`
  };
  const safeCodes = new Set([
    ...Object.keys(messages),
    'CODEX_FAILED', 'CODEX_INPUT_INVALID', 'CODEX_JSONL_INVALID',
    'CODEX_OUTPUT_TOO_LARGE', 'CODEX_PROGRESS_UNAVAILABLE', 'CODEX_RESPONSE_EMPTY',
    'CODEX_RESPONSE_MISSING', 'CODEX_SESSION_MISSING', 'CODEX_STDIN_FAILED',
    'CODEX_THREAD_MISSING', 'CODEX_TURN_FAILED', 'SCRIPT_SESSION_VERSION_LIMIT'
  ]);
  const code = safeCodes.has(requestedCode) ? requestedCode : 'CODEX_REQUEST_FAILED';
  const statusCode = code === 'CODEX_REQUEST_FAILED'
    ? 502
    : error?.statusCode
      || (code.startsWith('CODEX_TIMEOUT') || code === 'OLLAMA_TIMEOUT'
        ? 504
        : ['CODEX_UNAVAILABLE', 'OLLAMA_UNAVAILABLE', 'CODEX_PROGRESS_UNAVAILABLE'].includes(code)
          ? 503
          : 502);
  return Object.assign(new Error(messages[code] || 'Codex 本轮处理失败，请检查状态后重试。'), {
    statusCode,
    code
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

function codexAccepted(progress, session = null) {
  return {
    sessionId: session?.id || progress.sessionId || null,
    progressId: progress.progressId,
    provider: progress.provider,
    detailLevel: progress.detailLevel,
    model: progress.model,
    reasoningEffort: progress.reasoningEffort,
    timeoutMinutes: progress.timeoutMinutes,
    state: progress.state,
    eventsUrl: progress.eventsUrl,
    ...(session ? { session: publicCodexSession(session) } : {})
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
  return progressManager.start(
    progress.progressId,
    scope.projectId,
    scope.chapterId,
    operation,
    scope.sessionId
  );
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

async function persistSessionRunFailure({ projectId, chapterId, sessionId, progressId, code }) {
  try {
    await mutateProject(projectId, (draft) => {
      const chapter = findChapter(draft, chapterId);
      const session = findCodexSession(chapter, sessionId);
      failCodexSessionRun(session, { progressId, code });
      saveCodexSession(chapter, session, { activate: false });
    });
  } catch (error) {
    if (!['SCRIPT_SESSION_RUN_STALE', 'CODEX_SESSION_NOT_FOUND'].includes(error?.code)) throw error;
  }
}

function executePersistedSessionRun({
  projectId, chapterId, sessionId, progress, provider, model, reasoningEffort,
  timeoutMinutes, timeoutMs, detailLevel, prompt, progressManager,
  codexRunner, ollamaRunner, codexSettingsResolver
}) {
  const progressId = progress.progressId;
  const signal = progressManager.signal(progressId, projectId, chapterId, sessionId);
  const lockKey = `${projectId}:${chapterId}:${sessionId}`;
  return withCodexSessionLock(lockKey, async () => {
    try {
      assertCodexRunActive(signal);
      const project = await mutateProject(projectId, (draft) => {
        const chapter = findChapter(draft, chapterId);
        const session = findCodexSession(chapter, sessionId);
        markCodexSessionRunning(session, progressId);
        saveCodexSession(chapter, session, { activate: false });
        return draft;
      });
      progressManager.publish(progressId, { type: 'starting', phase: 'preparing' });
      assertCodexRunActive(signal);
      const chapter = findChapter(project, chapterId);
      const session = findCodexSession(chapter, sessionId);
      const baselineChapter = sessionRunnerChapter(chapter, session);
      const storedSettings = await getSettings();
      const settings = provider === 'codex'
        ? await codexSettingsResolver(storedSettings)
        : storedSettings;
      const redactionContext = detailLevel === 'summary'
        ? createCodexRedactionContext(codexActivitySensitiveTexts(baselineChapter, prompt, project))
        : undefined;
      assertCodexRunActive(signal);
      const runner = provider === 'codex' ? codexRunner : ollamaRunner;
      const resumeThreadId = provider === 'codex' ? session.codexThreadId || '' : '';
      const turn = await runner({
        chapter: baselineChapter,
        project,
        settings,
        mode: session.mode,
        model,
        provider,
        sessionId: resumeThreadId,
        prompt,
        baselineCurrentScript: Boolean(
          resumeThreadId
          || Number(session.turnCount) > 0
          || baselineChapter.scenes?.length
        ),
        detailLevel,
        reasoningEffort,
        timeoutMinutes,
        timeoutMs,
        signal,
        onProgress: (event) => publishCodexRunnerProgress(
          progressManager, progressId, event, redactionContext
        )
      });
      assertCodexRunActive(signal);
      assertUsableScript(turn.script, baselineChapter, 502);
      if (provider === 'codex' && !resumeThreadId && !turn.threadId) {
        throw Object.assign(new Error('Codex 没有返回可续接的 Session ID。'), {
          statusCode: 502, code: 'CODEX_THREAD_MISSING'
        });
      }
      progressManager.publish(progressId, { type: 'stage', phase: 'saving' });
      return await mutateProject(projectId, (draft) => {
        assertCodexRunActive(signal);
        const targetChapter = findChapter(draft, chapterId);
        const targetSession = findCodexSession(targetChapter, sessionId);
        const internalSnapshot = snapshotModelResult(draft, targetChapter, turn.script);
        const targetWasActive = targetChapter.activeCodexSessionId === targetSession.id;
        const baselineChapterHash = targetSession.activeRun?.baselineChapterHash || null;
        const appliedToLive = Boolean(
          targetWasActive
          && baselineChapterHash
          && codexChapterHash(targetChapter) === baselineChapterHash
        );
        if (targetWasActive && !appliedToLive) {
          try {
            const liveBackup = createCodexSession({
              provider: 'import',
              source: 'import',
              title: '运行期间手工稿自动备份',
              prompt: '后台结果完成前保存的当前制作台剧本',
              script: chapterSessionSnapshot(draft, targetChapter)
            });
            saveCodexSession(targetChapter, liveBackup);
          } catch (error) {
            if (error?.code !== 'SCRIPT_SESSION_VERSION_LIMIT') throw error;
            // The live chapter remains canonical and will be auto-backed up before
            // the next switch; clearing the pointer avoids claiming it matches the
            // completed model snapshot.
            targetChapter.activeCodexSessionId = null;
          }
        }
        completeCodexSessionRun(targetSession, {
          progressId,
          threadId: provider === 'codex' ? turn.threadId || resumeThreadId : '',
          provider,
          model,
          reasoningEffort,
          timeoutMinutes,
          script: internalSnapshot,
          usage: turn.usage
        });
        saveCodexSession(targetChapter, targetSession, { activate: false });
        if (appliedToLive) applyScript(draft, targetChapter, internalSnapshot);
        pruneUnusedRoles(draft);
        if (appliedToLive) draft.status = 'scripted';
        return {
          project: draft,
          session: publicCodexSession(targetSession),
          appliedToLive
        };
      });
    } catch (error) {
      if (!(signal.aborted && progressManager.closed)) {
        await persistSessionRunFailure({
          projectId, chapterId, sessionId, progressId, code: error?.code
        }).catch(() => {});
      }
      throw error;
    }
  });
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
  assertScriptStructureLimits(script, { statusCode: 422 });
  assertUsableScript(script, chapter);
  const roleMap = mergeRoles(project, script.roles);
  const rolesById = new Map(project.characters.map((role) => [role.id, role]));
  const narrator = project.characters.find((role) => role.isNarrator);
  chapter.scenes = script.scenes.map((scene) => ({
    ...scene,
    lines: scene.lines.map((line) => {
      const role = rolesById.get(line.speakerId)
        || roleMap.get(String(line.speaker || '').toLowerCase())
        || narrator;
      return {
        ...line,
        speaker: role?.name || line.speaker,
        speakerId: role?.id || 'role_narrator'
      };
    })
  }));
  chapter.scriptWarnings = script.warnings;
  chapter.scriptedAt = nowIso();
  chapter.status = 'scripted';
}

function chapterSessionSnapshot(project, chapter) {
  let snapshot;
  try { snapshot = chapterToScriptSnapshot(chapter, project); } catch (error) {
    if (error?.code === 'SCRIPT_SCHEMA_INVALID' && !error.statusCode) error.statusCode = 422;
    throw error;
  }
  const rolesByName = new Map(project.characters.flatMap((role) => (
    [role.name, ...(role.aliases || [])].map((name) => [String(name || '').trim().toLowerCase(), role])
  )));
  snapshot.roles = snapshot.roles.map((role) => ({
    ...role,
    id: rolesByName.get(String(role.name || '').trim().toLowerCase())?.id
  }));
  snapshot.scenes = snapshot.scenes.map((scene, sceneIndex) => ({
    ...scene,
    id: chapter.scenes?.[sceneIndex]?.id,
    lines: scene.lines.map((line, lineIndex) => ({
      ...line,
      id: chapter.scenes?.[sceneIndex]?.lines?.[lineIndex]?.id,
      speakerId: chapter.scenes?.[sceneIndex]?.lines?.[lineIndex]?.speakerId
    }))
  }));
  assertScriptStructureLimits(snapshot, { statusCode: 422 });
  return snapshot;
}

function sessionRunnerChapter(chapter, session) {
  if (!session?.scriptSnapshot?.scenes) {
    throw Object.assign(new Error('这个 Session 没有可用的剧本基线。'), {
      statusCode: 409, code: 'CODEX_SESSION_VERSION_UNAVAILABLE'
    });
  }
  const snapshot = structuredClone(session.scriptSnapshot);
  return {
    ...structuredClone(chapter),
    chapterTitle: snapshot.chapterTitle || chapter.title,
    roles: snapshot.roles || [],
    scenes: snapshot.scenes || [],
    scriptWarnings: snapshot.warnings || []
  };
}

function snapshotModelResult(project, chapter, script) {
  const staging = {
    ...structuredClone(chapter),
    scenes: [],
    scriptWarnings: []
  };
  applyScript(project, staging, script);
  return chapterSessionSnapshot(project, staging);
}

function captureActiveScriptVersion(project, chapter) {
  const active = (chapter.codexSessions || [])
    .find((session) => session.id === chapter.activeCodexSessionId);
  if (active) {
    const liveSnapshot = chapterSessionSnapshot(project, chapter);
    if (active.activeRun || ['pending', 'running'].includes(active.status)) {
      if (JSON.stringify(active.scriptSnapshot) === JSON.stringify(liveSnapshot)) return active;
      const manualBackup = createCodexSession({
        provider: 'import',
        source: 'import',
        title: '运行期间手工稿自动备份',
        prompt: '后台协作运行期间保存的当前制作台剧本',
        script: liveSnapshot
      });
      saveCodexSession(chapter, manualBackup);
      return manualBackup;
    }
    const captured = { ...active, scriptSnapshot: liveSnapshot };
    saveCodexSession(chapter, captured);
    return captured;
  }
  if (!Array.isArray(chapter.scenes) || chapter.scenes.length === 0) return null;
  const baseline = createCodexSession({
    provider: 'import',
    source: 'import',
    title: '当前稿自动备份',
    prompt: '覆盖或切换版本前自动备份当前制作台剧本',
    script: chapterSessionSnapshot(project, chapter)
  });
  saveCodexSession(chapter, baseline);
  return baseline;
}

function applyScriptVersion(project, chapter, script, {
  provider,
  source = provider,
  title,
  threadId = '',
  model,
  reasoningEffort,
  timeoutMinutes,
  mode = 'faithful',
  prompt = '',
  usage = null
} = {}) {
  const normalizedProvider = normalizeScriptSessionProvider(provider);
  captureActiveScriptVersion(project, chapter);
  applyScript(project, chapter, script);
  const persistedSnapshot = chapterSessionSnapshot(project, chapter);
  const session = createCodexSession({
    provider: normalizedProvider,
    source,
    title,
    threadId,
    model,
    reasoningEffort,
    timeoutMinutes,
    mode,
    prompt,
    script: persistedSnapshot,
    usage
  });
  saveCodexSession(chapter, session);
  return session;
}

function pruneUnusedRoles(project) {
  const used = new Set(project.chapters.flatMap((chapter) => (chapter.scenes || [])
    .flatMap((scene) => (scene.lines || []).map((line) => line.speakerId))));
  for (const chapter of project.chapters) for (const session of chapter.codexSessions || []) {
    for (const role of session.scriptSnapshot?.roles || []) if (role.id) used.add(role.id);
    for (const scene of session.scriptSnapshot?.scenes || []) {
      for (const line of scene.lines || []) if (line.speakerId) used.add(line.speakerId);
    }
  }
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

export async function recoverInterruptedCodexSessions(progressManager) {
  const summaries = await listProjects();
  for (const summary of summaries) {
    const stored = await getProject(summary.id);
    const hasInterrupted = stored.chapters.some((chapter) => (
      (chapter.codexSessions || []).some((session) => {
        if (!session?.activeRun && !['pending', 'running'].includes(session?.status)) return false;
        try {
          const progress = progressManager.latest(stored.id, chapter.id, session.id);
          return !progress || progress.terminal;
        } catch {
          return true;
        }
      })
    ));
    if (!hasInterrupted) continue;
    await mutateProject(stored.id, (draft) => {
      for (const chapter of draft.chapters) for (const session of chapter.codexSessions || []) {
        if (!session?.activeRun && !['pending', 'running'].includes(session?.status)) continue;
        let progress = null;
        try { progress = progressManager.latest(draft.id, chapter.id, session.id); } catch { /* invalid legacy run */ }
        if (!progress || progress.terminal) interruptCodexSessionRun(session);
      }
    });
  }
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
  ollamaRunner = runOllamaSession,
  codexSettingsResolver = codexRuntimeSettings,
  codexLoginManager: loginManager,
  codexProgressManager: progressManager,
  systemProfileResolver = getSystemProfile,
  withVoiceMutationLock,
  voiceMutationHook = async () => {},
  sessionRecoveryPromise = Promise.resolve()
} = {}) {
  const sessionRecoveryError = await sessionRecoveryPromise;
  if (sessionRecoveryError) throw sessionRecoveryError;
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
  let params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/codex-progress/:progressId');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    const chapter = findChapter(project, params.chapterId);
    findCodexSession(chapter, params.sessionId);
    return progressManager.subscribe(req, res, {
      ...params,
      lastEventId: req.headers['last-event-id']
    });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/codex-progress');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    const chapter = findChapter(project, params.chapterId);
    findCodexSession(chapter, params.sessionId);
    return json(res, 200, {
      progress: progressManager.latest(params.projectId, params.chapterId, params.sessionId)
    });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/script');
  if (params && method === 'GET') {
    assertCodexWorkspaceRequest(req);
    const project = await getProject(params.projectId);
    const chapter = findChapter(project, params.chapterId);
    const session = findCodexSession(chapter, params.sessionId);
    if (!session.scriptSnapshot?.scenes) {
      throw Object.assign(new Error('这个 Session 没有可恢复的剧本快照。'), {
        statusCode: 409, code: 'CODEX_SESSION_VERSION_UNAVAILABLE'
      });
    }
    return json(res, 200, {
      session: publicCodexSession(session),
      isActive: chapter.activeCodexSessionId === session.id,
      script: structuredClone(session.scriptSnapshot)
    });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-progress/:progressId');
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
    assertCodexWorkspaceRequest(req);
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const batchKeys = new Set([
      'chapterIds', 'provider', 'mode', 'model', 'reasoningEffort', 'timeoutMinutes'
    ]);
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(body).some((key) => !batchKeys.has(key))
    ) {
      throw Object.assign(new Error('批量剧本任务包含不支持的请求字段。'), {
        statusCode: 400, code: 'SCRIPT_JOB_OPTION_INVALID'
      });
    }
    const settings = await getSettings();
    const project = await getProject(params.projectId);
    if (body.chapterIds !== undefined && (
      !Array.isArray(body.chapterIds)
      || !body.chapterIds.length
      || body.chapterIds.length > 500
      || new Set(body.chapterIds).size !== body.chapterIds.length
    )) {
      throw Object.assign(new Error('chapterIds 必须是非空且不重复的章节 ID 数组。'), {
        statusCode: 400, code: 'SCRIPT_CHAPTER_INVALID'
      });
    }
    const chapterIds = new Set(body.chapterIds || project.chapters.map((chapter) => chapter.id));
    let defaultProvider = 'rules';
    try { defaultProvider = scriptJobProvider(settings.scriptProvider, 'rules'); } catch { /* legacy setting */ }
    const provider = scriptJobProvider(body.provider, defaultProvider);
    const mode = strictScriptMode(body.mode);
    const hasModel = Object.hasOwn(body, 'model');
    const hasReasoning = Object.hasOwn(body, 'reasoningEffort');
    const hasTimeout = Object.hasOwn(body, 'timeoutMinutes');
    if (provider === 'rules' && (hasModel || hasReasoning || hasTimeout)) {
      throw Object.assign(new Error('规则生成不接受模型、推理强度或超时选项。'), {
        statusCode: 400, code: 'SCRIPT_JOB_OPTION_INVALID'
      });
    }
    if (provider === 'ollama' && hasReasoning) {
      throw Object.assign(new Error('Ollama 不接受 Codex 推理强度。'), {
        statusCode: 400, code: 'SCRIPT_JOB_OPTION_INVALID'
      });
    }
    if (hasModel && (typeof body.model !== 'string' || !body.model.trim())) {
      throw Object.assign(new Error('批量剧本任务的 model 必须是非空字符串。'), {
        statusCode: 400, code: provider === 'ollama' ? 'OLLAMA_MODEL_INVALID' : 'CODEX_MODEL_INVALID'
      });
    }
    if (hasReasoning && (typeof body.reasoningEffort !== 'string' || !body.reasoningEffort.trim())) {
      throw Object.assign(new Error('批量 Codex 推理强度无效。'), {
        statusCode: 400, code: 'CODEX_REASONING_EFFORT_INVALID'
      });
    }
    const model = provider === 'rules' ? '' : collaborationModel(provider, body, settings);
    const reasoningEffort = provider === 'codex'
      ? normalizeCodexReasoningEffort(body.reasoningEffort)
      : null;
    const timeoutMinutes = provider === 'rules'
      ? null
      : normalizeCodexTimeoutMinutes(body.timeoutMinutes);
    const timeoutMs = timeoutMinutes === null ? null : codexTimeoutMinutesToMs(timeoutMinutes);
    const knownChapterIds = new Set(project.chapters.map((chapter) => chapter.id));
    if (![...chapterIds].every((chapterId) => typeof chapterId === 'string' && knownChapterIds.has(chapterId))) {
      throw Object.assign(new Error('chapterIds 包含不属于当前项目的章节。'), {
        statusCode: 400, code: 'SCRIPT_CHAPTER_INVALID'
      });
    }
    const targetIds = project.chapters.filter((chapter) => chapterIds.has(chapter.id)).map((chapter) => chapter.id);
    if (!targetIds.length || targetIds.length > 500) {
      throw Object.assign(new Error('批量剧本任务必须包含 1 到 500 个章节。'), {
        statusCode: 400, code: 'SCRIPT_CHAPTER_INVALID'
      });
    }
    const targetIdSet = new Set(targetIds);
    const overlappingJob = jobs.findActive((job) => (
      job.type === 'script'
      && job.payload?.projectId === project.id
      && Array.isArray(job.payload?.chapterIds)
      && job.payload.chapterIds.some((chapterId) => targetIdSet.has(chapterId))
    ));
    if (overlappingJob) {
      throw Object.assign(new Error('所选章节已有规则或模型剧本任务正在处理。'), {
        statusCode: 409, code: 'SCRIPT_JOB_ACTIVE'
      });
    }
    const jobPayload = {
      projectId: project.id,
      chapterIds: targetIds,
      provider,
      mode,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(timeoutMinutes ? { timeoutMinutes } : {})
    };
    const job = jobs.create('script', jobPayload, async (update) => {
      const versions = [];
      const chapterResults = [];
      for (let index = 0; index < targetIds.length; index += 1) {
        if (progressManager.closed) break;
        const chapterId = targetIds[index];
        let chapterSessionId = null;
        update((index / targetIds.length) * 100, `正在处理第 ${index + 1}/${targetIds.length} 章`, {
          currentChapterId: chapterId,
          currentSessionId: null,
          session: null,
          chapterResults: structuredClone(chapterResults)
        });
        try {
          const current = await getProject(project.id);
          const chapter = findChapter(current, chapterId);
          let result;
          if (provider === 'rules') {
            const script = await convertChapter(chapter, { provider, settings, mode });
            result = await mutateProject(project.id, (draft) => {
              const targetChapter = findChapter(draft, chapterId);
              const session = applyScriptVersion(draft, targetChapter, script, {
                provider: 'rules', title: '规则生成版本', mode,
                prompt: 'rules 批量剧本生成'
              });
              pruneUnusedRoles(draft);
              draft.status = 'scripted';
              return { session: publicCodexSession(session), appliedToLive: true };
            });
          } else {
            const sessionId = createCodexSessionId();
            chapterSessionId = sessionId;
            const detailLevel = 'basic';
            const progress = progressManager.create({
              projectId: project.id,
              chapterId,
              sessionId,
              provider,
              detailLevel,
              model,
              reasoningEffort,
              timeoutMinutes
            });
            try {
              const pendingSession = await mutateProject(project.id, (draft) => {
                const targetChapter = findChapter(draft, chapterId);
                captureActiveScriptVersion(draft, targetChapter);
                const session = createPendingCodexSession({
                  sessionId,
                  progressId: progress.progressId,
                  provider,
                  source: provider,
                  title: provider === 'codex' ? 'Codex 批量生成版本' : 'Ollama 批量生成版本',
                  model,
                  reasoningEffort,
                  timeoutMinutes,
                  mode,
                  prompt: `${provider} 批量剧本生成`,
                  script: chapterSessionSnapshot(draft, targetChapter),
                  baselineChapterHash: codexChapterHash(targetChapter)
                });
                saveCodexSession(targetChapter, session);
                return publicCodexSession(session);
              });
              update((index / targetIds.length) * 100, `正在处理第 ${index + 1}/${targetIds.length} 章`, {
                currentChapterId: chapterId,
                currentSessionId: sessionId,
                session: pendingSession,
                chapterResults: structuredClone(chapterResults)
              });
            } catch (error) {
              progressManager.discard(progress.progressId);
              throw error;
            }
            const scope = { projectId: project.id, chapterId, sessionId };
            const operation = () => executePersistedSessionRun({
              ...scope,
              progress,
              provider,
              model,
              reasoningEffort,
              timeoutMinutes,
              timeoutMs,
              detailLevel,
              prompt: `${provider} 批量剧本生成`,
              progressManager,
              codexRunner,
              ollamaRunner,
              codexSettingsResolver
            });
            try {
              result = await trackCodexOperation(progressManager, progress, scope, operation);
              progressManager.complete(progress.progressId);
            } catch (error) {
              progressManager.fail(progress.progressId, error?.code);
              throw error;
            }
          }
          const completed = {
            chapterId,
            state: 'completed',
            session: result.session,
            appliedToLive: result.appliedToLive
          };
          versions.push({ chapterId, session: result.session });
          chapterResults.push(completed);
        } catch (error) {
          if (progressManager.closed) break;
          const safe = provider === 'rules'
            ? {
                code: ['SCRIPT_SCHEMA_INVALID', 'SCRIPT_SESSION_VERSION_LIMIT'].includes(error?.code)
                  ? error.code
                  : 'SCRIPT_CHAPTER_FAILED',
                message: '本章规则剧本生成失败，原稿已保留。'
              }
            : codexFailureStatus(error, timeoutMinutes, provider);
          let failedSession = null;
          if (chapterSessionId) {
            try {
              const failedProject = await getProject(project.id);
              failedSession = publicCodexSession(findCodexSession(
                findChapter(failedProject, chapterId), chapterSessionId
              ));
            } catch { /* persistence failed before a Session existed */ }
          }
          chapterResults.push({
            chapterId,
            state: 'failed',
            code: safe.code,
            message: safe.message,
            ...(failedSession ? { session: failedSession } : {})
          });
        }
        update(((index + 1) / targetIds.length) * 100, `已处理 ${index + 1}/${targetIds.length} 章`, {
          currentChapterId: chapterId,
          currentSessionId: chapterSessionId,
          session: chapterResults.at(-1)?.session || null,
          chapterResults: structuredClone(chapterResults)
        });
      }
      const summary = progressManager.closed
        ? summarizeProject(await getProject(project.id))
        : await mutateProject(project.id, (draft) => {
            pruneUnusedRoles(draft);
            if (chapterResults.some((item) => item.state === 'completed')) draft.status = 'scripted';
            return summarizeProject(draft);
          });
      const successCount = chapterResults.filter((item) => item.state === 'completed').length;
      return {
        project: summary,
        chapterCount: targetIds.length,
        provider,
        mode,
        successCount,
        failureCount: chapterResults.length - successCount,
        chapters: chapterResults,
        versions
      };
    }, { gpu: provider !== 'rules' });
    await mutateProject(project.id, (draft) => { draft.production.lastJobId = job.id; });
    return json(res, 202, job);
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId');
  if (params && method === 'DELETE') {
    assertCodexWorkspaceRequest(req);
    const latest = progressManager.latest(params.projectId, params.chapterId, params.sessionId);
    if (latest && !latest.terminal) {
      throw Object.assign(new Error('本章正在进行剧本协作，暂不能删除版本。'), {
        statusCode: 409, code: 'CODEX_PROGRESS_ACTIVE'
      });
    }
    await mutateProject(params.projectId, (draft) => {
      const chapter = findChapter(draft, params.chapterId);
      const session = findCodexSession(chapter, params.sessionId);
      if (session.activeRun || ['pending', 'running'].includes(session.status)) {
        throw Object.assign(new Error('正在处理的 Session 不能删除。'), {
          statusCode: 409, code: 'SCRIPT_SESSION_ACTIVE'
        });
      }
      if (chapter.activeCodexSessionId === session.id) {
        throw Object.assign(new Error('当前活动版本不能删除，请先激活其他版本。'), {
          statusCode: 409, code: 'SCRIPT_SESSION_ACTIVE_DELETE'
        });
      }
      chapter.codexSessions = (chapter.codexSessions || []).filter((item) => item.id !== session.id);
    });
    res.writeHead(204);
    return res.end();
  }

  params = routeMatch(pathname, '/api/projects/:projectId/chapters/:chapterId/codex-sessions/:sessionId/activate');
  if (params && method === 'POST') {
    assertCodexWorkspaceRequest(req);
    const result = await mutateProject(params.projectId, (draft) => {
      const chapter = findChapter(draft, params.chapterId);
      const targetSession = findCodexSession(chapter, params.sessionId);
      if (targetSession.activeRun || ['pending', 'running'].includes(targetSession.status)) {
        throw Object.assign(new Error('正在处理的 Session 不能激活。'), {
          statusCode: 409, code: 'SCRIPT_SESSION_ACTIVE'
        });
      }
      if (chapter.activeCodexSessionId === targetSession.id) {
        return { project: draft, session: publicCodexSession(targetSession) };
      }
      if (!targetSession.scriptSnapshot?.scenes?.length) {
        throw Object.assign(new Error('这个旧 Session 没有可恢复的剧本快照。'), {
          statusCode: 409, code: 'CODEX_SESSION_VERSION_UNAVAILABLE'
        });
      }
      captureActiveScriptVersion(draft, chapter);
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
    const sourceProvider = scriptSessionProvider(scopeSession);
    const provider = body.provider === undefined
      ? (COLLABORATION_PROVIDERS.includes(sourceProvider)
        ? sourceProvider
        : (() => {
          throw Object.assign(new Error('规则或导入版本继续协作时必须选择 Codex 或 Ollama。'), {
            statusCode: 400, code: 'SCRIPT_SESSION_PROVIDER_REQUIRED'
          });
        })())
      : collaborationProvider(body.provider);
    const optionSettings = await getSettings();
    const model = collaborationModel(provider, body, optionSettings, scopeSession);
    const reasoningEffort = collaborationReasoningEffort(provider, body, scopeSession);
    const continuesSession = provider === sourceProvider && COLLABORATION_PROVIDERS.includes(sourceProvider);
    let inheritedTimeoutMinutes = DEFAULT_CODEX_TIMEOUT_MINUTES;
    if (continuesSession) {
      try { inheritedTimeoutMinutes = normalizeCodexTimeoutMinutes(scopeSession.timeoutMinutes); } catch { /* legacy */ }
    }
    const timeoutMinutes = normalizeCodexTimeoutMinutes(
      body.timeoutMinutes === undefined || body.timeoutMinutes === null
        ? inheritedTimeoutMinutes
        : body.timeoutMinutes
    );
    const timeoutMs = codexTimeoutMinutesToMs(timeoutMinutes);
    if (continuesSession && (scopeSession.activeRun || ['pending', 'running'].includes(scopeSession.status))) {
      const existing = progressManager.latest(params.projectId, params.chapterId, scopeSession.id);
      if (existing && !existing.terminal) {
        throw Object.assign(new Error('这个 Session 已有请求正在处理。'), {
          statusCode: 409, code: 'SCRIPT_SESSION_ACTIVE'
        });
      }
      await mutateProject(params.projectId, (draft) => {
        const chapter = findChapter(draft, params.chapterId);
        const session = findCodexSession(chapter, scopeSession.id);
        if (session.activeRun || ['pending', 'running'].includes(session.status)) {
          interruptCodexSessionRun(session);
          saveCodexSession(chapter, session, { activate: false });
        }
      });
    }
    const runSessionId = continuesSession ? scopeSession.id : createCodexSessionId();
    const progress = progressManager.create({
      ...params, sessionId: runSessionId,
      provider, detailLevel, model, reasoningEffort, timeoutMinutes
    });
    let pendingSession;
    try {
      pendingSession = await mutateProject(params.projectId, (draft) => {
        const chapter = findChapter(draft, params.chapterId);
        let sourceSession = findCodexSession(chapter, params.sessionId);
        const sourceWasActive = chapter.activeCodexSessionId === sourceSession.id;
        if (sourceWasActive) {
          captureActiveScriptVersion(draft, chapter);
          sourceSession = findCodexSession(chapter, params.sessionId);
        }
        if (continuesSession) {
          beginCodexSessionRun(sourceSession, {
            prompt, provider, model, reasoningEffort, timeoutMinutes,
            progressId: progress.progressId,
            baselineChapterHash: sourceWasActive ? codexChapterHash(chapter) : null
          });
          saveCodexSession(chapter, sourceSession, { activate: false });
          return sourceSession;
        }
        const session = createPendingCodexSession({
          sessionId: runSessionId,
          progressId: progress.progressId,
          provider,
          source: provider,
          title: provider === 'codex' ? 'Codex 协作版本' : 'Ollama 协作版本',
          model,
          reasoningEffort,
          timeoutMinutes,
          mode: sourceSession.mode,
          prompt,
          script: sourceSession.scriptSnapshot,
          baselineChapterHash: sourceWasActive ? codexChapterHash(chapter) : null
        });
        saveCodexSession(chapter, session, { activate: sourceWasActive });
        return session;
      });
    } catch (error) {
      progressManager.discard(progress.progressId);
      throw error;
    }
    const runScope = { ...params, sessionId: runSessionId };
    const operation = () => executePersistedSessionRun({
      ...runScope, progress, provider, model, reasoningEffort, timeoutMinutes, timeoutMs,
      detailLevel, prompt, progressManager, codexRunner, ollamaRunner, codexSettingsResolver
    });
    if (codexAsyncRequested(body)) {
      runCodexInBackground(progressManager, progress, runScope, operation);
      return json(res, 202, codexAccepted(progress, pendingSession));
    }
    try {
      const result = await trackCodexOperation(progressManager, progress, runScope, operation);
      progressManager.complete(progress.progressId);
      return json(res, 200, {
        ...result, project: publicProject(result.project), progressId: progress.progressId,
        sessionId: runSessionId, provider, detailLevel, model, reasoningEffort, timeoutMinutes
      });
    } catch (error) {
      const failure = codexFailureStatus(error, timeoutMinutes, provider);
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
    const mode = strictScriptMode(body.mode);
    const provider = collaborationProvider(body.provider, 'codex');
    const optionSettings = await getSettings();
    const model = collaborationModel(provider, body, optionSettings);
    const reasoningEffort = collaborationReasoningEffort(provider, body);
    const timeoutMinutes = normalizeCodexTimeoutMinutes(body.timeoutMinutes);
    const timeoutMs = codexTimeoutMinutesToMs(timeoutMinutes);
    const prompt = codexPrompt(body.prompt);
    const scopeProject = await getProject(params.projectId);
    findChapter(scopeProject, params.chapterId);
    const sessionId = createCodexSessionId();
    const progress = progressManager.create({
      ...params, sessionId, provider, detailLevel, model, reasoningEffort, timeoutMinutes
    });
    let pendingSession;
    try {
      pendingSession = await mutateProject(params.projectId, (draft) => {
        const chapter = findChapter(draft, params.chapterId);
        captureActiveScriptVersion(draft, chapter);
        const session = createPendingCodexSession({
          sessionId,
          progressId: progress.progressId,
          provider,
          source: provider,
          title: provider === 'codex' ? 'Codex 协作版本' : 'Ollama 协作版本',
          model,
          reasoningEffort,
          timeoutMinutes,
          mode,
          prompt,
          script: chapterSessionSnapshot(draft, chapter),
          baselineChapterHash: codexChapterHash(chapter)
        });
        saveCodexSession(chapter, session);
        return session;
      });
    } catch (error) {
      progressManager.discard(progress.progressId);
      throw error;
    }
    const runScope = { ...params, sessionId };
    const operation = () => executePersistedSessionRun({
      ...runScope, progress, provider, model, reasoningEffort, timeoutMinutes, timeoutMs,
      detailLevel, prompt, progressManager, codexRunner, ollamaRunner, codexSettingsResolver
    });
    if (codexAsyncRequested(body)) {
      runCodexInBackground(progressManager, progress, runScope, operation);
      return json(res, 202, codexAccepted(progress, pendingSession));
    }
    try {
      const result = await trackCodexOperation(progressManager, progress, runScope, operation);
      progressManager.complete(progress.progressId);
      return json(res, 201, {
        ...result, project: publicProject(result.project), progressId: progress.progressId,
        sessionId, provider, detailLevel, model, reasoningEffort, timeoutMinutes
      });
    } catch (error) {
      const failure = codexFailureStatus(error, timeoutMinutes, provider);
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
    let imported = body.script ?? body;
    if (typeof imported === 'string') {
      try { imported = JSON.parse(imported.replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch {
        throw Object.assign(new Error('导入的剧本不是有效 JSON。'), {
          statusCode: 400, code: 'SCRIPT_IMPORT_INVALID'
        });
      }
    }
    const project = await withCodexSessionLock(`${params.projectId}:${params.chapterId}`, () => (
      mutateProject(params.projectId, (draft) => {
        const chapter = findChapter(draft, params.chapterId);
        const script = normalizeImportedScript(imported, chapter);
        applyScriptVersion(draft, chapter, script, {
          provider: 'import', title: '导入剧本版本', prompt: '手动导入剧本'
        });
        pruneUnusedRoles(draft);
        draft.status = 'scripted';
      })
    ));
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/lines/:lineId');
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const project = await mutateProject(params.projectId, (draft) => {
      const { chapter, line } = findLine(draft, params.lineId);
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
      captureActiveScriptVersion(draft, chapter);
    });
    return json(res, 200, publicProject(project));
  }

  params = routeMatch(pathname, '/api/projects/:projectId/characters/voices');
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    if (!Array.isArray(body.assignments) || body.assignments.length < 1 || body.assignments.length > 200) {
      throw Object.assign(new Error('assignments 必须包含 1 到 200 个音色绑定。'), {
        statusCode: 400, code: 'VOICE_ASSIGNMENTS_INVALID'
      });
    }
    const assignments = body.assignments.map((assignment) => {
      if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
        throw Object.assign(new Error('音色绑定项格式无效。'), {
          statusCode: 400, code: 'VOICE_ASSIGNMENTS_INVALID'
        });
      }
      const keys = Object.keys(assignment);
      if (keys.some((key) => !['roleId', 'voiceId'].includes(key))) {
        throw Object.assign(new Error('音色绑定项包含不支持的字段。'), {
          statusCode: 400, code: 'VOICE_ASSIGNMENTS_INVALID'
        });
      }
      const roleId = typeof assignment.roleId === 'string' ? assignment.roleId.trim() : '';
      const voiceId = assignment.voiceId;
      if (!roleId || roleId.length > 120 || !(voiceId === null || (typeof voiceId === 'string' && voiceId.trim()))) {
        throw Object.assign(new Error('roleId 或 voiceId 格式无效。'), {
          statusCode: 400, code: 'VOICE_ASSIGNMENTS_INVALID'
        });
      }
      return { roleId, voiceId: voiceId === null ? null : voiceId.trim() };
    });
    const roleIds = new Set(assignments.map((assignment) => assignment.roleId));
    if (roleIds.size !== assignments.length) {
      throw Object.assign(new Error('同一角色不能重复绑定。'), {
        statusCode: 400, code: 'VOICE_ASSIGNMENTS_DUPLICATE_ROLE'
      });
    }
    const result = await withVoiceMutationLock(async () => {
      await voiceMutationHook({ action: 'batch-bind', projectId: params.projectId });
      const scopeProject = await getProject(params.projectId);
      const knownRoleIds = new Set(scopeProject.characters.map((role) => role.id));
      if (assignments.some((assignment) => !knownRoleIds.has(assignment.roleId))) {
        throw Object.assign(new Error('音色绑定包含未知角色。'), {
          statusCode: 404, code: 'VOICE_ASSIGNMENTS_ROLE_NOT_FOUND'
        });
      }
      await Promise.all([...new Set(assignments.map((assignment) => assignment.voiceId).filter(Boolean))]
        .map((voiceId) => getVoice(voiceId)));
      const updatedRoleIds = [];
      const project = await mutateProject(params.projectId, (draft) => {
        const roles = new Map(draft.characters.map((role) => [role.id, role]));
        if (assignments.some((assignment) => !roles.has(assignment.roleId))) {
          throw Object.assign(new Error('音色绑定包含未知角色。'), {
            statusCode: 404, code: 'VOICE_ASSIGNMENTS_ROLE_NOT_FOUND'
          });
        }
        for (const assignment of assignments) {
          const role = roles.get(assignment.roleId);
          if ((role.voiceId || null) === assignment.voiceId) continue;
          role.voiceId = assignment.voiceId;
          updatedRoleIds.push(role.id);
        }
        if (updatedRoleIds.length) {
          const changed = new Set(updatedRoleIds);
          for (const chapter of draft.chapters) for (const scene of chapter.scenes || []) for (const line of scene.lines || []) {
            if (changed.has(line.speakerId)) line.render = { status: 'stale' };
          }
        }
      });
      return { project, updatedRoleIds };
    });
    return json(res, 200, { project: publicProject(result.project), updatedRoleIds: result.updatedRoleIds });
  }

  params = routeMatch(pathname, '/api/projects/:projectId/characters/:roleId');
  if (params && method === 'PATCH') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    if (
      Object.hasOwn(body, 'voiceId')
      && !(body.voiceId === null || (typeof body.voiceId === 'string' && body.voiceId.trim()))
    ) {
      throw Object.assign(new Error('voiceId 必须是非空字符串或 null。'), {
        statusCode: 400, code: 'VOICE_ASSIGNMENT_INVALID'
      });
    }
    const updateRole = async () => {
      if (Object.hasOwn(body, 'voiceId')) {
        await voiceMutationHook({ action: 'single-bind', projectId: params.projectId, roleId: params.roleId });
      }
      if (body.voiceId) await getVoice(body.voiceId);
      return mutateProject(params.projectId, (draft) => {
      const role = draft.characters.find((item) => item.id === params.roleId);
      if (!role) throw Object.assign(new Error('角色不存在'), { statusCode: 404 });
      if ('voiceId' in body) {
        const nextVoiceId = body.voiceId === null ? null : body.voiceId.trim();
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
        if (oldName && oldName !== role.name) {
          role.aliases = [...new Set([...(role.aliases || []), oldName])].slice(0, 20);
        }
        for (const { line } of draft.chapters.flatMap((chapter) => chapter.scenes.flatMap((scene) => scene.lines.map((line) => ({ line }))))) {
          if (line.speakerId === role.id) line.speaker = role.name;
        }
      }
      });
    };
    const project = Object.hasOwn(body, 'voiceId')
      ? await withVoiceMutationLock(updateRole)
      : await updateRole();
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
    await withVoiceMutationLock(async () => {
      await voiceMutationHook({ action: 'delete', voiceId: params.voiceId });
      const references = await findVoiceReferences(params.voiceId);
      if (references.length) throw Object.assign(new Error(`音色仍绑定 ${references.length} 个角色，请先解除绑定`), { statusCode: 409 });
      await deleteVoice(params.voiceId);
    });
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
    codexProgressManager: options.codexProgressManager || new CodexProgressManager(),
    withVoiceMutationLock: options.withVoiceMutationLock || withGlobalVoiceMutationLock
  };
  const sessionRecovery = options.sessionRecoveryPromise || recoverInterruptedCodexSessions(
    serverOptions.codexProgressManager
  );
  serverOptions.sessionRecoveryPromise = Promise.resolve(sessionRecovery).then(() => null, () => {
    console.error('恢复中断的剧本 Session 失败。');
    return Object.assign(new Error('剧本 Session 恢复尚未完成，请稍后重试。'), {
      statusCode: 503,
      code: 'SCRIPT_SESSION_RECOVERY_FAILED'
    });
  });
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
