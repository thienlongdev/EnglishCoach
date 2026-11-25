"""
SHD-2B.2A Calibration Research Models & Interfaces
English Coach — Phoneme Calibration Data Model

Defines data structures for empirical phoneme calibration distributions.
Research statistics remain offline; calibrated scores remain strictly NULL /
NOT AVAILABLE until a later production decision explicitly activates them.
"""

from typing import Optional, Dict, Any, Sequence
from dataclasses import dataclass, asdict
import bisect
import numpy as np


@dataclass
class PhoneCalibrationStats:
    """
    Empirical distribution metrics for a single phoneme across a calibration corpus.
    """
    phoneme: str
    sampleCount: int = 0
    speakerCount: int = 0
    rawMedian: Optional[float] = None
    rawMean: Optional[float] = None
    rawStd: Optional[float] = None
    rawMad: Optional[float] = None
    q01: Optional[float] = None
    q05: Optional[float] = None
    q10: Optional[float] = None
    q25: Optional[float] = None
    q50: Optional[float] = None
    q75: Optional[float] = None
    q90: Optional[float] = None
    q95: Optional[float] = None
    q99: Optional[float] = None
    sourceDataset: str = "none"
    sourceSplit: str = "calibration"
    calibrationMethod: str = "empirical_reference_distribution"
    schemaVersion: str = "2.0-research"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def calculate_calibrated_score(
    raw_gop: Optional[float],
    stats: Optional[PhoneCalibrationStats] = None
) -> Optional[float]:
    """
    Mathematical mapping interface for future calibrated learner-facing scores (0-100).
    
    INVARIANT: SHD-2B.2A is research-only and strictly returns None. Never
    substitutes arbitrary sigmoid parameters or exposes a learner-facing score.
    """
    # SHD-2B.2A is research-only. Empirical statistics never activate a
    # learner-facing score without a later, separately accepted production slice.
    return None


def standard_z(raw_gop: float, stats: PhoneCalibrationStats) -> Optional[float]:
    if stats.rawMean is None or stats.rawStd is None or stats.rawStd <= 0:
        return None
    return (raw_gop - stats.rawMean) / stats.rawStd


def robust_scale(stats: PhoneCalibrationStats) -> Optional[float]:
    if stats.rawMad is not None and stats.rawMad > 0:
        return 1.4826 * stats.rawMad
    if stats.q25 is not None and stats.q75 is not None and stats.q75 > stats.q25:
        return (stats.q75 - stats.q25) / 1.349
    return None


def robust_z(raw_gop: float, stats: PhoneCalibrationStats) -> Optional[float]:
    scale = robust_scale(stats)
    if stats.rawMedian is None or scale is None or scale <= 0:
        return None
    return (raw_gop - stats.rawMedian) / scale


def empirical_cdf(raw_gop: float, sorted_values: Sequence[float]) -> Optional[float]:
    if not sorted_values:
        return None
    left = bisect.bisect_left(sorted_values, raw_gop)
    right = bisect.bisect_right(sorted_values, raw_gop)
    return (left + 0.5 * (right - left)) / len(sorted_values)


def build_phone_stats(
    phoneme: str,
    values: Sequence[float],
    speaker_count: int,
    source_dataset: str,
    source_split: str = "calibration"
) -> PhoneCalibrationStats:
    arr = np.asarray(values, dtype=np.float64)
    if arr.size == 0:
        return PhoneCalibrationStats(
            phoneme=phoneme,
            speakerCount=speaker_count,
            sourceDataset=source_dataset,
            sourceSplit=source_split
        )
    quantiles = np.percentile(arr, [1, 5, 10, 25, 50, 75, 90, 95, 99])
    median = float(np.median(arr))
    return PhoneCalibrationStats(
        phoneme=phoneme,
        sampleCount=int(arr.size),
        speakerCount=speaker_count,
        rawMean=float(np.mean(arr)),
        rawStd=float(np.std(arr)),
        rawMedian=median,
        rawMad=float(np.median(np.abs(arr - median))),
        q01=float(quantiles[0]), q05=float(quantiles[1]),
        q10=float(quantiles[2]), q25=float(quantiles[3]),
        q50=float(quantiles[4]), q75=float(quantiles[5]),
        q90=float(quantiles[6]), q95=float(quantiles[7]),
        q99=float(quantiles[8]),
        sourceDataset=source_dataset,
        sourceSplit=source_split
    )
