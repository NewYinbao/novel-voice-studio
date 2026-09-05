from __future__ import annotations

import importlib.util
import math
import os
import re
import shutil
import subprocess
import wave
from collections import defaultdict
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


SENSEVOICE_MODEL_ID = "iic/SenseVoiceSmall"
VAD_MODEL_ID = "fsmn-vad"
PUNCTUATION_MODEL_ID = "ct-punc"
SPEAKER_MODEL_ID = "cam++"
PYANNOTE_MODEL_ID = "pyannote/speaker-diarization-community-1"

SOURCE_ID_PATTERN = re.compile(r"^voicesrc_[a-f0-9]{16}$")
ANALYSIS_ID_PATTERN = re.compile(r"^voiceanalysis_[a-f0-9]{16}$")
SOURCE_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mpg", ".mpeg",
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma",
}
SENSEVOICE_TAG = re.compile(r"<\|([^|>]+)\|>")
EMOTION_TAGS = {
    "NEUTRAL": "neutral",
    "HAPPY": "happy",
    "SAD": "sad",
    "ANGRY": "angry",
    "FEARFUL": "fearful",
    "DISGUSTED": "disgusted",
    "SURPRISED": "surprised",
}


class VoiceAnalysisRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=200)
    source_path: str = Field(min_length=1, max_length=4096)
    output_dir: str = Field(min_length=1, max_length=4096)
    language: str = Field(default="zh", min_length=1, max_length=32)
    speaker_count: int | None = Field(default=None, ge=1, le=20)


class VoiceAnalysisUnavailable(RuntimeError):
    pass


class VoiceAnalysisError(RuntimeError):
    pass


class VoiceAnalysisTimeout(TimeoutError):
    pass


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _pyannote_source() -> tuple[str | None, str | None]:
    local = os.environ.get("NVS_PYANNOTE_MODEL", "").strip()
    if local:
        local_path = Path(local).expanduser().resolve()
        if local_path.is_dir():
            return str(local_path), None
        return None, "NVS_PYANNOTE_MODEL 指向的本地模型目录不存在"
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        return PYANNOTE_MODEL_ID, token
    return None, "需要已接受协议的 community-1 本地模型或 HF_TOKEN"


def voice_analysis_capabilities() -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg") is not None
    ffprobe = shutil.which("ffprobe") is not None
    funasr = _module_available("funasr")
    modelscope = _module_available("modelscope")
    torch = _module_available("torch")
    pyannote = _module_available("pyannote.audio")
    pyannote_source, pyannote_note = _pyannote_source()
    core_ready = ffmpeg and ffprobe and funasr and modelscope and torch
    overlap_ready = core_ready and pyannote and pyannote_source is not None
    missing: list[str] = []
    if not ffmpeg:
        missing.append("ffmpeg")
    if not ffprobe:
        missing.append("ffprobe")
    if not funasr:
        missing.append("funasr")
    if not modelscope:
        missing.append("modelscope")
    if not torch:
        missing.append("torch")
    return {
        "ready": core_ready,
        "asr": core_ready,
        "diarization": core_ready,
        "emotion": core_ready,
        "overlap_detection": overlap_ready,
        "missing_dependencies": missing,
        "overlap_note": None if overlap_ready else (
            pyannote_note if pyannote_source is None else "未安装 pyannote.audio"
        ),
        "models": {
            "asr_emotion": SENSEVOICE_MODEL_ID,
            "vad": VAD_MODEL_ID,
            "punctuation": PUNCTUATION_MODEL_ID,
            "speaker": SPEAKER_MODEL_ID,
            "overlap": PYANNOTE_MODEL_ID if overlap_ready else None,
        },
    }


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
        raise ValueError("分析来源与输出必须位于应用数据目录")
    return resolved


