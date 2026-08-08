import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR,
  DEFAULT_SETTINGS,
  EXPORTS_DIR,
  PROJECTS_DIR,
  SETTINGS_PATH,
  TMP_DIR,
  VOICES_DIR
} from './config.js';
import { ensureDir, id, nowIso, readJson, safeName, writeJsonAtomic } from './utils.js';
import { estimateDuration, splitChapters } from './novel.js';

const projectLocks = new Map();
let settingsLock = Promise.resolve();
const PROJECT_ID_PATTERN = /^project_[0-9a-f]{16}$/;
const VOICE_ID_PATTERN = /^voice_[0-9a-f]{16}$/;

function validatedId(value, pattern, label) {
  const candidate = String(value || '');
  if (!pattern.test(candidate)) throw Object.assign(new Error(`${label}标识无效`), { statusCode: 400 });
  return candidate;
}

function colorAt(index) {
  return ['#75d6c2', '#ffb86b', '#a9a0ff', '#f07d9e', '#70a7ff', '#d8cb70'][index % 6];
}

function projectPath(projectId) {
  return path.join(PROJECTS_DIR, validatedId(projectId, PROJECT_ID_PATTERN, '项目'), 'project.json');
}

function voicePath(voiceId) {
  return path.join(VOICES_DIR, validatedId(voiceId, VOICE_ID_PATTERN, '音色'), 'voice.json');
}

async function withProjectLock(projectId, fn) {
  const normalizedId = validatedId(projectId, PROJECT_ID_PATTERN, '项目');
  const previous = projectLocks.get(normalizedId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  projectLocks.set(normalizedId, next);
  try { return await next; } finally {
    if (projectLocks.get(normalizedId) === next) projectLocks.delete(normalizedId);
  }
}

export async function initStore() {
  await Promise.all([
    ensureDir(DATA_DIR), ensureDir(PROJECTS_DIR), ensureDir(VOICES_DIR),
    ensureDir(EXPORTS_DIR), ensureDir(TMP_DIR)
  ]);
  const settings = await readJson(SETTINGS_PATH);
  if (!settings) await writeJsonAtomic(SETTINGS_PATH, DEFAULT_SETTINGS);
  await seedDemoData();
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson(SETTINGS_PATH, {})) };
}

export async function updateSettings(patch) {
  const operation = settingsLock.catch(() => {}).then(async () => {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const filtered = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.has(key)));
    const next = { ...(await getSettings()), ...filtered };
    await writeJsonAtomic(SETTINGS_PATH, next);
    return next;
  });
  settingsLock = operation;
  return operation;
}

export async function listProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
    const project = await readJson(projectPath(entry.name));
    if (!project) continue;
    projects.push(summarizeProject(project));
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function summarizeProject(project) {
  const lines = project.chapters.flatMap((chapter) => chapter.scenes?.flatMap((scene) => scene.lines || []) || []);
  const rendered = lines.filter((line) => line.render?.status === 'ready').length;
  return {
    id: project.id,
    title: project.title,
    author: project.author,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    status: project.status,
    isDemo: Boolean(project.isDemo),
    coverTone: project.coverTone,
    chapterCount: project.chapters.length,
    charCount: project.source?.charCount || 0,
    durationMinutes: project.durationMinutes || estimateDuration(project.source?.charCount || 0),
    characters: project.characters.length,
    renderedLines: rendered,
    totalLines: lines.length,
    progress: lines.length ? Math.round((rendered / lines.length) * 100) : project.status === 'source' ? 8 : 0
  };
}

export async function getProject(projectId) {
  const project = await readJson(projectPath(projectId));
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  return project;
}

