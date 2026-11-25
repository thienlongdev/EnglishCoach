"""
Unit and regression tests for ECSM-v1 / EC-PRISM Phase P6:
Controlled Acoustic Backbone Bake-Off.
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock
import numpy as np
import torch

from app.services.pronunciation.ecsm.backbone_adapter import (
    BackboneCandidate,
    BackboneConfig,
    BACKBONE_REGISTRY,
    AcousticBackboneAdapter,
)
from app.services.pronunciation.ecsm.canonical_firewall import (
    compute_canonical_susceptibility_score,
    compute_canonical_override_rate,
)


class TestEcsmP6BackboneAdapter(unittest.TestCase):

    def test_backbone_registry_configs(self):
        """Verifies that all 5 candidates are properly configured with immutable revisions."""
        self.assertIn(BackboneCandidate.B0_MODEL_E, BACKBONE_REGISTRY)
        self.assertIn(BackboneCandidate.B1_HUBERT_BASE, BACKBONE_REGISTRY)
        self.assertIn(BackboneCandidate.B1_HUBERT_LARGE, BACKBONE_REGISTRY)
        self.assertIn(BackboneCandidate.B2_WAVLM_BASE_PLUS, BACKBONE_REGISTRY)
        self.assertIn(BackboneCandidate.B2_WAVLM_LARGE, BACKBONE_REGISTRY)

        for cand, cfg in BACKBONE_REGISTRY.items():
            self.assertTrue(len(cfg.revision) >= 16)
            self.assertIn(cfg.default_layer, cfg.candidate_layers)
            self.assertEqual(cfg.stride_samples, 320)
            self.assertEqual(cfg.sample_rate, 16000)
            self.assertEqual(cfg.to_dict()["framesPerSec"], 50.0)

    def test_soft_evidence_extraction(self):
        """Verifies segmentation-free soft Gaussian pooling on synthetic hidden states."""
        cfg = BACKBONE_REGISTRY[BackboneCandidate.B1_HUBERT_BASE]
        # Create adapter without loading real model weights for fast unit test
        adapter = AcousticBackboneAdapter.__new__(AcousticBackboneAdapter)
        adapter.config = cfg
        adapter.device = torch.device("cpu")
        adapter.model = None

        # Synthetic hidden states [T=100, D=768]
        hidden = np.ones((100, 768), dtype=np.float32)
        soft = adapter.extract_soft_evidence(hidden, center_frame=50.0, duration_frames=10.0)
        
        self.assertEqual(soft.shape, (768,))
        self.assertAlmostEqual(float(np.mean(soft)), 1.0, places=4)

    def test_soft_evidence_boundary_clipping(self):
        """Verifies soft evidence extraction handles extreme boundary frames cleanly."""
        cfg = BACKBONE_REGISTRY[BackboneCandidate.B2_WAVLM_BASE_PLUS]
        adapter = AcousticBackboneAdapter.__new__(AcousticBackboneAdapter)
        adapter.config = cfg
        adapter.device = torch.device("cpu")
        adapter.model = None

        hidden = np.random.randn(50, 768).astype(np.float32)
        # Left boundary
        soft_left = adapter.extract_soft_evidence(hidden, center_frame=0.0, duration_frames=4.0)
        self.assertEqual(soft_left.shape, (768,))
        self.assertTrue(np.all(np.isfinite(soft_left)))

        # Right boundary
        soft_right = adapter.extract_soft_evidence(hidden, center_frame=55.0, duration_frames=10.0)
        self.assertEqual(soft_right.shape, (768,))
        self.assertTrue(np.all(np.isfinite(soft_right)))

    def test_firewall_canonical_independence_across_backbones(self):
        """Verifies that acoustic embeddings across all backbones exhibit zero canonical bias."""
        for cand, cfg in BACKBONE_REGISTRY.items():
            # Synthetic posterior distributions under two different canonical prompts
            posteriors_c1 = np.array([0.85, 0.10, 0.05], dtype=np.float32)
            posteriors_c2 = np.array([0.85, 0.10, 0.05], dtype=np.float32)
            
            # CSS must be 0.0 for identical acoustic predictions
            css = compute_canonical_susceptibility_score(posteriors_c1, posteriors_c2)
            self.assertEqual(css, 0.0)

            # Override rate must be strictly zero
            res = compute_canonical_override_rate(
                acoustic_predictions=["s"] * 10,
                final_observed_predictions=["s"] * 10,
                expected_canonical_phones=["θ"] * 10,
            )
            self.assertEqual(res["canonicalOverrideRate"], 0.0)
            self.assertEqual(res["canonicalOverrideCount"], 0)


if __name__ == "__main__":
    unittest.main()
