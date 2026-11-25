import unittest
from app.domain.schemas.exams import (
    ExamScoringRequest,
    ExamScoringResponse,
    CriterionScore
)
from app.services.exams.evidence_contract import (
    SpeakingTurnEvidence,
    compute_evidence_hash,
    compute_request_hash,
    compute_output_hash,
    validate_speaking_turn_evidence_set
)


class TestExamSpeakingEvidenceContract(unittest.TestCase):

    def setUp(self):
        self.sample_turns = [
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                promptId="p1_item_01",
                promptText="What is your full name?",
                recordingId="11111111-1111-1111-1111-111111111111",
                durationMs=3500,
                transcriptText="My full name is Nguyen Van A.",
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
                transcriptText="I would like to talk about a book that made a strong impression on me.",
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
                transcriptText="Digital media certainly provides convenience, but physical books still have unique value.",
                transcriptStatus="READY",
                audioBase64="UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                acousticEvidence={"codec": "audio/webm", "totalBytes": 140000, "snr": 26.5}
            )
        ]

    def test_complete_authorized_turn_set_passes(self):
        val = validate_speaking_turn_evidence_set(self.sample_turns)
        self.assertTrue(val["valid"])
        self.assertEqual(val["turnCount"], 3)
        self.assertEqual(val["partsPresent"], ["Part 1", "Part 2", "Part 3"])
        self.assertTrue(val["hasAcousticEvidence"])
        self.assertFalse(val["pronunciationAbstentionRequired"])
        self.assertTrue(len(val["evidenceHash"]) == 64)

    def test_deterministic_evidence_hash(self):
        hash1 = compute_evidence_hash(self.sample_turns)
        # Reversed input list order must yield identical hash due to sequence sorting
        hash2 = compute_evidence_hash(list(reversed(self.sample_turns)))
        self.assertEqual(hash1, hash2)
        self.assertEqual(len(hash1), 64)

    def test_deterministic_request_and_output_hashes(self):
        ev_hash = compute_evidence_hash(self.sample_turns)
        req_hash1 = compute_request_hash("IELTS_SPEAKING", "IELTS", "SPEAKING", "snapshot_123", ev_hash)
        req_hash2 = compute_request_hash("IELTS_SPEAKING", "IELTS", "SPEAKING", "snapshot_123", ev_hash)
        self.assertEqual(req_hash1, req_hash2)

        criteria = [
            {"criterion": "FLUENCY_AND_COHERENCE", "score": 6.5},
            {"criterion": "LEXICAL_RESOURCE", "score": 7.0},
            {"criterion": "GRAMMATICAL_RANGE_AND_ACCURACY", "score": 6.0},
            {"criterion": "PRONUNCIATION", "score": 6.5}
        ]
        out_hash1 = compute_output_hash("IELTS_SPEAKING", 6.5, criteria, ev_hash)
        out_hash2 = compute_output_hash("IELTS_SPEAKING", 6.5, list(reversed(criteria)), ev_hash)
        self.assertEqual(out_hash1, out_hash2)

    def test_reject_duplicate_turn_keys(self):
        dup_turns = [
            self.sample_turns[0],
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",  # DUPLICATE!
                turnSequence=2,
                partKey="Part 2",
                recordingId="22222222-2222-2222-2222-222222222222",
                durationMs=5000
            ),
            self.sample_turns[2]
        ]
        with self.assertRaises(ValueError) as ctx:
            validate_speaking_turn_evidence_set(dup_turns)
        self.assertIn("DUPLICATE_TURN_KEY", str(ctx.exception))

    def test_reject_non_contiguous_sequence(self):
        bad_seq_turns = [
            self.sample_turns[0],
            SpeakingTurnEvidence(
                turnKey="speak_p2_g_long_i_01",
                turnSequence=4,  # JUMP from 1 to 4!
                partKey="Part 2",
                recordingId="22222222-2222-2222-2222-222222222222",
                durationMs=5000
            ),
            self.sample_turns[2]
        ]
        with self.assertRaises(ValueError) as ctx:
            validate_speaking_turn_evidence_set(bad_seq_turns)
        self.assertIn("NON_CONTIGUOUS_TURN_SEQUENCE", str(ctx.exception))

    def test_reject_independent_turn_level_band_score(self):
        # Strict architectural invariant: Turns must NEVER carry independent IELTS band scores
        with self.assertRaises(ValueError) as ctx:
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                recordingId="11111111-1111-1111-1111-111111111111",
                band=6.5  # FORBIDDEN!
            )
        self.assertIn("FORBIDDEN_TURN_BAND_SCORE", str(ctx.exception))

        with self.assertRaises(ValueError) as ctx2:
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                recordingId="11111111-1111-1111-1111-111111111111",
                ieltsBand=7.0  # FORBIDDEN!
            )
        self.assertIn("FORBIDDEN_TURN_BAND_SCORE", str(ctx2.exception))

    def test_reject_examiner_presentation_media(self):
        # Scorer inputs must NOT receive examiner presentation media
        with self.assertRaises(ValueError) as ctx:
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                recordingId="11111111-1111-1111-1111-111111111111",
                examinerAudioUrl="https://storage.englishcoach.app/examiner_audio_p1.mp3"  # FORBIDDEN!
            )
        self.assertIn("FORBIDDEN_EXAMINER_MEDIA", str(ctx.exception))

    def test_missing_required_parts_fails_validation(self):
        # Only Part 1 provided
        part1_only = [self.sample_turns[0]]
        with self.assertRaises(ValueError) as ctx:
            validate_speaking_turn_evidence_set(part1_only, required_parts=["Part 1", "Part 2", "Part 3"])
        self.assertIn("INCOMPLETE_SPEAKING_PARTS", str(ctx.exception))

    def test_pronunciation_requires_acoustic_evidence(self):
        # Turn without audio or acoustic metrics
        transcript_only_turns = [
            SpeakingTurnEvidence(
                turnKey="speak_p1_g_intro_i_01",
                turnSequence=1,
                partKey="Part 1",
                transcriptText="Hello world",
                durationMs=0,
                audioBase64=None,
                acousticEvidence={}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p2_g_long_i_01",
                turnSequence=2,
                partKey="Part 2",
                transcriptText="Long turn transcript",
                durationMs=0,
                audioBase64=None,
                acousticEvidence={}
            ),
            SpeakingTurnEvidence(
                turnKey="speak_p3_g_discuss_i_01",
                turnSequence=3,
                partKey="Part 3",
                transcriptText="Discussion transcript",
                durationMs=0,
                audioBase64=None,
                acousticEvidence={}
            )
        ]
        val = validate_speaking_turn_evidence_set(transcript_only_turns)
        self.assertTrue(val["valid"])
        self.assertFalse(val["hasAcousticEvidence"])
        self.assertTrue(val["pronunciationAbstentionRequired"])
        self.assertEqual(val["abstentionReason"], "PRONUNCIATION_LACKS_ACOUSTIC_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
