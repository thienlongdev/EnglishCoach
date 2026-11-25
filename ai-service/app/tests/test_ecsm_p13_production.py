"""
Unit tests for ECSM Phase P13 Speaking Production Lifecycle and Engine.
"""

import unittest
from pathlib import Path
import tempfile

from app.services.pronunciation.ecsm.speaking_production_lifecycle import (
    SpeakingProductionLifecycleManager,
    SessionStatus,
    UnitProgressState,
)
from scripts.ecsm_p13_engine import ECSMP13MasterEngine


class TestECSMP13ProductionLifecycle(unittest.TestCase):

    def setUp(self):
        self.lifecycle = SpeakingProductionLifecycleManager()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp_dir.name)
        self.engine = ECSMP13MasterEngine(self.output_dir)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_session_creation_and_resume(self):
        # Create session
        sess1 = self.lifecycle.create_or_resume_session(user_id=1, material_id=10, total_units=5)
        self.assertEqual(sess1.status, SessionStatus.ACTIVE)
        self.assertEqual(sess1.total_units_count, 5)

        # Resume session
        sess2 = self.lifecycle.create_or_resume_session(user_id=1, material_id=10, total_units=5)
        self.assertEqual(sess1.session_id, sess2.session_id)

    def test_attempt_persistence_and_lineage(self):
        sess = self.lifecycle.create_or_resume_session(user_id=1, material_id=10, total_units=2)

        ecsm_res1 = {
            "requestId": "req-1",
            "retryPlan": {"primary_target": {"target_id": "T1", "issue_type": "ARTICULATORY_VOICING_MISMATCH", "word": "Test"}},
        }
        att1, cached = self.lifecycle.record_attempt_with_idempotency(
            session_id=sess.session_id,
            user_id=1,
            unit_id=100,
            client_attempt_id="att-1",
            ecsm_response=ecsm_res1,
        )
        self.assertFalse(cached)
        self.assertEqual(att1.retry_index, 0)
        self.assertEqual(att1.primary_issue_type, "ARTICULATORY_VOICING_MISMATCH")

        # Retry attempt
        ecsm_res2 = {
            "requestId": "req-2",
            "retryComparison": {"comparison_state": "IMPROVED", "resolved_this_session": True},
        }
        att2, cached2 = self.lifecycle.record_attempt_with_idempotency(
            session_id=sess.session_id,
            user_id=1,
            unit_id=100,
            client_attempt_id="att-2",
            ecsm_response=ecsm_res2,
            parent_attempt_id="att-1",
            active_target_id="T1",
        )
        self.assertFalse(cached2)
        self.assertEqual(att2.retry_index, 1)
        self.assertTrue(att2.resolved_this_session)
        self.assertEqual(att2.parent_attempt_id, "att-1")

    def test_idempotency(self):
        sess = self.lifecycle.create_or_resume_session(user_id=1, material_id=10, total_units=2)
        att1, cached1 = self.lifecycle.record_attempt_with_idempotency(
            session_id=sess.session_id,
            user_id=1,
            unit_id=100,
            client_attempt_id="att-unique-123",
            ecsm_response={"requestId": "r1"},
        )
        self.assertFalse(cached1)

        # Duplicate submit
        att2, cached2 = self.lifecycle.record_attempt_with_idempotency(
            session_id=sess.session_id,
            user_id=1,
            unit_id=100,
            client_attempt_id="att-unique-123",
            ecsm_response={"requestId": "r1"},
        )
        self.assertTrue(cached2)
        self.assertEqual(att1.id, att2.id)

    def test_unit_advancement_and_completion(self):
        sess = self.lifecycle.create_or_resume_session(user_id=1, material_id=10, total_units=2)

        step1 = self.lifecycle.advance_unit(sess.session_id, 1, unit_id=100, action="COMPLETE")
        self.assertEqual(step1.current_unit_index, 1)
        self.assertEqual(step1.status, SessionStatus.ACTIVE)

        step2 = self.lifecycle.advance_unit(sess.session_id, 1, unit_id=101, action="COMPLETE")
        self.assertEqual(step2.current_unit_index, 2)
        self.assertEqual(step2.status, SessionStatus.COMPLETED)

    def test_master_engine_audits(self):
        results = self.engine.run_all_audits()
        self.assertEqual(results["session_contract"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["attempt_persistence"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["idempotency"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["refresh_resume"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["lesson_completion"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["no_raw_audio"]["status"], "VERIFIED_PASS")
        self.assertEqual(results["production_readiness"]["overall_status"], "READY_FOR_SPEAKING_PRODUCTION")


if __name__ == "__main__":
    unittest.main()
