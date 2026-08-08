from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .base import TTSProvider, atomic_audio_target


LANGUAGES = {
    "zh": "Chinese", "zh-cn": "Chinese", "zh-tw": "Chinese", "cmn": "Chinese",
    "en": "English", "en-us": "English", "ja": "Japanese", "ko": "Korean",
    "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese",
    "es": "Spanish", "it": "Italian",
}


class Qwen3TTSProvider(TTSProvider):
    provider_id = "qwen3_tts"

    def __init__(self, model_id: str, model_root: Path) -> None:
        super().__init__(model_id, model_root)
        self.model = None
        self.prompt_cache: dict[str, Any] = {}

    def load(self) -> None:
        import torch
        from qwen_tts import Qwen3TTSModel

        local_name = self.model_id.split("/")[-1]
        local_path = self.model_root / local_name
        source = str(local_path) if local_path.exists() else self.model_id
        self.model = Qwen3TTSModel.from_pretrained(
            source,
            device_map="cuda:0" if torch.cuda.is_available() else "cpu",
            dtype=(torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
            if torch.cuda.is_available() else torch.float32,
            # Native SDPA avoids old flash-attn wheels that do not include Blackwell sm_120.
            attn_implementation="sdpa",
        )

    def synthesize(self, request: Any) -> dict[str, Any]:
        if self.model is None:
            self.load()
        if not request.reference_audio:
            raise ValueError("Qwen3-TTS Base 声音克隆需要参考音频")
        if not request.reference_text:
            raise ValueError("高质量 ICL 克隆需要参考音频的准确文字")

        import soundfile as sf

        cache_key = hashlib.sha256(
            (request.reference_audio + "\0" + request.reference_text).encode("utf-8")
        ).hexdigest()
        voice_prompt = self.prompt_cache.get(cache_key)
        if voice_prompt is None:
            voice_prompt = self.model.create_voice_clone_prompt(
                ref_audio=request.reference_audio,
                ref_text=request.reference_text,
                x_vector_only_mode=False,
            )
            self.prompt_cache[cache_key] = voice_prompt

        language = LANGUAGES.get(request.language.lower(), "Auto")
        wavs, sample_rate = self.model.generate_voice_clone(
            text=request.text,
            language=language,
            voice_clone_prompt=voice_prompt,
            non_streaming_mode=True,
        )
        if not wavs:
            raise RuntimeError("Qwen3-TTS 没有返回音频")
        target, partial = atomic_audio_target(request.output_path)
        pace = max(0.6, min(1.6, float(request.pace)))
        if abs(pace - 1.0) > 0.01:
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise RuntimeError("Qwen3-TTS 语速调整需要模型环境中的 FFmpeg")
            source = partial.with_name(partial.name + ".source.wav")
            sf.write(str(source), wavs[0], sample_rate, format="WAV", subtype="PCM_16")
            completed = subprocess.run([
                ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source), "-filter:a", f"atempo={pace:.4f}",
                "-c:a", "pcm_s16le", "-f", "wav", str(partial),
            ], capture_output=True, text=True, timeout=180, check=False)
            source.unlink(missing_ok=True)
            if completed.returncode != 0:
                partial.unlink(missing_ok=True)
                raise RuntimeError(f"Qwen3-TTS 语速调整失败：{completed.stderr.strip()[-500:]}")
        else:
            sf.write(str(partial), wavs[0], sample_rate, format="WAV", subtype="PCM_16")
        partial.replace(target)
        duration_ms = round(sf.info(str(target)).duration * 1000)
        warnings = []
        if request.emotion != "neutral" or request.emotion_note:
            warnings.append("Qwen3-TTS Base 克隆不支持 instruct；情绪主要继承参考音频")
        return {
            "output_path": str(target),
            "duration_ms": duration_ms,
            "sample_rate": sample_rate,
            "engine": self.provider_id,
            "warnings": warnings,
        }

    def unload(self) -> None:
        self.prompt_cache.clear()
        self.model = None
        super().unload()
