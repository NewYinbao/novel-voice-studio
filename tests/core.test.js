import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-studio-test-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const { splitChapters, decodeBook } = await import('../src/lib/novel.js');
const { normalizeImportedScript, rulesToScript } = await import('../src/lib/script-engine.js');
const { recommendEngine } = await import('../src/lib/config.js');
const { generateDemoWav, parsePcmWav, concatenateWavs } = await import('../src/lib/audio.js');
const { initStore } = await import('../src/lib/store.js');
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
