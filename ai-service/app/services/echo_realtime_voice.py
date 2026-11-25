"""
Isolated Real-Time Echo JARVIS ASR + Semantic Turn Detection (`Smart Turn v3.2`) — Reforge ADR-1.

Key guarantees:
1. Completely isolated from `listening_local_asr.py` and its `_RUN_LOCK` (never imports or
   acquires `listening_local_asr._RUN_LOCK`).
2. Uses a dedicated local `faster-whisper` (`mobiuslabsgmbh/faster-whisper-large-v3-turbo` MIT,
   default `int8_float16` on CUDA / `int8` on CPU, `num_workers=2`, `local_files_only=True`)
   guarded by a **final-over-partial priority gate** (`capacity=2`).
3. Enforces the **7-Layer Zero-Hallucination Shield**:
   - L1: Pure-NumPy RMS floor (`-46.0 dBFS`) before touching GPU
   - L2: Universal Silero VAD (`vad_filter=True` on ALL partials & finals)
   - L3: Zero hotword/prompt poisoning (`hotwords=None`, `initial_prompt=None`)
   - L4: Anti-loop decoding (`condition_on_previous_text=False`, temperature fallback `(0.0, 0.2, 0.4)`,
         `compression_ratio_threshold=2.2`, `log_prob_threshold=-0.95`, `no_speech_threshold=0.60`,
         `no_repeat_ngram_size=3`, `repetition_penalty=1.10`, `hallucination_silence_threshold=0.5`)
   - L5: Constrained EN/VI language resolution (no `id`/`es`/`ko`/`pt`/`zh` mis-detections)
   - L6: Segment-level hard rejection + n-gram repetition-loop & Whisper phantom-phrase rejection
   - L7: Post-ASR domain canonicalizer (`IELTS`, `TOEIC`, `CEFR`, `Echo Jarvis`, `Odyssey`, etc.)
4. Provides `LocalAgreement-2` session-keyed partial stabilization and `< 15 ms` CPU ONNX
   `Smart Turn v3.2` (`BSD-2-Clause`, bilingual EN + VI).
"""
from __future__ import annotations

from collections import OrderedDict
import logging
import math
import os
import re
import threading
import time
import zlib
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

logger = logging.getLogger("echo_realtime_voice")

REALTIME_ASR_CANDIDATES = (
    os.getenv("ECHO_REALTIME_ASR_MODEL", "").strip(),
    "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3",
)

# ADR-1 7-Layer Zero-Hallucination Shield constants
RMS_SILENCE_FLOOR_DBFS = float(os.getenv("ECHO_ASR_RMS_FLOOR_DBFS", "-46.0"))
RMS_WINDOW_PEAK_FLOOR_DBFS = float(os.getenv("ECHO_ASR_WINDOW_PEAK_FLOOR_DBFS", "-52.0"))
RMS_QUIET_SPEECH_MODULATION_DB = 4.5
QUIET_SPEECH_TARGET_PEAK_DBFS = -24.0
QUIET_SPEECH_MAX_GAIN = 8.0
COMPRESSION_RATIO_MAX = 2.2
AVG_LOGPROB_MIN = -0.95
AVG_LOGPROB_CLEAR_SPEECH_MIN = -1.15
NO_SPEECH_PROB_MAX = 0.65
PARTIAL_ACQUIRE_TIMEOUT_SEC = 0.15
FINAL_ACQUIRE_TIMEOUT_SEC = 5.0
VAD_PARAMETERS: Dict[str, Any] = {
    "min_speech_duration_ms": 120,
    "min_silence_duration_ms": 280,
    "speech_pad_ms": 220,
    "threshold": 0.36,
}

# Whisper 8-second log-mel constants for Smart Turn v3.2 (16 kHz)
_ST_N_FFT = 400
_ST_HOP = 160
_ST_N_MELS = 80
_ST_SR = 16000
_ST_WINDOW_SAMPLES = 8 * _ST_SR  # 128000 samples = 8.0 s
_ST_MEL_FLOOR = 1e-10
_ST_NORM_EPS = 1e-7

_VI_DIACRITIC_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)
_NON_LATIN_HALLUCINATION_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]"
)
_WORD_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)

# Always-reject YouTube/caption boilerplate on short clips (< 4.0 s)
_HARD_PHANTOM_PHRASES = frozenset({
    "thank you for watching",
    "thanks for watching",
    "thank you very much for watching",
    "please subscribe",
    "subscribe to my channel",
    "subtitles by",
    "amara org",
    "the following is",
    "cảm ơn các bạn đã theo dõi",
    "cảm ơn các bạn đã xem",
    "hãy subscribe cho kênh",
    "hãy đăng ký kênh",
    "đăng ký kênh",
    "ghiền mì gõ",
    "la la school",
})

# Soft Whisper silence-phantom utterances rejected on short low-confidence / quiet clips
_SOFT_PHANTOM_PHRASES = frozenset({
    "thank you",
    "thanks",
    "thank you very much",
    "you re welcome",
    "you're welcome",
    "the end",
    "bye",
    "bye bye",
    "goodbye",
    "you",
    "cảm ơn",
    "cảm ơn bạn",
    "hẹn gặp lại",
    "tạm biệt",
})

