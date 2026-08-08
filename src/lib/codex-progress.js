import crypto from 'node:crypto';
import { normalizeCodexDetailLevel, sanitizeCodexActivitySummary } from './codex-activity.js';
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes
} from './codex-options.js';

const PROGRESS_ID_PATTERN = /^codexprog_[0-9a-f]{32}$/;
const LAST_EVENT_ID_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;

const EVENT_DEFINITIONS = Object.freeze({
  'queued:waiting': { message: '请求已进入本章处理队列。', state: 'queued' },
  'starting:preparing': { message: '正在准备 Codex 剧本协作环境。', state: 'running' },
  'thread:started': { message: 'Codex 会话已建立。', state: 'running' },
  'turn:started': { message: 'Codex 已开始处理本轮请求。', state: 'running' },
  'turn:completed': { message: 'Codex 已完成本轮生成，正在校验结果。', state: 'running' },
  'stage:analyzing': { message: '正在分析章节结构与角色关系。', state: 'running' },
  'stage:drafting': { message: '正在整理台词、角色与表演标注。', state: 'running' },
  'stage:processing': { message: '正在处理剧本协作任务。', state: 'running' },
  'stage:validating': { message: '正在校验剧本结构。', state: 'running' },
  'stage:saving': { message: '正在安全保存本轮剧本。', state: 'running' },
  'completed:completed': { message: '本轮剧本协作已完成。', state: 'completed', terminal: true },
  'failed:failed': { message: '本轮剧本协作未完成，请检查 Codex 状态后重试。', state: 'failed', terminal: true }
});

const ACTIVITY_DEFINITIONS = Object.freeze({
  reasoning_summary: { phase: 'reasoning_summary', message: 'Codex 更新了简短分析摘要。' },
  command: { phase: 'activity', message: '正在执行受控本地操作。' },
  file: { phase: 'activity', message: '正在处理工作文件。' },
  mcp: { phase: 'activity', message: '正在调用受控连接器。' },
  web: { phase: 'activity', message: '正在执行受控信息检索。' },
  collaboration: { phase: 'activity', message: '正在协调协作步骤。' },
  plan: { phase: 'activity', message: '正在更新处理计划。' },
  tool: { phase: 'activity', message: '正在执行受控工具操作。' }
});

const SAFE_FAILURE_CODES = new Set([
  'CODEX_AUTH_REQUIRED', 'CODEX_CANCELLED', 'CODEX_CHAPTER_CHANGED', 'CODEX_FAILED', 'CODEX_INPUT_INVALID',
  'CODEX_JSONL_INVALID', 'CODEX_OUTPUT_TOO_LARGE', 'CODEX_RESPONSE_EMPTY',
  'CODEX_RESPONSE_MISSING', 'CODEX_SESSION_MISSING', 'CODEX_STDIN_FAILED',
  'CODEX_THREAD_MISSING', 'CODEX_TIMEOUT', 'CODEX_TIMEOUT_ACTIVE', 'CODEX_TIMEOUT_STARTING',
  'CODEX_TURN_FAILED', 'CODEX_UNAVAILABLE',
  'SCRIPT_SCHEMA_INVALID'
]);

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeFailureCode(value) {
  const code = String(value || '').toUpperCase();
  return SAFE_FAILURE_CODES.has(code) ? code : 'CODEX_REQUEST_FAILED';
}

function safeEventMessage(definition, type, code, timeoutMinutes) {
  if (type !== 'failed') return definition.message;
  if (code === 'CODEX_TIMEOUT_ACTIVE') {
    return `Codex 已开始生成，但未在 ${timeoutMinutes} 分钟内完成。`;
  }
  if (code === 'CODEX_TIMEOUT_STARTING') {
    return `Codex 未能在 ${timeoutMinutes} 分钟内开始响应。`;
  }
  if (code === 'CODEX_TIMEOUT') {
    return `Codex 未能在 ${timeoutMinutes} 分钟内完成处理。`;
  }
  return definition.message;
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function eventsUrl(record) {
  return `/api/projects/${encodeURIComponent(record.projectId)}/chapters/${encodeURIComponent(record.chapterId)}/codex-progress/${record.id}`;
}

function safeSnapshot(record, now) {
  let latest;
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    if (record.events[index].type !== 'activity') {
      latest = record.events[index];
      break;
    }
  }
  const elapsedUntil = record.terminal ? record.updatedAt : now;
  const snapshot = {
    progressId: record.id,
    detailLevel: record.detailLevel,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    timeoutMinutes: record.timeoutMinutes,
    state: record.state,
    phase: latest?.phase || 'waiting',
    message: latest?.message || EVENT_DEFINITIONS['queued:waiting'].message,
    startedAt: isoTime(record.startedAt),
    updatedAt: isoTime(record.updatedAt),
    elapsedMs: Math.max(0, Math.min(86_400_000, elapsedUntil - record.startedAt)),
    terminal: record.terminal,
    eventsUrl: eventsUrl(record)
  };
  if (latest?.type === 'failed' && latest.data?.code) {
    snapshot.code = safeFailureCode(latest.data.code);
  }
  return snapshot;
}

