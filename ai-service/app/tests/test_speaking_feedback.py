import unittest
from unittest.mock import patch
from app.domain.schemas.speaking import TurnFeedbackRequest
from app.workflows.speaking_workflow import run_turn_feedback_workflow

class TestSpeakingTurnFeedback(unittest.TestCase):

    @patch("app.workflows.speaking_workflow._create_speaking_llm", return_value=None)
    def test_fallback_feedback_limits_to_max_two_corrections(self, mock_llm):
        request = TurnFeedbackRequest(
            learner_transcript="I want order coffee and I have reservation and how much is this",
            scenario_title="Coffee Shop Order",
            cefr_level="A2",
            target_vocabulary=["reservation", "order"]
        )
        response = run_turn_feedback_workflow(request)

        self.assertLessEqual(len(response.corrections), 2)
        self.assertTrue(response.is_mocked)
        self.assertIsNotNone(response.positive_feedback)
        # Verify no acoustic pronunciation claims
        for c in response.corrections:
            self.assertIn(c.type, ["GRAMMAR", "VOCABULARY", "NATURALNESS"])
            self.assertNotIn("phoneme", c.explanation.lower())
            self.assertNotIn("stress", c.explanation.lower())

    @patch("app.workflows.speaking_workflow._create_speaking_llm", return_value=None)
    def test_empty_corrections_supported(self, mock_llm):
        request = TurnFeedbackRequest(
            learner_transcript="Good morning, could I please have a cappuccino?",
            scenario_title="Coffee Shop Order",
            cefr_level="B1"
        )
        response = run_turn_feedback_workflow(request)
        self.assertLessEqual(len(response.corrections), 2)

if __name__ == "__main__":
    unittest.main()