def validate_analysis_paths(
    request: VoiceAnalysisRequest,
    data_root: Path,
) -> tuple[Path, Path]:
    root = data_root.resolve()
    source = _data_path(request.source_path, root, must_exist=True)
    output_dir = _data_path(request.output_dir, root, must_exist=False)
    expected_source_root = root / ".tmp" / "voice-sources"
    expected_output_root = root / ".tmp" / "voice-analysis"
    if (
        not source.is_file()
        or source.parent.parent != expected_source_root
        or not SOURCE_ID_PATTERN.fullmatch(source.parent.name)
        or source.stem != "source"
        or source.suffix.lower() not in SOURCE_EXTENSIONS
    ):
        raise ValueError("source_path 必须位于专用音色来源临时目录")
    if (
        output_dir.parent != expected_output_root
        or not ANALYSIS_ID_PATTERN.fullmatch(output_dir.name)
    ):
        raise ValueError("output_dir 必须位于专用音频分析临时目录")
    if output_dir.exists():
        raise ValueError("output_dir 已存在，拒绝覆盖")
    return source, output_dir


def _resolve_media_tools() -> tuple[str, str]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        missing = ", ".join(
            name for name, value in (("FFmpeg", ffmpeg), ("FFprobe", ffprobe)) if not value
        )
        raise VoiceAnalysisUnavailable(
            f"VOICE_ANALYSIS_UNAVAILABLE: 缺少媒体工具：{missing}"
        )
    return ffmpeg, ffprobe


def _run_media_command(command: list[str], timeout_seconds: float) -> subprocess.CompletedProcess[str]:
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
        raise VoiceAnalysisTimeout(
            f"VOICE_ANALYSIS_TIMEOUT: 媒体处理超过 {timeout_seconds:g} 秒"
        ) from error
    except OSError as error:
        raise VoiceAnalysisUnavailable(
            f"VOICE_ANALYSIS_UNAVAILABLE: 媒体工具无法启动：{error}"
        ) from error
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "未知错误").strip()[-800:]
        raise VoiceAnalysisError(f"VOICE_ANALYSIS_MEDIA_FAILED: {message}")
    return completed


def _probe_duration(source: Path, ffprobe: str) -> float:
    completed = _run_media_command([
        ffprobe, "-v", "error", "-show_entries", "format=duration", "-of",
        "default=noprint_wrappers=1:nokey=1", str(source),
    ], 30)
    try:
        duration = float(completed.stdout.strip())
    except ValueError as error:
        raise VoiceAnalysisError("VOICE_ANALYSIS_MEDIA_FAILED: 无法读取媒体时长") from error
    if not math.isfinite(duration) or duration <= 0:
        raise VoiceAnalysisError("VOICE_ANALYSIS_MEDIA_FAILED: 媒体时长无效")
    return duration


def _normalize_source(source: Path, target: Path, ffmpeg: str) -> None:
    _run_media_command([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
        "-i", str(source), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", "-f", "wav", str(target),
    ], 1800)
    if not target.is_file() or target.stat().st_size <= 44:
        raise VoiceAnalysisError("VOICE_ANALYSIS_MEDIA_FAILED: 未生成有效的归一化音频")


def _extract_clip(
    source: Path,
    target: Path,
    start_ms: int,
    end_ms: int,
    ffmpeg: str,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    _run_media_command([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
        "-ss", f"{start_ms / 1000:.6f}", "-i", str(source),
        "-t", f"{(end_ms - start_ms) / 1000:.6f}", "-vn", "-ac", "1", "-ar", "24000",
        "-c:a", "pcm_s16le", "-f", "wav", str(target),
    ], 300)
    if not target.is_file() or target.stat().st_size <= 44:
        raise VoiceAnalysisError("VOICE_ANALYSIS_MEDIA_FAILED: 片段导出失败")


def _concat_pcm_wavs(sources: list[Path], target: Path) -> None:
    if not sources:
        raise ValueError("没有可合并的非重叠音频")
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(sources[0]), "rb") as first:
        channels = first.getnchannels()
        sample_width = first.getsampwidth()
        sample_rate = first.getframerate()
    try:
        with target.open("xb") as raw_output:
            with wave.open(raw_output, "wb") as output:
                output.setnchannels(channels)
                output.setsampwidth(sample_width)
                output.setframerate(sample_rate)
                for source in sources:
                    with wave.open(str(source), "rb") as current:
                        if (
                            current.getnchannels() != channels
                            or current.getsampwidth() != sample_width
                            or current.getframerate() != sample_rate
                        ):
                            raise VoiceAnalysisError(
                                "VOICE_ANALYSIS_MEDIA_FAILED: 合并片段格式不一致"
                            )
                        while True:
                            frame_data = current.readframes(65536)
                            if not frame_data:
                                break
                            output.writeframesraw(frame_data)
    except FileExistsError as error:
        raise ValueError("说话人合并音频已存在，拒绝覆盖") from error


