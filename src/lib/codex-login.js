import { spawn } from 'node:child_process';

const LOGIN_ARGS = Object.freeze(['login']);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATE_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 2_000;

function nowIso() {
  return new Date().toISOString();
}

function timeoutIso(timeoutMs) {
  return new Date(Date.now() + timeoutMs).toISOString();
}

function safeCommand(command) {
  const value = typeof command === 'string' ? command.trim() : '';
  if (!value || value.length > 2_000 || /[\r\n\0]/.test(value)) {
    throw Object.assign(new Error('Codex CLI 命令无效'), {
      code: 'CODEX_UNAVAILABLE', statusCode: 409
    });
  }
  return value;
}

function safeSpawnMessage(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'ENOENT') return '未找到可启动的 Codex CLI。';
  if (code === 'EACCES' || code === 'EPERM') return 'Windows 拒绝启动 Codex CLI，请检查安装权限。';
  return 'Codex 登录流程启动失败。';
}

function baseState() {
  return {
    state: 'idle',
    message: '尚未发起 Codex 登录。',
    startedAt: null,
    finishedAt: null,
    timeoutAt: null,
    authenticated: false
  };
}

export function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase().split('%')[0];
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  const mapped = value.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(127(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1].split('.').every((part) => Number(part) <= 255);
  return /^(?:::ffff:|0:0:0:0:0:ffff:)7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(value);
}

export function assertLoopbackRequest(req) {
  if (isLoopbackAddress(req?.socket?.remoteAddress)) return;
  throw Object.assign(new Error('Codex 登录只能从本机页面发起。'), {
    code: 'CODEX_AUTH_LOCAL_ONLY', statusCode: 403
  });
}

export function assertSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return;
  const host = String(req?.headers?.host || '').trim().toLowerCase();
  const protocol = req?.socket?.encrypted ? 'https:' : 'http:';
  try {
    if (host && new URL(origin).origin.toLowerCase() === `${protocol}//${host}`) return;
  } catch {}
  throw Object.assign(new Error('Codex 登录只能由当前工作台页面发起。'), {
    code: 'CODEX_AUTH_SAME_ORIGIN_REQUIRED', statusCode: 403
  });
}

/**
 * Owns the single local `codex login` process. CLI output is deliberately ignored:
 * the app never needs to inspect or relay OAuth URLs, authorization codes, or tokens.
 */
