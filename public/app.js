const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const CODEX_PROGRESS_PREFERENCE_KEY = 'novelVoiceStudio.codexProgressVisible.v1';
const CODEX_ACTIVITY_PREFERENCE_KEY = 'novelVoiceStudio.codexActivityVisible.v1';
const CODEX_SESSION_PANE_WIDTH_KEY = 'novelVoiceStudio.codexSessionPaneWidth.v1';
const CODEX_SCRIPT_PANE_WIDTH_KEY = 'novelVoiceStudio.codexScriptPaneWidth.v1';
const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODEX_TIMEOUT_MINUTES = 10;
const MIN_CODEX_TIMEOUT_MINUTES = 5;
const MAX_CODEX_TIMEOUT_MINUTES = 120;

function readLocalBoolean(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeLocalBoolean(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch {}
}

function readLocalNumber(key, fallback, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalNumber(key, value) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch {}
}

const state = {
  bootstrap: null,
  view: 'projects',
  project: null,
  selectedChapterId: null,
  selectedLineId: null,
  lineFilter: 'all',
  bookFile: null,
  voiceFile: null,
  recordingBlob: null,
  recorder: null,
  recorderStream: null,
  recordingSession: 0,
  voiceTab: 'record',
  voiceSourceFile: null,
  voiceSourceKind: null,
  voiceSourceObjectUrl: null,
  voiceSourceDuration: 0,
  voiceClipStart: 0,
  voiceClipEnd: 0,
  voiceSourceId: null,
  voiceSourceSession: 0,
  voiceSourceUploadController: null,
  voiceExtractSubmitted: false,
  voiceExtractSubmitting: false,
  voiceClipPreviewing: false,
  loadedAudio: null,
  jobTimer: null,
  watchedJobs: new Set(),
  notifiedJobs: new Set(),
  saveTimers: new Map(),
  lineSaveErrors: new Map(),
  codexPackage: null,
  codexSessionId: null,
  codexVersionId: null,
  codexSessionByChapter: new Map(),
  codexCollapsedChapters: new Set(),
  codexChapterGroupsProjectId: '',
  codexShowAllChapters: false,
  codexSessionScripts: new Map(),
  codexSessionScriptRequests: new Map(),
  codexProjectRefreshSequence: 0,
  codexProjectRefreshApplied: new Map(),
  codexDrafts: new Map(),
  codexErrorsBySession: new Map(),
  codexProvider: 'codex',
  codexModel: DEFAULT_CODEX_MODEL,
  codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  codexTimeoutMinutes: DEFAULT_CODEX_TIMEOUT_MINUTES,
  codexMode: 'faithful',
  codexBusy: false,
  codexError: '',
  codexRequestId: 0,
  codexProgressVisible: readLocalBoolean(CODEX_PROGRESS_PREFERENCE_KEY, true),
  codexActivityVisible: readLocalBoolean(CODEX_ACTIVITY_PREFERENCE_KEY, false),
  codexSessionPaneWidth: readLocalNumber(CODEX_SESSION_PANE_WIDTH_KEY, 224, 180, 360),
  codexScriptPaneWidth: readLocalNumber(CODEX_SCRIPT_PANE_WIDTH_KEY, 430, 300, 720),
  codexProgressBySession: new Map(),
  codexProgressSources: new Map(),
  codexProgressGeneration: 0,
  codexProgressRecoveryId: 0,
  codexProgressRecoveryBySession: new Map(),
  codexProgressElapsedTimer: null,
  codexLogin: null,
  codexLoginPanelOpen: false,
  codexLoginTimer: null,
  codexLoginRequestId: 0,
  codexLoginAction: '',
  codexLoginPollInFlight: false,
  codexLoginOrigin: '',
  codexLoginPopup: null,
  codexLoginPopupNavigated: false,
  codexLoginPopupBlocked: false,
  codexLoginOpenedUrl: '',
  ruleScriptSubmitting: false,
  bulkScriptProvider: 'rules',
  bulkScriptMode: 'faithful',
  bulkScriptModel: DEFAULT_CODEX_MODEL,
  bulkScriptReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  bulkScriptTimeoutMinutes: DEFAULT_CODEX_TIMEOUT_MINUTES,
  bulkScriptChapterIds: new Set(),
  bulkScriptSubmitting: false,
  voiceBindingOpen: false,
  voiceBindingChapterOnly: false,
  voiceBindingDraft: new Map(),
  voiceBindingSaving: false,
  voiceBindingProjectId: '',
  voiceBindingPickerRoleId: '',
  voiceBindingPreview: null,
  voiceBindingPreviewRequestId: 0,
  modalTrigger: null
};

const statusLabels = {
  empty: '待导入', source: '等待剧本化', scripted: '剧本已就绪', rendered: '音频已生成',
  render_partial: '部分已生成', queued: '排队中', running: '进行中', completed: '已完成', failed: '失败'
};
const jobLabels = {
  script: '剧本润色', render: '语音生成', export: '音频导出',
  extract: '音色裁剪', voice_extract: '音色裁剪', 'voice-extract': '音色裁剪'
};
const coverColors = ['#78dfc9', '#ffb86b', '#aea4ff', '#f07d9e', '#78aef8'];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { notation: Number(value) > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '刚刚';
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function fileToBase64(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(fileOrBlob);
  });
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(payload.message || payload.detail || '请求失败');
    error.code = payload.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(title, message = '', type = 'success', timeout = 4200) {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<i></i><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div><button aria-label="关闭">×</button>`;
  item.querySelector('button').addEventListener('click', () => item.remove());
  $('#toast-stack').append(item);
  setTimeout(() => item.remove(), timeout);
}

function showModal(content, className = '') {
  if (!$('#modal-root .modal')) state.modalTrigger = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal ${className}" role="dialog" aria-modal="true">${content}</section></div>`;
  const modal = $('#modal-root .modal');
  const title = modal?.querySelector('h2');
  if (title) { title.id = 'active-modal-title'; modal.setAttribute('aria-labelledby', title.id); }
  requestAnimationFrame(() => modal?.querySelector('[data-action="close-modal"], input, select, textarea, button')?.focus());
}

function closeModal() {
  const closingCodexLogin = Boolean($('#modal-root .codex-login-modal'));
  if (state.voiceExtractSubmitting) {
    toast('正在提交裁剪任务', '任务编号返回前请不要关闭；提交完成后可在任务抽屉继续查看。', 'warn');
    return false;
  }
  stopRecorderTracks({ discard: true });
  resetVoiceSource({ discardRemote: true });
  stopCodexLoginPolling({ invalidate: true });
  state.codexLoginPanelOpen = false;
  state.codexLoginAction = '';
  if (closingCodexLogin && !state.codexLoginPopupNavigated) clearCodexLoginNavigation({ clearUrl: false });
  state.codexRequestId += 1;
  state.codexBusy = false;
  state.codexError = '';
  $('#modal-root').innerHTML = '';
  state.bookFile = null;
  state.voiceFile = null;
  state.recordingBlob = null;
  state.voiceTab = 'record';
  if (state.modalTrigger?.isConnected) state.modalTrigger.focus();
  state.modalTrigger = null;
  return true;
}

function stopRecorderTracks({ discard = false } = {}) {
  if (discard) state.recordingSession += 1;
  if (state.recorder?.state === 'recording') state.recorder.stop();
  state.recorderStream?.getTracks().forEach((track) => track.stop());
  state.recorderStream = null;
  state.recorder = null;
}

function discardRemoteVoiceSource(sourceId) {
  if (!sourceId) return;
  api(`/api/voice-sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }).catch(() => {});
}

function resetVoiceSource({ discardRemote = false } = {}) {
  const sourceId = state.voiceSourceId;
  const shouldDiscardRemote = discardRemote && sourceId && !state.voiceExtractSubmitted;
  state.voiceSourceSession += 1;
  state.voiceSourceUploadController?.abort();
  state.voiceSourceUploadController = null;
  const preview = $('#voice-source-preview-audio:not([hidden]), #voice-source-preview-video:not([hidden])');
  preview?.pause();
  if (state.voiceSourceObjectUrl) URL.revokeObjectURL(state.voiceSourceObjectUrl);
  state.voiceSourceFile = null;
  state.voiceSourceKind = null;
  state.voiceSourceObjectUrl = null;
  state.voiceSourceDuration = 0;
  state.voiceClipStart = 0;
  state.voiceClipEnd = 0;
  state.voiceSourceId = null;
  state.voiceExtractSubmitted = false;
  state.voiceExtractSubmitting = false;
  state.voiceClipPreviewing = false;
  if (shouldDiscardRemote) discardRemoteVoiceSource(sourceId);
}

function resetPlayback() {
  const audio = $('#audio-player');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.loadedAudio = null;
  state.voiceBindingPreview = null;
  state.voiceBindingPreviewRequestId += 1;
  $('.play-main').textContent = '▶';
  syncVoiceBindingPreviewButtons();
}

async function refreshBootstrap({ render = false } = {}) {
  state.bootstrap = await api('/api/bootstrap');
  updateTopbar();
  renderJobs();
  if (render) renderView();
}

async function loadProject(projectId) {
  const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  if (state.voiceBindingProjectId && state.voiceBindingProjectId !== project.id) {
    state.voiceBindingDraft.clear();
    state.voiceBindingOpen = false;
    state.voiceBindingChapterOnly = false;
  }
  state.voiceBindingProjectId = project.id;
  applyCodexProjectSnapshot(project, { allowSwitch: true });
  const validRoleIds = new Set(project.characters?.map((role) => role.id) || []);
  for (const roleId of state.voiceBindingDraft.keys()) {
    if (!validRoleIds.has(roleId)) state.voiceBindingDraft.delete(roleId);
  }
  if (!state.selectedChapterId || !state.project.chapters.some((chapter) => chapter.id === state.selectedChapterId)) {
    state.selectedChapterId = state.project.chapters[0]?.id || null;
  }
  if (state.selectedLineId && !findLine(state.selectedLineId)) state.selectedLineId = null;
}

function currentChapter() {
  return state.project?.chapters.find((chapter) => chapter.id === state.selectedChapterId) || state.project?.chapters[0] || null;
}

function allProjectLines() {
  return state.project?.chapters.flatMap((chapter) => (chapter.scenes || []).flatMap((scene) => scene.lines || [])) || [];
}

function findLineInProject(project, lineId) {
  return project?.chapters.flatMap((chapter) => (chapter.scenes || []).flatMap((scene) => scene.lines || []))
    .find((line) => line.id === lineId) || null;
}

function findLine(lineId) {
  return findLineInProject(state.project, lineId);
}

function roleForLine(line) {
  return state.project?.characters.find((role) => role.id === line?.speakerId) || state.project?.characters.find((role) => role.name === line?.speaker);
}

function voiceForRole(role) {
  return state.bootstrap?.voices.find((voice) => voice.id === role?.voiceId) || null;
}

function renderableLines(lines = []) {
  return lines.filter((line) => ['narration', 'dialogue'].includes(line?.kind) && String(line.spokenText || '').trim());
}

function renderTargetsForScope(scope, lineId = '') {
  if (scope === 'line') {
    const line = findLine(lineId);
    return renderableLines(line ? [line] : []);
  }
  if (scope === 'chapter') {
    return renderableLines(currentChapter()?.scenes?.flatMap((scene) => scene.lines || []) || []);
  }
  return renderableLines(allProjectLines());
}

function missingVoicesForLines(lines) {
  const missing = new Map();
  for (const line of renderableLines(lines)) {
    const role = roleForLine(line);
    const voice = voiceForRole(role);
    if (role && voice?.status === 'ready' && voice.reference) continue;
    const key = role?.id || `speaker:${line.speaker || 'unknown'}`;
    const reason = !role ? '角色尚未确认'
      : !role.voiceId ? '未绑定音色'
        : !voice ? '绑定的音色已不存在'
          : voice.status !== 'ready' ? '音色尚未就绪' : '缺少参考录音';
    const item = missing.get(key) || {
      id: role?.id || '', name: role?.name || line.speaker || '未识别角色', color: role?.color || '#ffb86b', reason, count: 0
    };
    item.count += 1;
    missing.set(key, item);
  }
  return [...missing.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
}

function emotionLabel(id) {
  return state.bootstrap?.emotions.find((emotion) => emotion.id === id)?.label || '平静';
}

const CODEX_MODE_LABELS = { faithful: '忠实朗读', polished: '轻度剧本化', drama: '广播剧化' };
const COLLABORATION_PROVIDERS = new Set(['codex', 'ollama']);
const SCRIPT_VERSION_SOURCES = new Set(['codex', 'ollama', 'rules', 'import']);
const SCRIPT_SOURCE_LABELS = {
  codex: 'Codex',
  ollama: '本地 Ollama',
  rules: '规则生成',
  import: '导入版本'
};
const CODEX_MODEL_OPTIONS = [
  ['gpt-5.6-sol', 'Sol'], ['gpt-5.6-terra', 'Terra'], ['gpt-5.6-luna', 'Luna']
];
const CODEX_REASONING_OPTIONS = [
  ['low', 'Low · 较快'],
  ['medium', 'Medium · 推荐（质量 / 速度平衡）'],
  ['high', 'High · 更深入'],
  ['xhigh', 'XHigh · 很深入'],
  ['max', 'Max · 最强、最慢']
];
const CODEX_REASONING_VALUES = new Set(CODEX_REASONING_OPTIONS.map(([value]) => value));
const CODEX_REASONING_LABELS = {
  low: '较低',
  medium: '中等',
  high: '高',
  xhigh: '极高',
  max: '最高（最慢）'
};
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function normalizeCodexModel(value, fallback = DEFAULT_CODEX_MODEL) {
  if (typeof value !== 'string') return fallback;
  const model = value.trim();
  return CODEX_MODEL_PATTERN.test(model) ? model : fallback;
}

function normalizeCodexReasoningEffort(value, fallback = DEFAULT_CODEX_REASONING_EFFORT) {
  return CODEX_REASONING_VALUES.has(value) ? value : fallback;
}

function parseCodexTimeoutMinutes(value) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^\d{1,3}$/.test(text)) return null;
  const minutes = Number(text);
  return Number.isInteger(minutes)
    && minutes >= MIN_CODEX_TIMEOUT_MINUTES
    && minutes <= MAX_CODEX_TIMEOUT_MINUTES
    ? minutes
    : null;
}

function normalizeCodexTimeoutMinutes(value, fallback = DEFAULT_CODEX_TIMEOUT_MINUTES) {
  return parseCodexTimeoutMinutes(value) ?? fallback;
}

function normalizeCollaborationProvider(value, fallback = 'codex') {
  return COLLABORATION_PROVIDERS.has(value) ? value : fallback;
}

function scriptVersionSource(value, fallback = 'codex') {
  const source = value?.source || value?.provider || value;
  return SCRIPT_VERSION_SOURCES.has(source) ? source : fallback;
}

function scriptSourceLabel(value) {
  return SCRIPT_SOURCE_LABELS[scriptVersionSource(value)] || SCRIPT_SOURCE_LABELS.codex;
}

function collaborationModelDefault(provider = state.codexProvider) {
  return normalizeCollaborationProvider(provider) === 'ollama'
    ? normalizeCodexModel(state.bootstrap?.settings?.ollamaModel, 'qwen3:8b')
    : DEFAULT_CODEX_MODEL;
}

function codexReasoningLabel(value, fallback = '未记录') {
  return CODEX_REASONING_LABELS[value] || fallback;
}

function codexSessionRuntimeLabel(session) {
  const provider = normalizeCollaborationProvider(session?.provider);
  const model = typeof session?.model === 'string' && session.model.trim()
    ? session.model.trim()
    : '模型未记录';
  const timeout = parseCodexTimeoutMinutes(session?.timeoutMinutes);
  const runtime = provider === 'ollama'
    ? `${model} · 本地推理`
    : `${model} · 推理 ${codexReasoningLabel(session?.reasoningEffort, '推理强度未记录')}`;
  return `${runtime} · ${timeout === null ? '超时未记录' : `超时 ${timeout} 分钟`}`;
}

function codexProgressRuntimeLabel(progress) {
  const provider = normalizeCollaborationProvider(progress?.provider);
  const model = normalizeCodexModel(progress?.model, collaborationModelDefault(provider));
  const timeout = normalizeCodexTimeoutMinutes(progress?.timeoutMinutes);
  const runtime = provider === 'ollama'
    ? `${model} · 本地 Ollama`
    : `${model} · 推理 ${codexReasoningLabel(normalizeCodexReasoningEffort(progress?.reasoningEffort))}`;
  return `${runtime} · 超时 ${timeout} 分钟`;
}

function codexSessions(chapter = currentChapter()) {
  return [...(chapter?.codexSessions || [])].sort((left, right) => {
    const leftDate = left.updatedAt || left.messages?.at(-1)?.createdAt || left.createdAt || '';
    const rightDate = right.updatedAt || right.messages?.at(-1)?.createdAt || right.createdAt || '';
    return String(rightDate).localeCompare(String(leftDate));
  });
}

function allCodexSessions() {
  const rows = [];
  for (const chapter of state.project?.chapters || []) {
    const sessions = codexSessions(chapter);
    sessions.forEach((session, index) => rows.push({
      ...session,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      chapterIndex: chapter.index,
      versionNumber: Number.isInteger(session.versionOrdinal) && session.versionOrdinal > 0
        ? session.versionOrdinal
        : Math.max(1, sessions.length - index)
    }));
  }
  return rows.sort((left, right) => String(right.updatedAt || right.createdAt || '')
    .localeCompare(String(left.updatedAt || left.createdAt || '')));
}

function findCodexSessionAcrossProject(sessionId, chapterId = '') {
  return allCodexSessions().find((session) => session.id === sessionId
    && (!chapterId || session.chapterId === chapterId)) || null;
}

function currentCodexSession() {
  return codexSessions().find((session) => session.id === state.codexSessionId) || null;
}

function currentCodexVersion() {
  return codexSessions().find((session) => session.id === state.codexVersionId) || null;
}

function codexSessionScriptKey(projectId, chapterId, sessionId) {
  return projectId && chapterId && sessionId ? `${projectId}:${chapterId}:${sessionId}` : '';
}

function mergeCodexSessionIntoProject(chapterId, session, { authoritative = false } = {}) {
  if (!session?.id || !state.project) return false;
  const chapter = state.project.chapters?.find((item) => item.id === chapterId);
  if (!chapter) return false;
  const sessions = [...(chapter.codexSessions || [])];
  const index = sessions.findIndex((item) => item.id === session.id);
  const current = index >= 0 ? sessions[index] : null;
  const currentUpdatedAt = Date.parse(current?.updatedAt || '');
  const incomingUpdatedAt = Date.parse(session.updatedAt || '');
  const currentIsTerminal = ['ready', 'failed'].includes(current?.status);
  const incomingIsActive = ['pending', 'running'].includes(session.status);
  const incomingIsReliablyNewer = Number.isFinite(currentUpdatedAt)
    && Number.isFinite(incomingUpdatedAt)
    && incomingUpdatedAt > currentUpdatedAt;
  if (!authoritative && ((Number.isFinite(currentUpdatedAt)
      && (!Number.isFinite(incomingUpdatedAt) || incomingUpdatedAt < currentUpdatedAt))
    || (currentIsTerminal && incomingIsActive && !incomingIsReliablyNewer))) return false;
  invalidateCodexProjectRefresh(state.project.id);
  if (index >= 0) sessions[index] = { ...sessions[index], ...session };
  else sessions.unshift(session);
  chapter.codexSessions = sessions;
  return true;
}

async function loadCodexSessionScript(sessionId, chapterId = currentChapter()?.id, { force = false } = {}) {
  const projectId = state.project?.id;
  const key = codexSessionScriptKey(projectId, chapterId, sessionId);
  if (!key) return null;
  const cached = state.codexSessionScripts.get(key) || null;
  if (!force && cached) {
    const publicSession = state.project?.chapters?.find((chapter) => chapter.id === chapterId)
      ?.codexSessions?.find((session) => session.id === sessionId) || null;
    const publicUpdatedAt = Date.parse(publicSession?.updatedAt || '');
    const cachedUpdatedAt = Date.parse(cached.session?.updatedAt || '');
    const publicIsTerminal = ['ready', 'failed'].includes(publicSession?.status);
    const cachedWasActive = sessionHasActiveRun(cached.session);
    const publicIsNewer = Number.isFinite(publicUpdatedAt)
      && (!Number.isFinite(cachedUpdatedAt) || publicUpdatedAt > cachedUpdatedAt);
    if (!publicIsNewer && !(publicIsTerminal && cachedWasActive)) return cached;
  }
  const requestGeneration = (state.codexSessionScriptRequests.get(key) || 0) + 1;
  state.codexSessionScriptRequests.set(key, requestGeneration);
  const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/script`);
  if (state.codexSessionScriptRequests.get(key) !== requestGeneration) {
    return state.codexSessionScripts.get(key) || null;
  }
  if (payload?.session && !mergeCodexSessionIntoProject(chapterId, payload.session)) {
    return state.codexSessionScripts.get(key) || null;
  }
  const snapshot = { script: payload?.script || null, isActive: payload?.isActive === true, session: payload?.session || null };
  state.codexSessionScripts.set(key, snapshot);
  return snapshot;
}

async function refreshCodexProjectSnapshot(projectId) {
  const requestGeneration = ++state.codexProjectRefreshSequence;
  // Mark the newest request before awaiting it. An older response that arrives
  // while a newer refresh is in flight must never replace the newer local
  // Session state, even if that newer request has not completed yet.
  state.codexProjectRefreshApplied.set(projectId, requestGeneration);
  const refreshed = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  if ([...state.saveTimers.keys()].some((key) => key.startsWith(`${projectId}:`))) return null;
  return applyCodexProjectSnapshot(refreshed, { expectedGeneration: requestGeneration }) ? refreshed : null;
}

function applyCodexProjectSnapshot(project, { allowSwitch = false, expectedGeneration = null } = {}) {
  const projectId = typeof project?.id === 'string' ? project.id : '';
  if (!projectId) return false;
  if (expectedGeneration !== null) {
    if (state.codexProjectRefreshApplied.get(projectId) !== expectedGeneration) return false;
  } else {
    // A mutation/load response is newer than every background refresh already
    // in flight. Advancing this token prevents an older GET from restoring an
    // obsolete active Session or script version afterwards.
    invalidateCodexProjectRefresh(projectId);
  }
  if (!allowSwitch && state.project?.id !== projectId) return false;
  const requestPrefix = `${projectId}:`;
  for (const [key, generation] of state.codexSessionScriptRequests.entries()) {
    if (key.startsWith(requestPrefix)) state.codexSessionScriptRequests.set(key, generation + 1);
  }
  state.project = project;
  return true;
}

function invalidateCodexProjectRefresh(projectId = state.project?.id) {
  if (!projectId) return 0;
  const generation = ++state.codexProjectRefreshSequence;
  state.codexProjectRefreshApplied.set(projectId, generation);
  return generation;
}

function selectedCodexScriptSnapshot() {
  const chapter = currentChapter();
  const sessionId = state.codexVersionId;
  if (!chapter || !sessionId) return { script: chapter, isActive: true, loading: false };
  if (chapter.activeCodexSessionId === sessionId) return { script: chapter, isActive: true, loading: false };
  const key = codexSessionScriptKey(state.project?.id, chapter.id, sessionId);
  const cached = state.codexSessionScripts.get(key);
  return cached ? { ...cached, loading: false } : { script: null, isActive: false, loading: true };
}

function codexReadiness() {
  const tool = state.bootstrap?.system?.tools?.codex || {};
  if (tool.runnable) {
    return { ready: true, label: 'Codex CLI 已就绪', detail: tool.version || tool.path || '可由本地服务直接调用' };
  }
  const detail = String(tool.error || '未检测到可由本地服务启动的 Codex CLI')
    .replace(/\s+/g, ' ').trim().slice(0, 220);
  if (tool.state === 'authRequired') return { ready: false, authRequired: true, label: 'Codex CLI 等待登录', detail };
  return { ready: false, authRequired: false, label: 'Codex CLI 当前不可直接调用', detail };
}

function collaborationReadiness(provider = state.codexProvider) {
  if (normalizeCollaborationProvider(provider) === 'codex') return codexReadiness();
  const settings = state.bootstrap?.settings || {};
  const model = normalizeCodexModel(settings.ollamaModel, 'qwen3:8b');
  const endpoint = String(settings.ollamaUrl || '').trim();
  return {
    ready: Boolean(model),
    authRequired: false,
    label: '本地 Ollama',
    detail: `${model}${endpoint ? ` · ${endpoint}` : ''}；发送时由本地服务检测连接`
  };
}

const CODEX_LOGIN_ACTIVE_STATES = new Set(['starting', 'waiting']);
const CODEX_LOGIN_TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timedOut']);
const CODEX_LOGIN_KNOWN_STATES = new Set(['idle', ...CODEX_LOGIN_ACTIVE_STATES, ...CODEX_LOGIN_TERMINAL_STATES]);
const CODEX_LOGIN_WINDOW_NAME = 'novel-voice-studio-codex-login';

function safeCodexLoginMessage(value = '') {
  return String(value)
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function normalizeCodexLoginUrl(value) {
  if (typeof value !== 'string' || value.length > 8_192) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'auth.openai.com') return '';
    if (url.pathname !== '/oauth/authorize' || url.port || url.username || url.password || url.hash) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeCodexLogin(payload, fallbackState = 'idle') {
  const source = payload?.login && typeof payload.login === 'object' ? payload.login : payload || {};
  const aliases = { canceled: 'cancelled', timeout: 'timedOut', timed_out: 'timedOut', completed: 'succeeded', success: 'succeeded' };
  let loginState = aliases[source.state] || source.state || fallbackState;
  if (source.authenticated === true) loginState = 'succeeded';
  if (!CODEX_LOGIN_KNOWN_STATES.has(loginState)) loginState = fallbackState;
  const loginUrl = normalizeCodexLoginUrl(source.loginUrl);
  return {
    state: loginState,
    message: safeCodexLoginMessage(source.message),
    startedAt: source.startedAt || null,
    finishedAt: source.finishedAt || null,
    timeoutAt: source.timeoutAt || null,
    authenticated: source.authenticated === true,
    loginUrl,
    browserActionRequired: source.browserActionRequired === true
  };
}

function currentCodexLogin() {
  return normalizeCodexLogin(state.codexLogin || { state: 'idle' });
}

function codexLoginPopupIsOpen() {
  try {
    return Boolean(state.codexLoginPopup && !state.codexLoginPopup.closed);
  } catch {
    return false;
  }
}

function renderCodexLoginWaitingPage(popup) {
  try {
    const doc = popup.document;
    doc.title = '正在准备 Codex 登录';
    doc.documentElement.lang = 'zh-CN';
    doc.documentElement.style.colorScheme = 'dark';
    doc.body.innerHTML = '<main><span>CODEX SIGN-IN</span><h1>正在准备 OpenAI 登录页</h1><p>请保留此窗口。验证地址准备好后会自动打开。</p><i aria-hidden="true"></i></main>';
    doc.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e0e;color:#edf7f3;font-family:system-ui,sans-serif';
    const main = doc.querySelector('main');
    if (main) main.style.cssText = 'max-width:420px;padding:36px;text-align:center';
    const eyebrow = doc.querySelector('span');
    if (eyebrow) eyebrow.style.cssText = 'color:#78dfc9;font-size:12px;letter-spacing:.16em';
    const heading = doc.querySelector('h1');
    if (heading) heading.style.cssText = 'margin:14px 0 10px;font-size:24px';
    const copy = doc.querySelector('p');
    if (copy) copy.style.cssText = 'margin:0;color:#91a09b;font-size:14px;line-height:1.7';
    const dot = doc.querySelector('i');
    if (dot) dot.style.cssText = 'display:block;width:9px;height:9px;margin:24px auto 0;border-radius:50%;background:#78dfc9;box-shadow:0 0 0 7px rgba(120,223,201,.08)';
  } catch {
    // about:blank may already have been replaced by the browser; navigation can still continue.
  }
}

function prepareCodexLoginPopup() {
  if (codexLoginPopupIsOpen()) return state.codexLoginPopup;
  let popup = null;
  try {
    popup = window.open('about:blank', CODEX_LOGIN_WINDOW_NAME, 'popup,width=760,height=860');
  } catch {}
  state.codexLoginPopup = popup;
  state.codexLoginPopupNavigated = false;
  state.codexLoginOpenedUrl = '';
  state.codexLoginPopupBlocked = !popup;
  if (!popup) return null;
  renderCodexLoginWaitingPage(popup);
  try { popup.opener = null; } catch {}
  return popup;
}

function navigateCodexLoginPopup(login = currentCodexLogin()) {
  const loginUrl = normalizeCodexLoginUrl(login.loginUrl);
  if (!loginUrl || state.codexLoginPopupNavigated || state.codexLoginOpenedUrl === loginUrl) return false;
  const popup = state.codexLoginPopup;
  if (!codexLoginPopupIsOpen()) {
    if (popup) state.codexLoginPopupBlocked = true;
    return false;
  }
  try {
    popup.opener = null;
    popup.location.replace(loginUrl);
    state.codexLoginPopupNavigated = true;
    state.codexLoginOpenedUrl = loginUrl;
    state.codexLoginPopupBlocked = false;
    return true;
  } catch {
    if (codexLoginPopupIsOpen()) {
      try { popup.close(); } catch {}
    }
    state.codexLoginPopup = null;
    state.codexLoginPopupBlocked = true;
    return false;
  }
}

function clearCodexLoginNavigation({ clearUrl = true } = {}) {
  if (codexLoginPopupIsOpen() && !state.codexLoginPopupNavigated) {
    try { state.codexLoginPopup.close(); } catch {}
  }
  state.codexLoginPopup = null;
  state.codexLoginPopupNavigated = false;
  state.codexLoginPopupBlocked = false;
  state.codexLoginOpenedUrl = '';
  if (clearUrl && state.codexLogin) {
    state.codexLogin = { ...state.codexLogin, loginUrl: '', browserActionRequired: false };
  }
}

function codexLoginPresentation(loginState) {
  return ({
    idle: {
      tone: 'idle', icon: '↗', eyebrow: 'SECURE SIGN-IN', title: '登录 Codex',
      detail: '将由本机 Codex CLI 打开 OpenAI 官方登录页。登录完成后会自动返回工作台。', status: '等待开始登录'
    },
    starting: {
      tone: 'active', icon: '↗', eyebrow: 'OPENING BROWSER', title: '正在打开 OpenAI 登录页',
      detail: '请稍候，工作台正在启动本机 Codex 登录流程。', status: '正在连接本机 Codex CLI'
    },
    waiting: {
      tone: 'active', icon: '↗', eyebrow: 'AWAITING CONFIRMATION', title: '请在浏览器中完成登录',
      detail: '在 OpenAI 官方页面选择账号与工作区；完成后留在此页，状态会自动更新。', status: '等待浏览器确认'
    },
    succeeded: {
      tone: 'success', icon: '✓', eyebrow: 'SIGNED IN', title: 'Codex 登录成功',
      detail: '本机 Codex CLI 已就绪，现在可以在同一会话中生成和调整剧本。', status: '身份验证已完成'
    },
    failed: {
      tone: 'error', icon: '!', eyebrow: 'SIGN-IN FAILED', title: 'Codex 登录没有完成',
      detail: '可以重试浏览器登录，或重新检测本机 Codex 状态。', status: '登录流程失败'
    },
    cancelled: {
      tone: 'idle', icon: '×', eyebrow: 'SIGN-IN CANCELLED', title: '已取消 Codex 登录',
      detail: '没有删除已有账号信息；需要时可以重新发起登录。', status: '登录流程已取消'
    },
    timedOut: {
      tone: 'error', icon: '!', eyebrow: 'SIGN-IN TIMED OUT', title: 'Codex 登录已超时',
      detail: '浏览器确认等待时间已结束。请检查网络后重试。', status: '等待浏览器确认超时'
    }
  })[loginState] || null;
}

function codexLoginElapsed(startedAt) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `已等待 ${minutes ? `${minutes} 分 ` : ''}${String(seconds % 60).padStart(2, '0')} 秒`;
}

function codexLoginStepClass(loginState, index) {
  if (loginState === 'succeeded') return 'done';
  if (loginState === 'starting') return index === 0 ? 'current' : '';
  if (loginState === 'waiting') return index === 0 ? 'done' : index === 1 ? 'current' : '';
  if (['failed', 'cancelled', 'timedOut'].includes(loginState)) return index === 0 ? 'done' : index === 1 ? 'current interrupted' : '';
  return index === 0 ? 'current' : '';
}

function codexLoginModalHtml() {
  const login = currentCodexLogin();
  const presentation = codexLoginPresentation(login.state);
  const active = CODEX_LOGIN_ACTIVE_STATES.has(login.state);
  const actionPending = Boolean(state.codexLoginAction);
  const message = login.message || presentation.status;
  const elapsed = codexLoginElapsed(login.startedAt);
  const closeLabel = active ? '关闭登录面板；登录流程会继续在后台运行' : '关闭登录面板';
  const steps = ['启动本机 CLI', '完成官方网页登录', '返回工作台'];
  const browserLinkTitle = state.codexLoginPopupBlocked
    ? '浏览器阻止了自动打开'
    : state.codexLoginPopupNavigated
      ? 'OpenAI 登录页已在新窗口打开'
      : login.browserActionRequired
        ? '需要手动打开官方登录页'
        : '打开 OpenAI 官方登录页';
  const browserLink = login.loginUrl
    ? `<div class="codex-login-browser-action" role="group" aria-label="OpenAI 官方登录页"><div><strong>${browserLinkTitle}</strong><small>${state.codexLoginPopupNavigated ? '如果没有看到登录窗口，可以从这里重新打开。' : '链接只在本次本机登录期间有效，将在完成、取消或超时后清除。'}</small></div><a class="button ${state.codexLoginPopupNavigated ? 'ghost' : 'primary'}" href="${escapeHtml(login.loginUrl)}" target="_blank" rel="noopener noreferrer">↗ 打开 OpenAI 登录页</a></div>`
    : '';
  const actions = active
    ? `<button class="button ghost" data-action="dismiss-codex-login">在后台继续</button><button class="button danger" data-action="cancel-codex-login" ${actionPending ? 'disabled' : ''}>${state.codexLoginAction === 'cancel' ? '取消中…' : '取消登录'}</button>`
    : login.state === 'succeeded'
      ? `<button class="button ghost" data-action="recheck-codex-login" ${actionPending ? 'disabled' : ''}>${state.codexLoginAction === 'recheck' ? '检测中…' : '重新检测'}</button><button class="button primary" data-action="dismiss-codex-login">开始使用 Codex</button>`
      : `<button class="button ghost" data-action="dismiss-codex-login">稍后处理</button><button class="button ghost" data-action="recheck-codex-login" ${actionPending ? 'disabled' : ''}>${state.codexLoginAction === 'recheck' ? '检测中…' : '重新检测'}</button><button class="button primary" data-action="start-codex-login" ${actionPending ? 'disabled' : ''}>${state.codexLoginAction === 'start' ? '正在申请…' : login.state === 'idle' ? '登录 Codex' : '重新登录'}</button>`;
  return `<header class="modal-head codex-login-head"><div><span class="eyebrow">CODEX ACCOUNT</span><h2>${escapeHtml(presentation.title)}</h2></div><button class="icon-button" data-action="dismiss-codex-login" aria-label="${closeLabel}">×</button></header>
    <div class="modal-body codex-login-body ${presentation.tone}">
      <div class="codex-login-hero"><span class="codex-login-icon" aria-hidden="true">${presentation.icon}</span><div><span class="eyebrow">${presentation.eyebrow}</span><p id="codex-login-description">${escapeHtml(presentation.detail)}</p></div></div>
      <div class="codex-login-live" role="status" aria-live="polite" aria-atomic="true"><i aria-hidden="true"></i><div><strong data-codex-login-message>${escapeHtml(message)}</strong><small data-codex-login-elapsed>${escapeHtml(elapsed)}</small></div></div>
      ${browserLink}
      <ol class="codex-login-steps" aria-label="Codex 登录进度">${steps.map((label, index) => `<li class="${codexLoginStepClass(login.state, index)}"><span>${index + 1}</span><small>${label}</small></li>`).join('')}</ol>
      <div class="codex-login-privacy"><span aria-hidden="true">⌾</span><p><strong>凭据不会经过本工作台</strong><small>密码、验证码与访问令牌只由 OpenAI 官方页面和本机 Codex CLI 处理；这里仅查看脱敏后的登录状态。</small></p></div>
      ${login.state === 'timedOut' ? '<p class="codex-login-help">如果浏览器无法回到本机应用，可在终端尝试 <code>codex login --device-auth</code>。</p>' : ''}
    </div>
    <footer class="modal-foot codex-login-actions">${actions}</footer>`;
}

function showCodexLoginModal({ focus = true } = {}) {
  state.codexLoginPanelOpen = true;
  showModal(codexLoginModalHtml(), 'codex-login-modal');
  const modal = $('#modal-root .codex-login-modal');
  if (modal) {
    modal.dataset.loginState = currentCodexLogin().state;
    modal.setAttribute('aria-describedby', 'codex-login-description');
  }
  if (focus) requestAnimationFrame(() => modal?.querySelector('.codex-login-head [data-action="dismiss-codex-login"]')?.focus());
}

function updateCodexLoginModal({ force = false, focusAction = '' } = {}) {
  if (!state.codexLoginPanelOpen) return;
  const modal = $('#modal-root .codex-login-modal');
  if (!modal) return showCodexLoginModal({ focus: Boolean(focusAction) });
  const login = currentCodexLogin();
  const presentation = codexLoginPresentation(login.state);
  if (!force && modal.dataset.loginState === login.state) {
    const message = modal.querySelector('[data-codex-login-message]');
    const elapsed = modal.querySelector('[data-codex-login-elapsed]');
    if (message) message.textContent = login.message || presentation.status;
    if (elapsed) elapsed.textContent = codexLoginElapsed(login.startedAt);
    return;
  }
  const previousAction = document.activeElement?.dataset?.action || '';
  modal.innerHTML = codexLoginModalHtml();
  modal.dataset.loginState = login.state;
  const title = modal.querySelector('h2');
  if (title) { title.id = 'active-modal-title'; modal.setAttribute('aria-labelledby', title.id); }
  modal.setAttribute('aria-describedby', 'codex-login-description');
  requestAnimationFrame(() => {
    const action = focusAction || previousAction;
    (action ? modal.querySelector(`[data-action="${action}"]:not([disabled])`) : null)?.focus();
  });
}

function stopCodexLoginPolling({ invalidate = false } = {}) {
  if (state.codexLoginTimer) clearTimeout(state.codexLoginTimer);
  state.codexLoginTimer = null;
  if (invalidate) state.codexLoginRequestId += 1;
  state.codexLoginPollInFlight = false;
}

function scheduleCodexLoginPoll() {
  if (state.codexLoginTimer) clearTimeout(state.codexLoginTimer);
  state.codexLoginTimer = null;
  if (!state.codexLoginPanelOpen || !CODEX_LOGIN_ACTIVE_STATES.has(currentCodexLogin().state)) return;
  state.codexLoginTimer = setTimeout(() => { pollCodexLogin(); }, 1200);
}

async function completeCodexLogin(login, requestId = state.codexLoginRequestId) {
  stopCodexLoginPolling();
  state.codexLogin = { ...login, state: 'succeeded', authenticated: true };
  clearCodexLoginNavigation();
  state.codexLoginAction = 'refresh';
  updateCodexLoginModal({ force: true });
  try {
    await api('/api/system?refresh=1');
    await refreshBootstrap({ render: state.codexLoginOrigin !== 'room' });
    if (requestId !== state.codexLoginRequestId) return;
    if (!codexReadiness().ready) throw new Error('登录已返回，但 Codex CLI 尚未就绪。请重新检测后再试。');
    state.codexLoginAction = '';
    updateCodexLoginModal({ force: true, focusAction: 'dismiss-codex-login' });
    toast('Codex 登录成功', '现在可以直接在协作室中进行多轮剧本调整。');
  } catch (error) {
    if (requestId !== state.codexLoginRequestId) return;
    state.codexLoginAction = '';
    state.codexLogin = { ...login, state: 'failed', authenticated: false, message: safeCodexLoginMessage(error.message) };
    clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: 'start-codex-login' });
  }
}

