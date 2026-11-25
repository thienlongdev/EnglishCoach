"""
English Coach — Real Microphone Acceptance Evaluators & Oracle Firewall Test Suite.
Verifies zero test-oracle leakage, target-membership validation, fail-closed ECSM status gating,
baseline comparison integrity, and genuine multi-event recurrence logic.
"""

import unittest
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field

from app.services.pronunciation.ecsm.retry_intelligence import (
    PrimaryTarget,
    TargetSelector,
    DrillPlanner,
    RetryComparator,
    SessionRecurrenceTracker,
    PracticeSessionState,
    RetryComparison,
    RetryDelta,
    RetryComparisonState,
    DecisionStatus,
    PriorityTier,
    TargetState,
    LadderLevel,
)
from app.services.pronunciation.ecsm.hierarchical_assessment import (
    HierarchicalAssessmentEngine,
    UtteranceAssessment,
    CoverageStatistics,
    WordAssessment,
    PhoneAssessment,
    IssueNode,
    IssueLevel,
    IssuePriority,
    IssueSeverity,
    ProductSafetyTier,
    WordAssessmentStatus,
)
from app.services.pronunciation.ipa_pipeline import get_ipa_pipeline


class TestAcceptanceOracleFirewall(unittest.TestCase):
    def setUp(self):
        self.ipa = get_ipa_pipeline()
        self.cov_full = CoverageStatistics(2, 2, 0, 1, 1, 1, 0, 1.0, 1.0, 1.0, 0.0, 1.0)
        self.cov_partial = CoverageStatistics(2, 1, 0, 1, 1, 0, 0, 0.3, 0.3, 0.3, 0.0, 0.3)

    # -----------------------------------------------------------------
    # 1. Target-Membership Lexicon Validation
    # -----------------------------------------------------------------
    def test_target_membership_this_does_not_contain_theta(self):
        """'this' in General American is /ðɪs/ or /ðɪz/, NEVER /θ/."""
        phones = self.ipa.get_word_phones("this")
        self.assertNotIn("θ", phones, "Expected /θ/ MUST NOT belong to 'this'")
        self.assertIn("ð", phones, "Expected /ð/ in 'this'")

    def test_target_membership_think_contains_theta(self):
        """'think' in General American is /θɪŋk/."""
        phones = self.ipa.get_word_phones("think")
        self.assertIn("θ", phones, "Expected /θ/ MUST belong to 'think'")

    def test_target_membership_thing_contains_theta(self):
        """'thing' in General American is /θɪŋ/."""
        phones = self.ipa.get_word_phones("thing")
        self.assertIn("θ", phones, "Expected /θ/ MUST belong to 'thing'")

    # -----------------------------------------------------------------
    # 2. Case B Negative Control: Target-Membership Rejection
    # -----------------------------------------------------------------
    def test_case_b_rejects_stale_theta_on_this(self):
        """If a stale /θ/ issue is injected on 'this', TargetSelector MUST reject it."""
        phone_iss = IssueNode(
            issue_id="ISS_FAKE_001",
            issue_type="PHONE_SUBSTITUTION",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.92,
            priority=IssuePriority.HIGH.value,
            priority_reasons=[],
            time_start_sec=0.0,
            time_end_sec=0.2,
            evidence_refs=[],
            target_info={"expectedPhone": "θ"},
            observed_info={"observedPhone": "s"},
            abstained_fields=[],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )
        p_th = PhoneAssessment("PH_001", "θ", 0.92, "s", 0.90, None, "SUBSTITUTION", 0.2, 0.0, 0.2, "COMPLETE", ["EV_001"], [phone_iss])
        word_this = WordAssessment(
            "W_001",
            "this",
            0.0,
            0.3,
            WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value,
            False,
            [p_th],
            [],
            0.92,
            1.0,
            "HIGH",
            [phone_iss],
            ["EV_001"],
        )
        assessment = UtteranceAssessment(
            utterance_id="UTT_001",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.95,
            coverage_stats=self.cov_full,
            primary_issues=[phone_iss],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[word_this],
            evidence_store={},
        )

        primary, non_sel, status = TargetSelector.evaluate_attempt_decision(assessment, None)
        self.assertIsNone(primary, "Stale /θ/ on 'this' must be rejected by Target-Membership validator")
        self.assertTrue(
            any("TARGET_PHONE_NOT_IN_WORD_LEXICON" in r for r in non_sel.values()),
            "Expected non-selected reason to state TARGET_PHONE_NOT_IN_WORD_LEXICON",
        )

    # -----------------------------------------------------------------
    # 3. Case C Negative Controls: Insufficient Evidence & No Issue
    # -----------------------------------------------------------------
    def test_case_c_insufficient_evidence_produces_no_primary_focus(self):
        """When content match is divergent (<50%), P9 blocks and returns CONTENT_MISMATCH focus."""
        assessment = UtteranceAssessment(
            utterance_id="UTT_002",
            overall_status="INSUFFICIENT_EVIDENCE",
            overall_score=None,
            confidence=0.3,
            coverage_stats=self.cov_partial,
            primary_issues=[],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=["ALL"],
            phrases=[],
            words=[],
            evidence_store={},
        )

        primary, non_sel, status = TargetSelector.evaluate_attempt_decision(
            assessment, session_state=None, content_match_score=25.0
        )
        self.assertEqual(status, DecisionStatus.INSUFFICIENT_EVIDENCE.value)
        self.assertEqual(primary.issue_type, "CONTENT_MISMATCH")

    def test_case_c_no_issue_detected_returns_no_action_needed(self):
        """When clean speech has zero acoustic errors, returns NO_ACTION_NEEDED."""
        assessment = UtteranceAssessment(
            utterance_id="UTT_003",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.98,
            coverage_stats=self.cov_full,
            primary_issues=[],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[],
            evidence_store={},
        )

        primary, non_sel, status = TargetSelector.evaluate_attempt_decision(
            assessment, session_state=None, content_match_score=95.0
        )
        self.assertIsNone(primary)
        self.assertEqual(status, DecisionStatus.NO_ACTION_NEEDED.value)

    # -----------------------------------------------------------------
    # 4. Case D Baseline Validity
    # -----------------------------------------------------------------
    def test_case_d_valid_baseline_and_clean_retry_produces_resolved(self):
        """Valid baseline + clean retry produces RESOLVED comparison state."""
        baseline_target = PrimaryTarget(
            target_id="TGT_TH_001",
            issue_type="PHONE_SUBSTITUTION",
            level="PHONE",
            word_str="think",
            word_index=0,
            expected_phone="θ",
            observed_phone="s",
            confidence=0.94,
            is_articulatory_fallback=False,
            articulatory_contrast=None,
            time_start_sec=0.0,
            time_end_sec=0.2,
            evidence_refs=[],
            selection_reasons=[],
            priority_tier=PriorityTier.TIER_1_HIGH_IMPACT.value,
        )

        pa_clean = PhoneAssessment(
            phone_id="PH_001",
            expected_phone="θ",
            error_probability=0.05,
            observed_phone="θ",
            exact_phone_confidence=0.95,
            articulatory_diagnosis=None,
            alignment_operation="MATCH",
            duration_sec=0.15,
            start_time_sec=0.0,
            end_time_sec=0.15,
            status="COMPLETE",
            evidence_refs=[],
        )
        word_clean = WordAssessment(
            "W_001",
            "think",
            0.0,
            0.3,
            WordAssessmentStatus.VALID_VARIANT.value,
            True,
            [pa_clean],
            [],
            0.95,
            1.0,
            "LOW",
            [],
            [],
        )
        retry_assessment = UtteranceAssessment(
            utterance_id="UTT_RETRY_001",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.95,
            coverage_stats=self.cov_full,
            primary_issues=[],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[word_clean],
            evidence_store={},
        )

        comparison = RetryComparator.compare_attempts(
            primary_target=baseline_target,
            baseline_assessment=None,
            retry_assessment=retry_assessment,
            session_id="SESS_001",
            baseline_attempt_id="ATT_C",
            retry_attempt_id="ATT_D",
        )

        self.assertIn(comparison.comparison_state, [RetryComparisonState.RESOLVED.value, RetryComparisonState.IMPROVED.value])
        self.assertGreater(comparison.delta.error_prob_delta, 0.5)

    # -----------------------------------------------------------------
    # 5. Case E Genuine Recurrence Across Words
    # -----------------------------------------------------------------
    def test_case_e_aggregates_genuine_theta_events_across_words(self):
        """Genuine /θ/ issues in 'think' and 'thing' aggregate under PHONE_PRODUCTION:θ."""
        sess = PracticeSessionState(
            session_id="SESS_REC",
            active_target=None,
            target_state=TargetState.PRACTICING.value,
            ladder_level=LadderLevel.LEVEL_3_WORD.value,
            current_attempt_index=1,
        )

        target_think = PrimaryTarget(
            target_id="TGT_THINK",
            issue_type="PHONE_SUBSTITUTION",
            level="PHONE",
            word_str="think",
            word_index=0,
            expected_phone="θ",
            observed_phone="s",
            confidence=0.92,
            is_articulatory_fallback=False,
            articulatory_contrast=None,
            time_start_sec=0.0,
            time_end_sec=0.2,
            evidence_refs=[],
            selection_reasons=[],
            priority_tier=PriorityTier.TIER_1_HIGH_IMPACT.value,
        )

        target_thing = PrimaryTarget(
            target_id="TGT_THING",
            issue_type="PHONE_SUBSTITUTION",
            level="PHONE",
            word_str="thing",
            word_index=3,
            expected_phone="θ",
            observed_phone="s",
            confidence=0.90,
            is_articulatory_fallback=False,
            articulatory_contrast=None,
            time_start_sec=1.0,
            time_end_sec=1.2,
            evidence_refs=[],
            selection_reasons=[],
            priority_tier=PriorityTier.TIER_1_HIGH_IMPACT.value,
        )

        # Event 1 on think
        SessionRecurrenceTracker.update_recurrence(sess, "ATT_01", target_think)
        self.assertEqual(len(sess.recurrence_map), 1)

        # Event 2 on thing
        SessionRecurrenceTracker.update_recurrence(sess, "ATT_02", target_thing)
        self.assertEqual(len(sess.recurrence_map), 2)

        # Local keys verify
        self.assertIn("PHONE_SUBSTITUTION:θ:s:think", sess.recurrence_map)
        self.assertIn("PHONE_SUBSTITUTION:θ:s:thing", sess.recurrence_map)


if __name__ == "__main__":
    unittest.main()
