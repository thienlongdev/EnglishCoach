"""Unit tests for whole-paragraph translation grading workflow."""

import unittest
from unittest.mock import patch, MagicMock

from app.domain.schemas.writing import (
    TranslationParagraphGradeRequest,
    TranslationParagraphGradeResponse,
)
from app.workflows.translation_paragraph_workflow import (
    _build_paragraph_prompt,
    _clean_json_output,
    _validate_and_anchor_issues,
    _parse_paragraph_response,
    grade_paragraph_translation,
)


class TestTranslationParagraphWorkflow(unittest.TestCase):

    def setUp(self):
        self.req = TranslationParagraphGradeRequest(
            source_vi="Đại học Carnegie Mellon là một trường đại học nghiên cứu tư thục ở Pittsburgh, Pennsylvania.",
            reference_en="Carnegie Mellon University is a private research university in Pittsburgh, Pennsylvania.",
            submitted_en="Carnegie Mellon University is a private research university located in Pittsburgh, Pennsylvania.",
            genre="GENERAL",
            topic="EDUCATION",
        )

    def test_build_paragraph_prompt_contains_five_dimensions(self):
        prompt = _build_paragraph_prompt(self.req)
        self.assertIn("1. MEANING", prompt)
        self.assertIn("2. GRAMMAR", prompt)
        self.assertIn("3. NATURALNESS", prompt)
        self.assertIn("4. VOCABULARY & COLLOCATION", prompt)
        self.assertIn("5. COHESION", prompt)
        self.assertIn(self.req.source_vi, prompt)
        self.assertIn(self.req.reference_en, prompt)
        self.assertIn(self.req.submitted_en, prompt)

    def test_clean_json_output_with_thought_and_markdown(self):
        raw = """<thought>Evaluating translation...</thought>
```json
{
  "meaning_verdict": "ACCURATE",
  "grammar_verdict": "ACCURATE",
  "naturalness_verdict": "NATURAL",
  "vocabulary_verdict": "ACCURATE",
  "cohesion_verdict": "COHESIVE",
  "overall_status": "ACCEPTED",
  "accepted": true,
  "headline_summary": "Bản dịch rất tốt.",
  "issues": []
}
```"""
        data = _clean_json_output(raw)
        self.assertEqual(data["overall_status"], "ACCEPTED")
        self.assertTrue(data["accepted"])

    def test_validate_and_anchor_issues_reanchors_matching_text(self):
        submitted = "Carnegie Mellon University is a private research university located in Pittsburgh, Pennsylvania."
        raw_issues = [
            {
                "offset_start": 999,  # Wrong offset provided by LLM
                "offset_end": 1005,
                "flagged_text": "located in",
                "category": "STYLE",
                "severity": "STYLE",
                "message": "Từ 'located in' có thể lược bỏ để câu văn ngắn gọn hơn.",
                "suggestion": "in",
            },
            {
                "offset_start": 0,
                "offset_end": 10,
                "flagged_text": "nonexistent text",
                "category": "GRAMMAR",
                "severity": "IMPROVEMENT",
                "message": "Không tìm thấy trong bài.",
                "suggestion": None,
            }
        ]
        issues = _validate_and_anchor_issues(raw_issues, submitted)
        self.assertEqual(len(issues), 2)

        # First issue re-anchored to real location of 'located in'
        self.assertEqual(issues[0].flagged_text, "located in")
        self.assertEqual(submitted[issues[0].offset_start:issues[0].offset_end], "located in")

        # Second issue unanchored (0, 0) to avoid false highlighting
        self.assertEqual(issues[1].offset_start, 0)
        self.assertEqual(issues[1].offset_end, 0)

    def test_parse_paragraph_response_style_only_does_not_block_acceptance(self):
        data = {
            "meaning_verdict": "ACCURATE",
            "grammar_verdict": "ACCURATE",
            "naturalness_verdict": "NATURAL",
            "vocabulary_verdict": "ACCURATE",
            "cohesion_verdict": "COHESIVE",
            "overall_status": "NEEDS_REVISION",  # LLM erroneously tried to fail on style
            "accepted": False,
            "headline_summary": "Bản dịch tốt nhưng có góp ý phong cách.",
            "issues": [
                {
                    "offset_start": 0,
                    "offset_end": 5,
                    "flagged_text": "Carnegie",
                    "category": "NATURALNESS",
                    "severity": "STYLE",
                    "message": "Phong cách có thể trau chuốt hơn.",
                }
            ]
        }
        res = _parse_paragraph_response(data, self.req.submitted_en)
        # Invariant: Style-only issues must NOT block acceptance
        self.assertTrue(res.accepted)
        self.assertEqual(res.overall_status, "ACCEPTED")

    def test_parse_paragraph_response_blocking_error_fails(self):
        data = {
            "meaning_verdict": "INACCURATE",
            "grammar_verdict": "ACCURATE",
            "naturalness_verdict": "ACCEPTABLE",
            "vocabulary_verdict": "ACCURATE",
            "cohesion_verdict": "COHESIVE",
            "overall_status": "NEEDS_REVISION",
            "accepted": False,
            "headline_summary": "Thiếu thông tin quan trọng.",
            "issues": [
                {
                    "offset_start": 0,
                    "offset_end": 10,
                    "flagged_text": "Carnegie",
                    "category": "MEANING",
                    "severity": "ERROR",
                    "message": "Sai lệch ý nghĩa.",
                }
            ]
        }
        res = _parse_paragraph_response(data, self.req.submitted_en)
        self.assertFalse(res.accepted)
        self.assertEqual(res.overall_status, "NEEDS_REVISION")

    @patch("app.workflows.translation_paragraph_workflow.get_llm")
    def test_technical_failure_returns_uncertain(self, mock_get_llm):
        mock_get_llm.side_effect = RuntimeError("Provider connection timeout")

        res = grade_paragraph_translation(self.req)
        self.assertEqual(res.overall_status, "UNCERTAIN")
        self.assertIsNone(res.accepted)
        self.assertIn("Hệ thống chấm AI tạm thời gián đoạn", res.headline_summary)


if __name__ == "__main__":
    unittest.main()
