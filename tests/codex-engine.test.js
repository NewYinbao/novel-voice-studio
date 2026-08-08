import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import {
  buildCodexExecArgs,
  buildCodexFollowUpPrompt,
  chapterToScriptSnapshot,
  codexProcessEnv,
  CODEX_PROCESS_TIMEOUT_MS,
  createCodexJsonlProgressParser,
  formatCodexTimeoutDuration,
  mapCodexJsonlProgress,
  normalizeImportedScript,
  parseCodexJsonl,
  resolveCodexModel,
  rulesToScript,
  runCodexSession,
  runOllamaSession
} from '../src/lib/script-engine.js';
import {
  codexTimeoutMinutesToMs,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes,
  normalizeOllamaModel
} from '../src/lib/codex-options.js';
import {
  appendCodexTurn,
  createCodexSession,
  createPendingCodexSession,
  MAX_SESSIONS_PER_CHAPTER,
  normalizeScriptSessionProvider,
  publicCodexSession,
  saveCodexSession
} from '../src/lib/codex-sessions.js';
import { SCRIPT_STRUCTURE_LIMITS } from '../src/lib/script-limits.js';

test('Codex Session 保存私有剧本版本快照且公开接口只暴露可用标记', () => {
  const script = {
    chapterTitle: '第一章', roles: [{ name: '旁白', aliases: [], description: '', isNarrator: true }],
    scenes: [{ id: 'scene_a', title: '场景', context: '', lines: [{ id: 'line_a', kind: 'narration', speaker: '旁白', sourceText: '原文', spokenText: '版本一' }] }],
    warnings: []
  };
  const session = createCodexSession({
    threadId: 'thread-a', model: 'gpt-5.6-terra', reasoningEffort: 'medium', timeoutMinutes: 10,
    mode: 'faithful', prompt: '生成版本', script
  });
  const chapter = { codexSessions: [], activeCodexSessionId: null };
  saveCodexSession(chapter, session);
  assert.equal(session.versionOrdinal, 1);
  script.scenes[0].lines[0].spokenText = '外部修改';
  assert.equal(session.scriptSnapshot.scenes[0].lines[0].spokenText, '版本一');
  const nextScript = structuredClone(session.scriptSnapshot);
  nextScript.scenes[0].lines[0].spokenText = '版本二';
  appendCodexTurn(session, {
    prompt: '继续修改', model: 'gpt-5.6-terra', reasoningEffort: 'medium', timeoutMinutes: 10,
    script: nextScript
  });
  saveCodexSession(chapter, session);
  assert.equal(session.versionOrdinal, 1);
  assert.equal(session.scriptSnapshot.scenes[0].lines[0].spokenText, '版本二');
  const publicValue = publicCodexSession(session);
  assert.equal(publicValue.versionAvailable, true);
  assert.equal('scriptSnapshot' in publicValue, false);
  assert.equal('codexThreadId' in publicValue, false);
});

test('通用剧本版本保留超过 8 个可恢复快照且到硬上限不静默淘汰', () => {
  const chapter = { codexSessions: [], activeCodexSessionId: null };
  for (let index = 0; index < MAX_SESSIONS_PER_CHAPTER; index += 1) {
    const script = {
      chapterTitle: '版本测试', roles: [], warnings: [],
      scenes: [{ title: '场景', context: '', lines: [{
        kind: 'narration', speaker: '旁白', sourceText: '原文', spokenText: `版本 ${index}`
      }] }]
    };
    saveCodexSession(chapter, createCodexSession({
      provider: 'rules', source: 'rules', title: `规则版本 ${index}`, script
    }));
  }
  assert.equal(chapter.codexSessions.length, 50);
  assert.deepEqual(
    [...chapter.codexSessions].map((session) => session.versionOrdinal).sort((a, b) => a - b),
    Array.from({ length: 50 }, (_value, index) => index + 1)
  );
  assert.equal(chapter.codexSessions.every((session) => session.scriptSnapshot?.scenes?.length), true);
  assert.equal(publicCodexSession(chapter.codexSessions[0]).provider, 'rules');
  assert.throws(
    () => saveCodexSession(chapter, createCodexSession({
      provider: 'import', script: chapter.codexSessions[0].scriptSnapshot
    })),
    (error) => error.statusCode === 409 && error.code === 'SCRIPT_SESSION_VERSION_LIMIT'
  );
  assert.equal(chapter.codexSessions.length, 50);
  assert.equal(normalizeScriptSessionProvider(undefined), 'codex');
  for (const value of [null, '', 'rules', 'import', 'invalid', [], {}]) {
    assert.throws(
      () => normalizeScriptSessionProvider(value, { allowed: ['codex', 'ollama'] }),
      (error) => error.code === 'SCRIPT_SESSION_PROVIDER_INVALID'
    );
  }
});

