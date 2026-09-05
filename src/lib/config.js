import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = path.resolve(process.env.NVS_DATA_DIR || path.join(ROOT_DIR, 'data'));
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const VOICES_DIR = path.join(DATA_DIR, 'voices');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const TMP_DIR = path.join(DATA_DIR, '.tmp');
export const VOICE_SOURCES_DIR = path.join(TMP_DIR, 'voice-sources');
export const VOICE_CLIPS_DIR = path.join(TMP_DIR, 'voice-clips');
export const VOICE_ANALYSIS_JOBS_DIR = path.join(TMP_DIR, 'voice-analysis');
export const VOICE_ANALYSES_DIR = path.join(DATA_DIR, 'voice-analyses');
export const VOICE_DESIGNS_DIR = path.join(DATA_DIR, 'voice-designs');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const SCRIPT_SCHEMA_PATH = path.join(ROOT_DIR, 'schemas', 'audiobook-script.schema.json');

export const MAX_JSON_BYTES = 40 * 1024 * 1024;
export const MAX_BOOK_BYTES = 30 * 1024 * 1024;
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;
export const MAX_VOICE_SOURCE_BYTES = 1024 * 1024 * 1024;
export const MIN_VOICE_CLIP_MS = 3_000;
export const MAX_VOICE_CLIP_MS = 60_000;
export const MAX_VOICE_ANALYSIS_SPEAKERS = 20;
export const MAX_VOICE_ANALYSIS_SEGMENTS = 5000;
export const MAX_VOICE_ANALYSIS_OVERLAPS = 1000;
export const MAX_VOICE_ANALYSIS_DURATION_MS = 12 * 60 * 60_000;
export const MAX_VOICE_ANALYSIS_WORKSPACE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_VOICE_EXPORT_MS = 5 * 60_000;

export const EMOTIONS = [
  { id: 'neutral', label: '平静', glyph: '—' },
  { id: 'warm', label: '温柔', glyph: '☼' },
  { id: 'joy', label: '喜悦', glyph: '⌣' },
  { id: 'sad', label: '悲伤', glyph: '◡' },
  { id: 'angry', label: '愤怒', glyph: 'ϟ' },
  { id: 'fear', label: '恐惧', glyph: '!' },
  { id: 'surprise', label: '惊讶', glyph: '✦' },
  { id: 'whisper', label: '耳语', glyph: '≈' },
  { id: 'solemn', label: '庄重', glyph: '◆' }
];

