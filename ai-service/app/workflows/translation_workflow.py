"""
Translation Grading Workflow for Translation Practice.
Single-pass structured grading with primary/fallback resilience.
"""

import json
import logging
import os
import re
from typing import Optional, List, Dict, Any

from app.domain.schemas.writing import (
    TranslationGradeRequest,
    TranslationGradeResponse,
    TranslationIssueItem
)
from app.services.llm_provider import get_llm

logger = logging.getLogger(__name__)

PRIMARY_TRANSLATION_MODEL = os.getenv("TRANSLATION_PRIMARY_MODEL", "openai/gpt-5.6-luna").strip()
FALLBACK_TRANSLATION_MODEL = os.getenv("TRANSLATION_FALLBACK_MODEL", "deepseek/deepseek-v3.2").strip()

def _clean_json_output(raw: str) -> dict:
    if not raw or not raw.strip():
        raise ValueError("Empty response from LLM")
    text = raw.strip()
    # Strip <thought>...</thought>
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

def _build_grading_prompt(req: TranslationGradeRequest) -> str:
    chunks_str = ""
    if req.target_chunks:
        chunks_list = [c.get("text", "") for c in req.target_chunks if isinstance(c, dict) and c.get("text")]
        if chunks_list:
            chunks_str = f"\nTarget collocations/chunks to encourage: {', '.join(chunks_list)}"

    return f"""You are an expert bilingual English-Vietnamese writing evaluator.
Grade the learner's English translation of the Vietnamese source sentence.

CRITICAL INSTRUCTIONS:
1. Accept valid paraphrases, natural word order variations, and legitimate synonym choices that preserve the original Vietnamese meaning. Do NOT penalize a sentence just because it uses different words than the reference answer.
2. An answer is ACCEPTED (accepted=true, overall_status="ACCEPTED") if it is grammatically correct and accurately conveys the full meaning of the Vietnamese source.
3. DO NOT block completion (do not set accepted=false) for harmless stylistic alternatives, valid vocabulary choices, capitalization differences, or punctuation variations. Style or naturalness suggestions must be provided via 'natural_suggestion' without failing the translation.
4. DO block completion (accepted=false, overall_status="NEEDS_REVISION" or "INCORRECT") ONLY when:
   - Meaning is missing, distorted, or significantly changed
   - Substantive grammar or structural errors exist
   - An incorrect lexical choice distorts the original meaning
5. All learner feedback, summaries, and issue messages MUST be in Vietnamese so Vietnamese learners understand clearly.
6. Provide accurate character offsets (offset_start, offset_end) corresponding to the exact substring in the learner's submitted English text.

INPUTS:
- Vietnamese Source: "{req.source_vi}"
- Reference English: "{req.reference_en}"
- Learner Translation: "{req.submitted_en}"
- Topic: {req.topic_code}
- Difficulty: {req.difficulty_bucket}{chunks_str}

Respond ONLY with a JSON object in this exact schema:
{{
  "meaning_verdict": "ACCURATE" | "PARTIAL" | "INACCURATE" | "UNCERTAIN",
  "grammar_verdict": "ACCURATE" | "MINOR_ISSUES" | "INCORRECT" | "UNCERTAIN",
  "naturalness_verdict": "NATURAL" | "ACCEPTABLE" | "AWKWARD" | "UNCERTAIN",
  "overall_status": "ACCEPTED" | "NEEDS_REVISION" | "INCORRECT" | "UNCERTAIN",
  "accepted": true | false,
  "headline_summary": "Concise 1-2 sentence feedback in Vietnamese explaining whether the translation is good or needs work",
  "natural_suggestion": "Polished, natural English sentence alternative",
  "issues": [
    {{
      "offset_start": 0,
      "offset_end": 5,
      "flagged_text": "words",
      "category": "GRAMMAR" | "MEANING" | "VOCABULARY" | "SPELLING" | "PUNCTUATION",
      "message": "Specific explanation in Vietnamese",
      "suggestion": "Better phrase or correction"
    }}
  ]
}}"""

