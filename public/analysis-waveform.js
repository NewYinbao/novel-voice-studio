// A small, dependency-free PCM waveform editor. Only visible tracks load peaks;
// decoded audio is never kept for an entire long recording in browser memory.
const peaksCache = new Map();
const selections = new Map();
const waiting = [];
let active = 0;
function drain() {
  while (active < 3 && waiting.length) {
    const { run, resolve, reject } = waiting.shift();
    active += 1;
    Promise.resolve().then(run).then(resolve, reject).finally(() => { active -= 1; drain(); });
  }
}
function boundedFetch(run) { return new Promise((resolve, reject) => { waiting.push({ run, resolve, reject }); drain(); }); }
function remember(map, key, value, limit = 100) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

class AnalysisWaveform extends HTMLElement {
  connectedCallback() {
    this.key = `${this.getAttribute('analysis-id')}:${this.getAttribute('segment-id')}:${this.getAttribute('audio-revision')}`;
    this.controller = new AbortController();
    this.innerHTML = `<div class="wave-heading"><strong>片段音轨</strong><span class="wave-status" role="status">滚动到此处加载波形…</span></div>
      <div class="wave-track" aria-label="音频波形，点击定位"><canvas aria-label="真实音频振幅波形" role="img"></canvas><div class="wave-selection"></div><i class="wave-playhead"></i>
        <button type="button" class="wave-handle start" data-bound="start" role="slider" aria-label="裁剪起点" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" disabled></button>
        <button type="button" class="wave-handle end" data-bound="end" role="slider" aria-label="裁剪终点" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" disabled></button>
      </div>
      <div class="wave-controls"><button type="button" class="button small" data-wave="play" disabled>▶ 试听选区</button><label>起点 <input type="number" step="0.01" min="0" data-bound="start" aria-label="裁剪起点（秒）" disabled> 秒</label><label>终点 <input type="number" step="0.01" min="0" data-bound="end" aria-label="裁剪终点（秒）" disabled> 秒</label><span class="wave-length"></span><button type="button" class="button small primary" data-wave="trim" disabled>应用裁剪</button><button type="button" class="button small" data-wave="silence" disabled>自动去静音</button><button type="button" class="button small" data-wave="restore" disabled>恢复原片段</button><button type="button" class="button small" data-wave="retry" hidden>重载波形</button></div>
      <audio preload="none"></audio>`;
    this.track = this.querySelector('.wave-track');
    this.audio = this.querySelector('audio');
    this.start = 0; this.end = 0; this.duration = 0;
    const options = { signal: this.controller.signal };
    this.addEventListener('click', (event) => this.click(event), options);
    for (const name of ['input', 'change']) this.addEventListener(name, (event) => {
      if (event.target.matches('input[data-bound]')) this.setBound(event.target.dataset.bound, event.target.valueAsNumber);
    }, options);
    this.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.wave-handle');
      if (!handle || handle.disabled) return;
      event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
      this.dragging = { bound: handle.dataset.bound, pointerId: event.pointerId };
    }, options);
    this.addEventListener('pointermove', (event) => {
      if (!this.dragging || this.dragging.pointerId !== event.pointerId) return;
      const rect = this.track.getBoundingClientRect();
      this.setBound(this.dragging.bound, (event.clientX - rect.left) / rect.width * this.duration);
    }, options);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.addEventListener(name, () => { this.dragging = null; }, options);
    this.addEventListener('keydown', (event) => {
      const handle = event.target.closest('.wave-handle');
      if (!handle || handle.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const bound = handle.dataset.bound;
      this.setBound(bound, event.key === 'Home' ? 0 : event.key === 'End' ? this.duration : this[bound] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .1 : .01));
    }, options);
    this.audio.addEventListener('play', () => {
      for (const player of document.querySelectorAll('audio, video')) if (player !== this.audio) player.pause();
      this.tick();
    }, options);
    this.audio.addEventListener('pause', () => { cancelAnimationFrame(this.frame); this.querySelector('[data-wave="play"]').textContent = '▶ 试听选区'; }, options);
    this.audio.addEventListener('timeupdate', () => this.updatePlayhead(), options);
    this.audio.addEventListener('error', () => this.status('音频无法播放，请重载波形后重试。'), options);
    this.resize = new ResizeObserver(() => this.draw()); this.resize.observe(this.track);
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { this.observer.disconnect(); this.load(); }
    }, { rootMargin: '120px' });
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.audio?.pause(); this.controller?.abort(); this.observer?.disconnect(); this.resize?.disconnect(); cancelAnimationFrame(this.frame);
  }
  status(message) { this.querySelector('.wave-status').textContent = message; }
  async load(fresh = false) {
    this.status('正在读取真实波形…');
    this.querySelector('[data-wave="retry"]').hidden = true;
    try {
      const data = !fresh && peaksCache.get(this.key) || await boundedFetch(async () => {
        if (this.controller.signal.aborted) throw new DOMException('Detached', 'AbortError');
        const url = `/api/voice-analyses/${encodeURIComponent(this.getAttribute('analysis-id'))}/segments/${encodeURIComponent(this.getAttribute('segment-id'))}/waveform`;
        const response = await fetch(url, { signal: this.controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || '读取波形失败');
        return result;
      });
      if (!this.isConnected) return;
      this.key = `${this.getAttribute('analysis-id')}:${this.getAttribute('segment-id')}:${data.audioRevision}`;
      remember(peaksCache, this.key, data);
      this.data = data; this.duration = data.durationMs / 1000;
      const saved = selections.get(this.key);
      this.start = Math.max(0, Math.min(saved?.start || 0, this.duration - .1));
      this.end = Math.min(this.duration, Math.max(saved?.end ?? this.duration, this.start + .1));
      this.audio.src = data.mediaUrl;
      this.sync(); this.draw();
      this.status(`拖动两端裁剪 · 当前 ${this.duration.toFixed(2)} 秒`);
    } catch (error) {
      if (error.name === 'AbortError' || !this.isConnected) return;
      this.status(error.message);
      this.querySelector('[data-wave="retry"]').hidden = false;
    }
  }
  setBusy(busy) { this.busy = busy; this.audio.pause(); this.sync(); this.status(busy ? '正在保存音频，请稍候…' : `拖动两端裁剪 · 当前 ${this.duration.toFixed(2)} 秒`); }
  setBound(bound, value) {
    if (!Number.isFinite(value) || !this.data || this.busy || this.duration < .1) return;
    this.audio.pause();
    this[bound] = Math.round((bound === 'start' ? Math.max(0, Math.min(value, this.end - .1)) : Math.min(this.duration, Math.max(value, this.start + .1))) * 1000) / 1000;
    remember(selections, this.key, { start: this.start, end: this.end }); this.sync();
  }
  sync() {
    const enabled = Boolean(this.data) && !this.busy;
    for (const control of this.querySelectorAll('button:not([data-wave="retry"]), input')) control.disabled = !enabled;
    this.querySelector('[data-wave="trim"]').disabled = !enabled || this.duration < .1 || (this.start === 0 && this.end === this.duration);
    this.querySelector('[data-wave="restore"]').disabled = !enabled || this.getAttribute('can-restore') !== 'true';
    for (const bound of ['start', 'end']) {
      const input = this.querySelector(`input[data-bound="${bound}"]`);
      input.disabled = !enabled || this.duration < .1;
      if (document.activeElement !== input) input.value = this[bound].toFixed(3);
      input.max = this.duration;
      const handle = this.querySelector(`button[data-bound="${bound}"]`);
      handle.disabled = !enabled || this.duration < .1;
      handle.style.left = `${this.duration ? this[bound] / this.duration * 100 : 0}%`;
      handle.setAttribute('aria-valuemax', this.duration); handle.setAttribute('aria-valuenow', this[bound]); handle.setAttribute('aria-valuetext', `${this[bound].toFixed(2)} 秒`);
    }
    const selection = this.querySelector('.wave-selection');
    selection.style.left = `${this.duration ? this.start / this.duration * 100 : 0}%`;
    selection.style.width = `${this.duration ? (this.end - this.start) / this.duration * 100 : 100}%`;
    this.querySelector('.wave-length').textContent = `选中 ${Math.max(0, this.end - this.start).toFixed(2)} 秒`;
  }
  draw() {
    if (!this.data || !this.isConnected) return;
    const canvas = this.querySelector('canvas');
    const width = Math.max(1, Math.floor(this.track.clientWidth));
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * ratio; canvas.height = 72 * ratio;
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.strokeStyle = '#2d4240'; ctx.beginPath(); ctx.moveTo(0, 36); ctx.lineTo(width, 36); ctx.stroke();
    ctx.fillStyle = '#78dfc9';
    const max = Math.max(.02, ...this.data.peaks);
    this.data.peaks.forEach((peak, index) => {
      const height = Math.max(1, peak / max * 58);
      ctx.fillRect(index / this.data.peaks.length * width, (72 - height) / 2, Math.max(1, width / this.data.peaks.length * .8), height);
    });
  }
  updatePlayhead() {
    if (!this.audio.paused && this.audio.currentTime >= this.end) this.audio.pause();
    this.querySelector('.wave-playhead').style.left = `${this.duration ? Math.min(100, this.audio.currentTime / this.duration * 100) : 0}%`;
  }
  tick() {
    this.updatePlayhead();
    if (this.audio.paused) return;
    this.querySelector('[data-wave="play"]').textContent = 'Ⅱ 暂停';
    this.frame = requestAnimationFrame(() => this.tick());
  }
  async click(event) {
    if (event.target.matches('canvas') && this.data) { this.audio.currentTime = Math.max(this.start, Math.min(this.end, event.offsetX / this.track.clientWidth * this.duration)); this.updatePlayhead(); }
    const action = event.target.closest('[data-wave]')?.dataset.wave;
    if (action === 'retry') return this.load(true);
    if (!action || !this.data || this.busy) return;
    if (action === 'play') {
      if (!this.audio.paused) return this.audio.pause();
      this.audio.currentTime = this.start;
      try { await this.audio.play(); } catch (error) { if (error.name !== 'AbortError') this.status(`无法试听：${error.message}`); }
      return;
    }
    this.dispatchEvent(new CustomEvent('analysis-audio-edit', { bubbles: true, detail: {
      analysisId: this.getAttribute('analysis-id'), segmentId: this.getAttribute('segment-id'),
      action, startMs: Math.round(this.start * 1000), endMs: Math.round(this.end * 1000), audioRevision: this.data.audioRevision,
    } }));
  }
}
customElements.define('analysis-waveform', AnalysisWaveform);
