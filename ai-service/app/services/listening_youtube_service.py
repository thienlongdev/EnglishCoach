"""
Listening YouTube import — the ONE authorized pipeline (rules 10 §BE, SUPREME LISTENING YOUTUBE IMPORT LAW).

Runs only on the owner's Windows GPU PC:

    yt-dlp metadata  ->  transcript text (English captions, else LOCAL faster-whisper transcription)
                     ->  source audio  ->  WhisperX wav2vec2 forced alignment (every word timed on the audio)
                     ->  publication gate (listening_timing_gate)  ->  segments

Personal and SYSTEM imports, retries, repairs and bulk tools all use this path. There is no paid or
remote ASR (OpenRouter / OpenAI / any provider), no VPS worker, no caption-offset or evenly split
word timing and no default duration. When a stage cannot run, the import fails with a clear error and
nothing is published.
"""
import os
import re
import json
import logging
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple

import numpy as np
import torch

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    YouTubeTranscriptApi = None
from fastapi import HTTPException

from app.services.listening_local_asr import LocalPipelineUnavailable, engine_label, transcribe_segments, transcription_state
from app.services.listening_timing_gate import TimingRejected, assess_transcript_timing
from app.services.listening_trace import Trace, current, measured

logger = logging.getLogger("listening_youtube")

ENGLISH_LANG_CODES = {"en", "en-us", "en-gb", "en-ca", "en-au", "en-nz", "en-ie", "en-za", "en-in", "en-orig"}
SAMPLE_RATE = 16000
# Metadata and audio must describe the same media.
DURATION_MISMATCH_SEC = 5.0
# Acoustic envelope padding of a segment (Dictation replays start -> end).
ENVELOPE_PAD_SEC = 0.12

LOCAL_PIPELINE_UNAVAILABLE_MESSAGE = (
    "Dịch vụ xử lý âm thanh cục bộ (WhisperX) đang tạm thời không khả dụng. "
    "Bài nghe chưa được tạo — vui lòng thử lại sau."
)
SOURCE_UNAVAILABLE_MESSAGE = (
    "YouTube tạm thời không cho máy xử lý tải video này. Bài nghe chưa được tạo — vui lòng thử lại sau ít phút."
)


def local_pipeline_unavailable(reason: Exception) -> HTTPException:
    logger.error("Local Listening pipeline unavailable: %s", reason)
    return HTTPException(status_code=503, detail=LOCAL_PIPELINE_UNAVAILABLE_MESSAGE)


# ==============================================================================
# WHISPERX FORCED ALIGNMENT SUBSYSTEM
# ==============================================================================

_ALIGN_MODEL = None
_ALIGN_METADATA = None
_ALIGN_DEVICE = None
_ALIGN_LOAD_LOCK = threading.RLock()
_PIPELINE_LOCK = threading.Lock()


def get_alignment_model():
    """
    Singleton loader for WhisperX alignment model.
    Cached once per process on CUDA (if available) or CPU.
    Reused across all alignment windows and video imports.
    """
    with _ALIGN_LOAD_LOCK:
        global _ALIGN_MODEL, _ALIGN_METADATA, _ALIGN_DEVICE
        device = "cuda" if (torch and torch.cuda.is_available()) else "cpu"
        if _ALIGN_MODEL is None or _ALIGN_DEVICE != device:
            import whisperx
            logger.info("Loading WhisperX alignment model for language 'en' on %s...", device)
            _ALIGN_MODEL, _ALIGN_METADATA = whisperx.load_align_model(
                language_code="en",
                device=device
            )
            _ALIGN_DEVICE = device
            logger.info("WhisperX alignment model loaded successfully.")
        return _ALIGN_MODEL, _ALIGN_METADATA, _ALIGN_DEVICE


def normalize_word_for_alignment(word: str) -> str:
    """
    Normalizes a display word into an acoustic token matching wav2vec2 CTC vocabulary.
    - Preserves apostrophes for contractions (don't, it's).
    - Replaces unicode quotes and hyphens/dashes.
    - Strips non-spoken punctuation (periods, commas, quotes, exclamation/question marks).
    - Keeps token alignment 1-to-1 with display words.
    """
    w = word.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
    w = w.replace('—', ' ').replace('–', ' ')
    cleaned = re.sub(r"[^a-zA-Z0-9'-]+", "", w).lower()
    return cleaned if cleaned else "_"


