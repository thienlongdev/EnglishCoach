from __future__ import annotations

import logging
from app.domain.schemas.exams import ExamScoringRequest, ExamScoringResponse
from app.services.exams.ielts_writing import evaluate_ielts_writing
from app.services.exams.ielts_speaking import evaluate_ielts_speaking
from app.services.exams.toeic_writing import evaluate_toeic_writing
from app.services.exams.toeic_speaking import evaluate_toeic_speaking

logger = logging.getLogger("exam_pipeline")


def execute_exam_scoring_stage(request: ExamScoringRequest) -> ExamScoringResponse:
    family = (request.family or "").strip().upper()
    skill = (request.skill or "").strip().upper()

    logger.info(f"Executing exam scoring stage {request.stageKey} for family {family} skill {skill}")

    # Architectural invariant: IELTS and TOEIC judges are completely isolated
    if family == "IELTS":
        if skill == "WRITING":
            return evaluate_ielts_writing(request)
        elif skill == "SPEAKING":
            return evaluate_ielts_speaking(request)
        else:
            raise ValueError(f"Unsupported IELTS productive skill: {skill}")
    elif family == "TOEIC":
        if skill == "WRITING":
            return evaluate_toeic_writing(request)
        elif skill == "SPEAKING":
            return evaluate_toeic_speaking(request)
        else:
            raise ValueError(f"Unsupported TOEIC productive skill: {skill}")
    else:
        raise ValueError(f"Unsupported examination family: {family}")
