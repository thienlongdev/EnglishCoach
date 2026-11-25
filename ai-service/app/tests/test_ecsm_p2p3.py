"""
Unit and regression tests for ECSM Phase P2 (Articulatory Reality)
and Phase P3 (Canonical Information Firewall).
"""

import unittest
import numpy as np
import torch
import torch.nn as nn

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    ConsonantManner,
    ConsonantPlace,
    Voicing,
    VowelBackness,
    VowelHeight,
    VowelRounding,
    VowelTenseness,
)
from app.services.pronunciation.ecsm.articulatory_reality import (
    CONSONANT_MANNER_CLASSES,
    CONSONANT_PLACE_CLASSES,
    FACTOR_VOCABULARIES,
    VOICING_CLASSES,
    VOWEL_BACKNESS_CLASSES,
    VOWEL_HEIGHT_CLASSES,
    VOWEL_ROUNDING_CLASSES,
    VOWEL_TENSENESS_CLASSES,
    ArticulatoryGroundTruth,
    ArticulatoryTargetProvenance,
    IndependentArticulatoryHeads,
    ProtectedPartialArticulatoryAdapter,
    SharedArticulatoryAdapter,
    compute_articulatory_multitask_loss,
    compute_fold_class_weights,
    extract_articulatory_ground_truth,
    predict_articulatory_distributions,
)
from app.services.pronunciation.ecsm.canonical_firewall import (
    EarlyCanonicalControl,
    LateCanonicalComparator,
    build_comparator_feature_vector,
    compute_canonical_override_rate,
    compute_canonical_susceptibility_score,
    compute_detection_metrics,
    compute_jensen_shannon_divergence,
)


class TestEcsmP2Articulatory(unittest.TestCase):
    """Tests for Phase P2 Articulatory Reality Modeling."""

    def test_phone_articulatory_mapping_completeness(self):
        """Verify all canonical phones map to valid articulatory profiles."""
        for phone, profile in CANONICAL_PHONE_PROFILES.items():
            gt = extract_articulatory_ground_truth(phone)
            self.assertEqual(gt.phone, phone)
            self.assertEqual(gt.provenance, ArticulatoryTargetProvenance.HUMAN_PERCEIVED_PHONE_DERIVED)
            
            if gt.is_vowel:
                self.assertGreaterEqual(gt.height_idx, 0, f"Missing height for vowel {phone}")
                self.assertGreaterEqual(gt.backness_idx, 0, f"Missing backness for vowel {phone}")
                self.assertGreaterEqual(gt.rounding_idx, 0, f"Missing rounding for vowel {phone}")
                self.assertGreaterEqual(gt.tenseness_idx, 0, f"Missing tenseness for vowel {phone}")
                self.assertEqual(gt.place_idx, -1)
                self.assertEqual(gt.manner_idx, -1)
                self.assertEqual(gt.voicing_idx, -1)
            else:
                self.assertGreaterEqual(gt.place_idx, 0, f"Missing place for consonant {phone}")
                self.assertGreaterEqual(gt.manner_idx, 0, f"Missing manner for consonant {phone}")
                self.assertGreaterEqual(gt.voicing_idx, 0, f"Missing voicing for consonant {phone}")
                self.assertEqual(gt.height_idx, -1)
                self.assertEqual(gt.backness_idx, -1)
                self.assertEqual(gt.rounding_idx, -1)
                self.assertEqual(gt.tenseness_idx, -1)

    def test_unknown_phone_handling(self):
        """Unknown phones must return safe neutral ground truth without crashing."""
        gt = extract_articulatory_ground_truth("__UNKNOWN_PHONE_SYM__")
        self.assertEqual(gt.phone, "__UNKNOWN_PHONE_SYM__")
        self.assertEqual(gt.place_idx, -1)
        self.assertEqual(gt.manner_idx, -1)
        self.assertEqual(gt.voicing_idx, -1)

    def test_articulatory_heads_forward(self):
        """Test forward pass of independent and shared articulatory heads."""
        x = torch.randn(4, 1416)
        
        # A1: Independent
        m_a1 = IndependentArticulatoryHeads(in_features=1416)
        out_a1 = m_a1(x)
        self.assertEqual(out_a1["place"].shape, (4, len(CONSONANT_PLACE_CLASSES)))
        self.assertEqual(out_a1["manner"].shape, (4, len(CONSONANT_MANNER_CLASSES)))
        self.assertEqual(out_a1["voicing"].shape, (4, len(VOICING_CLASSES)))
        self.assertEqual(out_a1["height"].shape, (4, len(VOWEL_HEIGHT_CLASSES)))

        # A2: Shared Adapter
        m_a2 = SharedArticulatoryAdapter(in_features=1416, hidden_dim=256)
        out_a2 = m_a2(x)
        self.assertEqual(out_a2["embedding"].shape, (4, 256))
        self.assertEqual(out_a2["place"].shape, (4, len(CONSONANT_PLACE_CLASSES)))

    def test_factor_masked_multitask_loss(self):
        """Ensure consonant factors only receive loss from consonants and vowels from vowels."""
        m = SharedArticulatoryAdapter(in_features=1416, hidden_dim=64)
        x = torch.randn(2, 1416)
        out = m(x)
        
        # Row 0: consonant 's', Row 1: vowel 'iː'
        gts = [
            extract_articulatory_ground_truth("s"),
            extract_articulatory_ground_truth("iː"),
        ]
        
        loss, breakdown = compute_articulatory_multitask_loss(out, gts)
        self.assertGreater(loss.item(), 0.0)
        self.assertIn("place", breakdown)
        self.assertIn("height", breakdown)
        self.assertGreater(breakdown["place"], 0.0)
        self.assertGreater(breakdown["height"], 0.0)

    def test_canonical_only_label_rejection(self):
        """Labels marked CANONICAL_ONLY must be ignored during acoustic articulatory training."""
        m = SharedArticulatoryAdapter(in_features=1416, hidden_dim=64)
        x = torch.randn(1, 1416)
        out = m(x)
        
        gt_canonical = extract_articulatory_ground_truth("s", provenance=ArticulatoryTargetProvenance.CANONICAL_ONLY)
        loss, breakdown = compute_articulatory_multitask_loss(out, [gt_canonical])
        self.assertEqual(loss.item(), 0.0)
        self.assertEqual(breakdown["total"], 0.0)

    def test_fold_class_weights(self):
        """Class balanced weights should be fold-local and inversely proportional to frequency."""
        targets = [0, 0, 0, 1]  # Class 0 frequent, Class 1 rare
        w = compute_fold_class_weights(targets, num_classes=2, smoothing=0.0)
        self.assertGreater(float(w[1]), float(w[0]))


