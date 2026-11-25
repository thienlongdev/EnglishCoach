"""Lexical stress feedback from aligned vowel nuclei. Scores are word counts, not examiner bands.

Upgraded Multi-Cue Stress Engine:
- 46 ms YIN-CMND F0 extraction with median octave filter and declination detrending.
- Spectral tilt (>500 Hz / <500 Hz) + intrinsic- & speaking-rate-normalized vowel duration + intrinsic-dB energy.
- Per-word fault tolerance: digits, hyphens, punctuation, or an OOV word are skipped individually,
  NEVER aborting stress scoring for the rest of the utterance.
- UK/US multi-accent accepted stress variants (`UK_ACCEPTED_STRESS`).
- Integer frame indexing (`int(round(...))`) eliminating float truncation errors (PP-12).
- Calibrated conservative margin threshold from `echo_speaking_v3_calibrator.json` (cutting Native FPR <= 5%).
"""
from __future__ import annotations

from collections import namedtuple
from functools import lru_cache
import logging
import math
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

from app.services.audio_ingestion import decode_browser_audio
from app.services.pronunciation.hybrid_engine import (
    INTRINSIC_VOWEL_DB,
    INTRINSIC_VOWEL_DUR,
    UK_ACCEPTED_STRESS,
    VOWELS,
    extract_f0_yin_46ms,
    load_calibrator,
    strip_stress,
)

log = logging.getLogger(__name__)
METHOD = "ALIGNED_VOWEL_PROMINENCE_V1"
ALGORITHM = "NEURAL_CTC_MULTICUE_V2"
PhoneSpan = namedtuple("PhoneSpan", ("name", "start", "duration"))


@lru_cache(maxsize=1)
def stress_dictionary() -> Dict[str, List[List[str]]]:
    pronunciations: Dict[str, List[List[str]]] = {}
    source = Path(__file__).parent / "data" / "cmudict-0.7b.txt"
    with source.open(encoding="latin1") as entries:
        for line in entries:
            if line.startswith(";;;"):
                continue
            fields = line.split()
            if len(fields) < 2:
                continue
            word = re.sub(r"\(\d+\)$", "", fields[0]).lower()
            pronunciations.setdefault(word, []).append(fields[1:])
    return pronunciations


def _calibrated_margin_threshold() -> float:
    calib = load_calibrator()
    return float(calib.get("lexical_stress", {}).get("err_margin_threshold", 0.4078))


def _resolve_expected_stress_indices(
    word: str,
    actual_phones: Sequence[str],
    accept_uk: bool = True,
) -> Tuple[Set[int], List[int]]:
    """Return `(expected_primary_0based_set, vowel_phone_indices)` for a word."""
    clean_w = re.sub(r"[^a-z']", "", str(word).lower()).strip("'")
    variants = stress_dictionary().get(clean_w, ())
    primary: Set[int] = set()
    nuclei: List[int] = []

    actual_upper = [strip_stress(p) for p in actual_phones]
    for variant in variants:
        if [strip_stress(p) for p in variant] != actual_upper:
            continue
        v_pos = [i for i, p in enumerate(variant) if p[-1:] in ("0", "1", "2")]
        if not nuclei:
            nuclei = v_pos
        if len(v_pos) != len(nuclei):
            continue
        accents = [j for j, i in enumerate(v_pos) if variant[i].endswith("1")]
        for acc_idx in accents:
            primary.add(acc_idx)

    # Fallback: if phone sequence length/pronunciation differs slightly from CMUdict primary
    # (e.g. neural alignment with reduced vowel), still accept vowel positions if count matches a variant
    if not nuclei:
        actual_v_pos = [i for i, p in enumerate(actual_upper) if p in VOWELS]
        for variant in variants:
            v_pos = [i for i, p in enumerate(variant) if p[-1:] in ("0", "1", "2")]
            if len(v_pos) == len(actual_v_pos) and len(v_pos) >= 2:
                nuclei = actual_v_pos
                for j, i in enumerate(v_pos):
                    if variant[i].endswith("1"):
                        primary.add(j)

    if accept_uk and clean_w in UK_ACCEPTED_STRESS and len(nuclei) >= 2:
        for s1 in UK_ACCEPTED_STRESS[clean_w]:
            if 1 <= s1 <= len(nuclei):
                primary.add(s1 - 1)

    return primary, nuclei


