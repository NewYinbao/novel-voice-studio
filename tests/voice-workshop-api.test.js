import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-workshop-test-'));
process.env.NVS_DATA_DIR = path.join(testRoot, 'data');

const {
  MAX_VOICE_ANALYSIS_SPEAKERS,
  VOICE_ANALYSES_DIR,
  VOICE_ANALYSIS_JOBS_DIR,
  VOICE_CLIPS_DIR,
  VOICE_DESIGNS_DIR,
  VOICE_SOURCES_DIR
} = await import('../src/lib/config.js');
const { generateDemoWav, wavBufferFromPcm } = await import('../src/lib/audio.js');
const { initStore } = await import('../src/lib/store.js');
const {
  cleanupExpiredVoiceDesigns, validateVoiceAnalysis, validateVoiceDesign, validateSpeakerExport
} = await import('../src/lib/voice-workshop.js');
const { createServer } = await import('../src/server.js');

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await fetch(`${base}/api/jobs/${jobId}`).then((response) => response.json());
    if (['completed', 'failed'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`等待任务超时：${jobId}`);
}

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('音色设计和分析输入严格限制字段、人数、授权与重叠开关', () => {
  assert.throws(() => validateVoiceDesign({ prompt: '专业播音腔', previewText: '试听', consent: false }), /确认/);
  assert.throws(() => validateVoiceDesign({ prompt: '短', previewText: '试听', consent: true }), /5–2000/);
  assert.throws(() => validateVoiceDesign({ prompt: '专业播音腔', previewText: '试听', consent: true, unexpected: true }), /不支持/);
  assert.throws(() => validateVoiceAnalysis({ consent: true, speakerCount: MAX_VOICE_ANALYSIS_SPEAKERS + 1 }), /说话人数/);
  assert.throws(() => validateSpeakerExport({ consent: true, includeOverlap: 'yes' }), /布尔值/);
});

