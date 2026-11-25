"""
Unit tests for ECSM Phase P7:
Prosodic Reality Modeling, Pitch (F0), Energy, Duration, Lexical Stress, Rhythm,
Pauses, Reference-Relative Intonation, and Raw Prosody Firewall.
"""

from pathlib import Path
import unittest
import numpy as np

from app.services.pronunciation.ecsm.prosodic_reality import (
    EnergyExtractor,
    IntonationComparator,
    LexicalStressAnalyzer,
    PauseDetector,
    PitchExtractor,
    ProsodicRealityModel,
    ProsodyMode,
    ProsodyUncertaintyReason,
    RhythmAndRateAnalyzer,
    Syllabifier,
)
from scripts.ecsm_p7_engine import (
    audit_p7_data_provenance,
    generate_p7_feature_registry,
    run_behavioral_perturbation_tests,
)


class TestEcsmP7(unittest.TestCase):
    def setUp(self):
        self.sr = 16000
        self.model = ProsodicRealityModel(sample_rate=self.sr)

    def test_pitch_extractor_sine_and_voicing(self):
        """Verifies PitchExtractor accuracy on pure sine tone and clean unvoiced masking."""
        t = np.linspace(0, 0.5, int(0.5 * self.sr))
        sine_200hz = 0.5 * np.sin(2 * np.pi * 200 * t)

        extractor = PitchExtractor(sample_rate=self.sr)
        feats = extractor.extract(sine_200hz)

        self.assertIsNotNone(feats.median_hz)
        self.assertAlmostEqual(feats.median_hz, 200.0, delta=3.0)
        self.assertGreater(feats.voiced_frame_ratio, 0.70)
        self.assertEqual(feats.uncertainty, ProsodyUncertaintyReason.NONE.value)

        # Unvoiced silence should return None without crashing
        silence = np.zeros(int(0.5 * self.sr))
        silence_feats = extractor.extract(silence)
        self.assertIsNone(silence_feats.median_hz)
        self.assertEqual(silence_feats.uncertainty, ProsodyUncertaintyReason.INSUFFICIENT_VOICED_FRAMES.value)

    def test_energy_extractor_gain_invariance(self):
        """Verifies frame RMS and dynamic range invariance under global gain changes."""
        t = np.linspace(0, 0.5, int(0.5 * self.sr))
        audio = 0.8 * np.sin(2 * np.pi * 150 * t) + 0.1 * np.random.randn(len(t))

        extractor = EnergyExtractor(sample_rate=self.sr)
        feats1 = extractor.extract(audio)
        feats2 = extractor.extract(0.5 * audio)

        self.assertAlmostEqual(feats1.dynamic_range_db, feats2.dynamic_range_db, delta=1.5)
        self.assertGreater(feats1.mean_rms, feats2.mean_rms)

    def test_syllabifier_and_duration(self):
        """Verifies deterministic syllabification around vowel nuclei."""
        phones = ["b", "æ", "n", "æ", "n", "ə"]  # "banana" (3 syllables)
        durs = [0.08, 0.15, 0.08, 0.18, 0.08, 0.12]

        syllables = Syllabifier.syllabify(phones, durs)
        self.assertEqual(len(syllables), 3)
        self.assertEqual(syllables[0].nucleus_phone, "æ")
        self.assertEqual(syllables[1].nucleus_phone, "æ")
        self.assertEqual(syllables[2].nucleus_phone, "ə")
        self.assertAlmostEqual(sum(s.duration_sec for s in syllables), sum(durs), places=2)

    def test_lexical_stress_analyzer(self):
        """Verifies relative intra-word prominence and primary stress detection."""
        phones = ["p", "r", "e", "z", "ə", "n", "t"]  # "present" (noun, primary stress on syl 0)
        durs = [0.08, 0.08, 0.22, 0.08, 0.10, 0.08, 0.08]
        syllables = Syllabifier.syllabify(phones, durs)

        f0_st = [2.0] * 20 + [-2.0] * 20  # higher pitch on first syllable
        energy = [0.8] * 20 + [0.3] * 20  # higher energy on first syllable

        res = LexicalStressAnalyzer.analyze_word_stress(
            word="present",
            syllables=syllables,
            pitch_contour_st=f0_st,
            energy_contour=energy,
            expected_primary_syllable=0,
        )

        self.assertEqual(res.observed_primary_syllable, 0)
        self.assertTrue(res.is_stress_match)
        self.assertLess(res.mismatch_probability, 0.20)

    def test_pause_detector(self):
        """Verifies silent pause detection on inserted silence."""
        t = np.linspace(0, 0.3, int(0.3 * self.sr))
        speech = 0.5 * np.sin(2 * np.pi * 200 * t)
        silence_250ms = np.zeros(int(0.25 * self.sr))

        audio_with_pause = np.concatenate([speech, silence_250ms, speech])

        detector = PauseDetector(sample_rate=self.sr)
        pause_res = detector.detect(audio_with_pause)

        self.assertEqual(pause_res.total_pauses_count, 1)
        self.assertAlmostEqual(pause_res.total_pause_duration_sec, 0.25, delta=0.05)

    def test_intonation_comparator_dtw(self):
        """Verifies syllable-anchored DTW semitone distance and contour correlation."""
        learner_st = [0.0, 1.0, 2.0, 3.0, 2.0, 1.0, 0.0]
        # Identical reference -> 0 semitone distance, 1.0 correlation
        dist, corr = IntonationComparator.compare_reference(learner_st, learner_st)
        self.assertIsNotNone(dist)
        self.assertAlmostEqual(dist, 0.0, places=2)
        self.assertAlmostEqual(corr, 1.0, places=2)

        # Inverted reference -> high distance, negative correlation
        inverted_st = [0.0, -1.0, -2.0, -3.0, -2.0, -1.0, 0.0]
        dist_inv, corr_inv = IntonationComparator.compare_reference(learner_st, inverted_st)
        self.assertGreater(dist_inv, 2.0)
        self.assertLess(corr_inv, -0.80)

    def test_raw_prosody_firewall_pss_raw(self):
        """Proves PSS_RAW = 0.00000000 under counterfactual text mutations."""
        t = np.linspace(0, 0.6, int(0.6 * self.sr))
        audio = 0.4 * np.sin(2 * np.pi * 150 * t)
        phones = ["s", "ʌ", "n"]
        durs = [0.20, 0.25, 0.15]
        words = [{"word": "sun", "startTime": 0.0, "endTime": 0.6, "expectedStressIndex": 0}]

        pss_raw, is_clean = self.model.verify_raw_prosody_firewall(audio, phones, durs, words)
        self.assertTrue(is_clean)
        self.assertAlmostEqual(pss_raw, 0.0, places=6)

    def test_behavioral_perturbations(self):
        """Verifies full behavioral perturbation suite passes."""
        res = run_behavioral_perturbation_tests(self.model)
        self.assertTrue(res["allPerturbationTestsPassed"])


if __name__ == "__main__":
    unittest.main()
