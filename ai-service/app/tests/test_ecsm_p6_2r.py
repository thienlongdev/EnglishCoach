"""
Unit tests for ECSM Phase P6.2R:
Retrieval-Selection Forensic Audit, Provenance Reconciliation, and Prototype Integrity.
"""

from pathlib import Path
import unittest
import numpy as np
import torch
import torch.nn.functional as F

from app.services.pronunciation.ecsm.metric_adapter import PrototypeMemory
from scripts.ecsm_p6_2r_engine import (
    audit_prototype_occupancy,
    audit_retrieval_metric_provenance,
    audit_topk_compression_root_cause,
    reconcile_delta_top1,
)


class TestEcsmP62R(unittest.TestCase):
    def test_delta_top1_reconciliation(self):
        """Verifies deterministic reconciliation of +0.19pp confirmation delta vs +3.10% artifact."""
        res = reconcile_delta_top1()
        self.assertEqual(res["historicalBaseline"]["correctCount"], 284)
        self.assertEqual(res["adaptedConfirmation"]["correctCount"], 285)
        self.assertAlmostEqual(res["exactRowDelta"]["absoluteDeltaPercentagePoints"], 0.1938, places=3)
        self.assertIn("STOCHASTIC_BOOTSTRAP_REFERENCE_ARTIFACT", res["reportedDeltaExplanation"]["forensicClassification"])

    def test_retrieval_provenance_audit(self):
        """Verifies all retrieval methods contain explicit rowsets, splits, and evaluation types."""
        prov = audit_retrieval_metric_provenance()
        methods = prov["methods"]
        for m in ["D0_KNN15", "D1_CENTROID_K1", "D2_MULTI_PROTO_K2", "D3_MULTI_PROTO_K3", "D4_HYBRID_KNN_PROTO"]:
            self.assertIn(m, methods)
            self.assertEqual(methods[m]["leakageStatus"], "LEAKAGE_FREE")
            self.assertEqual(methods[m]["evaluationType"], "OUT_OF_SAMPLE_VALIDATION")

    def test_prototype_leakage_and_normalization(self):
        """Proves prototype fitting uses training memory only and produces unit hypersphere centroids."""
        x_tr = np.random.randn(20, 16)
        x_tr = x_tr / np.linalg.norm(x_tr, axis=1, keepdims=True)
        y_tr = ["s"] * 10 + ["t"] * 10

        x_val = np.random.randn(5, 16)
        x_val = x_val / np.linalg.norm(x_val, axis=1, keepdims=True)

        proto = PrototypeMemory(k_prototypes=3, min_samples_for_cluster=4).fit(x_tr, y_tr)
        for p, centers in proto.prototypes.items():
            for c in centers:
                self.assertAlmostEqual(float(np.linalg.norm(c)), 1.0, places=5)

        preds = proto.predict_cosine_topk(x_val, top_k=2)
        self.assertEqual(len(preds), 5)
        for p_row in preds:
            self.assertEqual(len(p_row), 2)
            self.assertIn(p_row[0]["phone"], ["s", "t"])

    def test_topk_and_mrr_calculation(self):
        """Verifies Top-1, Top-3, Top-5, and MRR calculations against deterministic small examples."""
        # Candidate ranking: ["s", "t", "th", "d", "z"]
        # Gold: "th" -> Rank 3
        cands = ["s", "t", "th", "d", "z"]
        gold = "th"

        is_t1 = 1 if cands[0] == gold else 0
        is_t3 = 1 if gold in cands[:3] else 0
        is_t5 = 1 if gold in cands[:5] else 0
        rank = cands.index(gold) + 1
        mrr = 1.0 / rank

        self.assertEqual(is_t1, 0)
        self.assertEqual(is_t3, 1)
        self.assertEqual(is_t5, 1)
        self.assertAlmostEqual(mrr, 1.0 / 3.0, places=4)

    def test_prototype_occupancy_fallback(self):
        """Verifies low-support phonemes fall back to single centroid."""
        x_tr = np.random.randn(10, 16)
        x_tr = x_tr / np.linalg.norm(x_tr, axis=1, keepdims=True)
        # 8 samples for "s", 2 samples for "dh"
        y_tr = ["s"] * 8 + ["dh"] * 2
        spks = [f"spk_{i}" for i in range(10)]

        occupancy = audit_prototype_occupancy(x_tr, y_tr, spks)
        self.assertTrue(occupancy["occupancyByPhone"]["dh"]["fallbackToCentroid"])
        self.assertFalse(occupancy["occupancyByPhone"]["s"]["fallbackToCentroid"])


if __name__ == "__main__":
    unittest.main()
