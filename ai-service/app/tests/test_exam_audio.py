import unittest
from app.services.audio_ingestion import (
    MAX_AUDIO_DURATION_SECONDS,
    decode_browser_audio,
    AudioIngestionError,
)
from app.services.exams.audio_evidence import extract_speaking_evidence

class TestExamAudio(unittest.TestCase):

    def test_legacy_default_duration_limit_preserved(self):
        self.assertEqual(MAX_AUDIO_DURATION_SECONDS, 30.0)

    def test_acoustic_evidence_abstention_on_empty(self):
        evidence = extract_speaking_evidence(b"")
        self.assertTrue(evidence.abstention_required)
        self.assertEqual(evidence.abstention_reason, "INSUFFICIENT_AUDIO_PAYLOAD")

    def test_decode_browser_audio_rejects_empty(self):
        with self.assertRaises(AudioIngestionError):
            decode_browser_audio(b"")

if __name__ == "__main__":
    unittest.main()