async function pollCodexLogin() {
  state.codexLoginTimer = null;
  if (!state.codexLoginPanelOpen || state.codexLoginPollInFlight) return;
  const requestId = state.codexLoginRequestId;
  state.codexLoginPollInFlight = true;
  try {
    const payload = await api('/api/codex/auth/login');
    if (requestId !== state.codexLoginRequestId || !state.codexLoginPanelOpen) return;
    const login = normalizeCodexLogin(payload, 'waiting');
    const previous = currentCodexLogin();
    state.codexLogin = login;
    const popupNavigated = navigateCodexLoginPopup(login);
    const loginLinkChanged = login.loginUrl !== previous.loginUrl || login.browserActionRequired !== previous.browserActionRequired;
    if (!CODEX_LOGIN_ACTIVE_STATES.has(login.state) && login.state !== 'succeeded') clearCodexLoginNavigation();
    updateCodexLoginModal({ force: popupNavigated || loginLinkChanged || login.state !== $('#modal-root .codex-login-modal')?.dataset.loginState });
    if (login.state === 'succeeded') await completeCodexLogin(login, requestId);
    else if (CODEX_LOGIN_ACTIVE_STATES.has(login.state)) scheduleCodexLoginPoll();
    else stopCodexLoginPolling();
  } catch (error) {
    if (requestId !== state.codexLoginRequestId || !state.codexLoginPanelOpen) return;
    state.codexLogin = { ...currentCodexLogin(), state: 'failed', message: safeCodexLoginMessage(error.message) || '无法读取本机登录状态' };
    clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: 'start-codex-login' });
  } finally {
    if (requestId === state.codexLoginRequestId) state.codexLoginPollInFlight = false;
  }
}

async function startCodexLogin() {
  if (state.codexLoginAction) return;
  if (codexReadiness().ready) return toast('Codex 已登录', '本机 CLI 已经可以直接使用。');
  const roomWasOpen = Boolean($('.codex-room-surface'));
  if (!state.codexLoginPanelOpen) {
    state.codexLoginOrigin = roomWasOpen ? 'room' : state.view;
    if (roomWasOpen) rememberCodexComposer();
  }
  const existingLogin = currentCodexLogin();
  prepareCodexLoginPopup();
  navigateCodexLoginPopup(existingLogin);
  stopCodexLoginPolling({ invalidate: true });
  const requestId = state.codexLoginRequestId;
  state.codexLoginAction = 'start';
  state.codexLogin = { ...currentCodexLogin(), state: 'starting', message: '正在检查本机 Codex 登录状态' };
  showCodexLoginModal();
  try {
    const currentPayload = await api('/api/codex/auth/login');
    if (requestId !== state.codexLoginRequestId) return;
    const current = normalizeCodexLogin(currentPayload);
    if (current.state === 'succeeded') {
      state.codexLoginAction = '';
      await completeCodexLogin(current, requestId);
      return;
    }
    if (CODEX_LOGIN_ACTIVE_STATES.has(current.state)) {
      state.codexLogin = current;
      navigateCodexLoginPopup(current);
      state.codexLoginAction = '';
      updateCodexLoginModal({ force: true, focusAction: 'cancel-codex-login' });
      scheduleCodexLoginPoll();
      return;
    }
    state.codexLogin = { ...current, state: 'starting', message: '正在打开 OpenAI 官方登录页' };
    updateCodexLoginModal();
    const payload = await api('/api/codex/auth/login', { method: 'POST' });
    if (requestId !== state.codexLoginRequestId) return;
    const login = normalizeCodexLogin(payload, 'waiting');
    state.codexLogin = login;
    navigateCodexLoginPopup(login);
    if (!CODEX_LOGIN_ACTIVE_STATES.has(login.state) && login.state !== 'succeeded') clearCodexLoginNavigation();
    state.codexLoginAction = '';
    updateCodexLoginModal({ force: true, focusAction: login.state === 'succeeded' ? 'dismiss-codex-login' : 'cancel-codex-login' });
    if (login.state === 'succeeded') await completeCodexLogin(login, requestId);
    else if (CODEX_LOGIN_ACTIVE_STATES.has(login.state)) scheduleCodexLoginPoll();
  } catch (error) {
    if (requestId !== state.codexLoginRequestId) return;
    state.codexLoginAction = '';
    state.codexLogin = { ...currentCodexLogin(), state: 'failed', authenticated: false, message: safeCodexLoginMessage(error.message) || '无法启动本机 Codex 登录' };
    clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: 'start-codex-login' });
  }
}

async function cancelCodexLogin() {
  if (state.codexLoginAction) return;
  stopCodexLoginPolling({ invalidate: true });
  const requestId = state.codexLoginRequestId;
  state.codexLoginAction = 'cancel';
  updateCodexLoginModal({ force: true });
  try {
    const payload = await api('/api/codex/auth/login', { method: 'DELETE' });
    if (requestId !== state.codexLoginRequestId) return;
    state.codexLogin = normalizeCodexLogin(payload, 'cancelled');
    clearCodexLoginNavigation();
    state.codexLoginAction = '';
    updateCodexLoginModal({ force: true, focusAction: 'start-codex-login' });
    toast('Codex 登录已取消', '需要时可以再次发起登录。', 'warn');
  } catch (error) {
    if (requestId !== state.codexLoginRequestId) return;
    state.codexLoginAction = '';
    state.codexLogin = { ...currentCodexLogin(), state: 'failed', message: safeCodexLoginMessage(error.message) || '取消登录失败' };
    clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: 'recheck-codex-login' });
  }
}

async function recheckCodexLogin() {
  if (state.codexLoginAction) return;
  stopCodexLoginPolling({ invalidate: true });
  const requestId = state.codexLoginRequestId;
  state.codexLoginAction = 'recheck';
  updateCodexLoginModal({ force: true });
  try {
    const payload = await api('/api/codex/auth/login');
    if (requestId !== state.codexLoginRequestId) return;
    const login = normalizeCodexLogin(payload);
    state.codexLogin = login;
    navigateCodexLoginPopup(login);
    if (login.state === 'succeeded') {
      state.codexLoginAction = '';
      await completeCodexLogin(login, requestId);
      return;
    }
    await api('/api/system?refresh=1');
    await refreshBootstrap({ render: state.codexLoginOrigin !== 'room' });
    if (requestId !== state.codexLoginRequestId) return;
    if (codexReadiness().ready) {
      state.codexLoginAction = '';
      await completeCodexLogin({ ...login, state: 'succeeded', authenticated: true }, requestId);
      return;
    }
    state.codexLoginAction = '';
    if (!CODEX_LOGIN_ACTIVE_STATES.has(login.state)) clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: CODEX_LOGIN_ACTIVE_STATES.has(login.state) ? 'cancel-codex-login' : 'start-codex-login' });
    if (CODEX_LOGIN_ACTIVE_STATES.has(login.state)) scheduleCodexLoginPoll();
    else toast('Codex 仍未登录', '可以重新发起官方浏览器登录。', 'warn');
  } catch (error) {
    if (requestId !== state.codexLoginRequestId) return;
    state.codexLoginAction = '';
    state.codexLogin = { ...currentCodexLogin(), state: 'failed', message: safeCodexLoginMessage(error.message) || '重新检测失败' };
    clearCodexLoginNavigation();
    updateCodexLoginModal({ force: true, focusAction: 'start-codex-login' });
  }
}

function dismissCodexLogin() {
  const origin = state.codexLoginOrigin;
  stopCodexLoginPolling({ invalidate: true });
  state.codexLoginPanelOpen = false;
  state.codexLoginAction = '';
  if (!state.codexLoginPopupNavigated) clearCodexLoginNavigation({ clearUrl: false });
  closeModal();
  if (origin === 'room' && state.project && state.view === 'codex') renderCodexStudio({ focus: 'composer' });
}

async function recoverCodexLogin() {
  if (!codexReadiness().authRequired || state.codexLoginPanelOpen || state.codexLoginAction) return;
  const requestId = ++state.codexLoginRequestId;
  state.codexLoginAction = 'recover';
  try {
    const payload = await api('/api/codex/auth/login');
    if (requestId !== state.codexLoginRequestId) return;
    const login = normalizeCodexLogin(payload);
    state.codexLogin = login;
    navigateCodexLoginPopup(login);
    if (CODEX_LOGIN_ACTIVE_STATES.has(login.state) || login.state === 'succeeded') {
      state.codexLoginOrigin = 'room';
      state.codexLoginAction = '';
      showCodexLoginModal();
      if (login.state === 'succeeded') await completeCodexLogin(login, requestId);
      else scheduleCodexLoginPoll();
    }
  } catch {
    // 协作室仍可显示任务包；登录状态由用户点击“登录 Codex”时再次检测。
  } finally {
    if (requestId === state.codexLoginRequestId && state.codexLoginAction === 'recover') state.codexLoginAction = '';
  }
}

function codexStatusLabel(status) {
  return ({ pending: '等待运行', processing: '处理中', running: '处理中', completed: '已完成', ready: '可继续对话', failed: '处理失败' })[status] || '可继续对话';
}

const CODEX_PROGRESS_TYPES = new Set(['queued', 'starting', 'thread', 'turn', 'stage', 'completed', 'failed']);
const CODEX_PROGRESS_PRESENTATION = {
  queued: { label: '任务已排队', short: '排队中', tone: 'active' },
  starting: { label: '正在准备章节与本轮要求', short: '准备中', tone: 'active' },
  thread: { label: '正在创建协作 Session', short: '创建会话', tone: 'active' },
  turn: { label: '正在继续当前协作 Session', short: '继续会话', tone: 'active' },
  stage: { label: '正在生成并校验结构化剧本', short: '处理中', tone: 'active' },
  completed: { label: '本轮处理完成', short: '已完成', tone: 'success' },
  failed: { label: '本轮处理未完成', short: '失败', tone: 'error' }
};
const CODEX_PROGRESS_PHASE_MESSAGES = {
  'queued:waiting': '请求已进入本章处理队列。',
  'starting:preparing': '正在准备剧本协作环境。',
  'thread:started': '协作 Session 已建立。',
  'turn:started': '协作后端已开始处理本轮请求。',
  'turn:completed': '协作后端已完成本轮生成，正在校验结果。',
  'stage:analyzing': '正在分析章节结构与角色关系。',
  'stage:drafting': '正在整理台词、角色与表演标注。',
  'stage:processing': '正在处理剧本协作任务。',
  'stage:validating': '正在校验剧本结构。',
  'stage:saving': '正在安全保存本轮剧本。',
  'completed:completed': '本轮剧本协作已完成。',
  'failed:interrupted': '运行记录已中断，本机服务可能已重启；请重新检测或重试此 Session。',
  'failed:failed': '本轮剧本协作未完成，请检查所选后端状态后重试。'
};
const CODEX_ACTIVITY_CATEGORIES = new Set(['reasoning_summary', 'command', 'file', 'mcp', 'web', 'collaboration', 'plan', 'tool']);
const CODEX_ACTIVITY_PRESENTATION = {
  reasoning_summary: { label: '模型推理摘要', tone: 'summary' },
  command: { label: '受控命令', tone: 'activity' },
  file: { label: '文件活动', tone: 'activity' },
  mcp: { label: '扩展工具', tone: 'activity' },
  web: { label: '联网检索', tone: 'activity' },
  collaboration: { label: '协作活动', tone: 'activity' },
  plan: { label: '任务计划', tone: 'activity' },
  tool: { label: '工具活动', tone: 'activity' }
};
const CODEX_ACTIVITY_FIXED_TEXT = {
  command: '正在执行受控命令。',
  file: '正在处理工作区文件。',
  mcp: '正在调用已配置的扩展工具。',
  web: '正在执行联网检索。',
  collaboration: '正在进行协作任务。',
  plan: '正在更新任务计划。',
  tool: '正在使用受控工具。'
};
const CODEX_ACTIVITY_MAX_ITEMS = 24;
const CODEX_ACTIVITY_MAX_TEXT_BYTES = 8 * 1024;
const CODEX_TIMEOUT_FAILURE_CODES = new Set([
  'CODEX_TIMEOUT_STARTING',
  'CODEX_TIMEOUT_ACTIVE',
  'CODEX_TIMEOUT'
]);

function codexProgressKey(
  projectId = state.project?.id,
  chapterId = currentChapter()?.id,
  sessionId = state.codexSessionId
) {
  return projectId && chapterId && sessionId ? `${projectId}:${chapterId}:${sessionId}` : '';
}

function currentCodexProgress() {
  return state.codexProgressBySession.get(codexProgressKey()) || null;
}

function codexProgressIsActive(progress = currentCodexProgress()) {
  return Boolean(progress && !progress.terminal && !['completed', 'failed'].includes(progress.type));
}

function codexRoomBusy() {
  return state.codexBusy || codexProgressIsActive() || sessionHasActiveRun(currentCodexVersion());
}

function sessionHasActiveRun(session) {
  if (!session) return false;
  if (session.status === 'pending' || session.status === 'running') return true;
  return Boolean(session.activeRun?.progressId && !['completed', 'failed'].includes(session.activeRun.state));
}

function chapterHasActiveCollaboration(chapterId) {
  const chapter = state.project?.chapters?.find((item) => item.id === chapterId);
  if ((chapter?.codexSessions || []).some(sessionHasActiveRun)) return true;
  const prefix = `${state.project?.id || ''}:${chapterId}:`;
  return [...state.codexProgressBySession.entries()].some(([key, progress]) => key.startsWith(prefix) && codexProgressIsActive(progress));
}

function currentCodexError() {
  const key = codexProgressKey(state.project?.id, currentChapter()?.id, state.codexVersionId || state.codexSessionId);
  return key ? state.codexErrorsBySession.get(key) || '' : state.codexError || '';
}

function setCurrentCodexError(message = '', projectId = state.project?.id, chapterId = currentChapter()?.id, sessionId = state.codexVersionId || state.codexSessionId) {
  const key = codexProgressKey(projectId, chapterId, sessionId);
  if (key) {
    if (message) state.codexErrorsBySession.set(key, message);
    else state.codexErrorsBySession.delete(key);
  }
  const selectedKey = codexProgressKey(state.project?.id, currentChapter()?.id, state.codexVersionId || state.codexSessionId);
  if (!key || key === selectedKey) state.codexError = message;
}

function safeCodexProgressId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^codexprog_[0-9a-f]{32}$/.test(id) ? id : '';
}

function safeCodexProgressPhase(value = '') {
  const phase = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{0,40}$/.test(phase) ? phase : '';
}

function fixedCodexProgressMessage(type, phase) {
  return CODEX_PROGRESS_PHASE_MESSAGES[`${type}:${phase}`]
    || CODEX_PROGRESS_PRESENTATION[type]?.label
    || CODEX_PROGRESS_PRESENTATION.stage.label;
}

function safeCodexTimeoutFailureCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return CODEX_TIMEOUT_FAILURE_CODES.has(code) ? code : '';
}

function codexProgressFailureMessage(progress) {
  const minutes = normalizeCodexTimeoutMinutes(progress?.timeoutMinutes);
  const provider = scriptSourceLabel(normalizeCollaborationProvider(progress?.provider));
  if (progress?.failureCode === 'CODEX_TIMEOUT_STARTING') {
    return `${provider}未能在 ${minutes} 分钟内开始响应，请检查本机状态后重试。`;
  }
  if (progress?.failureCode === 'CODEX_TIMEOUT_ACTIVE') {
    return `${provider}已开始生成，但未在 ${minutes} 分钟内完成；可缩短章节、调整模型或提高超时后重试。`;
  }
  if (progress?.failureCode === 'CODEX_TIMEOUT') {
    return `${provider}未能在 ${minutes} 分钟内完成处理，请稍后重试。`;
  }
  return fixedCodexProgressMessage('failed', 'failed');
}

function normalizeCodexProgressEventsUrl(value, { projectId, chapterId, sessionId, progressId }) {
  if (typeof value !== 'string' || value.length > 2_000) return '';
  try {
    const url = new URL(value, location.origin);
    const expectedPath = `/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/codex-progress/${encodeURIComponent(progressId)}`;
    if (url.origin !== location.origin || url.pathname !== expectedPath || url.search || url.username || url.password || url.hash) return '';
    return url.pathname;
  } catch {
    return '';
  }
}

function normalizeCodexProgressEvent(value, expectedProgressId = '') {
  if (!value || typeof value !== 'object') return null;
  const progressId = safeCodexProgressId(value.progressId);
  const phase = safeCodexProgressPhase(value.phase);
  const progressState = typeof value.state === 'string' ? value.state : '';
  let type = CODEX_PROGRESS_TYPES.has(value.type) ? value.type : '';
  if (!type && ['queued', 'completed', 'failed'].includes(progressState)) type = progressState;
  if (!type && progressState === 'running') {
    type = phase === 'preparing' ? 'starting' : phase === 'thread' ? 'thread' : phase === 'turn' ? 'turn' : 'stage';
  }
  if (!progressId || (expectedProgressId && progressId !== expectedProgressId) || !type) return null;
  const elapsedMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(value.elapsedMs) || 0));
  const atValue = typeof value.at === 'string' ? value.at : '';
  const at = Number.isFinite(Date.parse(atValue)) ? atValue : new Date().toISOString();
  const failureCode = type === 'failed' ? safeCodexTimeoutFailureCode(value.code) : '';
  return {
    progressId,
    type,
    phase,
    message: fixedCodexProgressMessage(type, phase),
    elapsedMs,
    at,
    terminal: value.terminal === true || type === 'completed' || type === 'failed',
    failureCode
  };
}

function normalizeCodexDetailLevel(value, fallback = 'basic') {
  return value === 'summary' || value === 'basic' ? value : fallback;
}

function truncateCodexActivityText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || /[\u0000-\u001f\u007f-\u009f\u034f\u061c\u180e\u202a-\u202e\u2066-\u2069]/u.test(text)) return '';
  const limited = text.slice(0, 1_024);
  if (typeof Intl?.Segmenter !== 'function') return [...limited].slice(0, 320).join('');
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(limited);
  let output = '';
  let count = 0;
  for (const { segment } of segments) {
    if (count >= 320) break;
    output += segment;
    count += 1;
  }
  return output;
}

function codexActivityTextBytes(value) {
  try { return new TextEncoder().encode(value).byteLength; } catch { return String(value).length * 2; }
}

function normalizeCodexActivityEvent(value, expectedProgressId = '') {
  if (!value || typeof value !== 'object' || value.type !== 'activity' || value.terminal !== false) return null;
  const progressId = safeCodexProgressId(value.progressId);
  const category = CODEX_ACTIVITY_CATEGORIES.has(value.category) ? value.category : '';
  const phase = value.phase === 'reasoning_summary' || value.phase === 'activity' ? value.phase : '';
  const expectedPhase = category === 'reasoning_summary' ? 'reasoning_summary' : 'activity';
  const text = category === 'reasoning_summary'
    ? truncateCodexActivityText(value.text)
    : CODEX_ACTIVITY_FIXED_TEXT[category] || '';
  const atValue = typeof value.at === 'string' ? value.at : '';
  if (!progressId || progressId !== expectedProgressId || !category || phase !== expectedPhase || !text
    || atValue.length > 40 || !Number.isFinite(Date.parse(atValue))) return null;
  return { progressId, category, text, at: atValue };
}

function appendCodexActivityEvent(progress, activity, eventId = '') {
  if (!progress || !activity || progress.progressId !== activity.progressId || progress.detailLevel !== 'summary') return false;
  if (!progress.activityEventIds) progress.activityEventIds = new Set();
  const normalizedEventId = typeof eventId === 'string' ? eventId.slice(0, 160) : '';
  if (normalizedEventId && progress.activityEventIds.has(normalizedEventId)) return false;
  if (normalizedEventId) {
    progress.activityEventIds.add(normalizedEventId);
    while (progress.activityEventIds.size > 256) progress.activityEventIds.delete(progress.activityEventIds.values().next().value);
  }
  const signature = `${activity.category}:${activity.text}:${activity.at}`;
  if (progress.lastActivitySignature === signature) return false;
  progress.lastActivitySignature = signature;
  progress.activities = [...(progress.activities || []), activity];
  while (progress.activities.length > CODEX_ACTIVITY_MAX_ITEMS
    || progress.activities.reduce((total, item) => total + codexActivityTextBytes(item.text), 0) > CODEX_ACTIVITY_MAX_TEXT_BYTES) {
    progress.activities.shift();
  }
  return true;
}

function appendCodexProgressEvent(progress, event, eventId = '') {
  if (!progress || !event || progress.progressId !== event.progressId) return false;
  if (!progress.eventIds) progress.eventIds = new Set();
  const normalizedEventId = typeof eventId === 'string' ? eventId.slice(0, 160) : '';
  if (normalizedEventId && progress.eventIds.has(normalizedEventId)) return false;
  if (normalizedEventId) progress.eventIds.add(normalizedEventId);
  const signature = `${event.type}:${event.phase}:${event.failureCode}:${event.message}:${event.at}`;
  if (progress.lastEventSignature === signature) return false;
  progress.lastEventSignature = signature;
  progress.type = event.type;
  progress.phase = event.phase;
  progress.message = event.message;
  progress.elapsedMs = event.elapsedMs;
  progress.lastEventReceivedAt = Date.now();
  progress.at = event.at;
  progress.terminal = event.terminal;
  progress.failureCode = event.failureCode;
  progress.timeline = [...(progress.timeline || []), event].slice(-12);
  return true;
}

