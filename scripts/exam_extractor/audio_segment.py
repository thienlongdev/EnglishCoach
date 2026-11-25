"""Whole-test audio forensics and DEFENSIBLE Part segmentation (Exams Recovery Phase 3.5L).

Raw audio is decoded read-only into memory (ffmpeg -> 8 kHz mono PCM; zip members are piped, never extracted
to disk) and NEVER modified. The analysis produces candidate boundaries with evidence tiers:

  CONFIDENT   multiple independent signals align (exact structure)       -> may become an automatic segment
  PROBABLE    strong signal + correct expected structure                  -> review queue, not split
  AMBIGUOUS   silence / duration only                                     -> review queue
  UNRESOLVED  no defensible split                                         -> nothing

Never: fixed percentages of the duration, division by expected question counts, or silence alone.

TOEIC model (studio recordings): every question is followed by one ANSWER PAUSE whose length is fixed per part
family (Parts 1-2 short, Parts 3-4 long); a pause that starts within 3 s of the previous pause's end is a
follow-on (page turn) and is not an answer pause. Signals:
  S1 exact class counts: short answer pauses == items(P1+P2), long answer pauses == items(P3+P4)
  S2 order: every short answer pause precedes every long one
  S3 triplet rhythm: long pauses form sets of exactly 3 (within-set gaps < between-set gaps), sets == items/3
  S4 directions gap: the speech gap after the last Part 1 answer pause is the largest gap of Parts 1-2
     (the Part 2 directions are read there)
  S5 the gap after the last Part 3 set is at least the median between-set gap (Part 4 directions)
  Boundary 1|2 CONFIDENT = S1+S2+S4 ; 2|3 = S1+S2+S3 ; 3|4 = S1+S2+S3+S5 ; with S1+S2 only -> PROBABLE.
  Phase 3.6 (asr_cues.py, local recogniser): the recording ANNOUNCES each part.
  S6 a spoken 'Part n' announcement opens a window that starts where an answer pause of part n-1's class ends
  S7 the last spoken question number before it is the last question of part n-1
  Boundary n-1|n CONFIDENT = S6 + (S7, or the pause-structure boundary at the same instant). A spoken announcement
  that contradicts a pause-structure boundary makes that boundary AMBIGUOUS (conflict), never silently moved.

IELTS whole-test recordings pause for SPOKEN question spans ('look at questions 11 to 16') that merge printed
groups, so the printed structure cannot predict the silence pattern: long silences are reported as AMBIGUOUS
candidates for human review; nothing is split.

Outputs (derived, outside imports/source-files/**):
  imports/exams/staging/audio_segments/<parentSha256>.json   analysis + candidates + segments (virtual ranges)
  imports/exams/staging/assets/audio/<sha256>.mp3           physically rendered ONLY for CONFIDENT segments
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

import numpy as np

from .corpus import raw_abs, raw_rel
from .diagnostics import AMBIGUOUS, CONFIDENT, PROBABLE, UNRESOLVED
from .model import AudioBinding

ANALYSIS_VERSION = "7"
SR = 8000
FRAME_S = 0.05
MIN_PAUSE_S = 3.0
FOLLOW_ON_S = 3.0

TOEIC_ITEMS = {"TOEIC_LR_2016": (6, 25, 39, 30), "TOEIC_LR_PRE_2016": (10, 30, 30, 30)}


def ffmpeg_path() -> Optional[str]:
    for c in (shutil.which("ffmpeg"), r"C:\Anaconda\Scripts\ffmpeg.exe", r"C:\Anaconda\Library\bin\ffmpeg.exe"):
        if c and Path(c).exists():
            return c
    return None


def decode(source: str, member: Optional[str] = None) -> np.ndarray:
    """Mono 8 kHz float PCM of a raw recording (read-only; zip members are piped through stdin)."""
    ff = ffmpeg_path()
    if ff is None:
        raise RuntimeError("ffmpeg not available")
    full = raw_abs(source)
    if member:
        with zipfile.ZipFile(full) as z:
            data = z.read(member)
        cmd = [ff, "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
        out = subprocess.run(cmd, input=data, capture_output=True, check=True).stdout
    else:
        cmd = [ff, "-v", "error", "-i", str(full), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, np.int16).astype(np.float32)


def envelope_db(x: np.ndarray) -> np.ndarray:
    fr = int(SR * FRAME_S)
    n = len(x) // fr
    rms = np.sqrt((x[: n * fr].reshape(n, fr) ** 2).mean(axis=1) + 1e-6)
    return 20 * np.log10(rms + 1e-6)


def silences(db: np.ndarray, min_s: float = 1.0) -> tuple:
    """-> (threshold_db, [(start_s, dur_s)]) with an adaptive threshold between the noise floor and speech."""
    floor, speech = np.percentile(db, 10), np.percentile(db, 90)
    thr = float(floor + 0.3 * (speech - floor))
    sil = db < thr
    out, i, n = [], 0, len(db)
    while i < n:
        if sil[i]:
            j = i
            while j < n and sil[j]:
                j += 1
            d = (j - i) * FRAME_S
            if d >= min_s:
                out.append((round(i * FRAME_S, 2), round(d, 2)))
            i = j
        else:
            i += 1
    return round(thr, 2), out


def _split_classes(durs: list) -> Optional[float]:
    """Threshold between two pause-length classes (largest gap in the sorted durations), None if not bimodal."""
    s = sorted(durs)
    if len(s) < 4:
        return None
    gaps = [(s[i + 1] - s[i], (s[i + 1] + s[i]) / 2) for i in range(len(s) - 1)]
    g, mid = max(gaps)
    return mid if g >= 1.0 else None


def _ratio_split(vals: list, min_ratio: float = 2.0) -> Optional[float]:
    """Threshold at the largest RATIO jump of the sorted values (gaps are scale-like: ~4 s question readings
    vs 30-60 s conversations); None unless the jump is at least `min_ratio`."""
    s = sorted(v for v in vals if v > 0.05)
    if len(s) < 4:
        return None
    best, thr = 0.0, None
    for a, b in zip(s, s[1:]):
        r = b / a
        if r > best:
            best, thr = r, (a * b) ** 0.5
    return thr if best >= min_ratio else None


def analyze_toeic(pauses: list, duration_s: float, fmt: str) -> dict:
    n1, n2, n3, n4 = TOEIC_ITEMS[fmt]
    cand = [(s, d) for s, d in pauses if d >= MIN_PAUSE_S]
    out = {"model": "TOEIC_ANSWER_PAUSES", "format": fmt, "pausesConsidered": len(cand), "checks": {},
           "boundaries": [], "segments": []}
    thr = _split_classes([d for _s, d in cand])
    if thr is None:
        out["checks"]["classes"] = "NOT_BIMODAL"
        return _unresolved(out, duration_s)
    tagged = []
    prev_end = None
    for s, d in cand:
        follow = prev_end is not None and s - prev_end < FOLLOW_ON_S
        tagged.append({"start": s, "dur": d, "cls": "LONG" if d >= thr else "SHORT", "followOn": follow})
        prev_end = s + d
    ans = [p for p in tagged if not p["followOn"]]
    short = [p for p in ans if p["cls"] == "SHORT"]
    long = [p for p in ans if p["cls"] == "LONG"]
    out["answerPauses"] = [[p["start"], p["dur"], p["cls"]] for p in ans]
    out["classes"] = {"thresholdS": round(thr, 2), "short": len(short), "long": len(long),
                      "followOn": sum(1 for p in tagged if p["followOn"]),
                      "shortMedianS": round(float(np.median([p["dur"] for p in short])), 2) if short else None,
                      "longMedianS": round(float(np.median([p["dur"] for p in long])), 2) if long else None}
    s1s = len(short) == n1 + n2
    s1l = len(long) == n3 + n4
    s1 = s1s and s1l
    s2 = bool(short) and bool(long) and max(p["start"] for p in short) < min(p["start"] for p in long)
    out["checks"].update({"S1_exactCounts": s1, "S1_shortExact": s1s, "S1_longExact": s1l, "S2_order": s2})
    # S3 triplets
    s3, sets = False, []
    if long:
        gaps = [long[i + 1]["start"] - (long[i]["start"] + long[i]["dur"]) for i in range(len(long) - 1)]
        tg = _ratio_split(gaps)
        if tg is not None:
            cur = [long[0]]
            for p, g in zip(long[1:], gaps):
                if g >= tg:
                    sets.append(cur)
                    cur = []
                cur.append(p)
            sets.append(cur)
            s3 = all(len(x) == 3 for x in sets) and len(sets) == (n3 + n4) // 3
    out["checks"]["S3_triplets"] = s3
    out["checks"]["setsFound"] = len(sets)
    # S4 directions gap after Part 1: exactly n1 short answer pauses precede the largest Parts 1-2 speech gap
    s4 = False
    if len(short) > n1:
        sgaps = [short[i + 1]["start"] - (short[i]["start"] + short[i]["dur"]) for i in range(len(short) - 1)]
        s4 = int(np.argmax(sgaps)) == n1 - 1
    out["checks"]["S4_part2DirectionsGap"] = s4
    # S5 Part 4 directions gap
    s5 = False
    if s3 and s1l:
        between = [sets[i + 1][0]["start"] - (sets[i][-1]["start"] + sets[i][-1]["dur"]) for i in range(len(sets) - 1)]
        k = n3 // 3 - 1
        s5 = between[k] >= float(np.median(between))
    out["checks"]["S5_part4DirectionsGap"] = s5

    def end_of(p) -> float:
        # a follow-on pause right after the part's last answer pause belongs to that part
        e = p["start"] + p["dur"]
        for q in tagged:
            if q["followOn"] and abs(q["start"] - e) < FOLLOW_ON_S and q["start"] > p["start"]:
                e = q["start"] + q["dur"]
        return round(e, 2)

    if not s2 or len(short) < n1 or len(long) < n3:
        out["boundaries"] = [{"between": b, "tier": AMBIGUOUS if cand else UNRESOLVED, "evidence": ["silence only"]}
                             for b in ("1|2", "2|3", "3|4")]
        return _segments(out, duration_s, None)
    # each boundary is judged on the signals that bear on it (an anomaly in Parts 3-4 does not move 1|2)
    b12 = end_of(short[n1 - 1])
    b23 = end_of(short[-1])
    b34 = end_of(long[n3 - 1])
    t12 = CONFIDENT if s4 else PROBABLE if s1s else AMBIGUOUS
    t23 = CONFIDENT if (s1s or (s1l and s3)) else PROBABLE
    t34 = CONFIDENT if (s1l and s3 and s5) else PROBABLE if (s1l and s3) else AMBIGUOUS
    ev = lambda *xs: [x for x in xs if x]
    out["boundaries"] = [
        {"between": "1|2", "atS": b12, "tier": t12,
         "evidence": ev("S2 short-before-long order", "S4 exactly n1 answer pauses before the Part 2 directions gap" if s4 else None,
                        "S1 short count exact" if s1s else None)},
        {"between": "2|3", "atS": b23, "tier": t23,
         "evidence": ev("S2 single pause-class switch short->long", "S1 short count exact" if s1s else None,
                        "S1 long count exact" if s1l else None, "S3 triplet sets" if s3 else None)},
        {"between": "3|4", "atS": b34, "tier": t34,
         "evidence": ev("S1 long count exact" if s1l else None, "S3 triplet sets" if s3 else None,
                        "S5 Part 4 directions gap" if s5 else None)},
    ]
    return _segments(out, duration_s, (b12, b23, b34))


TOEIC_LAST = {"TOEIC_LR_2016": (6, 31, 70, 100), "TOEIC_LR_PRE_2016": (10, 40, 70, 100)}


def apply_spoken_parts(out: dict, cues: list, duration_s: float, fmt: str) -> dict:
    """Upgrade / correct TOEIC part boundaries with spoken part announcements (S6) and spoken question numbers
    (S7). Only explicit announcements move a boundary; disagreement downgrades it."""
    ans = out.get("answerPauses") or []
    if not ans or fmt not in TOEIC_LAST:
        return out
    last_q = TOEIC_LAST[fmt]
    nums = sorted((c["atS"], c["n"]) for c in cues if c["kind"] == "NUMBER")
    bounds = {b["between"]: b for b in out.get("boundaries", [])}
    cuts = {}
    for n, key, cls in ((2, "1|2", "SHORT"), (3, "2|3", "SHORT"), (4, "3|4", "LONG")):
        times = sorted({c["atS"] for c in cues if c["kind"] == "PART" and c.get("n") == n and c.get("pos", 99) <= 2})
        old = bounds.get(key) or {"between": key, "tier": UNRESOLVED, "evidence": []}
        if len(times) != 1:
            if times:
                old = dict(old, tier=AMBIGUOUS, evidence=old.get("evidence", []) + [f"S6 'Part {n}' announced {len(times)} times"])
            cuts[key] = old
            continue
        w = times[0]
        prev = [p for p in ans if p[0] < w]
        gap = w - (prev[-1][0] + prev[-1][1]) if prev else None
        before = [q for t, q in nums if t < w]
        s7 = bool(before) and before[-1] == last_q[n - 2]
        same = old.get("atS") is not None and abs(old["atS"] - w) <= 0.5
        # the announcement opens right after the last answer pause of part n-1 (or after its follow-on pause,
        # which then must be confirmed by S7: nothing but that pause lies between)
        ok_pause = bool(prev) and prev[-1][2] == cls and (gap <= FOLLOW_ON_S + 0.5 or (s7 and gap <= 12.0))
        ev = [f"S6 spoken 'Part {n}' announcement after a {cls.lower()} answer pause" if ok_pause else None,
              f"S7 last spoken question number before it = {last_q[n - 2]}" if s7 else None,
              "pause-structure boundary at the same instant" if same else None]
        ev = [e for e in ev if e]
        if ok_pause and (s7 or same):
            cuts[key] = {"between": key, "atS": round(w, 2), "tier": CONFIDENT, "evidence": ev}
        elif old.get("tier") == CONFIDENT and not same:
            cuts[key] = dict(old, tier=AMBIGUOUS, evidence=old.get("evidence", []) + ["conflicts with a spoken part announcement"])
        else:
            cuts[key] = old
    out["boundaries"] = [cuts[k] for k in ("1|2", "2|3", "3|4")]
    return _segments(out, duration_s, tuple(cuts[k].get("atS") for k in ("1|2", "2|3", "3|4")))


def _unresolved(out: dict, duration_s: float) -> dict:
    out["boundaries"] = [{"between": b, "tier": UNRESOLVED, "evidence": []} for b in ("1|2", "2|3", "3|4")]
    return _segments(out, duration_s, None)


def apply_ordered_spoken_parts(out: dict, cues: list, pauses: list, duration_s: float, fmt: str) -> dict:
    """Unlocated boundaries: own part/adjacent ordinals plus an acoustic window prove a cut.

    No cut comes from expected time or pause count. An absent/conflicting spoken
    ordinal or announcement leaves its boundary unresolved.
    """
    non_bimodal = not out.get('answerPauses') and out.get('checks',{}).get('classes')=='NOT_BIMODAL'
    failed_classes = out.get('checks',{}).get('S2_order') is False
    if (not non_bimodal and not failed_classes) or fmt not in TOEIC_LAST:
        return out
    from .asr_cues import window_plan, DENSE_SPAN_S
    from .toeic import part_numbers
    plan=window_plan(pauses,duration_s)
    numbers=sorted((c['atS'],c['n']) for c in cues if c.get('kind')=='NUMBER' and 1<=c.get('n',0)<=100)
    next_items=sorted((c['atS'],c['n'] if c['kind']=='NUMBER' else c['a']) for c in cues
                      if c.get('kind') in ('NUMBER','SET'))
    bounds={b['between']:b for b in out.get('boundaries',[])}
    for n,key in ((2,'1|2'),(3,'2|3'),(4,'3|4')):
        old=bounds.get(key,{'between':key,'tier':UNRESOLVED,'evidence':[]})
        announcements=[c for c in cues if c.get('kind')=='PART' and c.get('n')==n and c.get('pos',99)<=2]
        anchors={c['atS'] for c in announcements}
        unlocated = old.get('atS') is None and (old.get('tier')==UNRESOLVED or
            (failed_classes and old.get('tier')==AMBIGUOUS and old.get('evidence')==['silence only']))
        if len(anchors)!=1 or not unlocated:
            continue
        at=next(iter(anchors));starts={c.get('windowStartS') for c in announcements}
        if len(starts)!=1 or None in starts:continue
        start=next(iter(starts))
        if not any(abs(anchor-at)<=.011 and abs(begin-start)<=.011 for anchor,begin in plan):continue
        before=[(t,q) for t,q in numbers if t<at]
        after=[(t,q) for t,q in next_items if t>at]
        if not before or not after:continue
        last_time=before[-1][0];first_time=after[0][0]
        last={q for t,q in before if t==last_time};first={q for t,q in after if t==first_time}
        expected_last=part_numbers(n-1,fmt)[-1];expected_first=part_numbers(n,fmt)[0]
        if (last!={expected_last} or first!={expected_first}
                or at-last_time>DENSE_SPAN_S or first_time-at>DENSE_SPAN_S):continue
        bounds[key]={'between':key,'atS':round(start,2),'tier':CONFIDENT,'evidence':[
            f"S6 unique spoken Part {n} at its measured silence window",
            f"S7 preceding spoken question number {expected_last}",
            f"S8 following spoken question or set starts at {expected_first}"]}
    out['boundaries']=[bounds.get(k,{'between':k,'tier':UNRESOLVED,'evidence':[]}) for k in ('1|2','2|3','3|4')]
    result=_segments(out,duration_s,tuple(b.get('atS') for b in out['boundaries']))
    for segment in result['segments']:
        if segment.get('tier')==CONFIDENT:segment['method']='TOEIC_SPOKEN_PART_ORDINAL_CLOSURE_V1'
    return result


def _segments(out: dict, duration_s: float, cuts: Optional[tuple]) -> dict:
    tiers = {b["between"]: b["tier"] for b in out["boundaries"]}
    if cuts is None:
        out["segments"] = [{"part": p, "tier": UNRESOLVED} for p in (1, 2, 3, 4)]
        return out
    edges = [0.0, *cuts, round(duration_s, 2)]
    known = [edge for edge in edges if edge is not None]
    if any(right <= left for left, right in zip(known, known[1:])):
        out["segments"] = [{"part": p, "tier": UNRESOLVED} for p in (1, 2, 3, 4)]
        return out
    names = [None, "1|2", "2|3", "3|4", None]
    segs = []
    for i, part in enumerate((1, 2, 3, 4)):
        if edges[i] is None or edges[i + 1] is None:
            segs.append({"part": part, "tier": UNRESOLVED})
            continue
        left, right = names[i], names[i + 1]
        lt = CONFIDENT if left is None else tiers[left]
        rt = CONFIDENT if right is None else tiers[right]
        order = {CONFIDENT: 3, PROBABLE: 2, AMBIGUOUS: 1, UNRESOLVED: 0}
        tier = min((lt, rt), key=lambda t: order[t])
        segs.append({"part": part, "startMs": int(round(edges[i] * 1000)), "endMs": int(round(edges[i + 1] * 1000)),
                     "tier": tier, "method": "TOEIC_ANSWER_PAUSE_STRUCTURE_V1"})
    out["segments"] = segs
    return out


def apply_spoken_ielts_parts(out: dict, cues: list, pauses: list, duration_s: float) -> dict:
    """IELTS: a part boundary is accepted only where a spoken 'Part n' announcement opens the first window after
    a long silence (the check-your-answers time, >= 15 s), each of parts 2-4 is announced exactly there once, in
    order. Otherwise the long silences stay AMBIGUOUS candidates."""
    long_ends = [round(s + d, 2) for s, d in pauses if d >= 15.0]
    cuts = []
    for n in (2, 3, 4):
        at = sorted({c.get("windowStartS", c["atS"]) for c in cues if c["kind"] == "PART" and c.get("n") == n
                     and c.get("pos", 99) <= 3 and any(abs(c["atS"] - e) <= 0.11 for e in long_ends)})
        if len(at) != 1:
            return out
        cuts.append(at[0])     # the window start: still inside the >= 15 s silence, before the announcement
    if cuts != sorted(cuts):
        return out
    out["model"] = "IELTS_SPOKEN_PART_ANNOUNCEMENTS"
    out["boundaries"] = [{"between": f"{n - 1}|{n}", "atS": c, "tier": CONFIDENT,
                          "evidence": [f"S6 spoken 'Part {n}' announcement opens the speech after a >= 15 s silence"]}
                         for n, c in zip((2, 3, 4), cuts)]
    edges = [0.0, *cuts, round(duration_s, 2)]
    out["segments"] = [{"part": p, "startMs": int(round(edges[p - 1] * 1000)), "endMs": int(round(edges[p] * 1000)),
                        "tier": CONFIDENT, "method": "IELTS_SPOKEN_PART_ANNOUNCEMENT_V1"} for p in (1, 2, 3, 4)]
    return out


def analyze_ielts(pauses: list, duration_s: float) -> dict:
    long = [(s, d) for s, d in pauses if d >= 15.0]
    return {"model": "IELTS_LONG_SILENCES", "pausesConsidered": len(long),
            "candidates": [{"atS": round(s, 2), "durS": d, "tier": AMBIGUOUS,
                            "evidence": ["silence >= 15 s only; spoken question spans not machine-detectable locally"]}
                           for s, d in long],
            "boundaries": [{"between": b, "tier": AMBIGUOUS if long else UNRESOLVED, "evidence": ["silence only"]}
                           for b in ("1|2", "2|3", "3|4")],
            "segments": [{"part": p, "tier": AMBIGUOUS if long else UNRESOLVED} for p in (1, 2, 3, 4)]}


def analyze_recording(staging_root: Path, source: str, sha256: str, family: str, fmt: Optional[str],
                      member: Optional[str] = None, force: bool = False, asr: bool = True) -> dict:
    """Analyse one raw whole-test recording (cached by parent hash + analysis version). With asr=True the local
    recogniser reads the spoken structure cues (asr_cues.py) used as S6/S7 and by the Part 3/4 set rule."""
    out_dir = staging_root / "audio_segments"
    path = out_dir / f"{sha256}.json"
    if path.exists() and not force:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("analysisVersion") == ANALYSIS_VERSION and data.get("parentSha256") == sha256:
            return data
    x = decode(source, member)
    dur = len(x) / SR
    db = envelope_db(x)
    thr, pauses = silences(db, 1.0)
    data = {"analysisVersion": ANALYSIS_VERSION, "parentPath": raw_rel(source) + (f"::{member}" if member else ""),
            "parentSha256": sha256, "family": family, "format": fmt, "durationS": round(dur, 2),
            "decoder": {"tool": "ffmpeg", "sampleRate": SR, "frameS": FRAME_S},
            "silenceThresholdDb": thr, "silencesOver1s": len(pauses),
            "pauseHistogram": _hist([d for _s, d in pauses])}
    cues = None
    if asr:
        from .asr_cues import scan_cues
        cues = scan_cues(staging_root, source, sha256, pauses, dur, member, force)
        data["asrCues"] = {"available": cues.get("available", False), "reason": cues.get("reason"),
                           "count": len(cues.get("cues", [])), "cache": f"cache/asr_cues/{sha256}.json"}
    if family == "TOEIC" and fmt in TOEIC_ITEMS:
        data.update(analyze_toeic(pauses, dur, fmt))
        if cues and cues.get("available"):
            data.update(apply_spoken_parts(data, cues["cues"], dur, fmt))
            data.update(apply_ordered_spoken_parts(data,cues['cues'],pauses,dur,fmt))
    else:
        data.update(analyze_ielts(pauses, dur))
        if cues and cues.get("available"):
            data.update(apply_spoken_ielts_parts(data, cues["cues"], pauses, dur))
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)
    return data


def _hist(durs: list) -> dict:
    edges = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 40, 100000]
    h = {}
    for a, b in zip(edges, edges[1:]):
        h[f"{a}-{b if b < 1000 else 'inf'}s"] = sum(1 for d in durs if a <= d < b)
    return h


def render_confident(staging_root: Path, data: dict, member: Optional[str] = None) -> int:
    """Physically render CONFIDENT segments (stream copy, raw untouched) to content-addressed staging files."""
    ff = ffmpeg_path()
    if ff is None:
        return 0
    n = 0
    src_path = data["parentPath"].split("::")[0]
    full = raw_abs(src_path)
    out_dir = staging_root / "assets" / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    for seg in data.get("segments", []):
        if seg.get("tier") != CONFIDENT or seg.get("derived"):
            continue
        tmp = out_dir / f"tmp_{data['parentSha256'][:12]}_{seg['part']}.mp3"
        ss, to = seg["startMs"] / 1000, seg["endMs"] / 1000
        if member:
            with zipfile.ZipFile(full) as z:
                blob = z.read(member)
            subprocess.run([ff, "-v", "error", "-y", "-i", "pipe:0", "-ss", f"{ss:.3f}", "-to", f"{to:.3f}",
                            "-c", "copy", "-f", "mp3", str(tmp)], input=blob, check=True)
        else:
            subprocess.run([ff, "-v", "error", "-y", "-i", str(full), "-ss", f"{ss:.3f}", "-to", f"{to:.3f}",
                            "-c", "copy", str(tmp)], check=True)
        blob = tmp.read_bytes()
        sha = hashlib.sha256(blob).hexdigest()
        final = out_dir / f"{sha}.mp3"
        if final.exists():
            tmp.unlink()
        else:
            os.replace(tmp, final)
        dur = _probe(final)
        seg["derived"] = {"stagedPath": f"imports/exams/staging/assets/audio/{sha}.mp3", "sha256": sha,
                          "byteSize": len(blob), "durationMs": int(round(dur * 1000)) if dur else None,
                          "objectKey": f"extracted/audio/{sha}.mp3"}
        n += 1
    if n:
        path = staging_root / "audio_segments" / f"{data['parentSha256']}.json"
        path.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
    return n


def _probe(path: Path) -> Optional[float]:
    try:
        import mutagen  # type: ignore
        f = mutagen.File(str(path))
        return float(f.info.length) if f is not None else None
    except Exception:
        return None


def confident_part_segments(staging_root: Path, parent_sha: str, fmt: Optional[str]) -> dict:
    """{part: AudioBinding} for CONFIDENT, physically rendered and re-verified segments of a parent recording."""
    path = staging_root / "audio_segments" / f"{parent_sha}.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("parentSha256") != parent_sha or data.get("format") != fmt:
        return {}
    out = {}
    for seg in data.get("segments", []):
        d = seg.get("derived")
        if seg.get("tier") != CONFIDENT or not d:
            continue
        staged = staging_root.parents[2] / d["stagedPath"]
        if not staged.exists():
            continue
        blob = staged.read_bytes()
        sha = hashlib.sha256(blob).hexdigest()
        dur = _probe(staged)
        expected = (seg["endMs"] - seg["startMs"]) / 1000
        qa = {"hashVerified": sha == d["sha256"], "decodable": bool(dur), "durationAgrees": bool(dur and abs(dur - expected) <= 0.5),
              "mappingConfidence": CONFIDENT, "segment": {"startMs": seg["startMs"], "endMs": seg["endMs"],
                                                          "method": seg["method"]}}
        b = AudioBinding(path=data["parentPath"], sha256=sha, duration_ms=int(round((dur or expected) * 1000)),
                         byte_size=len(blob), mime="audio/mpeg", scope="PART", section=None, part=seg["part"],
                         confidence=CONFIDENT, rule="AUDIO_SEGMENT_V1", technical_qa=qa)
        b.derived = {"parentPath": data["parentPath"], "parentSha256": parent_sha, "startMs": seg["startMs"],
                     "endMs": seg["endMs"], "stagedPath": d["stagedPath"], "method": seg["method"],
                     "evidence": [x for bd in data.get("boundaries", []) for x in bd.get("evidence", [])][:8]}
        out[seg["part"]] = b
    return out
