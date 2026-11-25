"""
Unit tests for ECSM-v1 / EC-PRISM Phase P9: Retry Intelligence & Corrective Learning Policy.
Verifies primary target selection, exact-phone abstention preservation,
drill mapping, retry-to-retry comparison, state machine transitions, and P8 immutability.
"""

from dataclasses import asdict
import unittest

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
    DrillPlanner,
    DrillType,
    PracticeSessionState,
    PrimaryTarget,
    RetryComparator,
    RetryComparison,
    RetryComparisonState,
    RetryDelta,
    RetryPlan,
    ScaffoldLevel,
    SessionStateMachine,
    TargetSelector,
    TargetState,
)


class TestECSMP9RetryIntelligence(unittest.TestCase):

    def setUp(self):
        # Base issue: trusted /θ/ -> /s/ in "think"
        self.iss_th = IssueNode(
            issue_id="ISS_001",
            issue_type="PHONE_SUBSTITUTION",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.HIGH.value,
            confidence=0.95,
            priority=IssuePriority.HIGH.value,
            priority_reasons=["HIGH_SEGMENTAL_ERROR_CONFIDENCE"],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_001"],
            target_info={"expectedPhone": "θ"},
            observed_info={"observedPhone": "s", "exactPhoneConfidence": 0.93},
            abstained_fields=[],
            safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
        )

        self.p_assess_th = PhoneAssessment("PH_001", "θ", 0.95, "s", 0.93, None, "SUBSTITUTION", 0.12, 0.20, 0.32, "COMPLETE", ["EV_001"], [self.iss_th])
        self.w_assess_think = WordAssessment("W_001", "think", 0.20, 0.65, WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value, False, [self.p_assess_th], [], 0.93, 1.0, "HIGH", [self.iss_th], ["EV_001"])

        self.mock_p8 = UtteranceAssessment(
            utterance_id="UTT_001",
            overall_status="COMPLETE",
            overall_score=None,
            confidence=0.95,
            coverage_stats=CoverageStatistics(4, 4, 0, 1, 1, 1, 0, 1.0, 0.25, 1.0, 0.0, 1.0),
            primary_issues=[self.iss_th],
            secondary_issues=[],
            descriptive_observations=[],
            abstained_analyses=[],
            phrases=[],
            words=[self.w_assess_think],
            evidence_store={},
        )

    def test_primary_target_selection_precedence(self):
        target, non_sel = TargetSelector.select_primary_target(self.mock_p8, None)
        self.assertIsNotNone(target)
        self.assertEqual(target.expected_phone, "θ")
        self.assertEqual(target.observed_phone, "s")
        self.assertIn("SAFE_TO_SURFACE", target.selection_reasons)

    def test_exact_phone_abstention_preservation(self):
        # Case where exact phone abstained: observedPhone is None, articulatoryDiagnosis present
        iss_art = IssueNode(
            issue_id="ISS_ART_001",
            issue_type="ARTICULATORY_DENTAL_MISMATCH",
            level=IssueLevel.PHONE.value,
            severity=IssueSeverity.MEDIUM.value,
            confidence=0.88,
            priority=IssuePriority.HIGH.value,
            priority_reasons=[],
            time_start_sec=0.20,
            time_end_sec=0.32,
            evidence_refs=["EV_002"],
            target_info={"expectedPhone": "θ"},
            observed_info={"articulatoryDiagnosis": "θ"},
            abstained_fields=["observedExactPhone"],
            safety_tier=ProductSafetyTier.SAFE_WITH_CAVEAT.value,
        )
        p_art = PhoneAssessment("PH_002", "θ", 0.88, None, None, "θ", "SUBSTITUTION", 0.12, 0.20, 0.32, "PARTIAL", ["EV_002"], [iss_art])
        w_art = WordAssessment("W_002", "think", 0.20, 0.65, WordAssessmentStatus.LIKELY_ISSUE.value, False, [p_art], [], 0.88, 1.0, "MEDIUM", [iss_art], ["EV_002"])

        p8_art = UtteranceAssessment("UTT_ART", "COMPLETE", None, 0.88, self.mock_p8.coverage_stats, [iss_art], [], [], [], [], [w_art], {})

        target, _ = TargetSelector.select_primary_target(p8_art, None)
        self.assertIsNotNone(target)
        self.assertIsNone(target.observed_phone)
        self.assertTrue(target.is_articulatory_fallback)

        plan = DrillPlanner.plan_drill(target, None)
        self.assertEqual(plan.drill_type, DrillType.ARTICULATORY_PLACEMENT.value)
        # Verify no hallucinated /s/ in instructions
        self.assertNotIn("You pronounced /s/", str(plan.articulatory_instructions))

    def test_drill_mapping_and_scaffold_planning(self):
        target, _ = TargetSelector.select_primary_target(self.mock_p8, None)
        session = PracticeSessionState("S1", target, TargetState.PRACTICING.value, ScaffoldLevel.LEVEL_3_MINIMAL_PAIR.value, 0, 3, 0)
        plan = DrillPlanner.plan_drill(target, session)

        self.assertEqual(plan.drill_type, DrillType.MINIMAL_PAIR_CONTRAST.value)
        self.assertEqual(plan.minimal_pair, ("think", "sink"))
        self.assertIn("TARGET_ERROR_STATE_CLEARS", plan.success_criteria)

    def test_retry_comparison_improvement_and_uncertainty(self):
        target, _ = TargetSelector.select_primary_target(self.mock_p8, None)

        # 1. Clean retry -> IMPROVED
        p_clean = PhoneAssessment("PH_001", "θ", 0.05, "θ", 0.95, None, "MATCH", 0.12, 0.20, 0.32, "COMPLETE", ["EV_003"], [])
        w_clean = WordAssessment("W_001", "think", 0.20, 0.65, WordAssessmentStatus.NO_ISSUE_DETECTED.value, False, [p_clean], [], 0.95, 1.0, "LOW", [], ["EV_003"])
        p8_retry_clean = UtteranceAssessment("UTT_RETRY_1", "COMPLETE", None, 0.95, self.mock_p8.coverage_stats, [], [], [], [], [], [w_clean], {})

        comp = RetryComparator.compare_attempts(target, self.mock_p8, p8_retry_clean)
        self.assertEqual(comp.comparison_state, RetryComparisonState.IMPROVED.value)
        self.assertIn("TARGET_ERROR_CLEARED", comp.reasons)

        # 2. Uncertain delta -> INCONCLUSIVE
        p_unc = PhoneAssessment("PH_001", "θ", 0.55, None, None, None, "SUBSTITUTION", 0.12, 0.20, 0.32, "PARTIAL", ["EV_004"], [])
        w_unc = WordAssessment("W_001", "think", 0.20, 0.65, WordAssessmentStatus.LIKELY_ISSUE.value, False, [p_unc], [], 0.55, 1.0, "MEDIUM", [], ["EV_004"])
        p8_retry_unc = UtteranceAssessment("UTT_RETRY_2", "COMPLETE", None, 0.55, self.mock_p8.coverage_stats, [], [], [], [], [], [w_unc], {})

        comp_unc = RetryComparator.compare_attempts(target, self.mock_p8, p8_retry_unc)
        self.assertEqual(comp_unc.comparison_state, RetryComparisonState.INCONCLUSIVE.value)

    def test_within_session_state_machine_and_bounded_retry(self):
        target, _ = TargetSelector.select_primary_target(self.mock_p8, None)
        session = PracticeSessionState("S1", target, TargetState.IDENTIFIED.value, ScaffoldLevel.LEVEL_3_MINIMAL_PAIR.value, 0, 3, 0)

        # Step 1: Improved once -> recomposes scaffold
        comp_step1 = RetryComparison("C1", "S1", "A1", "A2", target.target_id, RetryComparisonState.IMPROVED.value, ["OK"], RetryDelta(0.9, 0.1, "s", "θ", 0.8, "IMPROVED", 0.9), TargetState.IMPROVED_ONCE.value)
        session = SessionStateMachine.transition(session, comp_step1)
        self.assertEqual(session.target_state, TargetState.IMPROVED_ONCE.value)
        self.assertEqual(session.scaffold_level, ScaffoldLevel.LEVEL_4_TARGET_WORD.value)

        # Step 2: Confirmed in context -> RESOLVED_THIS_SESSION
        comp_step2 = RetryComparison("C2", "S1", "A2", "A3", target.target_id, RetryComparisonState.IMPROVED.value, ["CONFIRMED"], RetryDelta(0.1, 0.05, "θ", "θ", 0.05, "CONFIRMED", 0.95), TargetState.RESOLVED_THIS_SESSION.value)
        session = SessionStateMachine.transition(session, comp_step2)
        self.assertEqual(session.target_state, TargetState.RESOLVED_THIS_SESSION.value)
        self.assertIn(target.target_id, session.resolved_targets)
        self.assertIsNone(session.active_target)

    def test_stall_and_deferral_after_max_retries(self):
        target, _ = TargetSelector.select_primary_target(self.mock_p8, None)
        session = PracticeSessionState("S1", target, TargetState.PRACTICING.value, ScaffoldLevel.LEVEL_4_TARGET_WORD.value, 0, 3, 0)

        # 3 unchanged retries -> STALLED & DEFERRED
        comp_fail = RetryComparison("CF", "S1", "A1", "A2", target.target_id, RetryComparisonState.UNCHANGED.value, ["PERSISTS"], RetryDelta(0.9, 0.9, "s", "s", 0.0, "UNCHANGED", 0.9), TargetState.PRACTICING.value)
        session = SessionStateMachine.transition(session, comp_fail)
        session = SessionStateMachine.transition(session, comp_fail)
        session = SessionStateMachine.transition(session, comp_fail)

        self.assertEqual(session.target_state, TargetState.STALLED.value)
        self.assertIn(target.target_id, session.deferred_targets)
        self.assertIsNone(session.active_target)


if __name__ == "__main__":
    unittest.main()
