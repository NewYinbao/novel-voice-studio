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
  assert.doesNotMatch(JSON.stringify(record.events), /小说原文|hidden chain|thread-secret|SECRET_ERROR/i);

  const next = manager.create({ projectId: 'project_a', chapterId: 'chapter_a' });
  manager.complete(next.progressId);
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
  const progress = manager.create({ projectId: 'project_a', chapterId: 'chapter_a' });
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
