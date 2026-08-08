import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_HIDDEN_SUMMARY,
  createCodexRedactionContext,
  normalizeCodexDetailLevel,
  sanitizeCodexActivitySummary
} from '../src/lib/codex-activity.js';
import {
  createCodexJsonlProgressParser,
  mapCodexJsonlActivity
} from '../src/lib/script-engine.js';

test('Codex detailLevel 仅接受 basic/summary 且默认关闭摘要', () => {
  assert.equal(normalizeCodexDetailLevel(undefined), 'basic');
  assert.equal(normalizeCodexDetailLevel('basic'), 'basic');
  assert.equal(normalizeCodexDetailLevel('summary'), 'summary');
  assert.throws(
    () => normalizeCodexDetailLevel('verbose'),
    (error) => error.statusCode === 400 && error.code === 'CODEX_DETAIL_LEVEL_INVALID'
  );
  for (const value of [['summary'], { detailLevel: 'summary' }]) {
    assert.throws(
      () => normalizeCodexDetailLevel(value),
      (error) => error.statusCode === 400 && error.code === 'CODEX_DETAIL_LEVEL_INVALID'
    );
  }
});

test('reasoning 摘要严格拦截原文、prompt、凭据、URL、路径、代码与剧本 JSON', () => {
  const source = '月光穿过寂静的长廊照在她苍白的脸上。';
  const prompt = '把冲突写得更加克制但保留人物关系。';
  const context = createCodexRedactionContext([source, prompt]);
  assert.equal(
    sanitizeCodexActivitySummary('正在梳理叙事节奏和人物动机。', { redactionContext: context }),
    '正在梳理叙事节奏和人物动机。'
  );

  const shortContext = createCodexRedactionContext(['改甜一点', '她推开门看见月亮']);
  assert.equal(
    sanitizeCodexActivitySummary('用户要求改甜一点', { redactionContext: shortContext }),
    CODEX_HIDDEN_SUMMARY
  );
  assert.equal(
    sanitizeCodexActivitySummary('正在分析她推开门看见月亮的情节', { redactionContext: shortContext }),
    CODEX_HIDDEN_SUMMARY
  );

  const suspicious = [
    '月 光\u200b穿 过 寂 静 的 长 廊 照 在 她 苍 白 的 脸 上',
    prompt,
    'Bearer top-secret-token',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.abcdefghijklmnop',
    'https://auth.openai.com/oauth/authorize?secret=yes',
    'wss://example.test/private',
    'file:///C:/private/token.txt',
    'blob:https://example.test/id',
    'custom+secret://host/value',
    '登录域名 auth.openai.com',
    'mailto:user@example.invalid',
    '127.0.0.1:3000/private',
    String.raw`C:\private\schema.json`,
    `C\u034F:\\private\\token.txt`,
    'C:/private/schema.json',
    String.raw`\\server\share\secret.txt`,
    String.raw`\\?\C:\private\secret.txt`,
    String.raw`\\wsl$\Ubuntu\home\secret`,
    '//server/share/secret.txt',
    '/home/user/private/secret.txt',
    '/etc',
    '~/private/secret.txt',
    '%USERPROFILE%/private/token.txt',
    '%userprofile%/private/token.txt',
    '$env:APPDATA/private/token.txt',
    '${HOME}/private/token.txt',
    'src/lib/private/secret.js',
    'src/server.js',
    '项目/秘密.txt',
    '/用户/秘密.txt',
    'bash -lc "print secret"',
    'cmd /c type secret.txt',
    'git status --short',
    'npm test -- --runInBand',
    'cargo test --release',
    'Get-ChildItem -Force',
    'mcp__secret__danger_tool',
    'web.run',
    'collaboration.send_message',
    'functions.shell_command',
    `B\u034Fearer top-secret-token`,
    `sk\u034F-abcdefghijklmnop`,
    `B\u115Fearer top-secret-token`,
    `sk\u17B4-abcdefghijklmnop`,
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    '```json\n{"roles":[],"scenes":[]}\n```',
    '<current-chapter-script>private prompt</current-chapter-script>',
    '<script>alert(1)</script>',
    '{"sourceText":"小说原文","spokenText":"台词"}'
  ];
  for (const value of suspicious) {
    assert.equal(
      sanitizeCodexActivitySummary(value, { redactionContext: context }),
      CODEX_HIDDEN_SUMMARY,
      value
    );
  }

  const controlled = sanitizeCodexActivitySummary('\u001b[31m分析人物\u202E关系\r\n并整理节奏。', {
    redactionContext: context
  });
  assert.doesNotMatch(controlled, /[\u001b\u202E\r\n]/u);
  assert.equal(sanitizeCodexActivitySummary('x'.repeat(1024 * 1024)), CODEX_HIDDEN_SUMMARY);
  const interleavedSource = '风吹过长街她独自推开旧门看见远处月光';
  const interleavedEcho = Array.from(interleavedSource).map((point, index) => (
    index > 0 && index % 6 === 0 ? `\u115F${point}` : point
  )).join('');
  assert.equal(
    sanitizeCodexActivitySummary(`正在复述${interleavedEcho}的情节`, {
      redactionContext: createCodexRedactionContext([interleavedSource])
    }),
    CODEX_HIDDEN_SUMMARY
  );
  assert.equal(
    sanitizeCodexActivitySummary('普通摘要', {
      redactionContext: createCodexRedactionContext(Array.from({ length: 8_193 }, () => 'a'))
    }),
    CODEX_HIDDEN_SUMMARY
  );
});

