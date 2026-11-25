import unittest

import numpy as np
import torch

from app.services.pronunciation.calibration_models import calculate_calibrated_score
from app.services.pronunciation.calibration_reliability import (
    EXCLUSION_REASONS,
    RECOVERED_MAPPING_RULES,
    audio_features,
    audit_phone_mapping,
    binary_metrics,
    mapping_rule,
    preprocess_waveform,
    speaker_cluster_bootstrap_statistics,
    speaker_cluster_metric_ci,
)


class CalibrationReliabilityTests(unittest.TestCase):
    def test_mapping_exclusion_reason_classification(self):
        cases = [
            ((["IY1"], [2], ["uː"]), "phone inventory mismatch"),
            ((["IY1"], [2], ["i"]), None),
            ((["CH"], [2], ["t"]), "affricate representation"),
            ((["ER1"], [2], ["ɑːɹ"]), "rhotic representation"),
            ((["XX"], [2], ["i", "u"]), "one-to-many alignment"),
            ((["AA1", "R"], [2, 2], ["ɑːɹ"]), "many-to-one alignment"),
            ((["XX"], [2], ["i"]), "unsupported token"),
            (([], [], ["i"]), "insertion"),
        ]
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                result = audit_phone_mapping(*arguments)
                reason = result["targetAudit"][0]["reason"]
                self.assertEqual(reason, expected)
                if reason is not None:
                    self.assertIn(reason, EXCLUSION_REASONS)
        deletion = audit_phone_mapping(["IY1"], [2], [])
        self.assertEqual(deletion["sourceOnlyAudit"][0]["reason"], "deletion")

    def test_recovered_mapping_has_provenance_and_is_stress_specific(self):
        rule = mapping_rule("IH0", "ᵻ")
        self.assertIsNotNone(rule)
        self.assertEqual(rule.recovered_in, "SHD-2B.2B")
        self.assertTrue(rule.provenance)
        self.assertTrue(rule.explanation)
        self.assertIsNone(mapping_rule("IH1", "ᵻ"))
        self.assertTrue(all(r.rule_id and r.provenance and r.explanation for r in RECOVERED_MAPPING_RULES))

    def test_speaker_count_aware_bootstrap_is_deterministic(self):
        rows = []
        for speaker in range(8):
            for instance in range(10):
                rows.append({"speakerId": f"s{speaker}", "expectedPhoneme": "i", "rawGop": speaker + instance / 10})
        first = speaker_cluster_bootstrap_statistics(rows, resamples=20, seed=7, sample_levels=(25, 100))
        second = speaker_cluster_bootstrap_statistics(rows, resamples=20, seed=7, sample_levels=(25, 100))
        self.assertEqual(first, second)
        self.assertEqual(first["i"]["speakerCount"], 8)
        self.assertEqual(first["i"]["levels"]["100"]["status"], "UNAVAILABLE")
        self.assertIn("robustScale", first["i"]["levels"]["25"]["metrics"])

    def test_metric_confidence_intervals_and_imbalance_baseline(self):
        speakers, labels, probability = [], [], []
        for speaker in range(30):
            speakers.extend([f"s{speaker}"] * 4)
            labels.extend([0, 0, 0, 1])
            probability.extend([0.1, 0.2, 0.3, 0.8])
        metrics = binary_metrics(labels, probability)
        self.assertEqual(metrics["prevalence"], 0.25)
        self.assertEqual(metrics["prBaseline"], 0.25)
        self.assertAlmostEqual(metrics["prAucLift"], metrics["prAuc"] - 0.25)
        ci = speaker_cluster_metric_ci(labels, probability, speakers, resamples=100, seed=9)
        self.assertEqual(ci["status"], "AVAILABLE")
        self.assertEqual(ci["validResamples"], 100)

    def test_audio_normalization_is_deterministic_and_safe(self):
        t = np.arange(16000, dtype=np.float32) / 16000
        waveform = np.concatenate([np.zeros(4000, dtype=np.float32), 0.2 * np.sin(2 * np.pi * 220 * t) + 0.02,
                                   np.zeros(4000, dtype=np.float32)]).astype(np.float32)
        for variant in ("canonical", "dc", "peak", "rms", "trim", "dc-rms-trim"):
            first, first_meta = preprocess_waveform(waveform, variant)
            second, second_meta = preprocess_waveform(waveform, variant)
            np.testing.assert_array_equal(first, second)
            self.assertEqual(first_meta, second_meta)
            self.assertLessEqual(float(np.max(np.abs(first))), 1.0)
        dc, _ = preprocess_waveform(waveform, "dc")
        self.assertAlmostEqual(audio_features(dc)["dcOffset"], 0.0, places=6)

    def test_production_score_contract_remains_null(self):
        self.assertIsNone(calculate_calibrated_score(-999.0))

    def test_true_feature_lengths_uses_attention_mask_not_padding_width(self):
        from app.services.pronunciation.acoustic_engine import true_feature_lengths
        class FakeModel:
            @staticmethod
            def _get_feat_extract_output_lengths(lengths):
                return lengths // 2
        mask = torch.tensor([[1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 1]], dtype=torch.long)
        self.assertEqual(true_feature_lengths(FakeModel(), mask).tolist(), [2, 3])

    def test_domain_shift_bootstrap_is_deterministic(self):
        from scripts.calibration_reliability_tool import _cluster_median_gap
        rows = []
        for index in range(20):
            dataset = "left" if index < 10 else "right"
            rows.append({"dataset": dataset, "speakerId": f"s{index}", "rawGopMedian": float(index)})
        self.assertEqual(_cluster_median_gap(rows, "left", "right", 17),
                         _cluster_median_gap(rows, "left", "right", 17))


if __name__ == "__main__":
    unittest.main()
