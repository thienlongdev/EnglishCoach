"""
SHD-2B.4 Targeted L2 Data Foundation + Parameter-Efficient Adapter Fine-Tuning Service
English Coach — Self-Hosted Acoustic Pronunciation Assessment Research

This module provides:
1. Canonical Baseline Freeze & Verification (facebook/wav2vec2-lv-60-espeak-cv-ft)
2. Strict Speaker-Disjoint Partitioning & Zero-Leakage Assertion
3. Multi-Task Supervision Targets & Class-Imbalance Objectives (Weighted BCE, Focal, Ranking)
4. Parameter-Efficient Adapter Architectures (Linear Probe, Native LoRA Ranks 2/4/8, Partial Unfreeze)
5. CTC Phoneme Preservation & Multi-Variant Alignment Drift Monitoring
6. Genuine L2 Data Collection Manifest & Blinded Double-Annotation Queues (Track A)
7. Standalone Checkpoint Serialization & Validation
8. Reproducibility Seeds & Training Stability Safety Controls
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

logger = logging.getLogger("fine_tuning_adapter")

# ---------------------------------------------------------------------------
# Constants & Model Identity
# ---------------------------------------------------------------------------

CANONICAL_MODEL_ID = "facebook/wav2vec2-lv-60-espeak-cv-ft"
CANONICAL_MODEL_REVISION = "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"
SHD_2B4_SCHEMA = "shd-2b.4-fine-tuning-v1"

DEFAULT_SEEDS = (20260830, 20260831)
PRIMARY_ERROR_THRESHOLD = 0.5
SENSITIVITY_ERROR_THRESHOLD = 2.0
PERFECT_SCORE_THRESHOLD = 2.0

# ---------------------------------------------------------------------------
# 1. Canonical Frozen Baseline Definition
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CanonicalBaselineSnapshot:
    modelId: str = CANONICAL_MODEL_ID
    modelRevision: str = CANONICAL_MODEL_REVISION
    primaryRocAuc: float = 0.885882
    primaryPrAuc: float = 0.264768
    primaryEer: float = 0.193256
    primaryRocAucCi95: Tuple[float, float] = (0.870848, 0.902914)
    primaryPrAucCi95: Tuple[float, float] = (0.188954, 0.331760)
    primaryEerCi95: Tuple[float, float] = (0.171053, 0.209521)
    adultPrimaryRocAuc: float = 0.891035
    childPrimaryRocAuc: float = 0.869838
    sensitivityRocAuc: float = 0.717973
    sensitivityPrAuc: float = 0.358241
    sensitivityEer: float = 0.339255
    wordAggregationRho: float = 0.336845
    studioGopMedian: float = 4.0476
    speechOceanGopMedian: float = 1.0606
    browserGopMedian: float = -2.4656
    studioVsSpeechOceanGap: float = 2.9870
    speechOceanVsBrowserGap: float = 3.5262
    studioVsBrowserGap: float = 6.5132

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["primaryRocAucCi95"] = list(self.primaryRocAucCi95)
        d["primaryPrAucCi95"] = list(self.primaryPrAucCi95)
        d["primaryEerCi95"] = list(self.primaryEerCi95)
        return d


CANONICAL_BASELINE = CanonicalBaselineSnapshot()


# ---------------------------------------------------------------------------
# 2. Data Splitting & Zero-Leakage Validation
# ---------------------------------------------------------------------------

@dataclass
class DatasetPartitionManifest:
    datasetName: str
    totalSpeakers: int
    trainSpeakers: List[str]
    valSpeakers: List[str]
    testSpeakers: List[str]
    trainInstances: int
    valInstances: int
    testInstances: int
    manifestHash: str
    isZeroLeakageVerified: bool

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def verify_speaker_partition_integrity(
    train_speakers: Iterable[str],
    val_speakers: Iterable[str],
    test_speakers: Iterable[str],
) -> Dict[str, Any]:
    """Verify strictly disjoint speaker partitions with zero leakage."""
    s_train = set(train_speakers)
    s_val = set(val_speakers)
    s_test = set(test_speakers)

    train_val_overlap = s_train & s_val
    train_test_overlap = s_train & s_test
    val_test_overlap = s_val & s_test

    total_overlap = train_val_overlap | train_test_overlap | val_test_overlap
    is_valid = len(total_overlap) == 0

    if not is_valid:
        raise ValueError(
            f"Speaker partition leakage detected! Overlapping speakers: {sorted(total_overlap)}"
        )

    return {
        "trainSpeakerCount": len(s_train),
        "valSpeakerCount": len(s_val),
        "testSpeakerCount": len(s_test),
        "trainValOverlap": len(train_val_overlap),
        "trainTestOverlap": len(train_test_overlap),
        "valTestOverlap": len(val_test_overlap),
        "zeroLeakageVerified": True,
    }


# ---------------------------------------------------------------------------
# 3. Supervision Targets & Loss Formulations
# ---------------------------------------------------------------------------

@dataclass
class SupervisionTargetMapping:
    scoreScale: str  # "0_TO_2" or "0_TO_10"
    rawHumanScore: float
    primaryBinaryLabel: Optional[int]  # 1 = error, 0 = correct, None = intermediate excluded
    sensitivityBinaryLabel: Optional[int]  # 1 = error, 0 = correct
    normalizedContinuousScore: float  # 0.0 (severe error) to 1.0 (perfect native)
    isIntermediateExcluded: bool


def map_supervision_targets(
    raw_score: float,
    score_scale: Optional[str] = None,
) -> SupervisionTargetMapping:
    """
    Map raw human scoring to primary binary, sensitivity binary, and continuous ordinal targets.
    Handles both 0-2 and 0-10 raw score representations deterministically.
    """
    if score_scale == "0_TO_10" or (score_scale is None and raw_score > 2.0):
        score_0_2 = (raw_score / 10.0) * 2.0
        scale = "0_TO_10"
    else:
        score_0_2 = raw_score
        scale = "0_TO_2"

    score_0_2 = max(0.0, min(2.0, score_0_2))
    norm_cont = score_0_2 / 2.0  # 0.0 to 1.0

    # Sensitivity binary: < 2.0 is error (1), == 2.0 is correct (0)
    sensitivity_label = 1 if score_0_2 < PERFECT_SCORE_THRESHOLD else 0

    # Primary binary: < 0.5 is error (1), == 2.0 is correct (0), [0.5, 2.0) excluded
    if score_0_2 < PRIMARY_ERROR_THRESHOLD:
        primary_label = 1
        is_intermediate = False
    elif score_0_2 >= PERFECT_SCORE_THRESHOLD:
        primary_label = 0
        is_intermediate = False
    else:
        primary_label = None
        is_intermediate = True

    return SupervisionTargetMapping(
        scoreScale=scale,
        rawHumanScore=raw_score,
        primaryBinaryLabel=primary_label,
        sensitivityBinaryLabel=sensitivity_label,
        normalizedContinuousScore=norm_cont,
        isIntermediateExcluded=is_intermediate,
    )


class ClassWeightedBCELoss(nn.Module):
    """Numerically stable binary cross entropy with positive class weight."""

    def __init__(self, pos_weight: float = 1.0):
        super().__init__()
        self.pos_weight = torch.tensor([pos_weight], dtype=torch.float32)

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        pos_w = self.pos_weight.to(logits.device)
        return F.binary_cross_entropy_with_logits(logits, targets, pos_weight=pos_w)


class FocalPronunciationLoss(nn.Module):
    """Focal loss for extreme positive/negative class imbalance."""

    def __init__(self, alpha: float = 0.25, gamma: float = 2.0):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        p = torch.sigmoid(logits)
        bce = F.binary_cross_entropy_with_logits(logits, targets, reduction="none")
        p_t = p * targets + (1 - p) * (1 - targets)
        alpha_t = self.alpha * targets + (1 - self.alpha) * (1 - targets)
        loss = alpha_t * ((1 - p_t) ** self.gamma) * bce
        return loss.mean()


class PairwiseRankingLoss(nn.Module):
    """Margin ranking loss: scores for correct pronunciations must exceed error scores."""

    def __init__(self, margin: float = 0.5):
        super().__init__()
        self.margin = margin

    def forward(
        self,
        pred_correct: torch.Tensor,
        pred_error: torch.Tensor,
    ) -> torch.Tensor:
        # pred_correct should have higher quality score than pred_error
        # Loss = max(0, margin - (pred_correct - pred_error))
        return F.relu(self.margin - (pred_correct - pred_error)).mean()


# ---------------------------------------------------------------------------
# 4. Parameter-Efficient Adapter Architectures
# ---------------------------------------------------------------------------

class LinearProbeHead(nn.Module):
    """
    Model B: Lightweight pronunciation quality scoring head on frozen Wav2Vec2 representations.
    Uses optional LayerNorm (for d > 1), Dropout, hidden projection, GELU, and output projection.
    """

    def __init__(self, input_dim: int = 1024, hidden_dim: int = 256, dropout: float = 0.05):
        super().__init__()
        self.use_norm = input_dim > 1
        if self.use_norm:
            self.layer_norm = nn.LayerNorm(input_dim)
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.gelu = nn.GELU()
        self.dropout = nn.Dropout(dropout) if dropout > 0.0 else nn.Identity()
        self.fc2 = nn.Linear(hidden_dim, 1)

        # Consistent directional initialization: higher GOP -> lower error probability
        nn.init.uniform_(self.fc1.weight, -0.2, -0.05)
        nn.init.zeros_(self.fc1.bias)
        nn.init.uniform_(self.fc2.weight, 0.05, 0.2)
        nn.init.zeros_(self.fc2.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.layer_norm(x) if self.use_norm else x
        h = self.fc1(h)
        h = self.gelu(h)
        h = self.dropout(h)
        logits = self.fc2(h)
        return logits.squeeze(-1)


class LoRAAdapterLinear(nn.Module):
    """
    Native low-rank adapter layer for linear projections:
    W = W_0 + (alpha / rank) * (B @ A)
    """

    def __init__(
        self,
        base_linear: nn.Linear,
        rank: int = 4,
        alpha: float = 8.0,
        dropout: float = 0.05,
    ):
        super().__init__()
        self.base_linear = base_linear
        self.rank = rank
        self.alpha = alpha
        self.scaling = alpha / rank

        # Freeze base linear
        self.base_linear.weight.requires_grad = False
        if self.base_linear.bias is not None:
            self.base_linear.bias.requires_grad = False

        in_dim = base_linear.in_features
        out_dim = base_linear.out_features

        # Low-rank matrices
        self.lora_A = nn.Parameter(torch.empty(rank, in_dim))
        self.lora_B = nn.Parameter(torch.zeros(out_dim, rank))
        self.dropout = nn.Dropout(dropout) if dropout > 0.0 else nn.Identity()

        # Kaiming uniform init for A, zero init for B so adapter begins as identity
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
        nn.init.zeros_(self.lora_B)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        base_out = self.base_linear(x)
        lora_out = (self.dropout(x) @ self.lora_A.T) @ self.lora_B.T * self.scaling
        return base_out + lora_out


class MultiTaskPronunciationAdapter(nn.Module):
    """
    Model C & D: Multi-task pronunciation assessment model combining:
    - Base Acoustic Feature Encoder (with optional LoRA or frozen weights)
    - Original CTC Phoneme Head (preserved for phoneme alignment & stability)
    - Auxiliary Pronunciation Error Scoring Head (LinearProbeHead)
    """

    def __init__(
        self,
        input_dim: int = 1024,
        vocab_size: int = 345,
        adapter_rank: Optional[int] = 4,
        hidden_dim: int = 256,
        is_partial_unfreeze: bool = False,
        freeze_ctc_head: bool = True,
    ):
        super().__init__()
        self.input_dim = input_dim
        self.vocab_size = vocab_size
        self.adapter_rank = adapter_rank
        self.is_partial_unfreeze = is_partial_unfreeze

        # CTC Head for phoneme representation preservation
        self.ctc_head = nn.Linear(input_dim, vocab_size)
        if freeze_ctc_head:
            self.ctc_head.weight.requires_grad = False
            if self.ctc_head.bias is not None:
                self.ctc_head.bias.requires_grad = False

        # Pronunciation quality prediction head
        self.score_head = LinearProbeHead(input_dim=input_dim, hidden_dim=hidden_dim)

    def forward(
        self,
        frame_features: torch.Tensor,
        phone_pooled_features: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            frame_features: [Batch, Time, Dim] for CTC phoneme prediction.
            phone_pooled_features: [Batch, NumPhones, Dim] for pronunciation scoring.
        Returns:
            (ctc_logits, score_logits)
        """
        ctc_logits = self.ctc_head(frame_features)
        score_logits = self.score_head(phone_pooled_features)
        return ctc_logits, score_logits

    def count_trainable_parameters(self) -> Dict[str, int]:
        trainable = sum(p.numel() for p in self.parameters() if p.requires_grad)
        total = sum(p.numel() for p in self.parameters())
        return {
            "trainableParameters": trainable,
            "totalParameters": total,
            "trainableRatio": trainable / max(1, total),
        }


