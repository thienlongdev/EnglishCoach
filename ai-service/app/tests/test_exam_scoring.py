import unittest
from app.domain.schemas.exams import ExamScoringRequest, ExamScoringResponse
from app.services.exams.pipeline import execute_exam_scoring_stage
from app.services.exams.ielts_writing import evaluate_ielts_writing
from app.services.exams.toeic_writing import evaluate_toeic_writing


class TestExamScoring(unittest.TestCase):

    def test_ielts_writing_short_response(self):
        req = ExamScoringRequest(
            stageKey="STAGE_WRITING",
            family="IELTS",
            skill="WRITING",
            taskType="TASK_2",
            promptText="Discuss both views and give your opinion.",
            responseText="Hello world.",
            rubricCriteria={}
        )
        res = evaluate_ielts_writing(req)
        self.assertFalse(res.success)
        self.assertIsNone(res.overallBand)
        self.assertTrue(res.reviewRequired)
        self.assertIsNotNone(res.abstention)
        self.assertEqual(res.abstention.get("reason"), "MIN_WRITING_INSUFFICIENT")
        self.assertIsNotNone(res.evidenceHash)
        self.assertIsNotNone(res.outputHash)

    def test_toeic_writing_short_response(self):
        req = ExamScoringRequest(
            stageKey="STAGE_WRITING",
            family="TOEIC",
            skill="WRITING",
            taskType="ESSAY",
            promptText="Do you agree or disagree?",
            responseText="No.",
            rubricCriteria={}
        )
        res = evaluate_toeic_writing(req)
        self.assertTrue(res.success)
        self.assertEqual(res.overallBand, 0.0)
        self.assertEqual(len(res.criteria), 3)
        criteria_names = {c.criterion for c in res.criteria}
        self.assertIn("TASK_COMPLIANCE", criteria_names)

    def test_pipeline_rejects_invalid_family(self):
        req = ExamScoringRequest(
            stageKey="STAGE_WRITING",
            family="TOEFL",  # Locked architecture: only IELTS and TOEIC!
            skill="WRITING",
            promptText="Essay",
            responseText="Valid response text here..."
        )
        with self.assertRaises(ValueError):
            execute_exam_scoring_stage(req)

    def test_pipeline_rejects_invalid_skill(self):
        req = ExamScoringRequest(
            stageKey="STAGE_MATH",
            family="IELTS",
            skill="MATHEMATICS",
            promptText="Solve for x",
            responseText="x = 5"
        )
        with self.assertRaises(ValueError):
            execute_exam_scoring_stage(req)


if __name__ == "__main__":
    unittest.main()