export async function createProject({ title, author = '', fileName = '', sourceText = '', isDemo = false }) {
  const projectId = id('project');
  const createdAt = nowIso();
  const chapters = sourceText ? splitChapters(sourceText) : [];
  const project = {
    version: 1,
    id: projectId,
    title: safeName(title || path.parse(fileName || '未命名作品').name, '未命名作品'),
    author: String(author || '').trim().slice(0, 80),
    description: '',
    createdAt,
    updatedAt: createdAt,
    status: chapters.length ? 'source' : 'empty',
    isDemo,
    coverTone: Math.floor(Math.random() * 5),
    source: {
      fileName: fileName ? safeName(fileName) : null,
      charCount: sourceText.length,
      importedAt: sourceText ? createdAt : null,
      sha256: sourceText ? crypto.createHash('sha256').update(sourceText).digest('hex') : null
    },
    durationMinutes: estimateDuration(sourceText.length),
    characters: [{
      id: 'role_narrator', name: '旁白', aliases: [], description: '全书叙述者',
      isNarrator: true, voiceId: null, color: colorAt(0)
    }],
    chapters,
    production: { engineId: 'auto', lastJobId: null, exportIds: [], exports: [] }
  };
  const folder = path.join(PROJECTS_DIR, projectId);
  await ensureDir(path.join(folder, 'source'));
  await ensureDir(path.join(folder, 'renders'));
  await writeJsonAtomic(projectPath(projectId), project);
  if (sourceText) await fs.writeFile(path.join(folder, 'source', 'normalized.txt'), sourceText, 'utf8');
  return project;
}

export async function replaceProjectSource(projectId, { fileName, sourceText, originalBuffer }) {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const projectFolder = path.join(PROJECTS_DIR, projectId);
    const folder = path.join(projectFolder, 'source');
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(path.join(projectFolder, 'renders'), { recursive: true, force: true });
    await fs.rm(path.join(EXPORTS_DIR, projectId), { recursive: true, force: true });
    await ensureDir(folder);
    await ensureDir(path.join(projectFolder, 'renders'));
    if (originalBuffer) await fs.writeFile(path.join(folder, `original${path.extname(fileName).toLowerCase()}`), originalBuffer);
    await fs.writeFile(path.join(folder, 'normalized.txt'), sourceText, 'utf8');
    project.source = {
      fileName: safeName(fileName),
      charCount: sourceText.length,
      importedAt: nowIso(),
      sha256: crypto.createHash('sha256').update(sourceText).digest('hex')
    };
    project.chapters = splitChapters(sourceText);
    project.durationMinutes = estimateDuration(sourceText.length);
    project.characters = project.characters.filter((role) => role.isNarrator);
    project.production = { engineId: project.production?.engineId || 'auto', lastJobId: null, exportIds: [], exports: [] };
    project.status = 'source';
    project.updatedAt = nowIso();
    await writeJsonAtomic(projectPath(projectId), project);
    return project;
  });
}

export async function mutateProject(projectId, mutator) {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const result = await mutator(project);
    project.updatedAt = nowIso();
    await writeJsonAtomic(projectPath(projectId), project);
    return result ?? project;
  });
}

export function mergeRoles(project, roles) {
  const byName = new Map();
  for (const role of project.characters) {
    for (const label of [role.name, ...(role.aliases || [])]) {
      const key = String(label || '').trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, role);
    }
  }
  for (const role of roles || []) {
    const key = String(role.name || '').trim().toLowerCase();
    if (!key) continue;
    const existing = byName.get(key);
    if (existing) {
      existing.aliases = [...new Set([...(existing.aliases || []), ...(role.aliases || [])])];
      for (const alias of existing.aliases) {
        const aliasKey = String(alias).trim().toLowerCase();
        if (aliasKey && !byName.has(aliasKey)) byName.set(aliasKey, existing);
      }
      if (role.description && !existing.description) existing.description = role.description;
      continue;
    }
    const created = {
      id: id('role'),
      name: String(role.name).trim().slice(0, 30),
      aliases: (role.aliases || []).map(String).slice(0, 12),
      description: String(role.description || '').slice(0, 300),
      isNarrator: Boolean(role.isNarrator),
      voiceId: null,
      color: colorAt(project.characters.length)
    };
    project.characters.push(created);
    byName.set(key, created);
    for (const alias of created.aliases) {
      const aliasKey = String(alias).trim().toLowerCase();
      if (aliasKey && !byName.has(aliasKey)) byName.set(aliasKey, created);
    }
  }
  return byName;
}

export async function listVoices() {
  const entries = await fs.readdir(VOICES_DIR, { withFileTypes: true });
  const voices = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VOICE_ID_PATTERN.test(entry.name)) continue;
    const voice = await readJson(voicePath(entry.name));
    if (voice) voices.push(voice);
  }
  return voices.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVoice(voiceId) {
  const voice = await readJson(voicePath(voiceId));
  if (!voice) throw Object.assign(new Error('音色不存在'), { statusCode: 404 });
  return voice;
}

