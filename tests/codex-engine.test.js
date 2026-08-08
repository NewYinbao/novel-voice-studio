import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  runCodexSession
} from '../src/lib/script-engine.js';
import {
  codexTimeoutMinutesToMs,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeCodexTimeoutMinutes
} from '../src/lib/codex-options.js';
import { publicCodexSession } from '../src/lib/codex-sessions.js';

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