function serializeFrame(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function parseCodexLastEventId(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value);
  if (!LAST_EVENT_ID_PATTERN.test(text)) {
    throw httpError('Last-Event-ID 格式无效。', 400, 'CODEX_PROGRESS_EVENT_ID_INVALID');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw httpError('Last-Event-ID 格式无效。', 400, 'CODEX_PROGRESS_EVENT_ID_INVALID');
  }
  return parsed;
}

/**
 * In-memory, non-persistent broker for the public, sanitized subset of Codex progress.
 * Private prompts, JSONL events, model output and CLI diagnostics never enter a record.
 */
export class CodexProgressManager {
  constructor({
    now = Date.now,
    terminalTtlMs = 10 * 60_000,
    summaryTerminalTtlMs = 2 * 60_000,
    maxRecords = 128,
    maxActive = 4,
    maxActivePerChapter = 1,
    maxEvents = 96,
    maxActivityEvents = 24,
    maxActivityTextBytes = 8 * 1024,
    activityIntervalMs = 500,
    maxSubscribers = 8,
    maxPendingFrames = 12,
    heartbeatMs = 15_000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}) {
    this.now = now;
    this.terminalTtlMs = Math.max(1_000, Number(terminalTtlMs) || 10 * 60_000);
    this.summaryTerminalTtlMs = Math.max(1_000, Number(summaryTerminalTtlMs) || 2 * 60_000);
    this.maxRecords = Math.max(4, Number(maxRecords) || 128);
    this.maxActive = Math.max(1, Number(maxActive) || 4);
    this.maxActivePerChapter = Math.max(1, Number(maxActivePerChapter) || 1);
    this.maxEvents = Math.max(8, Number(maxEvents) || 96);
    this.maxActivityEvents = Math.max(1, Math.min(24, Number(maxActivityEvents) || 24));
    this.maxActivityTextBytes = Math.max(256, Math.min(8 * 1024, Number(maxActivityTextBytes) || 8 * 1024));
    this.activityIntervalMs = Math.max(500, Number(activityIntervalMs) || 500);
    this.maxSubscribers = Math.max(1, Number(maxSubscribers) || 8);
    this.maxPendingFrames = Math.max(1, Number(maxPendingFrames) || 12);
    this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || 15_000);
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.records = new Map();
    this.closed = false;
    this.cleanupTimer = this.setIntervalFn(
      () => this.prune(),
      Math.min(60_000, this.terminalTtlMs, this.summaryTerminalTtlMs)
    );
    this.cleanupTimer?.unref?.();
  }

  prune() {
    const now = this.now();
    for (const [progressId, record] of this.records) {
      if (record.terminal && record.expiresAt <= now) this.#remove(progressId);
    }
  }

  create({ projectId, chapterId, detailLevel, model, reasoningEffort, timeoutMinutes } = {}) {
    if (this.closed) throw httpError('Codex 进度服务正在关闭。', 503, 'CODEX_PROGRESS_UNAVAILABLE');
    const ownerProjectId = String(projectId || '');
    const ownerChapterId = String(chapterId || '');
    const normalizedDetailLevel = normalizeCodexDetailLevel(detailLevel);
    const normalizedModel = normalizeCodexModel(model);
    const normalizedReasoningEffort = normalizeCodexReasoningEffort(reasoningEffort);
    const normalizedTimeoutMinutes = normalizeCodexTimeoutMinutes(timeoutMinutes);
    if (!ownerProjectId || !ownerChapterId) {
      throw httpError('Codex 进度缺少项目或章节边界。', 400, 'CODEX_PROGRESS_SCOPE_INVALID');
    }
    this.prune();
    const activeRecords = [...this.records.values()].filter((record) => !record.terminal);
    if (activeRecords.length >= this.maxActive) {
      throw httpError('同时进行的 Codex 请求过多，请稍后重试。', 503, 'CODEX_PROGRESS_CAPACITY');
    }
    const chapterActive = activeRecords.filter((record) => (
      record.projectId === ownerProjectId && record.chapterId === ownerChapterId
    ));
    if (chapterActive.length >= this.maxActivePerChapter) {
      throw httpError('本章已有 Codex 请求正在处理，请等待完成后再试。', 409, 'CODEX_PROGRESS_ACTIVE');
    }
    if (this.records.size >= this.maxRecords) {
      const terminalRecords = [...this.records.values()]
        .filter((record) => record.terminal)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      while (this.records.size >= this.maxRecords && terminalRecords.length) this.#remove(terminalRecords.shift().id);
    }
    if (this.records.size >= this.maxRecords) {
      throw httpError('同时进行的 Codex 请求过多，请稍后重试。', 503, 'CODEX_PROGRESS_CAPACITY');
    }

    const timestamp = this.now();
    const record = {
      id: `codexprog_${crypto.randomBytes(16).toString('hex')}`,
      projectId: ownerProjectId,
      chapterId: ownerChapterId,
      detailLevel: normalizedDetailLevel,
      model: normalizedModel,
      reasoningEffort: normalizedReasoningEffort,
      timeoutMinutes: normalizedTimeoutMinutes,
      state: 'queued',
      startedAt: timestamp,
      updatedAt: timestamp,
      terminal: false,
      expiresAt: Number.POSITIVE_INFINITY,
      nextEventId: 1,
      events: [],
      subscribers: new Set(),
      activityCount: 0,
      activityTextBytes: 0,
      activityKeys: new Set(),
      lastActivityAt: Number.NEGATIVE_INFINITY,
      controller: new AbortController(),
      task: null
    };
    this.records.set(record.id, record);
    this.publish(record.id, { type: 'queued', phase: 'waiting' });
    return safeSnapshot(record, this.now());
  }

  publish(progressId, { type, phase, code, category, text } = {}) {
    const record = this.records.get(String(progressId || ''));
    if (!record || record.terminal) return null;
    const normalizedType = String(type || '');
    const normalizedPhase = String(phase || '');
    const normalizedCategory = String(category || '');
    const activityDefinition = normalizedType === 'activity' ? ACTIVITY_DEFINITIONS[normalizedCategory] : null;
    const isActivity = Boolean(
      activityDefinition && record.detailLevel === 'summary' && activityDefinition.phase === normalizedPhase
    );
    const definition = isActivity
      ? { ...activityDefinition, state: 'running' }
      : EVENT_DEFINITIONS[`${normalizedType}:${normalizedPhase}`];
    if (!definition) return safeSnapshot(record, this.now());

    let safeText;
    let activityKey;
    if (normalizedType === 'activity') {
      if (!isActivity) return safeSnapshot(record, this.now());
      safeText = normalizedCategory === 'reasoning_summary'
        ? sanitizeCodexActivitySummary(text)
        : undefined;
      if (normalizedCategory === 'reasoning_summary' && !safeText) return safeSnapshot(record, this.now());
      activityKey = `${normalizedCategory}:${safeText || ''}`;
      if (record.activityKeys.has(activityKey)) return safeSnapshot(record, this.now());
      if (record.activityCount >= this.maxActivityEvents) return safeSnapshot(record, this.now());
      const activityTextBytes = safeText ? Buffer.byteLength(safeText, 'utf8') : 0;
      if (record.activityTextBytes + activityTextBytes > this.maxActivityTextBytes) {
        return safeSnapshot(record, this.now());
      }
      if (this.now() - record.lastActivityAt < this.activityIntervalMs) return safeSnapshot(record, this.now());
    }

    const previous = record.events.at(-1);
    if (!isActivity && !definition.terminal && previous?.type === normalizedType && previous?.phase === normalizedPhase) {
      return safeSnapshot(record, this.now());
    }
    // Keep one slot reserved for a terminal event; extra CLI updates are intentionally dropped.
    if (!definition.terminal && record.events.length >= this.maxEvents - 1) {
      return safeSnapshot(record, this.now());
    }

    const timestamp = this.now();
    const failureCode = normalizedType === 'failed' ? safeFailureCode(code) : undefined;
    const publicMessage = safeEventMessage(
      definition, normalizedType, failureCode, record.timeoutMinutes
    );
    const data = {
      progressId: record.id,
      type: normalizedType,
      phase: normalizedPhase,
      message: publicMessage,
      timeoutMinutes: record.timeoutMinutes,
      elapsedMs: Math.max(0, Math.min(86_400_000, timestamp - record.startedAt)),
      at: isoTime(timestamp),
      terminal: Boolean(definition.terminal)
    };
    if (isActivity) {
      data.category = normalizedCategory;
      if (safeText) data.text = safeText;
    }
    if (failureCode) data.code = failureCode;
    const event = {
      id: record.nextEventId,
      type: normalizedType,
      phase: normalizedPhase,
      message: publicMessage,
      data
    };
    // The full SSE frame, not merely its JSON payload, is bounded to one KiB.
    if (Buffer.byteLength(serializeFrame(event), 'utf8') > 1_024) return safeSnapshot(record, timestamp);
    record.nextEventId += 1;
    record.events.push(event);
    if (isActivity) {
      record.activityCount += 1;
      record.activityTextBytes += safeText ? Buffer.byteLength(safeText, 'utf8') : 0;
      record.activityKeys.add(activityKey);
      record.lastActivityAt = timestamp;
    }
    record.state = definition.state;
    record.updatedAt = timestamp;
    if (definition.terminal) {
      record.terminal = true;
      record.expiresAt = timestamp + (
        record.detailLevel === 'summary' ? this.summaryTerminalTtlMs : this.terminalTtlMs
      );
    }
    for (const subscriber of [...record.subscribers]) this.#send(subscriber, event);
    return safeSnapshot(record, timestamp);
  }

  complete(progressId) {
    return this.publish(progressId, { type: 'completed', phase: 'completed' });
  }

  fail(progressId, code) {
    return this.publish(progressId, { type: 'failed', phase: 'failed', code });
  }

  owned(progressId, projectId, chapterId) {
    this.prune();
    const id = String(progressId || '');
    if (!PROGRESS_ID_PATTERN.test(id)) {
      throw httpError('Codex 进度标识无效。', 404, 'CODEX_PROGRESS_NOT_FOUND');
    }
    const record = this.records.get(id);
    if (!record || record.projectId !== String(projectId || '') || record.chapterId !== String(chapterId || '')) {
      throw httpError('Codex 进度不存在或不属于当前章节。', 404, 'CODEX_PROGRESS_NOT_FOUND');
    }
    return record;
  }

  snapshot(progressId, projectId, chapterId) {
    return safeSnapshot(this.owned(progressId, projectId, chapterId), this.now());
  }

  signal(progressId, projectId, chapterId) {
    return this.owned(progressId, projectId, chapterId).controller.signal;
  }

  track(progressId, projectId, chapterId, task) {
    const record = this.owned(progressId, projectId, chapterId);
    if (record.task) throw httpError('Codex 进度已绑定执行任务。', 409, 'CODEX_PROGRESS_TASK_EXISTS');
    record.task = Promise.resolve(task);
    return record.task;
  }

  latest(projectId, chapterId) {
    this.prune();
    const records = [...this.records.values()].filter((record) => (
      record.projectId === String(projectId || '') && record.chapterId === String(chapterId || '')
    ));
    if (!records.length) return null;
    records.sort((a, b) => Number(a.terminal) - Number(b.terminal)
      || b.startedAt - a.startedAt || b.updatedAt - a.updatedAt);
    return safeSnapshot(records[0], this.now());
  }

  subscribe(req, res, { progressId, projectId, chapterId, lastEventId = 0 }) {
    const record = this.owned(progressId, projectId, chapterId);
    const lastId = parseCodexLastEventId(lastEventId);
    const latestId = record.nextEventId - 1;
    if (lastId > latestId) {
      throw httpError('Last-Event-ID 超出当前进度范围。', 400, 'CODEX_PROGRESS_EVENT_ID_INVALID');
    }
    if (record.subscribers.size >= this.maxSubscribers) {
      throw httpError('该请求的进度订阅过多。', 429, 'CODEX_PROGRESS_SUBSCRIBERS_FULL');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    res.flushHeaders?.();

    const subscriber = {
      req,
      res,
      record,
      closed: false,
      waitingDrain: false,
      pending: [],
      endAfterFlush: false,
      heartbeat: null,
      closeHandler: null
    };
    record.subscribers.add(subscriber);
    const close = () => this.#closeSubscriber(subscriber);
    subscriber.closeHandler = close;
    req.once('aborted', close);
    res.once('close', close);
    res.once('error', close);
    req.socket?.once('close', close);
    if (!res.write('retry: 2000\n\n')) {
      subscriber.waitingDrain = true;
      res.once('drain', () => this.#drain(subscriber));
    }
    for (const event of record.events) {
      if (event.id > lastId && !subscriber.closed) this.#send(subscriber, event);
    }
    if (!record.terminal && !subscriber.closed) {
      subscriber.heartbeat = this.setIntervalFn(() => {
        if (subscriber.closed || subscriber.waitingDrain) return;
        try {
          if (!res.write(': heartbeat\n\n')) {
            subscriber.waitingDrain = true;
            res.once('drain', () => this.#drain(subscriber));
          }
        } catch {
          this.#closeSubscriber(subscriber, { destroy: true });
        }
      }, this.heartbeatMs);
      subscriber.heartbeat?.unref?.();
    } else if (record.terminal && !subscriber.closed) {
      subscriber.endAfterFlush = true;
      if (!subscriber.waitingDrain && !subscriber.pending.length) this.#closeSubscriber(subscriber, { end: true });
    }
  }

  shutdown() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.cleanupTimer) this.clearIntervalFn(this.cleanupTimer);
    this.cleanupTimer = null;
    const tasks = [];
    for (const record of this.records.values()) {
      if (record.task) tasks.push(record.task);
      if (!record.controller.signal.aborted) record.controller.abort();
      for (const subscriber of [...record.subscribers]) this.#closeSubscriber(subscriber, { destroy: true });
    }
    this.records.clear();
    return Promise.allSettled(tasks);
  }

  #send(subscriber, event) {
    if (subscriber.closed) return;
    const frame = serializeFrame(event);
    if (subscriber.waitingDrain || subscriber.pending.length) {
      if (subscriber.pending.length >= this.maxPendingFrames) {
        this.#closeSubscriber(subscriber, { destroy: true });
        return;
      }
      subscriber.pending.push(frame);
      if (event.data.terminal) subscriber.endAfterFlush = true;
      return;
    }
    let writable;
    try { writable = subscriber.res.write(frame); } catch {
      this.#closeSubscriber(subscriber, { destroy: true });
      return;
    }
    if (event.data.terminal) subscriber.endAfterFlush = true;
    if (!writable) {
      subscriber.waitingDrain = true;
      subscriber.res.once('drain', () => this.#drain(subscriber));
      return;
    }
    if (subscriber.endAfterFlush) this.#closeSubscriber(subscriber, { end: true });
  }

  #drain(subscriber) {
    if (subscriber.closed) return;
    subscriber.waitingDrain = false;
    while (subscriber.pending.length && !subscriber.closed) {
      let writable;
      try { writable = subscriber.res.write(subscriber.pending.shift()); } catch {
        this.#closeSubscriber(subscriber, { destroy: true });
        return;
      }
      if (!writable) {
        subscriber.waitingDrain = true;
        subscriber.res.once('drain', () => this.#drain(subscriber));
        return;
      }
    }
    if (subscriber.endAfterFlush && !subscriber.pending.length) this.#closeSubscriber(subscriber, { end: true });
  }

  #closeSubscriber(subscriber, { end = false, destroy = false } = {}) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.record.subscribers.delete(subscriber);
    if (subscriber.closeHandler) {
      subscriber.req.off('aborted', subscriber.closeHandler);
      subscriber.res.off('close', subscriber.closeHandler);
      subscriber.res.off('error', subscriber.closeHandler);
      subscriber.req.socket?.off('close', subscriber.closeHandler);
      subscriber.closeHandler = null;
    }
    if (subscriber.heartbeat) this.clearIntervalFn(subscriber.heartbeat);
    subscriber.heartbeat = null;
    subscriber.pending.length = 0;
    if (destroy) subscriber.res.destroy();
    else if (end && !subscriber.res.writableEnded) subscriber.res.end();
  }

  #remove(progressId) {
    const record = this.records.get(progressId);
    if (!record) return;
    for (const subscriber of [...record.subscribers]) this.#closeSubscriber(subscriber, { end: true });
    this.records.delete(progressId);
  }
}

export const CODEX_PROGRESS_EVENT_TYPES = Object.freeze(
  [...new Set(Object.keys(EVENT_DEFINITIONS).map((key) => key.split(':')[0]))]
);
