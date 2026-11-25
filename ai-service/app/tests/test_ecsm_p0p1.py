"""
Unit and Regression Test Suite for ECSM Phase P0/P1 Architecture.
Tests data isolation, metric space normalization, multi-prototype memory,
ranking metrics, selective prediction, and anti-hallucination contracts.
"""

import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
import torch
import torch.nn.functional as F

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.acoustic_representations import (
    ContextAwareCtcRepresentation,
    DenseMonotonicRealityAdapter,
    SegmentationFreeEvidence,
    pool_acoustic_region,
)
from app.services.pronunciation.ecsm.evaluation_firewall import (
    compute_oracle_coverage,
    compute_paired_speaker_cluster_bootstrap,
    compute_ranking_metrics,
    compute_selective_prediction_curve,
)
from app.services.pronunciation.ecsm.experiment_registry import (
    atomic_write_json,
    sha256_bytes,
    sha256_json,
    sha256_tensor,
)
from app.services.pronunciation.ecsm.phone_metric_space import (
    MetricProjectionHead,
    MultiPrototypeMemoryBank,
    PEDAGOGICAL_MINIMAL_PAIRS,
    SupervisedContrastiveLoss,
)


class TestPhoneInventoryAndPrototypes(unittest.TestCase):
    def setUp(self):
        vocab = {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4}
        vocab.update({p: idx + 5 for idx, p in enumerate(CANONICAL_PHONE_PROFILES.keys())})
        self.inventory = CanonicalRealPhoneInventory(vocab)

    def test_no_special_tokens_in_real_phone_inventory(self):
        """Verify that special tokens, modifiers, and blanks cannot be included in real phone inventory."""
        self.assertNotIn("<pad>", self.inventory.phone2profile)
        self.assertNotIn("<s>", self.inventory.phone2profile)
        self.assertNotIn("<unk>", self.inventory.phone2profile)
        self.assertNotIn("|", self.inventory.phone2profile)
        self.assertNotIn("\u0329", self.inventory.phone2profile)
        self.assertIn("θ", self.inventory.phone2profile)
        self.assertIn("s", self.inventory.phone2profile)
        self.assertIn("ɪ", self.inventory.phone2profile)

    def test_prototype_bank_fitting_and_energy_numerical_stability(self):
        """Verify multi-prototype memory fitting, L2 normalization, and partition function correctness."""
        memory = MultiPrototypeMemoryBank(num_prototypes_per_phone=3, temperature=0.1)
        rng = np.random.RandomState(42)
        
        # Generate synthetic embeddings for 3 phones
        train_data = {
            "s": rng.randn(20, 64).astype(np.float32),
            "θ": rng.randn(15, 64).astype(np.float32),
            "t": rng.randn(10, 64).astype(np.float32),
        }
        memory.fit(train_data)
        
        self.assertEqual(len(memory.prototypes), 3)
        for phone, protos in memory.prototypes.items():
            self.assertEqual(protos.shape[1], 64)
            self.assertLessEqual(protos.shape[0], 3)
            # Verify unit normalization of prototypes
            norms = np.linalg.norm(protos, axis=-1)
            np.testing.assert_allclose(norms, 1.0, atol=1e-5)

        # Test energy scoring & posterior distribution
        test_z = rng.randn(64).astype(np.float32)
        posterior = memory.score_embedding(test_z)
        self.assertEqual(len(posterior), 3)
        prob_sum = sum(posterior.values())
        self.assertAlmostEqual(prob_sum, 1.0, places=5)
        for p, prob in posterior.items():
            self.assertGreaterEqual(prob, 0.0)
            self.assertLessEqual(prob, 1.0)


class TestMetricSpaceAndLosses(unittest.TestCase):
    def test_metric_projection_head_normalization(self):
        """Verify that MetricProjectionHead outputs unit L2 norm embeddings."""
        head = MetricProjectionHead(in_features=128, embedding_dim=64)
        head.eval()
        x = torch.randn(8, 128)
        with torch.no_grad():
            z = head(x)
        self.assertEqual(z.shape, (8, 64))
        norms = torch.norm(z, p=2, dim=-1).numpy()
        np.testing.assert_allclose(norms, 1.0, atol=1e-5)

    def test_supervised_contrastive_loss_gradient_flow(self):
        """Verify supervised contrastive loss with minimal pair hard negatives."""
        loss_fn = SupervisedContrastiveLoss(temperature=0.1, minimal_pair_weight=2.0)
        raw_embeddings = torch.randn(6, 32, requires_grad=True)
        embeddings = F.normalize(raw_embeddings, p=2, dim=-1)
        labels = ["θ", "θ", "s", "s", "t", "t"]
        
        loss = loss_fn(embeddings, labels)
        self.assertGreater(loss.item(), 0.0)
        loss.backward()
        self.assertIsNotNone(raw_embeddings.grad)
        self.assertTrue(torch.isfinite(raw_embeddings.grad).all())


