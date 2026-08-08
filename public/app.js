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
  loadedAudio: null,
  jobTimer: null,
  watchedJobs: new Set(),
  notifiedJobs: new Set(),
  saveTimers: new Map(),
  codexPackage: null,
  modalTrigger: null
};

const statusLabels = {
  empty: '待导入', source: '等待剧本化', scripted: '剧本已就绪', rendered: '音频已生成',
  render_partial: '部分已生成', queued: '排队中', running: '进行中', completed: '已完成', failed: '失败'
};
const jobLabels = { script: '剧本润色', render: '语音生成', export: '音频导出' };
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
  state.modalTrigger = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal ${className}" role="dialog" aria-modal="true">${content}</section></div>`;
  const modal = $('#modal-root .modal');
  const title = modal?.querySelector('h2');
  if (title) { title.id = 'active-modal-title'; modal.setAttribute('aria-labelledby', title.id); }
  requestAnimationFrame(() => modal?.querySelector('[data-action="close-modal"], input, select, textarea, button')?.focus());
}

function closeModal() {
  stopRecorderTracks({ discard: true });
  $('#modal-root').innerHTML = '';
  state.bookFile = null;
  state.voiceFile = null;
  state.recordingBlob = null;
  if (state.modalTrigger?.isConnected) state.modalTrigger.focus();
  state.modalTrigger = null;
}

function stopRecorderTracks({ discard = false } = {}) {
  if (discard) state.recordingSession += 1;
  if (state.recorder?.state === 'recording') state.recorder.stop();
  state.recorderStream?.getTracks().forEach((track) => track.stop());
  state.recorderStream = null;
  state.recorder = null;
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
        <section class="panel integration-panel"><span class="eyebrow">SCRIPT POLISH</span><h3>Codex 剧本集成</h3><div class="integration-row"><div><label class="form-label">Codex CLI 命令</label><input class="field" value="${escapeHtml(settings.codexCommand)}" data-setting="codexCommand"><div class="tool-state ${system.tools.codex.runnable ? 'online' : ''}"><i></i>${system.tools.codex.runnable ? `已就绪 · ${escapeHtml(system.tools.codex.version || '')}` : '当前 WindowsApps 权限不允许后端直接启动；可使用“导出任务 / 导入 JSON”模式'}</div></div><button class="button" data-action="save-command">保存并检测</button></div></section>
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
      <div class="tabs"><button type="button" class="active" data-action="voice-tab" data-tab="record">麦克风录制</button><button type="button" data-action="voice-tab" data-tab="upload">导入音频</button></div>
      <div id="voice-record-pane"><div class="record-box"><div><button type="button" class="record-button" id="record-button" data-action="toggle-record" aria-label="开始录音"></button><p id="record-status">点击红色按钮开始录制，建议 10–30 秒安静、清晰的人声</p></div></div></div>
      <div id="voice-upload-pane" hidden><div class="drop-zone" id="voice-drop-zone" role="button" tabindex="0"><div><span class="drop-icon">♫</span><strong>选择参考音频或开源音色样本</strong><small>WAV / MP3 / M4A / WebM / FLAC，最大 25MB</small><div class="selected-file" id="voice-file-label"></div></div><input id="modal-voice-file" type="file" accept="audio/*,.flac" hidden></div></div>
      <div class="form-grid" style="margin-top:16px"><div class="form-group"><label>音色名称</label><input class="field" name="name" required placeholder="例如：林默 · 青年男声"></div><div class="form-group"><label>标签</label><input class="field" name="tags" placeholder="沉稳, 青年, 旁白"></div>
        <div class="form-group full"><label>参考音频准确文字</label><textarea class="text-field" name="transcript" required placeholder="逐字填写录音中实际说出的内容，克隆效果会更稳定。"></textarea></div>
        <div class="form-group full"><label class="checkbox-row"><input type="checkbox" name="consent" required><span>我确认已取得声音本人授权，或样本的开源许可证允许此用途；不冒充、不欺骗、不侵犯他人权益。</span></label></div>
      </div>
    </div><footer class="modal-foot"><button type="button" class="button ghost" data-action="close-modal">取消</button><button type="submit" class="button primary">保存到音色库</button></footer></form>`;
}

function scriptModalHtml() {
  const chapter = currentChapter();
  const codexReady = state.bootstrap.system.tools.codex.runnable;
  return `<header class="modal-head"><div><span class="eyebrow">SCRIPT POLISH</span><h2>把小说转成配音剧本</h2></div><button class="icon-button" data-action="close-modal">×</button></header>
    <div class="modal-body"><div class="modal-note">当前处理：${escapeHtml(chapter?.title || '')}。原文始终保留；剧本会生成独立的朗读文本、角色、情绪和停顿。</div>
      <div class="form-group"><label>润色档位</label><div class="mode-cards">
        <label class="mode-card"><input type="radio" name="script-mode" value="faithful" checked><strong>忠实朗读</strong><small>不增写剧情，只做归属与情绪标注</small></label>
        <label class="mode-card"><input type="radio" name="script-mode" value="polished"><strong>轻度剧本化</strong><small>优化书面结构和朗读节奏</small></label>
        <label class="mode-card"><input type="radio" name="script-mode" value="drama"><strong>广播剧化</strong><small>适度压缩叙述，增强表演提示</small></label>
      </div></div>
      <div class="form-group" style="margin-top:16px"><label>处理方式</label><select class="select-field" id="script-provider"><option value="rules">本地规则引擎 · 立即完成</option><option value="codex" ${codexReady ? '' : 'disabled'}>Codex CLI · ${codexReady ? '已就绪' : '当前不可直接启动'}</option><option value="ollama">本地 Ollama · 结构化输出</option></select></div>
      <div class="modal-note" style="margin-top:15px;border-color:rgba(120,223,201,.12);background:rgba(120,223,201,.035)">推荐：先用规则引擎快速得到可编辑剧本；重点章节用 Codex 任务包精修。当前环境可直接复制任务给 Codex，再将 JSON 结果导回。</div>
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
  const chapter = currentChapter();
  closeModal();
  const job = await api(`/api/projects/${state.project.id}/script`, { method: 'POST', body: { chapterIds: [chapter.id], provider, mode } });
  toast('剧本任务已提交', `${chapter.title} · ${provider === 'rules' ? '本地规则' : provider}`, 'success');
  trackJob(job);
}

