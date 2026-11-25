"""
ECSM-v1 / EC-PRISM Phase P2: Articulatory Reality Modeling.
Provides structured articulatory attribute modeling from acoustic evidence alone,
strictly adhering to the Canonical Information Firewall.

Articulatory Target Provenance:
- HUMAN_PERCEIVED_PHONE_DERIVED: Target derived deterministically from human perceived-phone label.
- HUMAN_DIRECT_ATTRIBUTE: Direct human articulatory annotation.
- WEAK_MACHINE_LABEL: Inferred from ASR/acoustic model.
- CANONICAL_ONLY: Derived from expected canonical phone (FORBIDDEN as acoustic truth).
- UNAVAILABLE: Unspecified or missing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    ConsonantManner,
    ConsonantPlace,
    PhoneArticulatoryProfile,
    Voicing,
    VowelBackness,
    VowelHeight,
    VowelRounding,
    VowelTenseness,
)


class ArticulatoryTargetProvenance(str, Enum):
    HUMAN_PERCEIVED_PHONE_DERIVED = "HUMAN_PERCEIVED_PHONE_DERIVED"
    HUMAN_DIRECT_ATTRIBUTE = "HUMAN_DIRECT_ATTRIBUTE"
    WEAK_MACHINE_LABEL = "WEAK_MACHINE_LABEL"
    CANONICAL_ONLY = "CANONICAL_ONLY"
    UNAVAILABLE = "UNAVAILABLE"


# Articulatory factor class vocabularies
CONSONANT_PLACE_CLASSES = [p.value for p in ConsonantPlace]
CONSONANT_MANNER_CLASSES = [m.value for m in ConsonantManner]
VOICING_CLASSES = [v.value for v in Voicing]

VOWEL_HEIGHT_CLASSES = [h.value for h in VowelHeight]
VOWEL_BACKNESS_CLASSES = [b.value for b in VowelBackness]
VOWEL_ROUNDING_CLASSES = [r.value for r in VowelRounding]
VOWEL_TENSENESS_CLASSES = [t.value for t in VowelTenseness]

FACTOR_VOCABULARIES: Dict[str, List[str]] = {
    "place": CONSONANT_PLACE_CLASSES,
    "manner": CONSONANT_MANNER_CLASSES,
    "voicing": VOICING_CLASSES,
    "height": VOWEL_HEIGHT_CLASSES,
    "backness": VOWEL_BACKNESS_CLASSES,
    "rounding": VOWEL_ROUNDING_CLASSES,
    "tenseness": VOWEL_TENSENESS_CLASSES,
}


@dataclass
class ArticulatoryGroundTruth:
    """
    Explicit ground-truth articulatory record with provenance tracking.
    """
    phone: str
    provenance: ArticulatoryTargetProvenance
    is_vowel: bool
    # Consonant factors (-1 if not applicable or unknown)
    place_idx: int = -1
    manner_idx: int = -1
    voicing_idx: int = -1
    # Vowel factors (-1 if not applicable or unknown)
    height_idx: int = -1
    backness_idx: int = -1
    rounding_idx: int = -1
    tenseness_idx: int = -1

    def to_dict(self) -> Dict[str, Any]:
        return {
            "phone": self.phone,
            "provenance": self.provenance.value,
            "isVowel": self.is_vowel,
            "place": CONSONANT_PLACE_CLASSES[self.place_idx] if self.place_idx >= 0 else None,
            "manner": CONSONANT_MANNER_CLASSES[self.manner_idx] if self.manner_idx >= 0 else None,
            "voicing": VOICING_CLASSES[self.voicing_idx] if self.voicing_idx >= 0 else None,
            "height": VOWEL_HEIGHT_CLASSES[self.height_idx] if self.height_idx >= 0 else None,
            "backness": VOWEL_BACKNESS_CLASSES[self.backness_idx] if self.backness_idx >= 0 else None,
            "rounding": VOWEL_ROUNDING_CLASSES[self.rounding_idx] if self.rounding_idx >= 0 else None,
            "tenseness": VOWEL_TENSENESS_CLASSES[self.tenseness_idx] if self.tenseness_idx >= 0 else None,
        }


def extract_articulatory_ground_truth(
    phone: str,
    provenance: ArticulatoryTargetProvenance = ArticulatoryTargetProvenance.HUMAN_PERCEIVED_PHONE_DERIVED,
) -> ArticulatoryGroundTruth:
    """
    Extracts structured articulatory ground truth from phone symbol with explicit provenance.
    """
    profile = CANONICAL_PHONE_PROFILES.get(phone)
    if profile is None:
        return ArticulatoryGroundTruth(
            phone=phone,
            provenance=provenance,
            is_vowel=False,
        )

    is_vowel = bool(profile.get("isVowel", False))
    if not is_vowel:
        place = profile.get("place")
        manner = profile.get("manner")
        voicing = profile.get("voicing")
        place_idx = CONSONANT_PLACE_CLASSES.index(place.value) if place else -1
        manner_idx = CONSONANT_MANNER_CLASSES.index(manner.value) if manner else -1
        voicing_idx = VOICING_CLASSES.index(voicing.value) if voicing else -1
        return ArticulatoryGroundTruth(
            phone=phone,
            provenance=provenance,
            is_vowel=False,
            place_idx=place_idx,
            manner_idx=manner_idx,
            voicing_idx=voicing_idx,
        )
    else:
        height = profile.get("height")
        backness = profile.get("backness")
        rounding = profile.get("rounding")
        tenseness = profile.get("tenseness")
        height_idx = VOWEL_HEIGHT_CLASSES.index(height.value) if height else -1
        backness_idx = VOWEL_BACKNESS_CLASSES.index(backness.value) if backness else -1
        rounding_idx = VOWEL_ROUNDING_CLASSES.index(rounding.value) if rounding else -1
        tenseness_idx = VOWEL_TENSENESS_CLASSES.index(tenseness.value) if tenseness else -1
        return ArticulatoryGroundTruth(
            phone=phone,
            provenance=provenance,
            is_vowel=True,
            height_idx=height_idx,
            backness_idx=backness_idx,
            rounding_idx=rounding_idx,
            tenseness_idx=tenseness_idx,
        )


class IndependentArticulatoryHeads(nn.Module):
    """
    Candidate A1: Frozen representation -> Independent factor linear heads.
    Each articulatory factor has a direct projection from acoustic features.
    """

    def __init__(self, in_features: int = 1416, dropout: float = 0.1):
        super().__init__()
        self.in_features = in_features
        self.dropout = nn.Dropout(dropout)
        
        # Consonant factor heads
        self.head_place = nn.Linear(in_features, len(CONSONANT_PLACE_CLASSES))
        self.head_manner = nn.Linear(in_features, len(CONSONANT_MANNER_CLASSES))
        self.head_voicing = nn.Linear(in_features, len(VOICING_CLASSES))
        
        # Vowel factor heads
        self.head_height = nn.Linear(in_features, len(VOWEL_HEIGHT_CLASSES))
        self.head_backness = nn.Linear(in_features, len(VOWEL_BACKNESS_CLASSES))
        self.head_rounding = nn.Linear(in_features, len(VOWEL_ROUNDING_CLASSES))
        self.head_tenseness = nn.Linear(in_features, len(VOWEL_TENSENESS_CLASSES))

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        x_drop = self.dropout(x)
        return {
            "place": self.head_place(x_drop),
            "manner": self.head_manner(x_drop),
            "voicing": self.head_voicing(x_drop),
            "height": self.head_height(x_drop),
            "backness": self.head_backness(x_drop),
            "rounding": self.head_rounding(x_drop),
            "tenseness": self.head_tenseness(x_drop),
        }


class SharedArticulatoryAdapter(nn.Module):
    """
    Candidate A2: Frozen representation -> Shared Articulatory Adapter -> Factor Heads.
    A multi-layer bottleneck extracts shared phonological representations.
    """

    def __init__(self, in_features: int = 1416, hidden_dim: int = 256, dropout: float = 0.15):
        super().__init__()
        self.in_features = in_features
        self.hidden_dim = hidden_dim
        
        self.adapter = nn.Sequential(
            nn.Linear(in_features, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        
        # Factor heads from shared bottleneck
        self.head_place = nn.Linear(hidden_dim, len(CONSONANT_PLACE_CLASSES))
        self.head_manner = nn.Linear(hidden_dim, len(CONSONANT_MANNER_CLASSES))
        self.head_voicing = nn.Linear(hidden_dim, len(VOICING_CLASSES))
        
        self.head_height = nn.Linear(hidden_dim, len(VOWEL_HEIGHT_CLASSES))
        self.head_backness = nn.Linear(hidden_dim, len(VOWEL_BACKNESS_CLASSES))
        self.head_rounding = nn.Linear(hidden_dim, len(VOWEL_ROUNDING_CLASSES))
        self.head_tenseness = nn.Linear(hidden_dim, len(VOWEL_TENSENESS_CLASSES))

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        h = self.adapter(x)
        return {
            "embedding": h,
            "place": self.head_place(h),
            "manner": self.head_manner(h),
            "voicing": self.head_voicing(h),
            "height": self.head_height(h),
            "backness": self.head_backness(h),
            "rounding": self.head_rounding(h),
            "tenseness": self.head_tenseness(h),
        }


class ProtectedPartialArticulatoryAdapter(nn.Module):
    """
    Candidate A3: Stop-gradient protected adapter with residual connection and anti-collapse constraint.
    """

    def __init__(self, in_features: int = 1416, hidden_dim: int = 256, dropout: float = 0.15):
        super().__init__()
        self.in_features = in_features
        self.hidden_dim = hidden_dim
        
        self.proj_in = nn.Linear(in_features, hidden_dim)
        self.norm1 = nn.LayerNorm(hidden_dim)
        self.act = nn.SiLU()
        self.dropout = nn.Dropout(dropout)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.norm2 = nn.LayerNorm(hidden_dim)
        
        self.head_place = nn.Linear(hidden_dim, len(CONSONANT_PLACE_CLASSES))
        self.head_manner = nn.Linear(hidden_dim, len(CONSONANT_MANNER_CLASSES))
        self.head_voicing = nn.Linear(hidden_dim, len(VOICING_CLASSES))
        
        self.head_height = nn.Linear(hidden_dim, len(VOWEL_HEIGHT_CLASSES))
        self.head_backness = nn.Linear(hidden_dim, len(VOWEL_BACKNESS_CLASSES))
        self.head_rounding = nn.Linear(hidden_dim, len(VOWEL_ROUNDING_CLASSES))
        self.head_tenseness = nn.Linear(hidden_dim, len(VOWEL_TENSENESS_CLASSES))

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        # Stop gradient on input x to protect base acoustic representation
        x_detached = x.detach()
        h0 = self.act(self.norm1(self.proj_in(x_detached)))
        h1 = self.norm2(self.fc2(self.dropout(h0)))
        h = self.act(h0 + h1)
        
        return {
            "embedding": h,
            "place": self.head_place(h),
            "manner": self.head_manner(h),
            "voicing": self.head_voicing(h),
            "height": self.head_height(h),
            "backness": self.head_backness(h),
            "rounding": self.head_rounding(h),
            "tenseness": self.head_tenseness(h),
        }


def compute_fold_class_weights(
    targets: Sequence[int],
    num_classes: int,
    smoothing: float = 0.1,
) -> torch.Tensor:
    """
    Computes class-balanced cross entropy weights strictly on fold-train targets.
    weight[c] = total_samples / (num_classes * count[c] + smoothing)
    """
    counts = np.zeros(num_classes, dtype=np.float32)
    valid_targets = [t for t in targets if 0 <= t < num_classes]
    for t in valid_targets:
        counts[t] += 1.0
    
    total = max(1.0, float(len(valid_targets)))
    weights = np.zeros(num_classes, dtype=np.float32)
    for c in range(num_classes):
        weights[c] = total / (num_classes * (counts[c] + smoothing))
    
    # Normalize mean weight to 1.0
    weights /= (np.mean(weights) + 1e-9)
    return torch.tensor(weights, dtype=torch.float32)


def compute_articulatory_multitask_loss(
    logits_dict: Dict[str, torch.Tensor],
    ground_truths: Sequence[ArticulatoryGroundTruth],
    class_weights: Optional[Dict[str, torch.Tensor]] = None,
    device: Optional[torch.device] = None,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """
    Computes factor-masked multi-task articulatory loss.
    Consonant factors are only evaluated on consonants; vowel factors on vowels.
    """
    device = device or next(iter(logits_dict.values())).device
    total_loss = torch.tensor(0.0, device=device, requires_grad=True)
    loss_breakdown: Dict[str, float] = {}

    factors = ["place", "manner", "voicing", "height", "backness", "rounding", "tenseness"]
    
    for factor in factors:
        logits = logits_dict[factor]
        num_classes = len(FACTOR_VOCABULARIES[factor])
        target_indices = []
        sample_indices = []

        for idx, gt in enumerate(ground_truths):
            # Provenance guard: ensure label is not CANONICAL_ONLY
            if gt.provenance == ArticulatoryTargetProvenance.CANONICAL_ONLY:
                continue
            
            val = getattr(gt, f"{factor}_idx", -1)
            if val >= 0 and val < num_classes:
                target_indices.append(val)
                sample_indices.append(idx)

        if not target_indices:
            loss_breakdown[factor] = 0.0
            continue

        selected_logits = logits[sample_indices]
        targets_t = torch.tensor(target_indices, dtype=torch.long, device=device)
        
        weight = class_weights.get(factor).to(device) if class_weights and factor in class_weights else None
        factor_loss = F.cross_entropy(selected_logits, targets_t, weight=weight)
        
        total_loss = total_loss + factor_loss
        loss_breakdown[factor] = float(factor_loss.item())

    loss_breakdown["total"] = float(total_loss.item())
    return total_loss, loss_breakdown


def predict_articulatory_distributions(
    model: nn.Module,
    features: np.ndarray,
    device: torch.device,
) -> List[Dict[str, Any]]:
    """
    Infers articulatory probability distributions and top confidence for each feature vector.
    """
    model.eval()
    with torch.no_grad():
        x_t = torch.tensor(features, dtype=torch.float32, device=device)
        out = model(x_t)
        
        results = []
        batch_size = len(features)
        
        for i in range(batch_size):
            sample_pred: Dict[str, Any] = {}
            for factor, vocab in FACTOR_VOCABULARIES.items():
                logits = out[factor][i]
                probs = F.softmax(logits, dim=-1).cpu().numpy()
                top_idx = int(np.argmax(probs))
                dist = {vocab[c]: float(probs[c]) for c in range(len(vocab))}
                sample_pred[factor] = {
                    "topValue": vocab[top_idx],
                    "confidence": float(probs[top_idx]),
                    "distribution": dist,
                }
            results.append(sample_pred)
            
    return results
