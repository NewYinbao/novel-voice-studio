import fs from 'node:fs/promises';
import path from 'node:path';

function wavHeader(dataBytes, sampleRate = 24000, channels = 1) {
  if (dataBytes > 0xffffffff - 36) throw new Error('单个 WAV 超过 RIFF 4GiB 限制，请按章节导出或安装 FFmpeg');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function wavBufferFromPcm(pcm, sampleRate = 24000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([wavHeader(data.length, sampleRate, channels), data]);
}

export function generateDemoWav(text, emotion = 'neutral', sampleRate = 24000) {
  const seconds = Math.max(0.9, Math.min(12, String(text).length / 5.2));
  const frames = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(frames * 2);
  const baseByEmotion = { neutral: 178, warm: 164, joy: 212, sad: 142, angry: 225, fear: 198, surprise: 240, whisper: 125, solemn: 132 };
  const base = baseByEmotion[emotion] || baseByEmotion.neutral;
  const chars = [...String(text || '试听')];
  let noiseState = 0x9e3779b9;
  for (let index = 0; index < frames; index += 1) {
    const t = index / sampleRate;
    const syllable = Math.min(chars.length - 1, Math.floor((index / frames) * chars.length));
    const code = chars[Math.max(0, syllable)]?.codePointAt(0) || 1;
    const local = ((index / sampleRate) * 5.2) % 1;
    const envelope = Math.sin(Math.PI * Math.min(1, local / 0.15)) * Math.min(1, (1 - local) / 0.12);
    const contour = 1 + (((code % 17) - 8) / 90) + Math.sin(t * 2.1) * 0.025;
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    const noise = ((noiseState >>> 0) / 0xffffffff - 0.5) * (emotion === 'whisper' ? 0.12 : 0.018);
    const tone = Math.sin(2 * Math.PI * base * contour * t) * 0.48
      + Math.sin(2 * Math.PI * base * 2.03 * contour * t) * 0.16
      + Math.sin(2 * Math.PI * base * 3.9 * contour * t) * 0.06;
    const fade = Math.min(1, index / (sampleRate * 0.04), (frames - index) / (sampleRate * 0.08));
    const value = Math.max(-1, Math.min(1, (tone + noise) * envelope * fade * 0.32));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return { buffer: wavBufferFromPcm(pcm, sampleRate), durationMs: Math.round(seconds * 1000), sampleRate };
}

export function parsePcmWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(start, Math.min(buffer.length, start + size));
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('只支持 16-bit PCM WAV 合并；其他格式请安装 FFmpeg');
  }
  return { ...format, data };
}

async function inspectPcmWav(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const riff = Buffer.alloc(12);
    if ((await handle.read(riff, 0, 12, 0)).bytesRead !== 12 || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('不是有效的 WAV 文件');
    }
    let offset = 12;
    let format;
    let dataOffset;
    let dataSize;
    while (offset + 8 <= stat.size) {
      const chunk = Buffer.alloc(8);
      if ((await handle.read(chunk, 0, 8, offset)).bytesRead !== 8) break;
      const chunkId = chunk.toString('ascii', 0, 4);
      const size = chunk.readUInt32LE(4);
      const start = offset + 8;
      if (start + size > stat.size) throw new Error('WAV 数据块越界');
      if (chunkId === 'fmt ') {
        if (size < 16) throw new Error('WAV fmt 数据块无效');
        const value = Buffer.alloc(16);
        await handle.read(value, 0, 16, start);
        format = {
          audioFormat: value.readUInt16LE(0), channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4), bitsPerSample: value.readUInt16LE(14)
        };
      } else if (chunkId === 'data') {
        dataOffset = start;
        dataSize = size;
      }
      if (format && dataOffset !== undefined) break;
      offset = start + size + (size % 2);
    }
    if (!format || dataOffset === undefined || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
      throw new Error('只支持 16-bit PCM WAV 合并；其他格式请安装 FFmpeg');
    }
    return { ...format, dataOffset, dataSize };
  } finally { await handle.close(); }
}

async function writeAll(handle, buffer, length = buffer.length) {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset);
    if (!bytesWritten) throw new Error('写入 WAV 失败');
    offset += bytesWritten;
  }
}

async function copyFileRange(sourcePath, output, start, length) {
  const source = await fs.open(sourcePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = start;
    let remaining = length;
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (!bytesRead) throw new Error('WAV 片段提前结束');
      await writeAll(output, buffer, bytesRead);
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally { await source.close(); }
}

export async function concatenateWavs(segments, outputPath) {
  if (!segments.length) throw new Error('没有可导出的音频片段');
  const parsed = [];
  for (const segment of segments) {
    const wav = await inspectPcmWav(segment.filePath);
    parsed.push({ ...segment, wav });
  }
  const first = parsed[0].wav;
  for (const { wav } of parsed) {
    if (wav.sampleRate !== first.sampleRate || wav.channels !== first.channels) {
      throw new Error('片段采样率不一致，请安装 FFmpeg 后导出');
    }
  }
  const totalDataBytes = parsed.reduce((total, { wav, pauseAfterMs = 0 }) => {
    const safePause = Math.max(0, Math.min(60_000, Number(pauseAfterMs) || 0));
    const silenceFrames = Math.round((safePause / 1000) * wav.sampleRate);
    return total + wav.dataSize + silenceFrames * wav.channels * 2;
  }, 0);
  const header = wavHeader(totalDataBytes, first.sampleRate, first.channels);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.partial`;
  const output = await fs.open(temp, 'w');
  try {
    await writeAll(output, header);
    const silence = Buffer.alloc(64 * 1024);
    for (const { filePath, wav, pauseAfterMs = 0 } of parsed) {
      await copyFileRange(filePath, output, wav.dataOffset, wav.dataSize);
      const safePause = Math.max(0, Math.min(60_000, Number(pauseAfterMs) || 0));
      let silenceBytes = Math.round((safePause / 1000) * wav.sampleRate) * wav.channels * 2;
      while (silenceBytes > 0) {
        const size = Math.min(silence.length, silenceBytes);
        await writeAll(output, silence, size);
        silenceBytes -= size;
      }
    }
  } catch (error) {
    await output.close();
    await fs.rm(temp, { force: true });
    throw error;
  }
  await output.close();
  await fs.rename(temp, outputPath);
  return {
    filePath: outputPath,
    durationMs: Math.round(totalDataBytes / (first.sampleRate * first.channels * 2) * 1000),
    sampleRate: first.sampleRate
  };
}
