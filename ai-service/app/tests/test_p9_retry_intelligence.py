"""
Unit tests for ECSM-v1 / EC-PRISM Phase P9: Retry Intelligence & Actionable Pronunciation Coaching.

Validates all 16 core requirements:
1. Content blocking (Tier 0)
2. Partial content filtering
3. Exact-phone safety (null observed phone)
4. Minimal pair contrast drill
5. Single primary focus selection (ONE RETRY = ONE FOCUS)
6. Correlated issue deduplication
7. Deterministic tie-breaking
8. 5-level adaptive retry ladder
9. Retry comparison: RESOLVED
10. Retry comparison: IMPROVED
11. Retry comparison: UNCHANGED
12. Retry comparison: UNCERTAIN on bad audio / fail-closed
13. Session recurrence lifecycle
14. Duplicate attempt ID protection
15. Learner fatigue protection (deferral after max retries)
16. Speaking Profile weakness bridge gating (>= 2 occurrences required)
"""

import unittest
from typing import List

from app.services.pronunciation.ecsm.hierarchical_assessment import (
    CoverageStatistics,
    IssueLevel,
    IssueNode,
    IssuePriority,
    IssueSeverity,
    PhoneAssessment,
    ProductSafetyTier,
    UtteranceAssessment,
    WordAssessment,
    WordAssessmentStatus,
)
from app.services.pronunciation.ecsm.retry_intelligence import (
    DecisionStatus,
    DrillPlanner,
    DrillType,
    LadderLevel,
    PracticeSessionState,
    PrimaryTarget,
    PriorityTier,
    RetryComparator,
    RetryComparison,
    RetryComparisonState,
    SessionRecurrenceTracker,
    SessionStateMachine,
    TargetSelector,
    TargetState,
    WeaknessLifecycle,
)