def word_evidence(
    word: str,
    phones: Sequence[PhoneSpan],
    pitch: Sequence[Optional[float]],
    energy: Sequence[float],
    *,
    spectral_tilt: Optional[Sequence[float]] = None,
    median_vowel_frames: Optional[float] = None,
    err_margin_threshold: Optional[float] = None,
    accept_uk: bool = True,
) -> Optional[Dict[str, Any]]:
    """Compute multi-cue lexical stress evidence on one word's aligned phone spans.

    Uses integer frame indexing (`int(round(...))`), declination-detrended F0,
    intrinsic- & speaking-rate-normalized vowel duration, intrinsic-dB energy,
    optional spectral tilt (>500 Hz / <500 Hz), UK/US multi-accent variants,
    and calibrated conservative error-margin threshold.
    """
    actual = [strip_stress(p.name) for p in phones]
    expected_set, nuclei = _resolve_expected_stress_indices(word, actual, accept_uk=accept_uk)
    if not expected_set or len(nuclei) < 2:
        return None

    # Validate spans and gather median vowel duration if caller did not supply utterance-level median
    vowel_durs = []
    for phone_index in nuclei:
        ph = phones[phone_index]
        start = max(0, int(round(ph.start)))
        dur = int(round(ph.duration))
        end = start + dur
        if dur < 2 or end > len(energy) or end > len(pitch):
            return None
        if not any(v is not None for v in pitch[start:end]):
            return None
        vowel_durs.append(float(dur))

    med_vf = float(median_vowel_frames) if (median_vowel_frames and median_vowel_frames > 0) else float(np.median(vowel_durs))
    energy_arr = np.asarray(energy, dtype=np.float64)
    p95_e = float(np.percentile(energy_arr, 95)) if energy_arr.size >= 5 else float(np.max(energy_arr) + 1e-6)
    p95_e = max(p95_e, 1e-6)

    cues: List[float] = []
    for phone_index in nuclei:
        ph = phones[phone_index]
        v_base = strip_stress(ph.name)
        start = max(0, int(round(ph.start)))
        dur = max(1, int(round(ph.duration)))
        end = min(len(energy), start + dur)

        # 1. Intrinsic & speaking-rate normalized vowel duration
        exp_f = med_vf * INTRINSIC_VOWEL_DUR.get(v_base, 1.0)
        dur_c = float(np.clip(math.log2(max(0.5, float(dur)) / max(0.5, exp_f)), -1.5, 1.5)) / 1.5

        # 2. Declination-detrended F0 prominence (75th percentile of voiced semitones)
        voiced_st = [float(v) for v in pitch[start:end] if v is not None]
        if not voiced_st:
            return None
        f0_c = float(np.clip(np.percentile(voiced_st, 75), -6.0, 6.0)) / 6.0

        # 3. Intrinsic-dB normalized energy
        mean_e = float(np.mean(energy_arr[start:end]))
        e_db = 20.0 * math.log10((mean_e + 1e-6) / p95_e) - INTRINSIC_VOWEL_DB.get(v_base, 0.0)
        e_c = float(np.clip((e_db + 24.0) / 24.0, 0.0, 1.0))

        # 4. Spectral tilt (>500 Hz / <500 Hz) when extracted from audio
        if spectral_tilt is not None and end <= len(spectral_tilt):
            mean_tilt = float(np.mean(spectral_tilt[start:end]))
            t_c = float(np.clip((mean_tilt + 15.0) / 20.0, 0.0, 1.0))
            prom = 0.35 * dur_c + 0.25 * e_c + 0.15 * t_c + 0.25 * f0_c
        else:
            prom = 0.35 * dur_c + 0.30 * e_c + 0.35 * f0_c
        cues.append(prom)

    if len(cues) < 2:
        return None

    observed = int(np.argmax(cues))
    valid_exp = sorted(e for e in expected_set if 0 <= e < len(cues))
    if not valid_exp:
        return None

    best_exp = max(cues[e] for e in valid_exp)
    non_exp_vals = [cues[k] for k in range(len(cues)) if k not in expected_set]
    if not non_exp_vals:
        # All syllables are accepted (e.g., 2-syllable word accepting both US & UK stress like 'garage')
        return {
            "word": word,
            "expectedSyllable": valid_exp[0] + 1,
            "expectedSyllables": [e + 1 for e in valid_exp],
            "observedSyllable": observed + 1,
            "syllables": len(nuclei),
            "matched": True,
            "errorMargin": 0.0,
        }

    best_nonexp = max(non_exp_vals)
    err_margin = float(best_nonexp - best_exp)
    thr = float(err_margin_threshold) if err_margin_threshold is not None else _calibrated_margin_threshold()

    # Nearly indistinguishable flat tie -> abstain; otherwise preserve valid stress evidence
    strengths = sorted(cues, reverse=True)
    if strengths[0] - strengths[1] < 0.03 and err_margin < thr:
        return None

    matched = (observed in expected_set) or (err_margin < thr)
    return {
        "word": word,
        "expectedSyllable": valid_exp[0] + 1,
        "expectedSyllables": [e + 1 for e in valid_exp],
        "observedSyllable": observed + 1,
        "syllables": len(nuclei),
        "matched": matched,
        "errorMargin": round(err_margin, 4),
    }