def _numeric_value(payload: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return float(value)
    return None


def _parse_sensevoice_text(value: Any) -> tuple[str, str]:
    raw = str(value or "")
    tags = [match.upper() for match in SENSEVOICE_TAG.findall(raw)]
    emotion = next((EMOTION_TAGS[tag] for tag in tags if tag in EMOTION_TAGS), "unknown")
    text = SENSEVOICE_TAG.sub("", raw).strip()
    return text, emotion


def _sentence_items(result: Any, duration_ms: int) -> list[dict[str, Any]]:
    if not isinstance(result, list) or not result or not isinstance(result[0], dict):
        raise VoiceAnalysisError("VOICE_ANALYSIS_INVALID_RESULT: FunASR 未返回结构化结果")
    root = result[0]
    sentences = root.get("sentence_info")
    if not isinstance(sentences, list) or not sentences:
        raise VoiceAnalysisError(
            "VOICE_ANALYSIS_INVALID_RESULT: CAM++ 未返回带说话人的 sentence_info"
        )
    normalized: list[dict[str, Any]] = []
    for item in sentences:
        if not isinstance(item, dict):
            continue
        try:
            start_ms = max(0, int(round(float(item.get("start")))))
            end_ms = min(duration_ms, int(round(float(item.get("end")))))
        except (TypeError, ValueError):
            continue
        speaker = item.get("spk", item.get("speaker"))
        if speaker is None or end_ms <= start_ms:
            continue
        text, emotion = _parse_sensevoice_text(item.get("text", item.get("sentence")))
        normalized.append({
            "raw_speaker": str(speaker),
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": text,
            "emotion": emotion,
            "transcript_confidence": _numeric_value(item, "confidence", "score"),
            "emotion_confidence": _numeric_value(item, "emotion_confidence"),
        })
    normalized.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
    if not normalized:
        raise VoiceAnalysisError(
            "VOICE_ANALYSIS_INVALID_RESULT: 未得到有效的说话人片段"
        )
    return normalized


def _annotation_tracks(annotation: Any) -> list[tuple[float, float, str]]:
    tracks: list[tuple[float, float, str]] = []
    if hasattr(annotation, "itertracks"):
        iterator = annotation.itertracks(yield_label=True)
        for turn, _track, speaker in iterator:
            tracks.append((float(turn.start), float(turn.end), str(speaker)))
        return tracks
    for turn, speaker in annotation:
        tracks.append((float(turn.start), float(turn.end), str(speaker)))
    return tracks


def _overlap_ranges(
    tracks: list[tuple[float, float, str]],
) -> list[dict[str, Any]]:
    boundaries = sorted({point for start, end, _speaker in tracks for point in (start, end)})
    ranges: list[dict[str, Any]] = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        active = sorted({
            speaker for track_start, track_end, speaker in tracks
            if track_start < end and track_end > start
        })
        if len(active) < 2:
            continue
        start_ms = int(round(start * 1000))
        end_ms = int(round(end * 1000))
        if end_ms <= start_ms:
            continue
        if (
            ranges
            and ranges[-1]["end_ms"] == start_ms
            and ranges[-1]["raw_speakers"] == active
        ):
            ranges[-1]["end_ms"] = end_ms
        else:
            ranges.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "raw_speakers": active,
            })
    return ranges


def _align_pyannote_speakers(
    tracks: list[tuple[float, float, str]],
    segments: list[dict[str, Any]],
) -> dict[str, str]:
    scores: dict[tuple[str, str], float] = defaultdict(float)
    for track_start, track_end, py_speaker in tracks:
        for segment in segments:
            start = max(track_start, segment["start_ms"] / 1000)
            end = min(track_end, segment["end_ms"] / 1000)
            if end > start:
                scores[(py_speaker, segment["speaker_id"])] += end - start
    candidates = sorted(
        ((score, py_speaker, speaker_id) for (py_speaker, speaker_id), score in scores.items()),
        reverse=True,
    )
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for _score, py_speaker, speaker_id in candidates:
        if py_speaker not in mapping and speaker_id not in used:
            mapping[py_speaker] = speaker_id
            used.add(speaker_id)
    return mapping


