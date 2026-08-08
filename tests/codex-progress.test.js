import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CodexProgressManager, parseCodexLastEventId } from '../src/lib/codex-progress.js';

class FakeResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.frames = [];
    this.headers = null;
    this.statusCode = null;
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  flushHeaders() {}

  write(value) {
    this.frames.push(String(value));
    return this.writeResults.length ? this.writeResults.shift() : true;
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function fakeIntervals() {
  const timers = new Set();
  return {
    timers,
    set(fn) {
      const timer = { fn, unref() {} };
      timers.add(timer);
      return timer;
    },
    clear(timer) { timers.delete(timer); }
  };
}

test('Codex progress 只保存固定事件、限制同章并发并在 TTL 后清理', () => {
  let now = Date.parse('2026-08-08T10:00:00.000Z');
  const manager = new CodexProgressManager({ now: () => now, terminalTtlMs: 1_000, maxEvents: 8 });
  const progress = manager.create({ projectId: 'project_a', chapterId: 'chapter_a' });
  assert.match(progress.progressId, /^codexprog_[0-9a-f]{32}$/);
  assert.equal(progress.timeoutMinutes, 10);
  for (const timeoutMinutes of [4, 121, 5.5, '', '10', true, [], {}, NaN, Infinity]) {
    assert.throws(
      () => manager.create({ projectId: 'invalid', chapterId: 'invalid', timeoutMinutes }),
      (error) => error.code === 'CODEX_TIMEOUT_MINUTES_INVALID'
    );
  }
  assert.throws(
    () => manager.create({ projectId: 'project_a', chapterId: 'chapter_a' }),
    (error) => error.statusCode === 409 && error.code === 'CODEX_PROGRESS_ACTIVE'
  );

  manager.publish(progress.progressId, {
    type: 'stage', phase: 'analyzing', message: '小说原文 secret', reasoning: 'hidden chain', threadId: 'thread-secret'
  });
  for (let index = 0; index < 20; index += 1) {
    manager.publish(progress.progressId, { type: 'stage', phase: index % 2 ? 'drafting' : 'processing' });
  }
  manager.fail(progress.progressId, 'SECRET_ERROR_WITH_PATH');
  const record = manager.owned(progress.progressId, 'project_a', 'chapter_a');
  assert.ok(record.events.length <= 8);
  assert.equal(record.events.at(-1).data.terminal, true);
  assert.equal(record.events.at(-1).data.code, 'CODEX_REQUEST_FAILED');
  assert.ok(record.events.every((event) => event.data.timeoutMinutes === 10));
  assert.equal(
    manager.snapshot(progress.progressId, 'project_a', 'chapter_a').code,
    'CODEX_REQUEST_FAILED'
  );
  assert.doesNotMatch(JSON.stringify(record.events), /小说原文|hidden chain|thread-secret|SECRET_ERROR/i);

  const ollama = manager.create({
    projectId: 'project_ollama', chapterId: 'chapter_ollama', provider: 'ollama', model: ''
  });
  assert.equal(ollama.provider, 'ollama');
  assert.equal(ollama.model, 'qwen3:8b');
  assert.equal(ollama.reasoningEffort, null);
  assert.equal(manager.owned(ollama.progressId, 'project_ollama', 'chapter_ollama').events[0].data.provider, 'ollama');
  manager.complete(ollama.progressId);
  assert.throws(
    () => manager.create({ projectId: 'bad', chapterId: 'bad', provider: 'ollama', model: '--remote' }),
    (error) => error.code === 'OLLAMA_MODEL_INVALID'
  );

  const next = manager.create({
    projectId: 'project_a', chapterId: 'chapter_a', timeoutMinutes: 120
  });
  assert.equal(next.timeoutMinutes, 120);
  manager.complete(next.progressId);
  const timedOut = manager.create({
    projectId: 'project_timeout', chapterId: 'chapter_timeout', timeoutMinutes: 120
  });
  manager.fail(timedOut.progressId, 'CODEX_TIMEOUT_STARTING');
  const timeoutSnapshot = manager.snapshot(
    timedOut.progressId, 'project_timeout', 'chapter_timeout'
  );
  assert.equal(timeoutSnapshot.code, 'CODEX_TIMEOUT_STARTING');
  assert.equal(timeoutSnapshot.timeoutMinutes, 120);
  assert.match(timeoutSnapshot.message, /120 分钟/);
  const completedElapsed = manager.latest('project_a', 'chapter_a').elapsedMs;
  now += 500;
  assert.equal(manager.latest('project_a', 'chapter_a').elapsedMs, completedElapsed);
  now += 501;
  manager.prune();
  assert.equal(manager.latest('project_a', 'chapter_a'), null);
  manager.shutdown();
});

test('Codex progress SSE 支持回放、严格 Last-Event-ID 与终态关闭', () => {
  const manager = new CodexProgressManager();
  const progress = manager.create({
    projectId: 'project_a', chapterId: 'chapter_a', timeoutMinutes: 5
  });
  const signal = manager.signal(progress.progressId, 'project_a', 'chapter_a');
  manager.publish(progress.progressId, { type: 'starting', phase: 'preparing' });
  manager.complete(progress.progressId);

  const req = new EventEmitter();
  const res = new FakeResponse();
  manager.subscribe(req, res, {
    projectId: 'project_a', chapterId: 'chapter_a', progressId: progress.progressId, lastEventId: '1'
  });
  const output = res.frames.join('');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.doesNotMatch(output, /id: 1\n/);
  assert.match(output, /id: 2\n/);
  assert.match(output, /event: completed/);
  assert.match(output, /"timeoutMinutes":5/);
  assert.equal(res.writableEnded, true);
  assert.throws(() => parseCodexLastEventId('01'), /Last-Event-ID/);
  assert.throws(() => manager.subscribe(new EventEmitter(), new FakeResponse(), {
    projectId: 'project_a', chapterId: 'chapter_a', progressId: progress.progressId, lastEventId: '999'
  }), (error) => error.code === 'CODEX_PROGRESS_EVENT_ID_INVALID');
  manager.shutdown();
  assert.equal(signal.aborted, true);
});

test('Codex progress SSE 在 heartbeat 回压后 drain，并对过慢客户端有界断开', () => {
  const intervals = fakeIntervals();
  const manager = new CodexProgressManager({
    maxPendingFrames: 2,
    setIntervalFn: (fn) => intervals.set(fn),
    clearIntervalFn: (timer) => intervals.clear(timer)
  });
  const progress = manager.create({ projectId: 'project_a', chapterId: 'chapter_a' });
  const req = new EventEmitter();
  // retry + queued are writable; heartbeat applies backpressure.
  const res = new FakeResponse([true, true, false, true]);
  manager.subscribe(req, res, {
    projectId: 'project_a', chapterId: 'chapter_a', progressId: progress.progressId
  });
  const heartbeat = [...intervals.timers].at(-1);
  heartbeat.fn();
  manager.publish(progress.progressId, { type: 'starting', phase: 'preparing' });
  assert.doesNotMatch(res.frames.join(''), /event: starting/);
  res.emit('drain');
  assert.match(res.frames.join(''), /event: starting/);
  res.emit('close');
  assert.equal(manager.owned(progress.progressId, 'project_a', 'chapter_a').subscribers.size, 0);
  manager.shutdown();

  const slowManager = new CodexProgressManager({ maxPendingFrames: 1 });
  const slowProgress = slowManager.create({ projectId: 'project_b', chapterId: 'chapter_b' });
  const slowRes = new FakeResponse([false]);
  slowManager.subscribe(new EventEmitter(), slowRes, {
    projectId: 'project_b', chapterId: 'chapter_b', progressId: slowProgress.progressId
  });
  slowManager.publish(slowProgress.progressId, { type: 'starting', phase: 'preparing' });
  assert.equal(slowRes.destroyed, true);
  slowManager.shutdown();
});

test('Codex progress shutdown 强制清理处于回压状态的 SSE', () => {
  const manager = new CodexProgressManager();
  const progress = manager.create({ projectId: 'project_a', chapterId: 'chapter_a' });
  const response = new FakeResponse([false]);
  manager.subscribe(new EventEmitter(), response, {
    projectId: 'project_a', chapterId: 'chapter_a', progressId: progress.progressId
  });
  manager.shutdown();
  assert.equal(response.destroyed, true);
  assert.equal(manager.records.size, 0);
});

test('Codex activity 仅在 summary 发布，并受频率、数量、文本与 SSE frame 上限约束', () => {
  let now = Date.parse('2026-08-08T12:00:00.000Z');
  const manager = new CodexProgressManager({ now: () => now, activityIntervalMs: 500 });
  const basic = manager.create({ projectId: 'project_basic', chapterId: 'chapter_basic' });
  assert.equal(basic.detailLevel, 'basic');
  const basicEventCount = manager.owned(basic.progressId, 'project_basic', 'chapter_basic').events.length;
  manager.publish(basic.progressId, {
    type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary', text: '不应公开'
  });
  assert.equal(
    manager.owned(basic.progressId, 'project_basic', 'chapter_basic').events.length,
    basicEventCount
  );
  manager.complete(basic.progressId);

  const summary = manager.create({
    projectId: 'project_summary', chapterId: 'chapter_summary', detailLevel: 'summary'
  });
  assert.equal(summary.detailLevel, 'summary');
  manager.publish(summary.progressId, {
    type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary',
    text: '正在梳理人物动机与叙事节奏。'.repeat(100)
  });
  // Duplicate and a second event inside 500 ms are both ignored.
  manager.publish(summary.progressId, {
    type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary',
    text: '正在梳理人物动机与叙事节奏。'.repeat(100)
  });
  now += 499;
  manager.publish(summary.progressId, { type: 'activity', phase: 'activity', category: 'command' });
  now += 1;
  manager.publish(summary.progressId, {
    type: 'activity', phase: 'activity', category: 'command',
    command: 'C:\\secret\\tool.exe', args: ['--token', 'secret']
  });
  for (let index = 0; index < 40; index += 1) {
    now += 500;
    manager.publish(summary.progressId, {
      type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary', text: `安全摘要 ${index}`
    });
  }
  manager.complete(summary.progressId);

  const record = manager.owned(summary.progressId, 'project_summary', 'chapter_summary');
  const activity = record.events.filter((event) => event.type === 'activity');
  assert.ok(activity.length <= 24);
  assert.equal(record.events.at(-1).type, 'completed');
  assert.equal(record.events.at(-1).data.terminal, true);
  assert.equal(manager.snapshot(summary.progressId, 'project_summary', 'chapter_summary').phase, 'completed');
  for (const event of activity) {
    const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    assert.ok(Buffer.byteLength(frame, 'utf8') <= 1_024);
  }
  const publicEvents = JSON.stringify(record.events);
  assert.doesNotMatch(publicEvents, /secret|--token|"args"|tool\.exe/i);
  manager.shutdown();
});

test('summary 终态仅保留两分钟，basic 维持默认十分钟语义', () => {
  let now = 10_000;
  const manager = new CodexProgressManager({
    now: () => now, terminalTtlMs: 5_000, summaryTerminalTtlMs: 1_000
  });
  const basic = manager.create({ projectId: 'p1', chapterId: 'c1' });
  manager.complete(basic.progressId);
  const summary = manager.create({ projectId: 'p2', chapterId: 'c2', detailLevel: 'summary' });
  manager.complete(summary.progressId);
  now += 1_001;
  manager.prune();
  assert.equal(manager.latest('p2', 'c2'), null);
  assert.equal(manager.latest('p1', 'c1')?.detailLevel, 'basic');
  manager.shutdown();
});
