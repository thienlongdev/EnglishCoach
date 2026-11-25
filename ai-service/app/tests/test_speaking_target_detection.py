import unittest
from app.workflows.speaking_workflow import detect_target_vocabulary

class TestSpeakingTargetDetection(unittest.TestCase):

    def test_word_boundary_prevents_substring_false_positive(self):
        # 'art' must NOT match 'restaurant'
        transcript = "I would like to make a reservation at the restaurant."
        target_vocab = ["art", "reservation"]
        detected = detect_target_vocabulary(transcript, target_vocab)
        self.assertIn("reservation", detected)
        self.assertNotIn("art", detected)

    def test_phrase_and_stem_matching(self):
        transcript = "We are checking in today for our reservations."
        target_vocab = ["check in", "reservation", "amenities"]
        detected = detect_target_vocabulary(transcript, target_vocab)
        self.assertIn("check in", detected)
        self.assertIn("reservation", detected)
        self.assertNotIn("amenities", detected)

if __name__ == "__main__":
    unittest.main()
