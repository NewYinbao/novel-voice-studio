import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, MAX_BOOK_BYTES, MAX_JSON_BYTES, MAX_VOICE_BYTES, PROJECTS_DIR,
  PUBLIC_DIR, TTS_ENGINES, VOICES_DIR, EXPORTS_DIR, EMOTIONS
} from './lib/config.js';
import { engineCompatibility, getSystemProfile } from './lib/system.js';
import {
  createProject, createVoice, deleteVoice, findVoiceReferences, getProject, getSettings, getVoice, initStore, listProjects,
  listVoices, mergeRoles, mutateProject, replaceProjectSource, summarizeProject, updateSettings
} from './lib/store.js';
import { decodeBook, normalizeNovelText } from './lib/novel.js';
import { convertChapter, createCodexPackage, normalizeImportedScript } from './lib/script-engine.js';
import { JobManager } from './lib/jobs.js';
import { exportProjectWav, renderLines } from './lib/tts.js';
import {
  clamp, decodeBase64Payload, isPathInside, json, mediaType, nowIso, parseJsonBody, safeName, text
} from './lib/utils.js';

const jobs = new JobManager(path.join(DATA_DIR, 'jobs.json'));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);

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

function applyScript(project, chapter, script) {
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

function pruneUnusedRoles(project) {
  const used = new Set(project.chapters.flatMap((chapter) => (chapter.scenes || [])
    .flatMap((scene) => (scene.lines || []).map((line) => line.speakerId))));
  project.characters = project.characters.filter((role) => role.isNarrator || role.voiceId || used.has(role.id));
}

async function getBootstrap() {
  const settings = await getSettings();
  const [profile, projects, voices] = await Promise.all([
    getSystemProfile(settings), listProjects(), listVoices()
  ]);
  return {
    app: { name: '声绘 Studio', version: '0.1.0' },
    settings,
    system: profile,
    engines: engineCompatibility(profile, settings.selectedEngine, settings.qualityMode),
    projects,
    voices,
    emotions: EMOTIONS,
    jobs: jobs.list()
  };
}

async function handleApi(req, res, url) {
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
    return json(res, 201, project);
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

  let params = routeMatch(pathname, '/api/jobs/:jobId');
  if (params && method === 'GET') return json(res, 200, jobs.get(params.jobId));

  params = routeMatch(pathname, '/api/projects/:projectId');
  if (params && method === 'GET') return json(res, 200, await getProject(params.projectId));
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
    return json(res, 200, project);
  }

  params = routeMatch(pathname, '/api/projects/:projectId/import');
  if (params && method === 'POST') {
    const body = await parseJsonBody(req, MAX_JSON_BYTES);
    const originalBuffer = decodeBase64Payload(body.contentBase64, MAX_BOOK_BYTES);
    const sourceText = normalizeNovelText(decodeBook(originalBuffer, body.fileName));
    const project = await replaceProjectSource(params.projectId, { fileName: body.fileName, sourceText, originalBuffer });
    return json(res, 200, project);
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
    return json(res, 200, project);
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
    return json(res, 200, project);
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
    return json(res, 200, project);
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

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/media/')) return await handleMedia(req, res, url.pathname);
      return await handleStatic(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
      if (status >= 500) console.error(error);
      return json(res, status, { error: error.code || 'REQUEST_FAILED', message: error.message || '未知错误' });
    }
  });
}

async function main() {
  await initStore();
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
