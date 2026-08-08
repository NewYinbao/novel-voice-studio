import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexExecArgs,
  buildCodexFollowUpPrompt,
  chapterToScriptSnapshot,
  codexProcessEnv,
  normalizeImportedScript,
  parseCodexJsonl,
  resolveCodexModel
} from '../src/lib/script-engine.js';

test('Codex 初始会话使用 JSONL 和 Schema，且不使用 ephemeral', () => {
  const args = buildCodexExecArgs({ schemaPath: 'C:\\schemas\\script.json', model: 'gpt-test' });
  assert.deepEqual(args, [
    'exec', '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'hooks',
    '--model', 'gpt-test', '--output-schema', 'C:\\schemas\\script.json', '-'
  ]);
  assert.equal(args.includes('--ephemeral'), false);
});

test('Codex 续问使用指定 session ID 和同一个 Schema', () => {
  const args = buildCodexExecArgs({ schemaPath: 'schema.json', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
  assert.deepEqual(args, [
    'exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'hooks',
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
    (error) => error.code === 'CODEX_TURN_FAILED' && /会话已失效/.test(error.message)
  );
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

test('显式空模型会回到 Codex CLI 默认，不回退到旧设置', () => {
  assert.equal(resolveCodexModel(undefined, { codexModel: 'gpt-old' }), 'gpt-old');
  assert.equal(resolveCodexModel('', { codexModel: 'gpt-old' }), '');
});

test('非空章节拒绝没有可朗读片段的空剧本', () => {
  assert.throws(
    () => normalizeImportedScript({ chapterTitle: '第一章', roles: [], scenes: [], warnings: [] }, {
      title: '第一章', sourceText: '这里有正文。'
    }),
    (error) => error.code === 'SCRIPT_SCHEMA_INVALID' && error.statusCode === 400
  );
});