def _emotion_from_result(payload: Any) -> str:
    if not isinstance(payload, dict):
        return "unknown"
    candidates = [payload.get("text"), payload.get("sentence")]
    sentence_info = payload.get("sentence_info")
    if isinstance(sentence_info, list):
        for sentence in sentence_info:
            if isinstance(sentence, dict):
                candidates.extend((sentence.get("text"), sentence.get("sentence")))
    for candidate in candidates:
        _text, emotion = _parse_sensevoice_text(candidate)
        if emotion != "unknown":
            return emotion
    return "unknown"


def _emotion_was_detected(segments: list[dict[str, Any]]) -> bool:
    return any(segment.get("emotion") not in (None, "", "unknown") for segment in segments)


class FunASRVoiceAnalysisProvider:
    provider_id = "sensevoice_funasr"

    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root
        self.model: Any = None
        self.pyannote_pipeline: Any = None

    def _model_source(self, local_name: str, fallback: str) -> str:
        explicit = os.environ.get(f"NVS_{local_name.upper().replace('-', '_')}_MODEL", "").strip()
        if explicit:
            return explicit
        local = self.model_root / local_name
        return str(local) if local.is_dir() else fallback

    def load(self) -> None:
        capabilities = voice_analysis_capabilities()
        if not capabilities["ready"]:
            missing = ", ".join(capabilities["missing_dependencies"])
            raise VoiceAnalysisUnavailable(
                f"VOICE_ANALYSIS_UNAVAILABLE: 缺少分析依赖：{missing}"
            )
        try:
            import torch
            from funasr import AutoModel
        except ImportError as error:
            raise VoiceAnalysisUnavailable(
                f"VOICE_ANALYSIS_UNAVAILABLE: 无法导入 FunASR：{error}"
            ) from error
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        try:
            self.model = AutoModel(
                model=self._model_source("SenseVoiceSmall", SENSEVOICE_MODEL_ID),
                vad_model=self._model_source("fsmn-vad", VAD_MODEL_ID),
                punc_model=self._model_source("ct-punc", PUNCTUATION_MODEL_ID),
                spk_model=self._model_source("cam-plus-plus", SPEAKER_MODEL_ID),
                spk_mode="punc_segment",
                trust_remote_code=True,
                device=device,
                disable_update=True,
                log_level="ERROR",
            )
        except Exception as error:
            self.model = None
            raise VoiceAnalysisUnavailable(
                f"VOICE_ANALYSIS_UNAVAILABLE: FunASR 模型加载失败：{error}"
            ) from error

    def unload(self) -> None:
        self.pyannote_pipeline = None
        self.model = None
        try:
            import gc
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass

    def _detect_overlaps(
        self,
        source: Path,
        speaker_count: int | None,
    ) -> tuple[list[tuple[float, float, str]], str | None]:
        pyannote_source, token = _pyannote_source()
        if not _module_available("pyannote.audio") or pyannote_source is None:
            return [], voice_analysis_capabilities()["overlap_note"]
        try:
            if self.pyannote_pipeline is None:
                import torch
                from pyannote.audio import Pipeline

                self.pyannote_pipeline = Pipeline.from_pretrained(
                    pyannote_source,
                    token=token,
                )
                if torch.cuda.is_available():
                    self.pyannote_pipeline.to(torch.device("cuda"))
            kwargs = {"num_speakers": speaker_count} if speaker_count else {}
            output = self.pyannote_pipeline(str(source), **kwargs)
            annotation = getattr(output, "speaker_diarization", output)
            return _annotation_tracks(annotation), None
        except Exception as error:
            self.pyannote_pipeline = None
            return [], f"pyannote community-1 不可用，未检测重叠：{error}"

    def _enrich_unknown_emotions(
        self,
        segments: list[dict[str, Any]],
        language: str,
    ) -> str | None:
        unknown = [segment for segment in segments if segment["emotion"] == "unknown"]
        if not unknown:
            return None
        try:
            results = self.model.generate(
                input=[segment["audio_path"] for segment in unknown],
                cache={},
                language=language,
                use_itn=True,
                batch_size_s=300,
                return_spk_res=False,
            )
        except Exception as error:
            return f"SenseVoice 片段级情绪补推理失败：{error}"
        if not isinstance(results, list) or len(results) != len(unknown):
            return "SenseVoice 片段级情绪补推理返回数量不匹配"
        for segment, result in zip(unknown, results):
            segment["emotion"] = _emotion_from_result(result)
            if isinstance(result, dict):
                confidence = _numeric_value(result, "emotion_confidence")
                if confidence is not None:
                    segment["emotion_confidence"] = confidence
        return None

    def analyze(
        self,
        request: VoiceAnalysisRequest,
        data_root: Path,
    ) -> dict[str, Any]:
        if self.model is None:
            self.load()
        source, output_dir = validate_analysis_paths(request, data_root)
        ffmpeg, ffprobe = _resolve_media_tools()
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            output_dir.mkdir(exist_ok=False)
        except FileExistsError as error:
            raise ValueError("output_dir 已存在，拒绝覆盖") from error

        completed = False
        try:
            normalized = output_dir / "source.normalized.wav"
            _normalize_source(source, normalized, ffmpeg)
            duration_seconds = _probe_duration(normalized, ffprobe)
            duration_ms = int(round(duration_seconds * 1000))
            language = request.language.lower().split("-", 1)[0]
            try:
                result = self.model.generate(
                    input=str(normalized),
                    cache={},
                    language=language,
                    use_itn=True,
                    batch_size_s=300,
                    merge_vad=True,
                    merge_length_s=15,
                    sentence_timestamp=True,
                    return_spk_res=True,
                    preset_spk_num=request.speaker_count,
                )
            except Exception as error:
                raise VoiceAnalysisError(
                    f"VOICE_ANALYSIS_FAILED: FunASR 推理失败：{error}"
                ) from error

            raw_segments = _sentence_items(result, duration_ms)
            speaker_map: dict[str, str] = {}
            for segment in raw_segments:
                raw_speaker = segment.pop("raw_speaker")
                speaker_map.setdefault(raw_speaker, f"speaker_{len(speaker_map) + 1:02d}")
                segment["speaker_id"] = speaker_map[raw_speaker]

            tracks, overlap_warning = self._detect_overlaps(normalized, request.speaker_count)
            overlap_enabled = overlap_warning is None
            raw_overlaps = _overlap_ranges(tracks) if overlap_enabled else []
            pyannote_map = _align_pyannote_speakers(tracks, raw_segments) if tracks else {}
            overlaps: list[dict[str, Any]] = []
            for index, overlap in enumerate(raw_overlaps, 1):
                overlap_id = f"overlap_{index:04d}"
                audio_path = output_dir / "overlaps" / f"{overlap_id}.wav"
                _extract_clip(
                    normalized,
                    audio_path,
                    overlap["start_ms"],
                    overlap["end_ms"],
                    ffmpeg,
                )
                speaker_ids = sorted({
                    pyannote_map.get(raw_speaker, f"pyannote:{raw_speaker}")
                    for raw_speaker in overlap["raw_speakers"]
                })
                overlaps.append({
                    "overlap_id": overlap_id,
                    "id": overlap_id,
                    "start_ms": overlap["start_ms"],
                    "end_ms": overlap["end_ms"],
                    "start_seconds": overlap["start_ms"] / 1000,
                    "end_seconds": overlap["end_ms"] / 1000,
                    "speaker_ids": speaker_ids,
                    "text": "",
                    "emotion": "unknown",
                    "audio_path": str(audio_path),
                    "confidence": None,
                })

            excluded = [(item["start_ms"], item["end_ms"]) for item in overlaps]
            by_speaker: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for index, segment in enumerate(raw_segments, 1):
                segment_id = f"segment_{index:05d}"
                audio_path = output_dir / "segments" / f"{segment_id}.wav"
                _extract_clip(
                    normalized,
                    audio_path,
                    segment["start_ms"],
                    segment["end_ms"],
                    ffmpeg,
                )
                segment.update({
                    "segment_id": segment_id,
                    "id": segment_id,
                    "start_seconds": segment["start_ms"] / 1000,
                    "end_seconds": segment["end_ms"] / 1000,
                    "audio_path": str(audio_path),
                    "overlap": any(
                        start < segment["end_ms"] and end > segment["start_ms"]
                        for start, end in excluded
                    ),
                    "confidence": segment["transcript_confidence"],
                })
                by_speaker[segment["speaker_id"]].append(segment)

            emotion_warning = self._enrich_unknown_emotions(raw_segments, language)
            emotion_detected = _emotion_was_detected(raw_segments)

            speakers: list[dict[str, Any]] = []
            for speaker_id in sorted(by_speaker):
                segments = by_speaker[speaker_id]
                clean_parts: list[Path] = []
                clean_segments: list[dict[str, Any]] = []
                total_clean_ms = 0
                for segment in segments:
                    if segment["overlap"]:
                        # Without word-level forced alignment, trimming the mixed
                        # interval would leave an inaccurate reference transcript.
                        segment["clean_parts"] = []
                        segment["excluded_from_reference"] = True
                        segment["exclusion_reason"] = "overlap_without_forced_alignment"
                        continue
                    clean_path = Path(segment["audio_path"])
                    clean_parts.append(clean_path)
                    total_clean_ms += segment["end_ms"] - segment["start_ms"]
                    clean_segment = {
                        "id": f"{segment['segment_id']}_clean_01",
                        "source_segment_id": segment["segment_id"],
                        "start_ms": segment["start_ms"],
                        "end_ms": segment["end_ms"],
                        "text": segment["text"],
                        "emotion": segment["emotion"],
                        "emotion_confidence": segment.get("emotion_confidence"),
                        "transcript_confidence": segment.get("transcript_confidence"),
                        "audio_path": str(clean_path),
                        "text_alignment": "segment",
                    }
                    segment["clean_parts"] = [clean_segment]
                    segment["excluded_from_reference"] = False
                    clean_segments.append(clean_segment)
                merged_audio_path: str | None = None
                if clean_parts:
                    merged = output_dir / "speakers" / speaker_id / "reference.wav"
                    _concat_pcm_wavs(clean_parts, merged)
                    merged_audio_path = str(merged)
                speakers.append({
                    "speaker_id": speaker_id,
                    "id": speaker_id,
                    "label": f"说话人 {len(speakers) + 1}",
                    "total_duration_seconds": round(total_clean_ms / 1000, 3),
                    "merged_audio_path": merged_audio_path,
                    "clean_segments": clean_segments,
                    "segments": segments,
                })

            capabilities = {
                "asr": True,
                "diarization": True,
                "emotion": emotion_detected,
                "overlap_detection": overlap_enabled,
            }
            warnings: list[str] = []
            if overlap_warning:
                warnings.append(overlap_warning)
            elif tracks:
                warnings.append(
                    "重叠由 pyannote community-1 真实检测；其说话人标签按时间重合度与 CAM++ 对齐。"
                )
            if overlaps:
                warnings.append(
                    "与重叠区间相交的 ASR 句段因缺少词级强制对齐，已整段排除出克隆参考音频。"
                )
            if emotion_warning:
                warnings.append(emotion_warning)
            if not emotion_detected:
                warnings.append("SenseVoice 未返回可对应的情绪标签，未声称已完成情绪识别。")
            elif any(segment["emotion"] == "unknown" for segment in raw_segments):
                warnings.append("部分片段没有 SenseVoice 情绪标签，已保留为 unknown 供人工调整。")
            completed = True
            return {
                "schema_version": 1,
                "request_id": request.request_id,
                "output_dir": str(output_dir),
                "source_duration_seconds": duration_seconds,
                "duration_seconds": duration_seconds,
                "speakers": speakers,
                "overlaps": overlaps,
                "capabilities": capabilities,
                "models": {
                    **voice_analysis_capabilities()["models"],
                    "overlap": PYANNOTE_MODEL_ID if overlap_enabled else None,
                },
                "warnings": warnings,
            }
        finally:
            if not completed:
                shutil.rmtree(output_dir, ignore_errors=True)
