"""
ECSM Phase P0: Acoustic Reality Representations.
Preserves learner acoustic realization under the Canonical Information Firewall.

Candidates:
- R0: MODEL_E Adapted SSL Representation (Region Pooling)
- R1: Context-Aware CTC (Output Context Dependency + Label Prior Correction + Regularized Posterior)
- R2: Segmentation-Free Evidence (GOP-SA / GOP-SF Soft Marginalization)
- R3: Dense Monotonic Reality Representation (OT-inspired Continuous Acoustic Transport)
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def pool_acoustic_region(
    hidden_states: torch.Tensor | np.ndarray,
    start_frame: int,
    end_frame: int,
    mode: str = "mean_max_concat",
) -> np.ndarray:
    """
    Extract a fixed-dimensional acoustic region embedding from frame hidden states [T, D].
    Strictly acoustic: receives only frame indices and hidden states.
    """
    if isinstance(hidden_states, torch.Tensor):
        frames = hidden_states.detach().cpu().numpy()
    else:
        frames = np.asarray(hidden_states)

    num_frames, dim = frames.shape
    if num_frames == 0:
        return np.zeros(dim * (2 if mode == "mean_max_concat" else 1), dtype=np.float32)

    s = max(0, min(start_frame, num_frames - 1))
    e = max(s + 1, min(end_frame, num_frames))
    region = frames[s:e]

    if mode == "mean":
        return np.mean(region, axis=0).astype(np.float32)
    elif mode == "max":
        return np.max(region, axis=0).astype(np.float32)
    elif mode == "mean_max_concat":
        mean_feat = np.mean(region, axis=0).astype(np.float32)
        max_feat = np.max(region, axis=0).astype(np.float32)
        return np.concatenate([mean_feat, max_feat], axis=0)
    else:
        raise ValueError(f"Unknown pooling mode: {mode}")


class ContextAwareCtcRepresentation:
    """
    R1: Context-Aware CTC Representation.
    Implements Output Context Dependency (OCD) logits, Label Prior correction,
    and temporal contextual smoothing to mitigate CTC peakiness and frame instability.
    """

    def __init__(
        self,
        phone_priors: Mapping[str, float],
        phone_to_id: Mapping[str, int],
        blank_id: int = 0,
        prior_alpha: float = 0.5,
        context_window: int = 2,
    ):
        self.phone_to_id = dict(phone_to_id)
        self.id_to_phone = {idx: phone for phone, idx in phone_to_id.items()}
        self.blank_id = blank_id
        self.prior_alpha = prior_alpha
        self.context_window = context_window
        
        # Build log prior vector
        vocab_size = max(phone_to_id.values()) + 1 if phone_to_id else 392
        vocab_size = max(vocab_size, 392)
        self.log_priors = np.zeros(vocab_size, dtype=np.float32)
        eps = 1e-6
        for phone, idx in phone_to_id.items():
            prob = phone_priors.get(phone, eps)
            if idx < vocab_size:
                self.log_priors[idx] = math.log(max(prob, eps))
        if blank_id < vocab_size:
            self.log_priors[blank_id] = 0.0  # Do not suppress blank

    def transform(
        self,
        logits: np.ndarray,
        hidden_states: np.ndarray,
        start_frame: int,
        end_frame: int,
    ) -> np.ndarray:
        """
        Extract context-aware prior-corrected acoustic features.
        Combines contextualized posteriors and pooled acoustic embeddings.
        """
        num_frames, vocab_size = logits.shape
        if len(self.log_priors) != vocab_size:
            # Dynamically resize log_priors
            padded = np.zeros(vocab_size, dtype=np.float32)
            copy_len = min(len(self.log_priors), vocab_size)
            padded[:copy_len] = self.log_priors[:copy_len]
            self.log_priors = padded

        s = max(0, min(start_frame, num_frames - 1))
        e = max(s + 1, min(end_frame, num_frames))

        # 1. Prior-corrected log-probabilities: log P(y_t|x) - alpha * log P(y_t)
        # Softmax over vocabulary dimension
        shifted = logits - np.max(logits, axis=-1, keepdims=True)
        log_probs = shifted - np.log(np.sum(np.exp(shifted), axis=-1, keepdims=True) + 1e-9)
        corrected_log_probs = log_probs - (self.prior_alpha * self.log_priors)

        # Region posteriors
        region_log_probs = corrected_log_probs[s:e]
        region_probs = np.exp(region_log_probs - np.max(region_log_probs, axis=-1, keepdims=True))
        region_probs /= (np.sum(region_probs, axis=-1, keepdims=True) + 1e-9)

        # Mean and max posterior distributions over real phone vocab
        mean_post = np.mean(region_probs, axis=0)
        max_post = np.max(region_probs, axis=0)

        # 2. Contextualized hidden representation
        ctx_s = max(0, s - self.context_window)
        ctx_e = min(num_frames, e + self.context_window)
        ctx_hidden = hidden_states[ctx_s:ctx_e]
        pooled_hidden = np.mean(ctx_hidden, axis=0)

        # Concatenate acoustic representation and posterior evidence
        return np.concatenate([pooled_hidden, mean_post, max_post], axis=0).astype(np.float32)


class SegmentationFreeEvidence:
    """
    R2: Segmentation-Free Pronunciation Evidence (inspired by GOP-SA / GOP-SF).
    Soft temporal marginalization over candidate intervals rather than rigid hard boundaries.
    """

    def __init__(
        self,
        phone_to_id: Mapping[str, int],
        blank_id: int = 0,
        temporal_sigma: float = 3.0,
        margin_frames: int = 4,
    ):
        self.phone_to_id = dict(phone_to_id)
        self.blank_id = blank_id
        self.temporal_sigma = temporal_sigma
        self.margin_frames = margin_frames

    def extract_soft_evidence(
        self,
        logits: np.ndarray,
        hidden_states: np.ndarray,
        center_frame: float,
        duration_frames: float,
    ) -> np.ndarray:
        """
        Compute soft-marginalized acoustic evidence centered at center_frame with Gaussian temporal decay.
        """
        num_frames, vocab_size = logits.shape
        _, dim = hidden_states.shape

        s = max(0, int(center_frame - duration_frames / 2.0 - self.margin_frames))
        e = min(num_frames, int(center_frame + duration_frames / 2.0 + self.margin_frames + 1))

        if e <= s:
            s = max(0, min(int(center_frame), num_frames - 1))
            e = min(num_frames, s + 1)

        t_indices = np.arange(s, e, dtype=np.float32)
        # Gaussian soft temporal weights
        sigma = max(1.0, self.temporal_sigma)
        weights = np.exp(-((t_indices - center_frame) ** 2) / (2.0 * sigma ** 2))
        weights /= (np.sum(weights) + 1e-9)

        # Soft weighted hidden state
        sub_hidden = hidden_states[s:e]  # [L, D]
        soft_hidden = np.sum(sub_hidden * weights[:, None], axis=0)  # [D]

        # Soft weighted posteriors
        sub_logits = logits[s:e]  # [L, V]
        shifted = sub_logits - np.max(sub_logits, axis=-1, keepdims=True)
        probs = np.exp(shifted) / (np.sum(np.exp(shifted), axis=-1, keepdims=True) + 1e-9)
        soft_probs = np.sum(probs * weights[:, None], axis=0)  # [V]

        return np.concatenate([soft_hidden, soft_probs], axis=0).astype(np.float32)


class DenseMonotonicRealityAdapter(nn.Module):
    """
    R3: Dense Monotonic Reality Adapter (OT-inspired Continuous Acoustic Transport).
    Transforms frame representations via a continuous monotonic temporal projection head,
    avoiding CTC frame sparsity while preserving temporal ordering.
    """

    def __init__(self, in_features: int = 1024, out_features: int = 256):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.conv1 = nn.Conv1d(in_features, out_features, kernel_size=3, padding=1)
        self.norm1 = nn.LayerNorm(out_features)
        self.gru = nn.GRU(out_features, out_features // 2, batch_first=True, bidirectional=True)
        self.proj = nn.Linear(out_features, out_features)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Input: [B, T, D] or [T, D]
        Output: [B, T, out_features] or [T, out_features]
        """
        is_2d = (x.ndim == 2)
        if is_2d:
            x = x.unsqueeze(0)
        
        # Temporal convolution
        h = x.transpose(1, 2)  # [B, D, T]
        h = F.gelu(self.conv1(h))
        h = h.transpose(1, 2)  # [B, T, out_features]
        h = self.norm1(h)

        # Monotonic bidirectional temporal encoding
        out, _ = self.gru(h)
        out = self.proj(out)

        if is_2d:
            out = out.squeeze(0)
        return out
