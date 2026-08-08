import os from 'node:os';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
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

export async function probeCommand(command, versionArgs = ['--version']) {
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

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0] || null;
}

function commandErrorState(result) {
  const code = String(result.code || '').toUpperCase();
  return ['ENOENT', 'UNKNOWN'].includes(code) ? 'missing' : 'blocked';
}

function codexResult(command, state, { version = null, error = null, source = 'configured' } = {}) {
  const found = state !== 'missing';
  return {
    found,
    runnable: state === 'ready',
    version,
    path: command || null,
    command: command || null,
    resolvedCommand: command || null,
    resolvedPath: command || null,
    state,
    source,
    error
  };
}

export async function discoverLocalCodexCandidates(localAppData = process.env.LOCALAPPDATA) {
  if (typeof localAppData !== 'string' || !localAppData.trim()) return [];
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    const entries = await fs.readdir(binRoot, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = path.join(binRoot, entry.name, 'codex.exe');
        try {
          const stats = await fs.stat(candidate);
          return stats.isFile() ? { candidate, modifiedAt: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      }));
    return candidates
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.candidate.localeCompare(right.candidate))
      .map((item) => item.candidate);
  } catch {
    return [];
  }
}

export async function probeCodexCommand(command, { source = 'configured' } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\r\n\0]/.test(command)) {
    return codexResult(null, 'missing', { error: 'Codex 命令格式无效', source });
  }
  const normalized = command.trim();
  const versionProbe = await run(normalized, ['--version'], 3500);
  if (!versionProbe.ok) {
    const state = commandErrorState(versionProbe);
    return codexResult(normalized, state, {
      error: versionProbe.stderr || (state === 'missing' ? '未找到 Codex CLI' : 'Codex CLI 无法启动'),
      source
    });
  }

  const version = firstLine(versionProbe.stdout || versionProbe.stderr);
  const loginProbe = await run(normalized, ['login', 'status'], 5000);
  if (loginProbe.ok) return codexResult(normalized, 'ready', { version, source });

  const loginError = loginProbe.stderr || loginProbe.stdout || 'Codex CLI 登录状态检测失败';
  const code = String(loginProbe.code || '').toUpperCase();
  const unsupported = /(?:unexpected|unrecognized|unknown)\s+(?:argument|command|subcommand)|invalid\s+subcommand/i.test(loginError);
  const state = ['EPERM', 'EACCES', 'ENOENT', 'UNKNOWN'].includes(code) || unsupported ? 'blocked' : 'authRequired';
  return codexResult(normalized, state, {
    version,
    error: state === 'authRequired' ? 'Codex CLI 尚未登录，请先完成 Codex CLI 登录。' : loginError,
    source
  });
}

export async function probeCodex(configuredCommand, {
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  localCandidates
} = {}) {
  const configured = typeof configuredCommand === 'string' ? configuredCommand.trim() : '';
  const command = configured || 'codex';
  const mayUseWindowsFallback = platform === 'win32' && (!configured || ['codex', 'codex.exe'].includes(configured.toLowerCase()));
  const probes = [await probeCodexCommand(command, { source: 'configured' })];
  if (probes[0].state === 'ready' || !mayUseWindowsFallback) return probes[0];

  const discovered = Array.isArray(localCandidates)
    ? localCandidates
    : await discoverLocalCodexCandidates(localAppData);
  const seen = new Set([command.toLowerCase()]);
  for (const candidate of discovered) {
    if (typeof candidate !== 'string' || seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    const probe = await probeCodexCommand(candidate, { source: 'localAppData' });
    probes.push(probe);
    if (probe.state === 'ready') return probe;
  }

  const priority = { authRequired: 3, blocked: 2, missing: 1 };
  return probes.sort((left, right) => (priority[right.state] || 0) - (priority[left.state] || 0))[0];
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
    probeCodex(settings.codexCommand),
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
