import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_CLIP_MS,
  MAX_VOICE_SOURCE_BYTES,
  MIN_VOICE_CLIP_MS,
  VOICE_ANALYSIS_JOBS_DIR,
  VOICE_CLIPS_DIR,
  VOICE_SOURCES_DIR
} from './config.js';
import { parsePcmWav } from './audio.js';
import { createVoice } from './store.js';
import { ensureDir, id, isPathInside, nowIso, readJson, safeName, writeJsonAtomic } from './utils.js';

const SOURCE_ID_PATTERN = /^voicesrc_[a-f0-9]{16}$/;
const SOURCE_METADATA = 'source.json';
const CLAIMED_METADATA = 'claimed.json';
const DELETING_METADATA = 'deleting.json';
const SOURCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_POSITION_MS = 7 * 24 * 60 * 60 * 1000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mpg', '.mpeg']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const sourceOperationLocks = new Map();

function apiError(message, { code = 'VOICE_SOURCE_INVALID', statusCode = 400 } = {}) {
  return Object.assign(new Error(message), { code, statusCode });
}

function sourceDirectory(sourceId) {
  const normalized = String(sourceId || '');
  if (!SOURCE_ID_PATTERN.test(normalized)) throw apiError('音色来源标识无效');
  const root = path.resolve(VOICE_SOURCES_DIR);
  const target = path.resolve(root, normalized);
  if (path.dirname(target) !== root) throw apiError('音色来源路径无效');
  return target;
}

async function withSourceOperationLock(sourceId, operation) {
  const previous = sourceOperationLocks.get(sourceId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  sourceOperationLocks.set(sourceId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sourceOperationLocks.get(sourceId) === queued) sourceOperationLocks.delete(sourceId);
  }
}

function publicSource(metadata) {
  return {
    id: metadata.id,
    fileName: metadata.fileName,
    kind: metadata.kind,
    contentType: metadata.contentType,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt
  };
}

function classifySource(fileName, contentType = '') {
  const cleanName = safeName(fileName, '');
  const extension = path.extname(cleanName).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension) || (extension === '.webm' && String(contentType).toLowerCase().startsWith('audio/'));
  if (!cleanName || (!isVideo && !isAudio)) {
    throw apiError('仅支持常见视频或音频文件', { code: 'VOICE_SOURCE_TYPE_UNSUPPORTED' });
  }
  return { fileName: cleanName, extension, kind: isAudio ? 'audio' : 'video' };
}

