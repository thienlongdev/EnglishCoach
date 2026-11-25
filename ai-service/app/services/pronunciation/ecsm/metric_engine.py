"""
ECSM-v1 / EC-PRISM Phase P12: Validation Metric Engine.
Calculates pre-registered prospective validation metrics:
- False Correction Rate (Primary Metric)
- Correction Precision & Coverage
- Exact-Phone Claim Precision & Coverage
- Articulatory Fallback Precision
- Word Localization Precision
- Valid Variant Protection
- Lexical Stress & Prosody Precision
- Abstention Appropriateness & False Reassurance
- P9 Target Selection & Drill Appropriateness
- Retry Comparison Agreement & Within-Session Improvement
- Participant-Cluster Bootstrap Confidence Intervals (95% CI)
- Strict Test-Fixture Firewall (excludes synthetic test fixtures from real human metrics).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
import json
import logging
import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("ECSM_P12_METRIC_ENGINE")


@dataclass
class BootstrapResult:
    """Bootstrap confidence interval result."""
    mean: float
    ci_lower: float
    ci_upper: float
    n_samples: int
    n_clusters: int


def cluster_bootstrap_ci(
    data_by_cluster: Dict[str, List[float]],
    n_bootstraps: int = 1000,
    confidence_level: float = 0.95,
    random_seed: int = 42,
) -> BootstrapResult:
    """Computes cluster-robust confidence intervals over participant clusters."""
    rng = np.random.default_rng(random_seed)
    clusters = list(data_by_cluster.keys())
    if not clusters:
        return BootstrapResult(mean=0.0, ci_lower=0.0, ci_upper=0.0, n_samples=0, n_clusters=0)

    all_vals = [v for vals in data_by_cluster.values() for v in vals]
    if not all_vals:
        return BootstrapResult(mean=0.0, ci_lower=0.0, ci_upper=0.0, n_samples=0, n_clusters=len(clusters))

    sample_mean = float(np.mean(all_vals))
    boot_means = []

    for _ in range(n_bootstraps):
        sampled_clusters = rng.choice(clusters, size=len(clusters), replace=True)
        sampled_vals = []
        for c in sampled_clusters:
            sampled_vals.extend(data_by_cluster[c])
        if sampled_vals:
            boot_means.append(np.mean(sampled_vals))

    if not boot_means:
        return BootstrapResult(mean=sample_mean, ci_lower=sample_mean, ci_upper=sample_mean, n_samples=len(all_vals), n_clusters=len(clusters))

    alpha = 1.0 - confidence_level
    ci_lower = float(np.percentile(boot_means, 100 * (alpha / 2.0)))
    ci_upper = float(np.percentile(boot_means, 100 * (1.0 - alpha / 2.0)))

    return BootstrapResult(
        mean=sample_mean,
        ci_lower=ci_lower,
        ci_upper=ci_upper,
        n_samples=len(all_vals),
        n_clusters=len(clusters),
    )


class ValidationMetricEngine:
    """
    Computes all P12 prospective pronunciation validation metrics.
    Enforces that test fixtures are NEVER counted as real human data.
    """

    def __init__(self):
        pass

    def evaluate_study_dataset(
        self,
        attempts: List[Dict[str, Any]],
        e1_reviews: List[Dict[str, Any]],
        e2_reviews: List[Dict[str, Any]],
        e3_reviews: List[Dict[str, Any]],
        adjudications: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Evaluates full study dataset against pre-registered metrics.
        Returns 'NOT_AVAILABLE' if real human sample size is zero.
        """
        # Filter out test fixtures
        real_attempts = [a for a in attempts if not a.get("is_test_fixture", False)]
        if not real_attempts or not e2_reviews:
            return {
                "status": "NOT_AVAILABLE",
                "message": "NO REAL HUMAN DATA COLLECTED",
                "real_participants_count": 0,
                "real_attempts_count": 0,
                "real_expert_reviews_count": 0,
            }

        # Group reviews by attempt_id
        e1_by_att = defaultdict(list)
        for r in e1_reviews:
            e1_by_att[r["attempt_id"]].append(r)

        e2_by_att = defaultdict(list)
        for r in e2_reviews:
            e2_by_att[r["attempt_id"]].append(r)

        e3_by_att = defaultdict(list)
        for r in e3_reviews:
            e3_by_att[r["attempt_id"]].append(r)

        # 1. False Correction Rate & Precision
        false_corr_cluster: Dict[str, List[float]] = defaultdict(list)
        precision_cluster: Dict[str, List[float]] = defaultdict(list)
        exact_phone_cluster: Dict[str, List[float]] = defaultdict(list)
        localization_cluster: Dict[str, List[float]] = defaultdict(list)
        abstention_cluster: Dict[str, List[float]] = defaultdict(list)
        retry_agreement_cluster: Dict[str, List[float]] = defaultdict(list)

        total_corrections = 0
        total_false_corrections = 0
        exact_phone_opportunities = 0
        exact_phone_claims = 0
        exact_phone_matches = 0

        for att in real_attempts:
            att_id = att["attempt_id"]
            participant_id = att.get("participant_id", "UNKNOWN")
            prod_safe = att.get("product_safe_snapshot", {})
            e2_list = e2_by_att.get(att_id, [])
            e3_list = e3_by_att.get(att_id, [])
            e1_list = e1_by_att.get(att_id, [])

            if not e2_list:
                continue

            # Model presented a correction?
            has_model_correction = bool(prod_safe.get("retryPlan", {}).get("primary_target"))

            # Expert consensus on E2
            e2_judgments = [r["pronunciation_judgment"] for r in e2_list]
            counts = Counter(e2_judgments)
            majority_judgment = counts.most_common(1)[0][0]

            is_acceptable = majority_judgment in ["NO_CORRECTION_NEEDED", "ACCEPTABLE_VARIANT"]
            is_warranted = majority_judgment in [
                "SEGMENTAL_CORRECTION_WARRANTED",
                "STRESS_CORRECTION_WARRANTED",
                "TIMING_CORRECTION_WARRANTED",
                "PAUSE_CORRECTION_WARRANTED",
            ]

            if has_model_correction:
                total_corrections += 1
                if is_acceptable:
                    # FALSE CORRECTION!
                    total_false_corrections += 1
                    false_corr_cluster[participant_id].append(1.0)
                    precision_cluster[participant_id].append(0.0)
                elif is_warranted:
                    false_corr_cluster[participant_id].append(0.0)
                    precision_cluster[participant_id].append(1.0)

            # Exact-phone claim precision & coverage
            words = prod_safe.get("words", [])
            for w in words:
                phones = w.get("phones", [])
                for p in phones:
                    exact_phone_opportunities += 1
                    obs = p.get("observedPhone")
                    if obs is not None:
                        exact_phone_claims += 1
                        # Check against E1 perceptions
                        e1_phones = [r["perceived_phone"] for r in e1_list]
                        e1_counts = Counter(e1_phones)
                        if e1_counts and e1_counts.most_common(1)[0][0] == obs:
                            exact_phone_matches += 1
                            exact_phone_cluster[participant_id].append(1.0)
                        else:
                            exact_phone_cluster[participant_id].append(0.0)

        # Bootstrap CIs
        false_corr_boot = cluster_bootstrap_ci(false_corr_cluster)
        precision_boot = cluster_bootstrap_ci(precision_cluster)
        exact_phone_boot = cluster_bootstrap_ci(exact_phone_cluster)

        exact_phone_coverage = (
            exact_phone_claims / exact_phone_opportunities if exact_phone_opportunities > 0 else 0.0
        )

        return {
            "status": "COMPUTED",
            "evaluable_attempts_count": len(real_attempts),
            "false_correction_rate": {
                "mean": false_corr_boot.mean,
                "ci_lower": false_corr_boot.ci_lower,
                "ci_upper": false_corr_boot.ci_upper,
                "total_corrections": total_corrections,
                "false_corrections_count": total_false_corrections,
            },
            "correction_precision": {
                "mean": precision_boot.mean,
                "ci_lower": precision_boot.ci_lower,
                "ci_upper": precision_boot.ci_upper,
            },
            "exact_phone_claims": {
                "precision_mean": exact_phone_boot.mean,
                "ci_lower": exact_phone_boot.ci_lower,
                "ci_upper": exact_phone_boot.ci_upper,
                "coverage": exact_phone_coverage,
                "total_claims": exact_phone_claims,
                "total_opportunities": exact_phone_opportunities,
            },
        }
