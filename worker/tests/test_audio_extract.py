from __future__ import annotations

import math
import subprocess
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from audio_extract import AudioExtractRequest, extract_audio_segment


FFMPEG = Path(sys.prefix) / "Library" / "bin" / "ffmpeg.exe"
FFPROBE = Path(sys.prefix) / "Library" / "bin" / "ffprobe.exe"
HAS_MEDIA_TOOLS = FFMPEG.is_file() and FFPROBE.is_file()


class AudioExtractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="nvs-audio-extract-")
        self.data_root = Path(self.temp.name).resolve()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_tone(self, path: Path, seconds: float = 1.0) -> None:
        sample_rate = 16000
        frame_count = int(sample_rate * seconds)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as output:
            output.setnchannels(2)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            for index in range(frame_count):
                value = int(6000 * math.sin(2 * math.pi * 440 * index / sample_rate))
                output.writeframesraw(struct.pack("<hh", value, value))

    def source_path(self, source_id: str = "voicesrc_0123456789abcdef", extension: str = ".wav") -> Path:
        return self.data_root / ".tmp" / "voice-sources" / source_id / f"source{extension}"

    def target_path(self, clip_id: str = "voiceclip_0123456789abcdef") -> Path:
        return self.data_root / ".tmp" / "voice-clips" / clip_id / "reference.wav"

    def test_request_rejects_reversed_range(self) -> None:
        with self.assertRaises(ValidationError):
            AudioExtractRequest(
                request_id="bad-range",
                source_path="source.wav",
                output_path="clip.wav",
                start_seconds=1,
                end_seconds=1,
            )

    def test_rejects_clip_shorter_than_three_seconds_in_both_layers(self) -> None:
        values = {
            "request_id": "too-short",
            "source_path": "source.wav",
            "output_path": "clip.wav",
            "start_seconds": 0,
            "end_seconds": 2.999,
        }
        with self.assertRaisesRegex(ValidationError, "不得少于 3 秒"):
            AudioExtractRequest(**values)
        unchecked = AudioExtractRequest.model_construct(**values)
        with self.assertRaisesRegex(ValueError, "不得少于 3 秒"):
            extract_audio_segment(unchecked, self.data_root)

    def test_rejects_clip_longer_than_sixty_seconds_in_both_layers(self) -> None:
        values = {
            "request_id": "too-long",
            "source_path": "source.wav",
            "output_path": "clip.wav",
            "start_seconds": 0,
            "end_seconds": 60.001,
        }
        with self.assertRaisesRegex(ValidationError, "不得超过 60 秒"):
            AudioExtractRequest(**values)
        unchecked = AudioExtractRequest.model_construct(**values)
        with self.assertRaisesRegex(ValueError, "不得超过 60 秒"):
            extract_audio_segment(unchecked, self.data_root)

    def test_rejects_path_outside_data_root(self) -> None:
        outside = self.data_root.parent / "outside.wav"
        self.make_tone(outside)
        request = AudioExtractRequest(
            request_id="outside",
            source_path=str(outside),
            output_path="clip.wav",
            start_seconds=0,
            end_seconds=3,
        )
        with self.assertRaisesRegex(ValueError, "应用数据目录"):
            extract_audio_segment(request, self.data_root)
        outside.unlink(missing_ok=True)

    @unittest.skipUnless(HAS_MEDIA_TOOLS, "需要 FFmpeg/FFprobe")
    def test_extracts_atomic_24khz_mono_pcm_wav_with_input_seek(self) -> None:
        source = self.source_path()
        target = self.target_path()
        self.make_tone(source, seconds=5)
        request = AudioExtractRequest(
            request_id="clip-1",
            source_path=str(source),
            output_path=str(target),
            start_seconds=0.5,
            end_seconds=3.5,
        )

        commands: list[list[str]] = []
        real_run = subprocess.run

        def capture_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return real_run(command, **kwargs)

        with patch(
            "audio_extract._resolve_tools",
            return_value=(str(FFMPEG), str(FFPROBE)),
        ), patch("audio_extract.subprocess.run", side_effect=capture_run):
            result = extract_audio_segment(request, self.data_root)

        extract_command = next(command for command in commands if command[0] == str(FFMPEG))
        self.assertLess(extract_command.index("-ss"), extract_command.index("-i"))
        self.assertLess(extract_command.index("-accurate_seek"), extract_command.index("-i"))

        self.assertEqual(result["sample_rate"], 24000)
        self.assertEqual(result["channels"], 1)
        self.assertEqual(result["codec"], "pcm_s16le")
        with wave.open(str(target), "rb") as clip:
            self.assertEqual(clip.getframerate(), 24000)
            self.assertEqual(clip.getnchannels(), 1)
            self.assertEqual(clip.getsampwidth(), 2)
            self.assertAlmostEqual(clip.getnframes() / clip.getframerate(), 3, places=2)
        self.assertEqual(list(target.parent.glob("*.partial")), [])

    @unittest.skipUnless(HAS_MEDIA_TOOLS, "需要 FFmpeg/FFprobe")
    def test_rejects_end_beyond_source_duration(self) -> None:
        source = self.source_path()
        self.make_tone(source, seconds=5)
        request = AudioExtractRequest(
            request_id="too-long",
            source_path=str(source),
            output_path=str(self.target_path()),
            start_seconds=2,
            end_seconds=6,
        )
        with patch(
            "audio_extract._resolve_tools",
            return_value=(str(FFMPEG), str(FFPROBE)),
        ):
            with self.assertRaisesRegex(ValueError, "end_seconds"):
                extract_audio_segment(request, self.data_root)

    def test_rejects_paths_outside_dedicated_extract_directories(self) -> None:
        source = self.data_root / "imports" / "source.wav"
        self.make_tone(source, seconds=5)
        request = AudioExtractRequest(
            request_id="wrong-directory",
            source_path=str(source),
            output_path=str(self.target_path()),
            start_seconds=0,
            end_seconds=3,
        )
        with self.assertRaisesRegex(ValueError, "专用音色来源"):
            extract_audio_segment(request, self.data_root)

    def test_existing_target_is_never_overwritten(self) -> None:
        source = self.source_path()
        target = self.target_path()
        self.make_tone(source, seconds=5)
        target.parent.mkdir(parents=True, exist_ok=True)
        original = b"existing voice data"
        target.write_bytes(original)
        request = AudioExtractRequest(
            request_id="existing-target",
            source_path=str(source),
            output_path=str(target),
            start_seconds=0,
            end_seconds=3,
        )
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            extract_audio_segment(request, self.data_root)
        self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