def _acoustic_time(info: Dict[str, Any], key: str, offset: float) -> Optional[float]:
    """A word time counts only when the aligner SCORED the word (WhisperX interpolates unscored ones)."""
    if info.get("score") is None:
        return None
    v = info.get(key)
    if v is None:
        return None
    v = float(v)
    if np.isnan(v):
        return None
    return round(v + offset, 3)


def _apply_acoustic_envelope(seg: Dict[str, Any], audio_duration: float) -> None:
    """Segment bounds follow the aligned speech when both its first and last word were aligned."""
    words = seg["words"]
    timed = [w for w in words if w["start"] is not None and w["end"] is not None]
    if not timed:
        return
    first_start = timed[0]["start"]
    last_end = timed[-1]["end"]
    if words[0]["start"] is not None and words[-1]["end"] is not None:
        start = max(0.0, first_start - ENVELOPE_PAD_SEC)
        end = min(audio_duration, last_end + ENVELOPE_PAD_SEC)
    else:
        # Edge words stayed unaligned: keep the caption bounds, widened to cover the aligned words.
        start = min(seg["startTimeMs"] / 1000.0, first_start)
        end = max(seg["endTimeMs"] / 1000.0, last_end)
    seg["startTimeMs"] = int(round(start * 1000))
    seg["endTimeMs"] = int(round(min(end, audio_duration) * 1000))


def _align_window(window, full_audio, total_audio_duration, model, metadata, device) -> None:
    import whisperx

    win_start = min(s["startTimeMs"] for s in window) / 1000.0
    win_end = max(s["endTimeMs"] for s in window) / 1000.0
    margin = 1.0
    audio_start = max(0.0, win_start - margin)
    audio_end = min(total_audio_duration, win_end + margin)
    if audio_end <= audio_start:
        for seg in window:
            seg["words"] = [{"word": w, "start": None, "end": None} for w in _display_words(seg)]
        return

    window_audio = full_audio[int(audio_start * SAMPLE_RATE):int(audio_end * SAMPLE_RATE)]
    window_duration = len(window_audio) / float(SAMPLE_RATE)

    align_input = []
    for seg in window:
        local_start = max(0.0, seg["startTimeMs"] / 1000.0 - audio_start)
        local_end = min(window_duration, seg["endTimeMs"] / 1000.0 - audio_start)
        display_words = _display_words(seg)
        align_input.append({
            "text": " ".join(normalize_word_for_alignment(w) for w in display_words),
            # Small margin within window to avoid clipping boundary phonemes
            "start": max(0.0, local_start - 0.2),
            "end": min(window_duration, local_end + 0.2),
            "_display_words": display_words,
        })

    try:
        res = whisperx.align(
            [{"text": a["text"], "start": a["start"], "end": a["end"]} for a in align_input],
            model, metadata, window_audio, device,
        )
        aligned_segments = res.get("segments", [])
    except Exception as e:
        logger.warning("WhisperX alignment failed for window [%.2f, %.2f]: %s", win_start, win_end, e)
        aligned_segments = []

    # One output per input is required to map words back; otherwise the window stays unaligned.
    if len(aligned_segments) != len(align_input):
        aligned_segments = []

    for idx, item in enumerate(align_input):
        seg = window[idx]
        display_words = item["_display_words"]
        aligned_words = aligned_segments[idx].get("words", []) if aligned_segments else []
        if len(aligned_words) != len(display_words):
            aligned_words = []
        mapped = []
        for w_idx, dw in enumerate(display_words):
            info = aligned_words[w_idx] if aligned_words else {}
            start = _acoustic_time(info, "start", audio_start)
            end = _acoustic_time(info, "end", audio_start)
            if start is None or end is None or end <= start:
                start, end = None, None
            mapped.append({"word": dw, "start": start, "end": end})
        seg["words"] = mapped


def _release_cross_segment_edges(segments: List[Dict[str, Any]]) -> None:
    """
    An edge word aligned inside the NEIGHBOURING sentence's speech (a short "A" / "I" pulled onto the
    tail of the previous word) is not where it was spoken: it becomes unaligned instead of being
    highlighted at the wrong moment.
    """
    def timed(seg):
        return [w for w in seg["words"] if w["start"] is not None]

    for prev, cur in zip(segments, segments[1:]):
        p, c = timed(prev), timed(cur)
        if not p or not c:
            continue
        if c[0] is cur["words"][0] and c[0]["start"] < p[-1]["end"] - 0.05:
            c[0]["start"] = c[0]["end"] = None
            c = c[1:]
        if c and p[-1] is prev["words"][-1] and p[-1]["end"] > c[0]["start"] + 0.05:
            p[-1]["start"] = p[-1]["end"] = None


