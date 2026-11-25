"""
Publication gate for Listening YouTube transcripts (rules 10 §BE, SUPREME LISTENING YOUTUBE IMPORT LAW).

Every timestamp a Listening lesson stores must come from WhisperX acoustic alignment on the
owner's PC. This module checks the ORIGIN and the PLAUSIBILITY of the timing, not only that numbers
exist ("timestamp completeness is not timestamp accuracy"):

- a word has timing only when the aligner scored it (``score`` present); everything else is ``None``;
- no negative, reversed or out-of-media timing, no segment out of order;
- no synthetic signatures (equal-length words across a segment, fixed segment grids such as the
  removed fixed 2.5-second chunking);
- enough of the transcript must be acoustically aligned, otherwise nothing is published.

Pure Python (no torch): unit-tested without a GPU.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# Media tolerance: YouTube durations are whole seconds and caption windows may end a little late.
END_TOLERANCE_SEC = 1.5
# A transcript is publishable only when this share of its words carries acoustic timing ...
MIN_ALIGNED_WORD_RATIO = 0.90
# ... and at most this share of its segments is mostly unaligned.
MAX_UNALIGNED_SEGMENT_RATIO = 0.10
# A segment counts as aligned when at least half of its words were scored by the aligner.
SEGMENT_ALIGNED_SHARE = 0.5
# Inside one sentence two consecutive words are never this far apart in real speech.
MAX_WORD_GAP_SEC = 8.0
# A single aligned word is never longer than this.
MAX_WORD_SEC = 5.0


class TimingRejected(Exception):
    """The transcript must not be published; ``reason`` is a stable code, ``message`` is for learners."""

    def __init__(self, reason: str, message: str):
        super().__init__(f"{reason}: {message}")
        self.reason = reason
        self.message = message


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def _uniform_spacing(words: List[Dict[str, Any]]) -> bool:
    """True when every word of a segment has the same length and abuts the next one (even split)."""
    timed = [w for w in words if _num(w.get("start")) is not None and _num(w.get("end")) is not None]
    if len(timed) < 4 or len(timed) != len(words):
        return False
    lengths = [round(_num(w["end"]) - _num(w["start"]), 2) for w in timed]
    if max(lengths) - min(lengths) > 0.011:
        return False
    for a, b in zip(timed, timed[1:]):
        if abs(_num(b["start"]) - _num(a["end"])) > 0.011:
            return False
    return True


def _fixed_grid(segments: List[Dict[str, Any]]) -> bool:
    """True when segment starts march on one constant step (the removed fixed 2.5-second chunking)."""
    starts = [s.get("startTimeMs") for s in segments]
    if len(starts) < 6:
        return False
    steps = [b - a for a, b in zip(starts, starts[1:])]
    return len(set(steps)) == 1 and steps[0] > 0


def assess_transcript_timing(segments: List[Dict[str, Any]], media_duration_sec: float) -> Dict[str, Any]:
    """
    Validates aligned segments against the real media duration. Raises ``TimingRejected`` when the
    transcript must not be published; returns the timing report otherwise.
    """
    if not media_duration_sec or media_duration_sec <= 0:
        raise TimingRejected("DURATION_UNKNOWN", "Không xác định được độ dài thật của video.")
    if not segments:
        raise TimingRejected("NO_SEGMENTS", "Không phát hiện đủ lời thoại trong video để tạo bài luyện nghe.")

    limit = media_duration_sec + END_TOLERANCE_SEC
    total_words = 0
    aligned_words = 0
    unaligned_segments = 0
    uniform_segments = 0
    prev_start = -1

    for idx, seg in enumerate(segments):
        s_ms, e_ms = seg.get("startTimeMs"), seg.get("endTimeMs")
        if not isinstance(s_ms, int) or not isinstance(e_ms, int):
            raise TimingRejected("SEGMENT_MALFORMED", f"Câu {idx + 1} thiếu mốc thời gian.")
        if s_ms < 0 or e_ms <= s_ms:
            raise TimingRejected("SEGMENT_REVERSED", f"Câu {idx + 1} có mốc thời gian không hợp lệ.")
        if e_ms / 1000.0 > limit:
            raise TimingRejected("BEYOND_MEDIA", f"Câu {idx + 1} kết thúc sau khi video đã hết.")
        if s_ms < prev_start:
            raise TimingRejected("SEGMENT_ORDER", f"Câu {idx + 1} nằm sai thứ tự thời gian.")
        prev_start = s_ms

        words = seg.get("words") or []
        if not words:
            raise TimingRejected("WORDS_MISSING", f"Câu {idx + 1} không có danh sách từ.")
        seg_aligned = 0
        last_end = None
        for w in words:
            total_words += 1
            ws, we = w.get("start"), w.get("end")
            if ws is None and we is None:
                continue
            ws, we = _num(ws), _num(we)
            if ws is None or we is None:
                raise TimingRejected("WORD_MALFORMED", f"Câu {idx + 1} có mốc thời gian từ không hợp lệ.")
            if ws < 0 or we <= ws or we - ws > MAX_WORD_SEC:
                raise TimingRejected("WORD_REVERSED", f"Câu {idx + 1} có từ với thời lượng không hợp lệ.")
            if we > limit:
                raise TimingRejected("BEYOND_MEDIA", f"Câu {idx + 1} có từ nằm sau khi video đã hết.")
            if last_end is not None:
                if ws < last_end - 0.05:
                    raise TimingRejected("WORD_ORDER", f"Câu {idx + 1} có từ sai thứ tự thời gian.")
                if ws - last_end > MAX_WORD_GAP_SEC:
                    raise TimingRejected("WORD_GAP", f"Câu {idx + 1} có khoảng trống bất thường giữa hai từ.")
            last_end = we
            seg_aligned += 1
        aligned_words += seg_aligned
        if seg_aligned < SEGMENT_ALIGNED_SHARE * len(words):
            unaligned_segments += 1
        if _uniform_spacing(words):
            uniform_segments += 1

    if _fixed_grid(segments):
        raise TimingRejected("SYNTHETIC_GRID", "Mốc thời gian có dấu hiệu bị tạo giả theo lưới cố định.")
    if uniform_segments > max(1, 0.2 * len(segments)):
        raise TimingRejected("SYNTHETIC_UNIFORM", "Mốc thời gian từ có dấu hiệu bị chia đều giả tạo.")

    ratio = aligned_words / total_words if total_words else 0.0
    if ratio < MIN_ALIGNED_WORD_RATIO or unaligned_segments > MAX_UNALIGNED_SEGMENT_RATIO * len(segments):
        raise TimingRejected(
            "ALIGNMENT_INSUFFICIENT",
            "Không căn chỉnh được đủ từ với âm thanh thật của video, bài nghe không được tạo.",
        )

    return {
        "words": total_words,
        "alignedWords": aligned_words,
        "alignedWordRatio": round(ratio, 4),
        "segments": len(segments),
        "unalignedSegments": unaligned_segments,
        "mediaDurationSec": round(media_duration_sec, 2),
        "lastEndSec": round(max(s["endTimeMs"] for s in segments) / 1000.0, 2),
    }
