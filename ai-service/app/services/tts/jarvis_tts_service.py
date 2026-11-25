"""
Commercial-clean ultra-low-latency bilingual streaming TTS service (`jarvis-tts-v2`, ADR-1).

Zero `CC-BY-NC` weights AND zero in-process `GPLv3+` (`phonemizer` / `libespeak-ng` /
`espeakng-loader`) dependencies:
- English (`EN`): `Kokoro-82M v1.0` (`hexgrad/Kokoro-82M`, Apache-2.0, 24,000 Hz) with
  `misaki.en.G2P(trf=False, fallback=KokoroOovFallback(...))` loaded directly via `kokoro.model.KModel`
  (never importing `kokoro.pipeline`, `misaki.espeak`, `phonemizer`, or `espeakng_loader`):
  - `us_female` -> `af_heart`
  - `us_male`   -> `am_michael`
  - `uk_female` -> `bf_emma`
  - `uk_male`   -> `0.65 * bm_george + 0.35 * bm_fable` (JARVIS British timbre)
- Vietnamese (`VI`) & Intra-Sentence EN+VI Code-Switching:
  Pinned `pnnbao-ump/VieNeu-TTS-v3-Turbo` (Apache-2.0, commit `61b85e3d937fbbacb387714180e8182823512523`)
  + `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX` (Apache-2.0, commit `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae`)
  + `sea-g2p` (Apache-2.0 Rust phonemizer — zero `(en)/(vi)` tag speech!),
  defaulting to **Torch-free CPU ONNX Runtime INT8 (`VIENEU_DEVICE=cpu`, `0 MiB` GPU VRAM)**
  with opt-in `VIENEU_DEVICE=cuda` strictly behind env flag, resampled `48 kHz -> 24 kHz`
  via exact `1:2` polyphase FIR and loudness-matched to `-18 LUFS` (`-20.0 dBFS` active RMS)
  with `8 ms` (`192`-sample) raised-cosine crossfading.
"""
from __future__ import annotations

import importlib.util
import logging
import math
import os
import re
import struct
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List, Literal, Optional, Tuple

import numpy as np

from app.services.tts.kokoro_oov_g2p import KokoroOovFallback, sanitize_kokoro_phonemes

logger = logging.getLogger("JARVIS_TTS_SERVICE")

ENGINE_ID = "jarvis-tts-v2"


class TtsBusyError(Exception):
    """Raised when all synthesis concurrency slots are occupied."""
SAMPLE_RATE = 24000
MAX_CONCURRENT_SYNTHESIS = 6
CROSSFADE_SAMPLES = 192  # 8 ms @ 24,000 Hz
INTER_CLAUSE_BREATH_MS = 35  # 35 ms natural pause between distinct clauses
TARGET_ACTIVE_RMS_DBFS = -20.0  # Calibrated to ~ -18 LUFS for mono conversational speech
PEAK_CEILING = 0.94
KOKORO_MAX_PHONEMES = 450

VIENEU_REPO_ID = os.getenv("VIENEU_REPO_ID", "pnnbao-ump/VieNeu-TTS-v3-Turbo")
VIENEU_REVISION = os.getenv("VIENEU_REVISION", "61b85e3d937fbbacb387714180e8182823512523")
VIENEU_MOSS_REPO = os.getenv("VIENEU_MOSS_REPO", "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano")
VIENEU_MOSS_REVISION = os.getenv("VIENEU_MOSS_REVISION", "6aa02b01e445cc585582cf0ba480bc3ea6c8dd68")
VIENEU_MOSS_ONNX_REPO = os.getenv("VIENEU_MOSS_ONNX_REPO", "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX")
VIENEU_MOSS_ONNX_REVISION = os.getenv("VIENEU_MOSS_ONNX_REVISION", "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae")
VIENEU_MIN_FREE_VRAM_MIB = int(os.getenv("VIENEU_MIN_FREE_VRAM_MIB", "1800"))

# Consistent gender & timbre pairing between Kokoro-82M (EN) and VieNeu-TTS-v3-Turbo (VI & EN-VI CS)
VOICE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "us_male": {
        "displayName": "American Male",
        "accent": "US",
        "gender": "male",
        "kokoro_lang": "a",
        "kokoro_voice": "am_michael",
        "vieneu_voice": "Hải Đăng",  # Nam · Bắc · tự nhiên (featured default male)
    },
    "us_female": {
        "displayName": "American Female",
        "accent": "US",
        "gender": "female",
        "kokoro_lang": "a",
        "kokoro_voice": "af_heart",
        "vieneu_voice": "Trúc Ly",  # Nữ · Bắc · tự nhiên (featured #2 warm female)
    },
    "uk_male": {
        "displayName": "British Male",
        "accent": "UK",
        "gender": "male",
        "kokoro_lang": "b",
        "kokoro_voice": "uk_jarvis_blend",
        "vieneu_voice": "Thiện Minh",  # Nam · Bắc · kể chuyện (calm authoritative male)
    },
    "uk_female": {
        "displayName": "British Female",
        "accent": "UK",
        "gender": "female",
        "kokoro_lang": "b",
        "kokoro_voice": "bf_emma",
        "vieneu_voice": "Mai Anh",  # Nữ · Bắc · tin tức (clear articulate female)
    },
}

