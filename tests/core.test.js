import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-test-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { splitChapters, decodeBook } = await import('../src/lib/novel.js');
const { normalizeImportedScript, rulesToScript } = await import('../src/lib/script-engine.js');
const { recommendEngine, VOICE_SOURCES_DIR } = await import('../src/lib/config.js');
const { generateDemoWav, parsePcmWav, concatenateWavs } = await import('../src/lib/audio.js');
const { initStore } = await import('../src/lib/store.js');
const { JobManager } = await import('../src/lib/jobs.js');
const {
  claimVoiceSource, cleanupExpiredVoiceSources, deleteVoiceSource, saveVoiceSource, validateVoiceExtraction
} = await import('../src/lib/video-voice.js');
const { createServer } = await import('../src/server.js');

function makeStoredZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    nameBytes.copy(record, 46);
    central.push(record);
    offset += local.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await fetch(`${base}/api/jobs/${jobId}`).then((response) => response.json());
    if (['completed', 'failed'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待任务超时：${jobId}`);
}

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('按中文章节标题拆分小说', () => {
  const chapters = splitChapters('第一章 风起\n\n这是第一章。\n\n第二章 重逢\n\n这是第二章。');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章 风起');
  assert.match(chapters[1].sourceText, /第二章/);
  assert.match(chapters[1].sourceText, /这是第二章/);
});

test('章节号独占一行时不吞正文', () => {
  const chapters = splitChapters('第一章\n\n正文第一句。\n\n第二章\n\n正文第二句。');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].sourceText, '正文第一句。');
  assert.equal(chapters[1].sourceText, '正文第二句。');
});

test('无标题长文本按段落安全切块', () => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => `这是第${index}段。${'内容'.repeat(60)}`).join('\n\n');
  const chapters = splitChapters(paragraphs);
  assert.ok(chapters.length >= 2);
  assert.ok(chapters.every((chapter) => chapter.sourceText.length > 0));
});

test('规则剧本引擎区分旁白和对白并标注情绪', () => {
  const script = rulesToScript({ title: '测试章', sourceText: '夜色很深。林默怒声道：“你为什么骗我！”苏晚低声说：“对不起。”' });
  const lines = script.scenes.flatMap((scene) => scene.lines);
  assert.ok(lines.some((line) => line.kind === 'narration'));
  assert.ok(lines.some((line) => line.kind === 'dialogue'));
  assert.ok(lines.some((line) => line.emotion === 'angry'));
  assert.ok(script.roles.some((role) => role.name === '林默'));
});

test('16GB 显存 / 15.1GB 可见内存默认推荐 CosyVoice3', () => {
  const engine = recommendEngine({ gpu: { vramGb: 15.9 }, ramGb: 15.1 }, 'balanced');
  assert.equal(engine.id, 'cosyvoice3');
});

test('在线工作器只安装 Qwen 时自动路由到 Qwen3-TTS', () => {
  const engine = recommendEngine({
    gpu: { vramGb: 15.9 }, ramGb: 15.1,
    worker: { online: true, providers: { cosyvoice: false, qwen3_tts: true } }
  }, 'balanced');
  assert.equal(engine.id, 'qwen3-tts');
});

test('导入剧本的强度、语速与停顿会限制在安全范围', () => {
  const chapter = { title: '安全测试' };
  const script = normalizeImportedScript({
    roles: [{ name: '旁白', isNarrator: true }],
    scenes: [{ lines: [{ kind: 'narration', speaker: '旁白', spokenText: '测试', intensity: 99, pace: 0, pauseAfterMs: -100 }] }]
  }, chapter);
  const line = script.scenes[0].lines[0];
  assert.equal(line.intensity, 1);
  assert.equal(line.pace, 0.6);
  assert.equal(line.pauseAfterMs, 0);
});

test('演示音轨生成有效 16-bit PCM WAV 并可拼接', async () => {
  const first = generateDemoWav('第一句测试。', 'warm', 24000);
  const second = generateDemoWav('第二句测试。', 'joy', 24000);
  const parsed = parsePcmWav(first.buffer);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.bitsPerSample, 16);
  const firstPath = path.join(testRoot, 'first.wav');
  const secondPath = path.join(testRoot, 'second.wav');
  const outputPath = path.join(testRoot, 'joined.wav');
  await fs.writeFile(firstPath, first.buffer);
  await fs.writeFile(secondPath, second.buffer);
  const result = await concatenateWavs([
    { filePath: firstPath, pauseAfterMs: 300 }, { filePath: secondPath, pauseAfterMs: 0 }
  ], outputPath);
  assert.ok(result.durationMs > first.durationMs + second.durationMs);
  assert.ok((await fs.stat(outputPath)).size > first.buffer.length + second.buffer.length);
});

test('长音视频来源流式落盘并严格限制类型、大小、ID 与裁剪范围', async () => {
  await initStore();
  const source = await saveVoiceSource(Readable.from([Buffer.from('small-video-source')]), {
    fileName: '..\\片段.mp4', contentType: 'video/mp4', contentLength: 18, maxBytes: 1024
  });
  assert.match(source.id, /^voicesrc_[a-f0-9]{16}$/);
  assert.equal(source.kind, 'video');
  assert.equal(source.bytes, 18);
  assert.equal(path.extname(source.fileName), '.mp4');
  assert.doesNotMatch(source.fileName, /[\\/]/);
  const claimed = await claimVoiceSource(source.id);
  assert.ok(claimed.filePath.startsWith(path.resolve(VOICE_SOURCES_DIR)));
  await assert.rejects(() => claimVoiceSource(source.id), (error) => error.code === 'VOICE_SOURCE_CLAIMED' && error.statusCode === 409);
  await deleteVoiceSource(source.id, { allowClaimed: true });

  const before = await fs.readdir(VOICE_SOURCES_DIR);
  await assert.rejects(
    () => saveVoiceSource(Readable.from([Buffer.alloc(3), Buffer.alloc(2)]), {
      fileName: 'oversized.wav', contentType: 'audio/wav', maxBytes: 4
    }),
    (error) => error.code === 'VOICE_SOURCE_TOO_LARGE' && error.statusCode === 413
  );
  assert.deepEqual(await fs.readdir(VOICE_SOURCES_DIR), before);
  await assert.rejects(
    () => saveVoiceSource(Readable.from([Buffer.from('bad')]), { fileName: 'payload.exe', maxBytes: 1024 }),
    (error) => error.code === 'VOICE_SOURCE_TYPE_UNSUPPORTED'
  );
  await assert.rejects(() => claimVoiceSource('../voicesrc_0000000000000000'), (error) => error.statusCode === 400);
  assert.throws(() => validateVoiceExtraction({
    name: '角色', transcript: '台词', consent: true, startMs: 0, endMs: 2999
  }), /3–60 秒/);
  assert.equal(validateVoiceExtraction({
    name: '角色', transcript: '台词', consent: true, startMs: 0, endMs: 3000
  }).durationMs, 3000);
  assert.equal(validateVoiceExtraction({
    name: '角色', transcript: '台词', consent: true, startMs: 0, endMs: 60000
  }).durationMs, 60000);
  assert.throws(() => validateVoiceExtraction({
    name: '角色', transcript: '台词', consent: true, startMs: 0, endMs: 60001
  }), /3–60 秒/);
  assert.deepEqual(validateVoiceExtraction({
    name: '角色', tags: '沉稳, 青年', transcript: '准确台词', consent: true, startMs: 1000.2, endMs: 5000.4
  }), {
    name: '角色', tags: ['沉稳', '青年'], language: 'zh-CN', transcript: '准确台词', consent: true,
    startMs: 1000, endMs: 5000, durationMs: 4000
  });

  const expired = await saveVoiceSource(Readable.from([Buffer.from('temporary-audio')]), {
    fileName: 'temporary.wav', contentType: 'audio/wav', maxBytes: 1024
  });
  await cleanupExpiredVoiceSources(Date.now() + 25 * 60 * 60 * 1000);
  await assert.rejects(() => fs.stat(path.join(VOICE_SOURCES_DIR, expired.id)), { code: 'ENOENT' });
});

test('音视频裁剪任务在独立媒体队列中串行执行', async () => {
  const manager = new JobManager();
  const events = [];
  const first = manager.create('voice_extract', {}, async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push('first:end');
  }, { media: true });
  const second = manager.create('voice_extract', {}, async () => {
    events.push('second:start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push('second:end');
  }, { media: true });
  for (let attempt = 0; attempt < 100 && manager.get(second.id).state !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manager.get(first.id).state, 'completed');
  assert.equal(manager.get(second.id).state, 'completed');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('音色来源 claim 与删除通过原子重命名竞争，已 claim 的来源不会被删', async () => {
  for (let index = 0; index < 5; index += 1) {
    const source = await saveVoiceSource(Readable.from([Buffer.from(`race-${index}`)]), {
      fileName: `race-${index}.wav`, contentType: 'audio/wav', maxBytes: 1024
    });
    const [claimResult, deleteResult] = await Promise.allSettled([
      claimVoiceSource(source.id), deleteVoiceSource(source.id)
    ]);
    assert.equal([claimResult, deleteResult].filter((result) => result.status === 'fulfilled').length, 1);
    if (claimResult.status === 'fulfilled') {
      assert.equal(deleteResult.status, 'rejected');
      assert.equal(deleteResult.reason.code, 'VOICE_SOURCE_CLAIMED');
      await deleteVoiceSource(source.id, { allowClaimed: true, missingOk: true });
    } else {
      assert.equal(deleteResult.status, 'fulfilled');
      assert.equal(claimResult.reason.code, 'VOICE_SOURCE_NOT_FOUND');
    }
  }
});

test('UTF-8 与 GB18030 文本可解码', () => {
  const utf8 = decodeBook(Buffer.from('中文小说', 'utf8'), 'novel.txt');
  assert.equal(utf8, '中文小说');
  const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBook(gb, 'novel.txt'), '中文');
  assert.equal(decodeBook(Buffer.from('（开场）正文', 'utf8'), 'novel.txt'), '（开场）正文');
});

test('标准 EPUB container/OPF/spine 可提取正文', () => {
  const epub = makeStoredZip({
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/content.opf': '<?xml version="1.0"?><package><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    'OPS/chapter1.xhtml': '<html><body><h1>第一章 风起</h1><p>这是 EPUB 中的中文正文。</p></body></html>'
  });
  const text = decodeBook(epub, 'sample.epub');
  assert.match(text, /第一章 风起/);
  assert.match(text, /中文正文/);
});

test('HTTP API 可创建并读取项目', async (t) => {
  await initStore();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '接口测试小说',
      fileName: 'test.txt',
      contentBase64: Buffer.from('第一章 开始\n\n正文内容。').toString('base64')
    })
  }).then((response) => response.json());
  assert.equal(created.title, '接口测试小说');
  assert.equal(created.chapters.length, 1);
  const loaded = await fetch(`${base}/api/projects/${created.id}`).then((response) => response.json());
  assert.equal(loaded.id, created.id);

  const scriptSubmission = await fetch(`${base}/api/projects/${created.id}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'rules' })
  }).then((response) => response.json());
  const scriptJob = await waitForJob(base, scriptSubmission.id);
  assert.equal(scriptJob.state, 'completed');

  const renderSubmission = await fetch(`${base}/api/projects/${created.id}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then((response) => response.json());
  const renderJob = await waitForJob(base, renderSubmission.id);
  assert.equal(renderJob.state, 'failed');
  assert.match(renderJob.error.message, /所有 .* 个片段均生成失败/);

  const traversal = await fetch(`${base}/api/projects/x%5C..%5C${created.id}`);
  assert.equal(traversal.status, 400);
});

test('Codex 协作室持久化同一 session，并把手工修改带入下一轮', async (t) => {
  await initStore();
  const calls = [];
  let signalConflictStarted;
  let releaseConflictTurn;
  const conflictStarted = new Promise((resolve) => { signalConflictStarted = resolve; });
  const conflictGate = new Promise((resolve) => { releaseConflictTurn = resolve; });
  const makeScript = (spokenText, pace = 1) => ({
    chapterTitle: '会话测试章',
    roles: [{ name: '旁白', aliases: [], description: '叙述者', isNarrator: true }],
    scenes: [{
      id: `scene_${calls.length}`,
      title: '场景 1', context: '',
      lines: [{
        id: `line_${calls.length}`, kind: 'narration', speaker: '旁白', sourceText: '原文。', spokenText,
        emotion: 'neutral', emotionNote: '', intensity: 0.5, pace, pauseAfterMs: 350,
        confidence: 1, needsReview: false, render: { status: 'idle' }
      }]
    }],
    warnings: []
  });
  const codexRunner = async (input) => {
    calls.push(input);
    if (!input.sessionId) return {
      threadId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      script: makeScript('第一版台词。'), usage: { input_tokens: 10, output_tokens: 20 }
    };
    if (input.prompt === '模拟慢请求。') {
      signalConflictStarted();
      await conflictGate;
      return {
        threadId: input.sessionId,
        script: makeScript('这份旧结果不应覆盖手工稿。'), usage: { input_tokens: 30, output_tokens: 40 }
      };
    }
    const currentLine = input.chapter.scenes[0].lines[0];
    assert.equal(currentLine.spokenText, '用户手工修改的台词。');
    assert.equal(currentLine.pace, 0.85);
    return {
      threadId: input.sessionId,
      script: makeScript('Codex 根据手工稿继续精修。', 0.9), usage: { input_tokens: 12, output_tokens: 18 }
    };
  };
  const server = createServer({
    codexRunner,
    codexSettingsResolver: async (settings) => ({ ...settings, codexCommand: 'fake-codex' })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Codex 会话测试', sourceText: '第一章\n\n原文。' })
  }).then((response) => response.json());
  const chapterId = project.chapters[0].id;

  const firstResponse = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'faithful', model: 'gpt-5.6-terra', prompt: '保持克制。' })
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.match(first.session.id, /^codexchat_[a-f0-9]{16}$/);
  assert.equal(first.session.turnCount, 1);
  assert.equal(first.session.model, 'gpt-5.6-terra');
  const lineId = first.project.chapters[0].scenes[0].lines[0].id;

  const manualResponse = await fetch(`${base}/api/projects/${project.id}/lines/${lineId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spokenText: '用户手工修改的台词。', pace: 0.85 })
  });
  assert.equal(manualResponse.status, 200);

  const followResponse = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions/${first.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '', prompt: '在手工稿基础上再自然一点。' })
  });
  assert.equal(followResponse.status, 200);
  const follow = await followResponse.json();
  assert.equal(follow.session.id, first.session.id);
  assert.equal(follow.session.turnCount, 2);
  assert.equal(follow.session.model, '');
  assert.equal(follow.session.messages.at(-2).content, '在手工稿基础上再自然一点。');
  assert.equal(follow.project.chapters[0].scenes[0].lines[0].spokenText, 'Codex 根据手工稿继续精修。');
  assert.equal(calls[1].sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(calls[1].model, '');
  assert.equal('codexThreadId' in first.project.chapters[0].codexSessions[0], false);
  assert.equal('codexThreadId' in follow.project.chapters[0].codexSessions[0], false);

  const sessions = await fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions`).then((response) => response.json());
  assert.equal(sessions.activeSessionId, first.session.id);
  assert.equal(sessions.sessions.length, 1);
  assert.equal('codexThreadId' in sessions.sessions[0], false);

  const conflictRequest = fetch(`${base}/api/projects/${project.id}/chapters/${chapterId}/codex-sessions/${first.session.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '', prompt: '模拟慢请求。' })
  });
  await conflictStarted;
  const latestLineId = follow.project.chapters[0].scenes[0].lines[0].id;
  const editDuringRun = await fetch(`${base}/api/projects/${project.id}/lines/${latestLineId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spokenText: '处理期间的新手工稿。' })
  });
  assert.equal(editDuringRun.status, 200);
  releaseConflictTurn();
  const conflictResponse = await conflictRequest;
  assert.equal(conflictResponse.status, 409);
  const conflict = await conflictResponse.json();
  assert.equal(conflict.error, 'CODEX_CHAPTER_CHANGED');
  const afterConflict = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(afterConflict.chapters[0].scenes[0].lines[0].spokenText, '处理期间的新手工稿。');
  assert.equal('codexThreadId' in afterConflict.chapters[0].codexSessions[0], false);
});

test('HTTP API 流式上传来源并通过 worker Job 创建裁剪音色，失败时清理临时文件', async (t) => {
  await initStore();
  let failExtraction = false;
  const worker = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true, platform: process.platform === 'win32' ? 'Windows test worker' : `${process.platform} test worker`,
        ffmpeg: true, ffprobe: true, loaded_engine: null, providers: { cosyvoice: false, qwen3_tts: true }
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/audio/extract') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (failExtraction) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: { code: 'EXTRACT_FAILED', message: '模拟裁剪失败' } }));
        return;
      }
      assert.equal('sample_rate' in body, false);
      assert.equal(body.start_seconds, 1);
      assert.equal(body.end_seconds, 5);
      await fs.stat(body.source_path);
      await fs.mkdir(path.dirname(body.output_path), { recursive: true });
      const wav = generateDemoWav('模拟裁剪音色。'.repeat(3), 'neutral', 24000);
      await fs.writeFile(body.output_path, wav.buffer);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ duration_seconds: wav.durationMs / 1000, sample_rate: 24000, channels: 1, bytes: wav.buffer.length }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: 'not found' }));
  });
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const workerBase = `http://127.0.0.1:${worker.address().port}`;

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settingsResponse = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerUrl: workerBase })
  });
  assert.equal(settingsResponse.status, 200);

  const upload = await fetch(`${base}/api/voice-sources?fileName=${encodeURIComponent('授权片段.mp4')}`, {
    method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('mock-video')
  });
  assert.equal(upload.status, 201);
  const source = await upload.json();
  assert.equal(source.kind, 'video');
  const submission = await fetch(`${base}/api/voice-sources/${source.id}/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: '视频角色音色', tags: ['视频'], transcript: '模拟裁剪音色。', consent: true, startMs: 1000, endMs: 5000
    })
  });
  assert.equal(submission.status, 202);
  const job = await waitForJob(base, (await submission.json()).id);
  assert.equal(job.state, 'completed');
  assert.equal(job.result.voice.kind, 'video-extract');
  assert.equal(job.result.voice.reference.source.originalFileName, '授权片段.mp4');
  assert.equal(job.result.voice.reference.source.startMs, 1000);
  assert.equal(job.result.voice.reference.source.endMs, 5000);
  assert.equal(job.result.voice.reference.sampleRate, 24000);
  await assert.rejects(() => fs.stat(path.join(VOICE_SOURCES_DIR, source.id)), { code: 'ENOENT' });
  const voices = await fetch(`${base}/api/voices`).then((response) => response.json());
  assert.ok(voices.some((voice) => voice.id === job.result.voiceId));

  const failedUpload = await fetch(`${base}/api/voice-sources?fileName=${encodeURIComponent('长录音.wav')}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('mock-audio')
  }).then((response) => response.json());
  failExtraction = true;
  const failedSubmission = await fetch(`${base}/api/voice-sources/${failedUpload.id}/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: '失败音色', transcript: '失败测试。', consent: true, startMs: 0, endMs: 4000
    })
  });
  assert.equal(failedSubmission.status, 202);
  const failedJob = await waitForJob(base, (await failedSubmission.json()).id);
  assert.equal(failedJob.state, 'failed');
  assert.equal(failedJob.error.code, 'EXTRACT_FAILED');
  assert.match(failedJob.error.message, /模拟裁剪失败/);
  await assert.rejects(() => fs.stat(path.join(VOICE_SOURCES_DIR, failedUpload.id)), { code: 'ENOENT' });
});