test('pending/running Session 在容量边界不会被回收，私有 runId 与基线指纹不公开', () => {
  const script = {
    chapterTitle: '运行中版本', roles: [], warnings: [],
    scenes: [{ title: '场景', context: '', lines: [{
      kind: 'narration', speaker: '旁白', sourceText: '原文', spokenText: '运行中'
    }] }]
  };
  const chapter = { codexSessions: [], activeCodexSessionId: null };
  for (let index = 0; index < MAX_SESSIONS_PER_CHAPTER - 1; index += 1) {
    saveCodexSession(chapter, createCodexSession({ provider: 'import', script }));
  }
  const pending = createPendingCodexSession({
    provider: 'codex', script,
    progressId: 'codexprog_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baselineChapterHash: `sha256:${'b'.repeat(64)}`,
    prompt: '继续处理'
  });
  saveCodexSession(chapter, pending);
  assert.throws(
    () => saveCodexSession(chapter, createCodexSession({ provider: 'rules', script })),
    (error) => error.code === 'SCRIPT_SESSION_VERSION_LIMIT'
  );
  const storedPending = chapter.codexSessions.find((session) => session.id === pending.id);
  assert.equal(storedPending.status, 'pending');
  assert.equal(storedPending.activeRun.baselineChapterHash, `sha256:${'b'.repeat(64)}`);
  const publicValue = publicCodexSession(storedPending);
  assert.equal(publicValue.activeRun.progressId, pending.activeRun.progressId);
  assert.equal(Object.hasOwn(publicValue.activeRun, 'baselineChapterHash'), false);
  assert.doesNotMatch(JSON.stringify(publicValue), /runId|sha256:/);
});