_VI_DIACRITIC_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)
_VI_FUNCTION_WORDS = frozenset({
    "khong", "duoc", "nhung", "chao", "tieng", "vui", "long", "cua",
    "trong", "minh", "ban", "nha", "nhe", "chua", "nghe", "hoc", "xin",
    "cam", "giup", "dang", "san", "sang", "cau", "phan", "bai",
})
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…:;])\s+|\n+")
_COMMA_SPLIT_RE = re.compile(r"(?<=[,–—])\s+")
_WORD_TOKEN_RE = re.compile(r"[a-zA-Z]+")
_ECHO_META_RE = re.compile(r"\[ECHO_META\][\s\S]*$")
_FENCED_CODE_RE = re.compile(r"```(?:[a-zA-Z0-9_+-]+\n)?([\s\S]*?)```")
_ACTION_CHIP_RE = re.compile(r"\[([^\]\n]+?)\s*(?:->|→)\s*[^\]\n]+\]")
_MD_LINK_RE = re.compile(r"\[([^\]\n]+)\]\((?:https?://|/)[^)\s]*\)")
_BARE_URL_RE = re.compile(r"https?://[^\s)\]>]+")
_HEADING_LINE_RE = re.compile(r"(?m)^\s*#{1,6}\s+([^\n]+?)\s*$")
_DIVIDER_LINE_RE = re.compile(r"(?m)^\s*(?:[-*_]{3,}|[═─━]{3,})\s*$")
_BULLET_LINE_RE = re.compile(r"(?m)^\s*(?:[-*•‣▪◦]|>\s+)\s*")
_IPA_ANNOTATION_RE = re.compile(
    r"\(\s*/[^/\n]{1,48}/\s*\)|(?<=\s)/[ˈˌɪʊʌəɛæɑɒɔʃʒθðŋɹɚɜːɐɨɯɤʤʧa-zA-Z.\s]{2,48}/(?=[\s,.;:!?)]|$)"
)
_MARKDOWN_CLEAN_RE = re.compile(r"\*\*|__|`|~~|(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)")
_DECORATIVE_SYMBOL_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]+"
)
_ABBREV_END_RE = re.compile(
    r"(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|fig|approx|e\.g|i\.e)|(?:\b[a-zA-Z])|(?:\b\d{1,2}))\.$",
    re.IGNORECASE,
)
_ONLY_LIST_MARKER_RE = re.compile(r"^\s*(?:\(?\d{1,2}[.)]|[-•])\s*$")


def has_speakable_content(text: str) -> bool:
    """True when `text` contains at least one Unicode letter or digit."""
    return any(ch.isalnum() for ch in (text or ""))