class TestAcousticRepresentations(unittest.TestCase):
    def test_pool_acoustic_region_modes(self):
        hidden = np.arange(20, dtype=np.float32).reshape(5, 4)
        mean_feat = pool_acoustic_region(hidden, 1, 3, mode="mean")
        self.assertEqual(mean_feat.shape, (4,))
        np.testing.assert_allclose(mean_feat, np.mean(hidden[1:3], axis=0))

        concat_feat = pool_acoustic_region(hidden, 1, 3, mode="mean_max_concat")
        self.assertEqual(concat_feat.shape, (8,))

    def test_dense_monotonic_reality_adapter(self):
        adapter = DenseMonotonicRealityAdapter(in_features=64, out_features=32)
        adapter.eval()
        x = torch.randn(2, 10, 64)
        out = adapter(x)
        self.assertEqual(out.shape, (2, 10, 32))
        self.assertTrue(torch.isfinite(out).all())

    def test_context_aware_ctc_prior_correction(self):
        phone_priors = {"s": 0.5, "θ": 0.05}
        phone_to_id = {"s": 1, "θ": 2}
        rep = ContextAwareCtcRepresentation(phone_priors, phone_to_id, blank_id=0, prior_alpha=1.0)
        logits = np.zeros((5, 3), dtype=np.float32)
        hidden = np.ones((5, 16), dtype=np.float32)
        feat = rep.transform(logits, hidden, 1, 3)
        self.assertGreater(len(feat), 16)
        self.assertTrue(np.isfinite(feat).all())

    def test_segmentation_free_soft_evidence(self):
        seg_free = SegmentationFreeEvidence(phone_to_id={"s": 1, "t": 2}, blank_id=0, temporal_sigma=2.0)
        logits = np.zeros((10, 3), dtype=np.float32)
        hidden = np.ones((10, 16), dtype=np.float32)
        evidence = seg_free.extract_soft_evidence(logits, hidden, center_frame=5.0, duration_frames=3.0)
        self.assertEqual(evidence.shape, (16 + 3,))
        self.assertTrue(np.isfinite(evidence).all())


class TestEvaluationAndFirewall(unittest.TestCase):
    def test_ranking_metrics_calculation(self):
        predictions = [
            {"rank": 1, "humanPerceivedPhoneme": "s", "predictedPhoneme": "s"},
            {"rank": 2, "humanPerceivedPhoneme": "θ", "predictedPhoneme": "s"},
            {"rank": 1, "humanPerceivedPhoneme": "t", "predictedPhoneme": "t"},
            {"rank": 4, "humanPerceivedPhoneme": "f", "predictedPhoneme": "s"},
        ]
        metrics = compute_ranking_metrics(predictions)
        self.assertEqual(metrics["count"], 4)
        self.assertEqual(metrics["top1"], 0.5)  # 2 / 4
        self.assertEqual(metrics["top3"], 0.75) # 3 / 4
        self.assertEqual(metrics["top5"], 1.0)  # 4 / 4
        self.assertAlmostEqual(metrics["mrr"], (1.0 + 0.5 + 1.0 + 0.25) / 4.0)

    def test_oracle_coverage_calculation(self):
        rows = [
            {"expectedPhoneme": "θ", "humanPerceivedPhoneme": "s"},
            {"expectedPhoneme": "t", "humanPerceivedPhoneme": "d"},
            {"expectedPhoneme": "k", "humanPerceivedPhoneme": "ɡ"},
        ]
        candidate_graph = {
            "θ": ["s", "f", "t"],
            "t": ["d", "t"],
            "k": ["p", "t"],  # "ɡ" absent
        }
        cov = compute_oracle_coverage(rows, candidate_graph)
        self.assertEqual(cov["TOTAL_SUBSTITUTIONS"], 3)
        self.assertEqual(cov["HUMAN_TARGET_PRESENT_IN_CANDIDATE_SET"], 2)
        self.assertEqual(cov["HUMAN_TARGET_ABSENT"], 1)
        self.assertAlmostEqual(cov["ORACLE_COVERAGE"], 2.0 / 3.0)

    def test_selective_prediction_risk_coverage(self):
        predictions = [
            {"rank": 1, "confidence": 0.95},
            {"rank": 1, "confidence": 0.90},
            {"rank": 2, "confidence": 0.40},
            {"rank": 3, "confidence": 0.10},
        ]
        curves = compute_selective_prediction_curve(predictions)
        self.assertIn("coverage_50", curves)
        self.assertAlmostEqual(curves["coverage_50"]["precision"], 1.0)
        self.assertIn("precision_90", curves)
        self.assertEqual(curves["precision_90"]["status"], "ACHIEVED")

    def test_paired_speaker_cluster_bootstrap_same_row_requirement(self):
        cand = [
            {"rowId": "r1", "speakerId": "spk1", "rank": 1},
            {"rowId": "r2", "speakerId": "spk2", "rank": 1},
        ]
        base_mismatched = [
            {"rowId": "r1", "speakerId": "spk1", "rank": 2},
            {"rowId": "r3", "speakerId": "spk2", "rank": 2},
        ]
        with self.assertRaises(ValueError):
            compute_paired_speaker_cluster_bootstrap(cand, base_mismatched, n_bootstraps=10)

    def test_reproducible_tensor_and_json_hashing(self):
        t1 = torch.tensor([1.0, 2.0, 3.0])
        t2 = torch.tensor([1.0, 2.0, 3.0])
        self.assertEqual(sha256_tensor(t1), sha256_tensor(t2))

        j1 = {"a": 1, "b": [2, 3]}
        j2 = {"b": [2, 3], "a": 1}
        self.assertEqual(sha256_json(j1), sha256_json(j2))


if __name__ == "__main__":
    unittest.main()
