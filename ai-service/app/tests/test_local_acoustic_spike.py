import unittest
import numpy as np
import os
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from app.services.pronunciation.reference_provider import (
    ReferencePronunciationProvider,
    ReferenceWord,
    ReferenceVariant,
    tokenize_espeak_phones,
    CANONICAL_ENGLISH_PHONEMES
)
from app.services.pronunciation.acoustic_engine import (
    multi_variant_viterbi_align,
    calculate_raw_gop_and_candidates,
    inspect_audio_metadata,
    decode_audio_bytes_to_16k_mono
)


class TestLocalAcousticSpike(unittest.TestCase):
    """
    Deterministic unit tests for local acoustic engine and alignment mathematics.
    """

    def test_tokenize_espeak_phones_canonical_cases(self):
        """Test greedy longest-match tokenization of canonical English IPA strings."""
        raw_ipa = "skɹiːmd"
        tokens = tokenize_espeak_phones(raw_ipa)
        self.assertEqual(tokens, ["s", "k", "ɹ", "iː", "m", "d"])

        raw_ipa_2 = "mɔːɹnɪŋ"
        tokens_2 = tokenize_espeak_phones(raw_ipa_2)
        self.assertEqual(tokens_2, ["m", "ɔːɹ", "n", "ɪ", "ŋ"])

        raw_ipa_3 = "məʃiːn"
        tokens_3 = tokenize_espeak_phones(raw_ipa_3)
        self.assertEqual(tokens_3, ["m", "ə", "ʃ", "iː", "n"])

    def test_get_reference_phoneme_sequence_mapping(self):
        """Test reference sentence G2P breakdown and token ID assignment."""
        mock_vocab = {
            "<pad>": 0,
            "<s>": 1,
            "</s>": 2,
            "<unk>": 3,
            "ð": 22,
            "ɪ": 17,
            "s": 5,
            "m": 13,
            "ɔːɹ": 71,
            "ɔː": 70,
            "n": 4,
            "ŋ": 42,
            "eɪ": 44,
            "ə": 18,
            "ɐ": 19,
            "ʃ": 38,
            "iː": 30,
            "i": 29,
            "k": 11,
            "ɹ": 27,
            "d": 9,
            "æ": 21,
            "t": 6,
            "j": 25,
            "uː": 37,
            "u": 36,
            "ʌ": 28,
            "l": 10,
            "w": 27,
            "oʊ": 48,
            "p": 16
        }

        provider = ReferencePronunciationProvider(mock_vocab)
        ref_text = "This morning, a machine screamed at you until you woke up."
        ref_sent = provider.process_reference_text(ref_text)

        self.assertGreater(len(ref_sent.words), 5)
        self.assertEqual(ref_sent.words[0].surfaceText, "this")

        # Ensure no unmapped token (<unk> = 3) in primary variants
        for rw in ref_sent.words:
            self.assertGreater(len(rw.variants), 0)
            for tid in rw.variants[0].tokenIds:
                self.assertNotEqual(tid, 3, f"Unexpected <unk> token in word {rw.surfaceText}")

    def test_viterbi_ctc_align_synthetic_trellis(self):
        """
        Verify Viterbi dynamic programming correctness on a synthetic log-prob matrix.
        Target sequence: [10, 20]
        """
        T = 6
        V = 30
        blank_id = 0
        
        # Construct ReferenceWord with single variant [10, 20]
        word = ReferenceWord(
            wordIndex=0,
            surfaceText="test",
            normalizedText="test",
            variants=[ReferenceVariant(phonemes=["p1", "p2"], tokenIds=[10, 20], source="test")]
        )

        log_probs = np.full((T, V), -10.0, dtype=np.float32)
        # Frame 0: blank (state 0)
        log_probs[0, 0] = 0.0
        # Frames 1-2: token 10
        log_probs[1, 10] = 0.0
        log_probs[2, 10] = 0.0
        # Frame 3: blank
        log_probs[3, 0] = 0.0
        # Frames 4-5: token 20
        log_probs[4, 20] = 0.0
        log_probs[5, 20] = 0.0

        alignments, diag = multi_variant_viterbi_align(log_probs, [word], blank_id=blank_id)

        self.assertEqual(len(alignments), 1)
        phones = alignments[0]["phonemes"]
        self.assertEqual(len(phones), 2)
        self.assertEqual((phones[0]["startFrame"], phones[0]["endFrame"]), (1, 2))
        self.assertEqual((phones[1]["startFrame"], phones[1]["endFrame"]), (4, 5))

    def test_viterbi_ctc_align_repeated_tokens_cannot_skip_blank(self):
        """
        CTC rule verification: When two consecutive tokens are identical [10, 10],
        an intervening blank is required to distinguish repetitions.
        """
        T = 5
        V = 20
        blank_id = 0
        word = ReferenceWord(
            wordIndex=0,
            surfaceText="repeat",
            normalizedText="repeat",
            variants=[ReferenceVariant(phonemes=["p1", "p1"], tokenIds=[10, 10], source="test")]
        )

        log_probs = np.full((T, V), -10.0, dtype=np.float32)
        log_probs[0, 10] = 0.0
        log_probs[1, 10] = 0.0
        log_probs[2, 0] = 0.0  # Mandatory blank
        log_probs[3, 10] = 0.0
        log_probs[4, 0] = 0.0

        alignments, diag = multi_variant_viterbi_align(log_probs, [word], blank_id=blank_id)

        phones = alignments[0]["phonemes"]
        self.assertEqual((phones[0]["startFrame"], phones[0]["endFrame"]), (0, 1))
        self.assertEqual((phones[1]["startFrame"], phones[1]["endFrame"]), (3, 3))

    def test_calculate_raw_gop_positive_and_negative(self):
        """
        Test GOP calculation:
        Case 1: Target log-prob exceeds competitors -> GOP > 0
        Case 2: Competitor log-prob exceeds target -> GOP < 0
        """
        V = 5
        id2tok = {0: "<pad>", 1: "s", 2: "t", 3: "k", 4: "p"}

        high_log_probs = np.array([
            [-5.0, -0.1, -4.0, -5.0, -6.0],
            [-5.0, -0.2, -3.5, -4.5, -5.5]
        ], dtype=np.float32)

        gop_high = calculate_raw_gop_and_candidates(
            log_probs=high_log_probs,
            start_frame=0,
            end_frame=1,
            target_token_id=1,
            id2tok=id2tok,
            top_k=3
        )

        self.assertIsNotNone(gop_high["rawGop"])
        self.assertGreater(gop_high["rawGop"], 0.0)
        self.assertEqual(gop_high["candidatePhonemes"][0]["phoneme"], "s")

        low_log_probs = np.array([
            [-5.0, -5.0, -0.1, -6.0, -6.0],
            [-5.0, -4.5, -0.2, -5.5, -5.5]
        ], dtype=np.float32)

        gop_low = calculate_raw_gop_and_candidates(
            log_probs=low_log_probs,
            start_frame=0,
            end_frame=1,
            target_token_id=1,
            id2tok=id2tok,
            top_k=3
        )

        self.assertIsNotNone(gop_low["rawGop"])
        self.assertLess(gop_low["rawGop"], 0.0)
        self.assertEqual(gop_low["candidatePhonemes"][0]["phoneme"], "t")

    def test_audio_metadata_inspection(self):
        """Test audio container identification and energy statistics."""
        fake_wav_header = b"RIFF" + b"\x00" * 40
        fake_waveform = np.array([0.1, -0.1, 0.2, -0.2, 0.0], dtype=np.float32)

        meta = inspect_audio_metadata(fake_wav_header, fake_waveform)
        self.assertIn("wav", meta["container"])
        self.assertEqual(meta["sampleCount"], 5)
        self.assertGreater(meta["rmsEnergy"], 0.0)
        self.assertEqual(meta["peakAmplitude"], 0.2)

    def test_invalid_audio_decoding_raises_error(self):
        """Test that invalid/corrupt audio bytes raise an informative ValueError."""
        corrupt_bytes = b"CORRUPT_NOT_AUDIO_DATA_AT_ALL_12345"
        with self.assertRaises(ValueError):
            decode_audio_bytes_to_16k_mono(corrupt_bytes)


if __name__ == "__main__":
    unittest.main()