function createCodexProgressSnapshot(raw, context, existing = null) {
  const progressId = safeCodexProgressId(raw?.progressId);
  const rawSessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim().slice(0, 160) : '';
  const contextSessionId = typeof context?.sessionId === 'string' ? context.sessionId.trim().slice(0, 160) : '';
  if (rawSessionId && contextSessionId && rawSessionId !== contextSessionId) return null;
  const sessionId = typeof (rawSessionId || contextSessionId) === 'string'
    ? String(rawSessionId || contextSessionId).trim().slice(0, 160)
    : '';
  if (!progressId || !sessionId) return null;
  const provider = normalizeCollaborationProvider(
    raw?.provider,
    normalizeCollaborationProvider(context?.provider, normalizeCollaborationProvider(existing?.provider))
  );
  const detailLevel = normalizeCodexDetailLevel(
    raw?.detailLevel,
    normalizeCodexDetailLevel(context?.detailLevel, normalizeCodexDetailLevel(existing?.detailLevel))
  );
  const model = normalizeCodexModel(
    raw?.model,
    normalizeCodexModel(context?.model, normalizeCodexModel(existing?.model, collaborationModelDefault(provider)))
  );
  const reasoningEffort = provider === 'ollama' ? null : normalizeCodexReasoningEffort(
    raw?.reasoningEffort,
    normalizeCodexReasoningEffort(context?.reasoningEffort, normalizeCodexReasoningEffort(existing?.reasoningEffort))
  );
  const timeoutMinutes = normalizeCodexTimeoutMinutes(
    raw?.timeoutMinutes,
    normalizeCodexTimeoutMinutes(context?.timeoutMinutes, normalizeCodexTimeoutMinutes(existing?.timeoutMinutes))
  );
  const base = existing?.progressId === progressId ? existing : {
    progressId,
    projectId: context.projectId,
    chapterId: context.chapterId,
    sessionId,
    promptDraftKey: context.promptDraftKey || `${context.chapterId}:${sessionId}`,
    type: 'queued',
    phase: '',
    message: '',
    elapsedMs: 0,
    lastEventReceivedAt: Date.now(),
    at: new Date().toISOString(),
    terminal: false,
    expanded: true,
    detailLevel,
    provider,
    model,
    reasoningEffort,
    timeoutMinutes,
    activities: [],
    activityEventIds: new Set(),
    activityExpanded: true,
    activityUnread: 0,
    connection: 'connecting',
    timeline: [],
    eventIds: new Set(),
    failureCode: '',
    finalized: false,
    finalizing: false
  };
  base.detailLevel = detailLevel;
  base.sessionId = sessionId;
  base.provider = provider;
  base.model = model;
  base.reasoningEffort = reasoningEffort;
  base.timeoutMinutes = timeoutMinutes;
  const eventsUrl = normalizeCodexProgressEventsUrl(raw?.eventsUrl || base.eventsUrl, {
    projectId: context.projectId, chapterId: context.chapterId, sessionId, progressId
  });
  if (!eventsUrl) return null;
  base.eventsUrl = eventsUrl;
  const timeline = Array.isArray(raw?.events) ? raw.events : [];
  for (const item of timeline) {
    if (typeof item?.sessionId !== 'string' || item.sessionId !== sessionId) continue;
    const activity = normalizeCodexActivityEvent(item, progressId);
    if (activity) {
      appendCodexActivityEvent(base, activity, item.id);
      continue;
    }
    const event = normalizeCodexProgressEvent(item, progressId);
    if (event) appendCodexProgressEvent(base, event, item.id);
  }
  const hasCurrentEvent = ['type', 'phase', 'elapsedMs', 'at', 'terminal']
    .some((key) => Object.hasOwn(raw || {}, key));
  if (hasCurrentEvent) {
    const current = normalizeCodexProgressEvent({ ...raw, progressId }, progressId);
    if (current) {
      base.type = current.type;
      base.phase = current.phase;
      base.message = current.message;
      base.elapsedMs = current.elapsedMs;
      base.lastEventReceivedAt = Date.now();
      base.at = current.at;
      base.terminal = current.terminal;
      base.failureCode = current.failureCode;
    }
  } else if (['queued', 'completed', 'failed'].includes(raw?.state)) {
    base.type = raw.state;
    base.terminal = raw.state === 'completed' || raw.state === 'failed';
  }
  return base;
}

function codexProgressElapsedMs(progress) {
  if (!progress) return 0;
  const extra = codexProgressIsActive(progress) ? Math.max(0, Date.now() - Number(progress.lastEventReceivedAt || Date.now())) : 0;
  return Math.max(0, Number(progress.elapsedMs || 0) + extra);
}