async function openCodexPackage() {
  const mode = $('input[name="script-mode"]:checked')?.value || 'faithful';
  const chapter = currentChapter();
  state.codexPackage = await api(`/api/projects/${state.project.id}/chapters/${chapter.id}/codex-package?mode=${mode}`);
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
    } catch (error) { toast('自动保存失败', error.message, 'error'); }
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
    event.preventDefault(); closeJobs(); closeModal(); await navigate(target.dataset.nav); return;
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
    if (action === 'open-codex-package') { await openCodexPackage(); return; }
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
    if (action === 'new-voice') { showModal(voiceModalHtml()); return; }
    if (action === 'voice-tab') {
      $$('.tabs button').forEach((button) => button.classList.toggle('active', button === target));
      if (target.dataset.tab === 'upload') { stopRecorderTracks({ discard: true }); state.recordingBlob = null; }
      else state.voiceFile = null;
      $('#voice-record-pane').hidden = target.dataset.tab !== 'record'; $('#voice-upload-pane').hidden = target.dataset.tab !== 'upload'; return;
    }
    if (action === 'toggle-record') {
      if (state.recorder?.state === 'recording') state.recorder.stop(); else await startRecording(); return;
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
});

document.addEventListener('change', async (event) => {
  const input = event.target;
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
  if (input.dataset.lineField) {
    const value = ['intensity', 'pace', 'pauseAfterMs'].includes(input.dataset.lineField) ? Number(input.value) : input.value;
    scheduleLineSave(input.dataset.lineId, { [input.dataset.lineField]: value });
    if (input.dataset.lineField === 'speakerId') renderView();
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
  const zone = event.target.closest('#book-drop-zone, #voice-drop-zone');
  if (!zone || event.target.matches('input')) return;
  if (zone.id === 'book-drop-zone') $('#modal-book-file')?.click();
  else $('#modal-voice-file')?.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if ($('#modal-root .modal')) closeModal();
    else if ($('#job-drawer').classList.contains('open')) closeJobs();
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
    } else { state.voiceFile = file; state.recordingBlob = null; $('#voice-file-label').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`; }
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
