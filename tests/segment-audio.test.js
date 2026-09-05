import test from 'node:test';
import assert from 'node:assert/strict';
import { wavBufferFromPcm, parsePcmWav } from '../src/lib/audio.js';
import { cropSegmentAudio, removeSegmentSilence, segmentWaveform } from '../src/lib/segment-audio.js';

function sample(parts, amplitude = 7000) {
  const samples = [];
  for (const [duration, speech] of parts) {
    const pcm = Buffer.alloc(Math.round(duration * 24000) * 2);
    if (speech) for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * Math.PI * 440 / 24000)), i * 2);
    samples.push(pcm);
  }
  return wavBufferFromPcm(Buffer.concat(samples));
}

test('自动清理首尾与句内长静音，保留字头字尾余量与短停顿，并且可重复执行', () => {
  const input = sample([[1, false], [1, true], [.2, false], [1, true], [2, false], [1, true], [1, false]]);
  const cleaned = removeSegmentSilence(input);
  assert.equal(cleaned.originalDurationMs, 7200);
  assert.equal(cleaned.durationMs, 3520);
  assert.equal(cleaned.removedMs, 3680);
  assert.equal(cleaned.silent, false);
  assert.equal(cleaned.removedRanges.length, 3);
  assert.equal(removeSegmentSilence(cleaned.buffer).removedMs, 0);
  assert.deepEqual(input, sample([[1, false], [1, true], [.2, false], [1, true], [2, false], [1, true], [1, false]]));
});

test('保守阈值保护低音量声音，全静音单独识别，不伪造人声', () => {
  const quiet = removeSegmentSilence(sample([[1, false], [1, true], [1, false]], 30));
  assert.equal(quiet.silent, false);
  assert.equal(quiet.durationMs, 1160);
  const empty = removeSegmentSilence(sample([[3, false]]));
  assert.equal(empty.silent, true);
  assert.equal(empty.durationMs, 0);
  assert.equal(empty.removedMs, 3000);
});

test('真实 PCM 波形有界并能区分空白；裁剪精确到采样，拒绝越界及非法 WAV', () => {
  const input = sample([[1, false], [1, true]]);
  const waveform = segmentWaveform(input, 100);
  assert.equal(waveform.peaks.length, 100);
  assert.ok(waveform.peaks.slice(0, 50).every((peak) => peak === 0));
  assert.ok(waveform.peaks.slice(50).every((peak) => peak > .1));
  const cut = cropSegmentAudio(input, 1000, 1800);
  assert.equal(segmentWaveform(cut).durationMs, 800);
  assert.equal(parsePcmWav(cut).data.length, 800 * 24 * 2);
  for (const range of [[-1, 100], [0, 2200], [1000, 900], [0, 99], [NaN, 1000]]) assert.throws(() => cropSegmentAudio(input, ...range));
  const broken = Buffer.from(input); broken.writeUInt32LE(input.length + 1, 40);
  assert.throws(() => segmentWaveform(broken), /越界/);
});
