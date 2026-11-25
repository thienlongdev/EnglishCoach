from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import numpy as np

from app.services.audio_ingestion import CanonicalAudio, decode_browser_audio
from app.services.listening_local_asr import transcribe_segments

logger = logging.getLogger("audio_evidence")


@dataclass(frozen=True)
class SpeakingEvidence:
    transcript_text: str
    word_count: int
    duration_seconds: float
    silence_ratio: float
    mean_energy: float
    speech_rate_wpm: float
    abstention_required: bool
    abstention_reason: Optional[str]
    acoustic_features: Dict[str, Any]
    word_timestamps: List[Dict[str, Any]]


def extract_speaking_evidence(
    audio_bytes: bytes,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
) -> SpeakingEvidence:
    """
    Extract dual acoustic and linguistic evidence from candidate audio.
    Follows official examination invariants:
    - Never infer pronunciation from transcript alone.
    - Never reduce fluency to WPM alone.
    - Explicitly abstains if audio is silent, corrupt, or insufficient.
    """
    if not audio_bytes or len(audio_bytes) < 1000:
        return SpeakingEvidence(
            transcript_text="",
            word_count=0,
            duration_seconds=0.0,
            silence_ratio=1.0,
            mean_energy=0.0,
            speech_rate_wpm=0.0,
            abstention_required=True,
            abstention_reason="INSUFFICIENT_AUDIO_PAYLOAD",
            acoustic_features={},
            word_timestamps=[],
        )

    try:
        canonical = decode_browser_audio(
            audio_bytes,
            content_type=content_type,
            filename=filename,
            max_duration_seconds=180.0,
        )
    except Exception as exc:
        logger.warning(f"Audio decode failed in exam evidence extraction: {exc}")
        return SpeakingEvidence(
            transcript_text="",
            word_count=0,
            duration_seconds=0.0,
            silence_ratio=1.0,
            mean_energy=0.0,
            speech_rate_wpm=0.0,
            abstention_required=True,
            abstention_reason=f"DECODE_FAILURE: {str(exc)}",
            acoustic_features={},
            word_timestamps=[],
        )

    waveform = canonical.waveform
    duration = canonical.duration_seconds

    # Acoustic features
    rms_energy = float(np.sqrt(np.mean(waveform ** 2))) if len(waveform) > 0 else 0.0
    # Silence detection: frame-level energy below threshold
    frame_size = int(canonical.sample_rate * 0.05)  # 50ms frames
    silence_frames = 0
    total_frames = max(1, len(waveform) // frame_size)
    for i in range(total_frames):
        frame = waveform[i * frame_size : (i + 1) * frame_size]
        if np.sqrt(np.mean(frame ** 2)) < 0.01:
            silence_frames += 1
    silence_ratio = silence_frames / total_frames

    if silence_ratio > 0.95 or rms_energy < 0.002:
        return SpeakingEvidence(
            transcript_text="",
            word_count=0,
            duration_seconds=duration,
            silence_ratio=silence_ratio,
            mean_energy=rms_energy,
            speech_rate_wpm=0.0,
            abstention_required=True,
            abstention_reason="SILENCE_OR_INAUDIBLE",
            acoustic_features={"rms": rms_energy, "silenceRatio": silence_ratio},
            word_timestamps=[],
        )

    # Detailed transcription
    segments = transcribe_segments(waveform)
    transcript = " ".join(segment["text"] for segment in segments)
    words = [word for segment in segments for word in segment.get("words", [])]
    word_count = len(transcript.split()) if transcript else 0
    wpm = (word_count / (duration / 60.0)) if duration > 0 else 0.0

    return SpeakingEvidence(
        transcript_text=transcript,
        word_count=word_count,
        duration_seconds=duration,
        silence_ratio=silence_ratio,
        mean_energy=rms_energy,
        speech_rate_wpm=round(wpm, 1),
        abstention_required=False,
        abstention_reason=None,
        acoustic_features={
            "rms": round(rms_energy, 4),
            "silenceRatio": round(silence_ratio, 3),
            "sampleRate": canonical.sample_rate,
            "duration": round(duration, 2),
        },
        word_timestamps=words,
    )
