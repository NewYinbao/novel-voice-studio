import { id, nowIso } from './utils.js';
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes,
  normalizeOllamaModel
} from './codex-options.js';
import { assertScriptStructureLimits, SCRIPT_STRUCTURE_LIMITS } from './script-limits.js';

const SESSION_ID_PATTERN = /^codexchat_[0-9a-f]{16}$/;
export const MAX_SESSIONS_PER_CHAPTER = 50;
const MAX_MESSAGES_PER_SESSION = 40;
const MAX_MESSAGE_CHARS = 4000;
export const SCRIPT_SESSION_PROVIDERS = Object.freeze(['codex', 'ollama', 'rules', 'import']);
export const COLLABORATION_PROVIDERS = Object.freeze(['codex', 'ollama']);

const PROVIDER_TITLES = Object.freeze({
  codex: 'Codex 协作版本',
  ollama: 'Ollama 协作版本',
  rules: '规则生成版本',
  import: '导入剧本版本'
});

function sessionError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function normalizeScriptSessionProvider(value, {
  fallback = 'codex',
  allowed = SCRIPT_SESSION_PROVIDERS
} = {}) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'string') {
    throw sessionError('剧本协作 provider 无效。', 'SCRIPT_SESSION_PROVIDER_INVALID');
  }
  const provider = selected.trim().toLowerCase();
  if (!allowed.includes(provider)) {
    throw sessionError('剧本协作 provider 无效。', 'SCRIPT_SESSION_PROVIDER_INVALID');
  }
  return provider;
}

export function scriptSessionProvider(session) {
  try {
    return normalizeScriptSessionProvider(session?.provider ?? session?.source);
  } catch {
    return 'codex';
  }
}

function cleanText(value, max = MAX_MESSAGE_CHARS) {
  return String(value || '').trim().slice(0, max);
}

function scriptStats(script) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const lines = scenes.flatMap((scene) => Array.isArray(scene.lines) ? scene.lines : []);
  const roles = Array.isArray(script?.roles) ? script.roles : [];
  const reviewCount = lines.filter((line) => line.needsReview).length;
  return { sceneCount: scenes.length, lineCount: lines.length, roleCount: roles.length, reviewCount };
}

