import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  MAX_VOICE_ANALYSIS_OVERLAPS,
  MAX_VOICE_ANALYSIS_DURATION_MS,
  MAX_VOICE_ANALYSIS_SEGMENTS,
  MAX_VOICE_ANALYSIS_SPEAKERS,
  MAX_VOICE_ANALYSIS_WORKSPACE_BYTES,
  MAX_VOICE_BYTES,
  MAX_VOICE_EXPORT_MS,
  MIN_VOICE_CLIP_MS,
  VOICE_ANALYSES_DIR,
  VOICE_ANALYSIS_JOBS_DIR,
  VOICE_CLIPS_DIR,
  VOICE_DESIGNS_DIR
} from './config.js';
import { concatenateWavs, parsePcmWav } from './audio.js';
import { createVoice, getVoice, listVoices } from './store.js';
import { deleteVoiceSource } from './video-voice.js';
import { ensureDir, id, isPathInside, nowIso, readJson, safeName, writeJsonAtomic } from './utils.js';

const ANALYSIS_ID_PATTERN = /^voiceanalysis_[a-f0-9]{16}$/;
const DESIGN_ID_PATTERN = /^voicedesign_[a-f0-9]{16}$/;
const SAFE_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MANIFEST_FILE = 'manifest.json';
const DESIGN_FILE = 'design.json';
const DESIGN_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DESIGN_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
const DESIGN_MODELS = new Set([DEFAULT_DESIGN_MODEL]);
const EMOTION_IDS = new Set(['neutral', 'warm', 'joy', 'sad', 'angry', 'fear', 'surprise', 'whisper', 'solemn']);
const EMOTION_ALIASES = new Map([
  ['happy', 'joy'],
  ['fearful', 'fear'],
  ['surprised', 'surprise'],
  ['unknown', 'neutral'],
  ['disgusted', 'neutral']
]);
const analysisLocks = new Map();
const designLocks = new Map();

function apiError(message, { code = 'VOICE_WORKSHOP_INVALID', statusCode = 400, detail = null } = {}) {
  return Object.assign(new Error(message), { code, statusCode, detail });
}

function validateAnalysisId(value) {
  const analysisId = String(value || '');
  if (!ANALYSIS_ID_PATTERN.test(analysisId)) throw apiError('分析标识无效', { code: 'VOICE_ANALYSIS_ID_INVALID' });
  return analysisId;
}

function analysisDirectory(analysisId) {
  const normalized = validateAnalysisId(analysisId);
  const root = path.resolve(VOICE_ANALYSES_DIR);
  const target = path.resolve(root, normalized);
  if (path.dirname(target) !== root) throw apiError('分析路径无效', { code: 'VOICE_ANALYSIS_PATH_INVALID' });
  return target;
}

function analysisManifestPath(analysisId) {
  return path.join(analysisDirectory(analysisId), MANIFEST_FILE);
}

function validateDesignId(value) {
  const designId = String(value || '');
  if (!DESIGN_ID_PATTERN.test(designId)) throw apiError('音色候选标识无效', { code: 'VOICE_DESIGN_ID_INVALID' });
  return designId;
}

function designDirectory(designId) {
  const normalized = validateDesignId(designId);
  const root = path.resolve(VOICE_DESIGNS_DIR);
  const target = path.resolve(root, normalized);
  if (path.dirname(target) !== root) throw apiError('音色候选路径无效', { code: 'VOICE_DESIGN_PATH_INVALID' });
  return target;
}

function designMetadataPath(designId) {
  return path.join(designDirectory(designId), DESIGN_FILE);
}

async function withAnalysisLock(analysisId, operation) {
  const normalized = validateAnalysisId(analysisId);
  const previous = analysisLocks.get(normalized) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  analysisLocks.set(normalized, next);
  try {
    return await next;
  } finally {
    if (analysisLocks.get(normalized) === next) analysisLocks.delete(normalized);
  }
}

async function withDesignLock(designId, operation) {
  const normalized = validateDesignId(designId);
  const previous = designLocks.get(normalized) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  designLocks.set(normalized, next);
  try {
    return await next;
  } finally {
    if (designLocks.get(normalized) === next) designLocks.delete(normalized);
  }
}

function normalizedTags(value) {
  const tags = Array.isArray(value) ? value : String(value || '').split(/[,，]/);
  return tags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
}

function normalizedLanguage(value) {
  return String(value || 'zh-CN').trim().slice(0, 30) || 'zh-CN';
}

function normalizedEmotion(value) {
  const emotion = String(value || 'neutral').trim().toLowerCase();
  return EMOTION_IDS.has(emotion) ? emotion : EMOTION_ALIASES.get(emotion) || 'neutral';
}

function finiteConfidence(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function checkedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Math.round(Number(value));
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw apiError(`${label}无效`, { code: 'VOICE_ANALYSIS_RESULT_INVALID', statusCode: 502 });
  }
  return number;
}

