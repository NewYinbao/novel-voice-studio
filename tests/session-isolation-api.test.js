import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-session-isolation-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { getProject, initStore, mutateProject } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');
const { CodexProgressManager } = await import('../src/lib/codex-progress.js');
const { assertLoopbackRequest } = await import('../src/lib/codex-login.js');

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeScript(text, chapterTitle = '测试章') {
  return {
    chapterTitle,
    roles: [{ name: '旁白', aliases: [], description: '', isNarrator: true }],
    scenes: [{
      id: 'scene_generated', title: '场景', context: '',
      lines: [{
        id: 'line_generated', kind: 'narration', speaker: '旁白',
        sourceText: '原文', spokenText: text, emotion: 'neutral', emotionNote: '',
        intensity: 0.5, pace: 1, pauseAfterMs: 350, confidence: 1,
        needsReview: false, render: { status: 'idle' }
      }]
    }],
    warnings: []
  };
}

async function createProject(base, { title = 'Session 隔离测试', sourceText = '第一章\n\n小说原文。' } = {}) {
  const response = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, sourceText })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function waitFor(check, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function waitForSessionProgress(base, projectId, chapterId, sessionId, state) {
  return waitFor(async () => {
    const response = await fetch(
      `${base}/api/projects/${projectId}/chapters/${chapterId}/codex-sessions/${sessionId}/codex-progress`
    );
    const body = await response.json();
    return body.progress?.state === state ? body.progress : null;
  }, `等待 Session ${sessionId} 进入 ${state} 超时`);
}

async function waitForJob(base, jobId) {
  return waitFor(async () => {
    const job = await fetch(`${base}/api/jobs/${jobId}`).then((response) => response.json());
    return ['completed', 'failed'].includes(job.state) ? job : null;
  }, `等待任务 ${jobId} 超时`);
}

function postWithHost(base, requestPath, { host, origin, body }) {
  const target = new URL(base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: requestPath,
      method: 'POST',
      headers: {
        Host: host,
        Origin: origin,
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('Session 启动恢复失败时 API fail-closed 且不返回底层路径或诊断', async (t) => {
  await initStore();
  const server = createServer({
    sessionRecoveryPromise: Promise.reject(new Error('RAW C:\\private\\project.json token-secret'))
  });
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'SCRIPT_SESSION_RECOVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /RAW|private|project\.json|token-secret/i);
});

test('pending 持久化与 shutdown 竞态不会启动脱管 runner，重启后可安全恢复', async (t) => {
  await initStore();
  const manager = new CodexProgressManager();
  let runnerCalls = 0;
  const server = createServer({
    codexProgressManager: manager,
    codexRunner: async () => {
      runnerCalls += 1;
      return { threadId: 'must-not-run', script: makeScript('must-not-run') };
    },
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, { title: '关服竞态' });
  const chapterId = project.chapters[0].id;

  let signalLockHeld;
  let releaseProjectLock;
  const lockHeld = new Promise((resolve) => { signalLockHeld = resolve; });
  const projectGate = new Promise((resolve) => { releaseProjectLock = resolve; });
  const blocker = mutateProject(project.id, async () => {
    signalLockHeld();
    await projectGate;
  });
  await lockHeld;

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const request = fetch(
      `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`,
      {
        method: 'POST', headers: {
          'Content-Type': 'application/json', Origin: base, Connection: 'close'
        },
        body: JSON.stringify({ stream: true, prompt: '不能脱管执行' })
      }
    );
    await waitFor(() => manager.records.size === 1, '请求没有创建 progress reservation');
    const close = new Promise((resolve) => server.close(resolve));
    assert.equal(manager.closed, true);
    releaseProjectLock();
    await blocker;
    const response = await request;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'CODEX_PROGRESS_UNAVAILABLE');
    await close;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runnerCalls, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    releaseProjectLock?.();
  }

  const interrupted = await getProject(project.id);
  assert.equal(interrupted.chapters[0].codexSessions[0].status, 'pending');
  const recoveryServer = createServer();
  await new Promise((resolve) => recoveryServer.listen(0, '127.0.0.1', resolve));
  const recoveryBase = `http://127.0.0.1:${recoveryServer.address().port}`;
  const recovered = await fetch(
    `${recoveryBase}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`
  ).then((response) => response.json());
  assert.equal(recovered.sessions[0].status, 'failed');
  assert.equal(recovered.sessions[0].lastFailure.code, 'SCRIPT_SESSION_INTERRUPTED');
  await new Promise((resolve) => recoveryServer.close(resolve));
});

test('同章不同 Session 真并发，后台结果归属自身；切换和手工编辑不会被旧运行覆盖', async (t) => {
  await initStore();
  const pending = new Map();
  const started = [];
  const codexRunner = (input) => new Promise((resolve, reject) => {
    started.push({ prompt: input.prompt, chapter: structuredClone(input.chapter) });
    const finish = () => resolve({
      threadId: `thread-${input.prompt}`,
      script: makeScript(`${input.prompt}-模型结果`)
    });
    pending.set(input.prompt, finish);
    if (input.signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'CODEX_CANCELLED' }));
    input.signal.addEventListener('abort', () => {
      pending.delete(input.prompt);
      reject(Object.assign(new Error('cancelled'), { code: 'CODEX_CANCELLED' }));
    }, { once: true });
  });
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  t.after(async () => {
    for (const finish of pending.values()) finish();
    pending.clear();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base);
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;
  const start = async (prompt) => {
    const response = await fetch(sessionsUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ stream: true, prompt })
    });
    assert.equal(response.status, 202);
    return response.json();
  };

  const a = await start('A');
  const b = await start('B');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.session.status, 'pending');
  assert.equal(a.session.activeRun.progressId, a.progressId);
  assert.equal(b.session.status, 'pending');
  assert.equal(b.session.activeRun.progressId, b.progressId);
  await waitFor(() => started.length === 2, '两个 Session 未并发进入 runner');
  assert.deepEqual(new Set(started.map((item) => item.prompt)), new Set(['A', 'B']));
  assert.equal(started.every((item) => item.chapter.scenes.length === 0), true);
  const runningSessions = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(runningSessions.sessions.filter((session) => session.status === 'running').length, 2);
  assert.deepEqual(
    new Set(runningSessions.sessions.map((session) => session.activeRun?.progressId)),
    new Set([a.progressId, b.progressId])
  );

  const beforeRejectedActivate = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  const beforeRunningSnapshot = await fetch(`${sessionsUrl}/${a.sessionId}/script`).then((response) => response.json());
  const activateRunning = await fetch(`${sessionsUrl}/${a.sessionId}/activate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
  });
  assert.equal(activateRunning.status, 409);
  assert.equal((await activateRunning.json()).error, 'SCRIPT_SESSION_ACTIVE');
  const afterRejectedActivate = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  const afterRunningSnapshot = await fetch(`${sessionsUrl}/${a.sessionId}/script`).then((response) => response.json());
  assert.equal(
    afterRejectedActivate.chapters[0].activeCodexSessionId,
    beforeRejectedActivate.chapters[0].activeCodexSessionId
  );
  assert.deepEqual(afterRejectedActivate.chapters[0].scenes, beforeRejectedActivate.chapters[0].scenes);
  assert.deepEqual(afterRunningSnapshot.script, beforeRunningSnapshot.script);

  const duplicate = await fetch(`${sessionsUrl}/${a.sessionId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ stream: true, prompt: 'A-重复' })
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'SCRIPT_SESSION_ACTIVE');

  const wrongSessionUrl = `${base}${a.eventsUrl.replace(a.sessionId, b.sessionId)}`;
  const wrongSession = await fetch(wrongSessionUrl);
  assert.equal(wrongSession.status, 404);
  assert.equal((await wrongSession.json()).error, 'CODEX_PROGRESS_NOT_FOUND');
  const legacyProgress = await fetch(
    `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-progress/${a.progressId}`
  );
  assert.equal(legacyProgress.status, 404);

  pending.get('A')();
  pending.delete('A');
  await waitForSessionProgress(base, project.id, chapterId, a.sessionId, 'completed');
  let live = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(live.chapters[0].scenes.length, 0);

  pending.get('B')();
  pending.delete('B');
  await waitForSessionProgress(base, project.id, chapterId, b.sessionId, 'completed');
  live = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(live.chapters[0].scenes[0].lines[0].spokenText, 'B-模型结果');

  const aVersion = await fetch(`${sessionsUrl}/${a.sessionId}/script`).then((response) => response.json());
  assert.equal(aVersion.isActive, false);
  assert.equal(aVersion.script.scenes[0].lines[0].spokenText, 'A-模型结果');
  const activateA = await fetch(`${sessionsUrl}/${a.sessionId}/activate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
  });
  assert.equal(activateA.status, 200);
  live = await activateA.json();
  assert.equal(live.project.chapters[0].scenes[0].lines[0].spokenText, 'A-模型结果');

  const c = await start('C');
  await waitFor(() => pending.has('C'), 'C Session 未进入 runner');
  live = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  const liveLineId = live.chapters[0].scenes[0].lines[0].id;
  const manual = await fetch(`${base}/api/projects/${project.id}/lines/${liveLineId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ spokenText: '运行期间手工保留' })
  });
  assert.equal(manual.status, 200);
  pending.get('C')();
  pending.delete('C');
  await waitForSessionProgress(base, project.id, chapterId, c.sessionId, 'completed');
  live = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(live.chapters[0].scenes[0].lines[0].spokenText, '运行期间手工保留');
  assert.notEqual(live.chapters[0].activeCodexSessionId, c.sessionId);
  const cVersion = await fetch(`${sessionsUrl}/${c.sessionId}/script`).then((response) => response.json());
  assert.equal(cVersion.isActive, false);
  assert.equal(cVersion.script.scenes[0].lines[0].spokenText, 'C-模型结果');
  assert.doesNotMatch(JSON.stringify(cVersion.session), /thread-|baselineChapterHash|runId|usage/i);
});

