import pytest
from app.domain.schemas.writing import (
    SentenceAnalysisRequest,
    IssueKind,
    DimensionStatus,
)
from app.workflows.writing_workflow import analyze_sentence

from unittest.mock import patch, MagicMock

def test_correct_sentence_analysis_with_llm():
    mock_llm = MagicMock()
    mock_llm.invoke.return_value.content = """{
        "grammatically_correct": true,
        "dimension_verdicts": [
            {"dimension": "Grammar", "status": "CORRECT", "summary": "No errors detected.", "score": 98},
            {"dimension": "Naturalness", "status": "CORRECT", "summary": "Very natural.", "score": 95},
            {"dimension": "Vocabulary", "status": "CORRECT", "summary": "Appropriate vocabulary.", "score": 92}
        ],
        "issues": [],
        "suggested_improvement": null,
        "explanation": "Your sentence is grammatically sound."
    }"""
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=mock_llm):
        req = SentenceAnalysisRequest(
            text="The quick brown fox jumps over the lazy dog.",
            target_register="neutral"
        )
        res = analyze_sentence(req)
        assert res.grammatically_correct is True
        errors = [i for i in res.issues if i.kind == IssueKind.ERROR]
        assert len(errors) == 0
        grammar_verdict = next((v for v in res.dimension_verdicts if v.dimension == "Grammar"), None)
        assert grammar_verdict is not None
        assert grammar_verdict.status == DimensionStatus.CORRECT
        assert grammar_verdict.score == 98

def test_ai_failure_never_produces_false_correct_when_offline():
    # REGRESSION TEST for AI Failure Semantics:
    # When LLM is unavailable and no deterministic rule matched,
    # analysis must return grammatically_correct = None (ANALYSIS_UNAVAILABLE),
    # NEVER producing "Grammatically correct" (true) nor "Grammatically incorrect" (false).
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = SentenceAnalysisRequest(
            text="The quick brown fox jumps over the lazy dog.",
            target_register="neutral"
        )
        res = analyze_sentence(req)
        assert res.grammatically_correct is None
        assert res.analysis_status == "ANALYSIS_UNAVAILABLE"
        grammar_verdict = next((v for v in res.dimension_verdicts if v.dimension == "Grammar"), None)
        assert grammar_verdict is not None
        assert grammar_verdict.status == DimensionStatus.UNAVAILABLE
        assert grammar_verdict.score is None

def test_ai_failure_never_produces_false_correct_when_llm_throws():
    # REGRESSION TEST: When LLM throws an exception, must return UNAVAILABLE/UNCERTAIN, not false or correct.
    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = RuntimeError("OpenRouter 503 Service Unavailable")
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=mock_llm):
        req = SentenceAnalysisRequest(
            text="An unverified sentence that should not be marked correct on failure.",
            target_register="neutral"
        )
        res = analyze_sentence(req)
        assert res.grammatically_correct is None
        assert res.analysis_status == "ANALYSIS_UNAVAILABLE"
        grammar_verdict = next((v for v in res.dimension_verdicts if v.dimension == "Grammar"), None)
        assert grammar_verdict is not None
        assert grammar_verdict.status == DimensionStatus.UNAVAILABLE
        assert grammar_verdict.score is None

def test_third_person_singular_auxiliary_error():
    text = "She don't like apples."
    req = SentenceAnalysisRequest(text=text)
    res = analyze_sentence(req)
    assert res.grammatically_correct is False
    assert res.analysis_status == "COMPLETED"
    assert len(res.issues) > 0
    issue = res.issues[0]
    assert issue.pattern_code == "THIRD_PERSON_SINGULAR_AUXILIARY"
    assert issue.kind == IssueKind.ERROR
    assert text[issue.start_offset:issue.end_offset] == issue.source_quote
    assert issue.replacement == "She doesn't"

def test_modal_auxiliary_bare_infinitive_error():
    text = "You must to submit the draft by noon."
    req = SentenceAnalysisRequest(text=text)
    res = analyze_sentence(req)
    assert res.grammatically_correct is False
    assert res.analysis_status == "COMPLETED"
    issue = next(i for i in res.issues if i.pattern_code == "MODAL_AUXILIARY_BARE_INFINITIVE")
    assert issue.kind == IssueKind.ERROR
    assert text[issue.start_offset:issue.end_offset] == issue.source_quote
    assert issue.replacement == "must"

def test_preposition_collocation_error():
    text = "Our final results depend of your cooperation."
    req = SentenceAnalysisRequest(text=text)
    res = analyze_sentence(req)
    # Grammar syntax is sound; error is strictly in the Vocabulary/Collocation dimension
    assert res.grammatically_correct is True
    assert res.analysis_status == "COMPLETED"
    grammar_verdict = next((v for v in res.dimension_verdicts if v.dimension == "Grammar"), None)
    vocab_verdict = next((v for v in res.dimension_verdicts if v.dimension == "Vocabulary"), None)
    assert grammar_verdict.status == DimensionStatus.CORRECT
    assert vocab_verdict.status == DimensionStatus.NEEDS_WORK
    issue = next(i for i in res.issues if i.pattern_code == "PREPOSITION_CHOICE_COLLOCATION")
    assert issue.category == "Vocabulary"
    assert text[issue.start_offset:issue.end_offset] == issue.source_quote
    assert issue.replacement == "depend on"

