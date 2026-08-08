import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-codex-login-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { CodexLoginManager } = await import('../src/lib/codex-login.js');
const { initStore } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');

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

function makeLoginUrl() {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'app_test');
  url.searchParams.set('redirect_uri', 'http://localhost:1455/auth/callback');
  url.searchParams.set('code_challenge', 'challenge');
  url.searchParams.set('state', 'state-value');
  return url.href;
}

async function waitForLoginState(base, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await fetch(`${base}/api/codex/auth/login`).then((response) => response.json());
    if (result.login.state === expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 Codex 登录状态超时：${expected}`);
}

async function requestWithHost(base, host) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/api/codex/auth/login',
      method: 'GET',
      headers: { Host: host }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('Codex 登录 API 并发幂等、脱敏、可取消，并在服务关闭时清理进程', async (t) => {
  await initStore();
  let authenticated = false;
  let signalDiscovery;
  let releaseDiscovery;
  let firstDiscovery = true;
  const discoveryStarted = new Promise((resolve) => { signalDiscovery = resolve; });
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const children = [];
  const manager = new CodexLoginManager({
    spawnProcess(command, args, options) {
      const child = new FakeChild();
      children.push({ child, command, args, options });
      return child;
    }
  });
  const systemProfileResolver = async () => {
    if (firstDiscovery) {
      firstDiscovery = false;
      signalDiscovery();
      await discoveryGate;
    }
    return {
      tools: {
        codex: authenticated
          ? { state: 'ready', runnable: true, resolvedCommand: 'C:\\secret\\codex.exe' }
          : { state: 'authRequired', runnable: false, resolvedCommand: 'C:\\secret\\codex.exe' }
      }
    };
  };
  const server = createServer({ codexLoginManager: manager, systemProfileResolver });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const localHeaders = { Origin: base };
  const loginUrl = makeLoginUrl();

  const reboundHost = await requestWithHost(base, `attacker.example:${server.address().port}`);
  assert.equal(reboundHost.status, 403);
  assert.equal(reboundHost.body.error, 'CODEX_AUTH_HOST_INVALID');
  const wrongHostPort = await requestWithHost(base, `127.0.0.1:${server.address().port + 1}`);
  assert.equal(wrongHostPort.status, 403);

  const rejected = await fetch(`${base}/api/codex/auth/login`, {
    method: 'POST', headers: { Origin: 'https://attacker.example' }
  });
  assert.equal(rejected.status, 403);
  assert.equal(children.length, 0);

  const otherLocalPage = await fetch(`${base}/api/codex/auth/login`, {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:3000' }
  });
  assert.equal(otherLocalPage.status, 403);
  assert.equal((await otherLocalPage.json()).error, 'CODEX_AUTH_SAME_ORIGIN_REQUIRED');
  assert.equal(children.length, 0);

  const injected = await fetch(`${base}/api/codex/auth/login`, {
    method: 'POST',
    headers: { ...localHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'calc.exe', args: ['anything'] })
  });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error, 'CODEX_AUTH_OPTIONS_NOT_ALLOWED');
  assert.equal(children.length, 0);
  const unsupported = await fetch(`${base}/api/codex/auth/login`, { method: 'PUT', headers: localHeaders });
  assert.equal(unsupported.status, 405);
  assert.equal(children.length, 0);

  const firstRequest = fetch(`${base}/api/codex/auth/login`, { method: 'POST', headers: localHeaders });
  await discoveryStarted;
  const concurrentResponse = await fetch(`${base}/api/codex/auth/login`, { method: 'POST', headers: localHeaders });
  assert.equal(concurrentResponse.status, 202);
  const concurrent = await concurrentResponse.json();
  assert.equal(concurrent.login.state, 'starting');
  assert.equal(children.length, 0);

  releaseDiscovery();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.equal(first.login.state, 'waiting');
  assert.equal(children.length, 1);
  assert.equal(children[0].command, 'C:\\secret\\codex.exe');
  assert.deepEqual(children[0].args, ['login']);
  assert.equal(children[0].options.shell, false);
  assert.deepEqual(children[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.doesNotMatch(JSON.stringify(first), /secret|codex\.exe|pid|stdout|stderr|oauth|token/i);

  const waiting = await fetch(`${base}/api/codex/auth/login`).then((response) => response.json());
  assert.equal(waiting.login.state, 'waiting');
  children[0].child.stderr.write(`PRIVATE_NOISE refresh_token=must-not-leak\n${loginUrl.slice(0, 39)}`);
  children[0].child.stderr.write(`${loginUrl.slice(39)}\nTRAILING_SECRET\n`);
  const exposedResponse = await fetch(`${base}/api/codex/auth/login`);
  const exposedRaw = await exposedResponse.text();
  const exposed = JSON.parse(exposedRaw);
  assert.equal(exposed.login.loginUrl, loginUrl);
  assert.equal(exposed.login.browserActionRequired, true);
  assert.doesNotMatch(exposedRaw, /PRIVATE_NOISE|must-not-leak|TRAILING_SECRET|refresh_token/i);
  authenticated = true;
  children[0].child.emit('exit', 0, null);
  const succeeded = await waitForLoginState(base, 'succeeded');
  assert.equal(succeeded.login.state, 'succeeded');
  assert.equal(succeeded.login.authenticated, true);
  assert.equal(Object.hasOwn(succeeded.login, 'loginUrl'), false);

  const alreadyLoggedIn = await fetch(`${base}/api/codex/auth/login`, { method: 'POST', headers: localHeaders });
  assert.equal(alreadyLoggedIn.status, 200);
  assert.equal((await alreadyLoggedIn.json()).login.state, 'succeeded');
  assert.equal(children.length, 1);

  authenticated = false;
  const restarted = await fetch(`${base}/api/codex/auth/login`, { method: 'POST', headers: localHeaders });
  assert.equal(restarted.status, 202);
  assert.equal(children.length, 2);
  children[1].child.stdout.write(`${loginUrl}\n`);
  const cancelled = await fetch(`${base}/api/codex/auth/login`, { method: 'DELETE', headers: localHeaders })
    .then((response) => response.json());
  assert.equal(cancelled.login.state, 'cancelled');
  assert.equal(Object.hasOwn(cancelled.login, 'loginUrl'), false);
  assert.deepEqual(children[1].child.kills, ['SIGTERM']);
  await nextTask();

  await fetch(`${base}/api/codex/auth/login`, { method: 'POST', headers: localHeaders });
  assert.equal(children.length, 3);
  children[2].child.stderr.write(`${loginUrl}\n`);
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(children[2].child.kills, ['SIGTERM']);
  assert.equal(Object.hasOwn(manager.snapshot(), 'loginUrl'), false);
});
