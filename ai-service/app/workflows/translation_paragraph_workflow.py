"""
Whole-Paragraph Translation Grading Workflow.
Evaluates coherent paragraph translation across 5 dimensions:
1. Meaning (fidelity, omission, hallucination, subject/object, negation)
2. Grammar (morphology, agreement, clause structure)
3. Naturalness (idiomatic English phrasing, natural register)
4. Vocabulary & Collocation (context-appropriate lexical selections)
5. Cohesion (cross-sentence continuity, anaphoric references, logical connectors)
"""

import json
import logging
import os
import re
from typing import Optional, List, Dict, Any

from app.domain.schemas.writing import (
    TranslationParagraphGradeRequest,
    TranslationParagraphGradeResponse,
    TranslationParagraphIssueItem,
)
from app.services.llm_provider import get_llm

logger = logging.getLogger(__name__)

PRIMARY_PARAGRAPH_MODEL = os.getenv("TRANSLATION_PARAGRAPH_PRIMARY_MODEL", os.getenv("TRANSLATION_PRIMARY_MODEL", "openai/gpt-5.6-luna")).strip()
FALLBACK_PARAGRAPH_MODEL = os.getenv("TRANSLATION_PARAGRAPH_FALLBACK_MODEL", os.getenv("TRANSLATION_FALLBACK_MODEL", "deepseek/deepseek-v3.2")).strip()


def _clean_json_output(raw: str) -> dict:
    if not raw or not raw.strip():
        raise ValueError("Empty response from LLM")
    text = raw.strip()
    text = re.sub(r"<(thought|reasoning)>.*?</\1>", "", text, flags=re.DOTALL).strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()

    start_idx = text.find("{")
    if start_idx != -1:
        decoder = json.JSONDecoder()
        obj, _ = decoder.raw_decode(text[start_idx:])
        if isinstance(obj, dict):
            return obj
    raise ValueError(f"Could not parse valid JSON object from LLM response: {raw[:200]}")


def _build_paragraph_prompt(req: TranslationParagraphGradeRequest) -> str:
    genre_guidance = ""
    if req.genre and req.genre != "GENERAL":
        genre_guidance = f"\nGenre Context: {req.genre}. Consider appropriate genre register and conventions."

    return f"""You are an expert bilingual English-Vietnamese writing evaluator specializing in whole-paragraph translation assessment.
Evaluate the learner's English translation of the Vietnamese source paragraph across 5 core dimensions:
1. MEANING: Complete fidelity, accurate propositions, no omitted core facts, no hallucinated additions, correct negation and subject-verb-object relationships.
2. GRAMMAR: Accurate morphology, verb tense/aspect consistency, agreement, and proper clause coordination.
3. NATURALNESS: Idiomatic phrasing and natural native English flow rather than word-for-word literal translation.
4. VOCABULARY & COLLOCATION: Fluent collocations and authentic lexical choices.
5. COHESION: Inter-sentence consistency, clear pronoun/anaphoric reference resolution, smooth discourse markers, and logical transitions between ideas.{genre_guidance}

CRITICAL RUBRIC RULES:
1. VALID ALTERNATIVES MUST BE ACCEPTED: Legitimate paraphrases, reordered clauses, and valid synonyms that preserve original meaning must be marked ACCEPTED (accepted=true, overall_status="ACCEPTED"). Do NOT require identical wording to the reference answer.
2. ONLY SUBSTANTIVE ERRORS BLOCK ACCEPTANCE:
   - Severity ERROR: Blocks acceptance (missing meaning, distorted facts, broken grammar, wrong negation).
   - Severity IMPROVEMENT: Constructive suggestions for better word choice or flow. Does NOT block acceptance.
   - Severity STYLE: Minor stylistic preference or elegance polishing. Does NOT block acceptance.
   If all issues are only IMPROVEMENT or STYLE, the translation MUST be marked ACCEPTED (accepted=true).
3. ISSUE SPANS MUST BE ACCURATE:
   - Provide exact 'offset_start' and 'offset_end' referring to the learner's submitted English text.
   - 'flagged_text' must be the exact substring at those offsets. If you cannot specify precise character offsets, leave offsets 0.
4. FEEDBACK LANGUAGE: All explanations, suggestions, and headline summaries must be in encouraging, professional Vietnamese.

Vietnamese Source Paragraph:
\"\"\"{req.source_vi}\"\"\"

Reference English Translation:
\"\"\"{req.reference_en}\"\"\"

Learner's Submitted English Translation:
\"\"\"{req.submitted_en}\"\"\"

Return strictly valid JSON in this exact structure:
{{
  "meaning_verdict": "ACCURATE" | "MINOR_ISSUES" | "INACCURATE",
  "grammar_verdict": "ACCURATE" | "MINOR_ISSUES" | "INCORRECT",
  "naturalness_verdict": "NATURAL" | "ACCEPTABLE" | "UNNATURAL",
  "vocabulary_verdict": "ACCURATE" | "ACCEPTABLE" | "INACCURATE",
  "cohesion_verdict": "COHESIVE" | "ACCEPTABLE" | "DISJOINTED",
  "overall_status": "ACCEPTED" | "NEEDS_REVISION",
  "accepted": true | false,
  "headline_summary": "1-2 concise sentences in Vietnamese summarizing the overall assessment",
  "natural_suggestion": "An optional natural polished full paragraph alternative",
  "issues": [
    {{
      "offset_start": 0,
      "offset_end": 10,
      "flagged_text": "exact substring in submitted text",
      "category": "MEANING" | "GRAMMAR" | "NATURALNESS" | "VOCABULARY" | "COHESION",
      "severity": "ERROR" | "IMPROVEMENT" | "STYLE",
      "message": "Clear explanation in Vietnamese",
      "suggestion": "Specific correction or improved phrase"
    }}
  ]
}}"""