test('剧本结构、文本、总字节与版本累计快照都执行统一硬预算', async () => {
  const makeLine = (text = '短台词') => ({
    kind: 'narration', speaker: '旁白', sourceText: text, spokenText: text,
    emotion: 'neutral', emotionNote: '', intensity: 0.5, pace: 1,
    pauseAfterMs: 350, confidence: 1, needsReview: false
  });
  const base = {
    chapterTitle: '预算测试',
    roles: [{ name: '旁白', aliases: [], description: '', isNarrator: true }],
    scenes: [{ title: '场景', context: '', lines: [makeLine()] }],
    warnings: []
  };
  const chapter = { title: '预算测试', sourceText: '原文' };
  const expectInvalid = (script) => assert.throws(
    () => normalizeImportedScript(script, chapter),
    (error) => error.code === 'SCRIPT_SCHEMA_INVALID' && error.statusCode === 400
  );

  const longText = structuredClone(base);
  longText.scenes[0].lines[0].spokenText = '字'.repeat(SCRIPT_STRUCTURE_LIMITS.lineTextChars + 1);
  expectInvalid(longText);
  expectInvalid({ ...base, roles: Array.from({ length: SCRIPT_STRUCTURE_LIMITS.roles + 1 }, (_v, i) => ({
    name: `角色${i}`, aliases: [], description: '', isNarrator: false
  })) });
  expectInvalid({ ...base, scenes: Array.from({ length: SCRIPT_STRUCTURE_LIMITS.scenes + 1 }, () => ({
    title: '场景', context: '', lines: []
  })) });
  expectInvalid({ ...base, scenes: [{
    title: '场景', context: '',
    lines: Array.from({ length: SCRIPT_STRUCTURE_LIMITS.linesPerScene + 1 }, () => makeLine())
  }] });
  expectInvalid({ ...base, scenes: Array.from({ length: 11 }, () => ({
    title: '场景', context: '', lines: Array.from({ length: 500 }, () => makeLine())
  })) });
  for (const invalid of [
    { ...base, roles: [null] },
    { ...base, scenes: [null] },
    { ...base, scenes: [{ title: '场景', context: '', lines: [null] }] }
  ]) expectInvalid(invalid);
  const unpunctuatedRules = rulesToScript({ title: '长段落', sourceText: '长'.repeat(30_000) });
  assert.ok(unpunctuatedRules.scenes.flatMap((scene) => scene.lines)
    .every((line) => line.sourceText.length <= 2_000 && line.spokenText.length <= 2_000));

  const multiByte = '字'.repeat(4_000);
  const largeSnapshot = {
    ...base,
    scenes: [{ title: '大场景', context: '', lines: Array.from({ length: 150 }, () => makeLine(multiByte)) }]
  };
  const tooLarge = structuredClone(largeSnapshot);
  tooLarge.scenes[0].lines.push(...Array.from({ length: 50 }, () => makeLine(multiByte)));
  expectInvalid(tooLarge);

  const versionChapter = { codexSessions: [], activeCodexSessionId: null };
  let rejected = null;
  for (let index = 0; index < 20; index += 1) {
    try {
      saveCodexSession(versionChapter, createCodexSession({
        provider: 'import', title: `大版本 ${index}`, script: largeSnapshot
      }));
    } catch (error) {
      rejected = error;
      break;
    }
  }
  assert.equal(rejected?.code, 'SCRIPT_SESSION_VERSION_LIMIT');
  assert.equal(rejected?.statusCode, 409);
  assert.ok(versionChapter.codexSessions.length > 1 && versionChapter.codexSessions.length < 20);
  const smallActive = createCodexSession({ provider: 'import', title: '小型活动稿', script: base });
  saveCodexSession(versionChapter, smallActive);
  assert.throws(
    () => saveCodexSession(versionChapter, {
      ...smallActive, scriptSnapshot: structuredClone(largeSnapshot)
    }),
    (error) => error.code === 'SCRIPT_SESSION_VERSION_LIMIT' && error.statusCode === 409
  );
  assert.equal(versionChapter.activeCodexSessionId, smallActive.id);
  assert.equal(
    versionChapter.codexSessions.find((session) => session.id === smallActive.id).scriptSnapshot.scenes[0].lines.length,
    1
  );

  const schema = JSON.parse(await fs.readFile(new URL('../schemas/audiobook-script.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.roles.maxItems, SCRIPT_STRUCTURE_LIMITS.roles);
  assert.equal(schema.properties.scenes.maxItems, SCRIPT_STRUCTURE_LIMITS.scenes);
  assert.equal(schema.properties.scenes.items.properties.lines.maxItems, SCRIPT_STRUCTURE_LIMITS.linesPerScene);
  assert.equal(
    schema.properties.scenes.items.properties.lines.items.properties.spokenText.maxLength,
    SCRIPT_STRUCTURE_LIMITS.lineTextChars
  );
});

test('Ollama 会话以制作台当前完整剧本和本轮要求为基线并返回结构化结果', async () => {
  const progress = [];
  let request;
  const chapter = {
    title: '本地模型章节', sourceText: '小说原文', scriptWarnings: [],
    scenes: [{ title: '当前场景', context: '', lines: [{
      kind: 'narration', speaker: '旁白', sourceText: '小说原文', spokenText: '用户手工修改后的当前台词',
      emotion: 'neutral', intensity: 0.5, pace: 1, pauseAfterMs: 350
    }] }]
  };
  const returned = {
    chapterTitle: '本地模型章节',
    roles: [{ name: '旁白', aliases: [], description: '', isNarrator: true }],
    scenes: [{ title: '当前场景', context: '', lines: [{
      kind: 'narration', speaker: '旁白', sourceText: '小说原文', spokenText: 'Ollama 调整后的台词',
      emotion: 'warm', emotionNote: '', intensity: 0.6, pace: 1, pauseAfterMs: 350,
      confidence: 1, needsReview: false
    }] }], warnings: []
  };
  const result = await runOllamaSession({
    chapter,
    settings: { ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: '' },
    prompt: '语气再温暖一点',
    timeoutMinutes: 5,
    onProgress: (event) => progress.push(event),
    async fetchImpl(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ response: JSON.stringify(returned) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  assert.equal(request.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.model, 'qwen3:8b');
  assert.match(request.body.prompt, /用户手工修改后的当前台词/);
  assert.match(request.body.prompt, /语气再温暖一点/);
  assert.equal(result.script.scenes[0].lines[0].spokenText, 'Ollama 调整后的台词');
  assert.equal(result.threadId, null);
  assert.deepEqual(progress.map((event) => event.phase), ['analyzing', 'drafting', 'validating']);

  await assert.rejects(
    runOllamaSession({
      chapter, settings: { ollamaUrl: 'http://localhost:11434?redirect=evil', ollamaModel: '' },
      timeoutMinutes: 5, fetchImpl: async () => { throw new Error('must not run'); }
    }),
    (error) => error.code === 'OLLAMA_UNAVAILABLE'
  );
  await assert.rejects(
    runOllamaSession({
      chapter, settings: { ollamaUrl: 'http://localhost:11434/proxy', ollamaModel: '' },
      timeoutMinutes: 5, fetchImpl: async () => { throw new Error('must not run'); }
    }),
    (error) => error.code === 'OLLAMA_UNAVAILABLE'
  );

  await assert.rejects(
    runOllamaSession({
      chapter, settings: { ollamaUrl: 'https://example.com', ollamaModel: 'qwen3:8b' },
      timeoutMinutes: 5, fetchImpl: async () => { throw new Error('must not run'); }
    }),
    (error) => error.code === 'OLLAMA_UNAVAILABLE'
  );
  await assert.rejects(
    runOllamaSession({
      chapter, settings: { ollamaUrl: 'http://localhost:11434', ollamaModel: 'qwen3:8b' },
      timeoutMinutes: 5, timeoutMs: 10,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })
    }),
    (error) => error.code === 'OLLAMA_TIMEOUT' && error.timeoutMs === 10
  );
});

test('Codex 初始会话使用 JSONL 和 Schema，且不使用 ephemeral', () => {
  const args = buildCodexExecArgs({ schemaPath: 'C:\\schemas\\script.json', model: 'gpt-test' });
  assert.deepEqual(args, [
    'exec', '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'hooks',
    '--model', 'gpt-test', '-c', 'model_reasoning_effort="medium"',
    '--output-schema', 'C:\\schemas\\script.json', '-'
  ]);
  assert.equal(args.includes('--ephemeral'), false);
});

test('Codex 续问使用指定 session ID、Terra、推理强度和同一个 Schema', () => {
  const args = buildCodexExecArgs({
    schemaPath: 'schema.json', reasoningEffort: 'max',
    sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53'
  });
  assert.deepEqual(args, [
    'exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'hooks',
    '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="max"',
    '--output-schema', 'schema.json', '0199a213-81c0-7800-8aa1-bbab2a035a53', '-'
  ]);
  assert.equal(args.includes('--sandbox'), false);
});

test('Codex JSONL 解析会提取 thread、最终剧本消息和 usage', () => {
  const assistantText = JSON.stringify({ chapterTitle: '第一章', roles: [], scenes: [], warnings: [] });
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '中间说明' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: assistantText } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 } })
  ].join('\n');

  assert.deepEqual(parseCodexJsonl(output), {
    threadId: 'thread-123',
    assistantText,
    usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 },
    eventCount: 5
  });
});

