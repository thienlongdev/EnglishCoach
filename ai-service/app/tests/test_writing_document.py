import pytest
from app.domain.schemas.writing import (
    PlanOrganizationRequest,
    DocumentAnalysisRequest,
)
from app.workflows.writing_workflow import organize_plan, analyze_document

def test_runtime_evaluation_uses_one_luna_generation(monkeypatch):
    import json
    from types import SimpleNamespace
    from unittest.mock import Mock
    import app.workflows.writing_workflow as workflow
    response = SimpleNamespace(content=json.dumps({
        "overall_score": 78, "dimension_verdicts": [], "issues": [],
        "strengths": ["Clear position"], "summary": "Develop the examples."
    }), response_metadata={"model_name": "openai/gpt-5.6-luna"}, id="mock-generation")
    llm = Mock()
    llm.invoke.return_value = response
    factory = Mock(return_value=llm)
    monkeypatch.setattr(workflow, "get_llm", factory)
    result = workflow.analyze_document(DocumentAnalysisRequest(
        task_prompt="Discuss remote work.", draft_content="Remote work offers flexibility and reduces commuting time for many employees."))
    assert result.overall_score == 78
    assert factory.call_args.kwargs["model_override"] == "openai/gpt-5.6-luna"
    assert factory.call_args.kwargs["max_retries"] == 0
    llm.invoke.assert_called_once()

def test_runtime_reference_failure_is_truthful_and_single_call(monkeypatch):
    from unittest.mock import Mock
    from fastapi import HTTPException
    from app.domain.schemas.writing import ModelAnswerComparisonRequest
    import app.workflows.writing_workflow as workflow
    llm = Mock()
    llm.invoke.side_effect = TimeoutError("bounded provider timeout")
    factory = Mock(return_value=llm)
    monkeypatch.setattr(workflow, "get_llm", factory)
    with pytest.raises(HTTPException):
        workflow.compare_model_answer(ModelAnswerComparisonRequest(
            task_prompt="Discuss remote work.", learner_draft="Remote work offers flexibility for employees."))
    assert factory.call_args.kwargs["model_override"] == "openai/gpt-5.6-luna"
    assert factory.call_args.kwargs["max_retries"] == 0
    llm.invoke.assert_called_once()

def test_organize_plan_groups_supplied_ideas():
    req = PlanOrganizationRequest(
        task_prompt="Should remote work be encouraged?",
        learner_ideas=[
            "Saves commuting time and travel expenses",
            "Improves work life balance for families",
            "Can cause isolation if communication is poor",
            "Overall positive trend with hybrid models"
        ]
    )
    res = organize_plan(req)
    assert len(res.organized_sections) > 0
    all_points = [p for sec in res.organized_sections for p in sec.points]
    assert any("commuting" in p for p in all_points)
    assert any("isolation" in p for p in all_points)

def test_analyze_document_evaluates_multi_paragraph_draft():
    draft = """In recent years, remote work has transformed the modern workforce. Many employees value the flexibility of working from home.

However, remote work also presents notable challenges. Some workers feel isolated, and team collaboration can sometimes suffer without face-to-face contact.

In conclusion, a hybrid model offers the optimal compromise, balancing personal autonomy with vital team cohesion."""

    req = DocumentAnalysisRequest(
        task_prompt="Discuss the advantages and disadvantages of remote work.",
        draft_content=draft,
        draft_ordinal=1
    )
    res = analyze_document(req)
    assert res.overall_score is not None
    assert res.overall_score > 60
    assert len(res.dimension_verdicts) == 4
    dim_names = [v.dimension for v in res.dimension_verdicts]
    assert "Task Response" in dim_names
    assert "Coherence & Cohesion" in dim_names
    assert len(res.strengths) > 0