class TestEcsmP3CanonicalFirewall(unittest.TestCase):
    """Tests for Phase P3 Canonical Information Firewall Proof."""

    def test_jensen_shannon_divergence_properties(self):
        """JS divergence must be 0 for identical distributions and bounded in [0, 1]."""
        p = np.array([0.7, 0.2, 0.1])
        q = np.array([0.7, 0.2, 0.1])
        r = np.array([0.1, 0.2, 0.7])
        
        self.assertAlmostEqual(compute_jensen_shannon_divergence(p, q), 0.0, places=5)
        js_pr = compute_jensen_shannon_divergence(p, r)
        self.assertGreater(js_pr, 0.0)
        self.assertLessEqual(js_pr, 1.0)

    def test_canonical_susceptibility_score_zero_for_firewall(self):
        """Acoustic reality posteriors must yield CSS == 0 across counterfactual canonical targets."""
        # Simulated acoustic posterior for audio x (invariant to canonical target)
        post_under_c1 = np.array([0.8, 0.15, 0.05])
        post_under_c2 = np.array([0.8, 0.15, 0.05])
        
        css = compute_canonical_susceptibility_score(post_under_c1, post_under_c2)
        self.assertLess(css, 1e-6)

    def test_canonical_override_rate_computation(self):
        """Test COR_CANON when overrides occur vs when observed phone remains acoustic-authoritative."""
        # Case 1: Acoustic favors 's', Final observed stays 's', Canonical expected 'θ' -> No override
        # Case 2: Acoustic favors 's', Final observed rewritten to 'θ', Canonical 'θ' -> Override!
        ac_preds = ["s", "s", "t", "r"]
        fin_preds = ["s", "θ", "t", "r"]
        exp_phones = ["θ", "θ", "d", "l"]
        
        res = compute_canonical_override_rate(ac_preds, fin_preds, exp_phones)
        self.assertEqual(res["eligibleAcousticConflictCount"], 4)
        self.assertEqual(res["canonicalOverrideCount"], 1)
        self.assertAlmostEqual(res["canonicalOverrideRate"], 0.25)
        self.assertFalse(res["targetCompliance"])

        # Fully compliant case (0 overrides)
        res_clean = compute_canonical_override_rate(["s", "s"], ["s", "s"], ["θ", "θ"])
        self.assertEqual(res_clean["canonicalOverrideCount"], 0)
        self.assertTrue(res_clean["targetCompliance"])

    def test_late_comparator_stop_gradient(self):
        """Stop-gradient comparator must not propagate gradients back to acoustic representation."""
        comparator = LateCanonicalComparator(num_acoustic_features=14, canonical_vocab_size=41, stop_gradient=True)
        acoustic_feat = torch.randn(2, 14, requires_grad=True)
        canon_idx = torch.tensor([0, 1], dtype=torch.long)
        
        logit = comparator(acoustic_feat, canon_idx)
        loss = logit.sum()
        loss.backward()
        
        # Acoustic feat grad should be None due to stop_gradient
        self.assertIsNone(acoustic_feat.grad)

    def test_detection_metrics_far_frr_semantics(self):
        """Verify strict FAR/FRR definitions."""
        # y_true: 1 = error (positive), 0 = correct (negative)
        y_true = np.array([1, 1, 1, 1, 0, 0, 0, 0])
        # y_score: high = predicted error
        y_score = np.array([0.9, 0.8, 0.2, 0.1, 0.1, 0.2, 0.7, 0.8])
        # With threshold 0.5:
        # Positives (4): preds=[1, 1, 0, 0] -> 2 false acceptances (FAR = 2/4 = 50%)
        # Negatives (4): preds=[0, 0, 1, 1] -> 2 false rejections (FRR = 2/4 = 50%)
        
        metrics = compute_detection_metrics(y_true, y_score, threshold=0.5)
        self.assertEqual(metrics["totalPositives"], 4)
        self.assertEqual(metrics["totalNegatives"], 4)
        self.assertEqual(metrics["falseAcceptanceCount"], 2)
        self.assertEqual(metrics["falseRejectionCount"], 2)
        self.assertAlmostEqual(metrics["far"], 0.5)
        self.assertAlmostEqual(metrics["frr"], 0.5)


if __name__ == "__main__":
    unittest.main()
