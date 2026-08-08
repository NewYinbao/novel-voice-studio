from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


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
