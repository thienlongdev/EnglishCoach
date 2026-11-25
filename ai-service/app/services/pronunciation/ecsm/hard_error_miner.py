"""
ECSM-v1 / EC-PRISM Phase P6.1: Hard-Error Mining & Annotation Prioritization Engine.

Identifies, scores, and categorizes high-value acoustic realization errors for future human-gold annotation.
Prevents single-speaker / single-phone domination via diversity-constrained priority queues.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


class HardErrorBucket(str, Enum):
    """Scientific categories for prioritization and balanced human queue assembly."""
    HIGH_CONF_WRONG_PHONE = "HIGH_CONF_WRONG_PHONE"
    MINIMAL_PAIR_BOUNDARY = "MINIMAL_PAIR_BOUNDARY"
    CROSS_BACKBONE_DISAGREEMENT = "CROSS_BACKBONE_DISAGREEMENT"
    RARE_SUBSTITUTION = "RARE_SUBSTITUTION"
    RARE_TARGET_PHONE = "RARE_TARGET_PHONE"
    ALIGNMENT_AMBIGUOUS = "ALIGNMENT_AMBIGUOUS"
    ARTICULATORY_CONFLICT = "ARTICULATORY_CONFLICT"
    LOW_SUPPORT_SPEAKER_GROUP = "LOW_SUPPORT_SPEAKER_GROUP"
    CHANNEL_STRESS_SENSITIVE = "CHANNEL_STRESS_SENSITIVE"
    LABEL_SUSPECT = "LABEL_SUSPECT"
    HIGH_VALUE_CORRECT_CONTROL = "HIGH_VALUE_CORRECT_CONTROL"
    QUALITY_REJECT = "QUALITY_REJECT"


CRITICAL_MINIMAL_PAIRS: Set[Tuple[str, str]] = {
    ("T", "S"), ("S", "T"),
    ("S", "TH"), ("TH", "S"),
    ("TH", "T"), ("T", "TH"),
    ("D", "DH"), ("DH", "D"),
    ("Z", "DH"), ("DH", "Z"),
    ("R", "L"), ("L", "R"),
    ("V", "W"), ("W", "V"),
    ("IH", "IY"), ("IY", "IH"),
    ("AE", "EH"), ("EH", "AE"),
    ("S", "Z"), ("Z", "S"),
    ("SH", "S"), ("S", "SH"),
    ("CH", "SH"), ("SH", "CH"),
    ("F", "TH"), ("TH", "F"),
    ("B", "V"), ("V", "B"),
    ("P", "B"), ("B", "P"),
}


@dataclass
class CandidateEvaluationRecord:
    """Multi-model evaluation state for a single phone substitution record."""
    row_id: str
    utterance_id: str
    speaker_id: str
    word: str
    expected_phone: str
    human_perceived_phone: str
    model_e_pred: str
    hubert_pred: str
    wavlm_pred: str
    top1_pred: str
    is_correct: int
    risk_score: float
    confidence: float
    alignment_entropy: float
    articulatory_distance: float
    neighbor_purity: float
    phone_train_support: int
    confusion_train_support: int
    channel_stress_drop: float = 0.0
    is_quality_reject: bool = False


@dataclass
class HardErrorPoolItem:
    """Mined hard error candidate record with auditable priority breakdown."""
    item_id: str
    row_id: str
    utterance_id: str
    speaker_id: str
    word: str
    expected_phone: str
    human_label: str
    model_e_pred: str
    hubert_pred: str
    wavlm_pred: str
    top1_pred: str
    bucket: HardErrorBucket
    priority_score: float
    priority_components: Dict[str, float]
    risk_score: float
    confidence: float
    neighbor_purity: float
    alignment_entropy: float
    articulatory_distance: float
    phone_train_support: int
    confusion_train_support: int
    is_minimal_pair: bool
    is_cross_backbone_disagree: bool
    is_label_suspect: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "itemId": self.item_id,
            "rowId": self.row_id,
            "utteranceId": self.utterance_id,
            "speakerId": self.speaker_id,
            "word": self.word,
            "expectedPhone": self.expected_phone,
            "humanLabel": self.human_label,
            "modelPredictions": {
                "modelE": self.model_e_pred,
                "huBERT": self.hubert_pred,
                "wavLM": self.wavlm_pred,
                "top1": self.top1_pred,
            },
            "bucket": self.bucket.value,
            "priorityScore": round(float(self.priority_score), 6),
            "priorityComponents": {k: round(float(v), 6) for k, v in self.priority_components.items()},
            "metrics": {
                "riskScore": round(float(self.risk_score), 6),
                "confidence": round(float(self.confidence), 6),
                "neighborPurity": round(float(self.neighbor_purity), 6),
                "alignmentEntropy": round(float(self.alignment_entropy), 6),
                "articulatoryDistance": round(float(self.articulatory_distance), 6),
                "phoneTrainSupport": int(self.phone_train_support),
                "confusionTrainSupport": int(self.confusion_train_support),
            },
            "flags": {
                "isMinimalPair": bool(self.is_minimal_pair),
                "isCrossBackboneDisagree": bool(self.is_cross_backbone_disagree),
                "isLabelSuspect": bool(self.is_label_suspect),
            },
        }


class HardErrorPriorityEngine:
    """
    Auditable scoring and diversity-constrained queue generation engine.
    Weights are defined using TRAIN evidence and phonetic heuristics.
    """

    def __init__(
        self,
        w_high_conf_wrong: float = 0.25,
        w_cross_model_disagree: float = 0.20,
        w_low_support_pair: float = 0.15,
        w_minimal_pair: float = 0.15,
        w_neighbor_ambiguity: float = 0.10,
        w_alignment_uncertainty: float = 0.05,
        w_articulatory_conflict: float = 0.05,
        w_channel_sensitivity: float = 0.05,
    ):
        self.w_high_conf_wrong = w_high_conf_wrong
        self.w_cross_model_disagree = w_cross_model_disagree
        self.w_low_support_pair = w_low_support_pair
        self.w_minimal_pair = w_minimal_pair
        self.w_neighbor_ambiguity = w_neighbor_ambiguity
        self.w_alignment_uncertainty = w_alignment_uncertainty
        self.w_articulatory_conflict = w_articulatory_conflict
        self.w_channel_sensitivity = w_channel_sensitivity

    def compute_priority_score(self, rec: CandidateEvaluationRecord) -> Tuple[float, Dict[str, float], HardErrorBucket]:
        """Calculates normalized priority score and assigns primary bucket."""
        if rec.is_quality_reject:
            return 0.0, {"quality_reject": 1.0}, HardErrorBucket.QUALITY_REJECT

        # 1. High Confidence Wrong Phone (Model confident but wrong)
        is_wrong = 1.0 if rec.is_correct == 0 else 0.0
        c_high_conf = is_wrong * float(np.clip(rec.confidence, 0.0, 1.0))

        # 2. Cross-Model Disagreement (MODEL_E vs HuBERT vs WavLM)
        preds = [rec.model_e_pred, rec.hubert_pred, rec.wavlm_pred]
        unique_preds = len(set(preds))
        if unique_preds == 3:
            c_cross_disagree = 1.0
        elif unique_preds == 2:
            c_cross_disagree = 0.5
        else:
            c_cross_disagree = 0.0

        # 3. Low Support Confusion Pair (Sparse training data)
        supp = max(1, rec.confusion_train_support)
        c_low_support = float(np.exp(-supp / 15.0))

        # 4. Minimal Pair Contrast
        pair_forward = (rec.expected_phone, rec.human_perceived_phone)
        pair_backward = (rec.human_perceived_phone, rec.expected_phone)
        pair_pred = (rec.expected_phone, rec.top1_pred)
        is_min_pair = pair_forward in CRITICAL_MINIMAL_PAIRS or pair_backward in CRITICAL_MINIMAL_PAIRS or pair_pred in CRITICAL_MINIMAL_PAIRS
        c_min_pair = 1.0 if is_min_pair else 0.0

        # 5. Neighbor Ambiguity (1.0 - purity)
        c_neigh_ambiguity = float(np.clip(1.0 - rec.neighbor_purity, 0.0, 1.0))

        # 6. Alignment Uncertainty
        c_align_uncertainty = float(np.clip(rec.alignment_entropy / 2.0, 0.0, 1.0))

        # 7. Articulatory Conflict (High articulatory distance despite model prediction)
        c_art_conflict = float(np.clip(rec.articulatory_distance / 3.0, 0.0, 1.0))

        # 8. Channel Stress Sensitivity
        c_channel_sens = float(np.clip(rec.channel_stress_drop, 0.0, 1.0))

        components = {
            "high_conf_wrong": float(c_high_conf),
            "cross_model_disagree": float(c_cross_disagree),
            "low_support_pair": float(c_low_support),
            "minimal_pair": float(c_min_pair),
            "neighbor_ambiguity": float(c_neigh_ambiguity),
            "alignment_uncertainty": float(c_align_uncertainty),
            "articulatory_conflict": float(c_art_conflict),
            "channel_sensitivity": float(c_channel_sens),
        }

        # Weighted priority sum
        priority = (
            self.w_high_conf_wrong * c_high_conf
            + self.w_cross_model_disagree * c_cross_disagree
            + self.w_low_support_pair * c_low_support
            + self.w_minimal_pair * c_min_pair
            + self.w_neighbor_ambiguity * c_neigh_ambiguity
            + self.w_alignment_uncertainty * c_align_uncertainty
            + self.w_articulatory_conflict * c_art_conflict
            + self.w_channel_sensitivity * c_channel_sens
        )

        # Label Suspect detection: all models agree on P_model != P_human with high neighbor purity
        all_models_agree = (rec.model_e_pred == rec.hubert_pred == rec.wavlm_pred)
        is_label_suspect = all_models_agree and (rec.model_e_pred != rec.human_perceived_phone) and (rec.neighbor_purity >= 0.70)

        # Bucket Classification
        if is_label_suspect:
            bucket = HardErrorBucket.LABEL_SUSPECT
            priority += 0.20  # Boost priority for human adjudication
        elif is_wrong and c_high_conf >= 0.70:
            bucket = HardErrorBucket.HIGH_CONF_WRONG_PHONE
        elif is_min_pair and is_wrong:
            bucket = HardErrorBucket.MINIMAL_PAIR_BOUNDARY
        elif c_cross_disagree >= 0.5:
            bucket = HardErrorBucket.CROSS_BACKBONE_DISAGREEMENT
        elif c_low_support >= 0.60:
            bucket = HardErrorBucket.RARE_SUBSTITUTION
        elif c_art_conflict >= 0.60:
            bucket = HardErrorBucket.ARTICULATORY_CONFLICT
        elif c_align_uncertainty >= 0.60:
            bucket = HardErrorBucket.ALIGNMENT_AMBIGUOUS
        elif is_wrong:
            bucket = HardErrorBucket.RARE_TARGET_PHONE
        else:
            bucket = HardErrorBucket.HIGH_VALUE_CORRECT_CONTROL

        return float(np.clip(priority, 0.0, 1.0)), components, bucket

    def mine_and_rank_pool(
        self,
        records: Sequence[CandidateEvaluationRecord],
    ) -> List[HardErrorPoolItem]:
        """Evaluates all candidate evaluation records and ranks them by priority score."""
        pool: List[HardErrorPoolItem] = []

        for rec in records:
            p_score, p_comps, bucket = self.compute_priority_score(rec)
            
            all_models_agree = (rec.model_e_pred == rec.hubert_pred == rec.wavlm_pred)
            is_label_suspect = all_models_agree and (rec.model_e_pred != rec.human_perceived_phone) and (rec.neighbor_purity >= 0.70)
            is_cross_disagree = len(set([rec.model_e_pred, rec.hubert_pred, rec.wavlm_pred])) > 1

            pair_f = (rec.expected_phone, rec.human_perceived_phone)
            pair_b = (rec.human_perceived_phone, rec.expected_phone)
            is_min = pair_f in CRITICAL_MINIMAL_PAIRS or pair_b in CRITICAL_MINIMAL_PAIRS

            # Unique deterministic item ID
            hash_src = f"{rec.row_id}:{rec.utterance_id}:{rec.speaker_id}:{rec.expected_phone}:{rec.human_perceived_phone}"
            item_id = f"HE-{hashlib.sha256(hash_src.encode('utf-8')).hexdigest()[:12]}"

            item = HardErrorPoolItem(
                item_id=item_id,
                row_id=rec.row_id,
                utterance_id=rec.utterance_id,
                speaker_id=rec.speaker_id,
                word=rec.word,
                expected_phone=rec.expected_phone,
                human_label=rec.human_perceived_phone,
                model_e_pred=rec.model_e_pred,
                hubert_pred=rec.hubert_pred,
                wavlm_pred=rec.wavlm_pred,
                top1_pred=rec.top1_pred,
                bucket=bucket,
                priority_score=p_score,
                priority_components=p_comps,
                risk_score=rec.risk_score,
                confidence=rec.confidence,
                neighbor_purity=rec.neighbor_purity,
                alignment_entropy=rec.alignment_entropy,
                articulatory_distance=rec.articulatory_distance,
                phone_train_support=rec.phone_train_support,
                confusion_train_support=rec.confusion_train_support,
                is_minimal_pair=is_min,
                is_cross_backbone_disagree=is_cross_disagree,
                is_label_suspect=is_label_suspect,
            )
            pool.append(item)

        # Sort descending by priority score
        pool.sort(key=lambda x: x.priority_score, reverse=True)
        return pool

    def select_diversity_constrained_queue(
        self,
        pool: Sequence[HardErrorPoolItem],
        target_size: int,
        max_per_speaker_fraction: float = 0.05,
        max_per_canonical_fraction: float = 0.10,
        control_ratio: float = 0.10,
    ) -> List[HardErrorPoolItem]:
        """
        Assembles a balanced, diversity-constrained annotation queue from the ranked hard-error pool.
        Enforces caps per speaker, canonical phone, and incorporates known correct control samples.
        """
        max_per_speaker = max(2, int(math.ceil(target_size * max_per_speaker_fraction)))
        max_per_canon = max(5, int(math.ceil(target_size * max_per_canonical_fraction)))
        target_controls = int(round(target_size * control_ratio))

        selected: List[HardErrorPoolItem] = []
        speaker_counts: Dict[str, int] = defaultdict(int)
        canon_counts: Dict[str, int] = defaultdict(int)

        # Separate controls and hard errors
        controls = [item for item in pool if item.bucket == HardErrorBucket.HIGH_VALUE_CORRECT_CONTROL]
        hard_items = [item for item in pool if item.bucket != HardErrorBucket.HIGH_VALUE_CORRECT_CONTROL and item.bucket != HardErrorBucket.QUALITY_REJECT]

        # 1. Select hard items under diversity constraints
        for item in hard_items:
            if len(selected) >= (target_size - target_controls):
                break
            if speaker_counts[item.speaker_id] >= max_per_speaker:
                continue
            if canon_counts[item.expected_phone] >= max_per_canon:
                continue

            selected.append(item)
            speaker_counts[item.speaker_id] += 1
            canon_counts[item.expected_phone] += 1

        # 2. Add high-value control samples for annotator QC calibration
        for item in controls:
            if len(selected) >= target_size:
                break
            if speaker_counts[item.speaker_id] >= max_per_speaker:
                continue
            selected.append(item)
            speaker_counts[item.speaker_id] += 1
            canon_counts[item.expected_phone] += 1

        # 3. If target size not reached, backfill with next highest priority items under relaxed caps
        if len(selected) < target_size:
            selected_ids = set(x.item_id for x in selected)
            for item in hard_items:
                if len(selected) >= target_size:
                    break
                if item.item_id in selected_ids:
                    continue
                selected.append(item)
                selected_ids.add(item.item_id)

        return selected
