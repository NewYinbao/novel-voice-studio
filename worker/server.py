from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

from providers.cosyvoice import CosyVoiceProvider
from providers.qwen3_tts import Qwen3TTSProvider


WORKER_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("NVS_DATA_DIR", WORKER_DIR.parent / "data")).resolve()
MODEL_ROOT = Path(os.environ.get("NVS_MODEL_DIR", WORKER_DIR / "models")).resolve()
NUMBA_CACHE_DIR = Path(os.environ.get("NUMBA_CACHE_DIR", WORKER_DIR.parent / ".runtime" / "numba-cache")).resolve()
os.environ.setdefault("NUMBA_CACHE_DIR", str(NUMBA_CACHE_DIR))
ENV_BIN_DIRS = [Path(sys.prefix), Path(sys.prefix) / "Scripts", Path(sys.prefix) / "Library" / "bin", Path(sys.prefix) / "Library" / "usr" / "bin"]
os.environ["PATH"] = os.pathsep.join([*(str(item) for item in ENV_BIN_DIRS if item.exists()), os.environ.get("PATH", "")])
HOST = os.environ.get("NVS_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("NVS_WORKER_PORT", "7861"))


class TTSRequest(BaseModel):
    request_id: str
    engine: Literal["cosyvoice", "qwen3_tts", "indextts2", "gpt_sovits", "fishspeech"]
    model_id: str
    text: str = Field(min_length=1, max_length=5000)
    language: str = "zh-CN"
    emotion: str = "neutral"
    emotion_note: str = Field(default="", max_length=200)
    intensity: float = Field(default=0.5, ge=0, le=1)
    pace: float = Field(default=1, ge=0.6, le=1.6)
    reference_audio: str | None = None
    reference_text: str | None = None
    output_path: str

    @field_validator("output_path")
    @classmethod
    def validate_output(cls, value: str) -> str:
        target = Path(value).resolve()
        if DATA_DIR not in target.parents:
            raise ValueError("输出路径必须位于应用数据目录")
        if target.suffix.lower() != ".wav":
            raise ValueError("工作器输出必须为 WAV")
        return str(target)

    @field_validator("reference_audio")
    @classmethod
    def validate_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        target = Path(value).resolve()
        if DATA_DIR not in target.parents:
            raise ValueError("参考音频必须位于应用数据目录")
        if not target.is_file():
            raise ValueError("参考音频不存在")
        return str(target)


PROVIDERS = {
    "cosyvoice": CosyVoiceProvider,
    "qwen3_tts": Qwen3TTSProvider,
}

ALLOWED_MODELS = {
    "cosyvoice": {"FunAudioLLM/Fun-CosyVoice3-0.5B-2512"},
    "qwen3_tts": {
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    },
}


class EngineManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.provider = None
        self.key: tuple[str, str] | None = None

    def synthesize(self, request: TTSRequest) -> dict[str, Any]:
        provider_class = PROVIDERS.get(request.engine)
        if provider_class is None:
            raise RuntimeError(
                f"工作器尚未安装 {request.engine} 适配器；当前内置 cosyvoice 与 qwen3_tts"
            )
        if request.model_id not in ALLOWED_MODELS.get(request.engine, set()):
            raise ValueError(f"模型未列入本地工作器允许清单：{request.model_id}")
        if request.reference_audio:
            request = request.model_copy(update={
                "reference_audio": normalize_reference_audio(request.reference_audio)
            })
        with self.lock:
            key = (request.engine, request.model_id)
            if self.key != key:
                if self.provider is not None:
                    self.provider.unload()
                self.provider = None
                self.key = None
                candidate = provider_class(request.model_id, MODEL_ROOT)
                try:
                    candidate.load()
                except Exception:
                    candidate.unload()
                    raise
                self.provider = candidate
                self.key = key
            return self.provider.synthesize(request)

    @property
    def loaded_engine(self) -> str | None:
        return self.key[0] if self.key else None


manager = EngineManager()
app = FastAPI(title="声绘 Studio TTS Worker", version="0.1.0")


def normalize_reference_audio(source: str) -> str:
    path = Path(source).resolve()
    if path.suffix.lower() == ".wav":
        return str(path)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("参考录音不是 WAV，且模型环境中没有 FFmpeg 可用于转换")
    target = path.with_name(path.stem + ".normalized.wav")
    if target.exists() and target.stat().st_mtime_ns >= path.stat().st_mtime_ns:
        return str(target)
    partial = target.with_suffix(".wav.partial")
    command = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(path), "-vn", "-ac", "1", "-ar", "24000",
        "-c:a", "pcm_s16le", "-f", "wav", str(partial),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    if completed.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"参考音频转换失败：{completed.stderr.strip()[-500:]}")
    partial.replace(target)
    return str(target)


def torch_status() -> dict[str, Any]:
    if importlib.util.find_spec("torch") is None:
        return {"installed": False, "cuda": False}
    try:
        import torch

        result: dict[str, Any] = {
            "installed": True,
            "version": torch.__version__,
            "cuda": torch.cuda.is_available(),
            "cuda_build": torch.version.cuda,
        }
        if torch.cuda.is_available():
            result.update(
                gpu=torch.cuda.get_device_name(0),
                capability=".".join(map(str, torch.cuda.get_device_capability(0))),
            )
        return result
    except Exception as error:
        return {"installed": True, "cuda": False, "error": str(error)}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "platform": platform.platform(),
        "loaded_engine": manager.loaded_engine,
        "torch": torch_status(),
        "providers": {
            "cosyvoice": importlib.util.find_spec("cosyvoice") is not None
            or (WORKER_DIR / "vendor" / "CosyVoice" / "cosyvoice").exists(),
            "qwen3_tts": importlib.util.find_spec("qwen_tts") is not None,
        },
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }


@app.post("/v1/tts")
def synthesize(request: TTSRequest) -> dict[str, Any]:
    try:
        return manager.synthesize(request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        message = str(error)
        code = "GPU_OOM" if "out of memory" in message.lower() else "TTS_FAILED"
        raise HTTPException(status_code=503, detail=f"{code}: {message}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"TTS_FAILED: {error}") from error


if __name__ == "__main__":
    import uvicorn

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    NUMBA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
