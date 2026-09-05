import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvs-analysis-sessions-'));
process.env.NVS_DATA_DIR = root;
const { createServer } = await import('../src/server.js');
const { MAX_VOICE_ANALYSIS_SPEAKERS } = await import('../src/lib/config.js');
const { wavBufferFromPcm } = await import('../src/lib/audio.js');
const { initStore } = await import('../src/lib/store.js');
test.after(() => fs.rm(root, { recursive: true, force: true }));

test('历史 Session 跨服务实例持久保存原音频、片段、新对话人与归属，互不覆盖', async (t) => {
  await initStore();
  const ids = ['voiceanalysis_1111111111111111', 'voiceanalysis_2222222222222222'];
  const audio = wavBufferFromPcm(Buffer.alloc(24000 * 2), 24000, 1);
  for (const [index, id] of ids.entries()) {
    const directory = path.join(root, 'voice-analyses', id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'source.wav'), audio);
    await fs.writeFile(path.join(directory, 'segment.wav'), audio);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      id, name: `访谈 ${index + 1}`, status: 'ready', version: 1, revision: 1, language: 'zh', durationMs: 1000,
      createdAt: `2026-09-0${index + 1}T00:00:00Z`, updatedAt: `2026-09-0${index + 1}T00:00:00Z`,
      source: { fileName: 'source.wav', storedFileName: 'source.wav', kind: 'audio', bytes: audio.length, mediaUrl: `/media/voice-analyses/${id}/source.wav` },
      capabilities: {}, warnings: [], overlaps: [], speakers: [{ id: 'speaker_a', label: '对话人 A', segments: [{
        id: 'segment_a', speakerId: 'speaker_a', text: '初始台词', emotion: 'neutral', keep: true, startMs: 0, endMs: 1000, durationMs: 1000,
        audioFile: 'segment.wav', mediaUrl: `/media/voice-analyses/${id}/segment.wav`
      }] }]
    }));
  }
  const serve = async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await serve();
  const endpoint = `${base}/api/voice-analyses/${ids[0]}`;
  const post = (body) => fetch(`${endpoint}/speakers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const invalid of [{}, { label: ' ' }, { label: 1 }, { label: 'x'.repeat(81) }, { label: '访客', id: 'speaker_a' }]) {
    assert.equal((await post(invalid)).status, 400);
  }
  const concurrent = await Promise.all([post({ label: '主持人' }), post({ label: '主持人' })]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
  const added = await concurrent.find((response) => response.status === 201).json();
  assert.match(added.speaker.id, /^speaker_[a-f0-9]{16}$/);
  assert.equal(added.analysis.speakers[1].segments.length, 0);
  assert.equal((await fetch(`${base}/api/voice-analyses/${ids[1]}/segments/segment_a`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerId: added.speaker.id })
  })).status, 404, '不能把另一个 Session 的对话人分配过来');
  const edited = await fetch(`${endpoint}/segments/segment_a`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speakerId: added.speaker.id, text: '校对后的台词', emotion: 'warm', keep: true })
  }).then((response) => response.json());
  assert.equal(edited.analysis.speakers[0].segments.length, 0);
  assert.equal(edited.analysis.speakers[1].segments[0].text, '校对后的台词');

  // A fresh server reads the same manifest, not any previous instance's memory.
  const reopenedBase = await serve();
  const history = await fetch(`${reopenedBase}/api/voice-analyses`).then((response) => response.json());
  assert.equal(history.length, 2);
  assert.equal(history.find((item) => item.id === ids[0]).speakerCount, 2);
  assert.equal(history.find((item) => item.id === ids[0]).segmentCount, 1);
  const reopened = await fetch(`${reopenedBase}/api/voice-analyses/${ids[0]}`).then((response) => response.json());
  assert.equal(reopened.speakers[1].label, '主持人');
  assert.equal(reopened.speakers[1].segments[0].emotion, 'warm');
  const untouched = await fetch(`${reopenedBase}/api/voice-analyses/${ids[1]}`).then((response) => response.json());
  assert.equal(untouched.speakers.length, 1);
  assert.equal(untouched.speakers[0].segments[0].text, '初始台词');
  for (const url of [reopened.source.mediaUrl, reopened.speakers[1].segments[0].mediaUrl]) {
    const response = await fetch(`${reopenedBase}${url}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
    const ranged = await fetch(`${reopenedBase}${url}`, { headers: { Range: 'bytes=0-43' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 44);
  }
  for (let n = 2; n < MAX_VOICE_ANALYSIS_SPEAKERS; n += 1) assert.equal((await post({ label: `访客 ${n}` })).status, 201);
  assert.equal((await post({ label: '超出人数' })).status, 409);
});

