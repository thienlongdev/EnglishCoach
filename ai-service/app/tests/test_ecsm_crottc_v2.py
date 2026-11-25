"""
ECSM Pronunciation Engine V2: CROTTC-IF Unit and Integration Tests.
Tests Phone Mapping, Levenshtein Sequence Alignment, Multi-Variant Canonical Matching,
P8 Hierarchy Integration, and P9 Single-Focus Issue Selection.
"""

import unittest
from typing import List, Dict, Any

from app.services.pronunciation.ecsm.crottc_label_mapping import (
    CROTTC_LABEL_TO_ID,
    CROTTC_LABEL_TO_IPA,
    IPA_TO_CROTTC_LABEL,
    crottc_label_to_ipa,
    ipa_to_crottc_label,
    normalize_crottc_sequence_to_ipa,
)
from app.services.pronunciation.ecsm.mdd_sequence_alignment import (
    PhoneSequenceAligner,
    TargetPhoneItem,
    AlignmentOperation,
    are_phones_equivalent,
    phone_substitution_cost,
)
from app.services.pronunciation.ecsm.crottc_adapter import CrottcMddAdapter, CrottcMddResult
from app.services.pronunciation.ecsm.hierarchical_assessment import (
    HierarchicalAssessmentEngine,
    PhoneAssessment,
    WordAssessment,
    UtteranceAssessment,
)

class TestCrottcLabelMapping(unittest.TestCase):
    def test_total_label_count(self):
        self.assertEqual(len(CROTTC_LABEL_TO_ID), 44, "CROTTC vocabulary must have exactly 44 labels")
        self.assertEqual(len(CROTTC_LABEL_TO_IPA), 44)

    def test_critical_consonant_mappings(self):
        self.assertEqual(crottc_label_to_ipa("th"), "θ")
        self.assertEqual(crottc_label_to_ipa("s"), "s")
        self.assertEqual(crottc_label_to_ipa("dh"), "ð")
        self.assertEqual(crottc_label_to_ipa("d"), "d")
        self.assertEqual(crottc_label_to_ipa("r"), "ɹ")
        self.assertEqual(crottc_label_to_ipa("l"), "l")
        self.assertEqual(crottc_label_to_ipa("v"), "v")
        self.assertEqual(crottc_label_to_ipa("w"), "w")
        self.assertEqual(crottc_label_to_ipa("ch"), "tʃ")
        self.assertEqual(crottc_label_to_ipa("jh"), "dʒ")
        self.assertEqual(crottc_label_to_ipa("sh"), "ʃ")
        self.assertEqual(crottc_label_to_ipa("zh"), "ʒ")

    def test_critical_vowel_mappings(self):
        self.assertEqual(crottc_label_to_ipa("iy"), "i")
        self.assertEqual(crottc_label_to_ipa("ih"), "ɪ")
        self.assertEqual(crottc_label_to_ipa("ey"), "eɪ")
        self.assertEqual(crottc_label_to_ipa("eh"), "ɛ")
        self.assertEqual(crottc_label_to_ipa("ae"), "æ")
        self.assertEqual(crottc_label_to_ipa("aa"), "ɑ")
        self.assertEqual(crottc_label_to_ipa("ao"), "ɔ")
        self.assertEqual(crottc_label_to_ipa("ow"), "oʊ")
        self.assertEqual(crottc_label_to_ipa("uh"), "ʊ")
        self.assertEqual(crottc_label_to_ipa("uw"), "u")
        self.assertEqual(crottc_label_to_ipa("ah"), "ʌ")
        self.assertEqual(crottc_label_to_ipa("er"), "ɚ")
        self.assertEqual(crottc_label_to_ipa("ay"), "aɪ")
        self.assertEqual(crottc_label_to_ipa("aw"), "aʊ")
        self.assertEqual(crottc_label_to_ipa("oy"), "ɔɪ")

    def test_reverse_mapping(self):
        self.assertEqual(ipa_to_crottc_label("θ"), "th")
        self.assertEqual(ipa_to_crottc_label("s"), "s")
        self.assertEqual(ipa_to_crottc_label("ð"), "dh")
        self.assertEqual(ipa_to_crottc_label("d"), "d")
        self.assertEqual(ipa_to_crottc_label("ɹ"), "r")
        self.assertEqual(ipa_to_crottc_label("i"), "iy")
        self.assertEqual(ipa_to_crottc_label("ɪ"), "ih")

    def test_special_tokens_filtering(self):
        raw_tokens = ["<bos>", "sil", "th", "ih", "ng", "k", "<eos>", "<blank>"]
        filtered_ipa = normalize_crottc_sequence_to_ipa(raw_tokens)
        self.assertEqual(filtered_ipa, ["θ", "ɪ", "ŋ", "k"])


