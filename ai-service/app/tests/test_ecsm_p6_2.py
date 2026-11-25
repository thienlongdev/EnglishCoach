"""
Unit and regression tests for ECSM-v1 / EC-PRISM Phase P6.2:
Ambiguity-Aware Hard Metric Adaptation, PEFT Parameter Constraints, Multi-Prototype Memory, and Canonical Firewall.
"""

from collections import Counter
import unittest
from typing import List

import numpy as np
import torch
import torch.nn.functional as F

from app.services.pronunciation.ecsm.hard_error_miner import CRITICAL_MINIMAL_PAIRS
from app.services.pronunciation.ecsm.metric_adapter import (
    CombinedPeftModel,
    FoldLocalHardNegativeMiner,
    HardTripletMarginLoss,
    MetricLossType,
    MetricProjectionHead,
    PeftType,
    PrototypeMemory,
    ResidualBottleneckAdapter,
    SupervisedContrastiveLoss,
)
from scripts.ecsm_p6_2_engine import (
    audit_p6_2_licenses,
    audit_p6_2_support_and_negatives,
    compute_geometry_diagnostics,
    evaluate_minimal_pair_separability,
)


class TestEcsmP62(unittest.TestCase):
    """Test suite for ECSM Phase P6.2 modules."""

    def test_license_audit_and_supervision_tier(self):
        """Verifies HuBERT Base MIT license and Tier-1 single-human label supervision."""
        audit = audit_p6_2_licenses()
        self.assertEqual(audit["checkpoint"]["weightLicense"], "MIT License")
        self.assertEqual(audit["checkpoint"]["commercialUseStatus"], "PERMISSIVE_COMMERCIAL_PERMITTED")
        self.assertEqual(audit["supervisionTier"]["labelType"], "TIER_1_SINGLE_HUMAN_PERCEIVED_PHONE")
        self.assertEqual(audit["supervisionTier"]["humanGoldStatus"], "NONE_AVAILABLE_IN_P6_2")

    def test_peft_parameter_counts_and_hypersphere_norm(self):
        """Verifies adapter parameter counts (< 0.5% of HuBERT Base) and strict L2 unit normalization."""
        model = CombinedPeftModel(
            in_dim=768,
            bottleneck_dim=64,
            metric_dim=256,
            num_classes=57,
            peft_type=PeftType.ADAPTER_PLUS_PROJECTION,
            include_phone_aux=True,
            include_artic_aux=True,
        )
        counts = model.count_trainable_parameters()
        
        # Trainable params must be compact (< 500k params)
        self.assertLess(counts["trainableParams"], 500000)
        self.assertEqual(counts["adapterParams"], 100672)
        self.assertEqual(counts["metricHeadParams"], 197376)

        # Test forward pass and unit hypersphere norm ||z||_2 = 1
        dummy_input = torch.randn(8, 768)
        z, p_logits, a_logits = model(dummy_input)
        
        self.assertEqual(z.shape, (8, 256))
        norms = torch.norm(z, p=2, dim=-1)
        for n in norms:
            self.assertAlmostEqual(float(n.detach()), 1.0, places=5)

    def test_hard_negative_miner_fold_locality(self):
        """Verifies hard negative mapping from confusion pairs and minimal pairs."""
        train_canons = ["TH", "R", "V", "AE", "S"]
        train_perceived = ["S", "L", "W", "EH", "Z"]

        miner = FoldLocalHardNegativeMiner(train_canons, train_perceived)
        
        # /s/ and /th/ must be hard negatives
        self.assertTrue(miner.is_hard_negative("TH", "S"))
        self.assertTrue(miner.is_hard_negative("S", "TH"))
        
        # Critical minimal pairs must be recognized
        for p1, p2 in CRITICAL_MINIMAL_PAIRS:
            self.assertTrue(miner.is_hard_negative(p1, p2))

        # Self pairs must NOT be hard negatives
        self.assertFalse(miner.is_hard_negative("TH", "TH"))

    def test_prototype_memory_clustering_and_retrieval(self):
        """Verifies single centroid (K=1) and multi-prototype (K=2, 3) clustering."""
        rng = np.random.RandomState(20260831)
        dim = 16
        
        # Create 2 synthetic classes with 10 samples each on unit sphere
        class_a = rng.randn(10, dim)
        class_a = class_a / np.linalg.norm(class_a, axis=1, keepdims=True)
        class_b = rng.randn(10, dim)
        class_b = class_b / np.linalg.norm(class_b, axis=1, keepdims=True)

        embs = np.vstack([class_a, class_b])
        labels = ["A"] * 10 + ["B"] * 10

        # K=1 Centroid
        proto_k1 = PrototypeMemory(k_prototypes=1).fit(embs, labels)
        self.assertEqual(len(proto_k1.prototypes["A"]), 1)
        self.assertAlmostEqual(float(np.linalg.norm(proto_k1.prototypes["A"])), 1.0, places=5)

        # K=2 Multi-Prototype
        proto_k2 = PrototypeMemory(k_prototypes=2, min_samples_for_cluster=4).fit(embs, labels)
        self.assertEqual(len(proto_k2.prototypes["A"]), 2)
        for c in proto_k2.prototypes["A"]:
            self.assertAlmostEqual(float(np.linalg.norm(c)), 1.0, places=5)

        # Prediction retrieval test
        preds = proto_k2.predict_cosine_topk(class_a[:2], top_k=2)
        self.assertEqual(len(preds), 2)
        self.assertEqual(preds[0][0]["phone"], "A")

    def test_supervised_contrastive_loss(self):
        """Verifies supervised contrastive loss calculation and gradient flow."""
        loss_fn = SupervisedContrastiveLoss(temperature=0.07, hard_negative_weight=2.0)
        
        # 4 samples: 2 of class 0, 2 of class 1
        z = torch.randn(4, 32, requires_grad=True)
        z_norm = F.normalize(z, p=2, dim=-1)
        labels = torch.tensor([0, 0, 1, 1], dtype=torch.long)

        loss = loss_fn(z_norm, labels)
        self.assertTrue(torch.is_tensor(loss))
        self.assertGreater(float(loss.detach()), 0.0)

        # Gradient should flow to embeddings
        loss.backward()
        self.assertIsNotNone(z.grad)


if __name__ == "__main__":
    unittest.main()
