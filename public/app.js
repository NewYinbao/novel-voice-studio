const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

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
  codexSessionByChapter: new Map(),
  codexDrafts: new Map(),
  codexModel: '',
  codexMode: 'faithful',
  codexBusy: false,
  codexError: '',
  codexRequestId: 0,
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
  if ($('#modal-root .codex-room-modal') && state.codexBusy) {
    toast('Codex 正在处理', '本轮完成前请保持协作室打开，避免剧本结果丢失。', 'warn');
    return false;
  }
  if (state.voiceExtractSubmitting) {
    toast('正在提交裁剪任务', '任务编号返回前请不要关闭；提交完成后可在任务抽屉继续查看。', 'warn');
    return false;
  }
  stopRecorderTracks({ discard: true });
  resetVoiceSource({ discardRemote: true });
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
  $('.play-main').textContent = '▶';
}

async function refreshBootstrap({ render = false } = {}) {
  state.bootstrap = await api('/api/bootstrap');
  updateTopbar();
  renderJobs();
  if (render) renderView();
}

async function loadProject(projectId) {
  state.project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
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
const CODEX_MODEL_OPTIONS = [
  ['gpt-5.6-sol', 'Sol'], ['gpt-5.6-terra', 'Terra'], ['gpt-5.6-luna', 'Luna']
];

function codexSessions(chapter = currentChapter()) {
  return [...(chapter?.codexSessions || [])].sort((left, right) => {
    const leftDate = left.updatedAt || left.messages?.at(-1)?.createdAt || left.createdAt || '';
    const rightDate = right.updatedAt || right.messages?.at(-1)?.createdAt || right.createdAt || '';
    return String(rightDate).localeCompare(String(leftDate));
  });
}

function currentCodexSession() {
  return codexSessions().find((session) => session.id === state.codexSessionId) || null;
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

function codexStatusLabel(status) {
  return ({ processing: '处理中', running: '处理中', completed: '已完成', ready: '可继续对话', failed: '处理失败' })[status] || '可继续对话';
}

function codexDraftKey(sessionId = state.codexSessionId) {
  return `${currentChapter()?.id || 'chapter'}:${sessionId || 'new'}`;
}

function codexStarterPrompt(mode = state.codexMode) {
  const modeLabel = CODEX_MODE_LABELS[mode] || CODEX_MODE_LABELS.faithful;
  return `请按“${modeLabel}”档位分析当前章节，整理为可配音剧本。重点核对对白归属、角色一致性、情绪、语速与停顿；不确定的角色请标记待确认。`;
}

function codexDraft(sessionId = state.codexSessionId) {
  const key = codexDraftKey(sessionId);
  if (state.codexDrafts.has(key)) return state.codexDrafts.get(key);
  return sessionId ? '' : codexStarterPrompt();
}

function rememberCodexComposer() {
  const composer = $('#codex-chat-prompt');
  if (composer) state.codexDrafts.set(codexDraftKey(), composer.value);
  const model = $('#codex-model');
  if (model) state.codexModel = model.value.trim();
  const mode = $('#codex-room-mode');
  if (mode && !mode.disabled) state.codexMode = mode.value;
}

function codexSessionTitle(session, index) {
  const firstPrompt = session.messages?.find((message) => message.role === 'user')?.content || '';
  const title = String(session.title || firstPrompt).replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 34) : `协作会话 ${index + 1}`;
}

function updateTopbar() {
  $$('.main-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === state.view));
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
  return `<section class="studio-page ${missingVoices.length ? 'has-voice-warning' : ''}">
    <header class="studio-header">
      <div class="studio-title"><button class="back-button" data-nav="projects" aria-label="返回">‹</button><div><h1>${escapeHtml(project.title)}</h1><small>${project.chapters.length} 章 · ${formatNumber(project.source?.charCount)} 字 · ${project.characters.length} 个角色</small></div></div>
      <div class="studio-actions">
        <button class="button ghost" data-action="open-script-modal">✦ 剧本润色</button>
        <button class="button" data-action="render-scope" data-scope="chapter">◉ 生成本章</button>
        <button class="button primary" data-action="export-project">⇩ 导出 WAV</button>
      </div>
    </header>
    ${missingVoices.length ? `<div class="voice-readiness-banner" role="status"><span class="voice-warning-icon">!</span><div><strong>本章还有 ${missingVoices.length} 个角色无法生成真人语音</strong><small>${escapeHtml(missingNames)}${escapeHtml(missingMore)} 尚未绑定带参考录音的可用音色；选中台词后可在右侧绑定。</small></div><button class="button small" data-nav="voices">管理音色</button></div>` : ''}
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
      <aside class="inspector">${inspectorHtml()}</aside>
    </div>
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
    return `<div class="source-only"><div class="doc-glyph">▤</div><h3>正文已经拆好，等待剧本化</h3><p>用规则引擎可立即识别引号对白；也可以导出结构化任务交给 Codex，获得更准确的角色与情绪标注。</p><button class="button primary" data-action="open-script-modal">✦ 开始剧本润色</button></div>`;
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
  return `<article class="script-line ${selected ? 'selected' : ''}" style="--speaker:${role.color || '#78dfc9'}" data-action="select-line" data-line-id="${line.id}">
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
        <section class="panel integration-panel"><span class="eyebrow">SCRIPT POLISH</span><h3>Codex 剧本集成</h3><div class="integration-row"><div><label class="form-label">Codex CLI 命令</label><input class="field" value="${escapeHtml(settings.codexCommand)}" data-setting="codexCommand"><div class="tool-state ${codex.ready ? 'online' : ''}"><i></i><span><strong>${escapeHtml(codex.label)}</strong> · ${escapeHtml(codex.detail)}</span></div></div><button class="button" data-action="save-command">保存并检测</button></div></section>
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

async function navigate(view, projectId = null) {
  const previousProjectId = state.project?.id;
  if (view === 'studio') {
    const targetId = projectId || state.project?.id || state.bootstrap.projects[0]?.id;
    if (!targetId) { view = 'projects'; toast('还没有作品', '请先导入一本小说。', 'warn'); }
    else {
      try { await loadProject(targetId); } catch (error) { toast('无法打开作品', error.message, 'error'); view = 'projects'; }
    }
  }
  state.view = view;
  if (view !== 'studio' || (previousProjectId && state.project?.id !== previousProjectId)) resetPlayback();
  const hash = view === 'studio' && state.project ? `#/studio/${state.project.id}` : `#/${view}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderView();
}

function parseRoute() {
  const [, view = 'projects', id] = location.hash.match(/^#\/([^/]+)(?:\/([^/]+))?/) || [];
  return { view: ['projects', 'studio', 'voices', 'models'].includes(view) ? view : 'projects', id };
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

function scriptModalHtml() {
  const chapter = currentChapter();
  const codex = codexReadiness();
  return `<header class="modal-head"><div><span class="eyebrow">SCRIPT POLISH</span><h2>把小说转成配音剧本</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <div class="modal-body"><div class="modal-note">当前处理：${escapeHtml(chapter?.title || '')}。原文始终保留；剧本会生成独立的朗读文本、角色、情绪和停顿。</div>
      <div class="form-group"><label>润色档位</label><div class="mode-cards">
        <label class="mode-card"><input type="radio" name="script-mode" value="faithful" ${state.codexMode === 'faithful' ? 'checked' : ''}><strong>忠实朗读</strong><small>不增写剧情，只做归属与情绪标注</small></label>
        <label class="mode-card"><input type="radio" name="script-mode" value="polished" ${state.codexMode === 'polished' ? 'checked' : ''}><strong>轻度剧本化</strong><small>优化书面结构和朗读节奏</small></label>
        <label class="mode-card"><input type="radio" name="script-mode" value="drama" ${state.codexMode === 'drama' ? 'checked' : ''}><strong>广播剧化</strong><small>适度压缩叙述，增强表演提示</small></label>
      </div></div>
      <div class="form-group" style="margin-top:16px"><label>处理方式</label><select class="select-field" id="script-provider"><option value="rules">本地规则引擎 · 立即完成</option><option value="codex">Codex 剧本协作室 · ${codex.ready ? '可直接对话' : '任务包可用'}</option><option value="ollama">本地 Ollama · 结构化输出</option></select></div>
      <div class="script-readiness ${codex.ready ? 'ready' : 'warn'}" role="status"><i></i><div><strong>${escapeHtml(codex.label)}</strong><small>${escapeHtml(codex.detail)}${codex.ready ? '。选择 Codex 后可在同一会话里多轮调整。' : '。仍可打开协作室生成任务包，并手工导入 JSON。'}</small></div></div>
    </div><footer class="modal-foot" style="justify-content:space-between"><div><button class="button ghost" data-action="open-codex-package">⇧ Codex 任务包</button><button class="button ghost" data-action="open-codex-import">⇩ 导入 JSON</button></div><div style="display:flex;gap:8px"><button class="button ghost" data-action="close-modal">取消</button><button class="button primary" data-action="run-script">开始转换</button></div></footer>`;
}

function codexImportModalHtml(prompt = '') {
  return `<header class="modal-head"><div><span class="eyebrow">CODEX HANDOFF</span><h2>Codex 剧本任务</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <div class="modal-body"><div class="modal-note">已按官方结构化输出方式准备任务。复制下方内容交给 Codex，取得 JSON 后粘贴到“返回结果”中导入。</div>
      <div class="form-group"><label>任务提示词</label><textarea class="code-area" id="codex-prompt" readonly>${escapeHtml(prompt)}</textarea></div>
      <button class="button small" style="margin:8px 0 17px" data-action="copy-codex-prompt">复制任务提示词</button>
      <div class="form-group"><label>Codex 返回结果（JSON）</label><textarea class="code-area" id="codex-result" placeholder="在这里粘贴 Codex 返回的 JSON…"></textarea></div>
    </div><footer class="modal-foot"><button class="button ghost" data-action="close-modal">稍后处理</button><button class="button primary" data-action="import-codex-result">校验并导入</button></footer>`;
}

function codexMessageHtml(message) {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system';
  const label = role === 'assistant' ? 'Codex' : role === 'user' ? '你' : '系统';
  const createdAt = message.createdAt ? new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<article class="codex-message ${role}"><div class="codex-message-meta"><strong>${label}</strong><time>${escapeHtml(createdAt)}</time></div><div class="codex-message-content">${escapeHtml(message.content || '')}</div></article>`;
}

function codexLineEditorHtml(line, index) {
  const role = roleForLine(line);
  const locked = state.codexBusy ? 'disabled' : '';
  const roleOptions = state.project.characters.map((item) => `<option value="${item.id}" ${item.id === role?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const emotionOptions = state.bootstrap.emotions.map((emotion) => `<option value="${emotion.id}" ${emotion.id === line.emotion ? 'selected' : ''}>${escapeHtml(emotion.label)}</option>`).join('');
  return `<article class="codex-script-line" data-codex-line-id="${line.id}">
    <header><span class="codex-line-number">${String(index + 1).padStart(2, '0')}</span><span class="codex-line-kind">${line.kind === 'dialogue' ? '对白' : '旁白'}</span>${line.needsReview ? '<span class="review-flag">待确认</span>' : ''}<small>${state.codexBusy ? 'Codex 处理中暂锁定' : '修改自动保存'}</small></header>
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
  const session = currentCodexSession();
  const readiness = codexReadiness();
  const messages = session?.messages || [];
  const lines = chapter?.scenes?.flatMap((scene) => scene.lines || []) || [];
  const model = session?.model ?? state.codexModel ?? '';
  const mode = session?.mode || state.codexMode || 'faithful';
  const sessionStatus = state.codexBusy ? '处理中' : session ? codexStatusLabel(session.status) : '新会话';
  const canSend = readiness.ready && !state.codexBusy;
  return `<header class="modal-head codex-room-head"><div><span class="eyebrow">CODEX SCRIPT ROOM</span><h2>Codex 剧本协作室</h2><p>${escapeHtml(chapter?.title || '当前章节')} · 多轮调整与逐句校对</p></div><div class="codex-room-head-actions"><span class="codex-room-status ${readiness.ready ? 'ready' : 'warn'}"><i></i>${escapeHtml(readiness.label)}</span><button class="icon-button" data-action="close-modal" aria-label="关闭 Codex 剧本协作室">×</button></div></header>
    <div class="codex-room-grid">
      <aside class="codex-session-panel" aria-label="Codex 会话历史">
        <div class="codex-panel-title"><div><span class="eyebrow">SESSIONS</span><strong>本章会话</strong></div><button class="button small" data-action="new-codex-session" ${state.codexBusy ? 'disabled' : ''}>＋ 新会话</button></div>
        <div class="codex-session-list">${sessions.length ? sessions.map((item, index) => `<button class="codex-session-item ${item.id === session?.id ? 'active' : ''}" data-action="select-codex-session" data-session-id="${item.id}" ${state.codexBusy ? 'disabled' : ''}><span><strong>${escapeHtml(codexSessionTitle(item, index))}</strong><small>${escapeHtml(CODEX_MODE_LABELS[item.mode] || item.mode || '忠实朗读')} · ${escapeHtml(item.model || 'Codex 默认')}</small></span><span><em>${Number(item.turnCount || Math.ceil((item.messages?.length || 0) / 2))} 轮</em><time>${escapeHtml(formatDate(item.updatedAt || item.messages?.at(-1)?.createdAt || item.createdAt))}</time></span></button>`).join('') : '<div class="codex-empty-session"><span>✦</span><strong>还没有协作记录</strong><small>从一个明确目标开始，后续可在同一会话继续调整。</small></div>'}</div>
        <div class="codex-readiness-card ${readiness.ready ? 'ready' : 'warn'}"><strong>${escapeHtml(readiness.label)}</strong><p>${escapeHtml(readiness.detail)}${readiness.ready ? '。直接对话会把当前章节发送给你已登录的 Codex 服务。' : ''}</p><div><button class="button ghost small" data-action="open-codex-package" data-mode="${escapeHtml(mode)}" ${state.codexBusy ? 'disabled' : ''}>⇧ 任务包</button><button class="button ghost small" data-action="refresh-codex-room" ${state.codexBusy ? 'disabled' : ''}>↻ 重新检测</button></div></div>
      </aside>
      <main class="codex-chat-panel" aria-busy="${state.codexBusy}">
        <div class="codex-chat-toolbar"><label><span>模型（可输入完整 CLI ID）</span><div class="codex-model-input"><input class="field" id="codex-model" list="codex-model-options" maxlength="100" value="${escapeHtml(model)}" placeholder="Codex 默认" ${state.codexBusy ? 'disabled' : ''}><button class="button ghost small" type="button" data-action="use-codex-default-model" ${state.codexBusy ? 'disabled' : ''}>默认</button></div></label><datalist id="codex-model-options">${CODEX_MODEL_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</datalist><label><span>润色档位</span><select class="select-field" id="codex-room-mode" ${session || state.codexBusy ? 'disabled' : ''}>${Object.entries(CODEX_MODE_LABELS).map(([value, label]) => `<option value="${value}" ${value === mode ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="codex-active-status"><span>${sessionStatus}</span><small>${session ? `${Number(session.turnCount || Math.ceil(messages.length / 2))} 轮对话` : '发送后创建会话'}</small></div></div>
        <div class="codex-conversation" id="codex-conversation" aria-live="polite">${messages.length ? messages.map(codexMessageHtml).join('') : `<div class="codex-conversation-empty"><span>✦</span><h3>和 Codex 一起打磨这一章</h3><p>第一次发送会创建会话并更新右侧剧本。之后可以继续要求修正角色、语气或某一段台词。</p><div><button class="codex-suggestion" type="button" data-action="use-codex-suggestion" data-prompt="请重点检查所有对白的说话人归属，不确定的角色保留待确认标记。" ${state.codexBusy ? 'disabled' : ''}>检查角色归属</button><button class="codex-suggestion" type="button" data-action="use-codex-suggestion" data-prompt="请优化朗读节奏和停顿，但不要改变剧情事实和人物关系。" ${state.codexBusy ? 'disabled' : ''}>优化朗读节奏</button></div></div>`}${state.codexBusy ? '<div class="codex-processing" role="status"><span><i></i><i></i><i></i></span><div><strong>Codex 正在处理当前章节</strong><small>请保持窗口打开，完成后剧本会同步到右侧。</small></div></div>' : ''}${state.codexError ? `<div class="codex-chat-error" role="alert"><strong>本轮没有完成</strong><span>${escapeHtml(state.codexError)}</span></div>` : ''}</div>
        <form class="codex-composer" id="codex-chat-form"><textarea id="codex-chat-prompt" rows="3" maxlength="4000" placeholder="例如：第二场中苏晚的语气太激烈，请改得克制一些，并延长关键句后的停顿。" ${state.codexBusy ? 'disabled' : ''}>${escapeHtml(codexDraft())}</textarea><div><small>${readiness.ready ? '发送后会直接更新当前章节，可继续多轮调整。' : readiness.authRequired ? '请先在本机终端完成 codex login；任务包仍可使用。' : '直接对话暂不可用；请使用左侧任务包交接。'}</small><button class="button primary" type="submit" ${canSend ? '' : 'disabled'}>${state.codexBusy ? '处理中…' : session ? '发送并更新剧本' : '创建会话并生成'}</button></div></form>
      </main>
      <aside class="codex-script-panel" aria-label="当前剧本逐句编辑">
        <div class="codex-panel-title"><div><span class="eyebrow">LIVE SCRIPT</span><strong>当前剧本</strong></div><span class="codex-line-count">${lines.length} 句</span></div>
        <p class="codex-script-hint">可直接修改台词、角色、情绪与节奏；每项改动都会自动保存。</p>
        <div class="codex-script-list">${lines.length ? lines.map(codexLineEditorHtml).join('') : '<div class="codex-empty-script"><span>▤</span><strong>本章还没有剧本</strong><small>向 Codex 发送第一条要求后，生成结果会显示在这里。</small></div>'}</div>
      </aside>
    </div>`;
}

function renderCodexStudio({ focus = '' } = {}) {
  showModal(codexStudioHtml(), 'codex-room-modal');
  requestAnimationFrame(() => {
    const conversation = $('#codex-conversation');
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    if (focus === 'composer') $('#codex-chat-prompt')?.focus();
    if (focus === 'model') $('#codex-model')?.focus();
  });
}

function openCodexStudio(mode = state.codexMode) {
  state.codexMode = CODEX_MODE_LABELS[mode] ? mode : 'faithful';
  state.codexError = '';
  const chapter = currentChapter();
  const sessions = codexSessions(chapter);
  const remembered = state.codexSessionByChapter.get(chapter?.id);
  state.codexSessionId = sessions.some((session) => session.id === remembered) ? remembered : sessions[0]?.id || null;
  const session = currentCodexSession();
  if (session?.model) state.codexModel = session.model;
  if (session?.mode) state.codexMode = session.mode;
  renderCodexStudio({ focus: state.codexSessionId ? '' : 'composer' });
}

function startNewCodexSession() {
  rememberCodexComposer();
  const chapterId = currentChapter()?.id;
  if (chapterId) state.codexSessionByChapter.delete(chapterId);
  state.codexSessionId = null;
  state.codexError = '';
  state.codexDrafts.delete(codexDraftKey(null));
  renderCodexStudio({ focus: 'composer' });
}

function selectCodexSession(sessionId) {
  if (!sessionId || sessionId === state.codexSessionId) return;
  rememberCodexComposer();
  state.codexSessionId = sessionId;
  const chapterId = currentChapter()?.id;
  if (chapterId) state.codexSessionByChapter.set(chapterId, sessionId);
  const session = currentCodexSession();
  if (session?.model) state.codexModel = session.model;
  if (session?.mode) state.codexMode = session.mode;
  state.codexError = '';
  renderCodexStudio({ focus: 'composer' });
}

async function waitForPendingLineSaves(projectId, requestId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const hasPending = () => [...state.saveTimers.keys()].some((key) => key.startsWith(`${projectId}:`));
  while (hasPending() && Date.now() < deadline) {
    if (requestId !== state.codexRequestId) return false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (hasPending()) throw new Error('仍有台词正在自动保存，请稍后再发送给 Codex。');
  const failed = [...state.lineSaveErrors.entries()].filter(([key]) => key.startsWith(`${projectId}:`));
  if (failed.length) throw new Error(`有 ${failed.length} 句台词自动保存失败，请重新修改并保存后再发送给 Codex。`);
  return requestId === state.codexRequestId;
}

async function submitCodexMessage() {
  if (state.codexBusy) return;
  const readiness = codexReadiness();
  if (!readiness.ready) return toast(readiness.label, readiness.authRequired ? '请先在本机终端完成 codex login，或使用任务包交接。' : '请使用任务包完成手工交接。', 'warn');
  rememberCodexComposer();
  const prompt = String($('#codex-chat-prompt')?.value || codexDraft()).trim();
  if (!prompt) return toast('先写下本轮目标', '说明希望 Codex 生成或调整什么内容。', 'warn');
  const projectId = state.project?.id;
  const chapterId = currentChapter()?.id;
  if (!projectId || !chapterId) return;
  const sessionId = state.codexSessionId;
  const model = String($('#codex-model')?.value ?? state.codexModel ?? '').trim();
  const mode = String($('#codex-room-mode')?.value || currentCodexSession()?.mode || state.codexMode || 'faithful');
  const requestId = ++state.codexRequestId;
  state.codexModel = model;
  state.codexMode = mode;
  state.codexBusy = true;
  state.codexError = '';
  state.codexDrafts.set(codexDraftKey(sessionId), prompt);
  renderCodexStudio();
  try {
    if (!(await waitForPendingLineSaves(projectId, requestId))) return;
    const endpoint = sessionId
      ? `/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions/${encodeURIComponent(sessionId)}/messages`
      : `/api/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/codex-sessions`;
    const body = sessionId ? { model, prompt } : { mode, model, prompt };
    const result = await api(endpoint, { method: 'POST', body });
    if (requestId !== state.codexRequestId) return;
    if (result.project && state.project?.id === projectId) state.project = result.project;
    state.codexSessionId = result.session?.id || sessionId;
    if (state.codexSessionId) state.codexSessionByChapter.set(chapterId, state.codexSessionId);
    state.codexDrafts.delete(`${chapterId}:${sessionId || 'new'}`);
    state.codexDrafts.set(`${chapterId}:${state.codexSessionId || 'new'}`, '');
    state.codexBusy = false;
    state.codexError = '';
    renderCodexStudio({ focus: 'composer' });
    toast('Codex 已更新本章剧本', '可以继续对话，或在右侧逐句微调。');
  } catch (error) {
    if (requestId !== state.codexRequestId) return;
    state.codexBusy = false;
    state.codexError = error.message;
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

function jobCardHtml(job) {
  const failure = renderFailureOutcome(job);
  const className = failure?.className || job.state;
  const status = failure?.status || statusLabels[job.state] || job.state;
  const message = failure?.summary || `${job.message || ''}${job.error ? ` · ${job.error.message}` : ''}`;
  return `<article class="job-card ${className}"><div class="job-card-head"><strong>${escapeHtml(jobLabels[job.type] || job.type)}</strong><span>${escapeHtml(status)} · ${job.progress}%</span></div><div class="meter"><span style="width:${job.progress}%"></span></div><p>${escapeHtml(message)}</p>${job.result?.mediaUrl ? `<a class="job-download" href="${job.result.mediaUrl}" download="${escapeHtml(job.result.fileName || 'audiobook.wav')}">⇩ 下载 ${escapeHtml(job.result.fileName || 'WAV')}</a>` : ''}</article>`;
}

function jobCompletionNotice(job) {
  const label = jobLabels[job.type] || '任务';
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

async function runScript() {
  const provider = $('#script-provider')?.value || 'rules';
  const mode = $('input[name="script-mode"]:checked')?.value || 'faithful';
  state.codexMode = CODEX_MODE_LABELS[mode] ? mode : 'faithful';
  if (provider === 'codex') {
    openCodexStudio(mode);
    return;
  }
  const chapter = currentChapter();
  closeModal();
  const job = await api(`/api/projects/${state.project.id}/script`, { method: 'POST', body: { chapterIds: [chapter.id], provider, mode } });
  toast('剧本任务已提交', `${chapter.title} · ${provider === 'rules' ? '本地规则' : provider}`, 'success');
  trackJob(job);
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
    state.project = await api(`/api/projects/${state.project.id}/chapters/${chapter.id}/script-import`, { method: 'POST', body: { script: raw } });
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
  const selectionChanged = state.selectedLineId !== lineId;
  state.selectedLineId = lineId;
  if (selectionChanged && state.view === 'studio') renderView();
  updateTransportForSelection();
  const audio = $('#audio-player');
  if (audio.src !== new URL(line.render.mediaUrl, location.href).href) audio.src = line.render.mediaUrl;
  state.loadedAudio = { kind: 'line', id: lineId, url: line.render.mediaUrl };
  try { await audio.play(); $('.play-main').textContent = 'Ⅱ'; } catch (error) { toast('无法播放', error.message, 'error'); }
}

function stepLine(direction) {
  const lines = currentChapter()?.scenes?.flatMap((scene) => scene.lines || []) || [];
  if (!lines.length) return;
  const index = Math.max(0, lines.findIndex((line) => line.id === state.selectedLineId));
  const next = lines[(index + direction + lines.length) % lines.length];
  state.selectedLineId = next.id;
  renderView();
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
  const target = event.target.closest('[data-nav], [data-action]');
  if (!target) return;
  if (target.dataset.nav) {
    event.preventDefault(); closeJobs(); if (!closeModal()) return; await navigate(target.dataset.nav); return;
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
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'modal-backdrop' && event.target === target) { closeModal(); return; }
    if (action === 'open-jobs') { openJobs(); return; }
    if (action === 'close-jobs') { closeJobs(); return; }
    if (action === 'select-chapter') { resetPlayback(); state.selectedChapterId = target.dataset.chapterId; state.selectedLineId = null; renderView(); return; }
    if (action === 'select-line') {
      if (state.selectedLineId !== target.dataset.lineId) {
        state.selectedLineId = target.dataset.lineId;
        if (event.target.closest('textarea, select, input, button')) {
          $$('.script-line').forEach((item) => item.classList.toggle('selected', item.dataset.lineId === state.selectedLineId));
          updateTransportForSelection();
        } else renderView();
      }
      return;
    }
    if (action === 'filter-lines') { state.lineFilter = target.dataset.filter; renderView(); return; }
    if (action === 'open-script-modal') { showModal(scriptModalHtml(), 'wide'); return; }
    if (action === 'run-script') { await runScript(); return; }
    if (action === 'new-codex-session') { startNewCodexSession(); return; }
    if (action === 'select-codex-session') { selectCodexSession(target.dataset.sessionId); return; }
    if (action === 'use-codex-default-model') {
      state.codexModel = '';
      const model = $('#codex-model');
      if (model) { model.value = ''; model.focus(); }
      return;
    }
    if (action === 'refresh-codex-room') {
      rememberCodexComposer();
      await api('/api/system?refresh=1');
      await refreshBootstrap();
      renderCodexStudio({ focus: 'composer' });
      toast('Codex 状态已重新检测', codexReadiness().label);
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

document.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'project-form') submitProject(event.target);
  if (event.target.id === 'voice-form') submitVoice(event.target);
  if (event.target.id === 'codex-chat-form') submitCodexMessage();
});

document.addEventListener('change', async (event) => {
  const input = event.target;
  if (input.name === 'script-mode') {
    state.codexMode = CODEX_MODE_LABELS[input.value] ? input.value : 'faithful';
    return;
  }
  if (input.id === 'script-provider' && input.value === 'codex') {
    const mode = $('input[name="script-mode"]:checked')?.value || state.codexMode;
    openCodexStudio(mode);
    return;
  }
  if (input.id === 'codex-model') { state.codexModel = input.value.trim(); return; }
  if (input.id === 'codex-room-mode') { state.codexMode = CODEX_MODE_LABELS[input.value] ? input.value : 'faithful'; return; }
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
    if (input.dataset.lineField === 'speakerId' && !input.closest('.codex-room-modal')) renderView();
    return;
  }
  if (input.dataset.roleVoice) {
    const previous = roleForLine(findLine(state.selectedLineId))?.voiceId || '';
    try {
      state.project = await api(`/api/projects/${state.project.id}/characters/${input.dataset.roleVoice}`, { method: 'PATCH', body: { voiceId: input.value || null } });
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

document.addEventListener('click', async (event) => {
  const emotion = event.target.closest('.emotion-button[data-line-field="emotion"]');
  if (!emotion) return;
  scheduleLineSave(emotion.dataset.lineId, { emotion: emotion.dataset.value });
  const line = findLine(emotion.dataset.lineId);
  if (line) line.emotion = emotion.dataset.value;
  $$('.emotion-button').forEach((button) => button.classList.toggle('active', button === emotion));
});

document.addEventListener('click', (event) => {
  const zone = event.target.closest('#book-drop-zone, #voice-drop-zone, #voice-source-drop-zone');
  if (!zone || event.target.matches('input')) return;
  if (zone.id === 'book-drop-zone') $('#modal-book-file')?.click();
  else if (zone.id === 'voice-drop-zone') $('#modal-voice-file')?.click();
  else $('#modal-voice-source-file')?.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if ($('#modal-root .modal')) closeModal();
    else if ($('#job-drawer').classList.contains('open')) closeJobs();
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
audio.addEventListener('ended', () => { $('.play-main').textContent = '▶'; });
audio.addEventListener('pause', () => { if (!audio.ended) $('.play-main').textContent = '▶'; });

window.addEventListener('hashchange', async () => {
  const route = parseRoute();
  if (route.view === 'studio' && route.id) await loadProject(route.id).catch(() => {});
  state.view = route.view; renderView();
});

async function boot() {
  try {
    await refreshBootstrap();
    const route = parseRoute();
    state.view = route.view;
    if (route.view === 'studio') {
      const id = route.id || state.bootstrap.projects[0]?.id;
      if (id) await loadProject(id); else state.view = 'projects';
    }
    renderView();
    const activeJobs = state.bootstrap.jobs.filter((job) => ['queued', 'running'].includes(job.state));
    activeJobs.forEach((job) => state.watchedJobs.add(job.id));
    if (activeJobs.length) state.jobTimer = setInterval(pollJobs, 900);
  } catch (error) {
    $('#app-main').innerHTML = `<section class="error-state"><h2>工作台启动失败</h2><p>${escapeHtml(error.message)}。请确认已经在项目目录运行 <code>npm start</code>。</p><button class="button primary" data-action="reload-app">重新加载</button></section>`;
  }
}

boot();