export async function createVoice({ name, tags = [], language = 'zh-CN', transcript = '', kind = 'recorded', consent = false, audio }) {
  if (!consent) throw Object.assign(new Error('请确认你有权使用该声音样本'), { statusCode: 400 });
  const voiceId = id('voice');
  const versionId = id('voicever');
  const dir = path.join(VOICES_DIR, voiceId);
  await ensureDir(dir);
  let reference = null;
  if (audio?.buffer) {
    const ext = ['.wav', '.mp3', '.webm', '.ogg', '.m4a', '.flac'].includes(audio.ext) ? audio.ext : '.bin';
    const fileName = `reference${ext}`;
    await fs.writeFile(path.join(dir, fileName), audio.buffer);
    reference = {
      fileName,
      mediaUrl: `/media/voices/${voiceId}/${fileName}`,
      bytes: audio.buffer.length,
      transcript: String(transcript || '').trim(),
      sha256: crypto.createHash('sha256').update(audio.buffer).digest('hex')
    };
  }
  const timestamp = nowIso();
  const voice = {
    id: voiceId,
    version: 1,
    versionId,
    name: safeName(name, '新音色'),
    kind,
    tags: tags.map(String).slice(0, 10),
    language,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: reference ? 'ready' : 'needs_sample',
    reference,
    consent: { confirmed: true, confirmedAt: timestamp },
    defaults: { speed: 1, pitch: 0 },
    quality: { state: 'unchecked', notes: ['安装 FFmpeg 后可执行响度、静音和削波检测'] }
  };
  await writeJsonAtomic(voicePath(voiceId), voice);
  return voice;
}

export async function deleteVoice(voiceId) {
  const dir = path.resolve(VOICES_DIR, validatedId(voiceId, VOICE_ID_PATTERN, '音色'));
  if (path.dirname(dir) !== path.resolve(VOICES_DIR)) throw Object.assign(new Error('音色路径无效'), { statusCode: 400 });
  await fs.rm(dir, { recursive: true, force: false });
}

export async function findVoiceReferences(voiceId) {
  const normalizedId = validatedId(voiceId, VOICE_ID_PATTERN, '音色');
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const references = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
    const project = await readJson(projectPath(entry.name));
    for (const role of project?.characters || []) {
      if (role.voiceId === normalizedId) references.push({ projectId: project.id, projectTitle: project.title, roleId: role.id, roleName: role.name });
    }
  }
  return references;
}

async function seedDemoData() {
  const projects = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  if (projects.some((entry) => entry.isDirectory())) return;
  const source = `第一章 雾中的来客\n\n海风从旧码头穿过，卷起一阵咸湿的雾。林默把那封没有署名的信攥在掌心，纸角已经被汗水浸软。\n\n“你还是来了。”苏晚站在仓库门口，声音很轻。\n\n林默抬起头，压住心里的惊讶：“这封信，是你写的？”\n\n远处忽然传来汽笛声。苏晚摇了摇头，低声道：“不是我。可我知道寄信的人在哪里。”\n\n第二章 钟楼之下\n\n午夜的钟声敲响十二次。两个人沿着石阶向下，手电筒的光在墙壁上颤动。\n\n“别出声。”林默忽然停住。\n\n黑暗里，有人笑了一声。`;
  const project = await createProject({ title: '雾港来信', author: '示例作品', fileName: '雾港来信.txt', sourceText: source, isDemo: true });
  const { rulesToScript } = await import('./script-engine.js');
  await mutateProject(project.id, (draft) => {
    for (const chapter of draft.chapters) {
      const script = rulesToScript(chapter, 'faithful');
      const roleMap = mergeRoles(draft, script.roles);
      chapter.scenes = script.scenes.map((scene) => ({
        ...scene,
        lines: scene.lines.map((line) => ({
          ...line,
          speakerId: roleMap.get(line.speaker.toLowerCase())?.id || 'role_narrator'
        }))
      }));
      chapter.status = 'scripted';
    }
    draft.status = 'scripted';
  });
}