def grade_translation(req: TranslationGradeRequest) -> TranslationGradeResponse:
    primary_model = req.model or PRIMARY_TRANSLATION_MODEL
    fallback_model = req.fallback_model or FALLBACK_TRANSLATION_MODEL
    prompt = _build_grading_prompt(req)

    # Attempt 1: Primary model
    try:
        logger.info("Translation grading using primary model: %s", primary_model)
        llm = get_llm(
            temperature=0.1,
            max_tokens=1000,
            timeout=30.0,
            exam_mode=False,
            model_override=primary_model,
            json_mode=True,
            reasoning_effort="low",
            max_retries=1
        )
        if llm:
            response = llm.invoke(prompt)
            content = response.content if hasattr(response, "content") else str(response)
            data = _clean_json_output(content)
            return _parse_response(data, req.submitted_en)
    except Exception as exc:
        logger.warn("Primary model %s failed for translation grading: %s. Attempting fallback %s.", primary_model, exc, fallback_model)

    # Attempt 2: Fallback model
    try:
        logger.info("Translation grading using fallback model: %s", fallback_model)
        llm_fallback = get_llm(
            temperature=0.1,
            max_tokens=1000,
            timeout=30.0,
            exam_mode=False,
            model_override=fallback_model,
            json_mode=True,
            reasoning_effort="low",
            max_retries=1
        )
        if llm_fallback:
            response = llm_fallback.invoke(prompt)
            content = response.content if hasattr(response, "content") else str(response)
            data = _clean_json_output(content)
            return _parse_response(data, req.submitted_en)
    except Exception as exc:
        logger.error("Fallback model %s also failed for translation grading: %s.", fallback_model, exc)

    # Safe deterministic fallback
    return TranslationGradeResponse(
        meaning_verdict="UNCERTAIN",
        grammar_verdict="UNCERTAIN",
        naturalness_verdict="UNCERTAIN",
        overall_status="UNCERTAIN",
        accepted=None,
        headline_summary="Hệ thống chấm AI tạm thời gián đoạn. Câu trả lời của bạn đã được lưu lại an toàn.",
        natural_suggestion=None,
        issues=[]
    )

def _parse_response(data: dict, submitted_text: str) -> TranslationGradeResponse:
    meaning = str(data.get("meaning_verdict", "ACCURATE")).upper()
    grammar = str(data.get("grammar_verdict", "ACCURATE")).upper()
    naturalness = str(data.get("naturalness_verdict", "NATURAL")).upper()
    status = str(data.get("overall_status", "ACCEPTED")).upper()
    accepted = data.get("accepted")
    if accepted is None:
        accepted = (status == "ACCEPTED")

    headline = str(data.get("headline_summary") or "Đã hoàn thành đánh giá bài dịch.")
    suggestion = data.get("natural_suggestion")

    issues_raw = data.get("issues") or []
    issues: List[TranslationIssueItem] = []
    for item in issues_raw:
        if not isinstance(item, dict):
            continue
        flagged = str(item.get("flagged_text", ""))
        start = int(item.get("offset_start", 0))
        end = int(item.get("offset_end", 0))

        # Adjust offsets if flagged text matches submitted_text
        if flagged and (end <= start or end > len(submitted_text) or submitted_text[start:end] != flagged):
            idx = submitted_text.find(flagged)
            if idx != -1:
                start = idx
                end = idx + len(flagged)
            else:
                start = 0
                end = 0

        issues.append(TranslationIssueItem(
            offset_start=start,
            offset_end=end,
            flagged_text=flagged,
            category=str(item.get("category", "GRAMMAR")).upper(),
            message=str(item.get("message", "Cần xem lại cụm từ này")),
            suggestion=item.get("suggestion")
        ))

    return TranslationGradeResponse(
        meaning_verdict=meaning,
        grammar_verdict=grammar,
        naturalness_verdict=naturalness,
        overall_status=status,
        accepted=bool(accepted),
        headline_summary=headline,
        natural_suggestion=suggestion,
        issues=issues
    )
