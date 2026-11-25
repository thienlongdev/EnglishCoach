from __future__ import annotations

import json
import logging
from typing import Any, Dict
from app.domain.schemas.exams import CriterionScore, ExamScoringRequest, ExamScoringResponse
from app.services.exams.prompts import TOEIC_WRITING_SYSTEM_PROMPT
from app.services.llm_provider import get_llm

logger = logging.getLogger("toeic_writing")


def evaluate_toeic_writing(request: ExamScoringRequest) -> ExamScoringResponse:
    text = (request.responseText or "").strip()
    words = text.split()
    word_count = len(words)

    if word_count < 5:
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=True,
            overallBand=0.0,
            criteria=[
                CriterionScore(criterion="TASK_COMPLIANCE", score=0.0, feedback="Insufficient text provided.", evidence=[]),
                CriterionScore(criterion="GRAMMATICAL_ACCURACY", score=0.0, feedback="No sentences produced.", evidence=[]),
                CriterionScore(criterion="ORGANIZATION_VOCABULARY", score=0.0, feedback="No vocabulary demonstrated.", evidence=[])
            ],
            telemetry={"wordCount": word_count},
            reviewerNotes="Candidate provided fewer than 5 words. Scaled score 0/200.",
            reviewRequired=False
        )

    llm = get_llm(temperature=0.1, max_tokens=1500, exam_mode=True)
    if not llm:
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=0.0,
            criteria=[],
            telemetry={"wordCount": word_count},
            reviewerNotes="Scoring provider unavailable.",
            reviewRequired=True,
            errorMessage="AI LLM provider not configured or available."
        )

    user_prompt = f"""TOEIC Writing Task:
{request.promptText or 'TOEIC Writing Task'}

Candidate Text (Word count: {word_count}):
{text}
"""

    try:
        from langchain_core.messages import SystemMessage, HumanMessage
        messages = [
            SystemMessage(content=TOEIC_WRITING_SYSTEM_PROMPT),
            HumanMessage(content=user_prompt)
        ]

        ai_msg = llm.invoke(messages)
        content = ai_msg.content if hasattr(ai_msg, "content") else str(ai_msg)

        raw = content.strip()
        if "```json" in raw:
            raw = raw.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in raw:
            raw = raw.split("```", 1)[1].split("```", 1)[0].strip()

        data = json.loads(raw)

        criteria_list = []
        for c in data.get("criteria", []):
            criteria_list.append(CriterionScore(
                criterion=str(c.get("criterion", "TASK")),
                score=float(c.get("score", 50.0)),
                feedback=c.get("feedback"),
                evidence=c.get("evidence", [])
            ))

        raw_score = float(data.get("overallBand", 120.0))
        # TOEIC Writing scaled score: 0 to 200 in increments of 10
        scaled_score = min(200.0, max(0.0, round(raw_score / 10.0) * 10.0))

        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=True,
            overallBand=scaled_score,
            criteria=criteria_list,
            telemetry={"wordCount": word_count, "model": "official-toeic-writing-judge-v1"},
            reviewerNotes=data.get("reviewerNotes", "Automated TOEIC Writing scoring complete."),
            reviewRequired=False
        )
    except Exception as exc:
        logger.error(f"TOEIC Writing evaluation failed: {exc}", exc_info=True)
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=0.0,
            criteria=[],
            telemetry={"wordCount": word_count},
            reviewerNotes=f"Evaluation failed: {str(exc)}",
            reviewRequired=True,
            errorMessage=str(exc)
        )
