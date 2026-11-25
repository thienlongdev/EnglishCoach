"""
Unit tests for SHD-2B.3 channel adaptation, targeted deficits,
prompt generator, error taxonomy, and training foundation services.
"""

import unittest
import numpy as np

from app.services.pronunciation.channel_adaptation import (
    ALL_DEFICIENT_PHONES,
    FROZEN_SHD_2B2C_BASELINE,
    L2_DATASET_CANDIDATES,
    PHONE_ERROR_TAXONOMY,
    PORTABLE_CHECKPOINT_SCHEMA,
    SHD_2B3_SCHEMA,
    SINGLE_CLASS_PHONES,
    UNDERPOWERED_PHONES,
    HumanL2AnnotationRecord,
    PhoneDeficitRecord,
    SyntheticErrorItem,
    TargetedPromptItem,
    apply_composite_adaptation,
    apply_conservative_peak_limit,
    apply_conservative_rms_norm,
    apply_dc_removal,
    apply_safe_silence_trim,
    assert_human_synthetic_isolation,
    calculate_inter_annotator_agreement,
    calculate_phone_deficits,
    evaluate_fine_tuning_readiness,
    generate_targeted_prompt_corpus,
    transform_duration_residual,
    transform_phone_centered_gop,
    transform_standard_z,
)


class TestChannelAdaptationFoundations(unittest.TestCase):

    def test_dc_removal(self):
        # Array with DC offset
        arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0], dtype=np.float32)
        cleaned = apply_dc_removal(arr)
        self.assertAlmostEqual(float(np.mean(cleaned)), 0.0, places=5)
        self.assertEqual(len(cleaned), 5)

    def test_rms_normalization_and_peak_limit(self):
        # Low energy wave
        low_arr = np.array([0.01, -0.01, 0.01, -0.01], dtype=np.float32)
        norm = apply_conservative_rms_norm(low_arr, target_rms=0.08, max_gain_db=12.0)
        self.assertGreater(float(np.max(np.abs(norm))), float(np.max(np.abs(low_arr))))

        # High energy wave that exceeds peak limit
        high_arr = np.array([1.5, -1.2, 0.8, -0.5], dtype=np.float32)
        limited = apply_conservative_peak_limit(high_arr, threshold=0.95)
        self.assertLessEqual(float(np.max(np.abs(limited))), 0.95)

    def test_safe_silence_trimming(self):
        # Silence (0) followed by signal, followed by silence (0)
        sample_rate = 16000
        silence_lead = np.zeros(sample_rate, dtype=np.float32)
        signal = np.sin(2 * np.pi * 440 * np.linspace(0, 1, sample_rate, dtype=np.float32)) * 0.2
        silence_trail = np.zeros(sample_rate, dtype=np.float32)
        wave = np.concatenate([silence_lead, signal, silence_trail])

        trimmed = apply_safe_silence_trim(wave, sample_rate=sample_rate, threshold_db=-45.0, pad_ms=50)
        self.assertLess(len(trimmed), len(wave))
        self.assertGreater(len(trimmed), len(signal))  # Includes safety padding

    def test_composite_adaptation(self):
        wave = np.random.normal(0.05, 0.02, 16000).astype(np.float32)
        adapted = apply_composite_adaptation(wave, sample_rate=16000)
        self.assertEqual(adapted.dtype, np.float32)
        self.assertLessEqual(float(np.max(np.abs(adapted))), 0.95)

    def test_channel_invariant_transforms(self):
        centered = transform_phone_centered_gop(raw_gop=3.5, phone_mean=4.0)
        self.assertAlmostEqual(centered, -0.5)

        z = transform_standard_z(raw_gop=3.0, phone_mean=4.0, phone_std=0.5)
        self.assertAlmostEqual(z, -2.0)

        res = transform_duration_residual(
            raw_gop=3.5,
            duration_frames=15,
            phone_mean_gop=4.0,
            phone_mean_dur=10,
            slope=0.05,
        )
        self.assertAlmostEqual(res, -0.75)