test('Codex 续问嵌入用户手工编辑后的完整剧本快照', () => {
  const project = {
    characters: [
      { id: 'narrator', name: '旁白', aliases: [], description: '叙述者', isNarrator: true },
      { id: 'role-lin', name: '林默', aliases: ['小林'], description: '主角', isNarrator: false }
    ]
  };
  const chapter = {
    title: '第一章',
    scriptWarnings: ['已手工确认'],
    scenes: [{
      id: 'scene-internal', title: '对峙', context: '仓库',
      lines: [{
        id: 'line-internal', kind: 'dialogue', speakerId: 'role-lin', speaker: '林默',
        sourceText: '“你来了。”', spokenText: '你终于来了。', emotion: 'angry',
        emotionNote: '压着火气', intensity: 0.85, pace: 1.1, pauseAfterMs: 650,
        confidence: 1, needsReview: false, render: { status: 'ready' }
      }]
    }]
  };

  const snapshot = chapterToScriptSnapshot(chapter, project);
  assert.equal(snapshot.scenes[0].lines[0].spokenText, '你终于来了。');
  assert.equal(snapshot.scenes[0].lines[0].intensity, 0.85);
  assert.equal('id' in snapshot.scenes[0].lines[0], false);
  assert.equal('render' in snapshot.scenes[0].lines[0], false);

  const prompt = buildCodexFollowUpPrompt({ chapter, project, prompt: '把这句改得更克制' });
  assert.match(prompt, /把这句改得更克制/);
  assert.match(prompt, /你终于来了/);
  assert.match(prompt, /必须返回修改后的完整章节剧本 JSON/);
});

