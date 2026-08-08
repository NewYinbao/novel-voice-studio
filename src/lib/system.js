import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recommendEngine, TTS_ENGINES } from './config.js';

const execFileAsync = promisify(execFile);

async function run(command, args = [], timeout = 4000) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.code
    };
  }
}

async function probeCommand(command, versionArgs = ['--version']) {
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\r\n\0]/.test(command)) {
    return { found: false, runnable: false, version: null, path: null, error: '命令格式无效' };
  }
  const version = await run(command, versionArgs, 3500);
  return {
    found: version.ok || !['ENOENT', 'UNKNOWN'].includes(String(version.code || '').toUpperCase()),
    runnable: version.ok,
    version: (version.stdout || version.stderr).split(/\r?\n/)[0] || null,
    path: command,
    error: version.ok ? null : version.stderr
  };
}

async function probeGpu() {
  const result = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free,driver_version,compute_cap',
    '--format=csv,noheader,nounits'
  ]);
  if (!result.ok || !result.stdout) return { available: false, name: '未检测到 NVIDIA GPU', vramGb: 0 };
  const [name, memoryMb, freeMb, driver, computeCapability] = result.stdout.split(/\s*,\s*/);
  return {
    available: true,
    name,
    vramGb: Math.round((Number(memoryMb) / 1024) * 10) / 10,
    freeVramGb: Math.round((Number(freeMb) / 1024) * 10) / 10,
    driver,
    computeCapability
  };
}

async function probeWorker(url) {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { online: true, ...data };
  } catch (error) {
    return { online: false, error: error.message };
  }
}

let cachedProfile;
let cachedAt = 0;

export async function getSystemProfile(settings, { refresh = false } = {}) {
  if (!refresh && cachedProfile && Date.now() - cachedAt < 15_000) return cachedProfile;
  const [gpu, ffmpeg, python, uv, codex, worker] = await Promise.all([
    probeGpu(),
    probeCommand('ffmpeg', ['-version']),
    probeCommand('python', ['--version']),
    probeCommand('uv', ['--version']),
    probeCommand(settings.codexCommand || 'codex', ['--version']),
    probeWorker(settings.workerUrl)
  ]);
  const base = {
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: { name: os.cpus()[0]?.model || '未知 CPU', cores: os.cpus().length },
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeRamGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    gpu,
    tools: { ffmpeg, python, uv, codex },
    worker,
    detectedAt: new Date().toISOString()
  };
  const recommended = recommendEngine(base, settings.qualityMode);
  cachedProfile = {
    ...base,
    recommendedEngineId: recommended.id,
    readiness: {
      app: true,
      gpu: gpu.available,
      worker: worker.online,
      ffmpeg: ffmpeg.runnable,
      codex: codex.runnable
    }
  };
  cachedAt = Date.now();
  return cachedProfile;
}

export function engineCompatibility(profile, selectedEngine = 'auto', qualityMode = 'balanced') {
  const recommended = recommendEngine(profile, qualityMode);
  return TTS_ENGINES.map((engine) => {
    const hardwareCompatible = profile.gpu.vramGb >= engine.minVramGb && profile.ramGb >= engine.minRamGb;
    const installed = !profile.worker?.online || profile.worker.providers?.[engine.workerProvider] !== false;
    const compatible = hardwareCompatible && engine.availableInWorker && installed;
    return {
      ...engine,
      compatible,
      selected: (selectedEngine === 'auto' ? recommended.id : selectedEngine) === engine.id,
      reason: !engine.availableInWorker
        ? '模型已列入规划，当前版本尚未内置工作器适配器'
        : !installed
          ? '当前工作器未安装这个模型提供器'
        : compatible
        ? `适配当前 ${profile.gpu.vramGb}GB 显存 / ${profile.ramGb}GB 内存`
        : `至少需要 ${engine.minVramGb || 0}GB 显存 / ${engine.minRamGb}GB 内存`
    };
  });
}
