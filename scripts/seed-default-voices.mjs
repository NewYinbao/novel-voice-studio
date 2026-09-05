import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concatenateWavs } from '../src/lib/audio.js';
import { OPEN_SOURCE_VOICE_PRESETS } from './voice-preset-catalog.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const assetRoot = path.join(projectRoot, 'data', '.tmp', 'aishell3-defaults');
const sourceBase = 'https://huggingface.co/datasets/AISHELL/AISHELL-3/resolve/main';
const sourcePage = 'https://huggingface.co/datasets/AISHELL/AISHELL-3';

const args = process.argv.slice(2);
function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = option('--base-url', 'http://127.0.0.1:4317').replace(/\/$/, '');
const requestedProjectId = option('--project-id');
const shouldRender = args.includes('--render');

const bindingSamples = [
  {
    key: 'narrator',
    marker: 'AISHELL-3/SSB0241',
    name: '默认旁白 · 北方男声',
    transcript: '悟空。周璇。画面。心灵。',
    tags: ['默认', '开源测试', '男声', '沉稳', 'AISHELL-3', 'Apache-2.0', 'SSB0241'],
    files: [
      ['test/wav/SSB0241/SSB02410008.wav', 'b26020a03ad36da356e57e19b5e07c351c1f0d3724b292df1ddcc032b56b9842'],
      ['test/wav/SSB0241/SSB02410044.wav', '140dcc8a86a84eb06aab18bdd3ab4ab3e91f98a2c65222089083d5fa1efbe5b9'],
      ['test/wav/SSB0241/SSB02410064.wav', 'c19d996c38a2b239a7ca1ca25beb281c48c7533a12373ce282924edc0a5ebe58'],
      ['test/wav/SSB0241/SSB02410087.wav', 'ebf971f6339e377d9a22017f5347b6afa155e0e8f5f0b5c36db721da9c4b3b5d']
    ]
  },
  {
    key: 'male',
    marker: 'AISHELL-3/SSB0273',
    name: '默认角色 · 青年男声',
    transcript: '停车场。本周日。九百零八。',
    tags: ['默认', '开源测试', '男声', '青年', 'AISHELL-3', 'Apache-2.0', 'SSB0273'],
    files: [
      ['test/wav/SSB0273/SSB02730118.wav', '4ea119914736477bf13f37ed7ed1d0eb8cb0edc55d9898c88119425459381d3b'],
      ['test/wav/SSB0273/SSB02730120.wav', 'a93cbb9b3d55ca0dbed2f12934bcb1c9d1da81299d6770e27a2027ddee13c904'],
      ['test/wav/SSB0273/SSB02730357.wav', '8fc506fe6443381213e7a79d4f8abb9e73bc28542fc7ec23052cdc3a40565440']
    ]
  },
  {
    key: 'female',
    marker: 'AISHELL-3/SSB0005',
    name: '默认角色 · 清澈女声',
    transcript: '深交所副总经理周明指出。',
    tags: ['默认', '开源测试', '女声', '清澈', 'AISHELL-3', 'Apache-2.0', 'SSB0005'],
    files: [
      ['test/wav/SSB0005/SSB00050353.wav', 'e5f8e2417a89ce2418c59d419be999b46206890d1f094b76f77ad4d41b365bca']
    ]
  }
];

const samples = [...bindingSamples, ...OPEN_SOURCE_VOICE_PRESETS];
const bindingSampleKeys = new Set(bindingSamples.map((sample) => sample.key));

function validateCatalog() {
  const keys = new Set();
  const markers = new Set();
  for (const sample of samples) {
    if (!sample.key || keys.has(sample.key)) throw new Error(`音色 key 重复或为空：${sample.key || '空'}`);
    if (!sample.marker || markers.has(sample.marker)) throw new Error(`音色 marker 重复或为空：${sample.marker || '空'}`);
    const tags = sample.tags?.includes(sample.marker) ? sample.tags : [...(sample.tags || []), sample.marker];
    if (tags.length > 10) throw new Error(`${sample.name} 的标签超过 10 个，marker 可能被截断`);
    keys.add(sample.key);
    markers.add(sample.marker);
  }
}

validateCatalog();

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.detail || `HTTP ${response.status} ${route}`);
  return payload;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readIfVerified(filePath, expectedHash) {
  try {
    const buffer = await fs.readFile(filePath);
    return sha256(buffer) === expectedHash ? buffer : null;
  } catch {
    return null;
  }
}

async function download(file, expectedHash) {
  const outputPath = path.join(assetRoot, file);
  const cached = await readIfVerified(outputPath, expectedHash);
  if (cached) return outputPath;
  const url = `${sourceBase}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载默认音色失败：${file} · HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(buffer);
  if (actualHash !== expectedHash) throw new Error(`默认音色校验失败：${file} · ${actualHash}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const partial = `${outputPath}.partial`;
  await fs.writeFile(partial, buffer);
  await fs.rm(outputPath, { force: true });
  await fs.rename(partial, outputPath);
  return outputPath;
}

async function prepareReference(sample) {
  const sourcePaths = [];
  for (const [file, hash] of sample.files) sourcePaths.push(await download(file, hash));
  if (sourcePaths.length === 1) return sourcePaths[0];
  const outputPath = path.join(assetRoot, 'prepared', `${sample.key}.wav`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });
  await concatenateWavs(sourcePaths.map((filePath, index) => ({
    filePath,
    pauseAfterMs: index === sourcePaths.length - 1 ? 0 : 180
  })), outputPath);
  return outputPath;
}

