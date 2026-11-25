"""
ECSM-v1 / EC-PRISM Phase P5: Trust & Uncertainty Layer.
Dual calibration (Error Detection & Exact Phone), Conformal Candidate Sets,
Selective Prediction Risk-Coverage, OOD Evidence Fusion, and Structured Abstention.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss


class AbstentionReason(str, Enum):
    LOW_EXACT_CONFIDENCE = "LOW_EXACT_CONFIDENCE"
    AMBIGUOUS_PHONE_SET = "AMBIGUOUS_PHONE_SET"
    ALIGNMENT_UNCERTAIN = "ALIGNMENT_UNCERTAIN"
    OOD_ACOUSTIC = "OOD_ACOUSTIC"
    CHANNEL_SHIFT = "CHANNEL_SHIFT"
    LOW_SIGNAL_QUALITY = "LOW_SIGNAL_QUALITY"
    INSUFFICIENT_PHONE_SUPPORT = "INSUFFICIENT_PHONE_SUPPORT"
    GRAPH_AMBIGUITY = "GRAPH_AMBIGUITY"


@dataclass
class CalibratedDecision:
    error_probability: float
    candidate_observed_phoneme: Optional[str]
    exact_phone_confidence: float
    candidate_set: List[str]
    abstained: bool
    abstention_reason: Optional[AbstentionReason]
    ood_score: float
    alignment_uncertainty: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "errorProbability": float(self.error_probability),
            "candidateObservedPhoneme": self.candidate_observed_phoneme,
            "exactPhoneConfidence": float(self.exact_phone_confidence),
            "candidateSet": self.candidate_set,
            "abstained": self.abstained,
            "abstentionReason": self.abstention_reason.value if self.abstention_reason else None,
            "oodScore": float(self.ood_score),
            "alignmentUncertainty": float(self.alignment_uncertainty),
        }


def compute_expected_calibration_error(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    n_bins: int = 10,
) -> float:
    """
    Computes Expected Calibration Error (ECE) with equal-width binning.
    """
    y_true = np.asarray(y_true, dtype=int)
    y_prob = np.asarray(y_prob, dtype=float)
    
    bin_boundaries = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    total_samples = len(y_true)
    
    if total_samples == 0:
        return 0.0
        
    for i in range(n_bins):
        bin_lower = bin_boundaries[i]
        bin_upper = bin_boundaries[i + 1]
        
        if i == n_bins - 1:
            in_bin = (y_prob >= bin_lower) & (y_prob <= bin_upper)
        else:
            in_bin = (y_prob >= bin_lower) & (y_prob < bin_upper)
            
        bin_size = np.sum(in_bin)
        if bin_size > 0:
            bin_acc = np.mean(y_true[in_bin])
            bin_conf = np.mean(y_prob[in_bin])
            ece += (bin_size / total_samples) * abs(bin_acc - bin_conf)
            
    return float(ece)


class BinaryErrorCalibrator:
    """
    Calibrates binary error detection probabilities P(error | audio, expected).
    Supports B0 (raw), B1 (Platt scaling), B2 (Isotonic).
    """

    def __init__(self, method: str = "B1"):
        self.method = method
        self.platt_model: Optional[LogisticRegression] = None
        self.iso_model: Optional[IsotonicRegression] = None

    def fit(self, scores: np.ndarray, labels: np.ndarray) -> "BinaryErrorCalibrator":
        scores = np.asarray(scores, dtype=float).reshape(-1, 1)
        labels = np.asarray(labels, dtype=int)
        
        if len(np.unique(labels)) < 2:
            self.platt_model = None
            self.iso_model = None
            return self
        
        if self.method == "B1":
            # Platt scaling
            self.platt_model = LogisticRegression(C=1.0, solver="lbfgs")
            self.platt_model.fit(scores, labels)
        elif self.method == "B2":
            # Isotonic regression
            self.iso_model = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
            self.iso_model.fit(scores.ravel(), labels)
            
        return self

    def predict_proba(self, scores: np.ndarray) -> np.ndarray:
        scores = np.asarray(scores, dtype=float)
        if self.method == "B0":
            return np.clip(scores, 0.0, 1.0)
        elif self.method == "B1" and self.platt_model is not None:
            return self.platt_model.predict_proba(scores.reshape(-1, 1))[:, 1]
        elif self.method == "B2" and self.iso_model is not None:
            return self.iso_model.predict(scores.ravel())
        return np.clip(scores, 0.0, 1.0)


class MulticlassTemperatureCalibrator:
    """
    Calibrates exact phone multiclass probabilities using temperature scaling.
    Supports M0 (raw), M1 (scalar temperature), M2 (class-aware).
    """

    def __init__(self, method: str = "M1", temperature: float = 1.0):
        self.method = method
        self.temperature = max(1e-3, temperature)

    def fit(self, logits: np.ndarray, labels: np.ndarray) -> "MulticlassTemperatureCalibrator":
        if self.method == "M0":
            self.temperature = 1.0
            return self

        # Grid search over optimal temperature on calibration set
        best_nll = 1e9
        best_t = 1.0
        for t in np.linspace(0.2, 3.0, 50):
            scaled_logits = logits / t
            # Softmax
            exp_l = np.exp(scaled_logits - np.max(scaled_logits, axis=1, keepdims=True))
            probs = exp_l / np.sum(exp_l, axis=1, keepdims=True)
            
            # Compute NLL
            loss = log_loss(labels, probs, labels=np.arange(logits.shape[1]))
            if loss < best_nll:
                best_nll = loss
                best_t = float(t)
                
        self.temperature = best_t
        return self

    def scale_probabilities(self, probs: np.ndarray) -> np.ndarray:
        probs = np.asarray(probs, dtype=float)
        if self.method == "M0" or self.temperature == 1.0:
            return probs
            
        # Convert probs to pseudo-logits, scale, and re-normalize
        eps = 1e-9
        log_p = np.log(np.clip(probs, eps, 1.0 - eps))
        scaled = log_p / self.temperature
        exp_s = np.exp(scaled - np.max(scaled, axis=-1, keepdims=True))
        return exp_s / np.sum(exp_s, axis=-1, keepdims=True)


class ConformalPredictionSet:
    """
    Computes split conformal / Adaptive Prediction Sets (APS) with target coverage (1 - alpha).
    """

    def __init__(self, alpha: float = 0.10):
        self.alpha = alpha
        self.q_hat: float = 0.95

    def fit(self, cal_probs: np.ndarray, cal_true_indices: np.ndarray) -> "ConformalPredictionSet":
        """
        Calibrates non-conformity score quantile on held-out calibration set.
        Score s_i = 1 - p(y_i).
        """
        n = len(cal_probs)
        if n == 0:
            return self
            
        scores = []
        for i in range(n):
            y_idx = int(cal_true_indices[i])
            p_y = float(cal_probs[i, y_idx]) if y_idx < cal_probs.shape[1] else 0.0
            scores.append(1.0 - p_y)
            
        scores = np.sort(scores)
        # Compute conformal quantile (1 - alpha) * (1 + 1/n)
        q_idx = int(np.ceil((1.0 - self.alpha) * (n + 1))) - 1
        q_idx = min(n - 1, max(0, q_idx))
        self.q_hat = float(scores[q_idx])
        return self

    def predict_set(
        self,
        probs: np.ndarray,
        phone_vocab: Sequence[str],
    ) -> List[List[str]]:
        """
        Returns prediction set for each instance: { p : p(p) >= 1 - q_hat }.
        """
        threshold = max(0.01, 1.0 - self.q_hat)
        sets = []
        for row in probs:
            cands = [phone_vocab[idx] for idx, p in enumerate(row) if p >= threshold and idx < len(phone_vocab)]
            if not cands:
                # Guarantee non-empty set with Top-1 fallback
                top_idx = int(np.argmax(row))
                cands = [phone_vocab[top_idx]]
            sets.append(cands)
        return sets


class OODDetector:
    """
    Detects out-of-distribution acoustic representations and channel shifts.
    Combines kNN distance, posterior entropy, and alignment margin.
    """

    def __init__(
        self,
        method: str = "O2",
        distance_threshold: float = 0.75,
        entropy_threshold: float = 2.5,
    ):
        self.method = method
        self.distance_threshold = distance_threshold
        self.entropy_threshold = entropy_threshold
        self.calibrated_fusion: Optional[LogisticRegression] = None

    def fit_fusion(self, in_domain_features: np.ndarray, stress_features: np.ndarray) -> "OODDetector":
        """
        Fits small logistic fusion classifier on in-domain vs synthetic stress evidence.
        """
        x_all = np.vstack([in_domain_features, stress_features])
        y_all = np.array([0] * len(in_domain_features) + [1] * len(stress_features))
        self.calibrated_fusion = LogisticRegression(C=0.5, solver="lbfgs")
        self.calibrated_fusion.fit(x_all, y_all)
        return self

    def compute_ood_score(
        self,
        knn_dist: float,
        posterior_entropy: float,
        alignment_entropy: float,
        margin: float,
    ) -> float:
        feat = np.array([knn_dist, posterior_entropy, alignment_entropy, 1.0 - margin], dtype=np.float32)
        if self.method == "O0":
            return 0.0
        elif self.method == "O1":
            return float(knn_dist)
        elif self.method == "O2" and self.calibrated_fusion is not None:
            return float(self.calibrated_fusion.predict_proba(feat.reshape(1, -1))[0, 1])
        else:
            # Normalized heuristic combination
            norm_dist = min(1.0, knn_dist / self.distance_threshold)
            norm_ent = min(1.0, posterior_entropy / self.entropy_threshold)
            return float(0.6 * norm_dist + 0.4 * norm_ent)


def evaluate_selective_prediction(
    true_phones: Sequence[str],
    predicted_phones: Sequence[str],
    confidences: Sequence[float],
) -> Dict[str, Any]:
    """
    Computes risk-coverage curve and coverage @ targeted precision levels (90%, 95%).
    """
    y_true = np.asarray(true_phones)
    y_pred = np.asarray(predicted_phones)
    confs = np.asarray(confidences, dtype=float)
    
    correct = (y_true == y_pred).astype(int)
    total = len(correct)
    
    order = np.argsort(-confs)
    sorted_correct = correct[order]
    sorted_confs = confs[order]
    
    prec_at_cov = {}
    for cov_target in [0.10, 0.20, 0.30, 0.40, 0.50]:
        k = max(1, int(round(cov_target * total)))
        sel_correct = sorted_correct[:k]
        prec = float(np.mean(sel_correct))
        thresh = float(sorted_confs[k - 1])
        prec_at_cov[f"precision_at_{int(cov_target*100)}"] = {
            "targetCoverage": cov_target,
            "actualCoverage": float(k / total),
            "precision": prec,
            "threshold": thresh,
            "selectedCount": k,
        }
        
    cov_at_prec = {}
    cum_correct = np.cumsum(sorted_correct)
    cum_total = np.arange(1, total + 1)
    cum_prec = cum_correct / cum_total
    
    for prec_target in [0.90, 0.95]:
        valid_idx = np.where(cum_prec >= prec_target)[0]
        if len(valid_idx) > 0:
            max_i = valid_idx[-1]
            cov = float((max_i + 1) / total)
            cov_at_prec[f"coverage_at_{int(prec_target*100)}"] = {
                "targetPrecision": prec_target,
                "coverage": cov,
                "precision": float(cum_prec[max_i]),
                "threshold": float(sorted_confs[max_i]),
                "selectedCount": int(max_i + 1),
                "status": "ACHIEVED",
            }
        else:
            cov_at_prec[f"coverage_at_{int(prec_target*100)}"] = {
                "targetPrecision": prec_target,
                "coverage": 0.0,
                "precision": 0.0,
                "threshold": 1.0,
                "selectedCount": 0,
                "status": "NOT_REACHED",
            }
            
    return {
        "precisionAtCoverage": prec_at_cov,
        "coverageAtPrecision": cov_at_prec,
        "totalSamples": total,
    }


def compute_false_confident_diagnosis_rate(
    true_phones: Sequence[str],
    decisions: Sequence[CalibratedDecision],
) -> Dict[str, float]:
    """
    Computes FCDR = (incorrect exact-phone emissions) / (total exact-phone emissions).
    """
    emitted_correct = 0
    emitted_incorrect = 0
    abstained_count = 0
    
    for t_p, dec in zip(true_phones, decisions):
        if dec.abstained or dec.candidate_observed_phoneme is None:
            abstained_count += 1
        else:
            if dec.candidate_observed_phoneme == t_p:
                emitted_correct += 1
            else:
                emitted_incorrect += 1
                
    total_emitted = emitted_correct + emitted_incorrect
    fcdr = float(emitted_incorrect / total_emitted) if total_emitted > 0 else 0.0
    emission_rate = float(total_emitted / len(decisions)) if decisions else 0.0
    
    return {
        "fcdr": fcdr,
        "totalEmitted": total_emitted,
        "emittedCorrect": emitted_correct,
        "emittedIncorrect": emitted_incorrect,
        "abstainedCount": abstained_count,
        "emissionRate": emission_rate,
        "abstentionRate": float(abstained_count / len(decisions)) if decisions else 0.0,
    }