test('summary JSONL 只投影安全 reasoning 与固定工具活动，并去重 item.updated', () => {
  const received = [];
  const context = createCodexRedactionContext(['绝不能回显的小说原文和编辑提示']);
  const parser = createCodexJsonlProgressParser((event) => received.push(event), {
    detailLevel: 'summary',
    redactionContext: context
  });
  const finalJson = '{"roles":[{"name":"秘密角色"}],"scenes":[{"lines":[]}]}';
  const lines = [
    { type: 'item.updated', item: { id: 'reasoning-1', type: 'reasoning', text: '正在梳理人物关系与叙事节奏。' } },
    { type: 'item.updated', item: { id: 'reasoning-1', type: 'reasoning', text: '同一项目的第二段内容不应再发。' } },
    { type: 'item.completed', item: { id: 'agent-1', type: 'agent_message', text: finalJson } },
    {
      type: 'item.completed',
      item: { id: 'tool-1', type: 'command_execution', command: 'C:\\private\\tool.exe --token raw', output: 'RAW NOVEL' }
    },
    {
      type: 'item.completed',
      item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'secret-server', tool: 'secret-tool', args: { prompt: 'RAW' } }
    },
    { type: 'turn.completed', usage: { input_tokens: 999 } }
  ];
  const payload = Buffer.from(`${lines.map(JSON.stringify).join('\n')}\n`, 'utf8');
  for (let offset = 0; offset < payload.length; offset += 5) parser.push(payload.subarray(offset, offset + 5));
  parser.end();

  const activities = received.filter((event) => event.type === 'activity');
  assert.deepEqual(activities, [
    {
      type: 'activity', phase: 'reasoning_summary', category: 'reasoning_summary',
      text: '正在梳理人物关系与叙事节奏。'
    },
    { type: 'activity', phase: 'activity', category: 'command' },
    { type: 'activity', phase: 'activity', category: 'mcp' }
  ]);
  assert.doesNotMatch(JSON.stringify(received), /秘密角色|private|--token|RAW NOVEL|secret-server|input_tokens|999/i);

  assert.equal(mapCodexJsonlActivity(lines[0]), null);
  assert.equal(mapCodexJsonlActivity(lines[2], { detailLevel: 'summary' }), null);
});

test('basic 模式无 activity，JSONL 洪泛仍有严格解析与事件上限', () => {
  const basic = [];
  const basicParser = createCodexJsonlProgressParser((event) => basic.push(event));
  basicParser.push(`${JSON.stringify({
    type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: '安全摘要' }
  })}\n`);
  basicParser.end();
  assert.deepEqual(basic, [{ type: 'stage', phase: 'analyzing' }]);

  const flooded = [];
  const floodParser = createCodexJsonlProgressParser((event) => flooded.push(event), {
    detailLevel: 'summary', maxParsedLines: 64, maxEvents: 32, maxActivityEvents: 24
  });
  const lines = [];
  for (let index = 0; index < 10_000; index += 1) {
    lines.push(JSON.stringify({
      type: 'item.updated', item: { id: `r-${index}`, type: 'reasoning', text: `安全摘要编号 ${index}` }
    }));
  }
  floodParser.push(`${lines.join('\n')}\n`);
  floodParser.end();
  assert.ok(flooded.length <= 25);

  const classifier = createCodexJsonlProgressParser(undefined);
  classifier.push(`${JSON.stringify({ arbitrary: 'json is not an official event' })}\n`);
  assert.equal(classifier.hasValidEvent(), false);
  classifier.push(`${JSON.stringify({ type: 'turn.started', prompt: 'private' })}\n`);
  assert.equal(classifier.hasValidEvent(), true);
  classifier.end();
});
