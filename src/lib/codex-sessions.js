import { id, nowIso } from './utils.js';
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes,
  normalizeOllamaModel
} from './codex-options.js';
import { assertScriptStructureLimits, SCRIPT_STRUCTURE_LIMITS } from './script-limits.js';

const SESSION_ID_PATTERN = /^codexchat_[0-9a-f]{16}$/;
const PROGRESS_ID_PATTERN = /^codexprog_[0-9a-f]{32}$/;
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

const SAFE_SESSION_FAILURES = Object.freeze({
  CODEX_AUTH_REQUIRED: 'Codex 尚未登录，请登录后重试。',
  CODEX_CANCELLED: '本轮请求已取消，可以重新发送。',
  CODEX_CHAPTER_CHANGED: '本轮基线已变化，请基于最新版本重试。',
  CODEX_FAILED: 'Codex 未能完成本轮处理，可以重试。',
  CODEX_THREAD_MISSING: 'Codex 未返回可续接会话，可以重试。',
  CODEX_TIMEOUT: 'Codex 本轮处理超时，可以调整超时后重试。',
  CODEX_TIMEOUT_ACTIVE: 'Codex 生成超时，可以调整超时后重试。',
  CODEX_TIMEOUT_STARTING: 'Codex 启动响应超时，可以重试。',
  CODEX_UNAVAILABLE: 'Codex 当前不可用，可以稍后重试。',
  OLLAMA_FAILED: 'Ollama 未能完成本轮处理，可以重试。',
  OLLAMA_TIMEOUT: 'Ollama 本轮处理超时，可以重试。',
  OLLAMA_UNAVAILABLE: '本机 Ollama 当前不可用，可以重试。',
  SCRIPT_SCHEMA_INVALID: '返回的剧本结构无效，原版本已保留。',
  SCRIPT_SESSION_INTERRUPTED: '应用在本轮处理期间重启，可以重新发送本轮要求。',
  SCRIPT_SESSION_VERSION_LIMIT: '版本存储已达到安全上限，请整理后重试。'
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

function normalizedProgressId(value) {
  const progressId = String(value || '');
  if (!PROGRESS_ID_PATTERN.test(progressId)) {
    throw sessionError('剧本协作进度标识无效。', 'CODEX_PROGRESS_NOT_FOUND', 404);
  }
  return progressId;
}

function normalizedChapterHash(value) {
  if (value === undefined || value === null || value === '') return null;
  const hash = String(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw sessionError('剧本协作基线指纹无效。', 'SCRIPT_SESSION_RUN_INVALID', 400);
  }
  return hash;
}

function safeFailure(code) {
  const normalizedCode = String(code || '').toUpperCase();
  const safeCode = Object.hasOwn(SAFE_SESSION_FAILURES, normalizedCode)
    ? normalizedCode
    : 'CODEX_FAILED';
  return { code: safeCode, message: SAFE_SESSION_FAILURES[safeCode], at: nowIso() };
}

function assertMatchingRun(session, progressId) {
  const normalized = normalizedProgressId(progressId);
  if (session?.activeRun?.progressId !== normalized) {
    throw sessionError('本轮剧本协作已被更新的请求替代。', 'SCRIPT_SESSION_RUN_STALE', 409);
  }
  return normalized;
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

export function createCodexSessionId() {
  return assertCodexSessionId(id('codexchat'));
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
    id: createCodexSessionId(),
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

export function createPendingCodexSession({
  provider = 'codex', source, title, model, reasoningEffort, timeoutMinutes,
  mode = 'faithful', prompt = '', script, progressId, sessionId, baselineChapterHash
}) {
  const normalizedProvider = normalizeScriptSessionProvider(provider, {
    allowed: COLLABORATION_PROVIDERS
  });
  const normalizedSource = normalizeScriptSessionProvider(source, { fallback: normalizedProvider });
  const timestamp = nowIso();
  const safeProgressId = normalizedProgressId(progressId);
  return {
    id: sessionId === undefined ? createCodexSessionId() : assertCodexSessionId(sessionId),
    provider: normalizedProvider,
    source: normalizedSource,
    title: cleanText(title || PROVIDER_TITLES[normalizedProvider], 120),
    codexThreadId: '',
    model: sessionModel(normalizedProvider, model),
    reasoningEffort: sessionReasoningEffort(normalizedProvider, reasoningEffort),
    timeoutMinutes: sessionTimeoutMinutes(normalizedProvider, timeoutMinutes),
    mode: ['faithful', 'polished', 'drama'].includes(mode) ? mode : 'faithful',
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 0,
    scriptSnapshot: cloneScriptSnapshot(script),
    activeRun: {
      progressId: safeProgressId,
      state: 'pending',
      startedAt: timestamp,
      baselineChapterHash: normalizedChapterHash(baselineChapterHash)
    },
    lastFailure: null,
    messages: [message('user', prompt || '生成剧本版本', {
      runState: 'pending', runId: safeProgressId
    })]
  };
}

export function beginCodexSessionRun(session, {
  prompt, provider, model, reasoningEffort, timeoutMinutes, progressId, baselineChapterHash
}) {
  if (session?.activeRun?.progressId || ['pending', 'running'].includes(session?.status)) {
    throw sessionError('这个 Session 已有请求正在处理。', 'SCRIPT_SESSION_ACTIVE', 409);
  }
  const normalizedProvider = normalizeScriptSessionProvider(provider, {
    fallback: scriptSessionProvider(session), allowed: COLLABORATION_PROVIDERS
  });
  const timestamp = nowIso();
  const safeProgressId = normalizedProgressId(progressId);
  session.provider = normalizedProvider;
  session.source = normalizedProvider;
  session.model = sessionModel(normalizedProvider, model);
  session.reasoningEffort = sessionReasoningEffort(normalizedProvider, reasoningEffort);
  session.timeoutMinutes = sessionTimeoutMinutes(normalizedProvider, timeoutMinutes);
  session.status = 'pending';
  session.updatedAt = timestamp;
  session.activeRun = {
    progressId: safeProgressId,
    state: 'pending',
    startedAt: timestamp,
    baselineChapterHash: normalizedChapterHash(baselineChapterHash)
  };
  session.lastFailure = null;
  session.messages = [
    ...(Array.isArray(session.messages) ? session.messages : []),
    message('user', prompt, { runState: 'pending', runId: safeProgressId })
  ].slice(-MAX_MESSAGES_PER_SESSION);
  return session;
}

export function markCodexSessionRunning(session, progressId) {
  assertMatchingRun(session, progressId);
  session.status = 'running';
  session.updatedAt = nowIso();
  session.activeRun = { ...session.activeRun, state: 'running' };
  const pendingMessage = [...(session.messages || [])].reverse()
    .find((item) => item.role === 'user'
      && item.meta?.runId === progressId
      && item.meta?.runState === 'pending');
  if (pendingMessage) pendingMessage.meta = { ...pendingMessage.meta, runState: 'running' };
  return session;
}

export function completeCodexSessionRun(session, {
  progressId, threadId, provider, model, reasoningEffort, timeoutMinutes, script, usage = null
}) {
  assertMatchingRun(session, progressId);
  const normalizedProvider = normalizeScriptSessionProvider(provider, {
    fallback: scriptSessionProvider(session), allowed: COLLABORATION_PROVIDERS
  });
  const stats = scriptStats(script);
  session.provider = normalizedProvider;
  session.source = normalizedProvider;
  session.codexThreadId = normalizedProvider === 'codex'
    ? cleanText(threadId || session.codexThreadId, 120)
    : '';
  session.model = sessionModel(normalizedProvider, model);
  session.reasoningEffort = sessionReasoningEffort(normalizedProvider, reasoningEffort);
  session.timeoutMinutes = sessionTimeoutMinutes(normalizedProvider, timeoutMinutes);
  session.status = 'ready';
  session.updatedAt = nowIso();
  session.turnCount = Math.max(0, Number(session.turnCount) || 0) + 1;
  session.scriptSnapshot = cloneScriptSnapshot(script);
  session.activeRun = null;
  session.lastFailure = null;
  const pendingMessage = [...(session.messages || [])].reverse()
    .find((item) => item.role === 'user'
      && item.meta?.runId === progressId
      && ['pending', 'running'].includes(item.meta?.runState));
  if (pendingMessage) pendingMessage.meta = { ...pendingMessage.meta, runState: 'completed' };
  session.messages = [
    ...(Array.isArray(session.messages) ? session.messages : []),
    message('assistant', assistantSummary(script), { ...stats, usage: safeUsage(usage) })
  ].slice(-MAX_MESSAGES_PER_SESSION);
  return session;
}

export function failCodexSessionRun(session, { progressId, code }) {
  assertMatchingRun(session, progressId);
  const failure = safeFailure(code);
  session.status = 'failed';
  session.updatedAt = failure.at;
  session.activeRun = null;
  session.lastFailure = failure;
  const pendingMessage = [...(session.messages || [])].reverse()
    .find((item) => item.role === 'user'
      && item.meta?.runId === progressId
      && ['pending', 'running'].includes(item.meta?.runState));
  if (pendingMessage) pendingMessage.meta = { ...pendingMessage.meta, runState: 'failed', failureCode: failure.code };
  return session;
}

export function interruptCodexSessionRun(session) {
  if (!session?.activeRun && !['pending', 'running'].includes(session?.status)) return false;
  const failure = safeFailure('SCRIPT_SESSION_INTERRUPTED');
  const progressId = PROGRESS_ID_PATTERN.test(String(session?.activeRun?.progressId || ''))
    ? session.activeRun.progressId
    : null;
  session.status = 'failed';
  session.updatedAt = failure.at;
  session.activeRun = null;
  session.lastFailure = failure;
  const pendingMessage = [...(session.messages || [])].reverse()
    .find((item) => item.role === 'user'
      && ['pending', 'running'].includes(item.meta?.runState)
      && (!progressId || !item.meta?.runId || item.meta.runId === progressId));
  if (pendingMessage) {
    pendingMessage.meta = {
      ...pendingMessage.meta,
      runState: 'failed',
      failureCode: failure.code
    };
  }
  return true;
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

export function saveCodexSession(chapter, session, { activate = true } = {}) {
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
  if (existing < 0 && sessions.length >= MAX_SESSIONS_PER_CHAPTER) {
    throw sessionError(
      `本章已保留 ${MAX_SESSIONS_PER_CHAPTER} 个 Session，请先删除不需要的版本后再生成。`,
      'SCRIPT_SESSION_VERSION_LIMIT',
      409
    );
  }
  const nextSessions = [session, ...sessions];
  assertSessionSnapshotBudgets(nextSessions);
  chapter.codexSessions = nextSessions
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (activate) chapter.activeCodexSessionId = session.id;
  return session;
}

export function publicCodexSession(session) {
  if (!session) return null;
  const {
    codexThreadId: _privateThreadId,
    scriptSnapshot: _privateScriptSnapshot,
    activeRun: _privateActiveRun,
    lastFailure: _privateLastFailure,
    ...publicValue
  } = session;
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
    status: ['pending', 'running', 'ready', 'failed'].includes(publicValue.status)
      ? publicValue.status
      : 'ready',
    activeRun: _privateActiveRun && PROGRESS_ID_PATTERN.test(String(_privateActiveRun.progressId || ''))
      ? {
          progressId: _privateActiveRun.progressId,
          state: _privateActiveRun.state === 'running' ? 'running' : 'pending',
          startedAt: String(_privateActiveRun.startedAt || publicValue.updatedAt || '')
        }
      : null,
    lastFailure: _privateLastFailure && Object.hasOwn(SAFE_SESSION_FAILURES, _privateLastFailure.code)
      ? {
          code: _privateLastFailure.code,
          message: SAFE_SESSION_FAILURES[_privateLastFailure.code],
          at: String(_privateLastFailure.at || publicValue.updatedAt || '')
        }
      : null,
    messages: Array.isArray(publicValue.messages) ? publicValue.messages.map((item) => {
      if (!item?.meta || typeof item.meta !== 'object') return { ...item };
       const { usage: _privateUsage, runId: _privateRunId, ...safeMeta } = item.meta;
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