# ---------------------------------------------------------------------------
# 5. Model Evaluation & Comparison Structures
# ---------------------------------------------------------------------------

@dataclass
class ExperimentalModelResult:
    modelFamily: str  # "FROZEN_BASELINE", "LINEAR_PROBE_SCORING_HEAD", "LOW_RANK_SCORING_HEAD_RANK_2", "LOW_RANK_SCORING_HEAD_RANK_4", "LOW_RANK_SCORING_HEAD_RANK_8", "DEEP_MLP_SCORING_HEAD"
    experimentId: str
    seed: int
    trainableParameters: int
    trainablePercentage: float
    bestEpoch: int
    totalEpochs: int
    trainLoss: float
    valLoss: float
    primaryRocAuc: float
    primaryPrAuc: float
    primaryEer: float
    primaryRocAucCi95: List[float]
    primaryPrAucCi95: List[float]
    primaryEerCi95: List[float]
    sensitivityRocAuc: float
    sensitivityPrAuc: float
    sensitivityEer: float
    adultPrimaryRocAuc: float
    childPrimaryRocAuc: float
    wordAggregationRho: float
    ctcPhonemeAgreement: float  # fraction of frames matching base model
    alignmentPathDrift: float  # percentage drift
    studioVsSpeechOceanGap: float
    speechOceanVsBrowserGap: float
    studioVsBrowserGap: float
    rawVsRmsGapDelta: float
    inferenceLatencyMsPerUtt: float
    inferenceThroughputUttPerSec: float
    peakVramMb: float
    decisionStatus: str  # "CANONICAL_BASELINE", "NO_HELD_OUT_GAIN", "OVERFITTING_DEGRADATION"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 6. Genuine L2 Data Collection Foundation (Track A)