class TestTargetedDeficitsAndPrompts(unittest.TestCase):

    def test_deficient_phone_constants(self):
        self.assertEqual(len(UNDERPOWERED_PHONES), 25)
        self.assertEqual(len(SINGLE_CLASS_PHONES), 1)
        self.assertEqual(len(ALL_DEFICIENT_PHONES), 26)
        self.assertIn("oː", SINGLE_CLASS_PHONES)
        self.assertIn("θ", UNDERPOWERED_PHONES)

    def test_calculate_phone_deficits(self):
        mock_instances = [
            {"expectedPhoneme": "θ", "humanScore": 10.0, "speakerId": f"spk_{i:02d}"}
            for i in range(10)
        ] + [
            {"expectedPhoneme": "θ", "humanScore": 5.0, "speakerId": f"spk_err_{i:02d}"}
            for i in range(5)
        ] + [
            {"expectedPhoneme": "oː", "humanScore": 9.5, "speakerId": f"spk_{i:02d}"}
            for i in range(15)
        ]

        deficits = calculate_phone_deficits(mock_instances)
        self.assertEqual(len(deficits), 26)
        d_map = {d.enginePhone: d for d in deficits}

        self.assertEqual(d_map["θ"].availabilityStatus, "UNDERPOWERED")
        self.assertEqual(d_map["θ"].humanErrorInstances, 5)
        self.assertEqual(d_map["θ"].uniqueErrorSpeakers, 5)
        self.assertEqual(d_map["θ"].targetAdditionalErrorInstances, "TARGET_NOT_ESTABLISHED")
        self.assertEqual(d_map["θ"].planningHeuristicTargetErrors, 30)

        self.assertEqual(d_map["oː"].availabilityStatus, "SINGLE_CLASS")
        self.assertEqual(d_map["oː"].humanErrorInstances, 0)

    def test_targeted_prompt_generator(self):
        corpus = generate_targeted_prompt_corpus()
        self.assertGreater(len(corpus), 100)

        # Check coverage of all 26 deficient phones
        covered_phones = {p.targetPhone for p in corpus}
        for dp in ALL_DEFICIENT_PHONES:
            self.assertIn(dp, covered_phones, f"Deficient phone {dp} missing from prompt generator!")

        # Verify prompt structure
        for p in corpus:
            self.assertTrue(p.promptId.startswith("prompt_"))
            self.assertIn(p.phonePosition, ["INITIAL", "MEDIAL", "FINAL", "MINIMAL_PAIR"])
            self.assertIn(p.difficultyTier, ["EASY", "MEDIUM", "HARD"])
            self.assertIn(p.contextType, ["NATURAL_SENTENCE", "CONTRAST_PAIR", "SHORT_PHRASE", "ISOLATED_WORD"])
            self.assertTrue(len(p.promptText) > 0)
            self.assertTrue(len(p.lexicalPronunciation) > 0)

    def test_error_taxonomy_coverage(self):
        self.assertEqual(len(PHONE_ERROR_TAXONOMY), 26)
        for dp in ALL_DEFICIENT_PHONES:
            self.assertIn(dp, PHONE_ERROR_TAXONOMY)
            tax = PHONE_ERROR_TAXONOMY[dp]
            self.assertEqual(tax.targetPhone, dp)
            self.assertGreater(len(tax.commonSubstitutions), 0)
            self.assertGreater(len(tax.highRiskL1Backgrounds), 0)


