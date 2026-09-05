import { parsePcmWav, wavBufferFromPcm } from './audio.js';

export const SILENCE_VERSION = 1;
// Conservative energy gate, not speaker separation or noise removal. Short
// pauses/breaths stay intact; low-level speech lowers the gate automatically.
export const SILENCE_SETTINGS = Object.freeze({ thresholdDb: -42, minSilenceMs: 500, edgeSilenceMs: 180, paddingMs: 80, frameMs: 10 });

function pcm(buffer) {
  const wav = parsePcmWav(buffer);
  if (![1, 2].includes(wav.channels) || wav.sampleRate < 8000 || wav.sampleRate > 192000 || wav.data.length % (wav.channels * 2)) throw new Error('音频 PCM 格式无效');
  return { ...wav, frames: wav.data.length / (wav.channels * 2) };
}

export function cropSegmentAudio(buffer, startMs, endMs) {
  const wav = pcm(buffer);
  const durationMs = wav.frames / wav.sampleRate * 1000;
  if (![startMs, endMs].every(Number.isFinite) || startMs < 0 || endMs > durationMs + 1 || endMs - startMs < 100) {
    throw Object.assign(new Error('裁剪范围须在片段内，且至少保留 0.1 秒'), { statusCode: 400 });
  }
  const start = Math.round(startMs / 1000 * wav.sampleRate);
  const end = Math.min(wav.frames, Math.round(endMs / 1000 * wav.sampleRate));
  return wavBufferFromPcm(wav.data.subarray(start * wav.channels * 2, end * wav.channels * 2), wav.sampleRate, wav.channels);
}

export function removeSegmentSilence(buffer) {
  const wav = pcm(buffer);
  const frameSize = Math.max(1, Math.round(wav.sampleRate * SILENCE_SETTINGS.frameMs / 1000));
  const energies = [];
  let peakRms = 0;
  for (let start = 0; start < wav.frames; start += frameSize) {
    const end = Math.min(wav.frames, start + frameSize);
    let energy = 0;
    for (let frame = start; frame < end; frame += 1) {
      let amplitude = 0;
      for (let channel = 0; channel < wav.channels; channel += 1) amplitude = Math.max(amplitude, Math.abs(wav.data.readInt16LE((frame * wav.channels + channel) * 2) / 32768));
      energy += amplitude * amplitude;
    }
    const rms = Math.sqrt(energy / (end - start));
    energies.push(rms);
    peakRms = Math.max(peakRms, rms);
  }
  // Only near-digital silence is declared wholly unusable, to avoid discarding
  // quiet speech. An energy gate cannot distinguish speech from loud noise.
  const silent = peakRms < 10 ** (-80 / 20);
  const threshold = Math.min(10 ** (SILENCE_SETTINGS.thresholdDb / 20), peakRms * 10 ** (-30 / 20));
  const removed = [];
  const padding = Math.round(wav.sampleRate * SILENCE_SETTINGS.paddingMs / 1000);
  for (let index = 0; index < energies.length;) {
    if (!silent && energies[index] > threshold) { index += 1; continue; }
    const from = index;
    while (index < energies.length && (silent || energies[index] <= threshold)) index += 1;
    const start = from * frameSize;
    const end = Math.min(wav.frames, index * frameSize);
    const edge = from === 0 || index === energies.length;
    const minimumMs = edge ? SILENCE_SETTINGS.edgeSilenceMs : SILENCE_SETTINGS.minSilenceMs;
    if (silent || (end - start) / wav.sampleRate * 1000 >= minimumMs) {
      const cutStart = from === 0 ? 0 : Math.min(end, start + padding);
      const cutEnd = index === energies.length ? wav.frames : Math.max(cutStart, end - padding);
      if (cutEnd > cutStart) removed.push([cutStart, cutEnd]);
    }
  }
  const chunks = [];
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) chunks.push(wav.data.subarray(cursor * wav.channels * 2, start * wav.channels * 2));
    cursor = end;
  }
  if (cursor < wav.frames) chunks.push(wav.data.subarray(cursor * wav.channels * 2));
  const data = Buffer.concat(chunks);
  return {
    buffer: wavBufferFromPcm(data, wav.sampleRate, wav.channels),
    originalDurationMs: Math.round(wav.frames / wav.sampleRate * 1000),
    durationMs: Math.round(data.length / (wav.sampleRate * wav.channels * 2) * 1000),
    removedMs: Math.round((wav.data.length - data.length) / (wav.sampleRate * wav.channels * 2) * 1000),
    silent,
    removedRanges: removed.map(([start, end]) => [Math.round(start / wav.sampleRate * 1000), Math.round(end / wav.sampleRate * 1000)]),
  };
}

export function segmentWaveform(buffer, bins = 640) {
  const wav = pcm(buffer);
  const count = Math.min(bins, wav.frames);
  const peaks = [];
  for (let bin = 0; bin < count; bin += 1) {
    let peak = 0;
    const end = Math.floor((bin + 1) * wav.frames / count);
    for (let frame = Math.floor(bin * wav.frames / count); frame < end; frame += 1) {
      for (let channel = 0; channel < wav.channels; channel += 1) peak = Math.max(peak, Math.abs(wav.data.readInt16LE((frame * wav.channels + channel) * 2)));
    }
    peaks.push(Math.round(peak / 32768 * 1000) / 1000);
  }
  return { peaks, durationMs: Math.round(wav.frames / wav.sampleRate * 1000), sampleRate: wav.sampleRate };
}
