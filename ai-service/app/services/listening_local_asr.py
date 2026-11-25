"""
Local speech transcription for Listening YouTube imports (rules 10 §BE).

WhisperX's own transcription engine — faster-whisper (CTranslate2) — running on the owner's
Windows GPU PC with the model already in the local Hugging Face cache (``local_files_only``: never
downloaded at import time, never uploaded). Word timing is NOT taken from this stage: its segments
only carry text, and WhisperX wav2vec2 alignment then times every word against the audio.

There is no remote, paid or OpenRouter transcription anywhere in this module, and none may be added.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List

logger = logging.getLogger("listening_local_asr")

MODEL_NAME = os.getenv("LISTENING_ASR_MODEL", "large-v3")

_MODEL = None
_MODEL_DEVICE = None
_LOAD_LOCK = threading.Lock()
# One transcription at a time on the shared GPU (OCR, ECSM and alignment live in the same process).
_RUN_LOCK = threading.Lock()


class LocalPipelineUnavailable(Exception):
    """The authorized local pipeline (transcription or alignment) cannot run on this host."""


def _load_model():
    global _MODEL, _MODEL_DEVICE
    with _LOAD_LOCK:
        if _MODEL is not None:
            return _MODEL
        try:
            import ctranslate2
            from faster_whisper import WhisperModel
        except Exception as e:  # package missing in this runtime
            raise LocalPipelineUnavailable(f"faster-whisper is not installed: {e}") from e
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        try:
            _MODEL = WhisperModel(MODEL_NAME, device=device, compute_type=compute_type, local_files_only=True)
        except Exception as e:
            raise LocalPipelineUnavailable(f"local Whisper model '{MODEL_NAME}' cannot be loaded: {e}") from e
        _MODEL_DEVICE = device
        logger.info("Local Listening ASR loaded: %s on %s (%s)", MODEL_NAME, device, compute_type)
        return _MODEL


def engine_label() -> str:
    return f"faster-whisper:{MODEL_NAME}"


def transcribe_echo_pcm(pcm: bytes, language: str) -> dict:
    """Short mono 16 kHz PCM from an explicitly enabled Echo microphone."""
    import numpy as np

    if language not in ("vi", "en") or not 3200 <= len(pcm) <= 640000 or len(pcm) % 2:
        raise ValueError("Invalid voice clip")
    model = _load_model()
    if not _RUN_LOCK.acquire(blocking=False):
        raise LocalPipelineUnavailable("GPU busy")
    try:
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        # Short clips frequently contain names or one-syllable content words. Keep competing
        # hypotheses through decoding, as on the established Listening transcription path.
        segments, _ = model.transcribe(audio, language=language, task="transcribe", beam_size=5,
                                       temperature=0.0, vad_filter=True, condition_on_previous_text=False)
        spoken = [s for s in segments if s.text.strip()]
        text = " ".join(s.text.strip() for s in spoken)[:4000]
        uncertain = not spoken or any(s.avg_logprob < -0.8 or s.no_speech_prob > 0.55 for s in spoken)
        return {"text": text, "reviewNeeded": uncertain}
    finally:
        _RUN_LOCK.release()


def transcription_state() -> Dict[str, Any]:
    """What this process really holds in memory, for the readiness check. Loads nothing."""
    return {"engine": "faster-whisper", "model": MODEL_NAME, "loaded": _MODEL is not None, "device": _MODEL_DEVICE}


def transcribe_segments(audio_path) -> List[Dict[str, Any]]:
    """
    Transcribes English speech locally with deterministic greedy temperature (0.0),
    preserving real faster-whisper word timestamps and segment confidence metrics.
    """
    model = _load_model()
    with _RUN_LOCK:
        try:
            raw_segments, _info = model.transcribe(
                audio_path,
                language="en",
                task="transcribe",
                beam_size=5,
                temperature=0.0,
                vad_filter=True,
                condition_on_previous_text=False,
                word_timestamps=True,
            )
            from app.services.listening_trace import current
            collected = []
            for segment in raw_segments:
                if current.get(): current.get().check()
                collected.append(segment)
            raw_segments = collected
        except RuntimeError as e:
            # CUDA / library failure of the local engine: the pipeline is unavailable, not the video.
            raise LocalPipelineUnavailable(f"local transcription failed: {e}") from e

    segments: List[Dict[str, Any]] = []
    for s in raw_segments:
        text = (s.text or "").strip()
        if not text:
            continue
        start = float(s.start)
        end = float(s.end)
        raw_words = getattr(s, "words", None) or []
        words_out: List[Dict[str, Any]] = []
        if raw_words:
            first_start = getattr(raw_words[0], "start", None)
            last_end = getattr(raw_words[-1], "end", None)
            if first_start is not None:
                start = float(first_start)
            if last_end is not None:
                end = float(last_end)
            for w in raw_words:
                w_text = (getattr(w, "word", "") or "").strip()
                if not w_text:
                    continue
                w_start = getattr(w, "start", None)
                w_end = getattr(w, "end", None)
                w_prob = getattr(w, "probability", None)
                words_out.append({
                    "word": w_text,
                    "start": round(float(w_start), 3) if w_start is not None else None,
                    "end": round(float(w_end), 3) if w_end is not None else None,
                    "probability": round(float(w_prob), 3) if w_prob is not None else None,
                })
        if not words_out:
            words_out = [{"word": w, "start": None, "end": None, "probability": None} for w in text.split()]

        # Preserve ultra-short valid 1-word replies instead of dropping when end <= start
        end = max(start + 0.01, end)
        avg_logprob = getattr(s, "avg_logprob", None)
        no_speech_prob = getattr(s, "no_speech_prob", None)
        segments.append({
            "startTimeMs": int(round(start * 1000)),
            "endTimeMs": int(round(end * 1000)),
            "speakerName": "Speaker",
            "text": text,
            "difficultyScore": 1.0,
            "avg_logprob": round(float(avg_logprob), 4) if avg_logprob is not None else None,
            "no_speech_prob": round(float(no_speech_prob), 4) if no_speech_prob is not None else None,
            "words": words_out,
        })
    return segments