const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function sessionHarness(api) {
  const context = vm.createContext({ api, state: {
    voiceAnalysisRequestId: 0, voiceAnalysisCache: new Map(), voiceAnalysisDrafts: new Map(),
    voiceAnalysisId: null, voiceAnalysisJobId: null, bootstrap: { voiceAnalyses: [], jobs: [] }
  } });
  vm.runInContext(appSource.slice(appSource.indexOf('async function loadVoiceAnalysis('), appSource.indexOf('function voiceDesignId(')), context);
  return context;
}
function result(id, revision = 1) { return { id, revision, speakers: [], overlaps: [] }; }

test('快速切换只接受最后一次 Session 请求，旧保存回包不污染当前会话', async () => {
  const requests = new Map();
  const context = sessionHarness((url) => new Promise((resolve) => requests.set(url.split('/').at(-1), resolve)));
  const first = context.loadVoiceAnalysis('first');
  const second = context.loadVoiceAnalysis('second');
  requests.get('second')(result('second'));
  await second;
  requests.get('first')(result('first'));
  assert.equal(await first, null);
  assert.equal(context.state.voiceAnalysisId, 'second');
  context.rememberVoiceAnalysis(result('first', 3));
  assert.equal(context.state.voiceAnalysis.id, 'second');
  context.rememberVoiceAnalysis(result('second', 3));
  context.rememberVoiceAnalysis(result('second', 2));
  assert.equal(context.state.voiceAnalysis.revision, 3);
  context.analysisDraft('first').segments.set('same-id', { text: '甲会话未保存' });
  assert.equal(context.analysisDraft('second').segments.size, 0);
  assert.equal(context.analysisDraft('first').segments.get('same-id').text, '甲会话未保存');
});

test('离开页面后失效的请求不能重新激活旧 Session；完成任务可恢复到结果', async () => {
  let resolve;
  const context = sessionHarness(() => new Promise((done) => { resolve = done; }));
  const pending = context.loadVoiceAnalysis('old');
  context.state.voiceAnalysisRequestId += 1;
  resolve(result('old'));
  assert.equal(await pending, null);
  assert.equal(context.state.voiceAnalysisId, null);
  context.state.bootstrap.jobs = [{ id: 'job_ready', type: 'voice_analyze', result: { analysisId: 'ready' } }];
  context.api = async () => result('ready');
  await context.loadVoiceAnalysis('job_ready');
  assert.equal(context.state.voiceAnalysisId, 'ready');
});

test('后台拆分完成只更新历史，不抢占旧 Session；结果加载途中切换也不会跳回', async () => {
  const job = { id: 'job_background', type: 'voice_analyze', state: 'completed', result: { analysisId: 'new-result' } };
  let finishResult;
  const requested = [];
  const context = sessionHarness(async (url) => {
    requested.push(url);
    if (url === '/api/jobs') return [job];
    return new Promise((resolve) => { finishResult = resolve; });
  });
  Object.assign(context, {
    renderJobs() {}, refreshBootstrap: async () => {}, renderView() {}, renderVoiceAnalysisStudio() {},
    toast() {}, jobCompletionNotice: () => ({}), clearInterval() {}
  });
  Object.assign(context.state, { view: 'voice-analysis', watchedJobs: new Set([job.id]), notifiedJobs: new Set() });
  context.state.voiceAnalysisId = 'old';
  context.state.voiceAnalysis = result('old');
  vm.runInContext(appSource.slice(appSource.indexOf('async function pollJobs('), appSource.indexOf('function openJobs(')), context);
  await context.pollJobs();
  assert.equal(context.state.voiceAnalysisId, 'old');
  assert.deepEqual(requested, ['/api/jobs']);
  context.state.voiceAnalysisId = null;
  context.state.voiceAnalysisJobId = job.id;
  const polling = context.pollJobs();
  await new Promise((resolve) => setImmediate(resolve));
  // The user begins a new selection while the completed result is still loading.
  context.state.voiceAnalysisRequestId += 1;
  context.state.voiceAnalysisId = 'old';
  context.state.voiceAnalysisJobId = null;
  finishResult(result('new-result'));
  await polling;
  assert.equal(context.state.voiceAnalysisId, 'old');
  assert.equal(context.state.voiceAnalysis.id, 'old');
  assert.ok(context.state.bootstrap.voiceAnalyses.some((item) => item.id === 'new-result'));
});
