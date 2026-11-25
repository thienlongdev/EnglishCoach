import unittest
from unittest.mock import MagicMock, patch
from app.domain.schemas.exams import ExamScoringRequest, ExamScoringResponse
from app.services.exams.ielts_writing import (
    evaluate_ielts_writing,
    compute_writing_evidence_hash,
    round_ielts_quarter_boundary
)


class TestExamWritingProvenanceAndScoring(unittest.TestCase):

    def test_short_writing_abstains_honestly_never_1_or_0(self):
        """Short writing (< 20 words) must honestly abstain, never returning 1.0 or 0.0."""
        cases = [
            "",
            "   ",
            "I agree with the statement completely.",  # 6 words
            "In modern society, education is very important because it helps people get jobs and understand the world better today.",  # 19 words
        ]

        for text in cases:
            req = ExamScoringRequest(
                stageKey="STAGE_WRITING",
                family="IELTS",
                skill="WRITING",
                taskType="TASK_2",
                promptText="Some people think universities should provide graduates with knowledge and skills needed in the workplace. Others think the true function of a university should be to give access to knowledge for its own sake. Discuss both views and give your opinion.",
                responseText=text
            )
            res = evaluate_ielts_writing(req)

            self.assertFalse(res.success, f"Short writing should not be marked success: '{text}'")
            self.assertIsNone(res.overallBand, f"Short writing must have overallBand=None (never 1.0 or 0.0): '{text}'")
            self.assertTrue(res.reviewRequired, "Short writing must require human review")
            self.assertEqual(len(res.criteria), 0, "Abstained writing must emit empty criteria scores")
            self.assertIsNotNone(res.abstention)
            self.assertEqual(res.abstention.get("reason"), "MIN_WRITING_INSUFFICIENT")
            self.assertIsNotNone(res.evidenceHash)
            self.assertEqual(len(res.evidenceHash), 64)
            self.assertIsNotNone(res.outputHash)
            self.assertEqual(len(res.outputHash), 64)

    @patch("app.services.exams.ielts_writing.get_llm")
    def test_missing_provider_abstains_honestly_never_0_or_1(self, mock_get_llm):
        """When AI provider is unavailable, scoring must honestly abstain rather than returning 0.0 or 1.0."""
        mock_get_llm.return_value = None

        long_text = " ".join(["Education"] * 80)
        req = ExamScoringRequest(
            stageKey="STAGE_WRITING",
            family="IELTS",
            skill="WRITING",
            taskType="TASK_2",
            promptText="Discuss both views and give your opinion.",
            responseText=long_text
        )
        res = evaluate_ielts_writing(req)

        self.assertFalse(res.success)
        self.assertIsNone(res.overallBand, "Missing provider must result in overallBand=None (never 0.0 or 1.0)")
        self.assertTrue(res.reviewRequired)
        self.assertEqual(len(res.criteria), 0)
        self.assertIsNotNone(res.abstention)
        self.assertEqual(res.abstention.get("reason"), "PROVIDER_UNAVAILABLE")
        self.assertIsNotNone(res.evidenceHash)
        self.assertEqual(len(res.evidenceHash), 64)
        self.assertIsNotNone(res.outputHash)
        self.assertEqual(len(res.outputHash), 64)

    @patch("app.services.exams.ielts_writing.get_llm")
    def test_task_2_double_weighting_truthfulness(self, mock_get_llm):
        """Task 2 contributes 2/3 and Task 1 contributes 1/3 to the overall IELTS Writing band."""
        mock_llm = MagicMock()
        mock_get_llm.return_value = mock_llm

        import json
        sample = " ".join(["Students can use this library to study in the evening."] * 3)
        tasks = [{"taskType": f"TASK_{i}", "response": sample, "prompt": "Describe the library."} for i in (1, 2)]
        rows = []
        for i, score in [(1, 6), (2, 7.5)]:
            names = ["TASK_ACHIEVEMENT" if i == 1 else "TASK_RESPONSE", "COHERENCE_COHESION", "LEXICAL_RESOURCE", "GRAMMATICAL_RANGE"]
            rows.append({"taskType": f"TASK_{i}", "criteria": [{"criterion": n, "score": score,
                         "evidence": ["use this library"], "feedback": "Uses a concrete example."} for n in names]})
        # Both provider encodings carry the same four named criteria. A conflicting name is rejected.
        rows[0]["criteria"] = {row["criterion"]: row for row in rows[0]["criteria"]}
        req = ExamScoringRequest(stageKey="WRITING", family="IELTS", skill="WRITING", rubricCriteria={"tasks": tasks})
        mock_llm.invoke.side_effect = [MagicMock(content=json.dumps(row), response_metadata={}) for row in rows]
        result = evaluate_ielts_writing(req)
        self.assertTrue(result.success)
        self.assertEqual(result.overallBand, 7.0)
        self.assertEqual(len(result.criteria), 8)
        rows[1]["criteria"][0]["evidence"] = ["invented quotation"]
        mock_llm.invoke.side_effect = [MagicMock(content=json.dumps(row), response_metadata={}) for row in rows]
        self.assertIsNone(evaluate_ielts_writing(req).overallBand)

    def test_writing_provenance_hashes_deterministic(self):
        """evidenceHash and outputHash must be deterministic 64-character SHA-256 digests."""
        prompt = "Some people think that universities should focus on practical skills."
        resp = "In recent times, the primary role of tertiary educational institutions has become a subject of great debate. Many assert that universities should prioritize vocational training."

        hash1 = compute_writing_evidence_hash(prompt, resp, "STAGE_WRITING", "TASK_2")
        hash2 = compute_writing_evidence_hash(prompt, resp, "STAGE_WRITING", "TASK_2")
        self.assertEqual(hash1, hash2)
        self.assertEqual(len(hash1), 64)

        # Modifying prompt or response must alter the evidence hash
        hash_diff_prompt = compute_writing_evidence_hash("Different prompt text", resp, "STAGE_WRITING", "TASK_2")
        self.assertNotEqual(hash1, hash_diff_prompt)

        hash_diff_resp = compute_writing_evidence_hash(prompt, "Different response text completely.", "STAGE_WRITING", "TASK_2")
        self.assertNotEqual(hash1, hash_diff_resp)

    @patch("app.services.exams.ielts_writing.get_llm")
    def test_provider_error_withholds_score(self, mock_get_llm):
        """When LLM provider raises an exception, the judge returns review without a score."""
        mock_llm = MagicMock()
        mock_get_llm.return_value = mock_llm
        mock_llm.invoke.side_effect = RuntimeError("OpenRouter 429 Rate Limit Exceeded")

        paragraphs = [
            "In recent decades, higher education has been viewed as a stepping stone toward professional success.",
            "Furthermore, university education provides specialized knowledge that cannot be easily obtained elsewhere.",
            "In conclusion, while practical experience is valuable, academic foundations remain essential for career development."
        ]
        essay = "\n\n".join(paragraphs)

        req = ExamScoringRequest(
            stageKey="STAGE_WRITING",
            family="IELTS",
            skill="WRITING",
            taskType="TASK_2",
            promptText="Discuss the importance of universities.",
            responseText=essay
        )
        res = evaluate_ielts_writing(req)

        self.assertFalse(res.success)
        self.assertTrue(res.reviewRequired)
        self.assertIsNone(res.overallBand)
        self.assertFalse(res.criteria)
        self.assertIsNotNone(res.evidenceHash)
        self.assertIsNotNone(res.outputHash)


if __name__ == "__main__":
    unittest.main()