test('批量模型任务严格校验参数并串行处理，单章失败不丢失其他章节版本与安全明细', async (t) => {
  await initStore();
  const calls = [];
  let activeRunners = 0;
  let maxActiveRunners = 0;
  const codexRunner = async (input) => {
    calls.push({
      title: input.chapter.title,
      mode: input.mode,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      timeoutMinutes: input.timeoutMinutes
    });
    activeRunners += 1;
    maxActiveRunners = Math.max(maxActiveRunners, activeRunners);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRunners -= 1;
    if (input.chapter.title.includes('二')) {
      throw Object.assign(new Error('RAW C:\\private\\novel.txt --token secret'), {
        code: 'TOKEN_SECRET_LEAK'
      });
    }
    return {
      threadId: `thread-${input.chapter.title}`,
      script: makeScript(`${input.chapter.title}-批量成功`, input.chapter.title)
    };
  };
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  t.after(() => server.listening ? new Promise((resolve) => server.close(resolve)) : undefined);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, {
    title: '批量部分失败',
    sourceText: '第一章\n\n甲。\n\n第二章\n\n乙。\n\n第三章\n\n丙。'
  });
  assert.equal(project.chapters.length, 3);
  const scriptUrl = `${base}/api/projects/${project.id}/script`;
  const scriptPath = `/api/projects/${project.id}/script`;
  const post = (body) => fetch(scriptUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body)
  });
  const jobsBeforeOriginChecks = await fetch(`${base}/api/jobs`).then((response) => response.json());
  const wrongOrigin = await fetch(scriptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Origin: `http://127.0.0.1:${server.address().port + 1}`
    },
    body: JSON.stringify({ provider: 'codex' })
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error, 'CODEX_AUTH_SAME_ORIGIN_REQUIRED');
  const wrongHost = await postWithHost(base, scriptPath, {
    host: `attacker.example:${server.address().port}`,
    origin: base,
    body: { provider: 'codex' }
  });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.body.error, 'CODEX_AUTH_HOST_INVALID');
  assert.throws(
    () => assertLoopbackRequest({ socket: { remoteAddress: '192.0.2.10' } }),
    (error) => error.statusCode === 403 && error.code === 'CODEX_AUTH_LOCAL_ONLY'
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (await fetch(`${base}/api/jobs`).then((response) => response.json())).length,
    jobsBeforeOriginChecks.length
  );
  for (const invalid of [
    { provider: 'unknown' },
    { provider: 'rules', model: 'not-allowed' },
    { provider: 'ollama', reasoningEffort: 'medium' },
    { provider: 'codex', mode: 'cinematic' },
    { provider: 'codex', mode: null },
    { provider: 'codex', model: '--danger' },
    { provider: 'codex', model: null },
    { provider: 'codex', reasoningEffort: null },
    { provider: 'codex', timeoutMinutes: '10' },
    { provider: 'codex', command: 'codex --danger' },
    { provider: 'codex', chapterIds: [project.chapters[0].id, project.chapters[0].id] }
  ]) {
    const response = await post(invalid);
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);

  const oversized = await createProject(base, {
    title: '超过批量上限',
    sourceText: Array.from({ length: 501 }, (_value, index) => (
      `第${index + 1}章\n\n第 ${index + 1} 章正文。`
    )).join('\n\n')
  });
  assert.equal(oversized.chapters.length, 501);
  const oversizedResponse = await fetch(`${base}/api/projects/${oversized.id}/script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ provider: 'codex' })
  });
  assert.equal(oversizedResponse.status, 400);
  assert.equal((await oversizedResponse.json()).error, 'SCRIPT_CHAPTER_INVALID');
  assert.equal(calls.length, 0);

  const acceptedResponse = await post({
    chapterIds: project.chapters.map((chapter) => chapter.id),
    provider: 'codex', mode: 'drama', model: 'gpt-5.6-terra',
    reasoningEffort: 'high', timeoutMinutes: 5
  });
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  const job = await waitForJob(base, accepted.id);
  assert.equal(job.state, 'completed');
  assert.equal(job.result.provider, 'codex');
  assert.equal(job.result.mode, 'drama');
  assert.equal(job.result.successCount, 2);
  assert.equal(job.result.failureCount, 1);
  assert.deepEqual(job.result.chapters.map((item) => item.state), ['completed', 'failed', 'completed']);
  assert.equal(job.result.chapters[1].code, 'CODEX_REQUEST_FAILED');
  assert.equal(job.result.chapters[1].session.status, 'failed');
  assert.equal(job.result.chapters[1].session.lastFailure.code, 'CODEX_FAILED');
  assert.equal(job.result.versions.length, 2);
  assert.equal(maxActiveRunners, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.mode === 'drama'), true);
  assert.equal(calls.every((call) => call.model === 'gpt-5.6-terra'), true);
  assert.equal(calls.every((call) => call.reasoningEffort === 'high'), true);
  assert.equal(calls.every((call) => call.timeoutMinutes === 5), true);
  assert.doesNotMatch(JSON.stringify(job), /RAW|private|novel\.txt|--token|secret|thread-|TOKEN_SECRET/i);

  const failedChapterId = project.chapters[1].id;
  const failedSessionId = job.result.chapters[1].session.id;
  const failedProgress = await fetch(
    `${base}/api/projects/${project.id}/chapters/${failedChapterId}/codex-sessions/${failedSessionId}/codex-progress`
  ).then((response) => response.json());
  assert.equal(failedProgress.progress.code, 'CODEX_REQUEST_FAILED');
  const failedSse = await fetch(`${base}${failedProgress.progress.eventsUrl}`)
    .then((response) => response.text());
  assert.match(failedSse, /"code":"CODEX_REQUEST_FAILED"/);
  assert.doesNotMatch(failedSse, /TOKEN_SECRET|RAW|private|novel\.txt|--token|secret/i);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const persistedJobs = await fs.readFile(path.join(process.env.NVS_DATA_DIR, 'jobs.json'), 'utf8');
  assert.doesNotMatch(persistedJobs, /TOKEN_SECRET|RAW|private|novel\.txt|--token|secret/i);

  const saved = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.deepEqual(
    saved.chapters.map((chapter) => chapter.codexSessions[0].status),
    ['ready', 'failed', 'ready']
  );
  assert.equal(saved.chapters[0].scenes[0].lines[0].spokenText, '第一章-批量成功');
  assert.equal(saved.chapters[1].scenes.length, 0);
  assert.equal(saved.chapters[2].scenes[0].lines[0].spokenText, '第三章-批量成功');
  assert.doesNotMatch(JSON.stringify(saved), /RAW|private|novel\.txt|--token|secret|thread-|TOKEN_SECRET/i);
});