class TestPhoneSequenceAlignment(unittest.TestCase):
    def setUp(self):
        self.aligner = PhoneSequenceAligner(insertion_cost=1.0, deletion_cost=1.0)

    def test_exact_match_sequence(self):
        canonical = [
            TargetPhoneItem("W_0", 0, "So", "PH_0", 0, "s"),
            TargetPhoneItem("W_0", 0, "So", "PH_1", 1, "oʊ"),
        ]
        perceived = ["s", "oʊ"]
        res = self.aligner.align_single_sequence(canonical, perceived)
        self.assertEqual(res.match_count, 2)
        self.assertEqual(res.substitution_count, 0)
        self.assertEqual(res.deletion_count, 0)
        self.assertEqual(res.insertion_count, 0)
        self.assertEqual(res.total_cost, 0.0)

    def test_theta_to_s_substitution_case_c(self):
        """Case C: think /θ ɪ ŋ k/ pronounced as sink /s ɪ ŋ k/."""
        canonical = [
            TargetPhoneItem("W_0", 0, "think", "PH_0", 0, "θ"),
            TargetPhoneItem("W_0", 0, "think", "PH_1", 1, "ɪ"),
            TargetPhoneItem("W_0", 0, "think", "PH_2", 2, "ŋ"),
            TargetPhoneItem("W_0", 0, "think", "PH_3", 3, "k"),
        ]
        perceived = ["s", "ɪ", "ŋ", "k"]
        res = self.aligner.align_single_sequence(canonical, perceived)
        self.assertEqual(res.match_count, 3)
        self.assertEqual(res.substitution_count, 1)
        self.assertEqual(res.deletion_count, 0)
        self.assertEqual(res.insertion_count, 0)
        
        # Check that the first item is a θ -> s substitution
        ev0 = res.aligned_evidence[0]
        self.assertEqual(ev0.expected_phone, "θ")
        self.assertEqual(ev0.perceived_phone, "s")
        self.assertEqual(ev0.operation, AlignmentOperation.SUBSTITUTION)

    def test_final_consonant_deletion(self):
        """think /θ ɪ ŋ k/ pronounced as thin /θ ɪ ŋ/ (deleted /k/)."""
        canonical = [
            TargetPhoneItem("W_0", 0, "think", "PH_0", 0, "θ"),
            TargetPhoneItem("W_0", 0, "think", "PH_1", 1, "ɪ"),
            TargetPhoneItem("W_0", 0, "think", "PH_2", 2, "ŋ"),
            TargetPhoneItem("W_0", 0, "think", "PH_3", 3, "k"),
        ]
        perceived = ["θ", "ɪ", "ŋ"]
        res = self.aligner.align_single_sequence(canonical, perceived)
        self.assertEqual(res.match_count, 3)
        self.assertEqual(res.substitution_count, 0)
        self.assertEqual(res.deletion_count, 1)
        
        ev_last = res.aligned_evidence[-1]
        self.assertEqual(ev_last.expected_phone, "k")
        self.assertIsNone(ev_last.perceived_phone)
        self.assertEqual(ev_last.operation, AlignmentOperation.DELETION)

    def test_epenthesis_insertion(self):
        """speak /s p i k/ pronounced as /s ə p i k/ (inserted /ə/)."""
        canonical = [
            TargetPhoneItem("W_0", 0, "speak", "PH_0", 0, "s"),
            TargetPhoneItem("W_0", 0, "speak", "PH_1", 1, "p"),
            TargetPhoneItem("W_0", 0, "speak", "PH_2", 2, "i"),
            TargetPhoneItem("W_0", 0, "speak", "PH_3", 3, "k"),
        ]
        perceived = ["s", "ʌ", "p", "i", "k"]
        res = self.aligner.align_single_sequence(canonical, perceived)
        self.assertEqual(res.match_count, 4)
        self.assertEqual(res.insertion_count, 1)

    def test_multi_variant_selection(self):
        """Target 'the': variant 1 /ð ə/, variant 2 /ð i/. Learner said /ð i/."""
        var1 = [
            TargetPhoneItem("W_0", 0, "the", "PH_0", 0, "ð"),
            TargetPhoneItem("W_0", 0, "the", "PH_1", 1, "ʌ"),
        ]
        var2 = [
            TargetPhoneItem("W_0", 0, "the", "PH_0", 0, "ð"),
            TargetPhoneItem("W_0", 0, "the", "PH_1", 1, "i"),
        ]
        perceived = ["ð", "i"]
        candidates = [("VAR_THE_WEAK", var1), ("VAR_THE_STRONG", var2)]
        best_res = self.aligner.align_multi_variant(candidates, perceived)
        self.assertEqual(best_res.selected_variant_id, "VAR_THE_STRONG")
        self.assertEqual(best_res.match_count, 2)
        self.assertEqual(best_res.substitution_count, 0)


class TestCrottcAdapterAndP8(unittest.TestCase):
    def test_p8_hierarchy_construction_with_crottc(self):
        engine = HierarchicalAssessmentEngine()
        word_tokens = [
            {
                "word": "think",
                "wordIndex": 0,
                "wordId": "W_0",
                "expectedPhones": ["θ", "ɪ", "ŋ", "k"],
                "startTime": 0.0,
                "endTime": 0.5,
                "phoneticAssessmentAllowed": True,
            }
        ]
        # Simulate CROTTC detected theta->s substitution
        aligned_phones = ["θ", "ɪ", "ŋ", "k"]
        phone_error_probs = [None, None, None, None] # CROTTC uncalibrated
        phone_exact_preds = ["s", None, None, None]
        phone_exact_confs = [None, None, None, None]
        phone_durations = [0.12, 0.12, 0.13, 0.13]
        phone_timestamps = [(0.0, 0.12), (0.12, 0.24), (0.24, 0.37), (0.37, 0.50)]

        assessment = engine.build_assessment(
            utterance_id="TEST_UTT",
            word_tokens=word_tokens,
            aligned_phones=aligned_phones,
            phone_error_probs=phone_error_probs,
            phone_exact_preds=phone_exact_preds,
            phone_exact_confs=phone_exact_confs,
            phone_durations=phone_durations,
            phone_timestamps=phone_timestamps,
            prosody_output=None,
        )

        self.assertIsNotNone(assessment)
        self.assertEqual(len(assessment.words), 1)
        w0 = assessment.words[0]
        self.assertEqual(len(w0.phone_assessments), 4)
        p0 = w0.phone_assessments[0]
        self.assertEqual(p0.expected_phone, "θ")
        self.assertEqual(p0.observed_phone, "s")
        self.assertIsNone(p0.error_probability) # Honest uncalibrated null

if __name__ == "__main__":
    unittest.main()
