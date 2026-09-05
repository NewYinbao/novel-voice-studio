from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any
from uuid import uuid4


class TTSProvider(ABC):
    """Minimal contract implemented by every local model adapter."""

    provider_id = "base"

    def __init__(self, model_id: str, model_root: Path) -> None:
        self.model_id = model_id
        self.model_root = model_root

    @abstractmethod
    def load(self) -> None:
        """Load model weights. Called once, on first request."""

    @abstractmethod
    def synthesize(self, request: Any) -> dict[str, Any]:
        """Synthesize a request and atomically write request.output_path."""

    def unload(self) -> None:
        """Release accelerator memory before another provider is loaded."""
        self._release_cuda()

    @staticmethod
    def _release_cuda() -> None:
        try:
            import gc
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass


def atomic_audio_target(output_path: str) -> tuple[Path, Path]:
    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".partial")
    return target, partial


def exclusive_audio_target(output_path: str) -> tuple[Path, Path]:
    """Reserve a new output path and return a request-unique partial path.

    The empty target is an ownership marker.  Callers must delete it if writing
    fails.  This deliberately refuses to replace a pre-existing user file.
    """

    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("xb"):
            pass
    except FileExistsError as error:
        raise ValueError("输出文件已存在，拒绝覆盖") from error
    partial = target.with_name(f".{target.name}.{uuid4().hex}.partial")
    return target, partial
