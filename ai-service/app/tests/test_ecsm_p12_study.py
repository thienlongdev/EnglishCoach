"""
Unit tests for ECSM Phase P12 Real-User Validation Infrastructure,
Expert-Blind Review System, and Metric Engine.
"""

import datetime
from pathlib import Path
import tempfile
import unittest

from app.services.pronunciation.ecsm.study_infrastructure import (
    ConsentRecord,
    StudyStore,
    ValidationStudyConfig,
)
from app.services.pronunciation.ecsm.expert_blind_system import (
    ExpertReviewStore,
    PassE1Submission,
    PassE2Submission,
    PassE3Submission,
)
from app.services.pronunciation.ecsm.metric_engine import (
    cluster_bootstrap_ci,
    ValidationMetricEngine,
)


class TestECSMP12StudyInfrastructure(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_path = Path(self.temp_dir.name)
        self.study_store = StudyStore(self.base_path / "research")
        self.expert_store = ExpertReviewStore(self.base_path / "research" / "research_store.db")
        self.metric_engine = ValidationMetricEngine()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_study_enrollment_and_consent(self):
        consent = ConsentRecord(
            consent_id="CONS_001",
            participant_id="USR_001",
            protocol_version="ECSM_P12_PROTOCOL_v1.0",
            is_adult=True,
            consented_audio_capture=True,
            consented_expert_review=True,
            consented_research_analytics=True,
            timestamp_utc=datetime.datetime.utcnow().isoformat(),
        )
        participant = self.study_store.enroll_participant("USR_001", ["SB_01", "SB_02"], 42, consent)
        self.assertEqual(participant.participant_id, "USR_001")
        self.assertEqual(participant.status, "ENROLLED")

        counts = self.study_store.get_counts()
        self.assertEqual(counts["real_participants"], 1)

    def test_unconsented_capture_blocked(self):
        with self.assertRaises(PermissionError):
            self.study_store.save_study_attempt(
                participant_id="USR_UNCONSENTED",
                session_id="SESS_01",
                sentence_id="SB_01",
                expected_text="Hello world.",
                audio_bytes=b"RIFF...",
                duration_sec=1.0,
                product_safe_resp={"overall_score": None},
                full_research_resp={},
                is_test_fixture=False,
            )

    def test_withdrawal_deletes_audio_and_marks_status(self):
        consent = ConsentRecord(
            consent_id="CONS_002",
            participant_id="USR_002",
            protocol_version="ECSM_P12_PROTOCOL_v1.0",
            is_adult=True,
            consented_audio_capture=True,
            consented_expert_review=True,
            consented_research_analytics=True,
            timestamp_utc=datetime.datetime.utcnow().isoformat(),
        )
        self.study_store.enroll_participant("USR_002", ["SB_01"], 10, consent)
        attempt = self.study_store.save_study_attempt(
            participant_id="USR_002",
            session_id="SESS_02",
            sentence_id="SB_01",
            expected_text="Hello world.",
            audio_bytes=b"FAKE_AUDIO_BYTES_FOR_WITHDRAWAL_TEST",
            duration_sec=1.5,
            product_safe_resp={"overall_score": None},
            full_research_resp={},
            is_test_fixture=False,
        )

        self.assertTrue(Path(attempt.audio_opaque_path).exists())

        res = self.study_store.withdraw_participant("USR_002")
        self.assertEqual(res["status"], "WITHDRAWN_SUCCESSFUL")
        self.assertEqual(res["deleted_audio_files"], 1)
        self.assertFalse(Path(attempt.audio_opaque_path).exists())

        counts = self.study_store.get_counts()
        self.assertEqual(counts["real_participants"], 0)

    def test_expert_blind_pass_e1_e2_e3_lifecycle(self):
        consent = ConsentRecord(
            consent_id="CONS_003",
            participant_id="USR_003",
            protocol_version="ECSM_P12_PROTOCOL_v1.0",
            is_adult=True,
            consented_audio_capture=True,
            consented_expert_review=True,
            consented_research_analytics=True,
            timestamp_utc=datetime.datetime.utcnow().isoformat(),
        )
        self.study_store.enroll_participant("USR_003", ["SB_01"], 1, consent)
        attempt = self.study_store.save_study_attempt(
            participant_id="USR_003",
            session_id="SESS_03",
            sentence_id="SB_01",
            expected_text="Think carefully.",
            audio_bytes=b"AUDIO_FOR_EXPERT_TEST",
            duration_sec=1.0,
            product_safe_resp={"overall_score": None, "retryPlan": {"drill": {"drill_type": "MINIMAL_PAIR_CONTRAST"}}},
            full_research_resp={},
            is_test_fixture=False,
        )

        # Create review task
        with self.expert_store._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO review_tasks VALUES (?, ?, ?, ?, ?)",
                ("TASK_001", attempt.attempt_id, "EXP_001", "E1_PENDING", datetime.datetime.utcnow().isoformat()),
            )
            conn.commit()

        # 1. E2 must fail before E1 sealed
        with self.assertRaises(PermissionError):
            self.expert_store.get_e2_payload("TASK_001", "EXP_001")

        # 2. Submit E1
        e1_sub = PassE1Submission(
            review_task_id="TASK_001",
            attempt_id=attempt.attempt_id,
            expert_id="EXP_001",
            perceived_phone="s",
            confidence=5,
        )
        seal_e1 = self.expert_store.submit_e1(e1_sub)
        self.assertTrue(len(seal_e1) > 0)

        # 3. E1 cannot be modified once sealed
        with self.assertRaises(PermissionError):
            self.expert_store.submit_e1(e1_sub)

        # 4. E3 must fail before E2 sealed
        with self.assertRaises(PermissionError):
            self.expert_store.get_e3_payload("TASK_001", "EXP_001")

        # 5. E2 payload is now available
        e2_payload = self.expert_store.get_e2_payload("TASK_001", "EXP_001")
        self.assertEqual(e2_payload.expected_sentence, "Think carefully.")

        # 6. Submit E2
        e2_sub = PassE2Submission(
            review_task_id="TASK_001",
            attempt_id=attempt.attempt_id,
            expert_id="EXP_001",
            pronunciation_judgment="SEGMENTAL_CORRECTION_WARRANTED",
            localized_word="Think",
            confidence=5,
        )
        seal_e2 = self.expert_store.submit_e2(e2_sub)
        self.assertTrue(len(seal_e2) > 0)

        # 7. E3 payload is now available
        e3_payload = self.expert_store.get_e3_payload("TASK_001", "EXP_001")
        self.assertIsNotNone(e3_payload.product_safe_feedback)

        # 8. Submit E3
        e3_sub = PassE3Submission(
            review_task_id="TASK_001",
            attempt_id=attempt.attempt_id,
            expert_id="EXP_001",
            verdict="FEEDBACK_CORRECT",
            drill_appropriate=True,
        )
        self.expert_store.submit_e3(e3_sub)

        expert_counts = self.expert_store.get_expert_review_counts()
        self.assertEqual(expert_counts["e1_reviews_count"], 1)
        self.assertEqual(expert_counts["e2_reviews_count"], 1)
        self.assertEqual(expert_counts["e3_reviews_count"], 1)

    def test_metric_engine_rejects_test_fixtures(self):
        # When only test fixtures exist, evaluate_study_dataset returns NOT_AVAILABLE
        attempts = [
            {
                "attempt_id": "ATT_TEST",
                "is_test_fixture": True,
                "participant_id": "USR_TEST",
                "product_safe_snapshot": {"overall_score": None},
            }
        ]
        res = self.metric_engine.evaluate_study_dataset(attempts, [], [], [])
        self.assertEqual(res["status"], "NOT_AVAILABLE")
        self.assertEqual(res["real_participants_count"], 0)

    def test_cluster_bootstrap_ci(self):
        data = {
            "USR_1": [0.0, 0.0, 1.0],
            "USR_2": [0.0, 0.0],
            "USR_3": [1.0, 1.0],
        }
        res = cluster_bootstrap_ci(data, n_bootstraps=100)
        self.assertTrue(0.0 <= res.ci_lower <= res.mean <= res.ci_upper <= 1.0)
        self.assertEqual(res.n_clusters, 3)
        self.assertEqual(res.n_samples, 7)


if __name__ == "__main__":
    unittest.main()