def _validate_and_anchor_issues(raw_issues: list, submitted_text: str) -> List[TranslationParagraphIssueItem]:
    validated = []
    text_len = len(submitted_text)

    for item in raw_issues:
        if not isinstance(item, dict):
            continue

        category = str(item.get("category", "GRAMMAR")).upper()
        if category not in ("MEANING", "GRAMMAR", "NATURALNESS", "VOCABULARY", "COHESION"):
            category = "GRAMMAR"

        severity = str(item.get("severity", "ERROR")).upper()
        if severity not in ("ERROR", "IMPROVEMENT", "STYLE"):
            severity = "ERROR"

        message = str(item.get("message", "Cần xem lại cụm từ này."))
        suggestion = item.get("suggestion")
        flagged_text = str(item.get("flagged_text", ""))

        start = int(item.get("offset_start", 0))
        end = int(item.get("offset_end", 0))

        # Validate offsets
        if 0 <= start < end <= text_len and submitted_text[start:end] == flagged_text:
            validated.append(TranslationParagraphIssueItem(
                offset_start=start,
                span_start=start,
                offset_end=end,
                span_end=end,
                flagged_text=flagged_text,
                learner_span=flagged_text,
                category=category,
                dimension=category,
                severity=severity,
                issue_type=severity,
                message=message,
                suggestion=suggestion,
            ))
        elif flagged_text and flagged_text in submitted_text:
            # Try to re-anchor by exact text match
            re_start = submitted_text.find(flagged_text)
            re_end = re_start + len(flagged_text)
            validated.append(TranslationParagraphIssueItem(
                offset_start=re_start,
                span_start=re_start,
                offset_end=re_end,
                span_end=re_end,
                flagged_text=flagged_text,
                learner_span=flagged_text,
                category=category,
                dimension=category,
                severity=severity,
                issue_type=severity,
                message=message,
                suggestion=suggestion,
            ))
        else:
            # Unanchored issue rather than highlighting wrong text
            validated.append(TranslationParagraphIssueItem(
                offset_start=0,
                span_start=None,
                offset_end=0,
                span_end=None,
                flagged_text=flagged_text,
                learner_span=flagged_text,
                category=category,
                dimension=category,
                severity=severity,
                issue_type=severity,
                message=message,
                suggestion=suggestion,
            ))

    return validated


