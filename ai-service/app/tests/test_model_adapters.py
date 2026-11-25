import unittest
import numpy as np
import sys
import os

sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from app.services.pronunciation.model_adapter import (
    EspeakWav2Vec2Adapter,
    TimitXlsrAdapter,
    get_acoustic_adapter
)
from app.services.pronunciation.reference_provider import (
    ReferencePronunciationProvider,
    VariantCategory
)
from app.services.pronunciation.acoustic_engine import (
    calculate_raw_gop_and_candidates,
    multi_variant_viterbi_align
)


class TestModelAdaptersAndMultiModelAlignment(unittest.TestCase):
    """
    Deterministic unit tests for SHD-2B.1R3 Model Adapter Architecture.
    Validates token mapping, non-zero blank ID handling, and multi-model alignment compatibility.
    """

    def setUp(self):
        # Mock espeak vocabulary (Baseline A & Challenger 1)
        self.espeak_vocab = {
            "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3,
            "n": 4, "s": 5, "t": 6, "ə": 7, "l": 8, "a": 9,
            "i": 10, "k": 11, "d": 12, "m": 13, "iː": 14,
            "uː": 15, "u": 16, "ɪ": 17, "ð": 18, "ɹ": 19,
            "æ": 20, "eɪ": 21, "oʊ": 22, "ɔːɹ": 23, "ʌ": 24, "w": 25, "p": 26
        }

        # Mock TIMIT vocabulary (Challenger 2)
        self.timit_vocab = {
            "|": 0, "ɑ": 1, "æ": 2, "ə": 3, "aʊ": 4, "aɪ": 5, "b": 6,
            "ʧ": 7, "d": 8, "ð": 9, "ɾ": 10, "ɛ": 11, "ɝ": 12, "eɪ": 13,
            "f": 14, "g": 15, " ": 16, "h": 17, "ɪ": 18, "i": 19, "ʤ": 20,
            "k": 21, "l": 22, "m": 23, "n": 24, "ŋ": 25, "oʊ": 26, "ɔɪ": 27,
            "p": 28, "ɹ": 29, "s": 30, "ʃ": 31, "t": 32, "θ": 33, "ʊ": 34,
            "u": 35, "v": 36, "w": 37, "j": 38, "z": 39, "[UNK]": 40, "[PAD]": 41
        }

    def test_timit_adapter_phone_mapping(self):
        """Verify TimitXlsrAdapter accurately converts espeak/IPA phones to TIMIT 42-phone tokens."""
        # Create lightweight mock adapter instance
        class MockTimitAdapter(TimitXlsrAdapter):
            def __init__(self, vocab):
                self.vocab = vocab
                self.id2tok = {v: k for k, v in vocab.items()}
                self.blank_id = 41
                self.frame_duration_ms = 20.0
                self.param_count = 315000000

        adapter = MockTimitAdapter(self.timit_vocab)

        # Test long vowel mappings
        self.assertEqual(adapter.map_reference_phone("iː"), "i")
        self.assertEqual(adapter.map_reference_phone("uː"), "u")
        self.assertEqual(adapter.map_reference_phone("ɔːɹ"), "ɝ")
        self.assertEqual(adapter.map_reference_phone("ʌ"), "ə")
        self.assertEqual(adapter.map_reference_phone("ɐ"), "ə")
        self.assertEqual(adapter.map_reference_phone("dʒ"), "ʤ")
        self.assertEqual(adapter.map_reference_phone("tʃ"), "ʧ")

        # Test 1:1 consonant and vowel mappings
        self.assertEqual(adapter.map_reference_phone("s"), "s")
        self.assertEqual(adapter.map_reference_phone("k"), "k")
        self.assertEqual(adapter.map_reference_phone("ɹ"), "ɹ")
        self.assertEqual(adapter.map_reference_phone("m"), "m")
        self.assertEqual(adapter.map_reference_phone("d"), "d")
        self.assertEqual(adapter.map_reference_phone("ð"), "ð")
        self.assertEqual(adapter.map_reference_phone("æ"), "æ")
        self.assertEqual(adapter.map_reference_phone("eɪ"), "eɪ")
        self.assertEqual(adapter.map_reference_phone("oʊ"), "oʊ")

        # Test full sequence mapping
        screamed_espeak = ["s", "k", "ɹ", "iː", "m", "d"]
        mapped_seq = adapter.map_variant_phonemes(screamed_espeak)
        self.assertEqual(mapped_seq, ["s", "k", "ɹ", "i", "m", "d"])

    def test_calculate_raw_gop_with_nonzero_blank_id(self):
        """
        Verify calculate_raw_gop_and_candidates accurately excludes a non-zero blank_id (e.g. 41)
        from competitor maximums and candidate phoneme ranking.
        """
        V = 45
        blank_id = 41
        target_token_id = 19  # 'i' in TIMIT
        id2tok = {i: f"tok_{i}" for i in range(V)}
        id2tok[blank_id] = "[PAD]"
        id2tok[target_token_id] = "i"
        id2tok[21] = "k"

        # Construct synthetic log probs: blank is high at 0.0, target is -1.0, competitor k is -2.0
        log_probs = np.full((3, V), -10.0, dtype=np.float32)
        log_probs[:, blank_id] = 0.0
        log_probs[:, target_token_id] = -1.0
        log_probs[:, 21] = -2.0

        gop_res = calculate_raw_gop_and_candidates(
            log_probs=log_probs,
            start_frame=0,
            end_frame=2,
            target_token_id=target_token_id,
            id2tok=id2tok,
            blank_id=blank_id,
            top_k=3
        )

        # Target (-1.0) minus competitor max (-2.0) = +1.0
        self.assertAlmostEqual(gop_res["rawGop"], 1.0, places=3)
        self.assertAlmostEqual(gop_res["strongestCompetitorMeanLogProb"], -2.0, places=3)
        # Blank token [PAD] must NOT be in top candidates
        top_cand_names = [c["phoneme"] for c in gop_res["candidatePhonemes"]]
        self.assertNotIn("[PAD]", top_cand_names)
        self.assertIn("i", top_cand_names)
        self.assertIn("k", top_cand_names)

        target_candidate = next(
            c for c in gop_res["candidatePhonemes"] if c["phoneme"] == "i"
        )
        self.assertAlmostEqual(target_candidate["rawGop"], 1.0, places=3)
        self.assertAlmostEqual(
            target_candidate["strongestCompetitorMeanLogProb"], -2.0, places=3
        )

    def test_multi_variant_viterbi_align_with_nonzero_blank_id(self):
        """
        Verify multi_variant_viterbi_align functions correctly with a non-zero blank ID (e.g. 41).
        """
        provider = ReferencePronunciationProvider(
            vocab=self.timit_vocab,
            phone_mapper=lambda p: {"iː": "i", "ʌ": "ə"}.get(p, p)
        )
        ref = provider.process_reference_text("screamed", scoring_only=True)
        word_screamed = ref.words[0]

        # Ensure word token IDs are mapped to TIMIT IDs
        expected_ids = [self.timit_vocab[p] for p in ["s", "k", "ɹ", "i", "m", "d"]]
        self.assertEqual(word_screamed.variants[0].tokenIds, expected_ids)

        T = 10
        V = 45
        blank_id = 41
        log_probs = np.full((T, V), -10.0, dtype=np.float32)
        log_probs[:, blank_id] = -2.0  # Background blank
        for idx, tid in enumerate(expected_ids):
            t_frame = idx + 2
            log_probs[t_frame, tid] = 0.0

        alignments, diag = multi_variant_viterbi_align(
            log_probs=log_probs,
            reference_words=[word_screamed],
            blank_id=blank_id
        )

        self.assertEqual(len(alignments), 1)
        self.assertEqual(len(alignments[0]["phonemes"]), 6)
        self.assertIn("pathNormalizedLogLikelihood", diag)
        self.assertIn("blankRatio", diag)


if __name__ == "__main__":
    unittest.main()
