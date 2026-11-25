from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import math
import subprocess
import time
from typing import Optional

import numpy as np

logger = logging.getLogger("audio_ingestion")

CANONICAL_SAMPLE_RATE = 16_000
CANONICAL_CHANNELS = 1
MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_AUDIO_DURATION_SECONDS = 30.0
DECODE_TIMEOUT_SECONDS = 12.0
DECODE_PATH_VERSION = "ffmpeg-pipe-v1"

ALLOWED_MIME_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mp4",
    "audio/m4a",
    "audio/mpeg",
    "audio/flac",
    "audio/x-flac",
    "application/octet-stream",  # legacy gateways; bytes remain authoritative
}


class AudioIngestionError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def validate_audio_magic_bytes(audio_bytes: bytes) -> str:
    """Validate container magic bytes before passing untrusted bytes to ffprobe/ffmpeg (EC-SEC-2026-030).

    Allowlists only:
    - WebM / Matroska (EBML): 0x1A 0x45 0xDF 0xA3
    - WAV: RIFF....WAVE
    - OGG: OggS
    - MP4 / M4A: ....ftyp
    - FLAC: fLaC
    - MP3: ID3 or MPEG frame sync (0xFF, (b1 & 0xE0) == 0xE0)

    Rejects playlists / manifests (#EXTM3U, ffconcat, SDP, HTML, SVG, arbitrary bytes)
    before any subprocess invocation.
    """
    if not audio_bytes:
        raise AudioIngestionError("AUDIO_EMPTY", "audio payload is empty")
    if len(audio_bytes) >= 4 and audio_bytes[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if len(audio_bytes) >= 12 and audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
        return "wav"
    if len(audio_bytes) >= 4 and audio_bytes[:4] == b"OggS":
        return "ogg"
    if len(audio_bytes) >= 8 and audio_bytes[4:8] == b"ftyp":
        return "mp4"
    if len(audio_bytes) >= 4 and audio_bytes[:4] == b"fLaC":
        return "flac"
    if len(audio_bytes) >= 3 and audio_bytes[:3] == b"ID3":
        return "mp3"
    if (
        len(audio_bytes) >= 2
        and audio_bytes[0] == 0xFF
        and (audio_bytes[1] & 0xE0) == 0xE0
        and (audio_bytes[1] & 0x18) != 0x08
        and (audio_bytes[1] & 0x06) != 0x00
    ):
        return "mp3"
    raise AudioIngestionError(
        "AUDIO_DECODE_FAILED",
        "audio payload does not match an allowed audio container signature",
    )


@dataclass(frozen=True)
class CanonicalAudio:
    waveform: np.ndarray
    sample_rate: int
    channels: int
    duration_seconds: float
    source_mime_type: str
    source_container: str
    source_codec: str
    source_sample_rate: int
    source_channels: int
    source_size_bytes: int
    first_bytes_hex: str
    canonical_format: str
    decode_path_version: str
    decode_latency_ms: float


def normalize_mime_type(content_type: Optional[str]) -> str:
    return (content_type or "application/octet-stream").split(";", 1)[0].strip().lower()


def _probe(audio_bytes: bytes) -> dict:
    validate_audio_magic_bytes(audio_bytes)
    command = [
        "ffprobe", "-v", "error",
        "-protocol_whitelist", "pipe",
        "-print_format", "json",
        "-show_format", "-show_streams", "pipe:0",
    ]
    try:
        completed = subprocess.run(
            command,
            input=audio_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=DECODE_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AudioIngestionError("AUDIO_NORMALIZATION_FAILED", "ffprobe is unavailable") from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioIngestionError("AUDIO_DECODE_FAILED", "audio probe timed out") from exc

    if completed.returncode != 0:
        raise AudioIngestionError("AUDIO_DECODE_FAILED", "audio container could not be probed")

    try:
        payload = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudioIngestionError("AUDIO_DECODE_FAILED", "audio probe returned invalid metadata") from exc

    audio_stream = next(
        (stream for stream in payload.get("streams", []) if stream.get("codec_type") == "audio"),
        None,
    )
    if audio_stream is None:
        raise AudioIngestionError("AUDIO_UNSUPPORTED_FORMAT", "input contains no supported audio stream")
    return {"format": payload.get("format", {}), "stream": audio_stream}


def decode_browser_audio(
    audio_bytes: bytes,
    *,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
    max_duration_seconds: float = MAX_AUDIO_DURATION_SECONDS,
) -> CanonicalAudio:
    if not audio_bytes:
        raise AudioIngestionError("AUDIO_EMPTY", "audio payload is empty")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise AudioIngestionError("AUDIO_TOO_LARGE", "audio payload exceeds configured size limit")

    source_mime = normalize_mime_type(content_type)
    if source_mime not in ALLOWED_MIME_TYPES:
        raise AudioIngestionError("AUDIO_UNSUPPORTED_FORMAT", "declared audio MIME type is not allowed")

    validate_audio_magic_bytes(audio_bytes)

    started = time.perf_counter()
    try:
        probed = _probe(audio_bytes)
        stream = probed["stream"]
        fmt = probed["format"]
        source_codec = str(stream.get("codec_name") or "unknown")
        source_container = str(fmt.get("format_name") or "unknown")
        source_rate = int(stream.get("sample_rate") or CANONICAL_SAMPLE_RATE)
        source_channels = int(stream.get("channels") or 1)

        command = [
            "ffmpeg", "-v", "error", "-nostdin", "-threads", "1",
            "-protocol_whitelist", "pipe",
            "-i", "pipe:0", "-vn", "-sn", "-dn",
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ac", str(CANONICAL_CHANNELS), "-ar", str(CANONICAL_SAMPLE_RATE), "pipe:1",
        ]
        completed = subprocess.run(
            command,
            input=audio_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=DECODE_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0:
            raise AudioIngestionError("AUDIO_DECODE_FAILED", "audio decoder rejected the input")
        if not completed.stdout:
            raise AudioIngestionError("AUDIO_EMPTY", "decoded audio stream is empty")

        waveform = np.frombuffer(completed.stdout, dtype="<f4").astype(np.float32, copy=True)
    except AudioIngestionError as aie:
        if aie.code == "AUDIO_NORMALIZATION_FAILED" and len(audio_bytes) >= 12 and audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
            import io, wave
            try:
                with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
                    source_channels = wf.getnchannels()
                    source_rate = wf.getframerate()
                    sampwidth = wf.getsampwidth()
                    n_frames = wf.getnframes()
                    raw_data = wf.readframes(n_frames)
                    if sampwidth == 2:
                        samples = np.frombuffer(raw_data, dtype="<i2").astype(np.float32) / 32768.0
                        source_codec = "pcm_s16le"
                    elif sampwidth == 1:
                        samples = (np.frombuffer(raw_data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
                        source_codec = "pcm_u8"
                    elif sampwidth == 3:
                        raw_u8 = np.frombuffer(raw_data, dtype=np.uint8)
                        n_samples = raw_u8.size // 3
                        tri = raw_u8[: n_samples * 3].reshape(-1, 3).astype(np.int32)
                        signed = tri[:, 0] | (tri[:, 1] << 8) | (tri[:, 2] << 16)
                        signed = np.where(signed >= 0x800000, signed - 0x1000000, signed)
                        samples = signed.astype(np.float32) / 8388608.0
                        source_codec = "pcm_s24le"
                    elif sampwidth == 4:
                        samples = np.frombuffer(raw_data, dtype="<i4").astype(np.float32) / 2147483648.0
                        source_codec = "pcm_s32le"
                    else:
                        samples = np.frombuffer(raw_data, dtype="<f4").astype(np.float32, copy=True)
                        source_codec = "pcm_f32le"
                    if source_channels > 1:
                        usable = (samples.size // source_channels) * source_channels
                        samples = samples[:usable].reshape(-1, source_channels).mean(axis=1)
                    if source_rate < 4000 or source_rate > 192000:
                        raise AudioIngestionError(
                            "AUDIO_INVALID_SAMPLE_RATE",
                            f"WAV sample rate {source_rate} Hz is outside allowed bounds [4000, 192000]",
                        )
                    if source_rate != CANONICAL_SAMPLE_RATE and len(samples) > 0:
                        n_target = int(round(len(samples) * CANONICAL_SAMPLE_RATE / source_rate))
                        max_target_samples = int((max_duration_seconds + 1.0) * CANONICAL_SAMPLE_RATE)
                        if n_target <= 0 or n_target > max_target_samples:
                            raise AudioIngestionError(
                                "AUDIO_TOO_LONG",
                                f"WAV duration exceeds maximum supported length of {max_duration_seconds:.0f}s",
                            )
                        from scipy.signal import resample_poly

                        g = math.gcd(CANONICAL_SAMPLE_RATE, source_rate)
                        waveform = resample_poly(
                            samples,
                            CANONICAL_SAMPLE_RATE // g,
                            source_rate // g,
                        ).astype(np.float32)
                    else:
                        waveform = samples.astype(np.float32)
                    source_container = "wav"
            except AudioIngestionError:
                raise
            except Exception as w_err:
                logger.warning("WAV decode fallback failed: %s", w_err)
                raise AudioIngestionError("AUDIO_DECODE_FAILED", "WAV audio stream could not be decoded.") from w_err
        else:
            raise
    if waveform.size == 0:
        raise AudioIngestionError("AUDIO_EMPTY", "decoded audio stream has zero samples")
    if not np.isfinite(waveform).all():
        raise AudioIngestionError("AUDIO_NORMALIZATION_FAILED", "decoded waveform contains non-finite samples")

    duration_seconds = waveform.size / CANONICAL_SAMPLE_RATE
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise AudioIngestionError("AUDIO_INVALID_DURATION", "decoded duration is invalid")
    if duration_seconds > max_duration_seconds:
        raise AudioIngestionError("AUDIO_TOO_LONG", "decoded audio exceeds configured duration limit")

    latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
    canonical = CanonicalAudio(
        waveform=waveform,
        sample_rate=CANONICAL_SAMPLE_RATE,
        channels=CANONICAL_CHANNELS,
        duration_seconds=duration_seconds,
        source_mime_type=source_mime,
        source_container=source_container,
        source_codec=source_codec,
        source_sample_rate=source_rate,
        source_channels=source_channels,
        source_size_bytes=len(audio_bytes),
        first_bytes_hex=audio_bytes[:12].hex(),
        canonical_format="float32le",
        decode_path_version=DECODE_PATH_VERSION,
        decode_latency_ms=latency_ms,
    )
    logger.info(
        "canonical_audio requestFile=%s sourceMime=%s container=%s codec=%s "
        "sourceRate=%s sourceChannels=%s duration=%.3f canonicalRate=%s "
        "canonicalChannels=%s decodeMs=%.2f",
        filename or "upload",
        canonical.source_mime_type,
        canonical.source_container,
        canonical.source_codec,
        canonical.source_sample_rate,
        canonical.source_channels,
        canonical.duration_seconds,
        canonical.sample_rate,
        canonical.channels,
        canonical.decode_latency_ms,
    )
    return canonical


def compute_audio_quality_metrics(
    wav: np.ndarray,
    sr: int = CANONICAL_SAMPLE_RATE,
) -> dict:
    """Compute real acoustic signal quality metrics from a mono float32 waveform.

    Returns:
      - duration_sec: total audio duration (seconds)
      - rms_energy_db: overall RMS energy (dBFS)
      - snr_db: frame-percentile SNR estimate (p90 - p10 dB over 20 ms frames)
      - clipping_ratio: fraction of samples belonging to >= 2 consecutive near-full-scale samples
      - is_clipping: True when clipping_ratio >= 0.005
      - speech_ratio: active speech frame ratio in [0.0, 1.0]
      - silence_ratio: 1.0 - speech_ratio
      - spectral_flatness: mean Wiener entropy across active frames in [0.0, 1.0]
      - voicing_ratio: fraction of periodic voiced frames (65-450 Hz) in [0.0, 1.0]
      - peak_abs: maximum absolute sample amplitude
      - is_silent: True when recording is silent / effectively empty
    """
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    n = int(arr.size)
    if n == 0 or sr <= 0:
        return {
            "duration_sec": 0.0,
            "rms_energy_db": -120.0,
            "snr_db": 0.0,
            "clipping_ratio": 0.0,
            "is_clipping": False,
            "speech_ratio": 0.0,
            "silence_ratio": 1.0,
            "spectral_flatness": 1.0,
            "voicing_ratio": 0.0,
            "peak_abs": 0.0,
            "is_silent": True,
        }

    # Sanitize non-finite values defensively
    if not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=-1.0)

    duration_sec = float(n / float(sr))
    arr_dc = arr - float(np.mean(arr))
    rms = math.sqrt(float(np.mean(arr_dc * arr_dc)) + 1e-12)
    rms_energy_db = float(20.0 * math.log10(max(rms, 1e-6)))
    peak_abs = float(np.max(np.abs(arr)))

    # Consecutive-sample clipping (>= 2 adjacent samples at |x| >= 0.99)
    near_full = np.abs(arr) >= 0.99
    if n >= 2:
        left = np.concatenate(([False], near_full[:-1]))
        right = np.concatenate((near_full[1:], [False]))
        clipped_mask = near_full & (left | right)
        clipping_ratio = float(np.mean(clipped_mask))
    else:
        clipping_ratio = 0.0
    is_clipping = clipping_ratio >= 0.005

    # Frame-level energy & percentile SNR (20 ms frame, 10 ms hop)
    frame_len = max(16, int(round(sr * 0.020)))
    hop_len = max(8, int(round(sr * 0.010)))
    if n < frame_len:
        padded = np.pad(arr_dc, (0, frame_len - n))
    else:
        padded = arr_dc
    n_frames = 1 + (len(padded) - frame_len) // hop_len
    starts = np.arange(n_frames) * hop_len
    # Vectorized framing via stride_tricks or slice loop
    frame_rms = np.empty(n_frames, dtype=np.float64)
    for idx, st in enumerate(starts):
        fr = padded[st : st + frame_len]
        frame_rms[idx] = math.sqrt(float(np.mean(fr * fr)) + 1e-14)

    frame_db = 20.0 * np.log10(np.maximum(frame_rms, 1e-6))
    if n_frames >= 5:
        p90_db = float(np.percentile(frame_db, 90))
        p10_db = float(np.percentile(frame_db, 10))
        snr_db = max(0.0, p90_db - p10_db)
        p90_rms = float(np.percentile(frame_rms, 90))
    else:
        snr_db = float(max(0.0, np.max(frame_db) - np.min(frame_db)))
        p90_rms = float(np.max(frame_rms))

    speech_thresh = max(0.006, 0.15 * p90_rms)
    speech_mask = frame_rms >= speech_thresh
    speech_ratio = float(np.mean(speech_mask))
    silence_ratio = float(1.0 - speech_ratio)

    # Spectral flatness (Wiener entropy) on active frames -> separates speech from white noise
    active_indices = np.where(speech_mask)[0]
    if len(active_indices) > 0:
        step = max(1, len(active_indices) // 100)
        sampled_idx = active_indices[::step]
        win = np.hanning(frame_len)
        sfm_vals = []
        for idx in sampled_idx:
            st = int(starts[idx])
            fr = padded[st : st + frame_len] * win
            power = (np.abs(np.fft.rfft(fr)) ** 2) + 1e-12
            geo = math.exp(float(np.mean(np.log(power))))
            arith = float(np.mean(power))
            sfm_vals.append(min(1.0, max(0.0, geo / max(arith, 1e-12))))
        spectral_flatness = float(np.mean(sfm_vals))
    else:
        spectral_flatness = 1.0

    # Lightweight 46 ms YIN-CMND voicing ratio (65 - 450 Hz) to verify glottal periodicity
    v_frame_len = max(32, int(round(sr * 0.046)))
    v_hop = max(16, int(round(sr * 0.020)))
    v_min_lag = max(2, int(sr / 450.0))
    v_max_lag = min(v_frame_len // 2, int(sr / 65.0))
    v_sig = arr_dc if len(arr_dc) >= v_frame_len else np.pad(arr_dc, (0, v_frame_len - len(arr_dc)))
    v_n = 1 + (len(v_sig) - v_frame_len) // v_hop
    v_step = max(1, v_n // 120)
    voiced_cnt = 0
    checked_cnt = 0
    if v_max_lag > v_min_lag + 2:
        W = v_max_lag
        nfft = 1 << int(math.ceil(math.log2(v_frame_len + W)))
        lags = np.arange(1, v_max_lag + 1, dtype=np.float64)
        for i in range(0, v_n, v_step):
            checked_cnt += 1
            fr = v_sig[i * v_hop : i * v_hop + v_frame_len].astype(np.float64)
            fr = fr - float(np.mean(fr))
            r_val = math.sqrt(float(np.mean(fr * fr)) + 1e-12)
            if r_val < 0.003:
                continue
            sq = fr * fr
            cs = np.concatenate(([0.0], np.cumsum(sq)))
            e0 = cs[W]
            acf = np.fft.irfft(np.conj(np.fft.rfft(fr[:W], nfft)) * np.fft.rfft(fr, nfft), nfft)[: v_max_lag + 1]
            e_lag = cs[np.arange(v_max_lag + 1) + W] - cs[np.arange(v_max_lag + 1)]
            d = np.maximum(0.0, e0 + e_lag - 2.0 * acf)
            cmnd = np.ones(v_max_lag + 1, dtype=np.float64)
            run = np.cumsum(d[1:])
            nz = run > 1e-12
            cmnd[1:][nz] = d[1:][nz] * lags[nz] / run[nz]
            sub = cmnd[v_min_lag : v_max_lag + 1]
            if float(np.min(sub)) < 0.30:
                voiced_cnt += 1
    voicing_ratio = float(voiced_cnt / max(1, checked_cnt))

    is_silent = bool(rms_energy_db < -45.0 or peak_abs < 0.005 or speech_ratio < 0.05)

    return {
        "duration_sec": round(duration_sec, 4),
        "rms_energy_db": round(rms_energy_db, 2),
        "snr_db": round(snr_db, 2),
        "clipping_ratio": round(clipping_ratio, 5),
        "is_clipping": is_clipping,
        "speech_ratio": round(speech_ratio, 4),
        "silence_ratio": round(silence_ratio, 4),
        "spectral_flatness": round(spectral_flatness, 4),
        "voicing_ratio": round(voicing_ratio, 4),
        "peak_abs": round(peak_abs, 5),
        "is_silent": is_silent,
    }


def canonical_audio_to_wav_bytes(audio: CanonicalAudio) -> bytes:
    import io
    import wave

    clipped = np.clip(audio.waveform, -1.0, 1.0)
    pcm16 = np.round(clipped * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(CANONICAL_CHANNELS)
        wav_file.setsampwidth(2)
        wav_file.setframerate(CANONICAL_SAMPLE_RATE)
        wav_file.writeframes(pcm16.tobytes())
    return buffer.getvalue()
