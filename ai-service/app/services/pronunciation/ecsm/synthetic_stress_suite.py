"""
ECSM-v1 / EC-PRISM Phase P5: Synthetic Acoustic Stress Suite.
Applies controlled, reproducible acoustic and representation-level perturbations:
- Additive noise at controlled SNR (15dB, 10dB, 5dB)
- Amplitude clipping distortion
- Spectral bandpass / filtering distortion
- Representation jitter
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np


class StressCondition(str, Enum):
    CLEAN = "CLEAN"
    ADDITIVE_NOISE_15DB = "ADDITIVE_NOISE_15DB"
    ADDITIVE_NOISE_10DB = "ADDITIVE_NOISE_10DB"
    ADDITIVE_NOISE_5DB = "ADDITIVE_NOISE_5DB"
    CLIPPING_DISTORTION = "CLIPPING_DISTORTION"
    SPECTRAL_BANDPASS = "SPECTRAL_BANDPASS"
    REPRESENTATION_JITTER = "REPRESENTATION_JITTER"


def apply_representation_stress(
    features: np.ndarray,
    condition: StressCondition,
    seed: int = 20260831,
) -> np.ndarray:
    """
    Applies synthetic stress transformation to frozen acoustic feature embeddings (e.g. 1416-dim R2 features).
    """
    rng = np.random.RandomState(seed)
    x = np.copy(features)
    
    if condition == StressCondition.CLEAN:
        return x
        
    elif condition == StressCondition.ADDITIVE_NOISE_15DB:
        sig_p = np.mean(x ** 2, axis=-1, keepdims=True)
        noise_p = sig_p / (10 ** (15.0 / 10.0))
        noise = rng.randn(*x.shape) * np.sqrt(noise_p)
        return x + noise
        
    elif condition == StressCondition.ADDITIVE_NOISE_10DB:
        sig_p = np.mean(x ** 2, axis=-1, keepdims=True)
        noise_p = sig_p / (10 ** (10.0 / 10.0))
        noise = rng.randn(*x.shape) * np.sqrt(noise_p)
        return x + noise
        
    elif condition == StressCondition.ADDITIVE_NOISE_5DB:
        sig_p = np.mean(x ** 2, axis=-1, keepdims=True)
        noise_p = sig_p / (10 ** (5.0 / 10.0))
        noise = rng.randn(*x.shape) * np.sqrt(noise_p)
        return x + noise
        
    elif condition == StressCondition.CLIPPING_DISTORTION:
        # Non-linear amplitude compression / clipping at 60% standard deviation
        std = np.std(x, axis=-1, keepdims=True)
        threshold = 0.6 * std
        return np.clip(x, -threshold, threshold)
        
    elif condition == StressCondition.SPECTRAL_BANDPASS:
        # Attenuate higher and lower dimension bins
        D = x.shape[-1]
        filter_mask = np.ones(D, dtype=np.float32)
        filter_mask[: int(0.15 * D)] = 0.1
        filter_mask[int(0.85 * D) :] = 0.1
        return x * filter_mask
        
    elif condition == StressCondition.REPRESENTATION_JITTER:
        # Random dropout & scaling
        mask = (rng.rand(*x.shape) > 0.15).astype(np.float32)
        scale = 0.8 + 0.4 * rng.rand(x.shape[0], 1)
        return x * mask * scale
        
    return x
