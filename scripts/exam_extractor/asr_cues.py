"""Spoken structure cues from whole-test recordings (Exams Recovery Phase 3.6B/E).

Test recordings ANNOUNCE their own structure: 'Part 2. Directions: …', 'Questions 71 through 73 refer to the
following talk.', 'Number 32. What type of event…'. These announcements are source evidence that does not depend
on the booklet's typography (the ETS 2026 booklet prints no Part 3/4 set ranges). They are read with a LOCAL speech
recogniser (Whisper tiny.en from the local Hugging Face cache, `local_files_only` — never downloaded, never uploaded)
on short windows that start where each pause ends (announcements are spoken right after a pause).

Only parsed CUES are kept — kind, numbers, time and the matched cue words (<= 8 words) — never the transcript text.
Cache: imports/exams/staging/cache/asr_cues/<parentSha256>.json (keyed by parent hash, model, window plan, version).

Cue kinds
  SET     'questions 71 (through|to|-) 73 refer…'          -> a=71, b=73
  PART    'part (one|two|three|four|1-4)'                    -> n
  NUMBER  'number 32' / 'question number 32'               -> n

How cues are used (never alone; never to create structure from arithmetic):
  * Part 3/4 sets: accepted only when every set of the part is announced, the announced ranges are contiguous and
    cover the printed numbers exactly, the announcements are in time order, and between two consecutive
    announcements the recording holds exactly (b - a + 1) answer pauses of the part's class (audio rhythm
    corroborates the spoken range). A missing or contradictory announcement leaves the part unresolved.
  * Part boundaries: a spoken 'Part n' announcement that follows the last answer pause of part n-1 (pause class
    and count checked by audio_segment.py) is an explicit boundary signal (S6).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

import numpy as np

from .audio_segment import ffmpeg_path
from .corpus import raw_abs

ASR_VERSION = "2"
MODEL_ID = "openai/whisper-tiny.en"
SR16 = 16000
WINDOW_S = 8.0          # an announcement ('Questions 71 through 73 refer to the following talk.') takes ~4 s
LEAD_S = 2.0            # a window opens this much before the pause ends (a quiet 'Part 2' sits inside the
                        # envelope silence); cue times stay anchored at the pause end
MIN_PAUSE_S = 1.5       # windows start after pauses at least this long
DENSE_STEP_S = 3.5      # overlapping windows after a 'Part n' announcement (directions -> first set)
DENSE_SPAN_S = 75.0

_WORDNUM = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
            "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
            "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
            "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100}
_NUM = r"(\d{1,3}|(?:(?:one\s+)?hundred(?:\s+and)?\s+)?(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)" \
       r"(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|ten|eleven|twelve|thirteen|fourteen|fifteen|" \
       r"sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine)"
_SET = re.compile(rf"\bquestions?\s+{_NUM}\s*(?:through|thru|to|till|until|-|–|and)\s*{_NUM}\s*,?\s+(?:refer|referred|refers)", re.I)
_PART = re.compile(r"\bpart\s+(one|two|three|four|1|2|3|4)\b", re.I)
_NUMBER = re.compile(rf"\b(?:question\s+)?number\s+{_NUM}\b", re.I)


def words_to_int(s: str) -> Optional[int]:
    s = s.strip().lower().replace("-", " ")
    if s.isdigit():
        return int(s)
    total = 0
    for w in s.split():
        if w == "and":
            continue
        v = _WORDNUM.get(w)
        if v is None:
            return None
        if v == 100:
            total = max(total, 1) * 100
        else:
            total += v
    return total or None


def parse_cues(text: str, at_s: float) -> list:
    """Cues of one window transcript (kept: kind, numbers, window time, word position of the match in the
    window, <= 8 matched words)."""
    out = []
    t = re.sub(r"\s+", " ", text).strip()

    def pos(m) -> int:
        return len(t[:m.start()].split())
    for m in _SET.finditer(t):
        a, b = words_to_int(m.group(1)), words_to_int(m.group(2))
        if a is not None and b is not None:
            out.append({"kind": "SET", "a": a, "b": b, "atS": at_s, "pos": pos(m),
                        "match": " ".join(m.group(0).split()[:8])})
    for m in _PART.finditer(t):
        out.append({"kind": "PART", "n": words_to_int(m.group(1)), "atS": at_s, "pos": pos(m), "match": m.group(0)})
    for m in _NUMBER.finditer(t):
        n = words_to_int(m.group(1))
        if n is not None:
            out.append({"kind": "NUMBER", "n": n, "atS": at_s, "pos": pos(m),
                        "match": " ".join(m.group(0).split()[:4])})
    return out


class LocalWhisper:
    """Whisper tiny.en from the LOCAL Hugging Face cache only (no download, no network)."""

    def __init__(self):
        self._proc = self._model = None
        self.error = None

    def available(self) -> bool:
        if self._model is not None:
            return True
        if self.error is not None:
            return False
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        try:
            from transformers import WhisperForConditionalGeneration, WhisperProcessor  # type: ignore
            self._proc = WhisperProcessor.from_pretrained(MODEL_ID, local_files_only=True)
            self._model = WhisperForConditionalGeneration.from_pretrained(MODEL_ID, local_files_only=True).eval()
            return True
        except Exception as e:      # model not cached / transformers missing: cues are simply unavailable
            self.error = type(e).__name__
            return False

    def transcribe(self, chunk: np.ndarray) -> str:
        import torch  # type: ignore
        feats = self._proc(chunk, sampling_rate=SR16, return_tensors="pt").input_features
        with torch.no_grad():
            ids = self._model.generate(feats, max_new_tokens=96)
        return self._proc.batch_decode(ids, skip_special_tokens=True)[0]


_ENGINE = LocalWhisper()


def decode16k(source: str, member: Optional[str] = None) -> np.ndarray:
    ff = ffmpeg_path()
    if ff is None:
        raise RuntimeError("ffmpeg not available")
    full = raw_abs(source)
    if member:
        with zipfile.ZipFile(full) as z:
            data = z.read(member)
        cmd = [ff, "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR16), "-f", "s16le", "-"]
        out = subprocess.run(cmd, input=data, capture_output=True, check=True).stdout
    else:
        cmd = [ff, "-v", "error", "-i", str(full), "-ac", "1", "-ar", str(SR16), "-f", "s16le", "-"]
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, np.int16).astype(np.float32) / 32768.0


def window_plan(pauses: list, duration_s: float) -> list:
    """[(anchor, start)]: the recording start and the end of every pause >= MIN_PAUSE_S (anchor), each window
    opening min(LEAD_S, 40 % of the pause) earlier."""
    plan = [(0.0, 0.0)] + [(round(s + d, 2), round(s + d - min(LEAD_S, 0.4 * d), 2))
                           for s, d in pauses if d >= MIN_PAUSE_S]
    return [(a, b) for a, b in plan if a < duration_s - 1.0]


def scan_cues(staging_root: Path, source: str, sha256: str, pauses: list, duration_s: float,
              member: Optional[str] = None, force: bool = False) -> dict:
    """Cues of one recording (cached). Returns {"available": bool, "cues": [...], ...}."""
    plan = window_plan(pauses, duration_s)
    key = {"asrVersion": ASR_VERSION, "model": MODEL_ID, "windowS": WINDOW_S, "minPauseS": MIN_PAUSE_S,
           "leadS": LEAD_S, "dense": [DENSE_STEP_S, DENSE_SPAN_S], "windows": len(plan), "parentSha256": sha256}
    path = staging_root / "cache" / "asr_cues" / f"{sha256}.json"
    if path.exists() and not force:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("key") == key:
            return refine_boundary_cues(data, path, source, member, duration_s)
    if not _ENGINE.available():
        return {"available": False, "reason": _ENGINE.error or "ASR model unavailable", "cues": []}
    x = decode16k(source, member)
    cues = []

    def run(windows):
        for anchor, start in windows:
            a = int(start * SR16)
            chunk = x[a:a + int(WINDOW_S * SR16)]
            if len(chunk) >= SR16 // 2:
                for c in parse_cues(_ENGINE.transcribe(chunk), round(anchor, 2)):
                    c["windowStartS"] = round(start, 2)
                    cues.append(c)
    run(plan)
    # second pass: the directions read after a 'Part n' announcement run straight into the part's first set
    # announcement (no pause long enough to open a window) -> overlapping windows until the next long pause
    dense = []
    long_starts = sorted(s for s, d in pauses if d >= 3.0)
    for c in [c for c in cues if c["kind"] == "PART"]:
        stop = next((p for p in long_starts if p > c["atS"] + 1.0), c["atS"] + DENSE_SPAN_S)
        t = c["atS"] + DENSE_STEP_S
        while t < min(stop, c["atS"] + DENSE_SPAN_S, duration_s - 1.0):
            dense.append((round(t, 2), round(t, 2)))
            t += DENSE_STEP_S
    run(dense)
    data = {"key": key, "available": True, "engine": {"model": MODEL_ID, "localFilesOnly": True},
            "windows": len(plan) + len(dense), "denseWindows": len(dense), "cues": cues, "transcriptStored": False}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return refine_boundary_cues(data, path, source, member, duration_s)


def refine_boundary_cues(data: dict, path: Path, source: str, member: Optional[str], duration_s: float) -> dict:
    """Bounded overlapping rereads around announcements; retain only parsed source cues.

    The initial pause windows can miss quiet final ordinals. Reuse the existing
    cue cache and read at most the adjacent 75 seconds; never supply an ordinal.
    """
    if data.get('boundaryRereadVersion') == 1:
        return data
    cues = data.get('cues', [])
    missing = []
    for part, lasts in ((2,{6,10}),(3,{31,40}),(4,{70})):
        announcements = [c for c in cues if c.get('kind')=='PART' and c.get('n')==part and c.get('pos',99)<=2]
        for c in announcements:
            at=c['atS']
            before=[q for q in cues if q.get('kind')=='NUMBER' and at-DENSE_SPAN_S<q['atS']<at]
            if not any(q.get('n') in lasts for q in before):
                missing.append(at)
    if missing and _ENGINE.available():
        x=decode16k(source,member)
        windows=sorted({round(t,2) for at in missing
                        for t in np.arange(max(0,at-DENSE_SPAN_S),min(at+DENSE_SPAN_S,duration_s-1),DENSE_STEP_S)})
        for start in windows:
            chunk=x[int(start*SR16):int((start+WINDOW_S)*SR16)]
            for cue in parse_cues(_ENGINE.transcribe(chunk),start):
                # These windows prove ordinals only; they are not acoustic part anchors.
                if cue['kind'] in ('NUMBER','SET'):
                    cue['windowStartS']=start
                    cue['boundedBoundaryReread']=True
                    cues.append(cue)
        data['boundaryRereadWindows']=len(windows)
    data['boundaryRereadVersion']=1
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data,indent=1),encoding='utf-8')
    os.replace(tmp,path)
    return data


# ── evidence rules ──────────────────────────────────────────────────────────────────────────────

def announced_sets(cues: list, lo: int, hi: int, answer_pauses: list, end_s: float = float("inf")) -> tuple:
    """Part 3/4 sets from spoken announcements, corroborated by the answer-pause rhythm.

    answer_pauses: [(start_s, dur_s)] answer pauses of this part family (from audio_segment, time order);
    end_s: where the part ends (next part announcement / end of recording).
    -> (sets [(a, b, atS)] or None, detail). Never creates a set that was not announced."""
    found = {}
    for c in cues:
        if c["kind"] == "SET" and lo <= c["a"] <= c["b"] <= hi:
            found.setdefault((c["a"], c["b"]), []).append(c["atS"])
    if not found:
        return None, "no spoken set announcement"
    seq = sorted(((a, b, min(ts)) for (a, b), ts in found.items()), key=lambda s: s[2])
    if [s[0] for s in seq] != sorted(s[0] for s in seq):
        return None, "announcements out of time order"
    covered, nxt = [], lo
    for a, b, _t in seq:
        if a != nxt:
            return None, f"announcement missing or contradictory before question {a} (expected {nxt})"
        covered.extend(range(a, b + 1))
        nxt = b + 1
    if nxt != hi + 1:
        return None, f"announcements stop at question {nxt - 1} (part ends at {hi})"
    # audio rhythm: between consecutive announcements exactly (b - a + 1) answer pauses
    bounds = [s[2] for s in seq] + [end_s]
    for (a, b, t0), t1 in zip(seq, bounds[1:]):
        n = sum(1 for ps, _d in answer_pauses if t0 < ps < t1)
        if n != b - a + 1:
            return None, f"set {a}-{b}: {n} answer pauses after its announcement (expected {b - a + 1})"
    return seq, f"{len(seq)} spoken set announcements, contiguous, each followed by its own answer pauses"


def part_announcements(cues: list) -> dict:
    """{n: [atS…]} of spoken 'Part n' announcements."""
    out = {}
    for c in cues:
        if c["kind"] == "PART" and c.get("n"):
            out.setdefault(c["n"], []).append(c["atS"])
    return out