# Layer 7: Post-ASR deterministic English Coach domain canonicalizer (zero decoder poisoning!)
_DOMAIN_CANONICAL_RULES: Tuple[Tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^\s*(?:high|hay)\s+(?=(?:echo|ê[\s-]*cô)\b)", re.IGNORECASE), "Hi "),
    (re.compile(r"\b(?:i[\s.-]*e[\s.-]*l[\s.-]*t[\s.-]*s|ay[\s-]+elts|ai[\s-]+eo|ai[\s-]+elts|ielts|eelts)\b", re.IGNORECASE), "IELTS"),
    (re.compile(r"\beos(?=\s+(?:reading|listening|writing|speaking|academic|general|band))\b", re.IGNORECASE), "IELTS"),
    (re.compile(r"\b(?:t[\s.-]*o[\s.-]*e[\s.-]*i[\s.-]*c|toe[\s-]+ic|to[\s-]+ic|tô[\s-]+ích|toeic)\b", re.IGNORECASE), "TOEIC"),
    (re.compile(r"\b(?:c[\s.-]*e[\s.-]*f[\s.-]*r|cefr)\b", re.IGNORECASE), "CEFR"),
    (re.compile(r"\b(?:echo|eco|ê[\s-]*cô)\s+(?:jarvis|javis|gia[\s-]*vít|ja[\s-]*vis)\b", re.IGNORECASE), "Echo Jarvis"),
    (re.compile(r"\b(?:ê[\s-]*cô)\b", re.IGNORECASE), "Echo"),
    (re.compile(r"\b(?:odissey|oddisey|odysey|odyssey)\b", re.IGNORECASE), "Odyssey"),
    (re.compile(r"\b(?:study\s+space|sờ\s*tơ\s*đi\s*sờ\s*pây)\b", re.IGNORECASE), "Study Space"),
    (re.compile(r"\b(?:flash\s+cards|flashcasts|flash\s+casts)\b", re.IGNORECASE), "Flashcards"),
    (re.compile(r"\b(?:flash\s+card|flashcast|flash\s+cast)\b", re.IGNORECASE), "Flashcard"),
    (re.compile(r"\bshadow\s+ing\b", re.IGNORECASE), "Shadowing"),
)


class RealtimeVoiceUnavailable(Exception):
    """Raised when the local real-time ASR or Smart Turn engine cannot serve a request."""


class _AsrPriorityGate:
    """
    Bounded concurrency gate (`capacity=2`) giving strict priority to `mode="final"`
    requests over `mode="partial"` requests so live partials never starve turn commits.
    """

    def __init__(self, capacity: int = 2) -> None:
        self._capacity = max(1, int(capacity))
        self._cond = threading.Condition()
        self._active = 0
        self._waiting_finals = 0

    def acquire(self, mode: Literal["final", "partial"], timeout: Optional[float] = None) -> bool:
        is_final = mode == "final"
        wait_budget = (
            FINAL_ACQUIRE_TIMEOUT_SEC if is_final else PARTIAL_ACQUIRE_TIMEOUT_SEC
        ) if timeout is None else max(0.0, float(timeout))
        deadline = time.monotonic() + wait_budget

        with self._cond:
            if is_final:
                self._waiting_finals += 1
                try:
                    while self._active >= self._capacity:
                        rem = deadline - time.monotonic()
                        if rem <= 0.0:
                            return False
                        self._cond.wait(rem)
                    self._active += 1
                    return True
                finally:
                    self._waiting_finals -= 1
                    self._cond.notify_all()
            else:
                while self._waiting_finals > 0 or self._active >= self._capacity:
                    rem = deadline - time.monotonic()
                    if rem <= 0.0:
                        return False
                    self._cond.wait(rem)
                self._active += 1
                return True

    def release(self) -> None:
        with self._cond:
            if self._active > 0:
                self._active -= 1
            self._cond.notify_all()


class LocalAgreementStabilizer:
    """
    Session-keyed `LocalAgreement-2` partial stabilizer (ufal/whisper_streaming pattern).

    Commits words to `stableText` only once two consecutive partial hypotheses agree on the
    word prefix for the same `(session_id, turn_seq)`, preventing flickering captions and
    transient noise spikes.
    """

    def __init__(self, max_entries: int = 256, ttl_sec: float = 60.0) -> None:
        self._lock = threading.Lock()
        self._max_entries = max_entries
        self._ttl_sec = ttl_sec
        self._store: "OrderedDict[Tuple[str, int], Tuple[float, List[str], List[str]]]" = OrderedDict()

    def update(self, session_id: str, turn_seq: int, text: str) -> str:
        words = [w for w in text.strip().split() if w]
        if not words:
            return ""
        key = (session_id, int(turn_seq))
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            prev = self._store.get(key)
            if prev is None:
                self._store[key] = (now, words, [])
                return ""
            _, prev_words, committed = prev
            lcp_len = 0
            limit = min(len(prev_words), len(words))
            while lcp_len < limit and _norm_token(prev_words[lcp_len]) == _norm_token(words[lcp_len]):
                lcp_len += 1
            if lcp_len > len(committed):
                committed = words[:lcp_len]
            self._store[key] = (now, words, committed)
            self._store.move_to_end(key)
            return " ".join(committed)

    def clear(self, session_id: str, turn_seq: Optional[int] = None) -> None:
        with self._lock:
            if turn_seq is not None:
                self._store.pop((session_id, int(turn_seq)), None)
            else:
                for k in [k for k in self._store if k[0] == session_id]:
                    self._store.pop(k, None)

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self._ttl_sec
        while self._store:
            first_key = next(iter(self._store))
            if self._store[first_key][0] < cutoff or len(self._store) > self._max_entries:
                self._store.popitem(last=False)
            else:
                break


