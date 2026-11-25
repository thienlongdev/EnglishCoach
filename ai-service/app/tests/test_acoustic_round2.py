"""Regression tests for the Final Acoustic Round 2 protocol."""

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.context_ctc_diagnosis import (
    MarginConfidenceCalibrator,
    PhoneRobustNormalizer,
    Round2CandidateDiagnosis,
    Round2LogitCache,
    build_fold_candidate_graph,
    candidate_oracle_coverage,
    ctc_sequence_log_probability,
    paired_bootstrap_improvement,
    tensor_sha256,
    derive_confidence_thresholds,
)
from app.services.pronunciation.operating_points import (
    decision_boundaries,
    optimize_far_constrained_threshold,
    rates_at_threshold,
)


class TestFarOptimizer(unittest.TestCase):
    def test_duplicate_scores_move_together_and_largest_feasible_wins(self):
        labels = [1, 1, 1, 1, 0, 0, 0, 0]
        scores = [0.1, 0.2, 0.2, 0.9, 0.2, 0.3, 0.4, 0.8]
        point = optimize_far_constrained_threshold(labels, scores, 0.50)
        self.assertEqual(point.threshold, 0.2)
        self.assertEqual((point.tp, point.tn, point.fp, point.fn), (3, 0, 4, 1))
        self.assertEqual(point.far, 0.25)
        self.assertEqual(point.frr, 1.0)
        tied = rates_at_threshold(labels, scores, 0.2)
        self.assertEqual(tied.tp, 3)
        self.assertEqual(tied.fp, 4)

    def test_boundaries_include_both_endpoints(self):
        boundaries = decision_boundaries([1.0, 1.0, 2.0])
        self.assertEqual(len(boundaries), 4)
        self.assertLess(boundaries[0], 1.0)
        self.assertGreater(boundaries[-1], 2.0)
        all_error = rates_at_threshold([0, 1], [1.0, 2.0], boundaries[0])
        all_correct = rates_at_threshold([0, 1], [1.0, 2.0], boundaries[-1])
        self.assertEqual((all_error.fn, all_error.fp), (0, 1))
        self.assertEqual((all_correct.fn, all_correct.fp), (1, 0))


class TestConstrainedCtc(unittest.TestCase):
    def test_blank_transition_probability(self):
        probs = np.asarray([[0.6, 0.4], [0.5, 0.5]], dtype=np.float64)
        score = ctc_sequence_log_probability(np.log(probs), [1], blank_id=0)
        # Paths [token, token], [token, blank], and [blank, token].
        self.assertAlmostEqual(np.exp(score), 0.4 * 0.5 + 0.4 * 0.5 + 0.6 * 0.5, places=7)

    def test_repeated_phones_require_intervening_blank(self):
        probs = np.asarray([[0.1, 0.9], [0.9, 0.1], [0.1, 0.9]], dtype=np.float64)
        score = ctc_sequence_log_probability(np.log(probs), [1, 1], blank_id=0)
        self.assertAlmostEqual(np.exp(score), 0.9 * 0.9 * 0.9, places=7)

    def test_impossible_repeated_path_is_negative_infinity(self):
        probs = np.asarray([[0.1, 0.9], [0.1, 0.9]], dtype=np.float64)
        score = ctc_sequence_log_probability(np.log(probs), [1, 1], blank_id=0)
        self.assertTrue(np.isneginf(score))


class TestFoldLocality(unittest.TestCase):
    def setUp(self):
        self.valid = {"t", "s", "f", "d"}
        self.neighbors = {"t": ["d", "f"], "s": ["f"]}

    def test_held_substitution_cannot_enter_fold_graph(self):
        fold_train = [{"expectedPhoneme": "t", "humanPerceivedPhoneme": "s", "speakerId": "train"}]
        held = {"expectedPhoneme": "t", "humanPerceivedPhoneme": "f", "speakerId": "held"}
        graph = build_fold_candidate_graph(fold_train, {"t": ["d"]}, self.valid)
        self.assertIn("s", graph["t"])
        self.assertNotIn("f", graph["t"])
        coverage = candidate_oracle_coverage([held], graph)
        self.assertEqual(coverage["HUMAN_TARGET_ABSENT"], 1)
        self.assertEqual(coverage["ORACLE_COVERAGE"], 0.0)

    def test_normalizer_is_unchanged_by_held_rows(self):
        train = [
            {"expectedPhoneme": "t", "errorScore": float(index), "speakerId": f"s{index % 5}"}
            for index in range(30)
        ]
        held = {"expectedPhoneme": "t", "errorScore": 10000.0, "speakerId": "held"}
        fitted = PhoneRobustNormalizer().fit(train)
        before = fitted.manifest()
        _ = fitted.transform(held["expectedPhoneme"], held["errorScore"])
        self.assertEqual(before, fitted.manifest())

    def test_confidence_calibration_and_thresholds_are_fold_train_only(self):
        calibrator = MarginConfidenceCalibrator().fit([0.1, 0.2, 0.8, 1.0], [0, 0, 1, 1])
        fit_confidence = calibrator.predict([0.1, 0.2, 0.8, 1.0])
        thresholds = derive_confidence_thresholds(fit_confidence, [0, 0, 1, 1])
        before = dict(thresholds)
        _ = calibrator.predict([10000.0])  # held-fold observation
        self.assertEqual(before, thresholds)


class TestCacheAndContracts(unittest.TestCase):
    def test_cache_identity_and_invalidation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            cache = Round2LogitCache(path, {"checkpoint": "a", "audio": "x"})
            logits = np.arange(12, dtype=np.float32).reshape(3, 4)
            cache.save("u1", "audio-hash", logits)
            loaded = cache.load("u1", "audio-hash")
            self.assertTrue(np.array_equal(logits, loaded))
            self.assertEqual(tensor_sha256(logits), tensor_sha256(loaded))
            with self.assertRaises(RuntimeError):
                Round2LogitCache(path, {"checkpoint": "b", "audio": "x"})

    def test_low_confidence_contract_keeps_observed_null(self):
        diagnosis = Round2CandidateDiagnosis(
            expectedPhoneme="t",
            candidateObservedPhoneme=None,
            candidateConfidence=0.1,
            candidateSource="context_ctc",
            differences={},
        )
        self.assertIsNone(diagnosis.observedPhoneme)
        self.assertIsNone(diagnosis.candidateObservedPhoneme)

    def test_same_row_baseline_alignment_is_mandatory(self):
        common = {
            "speakerId": "s1", "expectedPhoneme": "t", "humanPerceivedPhoneme": "s",
            "predictedPhoneme": "s", "rank": 1,
        }
        round2 = [{**common, "rowId": "one"}]
        baseline = [{**common, "rowId": "two"}]
        with self.assertRaises(ValueError):
            paired_bootstrap_improvement(round2, baseline, resamples=10)


class TestPhysicalAccounting(unittest.TestCase):
    def test_validation_substitution_denominator_is_516(self):
        from scripts.acoustic_round2_engine import load_split_bundle

        data_dir = Path(__file__).resolve().parents[2] / "scripts/calibration_data"
        if not (data_dir / "outputs/phone_instances.jsonl").exists():
            self.skipTest("ignored SpeechOcean research data are not mounted")
        vocab = {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3}
        vocab.update({phone: index + 4 for index, phone in enumerate(CANONICAL_PHONE_PROFILES)})
        inventory = CanonicalRealPhoneInventory(vocab)
        _, _, substitutions, _ = load_split_bundle(data_dir, "validation", inventory)
        self.assertEqual(len(substitutions), 516)


if __name__ == "__main__":
    unittest.main()
