from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, model_validator


MIN_CLIP_SECONDS = 3.0
MAX_CLIP_SECONDS = 60.0
SOURCE_ID_PATTERN = re.compile(r"^voicesrc_[a-f0-9]{16}$")
CLIP_ID_PATTERN = re.compile(r"^voiceclip_[a-f0-9]{16}$")
SOURCE_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mpg", ".mpeg",
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma",
}


def _validate_clip_duration(start_seconds: float, end_seconds: float) -> float:
    duration = end_seconds - start_seconds
    if duration < MIN_CLIP_SECONDS:
        raise ValueError(
            f"裁剪时长不得少于 {MIN_CLIP_SECONDS:g} 秒"
        )
    if duration > MAX_CLIP_SECONDS:
        raise ValueError(
            f"裁剪时长不得超过 {MAX_CLIP_SECONDS:g} 秒"
        )
    return duration


class AudioExtractRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=200)
    source_path: str = Field(min_length=1, max_length=4096)
    output_path: str = Field(min_length=1, max_length=4096)
    start_seconds: float = Field(ge=0, allow_inf_nan=False)
    end_seconds: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_time_range(self) -> "AudioExtractRequest":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds 必须大于 start_seconds")
        _validate_clip_duration(self.start_seconds, self.end_seconds)
        return self


class AudioToolUnavailable(RuntimeError):
    pass


class AudioProbeError(ValueError):
    pass


class AudioExtractTimeout(TimeoutError):
    pass


class AudioExtractError(RuntimeError):
    pass


def _data_path(value: str, data_root: Path, *, must_exist: bool) -> Path:
    root = data_root.resolve()
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=must_exist)
    except FileNotFoundError as error:
        raise ValueError(f"路径不存在：{value}") from error
    if resolved == root or not resolved.is_relative_to(root):
        raise ValueError("音频源与输出路径必须位于应用数据目录")
    return resolved


def _validate_extract_paths(source: Path, target: Path, data_root: Path) -> None:
    root = data_root.resolve()
    expected_source_root = root / ".tmp" / "voice-sources"
    expected_clip_root = root / ".tmp" / "voice-clips"
    source_parent = source.parent
    target_parent = target.parent
    if (
        source_parent.parent != expected_source_root
        or not SOURCE_ID_PATTERN.fullmatch(source_parent.name)
        or source.stem != "source"
        or source.suffix.lower() not in SOURCE_EXTENSIONS
    ):
        raise ValueError("source_path 必须位于专用音色来源临时目录")
    if (
        target_parent.parent != expected_clip_root
        or not CLIP_ID_PATTERN.fullmatch(target_parent.name)
        or target.name != "reference.wav"
    ):
        raise ValueError("output_path 必须位于专用音色裁剪临时目录")


def _resolve_tools() -> tuple[str, str]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AudioToolUnavailable("AUDIO_TOOL_UNAVAILABLE: 未找到 FFmpeg")

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        executable = "ffprobe.exe" if Path(ffmpeg).suffix.lower() == ".exe" else "ffprobe"
        adjacent = Path(ffmpeg).with_name(executable)
        if adjacent.is_file():
            ffprobe = str(adjacent)
    if not ffprobe:
        raise AudioToolUnavailable("AUDIO_TOOL_UNAVAILABLE: 未找到 FFprobe，无法校验媒体时长")
    return ffmpeg, ffprobe


def _error_tail(completed: subprocess.CompletedProcess[str], limit: int = 800) -> str:
    message = (completed.stderr or completed.stdout or "未知错误").strip()
    return message[-limit:]