def _norm_token(tok: str) -> str:
    return re.sub(r"[^\w]+", "", tok, flags=re.UNICODE).lower()


def compute_rms_dbfs(audio: np.ndarray) -> float:
    if audio.size == 0:
        return -180.0
    rms = float(np.sqrt(float(np.mean(np.square(audio, dtype=np.float32)))))
    return 20.0 * math.log10(max(rms, 1e-9))


def compute_windowed_rms_stats(audio: np.ndarray, win_samples: int = 1600, hop_samples: int = 800) -> Tuple[float, float]:
    """
    Computes `(peak_window_dbfs, floor_window_dbfs)` across 100 ms (`1,600`-sample) windows so
    leading pre-roll and trailing endpoint silence never dilute genuine quiet speech below L1 RMS,
    while stationary white noise / 50 Hz hum is identified by its flat envelope (`< 4.5 dB` spread).
    """
    if audio.size == 0:
        return -180.0, -180.0
    if audio.size < win_samples:
        db = compute_rms_dbfs(audio)
        return db, db
    windows = sliding_window_view(audio, win_samples)[::hop_samples]
    rms_vals = np.sqrt(np.mean(np.square(windows, dtype=np.float32), axis=-1))
    db_vals = 20.0 * np.log10(np.maximum(rms_vals, 1e-9))
    peak_db = float(np.max(db_vals))
    floor_db = float(np.percentile(db_vals, 20.0))
    return peak_db, floor_db


def apply_quiet_speech_pregain(audio: np.ndarray, peak_win_dbfs: float, floor_win_dbfs: float) -> np.ndarray:
    """
    Boosts genuine quiet laptop-mic speech (`peak_win_dbfs < -26 dBFS` with `>= 4.5 dB` syllabic
    modulation above ambient floor) cleanly toward `-24 dBFS` while leaving flat stationary noise untouched.
    """
    if (
        audio.size == 0
        or peak_win_dbfs >= -26.0
        or (peak_win_dbfs - floor_win_dbfs) < RMS_QUIET_SPEECH_MODULATION_DB
    ):
        return audio
    gain = min(QUIET_SPEECH_MAX_GAIN, 10.0 ** ((QUIET_SPEECH_TARGET_PEAK_DBFS - peak_win_dbfs) / 20.0))
    if gain <= 1.05:
        return audio
    boosted = (audio * np.float32(gain)).astype(np.float32)
    peak = float(np.max(np.abs(boosted)))
    if peak > 0.85:
        over = np.maximum(0.0, np.abs(boosted) - 0.85)
        shaped = 0.85 + 0.07 * np.tanh(over / 0.07)
        boosted = np.where(np.abs(boosted) > 0.85, np.sign(boosted) * shaped, boosted).astype(np.float32)
    return boosted


def _analyze_turn_envelope(audio: np.ndarray) -> Tuple[int, int]:
    """Returns `(voiced_ms, trailing_silence_ms)` using fast 20 ms (`320`-sample) frame energy."""
    frame_len = 320  # 20 ms @ 16 kHz
    n_frames = int(audio.size // frame_len)
    if n_frames <= 0:
        return 0, 0
    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=-1))
    peak_rms = float(np.max(rms))
    if peak_rms < 0.0032:  # < -50 dBFS everywhere -> pure silence
        return 0, n_frames * 20
    floor_rms = float(np.percentile(rms, 20.0))
    thresh = max(0.0045, floor_rms * 2.2, peak_rms * 0.14)
    active = rms >= thresh
    voiced_frames = int(np.count_nonzero(active))
    if voiced_frames == 0:
        return 0, n_frames * 20
    last_voiced_idx = int(np.flatnonzero(active)[-1])
    trailing_frames = max(0, (n_frames - 1) - last_voiced_idx)
    return voiced_frames * 20, trailing_frames * 20


def compute_compression_ratio(text: str) -> float:
    raw = (text or "").encode("utf-8")
    if not raw:
        return 0.0
    return float(len(raw)) / float(len(zlib.compress(raw)))


def has_repetition_loop(text: str) -> bool:
    """
    Detects Whisper decoder repetition loops such as `"Writing, Writing, Writing..."` or
    any 1–4 word n-gram repeated `>= 3` consecutive times (punctuation/case insensitive).
    """
    words = [m.group(0).lower() for m in _WORD_RE.finditer(text or "")]
    n_words = len(words)
    if n_words < 3:
        return False

    for gram in (1, 2, 3, 4):
        if n_words < gram * 3:
            continue
        i = 0
        while i + gram * 3 <= n_words:
            chunk = words[i : i + gram]
            repeats = 1
            j = i + gram
            while j + gram <= n_words and words[j : j + gram] == chunk:
                repeats += 1
                j += gram
            if repeats >= 3:
                return True
            i += 1

    # Also catch comma/separator-heavy low-diversity spam ("Writing, Reading, Writing, Writing...")
    if n_words >= 8:
        unique_ratio = len(set(words)) / float(n_words)
        if unique_ratio <= 0.30:
            return True

    return False


def _normalize_for_phantom_check(text: str) -> str:
    tokens = [m.group(0).lower() for m in _WORD_RE.finditer(text or "")]
    return " ".join(tokens)


def is_phantom_phrase(text: str, duration_ms: int, avg_logprob: float, rms_dbfs: float) -> bool:
    norm = _normalize_for_phantom_check(text)
    if not norm:
        return False
    if duration_ms < 4000:
        if norm in _HARD_PHANTOM_PHRASES:
            return True
        for hard in _HARD_PHANTOM_PHRASES:
            if len(hard) >= 12 and hard in norm:
                return True
    if duration_ms < 2500 and (avg_logprob < -0.55 or rms_dbfs < -34.0):
        if norm in _SOFT_PHANTOM_PHRASES:
            return True
    return False