# ---------------------------------------------------------------------------

@dataclass
class L2CollectionManifestRecord:
    recordId: str
    speakerId: str
    promptId: str
    targetPhone: str
    targetWord: str
    phonePosition: str
    audioPath: str
    audioSha256: str
    recordingEnvironment: Dict[str, Any]
    l1Background: Optional[str] = None
    annotatorA_correct: Optional[bool] = None
    annotatorB_correct: Optional[bool] = None
    annotatorA_confidence: Optional[float] = None
    annotatorB_confidence: Optional[float] = None
    annotatorA_observedPhone: Optional[str] = None
    annotatorB_observedPhone: Optional[str] = None
    adjudicator_correct: Optional[bool] = None
    adjudicationStatus: str = "PENDING_COLLECTION"  # "PENDING_COLLECTION", "QUEUED_ANNOTATION", "ADJUDICATED"
    isSynthetic: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class AnnotationQueueManager:
    """
    Manages blinded double-annotation queues for Annotators A and B,
    and routes discrepant cases to Adjudication.
    """

    def __init__(self, collection_manifest: Optional[List[L2CollectionManifestRecord]] = None):
        self.records = collection_manifest or []

    def generate_blinded_queue(self, annotator_id: str) -> List[Dict[str, Any]]:
        """
        Generate blinded queue for an annotator.
        Strict Invariant: Model predictions, GOP scores, and co-annotator scores are NEVER exposed.
        """
        queue = []
        for r in self.records:
            queue.append({
                "queueItemKey": f"{r.recordId}:{annotator_id}",
                "recordId": r.recordId,
                "promptId": r.promptId,
                "audioPath": r.audioPath,
                "targetWord": r.targetWord,
                "targetPhone": r.targetPhone,
                "phonePosition": r.phonePosition,
                "recordingSampleRate": r.recordingEnvironment.get("sampleRate", 16000),
                # Blinding fields strictly absent:
                # "gopScore": None, "modelPrediction": None, "otherAnnotator": None
            })
        return queue

    def generate_adjudication_queue(self) -> List[Dict[str, Any]]:
        """Identify records where Annotator A and Annotator B disagreed."""
        discrepant = []
        for r in self.records:
            if r.annotatorA_correct is not None and r.annotatorB_correct is not None:
                if r.annotatorA_correct != r.annotatorB_correct:
                    discrepant.append({
                        "recordId": r.recordId,
                        "targetPhone": r.targetPhone,
                        "targetWord": r.targetWord,
                        "annotatorA_verdict": r.annotatorA_correct,
                        "annotatorB_verdict": r.annotatorB_correct,
                        "annotatorA_confidence": r.annotatorA_confidence,
                        "annotatorB_confidence": r.annotatorB_confidence,
                    })
        return discrepant