test('Codex JSONL 错误事件会转成可识别错误', () => {
  assert.throws(
    () => parseCodexJsonl(JSON.stringify({ type: 'turn.failed', error: { message: '会话已失效' } })),
    (error) => error.code === 'CODEX_TURN_FAILED'
  );
});

test('Codex JSONL 进度按 UTF-8 分块实时解析且只输出固定白名单字段', () => {
  const received = [];
  const parser = createCodexJsonlProgressParser((event) => received.push(event));
  const secret = '绝不能返回的小说原文、reasoning、C:\\private\\schema.json 和 thread-secret';
  const payload = Buffer.from(`\uFEFF${[
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-secret' }),
    JSON.stringify({ type: 'turn.started', prompt: secret }),
    JSON.stringify({ type: 'item.updated', item: { type: 'reasoning', text: secret } }),
    JSON.stringify({ type: 'item.updated', item: { type: 'agent_message', text: secret } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: secret, output: secret } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 999 } })
  ].join('\n')}\n`, 'utf8');
  // Split inside a multi-byte Chinese sequence as well as across JSONL boundaries.
  for (let offset = 0; offset < payload.length; offset += 7) parser.push(payload.subarray(offset, offset + 7));
  parser.end();

  assert.deepEqual(received, [
    { type: 'thread', phase: 'started' },
    { type: 'turn', phase: 'started' },
    { type: 'stage', phase: 'analyzing' },
    { type: 'stage', phase: 'drafting' },
    { type: 'stage', phase: 'processing' },
    { type: 'turn', phase: 'completed' }
  ]);
  const publicValue = JSON.stringify(received);
  assert.doesNotMatch(publicValue, /小说原文|reasoning|private|thread-secret|tokens|999/i);
});

