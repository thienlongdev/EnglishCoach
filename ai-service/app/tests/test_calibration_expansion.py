import unittest
import numpy as np

from app.services.pronunciation.calibration_models import calculate_calibrated_score
from app.services.pronunciation.calibration_expansion import (
    DATASET_PROVENANCE_REGISTRY,
    AUDITED_REJECTED_DATASETS,
    HUMAN_REVIEW_CATEGORIES,
    TIE_MARGIN_EPSILON,
    audit_dataset_provenance,
    multi_channel_audio_features,
    compute_underpowered_deficits,
    deterministic_trellis_tie_break,
    create_human_review_item,
    compute_inter_rater_agreement,
)
from app.services.pronunciation.calibration_research import assert_zero_speaker_leakage


class CalibrationExpansionTests(unittest.TestCase):
    def test_dataset_provenance_and_license_classification(self):
        audit = audit_dataset_provenance()
        self.assertGreaterEqual(audit["acceptedCount"], 4)
        self.assertGreaterEqual(audit["rejectedCount"], 4)
        for accepted in audit["accepted"]:
            self.assertEqual(accepted["license"], "CC BY 4.0")
            self.assertEqual(accepted["commercialUse"], "Permitted")
            self.assertTrue(accepted["url"].startswith("https://www.openslr.org/"))
        for rejected in audit["rejected"]:
            self.assertIn(
                rejected["classification"],
                [
                    "REJECTED_LICENSE_INCOMPATIBLE",
                    "REJECTED_UNVERIFIED_LABELS",
                    "REJECTED_UNVERIFIED_PROVENANCE",
                ],
            )
            self.assertTrue(len(rejected["rejectionReason"]) > 10)

    def test_multi_channel_audio_feature_extraction(self):
        sr = 16000
        t = np.arange(sr, dtype=np.float32) / sr
        # Sine wave with DC offset + minor clipping
        wave = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.05
        wave[100:110] = 1.0  # clipped samples
        features = multi_channel_audio_features(wave, sample_rate=sr)

        self.assertAlmostEqual(features["durationSeconds"], 1.0, places=2)
        self.assertGreater(features["rms"], 0.1)
        self.assertAlmostEqual(features["dcOffset"], 0.05, places=2)
        self.assertEqual(features["clippingSampleCount"], 10)
        self.assertGreater(features["clippingProportion"], 0.0)
        self.assertGreaterEqual(features["snrProxyDb"], 0.0)

    def test_underpowered_deficit_accounting_and_single_class(self):
        sample_quality = {
            "iː": {"sampleCount": 591, "speakerCount": 118, "errorCount": 6, "correctCount": 585, "status": "UNDERPOWERED"},
            "oː": {"sampleCount": 2, "speakerCount": 2, "errorCount": 0, "correctCount": 2, "status": "SINGLE_CLASS"},
            "t": {"sampleCount": 2000, "speakerCount": 125, "errorCount": 150, "correctCount": 1850, "status": "AVAILABLE"},
        }
        deficits = compute_underpowered_deficits(sample_quality)
        self.assertEqual(deficits["underpoweredCount"], 1)
        self.assertEqual(deficits["singleClassCount"], 1)
        self.assertEqual(deficits["availableCount"], 1)
        self.assertIn("oː", deficits["singleClassPhones"])
        self.assertIn("iː", deficits["underpoweredPhones"])

        # Check deficit metrics for iː
        i_def = [d for d in deficits["deficits"] if d["phoneme"] == "iː"][0]
        self.assertEqual(i_def["errorDeficit"], 14)  # 20 - 6
        self.assertEqual(i_def["speakerDeficit"], 0)  # 118 >= 20

    def test_trellis_tie_break_respects_margin_and_prioritizes_standard(self):
        # Case 1: Strict score difference > epsilon -> Select strictly higher score
        candidates_clear = [
            {"pathScore": -10.0, "category": "STANDARD", "phonemes": ["k", "æ", "t"], "variantIndex": 0},
            {"pathScore": -10.5, "category": "CASUAL", "phonemes": ["k", "ə", "t"], "variantIndex": 1},
        ]
        selected, diag = deterministic_trellis_tie_break(candidates_clear, epsilon=TIE_MARGIN_EPSILON)
        self.assertEqual(selected["variantIndex"], 0)
        self.assertFalse(diag["isNearTie"])
        self.assertFalse(diag["tieBreakApplied"])

        # Case 2: Near tie (margin <= epsilon) -> Standard category takes precedence over casual
        candidates_tied = [
            {"pathScore": -10.00002, "category": "STANDARD", "phonemes": ["j", "uː"], "variantIndex": 0},
            {"pathScore": -10.00001, "category": "CASUAL", "phonemes": ["j", "ə"], "variantIndex": 1},
        ]
        selected_tied, diag_tied = deterministic_trellis_tie_break(candidates_tied, epsilon=TIE_MARGIN_EPSILON)
        self.assertEqual(selected_tied["variantIndex"], 0)  # Standard preferred despite 1e-5 difference
        self.assertTrue(diag_tied["isNearTie"])
        self.assertTrue(diag_tied["tieBreakApplied"])

    def test_human_review_item_creation_and_inter_rater_kappa(self):
        item = create_human_review_item(
            utterance_id="utt01",
            speaker_id="spk01",
            word_index=0,
            word_text="test",
            selected_variant=["t", "ɛ", "s", "t"],
            aligned_phones=[{"expectedPhoneme": "t", "startFrame": 1, "endFrame": 5}],
            raw_gop_mean=1.2,
            alignment_margin=0.05,
            preprocessing_variant="canonical",
            audio_path="test.wav",
        )
        self.assertEqual(item["wordText"], "test")
        self.assertEqual(item["reviewStatus"], "PENDING")
        self.assertIn("alignment clearly correct", item["validReviewCategories"])

        # Perfect agreement
        ratings_perfect = [
            ("alignment clearly correct", "alignment clearly correct"),
            ("alignment plausible", "alignment plausible"),
            ("alignment incorrect", "alignment incorrect"),
        ] * 10
        kappa_perf = compute_inter_rater_agreement(ratings_perfect)
        self.assertEqual(kappa_perf["cohensKappa"], 1.0)
        self.assertEqual(kappa_perf["interpretation"], "Substantial")

        # Disagreement
        ratings_split = [
            ("alignment clearly correct", "alignment plausible"),
            ("alignment incorrect", "alignment incorrect"),
        ] * 10
        kappa_split = compute_inter_rater_agreement(ratings_split)
        self.assertLess(kappa_split["cohensKappa"], 1.0)

    def test_split_isolation_and_zero_speaker_leakage(self):
        clean_rows = [
            {"dataset": "speechocean762", "speakerId": "s1", "split": "calibration"},
            {"dataset": "speechocean762", "speakerId": "s2", "split": "validation"},
            {"dataset": "speechocean762", "speakerId": "s3", "split": "test"},
            {"dataset": "librispeech-dev-clean", "speakerId": "lib_s1", "split": "calibration"},
            {"dataset": "librispeech-dev-other", "speakerId": "lib_o1", "split": "calibration"},
        ]
        assert_zero_speaker_leakage(clean_rows)

        leaky_rows = list(clean_rows) + [
            {"dataset": "speechocean762", "speakerId": "s1", "split": "test"}
        ]
        with self.assertRaisesRegex(ValueError, "leakage"):
            assert_zero_speaker_leakage(leaky_rows)

    def test_production_null_contract_is_strictly_preserved(self):
        self.assertIsNone(calculate_calibrated_score(-10.0))
        self.assertIsNone(calculate_calibrated_score(0.0))
        self.assertIsNone(calculate_calibrated_score(100.0))


if __name__ == "__main__":
    unittest.main()
