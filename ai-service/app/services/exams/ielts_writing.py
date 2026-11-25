"""IELTS practice estimates for separately identified tasks with verifiable text evidence."""
import json
import logging
import re

from app.domain.schemas.exams import CriterionScore, ExamScoringRequest, ExamScoringResponse
from app.services.exams.evidence_contract import compute_output_hash, compute_writing_evidence_hash
from app.services.exams.prompts import IELTS_WRITING_SYSTEM_PROMPT
from app.services.llm_provider import get_llm

logger = logging.getLogger(__name__)


def round_ielts_quarter_boundary(score: float) -> float:
    return int(score * 2 + 0.5) / 2


def evaluate_ielts_writing(request: ExamScoringRequest) -> ExamScoringResponse:
    tasks = (request.rubricCriteria or {}).get("tasks")
    if tasks is None:
        tasks = [{"taskType": request.taskType, "prompt": request.promptText or "",
                  "response": (request.responseText or "").strip()}]
    evidence_hash = compute_writing_evidence_hash(
        request.promptText, json.dumps(tasks, ensure_ascii=False, sort_keys=True), request.stageKey, request.taskType)

    def abstain(reason):
        logger.info("Writing assessment withheld: %s", reason)
        return ExamScoringResponse(stageKey=request.stageKey, success=False, reviewRequired=True,
                                   abstention={"reason": reason}, evidenceHash=evidence_hash,
                                   outputHash=compute_output_hash(request.stageKey, None, [], evidence_hash))

    if not isinstance(tasks, list) or len(tasks) not in (1, 2) or not all(isinstance(t, dict) for t in tasks):
        return abstain("INVALID_TASK_SET")
    if any(not isinstance(t.get("response"), str) or len(t["response"].split()) < 20 for t in tasks):
        return abstain("MIN_WRITING_INSUFFICIENT")
    kinds = [t.get("taskType") for t in tasks]
    if kinds not in (["TASK_1"], ["TASK_2"], ["TASK_1", "TASK_2"]) or any(not t.get("prompt") for t in tasks):
        return abstain("MISSING_TASK_OR_PROMPT")
    try:
        judge = get_llm(exam_mode=True, temperature=0, max_tokens=1600, timeout=75, max_retries=0)
        if not judge:
            return abstain("PROVIDER_UNAVAILABLE")
        from langchain_core.messages import HumanMessage, SystemMessage
        passages = [re.split(r"(?<=[.!?])\s+|\n+", t["response"].strip()) for t in tasks]
        inputs = [{"taskType": t["taskType"], "variant": t.get("variant"), "prompt": t["prompt"],
                   "sentences": {str(i): line for i, line in enumerate(lines, 1)}} for t, lines in zip(tasks, passages)]
        assessments = []
        for item in inputs:
            output = judge.invoke([SystemMessage(content=IELTS_WRITING_SYSTEM_PROMPT),
                                   HumanMessage(content=json.dumps(item, ensure_ascii=False))], stop=["</assessment>"])
            if output.response_metadata.get("finish_reason") == "length":
                return abstain("INCOMPLETE_PROVIDER_RESPONSE")
            content = output.content.strip().removesuffix("</assessment>").rstrip()
            if content.startswith("```json") and content.endswith("```"):
                content = content[7:-3].strip()
            assessments.append(json.loads(content))
        criteria = []
        bands = {}
        for task, assessment, lines in zip(tasks, assessments, passages):
            kind = task["taskType"]
            if not isinstance(assessment, dict) or assessment.get("taskType") != kind:
                return abstain("TASK_ID_MISMATCH")
            expected = {"TASK_ACHIEVEMENT" if kind == "TASK_1" else "TASK_RESPONSE", "COHERENCE_COHESION",
                        "LEXICAL_RESOURCE", "GRAMMATICAL_RANGE"}
            rows = assessment.get("criteria") if isinstance(assessment, dict) else None
            if isinstance(rows, dict):
                if set(rows) != expected or not all(isinstance(row, dict) and row.get("criterion", name) == name
                                                     for name, row in rows.items()):
                    return abstain("INCOMPLETE_CRITERIA")
                rows = [dict(row, criterion=name) for name, row in rows.items()]
            if not isinstance(rows, list) or len(rows) != 4 or not all(isinstance(row, dict) for row in rows) or {row.get("criterion") for row in rows} != expected:
                return abstain("INCOMPLETE_CRITERIA")
            scores = []
            for row in rows:
                score = row["score"]
                if type(score) not in (int, float) or not 1 <= score <= 9 or score * 2 != int(score * 2):
                    return abstain("INVALID_CRITERION_SCORE")
                refs = row.get("sentenceIds")
                if refs is not None:
                    if not isinstance(refs, list) or not 1 <= len(refs) <= 3 or not all(type(i) is int and 1 <= i <= len(lines) for i in refs):
                        return abstain("UNSUPPORTED_EVIDENCE")
                    quotes = [lines[i - 1] for i in dict.fromkeys(refs)]
                else:
                    quotes = row.get("evidence")
                if not isinstance(quotes, list) or not quotes or not all(isinstance(q, str) and q.strip() and q in task["response"] for q in quotes):
                    return abstain("UNSUPPORTED_EVIDENCE")
                feedback = row["feedback"]
                if not isinstance(feedback, str) or not feedback.strip():
                    return abstain("MISSING_FEEDBACK")
                scores.append(score)
                criteria.append(CriterionScore(criterion=kind + "_" + row["criterion"], score=score,
                                               evidence=quotes, feedback=feedback))
            bands[kind] = sum(scores) / 4
        weighted = (bands["TASK_1"] + 2 * bands["TASK_2"]) / 3 if len(tasks) == 2 else next(iter(bands.values()))
        overall = round_ielts_quarter_boundary(weighted)
        facts = [{"criterion": c.criterion, "score": c.score} for c in criteria]
        telemetry = {"model": str(getattr(judge, "model_name", "unknown")), "rubricVersion": "ielts-writing-task-v1",
                     "canonicalWritingBand": overall, "task2DoubleWeight": len(tasks) == 2,
                     "assessmentType": "PRACTICE_ESTIMATE", "calculationVersion": "ielts-writing-task-v1"}
        for kind, band in bands.items():
            telemetry["task1Band" if kind == "TASK_1" else "task2Band"] = round_ielts_quarter_boundary(band)
        return ExamScoringResponse(stageKey=request.stageKey, success=True, overallBand=overall, criteria=criteria,
                                   evidenceHash=evidence_hash, outputHash=compute_output_hash(request.stageKey, overall, facts, evidence_hash),
                                   telemetry=telemetry, reviewerNotes="AI practice estimate")
    except Exception as exc:
        import traceback
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        logger.warning("Writing assessment unavailable (%s at %s:%s)", type(exc).__name__, frame.name, frame.lineno)
        return abstain("PROVIDER_OR_ASSESSMENT_INVALID")