def _extract_stress_acoustics(wav: np.ndarray, sr: int = 16000) -> Tuple[List[Optional[float]], np.ndarray, np.ndarray]:
    """Extract 10ms-hop 46ms YIN declination-detrended F0, RMS energy, and spectral tilt (>500Hz/<500Hz)."""
    bundle = extract_f0_yin_46ms(wav, sr=sr, hop_ms=10.0)
    voicing = bundle["voicing"]
    st_det = bundle["st_det"]
    pitch_opt: List[Optional[float]] = [float(st_det[i]) if voicing[i] else None for i in range(len(st_det))]
    rms = bundle["rms"]
    tilt = bundle["tilt"]
    return pitch_opt, rms, tilt


def _evidence_from_result_timestamps(
    wav: np.ndarray,
    words: Sequence[Dict[str, Any]],
    *,
    accept_uk: bool = True,
) -> List[Dict[str, Any]]:
    """Per-word fault-tolerant stress scoring directly from neural phone timestamps (10ms frame grid)."""
    pitch_opt, rms, tilt = _extract_stress_acoustics(wav, sr=16000)
    thr = _calibrated_margin_threshold()

    # Collect utterance-level median vowel duration (in 10ms frames) for speaking-rate normalization
    word_spans_list: List[Tuple[str, List[PhoneSpan]]] = []
    all_v_frames: List[float] = []

    for w in words:
        if w.get("status") not in ("GOOD", "NEEDS_WORK"):
            continue
        raw_word = str(w.get("word", "")).strip()
        phones_in = w.get("phones") or []
        if not raw_word or not phones_in:
            continue

        # Handle hyphenated words cleanly by skipping only if non-alphabetic; never abort utterance
        clean_token = re.sub(r"[^a-zA-Z']", "", raw_word).lower().strip("'")
        if not clean_token:
            continue

        spans: List[PhoneSpan] = []
        valid_word = True
        for p in phones_in:
            ep = strip_stress(p.get("expectedPhone") or p.get("expected_phone") or "")
            st_ms = p.get("startTimeMs") if p.get("startTimeMs") is not None else p.get("start_time_ms")
            en_ms = p.get("endTimeMs") if p.get("endTimeMs") is not None else p.get("end_time_ms")
            if not ep or st_ms is None or en_ms is None or float(en_ms) <= float(st_ms):
                valid_word = False
                break
            st_f = max(0, int(round(float(st_ms) / 10.0)))
            en_f = max(st_f + 1, int(round(float(en_ms) / 10.0)))
            dur_f = en_f - st_f
            spans.append(PhoneSpan(ep, st_f, dur_f))
            if ep in VOWELS:
                all_v_frames.append(float(dur_f))

        if valid_word and spans:
            word_spans_list.append((clean_token, spans))

    if not word_spans_list:
        return []

    med_vf = float(np.median(all_v_frames)) if all_v_frames else 8.0
    evidence: List[Dict[str, Any]] = []
    for token, spans in word_spans_list:
        try:
            measured = word_evidence(
                token,
                spans,
                pitch_opt,
                rms,
                spectral_tilt=tilt,
                median_vowel_frames=med_vf,
                err_margin_threshold=thr,
                accept_uk=accept_uk,
            )
            if measured:
                evidence.append(measured)
        except Exception:
            # Per-word fault tolerance: one word failure never aborts the utterance
            continue
    return evidence


