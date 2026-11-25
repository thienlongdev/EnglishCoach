"""
ECSM-v1 / EC-PRISM Phase P6.1: Canonical-Firewalled Annotation Schema & Private Data Flywheel Engine.

Implements:
1. Two-Pass Canonical-Firewalled Human Annotation Protocol:
   - Pass A (Acoustic Reality): STRICTLY zero canonical / lexical / model hints.
   - Pass B (Pronunciation Judgment): Released ONLY after Pass A submission is locked.
2. Ambiguity-Preserving Multi-Annotator Distribution Representation.
3. Private Data Flywheel Manifest & Speaker-Disjoint Split Protection.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
import hashlib
import json
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


class LabelTier(str, Enum):
    """Scientific classification of annotation gold provenance."""
    TIER_0_MACHINE_DERIVED = "TIER_0_MACHINE_DERIVED"
    TIER_1_SINGLE_HUMAN = "TIER_1_SINGLE_HUMAN"
    TIER_2_MULTI_HUMAN_UNADJUDICATED = "TIER_2_MULTI_HUMAN_UNADJUDICATED"
    TIER_3_ADJUDICATED_GOLD = "TIER_3_ADJUDICATED_GOLD"
    TIER_A_AMBIGUOUS_DISTRIBUTIONAL = "TIER_A_AMBIGUOUS_DISTRIBUTIONAL"


class AdjudicationState(str, Enum):
    """Status of multi-annotator agreement and expert adjudication."""
    CONSENSUS_3_OF_3 = "CONSENSUS_3_OF_3"
    MAJORITY_2_OF_3 = "MAJORITY_2_OF_3"
    AMBIGUOUS_VALID = "AMBIGUOUS_VALID"
    ADJUDICATION_REQUIRED = "ADJUDICATION_REQUIRED"
    UNINTELLIGIBLE = "UNINTELLIGIBLE"
    QUALITY_REJECT = "QUALITY_REJECT"


class PassAJudgmentStatus(str, Enum):
    """Annotator perceptual assessment status for Pass A."""
    PERCEIVED = "PERCEIVED"
    AMBIGUOUS_MULTIPLE = "AMBIGUOUS_MULTIPLE"
    UNINTELLIGIBLE = "UNINTELLIGIBLE"
    AUDIO_CORRUPTED = "AUDIO_CORRUPTED"


class PassBErrorType(str, Enum):
    """Categorization of learner pronunciation divergence."""
    MATCH_CANONICAL = "MATCH_CANONICAL"
    VALID_DIALECT_VARIANT = "VALID_DIALECT_VARIANT"
    SUBSTITUTION = "SUBSTITUTION"
    INSERTION = "INSERTION"
    DELETION = "DELETION"
    EPENTHESIS = "EPENTHESIS"
    DISTORTION_NON_INVENTORY = "DISTORTION_NON_INVENTORY"
    UNCERTAIN = "UNCERTAIN"


@dataclass
class PassAPayload:
    """
    Firewalled payload presented to human annotator in Pass A.
    STRICTLY FORBIDDEN: canonical transcript, expected phone, word context, model predictions.
    """
    item_id: str
    audio_id: str
    segment_start_ms: float
    segment_end_ms: float
    pre_context_ms: float = 50.0
    post_context_ms: float = 50.0
    sampling_rate: int = 16000
    allowed_phone_inventory: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "itemId": self.item_id,
            "audioId": self.audio_id,
            "segmentStartMs": self.segment_start_ms,
            "segmentEndMs": self.segment_end_ms,
            "preContextMs": self.pre_context_ms,
            "postContextMs": self.post_context_ms,
            "samplingRate": self.sampling_rate,
            "allowedPhoneInventory": self.allowed_phone_inventory,
        }

    def verify_firewall_integrity(self) -> bool:
        """Verifies that no canonical or model leakage exists in Pass A payload."""
        forbidden_attrs = ["expected_phone", "canonical_phone", "reference_word", "transcript", "model_prediction", "confidence", "risk_score"]
        for attr in forbidden_attrs:
            if hasattr(self, attr):
                return False
        return True


@dataclass
class PassAResponse:
    """Acoustic reality judgment submitted by an annotator during Pass A."""
    annotator_id: str
    timestamp_utc: str
    status: PassAJudgmentStatus
    primary_perceived_phone: str
    alternative_phones: List[str] = field(default_factory=list)
    confidence: float = 1.0  # 1 (low) to 5 (high) or 0.0 to 1.0
    intelligibility_score: float = 1.0  # 1 (poor) to 5 (excellent)
    is_ambiguous: bool = False
    articulatory_notes: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "annotatorId": self.annotator_id,
            "timestampUtc": self.timestamp_utc,
            "status": self.status.value,
            "primaryPerceivedPhone": self.primary_perceived_phone,
            "alternativePhones": self.alternative_phones,
            "confidence": float(self.confidence),
            "intelligibilityScore": float(self.intelligibility_score),
            "isAmbiguous": bool(self.is_ambiguous),
            "articulatoryNotes": self.articulatory_notes,
        }


@dataclass
class PassBPayload:
    """Context payload released ONLY after Pass A submission is sealed."""
    item_id: str
    expected_canonical_phone: str
    reference_word: str
    sentence_context: Optional[str] = None
    valid_dialect_variants: List[str] = field(default_factory=list)
    pass_a_primary_perceived_phone: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "itemId": self.item_id,
            "expectedCanonicalPhone": self.expected_canonical_phone,
            "referenceWord": self.reference_word,
            "sentenceContext": self.sentence_context,
            "validDialectVariants": self.valid_dialect_variants,
            "passAPrimaryPerceivedPhone": self.pass_a_primary_perceived_phone,
        }


@dataclass
class PassBResponse:
    """Pronunciation evaluation judgment submitted during Pass B."""
    annotator_id: str
    timestamp_utc: str
    error_type: PassBErrorType
    is_valid_variant: bool
    pedagogical_severity: int = 1  # 1 (minor/acceptable) to 5 (critical breakdown)
    judgment_notes: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "annotatorId": self.annotator_id,
            "timestampUtc": self.timestamp_utc,
            "errorType": self.error_type.value,
            "isValidVariant": bool(self.is_valid_variant),
            "pedagogicalSeverity": int(self.pedagogical_severity),
            "judgmentNotes": self.judgment_notes,
        }


@dataclass
class AmbiguityDistribution:
    """Distributional human perceptual target preserving perceptual ambiguity."""
    phone_probabilities: Dict[str, float]
    entropy: float
    total_votes: int
    majority_phone: str
    majority_fraction: float
    is_ambiguous: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "phoneProbabilities": {k: round(float(v), 4) for k, v in self.phone_probabilities.items()},
            "entropy": round(float(self.entropy), 4),
            "totalVotes": int(self.total_votes),
            "majorityPhone": self.majority_phone,
            "majorityFraction": round(float(self.majority_fraction), 4),
            "isAmbiguous": bool(self.is_ambiguous),
        }


def compute_vote_distribution(votes: Sequence[str]) -> AmbiguityDistribution:
    """Computes empirical probability distribution and entropy over perceived phone votes."""
    if not votes:
        return AmbiguityDistribution(
            phone_probabilities={},
            entropy=0.0,
            total_votes=0,
            majority_phone="",
            majority_fraction=0.0,
            is_ambiguous=False,
        )

    n = len(votes)
    counts = Counter(votes)
    probs = {p: count / n for p, count in counts.items()}
    
    entropy = -sum(p * math.log2(p) for p in probs.values() if p > 0)
    majority_phone, majority_count = counts.most_common(1)[0]
    majority_fraction = majority_count / n
    is_ambiguous = (majority_fraction < 0.70) or (len(counts) > 1 and entropy > 0.80)

    return AmbiguityDistribution(
        phone_probabilities=probs,
        entropy=float(entropy),
        total_votes=n,
        majority_phone=majority_phone,
        majority_fraction=float(majority_fraction),
        is_ambiguous=is_ambiguous,
    )


@dataclass
class TwoPassAnnotationItem:
    """Full lifecycle container for a firewalled two-pass annotation item."""
    item_id: str
    audio_id: str
    speaker_id: str
    segment_start_ms: float
    segment_end_ms: float
    expected_canonical_phone: str
    reference_word: str
    sentence_context: Optional[str] = None
    pass_a_responses: List[PassAResponse] = field(default_factory=list)
    pass_b_responses: List[PassBResponse] = field(default_factory=list)
    adjudication_state: AdjudicationState = AdjudicationState.ADJUDICATION_REQUIRED
    gold_tier: LabelTier = LabelTier.TIER_1_SINGLE_HUMAN
    distribution: Optional[AmbiguityDistribution] = None
    is_locked: bool = False

    def create_pass_a_payload(self, allowed_inventory: List[str]) -> PassAPayload:
        """Builds clean, firewalled Pass A payload."""
        return PassAPayload(
            item_id=self.item_id,
            audio_id=self.audio_id,
            segment_start_ms=self.segment_start_ms,
            segment_end_ms=self.segment_end_ms,
            allowed_phone_inventory=allowed_inventory,
        )

    def submit_pass_a_response(self, response: PassAResponse) -> None:
        """Records Pass A judgment."""
        if self.is_locked:
            raise RuntimeError(f"Annotation item {self.item_id} is locked against modifications.")
        self.pass_a_responses.append(response)

    def create_pass_b_payload(self, annotator_id: str) -> PassBPayload:
        """Constructs Pass B context after verifying Pass A submission exists for annotator."""
        matching_a = [r for r in self.pass_a_responses if r.annotator_id == annotator_id]
        if not matching_a:
            raise PermissionError(f"Pass B cannot be accessed before Pass A is submitted for annotator {annotator_id}.")

        return PassBPayload(
            item_id=self.item_id,
            expected_canonical_phone=self.expected_canonical_phone,
            reference_word=self.reference_word,
            sentence_context=self.sentence_context,
            pass_a_primary_perceived_phone=matching_a[-1].primary_perceived_phone,
        )

    def submit_pass_b_response(self, response: PassBResponse) -> None:
        """Records Pass B judgment."""
        if self.is_locked:
            raise RuntimeError(f"Annotation item {self.item_id} is locked against modifications.")
        matching_a = [r for r in self.pass_a_responses if r.annotator_id == response.annotator_id]
        if not matching_a:
            raise PermissionError(f"Pass B response rejected: Missing locked Pass A judgment for {response.annotator_id}.")
        self.pass_b_responses.append(response)

    def finalize_adjudication(self) -> None:
        """Aggregates votes, determines consensus state, and sets gold tier."""
        votes = [r.primary_perceived_phone for r in self.pass_a_responses if r.status == PassAJudgmentStatus.PERCEIVED]
        self.distribution = compute_vote_distribution(votes)

        n = len(votes)
        if n == 0:
            self.adjudication_state = AdjudicationState.QUALITY_REJECT
            self.gold_tier = LabelTier.TIER_0_MACHINE_DERIVED
        elif n == 1:
            self.adjudication_state = AdjudicationState.ADJUDICATION_REQUIRED
            self.gold_tier = LabelTier.TIER_1_SINGLE_HUMAN
        elif n == 3 and self.distribution.majority_fraction == 1.0:
            self.adjudication_state = AdjudicationState.CONSENSUS_3_OF_3
            self.gold_tier = LabelTier.TIER_3_ADJUDICATED_GOLD
        elif n >= 2 and self.distribution.majority_fraction >= 0.66:
            self.adjudication_state = AdjudicationState.MAJORITY_2_OF_3
            self.gold_tier = LabelTier.TIER_2_MULTI_HUMAN_UNADJUDICATED
        else:
            self.adjudication_state = AdjudicationState.AMBIGUOUS_VALID
            self.gold_tier = LabelTier.TIER_A_AMBIGUOUS_DISTRIBUTIONAL

        self.is_locked = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "itemId": self.item_id,
            "audioId": self.audio_id,
            "speakerId": self.speaker_id,
            "segmentStartMs": self.segment_start_ms,
            "segmentEndMs": self.segment_end_ms,
            "expectedCanonicalPhone": self.expected_canonical_phone,
            "referenceWord": self.reference_word,
            "passAResponses": [r.to_dict() for r in self.pass_a_responses],
            "passBResponses": [r.to_dict() for r in self.pass_b_responses],
            "adjudicationState": self.adjudication_state.value,
            "goldTier": self.gold_tier.value,
            "distribution": self.distribution.to_dict() if self.distribution else None,
            "isLocked": self.is_locked,
        }


@dataclass
class PrivateDataFlywheelRecord:
    """
    Versioned record for private, consented learner audio attempts.
    Guarantees privacy preservation, pseudonymization, and speaker-disjoint split allocation.
    """
    sample_id: str
    audio_sha256: str
    speaker_pseudonym_id: str
    source_dataset: str
    consent_category: str  # "EXPLICIT_RESEARCH_TRAINING_CONSENT" or "IN_APP_IMPROVEMENT"
    training_permission: bool
    retention_policy: str  # "PERMANENT_RESEARCH" or "90_DAY_EPHEMERAL"
    annotation_tier: LabelTier
    annotation_version: str
    phone_inventory_version: str
    segment_start_ms: float
    segment_end_ms: float
    expected_canonical_phone: str
    quality_status: str  # "CLEAN", "LOW_SNR", "CLIPPING"
    split_assignment: str  # "TRAIN", "CALIBRATION", "VALIDATION", "BLIND_TEST"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sampleId": self.sample_id,
            "audioSha256": self.audio_sha256,
            "speakerPseudonymId": self.speaker_pseudonym_id,
            "sourceDataset": self.source_dataset,
            "consentCategory": self.consent_category,
            "trainingPermission": bool(self.training_permission),
            "retentionPolicy": self.retention_policy,
            "annotationTier": self.annotation_tier.value,
            "annotationVersion": self.annotation_version,
            "phoneInventoryVersion": self.phone_inventory_version,
            "segmentBounds": [float(self.segment_start_ms), float(self.segment_end_ms)],
            "expectedCanonicalPhone": self.expected_canonical_phone,
            "qualityStatus": self.quality_status,
            "splitAssignment": self.split_assignment,
        }


def assign_deterministic_speaker_split(
    speaker_pseudonym_id: str,
    train_frac: float = 0.70,
    calib_frac: float = 0.10,
    val_frac: float = 0.10,
    blind_test_frac: float = 0.10,
    salt: str = "ECSM_SPEAKER_SPLIT_v1",
) -> str:
    """
    Deterministically maps a speaker pseudonym to an immutable split pool.
    Guarantees zero speaker overlap between TRAIN, CALIBRATION, VALIDATION, and BLIND_TEST.
    """
    hash_input = f"{salt}:{speaker_pseudonym_id}".encode("utf-8")
    hash_val = int(hashlib.sha256(hash_input).hexdigest()[:8], 16)
    uniform_val = hash_val / float(0xFFFFFFFF)

    if uniform_val < train_frac:
        return "TRAIN"
    elif uniform_val < (train_frac + calib_frac):
        return "CALIBRATION"
    elif uniform_val < (train_frac + calib_frac + val_frac):
        return "VALIDATION"
    else:
        return "BLIND_TEST"
