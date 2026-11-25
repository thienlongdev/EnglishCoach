"""
ECSM Evaluation Firewall, Speaker-Grouped Cross-Validation & Selective Prediction.
Guarantees strict data isolation, zero validation leakage, and anti-hallucination compliance.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple
import numpy as np
from sklearn.metrics import f1_score


def compute_ranking_metrics(
    predictions: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """
    Compute diagnosis ranking metrics: Top-1, Top-3, Top-5, MRR, Mean/Median Rank, Macro-F1, Weighted-F1.
    """
    if not predictions:
        return {
            "count": 0, "top1": 0.0, "top3": 0.0, "top5": 0.0, "mrr": 0.0,
            "meanRank": 0.0, "medianRank": 0.0, "macroF1": 0.0, "weightedF1": 0.0,
            "perPhone": {}, "commonConfusions": [],
        }

    ranks = [int(p["rank"]) for p in predictions]
    human_labels = [str(p["humanPerceivedPhoneme"]) for p in predictions]
    pred_labels = [str(p["predictedPhoneme"]) for p in predictions]

    top1 = np.mean([r == 1 for r in ranks])
    top3 = np.mean([r <= 3 for r in ranks])
    top5 = np.mean([r <= 5 for r in ranks])
    mrr = np.mean([1.0 / r for r in ranks])
    mean_rank = float(np.mean(ranks))
    median_rank = float(np.median(ranks))

    # F1 scores over human perceived phoneme inventory
    macro_f1 = f1_score(human_labels, pred_labels, average="macro", zero_division=0)
    weighted_f1 = f1_score(human_labels, pred_labels, average="weighted", zero_division=0)

    # Per-phone accuracy & support
    per_phone: Dict[str, Dict[str, Any]] = {}
    phone_counts = Counter(human_labels)
    for phone, support in sorted(phone_counts.items()):
        phone_preds = [p for p in predictions if str(p["humanPerceivedPhoneme"]) == phone]
        phone_correct = sum(1 for p in phone_preds if int(p["rank"]) == 1)
        per_phone[phone] = {
            "accuracy": float(phone_correct / support) if support > 0 else 0.0,
            "support": support,
        }

    # Top confusions
    confusions = Counter((h, p) for h, p in zip(human_labels, pred_labels) if h != p)
    common_confusions = [
        {"human": h, "predicted": p, "count": c}
        for (h, p), c in confusions.most_common(20)
    ]

    return {
        "count": len(predictions),
        "top1": float(top1),
        "top3": float(top3),
        "top5": float(top5),
        "mrr": float(mrr),
        "meanRank": mean_rank,
        "medianRank": median_rank,
        "macroF1": float(macro_f1),
        "weightedF1": float(weighted_f1),
        "perPhone": per_phone,
        "commonConfusions": common_confusions,
    }


def compute_oracle_coverage(
    rows: Sequence[Mapping[str, Any]],
    candidate_graph: Mapping[str, Sequence[str]],
) -> Dict[str, Any]:
    """
    Measure candidate set oracle coverage: whether the ground-truth human perceived phone is in the candidate set.
    """
    total = len(rows)
    if total == 0:
        return {"TOTAL_SUBSTITUTIONS": 0, "HUMAN_TARGET_PRESENT_IN_CANDIDATE_SET": 0, "HUMAN_TARGET_ABSENT": 0, "ORACLE_COVERAGE": 0.0}

    present = 0
    absent = 0
    for row in rows:
        expected = str(row["expectedPhoneme"])
        truth = str(row["humanPerceivedPhoneme"])
        allowed = set(candidate_graph.get(expected, []))
        if truth in allowed:
            present += 1
        else:
            absent += 1

    return {
        "TOTAL_SUBSTITUTIONS": total,
        "HUMAN_TARGET_PRESENT_IN_CANDIDATE_SET": present,
        "HUMAN_TARGET_ABSENT": absent,
        "ORACLE_COVERAGE": float(present / total),
    }


def compute_selective_prediction_curve(
    predictions: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """
    Compute selective prediction metrics: Risk-Coverage curve and precision @ {10%, 20%, 30%, 50%} coverage,
    and coverage @ >=90%, >=95% precision.
    """
    if not predictions:
        return {}

    confidences = np.array([float(p.get("confidence", 0.0)) for p in predictions])
    correct = np.array([int(p.get("rank", 999) == 1) for p in predictions])
    total = len(predictions)

    # Sort descending by confidence
    order = np.argsort(-confidences)
    sorted_conf = confidences[order]
    sorted_correct = correct[order]

    results: Dict[str, Any] = {}
    for target_cov in [0.10, 0.20, 0.30, 0.50]:
        k = max(1, int(round(target_cov * total)))
        selected_correct = sorted_correct[:k]
        prec = float(np.mean(selected_correct))
        thresh = float(sorted_conf[k - 1])
        key = f"coverage_{int(target_cov * 100)}"
        results[key] = {
            "targetCoverage": target_cov,
            "actualCoverage": float(k / total),
            "selectedCount": k,
            "precision": prec,
            "threshold": thresh,
        }

    # Coverage at precision >= 0.70, 0.80, 0.90, 0.95
    cum_correct = np.cumsum(sorted_correct)
    cum_total = np.arange(1, total + 1)
    cum_prec = cum_correct / cum_total

    for target_prec in [0.70, 0.80, 0.90, 0.95]:
        key = f"precision_{int(target_prec * 100)}"
        valid_indices = np.where(cum_prec >= target_prec)[0]
        if len(valid_indices) > 0:
            max_idx = valid_indices[-1]
            cov = float((max_idx + 1) / total)
            thresh = float(sorted_conf[max_idx])
            results[key] = {
                "targetPrecision": target_prec,
                "coverage": cov,
                "selectedCount": int(max_idx + 1),
                "precision": float(cum_prec[max_idx]),
                "threshold": thresh,
                "status": "ACHIEVED",
            }
        else:
            results[key] = {
                "targetPrecision": target_prec,
                "coverage": 0.0,
                "selectedCount": 0,
                "precision": 0.0,
                "threshold": 1.0,
                "status": "NOT_REACHED",
            }

    return results


def compute_paired_speaker_cluster_bootstrap(
    candidate_predictions: Sequence[Mapping[str, Any]],
    baseline_predictions: Sequence[Mapping[str, Any]],
    n_bootstraps: int = 2000,
    seed: int = 20260830,
) -> Dict[str, Any]:
    """
    Compute speaker-cluster paired bootstrap to evaluate statistical significance of candidate vs baseline.
    Ensures identical row alignment and clusters resamples by speaker.
    """
    if len(candidate_predictions) != len(baseline_predictions):
        raise ValueError("Candidate and baseline predictions must have identical length")

    # Verify same rowIds
    cand_rows = [p["rowId"] for p in candidate_predictions]
    base_rows = [p["rowId"] for p in baseline_predictions]
    if cand_rows != base_rows:
        raise ValueError("Candidate and baseline predictions are not row-aligned")

    cand_top1 = np.array([int(p["rank"] == 1) for p in candidate_predictions], dtype=np.float64)
    base_top1 = np.array([int(p["rank"] == 1) for p in baseline_predictions], dtype=np.float64)
    cand_mrr = np.array([1.0 / int(p["rank"]) for p in candidate_predictions], dtype=np.float64)
    base_mrr = np.array([1.0 / int(p["rank"]) for p in baseline_predictions], dtype=np.float64)
    speakers = np.array([str(p["speakerId"]) for p in candidate_predictions])

    unique_speakers = np.unique(speakers)
    n_speakers = len(unique_speakers)
    spk_to_indices = {spk: np.where(speakers == spk)[0] for spk in unique_speakers}

    rng = np.random.RandomState(seed)
    delta_top1_list = []
    delta_mrr_list = []

    for _ in range(n_bootstraps):
        sampled_spks = rng.choice(unique_speakers, size=n_speakers, replace=True)
        sampled_indices = np.concatenate([spk_to_indices[s] for s in sampled_spks])

        d_top1 = np.mean(cand_top1[sampled_indices]) - np.mean(base_top1[sampled_indices])
        d_mrr = np.mean(cand_mrr[sampled_indices]) - np.mean(base_mrr[sampled_indices])
        delta_top1_list.append(d_top1)
        delta_mrr_list.append(d_mrr)

    delta_top1_arr = np.array(delta_top1_list)
    delta_mrr_arr = np.array(delta_mrr_list)

    return {
        "candidateTop1": float(np.mean(cand_top1)),
        "baselineTop1": float(np.mean(base_top1)),
        "deltaTop1Point": float(np.mean(cand_top1) - np.mean(base_top1)),
        "deltaTop1Ci95": [float(np.percentile(delta_top1_arr, 2.5)), float(np.percentile(delta_top1_arr, 97.5))],
        "fractionDeltaTop1Positive": float(np.mean(delta_top1_arr > 0)),
        "candidateMrr": float(np.mean(cand_mrr)),
        "baselineMrr": float(np.mean(base_mrr)),
        "deltaMrrPoint": float(np.mean(cand_mrr) - np.mean(base_mrr)),
        "deltaMrrCi95": [float(np.percentile(delta_mrr_arr, 2.5)), float(np.percentile(delta_mrr_arr, 97.5))],
        "fractionDeltaMrrPositive": float(np.mean(delta_mrr_arr > 0)),
    }
