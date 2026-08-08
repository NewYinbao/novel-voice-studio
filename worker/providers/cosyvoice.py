from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from .base import TTSProvider, atomic_audio_target


EMOTION_INSTRUCTIONS = {
    "neutral": "请用自然、清晰、平静的语气朗读。",
    "warm": "请用温柔、亲近、带有暖意的语气朗读。",
    "joy": "请用喜悦、明快、自然带笑意的语气朗读。",
    "sad": "请用克制的悲伤语气朗读，不要过度哭腔。",
    "angry": "请用愤怒、坚定且有爆发力的语气朗读，保持吐字清楚。",
    "fear": "请用紧张、恐惧、略带颤抖的语气朗读。",
    "surprise": "请用惊讶、略带激动的语气朗读。",
    "whisper": "请压低音量，用贴近耳语但仍清晰的语气朗读。",
    "solemn": "请用庄重、沉稳、有分量的语气朗读。",
}


class CosyVoiceProvider(TTSProvider):
    provider_id = "cosyvoice"

    def __init__(self, model_id: str, model_root: Path) -> None:
        super().__init__(model_id, model_root)
        self.model = None

    def _resolve_paths(self) -> tuple[Path, Path]:
        worker_root = Path(__file__).resolve().parents[1]
        repo = Path(os.environ.get("COSYVOICE_REPO", worker_root / "vendor" / "CosyVoice")).resolve()
        configured = os.environ.get("COSYVOICE_MODEL_DIR")
        candidates = [
            Path(configured).resolve() if configured else None,
            self.model_root / "Fun-CosyVoice3-0.5B",
            self.model_root / "Fun-CosyVoice3-0.5B-2512",
        ]
        model_dir = next((item for item in candidates if item and item.exists()), candidates[1])
        return repo, model_dir

    def load(self) -> None:
        repo, model_dir = self._resolve_paths()
        if not repo.exists():
            raise RuntimeError(f"CosyVoice 仓库不存在：{repo}。请先运行安装脚本。")
        if not model_dir.exists():
            raise RuntimeError(f"CosyVoice3 模型不存在：{model_dir}。请先下载模型。")
        matcha = repo / "third_party" / "Matcha-TTS"
        for candidate in (str(repo), str(matcha)):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)

        from cosyvoice.cli.cosyvoice import AutoModel

        self.model = AutoModel(
            model_dir=str(model_dir),
            load_trt=False,
            load_vllm=False,
            fp16=True,
            trt_concurrent=1,
        )

    def synthesize(self, request: Any) -> dict[str, Any]:
        if self.model is None:
            self.load()
        if not request.reference_audio:
            raise ValueError("CosyVoice3 零样本复刻需要参考音频")
        if not request.reference_text:
            raise ValueError("CosyVoice3 零样本复刻需要参考音频的准确文字")

        import torch
        import soundfile as sf

        speed = max(0.7, min(1.35, float(request.pace)))
        emotion_instruction = EMOTION_INSTRUCTIONS.get(request.emotion, EMOTION_INSTRUCTIONS["neutral"])
        if request.emotion_note:
            emotion_instruction += f" 表演补充：{request.emotion_note[:100]}。"
        emotion_instruction += f" 情绪强度约为百分之{round(request.intensity * 100)}。"

        if request.emotion == "neutral" and not request.emotion_note:
            iterator = self.model.inference_zero_shot(
                request.text,
                "You are a helpful assistant.<|endofprompt|>" + request.reference_text,
                request.reference_audio,
                zero_shot_spk_id="",
                stream=False,
                speed=speed,
                text_frontend=True,
            )
        else:
            iterator = self.model.inference_instruct2(
                request.text,
                "You are a helpful assistant. " + emotion_instruction + "<|endofprompt|>",
                request.reference_audio,
                zero_shot_spk_id="",
                stream=False,
                speed=speed,
                text_frontend=True,
            )
        chunks = [item["tts_speech"] for item in iterator]
        if not chunks:
            raise RuntimeError("CosyVoice3 没有返回音频")
        waveform = torch.cat(chunks, dim=1).detach().cpu()
        target, partial = atomic_audio_target(request.output_path)
        sf.write(
            str(partial),
            waveform.squeeze(0).numpy(),
            self.model.sample_rate,
            format="WAV",
            subtype="PCM_16",
        )
        partial.replace(target)
        duration_ms = round(waveform.shape[-1] / self.model.sample_rate * 1000)
        return {
            "output_path": str(target),
            "duration_ms": duration_ms,
            "sample_rate": self.model.sample_rate,
            "engine": self.provider_id,
            "warnings": [],
        }

    def unload(self) -> None:
        self.model = None
        super().unload()
