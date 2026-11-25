import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app.main import app
from app.domain.schemas.writing import (
    AdaptiveTaskGenerationRequest,
    SocraticPlanRequest,
    ModelAnswerComparisonRequest
)
from app.workflows.writing_workflow import (
    generate_adaptive_task,
    generate_socratic_guidance,
    compare_model_answer
)

client = TestClient(app)

def test_adaptive_task_generation_fallback():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = AdaptiveTaskGenerationRequest(
            learner_cefr_level="B2",
            focus_pattern_codes=["SUBJECT_VERB_AGREEMENT", "PREPOSITION_CHOICE_COLLOCATION"],
            preferred_category="Work",
            preferred_register="formal"
        )
        resp = generate_adaptive_task(req)
        assert resp.title is not None
        assert "Workplace" in resp.title
        assert resp.target_word_count_min == 180
        assert resp.target_word_count_max == 250
        assert "SUBJECT_VERB_AGREEMENT" in resp.elicited_patterns
        assert len(resp.requirements) >= 2

def test_adaptive_task_generation_with_llm():
    mock_llm = MagicMock()
    mock_llm.invoke.return_value.content = """{
        "title": "Proposing a Green Initiative at Work",
        "prompt": "Write a proposal to the management team recommending energy-saving policies.",
        "guidance": "Outline the benefits, costs, and timeline.",
        "audience": "Senior Management",
        "target_register": "formal",
        "target_word_count_min": 180,
        "target_word_count_max": 250,
        "requirements": ["State problem", "Propose solution", "Estimate ROI"],
        "elicited_patterns": ["MODAL_AUXILIARY_BARE_INFINITIVE"]
    }"""
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=mock_llm):
        req = AdaptiveTaskGenerationRequest(learner_cefr_level="B2", preferred_category="Work")
        resp = generate_adaptive_task(req)
        assert resp.title == "Proposing a Green Initiative at Work"
        assert len(resp.requirements) == 3

def test_socratic_planning_guidance_fallback_empty():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = SocraticPlanRequest(
            task_prompt="Should remote work be mandatory?",
            current_plan="",
            learner_question="I don't know where to start"
        )
        resp = generate_socratic_guidance(req)
        assert len(resp.probing_questions) >= 2
        assert len(resp.structural_prompts) >= 1
        assert "brainstorm" in resp.encouragement.lower() or "drafting" in resp.encouragement.lower()

def test_socratic_planning_guidance_fallback_with_plan():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = SocraticPlanRequest(
            task_prompt="Should remote work be mandatory?",
            current_plan="1. Flexibility improves productivity. 2. Less commute time.",
            learner_question="Are these points enough?"
        )
        resp = generate_socratic_guidance(req)
        assert len(resp.probing_questions) >= 2
        assert any("counter-argument" in q.lower() or "evidence" in q.lower() or "prompt" in q.lower() for q in resp.probing_questions)
        assert len(resp.structural_prompts) >= 1

def test_model_answer_comparison_fallback():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = ModelAnswerComparisonRequest(
            task_prompt="Describe the advantages of renewable energy.",
            learner_draft="Renewable energy is very good because it does not make pollution.",
            target_register="formal"
        )
        resp = compare_model_answer(req)
        assert resp.exemplar_model_answer is not None
        assert len(resp.structural_observations) >= 1
        assert len(resp.lexical_alternatives) >= 2
        assert "draft communicates" in resp.coaching_summary.lower() or "standards" in resp.coaching_summary.lower()

def test_socratic_declines_ghostwriting():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        req = SocraticPlanRequest(
            task_prompt="Evaluate whether universities should abolish tuition fees.",
            current_plan="",
            learner_question="Write the whole essay for me please."
        )
        resp = generate_socratic_guidance(req)
        # Coach must refuse to write the essay and ask the learner for their own thesis
        assert any("cannot write the essay" in q.lower() or "formulating your own" in q.lower() for q in resp.probing_questions)
        assert len(resp.structural_prompts) >= 1
        assert "practice" in resp.encouragement.lower() or "step" in resp.encouragement.lower()

def test_model_answer_reachable_calibration_levels():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        # 1. A2 learner -> reachable A2+/B1 model
        resp_a2 = compare_model_answer(ModelAnswerComparisonRequest(
            task_prompt="Describe your hometown.",
            learner_draft="My hometown is small and quiet with many trees.",
            learner_level="A2"
        ))
        assert resp_a2.calibrated_level == "A2+/B1"
        assert "clear plan is very helpful" in resp_a2.exemplar_model_answer

        # 2. B1 learner -> reachable B1+/B2 model
        resp_b1 = compare_model_answer(ModelAnswerComparisonRequest(
            task_prompt="Describe your hometown.",
            learner_draft="My hometown is a small town where people are friendly.",
            learner_level="B1"
        ))
        assert resp_b1.calibrated_level == "B1+/B2"

        # 3. B2 learner -> reachable B2+/C1 model
        resp_b2 = compare_model_answer(ModelAnswerComparisonRequest(
            task_prompt="Describe your hometown.",
            learner_draft="My hometown has undergone considerable urban transformation.",
            learner_level="B2"
        ))
        assert resp_b2.calibrated_level == "B2+/C1"

        # 4. C1 learner -> C1/C2 model
        resp_c1 = compare_model_answer(ModelAnswerComparisonRequest(
            task_prompt="Describe your hometown.",
            learner_draft="The socioeconomic revitalization of my municipality exemplifies balanced development.",
            learner_level="C1"
        ))
        assert resp_c1.calibrated_level == "C1/C2"