PAUSE_SPLIT_SEC = 3.0
_CLAUSE_END = re.compile(r"[.?!,;:]['\"’”)]*$")


def _split_at_pauses(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    A transcript line that spans a long real pause after a sentence / clause end (a teacher's "Speak and say your
    name. [10 s for the learner] Spell your name.") becomes two lines at that pause: each Dictation sentence then
    replays only its own speech. Only aligned words decide; nothing is retimed.
    """
    out: List[Dict[str, Any]] = []
    for seg in segments:
        words = seg["words"]
        cuts = []
        for i in range(len(words) - 1):
            a, b = words[i], words[i + 1]
            if (a["end"] is not None and b["start"] is not None and b["start"] - a["end"] >= PAUSE_SPLIT_SEC
                    and _CLAUSE_END.search(a["word"])):
                cuts.append(i + 1)
        if not cuts:
            out.append(seg)
            continue
        bounds = [0] + cuts + [len(words)]
        for k in range(len(bounds) - 1):
            part = words[bounds[k]:bounds[k + 1]]
            start = seg["startTimeMs"] if k == 0 else int(round(part[0]["start"] * 1000))
            end = seg["endTimeMs"] if k == len(bounds) - 2 else int(round(part[-1]["end"] * 1000))
            out.append(dict(seg, startTimeMs=start, endTimeMs=max(end, start + 1),
                            text=" ".join(w["word"] for w in part), words=part))
    return out


def _keep_segment_order(segments: List[Dict[str, Any]]) -> None:
    """A line never starts before the previous one (a broken caption window can be a few ms off)."""
    for prev, cur in zip(segments, segments[1:]):
        if cur["startTimeMs"] < prev["startTimeMs"]:
            cur["startTimeMs"] = prev["startTimeMs"]
            cur["endTimeMs"] = max(cur["endTimeMs"], cur["startTimeMs"] + 1)


def _display_words(seg: Dict[str, Any]) -> List[str]:
    words = [w["word"] for w in seg.get("words", []) if w.get("word")]
    return words if words else seg["text"].strip().split()


def align_loaded_audio(segments: List[Dict[str, Any]], full_audio) -> List[Dict[str, Any]]:
    """
    Runs WhisperX forced alignment on transcript segments using source audio.
    Aligns in bounded ~30s windows with safe time margins to handle arbitrary video length.
    Preserves display transcript text exactly. Words the aligner could not score keep
    ``start``/``end`` = None (never interpolated, never split evenly).
    """
    try:
        model, metadata, device = get_alignment_model()
    except Exception as e:
        raise LocalPipelineUnavailable(f"WhisperX alignment model cannot be loaded: {e}") from e

    total_audio_duration = len(full_audio) / float(SAMPLE_RATE)

    # Group segments into bounded windows (~30s duration) for long-video stability
    target_window_sec = 30.0
    windows = []
    current_window = []
    current_start = None
    for seg in segments:
        s_start = seg["startTimeMs"] / 1000.0
        s_end = seg["endTimeMs"] / 1000.0
        if not current_window:
            current_window.append(seg)
            current_start = s_start
        elif (s_end - current_start) <= target_window_sec:
            current_window.append(seg)
        else:
            windows.append(current_window)
            current_window = [seg]
            current_start = s_start
    if current_window:
        windows.append(current_window)

    logger.info("Running WhisperX forced alignment on %d segments across %d bounded windows...", len(segments), len(windows))
    for window in windows:
        if current.get(): current.get().check()
        _align_window(window, full_audio, total_audio_duration, model, metadata, device)
    _release_cross_segment_edges(segments)
    segments = _split_at_pauses(segments)
    for seg in segments:
        _apply_acoustic_envelope(seg, total_audio_duration)
    _keep_segment_order(segments)
    logger.info("WhisperX forced alignment completed.")
    return segments


def alignment_state() -> Dict[str, Any]:
    """What this process really holds in memory, for the readiness check. Loads nothing."""
    return {"engine": "whisperx-wav2vec2", "loaded": _ALIGN_MODEL is not None, "device": _ALIGN_DEVICE}


def warm_up_pipeline() -> None:
    """Loads the local transcription and alignment models once at start-up (an import never pays the load)."""
    try:
        from app.services.listening_local_asr import _load_model
        _load_model()
        get_alignment_model()
        logger.info("Listening WhisperX pipeline warmed up.")
    except Exception as e:  # the import itself reports unavailability (503) if this persists
        logger.warning("Listening WhisperX pipeline warm-up failed: %s", e)


def load_audio_for_alignment(audio_path: str):
    try:
        from whisperx.audio import load_audio
        return load_audio(audio_path)
    except Exception as e:
        raise LocalPipelineUnavailable(f"audio cannot be decoded for alignment ({audio_path}): {e}") from e


def align_segments_with_whisperx(segments: List[Dict[str, Any]], audio_path: str) -> List[Dict[str, Any]]:
    return align_loaded_audio(segments, load_audio_for_alignment(audio_path))


YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def validate_youtube_video_id(video_id: Optional[str]) -> str:
    """Strictly validates a canonical 11-character YouTube video identifier (EC-SEC-2026-009)."""
    if not isinstance(video_id, str) or not YOUTUBE_VIDEO_ID_RE.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Mã video YouTube không hợp lệ.")
    return video_id


def download_youtube_audio(url: str, video_id: str, tmpdir: str) -> str:
    """
    Downloads and extracts YouTube audio to MP3 using yt-dlp.
    Shared audio acquisition pipeline for transcription and alignment.
    """
    video_id = validate_youtube_video_id(video_id)
    if yt_dlp is None:
        raise HTTPException(status_code=503, detail=LOCAL_PIPELINE_UNAVAILABLE_MESSAGE)

    resolved_tmpdir = Path(tmpdir).resolve()
    output_path = (resolved_tmpdir / f"{video_id}.%(ext)s").resolve()
    if not output_path.is_relative_to(resolved_tmpdir):
        raise HTTPException(status_code=400, detail="Đường dẫn tệp âm thanh không hợp lệ.")

    safe_url = f"https://www.youtube.com/watch?v={video_id}"
    audio_template = str(output_path)
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': audio_template,
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'ios', 'web']
            }
        },
        'noprogress': True,
        'noplaylist': True,
        'retries': 1,
        'extractor_retries': 1,
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 10,
        'max_filesize': 250 * 1024 * 1024,  # 250MB audio limit
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            trace = current.get()
            info = trace.metadata if trace else None
            if info:
                # Metadata already selected an audio-only format. Reuse its signed URL within this job.
                info = dict(info)
                info.pop('requested_downloads', None)
                ydl.process_info(info)
                downloaded_path = ydl.prepare_filename(info)
            else:
                info = ydl.extract_info(safe_url, download=True)
                downloaded_path = ydl.prepare_filename(info)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Audio download failed for %s: %s", video_id, e)
        raise HTTPException(status_code=503, detail=SOURCE_UNAVAILABLE_MESSAGE)

    resolved_downloaded = Path(downloaded_path).resolve()
    if not resolved_downloaded.is_relative_to(resolved_tmpdir):
        raise HTTPException(status_code=400, detail="Đường dẫn tệp âm thanh không hợp lệ.")
    if not os.path.exists(downloaded_path):
        raise HTTPException(
            status_code=400,
            detail="Video này không có luồng âm thanh phù hợp để tạo bài luyện nghe."
        )
    return downloaded_path


# ==============================================================================
# ROUTING AND METADATA PROCESSING
# ==============================================================================

def normalize_youtube_url(url_or_id: str) -> str:
    if not url_or_id:
        raise HTTPException(status_code=400, detail="Đường dẫn YouTube không hợp lệ.")
    raw = url_or_id.strip()
    if YOUTUBE_VIDEO_ID_RE.fullmatch(raw):
        return raw

    patterns = [
        r"(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})",
        r"[?&]v=([a-zA-Z0-9_-]{11})"
    ]
    for p in patterns:
        m = re.search(p, raw)
        if m:
            return validate_youtube_video_id(m.group(1))

    raise HTTPException(status_code=400, detail="Đường dẫn YouTube không hợp lệ.")


def check_english_ratio(text: str) -> float:
    """
    Computes rough English word ratio using common English phonetic/lexical patterns.
    """
    words = re.findall(r"\b[a-zA-Z']+\b", text)
    if not words:
        return 0.0
    common_en = {
        "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for",
        "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
        "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
        "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
        "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
        "time", "no", "just", "him", "know", "take", "people", "into", "year", "your",
        "good", "some", "could", "them", "see", "other", "than", "then", "now", "look",
        "only", "come", "its", "over", "think", "also", "back", "after", "use", "two",
        "how", "our", "work", "first", "well", "way", "even", "new", "want", "because",
        "any", "these", "give", "day", "most", "us", "is", "are", "was", "were", "been"
    }
    match_count = sum(1 for w in words if w.lower() in common_en)
    return match_count / len(words)


def _text_segment(text: str, start_sec: float, end_sec: float) -> Dict[str, Any]:
    """A transcript line with coarse bounds; its words get timing ONLY from WhisperX alignment."""
    return {
        "startTimeMs": int(start_sec * 1000),
        "endTimeMs": int(end_sec * 1000),
        "speakerName": "Speaker",
        "text": text,
        "difficultyScore": 1.0,
        "words": [{"word": w, "start": None, "end": None} for w in text.split()],
    }


def extract_segments_from_transcript_entries(entries) -> List[Dict[str, Any]]:
    """
    Extracts coarse segment text and boundaries from YouTubeTranscriptApi entries.
    Words carry no timing until WhisperX aligns them.
    """
    segments = []
    for entry in entries:
        if hasattr(entry, 'text'):
            text = getattr(entry, 'text', '')
            start_sec = float(getattr(entry, 'start', 0.0))
            dur_sec = float(getattr(entry, 'duration', 2.0))
        elif isinstance(entry, dict):
            text = entry.get('text', '')
            start_sec = float(entry.get('start', 0.0))
            dur_sec = float(entry.get('duration', 2.0))
        else:
            continue

        clean_text = text.strip().replace('\n', ' ')
        if not clean_text or clean_text in {"♪", "[Music]", "[Applause]", "[Laughter]", "♪♪", "♪ ♪"}:
            continue
        segments.append(_text_segment(clean_text, start_sec, start_sec + dur_sec))
    return segments


def _caption_gates(segments: List[Dict[str, Any]], duration: int) -> None:
    total_spoken_words = sum(len(s.get("words", [])) for s in segments)
    if total_spoken_words < 15 and duration > 30:
        raise HTTPException(
            status_code=400,
            detail="Không phát hiện đủ lời thoại trong video để tạo bài luyện nghe."
        )
    en_ratio = check_english_ratio(" ".join(s["text"] for s in segments))
    if en_ratio < 0.05 and total_spoken_words > 30:
        raise HTTPException(
            status_code=400,
            detail="Video này không có đủ nội dung tiếng Anh để tạo bài luyện nghe."
        )


def _captions_via_transcript_api(video_id: str) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    if YouTubeTranscriptApi is None:
        return None, None
    try:
        import requests
        class BoundedSession(requests.Session):
            def request(self, *args, **kwargs):
                kwargs.setdefault('timeout', (5, 8))
                return super().request(*args, **kwargs)
        with BoundedSession() as session:
            transcript_list = YouTubeTranscriptApi(http_client=session).list(video_id)
    except Exception as ex:
        logger.info("ytta.list failed for %s: %s", video_id, ex)
        return None, None
    chosen = None
    for t in transcript_list:
        if t.language_code.lower() in ENGLISH_LANG_CODES and not t.is_generated:
            chosen = t
            break
    if not chosen:
        for t in transcript_list:
            if t.language_code.lower() in ENGLISH_LANG_CODES:
                chosen = t
                break
    if not chosen:
        return None, None
    try:
        segments = extract_segments_from_transcript_entries(chosen.fetch())
    except Exception as ex:
        logger.info("ytta.fetch failed for %s: %s", video_id, ex)
        return None, None
    return segments, ("captions-auto" if chosen.is_generated else "captions-manual")


def _captions_via_timedtext(video_id: str, subs_dict: Dict, auto_dict: Dict) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Caption TEXT from yt-dlp's track list (json3). Provider word offsets are never used as timing."""
    chosen_track, kind = None, None
    for tracks, source in ((subs_dict, "captions-manual"), (auto_dict, "captions-auto")):
        for c, track in tracks.items():
            if c.lower() in ENGLISH_LANG_CODES and track:
                chosen_track, kind = track, source
                break
        if chosen_track:
            break
    if not chosen_track:
        return None, None
    json3_url = None
    for format_entry in chosen_track:
        if format_entry.get('ext') == 'json3' or 'json' in format_entry.get('ext', ''):
            json3_url = format_entry.get('url')
            break
    if not json3_url:
        json3_url = chosen_track[0].get('url')
    if not json3_url:
        return None, None
    try:
        req = urllib.request.Request(json3_url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        logger.info("yt-dlp timedtext fetch failed for %s: %s", video_id, e)
        return None, None

    segments = []
    for ev in data.get('events', []):
        if 'segs' not in ev:
            continue
        t_start_ms = ev.get('tStartMs', 0)
        t_end_ms = t_start_ms + ev.get('dDurationMs', 2000)
        parts = []
        for s in ev.get('segs', []):
            token = (s.get('utf8') or '').strip()
            if token and token not in {"♪", "[Music]"}:
                parts.append(token)
        full_text = ' '.join(parts).strip()
        if full_text:
            segments.append(_text_segment(full_text, t_start_ms / 1000.0, t_end_ms / 1000.0))
    return (segments or None), kind


def fetch_youtube_metadata_and_captions(video_id: str, trace=None, prefer_captions=True) -> Dict[str, Any]:
    video_id = validate_youtube_video_id(video_id)
    # One GPU pipeline at a time, including alignment; synchronous legacy callers cannot bypass the bulkhead.
    acquired = _PIPELINE_LOCK.acquire(blocking=False)
    if not acquired and trace is not None:
        while not acquired:
            trace.check()
            acquired = _PIPELINE_LOCK.acquire(timeout=0.25)
    if not acquired:
        raise HTTPException(status_code=503, detail="Máy xử lý đang bận. Vui lòng thử lại sau.")
    trace = trace or Trace()
    model_load_needed = not (transcription_state()['loaded'] and alignment_state()['loaded'])
    token = current.set(trace)
    try:
        result = _fetch_youtube_pipeline(video_id, prefer_captions)
        result['performance'] = {'jobId': trace.id, 'elapsedMs': round((time.perf_counter()-trace.started)*1000,2),
                                 'stages': trace.stages, 'modelLoadNecessary': model_load_needed, 'gpuInference': True}
        return result
    finally:
        current.reset(token)
        _PIPELINE_LOCK.release()


def _transcribe_audio(full_audio):
    segments = measured("transcription", transcribe_segments, full_audio)
    text = " ".join(s["text"] for s in segments)
    count = len(text.split())
    if count < 10:
        raise HTTPException(status_code=400, detail="Không phát hiện đủ lời thoại trong video để tạo bài luyện nghe.")
    if check_english_ratio(text) < 0.05 and count > 25:
        raise HTTPException(status_code=400, detail="Video này không có đủ nội dung tiếng Anh để tạo bài luyện nghe.")
    return segments


def _fetch_youtube_pipeline(video_id: str, prefer_captions=True) -> Dict[str, Any]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    if yt_dlp is None:
        raise local_pipeline_unavailable(RuntimeError("yt-dlp is not installed"))

    # 1. Metadata with yt-dlp (real duration is mandatory: never a default)
    ydl_opts = {
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web"]
            }
        },
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 10,
        "retries": 1,
        "extractor_retries": 1,
        "noplaylist": True,
        "format": "bestaudio/best",
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = measured("metadata", ydl.extract_info, url, download=False)
            if current.get(): current.get().metadata = info
    except Exception as e:
        logger.warning("yt-dlp extract_info failed for %s: %s", video_id, e)
        err_msg = str(e).lower()
        if "private" in err_msg or "unavailable" in err_msg or "deleted" in err_msg:
            raise HTTPException(status_code=400, detail="Video YouTube này là riêng tư hoặc không khả dụng.")
        raise HTTPException(status_code=503, detail=SOURCE_UNAVAILABLE_MESSAGE)
    if not info or not info.get("duration"):
        raise HTTPException(status_code=503, detail=SOURCE_UNAVAILABLE_MESSAGE)

    title = info.get("title") or f"YouTube Audio: {video_id}"
    duration = int(info["duration"])
    if duration > 7200 or info.get('is_live'):
        raise HTTPException(status_code=400, detail="Chọn video đã hoàn tất, dài tối đa hai giờ.")
    thumbnail = info.get("thumbnail") or f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"

    # STAGE 1: Audio Availability Gate
    formats = info.get("formats", [])
    has_audio = any(f.get("acodec") != "none" or f.get("audio_channels") for f in formats)
    if not has_audio and formats:
        raise HTTPException(
            status_code=400,
            detail="Video này không có luồng âm thanh phù hợp để tạo bài luyện nghe."
        )

    # 2. Language metadata
    subs_dict = info.get("subtitles") or {}
    auto_dict = info.get("automatic_captions") or {}
    orig_lang = None
    for k in auto_dict.keys():
        if k.endswith("-orig"):
            orig_lang = k.replace("-orig", "").lower()
            break
    has_manual_english = any(code in subs_dict for code in ["en", "en-US", "en-GB", "en-CA"])
    if orig_lang and orig_lang not in {"en"} and not has_manual_english:
        logger.info("Video %s rejected: original language is %s without manual English subs", video_id, orig_lang)
        raise HTTPException(
            status_code=400,
            detail="Video này không có đủ nội dung tiếng Anh để tạo bài luyện nghe."
        )

    # 3. Transcript TEXT: English captions (manual first) — timing comes only from alignment below
    segments, transcript_source = None, None
    if prefer_captions:
        segments, transcript_source = measured("captions", _captions_via_timedtext, video_id, subs_dict, auto_dict)
        if not segments:
            segments, transcript_source = measured("caption_fallback", _captions_via_transcript_api, video_id)
        if segments:
            try:
                _caption_gates(segments, duration)
            except HTTPException:
                # Captions can be present yet unusable. Judge the actual audio through the SAME local pipeline.
                segments, transcript_source = None, None

    with tempfile.TemporaryDirectory() as tmpdir:
        mp3_path = measured("audio_download", download_youtube_audio, url, video_id, tmpdir)
        downloaded_bytes = os.path.getsize(mp3_path)
        if current.get() and current.get().stages:
            current.get().stages[-1]['downloadedBytes'] = downloaded_bytes
        if downloaded_bytes < 1000:
            raise HTTPException(
                status_code=400,
                detail="Video này không có luồng âm thanh phù hợp để tạo bài luyện nghe."
            )
        try:
            full_audio = measured("audio_decode", load_audio_for_alignment, mp3_path)
            audio_duration = len(full_audio) / float(SAMPLE_RATE)
            if abs(audio_duration - duration) > DURATION_MISMATCH_SEC:
                logger.warning("Video %s: metadata %ss vs audio %.1fs", video_id, duration, audio_duration)
                raise HTTPException(status_code=503, detail=SOURCE_UNAVAILABLE_MESSAGE)

            # 4. No English captions: LOCAL transcription on this PC (WhisperX's faster-whisper engine)
            if not segments:
                logger.info("No captions for %s: local transcription (%s)", video_id, engine_label())
                segments = _transcribe_audio(full_audio)
                transcript_source = f"local-asr:{engine_label()}"

            # 5. WhisperX acoustic word alignment (the only source of word timing)
            segments = measured("alignment", align_loaded_audio, segments, full_audio)
        except LocalPipelineUnavailable as e:
            raise local_pipeline_unavailable(e)

    # 6. Publication gate: origin + plausibility of every timestamp
    try:
        report = measured("validation", assess_transcript_timing, segments, audio_duration)
    except TimingRejected as e:
        if transcript_source and transcript_source.startswith("captions-"):
            logger.info("Video %s: captions failed alignment gate (%s); transcribing the same decoded audio locally", video_id, e.reason)
            try:
                segments = _transcribe_audio(full_audio)
                segments = measured("alignment", align_loaded_audio, segments, full_audio)
                report = measured("validation", assess_transcript_timing, segments, audio_duration)
                transcript_source = f"local-asr:{engine_label()}"
            except LocalPipelineUnavailable as unavailable:
                raise local_pipeline_unavailable(unavailable)
            except TimingRejected as refused:
                raise HTTPException(status_code=422, detail=refused.message)
        else:
            logger.warning("Video %s refused by the timing gate: %s", video_id, e)
            raise HTTPException(status_code=422, detail=e.message)

    report.update({"alignment": "whisperx-wav2vec2", "transcript": transcript_source})
    logger.info("Video %s ready: %s", video_id, report)
    return {
        "title": title,
        "durationSeconds": duration,
        "thumbnailUrl": thumbnail,
        "detectedLanguage": "en",
        "timing": report,
        "segments": segments
    }
