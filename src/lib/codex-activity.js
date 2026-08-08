export const CODEX_DETAIL_LEVELS = Object.freeze(['basic', 'summary']);
export const CODEX_HIDDEN_SUMMARY = '摘要因可能包含原文或敏感信息而隐藏。';

const MAX_INPUT_CHARS = 8_192;
const MAX_SENSITIVE_CHARS = 2 * 1024 * 1024;
const MAX_OUTPUT_GRAPHEMES = 320;
const MAX_OUTPUT_BYTES = 512;
const EMPTY_VALUES = Object.freeze([]);
const INVISIBLE_PATTERN = /(?:\p{Cc}|\p{Default_Ignorable_Code_Point}|\p{M})/gu;
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]{1,31}:(?:[^\s]|$)|\bwww\.|\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[\/?#]|\b)|\[[0-9a-f:]+\](?::\d{1,5})?(?:[\/?#]|\b)|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b)/iu;
const SECRET_PATTERN = /(?:\b(?:bearer|authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\b\s*[:=]?|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu;
// Any slash/backslash is fail-closed: a public reasoning summary never needs to expose a filesystem-like value.
const PATH_PATTERN = /[\\/]/u;
const CODE_PATTERN = /(?:```|~~~|\$\(|--|__|(?:^|\s)(?:git|gh|npm|pnpm|yarn|bun|npx|node|python3?|py|rg|ls|cd|pwd|cat|type|copy|move|del|rm|mkdir|curl|wget|cargo|rustc|go|dotnet|java|gradle|mvn|powershell|cmd(?:\.exe)?|bash|sh|get-childitem|set-item|invoke-webrequest)(?:\s|$)|\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b|\b(?:mcp|function|tool)(?:__|[_:.])[A-Za-z0-9_.:-]*|\s(?:&&|\|\||>>?)\s)/iu;
const PROMPT_PATTERN = /(?:<(?:additional-editor-request|current-chapter-script|novel-source|system|prompt)>|\b(?:begin|end)[ _-]?(?:system[ _-]?)?prompt\b|prompt[_ -]?sentinel)/iu;
const SCRIPT_SCHEMA_PATTERN = /(?:["']?(?:chapterTitle|roles|scenes|lines|sourceText|spokenText|speaker|speakerId|emotionNote|pauseAfterMs|needsReview)["']?\s*:|[\[{]\s*["'])/u;
const ACTIVE_CONTENT_PATTERN = /(?:<\/?(?:script|img|svg|iframe|style)\b|\bonerror\s*=|\bonload\s*=|javascript:)/iu;

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function normalizeCodexDetailLevel(value) {
  const selected = value === undefined || value === null || value === '' ? 'basic' : value;
  if (typeof selected !== 'string') {
    throw httpError('Codex 进度详情级别无效。', 400, 'CODEX_DETAIL_LEVEL_INVALID');
  }
  const detailLevel = selected;
  if (!CODEX_DETAIL_LEVELS.includes(detailLevel)) {
    throw httpError('Codex 进度详情级别无效。', 400, 'CODEX_DETAIL_LEVEL_INVALID');
  }
  return detailLevel;
}

function cleanText(value) {
  return String(value).normalize('NFKD')
    .replace(ANSI_PATTERN, '')
    .replace(INVISIBLE_PATTERN, '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  for (const point of value) {
    if (Buffer.byteLength(output + point, 'utf8') > maxBytes) break;
    output += point;
  }
  return output.trim();
}

function truncateSummary(value) {
  let graphemes;
  try {
    const segmenter = typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
      : null;
    graphemes = segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : Array.from(value);
  } catch {
    graphemes = Array.from(value);
  }
  return truncateUtf8(graphemes.slice(0, MAX_OUTPUT_GRAPHEMES).join(''), MAX_OUTPUT_BYTES);
}

function compactForOverlap(value) {
  return cleanText(value).toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenStream(value) {
  const tokens = cleanText(value).toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.length ? `\u0001${tokens.join('\u0001')}\u0001` : '';
}

export function createCodexRedactionContext(sensitiveTexts = []) {
  try {
    const values = Array.isArray(sensitiveTexts) ? sensitiveTexts : [sensitiveTexts];
    if (values.length > 8_192) return Object.freeze({ hideAll: true, compact: '', tokens: '', short: EMPTY_VALUES });
    let totalChars = 0;
    const compact = [];
    const tokens = [];
    const short = new Set();
    for (const value of values) {
      if (typeof value !== 'string' || !value) continue;
      totalChars += value.length;
      if (totalChars > MAX_SENSITIVE_CHARS) {
        return Object.freeze({ hideAll: true, compact: '', tokens: '', short: EMPTY_VALUES });
      }
      const compactValue = compactForOverlap(value);
      const tokenValue = tokenStream(value);
      if (compactValue) compact.push(compactValue);
      const compactPoints = Array.from(compactValue);
      if (compactPoints.length >= 4 && compactPoints.length < 12) short.add(compactValue);
      if (short.size > 1_024) {
        return Object.freeze({ hideAll: true, compact: '', tokens: '', short: EMPTY_VALUES });
      }
      if (tokenValue) tokens.push(tokenValue);
    }
    return Object.freeze({
      hideAll: false,
      compact: compact.join('\u0002'),
      tokens: tokens.join('\u0002'),
      short: Object.freeze([...short])
    });
  } catch {
    return Object.freeze({ hideAll: true, compact: '', tokens: '', short: EMPTY_VALUES });
  }
}

function overlapsSensitiveText(candidate, context) {
  if (!context) return false;
  if (context.hideAll) return true;
  const compactCandidate = compactForOverlap(candidate);
  if (context.short?.some((value) => compactCandidate.includes(value))) return true;
  const points = Array.from(compactCandidate);
  if (points.length >= 12) {
    for (let offset = 0; offset <= points.length - 12; offset += 1) {
      const gram = points.slice(offset, offset + 12).join('');
      if (context.compact.includes(gram)) return true;
    }
  }
  const candidateTokens = cleanText(candidate).toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
  if (candidateTokens.length >= 6) {
    for (let offset = 0; offset <= candidateTokens.length - 6; offset += 1) {
      const gram = `\u0001${candidateTokens.slice(offset, offset + 6).join('\u0001')}\u0001`;
      if (context.tokens.includes(gram)) return true;
    }
  }
  return false;
}

export function sanitizeCodexActivitySummary(value, { redactionContext, sensitiveTexts } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.length > MAX_INPUT_CHARS) return CODEX_HIDDEN_SUMMARY;
  try {
    const normalized = value.normalize('NFKC');
    const cleaned = truncateSummary(cleanText(normalized));
    if (!cleaned) return null;
    if (
      URL_PATTERN.test(cleaned) || SECRET_PATTERN.test(cleaned) || PATH_PATTERN.test(cleaned)
      || CODE_PATTERN.test(cleaned) || PROMPT_PATTERN.test(cleaned) || SCRIPT_SCHEMA_PATTERN.test(cleaned)
      || ACTIVE_CONTENT_PATTERN.test(cleaned)
    ) return CODEX_HIDDEN_SUMMARY;
    const context = redactionContext || createCodexRedactionContext(sensitiveTexts || []);
    if (overlapsSensitiveText(cleaned, context)) return CODEX_HIDDEN_SUMMARY;
    return cleaned;
  } catch {
    return null;
  }
}

export function codexActivitySensitiveTexts(chapter, prompt = '', project = null) {
  const result = [String(chapter?.sourceText || ''), String(prompt || ''), String(chapter?.title || '')];
  for (const warning of Array.isArray(chapter?.scriptWarnings) ? chapter.scriptWarnings : []) result.push(String(warning || ''));
  for (const warning of Array.isArray(chapter?.warnings) ? chapter.warnings : []) result.push(String(warning || ''));
  for (const role of [
    ...(Array.isArray(chapter?.roles) ? chapter.roles : []),
    ...(Array.isArray(project?.characters) ? project.characters : [])
  ]) {
    result.push(String(role?.name || ''), String(role?.description || ''));
    for (const alias of Array.isArray(role?.aliases) ? role.aliases : []) result.push(String(alias || ''));
  }
  for (const scene of Array.isArray(chapter?.scenes) ? chapter.scenes : []) {
    result.push(String(scene?.title || ''), String(scene?.context || ''));
    for (const line of Array.isArray(scene?.lines) ? scene.lines : []) {
      result.push(
        String(line?.sourceText || ''), String(line?.spokenText || ''), String(line?.emotionNote || ''),
        String(line?.speaker || '')
      );
    }
  }
  return result;
}
