"""
Unit tests for Phoneme Diagnosis & Articulatory Feature Schema (Round 1).
"""

import unittest
from transformers import Wav2Vec2Processor
import torch

from app.services.pronunciation.acoustic_peft import CANONICAL_MODEL_ID, CANONICAL_MODEL_REVISION
from app.services.pronunciation.articulatory_diagnosis import (
    CanonicalRealPhoneInventory,
    TrainConfusionGraph,
    ConsonantPlace,
    ConsonantManner,
    Voicing,
    VowelHeight,
    VowelBackness,
    VowelRounding,
    VowelTenseness,
)


class TestArticulatoryDiagnosis(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            processor = Wav2Vec2Processor.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
            cls.vocab = processor.tokenizer.get_vocab()
        except Exception:
            cls.vocab = {
                "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4,
                "p": 5, "b": 6, "t": 7, "d": 8, "k": 9, "g": 10,
                "f": 11, "v": 12, "θ": 13, "ð": 14, "s": 15, "z": 16,
                "ʃ": 17, "ʒ": 18, "h": 19, "tʃ": 20, "dʒ": 21,
                "m": 22, "n": 23, "ŋ": 24, "l": 25, "r": 26, "j": 27, "w": 28,
                "iː": 29, "ɪ": 30, "e": 31, "æ": 32, "ɑː": 33, "ɒ": 34,
                "ɔː": 35, "ʊ": 36, "uː": 37, "ʌ": 38, "ɜː": 39, "ə": 40,
                "eɪ": 41, "aɪ": 42, "ɔɪ": 43, "aʊ": 44, "oʊ": 45,
            }
        cls.inventory = CanonicalRealPhoneInventory(cls.vocab)

    def test_real_phone_inventory_excludes_special_tokens(self):
        # Must exclude tokens < 4 (<pad>, <s>, </s>, <unk>)
        for profile in self.inventory.real_phones:
            self.assertGreaterEqual(profile.tokenId, 4)
            self.assertNotIn(profile.canonicalIpa, ["<pad>", "<s>", "</s>", "<unk>", "|", " ", "\u0329"])

    def test_voicing_contrast_p_vs_b(self):
        p_prof = self.inventory.phone2profile["p"]
        b_prof = self.inventory.phone2profile["b"]
        self.assertEqual(p_prof.place, b_prof.place) # both bilabial
        self.assertEqual(p_prof.manner, b_prof.manner) # both stop
        self.assertEqual(p_prof.voicing, Voicing.VOICELESS)
        self.assertEqual(b_prof.voicing, Voicing.VOICED)
        self.assertNotEqual(p_prof.voicing, b_prof.voicing)

    def test_place_contrast_theta_vs_s(self):
        th_prof = self.inventory.phone2profile["θ"]
        s_prof = self.inventory.phone2profile["s"]
        self.assertEqual(th_prof.manner, s_prof.manner) # both fricative
        self.assertEqual(th_prof.voicing, s_prof.voicing) # both voiceless
        self.assertEqual(th_prof.place, ConsonantPlace.DENTAL)
        self.assertEqual(s_prof.place, ConsonantPlace.ALVEOLAR)
        self.assertNotEqual(th_prof.place, s_prof.place)

    def test_manner_contrast_t_vs_s(self):
        t_prof = self.inventory.phone2profile["t"]
        s_prof = self.inventory.phone2profile["s"]
        self.assertEqual(t_prof.place, s_prof.place) # both alveolar
        self.assertEqual(t_prof.voicing, s_prof.voicing) # both voiceless
        self.assertEqual(t_prof.manner, ConsonantManner.STOP)
        self.assertEqual(s_prof.manner, ConsonantManner.FRICATIVE)
        self.assertNotEqual(t_prof.manner, s_prof.manner)

    def test_vowel_contrast_i_vs_u(self):
        i_prof = self.inventory.phone2profile["iː"]
        u_prof = self.inventory.phone2profile["uː"]
        self.assertEqual(i_prof.height, u_prof.height) # both close
        self.assertEqual(i_prof.backness, VowelBackness.FRONT)
        self.assertEqual(u_prof.backness, VowelBackness.BACK)
        self.assertEqual(i_prof.rounding, VowelRounding.UNROUNDED)
        self.assertEqual(u_prof.rounding, VowelRounding.ROUNDED)

    def test_vowel_quality_contrast_ih_vs_iy(self):
        ih_prof = self.inventory.phone2profile["ɪ"]
        iy_prof = self.inventory.phone2profile["iː"]
        self.assertEqual(ih_prof.backness, iy_prof.backness) # both front
        self.assertEqual(ih_prof.rounding, iy_prof.rounding) # both unrounded
        self.assertEqual(ih_prof.tenseness, VowelTenseness.LAX)
        self.assertEqual(iy_prof.tenseness, VowelTenseness.TENSE)

    def test_articulatory_neighbors_exclude_special_tokens(self):
        neighbors = self.inventory.get_articulatory_neighbors("θ", top_k=5)
        self.assertIn("s", neighbors) # dental -> alveolar fricative
        for n in neighbors:
            tid = self.inventory.phone2profile[n].tokenId
            self.assertGreaterEqual(tid, 4)

    def test_differentiable_projection_matrix_dimensions(self):
        M, feats = self.inventory.articulatory_matrix, self.inventory.feature_names
        self.assertEqual(M.shape[0], self.inventory.num_real_phones)
        self.assertEqual(M.shape[1], len(feats))
        # Probabilities projected through M produce valid feature activations
        dummy_probs = torch.softmax(torch.randn(2, self.inventory.num_real_phones), dim=-1)
        art_acts = torch.matmul(dummy_probs, M)
        self.assertEqual(art_acts.shape, (2, len(feats)))


if __name__ == "__main__":
    unittest.main()
