import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_api_sentence_check_endpoint():
    response = client.post(
        "/api/v1/writing/sentence-check",
        json={"text": "She don't understand the assignment.", "target_register": "formal"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["grammatically_correct"] is False
    assert len(data["issues"]) > 0
    assert data["issues"][0]["pattern_code"] == "THIRD_PERSON_SINGULAR_AUXILIARY"
    assert data["issues"][0]["replacement"] == "She doesn't"

from unittest.mock import patch, MagicMock

def test_api_sentence_check_correct():
    mock_llm = MagicMock()
    mock_llm.invoke.return_value.content = """{
        "grammatically_correct": true,
        "dimension_verdicts": [
            {"dimension": "Grammar", "status": "CORRECT", "summary": "No grammatical errors.", "score": 95},
            {"dimension": "Naturalness", "status": "CORRECT", "summary": "Natural wording.", "score": 90},
            {"dimension": "Vocabulary", "status": "CORRECT", "summary": "Appropriate lexical choice.", "score": 90}
        ],
        "issues": [],
        "suggested_improvement": null,
        "explanation": "Your sentence is clear and grammatically correct."
    }"""
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=mock_llm):
        response = client.post(
            "/api/v1/writing/sentence-check",
            json={"text": "They finished the comprehensive report yesterday.", "target_register": "formal"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["grammatically_correct"] is True
        assert len([i for i in data["issues"] if i["kind"] == "ERROR"]) == 0
        assert data["dimension_verdicts"][0]["status"] == "CORRECT"

def test_api_sentence_check_ai_failure_semantics():
    with patch("app.workflows.writing_workflow._create_writing_llm", return_value=None):
        response = client.post(
            "/api/v1/writing/sentence-check",
            json={"text": "They finished the comprehensive report yesterday.", "target_register": "formal"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["grammatically_correct"] is None
        assert data["analysis_status"] == "ANALYSIS_UNAVAILABLE"
        assert data["dimension_verdicts"][0]["status"] == "UNAVAILABLE"
        assert data["dimension_verdicts"][0]["score"] is None
