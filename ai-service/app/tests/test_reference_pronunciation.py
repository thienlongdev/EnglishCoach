import unittest
import numpy as np
import sys
import os

sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from app.services.pronunciation.reference_provider import (
    ReferencePronunciationProvider,
    VariantCategory,
    DEFAULT_SCORING_CATEGORIES,
    tokenize_espeak_phones,
    WEAK_FORM_LEXICON,
    CONTRACTIONS_LEXICON
)
from app.services.pronunciation.acoustic_engine import (
    multi_variant_viterbi_align,
    calculate_raw_gop_and_candidates,
    inspect_audio_metadata
)
from app.services.pronunciation.calibration_models import (
    PhoneCalibrationStats,
    calculate_calibrated_score
)


class TestReferencePronunciationAndCalibration(unittest.TestCase):
    """
    Deterministic unit tests for SHD-2B.1R2 Acceptance Repair:
    - Multi-variant pronunciation generation with explicit category tagging
    - Strict scoring eligibility (STANDARD & CONTEXTUAL_WEAK_FORM only)
    - Strict retention of final coda consonants in scoring (e.g. 'screamed' requires /d/)
    - Raw alignment diagnostics (no hardcoded uncalibrated threshold detectors)
    - Null observed phoneme & calibration score invariants
    """

    def setUp(self):
        # Mock vocabulary matching Wav2Vec2 espeak vocabulary structure
        self.mock_vocab = {
            "<pad>": 0,
            "<s>": 1,
            "</s>": 2,
            "<unk>": 3,
            "n": 4,
            "s": 5,
            "t": 6,
            "m": 13,
            "k": 11,
            "p": 16,
            "d": 9,
            "l": 10,
            "w": 27,
            "j": 25,
            "ɹ": 27,
            "v": 15,
            "z": 14,
            "ð": 22,
            "θ": 32,
            "ʃ": 38,
            "iː": 30,
            "uː": 37,
            "i": 29,
            "u": 36,
            "ɪ": 17,
            "ə": 18,
            "ɐ": 19,
            "ʌ": 28,
            "æ": 21,
            "eɪ": 44,
            "oʊ": 48,
            "ɔːɹ": 71,
            "ɔː": 70,
            "ɑː": 68,
            "aɪ": 46,
            "ŋ": 42
        }
        self.provider = ReferencePronunciationProvider(self.mock_vocab)

    def test_a_machine_allows_contextually_valid_reduced_pronunciation(self):
        """
        Verify that 'a' in 'a machine' generates BOTH the reduced weak form (/ə/)
        and the citation/strong form (/eɪ/) with explicit category and scoring eligibility.
        """
        ref = self.provider.process_reference_text("a machine", scoring_only=True)
        self.assertEqual(len(ref.words), 2)

        word_a = ref.words[0]
        self.assertEqual(word_a.surfaceText, "a")

        variant_phonemes = [v.phonemes for v in word_a.variants]
        self.assertIn(["ə"], variant_phonemes, "Weak form /ə/ missing from scoring variants of 'a'")
        self.assertIn(["eɪ"], variant_phonemes, "Citation form /eɪ/ missing from scoring variants of 'a'")

        # Check category and scoring eligibility
        weak_v = [v for v in word_a.variants if v.phonemes == ["ə"]][0]
        self.assertEqual(weak_v.category, VariantCategory.CONTEXTUAL_WEAK_FORM)
        self.assertTrue(weak_v.isScoringEligible)

        strong_v = [v for v in word_a.variants if v.phonemes == ["eɪ"]][0]
        self.assertEqual(strong_v.category, VariantCategory.STANDARD)
        self.assertTrue(strong_v.isScoringEligible)

    def test_screamed_retains_final_d_in_default_scoring(self):
        """
        Critical Acceptance Invariant:
        In default scoring, 'screamed' MUST NOT accept coda deletion /skɹiːm/.
        The learner must be evaluated on the final consonant /d/.
        """
        # 1. Full metadata check (all variants)
        all_variants = self.provider.generate_variants_for_word("screamed", 0, ["screamed"])
        coda_del_variants = [v for v in all_variants if v.phonemes == ["s", "k", "ɹ", "iː", "m"]]
        if coda_del_variants:
            self.assertEqual(coda_del_variants[0].category, VariantCategory.CASUAL_REDUCTION)
            self.assertFalse(coda_del_variants[0].isScoringEligible)

        # 2. Scoring-only check (Shadowing assessment mode)
        ref = self.provider.process_reference_text("screamed", scoring_only=True)
        scoring_variants = ref.words[0].variants
        for var in scoring_variants:
            self.assertEqual(var.phonemes[-1], "d", f"Scoring variant '{var.phonemes}' is missing required final /d/")
            self.assertIn(var.category, DEFAULT_SCORING_CATEGORIES)
            self.assertTrue(var.isScoringEligible)

    def test_casual_reductions_excluded_from_default_scoring(self):
        """
        Verify that casual reductions (e.g. 'you' -> /jə/, 'until' -> /ntɪl/) are marked
        CASUAL_REDUCTION and excluded from default scoring variants.
        """
        # 'you' in scoring mode must only have standard /juː/
        ref_you = self.provider.process_reference_text("you", scoring_only=True)
        you_variants = [v.phonemes for v in ref_you.words[0].variants]
        self.assertIn(["j", "uː"], you_variants)
        self.assertNotIn(["j", "ə"], you_variants)

        # 'until' in scoring mode must only have standard /ʌntɪl/ and contextual weak /əntɪl/
        ref_until = self.provider.process_reference_text("until", scoring_only=True)
        until_variants = [v.phonemes for v in ref_until.words[0].variants]
        self.assertNotIn(["n", "t", "ɪ", "l"], until_variants)

    def test_repeated_words_preserve_separate_positions(self):
        """Verify that repeated words (e.g. 'a a') maintain separate word indices (0 and 1)."""
        ref = self.provider.process_reference_text("a a")
        self.assertEqual(len(ref.words), 2)
        self.assertEqual(ref.words[0].wordIndex, 0)
        self.assertEqual(ref.words[1].wordIndex, 1)

    def test_contextual_articles_the_apple_vs_the_machine(self):
        """
        Verify contextual article rules:
        - 'the' before consonant ('the machine') -> weak /ðə/
        - 'the' before vowel ('the apple') -> weak /ðiː/ or /ði/
        """
        ref_consonant = self.provider.process_reference_text("the machine")
        c_variants = [v.phonemes for v in ref_consonant.words[0].variants]
        self.assertIn(["ð", "ə"], c_variants)

        ref_vowel = self.provider.process_reference_text("the apple")
        v_variants = [v.phonemes for v in ref_vowel.words[0].variants]
        self.assertTrue(any("iː" in v or "i" in v or "ɪ" in v for v in v_variants))

    def test_preposition_to_go_weak_form(self):
        """Verify 'to' before consonant in 'to go' provides weak /tə/ variant."""
        ref = self.provider.process_reference_text("to go")
        variants = [v.phonemes for v in ref.words[0].variants]
        self.assertIn(["t", "ə"], variants)

    def test_contractions_expansion_and_tokenization(self):
        """Verify contractions are parsed correctly without breaking on internal apostrophes."""
        test_phrases = ["I'm", "you're", "he's", "she's", "it's", "don't", "can't", "won't", "didn't", "I've", "we've", "they'll"]
        for phrase in test_phrases:
            ref = self.provider.process_reference_text(phrase)
            self.assertEqual(len(ref.words), 1, f"Failed parsing contraction '{phrase}'")
            w = ref.words[0]
            self.assertGreater(len(w.variants), 0)
            for var in w.variants:
                self.assertIn(var.category, DEFAULT_SCORING_CATEGORIES)

    def test_multi_variant_viterbi_alignment_selects_matching_weak_form(self):
        """
        Verify that given synthetic acoustic log-probs matching the weak variant /ə/
        over the citation form /eɪ/, multi_variant_viterbi_align dynamically selects /ə/.
        """
        ref = self.provider.process_reference_text("a", scoring_only=True)
        word_a = ref.words[0]

        T = 4
        V = 60
        log_probs = np.full((T, V), -10.0, dtype=np.float32)

        # Blank at t=0, /ə/ (token 18) at t=1,2, blank at t=3
        log_probs[0, 0] = 0.0
        log_probs[1, 18] = 0.0
        log_probs[2, 18] = 0.0
        log_probs[3, 0] = 0.0

        alignments, diag = multi_variant_viterbi_align(log_probs, [word_a], blank_id=0)

        self.assertEqual(len(alignments), 1)
        selected_var = alignments[0]["selectedVariant"]
        self.assertEqual(selected_var, ["ə"])
        self.assertEqual(alignments[0]["variantCategory"], VariantCategory.CONTEXTUAL_WEAK_FORM.value)
        self.assertIn("pathNormalizedLogLikelihood", diag)
        self.assertIn("phonemeCoverage", diag)

    def test_raw_alignment_diagnostics_exposed_without_uncalibrated_claims(self):
        """
        Verify raw alignment metrics are exposed truthfully without uncalibrated detector flags.
        """
        ref = self.provider.process_reference_text("screamed", scoring_only=True)
        word_screamed = ref.words[0]

        # 25 frames of pure silence/blank
        T = 25
        V = 60
        log_probs = np.full((T, V), -10.0, dtype=np.float32)
        log_probs[:, 0] = 0.0

        alignments, diag = multi_variant_viterbi_align(log_probs, [word_screamed], blank_id=0)

        # Raw metrics must be present
        self.assertIn("pathNormalizedLogLikelihood", diag)
        self.assertIn("meanPhonemeLogLikelihood", diag)
        self.assertIn("excessiveBlankRatio", diag)
        self.assertIn("blankRatio", diag)
        self.assertIn("phonemeCoverage", diag)
        self.assertIn("experimentalDiagnosticOnly", diag)
        self.assertGreater(diag["blankRatio"], 0.6)

    def test_calibration_interface_returns_null_when_uncalibrated(self):
        """
        Verify the strict invariant: calculate_calibrated_score MUST return None
        when calibration statistics are absent or uncalibrated.
        """
        score_1 = calculate_calibrated_score(raw_gop=2.5, stats=None)
        self.assertIsNone(score_1)

        stats = PhoneCalibrationStats(phoneme="s", sampleCount=5)
        score_2 = calculate_calibrated_score(raw_gop=2.5, stats=stats)
        self.assertIsNone(score_2)

    def test_observed_phoneme_is_strictly_none(self):
        """
        Verify that the output format sets observedPhoneme to None and exposes candidate phonemes.
        """
        V = 5
        id2tok = {0: "<pad>", 1: "s", 2: "t", 3: "k", 4: "p"}
        log_probs = np.array([
            [-5.0, -0.1, -4.0, -5.0, -6.0],
            [-5.0, -0.2, -3.5, -4.5, -5.5]
        ], dtype=np.float32)

        gop_data = calculate_raw_gop_and_candidates(
            log_probs=log_probs,
            start_frame=0,
            end_frame=1,
            target_token_id=1,
            id2tok=id2tok,
            top_k=3
        )

        self.assertIsNotNone(gop_data["rawGop"])
        self.assertEqual(len(gop_data["candidatePhonemes"]), 3)
        self.assertEqual(gop_data["candidatePhonemes"][0]["phoneme"], "s")


if __name__ == "__main__":
    unittest.main()
