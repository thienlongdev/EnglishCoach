"""
Unit tests for ECSM-v1 / EC-PRISM Phase P5.1 Selective Risk Estimation & Confidence Refinement.
"""

import unittest
import numpy as np
import torch

from app.services.pronunciation.articulatory_diagnosis import (
    CanonicalRealPhoneInventory,
    CANONICAL_PHONE_PROFILES,
)
from app.services.pronunciation.ecsm.risk_estimator import (
    NUM_P5_1_FEATURES,
    P5_1_FEATURE_REGISTRY,
    R0_ConfidenceBaseline,
    R1_RegularizedLogistic,
    R2_HistGradientBoosting,
    R3_SmallMLP,
    compute_coverage_at_precision_target,
    compute_p5_1_risk_coverage_curve,
    evaluate_risk_estimation_metrics,
    export_feature_registry_json,
    extract_p5_1_evidence_vector,
)


class TestEcsmP51RiskEstimator(unittest.TestCase):
    def setUp(self):
        self.mock_vocab = {p: i for i, p in enumerate(CANONICAL_PHONE_PROFILES.keys())}
        self.mock_vocab["<pad>"] = len(self.mock_vocab)
        self.inventory = CanonicalRealPhoneInventory(self.mock_vocab)
        
    def test_feature_registry_integrity(self):
        """Test feature registry contains exactly 40 defined features with valid metadata."""
        self.assertEqual(len(P5_1_FEATURE_REGISTRY), NUM_P5_1_FEATURES)
        self.assertEqual(NUM_P5_1_FEATURES, 40)
        
        # Verify no canonical dependent features
        for feat in P5_1_FEATURE_REGISTRY:
            self.assertFalse(feat.canonical_dependent, f"Feature {feat.name} must not depend on canonical identity")
            self.assertFalse(feat.requires_label, f"Feature {feat.name} must not require gold labels at runtime")

    def test_feature_extraction_dimension_and_bounds(self):
        """Test evidence extraction produces 40 finite numbers without NaNs."""
        knn_candidates = [
            {"phone": "s", "score": 0.85},
            {"phone": "z", "score": 0.60},
            {"phone": "ʃ", "score": 0.40},
            {"phone": "t", "score": 0.20},
        ]
        art_preds = {
            "place": np.array([0.05, 0.1, 0.75, 0.05, 0.05], dtype=np.float32),
            "manner": np.array([0.1, 0.8, 0.05, 0.05], dtype=np.float32),
            "voicing": np.array([0.9, 0.1], dtype=np.float32),
        }
        align_info = {
            "alignmentEntropy": 0.35,
            "bestPathScore": -1.2,
            "pathMargin": 0.8,
            "nullMass": 0.02,
            "insertionProb": 0.01,
            "deletionProb": 0.0,
            "editOpEntropy": 0.15,
            "durationFrames": 8.0,
        }
        raw_acoustic = np.random.randn(1416).astype(np.float32)
        
        vec = extract_p5_1_evidence_vector(
            knn_candidates=knn_candidates,
            articulatory_preds=art_preds,
            alignment_info=align_info,
            raw_acoustic_feat=raw_acoustic,
            inventory=self.inventory,
            ood_score=0.12,
            synthetic_stress_score=0.05,
        )
        
        self.assertEqual(len(vec), 40)
        self.assertTrue(np.all(np.isfinite(vec)))
        self.assertFalse(np.any(np.isnan(vec)))

    def test_canonical_invariance_in_evidence_vector(self):
        """Verify feature extraction is strictly invariant to expected canonical phone prompt."""
        knn_cands = [{"phone": "s", "score": 0.88}, {"phone": "θ", "score": 0.55}]
        art_preds = {"voicing": np.array([0.95, 0.05], dtype=np.float32)}
        raw_acoustic = np.ones(1416, dtype=np.float32)
        
        vec1 = extract_p5_1_evidence_vector(knn_cands, art_preds, None, raw_acoustic, self.inventory, 0.1, 0.0)
        vec2 = extract_p5_1_evidence_vector(knn_cands, art_preds, None, raw_acoustic, self.inventory, 0.1, 0.0)
        
        np.testing.assert_array_almost_equal(vec1, vec2)

    def test_risk_model_candidates_fitting_and_predictions(self):
        """Test R0, R1, R2, R3 models fit and output valid probabilities in [0, 1]."""
        np.random.seed(20260831)
        X = np.random.randn(100, 40).astype(np.float32)
        X[:, 0] = np.random.uniform(0.3, 0.95, size=100) # top1_prob
        y = (X[:, 0] + 0.3 * X[:, 8] + np.random.randn(100) * 0.2 > 0.6).astype(int)
        
        models = [
            ("R0", R0_ConfidenceBaseline()),
            ("R1", R1_RegularizedLogistic(C=1.0)),
            ("R2", R2_HistGradientBoosting(max_iter=20)),
            ("R3", R3_SmallMLP(epochs=10)),
        ]
        
        for name, model in models:
            model.fit(X, y)
            preds = model.predict_risk_proba(X)
            self.assertEqual(len(preds), 100)
            self.assertTrue(np.all(preds >= 0.0), f"{name} produced negative probabilities")
            self.assertTrue(np.all(preds <= 1.0), f"{name} produced probabilities > 1.0")
            self.assertTrue(np.all(np.isfinite(preds)), f"{name} produced non-finite predictions")

    def test_risk_coverage_curve_monotonicity(self):
        """Test risk-coverage curve calculation and confidence intervals."""
        np.random.seed(20260831)
        scores = np.random.uniform(0.1, 0.99, size=200)
        # Higher score -> higher probability of correctness
        y_correct = (np.random.rand(200) < scores).astype(int)
        
        curve = compute_p5_1_risk_coverage_curve(scores, y_correct)
        self.assertTrue(len(curve) > 0)
        
        # Verify coverage points are ordered and counts match
        prev_cov = 0.0
        for pt in curve:
            self.assertGreaterEqual(pt.actual_coverage, prev_cov)
            self.assertTrue(0.0 <= pt.precision <= 1.0)
            self.assertTrue(0.0 <= pt.ci_lower <= pt.precision <= pt.ci_upper <= 1.0)
            prev_cov = pt.actual_coverage

    def test_coverage_at_target_precision(self):
        """Test finding maximum coverage achieving target precision."""
        scores = np.array([0.95, 0.90, 0.85, 0.70, 0.60, 0.40, 0.20, 0.10])
        is_correct = np.array([1, 1, 1, 1, 0, 0, 0, 0])
        
        res_90 = compute_coverage_at_precision_target(scores, is_correct, target_precision=0.90)
        self.assertEqual(res_90["status"], "ACHIEVED")
        self.assertEqual(res_90["selectedCount"], 4) # First 4 are 100% correct
        self.assertEqual(res_90["coverage"], 0.5)

    def test_risk_evaluation_metrics(self):
        """Test AUROC, AUPR, NLL, Brier, and ECE computation."""
        y_true = np.array([1, 1, 1, 0, 0, 0, 1, 0, 1, 0])
        y_prob = np.array([0.9, 0.8, 0.7, 0.3, 0.2, 0.1, 0.85, 0.4, 0.75, 0.15])
        
        metrics = evaluate_risk_estimation_metrics(y_true, y_prob, n_bins=5)
        self.assertIn("auroc", metrics)
        self.assertIn("aupr", metrics)
        self.assertIn("nll", metrics)
        self.assertIn("brier", metrics)
        self.assertIn("ece", metrics)
        self.assertGreater(metrics["auroc"], 0.8)


if __name__ == "__main__":
    unittest.main()