test('Codex JSONL 进度忽略错误正文和事件洪泛', () => {
  assert.equal(mapCodexJsonlProgress({ type: 'turn.failed', error: { message: 'secret' } }), null);
  assert.deepEqual(
    mapCodexJsonlProgress({ type: 'item.started', item: { type: 'web_search', query: 'secret query' } }),
    { type: 'stage', phase: 'processing' }
  );
  const received = [];
  const parser = createCodexJsonlProgressParser((event) => received.push(event), { maxParsedLines: 2 });
  parser.push(`${JSON.stringify({ type: 'unknown' })}\n${JSON.stringify({ type: 'unknown' })}\n`);
  parser.push(`${JSON.stringify({ type: 'thread.started', thread_id: 'too-late' })}\n`);
  parser.end();
  assert.deepEqual(received, []);
});

test('Codex runner 收到 abort 后终止受控子进程且不等待真实 CLI', async () => {
  const controller = new AbortController();
  let child;
  let signalSpawned;
  const spawned = new Promise((resolve) => { signalSpawned = resolve; });
  const run = runCodexSession({
    project: { id: 'project_abort' },
    chapter: { id: 'chapter_abort', title: '取消测试', sourceText: '测试原文。' },
    settings: { codexCommand: 'fake-codex' },
    signal: controller.signal,
    spawnProcess(command, args, options) {
      assert.equal(command, 'fake-codex');
      assert.equal(args[0], 'exec');
      assert.equal(options.shell, false);
      assert.equal(options.detached, undefined);
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls += 1;
        child.signalCode = 'SIGTERM';
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      signalSpawned();
      return child;
    }
  });
  await spawned;
  controller.abort();
  await assert.rejects(run, (error) => error.code === 'CODEX_CANCELLED');
  assert.equal(child.killCalls, 1);
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
});

test('Codex 默认 10 分钟上限来自子进程 timer，所选时长超时会终止唯一受控子进程', async () => {
  assert.equal(CODEX_PROCESS_TIMEOUT_MS, 600_000);
  let child;
  const run = runCodexSession({
    project: { id: 'project_timeout' },
    chapter: { id: 'chapter_timeout', title: '超时测试', sourceText: '测试原文。' },
    settings: { codexCommand: 'fake-codex' },
    timeoutMs: 10,
    spawnProcess() {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls += 1;
        child.signalCode = 'SIGTERM';
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    }
  });
  await assert.rejects(
    run,
    (error) => error.code === 'CODEX_TIMEOUT_STARTING'
      && error.timeoutMs === 10
      && /10 毫秒/.test(error.message)
  );
  assert.equal(child.killCalls, 1);
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
});

