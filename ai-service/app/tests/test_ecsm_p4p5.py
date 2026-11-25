import unittest
import numpy as np

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.edit_aware_aligner import (
    EditAwareMonotonicAligner,
    EditOperation,
    compute_articulatory_disagreement,
)
from app.services.pronunciation.ecsm.pronunciation_graph import (
    ContextualPronunciationGraph,
    STANDARD_WEAK_FORMS,
    VariantProvenance,
)
from app.services.pronunciation.ecsm.synthetic_stress_suite import (
    StressCondition,
    apply_representation_stress,
)
from app.services.pronunciation.ecsm.trust_layer import (
    AbstentionReason,
    BinaryErrorCalibrator,
    CalibratedDecision,
    ConformalPredictionSet,
    MulticlassTemperatureCalibrator,
    OODDetector,
    compute_expected_calibration_error,
    compute_false_confident_diagnosis_rate,
    evaluate_selective_prediction,
)


class TestECSMP4P5(unittest.TestCase):

    def setUp(self):
        vocab = {p: i + 10 for i, p in enumerate(CANONICAL_PHONE_PROFILES.keys())}
        self.phone_inventory = CanonicalRealPhoneInventory(vocab)

    def test_pronunciation_graph_generation_and_bounding(self):
        words = ["the", "water", "can", "be", "cold"]
        base_sequences = [
            ["ð", "ə"],
            ["w", "ɔː", "t", "ɚ"],
            ["k", "æ", "n"],
            ["b", "iː"],
            ["k", "oʊ", "l", "d"],
        ]
        graph = ContextualPronunciationGraph(words, base_sequences, self.phone_inventory, max_paths=16)
        
        self.assertGreater(len(graph.paths), 0)
        self.assertLessEqual(len(graph.paths), 16)
        self.assertTrue(graph.nodes[0].is_start)
        # Citation path is preserved as path 0
        self.assertEqual(graph.paths[0].phones, ["ð", "ə", "w", "ɔː", "t", "ɚ", "k", "æ", "n", "b", "iː", "k", "oʊ", "l", "d"])
        # Check that flapping produced a flapped variant for "water"
        all_path_phones = [p.phones for p in graph.paths]
        self.assertTrue(any("ɾ" in p or "r" in p for p in all_path_phones))

    def test_edit_aware_aligner_match_and_substitution(self):
        aligner = EditAwareMonotonicAligner(self.phone_inventory)
        
        # 3 acoustic steps: /s/, /d/ (error for /t/), /ɑːɹ/
        acoustic_preds = [
            [{"phone": "s", "score": 0.95}, {"phone": "z", "score": 0.05}],
            [{"phone": "d", "score": 0.85}, {"phone": "t", "score": 0.15}],
            [{"phone": "ɑːɹ", "score": 0.90}, {"phone": "ɚ", "score": 0.10}],
        ]
        target_phones = ["s", "t", "ɑːɹ"]
        
        steps, cost = aligner.align_single_path_viterbi(acoustic_preds, target_phones)
        
        self.assertEqual(len(steps), 3)
        self.assertEqual(steps[0].operation, EditOperation.MATCH)
        self.assertEqual(steps[1].operation, EditOperation.SUBSTITUTION)
        self.assertEqual(steps[1].acoustic_phone, "d")
        self.assertEqual(steps[1].target_phone, "t")
        self.assertEqual(steps[2].operation, EditOperation.MATCH)

    def test_edit_aware_aligner_epenthesis_localization(self):
        aligner = EditAwareMonotonicAligner(self.phone_inventory)
        
        # Acoustic has epenthetic schwa /ə/ inside /s/ - /p/ cluster: [s, ə, p, ɔːɹ, t]
        acoustic_preds = [
            [{"phone": "s", "score": 0.95}],
            [{"phone": "ə", "score": 0.90}], # Epenthetic schwa
            [{"phone": "p", "score": 0.92}],
            [{"phone": "ɔːɹ", "score": 0.88}],
            [{"phone": "t", "score": 0.96}],
        ]
        target_phones = ["s", "p", "ɔːɹ", "t"]
        
        steps, cost = aligner.align_single_path_viterbi(acoustic_preds, target_phones)
        
        ops = [s.operation for s in steps]
        self.assertTrue(EditOperation.EPENTHESIS in ops or EditOperation.INSERTION in ops)
        # The subsequent phones /p/, /ɔːr/, /t/ must align to their exact targets (no cascading shift)
        self.assertEqual(steps[-1].operation, EditOperation.MATCH)
        self.assertEqual(steps[-1].target_phone, "t")

    def test_binary_error_calibrator_platt_and_ece(self):
        rng = np.random.RandomState(42)
        scores = rng.rand(200)
        labels = (scores > 0.5).astype(int)
        
        calibrator = BinaryErrorCalibrator(method="B1").fit(scores, labels)
        cal_probs = calibrator.predict_proba(scores)
        
        self.assertEqual(cal_probs.shape, (200,))
        self.assertTrue(np.all(cal_probs >= 0.0) and np.all(cal_probs <= 1.0))
        
        ece = compute_expected_calibration_error(labels, cal_probs, n_bins=10)
        self.assertTrue(0.0 <= ece <= 0.20)

    def test_multiclass_temperature_calibrator(self):
        rng = np.random.RandomState(42)
        logits = rng.randn(100, 10)
        labels = np.argmax(logits, axis=1)
        
        calibrator = MulticlassTemperatureCalibrator(method="M1").fit(logits, labels)
        self.assertGreater(calibrator.temperature, 0.0)
        
        probs = np.exp(logits) / np.sum(np.exp(logits), axis=1, keepdims=True)
        scaled_probs = calibrator.scale_probabilities(probs)
        
        self.assertEqual(scaled_probs.shape, (100, 10))
        self.assertTrue(np.allclose(np.sum(scaled_probs, axis=1), 1.0))

    def test_conformal_prediction_sets(self):
        rng = np.random.RandomState(42)
        vocab = [f"p_{i}" for i in range(10)]
        cal_probs = rng.dirichlet(np.ones(10), size=150)
        cal_labels = np.argmax(cal_probs, axis=1)
        
        conformal = ConformalPredictionSet(alpha=0.10).fit(cal_probs, cal_labels)
        test_probs = rng.dirichlet(np.ones(10), size=50)
        pred_sets = conformal.predict_set(test_probs, vocab)
        
        self.assertEqual(len(pred_sets), 50)
        # Every set must contain at least 1 phoneme candidate
        self.assertTrue(all(len(s) >= 1 for s in pred_sets))

    def test_selective_prediction_and_fcdr(self):
        true_phones = ["s", "t", "d", "n", "k", "p", "f", "v", "m", "z"]
        predicted_phones = ["s", "t", "d", "n", "k", "b", "f", "v", "m", "z"] # 1 mistake: 'b' instead of 'p'
        confidences = [0.95, 0.92, 0.88, 0.85, 0.80, 0.45, 0.78, 0.72, 0.65, 0.60]
        
        res = evaluate_selective_prediction(true_phones, predicted_phones, confidences)
        self.assertIn("precisionAtCoverage", res)
        self.assertIn("coverageAtPrecision", res)
        
        decisions = []
        for i in range(10):
            if confidences[i] >= 0.60:
                decisions.append(CalibratedDecision(
                    error_probability=0.1,
                    candidate_observed_phoneme=predicted_phones[i],
                    exact_phone_confidence=confidences[i],
                    candidate_set=[predicted_phones[i]],
                    abstained=False,
                    abstention_reason=None,
                    ood_score=0.1,
                    alignment_uncertainty=0.05,
                ))
            else:
                decisions.append(CalibratedDecision(
                    error_probability=0.8,
                    candidate_observed_phoneme=None,
                    exact_phone_confidence=confidences[i],
                    candidate_set=[predicted_phones[i], "p"],
                    abstained=True,
                    abstention_reason=AbstentionReason.LOW_EXACT_CONFIDENCE,
                    ood_score=0.1,
                    alignment_uncertainty=0.25,
                ))
                
        fcdr_res = compute_false_confident_diagnosis_rate(true_phones, decisions)
        # The mistake 'b' was abstained, so FCDR among emitted should be 0.0!
        self.assertEqual(fcdr_res["fcdr"], 0.0)
        self.assertEqual(fcdr_res["emittedCorrect"], 9)
        self.assertEqual(fcdr_res["abstainedCount"], 1)

    def test_synthetic_stress_perturbations(self):
        x = np.ones((10, 1416), dtype=np.float32)
        x_noise = apply_representation_stress(x, StressCondition.ADDITIVE_NOISE_10DB)
        x_clip = apply_representation_stress(x, StressCondition.CLIPPING_DISTORTION)
        
        self.assertEqual(x_noise.shape, x.shape)
        self.assertFalse(np.array_equal(x, x_noise))
        self.assertEqual(x_clip.shape, x.shape)


if __name__ == "__main__":
    unittest.main()