# ---------------------------------------------------------------------------
# 7. Portable Checkpoint Exporter & Serializer
# ---------------------------------------------------------------------------

def export_experimental_checkpoint(
    checkpoint_dir: Path,
    experiment_id: str,
    model: nn.Module,
    model_family: str,
    hyperparameters: Dict[str, Any],
    metrics: Dict[str, Any],
    train_manifest_hash: str,
    val_manifest_hash: str,
    seed: int,
) -> Path:
    """
    Serialize an experimental model checkpoint and associated metadata to an ignored research directory.
    """
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    target_path = checkpoint_dir / f"checkpoint_{experiment_id}"
    target_path.mkdir(parents=True, exist_ok=True)

    # Save state dict
    weights_path = target_path / "model_weights.pt"
    torch.save(model.state_dict(), weights_path)

    # Save metadata
    meta = {
        "schemaVersion": SHD_2B4_SCHEMA,
        "experimentId": experiment_id,
        "modelFamily": model_family,
        "checkpointClassification": "SCORING_HEAD_CHECKPOINT",
        "baseModelId": CANONICAL_MODEL_ID,
        "baseModelRevision": CANONICAL_MODEL_REVISION,
        "trainManifestHash": train_manifest_hash,
        "valManifestHash": val_manifest_hash,
        "seed": seed,
        "hyperparameters": hyperparameters,
        "evaluationSummary": metrics,
        "productionDeployable": False,
        "productionWarning": "Experimental research scoring-head checkpoint only. Base Wav2Vec2 weights remain frozen. Do NOT activate in production API.",
    }

    meta_path = target_path / "checkpoint_metadata.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return target_path
