"""Research-only reliability utilities for SHD-2B.2B.

Nothing in this module activates learner-facing pronunciation scores.  It is
kept separate from the online workflow so experiments remain reproducible and
cannot silently become production policy.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from app.services.pronunciation.calibration_research import ARPABET_TO_IPA


RELIABILITY_SCHEMA = "shd-2b.2b-research-v1"
RELIABILITY_SEED = 20260830
BOOTSTRAP_SAMPLE_LEVELS = (25, 50, 100, 250, 500, 750, 1000, 2000)
EXCLUSION_REASONS = (
    "phone inventory mismatch",
    "stress-marker mismatch",
    "vowel-length mismatch",
    "affricate representation",
    "rhotic representation",
    "insertion",
    "deletion",
    "many-to-one alignment",
    "one-to-many alignment",
    "lexical pronunciation variant",
    "unsupported token",
    "other explicit category",
)


@dataclass(frozen=True)
class MappingRule:
    rule_id: str
    source: str
    target: str
    category: str
    provenance: str
    explanation: str
    recovered_in: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _baseline_rules() -> Tuple[MappingRule, ...]:
    rules: List[MappingRule] = []
    for source, targets in sorted(ARPABET_TO_IPA.items()):
        for target in sorted(targets):
            rules.append(MappingRule(
                rule_id=f"cmu-espeak-{source.lower()}-{target.encode('unicode_escape').decode('ascii')}",
                source=source,
                target=target,
                category="accepted SHD-2B.2A equivalence",
                provenance="SHD-2B.2A ARPABET_TO_IPA registry",
                explanation="Accepted one-to-one CMU ARPABET to eSpeak IPA phone equivalence.",
            ))
    return tuple(rules)


BASELINE_MAPPING_RULES = _baseline_rules()
RECOVERED_MAPPING_RULES = (
    MappingRule(
        rule_id="speechocean-ih0-espeak-reduced-i",
        source="IH0",
        target="ᵻ",
        category="stress-marker mismatch",
        provenance="SpeechOcean762 uses CMU IH0; eSpeak emits the IPA reduced close central vowel U+1D7B",
        explanation="Recover only unstressed IH0 as eSpeak's reduced vowel; stressed IH remains distinct.",
        recovered_in="SHD-2B.2B",
    ),
)


def normalize_arpabet(phone: str) -> str:
    return phone.strip().upper().rstrip("012")


def mapping_rule(source: str, target: str, repaired: bool = True) -> Optional[MappingRule]:
    candidates = BASELINE_MAPPING_RULES + (RECOVERED_MAPPING_RULES if repaired else ())
    source_upper = source.strip().upper()
    source_base = normalize_arpabet(source)
    for rule in candidates:
        if rule.target != target:
            continue
        if rule.recovered_in:
            if rule.source == source_upper:
                return rule
        elif rule.source == source_base:
            return rule
    return None


def _known_engine_inventory() -> set[str]:
    inventory = set()
    for rule in BASELINE_MAPPING_RULES + RECOVERED_MAPPING_RULES:
        inventory.add(rule.target)
    inventory.update({"̩", "ɑːɹ", "ɔːɹ", "aɪɚ", "ɪuː", "ɐ", "ᵻ", "ɾ", "ʔ"})
    return inventory


ENGINE_INVENTORY = _known_engine_inventory()


def _reason_for_substitution(source: str, target: str) -> str:
    base = normalize_arpabet(source)
    if base not in ARPABET_TO_IPA:
        return "unsupported token"
    if target not in ENGINE_INVENTORY:
        return "unsupported token"
    if base in {"CH", "JH"} or target in {"tʃ", "dʒ", "t", "d", "ʃ", "ʒ"}:
        return "affricate representation"
    if base in {"R", "ER"} or any(mark in target for mark in ("r", "ɹ", "ɚ", "ɝ")):
        return "rhotic representation"
    without_length = target.replace("ː", "")
    if any(candidate.replace("ː", "") == without_length for candidate in ARPABET_TO_IPA[base]):
        return "vowel-length mismatch"
    if re.search(r"[012]$", source) and target in ARPABET_TO_IPA[base]:
        return "stress-marker mismatch"
    if target in ENGINE_INVENTORY:
        return "phone inventory mismatch"
    return "other explicit category"


def _composite_reason(source: Sequence[str], target: Sequence[str]) -> Optional[str]:
    if len(source) >= 2 and len(target) == 1:
        joined = target[0]
        if normalize_arpabet(source[-1]) in {"R", "ER"} and any(x in joined for x in ("r", "ɹ", "ɚ")):
            return "many-to-one alignment"
        return "many-to-one alignment"
    if len(source) == 1 and len(target) >= 2:
        return "one-to-many alignment"
    return None


def audit_phone_mapping(
    annotated_phones: Sequence[str],
    annotated_scores: Sequence[float],
    engine_phones: Sequence[str],
    repaired: bool = True,
) -> Dict[str, Any]:
    """Return deterministic mappings plus a reason for every excluded phone.

    The edit path is accepted only when the minimum-cost path is unique.  A
    non-unique path never receives a human label.
    """
    if len(annotated_phones) != len(annotated_scores):
        raise ValueError("Annotated phone and score lengths differ")
    n, m = len(annotated_phones), len(engine_phones)
    cost = np.full((n + 1, m + 1), np.inf)
    ways = np.zeros((n + 1, m + 1), dtype=np.int64)
    back: Dict[Tuple[int, int], Tuple[int, int, str]] = {}
    cost[0, 0], ways[0, 0] = 0.0, 1
    for i in range(n + 1):
        for j in range(m + 1):
            if not np.isfinite(cost[i, j]):
                continue
            moves: List[Tuple[int, int, float, str]] = []
            if i < n and j < m:
                equivalent = mapping_rule(annotated_phones[i], engine_phones[j], repaired) is not None
                moves.append((i + 1, j + 1, 0.0 if equivalent else 2.0, "pair"))
            if i < n:
                moves.append((i + 1, j, 1.0, "delete"))
            if j < m:
                moves.append((i, j + 1, 1.0, "insert"))
            for ni, nj, delta, kind in moves:
                candidate = cost[i, j] + delta
                if candidate < cost[ni, nj]:
                    cost[ni, nj] = candidate
                    ways[ni, nj] = ways[i, j]
                    back[(ni, nj)] = (i, j, kind)
                elif candidate == cost[ni, nj]:
                    ways[ni, nj] = min(np.iinfo(np.int64).max, ways[ni, nj] + ways[i, j])

    mapped: List[Optional[float]] = [None] * m
    target_audit: List[Dict[str, Any]] = [
        {"targetIndex": j, "targetPhone": phone, "status": "EXCLUDED", "reason": "other explicit category"}
        for j, phone in enumerate(engine_phones)
    ]
    source_only: List[Dict[str, Any]] = []
    if ways[n, m] != 1:
        if n == m == 1:
            reason = _reason_for_substitution(annotated_phones[0], engine_phones[0])
        elif n > m:
            reason = "many-to-one alignment"
        elif m > n:
            reason = "one-to-many alignment"
        else:
            reason = _composite_reason(annotated_phones, engine_phones) or "lexical pronunciation variant"
        for item in target_audit:
            item.update({"reason": reason, "pathCount": int(ways[n, m])})
        return {"mappedScores": mapped, "targetAudit": target_audit, "sourceOnlyAudit": source_only,
                "uniquePath": False, "minimumCost": float(cost[n, m])}

    i, j = n, m
    steps = []
    while i or j:
        pi, pj, kind = back[(i, j)]
        steps.append((pi, pj, i, j, kind))
        i, j = pi, pj
    for pi, pj, i, j, kind in reversed(steps):
        if kind == "pair":
            source, target = annotated_phones[pi], engine_phones[pj]
            rule = mapping_rule(source, target, repaired)
            if rule:
                mapped[pj] = float(annotated_scores[pi])
                target_audit[pj] = {
                    "targetIndex": pj, "targetPhone": target, "sourceIndex": pi, "sourcePhone": source,
                    "status": "MAPPED", "reason": None, "rule": rule.to_dict(),
                }
            else:
                target_audit[pj] = {
                    "targetIndex": pj, "targetPhone": target, "sourceIndex": pi, "sourcePhone": source,
                    "status": "EXCLUDED", "reason": _reason_for_substitution(source, target),
                }
        elif kind == "insert":
            target_audit[pj].update({"status": "EXCLUDED", "reason": "insertion", "sourceIndex": None, "sourcePhone": None})
        else:
            source_only.append({"sourceIndex": pi, "sourcePhone": annotated_phones[pi], "status": "EXCLUDED", "reason": "deletion"})
    return {"mappedScores": mapped, "targetAudit": target_audit, "sourceOnlyAudit": source_only,
            "uniquePath": True, "minimumCost": float(cost[n, m])}


def robust_scale(values: np.ndarray) -> float:
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    if mad > 0:
        return 1.4826 * mad
    q25, q75 = np.percentile(values, [25, 75])
    return float((q75 - q25) / 1.349) if q75 > q25 else 0.0


PHONE_STATISTICS: Dict[str, Callable[[np.ndarray], float]] = {
    "mean": lambda x: float(np.mean(x)),
    "median": lambda x: float(np.median(x)),
    "q10": lambda x: float(np.percentile(x, 10)),
    "q50": lambda x: float(np.percentile(x, 50)),
    "q90": lambda x: float(np.percentile(x, 90)),
    "robustScale": robust_scale,
}


def speaker_cluster_bootstrap_statistics(
    rows: Sequence[Dict[str, Any]],
    resamples: int = 1000,
    seed: int = RELIABILITY_SEED,
    sample_levels: Sequence[int] = BOOTSTRAP_SAMPLE_LEVELS,
) -> Dict[str, Any]:
    rng = np.random.default_rng(seed)
    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("rawGop") is not None:
            grouped[str(row["expectedPhoneme"])].append(row)
    report: Dict[str, Any] = {}
    for phone, phone_rows in sorted(grouped.items()):
        speakers = sorted({str(r["speakerId"]) for r in phone_rows})
        by_speaker = {s: [float(r["rawGop"]) for r in phone_rows if str(r["speakerId"]) == s] for s in speakers}
        full = np.asarray([float(r["rawGop"]) for r in phone_rows], dtype=np.float64)
        item: Dict[str, Any] = {"instanceCount": len(full), "speakerCount": len(speakers), "levels": {}}
        for level in sample_levels:
            if len(full) < level:
                item["levels"][str(level)] = {"status": "UNAVAILABLE"}
                continue
            draws = {name: [] for name in PHONE_STATISTICS}
            speaker_draw_counts = []
            for _ in range(resamples):
                selected: List[float] = []
                selected_speakers = set()
                while len(selected) < level:
                    speaker = speakers[int(rng.integers(0, len(speakers)))]
                    selected_speakers.add(speaker)
                    selected.extend(by_speaker[speaker])
                sample = rng.choice(np.asarray(selected), size=level, replace=False)
                speaker_draw_counts.append(len(selected_speakers))
                for name, function in PHONE_STATISTICS.items():
                    draws[name].append(function(sample))
            summaries = {}
            for name, values in draws.items():
                low, high = np.percentile(values, [2.5, 97.5])
                summaries[name] = {"estimate": PHONE_STATISTICS[name](full), "ci95": [float(low), float(high)],
                                   "halfWidth": float((high - low) / 2)}
            item["levels"][str(level)] = {
                "status": "AVAILABLE", "resamples": resamples, "metrics": summaries,
                "bootstrapUniqueSpeakers": {"median": float(np.median(speaker_draw_counts)),
                                             "q10": float(np.percentile(speaker_draw_counts, 10)),
                                             "q90": float(np.percentile(speaker_draw_counts, 90))},
            }
        report[phone] = item
    return report


def _eer(y: np.ndarray, probability: np.ndarray) -> float:
    from sklearn.metrics import roc_curve
    fpr, tpr, _ = roc_curve(y, probability)
    fnr = 1.0 - tpr
    index = int(np.nanargmin(np.abs(fnr - fpr)))
    return float((fpr[index] + fnr[index]) / 2)


def binary_metrics(y: Sequence[int], probability: Sequence[float]) -> Dict[str, float]:
    from sklearn.metrics import average_precision_score, roc_auc_score
    labels = np.asarray(y, dtype=int)
    scores = np.asarray(probability, dtype=float)
    prevalence = float(np.mean(labels))
    pr_auc = float(average_precision_score(labels, scores))
    return {"prevalence": prevalence, "prBaseline": prevalence, "rocAuc": float(roc_auc_score(labels, scores)),
            "prAuc": pr_auc, "prAucLift": pr_auc - prevalence, "eer": _eer(labels, scores)}


def speaker_cluster_metric_ci(
    y: Sequence[int], probability: Sequence[float], speaker_ids: Sequence[str],
    resamples: int = 1000, seed: int = RELIABILITY_SEED,
) -> Dict[str, Any]:
    labels = np.asarray(y, dtype=int)
    scores = np.asarray(probability, dtype=float)
    speakers = np.asarray(speaker_ids, dtype=object)
    unique = np.asarray(sorted(set(speaker_ids)), dtype=object)
    if labels.size == 0 or len(set(labels.tolist())) < 2:
        return {"status": "SINGLE_CLASS"}
    if len(unique) < 2:
        return {"status": "INSUFFICIENT_DATA", "speakerCount": len(unique)}
    rng = np.random.default_rng(seed)
    draws: Dict[str, List[float]] = defaultdict(list)
    speaker_indices = {speaker: np.flatnonzero(speakers == speaker) for speaker in unique}
    for _ in range(resamples):
        chosen = rng.choice(unique, size=len(unique), replace=True)
        indices = np.concatenate([speaker_indices[speaker] for speaker in chosen])
        yy, pp = labels[indices], scores[indices]
        if len(set(yy.tolist())) < 2:
            continue
        for name, value in binary_metrics(yy, pp).items():
            draws[name].append(value)
    valid = len(draws.get("rocAuc", []))
    if valid < math.ceil(0.95 * resamples):
        return {"status": "UNDERPOWERED", "validResamples": valid, "requestedResamples": resamples,
                "speakerCount": len(unique)}
    estimates = binary_metrics(labels, scores)
    return {"status": "AVAILABLE", "sampleCount": len(labels), "speakerCount": len(unique),
            "classCounts": dict(Counter(int(v) for v in labels)), "validResamples": valid,
            "metrics": {name: {"estimate": value,
                                "ci95": [float(np.percentile(draws[name], 2.5)), float(np.percentile(draws[name], 97.5))]}
                        for name, value in estimates.items()}}


def audio_features(waveform: np.ndarray, sample_rate: int = 16000) -> Dict[str, float]:
    values = np.asarray(waveform, dtype=np.float64)
    if values.size == 0:
        raise ValueError("Waveform is empty")
    frame_size = max(1, int(sample_rate * 0.025))
    usable = values[: values.size - (values.size % frame_size)]
    frames = usable.reshape(-1, frame_size) if usable.size else values.reshape(1, -1)
    frame_rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    silence_threshold = max(10 ** (-45 / 20), float(np.max(frame_rms)) * 10 ** (-40 / 20))
    low, high = np.percentile(frame_rms, [10, 90])
    return {
        "durationSeconds": float(values.size / sample_rate), "dcOffset": float(np.mean(values)),
        "rms": float(np.sqrt(np.mean(values ** 2))), "peak": float(np.max(np.abs(values))),
        "silenceProportion": float(np.mean(frame_rms <= silence_threshold)),
        "snrProxyDb": float(20 * np.log10((high + 1e-12) / (low + 1e-12))),
    }


def preprocess_waveform(waveform: np.ndarray, variant: str, sample_rate: int = 16000) -> Tuple[np.ndarray, Dict[str, Any]]:
    result = np.asarray(waveform, dtype=np.float32).copy()
    if result.size == 0:
        raise ValueError("Waveform is empty")
    steps: List[str] = []

    def dc_remove() -> None:
        nonlocal result
        result = result - np.float32(np.mean(result, dtype=np.float64)); steps.append("dc-removal")

    def peak_normalize() -> None:
        nonlocal result
        peak = float(np.max(np.abs(result)))
        if peak > 1e-8:
            result = result * np.float32(0.95 / peak)
        steps.append("peak-0.95")

    def rms_normalize() -> None:
        nonlocal result
        rms = float(np.sqrt(np.mean(result.astype(np.float64) ** 2)))
        peak = float(np.max(np.abs(result)))
        if rms > 1e-8 and peak > 0:
            gain = min(0.10 / rms, 0.99 / peak)
            result = result * np.float32(gain)
        steps.append("rms-0.10-peak-cap-0.99")

    def safe_trim() -> None:
        nonlocal result
        frame = max(1, int(sample_rate * 0.025))
        count = int(math.ceil(result.size / frame))
        rms_values = []
        for index in range(count):
            chunk = result[index * frame:min((index + 1) * frame, result.size)]
            rms_values.append(float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2) + 1e-12)))
        threshold = max(10 ** (-45 / 20), max(rms_values) * 10 ** (-40 / 20))
        active = np.flatnonzero(np.asarray(rms_values) > threshold)
        if active.size:
            margin = int(sample_rate * 0.1)
            start = max(0, int(active[0]) * frame - margin)
            end = min(result.size, (int(active[-1]) + 1) * frame + margin)
            candidate = result[start:end]
            if candidate.size >= int(0.5 * sample_rate) and candidate.size >= result.size * 0.5:
                result = candidate.copy()
                steps.append("safe-silence-trim")
            else:
                steps.append("safe-silence-trim-rejected")
        else:
            steps.append("safe-silence-trim-rejected")

    if variant == "canonical":
        steps.append("canonical-decode")
    elif variant == "dc":
        dc_remove()
    elif variant == "peak":
        peak_normalize()
    elif variant == "rms":
        rms_normalize()
    elif variant == "trim":
        safe_trim()
    elif variant == "dc-rms-trim":
        dc_remove(); rms_normalize(); safe_trim()
    else:
        raise ValueError(f"Unknown preprocessing variant: {variant}")
    result = np.clip(result, -1.0, 1.0).astype(np.float32, copy=False)
    return result, {"variant": variant, "steps": steps, "input": audio_features(waveform, sample_rate),
                    "output": audio_features(result, sample_rate)}


def summarize_reason_counts(audits: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    counts = Counter()
    mapped = 0
    total = 0
    for audit in audits:
        for item in audit["targetAudit"]:
            total += 1
            if item["status"] == "MAPPED":
                mapped += 1
            else:
                counts[item["reason"]] += 1
        for item in audit["sourceOnlyAudit"]:
            counts[item["reason"]] += 1
    excluded = total - mapped
    excluded_events = excluded + counts["deletion"]
    return {"targetPhoneCount": total, "mappedTargetPhones": mapped, "excludedTargetPhones": excluded,
            "excludedPhoneEventsIncludingSourceDeletions": excluded_events,
            "mappedPercent": 100.0 * mapped / total if total else 0.0,
            "excludedPercent": 100.0 * excluded / total if total else 0.0,
            "exclusionCounts": {reason: {"count": counts[reason],
                                           "percentOfExcludedPhoneEvents": 100.0 * counts[reason] / excluded_events if excluded_events else 0.0}
                                for reason in EXCLUSION_REASONS}}
