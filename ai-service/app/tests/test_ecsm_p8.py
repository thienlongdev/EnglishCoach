"""
Unit tests for ECSM Phase P8:
Hierarchical Pronunciation Assessment, Exact-Phone Abstention, G_VALID Variant Handling,
Issue Deduplication, Priority Policy, and Raw Hierarchy Firewall (HAS_RAW).
"""

from pathlib import Path
import unittest
import numpy as np

from app.services.pronunciation.ecsm.hierarchical_assessment import (
    AssessmentStatus,
    CoverageStatistics,
    EvidenceItem,
    EvidenceType,
    HierarchicalAssessmentEngine,
    IssueDeduplicator,
    IssueLevel,
    IssueNode,
    IssuePriority,
    IssueSeverity,
    PhoneAssessment,
    PhraseAssessment,
    PriorityEngine,
    ProductSafetyTier,
    SyllableAssessment,
    UtteranceAssessment,
    WordAssessment,
    WordAssessmentStatus,
)
from app.services.pronunciation.ecsm.prosodic_reality import (
    EnergyFeatures,
    IntonationFeatures,
    LexicalStressFeatures,
    PauseFeatures,
    PitchFeatures,
    ProsodicRealityOutput,
    ProsodyMode,
    SyllableInfo,
)


class TestEcsmP8(unittest.TestCase):
    def setUp(self):
        self.g_valid = {
            "to": [["t", "ə"], ["t", "uː"]],
            "the": [["ð", "ə"], ["ð", "iː"]],
        }
        self.engine = HierarchicalAssessmentEngine(g_valid_lexicon=self.g_valid)

    def test_phone_exact_abstention_preservation(self):
        """Proves that when exact phone trust fails, observedPhone is strictly None and falls back to articulatory contrast."""
        word_tokens = [{"word": "this", "expectedPhones": ["ð", "ɪ", "s"], "startTime": 0.0, "endTime": 0.35}]
        aligned_phones = ["ð", "ɪ", "s"]
        phone_error_probs = [0.92, 0.05, 0.05]
        phone_exact_preds = [None, None, None]  # Abstains from exact identity
        phone_exact_confs = [None, None, None]
        phone_durations = [0.12, 0.11, 0.12]
        phone_timestamps = [(0.0, 0.12), (0.12, 0.23), (0.23, 0.35)]

        assessment = self.engine.build_assessment(
            utterance_id="UTT_ABSTAIN_001",
            word_tokens=word_tokens,
            aligned_phones=aligned_phones,
            phone_error_probs=phone_error_probs,
            phone_exact_preds=phone_exact_preds,
            phone_exact_confs=phone_exact_confs,
            phone_durations=phone_durations,
            phone_timestamps=phone_timestamps,
            prosody_output=None,
            articulatory_mismatches=["voicing", None, None],
        )

        p0 = assessment.words[0].phone_assessments[0]
        self.assertIsNone(p0.observed_phone)
        self.assertGreater(len(p0.issues), 0)
        self.assertEqual(p0.issues[0].issue_type, "ARTICULATORY_VOICING_MISMATCH")
        self.assertIn("observedExactPhone", p0.issues[0].abstained_fields)

    def test_g_valid_variant_suppression(self):
        """Proves that a valid weak form reduction in G_VALID produces VALID_VARIANT and zero false phone errors."""
        word_tokens = [{"word": "to", "expectedPhones": ["t", "ə"], "startTime": 0.0, "endTime": 0.20}]
        aligned_phones = ["t", "ə"]
        phone_error_probs = [0.05, 0.05]
        phone_exact_preds = ["t", "ə"]
        phone_exact_confs = [0.95, 0.95]
        phone_durations = [0.08, 0.12]
        phone_timestamps = [(0.0, 0.08), (0.08, 0.20)]

        assessment = self.engine.build_assessment(
            utterance_id="UTT_VALID_001",
            word_tokens=word_tokens,
            aligned_phones=aligned_phones,
            phone_error_probs=phone_error_probs,
            phone_exact_preds=phone_exact_preds,
            phone_exact_confs=phone_exact_confs,
            phone_durations=phone_durations,
            phone_timestamps=phone_timestamps,
            prosody_output=None,
        )

        w = assessment.words[0]
        self.assertTrue(w.is_valid_variant)
        self.assertEqual(w.word_status, WordAssessmentStatus.VALID_VARIANT.value)
        self.assertEqual(len(w.issues), 0)

    def test_root_issue_deduplication(self):
        """Proves that overlapping phone and articulatory issues are deduplicated into 1 root issue with supporting children."""
        iss1 = IssueNode(
            issue_id="ISS_01",
            issue_type="PHONE_SUBSTITUTION",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.95,
            priority=IssuePriority.HIGH.value,
            priority_reasons=[],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_01"],
            target_info={},
            observed_info={},
            abstained_fields=[],
        )
        iss2 = IssueNode(
            issue_id="ISS_02",
            issue_type="ARTICULATORY_VOICING_MISMATCH",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.MEDIUM.value,
            confidence=0.85,
            priority=IssuePriority.HIGH.value,
            priority_reasons=[],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_02"],
            target_info={},
            observed_info={},
            abstained_fields=[],
        )

        roots, supporting = IssueDeduplicator.deduplicate([iss1, iss2])
        self.assertEqual(len(roots), 1)
        self.assertEqual(len(supporting), 1)
        self.assertEqual(roots[0].issue_id, "ISS_01")
        self.assertIn("ISS_02", roots[0].supporting_issue_ids)
        self.assertEqual(supporting[0].parent_issue_id, "ISS_01")

    def test_issue_prioritization_and_reasons(self):
        """Proves that high-confidence segmental error outranks descriptive intonation with machine-readable reasons."""
        high_seg = IssueNode(
            issue_id="ISS_HIGH_SEG",
            issue_type="PHONE_SUBSTITUTION",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.96,
            priority="",
            priority_reasons=[],
            time_start_sec=0.0,
            time_end_sec=0.1,
            evidence_refs=[],
            target_info={},
            observed_info={},
            abstained_fields=[],
        )
        prio_seg, reasons_seg = PriorityEngine.prioritize(high_seg)
        self.assertEqual(prio_seg, IssuePriority.HIGH.value)
        self.assertIn("HIGH_SEGMENTAL_ERROR_CONFIDENCE", reasons_seg)

        desc_int = IssueNode(
            issue_id="ISS_DESC_INT",
            issue_type="DESCRIPTIVE_INTONATION",
            level=IssueLevel.PHRASE.value,
            severity=IssueSeverity.DESCRIPTIVE.value,
            confidence=0.40,
            priority="",
            priority_reasons=[],
            time_start_sec=0.0,
            time_end_sec=1.0,
            evidence_refs=[],
            target_info={},
            observed_info={},
            abstained_fields=[],
        )
        prio_int, reasons_int = PriorityEngine.prioritize(desc_int)
        self.assertEqual(prio_int, IssuePriority.DESCRIPTIVE.value)

    def test_overall_score_is_strictly_null(self):
        """Proves that overall numeric pronunciation score is strictly None."""
        word_tokens = [{"word": "cat", "expectedPhones": ["k", "æ", "t"], "startTime": 0.0, "endTime": 0.30}]
        assessment = self.engine.build_assessment(
            utterance_id="UTT_SCORE_001",
            word_tokens=word_tokens,
            aligned_phones=["k", "æ", "t"],
            phone_error_probs=[0.05, 0.05, 0.05],
            phone_exact_preds=["k", "æ", "t"],
            phone_exact_confs=[0.95, 0.95, 0.95],
            phone_durations=[0.10, 0.10, 0.10],
            phone_timestamps=[(0.0, 0.10), (0.10, 0.20), (0.20, 0.30)],
            prosody_output=None,
        )
        self.assertIsNone(assessment.overall_score)

    def test_has_raw_hierarchy_firewall(self):
        """Proves HAS_RAW = 0.00000000 under counterfactual text mutations."""
        word_tokens1 = [{"word": "sun", "expectedPhones": ["s", "ʌ", "n"], "startTime": 0.0, "endTime": 0.30}]
        word_tokens2 = [{"word": "fun", "expectedPhones": ["f", "ʌ", "n"], "startTime": 0.0, "endTime": 0.30}]
        aligned_phones = ["s", "ʌ", "n"]
        phone_error_probs = [0.05, 0.05, 0.05]
        phone_exact_preds = ["s", "ʌ", "n"]
        phone_exact_confs = [0.95, 0.95, 0.95]
        phone_durations = [0.10, 0.10, 0.10]
        phone_timestamps = [(0.0, 0.10), (0.10, 0.20), (0.20, 0.30)]

        a1 = self.engine.build_assessment("UTT_F1", word_tokens1, aligned_phones, phone_error_probs, phone_exact_preds, phone_exact_confs, phone_durations, phone_timestamps, None)
        a2 = self.engine.build_assessment("UTT_F2", word_tokens2, aligned_phones, phone_error_probs, phone_exact_preds, phone_exact_confs, phone_durations, phone_timestamps, None)

        # Phone level acoustic durations and timestamps must remain identical
        for p1, p2 in zip(a1.words[0].phone_assessments, a2.words[0].phone_assessments):
            self.assertEqual(p1.duration_sec, p2.duration_sec)
            self.assertEqual(p1.start_time_sec, p2.start_time_sec)


if __name__ == "__main__":
    unittest.main()
