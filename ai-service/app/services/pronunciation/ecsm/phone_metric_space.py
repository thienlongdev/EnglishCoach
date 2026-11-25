"""
ECSM Phase P1: Realized-Phone Metric Space & Multi-Prototype Memory Bank.

Includes:
- Metric Projection Head: z = g_phi(H), ||z||_2 = 1
- Minimal-Pair Hard Negative Miner (strictly fold-train only)
- Multi-Prototype Phone Memory Bank with Energy-based Posterior Scoring
- Classifiers:
    D0: Softmax Baseline
    D1: Nearest Centroid Baseline
    D2: k-NN Retrieval Baseline
    D3: Multi-Prototype Memory Bank
    D4: Supervised Contrastive / Angular-Margin Metric Model
"""

from __future__ import annotations

from collections import Counter, defaultdict
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.cluster import KMeans
from sklearn.neighbors import NearestNeighbors


# Standard Pedagogical Minimal Pairs for Hard Negative Mining
PEDAGOGICAL_MINIMAL_PAIRS: List[Tuple[str, str]] = [
    # Dental fricative confusions
    ("θ", "s"), ("θ", "t"), ("θ", "f"),
    ("ð", "d"), ("ð", "z"), ("ð", "v"),
    # Vowel height / tenseness minimal pairs
    ("ɪ", "iː"), ("i", "iː"), ("ɪ", "i"),
    ("æ", "ɛ"), ("æ", "a"), ("ɛ", "e"),
    ("ʊ", "uː"), ("u", "uː"), ("ʊ", "u"),
    ("ʌ", "ɑː"), ("ʌ", "ɒ"), ("ʌ", "ə"),
    # Liquid & glide confusions
    ("ɹ", "l"), ("r", "l"),
    ("v", "w"),
    # Sibilant & affricate confusions
    ("s", "z"), ("ʃ", "s"), ("tʃ", "ʃ"), ("dʒ", "ʒ"), ("tʃ", "t"),
]