// “speedScore” is a relative product score, not a benchmark. Hardware gating is
// intentionally conservative because the UI and CUDA driver also use VRAM.
export const TTS_ENGINES = [
  {
    id: 'cosyvoice3',
    availableInWorker: true,
    name: 'CosyVoice 3 · 0.5B',
    badge: '均衡推荐',
    summary: '中文自然度、速度和指令情感控制兼顾，支持零样本音色复刻与流式合成。',
    minVramGb: 8,
    idealVramGb: 12,
    minRamGb: 15,
    qualityScore: 94,
    speedScore: 91,
    supports: ['中文', '多语种', '零样本复刻', '情感指令', '流式'],
    license: 'Apache-2.0（代码与官方模型卡）',
    workerProvider: 'cosyvoice',
    modelId: 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512'
  },
  {
    id: 'indextts2',
    availableInWorker: false,
    name: 'IndexTTS 2',
    badge: '效果优先',
    summary: '角色表演感与音色/情绪解耦突出，适合重点对白与高情绪章节。',
    minVramGb: 8,
    idealVramGb: 16,
    minRamGb: 15,
    qualityScore: 97,
    speedScore: 73,
    supports: ['中文', '零样本复刻', '情绪参考', '情绪向量'],
    license: 'Index Model License 2.2（商用有额外规模阈值与下游约束）',
    workerProvider: 'indextts2',
    modelId: 'IndexTeam/IndexTTS-2'
  },
  {
    id: 'qwen3-tts',
    availableInWorker: true,
    name: 'Qwen3-TTS · 0.6B / 1.7B',
    badge: '音色设计',
    summary: '支持三秒克隆和文字描述设计角色音色，克隆与指令能力按 checkpoint 路由。',
    minVramGb: 8,
    idealVramGb: 12,
    minRamGb: 15,
    qualityScore: 93,
    speedScore: 89,
    supports: ['中文', '多语种', '三秒克隆', '文字设计音色', '流式'],
    license: 'Apache-2.0',
    workerProvider: 'qwen3_tts',
    modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
  },
  {
    id: 'fishspeech',
    availableInWorker: false,
    name: 'Fish Speech',
    badge: '细节优先',
    summary: '音色相似度和韵律细节强，显存与部署成本较高。',
    minVramGb: 24,
    idealVramGb: 24,
    minRamGb: 32,
    qualityScore: 96,
    speedScore: 70,
    supports: ['中文', '多语种', '零样本复刻', '细腻韵律'],
    license: 'Fish Audio Research License（商用必须另行书面授权）',
    workerProvider: 'fishspeech',
    modelId: 'fishaudio/fish-speech-2-pro'
  },
  {
    id: 'gpt-sovits',
    availableInWorker: false,
    name: 'GPT-SoVITS',
    badge: '轻量兼容',
    summary: '中文生态成熟、少样本微调灵活，适合 6–8GB 显存设备。',
    minVramGb: 6,
    idealVramGb: 8,
    minRamGb: 12,
    qualityScore: 88,
    speedScore: 82,
    supports: ['中文', '多语种', '零样本复刻', '少样本训练'],
    license: 'MIT（代码；底模与数据条款另行确认）',
    workerProvider: 'gpt_sovits',
    modelId: 'RVC-Boss/GPT-SoVITS'
  },
  {
    id: 'kokoro',
    availableInWorker: false,
    name: 'Kokoro · 82M',
    badge: 'CPU / 极速',
    summary: '资源占用低、生成快，适合旁白草稿；不提供真正的零样本声音克隆。',
    minVramGb: 0,
    idealVramGb: 2,
    minRamGb: 8,
    qualityScore: 78,
    speedScore: 98,
    supports: ['中文', '内置多音色', 'CPU 可用'],
    license: 'Apache-2.0（以官方模型卡为准）',
    workerProvider: 'kokoro',
    modelId: 'hexgrad/Kokoro-82M'
  }
];

export const DEFAULT_SETTINGS = {
  version: 1,
  theme: 'dark',
  selectedEngine: 'auto',
  qualityMode: 'balanced',
  workerUrl: 'http://127.0.0.1:7861',
  codexCommand: 'codex',
  codexModel: 'gpt-5.6-terra',
  codexReasoningEffort: 'medium',
  scriptProvider: 'rules',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  exportFormat: 'wav',
  sampleRate: 24000,
  normalizeLufs: -16,
  consentRequired: true
};

export function recommendEngine(profile, qualityMode = 'balanced') {
  const vram = Number(profile?.gpu?.vramGb || 0);
  const ram = Number(profile?.ramGb || 0);
  const providerReady = (engine) => !profile?.worker?.online || profile.worker.providers?.[engine.workerProvider] !== false;
  const available = TTS_ENGINES.filter((engine) => engine.availableInWorker && providerReady(engine) && vram >= engine.minVramGb && ram >= engine.minRamGb);
  const candidates = available.length ? available : [TTS_ENGINES.find((engine) => engine.availableInWorker)];
  const weights = qualityMode === 'quality'
    ? { quality: 0.78, speed: 0.22 }
    : qualityMode === 'speed'
      ? { quality: 0.32, speed: 0.68 }
      : { quality: 0.56, speed: 0.44 };

  return [...candidates].sort((a, b) => {
    const aHeadroom = vram >= a.idealVramGb ? 4 : 0;
    const bHeadroom = vram >= b.idealVramGb ? 4 : 0;
    const aScore = a.qualityScore * weights.quality + a.speedScore * weights.speed + aHeadroom;
    const bScore = b.qualityScore * weights.quality + b.speedScore * weights.speed + bHeadroom;
    return bScore - aScore;
  })[0];
}
