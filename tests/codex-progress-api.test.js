import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-codex-progress-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { getProject, initStore, mutateProject } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');
const { CodexProgressManager } = await import('../src/lib/codex-progress.js');

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
    assert.equal(input.detailLevel, 'summary');
    assert.equal(input.model, 'gpt-5.6-terra');
    assert.equal(input.reasoningEffort, 'medium');
    const expectedTimeoutMinutes = runnerCalls === 1 ? 120 : 10;
    assert.equal(input.timeoutMinutes, expectedTimeoutMinutes);
    assert.equal(input.timeoutMs, expectedTimeoutMinutes * 60_000);
    activeSignal = input.signal;
    signalStarted();
    input.onProgress({
      type: 'thread', phase: 'started', threadId: 'thread-secret', prompt: input.prompt
    });
    input.onProgress({
      type: 'stage', phase: 'analyzing', message: 'reasoning-secret', reasoning: 'hidden chain of thought'
    });
    input.onProgress({
      type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary',
      text: '不得出现在进度里的小说原文。'
    });
    input.onProgress({
      type: 'item.completed', item: {
        type: 'agent_message', text: '{"roles":[{"name":"FINAL-JSON-SECRET"}],"scenes":[]}'
      }
    });
    input.onProgress({ type: 'failed', phase: 'failed', code: 'EARLY_FAKE_TERMINAL', message: 'must be ignored' });
    input.onProgress({ type: 'stage', phase: 'drafting', command: 'C:\\secret\\tool.exe --token secret' });
    input.onProgress({
      type: 'activity', phase: 'activity', category: 'command',
      command: 'C:\\secret\\tool.exe --token secret', output: 'RAW-TOOL-RESULT'
    });
    await runGate;
    input.onProgress({ type: 'stage', phase: 'validating', text: '完整模型输出 secret' });
    return {
      threadId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      script: makeScript(),
      usage: { input_tokens: 123, output_tokens: 456 }
    };
  };
  let progressNow = Date.parse('2026-08-08T12:00:00.000Z');
  const codexProgressManager = new CodexProgressManager({ now: () => {
    progressNow += 501;
    return progressNow;
  } });
  const server = createServer({
    codexRunner,
    codexProgressManager,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base);
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  const invalidDetail = await fetch(sessionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ stream: true, detailLevel: 'verbose' })
  });
  assert.equal(invalidDetail.status, 400);
  assert.equal((await invalidDetail.json()).error, 'CODEX_DETAIL_LEVEL_INVALID');
  assert.equal(runnerCalls, 0);

  const acceptedResponse = await fetch(sessionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      stream: true, detailLevel: 'summary', mode: 'faithful', prompt: 'PROMPT-SECRET',
      timeoutMinutes: 120
    })
  });
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  assert.match(accepted.progressId, /^codexprog_[0-9a-f]{32}$/);
  assert.equal(accepted.detailLevel, 'summary');
  assert.equal(accepted.model, 'gpt-5.6-terra');
  assert.equal(accepted.reasoningEffort, 'medium');
  assert.equal(accepted.timeoutMinutes, 120);
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
  assert.equal(active.progress.detailLevel, 'summary');
  assert.equal(active.progress.model, 'gpt-5.6-terra');
  assert.equal(active.progress.reasoningEffort, 'medium');
  assert.equal(active.progress.timeoutMinutes, 120);
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
  assert.match(streamText, /event: activity/);
  assert.match(streamText, /摘要因可能包含原文或敏感信息而隐藏/);
  assert.match(streamText, /正在执行受控本地操作/);
  assert.match(streamText, /event: completed/);
  assert.match(streamText, /"terminal":true/);
  assert.match(streamText, /"timeoutMinutes":120/);
  assert.doesNotMatch(streamText, /PROMPT-SECRET|不得出现在进度里的小说原文|thread-secret|reasoning-secret|hidden chain|secret\\tool|RAW-TOOL-RESULT|FINAL-JSON-SECRET|完整模型输出|input_tokens|output_tokens|0199a213/i);

  const terminal = await waitForProgress(base, project.id, chapterId, 'completed');
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.timeoutMinutes, 120);
  const replayResponse = await fetch(`${base}${accepted.eventsUrl}`, { headers: { 'Last-Event-ID': '2' } });
  const replay = await replayResponse.text();
  assert.doesNotMatch(replay, /id: 1\n|id: 2\n/);
  assert.match(replay, /event: activity/);
  assert.match(replay, /event: completed/);
  const invalidReplay = await fetch(`${base}${accepted.eventsUrl}`, { headers: { 'Last-Event-ID': '01' } });
  assert.equal(invalidReplay.status, 400);

  const sessions = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].timeoutMinutes, 120);
  const savedProject = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(savedProject.chapters[0].scenes[0].lines[0].spokenText, '安全台词。');
  const serializedSessions = JSON.stringify(sessions);
  assert.doesNotMatch(serializedSessions, /codexThreadId|input_tokens|output_tokens|"usage"|0199a213/i);

  await mutateProject(project.id, (draft) => {
    delete draft.chapters[0].codexSessions[0].timeoutMinutes;
  });
  const legacySessions = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(legacySessions.sessions[0].timeoutMinutes, null);
  const legacyFollow = await fetch(`${sessionsUrl}/${sessions.sessions[0].id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ prompt: '继续按当前稿件整理。', detailLevel: 'summary' })
  });
  assert.equal(legacyFollow.status, 200);
  const migrated = await legacyFollow.json();
  assert.equal(migrated.timeoutMinutes, 10);
  assert.equal(migrated.session.timeoutMinutes, 10);
  assert.equal(runnerCalls, 2);
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
    input.onProgress({
      type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary', text: 'basic 不应出现的摘要'
    });
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
  assert.doesNotMatch(failedStream, /event: activity/);
  assert.match(failedStream, /"code":"CODEX_FAILED"/);
  assert.doesNotMatch(failedStream, /RAW-STDERR|private|schema|prompt 原文|--token abc|detail/i);

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

test('Codex active 超时返回 504 语义终态、不提交，并释放本章锁供重试', async (t) => {
  await initStore();
  let calls = 0;
  const codexRunner = async (input) => {
    calls += 1;
    assert.equal(input.model, 'gpt-5.6-terra');
    assert.equal(input.reasoningEffort, 'medium');
    if (calls === 1) {
      assert.equal(input.timeoutMinutes, 5);
      assert.equal(input.timeoutMs, 5 * 60_000);
      throw Object.assign(new Error('RAW timeout diagnostics C:\\private\\prompt.txt'), {
        code: 'CODEX_TIMEOUT_ACTIVE'
      });
    }
    if (calls === 2) {
      assert.equal(input.timeoutMinutes, 120);
      assert.equal(input.timeoutMs, 120 * 60_000);
      throw Object.assign(new Error('RAW active diagnostics /private/prompt.txt'), {
        code: 'CODEX_TIMEOUT_ACTIVE'
      });
    }
    if (calls === 3) {
      assert.equal(input.timeoutMinutes, 5);
      assert.equal(input.timeoutMs, 5 * 60_000);
      throw Object.assign(new Error('RAW starting diagnostics /private/prompt.txt'), {
        code: 'CODEX_TIMEOUT_STARTING'
      });
    }
    assert.equal(input.timeoutMinutes, 10);
    assert.equal(input.timeoutMs, 10 * 60_000);
    return {
      threadId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      script: makeScript('重试成功。'),
      usage: { input_tokens: 999 }
    };
  };
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, '超时重试测试');
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  const started = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true, timeoutMinutes: 5 })
  }).then((response) => response.json());
  assert.equal(started.timeoutMinutes, 5);
  const failed = await waitForProgress(base, project.id, chapterId, 'failed');
  assert.equal(failed.timeoutMinutes, 5);
  assert.equal(failed.code, 'CODEX_TIMEOUT_ACTIVE');
  assert.match(failed.message, /5 分钟/);
  const stream = await fetch(`${base}${started.eventsUrl}`).then((response) => response.text());
  assert.match(stream, /"code":"CODEX_TIMEOUT_ACTIVE"/);
  assert.match(stream, /"timeoutMinutes":5/);
  assert.match(stream, /5 分钟/);
  assert.doesNotMatch(stream, /RAW timeout|private|prompt\.txt|input_tokens|999/i);
  const afterTimeout = await getProject(project.id);
  assert.equal(afterTimeout.chapters[0].codexSessions?.length || 0, 0);

  const activeTimeout = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutMinutes: 120 })
  });
  assert.equal(activeTimeout.status, 504);
  const activeFailure = await activeTimeout.json();
  assert.equal(activeFailure.error, 'CODEX_TIMEOUT_ACTIVE');
  assert.match(activeFailure.message, /120 分钟/);
  assert.doesNotMatch(JSON.stringify(activeFailure), /RAW active|private|prompt\.txt/i);

  const startingTimeout = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutMinutes: 5 })
  });
  assert.equal(startingTimeout.status, 504);
  const startingFailure = await startingTimeout.json();
  assert.equal(startingFailure.error, 'CODEX_TIMEOUT_STARTING');
  assert.match(startingFailure.message, /5 分钟/);
  assert.doesNotMatch(JSON.stringify(startingFailure), /RAW starting|private|prompt\.txt/i);
  const afterStartingTimeout = await getProject(project.id);
  assert.equal(afterStartingTimeout.chapters[0].codexSessions?.length || 0, 0);

  const retry = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(retry.status, 201);
  const result = await retry.json();
  assert.equal(result.session.model, 'gpt-5.6-terra');
  assert.equal(result.session.reasoningEffort, 'medium');
  assert.equal(result.session.timeoutMinutes, 10);
  assert.equal(result.timeoutMinutes, 10);
  assert.equal(result.project.chapters[0].scenes[0].lines[0].spokenText, '重试成功。');
  assert.equal(calls, 4);
});
