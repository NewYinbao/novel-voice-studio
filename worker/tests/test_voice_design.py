from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import server
from providers.qwen3_tts import (
    VOICE_DESIGN_MODEL_ID,
    Qwen3VoiceDesignProvider,
)


class FakeVoiceDesignModel:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def generate_voice_design(self, **kwargs: object) -> tuple[list[np.ndarray], int]:
        self.calls.append(kwargs)
        return [np.zeros(2400, dtype=np.float32)], 24000


class VoiceDesignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="nvs-voice-design-")
        self.data_root = Path(self.temp.name).resolve()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def output_path(self, design_id: str = "voicedesign_0123456789abcdef") -> Path:
        return self.data_root / ".tmp" / "voice-clips" / design_id / "reference.wav"

    def request(self, output_path: Path) -> SimpleNamespace:
        return SimpleNamespace(
            request_id="design-1",
            model_id=VOICE_DESIGN_MODEL_ID,
            text="欢迎收听今天的节目。",
            prompt="沉稳、清晰、专业的中文新闻男播音员",
            language="zh-CN",
            output_path=str(output_path),
        )

    def test_output_path_is_limited_to_dedicated_tmp_directory(self) -> None:
        target = self.output_path()
        target.parent.mkdir(parents=True)
        with patch.object(server, "DATA_DIR", self.data_root):
            self.assertEqual(server.validate_voice_design_output(str(target)), str(target))
            with self.assertRaisesRegex(ValueError, "专用 VoiceDesign"):
                server.validate_voice_design_output(
                    str(self.data_root / ".tmp" / "voice-clips" / "wrong" / "reference.wav")
                )

    def test_existing_output_is_never_overwritten(self) -> None:
        target = self.output_path()
        target.parent.mkdir(parents=True)
        original = b"existing"
        target.write_bytes(original)
        with patch.object(server, "DATA_DIR", self.data_root):
            with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
                server.validate_voice_design_output(str(target))
        self.assertEqual(target.read_bytes(), original)

    def test_provider_calls_voice_design_and_writes_pcm_wav(self) -> None:
        model = FakeVoiceDesignModel()
        provider = Qwen3VoiceDesignProvider(VOICE_DESIGN_MODEL_ID, self.data_root / "models")
        provider.model = model
        target = self.output_path()

        result = provider.synthesize(self.request(target))

        self.assertEqual(result["output_path"], str(target))
        self.assertEqual(result["audio_path"], str(target))
        self.assertEqual(result["sample_rate"], 24000)
        self.assertEqual(result["channels"], 1)
        self.assertTrue(target.is_file())
        self.assertEqual(model.calls[0]["instruct"], "沉稳、清晰、专业的中文新闻男播音员")
        self.assertEqual(model.calls[0]["language"], "Chinese")
        self.assertEqual(list(target.parent.glob("*.partial")), [])

    def test_provider_allowlist_is_exact(self) -> None:
        provider = Qwen3VoiceDesignProvider("some/other-model", self.data_root / "models")
        provider.model = FakeVoiceDesignModel()
        with self.assertRaisesRegex(ValueError, "允许清单"):
            provider.synthesize(self.request(self.output_path()))

    def test_engine_manager_lazily_loads_one_voice_design_model(self) -> None:
        instances: list[object] = []

        class FakeProvider:
            def __init__(self, model_id: str, model_root: Path) -> None:
                self.model_id = model_id
                self.loads = 0
                self.calls = 0
                self.unloads = 0
                instances.append(self)

            def load(self) -> None:
                self.loads += 1

            def synthesize(self, request: object) -> dict[str, object]:
                self.calls += 1
                return {"ok": True}

            def unload(self) -> None:
                self.unloads += 1

        manager = server.EngineManager()
        request = server.VoiceDesignRequest(
            request_id="design-1",
            text="测试文本",
            prompt="专业播音腔",
            output_path=str(self.output_path()),
        )
        with patch.object(server, "Qwen3VoiceDesignProvider", FakeProvider):
            manager.design_voice(request)
            manager.design_voice(request)

        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0].loads, 1)
        self.assertEqual(instances[0].calls, 2)


if __name__ == "__main__":
    unittest.main()