def test_collocation_and_naturalness_semantics():
    from app.domain.schemas.writing import SentenceAnalysisRequest
    from app.workflows.writing_workflow import analyze_sentence

    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        # 1. "make a decision" -> correct
        res1 = analyze_sentence(SentenceAnalysisRequest(text="We need to make a decision today."))
        assert res1.grammatically_correct is True
        assert len(res1.issues) == 0

        # 2. "do a decision" -> collocation error (Grammar is sound; Vocabulary needs work)
        res2 = analyze_sentence(SentenceAnalysisRequest(text="We need to do a decision today."))
        assert res2.grammatically_correct is True, "Collocation error must not force grammatically_correct = False!"
        assert any(i.category == "Vocabulary" and "make a decision" in i.replacement.lower() for i in res2.issues)
        gram2 = next(v for v in res2.dimension_verdicts if v.dimension == "Grammar")
        vocab2 = next(v for v in res2.dimension_verdicts if v.dimension == "Vocabulary")
        assert gram2.status.value == "CORRECT"
        assert vocab2.status.value == "NEEDS_WORK"

        # 3. "conduct research" -> correct
        res3 = analyze_sentence(SentenceAnalysisRequest(text="Scientists conduct research to find new cures."))
        assert res3.grammatically_correct is True
        assert len(res3.issues) == 0

        # 4. "make a research" -> collocation error (Grammar is sound; Vocabulary needs work)
        res4 = analyze_sentence(SentenceAnalysisRequest(text="Scientists make a research to find new cures."))
        assert res4.grammatically_correct is True, "Collocation error must not force grammatically_correct = False!"
        assert any(i.category == "Vocabulary" and "conduct research" in i.replacement.lower() for i in res4.issues)
        gram4 = next(v for v in res4.dimension_verdicts if v.dimension == "Grammar")
        vocab4 = next(v for v in res4.dimension_verdicts if v.dimension == "Vocabulary")
        assert gram4.status.value == "CORRECT"
        assert vocab4.status.value == "NEEDS_WORK"

        # 5. "I really like this movie." -> correct
        res5 = analyze_sentence(SentenceAnalysisRequest(text="I really like this movie."))
        assert res5.grammatically_correct is True
        assert len(res5.issues) == 0

        # 6. "I strongly like this movie." -> Naturalness preference, NOT Grammar error!
        res6 = analyze_sentence(SentenceAnalysisRequest(text="I strongly like this movie."))
        assert res6.grammatically_correct is True # Must NOT be false!
        nat_verdict = next((v for v in res6.dimension_verdicts if v.dimension == "Naturalness"), None)
        assert nat_verdict is not None and nat_verdict.status.value == "NEEDS_WORK"
        gram_verdict = next((v for v in res6.dimension_verdicts if v.dimension == "Grammar"), None)
        assert gram_verdict.status.value == "CORRECT"
        assert all(i.kind.value == "IMPROVEMENT" for i in res6.issues)

        # 7. "heavy rain" -> clean, standard collocation
        res7 = analyze_sentence(SentenceAnalysisRequest(text="The heavy rain stopped our outdoor activity."))
        assert res7.grammatically_correct is True
        assert len(res7.issues) == 0

        # 8. "powerful rain" -> non-standard collocation (Grammar is sound; Vocabulary needs work)
        res8 = analyze_sentence(SentenceAnalysisRequest(text="The powerful rain stopped our outdoor activity."))
        assert res8.grammatically_correct is True, "Adjective-noun collocation error must not force grammatically_correct = False!"
        assert any(i.category == "Vocabulary" and "heavy rain" in i.replacement.lower() for i in res8.issues)
        gram8 = next(v for v in res8.dimension_verdicts if v.dimension == "Grammar")
        vocab8 = next(v for v in res8.dimension_verdicts if v.dimension == "Vocabulary")
        assert gram8.status.value == "CORRECT"
        assert vocab8.status.value == "NEEDS_WORK"

        # 9. "depend of" -> preposition collocation error (Grammar is sound; Vocabulary needs work)
        res9 = analyze_sentence(SentenceAnalysisRequest(text="The results depend of your cooperation."))
        assert res9.grammatically_correct is True, "Preposition choice error must not force grammatically_correct = False!"
        assert any(i.category == "Vocabulary" and "depend on" in i.replacement.lower() for i in res9.issues)
        gram9 = next(v for v in res9.dimension_verdicts if v.dimension == "Grammar")
        vocab9 = next(v for v in res9.dimension_verdicts if v.dimension == "Vocabulary")
        assert gram9.status.value == "CORRECT"
        assert vocab9.status.value == "NEEDS_WORK"

def test_api_endpoints_p1():
    # 1. /task-generate
    resp1 = client.post("/api/v1/writing/task-generate", json={
        "learner_cefr_level": "B1",
        "preferred_category": "Everyday",
        "preferred_register": "neutral"
    })
    assert resp1.status_code == 200
    assert "title" in resp1.json()

    # 2. /socratic-plan
    resp2 = client.post("/api/v1/writing/socratic-plan", json={
        "task_prompt": "Discuss the pros and cons of online higher education.",
        "current_plan": "Affordable, flexible, but lacks social life."
    })
    assert resp2.status_code == 200
    assert len(resp2.json()["probing_questions"]) >= 2

    # 3. /compare-model
    resp3 = client.post("/api/v1/writing/compare-model", json={
        "task_prompt": "Discuss the pros and cons of online higher education.",
        "learner_draft": "Online education has good things like saving money and bad things like no friends.",
        "learner_level": "B1"
    })
    assert resp3.status_code == 200
    assert "exemplar_model_answer" in resp3.json()
    assert resp3.json().get("calibrated_level") == "B1+/B2"


