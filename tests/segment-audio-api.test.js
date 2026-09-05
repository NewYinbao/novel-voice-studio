import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvs-audio-edit-'));
process.env.NVS_DATA_DIR = root;
const { createServer } = await import('../src/server.js');
const { initStore } = await import('../src/lib/store.js');
const { wavBufferFromPcm } = await import('../src/lib/audio.js');
const { segmentWaveform } = await import('../src/lib/segment-audio.js');
const { exportSpeakerVoice, cleanVoiceAnalysisSilence } = await import('../src/lib/voice-workshop.js');
test.after(() => fs.rm(root, { recursive: true, force: true }));

test('波形、裁剪、恢复与去静音持久化隔离；原文件不变；克隆只使用核对后的有效声音', async (t) => {
  await initStore();
  const analysisId = 'voiceanalysis_1111111111111111';
  const secondId = 'voiceanalysis_2222222222222222';
  const pcm = Buffer.alloc(8 * 24000 * 2);
  for (let frame = 0; frame < 8 * 24000; frame += 1) {
    if ((frame >= 24000 && frame < 3 * 24000) || (frame >= 5 * 24000 && frame < 7 * 24000)) pcm.writeInt16LE(Math.round(Math.sin(frame * Math.PI * 440 / 24000) * 7000), frame * 2);
  }
  const original = wavBufferFromPcm(pcm);
  for (const id of [analysisId, secondId]) {
    const directory = path.join(root, 'voice-analyses', id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'segment.wav'), original);
    await fs.writeFile(path.join(directory, 'silent.wav'), wavBufferFromPcm(Buffer.alloc(24000 * 2)));
    const segment = { id: 'segment_a', speakerId: 'speaker_a', text: '甲说话。', keep: true, startMs: 10000, endMs: 18000, durationMs: 8000, audioFile: 'segment.wav', mediaUrl: `/media/voice-analyses/${id}/segment.wav` };
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ id, revision: 1, source: { fileName: 'original.wav' }, speakers: [{ id: 'speaker_a', label: '甲', segments: [segment, { ...segment, id: 'silent', audioFile: 'silent.wav', durationMs: 1000, text: '' }] }], overlaps: [] }));
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/voice-analyses/${analysisId}`;
  const edit = (body) => fetch(`${endpoint}/segments/segment_a/audio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const waveform = await fetch(`${endpoint}/segments/segment_a/waveform`).then((response) => response.json());
  assert.equal(waveform.durationMs, 8000);
  assert.equal(waveform.peaks.length, 640);
  assert.equal(waveform.audioRevision, 0);
  const manifestPath = path.join(root, 'voice-analyses', analysisId, 'manifest.json');
  const before = await fs.readFile(manifestPath, 'utf8');
  for (const body of [ { action: 'trim', audioRevision: 0, startMs: -1, endMs: 1000 }, { action: 'trim', audioRevision: 0, startMs: 0, endMs: 9000 }, { action: 'trim', audioRevision: 0, startMs: 0, endMs: 500 }, { action: 'silence', audioRevision: 0, path: 'evil' } ]) assert.equal((await edit(body)).status, 400);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), before);
  const outside = path.join(root, 'outside-edits');
  const editsDirectory = path.join(root, 'voice-analyses', analysisId, 'edits');
  await fs.mkdir(outside);
  await fs.symlink(outside, editsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal((await edit({ action: 'trim', audioRevision: 0, startMs: 1000, endMs: 3000 })).status, 502);
    assert.deepEqual(await fs.readdir(outside), [], '必须在写入前拒绝越界的编辑目录');
    assert.equal(await fs.readFile(manifestPath, 'utf8'), before);
  } finally {
    await fs.unlink(editsDirectory);
  }
  const trimmed = await edit({ action: 'trim', audioRevision: 0, startMs: 1000, endMs: 3000 }).then((response) => response.json());
  assert.equal(trimmed.segment.durationMs, 2000);
  assert.equal(trimmed.segment.startMs, 10000, '原录音定位不受处理后时长影响');
  assert.equal(trimmed.segment.needsTranscriptReview, true);
  assert.equal(trimmed.segment.canRestoreAudio, true);
  assert.equal((await edit({ action: 'silence', audioRevision: 0 })).status, 409);
  const exportInput = { name: '裁剪测试', tags: [], language: 'zh', includeOverlap: false, segmentIds: ['segment_a'], consent: true };
  await assert.rejects(() => exportSpeakerVoice(analysisId, 'speaker_a', exportInput), { code: 'VOICE_EXPORT_TRANSCRIPT_REVIEW' });
  const restored = await edit({ action: 'restore', audioRevision: 1 }).then((response) => response.json());
  assert.equal(restored.segment.durationMs, 8000);
  const simultaneous = await Promise.all([edit({ action: 'silence', audioRevision: 2 }), edit({ action: 'silence', audioRevision: 2 })]);
  assert.deepEqual(simultaneous.map((response) => response.status).sort(), [200, 409]);
  const cleaned = await simultaneous.find((response) => response.status === 200).json();
  assert.equal(cleaned.segment.durationMs, 4320);
  assert.equal(cleaned.removedMs, 3680);
  const saved = await fetch(`${endpoint}/segments/segment_a`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '校对后的甲。', transcriptReviewed: true }) });
  assert.equal(saved.status, 200);
  const exported = await exportSpeakerVoice(analysisId, 'speaker_a', exportInput);
  assert.equal(exported.voice.reference.durationMs, 4320);
  assert.equal(exported.voice.reference.transcript, '校对后的甲。');
  const exportedWav = await fetch(`${base}${exported.mediaUrl}`).then((response) => response.arrayBuffer());
  assert.equal(segmentWaveform(Buffer.from(exportedWav)).durationMs, 4320);
  const bulk = await fetch(`${endpoint}/clean-silence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    job = await fetch(`${base}/api/jobs/${bulk.id}`).then((response) => response.json());
    if (['completed', 'failed'].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.state, 'completed');
  assert.equal(job.result.silentCount, 1);
  const result = await fetch(endpoint).then((response) => response.json());
  assert.equal(result.speakers[0].segments[1].keep, false);
  assert.equal(result.speakers[0].segments[1].silence.silent, true);
  assert.equal((await cleanVoiceAnalysisSilence(analysisId)).processed, 0, '去静音幂等');
  assert.deepEqual(await fs.readFile(path.join(root, 'voice-analyses', analysisId, 'segment.wav')), original);
  const untouched = await fetch(`${base}/api/voice-analyses/${secondId}`).then((response) => response.json());
  assert.equal(untouched.speakers[0].segments[0].durationMs, 8000);
  assert.equal(untouched.speakers[0].segments[0].audioRevision, 0);
});