export class CodexLoginManager {
  constructor({
    spawnProcess = spawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.active = null;
    this.state = baseState();
  }

  snapshot() {
    return { ...this.state };
  }

  reportAuthenticated() {
    if (this.active) return this.snapshot();
    const timestamp = nowIso();
    this.state = {
      state: 'succeeded',
      message: 'Codex 已登录，可以开始剧本协作。',
      startedAt: this.state.startedAt,
      finishedAt: timestamp,
      timeoutAt: null,
      authenticated: true
    };
    return this.snapshot();
  }

  start({ resolveCommand, verifyAuthenticated }) {
    if (this.active) return Promise.resolve(this.snapshot());
    if (typeof resolveCommand !== 'function' || typeof verifyAuthenticated !== 'function') {
      return Promise.reject(new TypeError('Codex 登录缺少服务器端状态解析器'));
    }

    // Reserve the singleton synchronously, before command discovery performs any I/O.
    const startedAt = nowIso();
    const active = {
      generation: ++this.generation,
      child: null,
      reason: null,
      timeoutTimer: null,
      terminateTimer: null,
      forceTimer: null,
      verifyAuthenticated
    };
    this.active = active;
    this.state = {
      state: 'starting',
      message: '正在检查 Codex CLI…',
      startedAt,
      finishedAt: null,
      timeoutAt: timeoutIso(this.timeoutMs),
      authenticated: false
    };
    return this.#resolveAndLaunch(active, resolveCommand);
  }

  async #resolveAndLaunch(active, resolveCommand) {
    let resolved;
    try {
      resolved = await resolveCommand();
    } catch (error) {
      if (this.#isCurrent(active)) this.#finish(active, 'failed', 'Codex CLI 当前不可用。');
      throw error;
    }
    if (!this.#isCurrent(active)) return this.snapshot();
    if (resolved?.authenticated) {
      return this.#finish(active, 'succeeded', 'Codex 已登录，可以开始剧本协作。', true);
    }

    let command;
    try {
      command = safeCommand(resolved?.command);
    } catch (error) {
      this.#finish(active, 'failed', 'Codex CLI 当前不可用。');
      throw error;
    }
    let child;
    try {
      child = this.spawnProcess(command, LOGIN_ARGS, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch (error) {
      return this.#finish(active, 'failed', safeSpawnMessage(error));
    }
    if (!this.#isCurrent(active)) {
      try { child.kill('SIGTERM'); } catch {}
      return this.snapshot();
    }

    active.child = child;
    this.state = {
      ...this.state,
      state: 'waiting',
      message: '浏览器登录已发起，请在 OpenAI 页面完成授权。'
    };
    let settled = false;
    const settle = (error, code, signal) => {
      if (settled) return;
      settled = true;
      void this.#processSettled(active, { error, code, signal });
    };
    child.once('error', (error) => settle(error, null, null));
    child.once('exit', (code, signal) => settle(null, code, signal));
    child.once('close', (code, signal) => settle(null, code, signal));

    active.timeoutTimer = this.#timer(() => this.#requestStop(active, 'timedOut'), this.timeoutMs);
    return this.snapshot();
  }

  async #processSettled(active, { error, code }) {
    if (!this.#isCurrent(active)) return;
    active.child = null;
    this.#clear(active.timeoutTimer);
    this.#clear(active.terminateTimer);
    this.#clear(active.forceTimer);
    if (active.reason === 'cancelled') {
      this.#finish(active, 'cancelled', 'Codex 登录已取消。');
      return;
    }
    if (active.reason === 'timedOut') {
      this.#finish(active, 'timedOut', 'Codex 登录等待超时，请重新发起。');
      return;
    }
    if (error) {
      this.#finish(active, 'failed', safeSpawnMessage(error));
      return;
    }
    if (code !== 0) {
      this.#finish(active, 'failed', 'Codex 登录未完成或已在登录页面取消。');
      return;
    }

    try {
      const authenticated = await active.verifyAuthenticated();
      if (!this.#isCurrent(active)) return;
      if (authenticated) {
        this.#finish(active, 'succeeded', 'Codex 登录成功，可以开始剧本协作。', true);
      } else {
        this.#finish(active, 'failed', '登录流程已结束，但尚未检测到有效的 Codex 登录状态。');
      }
    } catch {
      if (this.#isCurrent(active)) {
        this.#finish(active, 'failed', '登录流程已结束，但重新检测 Codex 状态失败。');
      }
    }
  }

  cancel() {
    if (!this.active) return this.snapshot();
    this.#requestStop(this.active, 'cancelled');
    return this.snapshot();
  }

  shutdown() {
    if (!this.active) return this.snapshot();
    this.#requestStop(this.active, 'cancelled', '应用服务正在关闭，Codex 登录已取消。');
    return this.snapshot();
  }

  #requestStop(active, reason, message) {
    if (!this.#isCurrent(active) || active.reason) return;
    active.reason = reason;
    this.#clear(active.timeoutTimer);
    this.state = {
      ...this.state,
      state: reason,
      message: message || (reason === 'timedOut'
        ? 'Codex 登录等待超时，请重新发起。'
        : 'Codex 登录已取消。'),
      finishedAt: nowIso(),
      timeoutAt: null,
      authenticated: false
    };

    if (!active.child) {
      this.#finish(active, reason, this.state.message);
      return;
    }
    try { active.child.kill('SIGTERM'); } catch {}
    active.terminateTimer = this.#timer(() => {
      if (!this.#isCurrent(active) || !active.child) return;
      try { active.child.kill('SIGKILL'); } catch {}
      active.forceTimer = this.#timer(() => {
        if (this.#isCurrent(active)) this.#finish(active, reason, this.state.message);
      }, FORCE_KILL_GRACE_MS);
    }, TERMINATE_GRACE_MS);
  }

  #finish(active, state, message, authenticated = false) {
    if (!this.#isCurrent(active)) return this.snapshot();
    this.#clear(active.timeoutTimer);
    this.#clear(active.terminateTimer);
    this.#clear(active.forceTimer);
    this.active = null;
    this.state = {
      state,
      message,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt || nowIso(),
      timeoutAt: null,
      authenticated
    };
    return this.snapshot();
  }

  #isCurrent(active) {
    return this.active === active && active.generation === this.generation;
  }

  #timer(callback, delay) {
    const timer = this.setTimer(callback, delay);
    timer?.unref?.();
    return timer;
  }

  #clear(timer) {
    if (timer) this.clearTimer(timer);
  }
}

export const codexLoginManager = new CodexLoginManager();
