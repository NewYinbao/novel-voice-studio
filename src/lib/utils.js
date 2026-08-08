import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function id(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export function safeName(value, fallback = 'untitled') {
  const clean = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

export function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

export async function parseJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 请求体格式无效');
    error.statusCode = 400;
    throw error;
  }
}

export function decodeBase64Payload(value, maxBytes) {
  if (typeof value !== 'string') throw Object.assign(new Error('缺少文件内容'), { statusCode: 400 });
  const comma = value.indexOf(',');
  const encoded = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw Object.assign(new Error('文件为空或编码无效'), { statusCode: 400 });
  if (buffer.length > maxBytes) throw Object.assign(new Error('文件超过大小限制'), { statusCode: 413 });
  return buffer;
}

export function mediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4b': 'audio/mp4',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg'
  }[ext] || 'application/octet-stream';
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function stripCodeFence(value) {
  const trimmed = String(value || '').trim();
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
