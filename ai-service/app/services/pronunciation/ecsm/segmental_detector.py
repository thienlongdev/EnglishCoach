"""
ECSM Phase P6/P6.2R/P8 Segmental Acoustic Phone Detector.
Frozen Research Winner Architecture:
Frozen HuBERT Base Layer 9 + Soft Temporal Evidence + Cosine kNN15 + P5.1 Selective Policy.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import logging
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np
from sklearn.neighbors import NearestNeighbors
import torch

from app.services.pronunciation.ecsm.backbone_adapter import (
    AcousticBackboneAdapter,
    BACKBONE_REGISTRY,
    BackboneCandidate,
    BackboneConfig,
)

logger = logging.getLogger("ecsm_segmental_detector")


@dataclass
class SegmentalPhoneResult:
    word_id: str
    word: str
    word_index: int
    phone_id: str
    phone_index_within_word: int
    global_phone_index: int
    expected_phone: str
    time_start_sec: float
    time_end_sec: float
    center_frame: float
    duration_frames: float
    temporal_mode: str
    raw_error_score: float
    calibrated_error_probability: float
    target_class_support: float
    candidate_observed_phone: Optional[str]
    exact_phone_confidence: Optional[float]
    exact_phone_trusted: bool
    top_neighbors: List[Dict[str, Any]]
    evidence_id: str
    provenance: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "wordId": self.word_id,
            "word": self.word,
            "wordIndex": self.word_index,
            "phoneId": self.phone_id,
            "phoneIndexWithinWord": self.phone_index_within_word,
            "globalPhoneIndex": self.global_phone_index,
            "expectedPhone": self.expected_phone,
            "timeStartSec": round(self.time_start_sec, 3),
            "timeEndSec": round(self.time_end_sec, 3),
            "centerFrame": round(self.center_frame, 1),
            "durationFrames": round(self.duration_frames, 1),
            "temporalMode": self.temporal_mode,
            "rawErrorScore": round(self.raw_error_score, 4),
            "calibratedErrorProbability": round(self.calibrated_error_probability, 4),
            "targetClassSupport": round(self.target_class_support, 4),
            "candidateObservedPhone": self.candidate_observed_phone,
            "exactPhoneConfidence": round(self.exact_phone_confidence, 4) if self.exact_phone_confidence is not None else None,
            "exactPhoneTrusted": self.exact_phone_trusted,
            "topNeighbors": self.top_neighbors,
            "evidenceId": self.evidence_id,
            "provenance": self.provenance,
        }


class HuBERTKNNPhoneDetector:
    """
    Frozen HuBERT Base Layer 9 + Soft Temporal Evidence + Cosine kNN-15 Detector.
    Strictly adheres to Phase P6.2R research winner specification.
    """

    def __init__(
        self,
        device: Optional[torch.device] = None,
        reference_index_path: Optional[Path] = None,
        k: int = 15,
    ):
        self.device = device or torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.k = k
        self.metric = "cosine"
        self.selected_layer = 9
        self.hidden_dim = 768
        self.stride_samples = 320
        self.sample_rate = 16000
        self.frames_per_sec = 50.0

        # Load backbone adapter once
        self.config = BACKBONE_REGISTRY[BackboneCandidate.B1_HUBERT_BASE]
        self.adapter: Optional[AcousticBackboneAdapter] = None
        self._load_backbone()

        # Load reference index
        if reference_index_path is None:
            default_path = Path(__file__).resolve().parent / "data" / "hubert_knn_reference_index.npz"
            self.reference_index_path = default_path
        else:
            self.reference_index_path = reference_index_path

        self.reference_features: Optional[np.ndarray] = None
        self.reference_labels: Optional[np.ndarray] = None
        self.knn_index: Optional[NearestNeighbors] = None
        self.index_metadata: Dict[str, Any] = {}
        self._load_reference_index()

    def _load_backbone(self) -> None:
        try:
            logger.info(f"Loading HuBERT Base Layer 9 backbone on {self.device}...")
            self.adapter = AcousticBackboneAdapter(self.config, device=self.device)
            logger.info("HuBERT Base Layer 9 backbone successfully loaded.")
        except Exception as e:
            logger.error(f"Failed to load HuBERT Base backbone: {e}")
            self.adapter = None

    def _load_reference_index(self) -> None:
        if not self.reference_index_path.exists():
            logger.warning(f"Reference index artifact not found at {self.reference_index_path}")
            return

        try:
            logger.info(f"Loading reference kNN index from {self.reference_index_path}...")
            data = np.load(self.reference_index_path, allow_pickle=True)
            self.reference_features = data["features"].astype(np.float32)
            self.reference_labels = data["labels"]
            if "metadata" in data:
                self.index_metadata = json.loads(str(data["metadata"]))

            # Hypersphere normalize reference features
            norms = np.linalg.norm(self.reference_features, axis=-1, keepdims=True)
            norms[norms < 1e-9] = 1.0
            self.reference_features = self.reference_features / norms

            # Fit NearestNeighbors
            n_neigh = min(self.k, len(self.reference_features))
            self.knn_index = NearestNeighbors(n_neighbors=n_neigh, metric=self.metric)
            self.knn_index.fit(self.reference_features)
            logger.info(
                f"Reference kNN index fitted: {len(self.reference_features)} vectors, "
                f"{len(set(self.reference_labels))} unique phone classes, k={n_neigh}, metric={self.metric}."
            )
        except Exception as e:
            logger.error(f"Failed to load reference kNN index: {e}")
            self.knn_index = None

    def is_operational(self) -> bool:
        return self.adapter is not None and self.knn_index is not None

    def extract_hidden_states(self, audio_waveform: np.ndarray) -> np.ndarray:
        """Extracts [T, 768] frame representations from HuBERT Layer 9."""
        if self.adapter is None:
            raise RuntimeError("HuBERT backbone adapter is not loaded")
        return self.adapter.extract_hidden_states(audio_waveform, selected_layer=self.selected_layer)

    def evaluate_phone_segment(
        self,
        hidden_states: np.ndarray,
        center_sec: float,
        duration_sec: float,
        expected_phone: str,
        temporal_mode: str = "SEGMENTATION_FREE_SOFT",
    ) -> Dict[str, Any]:
        """
        Extracts soft temporal candidate evidence, performs cosine kNN15 query,
        computes continuous raw and calibrated error evidence, and evaluates P5.1 selective trust.
        """
        if self.adapter is None or self.knn_index is None:
            return {
                "raw_error_score": 0.0,
                "calibrated_error_probability": 0.0,
                "target_class_support": 1.0,
                "candidate_observed_phone": None,
                "exact_phone_confidence": None,
                "exact_phone_trusted": False,
                "top_neighbors": [],
            }

        center_frame = center_sec * self.frames_per_sec
        duration_frames = max(1.0, duration_sec * self.frames_per_sec)

        # Soft temporal Gaussian pooling
        soft_h = self.adapter.extract_soft_evidence(
            hidden_states=hidden_states,
            center_frame=center_frame,
            duration_frames=duration_frames,
            temporal_sigma=3.0,
            margin_frames=4,
        )

        # Unit hypersphere normalization
        norm = np.linalg.norm(soft_h)
        z = (soft_h / norm).astype(np.float32) if norm > 1e-9 else soft_h

        # Cosine kNN-15 retrieval
        dists, indices = self.knn_index.kneighbors(z.reshape(1, -1))
        dists = dists[0]
        indices = indices[0]

        top_neighbors = []
        votes: Dict[str, float] = {}
        for rank, (d, idx) in enumerate(zip(dists, indices), 1):
            neigh_phone = str(self.reference_labels[idx])
            sim = max(0.0, float(1.0 - d))
            votes[neigh_phone] = votes.get(neigh_phone, 0.0) + sim
            if rank <= 5:
                top_neighbors.append({
                    "rank": rank,
                    "phone": neigh_phone,
                    "distance": round(float(d), 4),
                    "similarity": round(sim, 4),
                })

        total_vote = sum(votes.values()) + 1e-9
        norm_votes = {p: v / total_vote for p, v in votes.items()}

        # Target class support
        target_support = norm_votes.get(expected_phone, 0.0)
        raw_error_score = float(1.0 - target_support)

        # Competing phone analysis
        competing_candidates = [(p, v) for p, v in norm_votes.items() if p != expected_phone]
        competing_candidates.sort(key=lambda x: x[1], reverse=True)
        top_competing_phone = competing_candidates[0][0] if competing_candidates else None
        top_competing_conf = float(competing_candidates[0][1]) if competing_candidates else 0.0

        # P5.1 Selective Decision Policy
        # Exact observed phone is trusted ONLY if competing phone confidence >= 0.80 and error score >= 0.50
        exact_phone_trusted = False
        candidate_observed_phone = None
        exact_phone_confidence = None

        if raw_error_score >= 0.50 and top_competing_conf >= 0.80 and top_competing_phone is not None:
            candidate_observed_phone = top_competing_phone
            exact_phone_confidence = top_competing_conf
            exact_phone_trusted = True
        elif raw_error_score >= 0.50 and top_competing_phone is not None:
            candidate_observed_phone = None  # abstained exact phone
            exact_phone_confidence = None
            exact_phone_trusted = False

        # Calibrated Error Probability (Smooth continuous transformation)
        calibrated_error_prob = float(np.clip(raw_error_score, 0.0, 1.0))

        return {
            "center_frame": center_frame,
            "duration_frames": duration_frames,
            "temporal_mode": temporal_mode,
            "raw_error_score": raw_error_score,
            "calibrated_error_probability": calibrated_error_prob,
            "target_class_support": target_support,
            "candidate_observed_phone": candidate_observed_phone,
            "exact_phone_confidence": exact_phone_confidence,
            "exact_phone_trusted": exact_phone_trusted,
            "top_neighbors": top_neighbors,
            "all_candidate_support": norm_votes,
        }