async function ensureVoices(bootstrap) {
  const voiceByKey = {};
  for (const sample of samples) {
    let voice = bootstrap.voices.find((item) => (
      item.tags?.includes(sample.marker) || (bindingSampleKeys.has(sample.key) && item.name === sample.name)
    ));
    if (voice && voice.status !== 'ready') {
      throw new Error(`预置音色“${voice.name}”已存在但未就绪，请在音色库删除该异常项后重试`);
    }
    if (!voice) {
      const referencePath = await prepareReference(sample);
      const audio = await fs.readFile(referencePath);
      const tags = sample.tags?.includes(sample.marker) ? sample.tags : [...(sample.tags || []), sample.marker];
      voice = await api('/api/voices', {
        method: 'POST',
        body: {
          name: sample.name,
          kind: 'open-source',
          language: 'zh-CN',
          tags,
          transcript: sample.transcript,
          consent: true,
          fileName: `${sample.key}.wav`,
          audioBase64: `data:audio/wav;base64,${audio.toString('base64')}`
        }
      });
      process.stdout.write(`已导入：${voice.name}（${sample.marker}）\n`);
    } else {
      process.stdout.write(`已存在：${voice.name}\n`);
    }
    voiceByKey[sample.key] = voice;
  }
  return voiceByKey;
}

function allLines(project) {
  return project.chapters.flatMap((chapter) => (chapter.scenes || []).flatMap((scene) => scene.lines || []));
}

async function bindProject(project, voiceByKey) {
  const dialogueRoles = project.characters.filter((role) => !role.isNarrator);
  for (const role of project.characters) {
    let voice = role.isNarrator ? voiceByKey.narrator : null;
    if (!voice && /苏晚|女/.test(role.name)) voice = voiceByKey.female;
    if (!voice && /林默|男/.test(role.name)) voice = voiceByKey.male;
    if (!voice) voice = dialogueRoles.indexOf(role) % 2 === 0 ? voiceByKey.male : voiceByKey.female;
    if (role.voiceId === voice.id) continue;
    await api(`/api/projects/${project.id}/characters/${role.id}`, { method: 'PATCH', body: { voiceId: voice.id } });
    process.stdout.write(`已绑定：${role.name} → ${voice.name}\n`);
  }
  return api(`/api/projects/${project.id}`);
}

async function waitForJob(jobId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${jobId}`);
    process.stdout.write(`\r${jobLabels[job.type] || job.type}：${job.state} ${job.progress}% · ${job.message}        `);
    if (['completed', 'failed'].includes(job.state)) {
      process.stdout.write('\n');
      if (job.state === 'failed') throw new Error(job.error?.message || '生成任务失败');
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待任务超时：${jobId}`);
}

const jobLabels = { render: '真实语音生成', script: '剧本转换', export: '导出' };

async function renderSmoke(project) {
  const selected = [];
  const seenRoles = new Set();
  for (const line of allLines(project)) {
    if (!['narration', 'dialogue'].includes(line.kind) || !line.spokenText?.trim() || seenRoles.has(line.speakerId)) continue;
    selected.push(line.id);
    seenRoles.add(line.speakerId);
    if (selected.length === 3) break;
  }
  if (!selected.length) throw new Error('项目还没有可测试的剧本台词');
  const submission = await api(`/api/projects/${project.id}/render`, { method: 'POST', body: { lineIds: selected } });
  const job = await waitForJob(submission.id);
  if (job.result?.failed) throw new Error(`真实生成有 ${job.result.failed} 个片段失败`);
  const renderedProject = await api(`/api/projects/${project.id}`);
  const renderedLines = allLines(renderedProject).filter((line) => selected.includes(line.id));
  for (const line of renderedLines) {
    if (line.render?.status !== 'ready' || !line.render?.mediaUrl || line.render.demo) {
      throw new Error(`${line.speaker} 的测试音频未生成成功：${line.render?.error || line.render?.status || '无结果'}`);
    }
    const response = await fetch(`${baseUrl}${line.render.mediaUrl}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${line.speaker} 的媒体文件校验失败`);
    }
    process.stdout.write(`播放文件就绪：${line.speaker} · ${(line.render.durationMs / 1000).toFixed(2)} 秒 · ${buffer.length} bytes · ${line.render.mediaUrl}\n`);
  }
  return renderedLines;
}

const bootstrap = await api('/api/bootstrap');
const projectId = requestedProjectId;
if (shouldRender && !projectId) throw new Error('`--render` 必须同时提供 `--project-id`');
const voiceByKey = await ensureVoices(bootstrap);
process.stdout.write(`默认音色来源：AISHELL-3（Apache-2.0）· ${sourcePage}\n`);
if (projectId) {
  let project = await api(`/api/projects/${projectId}`);
  project = await bindProject(project, voiceByKey);
  if (shouldRender) await renderSmoke(project);
  process.stdout.write(`完成：已导入 ${samples.length} 个开源测试音色，并为《${project.title}》绑定基础默认音色${shouldRender ? '，真实生成与媒体文件校验通过' : ''}。\n`);
} else {
  process.stdout.write(`完成：已导入 ${samples.length} 个开源测试音色（其中 ${OPEN_SOURCE_VOICE_PRESETS.length} 个常用角色预置），未修改任何作品的角色绑定。\n`);
}
