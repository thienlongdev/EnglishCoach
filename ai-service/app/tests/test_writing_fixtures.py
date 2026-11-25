import json
import os
import pytest
from app.domain.schemas.writing import (
    SentenceAnalysisResponse,
    DocumentAnalysisResponse,
    PracticeEvaluationResponse,
    DimensionStatus,
    IssueKind,
    IssueSeverity
)

FIXTURES_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "tests", "fixtures", "writing")
)

def test_sentence_check_correct_fixture():
    path = os.path.join(FIXTURES_DIR, "sentence_check_correct.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = SentenceAnalysisResponse.model_validate(data)
    assert res.grammatically_correct is True
    assert len(res.issues) == 0
    assert len(res.dimension_verdicts) == 2
    assert res.dimension_verdicts[0].status == DimensionStatus.CORRECT

def test_sentence_check_error_fixture():
    path = os.path.join(FIXTURES_DIR, "sentence_check_error.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = SentenceAnalysisResponse.model_validate(data)
    assert res.grammatically_correct is False
    assert len(res.issues) == 1
    issue = res.issues[0]
    assert issue.kind == IssueKind.ERROR
    assert issue.severity == IssueSeverity.CRITICAL
    assert issue.pattern_code == "SUBJECT_VERB_AGREEMENT"
    assert issue.source_quote == "she go"
    assert issue.start_offset == 0
    assert issue.end_offset == 6

def test_sentence_check_naturalness_fixture():
    path = os.path.join(FIXTURES_DIR, "sentence_check_naturalness.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = SentenceAnalysisResponse.model_validate(data)
    assert res.grammatically_correct is True
    assert len(res.issues) == 1
    assert res.issues[0].kind == IssueKind.IMPROVEMENT

def test_sentence_check_uncertain_fixture():
    path = os.path.join(FIXTURES_DIR, "sentence_check_uncertain.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = SentenceAnalysisResponse.model_validate(data)
    assert res.grammatically_correct is None
    assert res.analysis_status == "INCONCLUSIVE"
    assert res.dimension_verdicts[0].status == DimensionStatus.UNCERTAIN
    assert res.issues[0].kind == IssueKind.UNCERTAIN

def test_document_analysis_valid_fixture():
    path = os.path.join(FIXTURES_DIR, "document_analysis_valid.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = DocumentAnalysisResponse.model_validate(data)
    assert res.overall_score == 78
    assert len(res.issues) == 3
    assert len(res.prioritized_issue_indices) == 3
    assert len(res.strengths) == 3

def test_practice_eval_valid_fixture():
    path = os.path.join(FIXTURES_DIR, "practice_eval_valid.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = PracticeEvaluationResponse.model_validate(data)
    assert res.is_success is True
    assert len(res.alternative_valid_answers) == 2
