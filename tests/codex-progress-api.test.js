import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-codex-progress-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { getProject, initStore } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

function makeScript(text = '安全台词。') {
  return {
    chapterTitle: '测试章',
    roles: [{ name: '旁白', aliases: [], description: '叙述者', isNarrator: true }],
    scenes: [{
      id: 'scene_generated', title: '场景 1', context: '',
      lines: [{
        id: 'line_generated', kind: 'narration', speaker: '旁白', sourceText: '原文。', spokenText: text,
        emotion: 'neutral', emotionNote: '', intensity: 0.5, pace: 1, pauseAfterMs: 350,
        confidence: 1, needsReview: false, render: { status: 'idle' }
      }]
    }],
    warnings: []
  };
}

async function createProject(base, title = '流式进度测试') {
  return fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, sourceText: '第一章\n\n不得出现在进度里的小说原文。' })
  }).then((response) => response.json());
}

async function waitForProgress(base, projectId, chapterId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await fetch(`${base}/api/projects/${projectId}/chapters/${chapterId}/codex-progress`)
      .then((response) => response.json());
    if (result.progress?.state === expected) return result.progress;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待进度状态超时：${expected}`);
}

function requestWithHost(base, requestPath, host) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: requestPath,
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

test('Codex 异步协作通过 SSE 流式回放、恢复、隔离并在终态脱敏', async (t) => {
  await initStore();
  let runnerCalls = 0;
  let activeSignal = null;
  let releaseRun;
  let signalStarted;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const runStarted = new Promise((resolve) => { signalStarted = resolve; });
  const codexRunner = async (input) => {
    runnerCalls += 1;
    activeSignal = input.signal;
    signalStarted();
    input.onProgress({
      type: 'thread', phase: 'started', threadId: 'thread-secret', prompt: input.prompt
    });
    input.onProgress({
      type: 'stage', phase: 'analyzing', message: 'reasoning-secret', reasoning: 'hidden chain of thought'
    });
    input.onProgress({ type: 'failed', phase: 'failed', code: 'EARLY_FAKE_TERMINAL', message: 'must be ignored' });
    input.onProgress({ type: 'stage', phase: 'drafting', command: 'C:\\secret\\tool.exe --token secret' });
    await runGate;
    input.onProgress({ type: 'stage', phase: 'validating', text: '完整模型输出 secret' });
    return {
      threadId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      script: makeScript(),
      usage: { input_tokens: 123, output_tokens: 456 }
    };
  };
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base);
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  const acceptedResponse = await fetch(sessionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ stream: true, mode: 'faithful', prompt: 'PROMPT-SECRET' })
  });
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  assert.match(accepted.progressId, /^codexprog_[0-9a-f]{32}$/);
  assert.equal(accepted.state, 'queued');
  assert.equal(accepted.eventsUrl.endsWith(accepted.progressId), true);
  await runStarted;

  const duplicate = await fetch(sessionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ stream: true, prompt: '第二个请求不应排队' })
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'CODEX_PROGRESS_ACTIVE');
  assert.equal(runnerCalls, 1);

  const active = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/codex-progress`)
    .then((response) => response.json());
  assert.equal(active.progress.progressId, accepted.progressId);
  assert.equal(active.progress.terminal, false);
  assert.equal(Object.hasOwn(active.progress, 'events'), false);

  const wrongOrigin = await fetch(`${base}${accepted.eventsUrl}`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(wrongOrigin.status, 403);
  const rebound = await requestWithHost(base, accepted.eventsUrl, `attacker.example:${server.address().port}`);
  assert.equal(rebound.status, 403);

  const otherProject = await createProject(base, '其他项目');
  const otherChapter = otherProject.chapters[0].id;
  const crossScopePath = `/api/projects/${otherProject.id}/chapters/${otherChapter}/codex-progress/${accepted.progressId}`;
  const crossScope = await fetch(`${base}${crossScopePath}`);
  assert.equal(crossScope.status, 404);

  const droppedResponse = await fetch(`${base}${accepted.eventsUrl}`);
  await droppedResponse.body.cancel();
  assert.equal(activeSignal.aborted, false);

  const streamResponse = await fetch(`${base}${accepted.eventsUrl}`, { headers: { Origin: base } });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
  releaseRun();
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: queued/);
  assert.match(streamText, /event: starting/);
  assert.match(streamText, /event: thread/);
  assert.match(streamText, /event: completed/);
  assert.match(streamText, /"terminal":true/);
  assert.doesNotMatch(streamText, /PROMPT-SECRET|小说原文|thread-secret|reasoning-secret|hidden chain|secret\\tool|完整模型输出|input_tokens|output_tokens|0199a213/i);

  const terminal = await waitForProgress(base, project.id, chapterId, 'completed');
  assert.equal(terminal.terminal, true);
  const replayResponse = await fetch(`${base}${accepted.eventsUrl}`, { headers: { 'Last-Event-ID': '2' } });
  const replay = await replayResponse.text();
  assert.doesNotMatch(replay, /id: 1\n|id: 2\n/);
  assert.match(replay, /event: completed/);
  const invalidReplay = await fetch(`${base}${accepted.eventsUrl}`, { headers: { 'Last-Event-ID': '01' } });
  assert.equal(invalidReplay.status, 400);

  const sessions = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(sessions.sessions.length, 1);
  const savedProject = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(savedProject.chapters[0].scenes[0].lines[0].spokenText, '安全台词。');
  const serializedSessions = JSON.stringify(sessions);
  assert.doesNotMatch(serializedSessions, /codexThreadId|input_tokens|output_tokens|"usage"|0199a213/i);
});

test('Codex 异步失败只发送固定终态，服务关闭会强制结束 SSE', async (t) => {
  await initStore();
  let call = 0;
  let shutdownSignal = null;
  let signalHangingStarted;
  const hangingStarted = new Promise((resolve) => { signalHangingStarted = resolve; });
  const codexRunner = async (input) => {
    call += 1;
    input.onProgress({ type: 'stage', phase: 'processing', command: 'C:\\private\\secret.exe --token abc' });
    if (call === 1) {
      throw Object.assign(new Error('RAW-STDERR prompt 原文 C:\\private\\schema.json'), {
        code: 'CODEX_FAILED', detail: { raw: 'secret' }
      });
    }
    shutdownSignal = input.signal;
    signalHangingStarted();
    return new Promise((resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
        code: 'CODEX_CANCELLED'
      })), { once: true });
    });
  };
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, '失败与关闭测试');
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  const failedStart = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true })
  }).then((response) => response.json());
  await waitForProgress(base, project.id, chapterId, 'failed');
  const failedStream = await fetch(`${base}${failedStart.eventsUrl}`).then((response) => response.text());
  assert.match(failedStream, /event: failed/);
  assert.match(failedStream, /"code":"CODEX_FAILED"/);
  assert.doesNotMatch(failedStream, /RAW-STDERR|private|schema|prompt 原文|--token|abc|detail/i);

  const hangingStart = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true })
  }).then((response) => response.json());
  const hangingResponse = await fetch(`${base}${hangingStart.eventsUrl}`);
  await hangingStarted;
  const closeResult = new Promise((resolve) => server.close(resolve));
  await Promise.race([
    closeResult,
    new Promise((_, reject) => setTimeout(() => reject(new Error('server.close 未及时清理 SSE')), 1_000))
  ]);
  assert.equal(server.listening, false);
  assert.equal(shutdownSignal?.aborted, true);
  const stored = await getProject(project.id);
  assert.equal(stored.chapters[0].codexSessions?.length || 0, 0);
  await hangingResponse.body.cancel().catch(() => {});
});
