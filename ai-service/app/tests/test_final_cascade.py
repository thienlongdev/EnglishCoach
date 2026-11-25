"""
Unit tests for Final Pronunciation Engine Cascade:
MDD-LLM Primary Detector + Selective CROTTC-IF Exact-Phone Diagnosis (Policy C)
Tests production classes directly from app.services.pronunciation.ecsm.cascade_resolver.
"""

import unittest
from typing import Optional, List, Dict, Set, Any

from app.services.pronunciation.ecsm.cascade_resolver import (
    PronunciationCascadeResolver,
    CascadeResolutionResult,
    CascadePhoneResult,
    POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC,
)
from app.services.pronunciation.ecsm.mdd_primary_detector import MddDetectionResult
from app.services.pronunciation.ecsm.crottc_diagnosis_specialist import (
    CrottcDiagnosisSpecialist,
    CrottcDiagnosisResult,
)
from app.services.pronunciation.ecsm.mdd_sequence_alignment import (
    SequenceAlignmentResult,
    AlignedPhoneEvidence,
    AlignmentOperation,
)


def _build_mdd_result(
    is_clean: bool,
    detected_phone_ids: List[str],
    localized_words: List[str],
    candidate_substitutions: Dict[str, Optional[str]],
    perceived_ipa: List[str],
) -> MddDetectionResult:
    return MddDetectionResult(
        request_id="REQ_TEST",
        attempt_id="ATT_TEST",
        case_id="CASE_TEST",
        engine="MDD_LLM",
        model_revision="Haopeng/MDD-LLM-Llama3.2-1B-L2-ARCTIC",
        checkpoint_sha256="dfb2ed5be483bef0207dd41542a6ca0256be2dcadf534ccde1c3772f0859ce11",
        device="cuda:0",
        audio_sha256="dummy_sha",
        audio_duration_sec=1.5,
        perceived_labels=perceived_ipa,
        perceived_ipa=perceived_ipa,
        perceived_text=" ".join(perceived_ipa),
        generated_tokens=[],
        is_clean=is_clean,
        detected_phone_ids=set(detected_phone_ids),
        localized_words=localized_words,
        alignment_result=SequenceAlignmentResult(
            canonical_phones=perceived_ipa,
            perceived_phones=perceived_ipa,
            total_cost=float(len(detected_phone_ids)),
            match_count=0 if not is_clean else 1,
            substitution_count=len(detected_phone_ids),
            deletion_count=0,
            insertion_count=0,
            aligned_evidence=[],
        ),
        aligned_evidence_by_phone_id={},
        mdd_candidate_by_phone_id=candidate_substitutions,
        inference_ms=150.0,
        vram_allocated_mb=4800.0,
        warnings=[],
    )


def _build_crottc_result(
    crottc_called: bool,
    candidate_substitutions: Dict[str, Optional[str]],
    evidence_scores: Dict[str, float],
    perceived_ipa: List[str],
) -> CrottcDiagnosisResult:
    return CrottcDiagnosisResult(
        request_id="REQ_TEST",
        attempt_id="ATT_TEST",
        case_id="CASE_TEST",
        engine="CROTTC_IF",
        model_revision="9149e5107b3332b9aa3f5573f6328a4e312006ad",
        checkpoint_sha256="3a9a4a03d2af6c90f71db8972a51dd4ce4559d1e9801f078904a65ce4aa113ef",
        device="cuda:0",
        audio_sha256="dummy_sha",
        crottc_called=crottc_called,
        perceived_labels=perceived_ipa,
        perceived_ipa=perceived_ipa,
        perceived_text=" ".join(perceived_ipa),
        alignment_result=None,
        aligned_evidence_by_phone_id={},
        crottc_candidate_by_phone_id=candidate_substitutions,
        crottc_evidence_score_by_phone_id=evidence_scores,
        inference_ms=80.0 if crottc_called else 0.0,
        vram_allocated_mb=4800.0,
        warnings=[],
    )


