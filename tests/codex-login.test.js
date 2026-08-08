import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  assertLocalHostRequest, assertLoopbackRequest, assertSameOriginRequest, CodexLoginManager,
  createCodexLoginOutputParser, isLoopbackAddress, validateCodexLoginUrl
} from '../src/lib/codex-login.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.kills = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

function makeLoginUrl(redirectUri = 'http://localhost:1455/auth/callback', extra = {}) {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'app_test');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', 'challenge');
  url.searchParams.set('state', 'state-value');
  for (const [key, value] of Object.entries(extra)) url.searchParams.append(key, value);
  return url.href;
}

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
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe']);

  const serialized = JSON.stringify(waiting);
  assert.doesNotMatch(serialized, /codex\.exe|pid|stdout|stderr|oauth|token/i);
  const loginUrl = makeLoginUrl();
  child.stdout.write(`Starting local login server\n${loginUrl.slice(0, 47)}`);
  child.stdout.write(`${loginUrl.slice(47)}\n`);
  assert.equal(manager.snapshot().loginUrl, loginUrl);
  assert.equal(manager.snapshot().browserActionRequired, true);
  child.emit('exit', 0, null);
  await nextTask();
  assert.equal(manager.snapshot().state, 'succeeded');
  assert.equal(manager.snapshot().authenticated, true);
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
  assert.equal(Object.hasOwn(manager.snapshot(), 'browserActionRequired'), false);
});

test('Codex fallback URL 支持分块流式解析且只接受官方授权端点与窄列回调', () => {
  for (const redirect of [
    'http://localhost:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback',
    'http://[::1]:1455/auth/callback',
    'http://localhost:1457/auth/callback'
  ]) {
    const candidate = makeLoginUrl(redirect);
    assert.equal(validateCodexLoginUrl(candidate), candidate);
  }

  const received = [];
  const parser = createCodexLoginOutputParser((url) => received.push(url));
  const valid = makeLoginUrl();
  parser.push(`noise https://evil.example/oauth/authorize?redirect_uri=x\n${valid.slice(0, 11)}`);
  parser.push(valid.slice(11, 73));
  parser.push(`${valid.slice(73)}\r`);
  parser.push('\nignored');
  assert.deepEqual(received, [valid]);
  parser.clear();
});

test('Codex fallback URL 拒绝恶意协议、host、userinfo、hash、redirect 与超长输入', () => {
  const valid = makeLoginUrl();
  const invalid = [
    'javascript:alert(1)',
    valid.replace('https://auth.openai.com', 'http://auth.openai.com'),
    valid.replace('auth.openai.com', 'auth.openai.com.evil.example'),
    valid.replace('https://', 'https://attacker@'),
    `${valid}#fragment`,
    valid.replace('/oauth/authorize', '/oauth/token'),
    makeLoginUrl('https://localhost:1455/auth/callback'),
    makeLoginUrl('http://evil.example:1455/auth/callback'),
    makeLoginUrl('http://user@localhost:1455/auth/callback'),
    makeLoginUrl('http://2130706433:1455/auth/callback'),
    makeLoginUrl('http://127.1:1455/auth/callback'),
    makeLoginUrl('http://localhost:4317/auth/callback'),
    makeLoginUrl('http://localhost:1455/wrong'),
    makeLoginUrl('http://localhost:1455/auth/callback?code=bad'),
    makeLoginUrl('http://localhost:1455/auth/callback#hash'),
    makeLoginUrl('http://localhost:1455/auth/callback', { redirect_uri: 'http://localhost:1455/auth/callback' }),
    `${valid}&padding=${'x'.repeat(8_192)}`
  ];
  for (const candidate of invalid) assert.equal(validateCodexLoginUrl(candidate), null, candidate.slice(0, 120));

  const received = [];
  const parser = createCodexLoginOutputParser((url) => received.push(url));
  parser.push(`${'x'.repeat(70_000)}\n`);
  parser.push(`${invalid.at(-1)}\n`);
  assert.deepEqual(received, []);
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
  const loginUrl = makeLoginUrl();

  await launch();
  children[0].stderr.write(`${loginUrl}\n`);
  assert.equal(manager.snapshot().loginUrl, loginUrl);
  assert.equal(manager.cancel().state, 'cancelled');
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  await nextTask();

  await launch();
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
  children[1].stderr.write(`${loginUrl}\n`);
  const loginTimeout = timers.findLast((timer) => timer.delay === 1_000 && !timer.cleared);
  loginTimeout.callback();
  assert.equal(manager.snapshot().state, 'timedOut');
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
  assert.deepEqual(children[1].kills, ['SIGTERM']);
  await nextTask();

  await launch();
  children[2].stdout.write(`${loginUrl}\n`);
  manager.shutdown();
  assert.equal(manager.snapshot().state, 'cancelled');
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
  assert.deepEqual(children[2].kills, ['SIGTERM']);
  await nextTask();

  await launch();
  children[3].stderr.write(`${loginUrl}\n`);
  children[3].emit('exit', 1, null);
  await nextTask();
  assert.equal(manager.snapshot().state, 'failed');
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
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

test('Codex auth Host 必须是本机固定名称且端口匹配实际监听端口', () => {
  for (const host of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317']) {
    assert.doesNotThrow(() => assertLocalHostRequest({ headers: { host }, socket: { localPort: 4317 } }));
  }
  for (const host of [
    '', 'evil.example:4317', 'localhost:3000', '127.0.0.2:4317',
    'user@localhost:4317', '2130706433:4317', '127.1:4317'
  ]) {
    assert.throws(
      () => assertLocalHostRequest({ headers: { host }, socket: { localPort: 4317 } }),
      (error) => error.code === 'CODEX_AUTH_HOST_INVALID' && error.statusCode === 403
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