test('Codex 已收到 JSONL 后超时会标记为 active 且不公开原始事件', async () => {
  let child;
  const run = runCodexSession({
    project: { id: 'project_active_timeout' },
    chapter: { id: 'chapter_active_timeout', title: '生成超时', sourceText: '测试原文。' },
    settings: { codexCommand: 'fake-codex' },
    timeoutMs: 10,
    spawnProcess() {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls += 1;
        child.signalCode = 'SIGTERM';
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({
        type: 'turn.started', prompt: 'RAW-PROMPT-SECRET'
      })}\n`));
      return child;
    }
  });
  await assert.rejects(
    run,
    (error) => error.code === 'CODEX_TIMEOUT_ACTIVE'
      && error.timeoutMs === 10
      && /10 毫秒/.test(error.message)
      && !/RAW-PROMPT-SECRET/.test(error.message)
  );
  assert.equal(child.killCalls, 1);
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
});

test('Codex 子进程只继承白名单环境变量', () => {
  const env = codexProcessEnv({
    Path: 'C:\\bin', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    OPENAI_API_KEY: 'test-key', DATABASE_URL: 'must-not-leak', APP_SECRET: 'must-not-leak'
  });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\tester\\AppData\\Local');
  assert.equal(env.OPENAI_API_KEY, 'test-key');
  assert.equal('DATABASE_URL' in env, false);
  assert.equal('APP_SECRET' in env, false);
});

test('Codex 模型与推理强度由后端权威默认并拒绝参数注入', () => {
  assert.equal(resolveCodexModel(undefined, { codexModel: 'gpt-old' }), 'gpt-old');
  assert.equal(resolveCodexModel('', { codexModel: 'gpt-old' }), 'gpt-5.6-terra');
  assert.equal(normalizeCodexModel(undefined), 'gpt-5.6-terra');
  assert.equal(normalizeOllamaModel(undefined), 'qwen3:8b');
  assert.equal(normalizeOllamaModel(''), 'qwen3:8b');
  assert.equal(normalizeCodexReasoningEffort(undefined), 'medium');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeCodexReasoningEffort(effort), effort);
  }
  for (const effort of ['none', 'minimal', 'ultra', 'invalid', '-c']) {
    assert.throws(
      () => normalizeCodexReasoningEffort(effort),
      (error) => error.statusCode === 400 && error.code === 'CODEX_REASONING_EFFORT_INVALID'
    );
  }
  assert.throws(
    () => buildCodexExecArgs({ model: '--dangerously-bypass-approvals-and-sandbox' }),
    (error) => error.code === 'CODEX_MODEL_INVALID'
  );
  assert.throws(
    () => buildCodexExecArgs({ reasoningEffort: 'medium -c model="evil"' }),
    (error) => error.code === 'CODEX_REASONING_EFFORT_INVALID'
  );
  for (const value of [['gpt-5.6-terra'], { model: 'gpt-5.6-terra' }]) {
    assert.throws(() => normalizeCodexModel(value), (error) => error.code === 'CODEX_MODEL_INVALID');
    assert.throws(() => buildCodexExecArgs({ model: value }), (error) => error.code === 'CODEX_MODEL_INVALID');
  }
  for (const value of [['qwen3:8b'], { model: 'qwen3:8b' }, '--remote']) {
    assert.throws(() => normalizeOllamaModel(value), (error) => error.code === 'OLLAMA_MODEL_INVALID');
  }
  for (const value of [['medium'], { effort: 'medium' }]) {
    assert.throws(
      () => normalizeCodexReasoningEffort(value),
      (error) => error.code === 'CODEX_REASONING_EFFORT_INVALID'
    );
  }
});

test('Codex 会话超时严格限制为 5..120 整数分钟并安全换算毫秒', () => {
  assert.equal(normalizeCodexTimeoutMinutes(undefined), 10);
  assert.equal(normalizeCodexTimeoutMinutes(null), 10);
  for (const minutes of [5, 10, 120]) {
    assert.equal(normalizeCodexTimeoutMinutes(minutes), minutes);
    assert.equal(codexTimeoutMinutesToMs(minutes), minutes * 60_000);
  }
  for (const value of [4, 121, 5.5, '', '10', true, false, [], [10], {}, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => normalizeCodexTimeoutMinutes(value),
      (error) => error.statusCode === 400 && error.code === 'CODEX_TIMEOUT_MINUTES_INVALID'
    );
  }
  assert.equal(formatCodexTimeoutDuration(5 * 60_000), '5 分钟');
  assert.equal(formatCodexTimeoutDuration(2_000), '2 秒');
  assert.equal(formatCodexTimeoutDuration(10), '10 毫秒');
  assert.throws(() => formatCodexTimeoutDuration(2_147_483_648), /安全计时范围/);

  for (const timeoutMinutes of [undefined, null, '10', 4, 121]) {
    const legacy = publicCodexSession({
      id: 'codexchat_0000000000000000', timeoutMinutes, messages: []
    });
    assert.equal(legacy.timeoutMinutes, null);
  }
  assert.equal(publicCodexSession({ timeoutMinutes: 5, messages: [] }).timeoutMinutes, 5);
});

test('非空章节拒绝没有可朗读片段的空剧本', () => {
  assert.throws(
    () => normalizeImportedScript({ chapterTitle: '第一章', roles: [], scenes: [], warnings: [] }, {
      title: '第一章', sourceText: '这里有正文。'
    }),
    (error) => error.code === 'SCRIPT_SCHEMA_INVALID' && error.statusCode === 400
  );
});
