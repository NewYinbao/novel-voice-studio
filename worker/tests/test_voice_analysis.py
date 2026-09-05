from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

import voice_analysis
from voice_analysis import (
    FunASRVoiceAnalysisProvider,
    VoiceAnalysisError,
    VoiceAnalysisRequest,
    _overlap_ranges,
    _emotion_was_detected,
    _parse_sensevoice_text,
    _sentence_items,
    validate_analysis_paths,
    voice_analysis_capabilities,
)


def make_silent_wav(path: Path, seconds: float, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"\0\0" * max(1, int(seconds * sample_rate)))


class FakeAnalysisModel:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[dict[str, object]] = []

    def generate(self, **kwargs: object) -> list[dict[str, object]]:
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("test inference failure")
        if isinstance(kwargs.get("input"), list):
            return [
                {"text": "<|zh|><|NEUTRAL|><|Speech|>补充片段"}
                for _item in kwargs["input"]
            ]
        return [{
            "sentence_info": [
                {
                    "start": 0,
                    "end": 1000,
                    "spk": 0,
                    "text": "<|zh|><|NEUTRAL|><|Speech|>欢迎收听",
                    "confidence": 0.91,
                },
                {
                    "start": 800,
                    "end": 1800,
                    "spk": 1,
                    "sentence": "<|zh|><|HAPPY|><|Speech|>大家好",
                    "confidence": 0.87,
                },
                {
                    "start": 1900,
                    "end": 2400,
                    "spk": 0,
                    "sentence": "补充片段",
                    "confidence": 0.9,
                },
            ],
        }]


class VoiceAnalysisTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="nvs-voice-analysis-")
        self.data_root = Path(self.temp.name).resolve()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def source_path(self) -> Path:
        return (
            self.data_root / ".tmp" / "voice-sources"
            / "voicesrc_0123456789abcdef" / "source.mp4"
        )

    def output_dir(self, value: str = "voiceanalysis_0123456789abcdef") -> Path:
        return self.data_root / ".tmp" / "voice-analysis" / value

    def request(self) -> VoiceAnalysisRequest:
        return VoiceAnalysisRequest(
            request_id="analysis-1",
            source_path=str(self.source_path()),
            output_dir=str(self.output_dir()),
            language="zh-CN",
            speaker_count=2,
        )

    def test_request_rejects_invalid_speaker_count(self) -> None:
        with self.assertRaises(ValidationError):
            VoiceAnalysisRequest(
                request_id="bad",
                source_path="source.wav",
                output_dir="result",
                speaker_count=0,
            )

    def test_paths_are_limited_and_existing_output_is_rejected(self) -> None:
        source = self.source_path()
        source.parent.mkdir(parents=True)
        source.write_bytes(b"media")
        resolved_source, resolved_output = validate_analysis_paths(self.request(), self.data_root)
        self.assertEqual(resolved_source, source)
        self.assertEqual(resolved_output, self.output_dir())

        self.output_dir().mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            validate_analysis_paths(self.request(), self.data_root)

    def test_path_outside_dedicated_directory_is_rejected(self) -> None:
        source = self.source_path()
        source.parent.mkdir(parents=True)
        source.write_bytes(b"media")
        request = self.request().model_copy(update={
            "output_dir": str(self.data_root / ".tmp" / "other" / "voiceanalysis_0123456789abcdef")
        })
        with self.assertRaisesRegex(ValueError, "专用音频分析"):
            validate_analysis_paths(request, self.data_root)

    def test_capabilities_report_missing_dependencies_without_faking_results(self) -> None:
        with patch.object(voice_analysis.shutil, "which", return_value="tool"), patch.object(
            voice_analysis, "_module_available", side_effect=lambda name: name == "torch"
        ), patch.object(voice_analysis, "_pyannote_source", return_value=(None, "需要令牌")):
            capabilities = voice_analysis_capabilities()
        self.assertFalse(capabilities["ready"])
        self.assertFalse(capabilities["asr"])
        self.assertFalse(capabilities["diarization"])
        self.assertFalse(capabilities["emotion"])
        self.assertFalse(capabilities["overlap_detection"])
        self.assertIn("funasr", capabilities["missing_dependencies"])

    def test_sensevoice_tags_and_sentence_structure_are_preserved(self) -> None:
        text, emotion = _parse_sensevoice_text("<|zh|><|SAD|><|Speech|>慢慢说。")
        self.assertEqual(text, "慢慢说。")
        self.assertEqual(emotion, "sad")
        segments = _sentence_items(FakeAnalysisModel().generate(), 2000)
        self.assertEqual(segments[0]["emotion"], "neutral")
        self.assertEqual(segments[1]["raw_speaker"], "1")
        self.assertEqual(segments[1]["transcript_confidence"], 0.87)
        self.assertFalse(_emotion_was_detected([{"emotion": "unknown"}]))

    def test_overlap_ranges_only_include_simultaneous_real_tracks(self) -> None:
        overlaps = _overlap_ranges([
            (0.0, 1.2, "A"),
            (0.8, 1.8, "B"),
            (2.0, 2.5, "A"),
        ])
        self.assertEqual(overlaps, [{
            "start_ms": 800,
            "end_ms": 1200,
            "raw_speakers": ["A", "B"],
        }])

    def test_full_analysis_groups_speakers_and_lists_real_overlap(self) -> None:
        source = self.source_path()
        source.parent.mkdir(parents=True)
        source.write_bytes(b"fake video")
        provider = FunASRVoiceAnalysisProvider(self.data_root / "models")
        provider.model = FakeAnalysisModel()

        def fake_normalize(_source: Path, target: Path, _ffmpeg: str) -> None:
            make_silent_wav(target, 2, 16000)

        def fake_extract(
            _source: Path,
            target: Path,
            start_ms: int,
            end_ms: int,
            _ffmpeg: str,
        ) -> None:
            make_silent_wav(target, (end_ms - start_ms) / 1000, 24000)

        tracks = [(0.0, 1.2, "A"), (0.8, 1.8, "B"), (1.9, 2.4, "A")]
        with patch.object(voice_analysis, "_resolve_media_tools", return_value=("ffmpeg", "ffprobe")), patch.object(
            voice_analysis, "_normalize_source", side_effect=fake_normalize
        ), patch.object(voice_analysis, "_probe_duration", return_value=2.5), patch.object(
            voice_analysis, "_extract_clip", side_effect=fake_extract
        ), patch.object(provider, "_detect_overlaps", return_value=(tracks, None)):
            result = provider.analyze(self.request(), self.data_root)

        self.assertTrue(result["capabilities"]["overlap_detection"])
        self.assertEqual(provider.model.calls[0]["preset_spk_num"], 2)
        self.assertEqual(len(result["speakers"]), 2)
        self.assertEqual(len(result["overlaps"]), 1)
        self.assertEqual(result["overlaps"][0]["start_ms"], 800)
        self.assertEqual(result["overlaps"][0]["end_ms"], 1200)
        self.assertEqual(result["speakers"][0]["segments"][0]["text"], "欢迎收听")
        self.assertTrue(Path(result["speakers"][0]["merged_audio_path"]).is_file())
        self.assertTrue(result["capabilities"]["emotion"])
        overlap_segments = [
            segment
            for speaker in result["speakers"]
            for segment in speaker["segments"]
            if segment["overlap"]
        ]
        self.assertTrue(overlap_segments)
        self.assertTrue(all(segment["clean_parts"] == [] for segment in overlap_segments))
        self.assertTrue(all(segment["excluded_from_reference"] for segment in overlap_segments))
        clean_segments = [
            clean
            for speaker in result["speakers"]
            for clean in speaker["clean_segments"]
        ]
        self.assertTrue(clean_segments)
        self.assertEqual(clean_segments[0]["transcript_confidence"], 0.9)
        self.assertTrue(all(Path(item["audio_path"]).is_file() for item in clean_segments))
        self.assertTrue(all(not (item["start_ms"] < 1200 and item["end_ms"] > 800) for item in clean_segments))
        enriched = next(
            segment
            for speaker in result["speakers"]
            for segment in speaker["segments"]
            if segment["text"] == "补充片段"
        )
        self.assertEqual(enriched["emotion"], "neutral")

    def test_analysis_failure_removes_only_new_output_directory(self) -> None:
        source = self.source_path()
        source.parent.mkdir(parents=True)
        source.write_bytes(b"original source")
        provider = FunASRVoiceAnalysisProvider(self.data_root / "models")
        provider.model = FakeAnalysisModel(fail=True)

        def fake_normalize(_source: Path, target: Path, _ffmpeg: str) -> None:
            make_silent_wav(target, 2, 16000)

        with patch.object(voice_analysis, "_resolve_media_tools", return_value=("ffmpeg", "ffprobe")), patch.object(
            voice_analysis, "_normalize_source", side_effect=fake_normalize
        ), patch.object(voice_analysis, "_probe_duration", return_value=2.0):
            with self.assertRaisesRegex(VoiceAnalysisError, "FunASR 推理失败"):
                provider.analyze(self.request(), self.data_root)

        self.assertFalse(self.output_dir().exists())
        self.assertEqual(source.read_bytes(), b"original source")


if __name__ == "__main__":
    unittest.main()