def test_empty_sentence_handling():
    req = SentenceAnalysisRequest(text="   ")
    res = analyze_sentence(req)
    assert res.grammatically_correct is None
    assert res.analysis_status == "ANALYSIS_UNAVAILABLE"
    assert res.dimension_verdicts[0].status == DimensionStatus.UNAVAILABLE

def test_ambiguous_inconclusive_sentence_returns_none():
    mock_llm = MagicMock()
    mock_llm.invoke.return_value.content = """{
        "grammatically_correct": null,
        "dimension_verdicts": [
            {"dimension": "Grammar", "status": "UNCERTAIN", "summary": "Fragment without main clause.", "score": null},
            {"dimension": "Naturalness", "status": "UNCERTAIN", "summary": "Unclear context.", "score": null},
            {"dimension": "Vocabulary", "status": "CORRECT", "summary": "Standard vocabulary.", "score": 85}
        ],
        "issues": [
            {
                "kind": "UNCERTAIN",
                "severity": "MINOR",
                "category": "Grammar",
                "pattern_code": null,
                "title": "Ambiguous Fragment",
                "explanation": "Context is ambiguous.",
                "source_quote": "Although having many ideas",
                "start_offset": 0,
                "end_offset": 26,
                "replacement": null,
                "teaching_rule": null,
                "suggested_practice_mode": "IMPROVE_COHESION"
            }
        ],
        "suggested_improvement": null,
        "explanation": "Context is ambiguous. Please provide the full sentence."
    }"""
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=mock_llm):
        req = SentenceAnalysisRequest(
            text="Although having many ideas",
            target_register="formal"
        )
        res = analyze_sentence(req)
        assert res.grammatically_correct is None
        assert res.analysis_status == "INCONCLUSIVE"
        assert len(res.issues) == 1
        assert res.issues[0].kind == IssueKind.UNCERTAIN

def test_section_19a_mandatory_regression_i_was_do_it_by_myself():
    # MANDATORY REGRESSION: "i was do it by myself"
    # MUST return actionable feedback with local errors:
    # 1. "i" capitalization
    # 2. "was do" invalid auxiliary verb construction
    # MUST NOT return inconclusive or "Chưa đủ dữ liệu kết luận".
    text = "i was do it by myself"
    req = SentenceAnalysisRequest(text=text)
    res = analyze_sentence(req)
    assert res.grammatically_correct is False
    assert res.analysis_status == "COMPLETED"
    
    # Must have at least 2 issues: capitalization and was do
    codes = [i.pattern_code for i in res.issues]
    assert "CAPITALIZATION_PRONOUN_I" in codes
    assert "INVALID_AUXILIARY_VERB_CONSTRUCTION" in codes
    
    was_do_issue = next(i for i in res.issues if i.pattern_code == "INVALID_AUXILIARY_VERB_CONSTRUCTION")
    assert was_do_issue.kind == IssueKind.ERROR
    assert was_do_issue.category == "Grammar"
    assert was_do_issue.source_quote.lower() == "was do"
    assert text[was_do_issue.start_offset:was_do_issue.end_offset].lower() == "was do"

def test_section_19a_regression_cases():
    # 1. "He go to school every day."
    r1 = analyze_sentence(SentenceAnalysisRequest(text="He go to school every day."))
    assert r1.grammatically_correct is False
    assert any(i.pattern_code == "SUBJECT_VERB_AGREEMENT" for i in r1.issues)

    # 2. "I have went there."
    r2 = analyze_sentence(SentenceAnalysisRequest(text="I have went there."))
    assert r2.grammatically_correct is False
    assert any(i.pattern_code == "HAVE_PAST_PARTICIPLE_MISMATCH" for i in r2.issues)

    # 3. "She is very beauty."
    r3 = analyze_sentence(SentenceAnalysisRequest(text="She is very beauty."))
    assert r3.grammatically_correct is False
    assert any(i.pattern_code == "PART_OF_SPEECH_NOUN_ADJECTIVE" for i in r3.issues)

    # 4. "I bought book yesterday."
    r4 = analyze_sentence(SentenceAnalysisRequest(text="I bought book yesterday."))
    assert r4.grammatically_correct is False
    assert any(i.pattern_code == "ARTICLE_MISSING_BEFORE_SINGULAR_COUNT_NOUN" for i in r4.issues)

def test_section_19a_control_cases():
    # Controls: grammatically sound sentences
    # 1. "He told him about it."
    c1 = analyze_sentence(SentenceAnalysisRequest(text="He told him about it."))
    assert c1.grammatically_correct is True
    assert c1.analysis_status == "COMPLETED"

    # 2. "This is much better."
    c2 = analyze_sentence(SentenceAnalysisRequest(text="This is much better."))
    assert c2.grammatically_correct is True
    assert c2.analysis_status == "COMPLETED"