function formatCodexProgressElapsed(progress) {
  const seconds = Math.floor(codexProgressElapsedMs(progress) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function codexProgressConnectionLabel(progress) {
  if (!progress || progress.terminal) return progress?.type === 'failed' ? '任务已结束' : '结果已同步';
  return ({ open: '实时连接正常', connecting: '正在连接进度', reconnecting: '连接中断，正在自动重连', paused: '已切换 Session，任务仍在后台' })[progress.connection] || '正在连接进度';
}

function formatCodexActivityTime(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function codexActivityAtBottom(element) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 18;
}

function announceCodexActivity(progress, category) {
  if (!state.codexActivityVisible || !progress) return;
  const now = Date.now();
  if (now - Number(progress.lastActivityAnnouncementAt || 0) < 1_800) return;
  progress.lastActivityAnnouncementAt = now;
  announceCodexProgress(category === 'reasoning_summary' ? '新增一条模型推理摘要。' : '新增一条运行记录。');
}

function codexInlineRunItemsHtml(progress) {
  const stageItems = (progress?.timeline || []).map((event, index) => ({
    kind: 'stage',
    at: event.at,
    order: index,
    tone: (CODEX_PROGRESS_PRESENTATION[event.type] || CODEX_PROGRESS_PRESENTATION.stage).tone,
    label: (CODEX_PROGRESS_PRESENTATION[event.type] || CODEX_PROGRESS_PRESENTATION.stage).short,
    text: event.message || fixedCodexProgressMessage(event.type, event.phase)
  }));
  const activityItems = state.codexActivityVisible ? (progress?.activities || []).map((activity, index) => ({
    kind: activity.category === 'reasoning_summary' ? 'summary' : 'activity',
    at: activity.at,
    order: 100 + index,
    tone: activity.category === 'reasoning_summary' ? 'summary' : 'activity',
    label: CODEX_ACTIVITY_PRESENTATION[activity.category]?.label || '运行记录',
    text: activity.text
  })) : [];
  const items = [...stageItems, ...activityItems].sort((left, right) => {
    const time = Date.parse(left.at || '') - Date.parse(right.at || '');
    return Number.isFinite(time) && time !== 0 ? time : left.order - right.order;
  });
  return items.map((item) => `<li class="codex-run-timeline-item ${item.tone}">
    <i aria-hidden="true"></i><div><div><strong>${escapeHtml(item.label)}</strong><time datetime="${escapeHtml(item.at || '')}">${escapeHtml(formatCodexActivityTime(item.at))}</time></div><p>${escapeHtml(item.text)}</p></div>
  </li>`).join('');
}

function codexInlineRunTurnHtml(progress) {
  if (!progress) return '';
  const presentation = CODEX_PROGRESS_PRESENTATION[progress.type] || CODEX_PROGRESS_PRESENTATION.stage;
  const activities = progress.activities || [];
  const bodyId = `codex-run-turn-body-${progress.progressId}`;
  const expanded = progress.expanded !== false;
  const unread = Math.max(0, Number(progress.activityUnread) || 0);
  return `<article class="codex-message assistant codex-run-turn ${presentation.tone}" data-progress-id="${escapeHtml(progress.progressId)}" aria-labelledby="codex-progress-title">
    <div class="codex-message-meta"><strong>协作运行</strong><time data-codex-progress-elapsed datetime="PT${Math.floor(codexProgressElapsedMs(progress) / 1000)}S" aria-label="已用时 ${escapeHtml(formatCodexProgressElapsed(progress))}">${escapeHtml(formatCodexProgressElapsed(progress))}</time></div>
    <div class="codex-run-bubble"><header><div><i aria-hidden="true"></i><div><strong id="codex-progress-title">${escapeHtml(presentation.label)}</strong><small>${escapeHtml(codexProgressConnectionLabel(progress))} · ${escapeHtml(codexProgressRuntimeLabel(progress))}</small></div></div><div>${unread ? `<button class="codex-run-unread" type="button" data-action="scroll-codex-activity">${unread} 条新记录</button>` : ''}<button class="icon-button" type="button" data-action="toggle-codex-progress" aria-expanded="${expanded}" aria-controls="${bodyId}" aria-label="${expanded ? '折叠运行详情' : '展开运行详情'}">${expanded ? '⌃' : '⌄'}</button></div></header>
      <div class="codex-run-turn-body" id="${bodyId}" ${expanded ? '' : 'hidden'}><ol class="codex-run-timeline">${codexInlineRunItemsHtml(progress) || '<li class="codex-run-waiting">等待第一条安全进度…</li>'}</ol>
      <div class="codex-run-actions">${activities.length && state.codexActivityVisible ? '<button class="button ghost small" type="button" data-action="clear-codex-activity">清空本地活动</button>' : ''}</div>
      ${state.codexActivityVisible ? '<p class="codex-run-disclosure"><strong>推理摘要不是隐藏思维链</strong> · 仅展示后端筛选后的安全摘要与固定工具活动，不展示提示词、路径、命令或凭据。</p>' : '<p class="codex-run-disclosure">当前仅显示基础阶段；打开上方摘要开关后，新任务可显示安全活动记录。</p>'}</div>
    </div>
  </article>`;
}

function announceCodexProgress(text) {
  const announcer = $('#codex-progress-announcer');
  if (announcer) announcer.textContent = text;
}

function updateCodexProgressPanel({ announce = '', activityAutoScroll = false } = {}) {
  const room = $('.codex-room-surface');
  if (!room) return;
  const toggle = $('#codex-progress-visible', room);
  if (toggle) toggle.checked = state.codexProgressVisible;
  const activityToggle = $('#codex-activity-visible', room);
  if (activityToggle) activityToggle.checked = state.codexActivityVisible;
  const slot = $('#codex-progress-slot', room);
  if (!slot) return;
  const progress = currentCodexProgress();
  if (!state.codexProgressVisible || !progress) {
    slot.innerHTML = '';
    const announcer = $('#codex-progress-announcer', room);
    if (announcer) announcer.textContent = '';
    return;
  }
  const conversation = $('#codex-conversation', room);
  const wasAtBottom = conversation
    ? conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 24
    : false;
  slot.innerHTML = codexInlineRunTurnHtml(progress);
  if ((activityAutoScroll || wasAtBottom) && conversation) {
    requestAnimationFrame(() => { if (conversation.isConnected) conversation.scrollTop = conversation.scrollHeight; });
  }
  if (announce) announceCodexProgress(announce);
}

function stopCodexProgressElapsedTimer() {
  if (state.codexProgressElapsedTimer) clearInterval(state.codexProgressElapsedTimer);
  state.codexProgressElapsedTimer = null;
}

function startCodexProgressElapsedTimer() {
  stopCodexProgressElapsedTimer();
  if (!$('.codex-room-surface') || !codexProgressIsActive()) return;
  state.codexProgressElapsedTimer = setInterval(() => {
    const elapsed = $('.codex-room-surface [data-codex-progress-elapsed]');
    const progress = currentCodexProgress();
    if (!elapsed || !progress || !codexProgressIsActive(progress)) return;
    elapsed.textContent = formatCodexProgressElapsed(progress);
    elapsed.dateTime = `PT${Math.floor(codexProgressElapsedMs(progress) / 1000)}S`;
    elapsed.setAttribute('aria-label', `已用时 ${formatCodexProgressElapsed(progress)}`);
  }, 1_000);
}

function closeCodexProgressConnection(key = codexProgressKey(), { paused = false } = {}) {
  const entry = state.codexProgressSources.get(key);
  if (entry) {
    try { entry.source.close(); } catch {}
    state.codexProgressSources.delete(key);
  }
  state.codexProgressGeneration += 1;
  const progress = state.codexProgressBySession.get(key);
  if (paused && codexProgressIsActive(progress)) progress.connection = 'paused';
  if (key === codexProgressKey()) {
    stopCodexProgressElapsedTimer();
    updateCodexProgressPanel();
  }
}

function closeAllCodexProgressConnections({ paused = false } = {}) {
  for (const key of [...state.codexProgressSources.keys()]) {
    closeCodexProgressConnection(key, { paused });
  }
}

async function finalizeCodexProgress(progress, { recovered = false } = {}) {
  if (!progress || progress.finalizing || progress.finalized) return;
  const key = codexProgressKey(progress.projectId, progress.chapterId, progress.sessionId);
  if (state.codexProgressBySession.get(key)?.progressId !== progress.progressId) return;
  progress.finalizing = true;
  closeCodexProgressConnection(key);
  const targetsCurrentChapter = state.project?.id === progress.projectId && currentChapter()?.id === progress.chapterId;
  const targetsSelectedSession = targetsCurrentChapter && state.codexVersionId === progress.sessionId;
  const failureMessage = progress.type === 'failed' ? codexProgressFailureMessage(progress) : '';
  if (failureMessage) progress.message = failureMessage;
  if (failureMessage && targetsSelectedSession) setCurrentCodexError(failureMessage, progress.projectId, progress.chapterId, progress.sessionId);
  const localChapter = state.project?.id === progress.projectId
    ? state.project.chapters?.find((chapter) => chapter.id === progress.chapterId)
    : null;
  const localSession = localChapter?.codexSessions?.find((session) => session.id === progress.sessionId) || null;
  if (localSession) {
    localSession.status = progress.type === 'completed' ? 'ready' : 'failed';
    localSession.activeRun = null;
    if (progress.type === 'failed') {
      localSession.lastFailure = {
        code: progress.failureCode || '',
        message: failureMessage || fixedCodexProgressMessage('failed', 'failed'),
        at: new Date().toISOString()
      };
    }
  }
  // A terminal run invalidates any baseline cached before it completed. The
  // forced fetch below repopulates this key; if that fetch fails, selecting the
  // Session later will retry instead of showing a stale script.
  state.codexSessionScripts.delete(key);
  if ($('.codex-room-surface')) updateCodexSessionSidebar();
  try {
    if (progress.type === 'completed') {
      const refreshed = await refreshCodexProjectSnapshot(progress.projectId);
      if (state.codexProgressBySession.get(key)?.progressId !== progress.progressId) return;
      const projectSnapshot = refreshed || (state.project?.id === progress.projectId ? state.project : null);
      if (projectSnapshot) {
        const chapter = projectSnapshot.chapters?.find((item) => item.id === progress.chapterId);
        if (chapter && currentChapter()?.id === progress.chapterId && state.codexVersionId === progress.sessionId) {
          const sessions = codexSessions(chapter);
          const selectedVersion = sessions.find((item) => item.id === progress.sessionId) || null;
          const selectedSource = scriptVersionSource(selectedVersion, progress.provider);
          state.codexSessionId = COLLABORATION_PROVIDERS.has(selectedSource) ? selectedVersion?.id || progress.sessionId : null;
          if (state.codexSessionId) state.codexSessionByChapter.set(progress.chapterId, state.codexSessionId);
          state.codexProvider = normalizeCollaborationProvider(selectedVersion?.provider, progress.provider);
          state.codexModel = normalizeCodexModel(selectedVersion?.model, progress.model || collaborationModelDefault(state.codexProvider));
          state.codexReasoningEffort = normalizeCodexReasoningEffort(
            selectedVersion?.reasoningEffort,
            progress.reasoningEffort
          );
          state.codexTimeoutMinutes = normalizeCodexTimeoutMinutes(
            selectedVersion?.timeoutMinutes,
            progress.timeoutMinutes
          );
          state.codexDrafts.delete(progress.promptDraftKey);
          state.codexDrafts.set(`${progress.chapterId}:${state.codexSessionId || 'new'}`, '');
          setCurrentCodexError('', progress.projectId, progress.chapterId, progress.sessionId);
        }
      }
    } else if (progress.type === 'failed') {
      const refreshed = await refreshCodexProjectSnapshot(progress.projectId);
      if (state.codexProgressBySession.get(key)?.progressId !== progress.progressId) return;
      if (refreshed || state.project?.id === progress.projectId) {
        if (currentChapter()?.id === progress.chapterId && state.codexVersionId === progress.sessionId) {
          const selectedVersion = codexSessions().find((item) => item.id === progress.sessionId) || null;
          state.codexSessionId = selectedVersion && COLLABORATION_PROVIDERS.has(scriptVersionSource(selectedVersion))
            ? selectedVersion.id
            : state.codexSessionId;
        }
      }
    }
  } catch (error) {
    if (progress.type === 'completed') {
      progress.message = '本轮处理已完成，但项目刷新暂时失败；请重新检测。';
    }
  } finally {
    if (state.project?.id === progress.projectId
      && state.codexProgressBySession.get(key)?.progressId === progress.progressId) {
      await loadCodexSessionScript(progress.sessionId, progress.chapterId, { force: true }).catch(() => null);
    }
    progress.finalizing = false;
    progress.finalized = true;
    progress.connection = 'closed';
  }
  const roomMatches = Boolean($('.codex-room-surface'))
    && state.project?.id === progress.projectId
    && currentChapter()?.id === progress.chapterId
    && state.codexVersionId === progress.sessionId;
  if (roomMatches) renderCodexStudio({ focus: progress.type === 'failed' ? 'composer' : '' });
  else if ($('.codex-room-surface')) updateCodexSessionSidebar();
  if (!recovered || progress.type === 'failed') {
    const providerLabel = scriptSourceLabel(normalizeCollaborationProvider(progress.provider));
    if (progress.type === 'completed') toast(`${providerLabel}已完成此 Session`, '结果已保存到独立版本；只有活动版本会同步到右侧 Live Script。');
    else toast(`${providerLabel}本轮没有完成`, failureMessage || fixedCodexProgressMessage('failed', 'failed'), 'error');
  }
}

function connectCodexProgress(progress) {
  if (!progress || !codexProgressIsActive(progress) || !progress.eventsUrl) return;
  const key = codexProgressKey(progress.projectId, progress.chapterId, progress.sessionId);
  if (!key || !$('.codex-room-surface')) return;
  const targetsCurrentSession = () => key === codexProgressKey() && Boolean($('.codex-room-surface'));
  const currentEntry = state.codexProgressSources.get(key);
  if (currentEntry?.progressId === progress.progressId) return;
  if (currentEntry) closeCodexProgressConnection(key);
  if (typeof EventSource !== 'function') {
    progress.connection = 'reconnecting';
    if (targetsCurrentSession()) updateCodexProgressPanel({ announce: '无法建立实时进度连接，任务仍在后台运行。' });
    return;
  }
  const generation = ++state.codexProgressGeneration;
  progress.connection = 'connecting';
  if (targetsCurrentSession()) updateCodexProgressPanel();
  let source;
  try {
    source = new EventSource(progress.eventsUrl);
  } catch {
    progress.connection = 'reconnecting';
    if (targetsCurrentSession()) updateCodexProgressPanel({ announce: '进度连接中断，任务仍在后台运行。' });
    return;
  }
  const entry = { source, progressId: progress.progressId, generation, connectedAt: Date.now() };
  state.codexProgressSources.set(key, entry);
  if (state.codexProgressSources.size > 4) {
    const oldestBackground = [...state.codexProgressSources.entries()]
      .filter(([entryKey]) => entryKey !== key && entryKey !== codexProgressKey())
      .sort((left, right) => Number(left[1].connectedAt || 0) - Number(right[1].connectedAt || 0))[0];
    if (oldestBackground) closeCodexProgressConnection(oldestBackground[0], { paused: true });
  }
  const isCurrent = () => {
    const activeEntry = state.codexProgressSources.get(key);
    const activeProgress = state.codexProgressBySession.get(key);
    return activeEntry === entry
      && activeEntry.generation === generation
      && activeProgress?.progressId === progress.progressId;
  };
  const handleEvent = (streamEvent) => {
    if (!isCurrent()) return;
    let payload;
    try { payload = JSON.parse(streamEvent.data); } catch { return; }
    if (typeof payload?.sessionId !== 'string' || payload.sessionId !== progress.sessionId) return;
    const activity = normalizeCodexActivityEvent(payload, progress.progressId);
    if (activity) {
      if (!state.codexActivityVisible) return;
      const conversation = targetsCurrentSession() ? $('.codex-room-surface #codex-conversation') : null;
      const autoScroll = conversation
        ? conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 24
        : true;
      if (!appendCodexActivityEvent(progress, activity, streamEvent.lastEventId)) return;
      progress.activityUnread = autoScroll ? 0 : Math.min(99, Number(progress.activityUnread || 0) + 1);
      if (targetsCurrentSession()) {
        updateCodexProgressPanel({ activityAutoScroll: autoScroll });
        announceCodexActivity(progress, activity.category);
      }
      return;
    }
    const event = normalizeCodexProgressEvent(payload, progress.progressId);
    if (!event || !appendCodexProgressEvent(progress, event, streamEvent.lastEventId)) return;
    progress.connection = event.terminal ? 'closed' : 'open';
    const presentation = CODEX_PROGRESS_PRESENTATION[event.type] || CODEX_PROGRESS_PRESENTATION.stage;
    if (targetsCurrentSession()) {
      updateCodexProgressPanel({ announce: presentation.label });
      startCodexProgressElapsedTimer();
    }
    if (event.terminal) void finalizeCodexProgress(progress);
  };
  source.onmessage = handleEvent;
  for (const type of CODEX_PROGRESS_TYPES) source.addEventListener(type, handleEvent);
  source.addEventListener('activity', handleEvent);
  source.onopen = () => {
    if (!isCurrent()) return;
    const wasInterrupted = progress.connection === 'reconnecting';
    progress.connection = 'open';
    if (targetsCurrentSession()) {
      updateCodexProgressPanel({ announce: wasInterrupted ? '实时进度连接已恢复。' : '' });
      startCodexProgressElapsedTimer();
    }
  };
  source.onerror = () => {
    if (!isCurrent() || progress.terminal) return;
    const firstInterruption = progress.connection !== 'reconnecting';
    progress.connection = 'reconnecting';
    if (targetsCurrentSession()) updateCodexProgressPanel({ announce: firstInterruption ? '进度连接中断，正在自动重连；任务仍在后台运行。' : '' });
  };
  if (targetsCurrentSession()) startCodexProgressElapsedTimer();
}

async function recoverCodexSessionProgress(chapterId, sessionId, { selected = false } = {}) {
  const projectId = state.project?.id;
  const key = codexProgressKey(projectId, chapterId, sessionId);
  if (!key || !sessionId) return;
  const recoveryGeneration = (state.codexProgressRecoveryBySession.get(key) || 0) + 1;
  state.codexProgressRecoveryBySession.set(key, recoveryGeneration);
  const existing = state.codexProgressBySession.get(key) || null;
  const isLatest = () => state.codexProgressRecoveryBySession.get(key) === recoveryGeneration
    && state.project?.id === projectId;
  const authoritativeSession = () => state.project?.chapters
    ?.find((chapter) => chapter.id === chapterId)?.codexSessions
    ?.find((session) => session.id === sessionId) || null;
  const targetsCurrent = () => selected && codexProgressKey() === key && Boolean($('.codex-room-surface'));
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/codex-progress`);
    if (!isLatest()) return;
    const liveProgress = state.codexProgressBySession.get(key) || null;
    if (liveProgress && liveProgress !== existing && liveProgress.progressId !== existing?.progressId) return;
    const raw = payload?.progress;
    if (!raw) {
      let refreshedSessionSnapshot = null;
      try {
        refreshedSessionSnapshot = await loadCodexSessionScript(sessionId, chapterId, { force: true });
      } catch {
        if (!isLatest()) return;
        if (codexProgressIsActive(existing)) {
          closeCodexProgressConnection(key);
          existing.connection = 'paused';
        }
        setCurrentCodexError('暂时无法确认此 Session 的最新状态，请稍后重新检测。', projectId, chapterId, sessionId);
        if (targetsCurrent()) updateCodexProgressPanel();
        updateCodexSessionSidebar();
        return;
      }
      if (!isLatest() || !refreshedSessionSnapshot) return;
      const session = authoritativeSession();
      if (codexProgressIsActive(existing)) {
        closeCodexProgressConnection(key);
        const authoritativeTerminal = ['ready', 'failed'].includes(session?.status);
        existing.type = session?.status === 'ready' ? 'completed' : 'failed';
        existing.phase = authoritativeTerminal ? existing.type : 'interrupted';
        existing.message = fixedCodexProgressMessage(existing.type, existing.phase);
        existing.failureCode = session?.status === 'failed'
          ? safeCodexTimeoutFailureCode(session?.lastFailure?.code)
          : '';
        existing.terminal = true;
        existing.finalized = true;
        existing.finalizing = false;
        existing.connection = 'closed';
        existing.lastEventReceivedAt = Date.now();
        if (!authoritativeTerminal && session) {
          session.status = 'failed';
          session.activeRun = null;
          setCurrentCodexError(existing.message, projectId, chapterId, sessionId);
        }
      } else if (sessionHasActiveRun(session)) {
        session.status = 'failed';
        session.activeRun = null;
        setCurrentCodexError(fixedCodexProgressMessage('failed', 'interrupted'), projectId, chapterId, sessionId);
      }
      if (targetsCurrent()) renderCodexStudio();
      else updateCodexSessionSidebar();
      return;
    }
    const session = authoritativeSession();
    const progress = createCodexProgressSnapshot(raw, {
      projectId,
      chapterId,
      sessionId,
      detailLevel: existing?.detailLevel,
      provider: existing?.provider || session?.provider || state.codexProvider,
      model: existing?.model || session?.model,
      reasoningEffort: existing?.reasoningEffort ?? session?.reasoningEffort,
      timeoutMinutes: existing?.timeoutMinutes ?? session?.timeoutMinutes,
      promptDraftKey: existing?.promptDraftKey
    }, existing);
    if (!progress) return;
    state.codexProgressBySession.set(key, progress);
    if (targetsCurrent()) {
      state.codexProvider = progress.provider;
      state.codexModel = progress.model;
      state.codexReasoningEffort = progress.reasoningEffort;
      state.codexTimeoutMinutes = progress.timeoutMinutes;
      renderCodexStudio();
    } else updateCodexSessionSidebar();
    if (progress.terminal) await finalizeCodexProgress(progress, { recovered: true });
    else connectCodexProgress(progress);
  } catch {
    if (!isLatest()) return;
    const session = authoritativeSession();
    const authoritativeProgressId = safeCodexProgressId(session?.activeRun?.progressId);
    if (codexProgressIsActive(existing) && sessionHasActiveRun(session) && authoritativeProgressId === existing.progressId) {
      existing.connection = 'reconnecting';
      if (targetsCurrent()) updateCodexProgressPanel({ announce: '暂时无法恢复进度快照，正在重新连接；任务仍在后台运行。' });
      connectCodexProgress(existing);
    } else if (codexProgressIsActive(existing)) {
      closeCodexProgressConnection(key);
      state.codexProgressBySession.delete(key);
      if (targetsCurrent()) updateCodexProgressPanel();
      updateCodexSessionSidebar();
    }
  }
}

async function recoverCodexProgress() {
  const sessionId = state.codexSessionId;
  const chapterId = currentChapter()?.id;
  if (!sessionId || !chapterId) {
    updateCodexProgressPanel();
    return;
  }
  await recoverCodexSessionProgress(chapterId, sessionId, { selected: true });
}

async function recoverActiveCodexSessions() {
  const selectedSessionId = state.codexVersionId || state.codexSessionId;
  const selectedChapterId = currentChapter()?.id;
  const selectedKey = codexProgressKey(state.project?.id, selectedChapterId, selectedSessionId);
  const activeCandidates = [];
  let selectedCandidate = null;
  for (const chapter of state.project?.chapters || []) {
    for (const session of chapter.codexSessions || []) {
      const key = codexProgressKey(state.project?.id, chapter.id, session.id);
      const candidate = { chapterId: chapter.id, sessionId: session.id, selected: key === selectedKey };
      if (candidate.selected && COLLABORATION_PROVIDERS.has(scriptVersionSource(session))) selectedCandidate = candidate;
      const localProgress = state.codexProgressBySession.get(key);
      if (sessionHasActiveRun(session) || codexProgressIsActive(localProgress)) activeCandidates.push(candidate);
    }
  }
  activeCandidates.sort((left, right) => Number(right.selected) - Number(left.selected));
  const candidates = activeCandidates.slice(0, 4);
  if (selectedCandidate && !candidates.some((candidate) => candidate.sessionId === selectedCandidate.sessionId
    && candidate.chapterId === selectedCandidate.chapterId)) {
    // A selected, non-running Session may still have a replayable terminal
    // snapshot. It does not consume one of the four active connection slots.
    candidates.unshift(selectedCandidate);
  }
  await Promise.all(candidates.map((candidate) => recoverCodexSessionProgress(
    candidate.chapterId,
    candidate.sessionId,
    { selected: candidate.selected }
  )));
}

function codexDraftKey(sessionId = state.codexVersionId || state.codexSessionId) {
  return `${currentChapter()?.id || 'chapter'}:${sessionId || `new:${normalizeCollaborationProvider(state.codexProvider)}`}`;
}

function codexStarterPrompt(mode = state.codexMode) {
  const modeLabel = CODEX_MODE_LABELS[mode] || CODEX_MODE_LABELS.faithful;
  return `请按“${modeLabel}”档位分析当前章节，整理为可配音剧本。重点核对对白归属、角色一致性、情绪、语速与停顿；不确定的角色请标记待确认。`;
}

function codexDraft(sessionId = state.codexVersionId || state.codexSessionId) {
  const key = codexDraftKey(sessionId);
  if (state.codexDrafts.has(key)) return state.codexDrafts.get(key);
  return sessionId ? '' : codexStarterPrompt();
}

function rememberCodexComposer() {
  const composer = $('#codex-chat-prompt');
  if (composer) state.codexDrafts.set(codexDraftKey(), composer.value);
  const model = $('#codex-model');
  if (model) state.codexModel = model.value.trim();
  const reasoningEffort = $('#codex-reasoning-effort');
  if (reasoningEffort && !reasoningEffort.disabled) {
    state.codexReasoningEffort = normalizeCodexReasoningEffort(reasoningEffort.value);
  }
  const timeoutMinutes = $('#codex-timeout-minutes');
  const parsedTimeoutMinutes = timeoutMinutes && !timeoutMinutes.disabled
    ? parseCodexTimeoutMinutes(timeoutMinutes.value)
    : null;
  if (parsedTimeoutMinutes !== null) state.codexTimeoutMinutes = parsedTimeoutMinutes;
  const mode = $('#codex-room-mode');
  if (mode && !mode.disabled) state.codexMode = mode.value;
  const provider = $('#codex-provider');
  if (provider && !provider.disabled) state.codexProvider = normalizeCollaborationProvider(provider.value);
}

function codexSessionTitle(session, index) {
  const firstPrompt = session.messages?.find((message) => message.role === 'user')?.content || '';
  const title = String(session.title || firstPrompt).replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 34) : `${scriptSourceLabel(session)}版本 ${index + 1}`;
}

function codexSessionItemHtml(item, index) {
  const progress = state.codexProgressBySession.get(codexProgressKey(state.project?.id, item.chapterId, item.id));
  const running = sessionHasActiveRun(item) || (codexProgressIsActive(progress) && progress?.sessionId === item.id);
  const selected = item.id === state.codexVersionId && item.chapterId === currentChapter()?.id;
  const chapter = state.project?.chapters?.find((entry) => entry.id === item.chapterId);
  const active = chapter?.activeCodexSessionId === item.id;
  const version = `V${item.versionNumber || 1}`;
  const source = scriptVersionSource(item);
  const sourceLabel = scriptSourceLabel(source);
  return `<button class="codex-session-item ${selected ? 'active' : ''} ${running ? 'running' : ''}" data-action="select-codex-session" data-session-id="${escapeHtml(item.id)}" data-chapter-id="${escapeHtml(item.chapterId)}" ${selected ? 'aria-current="true"' : ''}>
    <span class="codex-session-primary"><span class="codex-session-version">${escapeHtml(version)}</span><span class="codex-session-source source-${source}">${escapeHtml(sourceLabel)}</span><strong>${escapeHtml(codexSessionTitle(item, index))}</strong></span>
    <small class="codex-session-runtime">${escapeHtml(COLLABORATION_PROVIDERS.has(source) ? codexSessionRuntimeLabel(item) : `${sourceLabel} · 可恢复剧本快照`)}</small>
    <span class="codex-session-meta"><em>${running ? '● 处理中' : active ? '活动版本' : `${Number(item.turnCount || Math.ceil((item.messages?.length || 0) / 2))} 轮`}</em><time>${escapeHtml(formatDate(item.updatedAt || item.messages?.at(-1)?.createdAt || item.createdAt))}</time></span>
  </button>`;
}

function codexChapterGroupHtml(chapter, chapterIndex) {
  const sessions = codexSessions(chapter).map((session, index, list) => ({
    ...session,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterIndex: chapter.index,
    versionNumber: Number.isInteger(session.versionOrdinal) && session.versionOrdinal > 0
      ? session.versionOrdinal
      : Math.max(1, list.length - index)
  }));
  const collapsed = state.codexCollapsedChapters.has(chapter.id);
  const selectedGroup = chapter.id === currentChapter()?.id;
  const runningCount = sessions.filter(sessionHasActiveRun).length;
  const bodyId = `codex-chapter-sessions-${chapter.id}`;
  return `<section class="codex-chapter-group ${selectedGroup ? 'selected' : ''}">
    <header><button type="button" class="codex-chapter-toggle" data-action="toggle-codex-chapter-group" data-chapter-id="${escapeHtml(chapter.id)}" aria-expanded="${!collapsed}" aria-controls="${escapeHtml(bodyId)}"><span>${collapsed ? '›' : '⌄'}</span><strong>${String(chapterIndex + 1).padStart(2, '0')} · ${escapeHtml(chapter.title || '未命名章节')}</strong><em>${sessions.length}${runningCount ? ` · ${runningCount} 运行` : ''}</em></button><button type="button" class="icon-button" data-action="new-codex-session-for-chapter" data-chapter-id="${escapeHtml(chapter.id)}" aria-label="在${escapeHtml(chapter.title || '本章')}新建 Session">＋</button></header>
    <div class="codex-chapter-session-list" id="${escapeHtml(bodyId)}" ${collapsed ? 'hidden' : ''}>${sessions.length ? sessions.map(codexSessionItemHtml).join('') : '<p>暂无版本；可点击右上角＋开始。</p>'}</div>
  </section>`;
}

function codexSessionSidebarData() {
  const allChapters = state.project?.chapters || [];
  const currentId = currentChapter()?.id;
  const groupedChapters = allChapters.filter((chapter) => state.codexShowAllChapters
    || chapter.id === currentId
    || (chapter.codexSessions || []).length);
  return {
    groupsHtml: groupedChapters.map((chapter) => codexChapterGroupHtml(chapter, allChapters.indexOf(chapter))).join(''),
    hiddenChapterCount: Math.max(0, allChapters.length - groupedChapters.length)
  };
}

function updateCodexSessionSidebar() {
  const list = $('.codex-room-surface .codex-session-list');
  if (!list) return;
  const sidebar = codexSessionSidebarData();
  list.innerHTML = sidebar.groupsHtml || '<div class="codex-empty-session"><span>✦</span><strong>还没有章节</strong></div>';
  const filter = $('.codex-room-surface [data-action="toggle-all-codex-chapters"]');
  if (filter) {
    filter.setAttribute('aria-pressed', String(state.codexShowAllChapters));
    filter.textContent = state.codexShowAllChapters
      ? '只看有版本章节'
      : `显示全部章节${sidebar.hiddenChapterCount ? `（另 ${sidebar.hiddenChapterCount}）` : ''}`;
  }
}

function updateTopbar() {
  const activeView = state.view === 'codex' ? 'studio' : state.view;
  $$('.main-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === activeView));
  const active = state.bootstrap?.jobs.filter((job) => ['queued', 'running'].includes(job.state)).length || 0;
  $('#job-count').textContent = active;
  const pulse = $('.pulse-dot');
  pulse?.classList.toggle('offline', !state.bootstrap?.system.worker.online);
  const label = $('.status-label');
  if (label) label.textContent = state.bootstrap?.system.worker.online ? '模型工作器在线' : '本地工作台';
}

function dashboardHtml() {
  const { projects, system, engines } = state.bootstrap;
  const recommended = engines.find((engine) => engine.id === system.recommendedEngineId) || engines[0];
  const gpuPercent = system.gpu.vramGb ? Math.round(((system.gpu.vramGb - system.gpu.freeVramGb) / system.gpu.vramGb) * 100) : 0;
  const readiness = [
    ['GPU 可用', system.readiness.gpu], ['模型工作器', system.readiness.worker],
    ['Codex 剧本', system.readiness.codex], ['FFmpeg 导出', system.readiness.ffmpeg]
  ];
  return `<section class="page dashboard-page">
    <div class="dashboard-hero">
      <article class="hero-card">
        <div class="hero-copy">
          <span class="eyebrow">LOCAL AUDIOBOOK WORKFLOW</span>
          <h1>把文字，变成<br><em>有灵魂的声音。</em></h1>
          <p>从小说拆章、角色识别到多音色演绎，在本机完成整本有声书制作。</p>
        </div>
        <div class="hero-actions">
          <button class="button primary" data-action="new-project">＋ 导入一本小说</button>
          <button class="button ghost" data-action="open-demo">打开示例作品</button>
          <span class="hero-note">支持 TXT · Markdown · EPUB</span>
        </div>
      </article>
      <aside class="machine-card">
        <div class="machine-head"><div><span class="eyebrow">THIS MACHINE</span><h3>本机制作能力</h3></div><span class="ready-pill">${system.gpu.available ? 'GPU 已识别' : 'CPU 模式'}</span></div>
        <div class="gpu-readout">
          <strong>${escapeHtml(system.gpu.name)}</strong>
          <div class="meter"><span style="width:${gpuPercent}%"></span></div>
          <div class="gpu-meta"><span>已用约 ${gpuPercent}%</span><span>${system.gpu.vramGb || 0} GB 显存</span></div>
        </div>
        <div class="recommend-row"><span class="recommend-icon">◈</span><div><strong>智能推荐 · ${escapeHtml(recommended.name)}</strong><small>${escapeHtml(recommended.badge)}，适合当前硬件</small></div></div>
        <div class="readiness">${readiness.map(([label, ready]) => `<div class="ready-item ${ready ? '' : 'warn'}"><i>${ready ? '✓' : '!'}</i>${label}</div>`).join('')}</div>
      </aside>
    </div>
    <div class="section-head"><h2>最近作品</h2><button data-nav="studio">继续上次制作 →</button></div>
    <div class="project-grid">
      ${projects.map(projectCardHtml).join('')}
      <article class="project-card empty-project" data-action="new-project" role="button" tabindex="0"><div><span class="plus">＋</span><strong>创建新作品</strong><div style="font-size:9px;margin-top:6px">导入小说，开始制作</div></div></article>
    </div>
  </section>`;
}

function projectCardHtml(project) {
  return `<article class="project-card" style="--cover:${coverColors[project.coverTone % coverColors.length]}" data-action="open-project" data-project-id="${project.id}" role="button" tabindex="0">
    <div class="project-top"><span class="project-state">${escapeHtml(statusLabels[project.status] || project.status)}${project.isDemo ? ' · 示例' : ''}</span></div>
    <h3>${escapeHtml(project.title)}</h3><div class="project-author">${escapeHtml(project.author || '未填写作者')} · ${formatDate(project.updatedAt)}</div>
    <div class="project-stats"><span>${project.chapterCount} 章</span><span>${formatNumber(project.charCount)} 字</span><span>约 ${project.durationMinutes} 分钟</span></div>
    <div class="project-progress"><div class="meter"><span style="width:${project.progress}%"></span></div><span>${project.progress}%</span></div>
  </article>`;
}

function voiceIsReady(voice) {
  return Boolean(voice?.status === 'ready' && voice.reference);
}

function activeScriptJobForChapter(chapterId = currentChapter()?.id) {
  const projectId = state.project?.id;
  return (state.bootstrap?.jobs || []).find((job) => job.type === 'script'
    && ['queued', 'running'].includes(job.state)
    && job.payload?.projectId === projectId
    && Array.isArray(job.payload?.chapterIds)
    && job.payload.chapterIds.includes(chapterId)) || null;
}

function characterOccurrenceCounts() {
  const projectCounts = new Map((state.project?.characters || []).map((role) => [role.id, 0]));
  const chapterCounts = new Map((state.project?.characters || []).map((role) => [role.id, 0]));
  for (const chapter of state.project?.chapters || []) {
    for (const line of chapter.scenes?.flatMap((scene) => scene.lines || []) || []) {
      const role = state.project.characters.find((item) => item.id === line.speakerId)
        || state.project.characters.find((item) => item.name === line.speaker);
      if (!role) continue;
      projectCounts.set(role.id, (projectCounts.get(role.id) || 0) + 1);
      if (chapter.id === currentChapter()?.id) chapterCounts.set(role.id, (chapterCounts.get(role.id) || 0) + 1);
    }
  }
  return { projectCounts, chapterCounts };
}

function voiceBindingDraftEntries() {
  const roles = new Map((state.project?.characters || []).map((role) => [role.id, role]));
  const voices = new Set((state.bootstrap?.voices || []).map((voice) => voice.id));
  const assignments = [];
  for (const [roleId, value] of state.voiceBindingDraft) {
    const role = roles.get(roleId);
    if (!role) continue;
    const voiceId = value || null;
    if (voiceId && !voices.has(voiceId)) continue;
    if ((role.voiceId || null) === voiceId) continue;
    assignments.push({ roleId, voiceId });
  }
  return assignments;
}

function effectiveRoleVoiceId(role) {
  return state.voiceBindingDraft.has(role.id) ? state.voiceBindingDraft.get(role.id) || null : role.voiceId || null;
}

function voiceBindingOptionsId(roleId) {
  return `voice-binding-options-${String(roleId || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function voiceBindingPreviewIsActive(roleId, voiceId) {
  const audio = $('#audio-player');
  return Boolean(audio && !audio.paused && state.voiceBindingPreview?.roleId === roleId && state.voiceBindingPreview?.voiceId === voiceId);
}

function syncVoiceBindingPreviewButtons() {
  const audio = $('#audio-player');
  $$('[data-action="preview-binding-voice"]').forEach((button) => {
    const voice = state.bootstrap?.voices?.find((item) => item.id === button.dataset.voiceId);
    const hasSample = Boolean(voice?.reference?.mediaUrl);
    if (!hasSample) {
      button.classList.remove('playing');
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', `音色 ${voice?.name || ''} 没有可试听样音`.trim());
      button.innerHTML = '<span aria-hidden="true">—</span><span>无样音</span>';
      return;
    }
    const active = Boolean(audio && !audio.paused && state.voiceBindingPreview?.roleId === button.dataset.roleId
      && state.voiceBindingPreview?.voiceId === button.dataset.voiceId);
    button.classList.toggle('playing', active);
    button.setAttribute('aria-pressed', String(active));
    button.innerHTML = `<span aria-hidden="true">${active ? 'Ⅱ' : '▶'}</span><span>${active ? '暂停' : '试听'}</span>`;
    if (voice) button.setAttribute('aria-label', `${active ? '暂停' : '试听'}音色：${voice.name}`);
  });
}

function restoreTransportAfterVoicePreview() {
  if (state.selectedLineId && findLine(state.selectedLineId)) {
    updateTransportForSelection();
    return;
  }
  const title = $('#transport-title');
  const subtitle = $('#transport-subtitle');
  if (title) title.textContent = '尚未选择片段';
  if (subtitle) subtitle.textContent = '选择一句台词开始试听';
}

function stopVoiceBindingPreview({ clear = true } = {}) {
  const audio = $('#audio-player');
  state.voiceBindingPreviewRequestId += 1;
  if (state.loadedAudio?.kind !== 'voice-binding') {
    state.voiceBindingPreview = null;
    syncVoiceBindingPreviewButtons();
    return;
  }
  audio.pause();
  state.voiceBindingPreview = null;
  if (clear) {
    state.loadedAudio = null;
    audio.removeAttribute('src');
    audio.load();
    restoreTransportAfterVoicePreview();
  }
  syncVoiceBindingPreviewButtons();
}

function closeVoiceBindingPicker({ focus = false } = {}) {
  const roleId = state.voiceBindingPickerRoleId;
  if (!roleId) return;
  state.voiceBindingPickerRoleId = '';
  const trigger = $(`[data-action="toggle-binding-voice-picker"][data-role-id="${CSS.escape(roleId)}"]`);
  const menu = $(`#${CSS.escape(voiceBindingOptionsId(roleId))}`);
  trigger?.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
  if (focus) trigger?.focus();
}

async function playVoiceBindingPreview(roleId, voiceId) {
  const voice = state.bootstrap?.voices?.find((item) => item.id === voiceId);
  const mediaUrl = voice?.reference?.mediaUrl;
  if (!voice || !mediaUrl) {
    toast('没有可试听样音', '这个音色尚未包含参考录音。', 'warn');
    return;
  }
  const audio = $('#audio-player');
  if (voiceBindingPreviewIsActive(roleId, voiceId)) {
    state.voiceBindingPreviewRequestId += 1;
    state.voiceBindingPreview = null;
    audio.pause();
    syncVoiceBindingPreviewButtons();
    return;
  }
  stopVoiceBindingPreview({ clear: true });
  const requestId = ++state.voiceBindingPreviewRequestId;
  audio.src = mediaUrl;
  state.loadedAudio = { kind: 'voice-binding', id: roleId, voiceId, url: mediaUrl };
  state.voiceBindingPreview = { roleId, voiceId, requestId };
  $('#transport').hidden = false;
  $('#transport-title').textContent = voice.name;
  $('#transport-subtitle').textContent = '角色绑定 · 音色参考原声';
  syncVoiceBindingPreviewButtons();
  try {
    await audio.play();
    if (requestId !== state.voiceBindingPreviewRequestId) return;
    syncVoiceBindingPreviewButtons();
  } catch (error) {
    if (requestId !== state.voiceBindingPreviewRequestId
      || state.voiceBindingPreview?.roleId !== roleId
      || state.voiceBindingPreview?.voiceId !== voiceId) return;
    stopVoiceBindingPreview({ clear: true });
    if (error?.name === 'AbortError') return;
    toast('无法试听音色', error.message || '浏览器未能播放这个参考音频。', 'error');
  }
}

function voiceBindingDrawerHtml() {
  if (!state.voiceBindingOpen) return '';
  const counts = characterOccurrenceCounts();
  const voices = state.bootstrap?.voices || [];
  const roles = (state.project?.characters || []).filter((role) => !state.voiceBindingChapterOnly || (counts.chapterCounts.get(role.id) || 0) > 0);
  const dirtyCount = voiceBindingDraftEntries().length;
  const readyCount = (state.project?.characters || []).filter((role) => voiceIsReady(voices.find((voice) => voice.id === effectiveRoleVoiceId(role)))).length;
  const rows = roles.map((role) => {
    const selectedVoiceId = effectiveRoleVoiceId(role);
    const selectedVoice = voices.find((voice) => voice.id === selectedVoiceId) || null;
    const chapterCount = counts.chapterCounts.get(role.id) || 0;
    const projectCount = counts.projectCounts.get(role.id) || 0;
    const ready = voiceIsReady(selectedVoice);
    const pickerOpen = state.voiceBindingPickerRoleId === role.id;
    const pickerId = voiceBindingOptionsId(role.id);
    const voiceOptions = voices.map((voice) => {
      const selected = voice.id === selectedVoiceId;
      const hasSample = Boolean(voice.reference?.mediaUrl);
      const active = voiceBindingPreviewIsActive(role.id, voice.id);
      return `<div class="voice-binding-option ${selected ? 'selected' : ''}">
        <button type="button" class="voice-binding-choice" data-action="choose-binding-voice" data-role-id="${escapeHtml(role.id)}" data-voice-id="${escapeHtml(voice.id)}" aria-pressed="${selected}"><span><strong>${escapeHtml(voice.name)}</strong><small>${voiceIsReady(voice) ? '可用于生成' : '音色未就绪'}</small></span>${selected ? '<i aria-hidden="true">✓</i>' : ''}</button>
        <button type="button" class="voice-binding-preview ${active ? 'playing' : ''}" data-action="preview-binding-voice" data-role-id="${escapeHtml(role.id)}" data-voice-id="${escapeHtml(voice.id)}" aria-label="${hasSample ? `${active ? '暂停' : '试听'}音色：${escapeHtml(voice.name)}` : `音色 ${escapeHtml(voice.name)} 没有可试听样音`}" aria-pressed="${active}" ${hasSample ? '' : 'disabled title="无参考音频"'}><span aria-hidden="true">${hasSample ? active ? 'Ⅱ' : '▶' : '—'}</span><span>${hasSample ? active ? '暂停' : '试听' : '无样音'}</span></button>
      </div>`;
    }).join('');
    return `<div class="voice-binding-row ${ready ? 'ready' : 'unbound'}">
      <span class="voice-binding-avatar" style="--speaker:${escapeHtml(role.color || '#78dfc9')}">${escapeHtml([...(role.name || '角')][0])}</span>
      <div class="voice-binding-role"><strong>${escapeHtml(role.name)}</strong><small>本章 ${chapterCount} 行 · 全书 ${projectCount} 行</small></div>
      <span class="voice-binding-state">${ready ? '就绪' : selectedVoiceId ? '音色未就绪' : '未绑定'}</span>
      <div class="voice-binding-picker">
        <button type="button" class="voice-binding-picker-button" data-action="toggle-binding-voice-picker" data-role-id="${escapeHtml(role.id)}" aria-label="为 ${escapeHtml(role.name)} 选择音色，当前${selectedVoice ? `为 ${escapeHtml(selectedVoice.name)}` : '未绑定'}" aria-expanded="${pickerOpen}" aria-controls="${escapeHtml(pickerId)}" ${state.voiceBindingSaving ? 'disabled' : ''}><span><small>角色音色</small><strong>${escapeHtml(selectedVoice?.name || '不绑定')}</strong></span><i aria-hidden="true">${pickerOpen ? '⌃' : '⌄'}</i></button>
        <div class="voice-binding-options" id="${escapeHtml(pickerId)}" role="group" aria-label="为 ${escapeHtml(role.name)} 选择并试听音色" ${pickerOpen ? '' : 'hidden'}>
          <div class="voice-binding-option ${selectedVoiceId ? '' : 'selected'}"><button type="button" class="voice-binding-choice" data-action="choose-binding-voice" data-role-id="${escapeHtml(role.id)}" data-voice-id="" aria-pressed="${!selectedVoiceId}"><span><strong>不绑定</strong><small>清除这个角色的音色</small></span>${selectedVoiceId ? '' : '<i aria-hidden="true">✓</i>'}</button><button type="button" class="voice-binding-preview" aria-label="不绑定选项没有试听音频" disabled><span aria-hidden="true">—</span><span>无样音</span></button></div>
          ${voiceOptions || '<p class="voice-binding-no-options">音色库为空，请先制作音色。</p>'}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div class="voice-binding-scrim" data-action="close-voice-binding" aria-hidden="true"></div><aside class="voice-binding-drawer" role="dialog" aria-modal="false" aria-labelledby="voice-binding-title">
    <header><div><span class="eyebrow">CAST VOICES</span><h2 id="voice-binding-title">角色音色绑定</h2><p>${readyCount}/${state.project?.characters?.length || 0} 个角色已可用于真人语音</p></div><button class="icon-button" data-action="close-voice-binding" aria-label="关闭角色音色绑定">×</button></header>
    <div class="voice-binding-tools"><label class="checkbox-row"><input type="checkbox" id="voice-binding-chapter-only" ${state.voiceBindingChapterOnly ? 'checked' : ''}><span>仅显示本章出现角色</span></label><button class="button ghost small" data-nav="voices">管理音色库</button></div>
    <div class="voice-binding-list">${rows || '<div class="voice-binding-empty">本章没有识别到已建档角色。</div>'}</div>
    <footer><div><strong>${dirtyCount ? `${dirtyCount} 项未保存` : '所有绑定已保存'}</strong><small>关闭侧栏会保留本地草稿；只有“保存全部绑定”才会写入项目。</small></div><div><button class="button ghost" data-action="discard-voice-bindings" ${!dirtyCount || state.voiceBindingSaving ? 'disabled' : ''}>取消更改</button><button class="button primary" data-action="save-voice-bindings" ${!dirtyCount || state.voiceBindingSaving ? 'disabled' : ''}>${state.voiceBindingSaving ? '保存中…' : '保存全部绑定'}</button></div></footer>
  </aside>`;
}

function studioHtml() {
  if (!state.project) {
    return `<section class="error-state"><h2>还没有打开作品</h2><p>请从项目页选择一本小说，或先创建新作品。</p><button class="button primary" data-nav="projects">返回项目</button></section>`;
  }
  const project = state.project;
  const chapter = currentChapter();
  const lines = chapter?.scenes?.flatMap((scene) => scene.lines || []) || [];
  const missingVoices = missingVoicesForLines(lines);
  const rendered = allProjectLines().filter((line) => line.render?.status === 'ready').length;
  const total = allProjectLines().length;
  const missingNames = missingVoices.slice(0, 4).map((item) => item.name).join('、');
  const missingMore = missingVoices.length > 4 ? `等 ${missingVoices.length} 个角色` : '';
  const collaborationActive = chapterHasActiveCollaboration(chapter?.id);
  const scriptJobActive = Boolean(activeScriptJobForChapter(chapter?.id));
  return `<section class="studio-page ${missingVoices.length ? 'has-voice-warning' : ''}">
    <header class="studio-header">
      <div class="studio-title"><button class="back-button" data-nav="projects" aria-label="返回">‹</button><div><h1>${escapeHtml(project.title)}</h1><small>${project.chapters.length} 章 · ${formatNumber(project.source?.charCount)} 字 · ${project.characters.length} 个角色</small></div></div>
      <div class="studio-actions">
        <button class="button ghost" data-action="run-rule-script" ${collaborationActive || scriptJobActive || state.ruleScriptSubmitting ? 'disabled' : ''} title="${collaborationActive ? '本章协作任务完成后才能运行规则生成' : scriptJobActive ? '本章已有剧本任务正在运行' : '按忠实朗读档位立即生成'}">⚡ ${scriptJobActive ? '剧本任务进行中…' : state.ruleScriptSubmitting ? '正在提交…' : '规则一键生成'}</button>
        <button class="button ghost" data-action="open-bulk-script">▦ 批量转脚本</button>
        <button class="button ghost" data-action="open-collaboration-room">✦ 剧本协作室 / 版本</button>
        <button class="button ghost" data-action="toggle-voice-binding">♬ 角色音色绑定</button>
        <button class="button" data-action="render-scope" data-scope="chapter">◉ 生成本章</button>
        <button class="button primary" data-action="export-project">⇩ 导出 WAV</button>
      </div>
    </header>
    ${missingVoices.length ? `<div class="voice-readiness-banner" role="status"><span class="voice-warning-icon">!</span><div><strong>本章还有 ${missingVoices.length} 个角色无法生成真人语音</strong><small>${escapeHtml(missingNames)}${escapeHtml(missingMore)} 尚未绑定带参考录音的可用音色。</small></div><button class="button small" data-action="toggle-voice-binding">批量绑定</button><button class="button ghost small" data-nav="voices">管理音色</button></div>` : ''}
    <div class="studio-grid">
      <aside class="chapter-rail">
        <div class="rail-head"><span>章节</span><small class="rail-count">${project.chapters.length}</small></div>
        <div class="chapter-list">${project.chapters.map((item, index) => chapterItemHtml(item, index)).join('')}</div>
        <div class="rail-footer"><button class="button ghost small" style="width:100%" data-action="new-project">＋ 导入另一部作品</button></div>
      </aside>
      <section class="script-workspace">
        <div class="script-toolbar">
          <div class="chapter-heading"><h2>${escapeHtml(chapter?.title || '尚无章节')}</h2><small>${chapter?.charCount || 0} 字 · ${lines.length} 个片段 · ${rendered}/${total} 已生成</small></div>
          <div class="toolbar-tools">
            ${[['all','全部'],['dialogue','对白'],['narration','旁白'],['review','待确认']].map(([id,label]) => `<button class="filter-chip ${state.lineFilter === id ? 'active' : ''}" data-action="filter-lines" data-filter="${id}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="script-scroll">${scriptContentHtml(chapter)}</div>
      </section>
      <aside class="inspector" data-inspected-line-id="${escapeHtml(state.selectedLineId || '')}">${inspectorHtml()}</aside>
    </div>
    ${voiceBindingDrawerHtml()}
  </section>`;
}

function chapterItemHtml(chapter, index) {
  const lineCount = chapter.scenes?.flatMap((scene) => scene.lines || []).length || 0;
  return `<button class="chapter-item ${chapter.id === state.selectedChapterId ? 'active' : ''}" data-action="select-chapter" data-chapter-id="${chapter.id}">
    <span class="chapter-index">${String(index + 1).padStart(2, '0')}</span><span><strong>${escapeHtml(chapter.title)}</strong><small>${lineCount ? `${lineCount} 个片段` : `${chapter.charCount} 字 · 待剧本化`}</small></span>
  </button>`;
}

function scriptContentHtml(chapter) {
  if (!chapter) return '<div class="source-only"><h3>作品还没有章节</h3><p>重新导入包含正文的文件后即可开始。</p></div>';
  const all = chapter.scenes?.flatMap((scene) => scene.lines || []) || [];
  if (!all.length) {
    return `<div class="source-only"><div class="doc-glyph">▤</div><h3>正文已经拆好，等待剧本化</h3><p>规则一键生成可立即识别引号对白；剧本协作室支持 Codex 或本地 Ollama 多轮调整，并保留可恢复版本。</p><div class="source-actions"><button class="button" data-action="run-rule-script" ${chapterHasActiveCollaboration(chapter.id) || activeScriptJobForChapter(chapter.id) || state.ruleScriptSubmitting ? 'disabled' : ''}>⚡ ${activeScriptJobForChapter(chapter.id) ? '剧本任务进行中…' : state.ruleScriptSubmitting ? '正在提交…' : '规则一键生成'}</button><button class="button primary" data-action="open-collaboration-room">✦ 打开剧本协作室</button></div></div>`;
  }
  const filtered = (line) => state.lineFilter === 'all' || line.kind === state.lineFilter || (state.lineFilter === 'review' && line.needsReview);
  return chapter.scenes.map((scene) => {
    const lines = (scene.lines || []).filter(filtered);
    if (!lines.length) return '';
    return `<div class="scene-block"><div class="scene-divider"><span>${escapeHtml(scene.title)}</span></div>${lines.map(scriptLineHtml).join('')}</div>`;
  }).join('') || `<div class="source-only"><h3>当前筛选没有片段</h3><p>切换到“全部”查看本章剧本。</p></div>`;
}

function scriptLineHtml(line) {
  const role = roleForLine(line) || { color: '#91a09b', name: line.speaker || '旁白' };
  const selected = line.id === state.selectedLineId;
  const initial = [...(role.name || '旁')][0];
  const pause = line.pauseAfterMs >= 1000 ? `${(line.pauseAfterMs / 1000).toFixed(1)}秒停顿` : `${line.pauseAfterMs || 0}ms 停顿`;
  return `<article class="script-line ${selected ? 'selected' : ''}" style="--speaker:${role.color || '#78dfc9'}" data-action="select-line" data-line-id="${line.id}" aria-current="${selected}">
    <span class="render-dot ${line.render?.status || 'idle'}"></span>
    <span class="speaker-avatar">${escapeHtml(initial)}</span>
    <div class="line-main"><div class="line-meta"><span class="speaker-name">${escapeHtml(role.name)}</span><span class="line-kind">${line.kind === 'dialogue' ? '对白' : '旁白'}</span>${line.needsReview ? '<span class="review-flag">待确认角色</span>' : ''}${line.render?.demo ? '<span class="review-flag">演示音轨</span>' : ''}</div>
      <textarea class="line-text" rows="1" data-line-input="spokenText" data-line-id="${line.id}">${escapeHtml(line.spokenText)}</textarea>
      <div class="line-traits"><span class="trait emotion">${escapeHtml(emotionLabel(line.emotion))}</span><span class="trait">强度 ${Math.round((line.intensity || 0) * 100)}%</span><span class="trait">${pause}</span></div>
    </div>
    <div class="line-actions"><button data-action="play-line" data-line-id="${line.id}" aria-label="试听">▶</button><button data-action="render-line" data-line-id="${line.id}" aria-label="生成">◉</button></div>
  </article>`;
}

function inspectorHtml() {
  const line = findLine(state.selectedLineId);
  if (!line) return `<div class="inspector-head"><h3>片段属性</h3></div><div class="inspector-empty">选择中间的一句旁白或对白，<br>在这里调整角色、情绪与节奏。</div>`;
  const role = roleForLine(line);
  const voice = voiceForRole(role);
  return `<div class="inspector-head"><h3>片段属性</h3><span class="eyebrow">${line.render?.status === 'ready' ? 'AUDIO READY' : 'SCRIPT'}</span></div>
    <div class="form-section"><div class="form-label"><span>说话角色</span>${line.needsReview ? '<span style="color:var(--orange)">需要确认</span>' : ''}</div>
      <select class="select-field" data-line-field="speakerId" data-line-id="${line.id}">${state.project.characters.map((item) => `<option value="${item.id}" ${item.id === role?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>
    </div>
    <div class="form-section"><div class="form-label"><span>角色音色</span><button class="button ghost small" data-nav="voices">管理音色</button></div>
      <div class="voice-assignment"><span class="voice-orb"></span><div><strong>${escapeHtml(voice?.name || '尚未绑定音色')}</strong><small>${voice ? `${voice.kind} · ${voice.status === 'ready' ? '参考样本就绪' : '需要样本'}` : '从音色库选择或录制新声音'}</small></div></div>
      <select class="select-field" style="margin-top:8px" data-role-voice="${role?.id || ''}"><option value="">不绑定</option>${state.bootstrap.voices.map((item) => `<option value="${item.id}" ${item.id === role?.voiceId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>
    </div>
    <div class="form-section"><div class="form-label"><span>情绪</span><span>${escapeHtml(line.emotionNote || '')}</span></div>
      <div class="emotion-grid">${state.bootstrap.emotions.map((emotion) => `<button class="emotion-button ${emotion.id === line.emotion ? 'active' : ''}" data-line-field="emotion" data-value="${emotion.id}" data-line-id="${line.id}"><span>${escapeHtml(emotion.glyph)}</span>${escapeHtml(emotion.label)}</button>`).join('')}</div>
    </div>
    <div class="form-section">
      <div class="form-label"><span>情绪强度</span></div><div class="range-row"><input type="range" min="0" max="1" step="0.05" value="${line.intensity ?? .5}" data-line-field="intensity" data-line-id="${line.id}"><span class="range-value">${Math.round((line.intensity || 0) * 100)}%</span></div>
      <div class="form-label" style="margin-top:16px"><span>语速</span></div><div class="range-row"><input type="range" min="0.7" max="1.35" step="0.05" value="${line.pace || 1}" data-line-field="pace" data-line-id="${line.id}"><span class="range-value">${Number(line.pace || 1).toFixed(2)}×</span></div>
      <div class="form-label" style="margin-top:16px"><span>句后停顿</span></div><div class="range-row"><input type="range" min="0" max="2500" step="50" value="${line.pauseAfterMs || 0}" data-line-field="pauseAfterMs" data-line-id="${line.id}"><span class="range-value">${line.pauseAfterMs || 0}ms</span></div>
    </div>
    <div class="form-section"><button class="button primary" style="width:100%" data-action="render-line" data-line-id="${line.id}">◉ 生成并试听这一句</button></div>`;
}

function syncStudioLineSelection() {
  if (state.view !== 'studio') return;
  $('.script-line.selected').forEach((item) => {
    item.classList.remove('selected');
    item.setAttribute('aria-current', 'false');
  });
  const selected = state.selectedLineId
    ? $(`.script-line[data-line-id="${CSS.escape(state.selectedLineId)}"]`)
    : null;
  selected?.classList.add('selected');
  selected?.setAttribute('aria-current', 'true');
  const audio = $('#audio-player');
  if (state.loadedAudio?.kind === 'line' && state.loadedAudio.id !== state.selectedLineId) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.loadedAudio = null;
    $('.play-main').textContent = '▶';
  }
  const inspector = $('.inspector');
  if (inspector) {
    inspector.innerHTML = inspectorHtml();
    inspector.dataset.inspectedLineId = state.selectedLineId || '';
    inspector.scrollTop = 0;
  }
  updateTransportForSelection();
}

function selectStudioLine(lineId) {
  if (!lineId || !findLine(lineId)) return false;
  const selected = $('.script-line.selected');
  const inspector = $('.inspector');
  const domIsAligned = selected?.dataset.lineId === lineId && inspector?.dataset.inspectedLineId === lineId;
  if (state.selectedLineId === lineId && domIsAligned) return false;
  state.selectedLineId = lineId;
  syncStudioLineSelection();
  return true;
}

function voicesHtml() {
  const voices = state.bootstrap.voices;
  return `<section class="page voices-page">
    <div class="page-head"><div><span class="eyebrow">VOICE LIBRARY</span><h1>角色音色库</h1><p>录制本人授权的声音，或导入许可证允许使用的开源音色，为角色建立可复用音色。</p></div><div class="head-actions"><button class="button primary" data-action="new-voice">＋ 制作新音色</button></div></div>
    <div class="voice-grid"><article class="voice-card new-voice-card" data-action="new-voice" role="button" tabindex="0"><span class="plus">＋</span><strong>制作新音色</strong><small>麦克风录制或导入音频</small></article>${voices.map(voiceCardHtml).join('')}</div>
  </section>`;
}

function voiceCardHtml(voice) {
  const tags = [voice.language, voice.kind, ...(voice.tags || [])].filter(Boolean).slice(0, 4);
  return `<article class="voice-card"><div class="voice-card-top"><span class="voice-orb"></span><span class="voice-status ${voice.status === 'ready' ? '' : 'warn'}">${voice.status === 'ready' ? '可用于克隆' : '需要样本'}</span></div>
    <h3>${escapeHtml(voice.name)}</h3><p>${escapeHtml(voice.reference?.transcript ? `“${voice.reference.transcript.slice(0, 42)}${voice.reference.transcript.length > 42 ? '…' : ''}”` : '尚未添加参考录音')}</p>
    <div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
    <div class="voice-card-actions">${voice.reference?.mediaUrl ? `<button class="button small" data-action="play-voice" data-url="${voice.reference.mediaUrl}" data-name="${escapeHtml(voice.name)}">▶ 试听原声</button>` : '<button class="button small" disabled>无参考音频</button>'}<button class="icon-button" data-action="delete-voice" data-voice-id="${voice.id}" aria-label="删除">×</button></div>
  </article>`;
}

function modelsHtml() {
  const { system, engines, settings } = state.bootstrap;
  const codex = codexReadiness();
  const loginActive = CODEX_LOGIN_ACTIVE_STATES.has(currentCodexLogin().state);
  return `<section class="page models-page">
    <div class="page-head"><div><span class="eyebrow">MODEL & HARDWARE</span><h1>模型中心</h1><p>按本机显存自动选择最合适的开源语音模型，也可为单个项目手动指定。</p></div><div class="head-actions"><button class="button" data-action="refresh-system">↻ 重新检测</button></div></div>
    <div class="models-layout">
      <aside class="panel system-panel"><span class="eyebrow">SYSTEM PROFILE</span><h3>当前设备</h3>
        ${hardwareRow('GPU', system.gpu.name, `${system.gpu.vramGb} GB`, '◇')}
        ${hardwareRow('CPU', system.cpu.name, `${system.cpu.cores} 线程`, '▦')}
        ${hardwareRow('内存', `可用 ${system.freeRamGb} / ${system.ramGb} GB`, `${system.ramGb} GB`, '▤')}
        ${hardwareRow('模型工作器', system.worker.online ? `已加载 ${system.worker.loaded_engine || '待命'}` : '尚未启动', system.worker.online ? '在线' : '离线', '◉')}
        <div class="system-tip">16GB 系统内存是当前瓶颈。工作器会懒加载模型并只保留一个主引擎，避免本地 LLM 与 TTS 同时抢占内存。</div>
      </aside>
      <div class="models-main">
        <section class="panel settings-strip"><strong>自动选择偏好</strong><div class="segmented">${[['speed','速度优先'],['balanced','均衡'],['quality','效果优先']].map(([id,label]) => `<button data-action="set-quality" data-quality="${id}" class="${settings.qualityMode === id ? 'active' : ''}">${label}</button>`).join('')}</div></section>
        <div class="engine-list">${engines.map(engineCardHtml).join('')}</div>
        <section class="panel integration-panel"><span class="eyebrow">SCRIPT POLISH</span><h3>Codex 剧本集成</h3><div class="integration-row"><div><label class="form-label">Codex CLI 命令</label><input class="field" value="${escapeHtml(settings.codexCommand)}" data-setting="codexCommand"><div class="tool-state ${codex.ready ? 'online' : ''}"><i></i><span><strong>${escapeHtml(codex.label)}</strong> · ${escapeHtml(codex.detail)}</span></div></div><div class="integration-actions">${codex.authRequired || loginActive ? `<button class="button primary" data-action="start-codex-login">${loginActive ? '查看登录进度' : '登录 Codex'}</button>` : ''}<button class="button" data-action="save-command">保存并检测</button></div></div></section>
        <section class="panel integration-panel"><span class="eyebrow">WORKER</span><h3>本地模型工作器</h3><div class="integration-row"><div><label class="form-label">服务地址</label><input class="field" value="${escapeHtml(settings.workerUrl)}" data-setting="workerUrl"><div class="tool-state ${system.worker.online ? 'online' : ''}"><i></i>${system.worker.online ? '连接正常，可进行真实语音生成' : '未连接；制作台可生成明确标记的演示音轨，用于先验收流程'}</div></div><button class="button" data-action="save-worker">保存并检测</button></div></section>
      </div>
    </div>
  </section>`;
}

function hardwareRow(label, description, value, icon) {
  return `<div class="hardware-row"><span class="hardware-icon">${icon}</span><div><strong>${escapeHtml(label)}</strong><small title="${escapeHtml(description)}">${escapeHtml(description)}</small></div><span class="hardware-value">${escapeHtml(value)}</span></div>`;
}

function engineCardHtml(engine) {
  return `<article class="engine-card ${engine.selected ? 'selected' : ''} ${engine.compatible ? '' : 'incompatible'}">
    <span class="engine-logo">${engine.id === 'cosyvoice3' ? 'C' : engine.id === 'indextts2' ? 'I' : engine.id === 'qwen3-tts' ? 'Q' : engine.id === 'gpt-sovits' ? 'G' : 'F'}</span>
    <div class="engine-info"><h3>${escapeHtml(engine.name)}<span class="engine-badge">${escapeHtml(engine.badge)}</span></h3><p>${escapeHtml(engine.summary)}</p><div class="engine-tags">${engine.supports.slice(0,5).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div></div>
    <div class="engine-scores"><div class="score-line"><span>效果</span><div class="meter"><span style="width:${engine.qualityScore}%"></span></div><b>${engine.qualityScore}</b></div><div class="score-line"><span>速度</span><div class="meter"><span style="width:${engine.speedScore}%"></span></div><b>${engine.speedScore}</b></div></div>
    <div class="engine-choice"><button class="button small ${engine.selected ? 'primary' : ''}" data-action="select-engine" data-engine-id="${engine.id}" ${engine.compatible ? '' : 'disabled'}>${engine.selected ? '已选择' : '选择'}</button><small>${escapeHtml(engine.reason)}</small></div>
  </article>`;
}

function renderView() {
  updateTopbar();
  const main = $('#app-main');
  if (!state.bootstrap) return;
  if (state.view === 'studio') main.innerHTML = studioHtml();
  else if (state.view === 'codex') {
    renderCodexStudio();
    return;
  }
  else if (state.view === 'voices') main.innerHTML = voicesHtml();
  else if (state.view === 'models') main.innerHTML = modelsHtml();
  else main.innerHTML = dashboardHtml();
  const transport = $('#transport');
  transport.hidden = state.view !== 'studio';
  if (state.view === 'studio') updateTransportForSelection();
  requestAnimationFrame(autoSizeTextareas);
}

function autoSizeTextareas() {
  $$('.line-text').forEach((textarea) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(28, textarea.scrollHeight)}px`;
  });
}

async function navigate(view, projectId = null, chapterId = null) {
  if (state.view === 'codex' && view !== 'codex') {
    if (state.codexBusy) {
      toast('正在提交协作任务', '收到后台任务编号后再离开本页。', 'warn');
      return;
    }
    pauseCodexStudio();
  }
  const previousProjectId = state.project?.id;
  if (view === 'studio' || view === 'codex') {
    const targetId = projectId || state.project?.id || state.bootstrap.projects[0]?.id;
    if (!targetId) { view = 'projects'; toast('还没有作品', '请先导入一本小说。', 'warn'); }
    else {
      try { await loadProject(targetId); } catch (error) { toast('无法打开作品', error.message, 'error'); view = 'projects'; }
    }
    if (chapterId && state.project?.chapters.some((chapter) => chapter.id === chapterId)) {
      state.selectedChapterId = chapterId;
    }
  }
  state.view = view;
  if (!['studio', 'codex'].includes(view) || (previousProjectId && state.project?.id !== previousProjectId)) resetPlayback();
  const hash = view === 'studio' && state.project
    ? `#/studio/${state.project.id}`
    : view === 'codex' && state.project && currentChapter()
      ? `#/codex/${state.project.id}/${currentChapter().id}`
      : `#/${view}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderView();
}

function parseRoute() {
  const [, view = 'projects', id, chapterId] = location.hash.match(/^#\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/) || [];
  return { view: ['projects', 'studio', 'codex', 'voices', 'models'].includes(view) ? view : 'projects', id, chapterId };
}

function projectModalHtml() {
  return `<header class="modal-head"><div><span class="eyebrow">NEW PROJECT</span><h2>导入一本小说</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <form id="project-form"><div class="modal-body"><div class="form-grid">
      <div class="form-group full"><div class="drop-zone" id="book-drop-zone" role="button" tabindex="0"><div><span class="drop-icon">⇧</span><strong>拖入小说文件，或点击选择</strong><small>支持 TXT / Markdown / EPUB，最大 30MB</small><div class="selected-file" id="book-file-label"></div></div><input id="modal-book-file" type="file" accept=".txt,.md,.markdown,.epub" hidden></div></div>
      <div class="form-group"><label for="project-title">作品名称</label><input class="field" id="project-title" name="title" placeholder="自动使用文件名"></div>
      <div class="form-group"><label for="project-author">作者</label><input class="field" id="project-author" name="author" placeholder="可稍后填写"></div>
    </div></div><footer class="modal-foot"><button type="button" class="button ghost" data-action="close-modal">取消</button><button type="submit" class="button primary">导入并自动拆章</button></footer></form>`;
}

function voiceModalHtml() {
  return `<header class="modal-head"><div><span class="eyebrow">VOICE CREATOR</span><h2>制作角色音色</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <form id="voice-form"><div class="modal-body">
      <div class="tabs voice-tabs" role="tablist" aria-label="音色素材来源"><button type="button" id="voice-tab-record" class="active" role="tab" aria-selected="true" aria-controls="voice-record-pane" data-action="voice-tab" data-tab="record">麦克风录制</button><button type="button" id="voice-tab-upload" role="tab" aria-selected="false" aria-controls="voice-upload-pane" tabindex="-1" data-action="voice-tab" data-tab="upload">导入短音频</button><button type="button" id="voice-tab-clip" role="tab" aria-selected="false" aria-controls="voice-clip-pane" tabindex="-1" data-action="voice-tab" data-tab="clip">从长媒体裁剪</button></div>
      <div id="voice-record-pane" role="tabpanel" aria-labelledby="voice-tab-record"><div class="record-box"><div><button type="button" class="record-button" id="record-button" data-action="toggle-record" aria-label="开始录音"></button><p id="record-status">点击红色按钮开始录制，建议 10–30 秒安静、清晰的人声</p></div></div></div>
      <div id="voice-upload-pane" role="tabpanel" aria-labelledby="voice-tab-upload" hidden><div class="drop-zone" id="voice-drop-zone" role="button" tabindex="0"><div><span class="drop-icon">♫</span><strong>选择参考音频或开源音色样本</strong><small>WAV / MP3 / M4A / WebM / FLAC，最大 25MB</small><div class="selected-file" id="voice-file-label"></div></div><input id="modal-voice-file" type="file" accept="audio/*,.flac" hidden></div></div>
      <div id="voice-clip-pane" role="tabpanel" aria-labelledby="voice-tab-clip" hidden>
        <div class="drop-zone media-source-zone" id="voice-source-drop-zone" role="button" tabindex="0"><div><span class="drop-icon">▶</span><strong>选择长视频或音频</strong><small>支持浏览器可预览的 MP4 / WebM / WAV / MP3 / M4A；先在本地定位，提交时再上传原始二进制</small><div class="selected-file" id="voice-source-file-label"></div></div><input id="modal-voice-source-file" type="file" accept="audio/*,video/*,.mkv,.avi,.mov,.m4v,.flac,.opus,.wma" hidden></div>
        <section class="clip-editor" id="voice-clip-editor" aria-label="音色片段裁剪" hidden>
          <div class="media-preview-shell"><video id="voice-source-preview-video" controls preload="metadata" aria-label="长视频本地预览" hidden></video><audio id="voice-source-preview-audio" controls preload="metadata" aria-label="长音频本地预览" hidden></audio></div>
          <div class="clip-summary"><span id="voice-source-duration">总时长 --:--</span><strong id="voice-clip-duration">选中 00:00</strong><span id="voice-preview-position">00:00 / --:--</span></div>
          <div class="clip-timeline" aria-hidden="true"><span id="voice-clip-window"></span></div>
          <div class="clip-boundaries">
            <div class="clip-boundary"><label for="voice-clip-start">起点（秒）</label><div><input class="field" id="voice-clip-start" type="number" min="0" step="0.1" value="0" inputmode="decimal" data-clip-boundary="start"><button class="button small ghost" type="button" data-action="set-clip-boundary" data-boundary="start">取当前</button></div></div>
            <div class="clip-boundary"><label for="voice-clip-end">终点（秒）</label><div><input class="field" id="voice-clip-end" type="number" min="0" step="0.1" value="0" inputmode="decimal" data-clip-boundary="end"><button class="button small ghost" type="button" data-action="set-clip-boundary" data-boundary="end">取当前</button></div></div>
          </div>
          <div class="clip-actions"><button type="button" class="button" id="voice-clip-play" data-action="play-voice-clip">▶ 试听选中片段</button><small>仅上传原始文件一次；服务器按时间点标准化提取为 24kHz 单声道</small></div>
          <p class="clip-validation" id="voice-clip-validation" role="status" aria-live="polite">请选择 3–60 秒、只包含一位说话人的清晰片段。</p>
        </section>
      </div>
      <div class="form-grid voice-details"><div class="form-group"><label for="voice-name">音色名称</label><input class="field" id="voice-name" name="name" required placeholder="例如：林默 · 青年男声"></div><div class="form-group"><label for="voice-tags">标签</label><input class="field" id="voice-tags" name="tags" placeholder="沉稳, 青年, 旁白"></div>
        <div class="form-group full"><label for="voice-transcript">参考音频准确台词</label><textarea class="text-field" id="voice-transcript" name="transcript" required placeholder="逐字填写选中片段中实际说出的内容，不要改写或省略。"></textarea></div>
        <div class="form-group full"><label class="checkbox-row"><input type="checkbox" name="consent" required><span>我确认已取得实际发声人对声音剪取、AI 克隆及本用途的明确授权，并同时具备素材的必要作品/录音权利；不冒充、不欺骗、不侵犯他人权益。</span></label></div>
      </div>
    </div><footer class="modal-foot"><button type="button" class="button ghost" data-action="close-modal">取消</button><button type="submit" class="button primary" id="voice-submit-button">保存到音色库</button></footer></form>`;
}

function codexImportModalHtml(prompt = '') {
  return `<header class="modal-head"><div><span class="eyebrow">CODEX HANDOFF</span><h2>Codex 剧本任务</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <div class="modal-body"><div class="modal-note">已按官方结构化输出方式准备任务。复制下方内容交给 Codex，取得 JSON 后粘贴到“返回结果”中导入。</div>
      <div class="form-group"><label>任务提示词</label><textarea class="code-area" id="codex-prompt" readonly>${escapeHtml(prompt)}</textarea></div>
      <button class="button small" style="margin:8px 0 17px" data-action="copy-codex-prompt">复制任务提示词</button>
      <div class="form-group"><label>Codex 返回结果（JSON）</label><textarea class="code-area" id="codex-result" placeholder="在这里粘贴 Codex 返回的 JSON…"></textarea></div>
    </div><footer class="modal-foot"><button class="button ghost" data-action="close-modal">稍后处理</button><button class="button primary" data-action="import-codex-result">校验并导入</button></footer>`;
}

function codexMessageHtml(message, provider = state.codexProvider) {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system';
  const label = role === 'assistant' ? scriptSourceLabel(normalizeCollaborationProvider(provider)) : role === 'user' ? '你' : '系统';
  const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<article class="codex-message ${role}"><div class="codex-message-meta"><strong>${label}</strong><time>${escapeHtml(createdAt)}</time></div><div class="codex-message-content">${escapeHtml(message.content || '')}</div></article>`;
}

function codexConversationTimelineHtml(messages, provider, progress) {
  const turns = (messages || []).map((message) => codexMessageHtml(message, provider));
  const runSlot = `<div id="codex-progress-slot">${state.codexProgressVisible && progress ? codexInlineRunTurnHtml(progress) : ''}</div>`;
  if (progress?.terminal && messages?.at(-1)?.role === 'assistant') {
    turns.splice(Math.max(0, turns.length - 1), 0, runSlot);
    return turns.join('');
  }
  return `${turns.join('')}${runSlot}`;
}

function codexLineEditorHtml(line, index, { readOnly = false, lockedReason = '' } = {}) {
  const role = roleForLine(line);
  const locked = readOnly ? 'disabled' : '';
  const roleOptions = state.project.characters.map((item) => `<option value="${item.id}" ${item.id === role?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const emotionOptions = state.bootstrap.emotions.map((emotion) => `<option value="${emotion.id}" ${emotion.id === line.emotion ? 'selected' : ''}>${escapeHtml(emotion.label)}</option>`).join('');
  return `<article class="codex-script-line" data-codex-line-id="${line.id}">
    <header><span class="codex-line-number">${String(index + 1).padStart(2, '0')}</span><span class="codex-line-kind">${line.kind === 'dialogue' ? '对白' : '旁白'}</span>${line.needsReview ? '<span class="review-flag">待确认</span>' : ''}<small>${readOnly ? escapeHtml(lockedReason || '只读版本') : '修改自动保存'}</small></header>
    <textarea class="codex-line-text" rows="2" aria-label="第 ${index + 1} 句朗读文本" data-line-input="spokenText" data-line-id="${line.id}" ${locked}>${escapeHtml(line.spokenText || '')}</textarea>
    <div class="codex-line-selects"><label><span>角色</span><select class="select-field" data-line-field="speakerId" data-line-id="${line.id}" ${locked}>${roleOptions}</select></label><label><span>情绪</span><select class="select-field" data-line-field="emotion" data-line-id="${line.id}" ${locked}>${emotionOptions}</select></label></div>
    <div class="codex-line-ranges">
      <label><span>强度 <output class="range-value">${Math.round(Number(line.intensity || 0) * 100)}%</output></span><input type="range" min="0" max="1" step="0.05" value="${line.intensity ?? .5}" data-line-field="intensity" data-line-id="${line.id}" ${locked}></label>
      <label><span>语速 <output class="range-value">${Number(line.pace || 1).toFixed(2)}×</output></span><input type="range" min="0.6" max="1.6" step="0.05" value="${line.pace || 1}" data-line-field="pace" data-line-id="${line.id}" ${locked}></label>
      <label><span>停顿 <output class="range-value">${line.pauseAfterMs || 0}ms</output></span><input type="range" min="0" max="5000" step="50" value="${line.pauseAfterMs || 0}" data-line-field="pauseAfterMs" data-line-id="${line.id}" ${locked}></label>
    </div>
  </article>`;
}

function codexStudioHtml() {
  const chapter = currentChapter();
  const sessions = codexSessions(chapter);
  if (state.codexChapterGroupsProjectId !== state.project?.id) {
    state.codexChapterGroupsProjectId = state.project?.id || '';
    state.codexCollapsedChapters = new Set((state.project?.chapters || [])
      .filter((item) => item.id !== chapter?.id)
      .map((item) => item.id));
    state.codexShowAllChapters = false;
  }
  if (chapter?.id) state.codexCollapsedChapters.delete(chapter.id);
  const session = currentCodexSession();
  const selectedVersion = sessions.find((item) => item.id === state.codexVersionId) || null;
  const messages = session?.messages || [];
  const scriptSnapshot = selectedCodexScriptSnapshot();
  const viewedScript = scriptSnapshot.script;
  const lines = viewedScript?.scenes?.flatMap((scene) => scene.lines || []) || [];
  const progress = currentCodexProgress();
  const busy = codexRoomBusy();
  const activeProgress = codexProgressIsActive(progress) ? progress : null;
  const provider = normalizeCollaborationProvider(activeProgress?.provider ?? session?.provider ?? state.codexProvider);
  const readiness = collaborationReadiness(provider);
  const providerLabel = scriptSourceLabel(provider);
  const model = normalizeCodexModel(activeProgress?.model ?? state.codexModel ?? session?.model, collaborationModelDefault(provider));
  const reasoningEffort = normalizeCodexReasoningEffort(
    activeProgress?.reasoningEffort ?? state.codexReasoningEffort ?? session?.reasoningEffort
  );
  const timeoutMinutes = normalizeCodexTimeoutMinutes(
    activeProgress?.timeoutMinutes ?? state.codexTimeoutMinutes ?? session?.timeoutMinutes
  );
  const legacyTimeout = Boolean(session) && !activeProgress && parseCodexTimeoutMinutes(session.timeoutMinutes) === null;
  const mode = selectedVersion?.mode || state.codexMode || 'faithful';
  const selectedIsActive = !selectedVersion || chapter?.activeCodexSessionId === selectedVersion.id || scriptSnapshot.isActive;
  const selectedCanContinue = !selectedVersion || selectedVersion.versionAvailable !== false;
  const sessionStatus = busy
    ? (CODEX_PROGRESS_PRESENTATION[progress?.type]?.short || '提交中')
    : session ? codexStatusLabel(session.status)
      : selectedVersion ? `${scriptSourceLabel(selectedVersion)}只读版本`
        : '新会话';
  const canSend = readiness.ready && !busy;
  const currentError = currentCodexError();
  const loginActive = CODEX_LOGIN_ACTIVE_STATES.has(currentCodexLogin().state);
  const loginButton = provider === 'codex' && readiness.authRequired
    ? `<button class="button primary small" data-action="start-codex-login" ${busy ? 'disabled' : ''}>${loginActive ? '查看登录' : '登录 Codex'}</button>`
    : '';
  const sidebar = codexSessionSidebarData();
  const continuationHint = selectedVersion
    ? `${selectedIsActive ? '活动版本' : '正在查看独立快照'} · ${session ? `${Number(session.turnCount || Math.ceil(messages.length / 2))} 轮对话` : `发送后创建 ${providerLabel} Session`}`
    : `发送后在本章创建 ${providerLabel} Session`;
  const rightReadOnly = !selectedIsActive || busy;
  const rightLockedReason = !selectedIsActive ? '先激活此版本再编辑' : busy ? '此 Session 处理中暂锁定' : '';
  const emptyConversation = `<div class="codex-conversation-empty"><span>✦</span><h3>${selectedVersion ? `查看 ${escapeHtml(scriptSourceLabel(selectedVersion))} 版本` : `和 ${escapeHtml(providerLabel)} 开始新 Session`}</h3><p>${selectedVersion ? '此处只显示所选 Session 的消息；规则或导入版本尚无对话记录，发送后会创建独立 Session。' : '每个 Session 拥有独立消息、运行记录和剧本快照，可在运行期间切换查看其他 Session。'}</p><div><button class="codex-suggestion" type="button" data-action="use-codex-suggestion" data-prompt="请重点检查所有对白的说话人归属，不确定的角色保留待确认标记。" ${busy ? 'disabled' : ''}>检查角色归属</button><button class="codex-suggestion" type="button" data-action="use-codex-suggestion" data-prompt="请优化朗读节奏和停顿，但不要改变剧情事实和人物关系。" ${busy ? 'disabled' : ''}>优化朗读节奏</button></div></div>`;
  const conversationTimeline = messages.length
    ? codexConversationTimelineHtml(messages, provider, progress)
    : `${emptyConversation}<div id="codex-progress-slot">${state.codexProgressVisible && progress ? codexInlineRunTurnHtml(progress) : ''}</div>`;
  return `<header class="codex-room-head"><div class="codex-room-title"><button class="button ghost codex-room-back" data-action="leave-codex-room" ${state.codexBusy ? 'disabled' : ''}>‹ 返回制作台</button><div><span class="eyebrow">SCRIPT COLLABORATION</span><h1>剧本协作室</h1><p>${escapeHtml(chapter?.title || '当前章节')} · 每个 Session 独立对话、进度与版本快照</p></div></div><div class="codex-room-head-actions"><span class="codex-room-status ${readiness.ready ? 'ready' : 'warn'}"><i></i>${escapeHtml(readiness.label)}</span></div></header>
    <div class="codex-room-grid" style="--codex-session-width:${Math.round(state.codexSessionPaneWidth)}px;--codex-script-width:${Math.round(state.codexScriptPaneWidth)}px">
      <aside class="codex-session-panel" aria-label="剧本版本与会话历史">
        <div class="codex-panel-title"><div><span class="eyebrow">CHAPTER SESSIONS</span><strong>章节与 Session</strong></div><button class="button small" data-action="new-codex-session" ${state.codexBusy ? 'disabled' : ''}>＋ 新 Session</button></div>
        <p class="codex-session-hint">按章节折叠；● 徽标只代表对应 Session 正在运行。选择版本不会自动激活右侧脚本。</p>
        <div class="codex-session-filter"><button type="button" data-action="toggle-all-codex-chapters" aria-pressed="${state.codexShowAllChapters}">${state.codexShowAllChapters ? '只看有版本章节' : `显示全部章节${sidebar.hiddenChapterCount ? `（另 ${sidebar.hiddenChapterCount}）` : ''}`}</button></div>
        <div class="codex-session-list">${sidebar.groupsHtml || '<div class="codex-empty-session"><span>✦</span><strong>还没有章节</strong></div>'}</div>
        <div class="codex-readiness-card ${readiness.ready ? 'ready' : 'warn'}"><strong>${escapeHtml(readiness.label)}</strong><p>${escapeHtml(readiness.detail)}${readiness.ready ? `。本轮会由${escapeHtml(providerLabel)}处理当前章节。` : ''}</p><div>${loginButton}${provider === 'codex' ? `<button class="button ghost small" data-action="open-codex-package" data-mode="${escapeHtml(mode)}" ${busy ? 'disabled' : ''}>⇧ Codex 任务包</button>` : ''}<button class="button ghost small" data-action="refresh-codex-room" ${state.codexBusy ? 'disabled' : ''}>↻ 重新检测</button></div></div>
      </aside>
      <div class="codex-splitter codex-splitter-left" data-codex-splitter="left" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整 Session 列表宽度"></div>
      <section class="codex-chat-panel" aria-label="剧本协作对话与任务进度" aria-busy="${busy}">
        <div class="codex-chat-toolbar">
          <label class="codex-provider-control"><span>协作后端（切换会新建 Session）</span><select class="select-field" id="codex-provider" ${busy ? 'disabled' : ''}><option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option><option value="ollama" ${provider === 'ollama' ? 'selected' : ''}>本地 Ollama</option></select></label>
          <label class="codex-model-control"><span>${provider === 'ollama' ? 'Ollama 模型（本地模型 ID）' : '模型（默认 Terra，可输入 CLI ID）'}</span><div class="codex-model-input"><input class="field" id="codex-model" ${provider === 'codex' ? 'list="codex-model-options"' : ''} maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}" value="${escapeHtml(model)}" placeholder="${provider === 'ollama' ? 'qwen3:8b' : 'gpt-5.6-terra'}" title="以字母或数字开头，最多 100 个字符" autocomplete="off" spellcheck="false" ${busy ? 'disabled' : ''}><button class="button ghost small" type="button" data-action="use-codex-default-model" title="使用${provider === 'ollama' ? '设置中的 Ollama 模型' : '推荐模型 gpt-5.6-terra'}" ${busy ? 'disabled' : ''}>${provider === 'ollama' ? '本地默认' : 'Terra'}</button></div></label>
          <datalist id="codex-model-options">${CODEX_MODEL_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</datalist>
          <label class="codex-reasoning-control"><span>${provider === 'ollama' ? '推理强度（由本地模型配置）' : '推理强度（影响质量 / 耗时）'}</span><select class="select-field" id="codex-reasoning-effort" ${busy || provider === 'ollama' ? 'disabled' : ''}>${provider === 'ollama' ? '<option>不适用</option>' : CODEX_REASONING_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === reasoningEffort ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label class="codex-timeout-control"><span>任务超时（分钟）${legacyTimeout ? ' · 旧会话下轮默认 10' : ''}</span><input class="field" id="codex-timeout-minutes" type="number" min="5" max="120" step="1" inputmode="numeric" value="${timeoutMinutes}" title="请输入 5–120 的整数；建议按 5 分钟调整" ${busy ? 'disabled' : ''}></label>
          <label class="codex-mode-control"><span>润色档位</span><select class="select-field" id="codex-room-mode" ${selectedVersion || busy ? 'disabled' : ''}>${Object.entries(CODEX_MODE_LABELS).map(([value, label]) => `<option value="${value}" ${value === mode ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <div class="codex-active-status"><span>${escapeHtml(sessionStatus)}</span><small>${escapeHtml(continuationHint)}</small><fieldset class="codex-observability-controls"><legend class="sr-only">协作进度显示设置</legend><label class="codex-progress-visibility"><input type="checkbox" id="codex-progress-visible" ${state.codexProgressVisible ? 'checked' : ''}><span>显示处理进度</span></label><label class="codex-progress-visibility codex-activity-visibility"><input type="checkbox" id="codex-activity-visible" ${state.codexActivityVisible ? 'checked' : ''} aria-describedby="codex-activity-setting-help"><span>显示推理摘要与活动日志 <em>非隐藏思维链</em></span></label><small id="codex-activity-setting-help">摘要采集模式在发送新任务时确定；关闭显示不会停止后台处理</small></fieldset></div>
        </div>
        <div class="sr-only" id="codex-progress-announcer" role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="codex-conversation" id="codex-conversation">${conversationTimeline}${state.codexBusy ? `<div class="codex-processing" role="status"><span><i></i><i></i><i></i></span><div><strong>正在提交 ${escapeHtml(providerLabel)} 后台任务</strong><small>收到 Session 与任务编号后会立即解除页面锁定。</small></div></div>` : ''}${currentError ? `<div class="codex-chat-error" role="alert"><strong>本轮没有完成</strong><span>${escapeHtml(currentError)}</span></div>` : ''}</div>
        <form class="codex-composer" id="codex-chat-form" novalidate><textarea id="codex-chat-prompt" rows="3" maxlength="4000" placeholder="例如：第二场中苏晚的语气太激烈，请改得克制一些，并延长关键句后的停顿。" ${busy ? 'disabled' : ''}>${escapeHtml(codexDraft())}</textarea><div><small>${!selectedCanContinue ? '此旧版本没有可恢复快照，无法从它继续。' : busy && progress ? '只锁定当前 Session；左侧其他 Session 仍可查看和继续。' : readiness.ready ? `发送后由${escapeHtml(providerLabel)}更新此 Session 的独立快照；跨后端会创建新 Session。` : readiness.authRequired ? '请先点击左侧“登录 Codex”，在 OpenAI 官方页面完成登录；任务包仍可使用。' : `${escapeHtml(providerLabel)}当前不可用，请检查本地配置。`}</small><button class="button primary" type="submit" ${canSend && selectedCanContinue ? '' : 'disabled'}>${busy ? (progress ? '此 Session 处理中…' : '正在提交…') : session && normalizeCollaborationProvider(session.provider) === provider ? '发送并更新此 Session' : selectedVersion ? `创建 ${escapeHtml(providerLabel)} Session` : `新建 ${escapeHtml(providerLabel)} Session`}</button></div></form>
      </section>
      <div class="codex-splitter codex-splitter-right" data-codex-splitter="right" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整对话与剧本宽度比例"></div>
      <aside class="codex-script-panel" aria-label="所选版本剧本">
        <div class="codex-panel-title"><div><span class="eyebrow">LIVE SCRIPT</span><strong>${selectedVersion ? `V${selectedVersion.versionOrdinal || 1} · ${escapeHtml(scriptSourceLabel(selectedVersion))}` : '当前活动剧本'}</strong></div><span class="codex-line-count">${lines.length} 句</span></div>
        <div class="codex-script-version-state ${selectedIsActive ? 'active' : 'readonly'}"><div><strong>${selectedIsActive ? '活动版本 · 可自动保存' : '正在查看快照 · 只读'}</strong><small>${selectedIsActive ? '右侧内容就是本章当前 Live Script。' : '选择 Session 不会覆盖当前 Live Script；激活后才能逐句编辑。'}</small></div>${selectedVersion && !selectedIsActive && selectedVersion.versionAvailable ? `<button class="button small" data-action="activate-codex-session" data-session-id="${escapeHtml(selectedVersion.id)}" data-chapter-id="${escapeHtml(chapter.id)}" ${sessionHasActiveRun(selectedVersion) ? 'disabled' : ''}>激活到 Live Script</button>` : ''}</div>
        <p class="codex-script-hint">${scriptSnapshot.loading ? '正在读取所选 Session 的独立剧本快照…' : rightReadOnly ? escapeHtml(rightLockedReason) : '可直接修改台词、角色、情绪与节奏；每项改动都会自动保存。'}</p>
        <div class="codex-script-list">${lines.length ? lines.map((line, index) => codexLineEditorHtml(line, index, { readOnly: rightReadOnly, lockedReason: rightLockedReason })).join('') : `<div class="codex-empty-script"><span>▤</span><strong>${scriptSnapshot.loading ? '正在读取版本快照' : '此版本还没有剧本'}</strong><small>${scriptSnapshot.loading ? '读取完成后会在这里显示，不会切换活动版本。' : `向${escapeHtml(providerLabel)}发送第一条要求后，结果会保存在此 Session。`}</small></div>`}</div>
      </aside>
    </div>`;
}

function codexPaneBounds(grid, side) {
  const width = grid?.getBoundingClientRect().width || 0;
  if (side === 'left') return { min: 180, max: Math.max(180, Math.min(360, width - state.codexScriptPaneWidth - 520)) };
  return { min: 300, max: Math.max(300, Math.min(720, width - state.codexSessionPaneWidth - 520)) };
}

function setCodexPaneWidth(grid, side, rawValue, { persist = false } = {}) {
  const bounds = codexPaneBounds(grid, side);
  const value = Math.round(Math.min(bounds.max, Math.max(bounds.min, Number(rawValue) || bounds.min)));
  if (side === 'left') {
    state.codexSessionPaneWidth = value;
    grid.style.setProperty('--codex-session-width', `${value}px`);
    if (persist) writeLocalNumber(CODEX_SESSION_PANE_WIDTH_KEY, value);
  } else {
    state.codexScriptPaneWidth = value;
    grid.style.setProperty('--codex-script-width', `${value}px`);
    if (persist) writeLocalNumber(CODEX_SCRIPT_PANE_WIDTH_KEY, value);
  }
  const separator = $(`[data-codex-splitter="${side}"]`, grid);
  if (separator) {
    separator.setAttribute('aria-valuemin', String(bounds.min));
    separator.setAttribute('aria-valuemax', String(bounds.max));
    separator.setAttribute('aria-valuenow', String(value));
  }
}

function setupCodexSplitters() {
  const grid = $('.codex-room-grid');
  if (!grid) return;
  for (const splitter of $$('[data-codex-splitter]', grid)) {
    const side = splitter.dataset.codexSplitter;
    setCodexPaneWidth(grid, side, side === 'left' ? state.codexSessionPaneWidth : state.codexScriptPaneWidth);
    splitter.addEventListener('pointerdown', (event) => {
      if (matchMedia('(max-width: 1100px)').matches || event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture?.(event.pointerId);
      document.documentElement.classList.add('codex-resizing');
      const rect = grid.getBoundingClientRect();
      const move = (moveEvent) => setCodexPaneWidth(
        grid,
        side,
        side === 'left' ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX
      );
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        document.documentElement.classList.remove('codex-resizing');
        setCodexPaneWidth(grid, side, side === 'left' ? state.codexSessionPaneWidth : state.codexScriptPaneWidth, { persist: true });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop, { once: true });
      window.addEventListener('pointercancel', stop, { once: true });
    });
    splitter.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      const current = side === 'left' ? state.codexSessionPaneWidth : state.codexScriptPaneWidth;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      const next = event.key === 'Home' ? (side === 'left' ? 224 : 430) : current + direction * (event.shiftKey ? 40 : 16) * (side === 'right' ? -1 : 1);
      setCodexPaneWidth(grid, side, next, { persist: true });
    });
  }
}

function renderCodexStudio({ focus = '' } = {}) {
  if (state.view !== 'codex') return;
  updateTopbar();
  const main = $('#app-main');
  main.innerHTML = `<section class="codex-room-page codex-room-surface">${codexStudioHtml()}</section>`;
  $('#transport').hidden = true;
  startCodexProgressElapsedTimer();
  requestAnimationFrame(() => {
    setupCodexSplitters();
    const conversation = $('#codex-conversation');
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    if (focus === 'composer') $('#codex-chat-prompt')?.focus();
    if (focus === 'model') $('#codex-model')?.focus();
  });
}

function pauseCodexStudio({ invalidateRequest = false } = {}) {
  if (state.view !== 'codex' && !$('.codex-room-surface')) return;
  rememberCodexComposer();
  closeAllCodexProgressConnections({ paused: true });
  stopCodexProgressElapsedTimer();
  stopCodexLoginPolling({ invalidate: true });
  state.codexLoginPanelOpen = false;
  state.codexLoginAction = '';
  if (invalidateRequest) {
    state.codexRequestId += 1;
    state.codexBusy = false;
  }
}

async function leaveCodexStudio() {
  if (state.codexBusy) {
    toast('正在提交协作任务', '收到后台任务编号后即可返回制作台。', 'warn');
    return;
  }
  const projectId = state.project?.id;
  await navigate('studio', projectId);
}

function prepareCodexStudioState(mode = state.codexMode) {
  state.codexMode = CODEX_MODE_LABELS[mode] ? mode : 'faithful';
  state.codexError = '';
  const chapter = currentChapter();
  const sessions = codexSessions(chapter);
  const remembered = state.codexSessionByChapter.get(chapter?.id);
  const preferred = remembered || chapter?.activeCodexSessionId || sessions[0]?.id || null;
  state.codexVersionId = sessions.some((version) => version.id === preferred) ? preferred : sessions[0]?.id || null;
  const selectedVersion = sessions.find((version) => version.id === state.codexVersionId) || null;
  const source = scriptVersionSource(selectedVersion);
  state.codexSessionId = selectedVersion && COLLABORATION_PROVIDERS.has(source) ? selectedVersion.id : null;
  const session = currentCodexSession();
  if (session) state.codexProvider = normalizeCollaborationProvider(session.provider, source);
  else state.codexProvider = normalizeCollaborationProvider(state.codexProvider);
  state.codexModel = normalizeCodexModel(session?.model, collaborationModelDefault(state.codexProvider));
  state.codexReasoningEffort = normalizeCodexReasoningEffort(session?.reasoningEffort);
  state.codexTimeoutMinutes = normalizeCodexTimeoutMinutes(session?.timeoutMinutes);
  if (selectedVersion?.mode) state.codexMode = selectedVersion.mode;
}

function openCodexStudio(mode = state.codexMode) {
  if ($('#modal-root .modal') && !closeModal()) return;
  prepareCodexStudioState(mode);
  const chapter = currentChapter();
  state.view = 'codex';
  const hash = state.project && chapter ? `#/codex/${state.project.id}/${chapter.id}` : '#/codex';
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderCodexStudio({ focus: state.codexSessionId ? '' : 'composer' });
  if (state.codexProvider === 'codex') recoverCodexLogin();
  if (state.codexVersionId) {
    void loadCodexSessionScript(state.codexVersionId)
      .catch(() => null)
      .then(() => {
        if (state.view !== 'codex') return;
        renderCodexStudio();
        return recoverActiveCodexSessions();
      });
  } else void recoverActiveCodexSessions();
}

function startNewCodexSession(provider = state.codexProvider, { remember = true, closeProgress = false } = {}) {
  if (state.codexBusy) return;
  if (remember) rememberCodexComposer();
  if (closeProgress) closeCodexProgressConnection(codexProgressKey(), { paused: true });
  const chapterId = currentChapter()?.id;
  if (chapterId) state.codexSessionByChapter.delete(chapterId);
  state.codexProvider = normalizeCollaborationProvider(provider);
  state.codexSessionId = null;
  state.codexVersionId = null;
  state.codexModel = collaborationModelDefault(state.codexProvider);
  state.codexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
  state.codexTimeoutMinutes = DEFAULT_CODEX_TIMEOUT_MINUTES;
  state.codexError = '';
  state.codexDrafts.delete(codexDraftKey(null));
  renderCodexStudio({ focus: 'composer' });
}

function switchCollaborationProvider(provider) {
  const nextProvider = normalizeCollaborationProvider(provider);
  if (codexRoomBusy() || nextProvider === state.codexProvider) return;
  rememberCodexComposer();
  state.codexProvider = nextProvider;
  state.codexModel = collaborationModelDefault(nextProvider);
  state.codexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
  state.codexError = '';
  renderCodexStudio({ focus: 'composer' });
  toast(`已切换到${scriptSourceLabel(nextProvider)}`, '发送时会从当前版本创建新的后端 Session；原 Session 保持不变。', 'warn');
}

async function selectCodexSession(sessionId, chapterId = '') {
  if (state.codexBusy || !sessionId) return;
  const target = findCodexSessionAcrossProject(sessionId, chapterId);
  if (!target) return;
  if (sessionId === state.codexVersionId && target.chapterId === currentChapter()?.id) return;
  rememberCodexComposer();
  state.selectedChapterId = target.chapterId;
  state.codexCollapsedChapters.delete(target.chapterId);
  state.codexVersionId = sessionId;
  const source = scriptVersionSource(target);
  state.codexSessionId = COLLABORATION_PROVIDERS.has(source) ? sessionId : null;
  if (target.chapterId) state.codexSessionByChapter.set(target.chapterId, sessionId);
  const session = currentCodexSession();
  if (session) state.codexProvider = normalizeCollaborationProvider(session.provider, source);
  state.codexModel = normalizeCodexModel(session?.model, collaborationModelDefault(state.codexProvider));
  state.codexReasoningEffort = normalizeCodexReasoningEffort(session?.reasoningEffort);
  state.codexTimeoutMinutes = normalizeCodexTimeoutMinutes(session?.timeoutMinutes);
  if (target?.mode) state.codexMode = target.mode;
  state.codexError = state.codexErrorsBySession.get(codexProgressKey(state.project?.id, target.chapterId, sessionId)) || '';
  const hash = `#/codex/${state.project.id}/${target.chapterId}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderCodexStudio();
  try {
    await loadCodexSessionScript(sessionId, target.chapterId);
  } catch {
    toast('版本快照暂时无法读取', '没有切换活动版本；可稍后重新选择此 Session。', 'warn');
  }
  if (state.codexVersionId !== sessionId || currentChapter()?.id !== target.chapterId) return;
  renderCodexStudio({ focus: 'composer' });
  if (state.codexSessionId) void recoverCodexProgress();
}

async function activateCodexSession(sessionId, chapterId) {
  if (state.codexBusy || !sessionId || !chapterId || !state.project) return;
  const target = findCodexSessionAcrossProject(sessionId, chapterId);
  if (!target?.versionAvailable || sessionHasActiveRun(target)) return;
  try {
    await waitForPendingLineSaves(state.project.id, state.codexRequestId);
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/activate`, { method: 'POST' });
    if (result?.project) applyCodexProjectSnapshot(result.project);
    else await loadProject(state.project.id);
    await loadCodexSessionScript(sessionId, chapterId, { force: true }).catch(() => null);
    renderCodexStudio();
    toast('版本已激活到 Live Script', '现在可以在右侧逐句编辑；原活动版本仍保留在 Session 历史中。');
  } catch (error) {
    toast('无法激活此版本', error.message, 'warn');
  }
}

async function waitForPendingLineSaves(projectId, requestId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const hasPending = () => [...state.saveTimers.keys()].some((key) => key.startsWith(`${projectId}:`));
  while (hasPending() && Date.now() < deadline) {
    if (requestId !== state.codexRequestId) return false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (hasPending()) throw new Error('仍有台词正在自动保存，请稍后再发送给协作后端。');
  const failed = [...state.lineSaveErrors.entries()].filter(([key]) => key.startsWith(`${projectId}:`));
  if (failed.length) throw new Error(`有 ${failed.length} 句台词自动保存失败，请重新修改并保存后再发送给协作后端。`);
  return requestId === state.codexRequestId;
}

async function submitCodexMessage() {
  if (codexRoomBusy()) return;
  rememberCodexComposer();
  const provider = normalizeCollaborationProvider($('#codex-provider')?.value ?? state.codexProvider);
  const readiness = collaborationReadiness(provider);
  if (!readiness.ready) {
    const advice = provider === 'codex'
      ? (readiness.authRequired ? '请点击左侧“登录 Codex”完成官方网页登录，或使用任务包交接。' : '请使用任务包完成手工交接。')
      : '请确认 Ollama 已启动，并在模型中心检查本地服务地址和模型。';
    return toast(readiness.label, advice, 'warn');
  }
  const prompt = String($('#codex-chat-prompt')?.value || codexDraft()).trim();
  if (!prompt) return toast('先写下本轮目标', `说明希望${scriptSourceLabel(provider)}生成或调整什么内容。`, 'warn');
  const projectId = state.project?.id;
  const chapterId = currentChapter()?.id;
  if (!projectId || !chapterId) return;
  const selectedVersion = currentCodexVersion();
  const sessionId = selectedVersion?.id || null;
  const rawModel = String($('#codex-model')?.value ?? state.codexModel ?? '').trim();
  if (rawModel && !CODEX_MODEL_PATTERN.test(rawModel)) {
    return toast('模型 ID 格式不正确', '请使用字母或数字开头，最多 100 个字符。', 'warn');
  }
  const model = normalizeCodexModel(rawModel, collaborationModelDefault(provider));
  const reasoningEffort = normalizeCodexReasoningEffort(
    $('#codex-reasoning-effort')?.value ?? state.codexReasoningEffort ?? currentCodexSession()?.reasoningEffort
  );
  const timeoutMinutes = parseCodexTimeoutMinutes($('#codex-timeout-minutes')?.value);
  if (timeoutMinutes === null) {
    return toast('任务超时设置无效', '请输入 5–120 的整数分钟数。', 'warn');
  }
  const mode = String($('#codex-room-mode')?.value || currentCodexSession()?.mode || state.codexMode || 'faithful');
  const detailLevel = state.codexActivityVisible ? 'summary' : 'basic';
  state.codexProgressRecoveryId += 1;
  const requestId = ++state.codexRequestId;
  state.codexProvider = provider;
  state.codexModel = model;
  state.codexReasoningEffort = reasoningEffort;
  state.codexTimeoutMinutes = timeoutMinutes;
  state.codexMode = mode;
  state.codexBusy = true;
  setCurrentCodexError('');
  const promptDraftKey = codexDraftKey(sessionId);
  state.codexDrafts.set(promptDraftKey, prompt);
  renderCodexStudio();
  try {
    if (!(await waitForPendingLineSaves(projectId, requestId))) return;
    const endpoint = sessionId
      ? `/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/messages`
      : `/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions`;
    const runtimeOptions = {
      provider,
      model,
      ...(provider === 'codex' ? { reasoningEffort } : {}),
      timeoutMinutes,
      prompt,
      stream: true,
      detailLevel
    };
    const body = sessionId ? runtimeOptions : { mode, ...runtimeOptions };
    const result = await api(endpoint, { method: 'POST', body });
    if (requestId !== state.codexRequestId) return;
    if (result?.progressId && result?.eventsUrl) {
      const progressSessionId = result.sessionId || result.session?.id || sessionId;
      if (!progressSessionId) throw new Error(`${scriptSourceLabel(provider)}已接收任务，但没有返回 Session。`);
      if (result.session) mergeCodexSessionIntoProject(chapterId, result.session, { authoritative: true });
      state.codexVersionId = progressSessionId;
      state.codexSessionId = progressSessionId;
      state.codexSessionByChapter.set(chapterId, progressSessionId);
      const key = codexProgressKey(projectId, chapterId, progressSessionId);
      const progress = createCodexProgressSnapshot(result, {
        projectId,
        chapterId,
        sessionId: progressSessionId,
        detailLevel,
        provider,
        model,
        reasoningEffort,
        timeoutMinutes,
        promptDraftKey
      });
      if (!progress) throw new Error(`${scriptSourceLabel(provider)}已接收任务，但返回的进度地址无效。`);
      state.codexProgressBySession.set(key, progress);
      state.codexBusy = false;
      setCurrentCodexError('', projectId, chapterId, progressSessionId);
      renderCodexStudio();
      connectCodexProgress(progress);
      toast(`${scriptSourceLabel(provider)}已开始后台处理`, '现在可以返回制作台，稍后再进入协作页查看进度。');
      return;
    }
    if (result.project && state.project?.id === projectId) applyCodexProjectSnapshot(result.project);
    state.codexSessionId = result.session?.id || sessionId;
    state.codexVersionId = state.codexSessionId;
    state.codexProvider = normalizeCollaborationProvider(result.session?.provider, provider);
    state.codexModel = normalizeCodexModel(result.session?.model, model);
    state.codexReasoningEffort = normalizeCodexReasoningEffort(result.session?.reasoningEffort, reasoningEffort);
    state.codexTimeoutMinutes = normalizeCodexTimeoutMinutes(result.session?.timeoutMinutes, timeoutMinutes);
    if (state.codexSessionId) state.codexSessionByChapter.set(chapterId, state.codexSessionId);
    state.codexDrafts.delete(promptDraftKey);
    state.codexDrafts.set(`${chapterId}:${state.codexSessionId || 'new'}`, '');
    state.codexBusy = false;
    setCurrentCodexError('', projectId, chapterId, state.codexSessionId);
    renderCodexStudio({ focus: 'composer' });
    toast(`${scriptSourceLabel(state.codexProvider)}已更新本章剧本`, '可以继续对话，或在右侧逐句微调。');
  } catch (error) {
    if (requestId !== state.codexRequestId) return;
    state.codexBusy = false;
    if (error.status === 409 && ['SCRIPT_SESSION_ACTIVE', 'CODEX_PROGRESS_ACTIVE'].includes(error.code)) {
      setCurrentCodexError('');
      await recoverCodexProgress();
      if (requestId !== state.codexRequestId) return;
      renderCodexStudio();
      toast('已接回本章后台任务', '当前任务仍在运行，可以继续查看进度。', 'warn');
      return;
    }
    const safeError = error.code === 'CODEX_TIMEOUT_MINUTES_INVALID'
      ? '任务超时必须是 5–120 的整数分钟数。'
      : error.message;
    setCurrentCodexError(safeError);
    renderCodexStudio({ focus: 'composer' });
  }
}

function demoRenderModalHtml(scope, lineId = '') {
  return `<header class="modal-head"><div><span class="eyebrow">MODEL WORKER OFFLINE</span><h2>模型工作器尚未启动</h2></div><button class="icon-button" data-action="close-modal">×</button></header><div class="modal-body"><div class="modal-note">真实语音需要先安装并启动独立的 Python 模型环境。你仍可生成明确标记的“演示音轨”（非人声，仅用于验证队列、试听与导出流程）。</div><p style="color:var(--muted);font-size:10px;line-height:1.7">安装脚本位于项目 <code>scripts/setup-worker.ps1</code>；也可以先进入模型中心查看当前硬件推荐。</p></div><footer class="modal-foot"><button class="button ghost" data-nav="models">前往模型中心</button><button class="button demo" data-action="confirm-demo-render" data-scope="${escapeHtml(scope)}" data-line-id="${escapeHtml(lineId)}">生成演示音轨（非人声）</button></footer>`;
}

function missingVoicesModalHtml(scope, lineId, missing, targetCount) {
  return `<header class="modal-head"><div><span class="eyebrow">VOICE SETUP REQUIRED</span><h2>先为角色准备可用音色</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <div class="modal-body"><div class="modal-note">本次真实生成包含 ${targetCount} 个片段。以下角色尚未绑定“已就绪且带参考录音”的音色，因此真实语音任务尚未提交。</div>
      <div class="missing-voice-list">${missing.map((item) => `<div class="missing-voice-item"><span class="missing-voice-avatar" style="--speaker:${escapeHtml(item.color)}">${escapeHtml([...(item.name || '角')][0])}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.reason)} · 涉及 ${item.count} 个片段</small></div></div>`).join('')}</div>
      <p class="demo-explainer">如果只想先验证队列、试听和导出流程，可以生成明确标记的演示音轨；它是提示信号，不包含人声。</p>
    </div><footer class="modal-foot missing-voice-actions"><div><button class="button primary" data-action="new-voice">＋ 制作新音色</button><button class="button ghost" data-nav="voices">去音色库</button></div><button class="button demo" data-action="confirm-demo-render" data-scope="${escapeHtml(scope)}" data-line-id="${escapeHtml(lineId)}">生成演示音轨（非人声）</button></footer>`;
}

function renderFailureOutcome(job) {
  const failed = Math.max(0, Number(job.result?.failed || 0));
  if (!failed) return null;
  const rendered = Math.max(0, Number(job.result?.rendered || 0));
  const partial = rendered > 0;
  const firstError = job.result?.errors?.find((item) => item?.message)?.message || '';
  const summary = `${partial ? `${rendered} 个已生成，` : ''}${failed} 个片段生成失败${firstError ? `：${firstError}` : '。'}`;
  return {
    failed, rendered, partial, summary,
    className: partial ? 'warning' : 'failed',
    status: partial ? '部分失败' : '生成失败',
    type: partial ? 'warn' : 'error'
  };
}

function scriptBatchJobHtml(job) {
  const chapterIds = Array.isArray(job.payload?.chapterIds) ? job.payload.chapterIds.filter((value) => typeof value === 'string') : [];
  if (job.type !== 'script' || chapterIds.length < 2) return '';
  const resultRows = Array.isArray(job.result?.chapters)
    ? job.result.chapters
    : Array.isArray(job.chapterResults) ? job.chapterResults : [];
  const results = new Map(resultRows
    .filter((row) => row && chapterIds.includes(row.chapterId) && ['completed', 'failed'].includes(row.state))
    .map((row) => [row.chapterId, row.state]));
  const processedEstimate = ['completed', 'failed'].includes(job.state)
    ? chapterIds.length
    : Math.min(chapterIds.length, Math.floor((Math.max(0, Number(job.progress) || 0) / 100) * chapterIds.length));
  const rows = chapterIds.map((chapterId, index) => {
    const chapter = state.project?.chapters?.find((item) => item.id === chapterId);
    const resultState = results.get(chapterId);
    const inferred = resultState || (index < processedEstimate ? 'processed' : job.state === 'running' && index === processedEstimate ? 'running' : 'queued');
    const label = ({ completed: '已完成', failed: '未完成', processed: '已处理', running: '处理中', queued: '等待中' })[inferred] || '等待中';
    return `<li class="${inferred}"><span>${escapeHtml(chapter?.title || `章节 ${index + 1}`)}</span><em>${label}</em></li>`;
  }).join('');
  const successCount = Math.max(0, Number(job.result?.successCount) || 0);
  const failureCount = Math.max(0, Number(job.result?.failureCount) || 0);
  const summary = ['completed', 'failed'].includes(job.state)
    ? `${successCount} 章成功 · ${failureCount} 章未完成`
    : `按章节串行处理 · ${chapterIds.length} 章`;
  return `<div class="batch-job-detail"><strong>${escapeHtml(summary)}</strong><ol>${rows}</ol></div>`;
}

function jobCardHtml(job) {
  const failure = renderFailureOutcome(job);
  const batchScript = job.type === 'script' && Array.isArray(job.payload?.chapterIds) && job.payload.chapterIds.length > 1;
  const batchFailures = batchScript ? Math.max(0, Number(job.result?.failureCount) || 0) : 0;
  const className = batchFailures ? 'warning' : failure?.className || job.state;
  const status = batchFailures ? '部分完成' : failure?.status || statusLabels[job.state] || job.state;
  const message = batchScript
    ? (['completed', 'failed'].includes(job.state) ? '逐章结果如下；失败章节可单独重试。' : '模型章节按队列串行运行；关闭任务抽屉不会停止处理。')
    : failure?.summary || `${job.message || ''}${job.error ? ` · ${job.error.message}` : ''}`;
  return `<article class="job-card ${className}"><div class="job-card-head"><strong>${escapeHtml(jobLabels[job.type] || job.type)}</strong><span>${escapeHtml(status)} · ${job.progress}%</span></div><div class="meter"><span style="width:${job.progress}%"></span></div><p>${escapeHtml(message)}</p>${scriptBatchJobHtml(job)}${job.result?.mediaUrl ? `<a class="job-download" href="${job.result.mediaUrl}" download="${escapeHtml(job.result.fileName || 'audiobook.wav')}">⇩ 下载 ${escapeHtml(job.result.fileName || 'WAV')}</a>` : ''}</article>`;
}

function jobCompletionNotice(job) {
  const label = jobLabels[job.type] || '任务';
  if (job.type === 'script' && Array.isArray(job.result?.chapters)) {
    const successCount = Math.max(0, Number(job.result.successCount) || 0);
    const failureCount = Math.max(0, Number(job.result.failureCount) || 0);
    return { title: failureCount ? '批量转脚本部分完成' : '批量转脚本完成', message: `${successCount} 章成功 · ${failureCount} 章未完成`, type: failureCount ? 'warn' : 'success' };
  }
  if (job.state === 'failed') return { title: `${label}失败`, message: job.error?.message || job.message, type: 'error' };
  const failure = renderFailureOutcome(job);
  if (failure) return { title: `${label}${failure.partial ? '部分失败' : '失败'}`, message: failure.summary, type: failure.type };
  if (job.result?.demo) return { title: `${label}完成`, message: '已生成演示音轨，真实 TTS 启动并绑定音色后可重新生成。', type: 'warn' };
  return { title: `${label}完成`, message: job.message, type: 'success' };
}

function renderJobs() {
  if (!state.bootstrap) return;
  const list = state.bootstrap.jobs || [];
  $('#job-list').innerHTML = list.length ? list.map(jobCardHtml).join('') : '<div class="job-empty">暂无生产任务</div>';
  const active = list.filter((job) => ['queued', 'running'].includes(job.state)).length;
  $('#job-count').textContent = active;
}

async function trackJob(job) {
  state.watchedJobs.add(job.id);
  state.bootstrap.jobs = [job, ...state.bootstrap.jobs.filter((item) => item.id !== job.id)];
  renderJobs();
  openJobs();
  if (!state.jobTimer) state.jobTimer = setInterval(pollJobs, 850);
}

async function pollJobs() {
  try {
    const jobs = await api('/api/jobs');
    state.bootstrap.jobs = jobs;
    renderJobs();
    let changed = false;
    for (const job of jobs) {
      if (!state.watchedJobs.has(job.id) || !['completed', 'failed'].includes(job.state) || state.notifiedJobs.has(job.id)) continue;
      state.notifiedJobs.add(job.id);
      changed = true;
      const notice = jobCompletionNotice(job);
      toast(notice.title, notice.message, notice.type, 6000);
    }
    if (changed) {
      await refreshBootstrap();
      if (state.project) await loadProject(state.project.id);
      renderView();
    }
    if (!jobs.some((job) => ['queued', 'running'].includes(job.state))) {
      clearInterval(state.jobTimer); state.jobTimer = null;
    }
  } catch { /* transient polling failure */ }
}

function openJobs() {
  $('#job-drawer').classList.add('open');
  $('#job-drawer').setAttribute('aria-hidden', 'false');
  $('#job-drawer').inert = false;
  $('#drawer-scrim').classList.add('open');
}

function closeJobs() {
  $('#job-drawer').classList.remove('open');
  $('#job-drawer').setAttribute('aria-hidden', 'true');
  $('#job-drawer').inert = true;
  $('#drawer-scrim').classList.remove('open');
}

function chapterNeedsScript(chapter) {
  return !(chapter?.scenes || []).some((scene) => (scene.lines || []).length);
}

function initializeBulkScriptDraft() {
  const chapters = state.project?.chapters || [];
  const validIds = new Set(chapters.map((chapter) => chapter.id));
  for (const chapterId of state.bulkScriptChapterIds) {
    if (!validIds.has(chapterId)) state.bulkScriptChapterIds.delete(chapterId);
  }
  if (!state.bulkScriptChapterIds.size) {
    const unprocessed = chapters.filter(chapterNeedsScript);
    for (const chapter of (unprocessed.length ? unprocessed : chapters.slice(0, 1))) {
      state.bulkScriptChapterIds.add(chapter.id);
    }
  }
  state.bulkScriptModel = normalizeCodexModel(
    state.bulkScriptModel,
    state.bulkScriptProvider === 'ollama' ? collaborationModelDefault('ollama') : DEFAULT_CODEX_MODEL
  );
}

function bulkScriptModalHtml() {
  const chapters = state.project?.chapters || [];
  const provider = ['rules', 'codex', 'ollama'].includes(state.bulkScriptProvider) ? state.bulkScriptProvider : 'rules';
  const selectedCount = chapters.filter((chapter) => state.bulkScriptChapterIds.has(chapter.id)).length;
  const chapterRows = chapters.map((chapter, index) => {
    const lineCount = chapter.scenes?.reduce((total, scene) => total + (scene.lines?.length || 0), 0) || 0;
    return `<label class="bulk-script-chapter"><input type="checkbox" data-bulk-chapter-id="${escapeHtml(chapter.id)}" ${state.bulkScriptChapterIds.has(chapter.id) ? 'checked' : ''} ${state.bulkScriptSubmitting ? 'disabled' : ''}><span><strong>${String(index + 1).padStart(2, '0')} · ${escapeHtml(chapter.title || '未命名章节')}</strong><small>${lineCount ? `已有 ${lineCount} 句脚本` : '未处理'}</small></span></label>`;
  }).join('');
  const runtimeFields = provider === 'rules' ? '' : `<div class="bulk-script-runtime-fields ${provider}">
    <label><span>${provider === 'ollama' ? 'Ollama 模型' : 'Codex 模型'}</span><input class="field" id="bulk-script-model" maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}" value="${escapeHtml(state.bulkScriptModel)}" autocomplete="off" spellcheck="false" ${state.bulkScriptSubmitting ? 'disabled' : ''}></label>
    ${provider === 'codex' ? `<label><span>推理强度</span><select class="select-field" id="bulk-script-effort" ${state.bulkScriptSubmitting ? 'disabled' : ''}>${CODEX_REASONING_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === state.bulkScriptReasoningEffort ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
    <label><span>单章超时（分钟）</span><input class="field" id="bulk-script-timeout" type="number" min="5" max="120" step="1" value="${state.bulkScriptTimeoutMinutes}" ${state.bulkScriptSubmitting ? 'disabled' : ''}></label>
  </div>`;
  return `<header class="modal-head"><div><span class="eyebrow">BATCH SCRIPT</span><h2 id="bulk-script-title">批量转脚本</h2><p>模型章节将按队列串行处理；单章失败不会中止其他章节。</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
    <form id="bulk-script-form" novalidate><div class="modal-body bulk-script-body">
      <div class="bulk-script-options"><label><span>生成后端</span><select class="select-field" id="bulk-script-provider" ${state.bulkScriptSubmitting ? 'disabled' : ''}><option value="rules" ${provider === 'rules' ? 'selected' : ''}>规则</option><option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option><option value="ollama" ${provider === 'ollama' ? 'selected' : ''}>本地 Ollama</option></select></label><label><span>润色风格</span><select class="select-field" id="bulk-script-mode" ${state.bulkScriptSubmitting ? 'disabled' : ''}>${Object.entries(CODEX_MODE_LABELS).map(([value, label]) => `<option value="${value}" ${value === state.bulkScriptMode ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      ${runtimeFields}
      <section class="bulk-script-selection" aria-labelledby="bulk-script-selection-title"><header><div><strong id="bulk-script-selection-title">选择章节</strong><small id="bulk-script-selected-count">已选 ${selectedCount}/${chapters.length}</small></div><div><button class="button ghost small" type="button" data-action="bulk-select-unprocessed">全选未处理</button><button class="button ghost small" type="button" data-action="bulk-select-all">全选</button><button class="button ghost small" type="button" data-action="bulk-clear-selection">清空</button></div></header><div class="bulk-script-range"><span>按范围</span><label><span class="sr-only">起始章节</span><input class="field" id="bulk-range-start" type="number" min="1" max="${chapters.length || 1}" step="1" value="1"></label><span>至</span><label><span class="sr-only">结束章节</span><input class="field" id="bulk-range-end" type="number" min="1" max="${chapters.length || 1}" step="1" value="${chapters.length || 1}"></label><button class="button small" type="button" data-action="bulk-apply-range">应用范围</button></div><div class="bulk-script-chapters">${chapterRows || '<p>项目中还没有章节。</p>'}</div></section>
      <p class="bulk-script-note" role="note">规则模式不会发送模型、推理强度或超时参数；Codex 与 Ollama 会为每章创建独立 Session / 版本。</p>
    </div><footer class="modal-foot"><span id="bulk-script-submit-status" role="status" aria-live="polite">${selectedCount ? `将提交 ${selectedCount} 章` : '请至少选择一章'}</span><div><button class="button ghost" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" ${!selectedCount || state.bulkScriptSubmitting ? 'disabled' : ''}>${state.bulkScriptSubmitting ? '正在提交…' : '提交批量任务'}</button></div></footer></form>`;
}

function showBulkScriptModal({ focus = '' } = {}) {
  initializeBulkScriptDraft();
  showModal(bulkScriptModalHtml(), 'wide bulk-script-modal');
  $('#modal-root .bulk-script-modal')?.setAttribute('aria-labelledby', 'bulk-script-title');
  if (focus) requestAnimationFrame(() => $(`#${CSS.escape(focus)}`)?.focus());
}

function selectBulkScriptChapters(predicate) {
  state.bulkScriptChapterIds.clear();
  for (const [index, chapter] of (state.project?.chapters || []).entries()) {
    if (predicate(chapter, index)) state.bulkScriptChapterIds.add(chapter.id);
  }
  showBulkScriptModal();
}

async function submitBulkScript() {
  if (state.bulkScriptSubmitting || !state.project) return;
  state.bulkScriptProvider = ['rules', 'codex', 'ollama'].includes($('#bulk-script-provider')?.value)
    ? $('#bulk-script-provider').value
    : state.bulkScriptProvider;
  state.bulkScriptMode = CODEX_MODE_LABELS[$('#bulk-script-mode')?.value]
    ? $('#bulk-script-mode').value
    : state.bulkScriptMode;
  if ($('#bulk-script-model')) state.bulkScriptModel = $('#bulk-script-model').value.trim();
  if ($('#bulk-script-effort')) state.bulkScriptReasoningEffort = normalizeCodexReasoningEffort($('#bulk-script-effort').value);
  if ($('#bulk-script-timeout')) state.bulkScriptTimeoutMinutes = $('#bulk-script-timeout').value;
  const chapters = state.project.chapters || [];
  const chapterIds = chapters.filter((chapter) => state.bulkScriptChapterIds.has(chapter.id)).map((chapter) => chapter.id);
  if (!chapterIds.length) return toast('还没有选择章节', '请至少选择一章后再提交。', 'warn');
  const provider = ['rules', 'codex', 'ollama'].includes(state.bulkScriptProvider) ? state.bulkScriptProvider : 'rules';
  const mode = CODEX_MODE_LABELS[state.bulkScriptMode] ? state.bulkScriptMode : 'faithful';
  const body = { chapterIds, provider, mode };
  if (provider !== 'rules') {
    const model = String(state.bulkScriptModel || '').trim();
    if (!CODEX_MODEL_PATTERN.test(model)) return toast('模型 ID 格式不正确', '请使用字母或数字开头，最多 100 个字符。', 'warn');
    const timeoutMinutes = parseCodexTimeoutMinutes(state.bulkScriptTimeoutMinutes);
    if (timeoutMinutes === null) return toast('超时设置无效', '请输入 5–120 的整数分钟数。', 'warn');
    body.model = model;
    body.timeoutMinutes = timeoutMinutes;
    state.bulkScriptTimeoutMinutes = timeoutMinutes;
    if (provider === 'codex') body.reasoningEffort = normalizeCodexReasoningEffort(state.bulkScriptReasoningEffort);
  }
  state.bulkScriptSubmitting = true;
  showBulkScriptModal();
  try {
    const jobs = await api('/api/jobs');
    state.bootstrap.jobs = jobs;
    const conflicts = jobs.filter((job) => job.type === 'script' && ['queued', 'running'].includes(job.state))
      .flatMap((job) => Array.isArray(job.payload?.chapterIds) ? job.payload.chapterIds : [])
      .filter((chapterId) => chapterIds.includes(chapterId));
    if (conflicts.length) {
      state.bulkScriptSubmitting = false;
      showBulkScriptModal();
      toast('所选章节已有剧本任务', '请移除正在排队或处理的章节，避免重复提交。', 'warn');
      return;
    }
    const job = await api(`/api/projects/${encodeURIComponent(state.project.id)}/script`, { method: 'POST', body });
    state.bulkScriptSubmitting = false;
    closeModal();
    await trackJob(job);
    toast('批量转脚本任务已提交', `${chapterIds.length} 章 · ${scriptSourceLabel(provider)} · ${CODEX_MODE_LABELS[mode]}`);
  } catch (error) {
    state.bulkScriptSubmitting = false;
    showBulkScriptModal();
    toast('批量任务没有提交', error.message, 'error');
  }
}

async function runRulesScript() {
  if (state.ruleScriptSubmitting) return;
  const chapter = currentChapter();
  if (!chapter || !state.project) return;
  if (activeScriptJobForChapter(chapter.id)) {
    toast('本章已有剧本任务', '请等待当前规则或模型剧本任务完成后再提交。', 'warn');
    return;
  }
  if (chapterHasActiveCollaboration(chapter.id)) {
    toast('本章协作任务仍在运行', '请等待后台任务完成，再使用规则一键生成，避免版本冲突。', 'warn');
    return;
  }
  try {
    const [jobs] = await Promise.all([
      api('/api/jobs'),
      refreshCodexProjectSnapshot(state.project.id)
    ]);
    state.bootstrap.jobs = jobs;
    if (activeScriptJobForChapter(chapter.id)) {
      toast('本章已有剧本任务', '请等待当前规则或模型剧本任务完成后再提交。', 'warn');
      renderView();
      return;
    }
    if (chapterHasActiveCollaboration(chapter.id)) {
      toast('本章协作任务仍在运行', '请等待后台任务完成，再使用规则一键生成，避免版本冲突。', 'warn');
      return;
    }
  } catch (error) {
    toast('暂时无法确认本章任务状态', '为避免覆盖后台协作结果，本次没有启动规则生成；请稍后重试。', 'warn');
    return;
  }
  state.ruleScriptSubmitting = true;
  renderView();
  try {
    const job = await api(`/api/projects/${encodeURIComponent(state.project.id)}/script`, {
      method: 'POST',
      body: { chapterIds: [chapter.id], provider: 'rules', mode: 'faithful' }
    });
    toast('规则剧本任务已提交', `${chapter.title} · 忠实朗读`, 'success');
    trackJob(job);
  } finally {
    state.ruleScriptSubmitting = false;
    if (state.view === 'studio') renderView();
  }
}

function closeVoiceBindingDrawer() {
  const dirtyCount = voiceBindingDraftEntries().length;
  stopVoiceBindingPreview({ clear: true });
  state.voiceBindingPickerRoleId = '';
  state.voiceBindingOpen = false;
  renderView();
  requestAnimationFrame(() => $('[data-action="toggle-voice-binding"]')?.focus());
  if (dirtyCount) toast('音色绑定草稿已保留', `${dirtyCount} 项更改尚未写入项目；重新打开侧栏可继续。`, 'warn');
}

function discardVoiceBindings() {
  if (state.voiceBindingSaving) return;
  stopVoiceBindingPreview({ clear: true });
  state.voiceBindingPickerRoleId = '';
  state.voiceBindingDraft.clear();
  renderView();
  requestAnimationFrame(() => $('[data-action="discard-voice-bindings"]')?.focus());
}

async function saveVoiceBindings() {
  if (state.voiceBindingSaving || !state.project) return;
  const assignments = voiceBindingDraftEntries();
  if (!assignments.length) return;
  stopVoiceBindingPreview({ clear: true });
  state.voiceBindingPickerRoleId = '';
  state.voiceBindingSaving = true;
  renderView();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/characters/voices`, {
      method: 'PATCH', body: { assignments }
    });
    const updatedProject = result?.project || result;
    if (!updatedProject?.id) throw new Error('服务未返回更新后的项目，请重新检测后再试。');
    applyCodexProjectSnapshot(updatedProject);
    state.voiceBindingDraft.clear();
    toast('角色音色已批量保存', `已原子更新 ${assignments.length} 个角色；现在可以继续生成语音。`);
  } catch (error) {
    toast('批量绑定没有保存', `${error.message}；全部本地草稿仍保留，可修正后重试。`, 'error');
  } finally {
    state.voiceBindingSaving = false;
    if (state.view === 'studio') renderView();
  }
}

async function openCodexPackage(modeOverride = '') {
  rememberCodexComposer();
  const mode = modeOverride || $('input[name="script-mode"]:checked')?.value || state.codexMode || 'faithful';
  state.codexMode = CODEX_MODE_LABELS[mode] ? mode : 'faithful';
  const chapter = currentChapter();
  state.codexPackage = await api(`/api/projects/${state.project.id}/chapters/${chapter.id}/codex-package?mode=${encodeURIComponent(state.codexMode)}`);
  showModal(codexImportModalHtml(state.codexPackage.prompt), 'wide');
}

async function importCodexResult() {
  const raw = $('#codex-result')?.value.trim();
  if (!raw) return toast('还没有 JSON', '请先粘贴 Codex 返回的结构化结果。', 'warn');
  const chapter = currentChapter();
  try {
    const importedProject = await api(`/api/projects/${state.project.id}/chapters/${chapter.id}/script-import`, { method: 'POST', body: { script: raw } });
    applyCodexProjectSnapshot(importedProject);
    closeModal(); renderView(); toast('Codex 剧本已导入', '角色、情绪和停顿已写入当前章节。');
  } catch (error) { toast('导入失败', error.message, 'error'); }
}

async function requestRender(scope, lineId = '', demoFallback = false) {
  const targets = renderTargetsForScope(scope, lineId);
  if (!targets.length) return toast('没有可生成的台词', '当前范围没有包含朗读文本的旁白或对白。', 'warn');
  const lineIds = scope === 'line' || scope === 'chapter' ? targets.map((line) => line.id) : [];
  if (!demoFallback) {
    const missing = missingVoicesForLines(targets);
    if (missing.length) {
      showModal(missingVoicesModalHtml(scope, lineId, missing, targets.length));
      return;
    }
    if (!state.bootstrap.system.worker.online) {
      showModal(demoRenderModalHtml(scope, lineId));
      return;
    }
  }
  closeModal();
  const job = await api(`/api/projects/${state.project.id}/render`, { method: 'POST', body: { lineIds, demoFallback } });
  toast(demoFallback ? '演示音轨任务已提交' : '语音任务已提交', `共 ${targets.length} 个片段${demoFallback ? ' · 非人声' : ''}`, demoFallback ? 'warn' : 'success');
  trackJob(job);
}

async function exportProject() {
  try {
    const job = await api(`/api/projects/${state.project.id}/export`, { method: 'POST', body: { format: 'wav' } });
    toast('导出任务已提交', '完成后可在任务结果中打开 WAV。'); trackJob(job);
  } catch (error) { toast('暂时无法导出', error.message, 'error'); }
}

function scheduleLineSave(lineId, patch) {
  const projectId = state.project?.id;
  if (!projectId) return;
  invalidateCodexProjectRefresh(projectId);
  const key = `${projectId}:${lineId}`;
  state.lineSaveErrors.delete(key);
  const current = state.saveTimers.get(key);
  if (current) clearTimeout(current.timer);
  const merged = { ...(current?.patch || {}), ...patch };
  const revision = (current?.revision || 0) + 1;
  const localLine = findLine(lineId);
  if (localLine) {
    Object.assign(localLine, patch);
    if (patch.speakerId) {
      const role = state.project.characters.find((item) => item.id === patch.speakerId);
      if (role) { localLine.speaker = role.name; localLine.needsReview = false; }
    }
    localLine.render = { status: 'stale' };
  }
  const record = { timer: null, patch: merged, revision, projectId };
  record.timer = setTimeout(async () => {
    try {
      const savedProject = await api(`/api/projects/${projectId}/lines/${lineId}`, { method: 'PATCH', body: merged });
      if (state.saveTimers.get(key) !== record || state.project?.id !== projectId) return;
      invalidateCodexProjectRefresh(projectId);
      const savedLine = findLineInProject(savedProject, lineId);
      const currentLine = findLine(lineId);
      if (savedLine && currentLine) Object.assign(currentLine, savedLine);
      state.project.updatedAt = savedProject.updatedAt;
      state.lineSaveErrors.delete(key);
    } catch (error) {
      state.lineSaveErrors.set(key, error.message || '自动保存失败');
      toast('自动保存失败', error.message, 'error');
    }
    finally {
      if (state.saveTimers.get(key) === record) state.saveTimers.delete(key);
    }
  }, 480);
  state.saveTimers.set(key, record);
}

function updateTransportForSelection() {
  if (state.loadedAudio?.kind === 'voice-binding') {
    const voice = state.bootstrap?.voices?.find((item) => item.id === state.loadedAudio.voiceId);
    $('#transport-title').textContent = voice?.name || '音色参考原声';
    $('#transport-subtitle').textContent = '角色绑定 · 音色参考原声';
    return;
  }
  const line = findLine(state.selectedLineId);
  if (!line) return;
  $('#transport-title').textContent = line.spokenText || '空白片段';
  $('#transport-subtitle').textContent = `${line.speaker} · ${emotionLabel(line.emotion)}${line.render?.demo ? ' · 演示音轨' : ''}`;
  $('.mini-avatar').textContent = [...(line.speaker || '旁')][0];
}

async function playLine(lineId) {
  const line = findLine(lineId);
  if (line?.render?.status === 'failed') {
    const detail = typeof line.render.error === 'string' ? line.render.error : line.render.error?.message;
    toast('这一句生成失败', detail || '模型未返回具体错误，请重新生成或查看任务队列。', 'error', 6500);
    return;
  }
  if (!line?.render?.mediaUrl) {
    toast('还没有音频', '先点击生成按钮为这一句创建音频。', 'warn'); return;
  }
  selectStudioLine(lineId);
  updateTransportForSelection();
  const audio = $('#audio-player');
  if (audio.src !== new URL(line.render.mediaUrl, location.href).href) audio.src = line.render.mediaUrl;
  state.loadedAudio = { kind: 'line', id: lineId, url: line.render.mediaUrl };
  try { await audio.play(); $('.play-main').textContent = 'Ⅱ'; } catch (error) {
    if (error?.name !== 'AbortError') toast('无法播放', error.message, 'error');
  }
}

function stepLine(direction) {
  const lines = currentChapter()?.scenes?.flatMap((scene) => scene.lines || []) || [];
  if (!lines.length) return;
  const index = Math.max(0, lines.findIndex((line) => line.id === state.selectedLineId));
  const next = lines[(index + direction + lines.length) % lines.length];
  selectStudioLine(next.id);
  if (next.render?.mediaUrl) playLine(next.id);
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('浏览器不支持录音', '请改用导入音频。', 'error');
  try {
    stopRecorderTracks({ discard: true });
    const session = ++state.recordingSession;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
    if (session !== state.recordingSession) { stream.getTracks().forEach((track) => track.stop()); return; }
    state.recorderStream = stream;
    const chunks = [];
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.recorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      if (session !== state.recordingSession) { stream.getTracks().forEach((track) => track.stop()); return; }
      state.recordingBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      stream.getTracks().forEach((track) => track.stop());
      state.recorderStream = null;
      $('#record-button')?.classList.remove('recording');
      if ($('#record-status')) $('#record-status').textContent = `录音完成 · ${(state.recordingBlob.size / 1024).toFixed(0)} KB，可保存到音色库`;
    };
    recorder.start(250);
    $('#record-button').classList.add('recording');
    $('#record-status').textContent = '正在录音… 再次点击停止';
  } catch (error) { toast('无法使用麦克风', error.message, 'error'); }
}

function mediaKindForFile(file) {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  if (['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'].includes(extension)) return 'video';
  if (['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'].includes(extension)) return 'audio';
  return null;
}

function activeVoiceSourcePreview() {
  return state.voiceSourceKind === 'video' ? $('#voice-source-preview-video') : $('#voice-source-preview-audio');
}

function validateVoiceClip() {
  if (!state.voiceSourceFile) return { valid: false, message: '请先选择一个视频或音频文件。', length: 0 };
  if (!Number.isFinite(state.voiceSourceDuration) || state.voiceSourceDuration <= 0) return { valid: false, message: '正在读取媒体时长，或浏览器无法预览该格式。', length: 0 };
  const start = Number(state.voiceClipStart);
  const end = Number(state.voiceClipEnd);
  const length = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return { valid: false, message: '终点必须晚于起点。', length };
  if (end > state.voiceSourceDuration + 0.05) return { valid: false, message: '终点不能超过原始媒体时长。', length };
  if (length < 3) return { valid: false, message: `当前仅 ${Math.max(0, length).toFixed(1)} 秒；音色素材至少需要 3 秒。`, length };
  if (length > 60) return { valid: false, message: `当前 ${length.toFixed(1)} 秒；单个音色素材最长 60 秒。`, length };
  return { valid: true, message: `片段可用 · ${length.toFixed(1)} 秒。请确保只有一位说话人，并逐字填写准确台词。`, length };
}

function updateVoiceClipUi() {
  const duration = Number(state.voiceSourceDuration) || 0;
  const startInput = $('#voice-clip-start');
  const endInput = $('#voice-clip-end');
  if (startInput) { startInput.max = duration || 0; startInput.value = Number(state.voiceClipStart || 0).toFixed(1); }
  if (endInput) { endInput.max = duration || 0; endInput.value = Number(state.voiceClipEnd || 0).toFixed(1); }
  const outcome = validateVoiceClip();
  if ($('#voice-source-duration')) $('#voice-source-duration').textContent = `总时长 ${duration ? formatTime(duration) : '--:--'}`;
  if ($('#voice-clip-duration')) $('#voice-clip-duration').textContent = `选中 ${Math.max(0, outcome.length).toFixed(1)} 秒`;
  const validation = $('#voice-clip-validation');
  if (validation) {
    validation.textContent = outcome.message;
    validation.classList.toggle('valid', outcome.valid);
    validation.classList.toggle('invalid', !outcome.valid);
  }
  const clipWindow = $('#voice-clip-window');
  if (clipWindow) {
    const left = duration ? Math.max(0, Math.min(100, state.voiceClipStart / duration * 100)) : 0;
    const right = duration ? Math.max(left, Math.min(100, state.voiceClipEnd / duration * 100)) : 0;
    clipWindow.style.left = `${left}%`;
    clipWindow.style.width = `${Math.max(0, right - left)}%`;
  }
  const submit = $('#voice-submit-button');
  if (submit && state.voiceTab === 'clip' && !state.voiceSourceUploadController) submit.disabled = !outcome.valid;
  return outcome;
}

function loadVoiceSourceFile(file) {
  resetVoiceSource({ discardRemote: true });
  const kind = mediaKindForFile(file);
  if (!file || !kind) {
    toast('不支持的媒体文件', '请选择音频或视频文件。', 'warn');
    const input = $('#modal-voice-source-file');
    if (input) input.value = '';
    updateVoiceClipUi();
    return;
  }
  const sourceLimit = Number(state.bootstrap?.app?.limits?.voiceSourceBytes) || 1024 * 1024 * 1024;
  if (file.size > sourceLimit) {
    toast('媒体文件过大', `单个来源最大 ${(sourceLimit / 1024 / 1024).toFixed(0)} MB。`, 'warn');
    const input = $('#modal-voice-source-file');
    if (input) input.value = '';
    updateVoiceClipUi();
    return;
  }
  const session = state.voiceSourceSession;
  state.voiceSourceFile = file;
  state.voiceSourceKind = kind;
  state.voiceSourceObjectUrl = URL.createObjectURL(file);
  state.voiceExtractSubmitted = false;
  const label = $('#voice-source-file-label');
  if (label) label.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · ${kind === 'video' ? '视频' : '音频'}`;
  const editor = $('#voice-clip-editor');
  if (editor) editor.hidden = false;
  const video = $('#voice-source-preview-video');
  const audio = $('#voice-source-preview-audio');
  const preview = kind === 'video' ? video : audio;
  const other = kind === 'video' ? audio : video;
  if (other) { other.pause(); other.removeAttribute('src'); other.hidden = true; }
  if (!preview) return;
  preview.hidden = false;
  preview.src = state.voiceSourceObjectUrl;
  preview.onloadedmetadata = () => {
    if (session !== state.voiceSourceSession) return;
    const duration = Number(preview.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      updateVoiceClipUi();
      return toast('无法读取媒体时长', '请换用浏览器可预览的 MP4、WebM、WAV、MP3 或 M4A。', 'error');
    }
    state.voiceSourceDuration = duration;
    state.voiceClipStart = 0;
    state.voiceClipEnd = Math.min(30, duration);
    if ($('#voice-preview-position')) $('#voice-preview-position').textContent = `00:00 / ${formatTime(duration)}`;
    updateVoiceClipUi();
  };
  preview.ontimeupdate = () => {
    if (session !== state.voiceSourceSession) return;
    if ($('#voice-preview-position')) $('#voice-preview-position').textContent = `${formatTime(preview.currentTime)} / ${formatTime(state.voiceSourceDuration)}`;
    if (state.voiceClipPreviewing && preview.currentTime >= state.voiceClipEnd - 0.03) {
      preview.pause();
      state.voiceClipPreviewing = false;
      const button = $('#voice-clip-play');
      if (button) button.textContent = '▶ 试听选中片段';
    }
  };
  preview.onpause = () => {
    if (session !== state.voiceSourceSession || !state.voiceClipPreviewing) return;
    state.voiceClipPreviewing = false;
    const button = $('#voice-clip-play');
    if (button) button.textContent = '▶ 试听选中片段';
  };
  preview.onerror = () => {
    if (session !== state.voiceSourceSession) return;
    state.voiceSourceDuration = 0;
    updateVoiceClipUi();
    toast('本地预览失败', '浏览器不支持该媒体编码，请换用常见的音频或视频格式。', 'error');
  };
  preview.load();
  updateVoiceClipUi();
}

function switchVoiceTab(tab) {
  if (!['record', 'upload', 'clip'].includes(tab)) return;
  if (state.voiceExtractSubmitting) {
    toast('正在提交裁剪任务', '取得任务编号后会自动关闭窗口。', 'warn');
    return;
  }
  if (state.voiceTab === 'clip' && tab !== 'clip') resetVoiceSource({ discardRemote: true });
  if (tab !== 'record') { stopRecorderTracks({ discard: true }); state.recordingBlob = null; }
  if (tab !== 'upload') state.voiceFile = null;
  if (tab === 'clip') {
    stopRecorderTracks({ discard: true });
    state.recordingBlob = null;
    state.voiceFile = null;
  }
  state.voiceTab = tab;
  $$('.voice-tabs [role="tab"]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $('#voice-record-pane').hidden = tab !== 'record';
  $('#voice-upload-pane').hidden = tab !== 'upload';
  $('#voice-clip-pane').hidden = tab !== 'clip';
  const submit = $('#voice-submit-button');
  if (submit) {
    submit.textContent = tab === 'clip' ? '上传并裁剪到音色库' : '保存到音色库';
    submit.disabled = tab === 'clip' && !validateVoiceClip().valid;
  }
  if (tab === 'clip') updateVoiceClipUi();
}

async function uploadVoiceSource(file, session) {
  if (state.voiceSourceId) return { id: state.voiceSourceId };
  const controller = new AbortController();
  state.voiceSourceUploadController = controller;
  const response = await fetch(`/api/voice-sources?fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    signal: controller.signal
  });
  const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.message || payload.detail || '原始媒体上传失败');
  const sourceId = payload.id || payload.sourceId;
  if (!sourceId) throw new Error('服务器未返回媒体 source id');
  if (session !== state.voiceSourceSession) {
    discardRemoteVoiceSource(sourceId);
    throw new DOMException('上传已取消', 'AbortError');
  }
  state.voiceSourceId = sourceId;
  return { ...payload, id: sourceId };
}

async function submitVoiceClip(form) {
  const outcome = updateVoiceClipUi();
  if (!outcome.valid) return toast('裁剪范围不可用', outcome.message, 'warn');
  const worker = state.bootstrap?.system?.worker;
  if (!worker?.online) return toast('模型工作器未启动', '请先启动模型工作器，再上传长媒体。', 'warn');
  if (!worker.ffmpeg || !worker.ffprobe) return toast('缺少媒体工具', '模型工作器需要同时提供 FFmpeg 和 FFprobe。', 'warn');
  const submit = form.querySelector('button[type="submit"]');
  const session = state.voiceSourceSession;
  const file = state.voiceSourceFile;
  const data = new FormData(form);
  submit.disabled = true;
  submit.textContent = '正在上传原始媒体…';
  try {
    const source = await uploadVoiceSource(file, session);
    if (session !== state.voiceSourceSession) return;
    submit.textContent = '正在提交裁剪任务…';
    state.voiceExtractSubmitting = true;
    form.setAttribute('aria-busy', 'true');
    const jobPayload = await api(`/api/voice-sources/${encodeURIComponent(source.id)}/extract`, { method: 'POST', body: {
      startMs: Math.round(state.voiceClipStart * 1000),
      endMs: Math.round(state.voiceClipEnd * 1000),
      name: String(data.get('name') || '').trim(),
      tags: String(data.get('tags') || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      transcript: String(data.get('transcript') || '').trim(),
      consent: data.get('consent') === 'on'
    } });
    if (session !== state.voiceSourceSession) return;
    const job = jobPayload.job || jobPayload;
    state.voiceExtractSubmitted = true;
    state.voiceExtractSubmitting = false;
    form.removeAttribute('aria-busy');
    closeModal();
    toast('音色裁剪任务已提交', `${outcome.length.toFixed(1)} 秒片段将在本地提取并加入音色库。`);
    await trackJob(job);
  } catch (error) {
    state.voiceExtractSubmitting = false;
    form.removeAttribute('aria-busy');
    if (error.name === 'AbortError' || session !== state.voiceSourceSession) return;
    toast('音色裁剪失败', error.message, 'error');
    if (submit.isConnected) { submit.disabled = false; submit.textContent = '上传并裁剪到音色库'; }
  } finally {
    state.voiceExtractSubmitting = false;
    form.removeAttribute('aria-busy');
    if (session === state.voiceSourceSession) state.voiceSourceUploadController = null;
  }
}

async function submitProject(form) {
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = '正在读取与拆章…';
  try {
    const data = new FormData(form);
    const body = { title: data.get('title'), author: data.get('author') };
    if (state.bookFile) {
      body.fileName = state.bookFile.name;
      body.contentBase64 = await fileToBase64(state.bookFile);
    }
    if (!state.bookFile && !body.title) throw new Error('请选择小说文件或填写作品名称');
    const project = await api('/api/projects', { method: 'POST', body });
    closeModal(); await refreshBootstrap(); await navigate('studio', project.id);
    toast('作品已创建', project.chapters.length ? `自动拆分为 ${project.chapters.length} 个章节。` : '可继续导入小说正文。');
  } catch (error) { toast('导入失败', error.message, 'error'); submit.disabled = false; submit.textContent = '导入并自动拆章'; }
}

async function submitVoice(form) {
  if (state.voiceTab === 'clip') return submitVoiceClip(form);
  const audio = state.recordingBlob || state.voiceFile;
  if (!audio) return toast('缺少声音样本', '请完成录音或选择一个音频文件。', 'warn');
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = '正在保存…';
  try {
    const data = new FormData(form);
    const isRecording = Boolean(state.recordingBlob);
    const fileName = isRecording ? 'recording.webm' : state.voiceFile.name;
    await api('/api/voices', { method: 'POST', body: {
      name: data.get('name'), tags: String(data.get('tags') || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      transcript: data.get('transcript'), consent: data.get('consent') === 'on', kind: isRecording ? 'recorded' : 'imported',
      fileName, audioBase64: await fileToBase64(audio)
    } });
    closeModal(); await refreshBootstrap({ render: true }); toast('音色已保存', '现在可以在制作台将它绑定给角色。');
  } catch (error) { toast('保存音色失败', error.message, 'error'); submit.disabled = false; submit.textContent = '保存到音色库'; }
}

document.addEventListener('click', async (event) => {
  const scriptLine = event.target.closest('.script-line[data-line-id]');
  if (scriptLine) selectStudioLine(scriptLine.dataset.lineId);
  const target = event.target.closest('[data-nav], [data-action]');
  if (!target) return;
  if (target.dataset.nav) {
    event.preventDefault();
    closeJobs();
    if ($('#modal-root .modal') && !closeModal()) return;
    await navigate(target.dataset.nav);
    return;
  }
  const action = target.dataset.action;
  try {
    if (action === 'reload-app') { location.reload(); return; }
    if (action === 'new-project') { state.bookFile = null; showModal(projectModalHtml()); return; }
    if (action === 'open-demo') {
      const demo = state.bootstrap.projects.find((project) => project.isDemo) || state.bootstrap.projects[0];
      if (demo) await navigate('studio', demo.id); else showModal(projectModalHtml()); return;
    }
    if (action === 'open-project') { await navigate('studio', target.dataset.projectId); return; }
    if (action === 'leave-codex-room') { await leaveCodexStudio(); return; }
    if (action === 'start-codex-login') { await startCodexLogin(); return; }
    if (action === 'cancel-codex-login') { await cancelCodexLogin(); return; }
    if (action === 'recheck-codex-login') { await recheckCodexLogin(); return; }
    if (action === 'dismiss-codex-login') { dismissCodexLogin(); return; }
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'modal-backdrop' && event.target === target) {
      if ($('#modal-root .codex-login-modal')) dismissCodexLogin();
      else closeModal();
      return;
    }
    if (action === 'open-jobs') { openJobs(); return; }
    if (action === 'close-jobs') { closeJobs(); return; }
    if (action === 'select-chapter') { resetPlayback(); state.selectedChapterId = target.dataset.chapterId; state.selectedLineId = null; renderView(); return; }
    if (action === 'select-line') {
      selectStudioLine(target.dataset.lineId);
      return;
    }
    if (action === 'filter-lines') { state.lineFilter = target.dataset.filter; renderView(); return; }
    if (action === 'run-rule-script') { await runRulesScript(); return; }
    if (action === 'open-bulk-script') { showBulkScriptModal(); return; }
    if (action === 'bulk-select-unprocessed') { selectBulkScriptChapters(chapterNeedsScript); return; }
    if (action === 'bulk-select-all') { selectBulkScriptChapters(() => true); return; }
    if (action === 'bulk-clear-selection') { selectBulkScriptChapters(() => false); return; }
    if (action === 'bulk-apply-range') {
      const chapters = state.project?.chapters || [];
      const start = Number($('#bulk-range-start')?.value);
      const end = Number($('#bulk-range-end')?.value);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > chapters.length) {
        toast('章节范围无效', `请输入 1–${chapters.length} 内的起止序号。`, 'warn');
        return;
      }
      selectBulkScriptChapters((chapter, index) => index + 1 >= start && index + 1 <= end);
      return;
    }
    if (action === 'open-collaboration-room') { openCodexStudio('faithful'); return; }
    if (action === 'toggle-voice-binding') {
      if (state.voiceBindingOpen) { closeVoiceBindingDrawer(); return; }
      state.voiceBindingOpen = true;
      state.voiceBindingPickerRoleId = '';
      renderView();
      if (state.voiceBindingOpen) requestAnimationFrame(() => $('.voice-binding-drawer select, .voice-binding-drawer button')?.focus());
      return;
    }
    if (action === 'toggle-binding-voice-picker') {
      stopVoiceBindingPreview({ clear: true });
      state.voiceBindingPickerRoleId = state.voiceBindingPickerRoleId === target.dataset.roleId ? '' : target.dataset.roleId;
      renderView();
      requestAnimationFrame(() => {
        const roleId = target.dataset.roleId;
        const picker = $(`[data-action="toggle-binding-voice-picker"][data-role-id="${CSS.escape(roleId)}"]`);
        if (state.voiceBindingPickerRoleId === roleId) $(`#${CSS.escape(voiceBindingOptionsId(roleId))} .voice-binding-choice`)?.focus();
        else picker?.focus();
      });
      return;
    }
    if (action === 'choose-binding-voice') {
      const role = state.project?.characters.find((item) => item.id === target.dataset.roleId);
      if (!role || state.voiceBindingSaving) return;
      const voiceId = target.dataset.voiceId || null;
      if (voiceId && !state.bootstrap?.voices?.some((voice) => voice.id === voiceId)) return;
      stopVoiceBindingPreview({ clear: true });
      if ((role.voiceId || null) === voiceId) state.voiceBindingDraft.delete(role.id);
      else state.voiceBindingDraft.set(role.id, voiceId);
      state.voiceBindingPickerRoleId = '';
      renderView();
      requestAnimationFrame(() => $(`[data-action="toggle-binding-voice-picker"][data-role-id="${CSS.escape(role.id)}"]`)?.focus());
      return;
    }
    if (action === 'preview-binding-voice') {
      event.stopPropagation();
      await playVoiceBindingPreview(target.dataset.roleId, target.dataset.voiceId);
      return;
    }
    if (action === 'close-voice-binding') { closeVoiceBindingDrawer(); return; }
    if (action === 'discard-voice-bindings') { discardVoiceBindings(); return; }
    if (action === 'save-voice-bindings') { await saveVoiceBindings(); return; }
    if (action === 'new-codex-session') { startNewCodexSession(); return; }
    if (action === 'new-codex-session-for-chapter') {
      if (state.codexBusy) return;
      rememberCodexComposer();
      state.selectedChapterId = target.dataset.chapterId;
      state.codexCollapsedChapters.delete(state.selectedChapterId);
      startNewCodexSession(state.codexProvider, { remember: false, closeProgress: false });
      const hash = `#/codex/${state.project.id}/${state.selectedChapterId}`;
      if (location.hash !== hash) history.pushState(null, '', hash);
      return;
    }
    if (action === 'toggle-codex-chapter-group') {
      const chapterId = target.dataset.chapterId;
      if (state.codexCollapsedChapters.has(chapterId)) state.codexCollapsedChapters.delete(chapterId);
      else state.codexCollapsedChapters.add(chapterId);
      renderCodexStudio();
      requestAnimationFrame(() => $(`[data-action="toggle-codex-chapter-group"][data-chapter-id="${CSS.escape(chapterId)}"]`)?.focus());
      return;
    }
    if (action === 'toggle-all-codex-chapters') {
      state.codexShowAllChapters = !state.codexShowAllChapters;
      renderCodexStudio();
      requestAnimationFrame(() => $('[data-action="toggle-all-codex-chapters"]')?.focus());
      return;
    }
    if (action === 'select-codex-session') { await selectCodexSession(target.dataset.sessionId, target.dataset.chapterId); return; }
    if (action === 'activate-codex-session') { await activateCodexSession(target.dataset.sessionId, target.dataset.chapterId); return; }
    if (action === 'toggle-codex-progress') {
      const progress = currentCodexProgress();
      if (!progress) return;
      progress.expanded = progress.expanded === false;
      updateCodexProgressPanel();
      return;
    }
    if (action === 'toggle-codex-activity') {
      const progress = currentCodexProgress();
      if (!progress) return;
      progress.activityExpanded = progress.activityExpanded === false;
      updateCodexProgressPanel({ activityAutoScroll: progress.activityExpanded !== false && !progress.activityUnread });
      return;
    }
    if (action === 'clear-codex-activity') {
      const progress = currentCodexProgress();
      if (!progress) return;
      progress.activities = [];
      progress.activityUnread = 0;
      updateCodexProgressPanel();
      toast('本地活动视图已清空', '后台任务仍会继续运行。', 'warn');
      return;
    }
    if (action === 'scroll-codex-activity') {
      const progress = currentCodexProgress();
      if (!progress) return;
      progress.activityExpanded = true;
      progress.expanded = true;
      progress.activityUnread = 0;
      updateCodexProgressPanel({ activityAutoScroll: true });
      return;
    }
    if (action === 'use-codex-default-model') {
      state.codexModel = collaborationModelDefault(state.codexProvider);
      const model = $('#codex-model');
      if (model) { model.value = state.codexModel; model.focus(); }
      return;
    }
    if (action === 'refresh-codex-room') {
      rememberCodexComposer();
      await api('/api/system?refresh=1');
      await refreshBootstrap();
      if (state.project?.id) await refreshCodexProjectSnapshot(state.project.id).catch(() => null);
      renderCodexStudio({ focus: 'composer' });
      await recoverActiveCodexSessions();
      toast('协作后端状态已重新检测', collaborationReadiness(state.codexProvider).label);
      return;
    }
    if (action === 'use-codex-suggestion') {
      const composer = $('#codex-chat-prompt');
      if (composer) { composer.value = target.dataset.prompt || ''; state.codexDrafts.set(codexDraftKey(), composer.value); composer.focus(); }
      return;
    }
    if (action === 'open-codex-package') { await openCodexPackage(target.dataset.mode || ''); return; }
    if (action === 'open-codex-import') { showModal(codexImportModalHtml(''), 'wide'); return; }
    if (action === 'copy-codex-prompt') { await navigator.clipboard.writeText($('#codex-prompt').value); toast('已复制任务提示词', '现在可直接粘贴给 Codex。'); return; }
    if (action === 'import-codex-result') { await importCodexResult(); return; }
    if (action === 'render-line') { await requestRender('line', target.dataset.lineId); return; }
    if (action === 'render-scope') { await requestRender(target.dataset.scope); return; }
    if (action === 'confirm-demo-render') { await requestRender(target.dataset.scope, target.dataset.lineId, true); return; }
    if (action === 'export-project') { await exportProject(); return; }
    if (action === 'play-line') { event.stopPropagation(); await playLine(target.dataset.lineId); return; }
    if (action === 'play-voice') {
      const audio = $('#audio-player'); audio.src = target.dataset.url; await audio.play();
      state.loadedAudio = { kind: 'voice', id: target.dataset.name, url: target.dataset.url };
      $('#transport').hidden = false; $('#transport-title').textContent = target.dataset.name; $('#transport-subtitle').textContent = '音色参考原声'; return;
    }
    if (action === 'play-current') {
      const audio = $('#audio-player');
      if (!state.selectedLineId) return;
      if (state.loadedAudio?.kind !== 'line' || state.loadedAudio.id !== state.selectedLineId) return playLine(state.selectedLineId);
      if (audio.paused) { await audio.play(); target.textContent = 'Ⅱ'; } else { audio.pause(); target.textContent = '▶'; } return;
    }
    if (action === 'previous-line') { stepLine(-1); return; }
    if (action === 'next-line') { stepLine(1); return; }
    if (action === 'new-voice') {
      stopRecorderTracks({ discard: true });
      resetVoiceSource({ discardRemote: true });
      state.voiceFile = null;
      state.recordingBlob = null;
      state.voiceTab = 'record';
      showModal(voiceModalHtml(), 'wide');
      return;
    }
    if (action === 'voice-tab') {
      switchVoiceTab(target.dataset.tab);
      return;
    }
    if (action === 'toggle-record') {
      if (state.recorder?.state === 'recording') state.recorder.stop(); else await startRecording(); return;
    }
    if (action === 'set-clip-boundary') {
      const preview = activeVoiceSourcePreview();
      if (!preview || !state.voiceSourceDuration) return toast('还不能设置时间点', '请先选择并等待媒体预览就绪。', 'warn');
      const point = Math.max(0, Math.min(state.voiceSourceDuration, preview.currentTime));
      if (target.dataset.boundary === 'start') state.voiceClipStart = point;
      else state.voiceClipEnd = point;
      updateVoiceClipUi();
      return;
    }
    if (action === 'play-voice-clip') {
      const outcome = updateVoiceClipUi();
      if (!outcome.valid) return toast('还不能试听', outcome.message, 'warn');
      const preview = activeVoiceSourcePreview();
      if (!preview) return;
      if (state.voiceClipPreviewing) { preview.pause(); return; }
      preview.currentTime = state.voiceClipStart;
      state.voiceClipPreviewing = true;
      target.textContent = 'Ⅱ 停止试听';
      try { await preview.play(); }
      catch (error) { state.voiceClipPreviewing = false; target.textContent = '▶ 试听选中片段'; throw error; }
      return;
    }
    if (action === 'delete-voice') {
      if (!confirm('删除这个音色及其参考录音？若仍有角色绑定，系统会拒绝删除并提示先解除绑定。')) return;
      await api(`/api/voices/${target.dataset.voiceId}`, { method: 'DELETE' }); await refreshBootstrap({ render: true }); toast('音色已删除'); return;
    }
    if (action === 'select-engine') {
      await api('/api/settings', { method: 'PATCH', body: { selectedEngine: target.dataset.engineId } }); await refreshBootstrap({ render: true }); toast('默认引擎已更新'); return;
    }
    if (action === 'set-quality') {
      await api('/api/settings', { method: 'PATCH', body: { qualityMode: target.dataset.quality } }); await refreshBootstrap({ render: true }); return;
    }
    if (action === 'refresh-system') { await api('/api/system?refresh=1'); await refreshBootstrap({ render: true }); toast('硬件状态已刷新'); return; }
    if (action === 'save-command') {
      await api('/api/settings', { method: 'PATCH', body: { codexCommand: $('[data-setting="codexCommand"]').value } }); await api('/api/system?refresh=1'); await refreshBootstrap({ render: true }); toast('Codex 设置已保存'); return;
    }
    if (action === 'save-worker') {
      await api('/api/settings', { method: 'PATCH', body: { workerUrl: $('[data-setting="workerUrl"]').value } }); await api('/api/system?refresh=1'); await refreshBootstrap({ render: true }); toast('工作器地址已保存'); return;
    }
  } catch (error) { toast('操作失败', error.message, 'error'); }
});

document.addEventListener('scroll', (event) => {
  const log = event.target?.matches?.('#codex-conversation') ? event.target : null;
  const progress = currentCodexProgress();
  if (!log || !progress || !codexActivityAtBottom(log) || !progress.activityUnread) return;
  progress.activityUnread = 0;
  const unread = $('.codex-room-surface [data-action="scroll-codex-activity"]');
  unread?.remove();
}, true);

document.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'project-form') submitProject(event.target);
  if (event.target.id === 'voice-form') submitVoice(event.target);
  if (event.target.id === 'codex-chat-form') submitCodexMessage();
  if (event.target.id === 'bulk-script-form') submitBulkScript();
});

document.addEventListener('change', async (event) => {
  const input = event.target;
  if (input.name === 'script-mode') {
    state.codexMode = CODEX_MODE_LABELS[input.value] ? input.value : 'faithful';
    return;
  }
  if (input.id === 'bulk-script-provider') {
    state.bulkScriptProvider = ['rules', 'codex', 'ollama'].includes(input.value) ? input.value : 'rules';
    state.bulkScriptModel = collaborationModelDefault(state.bulkScriptProvider === 'rules' ? 'codex' : state.bulkScriptProvider);
    showBulkScriptModal({ focus: 'bulk-script-provider' });
    return;
  }
  if (input.id === 'bulk-script-mode') { state.bulkScriptMode = CODEX_MODE_LABELS[input.value] ? input.value : 'faithful'; return; }
  if (input.id === 'bulk-script-model') { state.bulkScriptModel = input.value.trim(); return; }
  if (input.id === 'bulk-script-effort') { state.bulkScriptReasoningEffort = normalizeCodexReasoningEffort(input.value); return; }
  if (input.id === 'bulk-script-timeout') {
    const minutes = parseCodexTimeoutMinutes(input.value);
    if (minutes !== null) state.bulkScriptTimeoutMinutes = minutes;
    return;
  }
  if (input.matches?.('[data-bulk-chapter-id]')) {
    if (input.checked) state.bulkScriptChapterIds.add(input.dataset.bulkChapterId);
    else state.bulkScriptChapterIds.delete(input.dataset.bulkChapterId);
    const count = (state.project?.chapters || []).filter((chapter) => state.bulkScriptChapterIds.has(chapter.id)).length;
    const countNode = $('#bulk-script-selected-count');
    const statusNode = $('#bulk-script-submit-status');
    const submit = $('#bulk-script-form button[type="submit"]');
    if (countNode) countNode.textContent = `已选 ${count}/${state.project?.chapters?.length || 0}`;
    if (statusNode) statusNode.textContent = count ? `将提交 ${count} 章` : '请至少选择一章';
    if (submit) submit.disabled = !count || state.bulkScriptSubmitting;
    return;
  }
  if (input.id === 'codex-provider') { switchCollaborationProvider(input.value); return; }
  if (input.id === 'codex-model') { state.codexModel = input.value.trim(); return; }
  if (input.id === 'codex-reasoning-effort') {
    state.codexReasoningEffort = normalizeCodexReasoningEffort(input.value);
    return;
  }
  if (input.id === 'codex-timeout-minutes') {
    const timeoutMinutes = parseCodexTimeoutMinutes(input.value);
    if (timeoutMinutes !== null) state.codexTimeoutMinutes = timeoutMinutes;
    return;
  }
  if (input.id === 'codex-room-mode') { state.codexMode = CODEX_MODE_LABELS[input.value] ? input.value : 'faithful'; return; }
  if (input.id === 'codex-progress-visible') {
    state.codexProgressVisible = input.checked;
    writeLocalBoolean(CODEX_PROGRESS_PREFERENCE_KEY, state.codexProgressVisible);
    updateCodexProgressPanel();
    return;
  }
  if (input.id === 'codex-activity-visible') {
    state.codexActivityVisible = input.checked;
    writeLocalBoolean(CODEX_ACTIVITY_PREFERENCE_KEY, state.codexActivityVisible);
    const progress = currentCodexProgress();
    if (!state.codexActivityVisible && progress) {
      progress.activities = [];
      progress.activityUnread = 0;
    }
    updateCodexProgressPanel();
    if (state.codexActivityVisible && progress?.detailLevel === 'summary' && codexProgressIsActive(progress)) {
      closeCodexProgressConnection(codexProgressKey());
      connectCodexProgress(progress);
    }
    return;
  }
  if (input.id === 'voice-binding-chapter-only') {
    stopVoiceBindingPreview({ clear: true });
    state.voiceBindingPickerRoleId = '';
    state.voiceBindingChapterOnly = input.checked;
    renderView();
    requestAnimationFrame(() => $('#voice-binding-chapter-only')?.focus());
    return;
  }
  if (input.matches?.('[data-character-voice]')) {
    const role = state.project?.characters.find((item) => item.id === input.dataset.characterVoice);
    if (!role) return;
    const voiceId = input.value || null;
    if ((role.voiceId || null) === voiceId) state.voiceBindingDraft.delete(role.id);
    else state.voiceBindingDraft.set(role.id, voiceId);
    renderView();
    requestAnimationFrame(() => $(`[data-character-voice="${CSS.escape(role.id)}"]`)?.focus());
    return;
  }
  if (input.id === 'modal-book-file') {
    state.bookFile = input.files[0] || null;
    if (state.bookFile) {
      $('#book-file-label').textContent = `${state.bookFile.name} · ${(state.bookFile.size / 1024 / 1024).toFixed(2)} MB`;
      if (!$('#project-title').value) $('#project-title').value = state.bookFile.name.replace(/\.(txt|md|markdown|epub)$/i, '');
    }
    return;
  }
  if (input.id === 'modal-voice-file') {
    state.voiceFile = input.files[0] || null; state.recordingBlob = null;
    if (state.voiceFile) $('#voice-file-label').textContent = `${state.voiceFile.name} · ${(state.voiceFile.size / 1024 / 1024).toFixed(2)} MB`;
    return;
  }
  if (input.id === 'modal-voice-source-file') {
    const file = input.files[0] || null;
    if (file) loadVoiceSourceFile(file);
    else resetVoiceSource({ discardRemote: true });
    return;
  }
  if (input.dataset.lineField) {
    const value = ['intensity', 'pace', 'pauseAfterMs'].includes(input.dataset.lineField) ? Number(input.value) : input.value;
    scheduleLineSave(input.dataset.lineId, { [input.dataset.lineField]: value });
    if (input.dataset.lineField === 'speakerId' && !input.closest('.codex-room-surface')) renderView();
    return;
  }
  if (input.dataset.roleVoice) {
    const previous = roleForLine(findLine(state.selectedLineId))?.voiceId || '';
    try {
      const updatedProject = await api(`/api/projects/${state.project.id}/characters/${input.dataset.roleVoice}`, { method: 'PATCH', body: { voiceId: input.value || null } });
      applyCodexProjectSnapshot(updatedProject);
      state.voiceBindingDraft.delete(input.dataset.roleVoice);
      renderView(); toast('角色音色已绑定');
    } catch (error) {
      input.value = previous;
      toast('音色绑定失败', error.message, 'error');
    }
  }
});

document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'codex-chat-prompt') { state.codexDrafts.set(codexDraftKey(), input.value); return; }
  if (input.id === 'codex-model') { state.codexModel = input.value; return; }
  if (input.dataset.clipBoundary) {
    const value = Number(input.value);
    if (input.dataset.clipBoundary === 'start') state.voiceClipStart = value;
    else state.voiceClipEnd = value;
    if (state.voiceClipPreviewing) activeVoiceSourcePreview()?.pause();
    updateVoiceClipUi();
    return;
  }
  if (input.dataset.lineInput) {
    input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`;
    scheduleLineSave(input.dataset.lineId, { [input.dataset.lineInput]: input.value });
  }
  if (input.type === 'range' && input.dataset.lineField) {
    const valueNode = input.parentElement.querySelector('.range-value');
    if (input.dataset.lineField === 'intensity') valueNode.textContent = `${Math.round(input.value * 100)}%`;
    if (input.dataset.lineField === 'pace') valueNode.textContent = `${Number(input.value).toFixed(2)}×`;
    if (input.dataset.lineField === 'pauseAfterMs') valueNode.textContent = `${input.value}ms`;
  }
});

document.addEventListener('focusin', (event) => {
  const line = event.target.closest('.script-line[data-line-id]');
  if (line) selectStudioLine(line.dataset.lineId);
});

document.addEventListener('click', async (event) => {
  const emotion = event.target.closest('.emotion-button[data-line-field="emotion"]');
  if (!emotion) return;
  scheduleLineSave(emotion.dataset.lineId, { emotion: emotion.dataset.value });
  const line = findLine(emotion.dataset.lineId);
  if (line) line.emotion = emotion.dataset.value;
  $$('.emotion-button').forEach((button) => button.classList.toggle('active', button === emotion));
});

document.addEventListener('click', (event) => {
  const clickedInsideVoiceBindingPicker = event.composedPath().some((node) => node instanceof Element && node.classList?.contains('voice-binding-picker'));
  if (state.voiceBindingPickerRoleId && !clickedInsideVoiceBindingPicker) closeVoiceBindingPicker();
  const zone = event.target.closest('#book-drop-zone, #voice-drop-zone, #voice-source-drop-zone');
  if (!zone || event.target.matches('input')) return;
  if (zone.id === 'book-drop-zone') $('#modal-book-file')?.click();
  else if (zone.id === 'voice-drop-zone') $('#modal-voice-file')?.click();
  else $('#modal-voice-source-file')?.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.voiceBindingPickerRoleId) closeVoiceBindingPicker({ focus: true });
    else if ($('#modal-root .codex-login-modal')) dismissCodexLogin();
    else if ($('#modal-root .modal')) closeModal();
    else if ($('#job-drawer').classList.contains('open')) closeJobs();
    else if (state.voiceBindingOpen) closeVoiceBindingDrawer();
    return;
  }
  if (event.key === 'Tab') {
    const modal = $('#modal-root .modal');
    if (modal) {
      const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', modal)
        .filter((item) => item.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.target.id === 'codex-chat-prompt') {
    event.preventDefault();
    $('#codex-chat-form')?.requestSubmit();
    return;
  }
  const activeTab = event.target.closest('.voice-tabs [role="tab"]');
  if (activeTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = $$('.voice-tabs [role="tab"]');
    const index = tabs.indexOf(activeTab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex].click();
    tabs[nextIndex].focus();
    return;
  }
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[role="button"][data-action], .drop-zone[role="button"]');
  if (!target || target.matches('button')) return;
  event.preventDefault();
  target.click();
});

for (const type of ['dragenter', 'dragover']) document.addEventListener(type, (event) => {
  const zone = event.target.closest?.('.drop-zone');
  if (!zone) return; event.preventDefault(); zone.classList.add('dragging');
});
for (const type of ['dragleave', 'drop']) document.addEventListener(type, (event) => {
  const zone = event.target.closest?.('.drop-zone');
  if (!zone) return; event.preventDefault(); zone.classList.remove('dragging');
  if (type === 'drop' && event.dataTransfer.files[0]) {
    const file = event.dataTransfer.files[0];
    if (zone.id === 'book-drop-zone') {
      state.bookFile = file; $('#book-file-label').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
      if (!$('#project-title').value) $('#project-title').value = file.name.replace(/\.(txt|md|markdown|epub)$/i, '');
    } else if (zone.id === 'voice-drop-zone') {
      state.voiceFile = file; state.recordingBlob = null; $('#voice-file-label').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    } else if (zone.id === 'voice-source-drop-zone') loadVoiceSourceFile(file);
  }
});

const audio = $('#audio-player');
audio.addEventListener('timeupdate', () => {
  const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
  $('#transport-progress').style.width = `${ratio * 100}%`;
  $('#transport-time').textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
});
audio.addEventListener('ended', () => {
  $('.play-main').textContent = '▶';
  const expectedUrl = state.loadedAudio?.kind === 'voice-binding'
    ? new URL(state.loadedAudio.url, location.href).href : '';
  if (expectedUrl && audio.ended && (!audio.currentSrc || audio.currentSrc === expectedUrl)) {
    state.voiceBindingPreviewRequestId += 1;
    state.voiceBindingPreview = null;
    syncVoiceBindingPreviewButtons();
  }
});
audio.addEventListener('pause', () => {
  if (!audio.ended) $('.play-main').textContent = '▶';
});
audio.addEventListener('error', () => {
  if (state.loadedAudio?.kind !== 'voice-binding' || !state.voiceBindingPreview) return;
  const expectedUrl = new URL(state.loadedAudio.url, location.href).href;
  if (audio.currentSrc !== expectedUrl) return;
  stopVoiceBindingPreview({ clear: true });
  toast('样音播放失败', '参考音频无法由当前浏览器解码，请检查音频格式。', 'error');
});

window.addEventListener('hashchange', async () => {
  if ($('#modal-root .codex-login-modal')) closeModal();
  const route = parseRoute();
  if (state.view === 'codex' && route.view !== 'codex') pauseCodexStudio({ invalidateRequest: true });
  if (['studio', 'codex'].includes(route.view) && route.id) {
    await loadProject(route.id).catch(() => {});
    if (route.chapterId && state.project?.chapters.some((chapter) => chapter.id === route.chapterId)) {
      state.selectedChapterId = route.chapterId;
    }
  }
  state.view = route.view;
  if (state.view === 'codex') prepareCodexStudioState();
  renderView();
  if (state.view === 'codex') {
    if (state.codexProvider === 'codex') recoverCodexLogin();
    if (state.codexVersionId) {
      await loadCodexSessionScript(state.codexVersionId).catch(() => null);
      if (state.view === 'codex') renderCodexStudio();
    }
    void recoverActiveCodexSessions();
  }
});

window.addEventListener('pagehide', () => {
  for (const { source } of state.codexProgressSources.values()) {
    try { source.close(); } catch {}
  }
  state.codexProgressSources.clear();
  state.codexProgressGeneration += 1;
  stopCodexProgressElapsedTimer();
});

async function boot() {
  try {
    await refreshBootstrap();
    const route = parseRoute();
    state.view = route.view;
    if (route.view === 'studio' || route.view === 'codex') {
      const id = route.id || state.bootstrap.projects[0]?.id;
      if (id) {
        await loadProject(id);
        if (route.chapterId && state.project?.chapters.some((chapter) => chapter.id === route.chapterId)) {
          state.selectedChapterId = route.chapterId;
        }
      } else state.view = 'projects';
    }
    if (state.view === 'codex') prepareCodexStudioState();
    renderView();
    if (state.view === 'codex') {
      if (state.codexProvider === 'codex') recoverCodexLogin();
      if (state.codexVersionId) {
        await loadCodexSessionScript(state.codexVersionId).catch(() => null);
        if (state.view === 'codex') renderCodexStudio();
      }
      void recoverActiveCodexSessions();
    }
    const activeJobs = state.bootstrap.jobs.filter((job) => ['queued', 'running'].includes(job.state));
    activeJobs.forEach((job) => state.watchedJobs.add(job.id));
    if (activeJobs.length) state.jobTimer = setInterval(pollJobs, 900);
  } catch (error) {
    $('#app-main').innerHTML = `<section class="error-state"><h2>工作台启动失败</h2><p>${escapeHtml(error.message)}。请确认已经在项目目录运行 <code>npm start</code>。</p><button class="button primary" data-action="reload-app">重新加载</button></section>`;
  }
}

boot();
