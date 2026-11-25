import os
import unittest
from unittest.mock import patch, MagicMock
from app.domain.schemas.speaking import (
    RoleplayTurnRequest,
    RoleplayTurnResponse,
    TurnFeedbackRequest,
    TurnFeedbackResponse,
    TurnCorrectionItem,
)
from app.workflows.speaking_workflow import (
    run_roleplay_turn_workflow,
    run_turn_feedback_workflow,
    _create_speaking_llm,
)

class TestSpeakingWorkflowOpenRouter(unittest.TestCase):

    def setUp(self):
        # Clean relevant environment variables before each test while preserving system environment
        self.env_patcher = patch.dict(os.environ)
        self.env_patcher.start()
        for k in ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "DEFAULT_MODEL"]:
            os.environ.pop(k, None)

    def tearDown(self):
        self.env_patcher.stop()

    def test_llm_creation_with_openrouter_config(self):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        os.environ["OPENROUTER_BASE_URL"] = "https://openrouter.ai/api/v1"
        os.environ["DEFAULT_MODEL"] = "google/gemini-2.0-flash-001"

        llm = _create_speaking_llm(temperature=0.7, max_tokens=250)
        self.assertIsNotNone(llm)
        self.assertEqual(llm.model_name, "meta-llama/llama-3.1-8b-instruct")
        self.assertEqual(str(llm.openai_api_base), "https://openrouter.ai/api/v1")

    def test_llm_creation_missing_api_key_returns_none(self):
        # When OPENROUTER_API_KEY is not set or empty
        os.environ.pop("OPENROUTER_API_KEY", None)
        llm = _create_speaking_llm()
        self.assertIsNone(llm)

    def test_roleplay_fallback_when_openrouter_key_absent(self):
        os.environ.pop("OPENROUTER_API_KEY", None)
        request = RoleplayTurnRequest(
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            ai_role="Front Desk Receptionist",
            learner_role="Hotel Guest",
            learner_goal="Check in",
            learner_transcript="I have a reservation under John Doe.",
            target_vocabulary=["reservation", "amenities"]
        )

        response = run_roleplay_turn_workflow(request)
        self.assertTrue(response.is_mocked)
        self.assertIn("reservation", response.target_vocabulary_detected)
        self.assertIn("Certainly!", response.assistant_text)

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_roleplay_success_with_valid_text(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = RoleplayTurnResponse(
            assistant_text="Welcome to our hotel, Mr. Doe! May I see your ID?",
            target_vocabulary_detected=[],
            task_completed=False,
            is_mocked=False
        )
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = RoleplayTurnRequest(
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            ai_role="Front Desk Receptionist",
            learner_role="Hotel Guest",
            learner_goal="Check in",
            learner_transcript="I have a reservation.",
            target_vocabulary=["reservation"]
        )

        response = run_roleplay_turn_workflow(request)
        self.assertFalse(response.is_mocked)
        self.assertEqual(response.assistant_text, "Welcome to our hotel, Mr. Doe! May I see your ID?")
        self.assertFalse(response.task_completed)
        self.assertIn("reservation", response.target_vocabulary_detected)

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_roleplay_fallback_when_provider_returns_empty_string(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = RoleplayTurnResponse(
            assistant_text="",
            target_vocabulary_detected=[],
            task_completed=False,
            is_mocked=False
        )
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = RoleplayTurnRequest(
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            ai_role="Front Desk Receptionist",
            learner_role="Hotel Guest",
            learner_goal="Check in",
            learner_transcript="I have a reservation.",
            target_vocabulary=["reservation"]
        )

        response = run_roleplay_turn_workflow(request)
        self.assertTrue(response.is_mocked)
        self.assertTrue(len(response.assistant_text) > 0)
        self.assertIn("reservation", response.target_vocabulary_detected)
        self.assertIn("Certainly!", response.assistant_text)

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_roleplay_fallback_when_provider_returns_whitespace_only(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = RoleplayTurnResponse(
            assistant_text="   \n\t  ",
            target_vocabulary_detected=[],
            task_completed=False,
            is_mocked=False
        )
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = RoleplayTurnRequest(
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            ai_role="Front Desk Receptionist",
            learner_role="Hotel Guest",
            learner_goal="Check in",
            learner_transcript="I have a reservation.",
            target_vocabulary=["reservation"]
        )

        response = run_roleplay_turn_workflow(request)
        self.assertTrue(response.is_mocked)
        self.assertTrue(len(response.assistant_text.strip()) > 0)
        self.assertIn("reservation", response.target_vocabulary_detected)
        self.assertIn("Certainly!", response.assistant_text)

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_roleplay_fallback_on_provider_exception(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.side_effect = Exception("OpenRouter 429 Rate Limit Exceeded")
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = RoleplayTurnRequest(
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            ai_role="Front Desk Receptionist",
            learner_role="Hotel Guest",
            learner_goal="Check in",
            learner_transcript="I have a reservation.",
            target_vocabulary=["reservation"]
        )

        response = run_roleplay_turn_workflow(request)
        self.assertTrue(response.is_mocked)
        self.assertIn("reservation", response.target_vocabulary_detected)
        self.assertTrue(len(response.assistant_text) > 0)

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_feedback_success_with_openrouter(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.return_value = TurnFeedbackResponse(
            corrections=[
                TurnCorrectionItem(
                    type="GRAMMAR",
                    original="have reservation",
                    suggestion="have a reservation",
                    explanation="Missing article 'a'",
                    priority="MEDIUM"
                )
            ],
            positive_feedback="Great clarity!",
            summary="Clear sentence.",
            is_mocked=False
        )
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = TurnFeedbackRequest(
            learner_transcript="I have reservation.",
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            target_vocabulary=["reservation"]
        )

        response = run_turn_feedback_workflow(request)
        self.assertFalse(response.is_mocked)
        self.assertEqual(len(response.corrections), 1)
        self.assertEqual(response.corrections[0].original, "have reservation")

    @patch("app.workflows.speaking_workflow._create_speaking_llm")
    def test_feedback_fallback_on_openrouter_failure(self, mock_create_llm):
        mock_llm = MagicMock()
        mock_structured = MagicMock()
        mock_structured.invoke.side_effect = Exception("OpenRouter 503 Service Unavailable")
        mock_llm.with_structured_output.return_value = mock_structured
        mock_create_llm.return_value = mock_llm

        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-testkey"
        request = TurnFeedbackRequest(
            learner_transcript="I have reservation.",
            scenario_title="Hotel Check-in",
            cefr_level="B1",
            target_vocabulary=["reservation"]
        )

        response = run_turn_feedback_workflow(request)
        self.assertTrue(response.is_mocked)
        self.assertLessEqual(len(response.corrections), 2)
        self.assertIsNotNone(response.positive_feedback)

if __name__ == "__main__":
    unittest.main()
