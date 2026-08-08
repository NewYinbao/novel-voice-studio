import path from 'node:path';
import { extractEpub } from './epub.js';
import { id } from './utils.js';

function scoreDecoded(value) {
  const replacements = (value.match(/�/g) || []).length;
  const controls = (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  return replacements * 8 + controls * 2;
}

export function decodeBook(buffer, fileName = 'novel.txt') {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.epub') return extractEpub(buffer);
  if (!['.txt', '.md', '.markdown'].includes(ext)) {
    throw Object.assign(new Error('目前支持 TXT、Markdown 与 EPUB'), { statusCode: 415 });
  }

  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const utf8 = new TextDecoder('utf-8').decode(hasUtf8Bom ? buffer.subarray(3) : buffer);
  let gb18030 = '';
  try { gb18030 = new TextDecoder('gb18030').decode(buffer); } catch { /* small ICU builds */ }
  return gb18030 && scoreDecoded(gb18030) < scoreDecoded(utf8) ? gb18030 : utf8;
}

export function normalizeNovelText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]+/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const CHAPTER_HEADING = /^(?:[ \t]{0,4})(?:(?:第[零〇一二两三四五六七八九十百千万0-9]{1,12}[章节卷回部篇幕集])(?:[ \t:：·、.\-]*[^\n]{0,42})?|(?:chapter|part|volume)[ \t]+[0-9ivxlcdm]+(?:[ \t]*[:：.\-—][ \t]*[^\n]{0,60})?|(?:序章|楔子|引子|前言|后记|尾声|终章|番外(?:篇)?)(?:[ \t:：·、.\-]*[^\n]{0,42})?)[ \t]*$/gim;

function chunkUntitled(text, targetChars = 5200) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    if (size && size + paragraph.length > targetChars) {
      chunks.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += paragraph.length;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks;
}

export function splitChapters(input) {
  const text = normalizeNovelText(input);
  if (!text) return [];
  const matches = [...text.matchAll(CHAPTER_HEADING)];
  const chapters = [];

  if (!matches.length) {
    return chunkUntitled(text).map((sourceText, index) => ({
      id: id('chapter'),
      index,
      title: `第 ${index + 1} 章`,
      sourceText,
      charCount: sourceText.length,
      status: 'source',
      scenes: []
    }));
  }

  const preface = text.slice(0, matches[0].index).trim();
  if (preface.length > 80) chapters.push({ title: '卷首', sourceText: preface });
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const title = match[0].trim();
    const sourceText = text.slice(match.index + match[0].length, next?.index ?? text.length).trim();
    if (sourceText) chapters.push({ title, sourceText });
  }

  return chapters.map((chapter, index) => ({
    id: id('chapter'),
    index,
    title: chapter.title,
    sourceText: chapter.sourceText,
    charCount: chapter.sourceText.length,
    status: 'source',
    scenes: []
  }));
}

export function estimateDuration(charCount, charsPerMinute = 220) {
  return Math.max(1, Math.round(Number(charCount || 0) / charsPerMinute));
}