function pathForWorker(localPath, profile) {
  const workerPlatform = String(profile?.worker?.platform || '');
  if (process.platform === 'win32' && /^linux/i.test(workerPlatform)) {
    const normalized = path.resolve(localPath).replaceAll('\\', '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return localPath;
}

function pathFromWorker(workerPath, profile, fallbackRoot) {
  const value = String(workerPath || '').trim();
  if (!value) throw apiError('工作器没有返回片段音频路径', { code: 'VOICE_ANALYSIS_AUDIO_MISSING', statusCode: 502 });
  if (process.platform === 'win32' && /^linux/i.test(String(profile?.worker?.platform || ''))) {
    const match = value.replaceAll('\\', '/').match(/^\/mnt\/([A-Za-z])\/(.*)$/);
    if (match) return path.resolve(`${match[1].toUpperCase()}:\\`, ...match[2].split('/'));
  }
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(fallbackRoot, value);
}

function workerError(payload, status, fallbackCode) {
  const detail = payload?.detail;
  const message = typeof detail === 'string'
    ? detail
    : detail?.message || payload?.message || `模型工作器返回 HTTP ${status}`;
  return apiError(message, {
    code: payload?.code || detail?.code || fallbackCode,
    statusCode: status >= 400 && status < 500 ? status : 502,
    detail: typeof detail === 'object' ? detail : null
  });
}

async function postWorker(settings, endpoint, request, { timeoutMs, fallbackCode }) {
  const response = await fetch(`${String(settings.workerUrl || '').replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw workerError(payload, response.status, fallbackCode);
  return payload;
}

async function checkedWav(filePath, {
  root,
  maxBytes = MAX_VOICE_BYTES,
  expectedDurationMs = null,
  durationToleranceMs = 1500
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filePath);
  if (!isPathInside(resolvedRoot, resolved)) {
    throw apiError('工作器输出路径越界', { code: 'VOICE_WORKER_PATH_ESCAPE', statusCode: 502 });
  }
  const stat = await fs.lstat(resolved).catch((error) => {
    if (error.code === 'ENOENT') throw apiError('工作器没有生成音频', { code: 'VOICE_WORKER_OUTPUT_MISSING', statusCode: 502 });
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 44 || stat.size > maxBytes) {
    throw apiError('工作器生成的音频文件无效', { code: 'VOICE_WORKER_OUTPUT_INVALID', statusCode: 502 });
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(resolved)]);
  if (!isPathInside(realRoot, realFile)) {
    throw apiError('工作器输出路径越界', { code: 'VOICE_WORKER_PATH_ESCAPE', statusCode: 502 });
  }
  const buffer = await fs.readFile(realFile);
  let wav;
  try {
    wav = parsePcmWav(buffer);
  } catch (error) {
    throw apiError(error.message, { code: 'VOICE_WORKER_FORMAT_INVALID', statusCode: 502 });
  }
  if (wav.sampleRate !== 24000 || wav.channels !== 1) {
    throw apiError('音频必须是 24kHz 单声道 16-bit PCM WAV', { code: 'VOICE_WORKER_FORMAT_INVALID', statusCode: 502 });
  }
  const durationMs = Math.round(wav.data.length / (wav.sampleRate * wav.channels * 2) * 1000);
  if (expectedDurationMs !== null && Math.abs(durationMs - expectedDurationMs) > durationToleranceMs) {
    throw apiError('片段音频时长与分析结果不一致', { code: 'VOICE_ANALYSIS_DURATION_MISMATCH', statusCode: 502 });
  }
  return { buffer, durationMs, sampleRate: wav.sampleRate, channels: wav.channels, bytes: stat.size, realPath: realFile };
}

async function checkedWorkspaceBytes(root, sourceBytes = 0) {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  let total = Math.max(0, Number(sourceBytes) || 0);
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.resolve(current, entry.name);
      if (!isPathInside(resolvedRoot, target) || entry.isSymbolicLink()) {
        throw apiError('分析工作区包含无效路径', { code: 'VOICE_ANALYSIS_PATH_INVALID', statusCode: 502 });
      }
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) {
        throw apiError('分析工作区包含不支持的文件类型', { code: 'VOICE_ANALYSIS_OUTPUT_INVALID', statusCode: 502 });
      }
      total += (await fs.stat(target)).size;
      if (total > MAX_VOICE_ANALYSIS_WORKSPACE_BYTES) {
        throw apiError('分析工作区超过 4 GB 安全限制', {
          code: 'VOICE_ANALYSIS_OUTPUT_TOO_LARGE', statusCode: 502
        });
      }
    }
  }
  return total;
}

function publicSegment(segment) {
  return {
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    durationMs: segment.durationMs,
    text: segment.text,
    emotion: segment.emotion,
    emotionConfidence: segment.emotionConfidence,
    transcriptConfidence: segment.transcriptConfidence,
    keep: segment.keep,
    mediaUrl: segment.mediaUrl,
    speakerId: segment.speakerId,
    speakerIds: segment.speakerIds,
    isOverlap: segment.isOverlap,
    containsOverlap: segment.containsOverlap,
    sourceSegmentId: segment.sourceSegmentId,
    textAlignment: segment.textAlignment
  };
}

function publicAnalysis(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    revision: manifest.revision,
    name: manifest.name,
    status: manifest.status,
    language: manifest.language,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    source: {
      fileName: manifest.source.fileName,
      kind: manifest.source.kind,
      bytes: manifest.source.bytes,
      sha256: manifest.source.sha256,
      mediaUrl: manifest.source.mediaUrl
    },
    durationMs: manifest.durationMs,
    capabilities: manifest.capabilities,
    warnings: manifest.warnings,
    speakers: manifest.speakers.map((speaker) => ({
      id: speaker.id,
      label: speaker.label,
      totalDurationMs: speaker.segments.reduce((sum, segment) => sum + segment.durationMs, 0),
      segments: speaker.segments.map(publicSegment)
    })),
    overlaps: manifest.overlaps.map(publicSegment)
  };
}

async function readManifest(analysisId) {
  const manifest = await readJson(analysisManifestPath(analysisId));
  if (!manifest) throw apiError('分析结果不存在', { code: 'VOICE_ANALYSIS_NOT_FOUND', statusCode: 404 });
  return manifest;
}

async function saveManifest(manifest) {
  manifest.revision = Math.max(1, Number(manifest.revision) || 1);
  manifest.updatedAt = nowIso();
  await writeJsonAtomic(analysisManifestPath(manifest.id), manifest);
  return manifest;
}

function publicVoiceDesign(record) {
  return {
    id: record.id,
    designId: record.id,
    version: record.version,
    status: record.status,
    name: record.name,
    prompt: record.prompt,
    previewText: record.previewText,
    language: record.language,
    tags: record.tags,
    modelId: record.modelId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    committedAt: record.committedAt || null,
    voiceId: record.voiceId || null,
    mediaUrl: record.reference.mediaUrl,
    reference: { ...record.reference }
  };
}

async function readVoiceDesignRecord(designId, { allowExpired = false } = {}) {
  const record = await readJson(designMetadataPath(designId));
  if (!record) throw apiError('音色候选不存在', { code: 'VOICE_DESIGN_NOT_FOUND', statusCode: 404 });
  if (!allowExpired && Date.parse(record.expiresAt || '') <= Date.now()) {
    await fs.rm(designDirectory(designId), { recursive: true, force: true }).catch(() => {});
    throw apiError('音色候选已过期，请重新生成', { code: 'VOICE_DESIGN_EXPIRED', statusCode: 410 });
  }
  return record;
}

async function saveVoiceDesignRecord(record) {
  record.updatedAt = nowIso();
  await writeJsonAtomic(designMetadataPath(record.id), record);
  return record;
}

export async function cleanupExpiredVoiceDesigns(now = Date.now()) {
  await ensureDir(VOICE_DESIGNS_DIR);
  const entries = await fs.readdir(VOICE_DESIGNS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !DESIGN_ID_PATTERN.test(entry.name)) continue;
    await withDesignLock(entry.name, async () => {
      const dir = designDirectory(entry.name);
      const record = await readJson(path.join(dir, DESIGN_FILE));
      let expiresAt = Date.parse(record?.expiresAt || '');
      if (!Number.isFinite(expiresAt)) {
        const stat = await fs.stat(dir);
        expiresAt = stat.mtimeMs + DESIGN_TTL_MS;
      }
      if (expiresAt <= now) await fs.rm(dir, { recursive: true, force: true });
    });
  }
}

export async function listVoiceDesigns() {
  await cleanupExpiredVoiceDesigns();
  const entries = await fs.readdir(VOICE_DESIGNS_DIR, { withFileTypes: true });
  const designs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !DESIGN_ID_PATTERN.test(entry.name)) continue;
    const record = await readJson(path.join(VOICE_DESIGNS_DIR, entry.name, DESIGN_FILE));
    if (record) designs.push(publicVoiceDesign(record));
  }
  return designs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVoiceDesign(designId) {
  return publicVoiceDesign(await readVoiceDesignRecord(designId));
}

export function validateVoiceDesign(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('音色设计参数无效');
  const allowed = new Set(['name', 'prompt', 'previewText', 'text', 'language', 'tags', 'consent', 'modelId']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw apiError('音色设计包含不支持的字段');
  const name = safeName(value.name, '自定义设计音色');
  const prompt = String(value.prompt || '').trim();
  const previewText = String(value.previewText ?? value.text ?? '').trim();
  const modelId = String(value.modelId || DEFAULT_DESIGN_MODEL).trim();
  if (prompt.length < 5 || prompt.length > 2000) throw apiError('音色提示词须为 5–2000 个字符');
  if (previewText.length < 2 || previewText.length > 500) throw apiError('试听台词须为 2–500 个字符');
  if (!DESIGN_MODELS.has(modelId)) throw apiError('不支持该 VoiceDesign 模型', { code: 'VOICE_DESIGN_MODEL_INVALID' });
  if (value.consent !== true) throw apiError('请确认提示词和生成内容可合法使用', { code: 'VOICE_CONSENT_REQUIRED' });
  return {
    name,
    prompt,
    previewText,
    language: normalizedLanguage(value.language),
    tags: normalizedTags(value.tags),
    consent: true,
    modelId
  };
}

export async function designVoice(voiceInput, { settings, profile }, update = () => {}) {
  const designId = id('voicedesign');
  const outputDir = path.resolve(VOICE_CLIPS_DIR, designId);
  const outputPath = path.join(outputDir, 'reference.wav');
  const finalDir = designDirectory(designId);
  if (!isPathInside(VOICE_CLIPS_DIR, outputDir) || !isPathInside(VOICE_DESIGNS_DIR, finalDir)) {
    throw apiError('音色设计输出路径无效');
  }
  try {
    await cleanupExpiredVoiceDesigns();
    if (!profile?.worker?.online) throw apiError('模型工作器未启动', { code: 'WORKER_OFFLINE', statusCode: 503 });
    if (profile.worker.providers?.qwen3_tts === false) {
      throw apiError('工作器没有安装 Qwen3-TTS', { code: 'VOICE_DESIGN_UNAVAILABLE', statusCode: 503 });
    }
    await ensureDir(outputDir);
    update(10, '正在根据提示词设计音色');
    const response = await postWorker(settings, '/v1/voice/design', {
      request_id: id('design'),
      model_id: voiceInput.modelId,
      text: voiceInput.previewText,
      prompt: voiceInput.prompt,
      language: voiceInput.language,
      output_path: pathForWorker(outputPath, profile)
    }, { timeoutMs: 20 * 60_000, fallbackCode: 'VOICE_DESIGN_FAILED' });
    update(75, '正在校验并保存候选试听');
    const audio = await checkedWav(outputPath, { root: outputDir });
    if (audio.durationMs < 1000 || audio.durationMs > 60_000) {
      throw apiError('设计试听音频时长须为 1–60 秒', { code: 'VOICE_DESIGN_DURATION_INVALID', statusCode: 502 });
    }
    const timestamp = nowIso();
    const record = {
      id: designId,
      version: 1,
      status: 'draft',
      name: voiceInput.name,
      prompt: voiceInput.prompt,
      previewText: voiceInput.previewText,
      language: voiceInput.language,
      tags: voiceInput.tags,
      modelId: String(response.model_id || voiceInput.modelId),
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + DESIGN_TTL_MS).toISOString(),
      committedAt: null,
      voiceId: null,
      reference: {
        fileName: 'reference.wav',
        mediaUrl: `/media/voice-designs/${designId}/reference.wav`,
        transcript: voiceInput.previewText,
        bytes: audio.bytes,
        sha256: crypto.createHash('sha256').update(audio.buffer).digest('hex'),
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channels: audio.channels
      }
    };
    await ensureDir(VOICE_DESIGNS_DIR);
    await writeJsonAtomic(path.join(outputDir, DESIGN_FILE), record);
    await fs.rename(outputDir, finalDir);
    update(100, '候选试听已生成，确认后再加入音色库');
    return publicVoiceDesign(record);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function commitVoiceDesign(designId) {
  return withDesignLock(designId, async () => {
    const record = await readVoiceDesignRecord(designId);
    let voice = null;
    let alreadyCommitted = false;
    if (record.voiceId) {
      voice = await getVoice(record.voiceId).catch((error) => {
        if (error.statusCode === 404) {
          throw apiError('候选记录对应的音色已被删除，不能重复提交', {
            code: 'VOICE_DESIGN_COMMITTED_VOICE_MISSING', statusCode: 409
          });
        }
        throw error;
      });
      alreadyCommitted = true;
    } else {
      voice = (await listVoices()).find((item) => item.design?.designId === record.id) || null;
      if (voice) {
        alreadyCommitted = true;
      } else {
        const candidatePath = path.join(designDirectory(record.id), record.reference.fileName);
        const audio = await checkedWav(candidatePath, { root: designDirectory(record.id) });
        const sha256 = crypto.createHash('sha256').update(audio.buffer).digest('hex');
        if (sha256 !== record.reference.sha256 || audio.bytes !== record.reference.bytes) {
          throw apiError('候选试听文件已被修改', { code: 'VOICE_DESIGN_CHANGED', statusCode: 409 });
        }
        voice = await createVoice({
          name: record.name,
          tags: ['提示词设计', ...record.tags].slice(0, 10),
          language: record.language,
          transcript: record.previewText,
          consent: true,
          kind: 'voice-design',
          audio: {
            buffer: audio.buffer,
            ext: '.wav',
            durationMs: audio.durationMs,
            sampleRate: audio.sampleRate,
            channels: audio.channels
          },
          design: {
            designId: record.id,
            prompt: record.prompt,
            previewText: record.previewText,
            modelId: record.modelId
          }
        });
      }
      record.status = 'committed';
      record.voiceId = voice.id;
      record.committedAt ||= nowIso();
      await saveVoiceDesignRecord(record);
    }
    return {
      design: publicVoiceDesign(record),
      voice,
      voiceId: voice.id,
      mediaUrl: voice.reference?.mediaUrl || null,
      name: voice.name,
      alreadyCommitted
    };
  });
}

export async function discardVoiceDesign(designId) {
  return withDesignLock(designId, async () => {
    await fs.rm(designDirectory(designId), { recursive: true, force: true });
  });
}

export function validateVoiceAnalysis(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('分析参数无效');
  const allowed = new Set(['name', 'language', 'speakerCount', 'consent']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw apiError('分析请求包含不支持的字段');
  if (value.consent !== true) throw apiError('请确认你有权分析和使用该媒体中的声音', { code: 'VOICE_CONSENT_REQUIRED' });
  let speakerCount = null;
  if (value.speakerCount !== undefined && value.speakerCount !== null && value.speakerCount !== '') {
    speakerCount = Number(value.speakerCount);
    if (!Number.isSafeInteger(speakerCount) || speakerCount < 1 || speakerCount > MAX_VOICE_ANALYSIS_SPEAKERS) {
      throw apiError(`说话人数须为 1–${MAX_VOICE_ANALYSIS_SPEAKERS} 的整数`);
    }
  }
  return {
    name: safeName(value.name, '说话人分析'),
    language: normalizedLanguage(value.language),
    speakerCount,
    consent: true
  };
}

function uniqueSafeId(candidate, prefix, seen) {
  let normalized = String(candidate || '').trim();
  if (!SAFE_ITEM_ID_PATTERN.test(normalized) || seen.has(normalized)) normalized = id(prefix);
  seen.add(normalized);
  return normalized;
}

async function normalizeWorkerSegment(raw, {
  outputDir,
  profile,
  analysisId,
  speakerId = null,
  speakerIds = [],
  isOverlap = false,
  seenSegmentIds
}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('工作器返回了无效片段', { code: 'VOICE_ANALYSIS_RESULT_INVALID', statusCode: 502 });
  }
  const startMs = checkedInteger(raw.start_ms ?? (Number(raw.start_seconds) * 1000), '片段开始时间');
  const endMs = checkedInteger(raw.end_ms ?? (Number(raw.end_seconds) * 1000), '片段结束时间');
  if (endMs <= startMs) throw apiError('片段结束时间无效', { code: 'VOICE_ANALYSIS_RESULT_INVALID', statusCode: 502 });
  const durationMs = endMs - startMs;
  const workerAudioPath = raw.audio_path ?? raw.audioPath;
  const audioPath = pathFromWorker(workerAudioPath, profile, outputDir);
  const audio = await checkedWav(audioPath, {
    root: outputDir,
    expectedDurationMs: durationMs,
    durationToleranceMs: 2000
  });
  const relativeAudioPath = path.relative(outputDir, audio.realPath).split(path.sep).join('/');
  const containsOverlap = isOverlap || raw.overlap === true || raw.contains_overlap === true;
  return {
    id: uniqueSafeId(raw.segment_id ?? raw.id, 'segment', seenSegmentIds),
    startMs,
    endMs,
    durationMs: audio.durationMs,
    text: String(raw.text ?? raw.transcript ?? '').trim().slice(0, 2000),
    emotion: normalizedEmotion(raw.emotion),
    emotionConfidence: finiteConfidence(raw.emotion_confidence ?? raw.emotionConfidence ?? raw.confidence),
    transcriptConfidence: finiteConfidence(raw.transcript_confidence ?? raw.transcriptConfidence ?? raw.confidence),
    keep: !containsOverlap,
    audioFile: relativeAudioPath,
    mediaUrl: `/media/voice-analyses/${analysisId}/${relativeAudioPath.split('/').map(encodeURIComponent).join('/')}`,
    speakerId,
    speakerIds: isOverlap ? speakerIds : undefined,
    isOverlap,
    containsOverlap,
    sourceSegmentId: String(raw.source_segment_id || '').slice(0, 80) || undefined,
    textAlignment: ['segment', 'source_segment'].includes(raw.text_alignment) ? raw.text_alignment : 'segment'
  };
}

function normalizedCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
    String(key).slice(0, 80),
    typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string'
      ? item
      : Boolean(item)
  ]));
}

export function workerSpeakerSegments(speaker) {
  const segments = Array.isArray(speaker?.segments) ? speaker.segments : [];
  if (!Array.isArray(speaker?.clean_segments)) return segments;
  const clean = speaker.clean_segments;
  const represented = new Set(clean.map((segment) => String(segment.source_segment_id || segment.id || segment.segment_id || '')));
  // Preserve excluded ASR sentences for review. "Not usable for cloning" must
  // not mean losing their transcript and original audio from the session.
  const excluded = segments.filter((segment) => !represented.has(String(segment.id || segment.segment_id || '')))
    .map((segment) => ({ ...segment, contains_overlap: true }));
  return [...clean, ...excluded].sort((a, b) => Number(a.start_ms || 0) - Number(b.start_ms || 0));
}

export async function analyzeVoiceSource(source, analysisInput, { settings, profile }, update = () => {}) {
  const analysisId = id('voiceanalysis');
  const outputDir = path.resolve(VOICE_ANALYSIS_JOBS_DIR, analysisId);
  const finalDir = analysisDirectory(analysisId);
  if (!isPathInside(VOICE_ANALYSIS_JOBS_DIR, outputDir) || !isPathInside(VOICE_ANALYSES_DIR, finalDir)) {
    throw apiError('分析工作区路径无效');
  }
  try {
    if (!profile?.worker?.online) throw apiError('模型工作器未启动', { code: 'WORKER_OFFLINE', statusCode: 503 });
    if (!profile.worker.ffmpeg || !profile.worker.ffprobe) {
      throw apiError('工作器需要 FFmpeg 和 FFprobe 才能分析媒体', { code: 'VOICE_ANALYSIS_MEDIA_TOOLS_UNAVAILABLE', statusCode: 503 });
    }
    await ensureDir(VOICE_ANALYSIS_JOBS_DIR);
    await ensureDir(VOICE_ANALYSES_DIR);
    const outputExists = await fs.stat(outputDir).then(() => true, () => false);
    if (outputExists) throw apiError('分析临时目录已存在', { code: 'VOICE_ANALYSIS_WORKSPACE_CONFLICT', statusCode: 409 });
    update(5, '正在识别台词、说话人、语气和重叠语音');
    const request = {
      request_id: id('analysis'),
      source_path: pathForWorker(source.filePath, profile),
      output_dir: pathForWorker(outputDir, profile),
      language: analysisInput.language
    };
    if (analysisInput.speakerCount !== null) request.speaker_count = analysisInput.speakerCount;
    const response = await postWorker(settings, '/v1/voice-analysis', request, {
      timeoutMs: 2 * 60 * 60_000,
      fallbackCode: 'VOICE_ANALYSIS_FAILED'
    });
    const outputStat = await fs.lstat(outputDir).catch((error) => {
      if (error.code === 'ENOENT') throw apiError('工作器没有生成分析工作区', { code: 'VOICE_ANALYSIS_OUTPUT_MISSING', statusCode: 502 });
      throw error;
    });
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
      throw apiError('工作器生成的分析工作区无效', { code: 'VOICE_ANALYSIS_OUTPUT_INVALID', statusCode: 502 });
    }
    await checkedWorkspaceBytes(outputDir, source.bytes);
    const rawSpeakers = Array.isArray(response.speakers) ? response.speakers : [];
    const rawOverlaps = Array.isArray(response.overlaps) ? response.overlaps : [];
    if (!rawSpeakers.length || rawSpeakers.length > MAX_VOICE_ANALYSIS_SPEAKERS) {
      throw apiError('说话人识别结果数量无效', { code: 'VOICE_ANALYSIS_RESULT_INVALID', statusCode: 502 });
    }
    if (rawOverlaps.length > MAX_VOICE_ANALYSIS_OVERLAPS) {
      throw apiError('重叠片段数量超过安全限制', { code: 'VOICE_ANALYSIS_RESULT_TOO_LARGE', statusCode: 502 });
    }
    const segmentCount = rawSpeakers.reduce((sum, speaker) => {
      return sum + workerSpeakerSegments(speaker).length;
    }, 0);
    if ((segmentCount === 0 && rawOverlaps.length === 0) || segmentCount > MAX_VOICE_ANALYSIS_SEGMENTS) {
      throw apiError('语音片段数量无效或超过安全限制', { code: 'VOICE_ANALYSIS_RESULT_TOO_LARGE', statusCode: 502 });
    }
    update(72, '正在校验分析片段');
    const seenSpeakerIds = new Set();
    const seenSegmentIds = new Set();
    const speakerIdMap = new Map();
    const speakerRecords = rawSpeakers.map((rawSpeaker, index) => {
      const rawId = rawSpeaker?.speaker_id ?? rawSpeaker?.id ?? `speaker_${index + 1}`;
      const speakerId = uniqueSafeId(rawId, 'speaker', seenSpeakerIds);
      speakerIdMap.set(String(rawId), speakerId);
      return { rawSpeaker, speakerId, index };
    });
    const speakers = [];
    for (const { rawSpeaker, speakerId, index } of speakerRecords) {
      const segments = [];
      const workerSegments = workerSpeakerSegments(rawSpeaker);
      for (const rawSegment of workerSegments) {
        segments.push(await normalizeWorkerSegment(rawSegment, {
          outputDir, profile, analysisId, speakerId, seenSegmentIds
        }));
      }
      speakers.push({
        id: speakerId,
        label: safeName(rawSpeaker.label || rawSpeaker.name, `说话人 ${index + 1}`),
        segments
      });
    }
    const overlaps = [];
    for (const rawOverlap of rawOverlaps) {
      const rawSpeakerIds = Array.isArray(rawOverlap.speaker_ids)
        ? rawOverlap.speaker_ids
        : Array.isArray(rawOverlap.speakerIds) ? rawOverlap.speakerIds : [];
      const speakerIds = [...new Set(rawSpeakerIds.map((value) => speakerIdMap.get(String(value))).filter(Boolean))];
      overlaps.push(await normalizeWorkerSegment(rawOverlap, {
        outputDir, profile, analysisId, speakerIds, isOverlap: true, seenSegmentIds
      }));
    }
    const extension = path.extname(source.filePath).toLowerCase();
    const storedSourceName = `source${extension}`;
    await fs.copyFile(source.filePath, path.join(outputDir, storedSourceName), fsConstants.COPYFILE_EXCL);
    const timestamp = nowIso();
    const manifest = {
      id: analysisId,
      version: 1,
      revision: 1,
      name: analysisInput.name === '说话人分析'
        ? safeName(path.parse(source.fileName).name, analysisInput.name)
        : analysisInput.name,
      status: 'ready',
      language: analysisInput.language,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: {
        fileName: source.fileName,
        storedFileName: storedSourceName,
        kind: source.kind,
        bytes: source.bytes,
        sha256: source.sha256,
        mediaUrl: `/media/voice-analyses/${analysisId}/${storedSourceName}`
      },
      durationMs: checkedInteger(
        response.duration_ms ?? (Number(response.duration_seconds) * 1000),
        '媒体时长',
        { min: 1, max: MAX_VOICE_ANALYSIS_DURATION_MS }
      ),
      capabilities: normalizedCapabilities(response.capabilities),
      warnings: (Array.isArray(response.warnings) ? response.warnings : [])
        .map((warning) => String(warning).trim().slice(0, 500)).filter(Boolean).slice(0, 50),
      speakers,
      overlaps
    };
    await writeJsonAtomic(path.join(outputDir, MANIFEST_FILE), manifest);
    await fs.rename(outputDir, finalDir);
    await deleteVoiceSource(source.id, { allowClaimed: true, missingOk: true });
    update(100, '说话人分析已完成');
    return { analysisId, name: manifest.name, durationMs: manifest.durationMs, speakerCount: speakers.length };
  } catch (error) {
    await Promise.allSettled([
      fs.rm(outputDir, { recursive: true, force: true }),
      fs.rm(finalDir, { recursive: true, force: true }),
      deleteVoiceSource(source.id, { allowClaimed: true, missingOk: true })
    ]);
    throw error;
  }
}

export async function getVoiceAnalysis(analysisId) {
  return publicAnalysis(await readManifest(analysisId));
}

export async function listVoiceAnalyses() {
  await ensureDir(VOICE_ANALYSES_DIR);
  const entries = await fs.readdir(VOICE_ANALYSES_DIR, { withFileTypes: true });
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ANALYSIS_ID_PATTERN.test(entry.name)) continue;
    const manifest = await readJson(path.join(VOICE_ANALYSES_DIR, entry.name, MANIFEST_FILE));
    if (!manifest) continue;
    summaries.push({
      id: manifest.id,
      name: manifest.name,
      status: manifest.status,
      language: manifest.language,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      durationMs: manifest.durationMs,
      speakerCount: Array.isArray(manifest.speakers) ? manifest.speakers.length : 0,
      segmentCount: (manifest.speakers || []).reduce((sum, speaker) => sum + (speaker.segments?.length || 0), 0),
      overlapCount: Array.isArray(manifest.overlaps) ? manifest.overlaps.length : 0,
      source: {
        fileName: manifest.source?.fileName,
        kind: manifest.source?.kind,
        mediaUrl: manifest.source?.mediaUrl
      },
      capabilities: manifest.capabilities || {},
      warnings: manifest.warnings || []
    });
  }
  return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function updateVoiceAnalysis(analysisId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw apiError('分析修改参数无效');
  const allowed = new Set(['name']);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw apiError('分析修改包含不支持的字段');
  return withAnalysisLock(analysisId, async () => {
    const manifest = await readManifest(analysisId);
    if ('name' in patch) manifest.name = safeName(patch.name, manifest.name);
    manifest.revision += 1;
    await saveManifest(manifest);
    return publicAnalysis(manifest);
  });
}

function findManifestSegmentRecord(manifest, segmentId) {
  const normalized = String(segmentId || '');
  if (!SAFE_ITEM_ID_PATTERN.test(normalized)) throw apiError('片段标识无效', { code: 'VOICE_SEGMENT_ID_INVALID' });
  for (const speaker of manifest.speakers) {
    const index = speaker.segments.findIndex((item) => item.id === normalized);
    if (index >= 0) return { segment: speaker.segments[index], speaker, index, isOverlap: false };
  }
  const index = manifest.overlaps.findIndex((item) => item.id === normalized);
  if (index >= 0) return { segment: manifest.overlaps[index], speaker: null, index, isOverlap: true };
  throw apiError('片段不存在', { code: 'VOICE_SEGMENT_NOT_FOUND', statusCode: 404 });
}

function validateSegmentPatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw apiError('片段修改参数无效');
  const allowed = new Set(['text', 'emotion', 'keep', 'speakerId']);
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !allowed.has(key))) {
    throw apiError('片段修改包含不支持的字段');
  }
  if ('text' in patch && (typeof patch.text !== 'string' || patch.text.trim().length > 2000)) {
    throw apiError('台词须为不超过 2000 个字符的文本');
  }
  if ('emotion' in patch && !EMOTION_IDS.has(String(patch.emotion || '').trim().toLowerCase())) {
    throw apiError('语气标识无效');
  }
  if ('keep' in patch && typeof patch.keep !== 'boolean') throw apiError('keep 必须是布尔值');
  if ('speakerId' in patch && (
    typeof patch.speakerId !== 'string'
    || (patch.speakerId !== 'overlap' && !SAFE_ITEM_ID_PATTERN.test(patch.speakerId))
  )) {
    throw apiError('说话人标识无效', { code: 'VOICE_SPEAKER_ID_INVALID' });
  }
}

function applySegmentPatch(manifest, segmentId, patch) {
    const record = findManifestSegmentRecord(manifest, segmentId);
    const { segment } = record;
    if ('speakerId' in patch && patch.speakerId !== 'overlap') {
      const target = manifest.speakers.find((speaker) => speaker.id === patch.speakerId);
      if (!target) throw apiError('目标说话人不存在', { code: 'VOICE_SPEAKER_NOT_FOUND', statusCode: 404 });
      if (record.isOverlap) {
        manifest.overlaps.splice(record.index, 1);
        target.segments.push(segment);
        segment.isOverlap = false;
        segment.containsOverlap = true;
        segment.speakerIds = undefined;
        segment.speakerId = target.id;
      } else if (record.speaker.id !== target.id) {
        record.speaker.segments.splice(record.index, 1);
        target.segments.push(segment);
        segment.speakerId = target.id;
      }
    } else if ('speakerId' in patch && patch.speakerId === 'overlap' && !record.isOverlap) {
      record.speaker.segments.splice(record.index, 1);
      manifest.overlaps.push(segment);
      segment.isOverlap = true;
      segment.containsOverlap = true;
      segment.speakerIds = [record.speaker.id];
      segment.speakerId = null;
      if (!('keep' in patch)) segment.keep = false;
    }
    if ('text' in patch) segment.text = patch.text.trim();
    if ('emotion' in patch) segment.emotion = String(patch.emotion).trim().toLowerCase();
    if ('keep' in patch) segment.keep = patch.keep;
    return segment;
}

export async function updateVoiceAnalysisSegments(analysisId, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_VOICE_ANALYSIS_SEGMENTS) throw apiError('片段修改列表无效');
  const ids = new Set();
  for (const edit of edits) {
    if (!edit || Object.keys(edit).some((key) => !['segmentId', 'patch'].includes(key)) || typeof edit.segmentId !== 'string' || !SAFE_ITEM_ID_PATTERN.test(edit.segmentId) || ids.has(edit.segmentId)) {
      throw apiError('片段标识无效或重复');
    }
    validateSegmentPatch(edit.patch);
    ids.add(edit.segmentId);
  }
  return withAnalysisLock(analysisId, async () => {
    const manifest = await readManifest(analysisId);
    const segments = edits.map((edit) => publicSegment(applySegmentPatch(manifest, edit.segmentId, edit.patch)));
    for (const speaker of manifest.speakers) speaker.segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    manifest.overlaps.sort((a, b) => a.startMs - b.startMs);
    manifest.revision += 1;
    await saveManifest(manifest);
    return { analysis: publicAnalysis(manifest), segments, revision: manifest.revision, updatedAt: manifest.updatedAt };
  });
}

export async function updateVoiceAnalysisSegment(analysisId, segmentId, patch = {}) {
  const result = await updateVoiceAnalysisSegments(analysisId, [{ segmentId, patch }]);
  return { ...result, segment: result.segments[0] };
}

export async function updateVoiceAnalysisSpeaker(analysisId, speakerId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => key !== 'label')) {
    throw apiError('说话人修改参数无效');
  }
  return withAnalysisLock(analysisId, async () => {
    const manifest = await readManifest(analysisId);
    const speaker = manifest.speakers.find((item) => item.id === String(speakerId || ''));
    if (!speaker) throw apiError('说话人不存在', { code: 'VOICE_SPEAKER_NOT_FOUND', statusCode: 404 });
    speaker.label = safeName(patch.label, speaker.label);
    manifest.revision += 1;
    await saveManifest(manifest);
    return { speaker: { id: speaker.id, label: speaker.label }, revision: manifest.revision, updatedAt: manifest.updatedAt };
  });
}

export async function addVoiceAnalysisSpeaker(analysisId, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => key !== 'label')
    || typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 80) {
    throw apiError('请输入 1–80 个字符的对话人名称');
  }
  return withAnalysisLock(analysisId, async () => {
    const manifest = await readManifest(analysisId);
    if (manifest.speakers.length >= MAX_VOICE_ANALYSIS_SPEAKERS) {
      throw apiError(`每个 Session 最多支持 ${MAX_VOICE_ANALYSIS_SPEAKERS} 个对话人`, { statusCode: 409 });
    }
    const label = safeName(input.label);
    if (manifest.speakers.some((speaker) => speaker.label === label)) {
      throw apiError('这个 Session 已有同名对话人', { code: 'VOICE_SPEAKER_EXISTS', statusCode: 409 });
    }
    const speaker = { id: id('speaker'), label, segments: [] };
    manifest.speakers.push(speaker);
    manifest.revision += 1;
    await saveManifest(manifest);
    return { analysis: publicAnalysis(manifest), speaker: { id: speaker.id, label }, revision: manifest.revision };
  });
}

export function validateSpeakerExport(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('导出参数无效');
  const allowed = new Set(['name', 'tags', 'language', 'consent', 'includeOverlap', 'segmentIds']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw apiError('导出请求包含不支持的字段');
  if (value.consent !== true) throw apiError('请确认你有权使用选中的声音片段', { code: 'VOICE_CONSENT_REQUIRED' });
  if ('includeOverlap' in value && typeof value.includeOverlap !== 'boolean') throw apiError('includeOverlap 必须是布尔值');
  let segmentIds = null;
  if (value.segmentIds !== undefined) {
    if (!Array.isArray(value.segmentIds) || !value.segmentIds.length || value.segmentIds.length > 1000) {
      throw apiError('segmentIds 须为非空片段 ID 数组');
    }
    segmentIds = [...new Set(value.segmentIds.map((item) => String(item || '')))];
    if (segmentIds.length !== value.segmentIds.length || segmentIds.some((item) => !SAFE_ITEM_ID_PATTERN.test(item))) {
      throw apiError('segmentIds 包含重复或无效标识');
    }
  }
  return {
    name: safeName(value.name, '分析音色'),
    tags: normalizedTags(value.tags),
    language: normalizedLanguage(value.language),
    consent: true,
    includeOverlap: value.includeOverlap === true,
    segmentIds
  };
}

export async function exportSpeakerVoice(analysisId, speakerId, exportInput, update = () => {}) {
  const manifest = await readManifest(analysisId);
  const speaker = manifest.speakers.find((item) => item.id === String(speakerId || ''));
  if (!speaker) throw apiError('说话人不存在', { code: 'VOICE_SPEAKER_NOT_FOUND', statusCode: 404 });
  const selectedIds = exportInput.segmentIds ? new Set(exportInput.segmentIds) : null;
  const clean = speaker.segments.filter((segment) => (
    segment.keep && !segment.containsOverlap && (!selectedIds || selectedIds.has(segment.id))
  ));
  const speakerOverlaps = exportInput.includeOverlap
    ? speaker.segments.filter((segment) => (
      segment.keep && segment.containsOverlap && (!selectedIds || selectedIds.has(segment.id))
    ))
    : [];
  const sharedOverlaps = exportInput.includeOverlap
    ? manifest.overlaps.filter((segment) => (
      segment.keep
      && segment.speakerIds?.includes(speaker.id)
      && (!selectedIds || selectedIds.has(segment.id))
    ))
    : [];
  const overlaps = [...speakerOverlaps, ...sharedOverlaps];
  const selected = [...clean, ...overlaps].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  if (!selected.length) throw apiError('没有选中可导出的片段', { code: 'VOICE_EXPORT_EMPTY', statusCode: 409 });
  if (selectedIds) {
    const matched = new Set(selected.map((segment) => segment.id));
    const invalid = [...selectedIds].filter((segmentId) => !matched.has(segmentId));
    if (invalid.length) {
      throw apiError('部分指定片段未保留、属于其他说话人，或重叠片段未明确启用', {
        code: 'VOICE_EXPORT_SEGMENT_NOT_ALLOWED', statusCode: 409
      });
    }
  }
  const totalDurationMs = selected.reduce((sum, segment) => sum + segment.durationMs, 0);
  if (totalDurationMs < MIN_VOICE_CLIP_MS || totalDurationMs > MAX_VOICE_EXPORT_MS) {
    throw apiError(`选中片段总时长须为 ${MIN_VOICE_CLIP_MS / 1000}–${MAX_VOICE_EXPORT_MS / 1000} 秒`, {
      code: 'VOICE_EXPORT_DURATION_INVALID', statusCode: 409
    });
  }
  const jobDir = path.resolve(VOICE_CLIPS_DIR, id('voiceexport'));
  const outputPath = path.join(jobDir, 'reference.wav');
  if (!isPathInside(VOICE_CLIPS_DIR, jobDir)) throw apiError('导出路径无效');
  try {
    await ensureDir(jobDir);
    update(20, `正在合并 ${selected.length} 个片段`);
    const parts = selected.map((segment) => ({
      filePath: path.resolve(analysisDirectory(analysisId), ...segment.audioFile.split('/')),
      pauseAfterMs: 120
    }));
    for (const part of parts) {
      if (!isPathInside(analysisDirectory(analysisId), part.filePath)) {
        throw apiError('片段路径越界', { code: 'VOICE_ANALYSIS_PATH_INVALID', statusCode: 500 });
      }
    }
    const merged = await concatenateWavs(parts, outputPath);
    const audio = await checkedWav(outputPath, { root: jobDir });
    if (audio.bytes > MAX_VOICE_BYTES) {
      throw apiError('合并后的参考音频超过大小限制', { code: 'VOICE_EXPORT_TOO_LARGE', statusCode: 413 });
    }
    update(80, '正在保存说话人音色');
    const transcript = selected.map((segment) => segment.text).filter(Boolean).join('\n').slice(0, 5000);
    if (!transcript) throw apiError('选中片段缺少台词，请先补全台词', { code: 'VOICE_EXPORT_TRANSCRIPT_EMPTY', statusCode: 409 });
    const voice = await createVoice({
      name: exportInput.name || speaker.label,
      tags: ['说话人分析', ...exportInput.tags].slice(0, 10),
      language: exportInput.language || manifest.language,
      transcript,
      consent: true,
      kind: 'speaker-analysis',
      audio: {
        buffer: audio.buffer,
        ext: '.wav',
        durationMs: merged.durationMs,
        sampleRate: audio.sampleRate,
        channels: audio.channels
      }
    });
    update(100, '说话人音色已保存到音色库');
    return {
      analysisId,
      speakerId: speaker.id,
      segmentIds: selected.map((segment) => segment.id),
      includedOverlap: overlaps.length > 0,
      voiceId: voice.id,
      mediaUrl: voice.reference.mediaUrl,
      name: voice.name,
      voice
    };
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function resetVoiceWorkshopTransientWorkspace() {
  await Promise.all([
    fs.rm(VOICE_CLIPS_DIR, { recursive: true, force: true }),
    fs.rm(VOICE_ANALYSIS_JOBS_DIR, { recursive: true, force: true })
  ]);
  await Promise.all([ensureDir(VOICE_CLIPS_DIR), ensureDir(VOICE_ANALYSIS_JOBS_DIR)]);
}