def aligned_evidence(wav: np.ndarray, words: Sequence[Dict[str, Any]], text: str = "") -> List[Dict[str, Any]]:
    """Compute multi-cue lexical stress evidence using neural timestamps if available,
    falling back to per-word fault-tolerant PocketSphinx forced alignment."""
    # 1. Prefer neural phone timestamps already attached to words (zero PocketSphinx dependency!)
    has_phone_times = any(
        isinstance(p, dict)
        and (p.get("startTimeMs") is not None or p.get("start_time_ms") is not None)
        for w in words
        for p in (w.get("phones") or [])
    )
    if has_phone_times:
        return _evidence_from_result_timestamps(wav, words, accept_uk=True)

    # 2. Fallback: PocketSphinx alignment on valid alphabetic tokens (per-word fault tolerant!)
    from pocketsphinx import Decoder

    # Split hyphenated tokens and strip non-alpha tokens individually instead of aborting the whole utterance
    clean_pairs: List[Tuple[str, Dict[str, Any]]] = []
    lex = stress_dictionary()
    for w in words:
        raw_w = str(w.get("word", "")).strip().lower()
        for part in re.split(r"[\-\s]+", raw_w):
            tok = re.sub(r"[^a-z']", "", part).strip("'")
            if tok and tok in lex:
                clean_pairs.append((tok, w))

    if not clean_pairs:
        return []

    align_text = " ".join(tok for tok, _ in clean_pairs)
    decoder = Decoder(lm=None, samprate=16000, loglevel="ERROR")
    decoder.set_align_text(align_text)
    pcm = (np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes()
    for second_pass in (False, True):
        if second_pass:
            decoder.set_alignment()
        decoder.start_utt()
        decoder.process_raw(pcm, False, True)
        decoder.end_utt()

    alignment: List[Tuple[str, List[PhoneSpan]]] = []
    for word_seg in decoder.get_alignment():
        if word_seg.name.startswith(("<", "[")):
            continue
        token = word_seg.name.partition("(")[0].lower()
        phones = [PhoneSpan(phone.name, int(round(phone.start)), int(round(phone.duration))) for phone in word_seg]
        alignment.append((token, phones))

    if not alignment:
        return []

    pitch_opt, rms, tilt = _extract_stress_acoustics(wav, sr=16000)
    thr = _calibrated_margin_threshold()

    # Match aligned tokens greedily to clean_pairs so 1 dropped/OOV word never aborts the rest
    all_v_f = [
        float(ph.duration)
        for _tok, phs in alignment
        for ph in phs
        if strip_stress(ph.name) in VOWELS and ph.duration >= 2
    ]
    med_vf = float(np.median(all_v_f)) if all_v_f else 8.0

    evidence: List[Dict[str, Any]] = []
    pair_idx = 0
    for token, phones in alignment:
        matched_word_obj = None
        for scan in range(pair_idx, min(len(clean_pairs), pair_idx + 4)):
            if clean_pairs[scan][0] == token:
                matched_word_obj = clean_pairs[scan][1]
                pair_idx = scan + 1
                break
        if matched_word_obj is None:
            continue
        if matched_word_obj.get("status") not in ("GOOD", "NEEDS_WORK"):
            continue
        try:
            measured = word_evidence(
                token,
                phones,
                pitch_opt,
                rms,
                spectral_tilt=tilt,
                median_vowel_frames=med_vf,
                err_margin_threshold=thr,
                accept_uk=True,
            )
            if measured:
                evidence.append(measured)
        except Exception:
            continue
    return evidence


def apply_lexical_stress(result, raw, filename, content_type):
    """Erase legacy constants before any guard. Retain only calibrated multi-cue acoustic evidence."""
    overall = result.get("overall")
    if not isinstance(overall, dict):
        return result
    if "overall_score" in result:
        result["overall_score"] = overall
    overall.pop("confidence", None)
    overall["stress_score"] = overall["stressScore"] = None
    summary = {
        "method": METHOD,
        "algorithm": ALGORITHM,
        "status": "INSUFFICIENT_EVIDENCE",
        "assessed": 0,
        "matched": 0,
        "words": [],
    }
    result["lexicalStress"] = summary
    words = result.get("words") or []
    if result.get("status") != "COMPLETED" or not words:
        return result
    if not any(w.get("status") in ("GOOD", "NEEDS_WORK") for w in words):
        result["status"] = result["pipeline_status"] = "ABSTAINED"
        for field in list(overall):
            if field.endswith(("Score", "_score")):
                overall[field] = None
        return result
    try:
        audio = decode_browser_audio(raw, content_type=content_type, filename=filename, max_duration_seconds=90)
        if audio.sample_rate != 16000 or audio.duration_seconds > 90:
            return result
        tokens = [str(w.get("word", "")).lower() for w in words]
        evidence = aligned_evidence(audio.waveform.reshape(-1), words, " ".join(tokens))
    except (ValueError, RuntimeError, OSError, ImportError) as exc:
        log.warning("Lexical stress unavailable (%s)", type(exc).__name__)
        return result
    if evidence:
        matched = sum(1 for w in evidence if w["matched"])
        summary.update(status="ASSESSED", assessed=len(evidence), matched=matched, words=evidence)
        overall["stress_score"] = overall["stressScore"] = int(round(100.0 * matched / len(evidence)))
    return result