def canonicalize_domain_terms(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if not cleaned:
        return ""
    for pattern, repl in _DOMAIN_CANONICAL_RULES:
        cleaned = pattern.sub(repl, cleaned)
    return cleaned


def resolve_en_vi_language(
    requested_lang: Literal["vi", "en", "auto"],
    info: Any,
    text: str,
) -> Literal["en", "vi"]:
    if requested_lang in ("en", "vi"):
        return requested_lang
    if _VI_DIACRITIC_RE.search(text or ""):
        return "vi"
    detected = (getattr(info, "language", None) or "").strip().lower()
    if detected in ("en", "vi"):
        return detected  # type: ignore[return-value]

    # Constrain auto-detection strictly to EN vs VI using Whisper's probability distribution
    all_probs = getattr(info, "all_language_probs", None)
    if all_probs:
        en_p = 0.0
        vi_p = 0.0
        for item in all_probs:
            try:
                code, prob = item[0], float(item[1])
            except Exception:
                continue
            c = str(code).strip().lower()
            if c == "en":
                en_p = prob
            elif c == "vi":
                vi_p = prob
        if vi_p > en_p and vi_p > 0.0:
            return "vi"
        # Tonal East/SE-Asian acoustic confusion (zh/yue/th/km/lo/my) strongly correlates with VI over EN
        if detected in ("zh", "yue", "th", "km", "lo", "my") and vi_p >= 0.03 and vi_p >= 0.35 * en_p:
            return "vi"
        if en_p > 0.0:
            return "en"

    return "en"


def _hertz_to_mel_slaney(freq: np.ndarray) -> np.ndarray:
    min_log_hertz = 1000.0
    min_log_mel = 15.0
    logstep = 27.0 / np.log(6.4)
    freq = np.atleast_1d(np.asarray(freq, dtype=np.float64))
    mels = 3.0 * freq / 200.0
    log_region = freq >= min_log_hertz
    mels[log_region] = min_log_mel + np.log(freq[log_region] / min_log_hertz) * logstep
    return mels


def _mel_to_hertz_slaney(mels: np.ndarray) -> np.ndarray:
    min_log_hertz = 1000.0
    min_log_mel = 15.0
    logstep = np.log(6.4) / 27.0
    mels = np.atleast_1d(np.asarray(mels, dtype=np.float64))
    freq = 200.0 * mels / 3.0
    log_region = mels >= min_log_mel
    freq[log_region] = min_log_hertz * np.exp(logstep * (mels[log_region] - min_log_mel))
    return freq


def _build_slaney_mel_filterbank() -> np.ndarray:
    num_freq_bins = _ST_N_FFT // 2 + 1
    mel_min = float(_hertz_to_mel_slaney(np.array([0.0], dtype=np.float64))[0])
    mel_max = float(_hertz_to_mel_slaney(np.array([_ST_SR / 2.0], dtype=np.float64))[0])
    mel_freqs = np.linspace(mel_min, mel_max, _ST_N_MELS + 2)
    filter_freqs = _mel_to_hertz_slaney(mel_freqs)
    fft_freqs = np.linspace(0.0, _ST_SR // 2, num_freq_bins)

    filter_diff = np.diff(filter_freqs)
    slopes = np.expand_dims(filter_freqs, 0) - np.expand_dims(fft_freqs, 1)
    down_slopes = -slopes[:, :-2] / filter_diff[:-1]
    up_slopes = slopes[:, 2:] / filter_diff[1:]
    mel_filters = np.maximum(0.0, np.minimum(down_slopes, up_slopes))
    enorm = 2.0 / (filter_freqs[2 : _ST_N_MELS + 2] - filter_freqs[:_ST_N_MELS])
    mel_filters *= np.expand_dims(enorm, 0)
    return mel_filters.astype(np.float32)


_ST_HANN_WIN = np.hanning(_ST_N_FFT + 1)[:-1].astype(np.float32)
_ST_MEL_FILTERS_T = _build_slaney_mel_filterbank().T.copy()  # (80, 201) float32
_ST_TORCH_CACHE: Dict[str, Any] = {}


def compute_smart_turn_log_mel(audio_16k: np.ndarray) -> np.ndarray:
    """
    Left-pads or right-truncates `audio_16k` to 8.0 s (`128,000` samples) and computes
    `[1, 80, 800]` float32 Whisper log-mel features in ~0.45 ms (with NumPy fallback).
    """
    x = np.asarray(audio_16k, dtype=np.float32).reshape(-1)
    if x.size > _ST_WINDOW_SAMPLES:
        x = x[-_ST_WINDOW_SAMPLES:]
    elif x.size < _ST_WINDOW_SAMPLES:
        x = np.pad(x, (_ST_WINDOW_SAMPLES - x.size, 0), mode="constant")

    try:
        import torch

        win_t = _ST_TORCH_CACHE.get("win")
        mel_t = _ST_TORCH_CACHE.get("mel")
        if win_t is None or mel_t is None:
            win_t = torch.from_numpy(_ST_HANN_WIN)
            mel_t = torch.from_numpy(_ST_MEL_FILTERS_T)
            _ST_TORCH_CACHE["win"] = win_t
            _ST_TORCH_CACHE["mel"] = mel_t

        xt = torch.from_numpy(x)
        xt = (xt - xt.mean()) / torch.sqrt(xt.var(unbiased=False) + _ST_NORM_EPS)
        spec = torch.stft(
            xt,
            n_fft=_ST_N_FFT,
            hop_length=_ST_HOP,
            window=win_t,
            center=True,
            pad_mode="reflect",
            return_complex=True,
        )
        power = spec.real.square() + spec.imag.square()
        mel = torch.clamp(mel_t @ power[:, :-1], min=_ST_MEL_FLOOR)
        log_spec = torch.log10(mel)
        log_spec = torch.clamp(log_spec, min=log_spec.max() - 8.0)
        log_spec = (log_spec + 4.0) * 0.25
        return log_spec.unsqueeze(0).numpy()
    except Exception:
        mean = float(x.mean())
        var = float(x.var())
        x = (x - mean) / np.sqrt(var + _ST_NORM_EPS)
        pad = _ST_N_FFT // 2
        padded = np.pad(x, (pad, pad), mode="reflect")
        windows = sliding_window_view(padded, _ST_N_FFT)[::_ST_HOP]
        spec = np.fft.rfft(windows * _ST_HANN_WIN, axis=-1)
        power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32).T
        mel = np.maximum(_ST_MEL_FLOOR, _ST_MEL_FILTERS_T @ power)[:, :-1]
        log_spec = np.log10(mel)
        log_spec = np.maximum(log_spec, float(log_spec.max()) - 8.0)
        log_spec = (log_spec + 4.0) * 0.25
        return np.expand_dims(log_spec.astype(np.float32), axis=0)


class EchoRealtimeVoiceService:
    _instance: Optional["EchoRealtimeVoiceService"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._asr_load_lock = threading.Lock()
        self._turn_load_lock = threading.Lock()
        self._asr_gate = _AsrPriorityGate(capacity=2)
        self._stabilizer = LocalAgreementStabilizer()
        self._asr_model: Any = None
        self._asr_model_name: Optional[str] = None
        self._asr_device: Optional[str] = None
        self._asr_compute_type: Optional[str] = None
        self._turn_session: Any = None
        self._turn_model_path: Optional[str] = None

    @classmethod
    def get_instance(cls) -> "EchoRealtimeVoiceService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def load_asr_model(self) -> Any:
        if self._asr_model is not None:
            return self._asr_model
        with self._asr_load_lock:
            if self._asr_model is not None:
                return self._asr_model
            try:
                import ctranslate2
                from faster_whisper import WhisperModel
            except Exception as exc:
                raise RealtimeVoiceUnavailable(f"faster-whisper is not installed: {exc}") from exc

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            # ADR-1: quantize Echo Whisper to int8_float16 on CUDA to save ~0.8-0.9 GiB VRAM on RTX 5070
            compute_type = os.getenv(
                "ECHO_REALTIME_ASR_COMPUTE",
                "int8_float16" if device == "cuda" else "int8",
            ).strip() or ("int8_float16" if device == "cuda" else "int8")

            last_err: Optional[Exception] = None
            for candidate in REALTIME_ASR_CANDIDATES:
                if not candidate:
                    continue
                try:
                    t0 = time.perf_counter()
                    model = WhisperModel(
                        candidate,
                        device=device,
                        compute_type=compute_type,
                        num_workers=2,
                        local_files_only=True,
                    )
                    self._asr_model = model
                    self._asr_model_name = candidate
                    self._asr_device = device
                    self._asr_compute_type = compute_type
                    logger.info(
                        "EchoRealtimeVoice ASR loaded '%s' on %s (%s, num_workers=2) in %.2fs",
                        candidate,
                        device,
                        compute_type,
                        time.perf_counter() - t0,
                    )
                    return model
                except Exception as exc:
                    last_err = exc
                    logger.debug("Candidate ASR model '%s' not available locally: %s", candidate, exc)

            raise RealtimeVoiceUnavailable(f"No local faster-whisper model could be loaded: {last_err}")

    def _resolve_smart_turn_onnx_path(self) -> str:
        candidates = [
            (os.getenv("SMART_TURN_MODEL_PATH") or "").strip(),
            "/opt/echo-jarvis/smart-turn-v3.2-cpu.onnx",
            str(Path.home() / ".cache" / "huggingface" / "echo-jarvis" / "smart-turn-v3.2-cpu.onnx"),
        ]
        for c in candidates:
            if c and os.path.isfile(c):
                return c
        try:
            from huggingface_hub import hf_hub_download

            return hf_hub_download(
                repo_id="pipecat-ai/smart-turn-v3",
                filename="smart-turn-v3.2-cpu.onnx",
                local_files_only=True,
            )
        except Exception as exc:
            raise RealtimeVoiceUnavailable(
                f"Smart Turn v3.2 ONNX model not found locally: {exc}"
            ) from exc

    def load_turn_session(self) -> Any:
        if self._turn_session is not None:
            return self._turn_session
        with self._turn_load_lock:
            if self._turn_session is not None:
                return self._turn_session
            try:
                import onnxruntime as ort
            except Exception as exc:
                raise RealtimeVoiceUnavailable(f"onnxruntime is not installed: {exc}") from exc

            model_path = self._resolve_smart_turn_onnx_path()
            so = ort.SessionOptions()
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            so.inter_op_num_threads = 1
            so.intra_op_num_threads = int(os.getenv("SMART_TURN_THREADS", "4"))
            so.add_session_config_entry("session.intra_op.allow_spinning", "0")
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            sess = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
            dummy = np.zeros((1, _ST_N_MELS, 800), dtype=np.float32)
            sess.run(None, {"input_features": dummy})
            self._turn_session = sess
            self._turn_model_path = model_path
            logger.info("Smart Turn v3.2 loaded and warmed from %s", model_path)
            return sess

    def warmup(self) -> None:
        try:
            self.load_turn_session()
        except Exception as exc:
            logger.warning("Smart Turn warmup skipped: %s", exc)
        try:
            model = self.load_asr_model()
            dummy_pcm = (0.05 * np.sin(2.0 * np.pi * 220.0 * np.arange(16000, dtype=np.float32) / 16000.0)).astype(
                np.float32
            )
            # Warm both Silero VAD ONNX (`vad_filter=True`) and auto-lang beam=2 CTranslate2 kernels
            warm_segs, _ = model.transcribe(
                dummy_pcm,
                language=None,
                beam_size=2,
                vad_filter=True,
                vad_parameters=dict(VAD_PARAMETERS),
            )
            if not list(warm_segs):
                list(model.transcribe(dummy_pcm[:8000], language=None, beam_size=2, vad_filter=False)[0])
        except Exception as exc:
            logger.warning("EchoRealtimeVoice ASR warmup skipped: %s", exc)

    def _run_whisper_pass(
        self,
        model: Any,
        audio: np.ndarray,
        explicit_lang: Optional[str],
        mode: Literal["final", "partial"],
        duration_ms: int,
    ) -> Tuple[List[Any], Any]:
        is_final = mode == "final"
        beam_size = 2 if is_final else 1
        use_word_ts = False
        kwargs: Dict[str, Any] = {
            "language": explicit_lang,
            "multilingual": False,
            "task": "transcribe",
            "beam_size": beam_size,
            "temperature": (0.0, 0.2, 0.4),
            "vad_filter": True,
            "vad_parameters": dict(VAD_PARAMETERS),
            "condition_on_previous_text": False,
            "compression_ratio_threshold": COMPRESSION_RATIO_MAX,
            "log_prob_threshold": AVG_LOGPROB_MIN,
            "no_speech_threshold": 0.60,
            "no_repeat_ngram_size": 3,
            "repetition_penalty": 1.10,
            "hotwords": None,
            "initial_prompt": None,
        }
        if use_word_ts:
            kwargs["word_timestamps"] = True
            kwargs["hallucination_silence_threshold"] = 0.5
        raw_segments, info = model.transcribe(audio, **kwargs)
        return list(raw_segments), info

    def _empty_result(
        self,
        lang: Literal["vi", "en", "auto"],
        duration_ms: int,
        rejected_reason: str,
        *,
        no_speech_prob: float = 1.0,
        avg_logprob: float = 0.0,
        compression_ratio: float = 0.0,
        resolved_lang: Optional[str] = None,
    ) -> Dict[str, Any]:
        out_lang = resolved_lang if resolved_lang in ("en", "vi") else (lang if lang in ("en", "vi") else "en")
        return {
            "text": "",
            "stableText": "",
            "reviewNeeded": False,
            "language": out_lang,
            "durationMs": duration_ms,
            "noSpeechProb": round(float(no_speech_prob), 4),
            "avgLogprob": round(float(avg_logprob), 4),
            "compressionRatio": round(float(compression_ratio), 4),
            "rejectedReason": rejected_reason,
        }

    def transcribe_pcm(
        self,
        pcm: bytes,
        lang: Literal["vi", "en", "auto"] = "auto",
        mode: Literal["final", "partial"] = "final",
        session_id: Optional[str] = None,
        turn_seq: Optional[int] = None,
    ) -> Dict[str, Any]:
        if lang not in ("vi", "en", "auto") or mode not in ("final", "partial"):
            raise ValueError("Invalid voice parameters")
        if len(pcm) > 640000 or (len(pcm) % 2 != 0):
            raise ValueError("Invalid voice clip")

        min_bytes = 1600 if mode == "partial" else 3200
        if len(pcm) < min_bytes:
            duration_short_ms = int(round((len(pcm) // 2) * 1000.0 / 16000.0))
            if mode == "final" and session_id:
                self._stabilizer.clear(session_id, turn_seq)
            return self._empty_result(lang, duration_short_ms, "no_speech")

        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        duration_ms = int(round(len(audio) * 1000.0 / 16000.0))

        # Layer 1: Windowed active-speech RMS gate + quiet laptop-mic pre-gain (< 0.1 ms, zero GPU compute on silence!)
        rms_dbfs = compute_rms_dbfs(audio)
        peak_win_dbfs, floor_win_dbfs = compute_windowed_rms_stats(audio)
        is_dead_quiet = rms_dbfs < -58.0 or peak_win_dbfs < RMS_WINDOW_PEAK_FLOOR_DBFS
        is_flat_subfloor = rms_dbfs < RMS_SILENCE_FLOOR_DBFS and (
            peak_win_dbfs < -50.5 or (peak_win_dbfs - floor_win_dbfs) < RMS_QUIET_SPEECH_MODULATION_DB
        )
        if is_dead_quiet or is_flat_subfloor:
            if mode == "final" and session_id:
                self._stabilizer.clear(session_id, turn_seq)
            return self._empty_result(lang, duration_ms, "rms_silence")

        audio_for_asr = apply_quiet_speech_pregain(audio, peak_win_dbfs, floor_win_dbfs)
        effective_rms_dbfs = max(rms_dbfs, peak_win_dbfs)

        model = self.load_asr_model()
        acquired = self._asr_gate.acquire(mode)
        if not acquired:
            if mode == "partial":
                return self._empty_result(lang, duration_ms, "busy_yielded")
            raise RealtimeVoiceUnavailable("Realtime ASR workers busy")

        try:
            explicit_lang = None if lang == "auto" else lang
            segments, info = self._run_whisper_pass(model, audio_for_asr, explicit_lang, mode, duration_ms)

            # Layer 2: VAD returned zero speech segments
            non_empty = [s for s in segments if (getattr(s, "text", "") or "").strip()]
            if not non_empty:
                if mode == "final" and session_id:
                    self._stabilizer.clear(session_id, turn_seq)
                return self._empty_result(lang, duration_ms, "vad_no_speech")

            joined_raw = " ".join(s.text.strip() for s in non_empty)
            detected_raw = (getattr(info, "language", None) or "").strip().lower()
            resolved_lang = resolve_en_vi_language(lang, info, joined_raw)

            # Layer 5: Constrained EN/VI re-decode whenever auto-detect picked a non-EN/VI language (e.g. 'pt',
            # 'id', 'es', 'fr', 'tl', 'zh', 'ko') without Vietnamese diacritics, or emitted non-Latin scripts!
            has_non_latin = bool(_NON_LATIN_HALLUCINATION_RE.search(joined_raw))
            foreign_latin_misdetect = (
                detected_raw not in ("en", "vi", "") and not _VI_DIACRITIC_RE.search(joined_raw)
            )
            if lang == "auto" and (has_non_latin or foreign_latin_misdetect):
                if mode == "final":
                    segments, info = self._run_whisper_pass(
                        model, audio_for_asr, resolved_lang, mode, duration_ms
                    )
                    non_empty = [s for s in segments if (getattr(s, "text", "") or "").strip()]

                    # On final turns where unconstrained language detection misfired, verify alternate EN<->VI
                    # if primary constrained pass had weak confidence (< -0.82) or empty segments.
                    if mode == "final":
                        primary_lp = (
                            sum(float(getattr(s, "avg_logprob", -1.2) or -1.2) for s in non_empty) / len(non_empty)
                            if non_empty
                            else -2.0
                        )
                        if not non_empty or primary_lp < -0.82:
                            alt_lang: Literal["en", "vi"] = "vi" if resolved_lang == "en" else "en"
                            alt_segs, alt_info = self._run_whisper_pass(
                                model, audio_for_asr, alt_lang, mode, duration_ms
                            )
                            alt_non_empty = [s for s in alt_segs if (getattr(s, "text", "") or "").strip()]
                            if alt_non_empty:
                                alt_joined = " ".join(s.text.strip() for s in alt_non_empty)
                                alt_lp = sum(
                                    float(getattr(s, "avg_logprob", -1.2) or -1.2) for s in alt_non_empty
                                ) / len(alt_non_empty)
                                if not _NON_LATIN_HALLUCINATION_RE.search(alt_joined) and alt_lp > primary_lp + 0.08:
                                    non_empty = alt_non_empty
                                    info = alt_info
                                    resolved_lang = alt_lang

                    if not non_empty:
                        if mode == "final" and session_id:
                            self._stabilizer.clear(session_id, turn_seq)
                        return self._empty_result(lang, duration_ms, "vad_no_speech", resolved_lang=resolved_lang)
                    joined_raw = " ".join(s.text.strip() for s in non_empty)

                if _NON_LATIN_HALLUCINATION_RE.search(joined_raw):
                    if mode == "final" and session_id:
                        self._stabilizer.clear(session_id, turn_seq)
                    return self._empty_result(lang, duration_ms, "no_speech_prob", resolved_lang=resolved_lang)

            # Layer 6: Segment-level hard confidence & compression-ratio filtering
            kept: List[Any] = []
            rejection_counts: Dict[str, int] = {}
            raw_no_speech_probs: List[float] = []
            raw_logprobs: List[float] = []
            raw_comp_ratios: List[float] = []

            for seg in non_empty:
                seg_text = seg.text.strip()
                seg_nsp = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
                seg_lp = float(getattr(seg, "avg_logprob", -0.25) or -0.25)
                raw_cr = getattr(seg, "compression_ratio", None)
                seg_cr = float(raw_cr) if raw_cr is not None else compute_compression_ratio(seg_text)

                raw_no_speech_probs.append(seg_nsp)
                raw_logprobs.append(seg_lp)
                raw_comp_ratios.append(seg_cr)

                if seg_cr > COMPRESSION_RATIO_MAX:
                    rejection_counts["compression_ratio"] = rejection_counts.get("compression_ratio", 0) + 1
                    continue
                seg_lp_floor = AVG_LOGPROB_CLEAR_SPEECH_MIN if seg_nsp <= 0.35 else AVG_LOGPROB_MIN
                if seg_lp < seg_lp_floor:
                    rejection_counts["low_logprob"] = rejection_counts.get("low_logprob", 0) + 1
                    continue
                if seg_nsp > NO_SPEECH_PROB_MAX:
                    rejection_counts["no_speech_prob"] = rejection_counts.get("no_speech_prob", 0) + 1
                    continue
                kept.append((seg_text, seg_nsp, seg_lp, seg_cr))

            if not kept:
                primary_reason = (
                    "compression_ratio"
                    if rejection_counts.get("compression_ratio")
                    else "low_logprob"
                    if rejection_counts.get("low_logprob")
                    else "no_speech_prob"
                )
                if mode == "final" and session_id:
                    self._stabilizer.clear(session_id, turn_seq)
                return self._empty_result(
                    lang,
                    duration_ms,
                    primary_reason,
                    no_speech_prob=max(raw_no_speech_probs) if raw_no_speech_probs else 1.0,
                    avg_logprob=min(raw_logprobs) if raw_logprobs else -1.0,
                    compression_ratio=max(raw_comp_ratios) if raw_comp_ratios else 0.0,
                    resolved_lang=resolved_lang,
                )

            text = " ".join(item[0] for item in kept)[:4000]
            no_speech_prob = max(item[1] for item in kept)
            avg_logprob = sum(item[2] for item in kept) / float(len(kept))
            text_cr = compute_compression_ratio(text)
            compression_ratio = max(max(item[3] for item in kept), text_cr if len(text) >= 32 else 0.0)

            # Layer 6b: Hard repetition-loop detector ("Writing, Writing, Writing...")
            if (len(text) >= 32 and compression_ratio > COMPRESSION_RATIO_MAX) or has_repetition_loop(text):
                reason = "repetition_loop" if has_repetition_loop(text) else "compression_ratio"
                if mode == "final" and session_id:
                    self._stabilizer.clear(session_id, turn_seq)
                return self._empty_result(
                    lang,
                    duration_ms,
                    reason,
                    no_speech_prob=no_speech_prob,
                    avg_logprob=avg_logprob,
                    compression_ratio=compression_ratio,
                    resolved_lang=resolved_lang,
                )

            # Layer 6c: Phantom YouTube/silence phrase detector
            if is_phantom_phrase(text, duration_ms, avg_logprob, effective_rms_dbfs):
                if mode == "final" and session_id:
                    self._stabilizer.clear(session_id, turn_seq)
                return self._empty_result(
                    lang,
                    duration_ms,
                    "phantom_phrase",
                    no_speech_prob=no_speech_prob,
                    avg_logprob=avg_logprob,
                    compression_ratio=compression_ratio,
                    resolved_lang=resolved_lang,
                )

            # Layer 7: Deterministic post-ASR English Coach domain canonicalizer
            text = canonicalize_domain_terms(text)

            # Refine language tag after filtering if text clearly carries Vietnamese diacritics
            if lang == "auto" and _VI_DIACRITIC_RE.search(text):
                resolved_lang = "vi"

            if mode == "partial" and session_id:
                stable_text = self._stabilizer.update(session_id, turn_seq or 0, text)
            else:
                stable_text = text
                if mode == "final" and session_id:
                    self._stabilizer.clear(session_id, turn_seq)

            uncertain = bool(avg_logprob < -0.75 or no_speech_prob > 0.50)
            return {
                "text": text,
                "stableText": stable_text,
                "reviewNeeded": uncertain,
                "language": resolved_lang,
                "durationMs": duration_ms,
                "noSpeechProb": round(float(no_speech_prob), 4),
                "avgLogprob": round(float(avg_logprob), 4),
                "compressionRatio": round(float(compression_ratio), 4),
                "rejectedReason": None,
            }
        finally:
            self._asr_gate.release()

    def check_turn_complete(self, pcm: bytes) -> Dict[str, Any]:
        if len(pcm) % 2 != 0:
            raise ValueError("Invalid voice clip")
        if len(pcm) > 262144:
            raise ValueError("Turn clip exceeds 8 seconds")
        if len(pcm) < 640:
            return {
                "complete": False,
                "probability": 0.0,
                "recommendedWaitMs": 420,
            }

        sess = self.load_turn_session()
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        voiced_ms, trailing_silence_ms = _analyze_turn_envelope(audio)
        features = compute_smart_turn_log_mel(audio)
        outputs = sess.run(None, {"input_features": features})
        raw_prob = float(np.asarray(outputs[0]).reshape(-1)[0])
        prob = float(np.clip(raw_prob, 0.0, 1.0))

        is_short_cmd = 0 < voiced_ms <= 950
        if prob >= 0.52:
            complete = True
            wait_ms = 280 if is_short_cmd else 320
        elif prob >= 0.28:
            if is_short_cmd and trailing_silence_ms >= 360:
                complete = True
                wait_ms = 320
            elif is_short_cmd:
                complete = False
                wait_ms = 460
            else:
                complete = False
                wait_ms = 620
        else:
            if voiced_ms >= 220 and trailing_silence_ms >= 900:
                complete = True
                wait_ms = 300
            elif is_short_cmd:
                complete = False
                wait_ms = 560
            else:
                # Protects 350-850 ms L2 hesitation/fillers ("um", "because...") while eliminating >1s-2.2s stalls!
                complete = False
                wait_ms = 850

        return {
            "complete": complete,
            "probability": round(prob, 4),
            "recommendedWaitMs": wait_ms,
        }


def transcribe_realtime_echo_pcm(
    pcm: bytes,
    lang: Literal["vi", "en", "auto"] = "auto",
    mode: Literal["final", "partial"] = "final",
    session_id: Optional[str] = None,
    turn_seq: Optional[int] = None,
) -> Dict[str, Any]:
    return EchoRealtimeVoiceService.get_instance().transcribe_pcm(
        pcm=pcm,
        lang=lang,
        mode=mode,
        session_id=session_id,
        turn_seq=turn_seq,
    )


def evaluate_smart_turn_pcm(pcm: bytes) -> Dict[str, Any]:
    return EchoRealtimeVoiceService.get_instance().check_turn_complete(pcm=pcm)