function assistantSummary(script) {
  const stats = scriptStats(script);
  const review = stats.reviewCount ? `，其中 ${stats.reviewCount} 句需要确认角色` : '';
  return `已生成完整剧本：${stats.sceneCount} 个场景、${stats.lineCount} 个片段、${stats.roleCount} 个角色${review}。右侧可继续手动调整，或在下方发送下一轮要求。`;
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const result = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    const value = Number(usage[key]);
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function message(role, content, meta = undefined) {
  const item = { id: id('message'), role, content: cleanText(content), createdAt: nowIso() };
  if (meta && Object.keys(meta).length) item.meta = meta;
  return item;
}

function cloneScriptSnapshot(script) {
  if (!script || typeof script !== 'object' || !Array.isArray(script.scenes)) return null;
  return structuredClone(script);
}

function assertSessionSnapshotBudgets(sessions) {
  let totalBytes = 0;
  for (const item of sessions) {
    if (!item?.scriptSnapshot?.scenes) continue;
    const { serializedBytes } = assertScriptStructureLimits(item.scriptSnapshot, {
      code: 'SCRIPT_SESSION_VERSION_LIMIT',
      statusCode: 409
    });
    totalBytes += serializedBytes;
    if (totalBytes > SCRIPT_STRUCTURE_LIMITS.chapterSnapshotsBytes) {
      throw sessionError(
        '本章可恢复版本的累计大小已达到安全上限，请先删除不需要的旧版本。',
        'SCRIPT_SESSION_VERSION_LIMIT',
        409
      );
    }
  }
}

function sessionModel(provider, model) {
  if (provider === 'codex') return normalizeCodexModel(model);
  if (provider === 'ollama') return normalizeOllamaModel(model);
  return '';
}

function sessionReasoningEffort(provider, value) {
  return provider === 'codex' ? normalizeCodexReasoningEffort(value) : null;
}

function sessionTimeoutMinutes(provider, value) {
  return COLLABORATION_PROVIDERS.includes(provider) ? normalizeCodexTimeoutMinutes(value) : null;
}

export function assertCodexSessionId(value) {
  const candidate = String(value || '');
  if (!SESSION_ID_PATTERN.test(candidate)) {
    throw Object.assign(new Error('Codex 会话标识无效'), { statusCode: 400, code: 'CODEX_SESSION_INVALID' });
  }
  return candidate;
}

export function findCodexSession(chapter, sessionId) {
  const normalized = assertCodexSessionId(sessionId);
  const session = (chapter.codexSessions || []).find((item) => item.id === normalized);
  if (!session) throw Object.assign(new Error('Codex 会话不存在或已被清理'), { statusCode: 404, code: 'CODEX_SESSION_NOT_FOUND' });
  return session;
}

export function createCodexSession({
  threadId,
  provider = 'codex',
  source,
  title,
  model,
  reasoningEffort,
  timeoutMinutes,
  mode = 'faithful',
  prompt = '',
  script,
  usage = null
}) {
  const normalizedProvider = normalizeScriptSessionProvider(provider);
  const normalizedSource = normalizeScriptSessionProvider(source, { fallback: normalizedProvider });
  const stats = scriptStats(script);
  const timestamp = nowIso();
  return {
    id: id('codexchat'),
    provider: normalizedProvider,
    source: normalizedSource,
    title: cleanText(title || PROVIDER_TITLES[normalizedSource] || PROVIDER_TITLES[normalizedProvider], 120),
    codexThreadId: normalizedProvider === 'codex' ? cleanText(threadId, 120) : '',
    model: sessionModel(normalizedProvider, model),
    reasoningEffort: sessionReasoningEffort(normalizedProvider, reasoningEffort),
    timeoutMinutes: sessionTimeoutMinutes(normalizedProvider, timeoutMinutes),
    mode: ['faithful', 'polished', 'drama'].includes(mode) ? mode : 'faithful',
    status: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 1,
    scriptSnapshot: cloneScriptSnapshot(script),
    messages: [
      message('user', prompt || PROVIDER_TITLES[normalizedSource] || '生成剧本版本'),
      message('assistant', assistantSummary(script), { ...stats, usage: safeUsage(usage) })
    ]
  };
}

export function appendCodexTurn(session, {
  prompt, provider, model, reasoningEffort, timeoutMinutes, script, usage = null
}) {
  const normalizedProvider = normalizeScriptSessionProvider(provider, {
    fallback: scriptSessionProvider(session), allowed: COLLABORATION_PROVIDERS
  });
  const stats = scriptStats(script);
  session.provider = normalizedProvider;
  session.source = normalizedProvider;
  session.model = sessionModel(normalizedProvider, model);
  session.reasoningEffort = sessionReasoningEffort(normalizedProvider, reasoningEffort);
  session.timeoutMinutes = sessionTimeoutMinutes(normalizedProvider, timeoutMinutes);
  session.status = 'ready';
  session.updatedAt = nowIso();
  session.turnCount = Math.max(0, Number(session.turnCount) || 0) + 1;
  session.scriptSnapshot = cloneScriptSnapshot(script);
  session.messages = [
    ...(Array.isArray(session.messages) ? session.messages : []),
    message('user', prompt),
    message('assistant', assistantSummary(script), { ...stats, usage: safeUsage(usage) })
  ].slice(-MAX_MESSAGES_PER_SESSION);
  return session;
}

export function saveCodexSession(chapter, session) {
  const sessions = Array.isArray(chapter.codexSessions) ? [...chapter.codexSessions] : [];
  const existing = sessions.findIndex((item) => item.id === session.id);
  if (existing < 0 && !(Number.isSafeInteger(session.versionOrdinal) && session.versionOrdinal > 0)) {
    const maxOrdinal = sessions.reduce((maximum, item) => (
      Number.isSafeInteger(item.versionOrdinal) && item.versionOrdinal > maximum
        ? item.versionOrdinal
        : maximum
    ), 0);
    session.versionOrdinal = maxOrdinal + 1;
  }
  if (existing >= 0) sessions.splice(existing, 1);
  while (existing < 0 && sessions.length >= MAX_SESSIONS_PER_CHAPTER) {
    const disposable = sessions.findLastIndex((item) => (
      item.id !== chapter.activeCodexSessionId && !item.scriptSnapshot?.scenes?.length
    ));
    if (disposable < 0) {
      throw sessionError(
        `本章已保留 ${MAX_SESSIONS_PER_CHAPTER} 个可恢复版本，请先整理版本后再生成。`,
        'SCRIPT_SESSION_VERSION_LIMIT',
        409
      );
    }
    sessions.splice(disposable, 1);
  }
  const nextSessions = [session, ...sessions];
  assertSessionSnapshotBudgets(nextSessions);
  chapter.codexSessions = nextSessions
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  chapter.activeCodexSessionId = session.id;
  return session;
}

export function publicCodexSession(session) {
  if (!session) return null;
  const { codexThreadId: _privateThreadId, scriptSnapshot: _privateScriptSnapshot, ...publicValue } = session;
  const provider = scriptSessionProvider(session);
  let source = provider;
  try { source = normalizeScriptSessionProvider(session?.source, { fallback: provider }); } catch { /* legacy */ }
  let publicReasoningEffort = null;
  if (publicValue.reasoningEffort !== undefined && publicValue.reasoningEffort !== null && publicValue.reasoningEffort !== '') {
    try { publicReasoningEffort = normalizeCodexReasoningEffort(publicValue.reasoningEffort); } catch { /* legacy value */ }
  }
  let publicTimeoutMinutes = null;
  if (typeof publicValue.timeoutMinutes === 'number') {
    try { publicTimeoutMinutes = normalizeCodexTimeoutMinutes(publicValue.timeoutMinutes); } catch { /* legacy value */ }
  }
  return {
    ...publicValue,
    provider,
    source,
    title: cleanText(publicValue.title || PROVIDER_TITLES[source] || PROVIDER_TITLES[provider], 120),
    versionOrdinal: Number.isSafeInteger(publicValue.versionOrdinal) && publicValue.versionOrdinal > 0
      ? publicValue.versionOrdinal
      : null,
    versionAvailable: Boolean(_privateScriptSnapshot?.scenes?.length),
    model: cleanText(publicValue.model, 100),
    reasoningEffort: publicReasoningEffort,
    timeoutMinutes: publicTimeoutMinutes,
    messages: Array.isArray(publicValue.messages) ? publicValue.messages.map((item) => {
      if (!item?.meta || typeof item.meta !== 'object') return { ...item };
      const { usage: _privateUsage, ...safeMeta } = item.meta;
      const result = { ...item };
      if (Object.keys(safeMeta).length) result.meta = safeMeta;
      else delete result.meta;
      return result;
    }) : publicValue.messages
  };
}

export function publicCodexSessions(chapter) {
  return (chapter.codexSessions || []).map(publicCodexSession);
}

export { scriptStats };
