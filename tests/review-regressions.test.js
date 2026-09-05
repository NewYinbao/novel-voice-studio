import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvs-review-'));
process.env.NVS_DATA_DIR = path.join(root, 'data');
const { initStore } = await import('../src/lib/store.js');
const { createServer } = await import('../src/server.js');
const { JobManager } = await import('../src/lib/jobs.js');
const { parseByteRange, mediaType } = await import('../src/lib/utils.js');
const { workerSpeakerSegments } = await import('../src/lib/voice-workshop.js');
test.after(() => fs.rm(root, { recursive: true, force: true }));

test('媒体 Range 正确支持末尾字节、开放范围和不可满足范围', () => {
  assert.deepEqual(parseByteRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-50', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseByteRange('bytes=4-50', 10), { start: 4, end: 9 });
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=5-3', 'bytes=0-1,4-5', 'bytes=9999999999999999999999-', 'items=1-2']) {
    assert.equal(parseByteRange(range, 10), null, range);
  }
  assert.equal(parseByteRange('bytes=0-', 0), null);
  assert.equal(mediaType('source.mp4'), 'video/mp4');
  assert.equal(mediaType('source.aac'), 'audio/aac');
  assert.equal(mediaType('source.mov'), 'video/quicktime');
});

test('媒体请求拒绝元数据和符号链接越界，工作台拒绝跨端口写入及 DNS 重绑定 Host', async (t) => {
  await initStore();
  const mediaRoot = path.join(process.env.NVS_DATA_DIR, 'voice-analyses');
  const dir = path.join(mediaRoot, 'voiceanalysis_aaaaaaaaaaaaaaaa');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.mp4'), Buffer.from('0123456789'));
  await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.wav'), Buffer.from('private'));
  await fs.symlink(outside, path.join(mediaRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = `${base}/media/voice-analyses/voiceanalysis_aaaaaaaaaaaaaaaa/source.mp4`;
  const suffix = await fetch(source, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-type'), 'video/mp4');
  assert.equal(suffix.headers.get('content-range'), 'bytes 6-9/10');
  assert.equal(await suffix.text(), '6789');
  const head = await fetch(source, { method: 'HEAD', headers: { Range: 'bytes=3-' } });
  assert.equal(head.headers.get('content-length'), '7');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(source, { headers: { Range: 'bytes=-' } })).status, 416);
  assert.equal((await fetch(`${base}/media/voice-analyses/voiceanalysis_aaaaaaaaaaaaaaaa/manifest.json`)).status, 403);
  assert.equal((await fetch(`${base}/media/voice-analyses/escape/private.wav`)).status, 403);
  assert.equal((await fetch(`${base}/media/voice-analyses/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/api/projects/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/health`, { headers: { Host: `attacker.example:${server.address().port}` } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(rebound, 403);
});

test('超过 100 个任务仍保留全部活动任务，持久化按序且不重复携带完整分析', async () => {
  const storage = path.join(root, 'jobs.json');
  const manager = new JobManager(storage);
  const releases = [];
  const active = manager.create('render', {}, () => new Promise((resolve) => releases.push(resolve)));
  const records = Array.from({ length: 110 }, () => manager.create('voice_analyze', {}, async () => ({ analysis: { id: 'result-id', text: 'large private transcript' } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(manager.list().some((job) => job.id === active.id));
  assert.equal(manager.list().length, 101);
  assert.equal(manager.get(records[0].id).result.analysis, undefined);
  assert.equal(manager.get(records[0].id).result.analysisId, 'result-id');
  const moreActive = Array.from({ length: 105 }, () => manager.create('render', {}, () => new Promise((resolve) => releases.push(resolve))));
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([manager.flush(), manager.flush()]);
  const stored = JSON.parse(await fs.readFile(storage, 'utf8'));
  assert.equal(stored.filter((job) => job.state === 'running').length, 106);
  assert.ok(stored.some((job) => job.id === moreActive.at(-1).id));
  releases.forEach((resolve) => resolve({ ok: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await manager.flush();
  assert.ok(JSON.parse(await fs.readFile(storage, 'utf8')).every((job) => job.state === 'completed'));
});

test('克隆排除的 ASR 整句仍保留可复核文本与音频，干净片段不重复', () => {
  const clean = { id: 'clean-1', source_segment_id: 'raw-1', text: '干净台词', start_ms: 0 };
  const excluded = { id: 'raw-2', text: '有重叠但不可丢失的台词', audio_path: 'raw-2.wav', start_ms: 3000, overlap: true };
  const segments = workerSpeakerSegments({ clean_segments: [clean], segments: [{ id: 'raw-1' }, excluded] });
  assert.equal(segments.length, 2);
  assert.equal(segments[1].text, excluded.text);
  assert.equal(segments[1].contains_overlap, true);
  assert.equal(segments[1].audio_path, 'raw-2.wav');
});

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function saveHarness() {
  const callbacks = new Map();
  let timer = 0;
  const requests = [];
  const line = { id: 'line', spokenText: '初稿' };
  const state = { project: { id: 'project', characters: [] }, saveTimers: new Map(), lineSaveErrors: new Map(), lineSaveQueues: new Map(), lineFailedDrafts: new Map() };
  const context = vm.createContext({ state, invalidateCodexProjectRefresh() {}, findLine: () => line,
    findLineInProject: (project) => project.line, toast() {},
    setTimeout: (callback) => { callbacks.set(++timer, callback); return timer; }, clearTimeout: (id) => callbacks.delete(id),
    api: (_url, options) => new Promise((resolve, reject) => requests.push({ patch: options.body, resolve, reject }))
  });
  vm.runInContext(app.slice(app.indexOf('function scheduleLineSave('), app.indexOf('function updateTransportForSelection(')), context);
  return { context, state, requests, line, fire: async () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((callback) => callback()); await new Promise((resolve) => setImmediate(resolve)); } };
}

test('同一句自动保存严格串行，旧响应不会覆盖新输入', async () => {
  const h = saveHarness();
  h.context.scheduleLineSave('line', { spokenText: '第一版' });
  await h.fire();
  h.context.scheduleLineSave('line', { spokenText: '第二版', pace: 1.2 });
  await h.fire();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ line: { spokenText: '第一版' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  assert.equal(h.line.spokenText, '第二版');
  h.requests[1].resolve({ line: { spokenText: '第二版', pace: 1.2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.saveTimers.size, 0);
  assert.equal(h.line.pace, 1.2);
});

test('保存失败保留整份修改，重试不同字段时也不会丢失先前台词', async () => {
  const h = saveHarness();
  h.context.scheduleLineSave('line', { spokenText: '不能丢的台词' });
  await h.fire();
  h.requests[0].reject(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.lineFailedDrafts.get('project:line').patch.spokenText, '不能丢的台词');
  h.context.scheduleLineSave('line', { pace: 0.9 });
  await h.fire();
  assert.equal(h.requests[1].patch.spokenText, '不能丢的台词');
  h.requests[1].resolve({ line: h.requests[1].patch });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.lineFailedDrafts.size, 0);
});