class TestFinalCascadeProduction(unittest.TestCase):

    def setUp(self):
        self.resolver = PronunciationCascadeResolver()

    def test_mdd_clean_blocks_crottc_error_creation(self):
        """Hard Authority Invariant: If MDD-LLM classifies clean, CROTTC cannot create an error."""
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "θ", "word_id": "W_0", "word_index": 0, "target_word": "think", "phone_index_within_word": 0}
        ]
        
        # MDD says clean
        mdd_res = _build_mdd_result(
            is_clean=True,
            detected_phone_ids=[],
            localized_words=[],
            candidate_substitutions={"PH_001": None},
            perceived_ipa=["θ"],
        )
        
        # CROTTC not called
        crottc_res = _build_crottc_result(
            crottc_called=False,
            candidate_substitutions={},
            evidence_scores={},
            perceived_ipa=[],
        )
        
        res = self.resolver.resolve(mdd_res, crottc_res, target_phones)
        self.assertEqual(res.primary_detection_decision, "CLEAN")
        self.assertEqual(res.final_selected_phone_ids, [])
        self.assertEqual(res.phone_results[0].observed_phone, None)
        self.assertFalse(res.phone_results[0].is_error_final)
        self.assertEqual(res.phone_results[0].diagnosis_source, "CLEAN")

    def test_mdd_crottc_agreement(self):
        """Agreement between MDD-LLM and CROTTC yields highest trust diagnosis."""
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "θ", "word_id": "W_0", "word_index": 0, "target_word": "think", "phone_index_within_word": 0}
        ]
        
        mdd_res = _build_mdd_result(
            is_clean=False,
            detected_phone_ids=["PH_001"],
            localized_words=["think"],
            candidate_substitutions={"PH_001": "s"},
            perceived_ipa=["s"],
        )
        crottc_res = _build_crottc_result(
            crottc_called=True,
            candidate_substitutions={"PH_001": "s"},
            evidence_scores={"PH_001": 0.92},
            perceived_ipa=["s"],
        )
        
        res = self.resolver.resolve(mdd_res, crottc_res, target_phones)
        self.assertEqual(res.primary_detection_decision, "ERROR")
        self.assertEqual(res.final_selected_phone_ids, ["PH_001"])
        p_res = res.phone_results[0]
        self.assertTrue(p_res.is_error_final)
        self.assertEqual(p_res.observed_phone, "s")
        self.assertTrue(p_res.observed_phone_trusted)
        self.assertEqual(p_res.diagnosis_source, "AGREEMENT")

    def test_mdd_crottc_disagreement_with_strong_crottc_evidence(self):
        """Under disagreement, strong CROTTC acoustic evidence (>=0.80) is trusted for phonetic detail."""
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "θ", "word_id": "W_0", "word_index": 0, "target_word": "think", "phone_index_within_word": 0}
        ]
        
        mdd_res = _build_mdd_result(
            is_clean=False,
            detected_phone_ids=["PH_001"],
            localized_words=["think"],
            candidate_substitutions={"PH_001": "t"},
            perceived_ipa=["t"],
        )
        crottc_res = _build_crottc_result(
            crottc_called=True,
            candidate_substitutions={"PH_001": "s"},
            evidence_scores={"PH_001": 0.85},
            perceived_ipa=["s"],
        )
        
        res = self.resolver.resolve(mdd_res, crottc_res, target_phones)
        self.assertEqual(res.final_selected_phone_ids, ["PH_001"])
        p_res = res.phone_results[0]
        self.assertTrue(p_res.is_error_final)
        self.assertEqual(p_res.observed_phone, "s")
        self.assertTrue(p_res.observed_phone_trusted)
        self.assertEqual(p_res.diagnosis_source, "CROTTC_IF")

    def test_crottc_uncertain_yields_null_observed_phone_selective_abstention(self):
        """Low acoustic certainty under disagreement results in selective abstention (observed_phone = None)."""
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "æ", "word_id": "W_0", "word_index": 0, "target_word": "cat", "phone_index_within_word": 1}
        ]
        
        mdd_res = _build_mdd_result(
            is_clean=False,
            detected_phone_ids=["PH_001"],
            localized_words=["cat"],
            candidate_substitutions={"PH_001": None},
            perceived_ipa=["k", "ʌ", "t"],
        )
        crottc_res = _build_crottc_result(
            crottc_called=True,
            candidate_substitutions={"PH_001": "ɛ"},
            evidence_scores={"PH_001": 0.55}, # low score < 0.80
            perceived_ipa=["k", "ɛ", "t"],
        )
        
        res = self.resolver.resolve(mdd_res, crottc_res, target_phones)
        self.assertEqual(res.final_selected_phone_ids, ["PH_001"])
        p_res = res.phone_results[0]
        self.assertTrue(p_res.is_error_final)
        self.assertIsNone(p_res.observed_phone)
        self.assertFalse(p_res.observed_phone_trusted)
        self.assertEqual(p_res.diagnosis_source, "ABSTAINED")

    def test_crottc_cannot_create_extra_p8_nodes(self):
        """Hard invariant: CROTTC can NEVER diagnose a phone that was not detected as an error by MDD-LLM."""
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "ð", "word_id": "W_0", "word_index": 0, "target_word": "this", "phone_index_within_word": 0},
            {"phone_id": "PH_002", "expected_phone": "ɪ", "word_id": "W_0", "word_index": 0, "target_word": "this", "phone_index_within_word": 1},
            {"phone_id": "PH_003", "expected_phone": "s", "word_id": "W_0", "word_index": 0, "target_word": "this", "phone_index_within_word": 2},
        ]
        
        # MDD only detected PH_003
        mdd_res = _build_mdd_result(
            is_clean=False,
            detected_phone_ids=["PH_003"],
            localized_words=["this"],
            candidate_substitutions={"PH_001": None, "PH_002": None, "PH_003": "ʃ"},
            perceived_ipa=["ð", "ɪ", "ʃ"],
        )
        
        # CROTTC tries to diagnose PH_001, PH_002, and PH_003
        crottc_res = _build_crottc_result(
            crottc_called=True,
            candidate_substitutions={"PH_001": "d", "PH_002": "i", "PH_003": "ʃ"},
            evidence_scores={"PH_001": 0.99, "PH_002": 0.95, "PH_003": 0.90},
            perceived_ipa=["d", "i", "ʃ"],
        )
        
        res = self.resolver.resolve(mdd_res, crottc_res, target_phones)
        # Invariant check: final_selected_phone_ids must be subset of mdd_detected_phone_ids
        self.assertEqual(res.final_selected_phone_ids, ["PH_003"])
        self.assertFalse(res.phone_results_by_id["PH_001"].is_error_final)
        self.assertFalse(res.phone_results_by_id["PH_002"].is_error_final)
        self.assertTrue(res.phone_results_by_id["PH_003"].is_error_final)

    def test_single_phone_clean_bypass(self):
        """When MDD finds no errors, diagnosis specialist is completely bypassed."""
        specialist = CrottcDiagnosisSpecialist()
        
        target_phones = [
            {"phone_id": "PH_001", "expected_phone": "ð", "word_id": "W_0", "word_index": 0, "target_word": "the", "phone_index_within_word": 0},
            {"phone_id": "PH_002", "expected_phone": "ə", "word_id": "W_0", "word_index": 0, "target_word": "the", "phone_index_within_word": 1},
        ]
        
        # Run specialist diagnose with empty detected_phone_ids
        diag_res = specialist.diagnose(
            audio_bytes=b"dummy",
            filename="test.wav",
            target_words=[{"word": "the", "expectedPhones": ["ð", "ə"]}],
            target_phones=target_phones,
            mdd_detected_phone_ids=set(),
        )
        self.assertFalse(diag_res.crottc_called)
        self.assertEqual(diag_res.crottc_candidate_by_phone_id, {})


if __name__ == "__main__":
    unittest.main()