test('提示词设计、多人分析、编辑与按说话人导出形成安全且幂等的完整链路', async (t) => {
  await initStore();
  let designCalls = 0;
  let analysisCalls = 0;
  let activeGpuCalls = 0;
  let maxActiveGpuCalls = 0;
  let maliciousAnalysisOutput = false;
  let failDesign = false;
  const outsideWav = path.join(testRoot, 'outside.wav');
  await fs.writeFile(outsideWav, generateDemoWav('越界音频测试测试测试测试').buffer);

  const worker = http.createServer(async (request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'POST' && request.url === '/v1/voice/design') {
      const body = await readBody(request);
      designCalls += 1;
      activeGpuCalls += 1;
      maxActiveGpuCalls = Math.max(maxActiveGpuCalls, activeGpuCalls);
      assert.match(body.request_id, /^design_[a-f0-9]{16}$/);
      assert.equal(body.model_id, 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign');
      assert.equal(body.text, '各位听众，欢迎收听今晚的文学节目。');
      assert.equal(body.prompt, '沉稳、清晰、克制的中文男播音员，字正腔圆。');
      assert.match(path.normalize(body.output_path), new RegExp(`voice-clips\\${path.sep}voicedesign_[a-f0-9]{16}\\${path.sep}reference\\.wav$`));
      if (failDesign) {
        activeGpuCalls -= 1;
        return send(503, { detail: { code: 'VOICE_DESIGN_FAILED', message: '模拟设计失败' } });
      }
      await fs.mkdir(path.dirname(body.output_path), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(body.output_path, generateDemoWav(body.text, 'solemn').buffer);
      activeGpuCalls -= 1;
      return send(200, { duration_seconds: 7, sample_rate: 24000, channels: 1, model_id: body.model_id });
    }
    if (request.method === 'POST' && request.url === '/v1/voice-analysis') {
      const body = await readBody(request);
      analysisCalls += 1;
      activeGpuCalls += 1;
      maxActiveGpuCalls = Math.max(maxActiveGpuCalls, activeGpuCalls);
      assert.match(body.request_id, /^analysis_[a-f0-9]{16}$/);
      await fs.stat(body.source_path);
      await assert.rejects(() => fs.stat(body.output_dir), { code: 'ENOENT' });
      await fs.mkdir(path.join(body.output_dir, 'segments'), { recursive: true });
      const makeClip = async (name, text) => {
        const filePath = path.join(body.output_dir, 'segments', `${name}.wav`);
        assert.ok(text);
        await fs.writeFile(filePath, wavBufferFromPcm(Buffer.alloc(5 * 24000 * 2), 24000, 1));
        return filePath;
      };
      const speakerOne = await makeClip('speaker-one', '第一位说话人的清晰测试台词');
      const speakerTwo = await makeClip('speaker-two', '第二位说话人的清晰测试台词');
      const overlap = await makeClip('overlap', '两个人重叠说话的测试台词');
      activeGpuCalls -= 1;
      return send(200, {
        duration_seconds: 20,
        capabilities: { diarization: true, transcription: true, emotion_detection: true, overlap_detection: true },
        warnings: ['自动识别结果需要人工复核'],
        speakers: [
          {
            id: 'speaker_a', label: '说话人 A', clean_segments: [{
              id: 'segment_a_clean_01', source_segment_id: 'segment_a', start_ms: 0, end_ms: 5000,
              text: '原始识别台词 A', emotion: 'neutral', text_alignment: 'segment',
              audio_path: maliciousAnalysisOutput ? outsideWav : speakerOne
            }], segments: [{
              id: 'segment_a', start_ms: 0, end_ms: 5000,
              text: '原始识别台词 A', emotion: 'neutral', confidence: 0.91, overlap: true, audio_path: speakerOne
            }]
          },
          {
            id: 'speaker_b', label: '说话人 B', clean_segments: [{
              id: 'segment_b_clean_01', source_segment_id: 'segment_b', start_ms: 6000, end_ms: 11000,
              text: '原始识别台词 B', emotion: 'happy', text_alignment: 'segment', audio_path: speakerTwo
            }], segments: [{
              id: 'segment_b', start_ms: 6000, end_ms: 11000,
              text: '原始识别台词 B', emotion: 'joy', confidence: 0.88, audio_path: speakerTwo
            }]
          }
        ],
        overlaps: [{
          id: 'overlap_ab', speaker_ids: ['speaker_a', 'speaker_b'], start_ms: 12000, end_ms: 17000,
          text: '重叠识别台词', emotion: 'surprise', confidence: 0.7, audio_path: overlap
        }]
      });
    }
    return send(404, { detail: 'not found' });
  });
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const workerBase = `http://127.0.0.1:${worker.address().port}`;

  const profile = {
    worker: {
      online: true,
      platform: process.platform === 'win32' ? 'Windows test worker' : `${process.platform} test worker`,
      ffmpeg: true,
      ffprobe: true,
      providers: { qwen3_tts: true }
    }
  };
  const server = createServer({ systemProfileResolver: async () => profile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerUrl: workerBase })
  });

  const designBody = {
    name: '文学男播',
    prompt: '沉稳、清晰、克制的中文男播音员，字正腔圆。',
    previewText: '各位听众，欢迎收听今晚的文学节目。',
    language: 'zh-CN',
    tags: ['播音腔'],
    consent: true
  };
  const voicesBeforeDesign = await fetch(`${base}/api/voices`).then((response) => response.json());
  const [designFirst, designRetry] = await Promise.all([
    fetch(`${base}/api/voices/design`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'design-test-1' }, body: JSON.stringify(designBody)
    }).then((response) => response.json()),
    fetch(`${base}/api/voices/design`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'design-test-1' }, body: JSON.stringify(designBody)
    }).then((response) => response.json())
  ]);
  assert.equal(designRetry.id, designFirst.id);
  const designJob = await waitForJob(base, designFirst.id);
  assert.equal(designJob.state, 'completed');
  assert.match(designJob.result.designId, /^voicedesign_[a-f0-9]{16}$/);
  assert.equal(designJob.result.voiceId, null);
  assert.equal(designJob.result.status, 'draft');
  assert.equal(designJob.result.name, '文学男播');
  assert.match(designJob.result.mediaUrl, /^\/media\/voice-designs\//);
  assert.equal(designCalls, 1);
  assert.equal((await fetch(`${base}${designJob.result.mediaUrl}`)).status, 200);
  assert.equal((await fetch(`${base}/api/voices`).then((response) => response.json())).length, voicesBeforeDesign.length);
  const persistedDesign = await fetch(`${base}/api/voice-designs/${designJob.result.designId}`).then((response) => response.json());
  assert.equal(persistedDesign.status, 'draft');
  assert.equal(persistedDesign.previewText, designBody.previewText);
  assert.ok((await fetch(`${base}/api/voice-designs`).then((response) => response.json()))
    .some((item) => item.id === persistedDesign.id));

  const commitResponses = await Promise.all([
    fetch(`${base}/api/voice-designs/${designJob.result.designId}/commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }),
    fetch(`${base}/api/voice-designs/${designJob.result.designId}/commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })
  ]);
  assert.deepEqual(commitResponses.map((response) => response.status).sort(), [200, 201]);
  const committed = await Promise.all(commitResponses.map((response) => response.json()));
  assert.equal(committed[0].voiceId, committed[1].voiceId);
  assert.equal(committed.filter((item) => item.alreadyCommitted).length, 1);
  assert.equal(committed[0].design.status, 'committed');
  assert.equal((await fetch(`${base}/api/voices`).then((response) => response.json())).length, voicesBeforeDesign.length + 1);
  assert.equal((await fetch(`${base}${committed[0].mediaUrl}`)).status, 200);

  const discardSubmission = await fetch(`${base}/api/voices/design`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'design-discard-1' },
    body: JSON.stringify({ ...designBody, name: '待丢弃候选' })
  }).then((response) => response.json());
  const discardJob = await waitForJob(base, discardSubmission.id);
  assert.equal(discardJob.state, 'completed');
  const discardResponse = await fetch(`${base}/api/voice-designs/${discardJob.result.designId}`, { method: 'DELETE' });
  assert.equal(discardResponse.status, 204);
  assert.equal((await fetch(`${base}/api/voice-designs/${discardJob.result.designId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/voices`).then((response) => response.json())).length, voicesBeforeDesign.length + 1);
  assert.equal(designCalls, 2);

  failDesign = true;
  const failedDesignSubmission = await fetch(`${base}/api/voices/design`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(designBody)
  }).then((response) => response.json());
  const failedDesignJob = await waitForJob(base, failedDesignSubmission.id);
  assert.equal(failedDesignJob.state, 'failed');
  assert.equal(failedDesignJob.error.code, 'VOICE_DESIGN_FAILED');
  failDesign = false;
  assert.deepEqual(await fs.readdir(VOICE_CLIPS_DIR), []);
  assert.equal((await fetch(`${base}/api/voice-designs`).then((response) => response.json())).length, 1);
  assert.equal(designCalls, 3);

  const upload = await fetch(`${base}/api/voice-sources?fileName=${encodeURIComponent('多人访谈.mp4')}`, {
    method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('mock-long-video')
  }).then((response) => response.json());
  const analysisRequest = () => fetch(`${base}/api/voice-sources/${upload.id}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'analysis-test-1' },
    body: JSON.stringify({ name: '多人访谈', language: 'zh-CN', consent: true })
  });
  const analysisSubmission = await analysisRequest();
  assert.equal(analysisSubmission.status, 202);
  const analysisQueued = await analysisSubmission.json();
  const analysisRetry = await analysisRequest();
  assert.equal(analysisRetry.status, 202);
  assert.equal((await analysisRetry.json()).id, analysisQueued.id);
  const analysisJob = await waitForJob(base, analysisQueued.id);
  assert.equal(analysisJob.state, 'completed', JSON.stringify(analysisJob.error));
  assert.match(analysisJob.result.analysisId, /^voiceanalysis_[a-f0-9]{16}$/);
  assert.equal(analysisCalls, 1);
  assert.equal(analysisJob.result.analysis, undefined, '任务响应只返回索引，不重复携带完整台词');
  assert.equal(maxActiveGpuCalls, 1);
  await assert.rejects(() => fs.stat(path.join(VOICE_SOURCES_DIR, upload.id)), { code: 'ENOENT' });

  const analysisUrl = `${base}/api/voice-analyses/${analysisJob.result.analysisId}`;
  let analysis = await fetch(analysisUrl).then((response) => response.json());
  assert.equal(analysis.name, '多人访谈');
  assert.equal(analysis.speakers.length, 2);
  assert.equal(analysis.speakers[0].totalDurationMs > 3000, true);
  assert.equal(analysis.speakers[0].segments[0].speakerId, 'speaker_a');
  assert.equal(analysis.speakers[0].segments[0].isOverlap, false);
  assert.equal(analysis.speakers[0].segments[0].containsOverlap, false);
  assert.equal(analysis.speakers[0].segments[0].sourceSegmentId, 'segment_a');
  assert.equal(analysis.speakers[0].segments[0].textAlignment, 'segment');
  assert.equal(analysis.speakers[1].segments[0].emotion, 'joy');
  assert.equal(analysis.overlaps[0].isOverlap, true);
  assert.equal(analysis.overlaps[0].keep, false);
  assert.deepEqual(analysis.overlaps[0].speakerIds, ['speaker_a', 'speaker_b']);
  assert.equal(analysis.capabilities.overlap_detection, true);
  assert.deepEqual(analysis.warnings, ['自动识别结果需要人工复核']);
  assert.equal((await fetch(`${base}${analysis.speakers[0].segments[0].mediaUrl}`)).status, 200);
  assert.equal((await fetch(`${base}${analysis.source.mediaUrl}`)).status, 200);

  const secondSegment = analysis.speakers[1].segments[0];
  const reassigned = await fetch(`${analysisUrl}/segments/${secondSegment.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerId: 'speaker_a' })
  }).then((response) => response.json());
  assert.equal(reassigned.analysis.speakers[0].segments.some((item) => item.id === secondSegment.id), true);
  assert.equal(reassigned.analysis.speakers[1].segments.length, 0);
  const reassignedBack = await fetch(`${analysisUrl}/segments/${secondSegment.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerId: 'speaker_b' })
  }).then((response) => response.json());
  assert.equal(reassignedBack.analysis.speakers[1].segments[0].speakerId, 'speaker_b');

  const cleanSegment = analysis.speakers[0].segments[0];
  const edited = await fetch(`${analysisUrl}/segments/${cleanSegment.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '人工校对后的准确台词。', emotion: 'solemn', keep: true })
  });
  assert.equal(edited.status, 200);
  const editedPayload = await edited.json();
  assert.equal(editedPayload.analysis.id, analysis.id);
  assert.equal(editedPayload.segment.text, '人工校对后的准确台词。');
  assert.equal(editedPayload.segment.emotion, 'solemn');

  const overlapSegment = analysis.overlaps[0];
  const retainedOverlap = await fetch(`${analysisUrl}/segments/${overlapSegment.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: true })
  });
  assert.equal(retainedOverlap.status, 200);

  const exportSubmission = await fetch(`${analysisUrl}/speakers/speaker_a/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'export-speaker-a-1' },
    body: JSON.stringify({ name: '访谈角色 A', tags: ['访谈'], consent: true })
  });
  assert.equal(exportSubmission.status, 202);
  const exportJob = await waitForJob(base, (await exportSubmission.json()).id);
  assert.equal(exportJob.state, 'completed');
  assert.deepEqual(exportJob.result.segmentIds, [cleanSegment.id]);
  assert.equal(exportJob.result.includedOverlap, false);
  assert.match(exportJob.result.voiceId, /^voice_[a-f0-9]{16}$/);
  assert.equal(exportJob.result.voice.reference.transcript, '人工校对后的准确台词。');

  const exportRetry = await fetch(`${analysisUrl}/speakers/speaker_a/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'export-speaker-a-1' },
    body: JSON.stringify({ name: '访谈角色 A', tags: ['访谈'], consent: true })
  }).then((response) => response.json());
  assert.equal(exportRetry.id, exportJob.id);

  const forbiddenOverlap = await fetch(`${analysisUrl}/speakers/speaker_a/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '只导出重叠', consent: true, segmentIds: [overlapSegment.id] })
  });
  assert.equal(forbiddenOverlap.status, 202);
  const forbiddenJob = await waitForJob(base, (await forbiddenOverlap.json()).id);
  assert.equal(forbiddenJob.state, 'failed');
  assert.equal(forbiddenJob.error.code, 'VOICE_EXPORT_EMPTY');

  analysis = await fetch(analysisUrl).then((response) => response.json());
  assert.equal(analysis.overlaps[0].keep, true);
  const analyses = await fetch(`${base}/api/voice-analyses`).then((response) => response.json());
  assert.ok(analyses.some((item) => item.id === analysis.id && item.speakerCount === 2));

  maliciousAnalysisOutput = true;
  const badUpload = await fetch(`${base}/api/voice-sources?fileName=${encodeURIComponent('恶意结果.wav')}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('mock-audio')
  }).then((response) => response.json());
  const badSubmission = await fetch(`${base}/api/voice-sources/${badUpload.id}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '恶意输出', consent: true })
  });
  const badJob = await waitForJob(base, (await badSubmission.json()).id);
  assert.equal(badJob.state, 'failed');
  assert.equal(badJob.error.code, 'VOICE_WORKER_PATH_ESCAPE');
  await assert.rejects(() => fs.stat(path.join(VOICE_SOURCES_DIR, badUpload.id)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(VOICE_ANALYSIS_JOBS_DIR), []);
  assert.deepEqual(await fs.readdir(VOICE_CLIPS_DIR), []);
  assert.deepEqual(await fs.readdir(VOICE_DESIGNS_DIR), [designJob.result.designId]);
  assert.equal((await fs.readdir(VOICE_ANALYSES_DIR)).length, 1);
});

test('过期 VoiceDesign 候选会清理且不会影响已入库音色', async () => {
  const designId = 'voicedesign_ffffffffffffffff';
  const dir = path.join(VOICE_DESIGNS_DIR, designId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'reference.wav'), generateDemoWav('过期候选试听').buffer);
  await fs.writeFile(path.join(dir, 'design.json'), JSON.stringify({
    id: designId,
    expiresAt: new Date(Date.now() - 1000).toISOString()
  }));
  await cleanupExpiredVoiceDesigns();
  await assert.rejects(() => fs.stat(dir), { code: 'ENOENT' });
});
