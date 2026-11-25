"""Research-only calibration utilities for SHD-2B.2A."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from app.services.pronunciation.calibration_models import (
    PhoneCalibrationStats,
    build_phone_stats,
    empirical_cdf,
    robust_z,
    standard_z,
)


PRIMARY_ERROR_MAX = 0.5
PERFECT_SCORE = 2.0
BOOTSTRAP_SIZES = (25, 50, 100, 250, 500)
BOOTSTRAP_SEED = 20260830


ARPABET_TO_IPA = {
    "AA": {"ɑ", "ɑː", "ɒ"}, "AE": {"æ"}, "AH": {"ʌ", "ə", "ɐ"},
    "AO": {"ɔ", "ɔː", "ɑː"}, "AW": {"aʊ"}, "AY": {"aɪ"},
    "B": {"b"}, "CH": {"tʃ"}, "D": {"d"}, "DH": {"ð"},
    "EH": {"ɛ", "e"}, "ER": {"ɜː", "ɚ", "ɝ"}, "EY": {"eɪ"},
    "F": {"f"}, "G": {"ɡ", "g"}, "HH": {"h"}, "IH": {"ɪ", "i"},
    "IY": {"iː", "i"}, "JH": {"dʒ"}, "K": {"k"}, "L": {"l", "əl"},
    "M": {"m"}, "N": {"n"}, "NG": {"ŋ"}, "OW": {"oʊ", "oː"},
    "OY": {"ɔɪ"}, "P": {"p"}, "R": {"ɹ", "r"}, "S": {"s"},
    "SH": {"ʃ"}, "T": {"t"}, "TH": {"θ"}, "UH": {"ʊ", "u"},
    "UW": {"uː", "u"}, "V": {"v"}, "W": {"w"}, "Y": {"j"},
    "Z": {"z"}, "ZH": {"ʒ"},
}


def stable_rank(namespace: str, speaker_id: str) -> str:
    return hashlib.sha256(f"{namespace}|{speaker_id}".encode("utf-8")).hexdigest()


def deterministic_speaker_partition(
    speaker_ids: Iterable[str],
    namespace: str,
    split_counts: Dict[str, int],
) -> Dict[str, str]:
    unique = sorted(set(speaker_ids), key=lambda sid: (stable_rank(namespace, sid), sid))
    if sum(split_counts.values()) != len(unique):
        raise ValueError("Split counts must exactly cover the distinct speakers")
    result: Dict[str, str] = {}
    cursor = 0
    for split, count in split_counts.items():
        for speaker_id in unique[cursor:cursor + count]:
            result[speaker_id] = split
        cursor += count
    return result


def assert_zero_speaker_leakage(rows: Sequence[Dict[str, Any]]) -> None:
    memberships: Dict[Tuple[str, str], set] = defaultdict(set)
    for row in rows:
        memberships[(row["dataset"], row["speakerId"])].add(row["split"])
    leaked = {key: splits for key, splits in memberships.items() if len(splits) > 1}
    if leaked:
        raise ValueError(f"Speaker leakage detected: {leaked}")


def primary_binary_label(score: Optional[float]) -> Optional[int]:
    if score is None:
        return None
    if score < PRIMARY_ERROR_MAX:
        return 1
    if score == PERFECT_SCORE:
        return 0
    return None


def sensitivity_binary_label(score: Optional[float]) -> Optional[int]:
    if score is None:
        return None
    return int(score < PERFECT_SCORE)


def normalize_arpabet(phone: str) -> str:
    return phone.strip().upper().rstrip("012")


def phone_equivalent(arpabet_phone: str, ipa_phone: str) -> bool:
    return ipa_phone in ARPABET_TO_IPA.get(normalize_arpabet(arpabet_phone), set())


def map_human_phone_labels(
    annotated_phones: Sequence[str],
    annotated_scores: Sequence[float],
    engine_phones: Sequence[str],
) -> List[Optional[float]]:
    """Map only unambiguous one-to-one equivalent phones; ambiguity stays null."""
    if len(annotated_phones) != len(annotated_scores):
        raise ValueError("Annotated phone and score lengths differ")
    n, m = len(annotated_phones), len(engine_phones)
    cost = np.full((n + 1, m + 1), np.inf)
    ways = np.zeros((n + 1, m + 1), dtype=np.int64)
    back: Dict[Tuple[int, int], List[Tuple[int, int, str]]] = defaultdict(list)
    cost[0, 0], ways[0, 0] = 0.0, 1
    for i in range(n + 1):
        for j in range(m + 1):
            if not np.isfinite(cost[i, j]):
                continue
            transitions = []
            if i < n and j < m:
                transitions.append((i + 1, j + 1, 0 if phone_equivalent(annotated_phones[i], engine_phones[j]) else 2, "match"))
            if i < n:
                transitions.append((i + 1, j, 1, "delete"))
            if j < m:
                transitions.append((i, j + 1, 1, "insert"))
            for ni, nj, delta, kind in transitions:
                candidate = cost[i, j] + delta
                if candidate < cost[ni, nj]:
                    cost[ni, nj] = candidate
                    ways[ni, nj] = ways[i, j]
                    back[(ni, nj)] = [(i, j, kind)]
                elif candidate == cost[ni, nj]:
                    ways[ni, nj] += ways[i, j]
                    back[(ni, nj)].append((i, j, kind))
    if ways[n, m] != 1:
        return [None] * m
    mapped: List[Optional[float]] = [None] * m
    i, j = n, m
    while i or j:
        pi, pj, kind = back[(i, j)][0]
        if kind == "match" and i == pi + 1 and j == pj + 1 and phone_equivalent(annotated_phones[pi], engine_phones[pj]):
            mapped[pj] = float(annotated_scores[pi])
        i, j = pi, pj
    return mapped


def group_phone_stats(
    rows: Sequence[Dict[str, Any]],
    source_dataset: str,
    split: str = "calibration",
) -> Dict[str, PhoneCalibrationStats]:
    values: Dict[str, List[float]] = defaultdict(list)
    speakers: Dict[str, set] = defaultdict(set)
    for row in rows:
        if row.get("rawGop") is None:
            continue
        phone = row["expectedPhoneme"]
        values[phone].append(float(row["rawGop"]))
        speakers[phone].add(row["speakerId"])
    return {
        phone: build_phone_stats(phone, vals, len(speakers[phone]), source_dataset, split)
        for phone, vals in sorted(values.items())
    }


def add_normalizations(
    row: Dict[str, Any], stats: PhoneCalibrationStats, sorted_values: Sequence[float]
) -> Dict[str, Any]:
    enriched = dict(row)
    raw = float(row["rawGop"])
    enriched["experimentalStandardZ"] = standard_z(raw, stats)
    enriched["experimentalRobustZ"] = robust_z(raw, stats)
    enriched["experimentalEmpiricalCdf"] = empirical_cdf(raw, sorted_values)
    return enriched


def bootstrap_stability(
    rows: Sequence[Dict[str, Any]],
    resamples: int = 1000,
    seed: int = BOOTSTRAP_SEED,
) -> Dict[str, Any]:
    rng = np.random.default_rng(seed)
    by_phone: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("rawGop") is not None:
            by_phone[row["expectedPhoneme"]].append(row)
    report: Dict[str, Any] = {}
    metrics = {
        "mean": np.mean, "median": np.median, "std": np.std,
        "q10": lambda x: np.percentile(x, 10),
        "q50": lambda x: np.percentile(x, 50),
        "q90": lambda x: np.percentile(x, 90),
    }
    for phone, phone_rows in sorted(by_phone.items()):
        full = np.asarray([float(r["rawGop"]) for r in phone_rows])
        speakers = sorted({r["speakerId"] for r in phone_rows})
        speaker_rows = {s: [r for r in phone_rows if r["speakerId"] == s] for s in speakers}
        iqr = float(np.percentile(full, 75) - np.percentile(full, 25))
        phone_report: Dict[str, Any] = {"availableN": len(full), "speakerCount": len(speakers), "sizes": {}}
        for sample_n in BOOTSTRAP_SIZES:
            if len(full) < sample_n:
                phone_report["sizes"][str(sample_n)] = {"status": "UNAVAILABLE"}
                continue
            draws = {name: [] for name in metrics}
            for _ in range(resamples):
                selected: List[float] = []
                while len(selected) < sample_n:
                    speaker = speakers[int(rng.integers(0, len(speakers)))]
                    selected.extend(float(r["rawGop"]) for r in speaker_rows[speaker])
                selected_array = np.asarray(selected)
                arr = rng.choice(selected_array, size=sample_n, replace=False)
                for name, fn in metrics.items():
                    draws[name].append(float(fn(arr)))
            summary = {"status": "AVAILABLE", "metrics": {}}
            stable = True
            for name, samples in draws.items():
                low, high = np.percentile(samples, [2.5, 97.5])
                half_width = float((high - low) / 2)
                summary["metrics"][name] = {"ci95": [float(low), float(high)], "halfWidth": half_width}
                if name == "std":
                    reference = float(np.std(full))
                    stable &= reference > 0 and half_width / reference <= 0.10
                else:
                    stable &= iqr > 0 and half_width <= 0.20 * iqr
            summary["meetsStabilityCriterion"] = bool(stable)
            phone_report["sizes"][str(sample_n)] = summary
        eligible = [int(n) for n, item in phone_report["sizes"].items() if item.get("meetsStabilityCriterion")]
        phone_report["recommendedMinimumN"] = min(eligible) if eligible else None
        report[phone] = phone_report
    return report


def distribution_summary(values: Sequence[float]) -> Dict[str, Any]:
    arr = np.asarray(values, dtype=np.float64)
    if arr.size == 0:
        return {"count": 0, "status": "UNAVAILABLE"}
    q = np.percentile(arr, [1, 5, 10, 25, 50, 75, 90, 95, 99])
    return {
        "count": int(arr.size), "mean": float(np.mean(arr)), "std": float(np.std(arr)),
        "median": float(q[4]), "minimum": float(np.min(arr)), "maximum": float(np.max(arr)),
        "q01": float(q[0]), "q05": float(q[1]), "q10": float(q[2]),
        "q25": float(q[3]), "q50": float(q[4]), "q75": float(q[5]),
        "q90": float(q[6]), "q95": float(q[7]), "q99": float(q[8]),
    }