function checkedContentLength(value, maxBytes) {
  if (value === undefined || value === null || value === '') return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) throw apiError('Content-Length 无效');
  if (length > maxBytes) {
    throw apiError(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`, {
      code: 'VOICE_SOURCE_TOO_LARGE', statusCode: 413
    });
  }
  return length;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new Error('写入音色来源失败');
    offset += bytesWritten;
  }
}

async function metadataForDirectory(dir) {
  const pending = await readJson(path.join(dir, SOURCE_METADATA));
  if (pending) return { metadata: pending, claimed: false };
  const claimed = await readJson(path.join(dir, CLAIMED_METADATA));
  if (claimed) return { metadata: claimed, claimed: true };
  const deleting = await readJson(path.join(dir, DELETING_METADATA));
  return deleting ? { metadata: deleting, claimed: false, deleting: true } : null;
}

async function cleanupDirectoryRoot(root, now = Date.now()) {
  await ensureDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const dir = path.join(root, entry.name);
    let expiresAt = 0;
    try {
      const record = await metadataForDirectory(dir);
      expiresAt = Date.parse(record?.metadata?.expiresAt || '');
      if (!Number.isFinite(expiresAt)) {
        const stat = await fs.stat(dir);
        expiresAt = stat.mtimeMs + SOURCE_TTL_MS;
      }
    } catch {
      expiresAt = 0;
    }
    if (expiresAt <= now) await fs.rm(dir, { recursive: true, force: true });
  }));
}

export async function cleanupExpiredVoiceSources(now = Date.now()) {
  await Promise.all([
    cleanupDirectoryRoot(VOICE_SOURCES_DIR, now),
    cleanupDirectoryRoot(VOICE_CLIPS_DIR, now)
  ]);
}

export async function resetVoiceSourceWorkspace() {
  await Promise.all([
    fs.rm(VOICE_SOURCES_DIR, { recursive: true, force: true }),
    fs.rm(VOICE_CLIPS_DIR, { recursive: true, force: true }),
    fs.rm(VOICE_ANALYSIS_JOBS_DIR, { recursive: true, force: true })
  ]);
  await Promise.all([
    ensureDir(VOICE_SOURCES_DIR), ensureDir(VOICE_CLIPS_DIR),
    ensureDir(VOICE_ANALYSIS_JOBS_DIR)
  ]);
}

export async function saveVoiceSource(stream, {
  fileName,
  contentType = 'application/octet-stream',
  contentLength = null,
  maxBytes = MAX_VOICE_SOURCE_BYTES
} = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw apiError('缺少文件内容');
  const safeMaxBytes = Number(maxBytes);
  if (!Number.isSafeInteger(safeMaxBytes) || safeMaxBytes <= 0) throw new TypeError('maxBytes 必须是正整数');
  const sourceType = classifySource(fileName, contentType);
  const declaredLength = checkedContentLength(contentLength, safeMaxBytes);
  await cleanupExpiredVoiceSources();

  const sourceId = id('voicesrc');
  const dir = sourceDirectory(sourceId);
  const storedFileName = `source${sourceType.extension}`;
  const finalPath = path.join(dir, storedFileName);
  const partialPath = `${finalPath}.partial`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let handle;
  try {
    await ensureDir(dir);
    handle = await fs.open(partialPath, 'wx');
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + buffer.length > safeMaxBytes) {
        throw apiError(`文件超过 ${Math.round(safeMaxBytes / 1024 / 1024)} MB 限制`, {
          code: 'VOICE_SOURCE_TOO_LARGE', statusCode: 413
        });
      }
      bytes += buffer.length;
      hash.update(buffer);
      await writeAll(handle, buffer);
    }
    if (!bytes) throw apiError('文件为空或上传中断');
    if (declaredLength !== null && bytes !== declaredLength) throw apiError('文件上传不完整');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(partialPath, finalPath);
    const createdAt = nowIso();
    const metadata = {
      id: sourceId,
      fileName: sourceType.fileName,
      storedFileName,
      kind: sourceType.kind,
      contentType: String(contentType || 'application/octet-stream').slice(0, 120),
      bytes,
      sha256: hash.digest('hex'),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + SOURCE_TTL_MS).toISOString()
    };
    await writeJsonAtomic(path.join(dir, SOURCE_METADATA), metadata);
    return publicSource(metadata);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function checkedSourceFile(metadata) {
  const dir = sourceDirectory(metadata.id);
  const target = path.resolve(dir, String(metadata.storedFileName || ''));
  if (!metadata.storedFileName || !isPathInside(dir, target)) throw apiError('音色来源路径无效');
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') throw apiError('音色来源文件不存在', { code: 'VOICE_SOURCE_NOT_FOUND', statusCode: 404 });
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw apiError('音色来源文件无效');
  const [realDir, realTarget] = await Promise.all([fs.realpath(dir), fs.realpath(target)]);
  if (!isPathInside(realDir, realTarget)) throw apiError('音色来源路径越界', { code: 'VOICE_SOURCE_PATH_ESCAPE', statusCode: 403 });
  if (stat.size !== metadata.bytes) throw apiError('音色来源文件已被修改', { code: 'VOICE_SOURCE_CHANGED', statusCode: 409 });
  return realTarget;
}

export async function claimVoiceSource(sourceId) {
  sourceDirectory(sourceId);
  return withSourceOperationLock(sourceId, async () => {
    const dir = sourceDirectory(sourceId);
    const pendingPath = path.join(dir, SOURCE_METADATA);
    const claimedPath = path.join(dir, CLAIMED_METADATA);
    try {
      await fs.rename(pendingPath, claimedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const alreadyClaimed = await fs.stat(claimedPath).then(() => true, () => false);
      if (alreadyClaimed) throw apiError('音色来源已在处理中', { code: 'VOICE_SOURCE_CLAIMED', statusCode: 409 });
      throw apiError('音色来源不存在或已过期', { code: 'VOICE_SOURCE_NOT_FOUND', statusCode: 404 });
    }
    try {
      const metadata = await readJson(claimedPath);
      if (!metadata || metadata.id !== sourceId) throw apiError('音色来源元数据无效');
      if (Date.parse(metadata.expiresAt || '') <= Date.now()) {
        throw apiError('音色来源已过期，请重新选择文件', { code: 'VOICE_SOURCE_EXPIRED', statusCode: 410 });
      }
      const filePath = await checkedSourceFile(metadata);
      return { ...metadata, filePath };
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

export async function deleteVoiceSource(sourceId, { allowClaimed = false, missingOk = false } = {}) {
  sourceDirectory(sourceId);
  return withSourceOperationLock(sourceId, async () => {
    const dir = sourceDirectory(sourceId);
    if (allowClaimed) {
      await fs.rm(dir, { recursive: true, force: missingOk });
      return;
    }
    const pendingPath = path.join(dir, SOURCE_METADATA);
    const deletingPath = path.join(dir, DELETING_METADATA);
    try {
      await fs.rename(pendingPath, deletingPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const claimed = await fs.stat(path.join(dir, CLAIMED_METADATA)).then(() => true, () => false);
      if (claimed) throw apiError('音色来源正在处理中', { code: 'VOICE_SOURCE_CLAIMED', statusCode: 409 });
      if (missingOk) return;
      throw apiError('音色来源不存在', { code: 'VOICE_SOURCE_NOT_FOUND', statusCode: 404 });
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
}

export function validateVoiceExtraction(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('裁剪参数无效');
  const name = String(value.name || '').trim();
  const transcript = String(value.transcript || '').trim();
  const startMs = Math.round(Number(value.startMs));
  const endMs = Math.round(Number(value.endMs));
  if (!name) throw apiError('请填写音色名称');
  if (!transcript) throw apiError('请填写所选片段的准确台词');
  if (value.consent !== true) throw apiError('请确认你有权使用视频或音频中的声音样本');
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || startMs > MAX_SOURCE_POSITION_MS || endMs <= startMs) {
    throw apiError('裁剪起止时间无效');
  }
  const durationMs = endMs - startMs;
  if (durationMs < MIN_VOICE_CLIP_MS || durationMs > MAX_VOICE_CLIP_MS) {
    throw apiError(`音色片段时长须为 ${MIN_VOICE_CLIP_MS / 1000}–${MAX_VOICE_CLIP_MS / 1000} 秒`);
  }
  const rawTags = Array.isArray(value.tags) ? value.tags : String(value.tags || '').split(/[,，]/);
  return {
    name: safeName(name, '新音色'),
    tags: rawTags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean).slice(0, 10),
    language: String(value.language || 'zh-CN').trim().slice(0, 30) || 'zh-CN',
    transcript: transcript.slice(0, 5000),
    consent: true,
    startMs,
    endMs,
    durationMs
  };
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

function workerError(payload, status) {
  const detail = payload?.detail;
  const message = typeof detail === 'string' ? detail : detail?.message || payload?.message || `模型工作器返回 HTTP ${status}`;
  const code = payload?.code || detail?.code || (status === 404 ? 'VOICE_EXTRACT_UNSUPPORTED' : 'VOICE_EXTRACT_FAILED');
  return Object.assign(new Error(message), { code });
}

async function requestWorkerExtraction(settings, request) {
  const response = await fetch(`${String(settings.workerUrl || '').replace(/\/$/, '')}/v1/audio/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5 * 60_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw workerError(payload, response.status);
  return payload;
}

async function cleanupJobFiles(sourceId, outputDir) {
  const results = await Promise.allSettled([
    fs.rm(outputDir, { recursive: true, force: true }),
    deleteVoiceSource(sourceId, { allowClaimed: true, missingOk: true })
  ]);
  for (const result of results) if (result.status === 'rejected') console.warn('清理音色裁剪临时文件失败', result.reason);
}

export async function extractVoiceFromSource(source, voiceInput, { settings, profile }, update = () => {}) {
  const outputId = id('voiceclip');
  const outputDir = path.resolve(VOICE_CLIPS_DIR, outputId);
  const outputPath = path.join(outputDir, 'reference.wav');
  if (!isPathInside(VOICE_CLIPS_DIR, outputDir)) throw apiError('音色裁剪输出路径无效');
  try {
    if (!profile?.worker?.online) throw apiError('模型工作器未启动', { code: 'WORKER_OFFLINE', statusCode: 503 });
    if (!profile.worker.ffmpeg) throw apiError('模型工作器中没有 FFmpeg', { code: 'FFMPEG_UNAVAILABLE', statusCode: 503 });
    if (!profile.worker.ffprobe) throw apiError('模型工作器中没有 FFprobe', { code: 'FFPROBE_UNAVAILABLE', statusCode: 503 });
    await ensureDir(outputDir);
    update(10, '正在从来源文件裁剪人声片段');
    const response = await requestWorkerExtraction(settings, {
      request_id: id('extract'),
      source_path: pathForWorker(source.filePath, profile),
      output_path: pathForWorker(outputPath, profile),
      start_seconds: voiceInput.startMs / 1000,
      end_seconds: voiceInput.endMs / 1000
    });
    update(75, '正在校验并保存音色样本');
    const stat = await fs.lstat(outputPath).catch((error) => {
      if (error.code === 'ENOENT') throw apiError('工作器没有生成裁剪音频', { code: 'VOICE_EXTRACT_OUTPUT_MISSING', statusCode: 502 });
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 44 || stat.size > MAX_VOICE_BYTES) {
      throw apiError('工作器生成的裁剪音频无效', { code: 'VOICE_EXTRACT_OUTPUT_INVALID', statusCode: 502 });
    }
    const buffer = await fs.readFile(outputPath);
    const parsed = parsePcmWav(buffer);
    if (parsed.sampleRate !== 24000 || parsed.channels !== 1) {
      throw apiError('裁剪音频必须是 24kHz 单声道 PCM WAV', { code: 'VOICE_EXTRACT_FORMAT_INVALID', statusCode: 502 });
    }
    const durationMs = Math.round(parsed.data.length / (parsed.sampleRate * parsed.channels * 2) * 1000);
    if (durationMs < MIN_VOICE_CLIP_MS || durationMs > MAX_VOICE_CLIP_MS || Math.abs(durationMs - voiceInput.durationMs) > 1500) {
      throw apiError('裁剪音频时长与请求范围不一致', { code: 'VOICE_EXTRACT_DURATION_INVALID', statusCode: 502 });
    }
    const voice = await createVoice({
      name: voiceInput.name,
      tags: voiceInput.tags,
      language: voiceInput.language,
      transcript: voiceInput.transcript,
      consent: true,
      kind: source.kind === 'audio' ? 'audio-extract' : 'video-extract',
      audio: { buffer, ext: '.wav', durationMs, sampleRate: parsed.sampleRate, channels: parsed.channels },
      provenance: {
        type: source.kind,
        originalFileName: source.fileName,
        sha256: source.sha256,
        bytes: source.bytes,
        startMs: voiceInput.startMs,
        endMs: voiceInput.endMs
      }
    });
    update(100, '音色已保存到音色库');
    return {
      voice,
      voiceId: voice.id,
      sourceId: source.id,
      durationMs,
      worker: {
        durationMs: Number(response.duration_seconds) > 0 ? Math.round(Number(response.duration_seconds) * 1000) : durationMs,
        sampleRate: Number(response.sample_rate) || parsed.sampleRate
      }
    };
  } finally {
    await cleanupJobFiles(source.id, outputDir);
  }
}
