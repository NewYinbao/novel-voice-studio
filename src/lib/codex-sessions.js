import { id, nowIso } from './utils.js';
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes
} from './codex-options.js';

const SESSION_ID_PATTERN = /^codexchat_[0-9a-f]{16}$/;
const MAX_SESSIONS_PER_CHAPTER = 8;
const MAX_MESSAGES_PER_SESSION = 40;
const MAX_MESSAGE_CHARS = 4000;

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
  model,
  reasoningEffort,
  timeoutMinutes,
  mode = 'faithful',
  prompt = '',
  script,
  usage = null
}) {
  const stats = scriptStats(script);
  const timestamp = nowIso();
  return {
    id: id('codexchat'),
    codexThreadId: cleanText(threadId, 120),
    model: normalizeCodexModel(model),
    reasoningEffort: normalizeCodexReasoningEffort(reasoningEffort),
    timeoutMinutes: normalizeCodexTimeoutMinutes(timeoutMinutes),
    mode: ['faithful', 'polished', 'drama'].includes(mode) ? mode : 'faithful',
    status: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 1,
    scriptSnapshot: cloneScriptSnapshot(script),
    messages: [
      message('user', prompt || '请把当前章节转换为结构化有声书剧本。'),
      message('assistant', assistantSummary(script), { ...stats, usage: safeUsage(usage) })
    ]
  };
}

export function appendCodexTurn(session, {
  prompt, model, reasoningEffort, timeoutMinutes, script, usage = null
}) {
  const stats = scriptStats(script);
  session.model = normalizeCodexModel(model);
  session.reasoningEffort = normalizeCodexReasoningEffort(reasoningEffort);
  session.timeoutMinutes = normalizeCodexTimeoutMinutes(timeoutMinutes);
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
  const sessions = Array.isArray(chapter.codexSessions) ? chapter.codexSessions : [];
  chapter.codexSessions = [session, ...sessions.filter((item) => item.id !== session.id)]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, MAX_SESSIONS_PER_CHAPTER);
  chapter.activeCodexSessionId = session.id;
  return session;
}

export function publicCodexSession(session) {
  if (!session) return null;
  const { codexThreadId: _privateThreadId, scriptSnapshot: _privateScriptSnapshot, ...publicValue } = session;
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