class TestP9RetryIntelligence(unittest.TestCase):

    def setUp(self):
        # Issue 1: High confidence /θ/ -> /s/ in "think" (0.20s - 0.32s)
        self.iss_th = IssueNode(
            issue_id="ISS_TH_001",
            issue_type="PHONE_SUBSTITUTION",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.94,
            priority=IssuePriority.HIGH.value,
            priority_reasons=["HIGH_SEGMENTAL_CONFIDENCE"],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_001"],
            target_info={"expectedPhone": "θ"},
            observed_info={"observedPhone": "s", "exactPhoneConfidence": 0.92},
            abstained_fields=[],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )

        # Issue 2: Correlated articulatory diagnosis on same /θ/ interval
        self.iss_th_art = IssueNode(
            issue_id="ISS_TH_ART_001",
            issue_type="ARTICULATORY_DENTAL_MISMATCH",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.MEDIUM.value,
            confidence=0.85,
            priority=IssuePriority.MEDIUM.value,
            priority_reasons=["DENTAL_FRICTION_MISMATCH"],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_002"],
            target_info={"expectedPhone": "θ"},
            observed_info={"articulatoryDiagnosis": "θ"},
            abstained_fields=["observedExactPhone"],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )

        # Issue 3: Lexical stress mismatch on "machine" (0.80s - 1.25s)
        self.iss_stress = IssueNode(
            issue_id="ISS_STR_001",
            issue_type="LEXICAL_STRESS_MISMATCH",
            level=IssueLevel.SYLLABLE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.89,
            priority=IssuePriority.HIGH.value,
            priority_reasons=["STRESS_INDEX_MISMATCH"],
            time_start_sec=0.80,
            time_end_sec=1.25,
            evidence_refs=["EV_003"],
            target_info={"expectedStressIndex": 1},
            observed_info={"observedStressIndex": 0},
            abstained_fields=[],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )

        # Issue 4: Uncalibrated rhythm statistic (research only)
        self.iss_rhythm = IssueNode(
            issue_id="ISS_RHY_001",
            issue_type="UNCALIBRATED_RHYTHM_STATISTIC",
            level=IssueLevel.UTTERANCE.value,
            severity=IssueSeverity.LOW.value,
            confidence=0.99,
            priority=IssuePriority.LOW.value,
            priority_reasons=[],
            time_start_sec=0.0,
            time_end_sec=2.0,
            evidence_refs=["EV_004"],
            target_info={},
            observed_info={},
            abstained_fields=[],
            safety_tier=ProductSafetyTier.RESEARCH_ONLY.value,
        )

        self.p_th = PhoneAssessment("PH_001", "θ", 0.94, "s", 0.92, None, "SUBSTITUTION", 0.12, 0.20, 0.32, "COMPLETE", ["EV_001"], [self.iss_th, self.iss_th_art])
        self.w_think = WordAssessment("W_001", "think", 0.20, 0.65, WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value, False, [self.p_th], [], 0.92, 1.0, "HIGH", [self.iss_th, self.iss_th_art], ["EV_001"])
        self.w_machine = WordAssessment("W_002", "machine", 0.80, 1.30, WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value, False, [], [], 0.89, 1.0, "HIGH", [self.iss_stress], ["EV_003"])

        self.mock_p8 = UtteranceAssessment(
            utterance_id="UTT_001",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.94,
            coverage_stats=CoverageStatistics(2, 2, 0, 1, 1, 1, 0, 1.0, 0.5, 1.0, 0.0, 1.0),
            primary_issues=[self.iss_th, self.iss_stress],
            secondary_issues=[self.iss_th_art, self.iss_rhythm],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[self.w_think, self.w_machine],
            evidence_store={},
        )

    def test_content_blocking_tier_0(self):
        """1. When content match is 18%, P9 blocks phonetic coaching and outputs CONTENT_RETRY."""
        target, non_sel, status = TargetSelector.evaluate_attempt_decision(
            self.mock_p8, None, content_match_score=18.0
        )
        self.assertEqual(status, DecisionStatus.INSUFFICIENT_EVIDENCE.value)
        self.assertIsNotNone(target)
        self.assertEqual(target.issue_type, "CONTENT_MISMATCH")
        self.assertEqual(target.priority_tier, PriorityTier.TIER_0_BLOCKING.value)

        plan = DrillPlanner.plan_drill(target, None, "SESS_1", "ATT_1", "This morning a machine screamed.")
        self.assertEqual(plan.drill_type, DrillType.CONTENT_RETRY.value)
        self.assertTrue(plan.reference_required)
        self.assertIn("Nội dung", plan.articulatory_instructions_vi)

    def test_partial_content_filtering(self):
        """2. When content match is 65%, only issues on recognized words are eligible."""
        # Learner only said "machine", omitted "think"
        target, non_sel, status = TargetSelector.evaluate_attempt_decision(
            self.mock_p8, None, content_match_score=65.0, recognized_words=["machine"]
        )
        self.assertEqual(status, DecisionStatus.PARTIAL_EVIDENCE.value)
        self.assertIsNotNone(target)
        self.assertEqual(target.word_str, "machine")
        self.assertEqual(target.issue_type, "LEXICAL_STRESS_MISMATCH")
        self.assertIn("ISS_TH_001", non_sel)
        self.assertEqual(non_sel["ISS_TH_001"], "WORD_UNALIGNED_IN_PARTIAL_CONTENT")

    def test_exact_phone_safety_null_observed(self):
        """3. When observed_phone is None, P9 coaches target sound placement without fabricating substitution."""
        iss_null_obs = IssueNode(
            issue_id="ISS_NULL_001",
            issue_type="ARTICULATORY_DENTAL_MISMATCH",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.88,
            priority=IssuePriority.HIGH.value,
            priority_reasons=[],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_005"],
            target_info={"expectedPhone": "θ"},
            observed_info={"articulatoryDiagnosis": "θ"},
            abstained_fields=["observedExactPhone"],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )
        p8_null = UtteranceAssessment(
            utterance_id="UTT_002",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.88,
            coverage_stats=CoverageStatistics(1, 1, 0, 1, 1, 1, 0, 1.0, 1.0, 1.0, 0.0, 1.0),
            primary_issues=[iss_null_obs],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[self.w_think],
            evidence_store={},
        )
        target, non_sel, status = TargetSelector.evaluate_attempt_decision(p8_null, None)
        self.assertIsNotNone(target)
        self.assertIsNone(target.observed_phone)
        self.assertTrue(target.is_articulatory_fallback)

        plan = DrillPlanner.plan_drill(target, None, "SESS_1", "ATT_1", "I think so.")
        self.assertIsNone(plan.minimal_pair)
        self.assertEqual(plan.drill_type, DrillType.ARTICULATORY_PLACEMENT.value)
        self.assertIn("lưỡi", plan.articulatory_instructions_vi)

    def test_contrast_drill_trusted_observed(self):
        """4. When observed_phone is trusted and present in minimal pair registry, P9 offers contrast drill."""
        target, non_sel, status = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        self.assertEqual(target.expected_phone, "θ")
        self.assertEqual(target.observed_phone, "s")

        # In Level 2 CONTRAST, drill type is MINIMAL_PAIR_CONTRAST
        session = PracticeSessionState(
            session_id="S_1",
            active_target=target,
            target_state=TargetState.PRACTICING.value,
            ladder_level=LadderLevel.LEVEL_2_CONTRAST.value,
            current_attempt_index=1,
        )
        plan = DrillPlanner.plan_drill(target, session, "S_1", "A_1", "I think so.")
        self.assertIsNotNone(plan.minimal_pair)
        self.assertEqual(plan.minimal_pair, ("think", "sink"))
        self.assertEqual(plan.drill_type, DrillType.MINIMAL_PAIR_CONTRAST.value)
        self.assertEqual(plan.practice_text, "think vs sink")

    def test_single_focus_selection_and_deduplication(self):
        """5 & 6. Selects ONE primary focus, deduplicates correlated signals, rejects research only."""
        target, non_sel, status = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        self.assertIsNotNone(target)
        # Exactly one winner
        self.assertEqual(target.target_id, "TGT_ISS_TH_001")
        # Research only rejected
        self.assertEqual(non_sel["ISS_RHY_001"], "RESEARCH_ONLY_OR_UNAVAILABLE")
        # Correlated articulatory diagnosis on same phone deduplicated
        self.assertEqual(non_sel["ISS_TH_ART_001"], "CORRELATED_SUBORDINATE_SIGNAL_DEDUPLICATED")
        # Lower priority runner-up rejected
        self.assertEqual(non_sel["ISS_STR_001"], "LOWER_PEDAGOGICAL_PRIORITY_THAN_PRIMARY_TARGET")

    def test_deterministic_tie_breaking(self):
        """7. Deterministic tie breaking produces identical results over 100 runs."""
        results = [
            TargetSelector.evaluate_attempt_decision(self.mock_p8, None)[0].target_id
            for _ in range(100)
        ]
        self.assertTrue(all(r == "TGT_ISS_TH_001" for r in results))

    def test_5_level_ladder_initialization(self):
        """8. Initializes 5 ladder steps with Vietnamese instructions."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        plan = DrillPlanner.plan_drill(target, None, "S_1", "A_1", "I think so.")
        self.assertEqual(len(plan.ladder_steps), 5)
        self.assertEqual(plan.ladder_steps[0].level, LadderLevel.LEVEL_1_SOUND.value)
        self.assertEqual(plan.ladder_steps[1].level, LadderLevel.LEVEL_2_CONTRAST.value)
        self.assertEqual(plan.ladder_steps[2].level, LadderLevel.LEVEL_3_WORD.value)
        self.assertEqual(plan.ladder_steps[3].level, LadderLevel.LEVEL_4_PHRASE.value)
        self.assertEqual(plan.ladder_steps[4].level, LadderLevel.LEVEL_5_SENTENCE.value)
        self.assertIn("Khẩu hình", plan.ladder_steps[0].title_vi)

    def test_retry_comparison_resolved_and_improved(self):
        """9 & 10. Validates RESOLVED and IMPROVED before/after transitions."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)

        # Baseline: think with /s/
        # Retry 1: error clears to 0.40 -> IMPROVED
        retry_p_improved = PhoneAssessment("PH_002", "θ", 0.40, "θ", 0.70, None, "CORRECT", 0.12, 0.20, 0.32, "COMPLETE", [], [])
        retry_w_improved = WordAssessment("W_002", "think", 0.20, 0.65, WordAssessmentStatus.NO_ISSUE_DETECTED.value, False, [retry_p_improved], [], 0.85, 1.0, "LOW", [], [])
        retry_p8_improved = UtteranceAssessment("UTT_002", "COMPLETE", None, 0.85, CoverageStatistics(1, 1, 0, 1, 1, 1, 0, 1.0, 1.0, 1.0, 0.0, 1.0), [], [], [], [], [], [retry_w_improved], {})

        comp_improved = RetryComparator.compare_attempts(target, self.mock_p8, retry_p8_improved, "S_1", "A_1", "A_2")
        self.assertEqual(comp_improved.comparison_state, RetryComparisonState.IMPROVED.value)
        self.assertIn("Tiến bộ", comp_improved.message_vi)

        # Retry 2: error clears to 0.10 with previous state IMPROVED_ONCE -> RESOLVED
        session_improved = PracticeSessionState("S_1", target, TargetState.IMPROVED_ONCE.value, LadderLevel.LEVEL_4_PHRASE.value, 2)
        retry_p_resolved = PhoneAssessment("PH_003", "θ", 0.10, "θ", 0.95, None, "CORRECT", 0.12, 0.20, 0.32, "COMPLETE", [], [])
        retry_w_resolved = WordAssessment("W_003", "think", 0.20, 0.65, WordAssessmentStatus.NO_ISSUE_DETECTED.value, False, [retry_p_resolved], [], 0.95, 1.0, "NONE", [], [])
        retry_p8_resolved = UtteranceAssessment("UTT_003", "COMPLETE", None, 0.95, CoverageStatistics(1, 1, 0, 1, 1, 1, 0, 1.0, 1.0, 1.0, 0.0, 1.0), [], [], [], [], [], [retry_w_resolved], {})

        comp_resolved = RetryComparator.compare_attempts(target, self.mock_p8, retry_p8_resolved, "S_1", "A_2", "A_3", session_improved)
        self.assertEqual(comp_resolved.comparison_state, RetryComparisonState.RESOLVED.value)
        self.assertTrue(comp_resolved.resolved_this_session)
        self.assertIn("làm chủ", comp_resolved.message_vi)

    def test_retry_comparison_unchanged(self):
        """11. Validates UNCHANGED state when error persists."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        retry_p_bad = PhoneAssessment("PH_004", "θ", 0.92, "s", 0.90, None, "SUBSTITUTION", 0.12, 0.20, 0.32, "COMPLETE", [], [])
        retry_w_bad = WordAssessment("W_004", "think", 0.20, 0.65, WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value, False, [retry_p_bad], [], 0.90, 1.0, "HIGH", [], [])
        retry_p8_bad = UtteranceAssessment("UTT_004", "COMPLETE", None, 0.90, CoverageStatistics(1, 1, 0, 1, 1, 1, 0, 1.0, 1.0, 1.0, 0.0, 1.0), [], [], [], [], [], [retry_w_bad], {})

        comp = RetryComparator.compare_attempts(target, self.mock_p8, retry_p8_bad, "S_1", "A_1", "A_2")
        self.assertEqual(comp.comparison_state, RetryComparisonState.UNCHANGED.value)
        self.assertIn("vẫn cần chú ý", comp.message_vi)

    def test_retry_comparison_uncertain_on_bad_audio(self):
        """12. Fail-closed: unparseable/empty retry audio yields UNCERTAIN, never false success."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        empty_p8 = UtteranceAssessment("UTT_005", "INCOMPLETE", None, 0.0, CoverageStatistics(0, 0, 0, 0, 0, 0, 0, 0.0, 0.0, 0.0, 0.0, 0.0), [], [], [], [], [], [], {})
        comp = RetryComparator.compare_attempts(target, self.mock_p8, empty_p8, "S_1", "A_1", "A_2")
        self.assertEqual(comp.comparison_state, RetryComparisonState.UNCERTAIN.value)

    def test_session_recurrence_and_duplicate_attempt_protection(self):
        """13 & 14. Tracks recurrence lifecycle and protects against duplicate attempt counting."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        session = PracticeSessionState("S_1", target, TargetState.PRACTICING.value, LadderLevel.LEVEL_3_WORD.value, 0)

        # Attempt 1: First observation -> NEW
        session = SessionRecurrenceTracker.update_recurrence(session, "ATT_001", target)
        rec_key = SessionRecurrenceTracker.get_recurrence_key(target)
        self.assertEqual(session.recurrence_map[rec_key].lifecycle_state, WeaknessLifecycle.NEW.value)
        self.assertEqual(session.recurrence_map[rec_key].supported_occurrences, 1)

        # Duplicate Attempt 1: should NOT increment
        session = SessionRecurrenceTracker.update_recurrence(session, "ATT_001", target)
        self.assertEqual(session.recurrence_map[rec_key].attempt_count, 1)

        # Attempt 2: Second persistent observation -> RECURRING
        session = SessionRecurrenceTracker.update_recurrence(session, "ATT_002", target)
        self.assertEqual(session.recurrence_map[rec_key].lifecycle_state, WeaknessLifecycle.RECURRING.value)
        self.assertEqual(session.recurrence_map[rec_key].supported_occurrences, 2)

    def test_learner_fatigue_limit(self):
        """15. Reaching max retries transitions target to STALLED and defers it."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        session = PracticeSessionState("S_1", target, TargetState.PRACTICING.value, LadderLevel.LEVEL_3_WORD.value, 0, max_retries_per_target=3)

        bad_comp = RetryComparison("C_1", "S_1", "A_1", "A_2", target.target_id, RetryComparisonState.UNCHANGED.value, [], None, TargetState.PRACTICING.value)

        # Retry 1 & 2
        session = SessionStateMachine.transition(session, bad_comp)
        session = SessionStateMachine.transition(session, bad_comp)
        self.assertEqual(session.target_state, TargetState.PRACTICING.value)

        # Retry 3: Reaches max_retries_per_target -> STALLED & deferred
        session = SessionStateMachine.transition(session, bad_comp)
        self.assertEqual(session.target_state, TargetState.STALLED.value)
        self.assertIn(target.target_id, session.deferred_targets)
        self.assertIsNone(session.active_target)

    def test_speaking_profile_weakness_bridge_gating(self):
        """16. Speaking Profile weakness bridge exports only patterns with >= 2 supported occurrences."""
        target, _, _ = TargetSelector.evaluate_attempt_decision(self.mock_p8, None)
        session = PracticeSessionState("S_1", target, TargetState.PRACTICING.value, LadderLevel.LEVEL_3_WORD.value, 0)

        # Single occurrence -> NOT exported
        session = SessionRecurrenceTracker.update_recurrence(session, "ATT_001", target)
        exported_1 = SessionRecurrenceTracker.export_speaking_profile_weaknesses(session)
        self.assertEqual(len(exported_1), 0)

        # Second occurrence -> Exported!
        session = SessionRecurrenceTracker.update_recurrence(session, "ATT_002", target)
        exported_2 = SessionRecurrenceTracker.export_speaking_profile_weaknesses(session)
        self.assertEqual(len(exported_2), 1)
        self.assertEqual(exported_2[0]["expectedPhone"], "θ")
        self.assertIn("Âm /θ/", exported_2[0]["labelVi"])
        self.assertEqual(exported_2[0]["occurrenceCount"], 2)


if __name__ == "__main__":
    unittest.main()
