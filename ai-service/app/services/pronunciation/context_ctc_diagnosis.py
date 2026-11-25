"""Context-aware constrained CTC diagnosis primitives for Acoustic Round 2.

This module deliberately contains no validation-selection behavior.  All empirical
objects accept explicit training rows so callers can enforce speaker-fold locality.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import random
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import f1_score


ROUND2_FEATURE_VERSION = "final-acoustic-r2-v1"
WINDOWS = ("target", "neighbors", "word")


def logsumexp(values: Sequence[float]) -> float:
    finite = [float(value) for value in values if not math.isinf(float(value))]
    if not finite:
        return -math.inf
    maximum = max(finite)
    return maximum + math.log(sum(math.exp(value - maximum) for value in finite))


def ctc_sequence_log_probability(
    log_probs: np.ndarray, token_ids: Sequence[int], blank_id: int
) -> float:
    """Sum probabilities of all CTC paths emitting ``token_ids`` in log space."""
    matrix = np.asarray(log_probs, dtype=np.float64)
    labels = [int(token_id) for token_id in token_ids]
    if matrix.ndim != 2 or matrix.shape[0] == 0:
        raise ValueError("log_probs must have shape [frames, vocabulary] with at least one frame")
    if not labels:
        return float(np.sum(matrix[:, blank_id]))
    if blank_id in labels:
        raise ValueError("the output sequence may not contain the CTC blank")
    if min(labels) < 0 or max(labels) >= matrix.shape[1] or blank_id < 0 or blank_id >= matrix.shape[1]:
        raise ValueError("token id outside log-probability vocabulary")

    expanded: List[int] = [blank_id]
    for label in labels:
        expanded.extend((label, blank_id))
    state_count = len(expanded)
    previous = np.full(state_count, -np.inf, dtype=np.float64)
    previous[0] = matrix[0, blank_id]
    if state_count > 1:
        previous[1] = matrix[0, expanded[1]]

    for frame in range(1, matrix.shape[0]):
        current = np.full(state_count, -np.inf, dtype=np.float64)
        for state, token_id in enumerate(expanded):
            sources = [previous[state]]
            if state > 0:
                sources.append(previous[state - 1])
            if state > 1 and token_id != blank_id and token_id != expanded[state - 2]:
                sources.append(previous[state - 2])
            current[state] = logsumexp(sources) + matrix[frame, token_id]
        previous = current
    return logsumexp(previous[-2:])


def stable_log_softmax(logits: np.ndarray) -> np.ndarray:
    values = np.asarray(logits, dtype=np.float64)
    maximum = np.max(values, axis=-1, keepdims=True)
    shifted = values - maximum
    return shifted - np.log(np.sum(np.exp(shifted), axis=-1, keepdims=True))


def deterministic_group_folds(
    speaker_ids: Iterable[str], folds: int = 5, seed: int = 20260830
) -> List[set[str]]:
    speakers = sorted(set(str(speaker) for speaker in speaker_ids))
    if len(speakers) < folds:
        raise ValueError("fewer speakers than folds")
    random.Random(seed).shuffle(speakers)
    result = [set() for _ in range(folds)]
    for index, speaker in enumerate(speakers):
        result[index % folds].add(speaker)
    return result


def build_fold_candidate_graph(
    substitution_rows: Sequence[Mapping[str, Any]],
    articulatory_neighbors: Mapping[str, Sequence[str]],
    valid_phones: Iterable[str],
) -> Dict[str, Tuple[str, ...]]:
    """Build candidates from only the substitution rows explicitly supplied."""
    valid = set(valid_phones)
    observed: Dict[str, set[str]] = defaultdict(set)
    canonical_phones = set(valid)
    for row in substitution_rows:
        expected = str(row["expectedPhoneme"])
        perceived = str(row["humanPerceivedPhoneme"])
        if expected in valid and perceived in valid and expected != perceived:
            observed[expected].add(perceived)
    graph: Dict[str, Tuple[str, ...]] = {}
    for expected in sorted(canonical_phones):
        candidates = {expected, *observed.get(expected, set())}
        candidates.update(phone for phone in articulatory_neighbors.get(expected, ())[:6] if phone in valid)
        graph[expected] = tuple(sorted(candidates))
    return graph


def candidate_oracle_coverage(
    rows: Sequence[Mapping[str, Any]], graph: Mapping[str, Sequence[str]]
) -> Dict[str, float | int]:
    total = len(rows)
    present = sum(
        str(row["humanPerceivedPhoneme"]) in set(graph.get(str(row["expectedPhoneme"]), ()))
        for row in rows
    )
    return {
        "TOTAL_SUBSTITUTIONS": total,
        "HUMAN_TARGET_PRESENT_IN_CANDIDATE_SET": present,
        "HUMAN_TARGET_ABSENT": total - present,
        "ORACLE_COVERAGE": float(present / total) if total else 0.0,
    }


@dataclass(frozen=True)
class RobustPhoneStats:
    center: float
    scale: float
    count: int
    speakers: int
    usedPhoneSpecific: bool


class PhoneRobustNormalizer:
    def __init__(self, minimum_instances: int = 30, minimum_speakers: int = 5):
        self.minimum_instances = minimum_instances
        self.minimum_speakers = minimum_speakers
        self.global_stats: Optional[RobustPhoneStats] = None
        self.phone_stats: Dict[str, RobustPhoneStats] = {}

    @staticmethod
    def _stats(values: Sequence[float], speakers: int, phone_specific: bool) -> RobustPhoneStats:
        array = np.asarray(values, dtype=np.float64)
        center = float(np.median(array))
        q25, q75 = np.quantile(array, [0.25, 0.75])
        scale = float((q75 - q25) / 1.349)
        if not np.isfinite(scale) or scale < 1e-6:
            scale = float(np.std(array))
        if not np.isfinite(scale) or scale < 1e-6:
            scale = 1.0
        return RobustPhoneStats(center, scale, len(array), speakers, phone_specific)

    def fit(self, rows: Sequence[Mapping[str, Any]]) -> "PhoneRobustNormalizer":
        if not rows:
            raise ValueError("normalizer requires training rows")
        global_values = [float(row["errorScore"]) for row in rows]
        global_speakers = len({str(row["speakerId"]) for row in rows})
        self.global_stats = self._stats(global_values, global_speakers, False)
        by_phone: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
        for row in rows:
            by_phone[str(row["expectedPhoneme"])].append(row)
        self.phone_stats = {}
        for phone, phone_rows in by_phone.items():
            speakers = len({str(row["speakerId"]) for row in phone_rows})
            if len(phone_rows) >= self.minimum_instances and speakers >= self.minimum_speakers:
                self.phone_stats[phone] = self._stats(
                    [float(row["errorScore"]) for row in phone_rows], speakers, True
                )
        return self

    def transform(self, phone: str, score: float) -> float:
        if self.global_stats is None:
            raise RuntimeError("normalizer has not been fitted")
        stats = self.phone_stats.get(str(phone), self.global_stats)
        return float((float(score) - stats.center) / stats.scale)

    def manifest(self) -> Dict[str, Any]:
        return {
            "minimumInstances": self.minimum_instances,
            "minimumSpeakers": self.minimum_speakers,
            "global": asdict(self.global_stats) if self.global_stats else None,
            "phones": {phone: asdict(stats) for phone, stats in sorted(self.phone_stats.items())},
        }


class MarginConfidenceCalibrator:
    def __init__(self):
        self.model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        self.fitted = False

    def fit(self, margins: Sequence[float], correct: Sequence[int]) -> "MarginConfidenceCalibrator":
        if len(margins) != len(correct) or not margins:
            raise ValueError("non-empty aligned margins and correctness labels are required")
        self.model.fit(np.asarray(margins, dtype=np.float64), np.asarray(correct, dtype=np.int8))
        self.fitted = True
        return self

    def predict(self, margins: Sequence[float]) -> np.ndarray:
        if not self.fitted:
            raise RuntimeError("calibrator has not been fitted")
        return np.asarray(self.model.predict(np.asarray(margins, dtype=np.float64)), dtype=np.float64)


def derive_confidence_thresholds(
    confidence: Sequence[float], correct: Sequence[int]
) -> Dict[str, Optional[float]]:
    conf = np.asarray(confidence, dtype=np.float64)
    hits = np.asarray(correct, dtype=np.int8)
    if conf.size == 0 or conf.size != hits.size:
        raise ValueError("non-empty aligned confidence and correctness are required")
    thresholds: Dict[str, Optional[float]] = {}
    for coverage in (0.10, 0.20, 0.30, 0.50):
        count = max(1, int(math.ceil(coverage * conf.size)))
        thresholds[f"coverage_{int(coverage * 100)}"] = float(np.sort(conf)[::-1][count - 1])
    for precision in (0.70, 0.80, 0.90):
        best_threshold: Optional[float] = None
        best_coverage = -1.0
        for threshold in sorted(set(float(value) for value in conf), reverse=True):
            selected = conf >= threshold
            if selected.any() and float(np.mean(hits[selected])) >= precision:
                coverage = float(np.mean(selected))
                if coverage > best_coverage:
                    best_coverage = coverage
                    best_threshold = threshold
        thresholds[f"precision_{int(precision * 100)}"] = best_threshold
    return thresholds


def evaluate_selective(
    confidence: Sequence[float], correct: Sequence[int], thresholds: Mapping[str, Optional[float]]
) -> Dict[str, Dict[str, float | int | str]]:
    conf = np.asarray(confidence, dtype=np.float64)
    hits = np.asarray(correct, dtype=np.int8)
    result: Dict[str, Dict[str, float | int | str]] = {}
    for name, threshold in thresholds.items():
        if threshold is None:
            result[name] = {"status": "UNATTAINABLE", "selected": 0, "coverage": 0.0, "precision": 0.0}
            continue
        selected = conf >= threshold
        result[name] = {
            "status": "MEASURED",
            "threshold": float(threshold),
            "selected": int(np.sum(selected)),
            "coverage": float(np.mean(selected)) if selected.size else 0.0,
            "precision": float(np.mean(hits[selected])) if selected.any() else 0.0,
        }
    return result


def ranking_metrics(rows: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    if not rows:
        return {"count": 0, "top1": 0.0, "top3": 0.0, "top5": 0.0, "mrr": 0.0}
    ranks = np.asarray([int(row["rank"]) for row in rows], dtype=np.int64)
    truth = [str(row["humanPerceivedPhoneme"]) for row in rows]
    pred = [str(row["predictedPhoneme"]) for row in rows]
    labels = sorted(set(truth) | set(pred))
    per_phone: Dict[str, Any] = {}
    for phone in sorted(set(truth)):
        mask = np.asarray([value == phone for value in truth])
        per_phone[phone] = {
            "support": int(np.sum(mask)),
            "accuracy": float(np.mean(ranks[mask] == 1)),
        }
    confusions = Counter((target, guess) for target, guess in zip(truth, pred) if target != guess)
    return {
        "count": len(rows),
        "top1": float(np.mean(ranks <= 1)),
        "top3": float(np.mean(ranks <= 3)),
        "top5": float(np.mean(ranks <= 5)),
        "macroF1": float(f1_score(truth, pred, labels=labels, average="macro", zero_division=0)),
        "weightedF1": float(f1_score(truth, pred, labels=labels, average="weighted", zero_division=0)),
        "mrr": float(np.mean(1.0 / ranks)),
        "meanRank": float(np.mean(ranks)),
        "medianRank": float(np.median(ranks)),
        "perPhone": per_phone,
        "commonConfusions": [
            {"human": human, "predicted": predicted, "count": count}
            for (human, predicted), count in confusions.most_common(25)
        ],
    }


def paired_bootstrap_improvement(
    round2_rows: Sequence[Mapping[str, Any]],
    baseline_rows: Sequence[Mapping[str, Any]],
    resamples: int = 2000,
    seed: int = 20260830,
) -> Dict[str, Any]:
    if [row["rowId"] for row in round2_rows] != [row["rowId"] for row in baseline_rows]:
        raise ValueError("paired comparison requires identical held-fold rows in identical order")
    r2_rank = np.asarray([int(row["rank"]) for row in round2_rows], dtype=np.int64)
    base_rank = np.asarray([int(row["rank"]) for row in baseline_rows], dtype=np.int64)
    speakers = np.asarray([str(row["speakerId"]) for row in round2_rows])
    rng = np.random.default_rng(seed)

    def differences(indices: np.ndarray) -> Tuple[float, float]:
        return (
            float(np.mean(r2_rank[indices] == 1) - np.mean(base_rank[indices] == 1)),
            float(np.mean(1.0 / r2_rank[indices]) - np.mean(1.0 / base_rank[indices])),
        )

    instance = [differences(rng.integers(0, len(r2_rank), len(r2_rank))) for _ in range(resamples)]
    unique_speakers = np.unique(speakers)
    speaker_samples: List[Tuple[float, float]] = []
    for _ in range(resamples):
        sampled = rng.choice(unique_speakers, size=len(unique_speakers), replace=True)
        indices = np.concatenate([np.flatnonzero(speakers == speaker) for speaker in sampled])
        speaker_samples.append(differences(indices))

    observed = differences(np.arange(len(r2_rank)))
    return {
        "sameRowCount": len(round2_rows),
        "observedTop1Difference": observed[0],
        "observedMrrDifference": observed[1],
        "instanceTop1Ci95": np.quantile(np.asarray(instance)[:, 0], [0.025, 0.975]).tolist(),
        "instanceMrrCi95": np.quantile(np.asarray(instance)[:, 1], [0.025, 0.975]).tolist(),
        "speakerTop1Ci95": np.quantile(np.asarray(speaker_samples)[:, 0], [0.025, 0.975]).tolist(),
        "speakerMrrCi95": np.quantile(np.asarray(speaker_samples)[:, 1], [0.025, 0.975]).tolist(),
    }


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class Round2LogitCache:
    def __init__(self, cache_dir: Path, identity: Mapping[str, Any]):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        identity_json = json.dumps(dict(identity), sort_keys=True, separators=(",", ":"))
        self.identity = dict(identity)
        self.identity_hash = hashlib.sha256(identity_json.encode("utf-8")).hexdigest()
        self.manifest_path = self.cache_dir / "manifest.json"
        if self.manifest_path.exists():
            existing = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            if existing.get("identityHash") != self.identity_hash:
                raise RuntimeError("Round2 cache identity mismatch; use a new cache directory")
        else:
            atomic_write_json(
                self.manifest_path,
                {"featureVersion": ROUND2_FEATURE_VERSION, "identity": self.identity, "identityHash": self.identity_hash},
            )

    def _path(self, utterance_id: str, audio_hash: str) -> Path:
        key = hashlib.sha256(f"{self.identity_hash}:{utterance_id}:{audio_hash}".encode("utf-8")).hexdigest()
        return self.cache_dir / f"{key}.npy"

    def save(self, utterance_id: str, audio_hash: str, logits: np.ndarray) -> Path:
        path = self._path(utterance_id, audio_hash)
        temporary = path.with_suffix(".tmp")
        array = np.asarray(logits, dtype=np.float32)
        with open(temporary, "wb") as handle:
            np.save(handle, array, allow_pickle=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        return path

    def load(self, utterance_id: str, audio_hash: str) -> Optional[np.ndarray]:
        path = self._path(utterance_id, audio_hash)
        if not path.exists():
            return None
        return np.load(path, allow_pickle=False)


def tensor_sha256(array: np.ndarray) -> str:
    contiguous = np.ascontiguousarray(array)
    hasher = hashlib.sha256()
    hasher.update(str(contiguous.dtype).encode("ascii"))
    hasher.update(np.asarray(contiguous.shape, dtype=np.int64).tobytes())
    hasher.update(contiguous.tobytes())
    return hasher.hexdigest()


@dataclass(frozen=True)
class Round2CandidateDiagnosis:
    expectedPhoneme: str
    candidateObservedPhoneme: Optional[str]
    candidateConfidence: float
    candidateSource: str
    differences: Dict[str, Tuple[Optional[str], Optional[str]]]
    observedPhoneme: None = None


def articulatory_differences(expected_profile: Any, candidate_profile: Any) -> Dict[str, Tuple[Optional[str], Optional[str]]]:
    if expected_profile.isVowel and candidate_profile.isVowel:
        names = ("height", "backness", "rounding")
    elif not expected_profile.isVowel and not candidate_profile.isVowel:
        names = ("place", "manner", "voicing")
    else:
        return {"phoneClass": ("vowel" if expected_profile.isVowel else "consonant", "vowel" if candidate_profile.isVowel else "consonant")}
    result: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    for name in names:
        left = getattr(expected_profile, name, None)
        right = getattr(candidate_profile, name, None)
        result[name] = (getattr(left, "value", left), getattr(right, "value", right))
    return result
