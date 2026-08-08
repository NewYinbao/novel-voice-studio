import path from 'node:path';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_ENTRY_COUNT = 4096;

function normalizeZipName(value) {
  let decoded;
  try { decoded = decodeURIComponent(String(value).replaceAll('\\', '/')); }
  catch { throw Object.assign(new Error('EPUB 文件名编码无效'), { statusCode: 400 }); }
  const normalized = path.posix.normalize(decoded).replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw Object.assign(new Error('EPUB 包含不安全的文件路径'), { statusCode: 400 });
  }
  return normalized;
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw Object.assign(new Error('不是有效的 EPUB/ZIP 文件'), { statusCode: 400 });
}

function readZipEntries(buffer) {
  const eocdOffset = findEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  if (entryCount > MAX_ENTRY_COUNT) {
    throw Object.assign(new Error('EPUB 文件条目过多'), { statusCode: 413 });
  }
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  const outputCache = new Map();
  let offset = centralOffset;
  let expandedTotal = 0;
  let actualExpandedTotal = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) {
      throw Object.assign(new Error('EPUB 中央目录损坏'), { statusCode: 400 });
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    if (nameBytes.length !== nameLength) throw Object.assign(new Error('EPUB 中央目录越界'), { statusCode: 400 });
    const encoding = flags & 0x800 ? 'utf8' : 'utf8';
    const name = normalizeZipName(nameBytes.toString(encoding));

    expandedTotal += expandedSize;
    if (expandedSize > MAX_ENTRY_BYTES || expandedTotal > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('EPUB 解压后内容过大'), { statusCode: 413 });
    }

    entries.set(name, { name, method, compressedSize, expandedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  function readEntry(name) {
    const normalized = normalizeZipName(name);
    const entry = entries.get(normalized);
    if (!entry) return null;
    if (outputCache.has(normalized)) return outputCache.get(normalized);
    const at = entry.localOffset;
    if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL) {
      throw Object.assign(new Error(`EPUB 条目损坏：${normalized}`), { statusCode: 400 });
    }
    const localNameLength = buffer.readUInt16LE(at + 26);
    const localExtraLength = buffer.readUInt16LE(at + 28);
    const dataStart = at + 30 + localNameLength + localExtraLength;
    if (dataStart + entry.compressedSize > buffer.length) {
      throw Object.assign(new Error(`EPUB 条目越界：${normalized}`), { statusCode: 400 });
    }
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let output;
    if (entry.method === 0) output = compressed;
    else if (entry.method === 8) output = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw Object.assign(new Error(`EPUB 使用了暂不支持的压缩方式：${entry.method}`), { statusCode: 400 });
    if (output.length !== entry.expandedSize) {
      throw Object.assign(new Error(`EPUB 条目大小声明不一致：${normalized}`), { statusCode: 400 });
    }
    actualExpandedTotal += output.length;
    if (actualExpandedTotal > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('EPUB 实际解压内容过大'), { statusCode: 413 });
    }
    outputCache.set(normalized, output);
    return output;
  }

  return { entries, readEntry };
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = match[2] ?? match[3] ?? '';
  }
  return result;
}

export function extractEpub(buffer) {
  const zip = readZipEntries(buffer);
  const containerBuffer = zip.readEntry('META-INF/container.xml');
  if (!containerBuffer) throw Object.assign(new Error('EPUB 缺少 META-INF/container.xml'), { statusCode: 400 });
  const containerXml = containerBuffer.toString('utf8');
  const rootfileTag = containerXml.match(/<rootfile\b[^>]*>/i)?.[0];
  const opfPath = rootfileTag ? parseAttributes(rootfileTag)['full-path'] : null;
  if (!opfPath) throw Object.assign(new Error('EPUB 未声明内容清单'), { statusCode: 400 });

  const normalizedOpf = normalizeZipName(opfPath);
  const opf = zip.readEntry(normalizedOpf)?.toString('utf8');
  if (!opf) throw Object.assign(new Error('EPUB 内容清单不存在'), { statusCode: 400 });
  const baseDir = path.posix.dirname(normalizedOpf);
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs);
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
    .map((match) => parseAttributes(match[0]).idref)
    .filter(Boolean);
  const ordered = spineIds
    .map((itemId) => manifest.get(itemId))
    .filter((item) => item && /xhtml|html/i.test(item['media-type'] || item.href));

  const fallback = [...manifest.values()].filter((item) => /xhtml|html/i.test(item['media-type'] || item.href));
  const documents = ordered.length ? ordered : fallback;
  const sections = [];
  for (const item of documents) {
    const itemPath = normalizeZipName(path.posix.join(baseDir, item.href.split('#')[0]));
    const htmlBuffer = zip.readEntry(itemPath);
    if (!htmlBuffer) continue;
    const text = htmlToText(htmlBuffer.toString('utf8'));
    if (text) sections.push(text);
  }
  if (!sections.length) throw Object.assign(new Error('EPUB 中没有可读取的正文'), { statusCode: 400 });
  return sections.join('\n\n');
}
