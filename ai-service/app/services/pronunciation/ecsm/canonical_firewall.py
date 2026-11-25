"""
ECSM-v1 / EC-PRISM Phase P3: Canonical Information Firewall Proof & Late Comparator.
Provides architectural firewall enforcement, counterfactual canonical tests,
Canonical Susceptibility Score (CSS), Canonical Override Rate (COR_CANON),
and Late Comparator modeling without contaminating realized-phone acoustics.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score, roc_curve
import torch
import torch.nn as nn
import torch.nn.functional as F

from app.services.pronunciation.ecsm.articulatory_reality import (
    FACTOR_VOCABULARIES,
    extract_articulatory_ground_truth,
)


def compute_jensen_shannon_divergence(p: np.ndarray, q: np.ndarray, eps: float = 1e-9) -> float:
    """
    Computes Jensen-Shannon divergence JS(P || Q) in base 2.
    JS(P || Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M) where M = 0.5 * (P + Q).
    Bounded in [0, 1].
    """
    p_safe = np.clip(p, eps, 1.0)
    p_safe /= np.sum(p_safe)
    q_safe = np.clip(q, eps, 1.0)
    q_safe /= np.sum(q_safe)
    m = 0.5 * (p_safe + q_safe)
    
    kl_pm = np.sum(p_safe * np.log2(p_safe / m))
    kl_qm = np.sum(q_safe * np.log2(q_safe / m))
    js = 0.5 * (kl_pm + kl_qm)
    return float(np.clip(js, 0.0, 1.0))


def compute_canonical_susceptibility_score(
    posteriors_c1: np.ndarray,
    posteriors_c2: np.ndarray,
) -> float:
    """
    Computes CSS for identical acoustic evidence across two canonical references:
    CSS(x, c1, c2) = JS(P_A(. | x, c1), P_A(. | x, c2))
    Target: CSS == 0.0 (up to numerical tolerance 1e-6) for firewall-protected models.
    """
    return compute_jensen_shannon_divergence(posteriors_c1, posteriors_c2)


def compute_canonical_override_rate(
    acoustic_predictions: Sequence[str],
    final_observed_predictions: Sequence[str],
    expected_canonical_phones: Sequence[str],
) -> Dict[str, Any]:
    """
    Computes Canonical Override Rate (COR_CANON).
    Eligible cases: acoustic evidence favors non-canonical phone (p_alt != c).
    Override count: cases where final observed phone is rewritten toward c solely after canonical conditioning.
    Target: COR_CANON == 0.0.
    """
    total_eligible = 0
    overrides = 0
    
    for p_ac, p_fin, c in zip(acoustic_predictions, final_observed_predictions, expected_canonical_phones):
        if p_ac != c:
            total_eligible += 1
            if p_fin == c:
                overrides += 1
                
    override_rate = float(overrides / total_eligible) if total_eligible > 0 else 0.0
    return {
        "eligibleAcousticConflictCount": total_eligible,
        "canonicalOverrideCount": overrides,
        "canonicalOverrideRate": override_rate,
        "targetCompliance": bool(override_rate < 1e-4),
    }


class EarlyCanonicalControl(nn.Module):
    """
    Candidate C0: Early Canonical Control (Confirmation-Bias Control).
    Intentionally injects canonical phone embedding prior to acoustic classification.
    Used as an empirical control to measure confirmation bias and false acceptance.
    """

    def __init__(self, in_features: int = 1416, vocab_size: int = 41, embed_dim: int = 64):
        super().__init__()
        self.in_features = in_features
        self.vocab_size = vocab_size
        self.canonical_embedding = nn.Embedding(vocab_size, embed_dim)
        self.classifier = nn.Sequential(
            nn.Linear(in_features + embed_dim, 256),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(256, vocab_size),
        )

    def forward(self, acoustic_feat: torch.Tensor, canonical_idx: torch.Tensor) -> torch.Tensor:
        c_emb = self.canonical_embedding(canonical_idx)
        fused = torch.cat([acoustic_feat, c_emb], dim=-1)
        return self.classifier(fused)


class LateCanonicalComparator(nn.Module):
    """
    Candidate C1 & C2: Late Canonical Comparator.
    Consumes frozen acoustic scores, metric margin, articulatory match features,
    and canonical phone index to output P(error | acoustic, canonical).
    Does NOT rewrite or modify the acoustic phone posterior.
    """

    def __init__(
        self,
        num_acoustic_features: int = 14,
        canonical_vocab_size: int = 41,
        canonical_embed_dim: int = 32,
        hidden_dim: int = 64,
        stop_gradient: bool = False,
    ):
        super().__init__()
        self.num_acoustic_features = num_acoustic_features
        self.stop_gradient = stop_gradient
        self.canonical_embedding = nn.Embedding(canonical_vocab_size, canonical_embed_dim)
        
        self.mlp = nn.Sequential(
            nn.Linear(num_acoustic_features + canonical_embed_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(0.1),
            nn.Linear(hidden_dim, 32),
            nn.SiLU(),
            nn.Linear(32, 1),
        )

    def forward(
        self,
        acoustic_summary_features: torch.Tensor,
        canonical_idx: torch.Tensor,
    ) -> torch.Tensor:
        """
        Outputs logit for P(error).
        """
        feat = acoustic_summary_features
        if self.stop_gradient:
            feat = feat.detach()
            
        c_emb = self.canonical_embedding(canonical_idx)
        fused = torch.cat([feat, c_emb], dim=-1)
        return self.mlp(fused).squeeze(-1)


def build_comparator_feature_vector(
    top_knn_scores: Sequence[float],
    top_knn_phones: Sequence[str],
    articulatory_pred: Dict[str, Any],
    expected_phone: str,
    real_phones: Sequence[str],
) -> np.ndarray:
    """
    Constructs late-comparator input vector from purely acoustic evidence and expected target.
    Vector structure (14 dimensions):
    [0]: Top-1 acoustic score / probability
    [1]: Top-1 margin (score[0] - score[1])
    [2]: Top-3 entropy
    [3]: Canonical phone score in acoustic top-k (0.0 if not present)
    [4]: Canonical phone rank in acoustic top-k (normalized, 1.0 if not present)
    [5]: Acoustic Top-1 matches expected phone (binary)
    [6]: Consonant Place match (binary)
    [7]: Consonant Manner match (binary)
    [8]: Voicing match (binary)
    [9]: Vowel Height match (binary)
    [10]: Vowel Backness match (binary)
    [11]: Vowel Rounding match (binary)
    [12]: Vowel Tenseness match (binary)
    [13]: Articulatory agreement confidence (mean confidence of top factors)
    """
    scores = np.array(top_knn_scores[:5], dtype=np.float32) if top_knn_scores else np.zeros(5, dtype=np.float32)
    s0 = float(scores[0]) if len(scores) > 0 else 0.0
    s1 = float(scores[1]) if len(scores) > 1 else 0.0
    margin = float(s0 - s1)
    
    # Entropy
    probs = np.exp(scores - np.max(scores))
    probs /= (np.sum(probs) + 1e-9)
    entropy = float(-np.sum(probs * np.log(probs + 1e-9)))
    
    # Canonical presence
    canon_score = 0.0
    canon_rank = 1.0
    for r_idx, p in enumerate(top_knn_phones):
        if p == expected_phone:
            canon_score = float(scores[r_idx]) if r_idx < len(scores) else 0.0
            canon_rank = float(r_idx) / max(1.0, float(len(top_knn_phones)))
            break
            
    top1_match = 1.0 if (top_knn_phones and top_knn_phones[0] == expected_phone) else 0.0
    
    # Articulatory matches
    expected_gt = extract_articulatory_ground_truth(expected_phone)
    place_match = 1.0 if (expected_gt.place_idx >= 0 and articulatory_pred.get("place", {}).get("topValue") == FACTOR_VOCABULARIES["place"][expected_gt.place_idx]) else 0.0
    manner_match = 1.0 if (expected_gt.manner_idx >= 0 and articulatory_pred.get("manner", {}).get("topValue") == FACTOR_VOCABULARIES["manner"][expected_gt.manner_idx]) else 0.0
    voicing_match = 1.0 if (expected_gt.voicing_idx >= 0 and articulatory_pred.get("voicing", {}).get("topValue") == FACTOR_VOCABULARIES["voicing"][expected_gt.voicing_idx]) else 0.0
    
    height_match = 1.0 if (expected_gt.height_idx >= 0 and articulatory_pred.get("height", {}).get("topValue") == FACTOR_VOCABULARIES["height"][expected_gt.height_idx]) else 0.0
    backness_match = 1.0 if (expected_gt.backness_idx >= 0 and articulatory_pred.get("backness", {}).get("topValue") == FACTOR_VOCABULARIES["backness"][expected_gt.backness_idx]) else 0.0
    rounding_match = 1.0 if (expected_gt.rounding_idx >= 0 and articulatory_pred.get("rounding", {}).get("topValue") == FACTOR_VOCABULARIES["rounding"][expected_gt.rounding_idx]) else 0.0
    tenseness_match = 1.0 if (expected_gt.tenseness_idx >= 0 and articulatory_pred.get("tenseness", {}).get("topValue") == FACTOR_VOCABULARIES["tenseness"][expected_gt.tenseness_idx]) else 0.0
    
    confs = [articulatory_pred.get(f, {}).get("confidence", 0.5) for f in FACTOR_VOCABULARIES]
    mean_conf = float(np.mean(confs))
    
    return np.array([
        s0,
        margin,
        entropy,
        canon_score,
        canon_rank,
        top1_match,
        place_match,
        manner_match,
        voicing_match,
        height_match,
        backness_match,
        rounding_match,
        tenseness_match,
        mean_conf,
    ], dtype=np.float32)


def compute_detection_metrics(
    y_true_error: np.ndarray,
    y_score_error: np.ndarray,
    threshold: float = 0.5,
) -> Dict[str, float]:
    """
    Computes Error Detection Metrics with rigorous FAR/FRR definitions:
    - POSITIVE = True Mispronunciation / Error (y_true_error == 1)
    - NEGATIVE = Correct Pronunciation (y_true_error == 0)
    - FALSE ACCEPTANCE (FAR) = Actual error accepted as correct (y_true == 1, y_pred == 0) / Total Positive
    - FALSE REJECTION (FRR) = Correct pronunciation rejected as error (y_true == 0, y_pred == 1) / Total Negative
    """
    y_true = np.asarray(y_true_error, dtype=int)
    y_score = np.asarray(y_score_error, dtype=float)
    
    total_pos = int(np.sum(y_true == 1))
    total_neg = int(np.sum(y_true == 0))
    
    if total_pos == 0 or total_neg == 0:
        return {
            "rocAuc": 0.5,
            "prAuc": 0.0,
            "eer": 0.5,
            "far": 0.0,
            "frr": 0.0,
            "accuracy": 1.0,
            "totalPositives": total_pos,
            "totalNegatives": total_neg,
            "falseAcceptanceCount": 0,
            "falseRejectionCount": 0,
        }
        
    roc_auc = float(roc_auc_score(y_true, y_score))
    pr_auc = float(average_precision_score(y_true, y_score))
    
    # EER calculation
    fpr_arr, tpr_arr, thresh_arr = roc_curve(y_true, y_score)
    fnr_arr = 1.0 - tpr_arr
    eer_idx = int(np.nanargmin(np.abs(fnr_arr - fpr_arr)))
    eer = float(0.5 * (fpr_arr[eer_idx] + fnr_arr[eer_idx]))
    
    # Threshold metrics
    y_pred = (y_score >= threshold).astype(int)
    # False Acceptances: y_true == 1, y_pred == 0
    false_acceptances = int(np.sum((y_true == 1) & (y_pred == 0)))
    far = float(false_acceptances / total_pos) if total_pos > 0 else 0.0
    
    # False Rejections: y_true == 0, y_pred == 1
    false_rejections = int(np.sum((y_true == 0) & (y_pred == 1)))
    frr = float(false_rejections / total_neg) if total_neg > 0 else 0.0
    
    acc = float(np.mean(y_true == y_pred))
    
    return {
        "rocAuc": roc_auc,
        "prAuc": pr_auc,
        "eer": eer,
        "far": far,
        "frr": frr,
        "accuracy": acc,
        "totalPositives": total_pos,
        "totalNegatives": total_neg,
        "falseAcceptanceCount": false_acceptances,
        "falseRejectionCount": false_rejections,
    }
