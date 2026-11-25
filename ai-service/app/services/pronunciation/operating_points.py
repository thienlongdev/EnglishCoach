"""Detection operating-point utilities with explicit pronunciation semantics."""

from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List

import numpy as np


@dataclass(frozen=True)
class DetectionOperatingPoint:
    threshold: float
    tp: int
    tn: int
    fp: int
    fn: int
    far: float
    frr: float
    errorRecall: float
    specificity: float

    def to_dict(self) -> Dict[str, float | int]:
        return asdict(self)


def decision_boundaries(scores: Iterable[float]) -> List[float]:
    """Return all deterministic boundaries for the ``score >= threshold`` rule."""
    values = np.asarray(list(scores), dtype=np.float64)
    if values.ndim != 1 or values.size == 0:
        raise ValueError("scores must be a non-empty one-dimensional sequence")
    if not np.isfinite(values).all():
        raise ValueError("scores must all be finite")
    unique = np.unique(values)
    return [
        float(np.nextafter(unique[0], -np.inf)),
        *[float(value) for value in unique],
        float(np.nextafter(unique[-1], np.inf)),
    ]


def rates_at_threshold(
    labels: Iterable[int], scores: Iterable[float], threshold: float
) -> DetectionOperatingPoint:
    y_true = np.asarray(list(labels), dtype=np.int8)
    y_score = np.asarray(list(scores), dtype=np.float64)
    if y_true.ndim != 1 or y_score.ndim != 1 or y_true.size != y_score.size or y_true.size == 0:
        raise ValueError("labels and scores must be non-empty one-dimensional sequences of equal length")
    if not np.isin(y_true, [0, 1]).all():
        raise ValueError("labels must contain only 0 (correct) and 1 (error)")
    if not np.isfinite(y_score).all() or not np.isfinite(threshold):
        raise ValueError("scores and threshold must be finite")

    prediction = y_score >= threshold
    actual_error = y_true == 1
    actual_correct = ~actual_error
    tp = int(np.sum(prediction & actual_error))
    tn = int(np.sum(~prediction & actual_correct))
    fp = int(np.sum(prediction & actual_correct))
    fn = int(np.sum(~prediction & actual_error))
    positives = tp + fn
    negatives = tn + fp
    if positives == 0 or negatives == 0:
        raise ValueError("both actual-error and actual-correct rows are required")
    far = fn / positives
    frr = fp / negatives
    return DetectionOperatingPoint(
        threshold=float(threshold),
        tp=tp,
        tn=tn,
        fp=fp,
        fn=fn,
        far=float(far),
        frr=float(frr),
        errorRecall=float(tp / positives),
        specificity=float(tn / negatives),
    )


def optimize_far_constrained_threshold(
    labels: Iterable[int], scores: Iterable[float], alpha: float
) -> DetectionOperatingPoint:
    """Minimize FRR subject to FAR <= alpha, choosing the largest feasible threshold."""
    if not 0.0 <= alpha <= 1.0:
        raise ValueError("alpha must be between zero and one")
    label_values = list(labels)
    score_values = list(scores)
    points = [rates_at_threshold(label_values, score_values, th) for th in decision_boundaries(score_values)]
    feasible = [point for point in points if point.far <= alpha + 1e-15]
    if not feasible:
        raise RuntimeError("no FAR-feasible threshold exists")
    # With the configured score orientation, largest feasible also minimizes FRR.
    minimum_frr = min(point.frr for point in feasible)
    best = [point for point in feasible if abs(point.frr - minimum_frr) <= 1e-15]
    return max(best, key=lambda point: point.threshold)