def sanitize_speakable_text(text: str) -> str:
    if not text:
        return ""
    cleaned = _ECHO_META_RE.sub("", text)
    cleaned = _FENCED_CODE_RE.sub(r" \1 ", cleaned)
    cleaned = _ACTION_CHIP_RE.sub(r"\1", cleaned)
    cleaned = _MD_LINK_RE.sub(r"\1", cleaned)
    cleaned = _BARE_URL_RE.sub("", cleaned)
    cleaned = _IPA_ANNOTATION_RE.sub("", cleaned)
    cleaned = _DIVIDER_LINE_RE.sub(" ", cleaned)

    def _heading_to_sentence(match: re.Match[str]) -> str:
        body = match.group(1).strip()
        if not body:
            return ""
        return body if body[-1] in ".!?…:;" else f"{body}."

    cleaned = _HEADING_LINE_RE.sub(_heading_to_sentence, cleaned)
    cleaned = _BULLET_LINE_RE.sub("", cleaned)
    cleaned = _MARKDOWN_CLEAN_RE.sub("", cleaned)
    cleaned = _DECORATIVE_SYMBOL_RE.sub(" ", cleaned)

    # Expand high-frequency Latin abbreviations & symbols that otherwise break prosody
    cleaned = re.sub(r"\be\.g\.,?\s*", "for example, ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi\.e\.,?\s*", "that is, ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bvs\.\s+", "versus ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"~(\d)", r"\1", cleaned)

    return re.sub(r"\s+", " ", cleaned).strip()


def detect_clause_language(clause: str, lang_mode: str = "auto") -> Literal["en", "vi"]:
    mode = (lang_mode or "auto").strip().lower()
    if mode == "en":
        return "en"
    if mode == "vi":
        return "vi"
    if _VI_DIACRITIC_RE.search(clause):
        return "vi"
    tokens = [m.group(0).lower() for m in _WORD_TOKEN_RE.finditer(clause)]
    if len(tokens) >= 2:
        vi_hits = sum(1 for t in tokens if t in _VI_FUNCTION_WORDS)
        if vi_hits >= 2 and (vi_hits / len(tokens)) >= 0.34:
            return "vi"
    return "en"


def split_text_clauses(text: str, max_first_clause_chars: int = 72, max_clause_chars: int = 150) -> List[str]:
    cleaned = sanitize_speakable_text(text)
    if not cleaned or not has_speakable_content(cleaned):
        return []

    raw_parts = [s.strip() for s in _SENTENCE_SPLIT_RE.split(cleaned) if s.strip()]
    # Re-join false sentence splits after titles ("Dr."), initials ("U.S."), or list numbers ("1. Mở phần Đọc")
    raw_sentences: List[str] = []
    for part in raw_parts:
        if raw_sentences and (
            _ONLY_LIST_MARKER_RE.match(raw_sentences[-1])
            or _ABBREV_END_RE.search(raw_sentences[-1])
        ):
            raw_sentences[-1] = f"{raw_sentences[-1]} {part}"
        else:
            raw_sentences.append(part)

    clauses: List[str] = []
    for idx, sent in enumerate(raw_sentences):
        if not has_speakable_content(sent):
            continue
        limit = max_first_clause_chars if (idx == 0 and not clauses) else max_clause_chars
        if len(sent) <= limit:
            clauses.append(sent)
            continue
        sub_parts = [p.strip() for p in _COMMA_SPLIT_RE.split(sent) if p.strip()]
        acc = ""
        for part in sub_parts:
            cur_limit = max_first_clause_chars if not clauses else max_clause_chars
            if not acc:
                acc = part
            elif len(acc) + 1 + len(part) <= cur_limit or len(acc) < 18:
                acc = f"{acc} {part}"
            else:
                if has_speakable_content(acc):
                    clauses.append(acc)
                acc = part
        if acc and has_speakable_content(acc):
            clauses.append(acc)

    return clauses


def _chunk_phonemes(phonemes: str, max_len: int = KOKORO_MAX_PHONEMES) -> List[str]:
    ps = sanitize_kokoro_phonemes(phonemes).strip()
    if not ps:
        return []
    if len(ps) <= max_len:
        return [ps]
    chunks: List[str] = []
    cur = ps
    while len(cur) > max_len:
        cut = cur.rfind(" ", 0, max_len)
        if cut <= max_len // 3:
            cut = max_len
        part = cur[:cut].strip()
        if part:
            chunks.append(part)
        cur = cur[cut:].strip()
    if cur:
        chunks.append(cur)
    return chunks


def normalize_loudness_lufs(
    samples: np.ndarray,
    target_active_rms_dbfs: float = TARGET_ACTIVE_RMS_DBFS,
    peak_ceiling: float = PEAK_CEILING,
    min_gain: float = 0.25,
    max_gain: float = 3.5,
) -> np.ndarray:
    """
    Normalize mono float32 speech to a consistent `-18 LUFS` (~`-20.0 dBFS` active-speech RMS)
    so English (Kokoro-82M) and Vietnamese/Code-Switched (VieNeu-TTS-v3-Turbo) clauses maintain
    `< 1.0 dB` loudness continuity with smooth soft-knee peak limiting (`<= 0.94`).
    """
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x

    # Gate out near-silence samples (< -45 dBFS) so leading/trailing silence doesn't distort gain
    active_mask = np.abs(x) >= 0.0056
    active_count = int(np.count_nonzero(active_mask))
    if active_count >= 64:
        active_rms = float(np.sqrt(float(np.mean(np.square(x[active_mask], dtype=np.float32)))))
    else:
        active_rms = float(np.sqrt(float(np.mean(np.square(x, dtype=np.float32)))))

    # Never amplify ultra-quiet residual breath/tail noise (< -74 dBFS or tiny < 10 ms clicks)
    if active_rms < 2e-4 or (active_count < 240 and active_rms < 0.004):
        return x

    target_rms = 10.0 ** (target_active_rms_dbfs / 20.0)
    gain = float(np.clip(target_rms / active_rms, min_gain, max_gain))
    y = x * gain

    # Smooth soft-knee limiter above 0.86 capped strictly at `peak_ceiling` (0.94)
    knee = 0.86
    peak = float(np.max(np.abs(y)))
    if peak > knee:
        headroom = max(0.02, peak_ceiling - knee)
        over = np.maximum(0.0, np.abs(y) - knee)
        shaped = knee + headroom * np.tanh(over / headroom)
        y = np.where(np.abs(y) > knee, np.sign(y) * shaped, y).astype(np.float32)

    final_peak = float(np.max(np.abs(y)))
    if final_peak > peak_ceiling:
        y = (y * (peak_ceiling / final_peak)).astype(np.float32)
    return y


def _apply_cosine_edge_fades(samples: np.ndarray, fade_samples: int = CROSSFADE_SAMPLES) -> np.ndarray:
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x
    fade = min(fade_samples, x.size // 4)
    if fade < 8:
        return x
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, fade, dtype=np.float32))).astype(np.float32)
    y = x.copy()
    y[:fade] *= ramp
    y[-fade:] *= ramp[::-1]
    return y


def _float32_to_pcm16le(samples: np.ndarray, apply_fades: bool = True, fade_samples: int = CROSSFADE_SAMPLES) -> bytes:
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return b""
    if apply_fades:
        x = _apply_cosine_edge_fades(x, fade_samples=fade_samples)
    pcm_i16 = np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")
    return pcm_i16.tobytes()


def crossfade_float32_chunks(chunks: List[np.ndarray], fade_samples: int = CROSSFADE_SAMPLES) -> np.ndarray:
    """Overlap-add consecutive float32 sub-chunks using an 8 ms raised-cosine crossfade."""
    non_empty = [np.asarray(c, dtype=np.float32).reshape(-1) for c in chunks if c is not None and c.size > 0]
    if not non_empty:
        return np.zeros(0, dtype=np.float32)
    if len(non_empty) == 1:
        return non_empty[0]

    out = non_empty[0].copy()
    for nxt in non_empty[1:]:
        ov = min(fade_samples, out.size // 3, nxt.size // 3)
        if ov < 8:
            out = np.concatenate([out, nxt])
            continue
        ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, ov, dtype=np.float32))).astype(np.float32)
        blended = out[-ov:] * ramp[::-1] + nxt[:ov] * ramp
        out = np.concatenate([out[:-ov], blended, nxt[ov:]])
    return out