def _parse_paragraph_response(data: dict, submitted_text: str, model_id: Optional[str] = None) -> TranslationParagraphGradeResponse:
    meaning_verdict = str(data.get("meaning_verdict", "ACCURATE")).upper()
    grammar_verdict = str(data.get("grammar_verdict", "ACCURATE")).upper()
    naturalness_verdict = str(data.get("naturalness_verdict", "NATURAL")).upper()
    vocabulary_verdict = str(data.get("vocabulary_verdict", "ACCURATE")).upper()
    cohesion_verdict = str(data.get("cohesion_verdict", "COHESIVE")).upper()

    overall_status = str(data.get("overall_status", "ACCEPTED")).upper()
    accepted = bool(data.get("accepted", overall_status == "ACCEPTED"))

    raw_issues = data.get("issues", [])
    issues = _validate_and_anchor_issues(raw_issues, submitted_text)

    # Invariant: If there are NO 'ERROR' severity issues, must be ACCEPTED
    has_blocking_errors = any(i.severity == "ERROR" for i in issues)
    if not has_blocking_errors and not accepted:
        accepted = True
        overall_status = "ACCEPTED"

    headline_summary = str(data.get("headline_summary", "Đoạn dịch được đánh giá hoàn tất."))
    natural_suggestion = data.get("natural_suggestion")

    return TranslationParagraphGradeResponse(
        meaning_verdict=meaning_verdict,
        grammar_verdict=grammar_verdict,
        naturalness_verdict=naturalness_verdict,
        vocabulary_verdict=vocabulary_verdict,
        cohesion_verdict=cohesion_verdict,
        overall_status=overall_status,
        evaluation_status=overall_status,
        accepted=accepted,
        headline_summary=headline_summary,
        overall_summary=headline_summary,
        natural_suggestion=natural_suggestion,
        natural_alternative=natural_suggestion,
        issues=issues,
        model_id=model_id,
        generation_count=1,
    )


def grade_paragraph_translation(req: TranslationParagraphGradeRequest) -> TranslationParagraphGradeResponse:
    """Execute whole-paragraph grading with primary model and fallback model."""
    primary_model = req.model or PRIMARY_PARAGRAPH_MODEL
    fallback_model = req.fallback_model or FALLBACK_PARAGRAPH_MODEL
    prompt = _build_paragraph_prompt(req)

    # Attempt 1: Primary model
    try:
        logger.info("Paragraph grading using primary model: %s", primary_model)
        llm = get_llm(
            temperature=0.1,
            max_tokens=1500,
            timeout=40.0,
            exam_mode=False,
            model_override=primary_model,
            json_mode=True,
            reasoning_effort="low",
            max_retries=1,
        )
        if llm:
            response = llm.invoke(prompt)
            content = response.content if hasattr(response, "content") else str(response)
            data = _clean_json_output(content)
            return _parse_paragraph_response(data, req.submitted_en, model_id=primary_model)
    except Exception as exc:
        logger.warning(
            "Primary model %s failed for paragraph grading: %s. Attempting fallback %s.",
            primary_model, exc, fallback_model
        )

    # Attempt 2: Fallback model
    try:
        logger.info("Paragraph grading using fallback model: %s", fallback_model)
        llm_fallback = get_llm(
            temperature=0.1,
            max_tokens=1500,
            timeout=40.0,
            exam_mode=False,
            model_override=fallback_model,
            json_mode=True,
            reasoning_effort="low",
            max_retries=1,
        )
        if llm_fallback:
            response = llm_fallback.invoke(prompt)
            content = response.content if hasattr(response, "content") else str(response)
            data = _clean_json_output(content)
            return _parse_paragraph_response(data, req.submitted_en, model_id=fallback_model)
    except Exception as exc:
        logger.error("Fallback model %s failed for paragraph grading: %s", fallback_model, exc)

    # Technical failure -> UNCERTAIN, do NOT mark incorrect
    return TranslationParagraphGradeResponse(
        meaning_verdict="UNCERTAIN",
        grammar_verdict="UNCERTAIN",
        naturalness_verdict="UNCERTAIN",
        vocabulary_verdict="UNCERTAIN",
        cohesion_verdict="UNCERTAIN",
        overall_status="UNCERTAIN",
        evaluation_status="UNCERTAIN",
        accepted=None,
        headline_summary="Hệ thống chấm AI tạm thời gián đoạn. Bài làm của bạn đã được ghi nhận an toàn.",
        overall_summary="Hệ thống chấm AI tạm thời gián đoạn. Bài làm của bạn đã được ghi nhận an toàn.",
        natural_suggestion=None,
        natural_alternative=None,
        issues=[],
        model_id=None,
        generation_count=0,
    )
