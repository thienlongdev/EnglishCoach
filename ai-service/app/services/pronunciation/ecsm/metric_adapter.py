"""
ECSM-v1 / EC-PRISM Phase P6.2: Ambiguity-Aware Hard Metric Adaptation & Multi-Prototype Retrieval.

Provides:
1. Parameter-Efficient Fine-Tuning (PEFT) modules (< 0.5% trainable parameters):
   - ResidualBottleneckAdapter (768 -> 64 -> 768 with residual skip)
   - MetricProjectionHead (768 -> 256 with LayerNorm and L2 unit hypersphere normalization)
2. Metric loss objectives:
   - Supervised Contrastive Loss with hard-negative and ambiguity-aware sample weighting
   - Hard Triplet Margin Loss
3. Fold-local Hard-Negative Mining (articulatory neighbors, human confusion pairs, critical minimal pairs)
4. Multi-Prototype Clustering (K=1, 2, 3) and Hybrid Retrieval.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.cluster import KMeans
import torch
import torch.nn as nn
import torch.nn.functional as F

from app.services.pronunciation.ecsm.articulatory_reality import (
    FACTOR_VOCABULARIES,
    SharedArticulatoryAdapter,
    compute_articulatory_multitask_loss,
    extract_articulatory_ground_truth,
)
from app.services.pronunciation.ecsm.hard_error_miner import CRITICAL_MINIMAL_PAIRS


class PeftType(str, Enum):
    FROZEN_BASE = "FROZEN_BASE"
    RESIDUAL_BOTTLENECK_ADAPTER = "RESIDUAL_BOTTLENECK_ADAPTER"
    METRIC_PROJECTION_HEAD = "METRIC_PROJECTION_HEAD"
    ADAPTER_PLUS_PROJECTION = "ADAPTER_PLUS_PROJECTION"


class MetricLossType(str, Enum):
    SUPERVISED_CONTRASTIVE = "SUPERVISED_CONTRASTIVE"
    HARD_TRIPLET_MARGIN = "HARD_TRIPLET_MARGIN"
    COSINE_MARGIN = "COSINE_MARGIN"


class ResidualBottleneckAdapter(nn.Module):
    """
    Compact parameter-efficient residual bottleneck adapter.
    Maps input_dim (768) -> bottleneck_dim (64) -> input_dim (768) with residual skip scaling.
    Total trainable parameters: ~99,136 (< 0.11% of HuBERT Base 94.4M).
    """
    def __init__(self, in_dim: int = 768, bottleneck_dim: int = 64, residual_scale: float = 0.5):
        super().__init__()
        self.in_dim = in_dim
        self.bottleneck_dim = bottleneck_dim
        self.residual_scale = residual_scale
        
        self.down_proj = nn.Linear(in_dim, bottleneck_dim)
        self.act = nn.GELU()
        self.up_proj = nn.Linear(bottleneck_dim, in_dim)
        self.norm = nn.LayerNorm(in_dim)
        
        # Initialize up_proj with near-zero weights for identity initialization
        nn.init.zeros_(self.up_proj.weight)
        nn.init.zeros_(self.up_proj.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        h = self.down_proj(x)
        h = self.act(h)
        h = self.up_proj(h)
        out = residual + self.residual_scale * h
        return self.norm(out)


class MetricProjectionHead(nn.Module):
    """
    Trainable metric projection head mapping to unit hypersphere ||z||_2 = 1.
    Maps input_dim (768) -> metric_dim (256) + LayerNorm + L2 normalization.
    """
    def __init__(self, in_dim: int = 768, metric_dim: int = 256):
        super().__init__()
        self.in_dim = in_dim
        self.metric_dim = metric_dim
        self.proj = nn.Linear(in_dim, metric_dim)
        self.norm = nn.LayerNorm(metric_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.proj(x)
        h = self.norm(h)
        # Strict L2 normalization to unit hypersphere
        z = F.normalize(h, p=2, dim=-1)
        return z


class CombinedPeftModel(nn.Module):
    """
    Unified acoustic adaptation model combining backbone feature processing,
    optional residual adapter, metric projection head, and auxiliary heads.
    """
    def __init__(
        self,
        in_dim: int = 768,
        bottleneck_dim: int = 64,
        metric_dim: int = 256,
        num_classes: int = 57,
        peft_type: PeftType = PeftType.ADAPTER_PLUS_PROJECTION,
        include_phone_aux: bool = True,
        include_artic_aux: bool = True,
    ):
        super().__init__()
        self.in_dim = in_dim
        self.metric_dim = metric_dim
        self.peft_type = peft_type
        self.include_phone_aux = include_phone_aux
        self.include_artic_aux = include_artic_aux

        if peft_type in (PeftType.RESIDUAL_BOTTLENECK_ADAPTER, PeftType.ADAPTER_PLUS_PROJECTION):
            self.adapter = ResidualBottleneckAdapter(in_dim=in_dim, bottleneck_dim=bottleneck_dim)
        else:
            self.adapter = None

        if peft_type in (PeftType.METRIC_PROJECTION_HEAD, PeftType.ADAPTER_PLUS_PROJECTION):
            self.metric_head = MetricProjectionHead(in_dim=in_dim, metric_dim=metric_dim)
        else:
            self.metric_head = None

        head_in_dim = metric_dim if self.metric_head is not None else in_dim

        if include_phone_aux:
            self.phone_classifier = nn.Linear(head_in_dim, num_classes)
        else:
            self.phone_classifier = None

        if include_artic_aux:
            self.artic_adapter = SharedArticulatoryAdapter(in_features=head_in_dim, hidden_dim=128)
        else:
            self.artic_adapter = None

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, Optional[torch.Tensor], Optional[Dict[str, torch.Tensor]]]:
        h = x
        if self.adapter is not None:
            h = self.adapter(h)

        if self.metric_head is not None:
            z = self.metric_head(h)
        else:
            z = F.normalize(h, p=2, dim=-1)

        phone_logits = self.phone_classifier(z) if self.phone_classifier is not None else None
        artic_logits = self.artic_adapter(z) if self.artic_adapter is not None else None

        return z, phone_logits, artic_logits

    def count_trainable_parameters(self) -> Dict[str, int]:
        total = sum(p.numel() for p in self.parameters())
        trainable = sum(p.numel() for p in self.parameters() if p.requires_grad)
        adapter_params = sum(p.numel() for p in self.adapter.parameters()) if self.adapter is not None else 0
        metric_params = sum(p.numel() for p in self.metric_head.parameters()) if self.metric_head is not None else 0
        aux_params = total - (adapter_params + metric_params)
        return {
            "totalParams": total,
            "trainableParams": trainable,
            "adapterParams": adapter_params,
            "metricHeadParams": metric_params,
            "auxiliaryParams": aux_params,
        }


class SupervisedContrastiveLoss(nn.Module):
    """
    Supervised Contrastive Loss with hard-negative temperature scaling and ambiguity sample weights.
    """
    def __init__(self, temperature: float = 0.07, hard_negative_weight: float = 2.0):
        super().__init__()
        self.temperature = temperature
        self.hard_negative_weight = hard_negative_weight

    def forward(
        self,
        embeddings: torch.Tensor,
        labels: torch.Tensor,
        sample_weights: Optional[torch.Tensor] = None,
        hard_negative_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        device = embeddings.device
        n = embeddings.shape[0]
        if n <= 1:
            return torch.tensor(0.0, device=device, requires_grad=True)

        # Pairwise cosine similarity matrix
        sim = torch.matmul(embeddings, embeddings.T) / self.temperature

        # Create positive mask: labels[i] == labels[j], excluding self (i == j)
        labels_eq = torch.eq(labels.unsqueeze(1), labels.unsqueeze(0)).float()
        self_mask = torch.eye(n, device=device)
        pos_mask = labels_eq * (1.0 - self_mask)

        # Apply hard-negative weighting if provided
        neg_mask = (1.0 - labels_eq)
        if hard_negative_mask is not None:
            weights_matrix = 1.0 + (self.hard_negative_weight - 1.0) * hard_negative_mask
        else:
            weights_matrix = torch.ones_like(sim)

        # Log-sum-exp over negatives and positives (excluding self)
        sim_max = torch.max(sim, dim=1, keepdim=True)[0].detach()
        exp_sim = torch.exp(sim - sim_max) * (1.0 - self_mask) * weights_matrix
        denom = torch.sum(exp_sim, dim=1, keepdim=True) + 1e-8

        log_prob = (sim - sim_max) - torch.log(denom + 1e-8)

        # Mean over positive pairs per anchor
        num_pos = torch.sum(pos_mask, dim=1)
        valid_anchors = num_pos > 0

        if not torch.any(valid_anchors):
            return torch.tensor(0.0, device=device, requires_grad=True)

        per_anchor_loss = -torch.sum(log_prob * pos_mask, dim=1)[valid_anchors] / num_pos[valid_anchors]

        if sample_weights is not None:
            w = sample_weights[valid_anchors]
            w = w / (torch.mean(w) + 1e-8)
            loss = torch.mean(per_anchor_loss * w)
        else:
            loss = torch.mean(per_anchor_loss)

        return loss


class HardTripletMarginLoss(nn.Module):
    """
    Hard Triplet Margin Loss selecting the closest hard negative in the batch.
    """
    def __init__(self, margin: float = 0.3):
        super().__init__()
        self.margin = margin

    def forward(
        self,
        embeddings: torch.Tensor,
        labels: torch.Tensor,
        sample_weights: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        device = embeddings.device
        n = embeddings.shape[0]
        if n <= 2:
            return torch.tensor(0.0, device=device, requires_grad=True)

        # Pairwise euclidean distance (z is L2 normalized, so d^2 = 2 - 2 * cos_sim)
        sim = torch.matmul(embeddings, embeddings.T)
        dist = torch.clamp(2.0 - 2.0 * sim, min=0.0)

        labels_eq = torch.eq(labels.unsqueeze(1), labels.unsqueeze(0))
        self_mask = torch.eye(n, dtype=torch.bool, device=device)

        pos_mask = labels_eq & (~self_mask)
        neg_mask = ~labels_eq

        losses = []
        for i in range(n):
            pos_indices = torch.where(pos_mask[i])[0]
            neg_indices = torch.where(neg_mask[i])[0]

            if len(pos_indices) == 0 or len(neg_indices) == 0:
                continue

            # Hardest positive (furthest)
            hardest_pos_dist = torch.max(dist[i, pos_indices])
            # Hardest negative (closest)
            hardest_neg_dist = torch.min(dist[i, neg_indices])

            loss_i = F.relu(hardest_pos_dist - hardest_neg_dist + self.margin)
            losses.append(loss_i)

        if not losses:
            return torch.tensor(0.0, device=device, requires_grad=True)

        loss = torch.stack(losses).mean()
        return loss


class FoldLocalHardNegativeMiner:
    """
    Fold-local hard negative generator.
    Constructs high-priority confusing negative phone pairs using:
    1. Fold-train substitution confusion pairs
    2. Articulatory nearest neighbors
    3. Critical minimal pairs
    """
    def __init__(
        self,
        train_canonicals: Sequence[str],
        train_perceived: Sequence[str],
    ):
        self.confusion_pairs = Counter(zip(train_canonicals, train_perceived))
        self.hard_neg_map: Dict[str, Set[str]] = defaultdict(set)
        
        # 1. Add observed substitution pairs
        for (c, p), count in self.confusion_pairs.items():
            if c != p and count >= 2:
                self.hard_neg_map[c].add(p)
                self.hard_neg_map[p].add(c)

        # 2. Add critical minimal pairs
        for p1, p2 in CRITICAL_MINIMAL_PAIRS:
            self.hard_neg_map[p1].add(p2)
            self.hard_neg_map[p2].add(p1)

    def is_hard_negative(self, phone_a: str, phone_b: str) -> bool:
        if phone_a == phone_b:
            return False
        return (phone_b in self.hard_neg_map.get(phone_a, set())) or ((phone_a, phone_b) in CRITICAL_MINIMAL_PAIRS) or ((phone_b, phone_a) in CRITICAL_MINIMAL_PAIRS)

    def get_hard_negative_mask(self, labels: Sequence[str]) -> np.ndarray:
        n = len(labels)
        mask = np.zeros((n, n), dtype=np.float32)
        for i in range(n):
            for j in range(n):
                if i != j and labels[i] != labels[j]:
                    if self.is_hard_negative(labels[i], labels[j]):
                        mask[i, j] = 1.0
        return mask


class PrototypeMemory:
    """
    Fold-local Multi-Prototype Memory (K=1, 2, 3) using spherical k-means clustering.
    Falls back to single centroid for classes with sparse support.
    """
    def __init__(self, k_prototypes: int = 1, min_samples_for_cluster: int = 6):
        self.k_prototypes = k_prototypes
        self.min_samples_for_cluster = min_samples_for_cluster
        self.prototypes: Dict[str, np.ndarray] = {}  # phone -> array of shape (K, dim)
        self.class_counts: Dict[str, int] = {}

    def fit(self, embeddings: np.ndarray, labels: Sequence[str]) -> "PrototypeMemory":
        unique_labels = sorted(list(set(labels)))
        self.prototypes.clear()
        self.class_counts = Counter(labels)

        for phone in unique_labels:
            idx = [i for i, l in enumerate(labels) if l == phone]
            class_feats = embeddings[idx]
            n_samples = len(class_feats)

            if self.k_prototypes == 1 or n_samples < self.min_samples_for_cluster:
                # Single centroid (spherical mean)
                centroid = np.mean(class_feats, axis=0, keepdims=True)
                norm = np.linalg.norm(centroid, axis=1, keepdims=True) + 1e-8
                centroid = centroid / norm
                self.prototypes[phone] = centroid
            else:
                # Spherical k-means (K-means on L2 normalized features)
                actual_k = min(self.k_prototypes, n_samples // 2)
                kmeans = KMeans(n_clusters=actual_k, random_state=20260831, n_init=5)
                kmeans.fit(class_feats)
                centers = kmeans.cluster_centers_
                norms = np.linalg.norm(centers, axis=1, keepdims=True) + 1e-8
                centers = centers / norms
                self.prototypes[phone] = centers

        return self

    def predict_cosine_topk(
        self,
        query_embeddings: np.ndarray,
        candidate_graph: Optional[Dict[str, List[str]]] = None,
        query_canonicals: Optional[Sequence[str]] = None,
        top_k: int = 5,
    ) -> List[List[Dict[str, Any]]]:
        """
        Retrieves top-k nearest classes based on minimum prototype cosine distance.
        """
        all_results = []
        n_queries = len(query_embeddings)

        for i in range(n_queries):
            q = query_embeddings[i]  # shape (dim,)
            canon = query_canonicals[i] if query_canonicals is not None else None
            allowed_cands = candidate_graph.get(canon, list(self.prototypes.keys())) if (candidate_graph and canon) else list(self.prototypes.keys())

            scores = []
            for phone in allowed_cands:
                if phone not in self.prototypes:
                    continue
                proto_matrix = self.prototypes[phone]  # shape (K, dim)
                sims = np.dot(proto_matrix, q)
                max_sim = float(np.max(sims))
                scores.append({"phone": phone, "similarity": max_sim, "distance": float(1.0 - max_sim)})

            scores.sort(key=lambda x: x["similarity"], reverse=True)
            all_results.append(scores[:top_k])

        return all_results