def wrap_pcm16le_as_wav(pcm_bytes: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    data_len = len(pcm_bytes)
    byte_rate = sample_rate * 2
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_len,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        byte_rate,
        2,
        16,
        b"data",
        data_len,
    )
    return header + pcm_bytes


def _import_kmodel_without_espeak() -> Any:
    """
    Import `kokoro.model.KModel` WITHOUT executing `kokoro/__init__.py` (which eagerly
    imports `kokoro.pipeline` -> `misaki.espeak` -> GPLv3+ `phonemizer` / `espeakng_loader`).
    """
    try:
        from loguru import logger as _loguru_logger

        _loguru_logger.disable("kokoro")
    except Exception:
        pass
    if "kokoro" not in sys.modules:
        spec = importlib.util.find_spec("kokoro")
        if spec is None or not spec.submodule_search_locations:
            raise ImportError("kokoro package is not installed")
        pkg = types.ModuleType("kokoro")
        pkg.__path__ = list(spec.submodule_search_locations)
        pkg.__package__ = "kokoro"
        sys.modules["kokoro"] = pkg
    from kokoro.model import KModel  # type: ignore[import-not-found]

    return KModel


class JarvisTtsService:
    _instance: Optional["JarvisTtsService"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._load_lock = threading.Lock()
        self._kokoro_lock = threading.Lock()
        self._vieneu_lock = threading.Lock()
        self._synthesis_slot = threading.BoundedSemaphore(MAX_CONCURRENT_SYNTHESIS)
        self._is_loaded = False
        self._device = "cpu"
        self._vieneu_device = "cpu"
        self._vieneu_backend = "onnx"
        self._vieneu_precision = "int8"
        self._model_load_time_sec = 0.0
        self._sampling_rate = SAMPLE_RATE

        self._kmodel: Any = None
        self._en_g2p: Dict[str, Any] = {}
        self._voice_packs: Dict[str, Any] = {}
        self._vieneu: Any = None
        self._vieneu_voice_objs: Dict[str, Any] = {}
        self._vieneu_sample_rate: int = 48000

    @classmethod
    def get_instance(cls) -> "JarvisTtsService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _resolve_kokoro_paths(self) -> Tuple[str, str, Dict[str, str]]:
        from huggingface_hub import hf_hub_download

        repo_id = os.getenv("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")
        local_only = os.getenv("KOKORO_ALLOW_DOWNLOAD", "false").strip().lower() != "true"
        try:
            cfg_path = hf_hub_download(repo_id=repo_id, filename="config.json", local_files_only=local_only)
            mdl_path = hf_hub_download(repo_id=repo_id, filename="kokoro-v1_0.pth", local_files_only=local_only)
            voice_files = {
                vname: hf_hub_download(
                    repo_id=repo_id, filename=f"voices/{vname}.pt", local_files_only=local_only
                )
                for vname in ("af_heart", "am_michael", "bf_emma", "bm_george", "bm_fable")
            }
            return cfg_path, mdl_path, voice_files
        except Exception:
            if not local_only:
                raise
            cfg_path = hf_hub_download(repo_id=repo_id, filename="config.json")
            mdl_path = hf_hub_download(repo_id=repo_id, filename="kokoro-v1_0.pth")
            voice_files = {
                vname: hf_hub_download(repo_id=repo_id, filename=f"voices/{vname}.pt")
                for vname in ("af_heart", "am_michael", "bf_emma", "bm_george", "bm_fable")
            }
            return cfg_path, mdl_path, voice_files

    def _resolve_vieneu_local_dirs(self, precision: str) -> Tuple[Optional[str], Optional[str]]:
        """Resolve pre-baked or HF-cached pinned VieNeu-TTS-v3-Turbo ONNX & MOSS codec dirs."""
        env_onnx_dir = (os.getenv("VIENEU_ONNX_DIR") or "").strip()
        env_codec_dir = (os.getenv("VIENEU_CODEC_DIR") or "").strip()
        subfolder = "onnx_int8" if precision == "int8" else "onnx_update"

        onnx_dir: Optional[str] = None
        if env_onnx_dir and Path(env_onnx_dir).is_dir():
            onnx_dir = env_onnx_dir
        else:
            baked = Path(f"/opt/echo-jarvis/vieneu-v3-turbo/{subfolder}")
            if baked.is_dir():
                onnx_dir = str(baked)

        codec_dir: Optional[str] = None
        if env_codec_dir and Path(env_codec_dir).is_dir():
            codec_dir = env_codec_dir
        else:
            baked_codec = Path("/opt/echo-jarvis/moss-audio-tokenizer-nano-onnx")
            if baked_codec.is_dir():
                codec_dir = str(baked_codec)

        if onnx_dir and codec_dir:
            return onnx_dir, codec_dir

        # Download or resolve exact pinned Apache-2.0 revisions from Hugging Face cache
        from huggingface_hub import snapshot_download

        allow_dl = os.getenv("VIENEU_ALLOW_DOWNLOAD", "true").strip().lower() == "true"
        if onnx_dir is None:
            try:
                snap = snapshot_download(
                    repo_id=VIENEU_REPO_ID,
                    revision=VIENEU_REVISION,
                    allow_patterns=[f"{subfolder}/*", "config.json"],
                    local_files_only=True,
                )
            except Exception:
                if not allow_dl:
                    raise
                snap = snapshot_download(
                    repo_id=VIENEU_REPO_ID,
                    revision=VIENEU_REVISION,
                    allow_patterns=[f"{subfolder}/*", "config.json"],
                )
            cand = Path(snap) / subfolder
            onnx_dir = str(cand) if cand.is_dir() else snap

        if codec_dir is None:
            try:
                codec_dir = snapshot_download(
                    repo_id=VIENEU_MOSS_ONNX_REPO,
                    revision=VIENEU_MOSS_ONNX_REVISION,
                    allow_patterns=["moss_audio_tokenizer_decode*", "codec_browser_onnx_meta.json"],
                    local_files_only=True,
                )
            except Exception:
                if not allow_dl:
                    raise
                codec_dir = snapshot_download(
                    repo_id=VIENEU_MOSS_ONNX_REPO,
                    revision=VIENEU_MOSS_ONNX_REVISION,
                    allow_patterns=["moss_audio_tokenizer_decode*", "codec_browser_onnx_meta.json"],
                )

        return onnx_dir, codec_dir

    def _resolve_vieneu_cuda_local_dirs(self) -> Tuple[str, str]:
        """Resolve pre-baked or HF-cached pinned VieNeu-TTS-v3-Turbo PyTorch & MOSS codec dirs."""
        baked_v = Path("/opt/echo-jarvis/vieneu-v3-turbo-pt")
        baked_m = Path("/opt/echo-jarvis/moss-audio-tokenizer-nano-pt")
        if (baked_v / "update" / "model.safetensors").is_file() and (baked_m / "config.json").is_file():
            return str(baked_v), str(baked_m)

        from huggingface_hub import snapshot_download

        allow_dl = os.getenv("VIENEU_ALLOW_DOWNLOAD", "true").strip().lower() == "true"
        try:
            v_dir = snapshot_download(
                repo_id=VIENEU_REPO_ID,
                revision=VIENEU_REVISION,
                allow_patterns=["update/*", "config.json", "speaker_encoder.onnx"],
                local_files_only=True,
            )
        except Exception:
            if not allow_dl:
                raise
            v_dir = snapshot_download(
                repo_id=VIENEU_REPO_ID,
                revision=VIENEU_REVISION,
                allow_patterns=["update/*", "config.json", "speaker_encoder.onnx"],
            )
        try:
            m_dir = snapshot_download(
                repo_id=VIENEU_MOSS_REPO,
                revision=VIENEU_MOSS_REVISION,
                local_files_only=True,
            )
        except Exception:
            if not allow_dl:
                raise
            m_dir = snapshot_download(
                repo_id=VIENEU_MOSS_REPO,
                revision=VIENEU_MOSS_REVISION,
            )
        return v_dir, m_dir

    def _load_vieneu_engine(self) -> Any:
        from vieneu import Vieneu  # type: ignore[import-not-found]

        # Locked default `cpu` (ONNX INT8, 0 MiB VRAM) protects the shared RTX 5070 12 GB budget
        # when Listening WhisperX + MDD Pronunciation V2.2 + 4-way Echo run concurrently (controlled
        # soak measured CUDA peak 10.97 GiB > 10.5 GiB ceiling with only 707 MiB free vs CPU ONNX
        # 2,360 MiB idle headroom). Operators on >=16 GB GPUs can opt in via `VIENEU_DEVICE=cuda|auto`.
        requested_device = (os.getenv("VIENEU_DEVICE", "cpu") or "cpu").strip().lower()
        if requested_device not in ("auto", "cpu", "cuda"):
            requested_device = "cpu"
        precision = (os.getenv("VIENEU_PRECISION", "int8") or "int8").strip().lower()
        if precision not in ("int8", "fp32"):
            precision = "int8"
        threads = max(1, int(os.getenv("VIENEU_THREADS", "4")))

        try_cuda = requested_device in ("auto", "cuda")
        if try_cuda:
            try:
                import torch

                if torch.cuda.is_available():
                    free_bytes, _total_bytes = torch.cuda.mem_get_info()
                    free_mib = int(free_bytes // (1024 * 1024))
                    if requested_device == "cuda" or free_mib >= VIENEU_MIN_FREE_VRAM_MIB:
                        # Deregister PyTorch 2.14 eager Triton op overrides (python:3.11-slim has no gcc)
                        try:
                            import torch._native.registry as _tn_reg  # type: ignore[import-not-found]

                            _tn_reg.deregister_op_overrides(disable_dsl_names=["triton"])
                        except Exception:
                            pass
                        v_dir, m_dir = self._resolve_vieneu_cuda_local_dirs()
                        max_streams = max(2, int(os.getenv("VIENEU_MAX_STREAMS", "8")))
                        tts = Vieneu(
                            mode="v3turbo",
                            backbone_repo=v_dir,
                            model_subfolder="update",
                            moss_tokenizer=m_dir,
                            device="cuda",
                            backend="pytorch",
                            max_streams=max_streams,
                        )
                        self._vieneu_device = "cuda"
                        self._vieneu_backend = "pytorch"
                        self._vieneu_precision = "bf16"
                        logger.info(
                            "VieNeu-TTS-v3-Turbo promoted to CUDA continuous-batching (max_streams=%d, free_vram=%d MiB).",
                            max_streams,
                            free_mib,
                        )
                        return tts
                    logger.info(
                        "VieNeu-TTS-v3-Turbo staying on CPU ONNX INT8 (free_vram=%d MiB < %d MiB floor).",
                        free_mib,
                        VIENEU_MIN_FREE_VRAM_MIB,
                    )
            except Exception as cuda_err:
                logger.warning("VieNeu-TTS-v3-Turbo CUDA init failed (%s); falling back to CPU ONNX INT8.", cuda_err)

        self._vieneu_device = "cpu"
        self._vieneu_backend = "onnx"
        self._vieneu_precision = precision
        onnx_dir, codec_dir = self._resolve_vieneu_local_dirs(precision)

        local_backbone = (
            str(Path(onnx_dir).parent)
            if onnx_dir and Path(onnx_dir).parent.is_dir()
            else VIENEU_REPO_ID
        )

        # Ensure OnnxV3LiteEngine receives the exact pinned local `codec_dir` (zero runtime HF download)
        from vieneu._v3_turbo_engine import onnx_runtime_lite as _ort_lite  # type: ignore[import-not-found]

        orig_init = _ort_lite.OnnxV3LiteEngine.__init__
        if codec_dir:
            def _pinned_init(eng_self: Any, *args: Any, **kwargs: Any) -> None:
                kwargs.setdefault("codec_dir", codec_dir)
                orig_init(eng_self, *args, **kwargs)

            _ort_lite.OnnxV3LiteEngine.__init__ = _pinned_init  # type: ignore[method-assign]
        try:
            tts = Vieneu(
                mode="v3turbo",
                backbone_repo=local_backbone,
                device="cpu",
                backend="onnx",
                onnx_dir=onnx_dir,
                precision=precision,
                threads=threads,
            )
        finally:
            if codec_dir:
                _ort_lite.OnnxV3LiteEngine.__init__ = orig_init  # type: ignore[method-assign]
        return tts

    def _resolve_vieneu_voice_map(self, vieneu_tts: Any) -> Dict[str, Any]:
        resolved: Dict[str, Any] = {}
        for voice_id, meta in VOICE_REGISTRY.items():
            preset_name = meta["vieneu_voice"]
            try:
                resolved[voice_id] = vieneu_tts.get_preset_voice(preset_name)
            except Exception as exc:
                logger.warning(
                    "VieNeu preset '%s' for %s unavailable (%s); falling back to default preset.",
                    preset_name,
                    voice_id,
                    exc,
                )
                resolved[voice_id] = vieneu_tts.get_preset_voice()
        return resolved

    def load_model(self, force_reload: bool = False) -> None:
        if self._is_loaded and not force_reload:
            return
        with self._load_lock:
            if self._is_loaded and not force_reload:
                return

            import torch
            from misaki import en as misaki_en  # type: ignore[import-not-found]

            t0 = time.perf_counter()
            KModel = _import_kmodel_without_espeak()

            self._device = "cuda" if torch.cuda.is_available() else "cpu"
            cfg_path, mdl_path, voice_files = self._resolve_kokoro_paths()
            repo_id = os.getenv("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")

            kmodel = KModel(repo_id=repo_id, config=cfg_path, model=mdl_path).to(self._device).eval()
            g2p_us = misaki_en.G2P(trf=False, british=False, fallback=KokoroOovFallback(british=False), unk="")
            g2p_uk = misaki_en.G2P(trf=False, british=True, fallback=KokoroOovFallback(british=True), unk="")

            raw_packs = {
                k: torch.load(p, map_location="cpu", weights_only=True)
                for k, p in voice_files.items()
            }
            voice_packs = {
                "us_female": raw_packs["af_heart"],
                "us_male": raw_packs["am_michael"],
                "uk_female": raw_packs["bf_emma"],
                "uk_male": 0.65 * raw_packs["bm_george"] + 0.35 * raw_packs["bm_fable"],
            }

            vieneu_tts = self._load_vieneu_engine()
            vieneu_voice_objs = self._resolve_vieneu_voice_map(vieneu_tts)

            self._kmodel = kmodel
            self._en_g2p = {"a": g2p_us, "b": g2p_uk}
            self._voice_packs = voice_packs
            self._vieneu = vieneu_tts
            self._vieneu_voice_objs = vieneu_voice_objs
            self._vieneu_sample_rate = int(getattr(vieneu_tts, "sample_rate", 48000) or 48000)
            self._is_loaded = True

            # Execute tiny warmup kernels on both Kokoro EN and VieNeu VI so first real turn is hot
            try:
                self._synth_en_clause("Ready.", "uk_male")
                self._synth_vi_clause("Sẵn sàng.", "us_female")
            except Exception as warm_err:
                logger.warning("Warmup synthesis warning: %s", warm_err)

            self._model_load_time_sec = time.perf_counter() - t0
            logger.info(
                "JarvisTtsService (%s) loaded in %.2fs [Kokoro-82M %s + VieNeu-TTS-v3-Turbo %s/%s/%s, 0 GPLv3].",
                ENGINE_ID,
                self._model_load_time_sec,
                self._device,
                self._vieneu_device,
                self._vieneu_backend,
                self._vieneu_precision,
            )

    def _validate_voice_id(self, voice_id: str) -> str:
        clean = (voice_id or "").strip().lower()
        if clean not in VOICE_REGISTRY:
            raise ValueError(
                f"Unknown voiceId '{voice_id}'. Must be one of: {sorted(list(VOICE_REGISTRY.keys()))}"
            )
        return clean

    def _phonemize_en(self, clause: str, lang_code: str) -> List[str]:
        g2p = self._en_g2p[lang_code]
        phonemes, _tokens = g2p(clause)
        if not phonemes:
            return []
        return _chunk_phonemes(phonemes, max_len=KOKORO_MAX_PHONEMES)

    def _synth_en_clause(self, clause: str, clean_voice_id: str) -> np.ndarray:
        import torch

        meta = VOICE_REGISTRY[clean_voice_id]
        pack = self._voice_packs[clean_voice_id]
        phoneme_segments = self._phonemize_en(clause, meta["kokoro_lang"])
        if not phoneme_segments:
            return np.zeros(0, dtype=np.float32)

        chunks: List[np.ndarray] = []
        for ps in phoneme_segments:
            ref_s = pack[min(len(ps) - 1, len(pack) - 1)]
            with self._kokoro_lock, torch.inference_mode():
                audio = self._kmodel(ps, ref_s, speed=1.0)
                if isinstance(audio, torch.Tensor):
                    arr = audio.detach().cpu().numpy().astype(np.float32).reshape(-1)
                else:
                    arr = np.asarray(audio, dtype=np.float32).reshape(-1)
            if arr.size > 0:
                chunks.append(arr)

        if not chunks:
            return np.zeros(0, dtype=np.float32)
        merged = crossfade_float32_chunks(chunks, fade_samples=CROSSFADE_SAMPLES)
        return normalize_loudness_lufs(merged)

    def _resample_to_24k(self, samples: np.ndarray, src_sr: int) -> np.ndarray:
        if samples.size == 0 or src_sr == SAMPLE_RATE:
            return samples.astype(np.float32, copy=False)
        import scipy.signal as sps

        g = math.gcd(SAMPLE_RATE, src_sr)
        return sps.resample_poly(samples, SAMPLE_RATE // g, src_sr // g).astype(np.float32)

    def _stream_vi_raw_24k(self, clause: str, clean_voice_id: str) -> Iterator[np.ndarray]:
        """Yield raw 24 kHz resampled float32 sub-chunks from VieNeu-TTS-v3-Turbo."""
        voice_obj = self._vieneu_voice_objs.get(clean_voice_id)
        sr = int(self._vieneu_sample_rate or 48000)
        stream_fn = getattr(self._vieneu, "infer_stream", None)

        if self._vieneu_backend == "pytorch" and callable(stream_fn):
            for raw_chunk in stream_fn(text=clause, voice=voice_obj):
                arr = np.asarray(raw_chunk, dtype=np.float32).reshape(-1)
                if arr.size == 0:
                    continue
                yield self._resample_to_24k(arr, sr)
            return

        with self._vieneu_lock:
            if callable(stream_fn):
                raw_iter = stream_fn(text=clause, voice=voice_obj, chunk_frames=8)
                for raw_chunk in raw_iter:
                    arr = np.asarray(raw_chunk, dtype=np.float32).reshape(-1)
                    if arr.size == 0:
                        continue
                    yield self._resample_to_24k(arr, sr)
                return

            arr = np.asarray(self._vieneu.infer(text=clause, voice=voice_obj), dtype=np.float32).reshape(-1)
            if arr.size > 0:
                yield self._resample_to_24k(arr, sr)

    def _stream_vi_clause_float32(self, clause: str, clean_voice_id: str) -> Iterator[np.ndarray]:
        """
        Stream 24 kHz `-18 LUFS` float32 chunks from VieNeu-TTS-v3-Turbo using smoothed clause-level
        gain tracking so trailing breath/consonant sub-chunks never pump in loudness.
        """
        target_rms = 10.0 ** (TARGET_ACTIVE_RMS_DBFS / 20.0)
        smoothed_gain: Optional[float] = None
        knee = 0.86
        headroom = max(0.02, PEAK_CEILING - knee)

        for chunk_24k in self._stream_vi_raw_24k(clause, clean_voice_id):
            if chunk_24k.size == 0:
                continue
            active_mask = np.abs(chunk_24k) >= 0.0056
            active_count = int(np.count_nonzero(active_mask))
            if active_count >= 360:
                sub_rms = float(np.sqrt(float(np.mean(np.square(chunk_24k[active_mask], dtype=np.float32)))))
                raw_gain = float(np.clip(target_rms / max(sub_rms, 1e-4), 0.25, 3.5))
                smoothed_gain = raw_gain if smoothed_gain is None else (0.72 * smoothed_gain + 0.28 * raw_gain)
            elif smoothed_gain is None:
                yield normalize_loudness_lufs(chunk_24k)
                continue

            y = (chunk_24k * np.float32(smoothed_gain)).astype(np.float32)
            peak = float(np.max(np.abs(y)))
            if peak > knee:
                over = np.maximum(0.0, np.abs(y) - knee)
                shaped = knee + headroom * np.tanh(over / headroom)
                y = np.where(np.abs(y) > knee, np.sign(y) * shaped, y).astype(np.float32)
            final_peak = float(np.max(np.abs(y)))
            if final_peak > PEAK_CEILING:
                y = (y * (PEAK_CEILING / final_peak)).astype(np.float32)
            yield y

    def _synth_vi_clause(self, clause: str, clean_voice_id: str) -> np.ndarray:
        chunks = list(self._stream_vi_clause_float32(clause, clean_voice_id))
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        merged = crossfade_float32_chunks(chunks, fade_samples=CROSSFADE_SAMPLES)
        return normalize_loudness_lufs(merged)

    def _stream_clause_pcm16_segments(
        self,
        clause: str,
        clean_voice_id: str,
        lang_mode: str,
    ) -> Iterator[bytes]:
        clause_lang = detect_clause_language(clause, lang_mode)
        if clause_lang == "en":
            samples = self._synth_en_clause(clause, clean_voice_id)
            pcm = _float32_to_pcm16le(samples, apply_fades=True, fade_samples=CROSSFADE_SAMPLES)
            if pcm:
                yield pcm
            return

        # True streaming overlap-add across incremental VieNeu sub-chunks (0 ms dead gap!)
        pending_tail: Optional[np.ndarray] = None
        is_first = True
        fade = CROSSFADE_SAMPLES
        ramp_up = (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, fade, dtype=np.float32))).astype(np.float32)
        ramp_down = ramp_up[::-1]

        for raw_sub in self._stream_vi_clause_float32(clause, clean_voice_id):
            sub = np.asarray(raw_sub, dtype=np.float32).reshape(-1)
            if sub.size == 0:
                continue
            if is_first:
                is_first = False
                f0 = min(fade, sub.size // 4)
                if f0 >= 8:
                    sub = sub.copy()
                    sub[:f0] *= (
                        ramp_up
                        if f0 == fade
                        else (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, f0, dtype=np.float32))).astype(np.float32)
                    )
            if pending_tail is not None:
                ov = min(fade, pending_tail.size, sub.size // 2)
                if ov >= 8:
                    r_up = (
                        ramp_up
                        if ov == fade
                        else (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, ov, dtype=np.float32))).astype(np.float32)
                    )
                    blended = pending_tail[-ov:] * r_up[::-1] + sub[:ov] * r_up
                    prefix = pending_tail[:-ov] if pending_tail.size > ov else np.zeros(0, dtype=np.float32)
                    sub = np.concatenate([prefix, blended, sub[ov:]])
                else:
                    sub = np.concatenate([pending_tail, sub])

            if sub.size > fade * 2:
                emit_part = sub[:-fade]
                pending_tail = sub[-fade:].copy()
                pcm = _float32_to_pcm16le(emit_part, apply_fades=False)
                if pcm:
                    yield pcm
            else:
                pending_tail = sub.copy()

        if pending_tail is not None and pending_tail.size > 0:
            fe = min(fade, pending_tail.size)
            if fe >= 8:
                tail_out = pending_tail.copy()
                tail_out[-fe:] *= (
                    ramp_down
                    if fe == fade
                    else (0.5 - 0.5 * np.cos(np.linspace(math.pi, 0.0, fe, dtype=np.float32))).astype(np.float32)
                )
            else:
                tail_out = pending_tail
            pcm = _float32_to_pcm16le(tail_out, apply_fades=False)
            if pcm:
                yield pcm

    def stream_pcm_chunks(
        self,
        text: str,
        voice_id: str,
        lang: str = "auto",
        frame_bytes: int = 9600,
    ) -> Iterator[bytes]:
        clean_voice_id = self._validate_voice_id(voice_id)
        if not (text or "").strip():
            raise ValueError("text cannot be blank or whitespace-only")

        stripped = sanitize_speakable_text(text)
        if not stripped or not has_speakable_content(stripped):
            # Punctuation-only, markdown divider, emoji, or `[ECHO_META]` remnant -> 20 ms clean silence (0 HTTP 4xx/5xx!)
            return iter([b"\x00" * 960])

        if not self._is_loaded:
            self.load_model()

        if not self._synthesis_slot.acquire(timeout=8.0):
            raise TtsBusyError("Speech service is busy; try again shortly")

        clauses = split_text_clauses(stripped)
        if not clauses:
            self._synthesis_slot.release()
            return iter([b"\x00" * 960])
        step = max(960, frame_bytes - (frame_bytes % 2))
        breath_bytes = b"\x00" * (int(round(INTER_CLAUSE_BREATH_MS * SAMPLE_RATE / 1000.0)) * 2)

        def _gen() -> Iterator[bytes]:
            try:
                emitted = False
                for idx, clause in enumerate(clauses):
                    clause_emitted = False
                    for pcm in self._stream_clause_pcm16_segments(clause, clean_voice_id, lang):
                        if not pcm:
                            continue
                        emitted = True
                        clause_emitted = True
                        for off in range(0, len(pcm), step):
                            yield pcm[off : off + step]
                    if clause_emitted and idx + 1 < len(clauses):
                        yield breath_bytes
                if not emitted:
                    yield b"\x00" * 960
            finally:
                self._synthesis_slot.release()

        return _gen()

    def synthesize(self, text: str, voice_id: str, lang: str = "auto") -> Tuple[bytes, float, float]:
        t0 = time.perf_counter()
        pcm_parts = list(self.stream_pcm_chunks(text=text, voice_id=voice_id, lang=lang, frame_bytes=96000))
        pcm_bytes = b"".join(pcm_parts)
        latency = time.perf_counter() - t0
        duration = len(pcm_bytes) / float(SAMPLE_RATE * 2)
        wav_bytes = wrap_pcm16le_as_wav(pcm_bytes, SAMPLE_RATE)
        return wav_bytes, latency, duration

    def get_public_voices(self) -> List[Dict[str, str]]:
        return [
            {
                "voiceId": k,
                "displayName": v["displayName"],
                "accent": v["accent"],
                "gender": v["gender"],
            }
            for k, v in VOICE_REGISTRY.items()
        ]

    @property
    def is_loaded(self) -> bool:
        return self._is_loaded

    @property
    def device(self) -> str:
        return self._device

    @property
    def vieneu_device(self) -> str:
        return self._vieneu_device

    @property
    def model_load_time_sec(self) -> float:
        return self._model_load_time_sec
