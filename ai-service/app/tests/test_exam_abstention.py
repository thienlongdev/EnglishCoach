import unittest
from unittest.mock import MagicMock, patch
from app.domain.schemas.exams import ExamScoringRequest, ExamScoringResponse
from app.services.exams.evidence_contract import SpeakingTurnEvidence
from app.services.exams.ielts_speaking import evaluate_ielts_speaking


class TestExamSpeakingAbstentionAndScoring(unittest.TestCase):

    def setUp(self):
        self.valid_turns = [
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                promptId="p1_item_01",
                promptText="What is your full name?",
                recordingId="11111111-1111-1111-1111-111111111111",
                durationMs=5000,
                transcriptText="My full name is Nguyen Van A and I am from Da Nang.",
                transcriptStatus="READY",
                audioBase64="UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                acousticEvidence={"codec": "audio/webm", "totalBytes": 16000, "snr": 25.4}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p2_g_long_i_01",
                turnSequence=2,
                partKey="Part 2",
                promptId="p2_item_01",
                promptText="Describe a book you read recently.",
                recordingId="22222222-2222-2222-2222-222222222222",
                durationMs=90000,
                transcriptText="I would like to describe an engaging book that I read last month about human psychology and habits.",
                transcriptStatus="READY",
                audioBase64="UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                acousticEvidence={"codec": "audio/webm", "totalBytes": 360000, "snr": 28.1}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p3_g_discuss_i_01",
                turnSequence=3,
                partKey="Part 3",
                promptId="p3_item_01",
                promptText="Do you think reading books will change in the digital era?",
                recordingId="33333333-3333-3333-3333-333333333333",
                durationMs=35000,
                transcriptText="Digital media certainly provides convenience, but physical books still have unique tactile value for readers.",
                transcriptStatus="READY",
                audioBase64="UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                acousticEvidence={"codec": "audio/webm", "totalBytes": 140000, "snr": 26.5}
            )
        ]

    def test_short_speech_abstains_honestly_without_1_or_0_fallback(self):
        """Speech fewer than 5 words across the session must abstain, never returning 1.0 or 0.0."""
        short_turns = [
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                recordingId="11111111-1111-1111-1111-111111111111",
                durationMs=2000,
                transcriptText="Yes.",
                transcriptStatus="READY",
                acousticEvidence={"totalBytes": 8000}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p2_g_long_i_01",
                turnSequence=2,
                partKey="Part 2",
                recordingId="22222222-2222-2222-2222-222222222222",
                durationMs=2000,
                transcriptText="No.",
                transcriptStatus="READY",
                acousticEvidence={"totalBytes": 8000}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p3_g_discuss_i_01",
                turnSequence=3,
                partKey="Part 3",
                recordingId="33333333-3333-3333-3333-333333333333",
                durationMs=2000,
                transcriptText="Maybe.",
                transcriptStatus="READY",
                acousticEvidence={"totalBytes": 8000}
            )
        ]
        # Total words = 3 (< 5)
        req = ExamScoringRequest(
            stageKey="STAGE_IELTS_SPEAKING_SESSION",
            family="IELTS",
            skill="SPEAKING",
            turns=short_turns
        )
        res = evaluate_ielts_speaking(req)

        self.assertFalse(res.success)
        self.assertIsNone(res.overallBand, "Insufficient speech must NOT fall back to 1.0 or 0.0!")
        self.assertNotEqual(res.overallBand, 1.0)
        self.assertNotEqual(res.overallBand, 0.0)
        self.assertTrue(res.reviewRequired)
        self.assertIsNotNone(res.abstention)
        self.assertEqual(res.abstention.get("reason"), "MIN_SPEECH_INSUFFICIENT")
        self.assertEqual(res.telemetry.get("rule"), "MIN_SPEECH_INSUFFICIENT")
        self.assertEqual(len(res.criteria), 0, "Criteria must be empty/unassigned on speech abstention")
        self.assertIsNotNone(res.evidenceHash)

    def test_transcript_only_abstains_pronunciation_without_numeric_fallback(self):
        """If turns have transcript only and zero acoustic evidence, Pronunciation cannot be scored."""
        transcript_only_turns = [
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                durationMs=5000,
                transcriptText="My full name is Nguyen Van A and I live in Hanoi.",
                transcriptStatus="READY",
                acousticEvidence={}  # Empty! No audio/acoustic evidence
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p2_g_long_i_01",
                turnSequence=2,
                partKey="Part 2",
                durationMs=45000,
                transcriptText="I would like to describe a book that influenced my career choices deeply.",
                transcriptStatus="READY",
                acousticEvidence={}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p3_g_discuss_i_01",
                turnSequence=3,
                partKey="Part 3",
                durationMs=25000,
                transcriptText="Reading digital articles is convenient but physical books encourage deep concentration.",
                transcriptStatus="READY",
                acousticEvidence={}
            )
        ]
        req = ExamScoringRequest(
            stageKey="STAGE_IELTS_SPEAKING_SESSION",
            family="IELTS",
            skill="SPEAKING",
            turns=transcript_only_turns
        )
        res = evaluate_ielts_speaking(req)

        self.assertFalse(res.success)
        self.assertIsNone(res.overallBand, "Session overall band cannot be emitted when Pronunciation lacks audio evidence")
        self.assertTrue(res.reviewRequired)
        self.assertIsNotNone(res.abstention)
        self.assertEqual(res.abstention.get("criterion"), "PRONUNCIATION")
        self.assertEqual(res.abstention.get("reason"), "PRONUNCIATION_LACKS_ACOUSTIC_EVIDENCE")

    def test_turn_diagnostics_remain_evidence_only_never_contain_band_score(self):
        """Turn diagnostics must carry duration, transcript, acoustic info, but NEVER an IELTS band."""
        req = ExamScoringRequest(
            stageKey="STAGE_IELTS_SPEAKING_SESSION",
            family="IELTS",
            skill="SPEAKING",
            turns=self.valid_turns
        )
        # These fixtures carry metadata but no decodable audio.
        with patch("app.services.exams.ielts_speaking.get_llm") as judge:
            res = evaluate_ielts_speaking(req)
            judge.assert_not_called()
        self.assertFalse(res.success)
        self.assertTrue(res.reviewRequired)
        self.assertIsNone(res.overallBand)
        self.assertFalse(res.criteria)
        self.assertIsNotNone(res.turnDiagnostics)

        for turn_key, diag in res.turnDiagnostics.items():
            self.assertIn("durationMs", diag)
            self.assertIn("wordCount", diag)
            self.assertIn("transcriptStatus", diag)
            self.assertIn("hasAcoustic", diag)
            # Invariant: No turn-level band scores
            self.assertNotIn("band", diag)
            self.assertNotIn("ieltsBand", diag)
            self.assertNotIn("score", diag)
            self.assertNotIn("turnBand", diag)

    def test_invalid_turn_set_rejects_cleanly(self):
        """Duplicate turnKey or sequence gap returns reviewRequired and no overall band."""
        bad_turns = [
            self.valid_turns[0],
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",  # DUPLICATE
                turnSequence=2,
                partKey="Part 2",
                durationMs=5000,
                transcriptText="Duplicate key test."
            ),
            self.valid_turns[2]
        ]
        req = ExamScoringRequest(
            stageKey="STAGE_IELTS_SPEAKING_SESSION",
            family="IELTS",
            skill="SPEAKING",
            turns=bad_turns
        )
        res = evaluate_ielts_speaking(req)
        self.assertFalse(res.success)
        self.assertIsNone(res.overallBand)
        self.assertTrue(res.reviewRequired)
        self.assertEqual(res.abstention.get("reason"), "INVALID_TURN_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