def _probe_duration(source: Path, ffprobe: str, timeout_seconds: float) -> float:
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration:format=duration",
        "-of",
        "json",
        str(source),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired as error:
        raise AudioExtractTimeout(
            f"AUDIO_PROBE_TIMEOUT: 媒体探测超过 {timeout_seconds:g} 秒"
        ) from error
    except OSError as error:
        raise AudioToolUnavailable(f"AUDIO_TOOL_UNAVAILABLE: FFprobe 无法启动：{error}") from error

    if completed.returncode != 0:
        raise AudioProbeError(f"AUDIO_PROBE_FAILED: {_error_tail(completed)}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise AudioProbeError("AUDIO_PROBE_FAILED: FFprobe 返回了无效 JSON") from error

    streams = payload.get("streams") or []
    if not streams:
        raise AudioProbeError("AUDIO_PROBE_FAILED: 媒体中没有可用音轨")
    candidates = [streams[0].get("duration"), (payload.get("format") or {}).get("duration")]
    for raw_value in candidates:
        try:
            duration = float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0:
            return duration
    raise AudioProbeError("AUDIO_PROBE_FAILED: 无法取得有效音轨时长")


def extract_audio_segment(
    request: AudioExtractRequest,
    data_root: Path,
    *,
    probe_timeout_seconds: float = 30,
    extract_timeout_seconds: float = 180,
) -> dict[str, Any]:
    clip_duration = _validate_clip_duration(
        request.start_seconds,
        request.end_seconds,
    )
    source = _data_path(request.source_path, data_root, must_exist=True)
    if not source.is_file():
        raise ValueError("source_path 必须是媒体文件")
    target = _data_path(request.output_path, data_root, must_exist=False)
    if target.suffix.lower() != ".wav":
        raise ValueError("output_path 必须使用 .wav 扩展名")
    if target == source:
        raise ValueError("output_path 不能覆盖源媒体")
    _validate_extract_paths(source, target, data_root)
    if target.exists():
        raise ValueError("output_path 已存在，拒绝覆盖")

    ffmpeg, ffprobe = _resolve_tools()
    source_duration = _probe_duration(source, ffprobe, probe_timeout_seconds)
    if request.start_seconds >= source_duration:
        raise ValueError(
            f"start_seconds 超出媒体时长（{source_duration:.3f} 秒）"
        )
    if request.end_seconds > source_duration:
        raise ValueError(
            f"end_seconds 超出媒体时长（{source_duration:.3f} 秒）"
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.{uuid.uuid4().hex}.partial")
    reserved_target = False
    completed_output = False
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{request.start_seconds:.6f}",
        "-accurate_seek",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-t",
        f"{clip_duration:.6f}",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(partial),
    ]
    try:
        try:
            with target.open("xb"):
                pass
            reserved_target = True
        except FileExistsError as error:
            raise ValueError("output_path 已存在，拒绝覆盖") from error
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=extract_timeout_seconds,
            check=False,
            shell=False,
        )
        if completed.returncode != 0:
            raise AudioExtractError(f"AUDIO_EXTRACT_FAILED: {_error_tail(completed)}")
        if not partial.is_file() or partial.stat().st_size <= 44:
            raise AudioExtractError("AUDIO_EXTRACT_FAILED: FFmpeg 未生成有效 WAV")
        partial.replace(target)
        completed_output = True
    except subprocess.TimeoutExpired as error:
        raise AudioExtractTimeout(
            f"AUDIO_EXTRACT_TIMEOUT: 音频裁剪超过 {extract_timeout_seconds:g} 秒"
        ) from error
    except OSError as error:
        raise AudioToolUnavailable(f"AUDIO_TOOL_UNAVAILABLE: FFmpeg 无法启动：{error}") from error
    finally:
        partial.unlink(missing_ok=True)
        if reserved_target and not completed_output:
            target.unlink(missing_ok=True)

    return {
        "request_id": request.request_id,
        "output_path": str(target),
        "source_duration_seconds": source_duration,
        "start_seconds": request.start_seconds,
        "end_seconds": request.end_seconds,
        "duration_seconds": clip_duration,
        "sample_rate": 24000,
        "channels": 1,
        "codec": "pcm_s16le",
        "bytes": target.stat().st_size,
    }