class MetricProjectionHead(nn.Module):
    """
    Metric Projection Network: Projects acoustic features into normalized metric space.
    z = g_phi(H), with L2 normalization ||z||_2 = 1.
    """

    def __init__(self, in_features: int, embedding_dim: int = 128, hidden_dim: int = 256):
        super().__init__()
        self.in_features = in_features
        self.embedding_dim = embedding_dim
        self.net = nn.Sequential(
            nn.Linear(in_features, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(0.05),
            nn.Linear(hidden_dim, embedding_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass with L2 unit hypersphere normalization."""
        z = self.net(x)
        return F.normalize(z, p=2, dim=-1)


class MultiPrototypeMemoryBank:
    """
    Learned / Clustered Multi-Prototype Phone Memory Bank.
    Each phone p is represented by K prototype vectors {mu_{p,1}, ..., mu_{p,K}}.
    Acoustic realization posterior is computed via energy-based scoring:
        E_A(p, z) = -tau * log sum_k exp(cos(z, mu_{p,k}) / tau)
        P_A(p | z) = exp(-E_A(p, z)) / sum_q exp(-E_A(q, z))
    """

    def __init__(
        self,
        num_prototypes_per_phone: int = 3,
        temperature: float = 0.1,
        phone_inventory: Optional[Sequence[str]] = None,
        random_seed: int = 20260830,
    ):
        self.k = num_prototypes_per_phone
        self.temperature = max(1e-4, temperature)
        self.random_seed = random_seed
        self.phone_inventory = list(phone_inventory) if phone_inventory else []
        self.prototypes: Dict[str, np.ndarray] = {}  # phone -> [K, D]
        self.dim: int = 0

    def fit(self, phone_embeddings: Mapping[str, np.ndarray]) -> "MultiPrototypeMemoryBank":
        """
        Fit prototypes per phone from training embeddings using k-means clustering.
        Strictly fold-train only.
        """
        self.prototypes = {}
        for phone, embeddings in phone_embeddings.items():
            if len(embeddings) == 0:
                continue
            emb = np.asarray(embeddings, dtype=np.float32)
            # Ensure L2 normalization
            norms = np.linalg.norm(emb, axis=-1, keepdims=True)
            norms[norms < 1e-9] = 1.0
            emb = emb / norms

            n_samples, d = emb.shape
            self.dim = d
            k_actual = min(self.k, n_samples)
            if k_actual <= 1:
                # Single centroid
                proto = np.mean(emb, axis=0, keepdims=True)
                proto = proto / (np.linalg.norm(proto, axis=-1, keepdims=True) + 1e-9)
            else:
                kmeans = KMeans(n_clusters=k_actual, random_state=self.random_seed, n_init=5)
                kmeans.fit(emb)
                proto = kmeans.cluster_centers_
                proto = proto / (np.linalg.norm(proto, axis=-1, keepdims=True) + 1e-9)

            self.prototypes[phone] = proto.astype(np.float32)

        if not self.phone_inventory:
            self.phone_inventory = sorted(self.prototypes.keys())
        return self

    def score_embedding(self, z: np.ndarray) -> Dict[str, float]:
        """
        Compute energy-based acoustic posterior distribution over phone inventory for a single embedding z [D].
        """
        z_norm = z / (np.linalg.norm(z) + 1e-9)
        energies: Dict[str, float] = {}
        tau = self.temperature

        for phone in self.phone_inventory:
            if phone not in self.prototypes:
                energies[phone] = 100.0  # High energy / low probability
                continue
            protos = self.prototypes[phone]  # [K, D]
            cos_sims = np.dot(protos, z_norm)  # [K]
            # Numerically stable logsumexp
            max_sim = np.max(cos_sims)
            lse = max_sim + tau * np.log(np.sum(np.exp((cos_sims - max_sim) / tau)) + 1e-12)
            energy = -lse
            energies[phone] = float(energy)

        # Softmax over negative energies -> P_A(phone | z)
        all_phones = list(energies.keys())
        neg_e = np.array([-energies[p] / tau for p in all_phones], dtype=np.float64)
        max_neg = np.max(neg_e)
        exp_vals = np.exp(neg_e - max_neg)
        probs = exp_vals / (np.sum(exp_vals) + 1e-12)

        return {phone: float(prob) for phone, prob in zip(all_phones, probs)}

    def rank_candidates(
        self,
        z: np.ndarray,
        candidate_subset: Optional[Sequence[str]] = None,
    ) -> List[Tuple[str, float]]:
        """
        Rank candidate phones given acoustic embedding z.
        If candidate_subset is provided, restricts ranking to that subset.
        """
        posterior = self.score_embedding(z)
        if candidate_subset is not None:
            active_set = set(candidate_subset)
            filtered = [(p, posterior.get(p, 0.0)) for p in active_set if p in posterior]
        else:
            filtered = list(posterior.items())

        # Sort descending by probability
        filtered.sort(key=lambda x: x[1], reverse=True)
        return filtered


class SupervisedContrastiveLoss(nn.Module):
    """
    Supervised Contrastive / Multi-Prototype Metric Loss with Pedagogical Minimal-Pair Hard Negative Weighting.
    Pulls embeddings of the same realized phone together and pushes different phones apart,
    with extra penalty on critical pedagogical minimal-pair confusions.
    """

    def __init__(
        self,
        temperature: float = 0.07,
        minimal_pair_weight: float = 2.0,
        minimal_pairs: Optional[Sequence[Tuple[str, str]]] = None,
    ):
        super().__init__()
        self.temperature = temperature
        self.minimal_pair_weight = minimal_pair_weight
        self.minimal_pairs = set()
        for p1, p2 in (minimal_pairs or PEDAGOGICAL_MINIMAL_PAIRS):
            self.minimal_pairs.add((p1, p2))
            self.minimal_pairs.add((p2, p1))

    def forward(
        self,
        embeddings: torch.Tensor,  # [B, D] L2-normalized
        labels: Sequence[str],     # [B] phone labels
    ) -> torch.Tensor:
        batch_size = embeddings.shape[0]
        if batch_size < 2:
            return torch.tensor(0.0, device=embeddings.device, requires_grad=True)

        device = embeddings.device
        # Pairwise cosine similarity matrix scaled by temperature
        sim_matrix = torch.matmul(embeddings, embeddings.T) / self.temperature  # [B, B]

        # Max for numerical stability
        sim_max, _ = torch.max(sim_matrix, dim=-1, keepdim=True)
        sim_matrix_scaled = sim_matrix - sim_max.detach()

        # Positive mask (same phone, excluding self)
        label_arr = np.array(labels)
        pos_mask = (label_arr[:, None] == label_arr[None, :])
        np.fill_diagonal(pos_mask, False)
        pos_mask_tensor = torch.from_numpy(pos_mask).to(device)

        # Self mask
        self_mask = torch.eye(batch_size, dtype=torch.bool, device=device)

        # Negative weights (higher for minimal pairs)
        neg_weights = np.ones((batch_size, batch_size), dtype=np.float32)
        for i in range(batch_size):
            for j in range(batch_size):
                if i != j and not pos_mask[i, j]:
                    pair = (labels[i], labels[j])
                    if pair in self.minimal_pairs:
                        neg_weights[i, j] = self.minimal_pair_weight
        neg_weights_tensor = torch.from_numpy(neg_weights).to(device)

        # Denominator: sum over all j != i of weighted exp(sim)
        exp_sim = torch.exp(sim_matrix_scaled)
        # Apply weights: positives have weight 1, negatives have neg_weights, self is 0
        pair_weights = torch.where(pos_mask_tensor, torch.ones_like(neg_weights_tensor), neg_weights_tensor)
        pair_weights = torch.where(self_mask, torch.zeros_like(pair_weights), pair_weights)

        denom = torch.sum(exp_sim * pair_weights, dim=-1, keepdim=True) + 1e-12
        log_prob = sim_matrix_scaled - torch.log(denom)

        # Mean log probability over positives for each anchor
        pos_counts = torch.sum(pos_mask_tensor.float(), dim=-1)
        valid_anchors = (pos_counts > 0)
        if not valid_anchors.any():
            return torch.tensor(0.0, device=device, requires_grad=True)

        mean_log_prob_pos = torch.sum(log_prob * pos_mask_tensor.float(), dim=-1)[valid_anchors] / pos_counts[valid_anchors]
        loss = -torch.mean(mean_log_prob_pos)
        return loss