class TestLicenseRegistryAndProtocols(unittest.TestCase):

    def test_l2_dataset_candidates(self):
        self.assertGreaterEqual(len(L2_DATASET_CANDIDATES), 5)
        accepted = [d for d in L2_DATASET_CANDIDATES if d.auditStatus == "ACCEPTED_BASELINE"]
        rejected = [d for d in L2_DATASET_CANDIDATES if d.auditStatus == "REJECTED_LICENSE"]

        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0].datasetName, "speechocean762")
        self.assertTrue(accepted[0].commercialUsePermitted)

        # Check L2-ARCTIC is rejected due to CC BY-NC 4.0
        l2_arctic = next(d for d in L2_DATASET_CANDIDATES if d.datasetName == "L2-ARCTIC v5")
        self.assertFalse(l2_arctic.commercialUsePermitted)
        self.assertEqual(l2_arctic.auditStatus, "REJECTED_LICENSE")

    def test_inter_annotator_agreement_calculation(self):
        # Empty records
        empty_res = calculate_inter_annotator_agreement([])
        self.assertEqual(empty_res["status"], "NOT_PERFORMED")

        # Perfect agreement
        perfect_records = [
            HumanL2AnnotationRecord(
                recordId=f"rec_{i}",
                speakerId="spk_1",
                promptId="p_1",
                audioPath="test.wav",
                targetWord="think",
                targetPhone="θ",
                phonePosition="INITIAL",
                recordingEnvironment={},
                annotatorA_correct=(i % 2 == 0),
                annotatorB_correct=(i % 2 == 0),
            )
            for i in range(10)
        ]
        res = calculate_inter_annotator_agreement(perfect_records)
        self.assertEqual(res["status"], "COMPLETED")
        self.assertAlmostEqual(res["observedAgreement"], 1.0)
        self.assertAlmostEqual(res["cohensKappa"], 1.0)

    def test_human_synthetic_isolation_assertion(self):
        clean_dataset = [
            {"id": "utt_1", "expectedPhoneme": "s", "humanScore": 9.0},
            {"id": "utt_2", "expectedPhoneme": "z", "humanScore": 4.0},
        ]
        # Should not raise
        assert_human_synthetic_isolation(clean_dataset)

        contaminated_dataset = [
            {"id": "utt_1", "expectedPhoneme": "s", "humanScore": 9.0},
            {"id": "synth_1", "expectedPhoneme": "z", "isSynthetic": True},
        ]
        with self.assertRaises(ValueError):
            assert_human_synthetic_isolation(contaminated_dataset)


class TestReadinessAndCheckpoints(unittest.TestCase):

    def test_fine_tuning_readiness_assessment(self):
        # Current underpowered state should return NOT_READY
        res = evaluate_fine_tuning_readiness(
            human_l2_speakers=250,
            powered_phones_count=22,
            underpowered_phones_count=25,
            single_class_phones_count=1,
            independent_l2_corpora_count=1,
            cross_channel_l2_hours=14.5,
        )
        self.assertEqual(res.readinessStatus, "NOT_READY")
        self.assertGreater(len(res.blockingDeficits), 0)

        # Hypothetical fully powered multi-corpus state
        ready_res = evaluate_fine_tuning_readiness(
            human_l2_speakers=600,
            powered_phones_count=48,
            underpowered_phones_count=0,
            single_class_phones_count=0,
            independent_l2_corpora_count=3,
            cross_channel_l2_hours=65.0,
        )
        self.assertEqual(ready_res.readinessStatus, "FULL_FINE_TUNE_READY")

    def test_portable_checkpoint_schema(self):
        req_files = PORTABLE_CHECKPOINT_SCHEMA["requiredFiles"]
        self.assertIn("config.json", req_files)
        self.assertIn("model.safetensors", req_files)
        self.assertIn("phone_inventory.json", req_files)
        self.assertIn("model_card.md", req_files)

    def test_frozen_baseline_metrics(self):
        b = FROZEN_SHD_2B2C_BASELINE
        self.assertEqual(b.modelId, "facebook/wav2vec2-lv-60-espeak-cv-ft")
        self.assertEqual(b.modelRevision, "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4")
        self.assertAlmostEqual(b.primaryRocAuc, 0.885882, places=5)
        self.assertAlmostEqual(b.primaryPrAuc, 0.264768, places=5)
        self.assertAlmostEqual(b.primaryEer, 0.193256, places=5)
        self.assertAlmostEqual(b.wordAggregationRho, 0.336845, places=5)
        self.assertAlmostEqual(b.studioVsSpeechOceanGap, 2.9870, places=4)
        self.assertAlmostEqual(b.speechOceanVsBrowserGap, 3.5262, places=4)
        self.assertAlmostEqual(b.studioVsBrowserGap, 6.5132, places=4)


if __name__ == "__main__":
    unittest.main()
