import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  assertLoopbackRequest, assertSameOriginRequest, CodexLoginManager, isLoopbackAddress
} from '../src/lib/codex-login.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

test('Codex 登录单例在异步探测前占位，固定安全参数且响应不泄漏进程信息', async () => {
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const spawns = [];
  const child = new FakeChild();
  const manager = new CodexLoginManager({
    spawnProcess(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    }
  });

  const first = manager.start({
    resolveCommand: async () => {
      await discoveryGate;
      return { command: 'C:\\OpenAI\\Codex\\codex.exe', authenticated: false };
    },
    verifyAuthenticated: async () => true
  });
  const concurrent = await manager.start({
    resolveCommand: async () => ({ command: 'must-not-run' }),
    verifyAuthenticated: async () => false
  });
  assert.equal(concurrent.state, 'starting');
  assert.equal(spawns.length, 0);

  releaseDiscovery();
  const waiting = await first;
  assert.equal(waiting.state, 'waiting');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'C:\\OpenAI\\Codex\\codex.exe');
  assert.deepEqual(spawns[0].args, ['login']);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'ignore', 'ignore']);

  const serialized = JSON.stringify(waiting);
  assert.doesNotMatch(serialized, /codex\.exe|pid|stdout|stderr|oauth|token/i);
  child.emit('exit', 0, null);
  await nextTask();
  assert.equal(manager.snapshot().state, 'succeeded');
  assert.equal(manager.snapshot().authenticated, true);
});

test('Codex 登录支持取消、超时和服务关闭时清理唯一受控子进程', async () => {
  const timers = [];
  const children = [];
  const manager = new CodexLoginManager({
    timeoutMs: 1_000,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    spawnProcess() {
      const child = new FakeChild();
      children.push(child);
      return child;
    }
  });
  const launch = () => manager.start({
    resolveCommand: async () => ({ command: 'codex', authenticated: false }),
    verifyAuthenticated: async () => false
  });

  await launch();
  assert.equal(manager.cancel().state, 'cancelled');
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  await nextTask();

  await launch();
  const loginTimeout = timers.findLast((timer) => timer.delay === 1_000 && !timer.cleared);
  loginTimeout.callback();
  assert.equal(manager.snapshot().state, 'timedOut');
  assert.deepEqual(children[1].kills, ['SIGTERM']);
  await nextTask();

  await launch();
  manager.shutdown();
  assert.equal(manager.snapshot().state, 'cancelled');
  assert.deepEqual(children[2].kills, ['SIGTERM']);
  await nextTask();
});

test('Codex 登录只接受 IPv4、IPv6 与映射形式的 loopback 地址', () => {
  for (const address of [
    '127.0.0.1', '127.2.3.4', '::1', '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:7f00:1'
  ]) {
    assert.equal(isLoopbackAddress(address), true, address);
    assert.doesNotThrow(() => assertLoopbackRequest({ socket: { remoteAddress: address } }));
  }
  for (const address of ['', '0.0.0.0', '192.168.1.10', '::ffff:192.168.1.10', '2001:db8::1']) {
    assert.equal(isLoopbackAddress(address), false, address);
    assert.throws(
      () => assertLoopbackRequest({ socket: { remoteAddress: address } }),
      (error) => error.code === 'CODEX_AUTH_LOCAL_ONLY' && error.statusCode === 403
    );
  }
});

test('Codex 登录写请求只接受与工作台 Host 完全一致的 Origin', () => {
  assert.doesNotThrow(() => assertSameOriginRequest({ headers: {
    host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317'
  } }));
  assert.doesNotThrow(() => assertSameOriginRequest({ headers: { host: '127.0.0.1:4317' } }));
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:4317', 'https://127.0.0.1:4317']) {
    assert.throws(
      () => assertSameOriginRequest({ headers: { host: '127.0.0.1:4317', origin } }),
      (error) => error.code === 'CODEX_AUTH_SAME_ORIGIN_REQUIRED' && error.statusCode === 403
    );
  }
});
