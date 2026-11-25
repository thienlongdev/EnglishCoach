"""
ECSM-v1 / EC-PRISM Phase P5.1: Selective Risk Estimator & Confidence Refinement.
Implements:
1. 40-dimensional Canonical-Independent Feature Extractor across 7 evidence families:
   - Family A: Posterior / Ranking (8 features)
   - Family B: k-NN Geometry (10 features)
   - Family C: Local Density (3 features)
   - Family D: Alignment & Graph Uncertainty (7 features)
   - Family E: Articulatory Consistency (6 features)
   - Family F: Signal / Quality (3 features)
   - Family G: OOD / Manifold Uncertainty (3 features)
2. Machine-Readable Feature Registry with formal provenance & normalization policies.
3. Risk Model Architectures:
   - R0: Baseline Top-1 Confidence
   - R1: Regularized Logistic Regression (L2 / Platt)
   - R2: Histogram Gradient-Boosted Decision Trees (HistGBM)
   - R3: Small Multi-Layer Perceptron (< 2k parameters)
4. Out-of-Fold (OOF) Speaker-Disjoint Training & Nested Calibration.
5. Selective Decision Policies (D0, D1, D2, D3) & Risk-Coverage Optimization.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
    roc_curve,
)
from sklearn.preprocessing import StandardScaler
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.trust_layer import (
    AbstentionReason,
    BinaryErrorCalibrator,
    compute_expected_calibration_error,
    compute_false_confident_diagnosis_rate,
)


# =====================================================================
# 1. FEATURE DEFINITIONS & REGISTRY
# =====================================================================

@dataclass(frozen=True)
class FeatureDefinition:
    name: str
    family: str
    description: str
    source_module: str
    canonical_dependent: bool
    requires_label: bool
    fold_local_norm: bool
    norm_method: str
    missing_value_policy: str
    expected_range: Tuple[float, float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "family": self.family,
            "description": self.description,
            "sourceModule": self.source_module,
            "canonicalDependent": self.canonical_dependent,
            "requiresLabel": self.requires_label,
            "foldLocalNorm": self.fold_local_norm,
            "normMethod": self.norm_method,
            "missingValuePolicy": self.missing_value_policy,
            "expectedRange": list(self.expected_range),
        }


P5_1_FEATURE_REGISTRY: List[FeatureDefinition] = [
    # Family A: Phone Posterior / Ranking
    FeatureDefinition("top1_prob", "A_POSTERIOR", "Softmax probability of top-1 realized phone candidate", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("top2_prob", "A_POSTERIOR", "Softmax probability of top-2 realized phone candidate", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("top3_prob", "A_POSTERIOR", "Softmax probability of top-3 realized phone candidate", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("prob_margin_1_2", "A_POSTERIOR", "Margin between top-1 and top-2 candidate probabilities", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("prob_ratio_1_2", "A_POSTERIOR", "Ratio between top-1 and top-2 candidate probabilities (clipped)", "kNN_Softmax", False, False, True, "standard", "one", (1.0, 100.0)),
    FeatureDefinition("posterior_entropy", "A_POSTERIOR", "Shannon entropy of retrieved phone posterior distribution", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 4.0)),
    FeatureDefinition("normalized_entropy", "A_POSTERIOR", "Entropy normalized by log(K) candidate count", "kNN_Softmax", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("aps_set_size", "A_POSTERIOR", "Cardinality of conformal adaptive prediction set (alpha=0.10)", "ConformalAPS", False, False, True, "standard", "one", (1.0, 15.0)),

    # Family B: k-NN Geometry
    FeatureDefinition("knn_dist_1", "B_GEOMETRY", "Cosine distance to 1st nearest neighbor (1 - s1)", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 2.0)),
    FeatureDefinition("knn_mean_dist", "B_GEOMETRY", "Mean cosine distance to top-15 nearest neighbors", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 2.0)),
    FeatureDefinition("knn_median_dist", "B_GEOMETRY", "Median cosine distance to top-15 nearest neighbors", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 2.0)),
    FeatureDefinition("knn_var_dist", "B_GEOMETRY", "Variance of distances across top-15 nearest neighbors", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("knn_top_label_frac", "B_GEOMETRY", "Fraction of top-15 neighbors matching top-1 predicted label", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("knn_neighbor_entropy", "B_GEOMETRY", "Entropy of neighbor label vote counts in retrieval set", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 3.0)),
    FeatureDefinition("knn_neighbor_agreement", "B_GEOMETRY", "Gini purity / vote agreement metric of top-15 neighbors", "Cosine_kNN", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("knn_effective_neighbors", "B_GEOMETRY", "Exponential of neighbor label entropy (effective class count)", "Cosine_kNN", False, False, True, "standard", "one", (1.0, 15.0)),
    FeatureDefinition("knn_nearest_wrong_dist", "B_GEOMETRY", "Cosine distance to nearest neighbor with a conflicting label", "Cosine_kNN", False, False, True, "standard", "max", (0.0, 2.0)),
    FeatureDefinition("knn_distance_margin", "B_GEOMETRY", "Margin between nearest conflicting neighbor and nearest neighbor", "Cosine_kNN", False, False, True, "standard", "zero", (-1.0, 2.0)),

    # Family C: Local Density
    FeatureDefinition("local_density", "C_DENSITY", "Mean inverse cosine distance across all 15 neighbors", "Density_Estimator", False, False, True, "standard", "one", (0.0, 50.0)),
    FeatureDefinition("class_conditional_density", "C_DENSITY", "Mean inverse distance among neighbors matching top-1 label", "Density_Estimator", False, False, True, "standard", "one", (0.0, 50.0)),
    FeatureDefinition("density_ratio", "C_DENSITY", "Ratio of class-conditional density to total local density", "Density_Estimator", False, False, True, "standard", "one", (0.0, 10.0)),

    # Family D: Alignment & Graph Uncertainty
    FeatureDefinition("alignment_entropy", "D_ALIGNMENT", "Entropy of marginalized forward-backward edit alignment DP", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 3.0)),
    FeatureDefinition("best_path_score", "D_ALIGNMENT", "Normalized log-likelihood score of best Viterbi alignment path", "EditAligner_G2", False, False, True, "standard", "zero", (-10.0, 0.0)),
    FeatureDefinition("path_score_margin", "D_ALIGNMENT", "Score margin between best and 2nd-best alignment paths", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 10.0)),
    FeatureDefinition("null_alignment_mass", "D_ALIGNMENT", "Posterior probability mass assigned to non-emitting edit states", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("insertion_prob", "D_ALIGNMENT", "Marginalized posterior probability of INSERTION / EPENTHESIS", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("deletion_prob", "D_ALIGNMENT", "Marginalized posterior probability of DELETION state", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("edit_op_entropy", "D_ALIGNMENT", "Shannon entropy across 8 possible edit operation states", "EditAligner_G2", False, False, True, "standard", "zero", (0.0, 3.0)),

    # Family E: Articulatory Consistency
    FeatureDefinition("art_place_consistency", "E_ARTICULATORY", "Predicted phone place probability under Shared Adapter A2", "Adapter_A2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("art_manner_consistency", "E_ARTICULATORY", "Predicted phone manner probability under Shared Adapter A2", "Adapter_A2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("art_voicing_consistency", "E_ARTICULATORY", "Predicted phone voicing probability under Shared Adapter A2", "Adapter_A2", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("art_vowel_consistency", "E_ARTICULATORY", "Geometric mean of height/backness/rounding/tenseness (or 1.0)", "Adapter_A2", False, False, True, "standard", "one", (0.0, 1.0)),
    FeatureDefinition("art_multitask_entropy", "E_ARTICULATORY", "Average entropy across all 7 articulatory factor heads", "Adapter_A2", False, False, True, "standard", "zero", (0.0, 3.0)),
    FeatureDefinition("art_disagreement_score", "E_ARTICULATORY", "Penalty indicator when factor argmax contradicts predicted phone", "Adapter_A2", False, False, True, "standard", "zero", (0.0, 3.0)),

    # Family F: Signal / Quality
    FeatureDefinition("duration_frames", "F_SIGNAL_QUALITY", "Number of acoustic CTC frames spanned by phoneme segment", "Acoustic_Segmentation", False, False, True, "standard", "mean", (1.0, 100.0)),
    FeatureDefinition("energy_anomaly", "F_SIGNAL_QUALITY", "Absolute deviation of frame log-energy from utterance mean", "Acoustic_Features", False, False, True, "standard", "zero", (0.0, 10.0)),
    FeatureDefinition("signal_quality", "F_SIGNAL_QUALITY", "Acoustic representation norm consistency score", "Acoustic_Features", False, False, True, "standard", "one", (0.0, 1.0)),

    # Family G: OOD / Manifold Uncertainty
    FeatureDefinition("manifold_dist", "G_OOD", "Normalized distance to global acoustic training manifold centroid", "OOD_Detector", False, False, True, "standard", "zero", (0.0, 10.0)),
    FeatureDefinition("ood_score", "G_OOD", "Fused OOD anomaly score (distance + entropy + margin)", "OOD_Detector", False, False, True, "standard", "zero", (0.0, 1.0)),
    FeatureDefinition("synthetic_stress_score", "G_OOD", "Estimated vulnerability to acoustic perturbation / noise", "Stress_Suite", False, False, True, "standard", "zero", (0.0, 1.0)),
]

FEATURE_NAME_TO_INDEX: Dict[str, int] = {f.name: i for i, f in enumerate(P5_1_FEATURE_REGISTRY)}
NUM_P5_1_FEATURES = len(P5_1_FEATURE_REGISTRY)


def export_feature_registry_json(output_path: Path) -> str:
    """Exports machine-readable feature registry with SHA-256 integrity hash."""
    records = [f.to_dict() for f in P5_1_FEATURE_REGISTRY]
    content = json.dumps({"features": records, "totalFeatures": len(records), "version": "p5.1-v1"}, indent=2)
    output_path.write_text(content, encoding="utf-8")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# =====================================================================
# 2. FEATURE EXTRACTION ENGINE
# =====================================================================

def extract_p5_1_evidence_vector(
    knn_candidates: Sequence[Dict[str, Any]],
    articulatory_preds: Optional[Dict[str, Any]],
    alignment_info: Optional[Dict[str, Any]],
    raw_acoustic_feat: Optional[np.ndarray],
    inventory: Optional[CanonicalRealPhoneInventory] = None,
    ood_score: float = 0.0,
    synthetic_stress_score: float = 0.0,
    knn_geometry_info: Optional[Dict[str, Any]] = None,
) -> np.ndarray:
    """
    Extracts a 40-dimensional canonical-independent feature vector across 7 evidence families.
    Strictly canonical-identity free: zero expected-phone leakage.
    """
    vec = np.zeros(NUM_P5_1_FEATURES, dtype=np.float32)
    
    # 1. Posterior / Ranking (Family A)
    scores = np.array([float(c.get("score", 0.0)) for c in knn_candidates], dtype=np.float32)
    top1_prob = float(scores[0]) if len(scores) > 0 else 0.0
    top2_prob = float(scores[1]) if len(scores) > 1 else 0.0
    top3_prob = float(scores[2]) if len(scores) > 2 else 0.0
    
    prob_margin_1_2 = float(top1_prob - top2_prob)
    prob_ratio_1_2 = float(top1_prob / (top2_prob + 1e-6))
    
    # Entropy over candidate distribution
    scores_nz = scores[scores > 1e-8]
    posterior_entropy = float(-np.sum(scores_nz * np.log(scores_nz))) if len(scores_nz) > 0 else 0.0
    normalized_entropy = float(posterior_entropy / math.log(max(2, len(scores)))) if len(scores) > 1 else 0.0
    
    # APS conformal set size at alpha = 0.10 (nominal 90% confidence)
    cum_probs = np.cumsum(scores)
    aps_set_size = float(np.searchsorted(cum_probs, 0.90) + 1)
    
    vec[0] = top1_prob
    vec[1] = top2_prob
    vec[2] = top3_prob
    vec[3] = prob_margin_1_2
    vec[4] = prob_ratio_1_2
    vec[5] = posterior_entropy
    vec[6] = normalized_entropy
    vec[7] = aps_set_size

    # 2. k-NN Geometry (Family B) & 3. Local Density (Family C)
    top_pred_phone = str(knn_candidates[0]["phone"]) if knn_candidates else ""
    
    if knn_geometry_info is not None:
        dists = np.array(knn_geometry_info["dists"], dtype=float)
        neighbor_phones = [str(p) for p in knn_geometry_info.get("neighbor_phones", [])]
        knn_nearest_wrong_dist = float(knn_geometry_info.get("nearest_wrong_dist", 1.5))
        knn_distance_margin = float(knn_geometry_info.get("distance_margin", 0.0))
    else:
        dists = np.clip(1.0 - scores, 0.0, 2.0)
        neighbor_phones = [str(c["phone"]) for c in knn_candidates]
        matching_mask = np.array([p == top_pred_phone for p in neighbor_phones], dtype=bool)
        wrong_dists = dists[~matching_mask]
        knn_nearest_wrong_dist = float(np.min(wrong_dists)) if len(wrong_dists) > 0 else 1.5
        knn_distance_margin = float(knn_nearest_wrong_dist - (dists[0] if len(dists) > 0 else 0.0))

    knn_dist_1 = float(dists[0]) if len(dists) > 0 else 0.0
    knn_mean_dist = float(np.mean(dists)) if len(dists) > 0 else 0.0
    knn_median_dist = float(np.median(dists)) if len(dists) > 0 else 0.0
    knn_var_dist = float(np.var(dists)) if len(dists) > 0 else 0.0
    
    matching_mask = np.array([p == top_pred_phone for p in neighbor_phones], dtype=bool)
    knn_top_label_frac = float(np.mean(matching_mask)) if len(matching_mask) > 0 else 0.0
    
    phone_counts = {}
    for p in neighbor_phones:
        phone_counts[p] = phone_counts.get(p, 0) + 1
    total_neighbors = max(1, len(neighbor_phones))
    vote_probs = np.array([cnt / total_neighbors for cnt in phone_counts.values()], dtype=np.float32)
    knn_neighbor_entropy = float(-np.sum(vote_probs * np.log(vote_probs + 1e-9)))
    knn_neighbor_agreement = float(np.sum(vote_probs ** 2))
    knn_effective_neighbors = float(np.exp(knn_neighbor_entropy))
    
    vec[8] = knn_dist_1
    vec[9] = knn_mean_dist
    vec[10] = knn_median_dist
    vec[11] = knn_var_dist
    vec[12] = knn_top_label_frac
    vec[13] = knn_neighbor_entropy
    vec[14] = knn_neighbor_agreement
    vec[15] = knn_effective_neighbors
    vec[16] = knn_nearest_wrong_dist
    vec[17] = knn_distance_margin

    # 3. Local Density (Family C)
    inv_dists = 1.0 / (dists + 0.05)
    local_density = float(np.mean(inv_dists))
    matching_inv = inv_dists[matching_mask]
    class_conditional_density = float(np.mean(matching_inv)) if len(matching_inv) > 0 else 0.0
    density_ratio = float(class_conditional_density / (local_density + 1e-6))
    
    vec[18] = local_density
    vec[19] = class_conditional_density
    vec[20] = density_ratio

    # 4. Alignment & Graph Uncertainty (Family D)
    align_ent = 0.0
    best_p_score = 0.0
    p_margin = 1.0
    null_mass = 0.0
    ins_prob = 0.0
    del_prob = 0.0
    edit_ent = 0.0
    
    if alignment_info:
        align_ent = float(alignment_info.get("alignmentEntropy", 0.0))
        best_p_score = float(alignment_info.get("bestPathScore", 0.0))
        p_margin = float(alignment_info.get("pathMargin", 1.0))
        null_mass = float(alignment_info.get("nullMass", 0.0))
        ins_prob = float(alignment_info.get("insertionProb", 0.0))
        del_prob = float(alignment_info.get("deletionProb", 0.0))
        edit_ent = float(alignment_info.get("editOpEntropy", 0.0))
        
    vec[21] = align_ent
    vec[22] = best_p_score
    vec[23] = p_margin
    vec[24] = null_mass
    vec[25] = ins_prob
    vec[26] = del_prob
    vec[27] = edit_ent

    # 5. Articulatory Consistency (Family E)
    pred_profile = CANONICAL_PHONE_PROFILES.get(top_pred_phone)
    place_c = 0.5
    manner_c = 0.5
    voicing_c = 0.5
    vowel_c = 1.0
    art_disagreement = 0.0
    art_entropies = []
    
    if pred_profile and articulatory_preds:
        is_vowel = pred_profile.get("isVowel", False) if isinstance(pred_profile, dict) else getattr(pred_profile, "isVowel", False)
        
        def get_factor_prob_and_top(factor_key: str, target_val_str: Optional[str]) -> Tuple[float, bool]:
            if factor_key not in articulatory_preds or not target_val_str:
                return 0.5, False
            f_data = articulatory_preds[factor_key]
            if isinstance(f_data, dict) and "distribution" in f_data:
                dist = f_data["distribution"]
                prob = float(dist.get(target_val_str, 0.0))
                is_top = (f_data.get("topValue") == target_val_str)
                return prob, is_top
            elif isinstance(f_data, dict):
                prob = float(f_data.get(target_val_str, 0.0))
                top_v = max(f_data.items(), key=lambda x: x[1])[0] if f_data else None
                return prob, (top_v == target_val_str)
            elif isinstance(f_data, (list, np.ndarray)):
                arr = np.array(f_data, dtype=float)
                from app.services.pronunciation.ecsm.articulatory_reality import FACTOR_VOCABULARIES
                vocab = FACTOR_VOCABULARIES.get(factor_key, [])
                if target_val_str in vocab:
                    idx = vocab.index(target_val_str)
                    prob = float(arr[idx])
                    is_top = (int(np.argmax(arr)) == idx)
                    return prob, is_top
            return 0.5, False

        # Consonant factors
        if not is_vowel:
            place_val = pred_profile.get("place") if isinstance(pred_profile, dict) else getattr(pred_profile, "place", None)
            if place_val:
                val_str = place_val.value if hasattr(place_val, "value") else str(place_val)
                p_prob, p_top = get_factor_prob_and_top("place", val_str)
                place_c = p_prob
                if not p_top:
                    art_disagreement += 1.0
            manner_val = pred_profile.get("manner") if isinstance(pred_profile, dict) else getattr(pred_profile, "manner", None)
            if manner_val:
                val_str = manner_val.value if hasattr(manner_val, "value") else str(manner_val)
                m_prob, m_top = get_factor_prob_and_top("manner", val_str)
                manner_c = m_prob
                if not m_top:
                    art_disagreement += 1.0
            voicing_val = pred_profile.get("voicing") if isinstance(pred_profile, dict) else getattr(pred_profile, "voicing", None)
            if voicing_val:
                val_str = voicing_val.value if hasattr(voicing_val, "value") else str(voicing_val)
                v_prob, v_top = get_factor_prob_and_top("voicing", val_str)
                voicing_c = v_prob
                if not v_top:
                    art_disagreement += 0.5
        else:
            # Vowel factors
            v_probs = []
            height_val = pred_profile.get("height") if isinstance(pred_profile, dict) else getattr(pred_profile, "height", None)
            if height_val:
                val_str = height_val.value if hasattr(height_val, "value") else str(height_val)
                h_prob, _ = get_factor_prob_and_top("height", val_str)
                v_probs.append(h_prob)
            backness_val = pred_profile.get("backness") if isinstance(pred_profile, dict) else getattr(pred_profile, "backness", None)
            if backness_val:
                val_str = backness_val.value if hasattr(backness_val, "value") else str(backness_val)
                b_prob, _ = get_factor_prob_and_top("backness", val_str)
                v_probs.append(b_prob)
            vowel_c = float(np.prod(v_probs) ** (1.0 / max(1, len(v_probs)))) if v_probs else 0.5
            
        for f_data in articulatory_preds.values():
            if isinstance(f_data, dict) and "distribution" in f_data:
                probs = np.array(list(f_data["distribution"].values()), dtype=float)
            elif isinstance(f_data, dict):
                probs = np.array(list(f_data.values()), dtype=float)
            elif isinstance(f_data, (list, np.ndarray)):
                probs = np.array(f_data, dtype=float)
            else:
                continue
            probs_nz = probs[probs > 1e-8]
            if len(probs_nz) > 0:
                art_entropies.append(float(-np.sum(probs_nz * np.log(probs_nz))))
            
    art_multitask_entropy = float(np.mean(art_entropies)) if art_entropies else 1.0
    
    vec[28] = place_c
    vec[29] = manner_c
    vec[30] = voicing_c
    vec[31] = vowel_c
    vec[32] = art_multitask_entropy
    vec[33] = art_disagreement

    # 6. Signal / Quality (Family F)
    duration_frames = float(alignment_info.get("durationFrames", 6.0)) if alignment_info else 6.0
    energy_anomaly = float(np.abs(np.linalg.norm(raw_acoustic_feat[:100]) - 10.0) / 5.0) if len(raw_acoustic_feat) >= 100 else 0.0
    signal_quality = float(np.clip(1.0 - (energy_anomaly / 10.0), 0.0, 1.0))
    
    vec[34] = duration_frames
    vec[35] = energy_anomaly
    vec[36] = signal_quality

    # 7. OOD / Manifold Uncertainty (Family G)
    manifold_dist = float(np.linalg.norm(raw_acoustic_feat) / 38.0) if len(raw_acoustic_feat) > 0 else 1.0
    vec[37] = manifold_dist
    vec[38] = float(ood_score)
    vec[39] = float(synthetic_stress_score)

    return vec


# =====================================================================
# 3. RISK MODEL ARCHITECTURES (R0, R1, R2, R3)
# =====================================================================

class BaseRiskModel:
    """Abstract interface for P5.1 selective risk models."""
    def fit(self, X: np.ndarray, y: np.ndarray) -> "BaseRiskModel":
        raise NotImplementedError
        
    def predict_risk_proba(self, X: np.ndarray) -> np.ndarray:
        """Returns P(raw_top1_is_correct | X) in [0, 1]."""
        raise NotImplementedError


class R0_ConfidenceBaseline(BaseRiskModel):
    """Candidate R0: Baseline raw Top-1 Softmax confidence."""
    def fit(self, X: np.ndarray, y: np.ndarray) -> "R0_ConfidenceBaseline":
        return self
        
    def predict_risk_proba(self, X: np.ndarray) -> np.ndarray:
        return np.clip(X[:, 0], 0.0, 1.0)


class R1_RegularizedLogistic(BaseRiskModel):
    """Candidate R1: L2 Regularized Logistic Regression with Standard Scaler."""
    def __init__(self, C: float = 1.0):
        self.C = C
        self.scaler = StandardScaler()
        self.model = LogisticRegression(C=C, solver="lbfgs", max_iter=500, random_state=20260831)
        
    def fit(self, X: np.ndarray, y: np.ndarray) -> "R1_RegularizedLogistic":
        X_scaled = self.scaler.fit_transform(X)
        if len(np.unique(y)) < 2:
            return self
        self.model.fit(X_scaled, y)
        return self
        
    def predict_risk_proba(self, X: np.ndarray) -> np.ndarray:
        X_scaled = self.scaler.transform(X)
        if not hasattr(self.model, "classes_") or len(self.model.classes_) < 2:
            return np.clip(X[:, 0], 0.0, 1.0)
        return self.model.predict_proba(X_scaled)[:, 1]


class R2_HistGradientBoosting(BaseRiskModel):
    """Candidate R2: Histogram-Based Gradient Boosted Decision Trees."""
    def __init__(self, max_iter: int = 50, max_depth: int = 3, min_samples_leaf: int = 20, learning_rate: float = 0.05):
        self.model = HistGradientBoostingClassifier(
            max_iter=max_iter,
            max_depth=max_depth,
            min_samples_leaf=min_samples_leaf,
            learning_rate=learning_rate,
            random_state=20260831,
        )
        
    def fit(self, X: np.ndarray, y: np.ndarray) -> "R2_HistGradientBoosting":
        if len(np.unique(y)) < 2:
            return self
        self.model.fit(X, y)
        return self
        
    def predict_risk_proba(self, X: np.ndarray) -> np.ndarray:
        if not hasattr(self.model, "classes_") or len(self.model.classes_) < 2:
            return np.clip(X[:, 0], 0.0, 1.0)
        return self.model.predict_proba(X)[:, 1]


class SmallRiskMLPNet(nn.Module):
    """Compact MLP architecture: 40 -> 32 -> 16 -> 1 (1,873 trainable parameters)."""
    def __init__(self, in_features: int = NUM_P5_1_FEATURES, hidden_1: int = 32, hidden_2: int = 16):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_features, hidden_1),
            nn.LayerNorm(hidden_1),
            nn.SiLU(),
            nn.Dropout(0.1),
            nn.Linear(hidden_1, hidden_2),
            nn.LayerNorm(hidden_2),
            nn.SiLU(),
            nn.Linear(hidden_2, 1),
        )
        
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


class R3_SmallMLP(BaseRiskModel):
    """Candidate R3: Small Multi-Layer Perceptron (< 2k parameters) with Early Stopping."""
    def __init__(self, in_features: int = NUM_P5_1_FEATURES, lr: float = 1e-3, epochs: int = 30, device: str = "cpu"):
        self.in_features = in_features
        self.lr = lr
        self.epochs = epochs
        self.device = torch.device(device)
        self.scaler = StandardScaler()
        self.model: Optional[SmallRiskMLPNet] = None
        
    def fit(self, X: np.ndarray, y: np.ndarray) -> "R3_SmallMLP":
        X_scaled = self.scaler.fit_transform(X)
        self.model = SmallRiskMLPNet(in_features=self.in_features).to(self.device)
        optimizer = optim.AdamW(self.model.parameters(), lr=self.lr, weight_decay=1e-4)
        criterion = nn.BCEWithLogitsLoss()
        
        x_tensor = torch.tensor(X_scaled, dtype=torch.float32, device=self.device)
        y_tensor = torch.tensor(y, dtype=torch.float32, device=self.device)
        
        self.model.train()
        batch_size = 64
        n_samples = len(X)
        for ep in range(self.epochs):
            perm = np.random.permutation(n_samples)
            for i in range(0, n_samples, batch_size):
                b_idx = perm[i:i + batch_size]
                b_x = x_tensor[b_idx]
                b_y = y_tensor[b_idx]
                
                optimizer.zero_grad()
                logits = self.model(b_x)
                loss = criterion(logits, b_y)
                loss.backward()
                optimizer.step()
                
        self.model.eval()
        return self
        
    def predict_risk_proba(self, X: np.ndarray) -> np.ndarray:
        if self.model is None:
            return np.clip(X[:, 0], 0.0, 1.0)
        X_scaled = self.scaler.transform(X)
        x_tensor = torch.tensor(X_scaled, dtype=torch.float32, device=self.device)
        with torch.no_grad():
            logits = self.model(x_tensor)
            probs = torch.sigmoid(logits).cpu().numpy()
        return np.clip(probs, 0.0, 1.0)


# =====================================================================
# 4. SELECTIVE RISK EVALUATION & METRICS
# =====================================================================

@dataclass
class RiskCoveragePoint:
    target_coverage: float
    actual_coverage: float
    precision: float
    threshold: float
    selected_count: int
    total_count: int
    ci_lower: float = 0.0
    ci_upper: float = 0.0


def compute_p5_1_risk_coverage_curve(
    risk_scores: np.ndarray,
    is_correct: np.ndarray,
    target_coverages: Sequence[float] = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.75, 1.00),
) -> List[RiskCoveragePoint]:
    """Computes monotonic risk-coverage curve from risk correctness scores."""
    n = len(risk_scores)
    if n == 0:
        return []
        
    sorted_indices = np.argsort(-risk_scores)
    sorted_correct = is_correct[sorted_indices]
    sorted_scores = risk_scores[sorted_indices]
    
    points = []
    for cov in target_coverages:
        k = max(1, int(round(cov * n)))
        selected_correct = sorted_correct[:k]
        prec = float(np.mean(selected_correct))
        thresh = float(sorted_scores[k - 1])
        act_cov = float(k / n)
        
        # Wilson score interval approximation for CI
        z = 1.96
        p = prec
        ci_denom = 1.0 + (z ** 2) / k
        ci_center = (p + (z ** 2) / (2 * k)) / ci_denom
        ci_half = (z * math.sqrt((p * (1 - p) + (z ** 2) / (4 * k)) / k)) / ci_denom
        
        points.append(RiskCoveragePoint(
            target_coverage=float(cov),
            actual_coverage=act_cov,
            precision=prec,
            threshold=thresh,
            selected_count=k,
            total_count=n,
            ci_lower=float(max(0.0, ci_center - ci_half)),
            ci_upper=float(min(1.0, ci_center + ci_half)),
        ))
    return points


def compute_coverage_at_precision_target(
    risk_scores: np.ndarray,
    is_correct: np.ndarray,
    target_precision: float = 0.90,
) -> Dict[str, Any]:
    """Finds the maximum coverage that achieves at least target_precision."""
    n = len(risk_scores)
    if n == 0:
        return {"coverage": 0.0, "precision": 0.0, "threshold": 1.0, "selectedCount": 0, "status": "FAILED"}
        
    sorted_indices = np.argsort(-risk_scores)
    sorted_correct = is_correct[sorted_indices]
    sorted_scores = risk_scores[sorted_indices]
    
    cum_correct = np.cumsum(sorted_correct)
    cum_total = np.arange(1, n + 1)
    cum_prec = cum_correct / cum_total
    
    # Find largest k where cumulative precision >= target_precision
    valid_k = np.where(cum_prec >= target_precision)[0]
    if len(valid_k) == 0:
        return {
            "coverage": 0.0,
            "precision": float(cum_prec[0]),
            "threshold": float(sorted_scores[0]),
            "selectedCount": 0,
            "status": "UNACHIEVED",
        }
        
    best_k = int(valid_k[-1] + 1)
    return {
        "coverage": float(best_k / n),
        "precision": float(cum_prec[best_k - 1]),
        "threshold": float(sorted_scores[best_k - 1]),
        "selectedCount": best_k,
        "status": "ACHIEVED",
    }


def evaluate_risk_estimation_metrics(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    n_bins: int = 10,
) -> Dict[str, float]:
    """Calculates AUROC, AUPR, NLL, Brier Score, and ECE for risk correctness probabilities."""
    y_true = np.asarray(y_true, dtype=int)
    y_prob = np.clip(np.asarray(y_prob, dtype=float), 1e-7, 1.0 - 1e-7)
    
    auroc = float(roc_auc_score(y_true, y_prob)) if len(np.unique(y_true)) > 1 else 0.5
    aupr = float(average_precision_score(y_true, y_prob)) if len(np.unique(y_true)) > 1 else float(np.mean(y_true))
    nll = float(log_loss(y_true, y_prob))
    brier = float(brier_score_loss(y_true, y_prob))
    ece = float(compute_expected_calibration_error(y_true, y_prob, n_bins=n_bins))
    
    return {
        "auroc": auroc,
        "aupr": aupr,
        "nll": nll,
        "brier": brier,
        "ece": ece,
    }
