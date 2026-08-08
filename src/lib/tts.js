import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, EXPORTS_DIR, PROJECTS_DIR, TTS_ENGINES, VOICES_DIR } from './config.js';
import { concatenateWavs, generateDemoWav } from './audio.js';
import { getProject, getVoice, mutateProject } from './store.js';
import { id, nowIso, safeName } from './utils.js';

function allLines(project) {
  return project.chapters.flatMap((chapter) => chapter.scenes.flatMap((scene) => scene.lines.map((line) => ({ chapter, scene, line }))));
}

function renderKey({ engineId, line, voice }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    engineId,
    text: line.spokenText,
    emotion: line.emotion,
    intensity: line.intensity,
    pace: line.pace,
    voiceVersion: voice?.versionId || 'none',
    referenceHash: voice?.reference?.sha256 || 'none'
  })).digest('hex');
}

async function workerSynthesize(settings, request) {
  const response = await fetch(`${settings.workerUrl.replace(/\/$/, '')}/v1/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(12 * 60_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.detail || payload.message || `模型工作器返回 HTTP ${response.status}`), { code: payload.code || 'TTS_FAILED' });
  }
  return payload;
}

function resolveEngine(settings, profile, project) {
  const selected = project.production.engineId !== 'auto' ? project.production.engineId : settings.selectedEngine;
  const engineId = selected && selected !== 'auto' ? selected : profile.recommendedEngineId;
  return TTS_ENGINES.find((engine) => engine.id === engineId) || TTS_ENGINES[0];
}

function pathForWorker(localPath, profile) {
  const workerPlatform = String(profile.worker?.platform || '');
  if (process.platform === 'win32' && /^linux/i.test(workerPlatform)) {
    const normalized = path.resolve(localPath).replaceAll('\\', '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return localPath;
}

export async function renderLines(projectId, { lineIds = [], demoFallback = false, settings, profile }, update) {
  const selectedIds = new Set(lineIds);
  const initialProject = await getProject(projectId);
  const targetIds = allLines(initialProject)
    .filter(({ line }) => !selectedIds.size || selectedIds.has(line.id))
    .map(({ line }) => line.id);
  if (!targetIds.length) throw Object.assign(new Error('没有可生成的台词'), { code: 'NO_RENDER_TARGETS' });
  const engine = resolveEngine(settings, profile, initialProject);
  const result = { rendered: 0, skipped: 0, failed: 0, engineId: engine.id, demo: false, errors: [] };
  const rendersDir = path.join(PROJECTS_DIR, projectId, 'renders');
  await fs.mkdir(rendersDir, { recursive: true });

  for (let index = 0; index < targetIds.length; index += 1) {
    const currentProject = await getProject(projectId);
    const line = allLines(currentProject).find((item) => item.line.id === targetIds[index])?.line;
    if (!line || !['narration', 'dialogue'].includes(line.kind) || !line.spokenText.trim()) {
      result.skipped += 1;
      continue;
    }
    const character = currentProject.characters.find((role) => role.id === line.speakerId || role.name === line.speaker);
    let voice = null;
    if (character?.voiceId) voice = await getVoice(character.voiceId).catch(() => null);
    const key = renderKey({ engineId: engine.id, line, voice });
    if (line.render?.key === key && line.render?.status === 'ready' && !line.render.demo && line.render.engineId === engine.id) {
      result.skipped += 1;
      update(((index + 1) / targetIds.length) * 100, `复用缓存：${line.speaker}`);
      continue;
    }
    const outputPath = path.join(rendersDir, `${line.id}-${key.slice(0, 10)}.wav`);
    await mutateProject(projectId, (draft) => {
      const target = allLines(draft).find((item) => item.line.id === line.id)?.line;
      if (target) target.render = { status: 'running', key, engineId: engine.id };
    });
    update((index / targetIds.length) * 100, `正在生成 ${index + 1}/${targetIds.length} · ${line.speaker}`);

    let finalRender;
    try {
      if (!profile.worker.online) throw Object.assign(new Error('模型工作器未启动'), { code: 'WORKER_OFFLINE' });
      if (!voice?.reference) throw Object.assign(new Error(`${line.speaker} 尚未绑定带参考录音的音色`), { code: 'VOICE_REFERENCE_MISSING' });
      const referencePath = path.join(VOICES_DIR, voice.id, voice.reference.fileName);
      const response = await workerSynthesize(settings, {
        request_id: id('tts'), engine: engine.workerProvider, model_id: engine.modelId,
        text: line.spokenText, language: voice.language || 'zh-CN', emotion: line.emotion,
        emotion_note: line.emotionNote || '', intensity: line.intensity, pace: line.pace,
        reference_audio: pathForWorker(referencePath, profile), reference_text: voice.reference.transcript,
        output_path: pathForWorker(outputPath, profile)
      });
      finalRender = {
        status: 'ready', key, engineId: engine.id, file: path.relative(DATA_DIR, outputPath).replaceAll('\\', '/'),
        mediaUrl: `/media/projects/${projectId}/renders/${path.basename(outputPath)}`,
        durationMs: response.duration_ms, generatedAt: nowIso(), demo: false,
        warnings: response.warnings || []
      };
    } catch (error) {
      if (demoFallback) {
        const demo = generateDemoWav(line.spokenText, line.emotion, settings.sampleRate);
        await fs.writeFile(outputPath, demo.buffer);
        finalRender = {
          status: 'ready', key: `demo:${key}`, engineId: 'demo-signal', file: path.relative(DATA_DIR, outputPath).replaceAll('\\', '/'),
          mediaUrl: `/media/projects/${projectId}/renders/${path.basename(outputPath)}`,
          durationMs: demo.durationMs, generatedAt: nowIso(), demo: true, warning: `演示音轨：${error.message}`
        };
        result.demo = true;
      } else {
        finalRender = { status: 'failed', key, engineId: engine.id, error: error.message };
        result.failed += 1;
        result.errors.push({ lineId: line.id, message: error.message, code: error.code });
      }
    }

    let committed = false;
    await mutateProject(projectId, (draft) => {
      const target = allLines(draft).find((item) => item.line.id === line.id)?.line;
      if (!target || target.render?.status !== 'running' || target.render?.key !== key) return;
      target.render = finalRender;
      committed = true;
    });
    if (!committed && finalRender.status === 'ready') await fs.rm(outputPath, { force: true });
    if (committed && finalRender.status === 'ready') result.rendered += 1;
    update(((index + 1) / targetIds.length) * 100, finalRender.status === 'ready' ? `已生成 ${index + 1}/${targetIds.length}` : `生成失败 ${index + 1}/${targetIds.length}`);
  }

  await mutateProject(projectId, (project) => {
    const productionLines = allLines(project).map(({ line }) => line)
      .filter((line) => ['narration', 'dialogue'].includes(line.kind) && line.spokenText.trim());
    const readyCount = productionLines.filter((line) => line.render?.status === 'ready').length;
    project.status = readyCount === productionLines.length ? 'rendered' : readyCount ? 'render_partial' : 'scripted';
  });
  if (result.failed > 0 && result.rendered === 0) {
    const firstError = result.errors[0];
    throw Object.assign(
      new Error(`所有 ${result.failed} 个片段均生成失败${firstError?.message ? `：${firstError.message}` : ''}`),
      { code: firstError?.code || 'RENDER_ALL_FAILED', detail: result }
    );
  }
  return result;
}

export async function exportProjectWav(projectId, update, { allowPartial = false } = {}) {
  return mutateProject(projectId, async (project) => {
    const speakable = allLines(project).filter(({ line }) => ['narration', 'dialogue'].includes(line.kind) && line.spokenText.trim());
    const ready = speakable.filter(({ line }) => line.render?.status === 'ready' && line.render?.file);
    if (!ready.length) throw Object.assign(new Error('还没有已生成的音频片段'), { code: 'NO_AUDIO' });
    const missing = speakable.filter(({ line }) => line.render?.status !== 'ready' || !line.render?.file);
    if (missing.length && !allowPartial) {
      throw Object.assign(new Error(`还有 ${missing.length} 个片段未生成或已过期，请全部生成后再导出`), {
        code: 'INCOMPLETE_AUDIO', statusCode: 409, detail: { missingLineIds: missing.slice(0, 100).map(({ line }) => line.id) }
      });
    }
    update(10, '正在校验音频片段');
    const segments = ready.map(({ line }) => ({
      filePath: path.join(DATA_DIR, line.render.file), pauseAfterMs: line.pauseAfterMs || 0
    }));
    const exportId = id('export');
    const dir = path.join(EXPORTS_DIR, projectId);
    const fileName = `${safeName(project.title)}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${exportId.slice(-6)}.wav`;
    const outputPath = path.join(dir, fileName);
    update(35, '正在拼接与写入 WAV');
    const audio = await concatenateWavs(segments, outputPath);
    const record = {
      id: exportId, format: 'wav', fileName, file: path.relative(DATA_DIR, outputPath).replaceAll('\\', '/'),
      mediaUrl: `/media/exports/${projectId}/${encodeURIComponent(fileName)}`,
      durationMs: audio.durationMs, createdAt: nowIso(), lineCount: ready.length,
      containsDemoAudio: ready.some(({ line }) => line.render.demo),
      partial: missing.length > 0, missingLineCount: missing.length
    };
    project.production.exportIds.push(exportId);
    project.production.exports ||= [];
    project.production.exports.push(record);
    project.production.lastExport = record;
    update(100, '导出完成');
    return record;
  });
}
