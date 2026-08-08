import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-script-versions-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { getProject, initStore, mutateProject, updateSettings } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeScript(text, speaker = '旁白') {
  return {
    chapterTitle: '版本章节',
    roles: [{ name: '旁白', aliases: [], description: '', isNarrator: true }],
    scenes: [{
      title: '场景 1', context: '',
      lines: [{
        kind: 'narration', speaker, sourceText: '小说原文', spokenText: text,
        emotion: 'neutral', emotionNote: '', intensity: 0.5, pace: 1,
        pauseAfterMs: 350, confidence: 1, needsReview: false
      }]
    }],
    warnings: []
  };
}

async function createProject(base, title) {
  return fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, sourceText: '第一章\n\n小说原文。' })
  }).then((response) => response.json());
}

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await fetch(`${base}/api/jobs/${jobId}`).then((response) => response.json());
    if (['completed', 'failed'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待任务超时');
}

test('Ollama 合并到协作室，同 provider 续问并在跨 provider 时新建 Session', async (t) => {
  await initStore();
  await updateSettings({ ollamaModel: '' });
  const codexCalls = [];
  const ollamaCalls = [];
  const codexRunner = async (input) => {
    codexCalls.push(input);
    return {
      threadId: input.sessionId || `codex-thread-${codexCalls.length}`,
      script: makeScript(`Codex 版本 ${codexCalls.length}`)
    };
  };
  const ollamaRunner = async (input) => {
    ollamaCalls.push(input);
    if (input.prompt === '模拟本地服务不可用') {
      throw Object.assign(new Error('RAW local diagnostics'), { code: 'OLLAMA_UNAVAILABLE' });
    }
    return { threadId: null, script: makeScript(`Ollama 版本 ${ollamaCalls.length}`) };
  };
  const server = createServer({
    codexRunner,
    ollamaRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, 'provider 协作测试');
  const chapterId = project.chapters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  for (const provider of [null, 'rules', 'import', 'bad', '', [], {}]) {
    const response = await fetch(sessionsUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'SCRIPT_SESSION_PROVIDER_INVALID');
  }
  const invalidOllamaOption = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', reasoningEffort: 'high' })
  });
  assert.equal(invalidOllamaOption.status, 400);
  assert.equal((await invalidOllamaOption.json()).error, 'SCRIPT_SESSION_OPTION_INVALID');
  for (const model of ['--remote', ['qwen3:8b'], { name: 'qwen3:8b' }]) {
    const invalidModel = await fetch(sessionsUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model })
    });
    assert.equal(invalidModel.status, 400);
    assert.equal((await invalidModel.json()).error, 'OLLAMA_MODEL_INVALID');
  }

  const initialResponse = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', prompt: '先整理为本地模型版本' })
  });
  assert.equal(initialResponse.status, 201);
  const initial = await initialResponse.json();
  assert.equal(initial.provider, 'ollama');
  assert.equal(initial.session.provider, 'ollama');
  assert.equal(initial.session.source, 'ollama');
  assert.equal(initial.session.model, 'qwen3:8b');
  assert.equal(initial.session.reasoningEffort, null);
  assert.equal(initial.session.versionAvailable, true);
  assert.equal(initial.session.versionOrdinal, 1);
  assert.equal(ollamaCalls[0].provider, 'ollama');
  assert.equal(ollamaCalls[0].model, 'qwen3:8b');
  assert.equal(ollamaCalls[0].timeoutMs, 10 * 60_000);

  const followResponse = await fetch(`${sessionsUrl}/${initial.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '继续润色当前稿' })
  });
  assert.equal(followResponse.status, 200);
  const follow = await followResponse.json();
  assert.equal(follow.session.id, initial.session.id);
  assert.equal(follow.session.turnCount, 2);
  assert.equal(follow.session.provider, 'ollama');
  assert.equal(follow.session.versionOrdinal, 1);
  assert.equal(ollamaCalls[1].chapter.scenes[0].lines[0].spokenText, 'Ollama 版本 1');

  const crossResponse = await fetch(`${sessionsUrl}/${initial.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', prompt: '改用 Codex 继续' })
  });
  assert.equal(crossResponse.status, 200);
  const cross = await crossResponse.json();
  assert.notEqual(cross.session.id, initial.session.id);
  assert.equal(cross.session.provider, 'codex');
  assert.equal(cross.session.versionOrdinal, 2);
  assert.equal(codexCalls[0].sessionId, '');
  assert.equal(codexCalls[0].baselineCurrentScript, true);

  const inactive = await fetch(`${sessionsUrl}/${initial.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', prompt: '不应混用非活动版本' })
  });
  assert.equal(inactive.status, 409);
  assert.equal((await inactive.json()).error, 'SCRIPT_SESSION_NOT_ACTIVE');

  const resumeResponse = await fetch(`${sessionsUrl}/${cross.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Codex 同线程续问' })
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = await resumeResponse.json();
  assert.equal(resumed.session.id, cross.session.id);
  assert.equal(codexCalls[1].sessionId, 'codex-thread-1');

  const listed = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(listed.sessions.some((session) => session.provider === 'ollama'), true);
  assert.equal(listed.sessions.some((session) => session.provider === 'codex'), true);
  assert.doesNotMatch(JSON.stringify(listed), /codex-thread-/);
  const deleteActive = await fetch(`${sessionsUrl}/${cross.session.id}`, { method: 'DELETE' });
  assert.equal(deleteActive.status, 409);
  assert.equal((await deleteActive.json()).error, 'SCRIPT_SESSION_ACTIVE_DELETE');
  const deleteOld = await fetch(`${sessionsUrl}/${initial.session.id}`, { method: 'DELETE' });
  assert.equal(deleteOld.status, 204);
  const afterDelete = await fetch(sessionsUrl).then((response) => response.json());
  assert.equal(afterDelete.sessions.some((session) => session.id === initial.session.id), false);

  const failedProject = await createProject(base, 'Ollama 错误语义');
  const failedChapterId = failedProject.chapters[0].id;
  const failedResponse = await fetch(`${base}/api/projects/${failedProject.id}/chapters/${failedChapterId}/codex-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', prompt: '模拟本地服务不可用' })
  });
  assert.equal(failedResponse.status, 503);
  const failed = await failedResponse.json();
  assert.equal(failed.error, 'OLLAMA_UNAVAILABLE');
  assert.match(failed.message, /Ollama/);
  assert.doesNotMatch(JSON.stringify(failed), /RAW local diagnostics|Codex 本轮/);
});

test('规则、Ollama job 与剧本导入都会保存可激活版本，重复 job 被拒绝', async (t) => {
  await initStore();
  let holdBatch = false;
  let releaseBatch;
  let signalBatch;
  const batchStarted = new Promise((resolve) => { signalBatch = resolve; });
  const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
  const server = createServer({
    codexRunner: async (input) => ({
      threadId: input.sessionId || 'version-thread', script: makeScript('可恢复的 Codex 版本')
    }),
    ollamaRunner: async () => {
      if (holdBatch) {
        signalBatch();
        await batchGate;
      }
      return { threadId: null, script: makeScript('Ollama job 版本') };
    },
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, '版本恢复测试');
  const chapterId = project.chapters[0].id;
  const narratorId = project.characters[0].id;
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;

  const codex = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  }).then((response) => response.json());
  const codexId = codex.session.id;

  const invalidProvider = await fetch(`${base}/api/projects/${project.id}/script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'invalid' })
  });
  assert.equal(invalidProvider.status, 400);

  const rulesStart = await fetch(`${base}/api/projects/${project.id}/script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'rules', chapterIds: [chapterId] })
  }).then((response) => response.json());
  const rulesJob = await waitForJob(base, rulesStart.id);
  assert.equal(rulesJob.state, 'completed');
  assert.equal(rulesJob.result.versions[0].session.provider, 'rules');
  assert.equal(Number.isSafeInteger(rulesJob.result.versions[0].session.versionOrdinal), true);
  const afterRules = await fetch(sessionsUrl).then((response) => response.json());
  const rulesVersion = afterRules.sessions.find((session) => session.provider === 'rules');
  assert.ok(rulesVersion?.versionAvailable);
  assert.equal(afterRules.activeSessionId, rulesVersion.id);

  const voice = await fetch(`${base}/api/voices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '版本角色音色', consent: true })
  }).then((response) => response.json());
  const rename = await fetch(`${base}/api/projects/${project.id}/characters/${narratorId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新版旁白', voiceId: voice.id })
  });
  assert.equal(rename.status, 200);

  const restoredCodex = await fetch(`${sessionsUrl}/${codexId}/activate`, { method: 'POST' });
  assert.equal(restoredCodex.status, 200);
  const codexProject = (await restoredCodex.json()).project;
  assert.equal(codexProject.chapters[0].scenes[0].lines[0].spokenText, '可恢复的 Codex 版本');
  assert.equal(codexProject.chapters[0].scenes[0].lines[0].speakerId, narratorId);
  assert.equal(codexProject.characters.find((role) => role.id === narratorId).voiceId, voice.id);

  const importedScript = makeScript('手动导入版本');
  const importResponse = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/script-import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: importedScript })
  });
  assert.equal(importResponse.status, 200);
  const importedProject = await importResponse.json();
  const importVersion = importedProject.chapters[0].codexSessions.find((session) => session.provider === 'import');
  assert.ok(importVersion?.versionAvailable);
  assert.equal(importedProject.chapters[0].activeCodexSessionId, importVersion.id);

  const invalidImport = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/script-import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: '{not json' })
  });
  assert.equal(invalidImport.status, 400);
  assert.equal((await invalidImport.json()).error, 'SCRIPT_IMPORT_INVALID');

  const restoredRules = await fetch(`${sessionsUrl}/${rulesVersion.id}/activate`, { method: 'POST' });
  assert.equal(restoredRules.status, 200);
  const rulesProject = (await restoredRules.json()).project;
  assert.notEqual(rulesProject.chapters[0].scenes[0].lines[0].spokenText, '手动导入版本');

  holdBatch = true;
  const firstBatchResponse = await fetch(`${base}/api/projects/${project.id}/script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', chapterIds: [chapterId] })
  });
  assert.equal(firstBatchResponse.status, 202);
  const firstBatch = await firstBatchResponse.json();
  await batchStarted;
  const duplicate = await fetch(`${base}/api/projects/${project.id}/script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', chapterIds: [chapterId] })
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'SCRIPT_JOB_ACTIVE');
  releaseBatch();
  assert.equal((await waitForJob(base, firstBatch.id)).state, 'completed');
});

test('覆盖或切换前会为无活动 Session 的当前手工稿建立可恢复基线', async (t) => {
  await initStore();
  const server = createServer({
    codexRunner: async () => ({ threadId: 'baseline-thread', script: makeScript('模型生成稿') }),
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, '孤立手工稿恢复测试');
  const chapterId = project.chapters[0].id;
  await mutateProject(project.id, (draft) => {
    draft.chapters[0].scenes = makeScript('首次覆盖前手工稿').scenes;
    draft.chapters[0].codexSessions = [];
    draft.chapters[0].activeCodexSessionId = null;
  });
  const sessionsUrl = `${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`;
  const generatedResponse = await fetch(sessionsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(generatedResponse.status, 201);
  const generated = await generatedResponse.json();
  let stored = await getProject(project.id);
  const firstBaseline = stored.chapters[0].codexSessions.find((session) => (
    session.title === '当前稿自动备份'
      && session.scriptSnapshot.scenes[0].lines[0].spokenText === '首次覆盖前手工稿'
  ));
  assert.ok(firstBaseline);

  const firstRestore = await fetch(`${sessionsUrl}/${firstBaseline.id}/activate`, { method: 'POST' });
  assert.equal(firstRestore.status, 200);
  assert.equal((await firstRestore.json()).project.chapters[0].scenes[0].lines[0].spokenText, '首次覆盖前手工稿');

  await mutateProject(project.id, (draft) => {
    draft.chapters[0].scenes[0].lines[0].spokenText = '失效 activeId 下的手工稿';
    draft.chapters[0].activeCodexSessionId = 'codexchat_ffffffffffffffff';
  });
  const switchToOld = await fetch(`${sessionsUrl}/${generated.session.id}/activate`, { method: 'POST' });
  assert.equal(switchToOld.status, 200);
  assert.equal((await switchToOld.json()).project.chapters[0].scenes[0].lines[0].spokenText, '模型生成稿');
  stored = await getProject(project.id);
  const orphanBaseline = stored.chapters[0].codexSessions.find((session) => (
    session.title === '当前稿自动备份'
      && session.scriptSnapshot.scenes[0].lines[0].spokenText === '失效 activeId 下的手工稿'
  ));
  assert.ok(orphanBaseline);
  const orphanRestore = await fetch(`${sessionsUrl}/${orphanBaseline.id}/activate`, { method: 'POST' });
  assert.equal(orphanRestore.status, 200);
  assert.equal((await orphanRestore.json()).project.chapters[0].scenes[0].lines[0].spokenText, '失效 activeId 下的手工稿');
});

test('批量角色音色绑定先全量校验再原子写入，并只把变化角色台词标 stale', async (t) => {
  await initStore();
  let pauseDelete = false;
  let batchEntered = false;
  let signalDeleteStarted;
  let releaseDelete;
  const deleteStarted = new Promise((resolve) => { signalDeleteStarted = resolve; });
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  const server = createServer({
    async voiceMutationHook({ action }) {
      if (action === 'batch-bind') batchEntered = true;
      if (pauseDelete && action === 'delete') {
        signalDeleteStarted();
        await deleteGate;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await createProject(base, '批量音色测试');
  const narratorId = project.characters[0].id;
  const roleId = 'role_batch_second';
  await mutateProject(project.id, (draft) => {
    draft.characters.push({
      id: roleId, name: '角色乙', aliases: [], description: '', isNarrator: false,
      voiceId: null
    });
    draft.chapters[0].scenes = [{
      id: 'scene_voice', title: '场景', context: '', lines: [
        { id: 'line_narrator', kind: 'narration', speakerId: narratorId, speaker: '旁白', spokenText: '旁白', render: { status: 'ready' } },
        { id: 'line_role', kind: 'dialogue', speakerId: roleId, speaker: '角色乙', spokenText: '台词', render: { status: 'ready' } }
      ]
    }];
  });
  const makeVoice = (name) => fetch(`${base}/api/voices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, consent: true })
  }).then((response) => response.json());
  const [voiceA, voiceB] = await Promise.all([makeVoice('音色 A'), makeVoice('音色 B')]);
  const url = `${base}/api/projects/${project.id}/characters/voices`;

  const failed = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [
      { roleId: narratorId, voiceId: voiceA.id },
      { roleId, voiceId: 'voice_0000000000000000' }
    ] })
  });
  assert.equal(failed.status, 404);
  let stored = await getProject(project.id);
  assert.equal(stored.characters.find((role) => role.id === narratorId).voiceId || null, null);
  assert.equal(stored.characters.find((role) => role.id === roleId).voiceId || null, null);

  const duplicate = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [
      { roleId, voiceId: voiceA.id }, { roleId, voiceId: voiceB.id }
    ] })
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error, 'VOICE_ASSIGNMENTS_DUPLICATE_ROLE');

  const saved = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [
      { roleId: narratorId, voiceId: voiceA.id },
      { roleId, voiceId: voiceB.id }
    ] })
  });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.deepEqual(new Set(result.updatedRoleIds), new Set([narratorId, roleId]));
  stored = await getProject(project.id);
  assert.equal(stored.characters.find((role) => role.id === narratorId).voiceId, voiceA.id);
  assert.equal(stored.characters.find((role) => role.id === roleId).voiceId, voiceB.id);
  assert.equal(stored.chapters[0].scenes[0].lines.every((line) => line.render.status === 'stale'), true);

  for (const voiceId of ['', false, 0, [], {}]) {
    const invalidSingle = await fetch(`${base}/api/projects/${project.id}/characters/${roleId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId })
    });
    assert.equal(invalidSingle.status, 400);
    assert.equal((await invalidSingle.json()).error, 'VOICE_ASSIGNMENT_INVALID');
  }
  stored = await getProject(project.id);
  assert.equal(stored.characters.find((role) => role.id === roleId).voiceId, voiceB.id);

  const unbound = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [{ roleId, voiceId: null }] })
  });
  assert.equal(unbound.status, 200);
  assert.deepEqual((await unbound.json()).updatedRoleIds, [roleId]);

  const raceVoice = await makeVoice('并发删除音色');
  pauseDelete = true;
  batchEntered = false;
  const deleting = fetch(`${base}/api/voices/${raceVoice.id}`, { method: 'DELETE' });
  await deleteStarted;
  const binding = fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [{ roleId, voiceId: raceVoice.id }] })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(batchEntered, false);
  releaseDelete();
  assert.equal((await deleting).status, 204);
  const racedBinding = await binding;
  assert.equal(racedBinding.status, 404);
  stored = await getProject(project.id);
  assert.notEqual(stored.characters.find((role) => role.id === roleId).voiceId, raceVoice.id);
});
