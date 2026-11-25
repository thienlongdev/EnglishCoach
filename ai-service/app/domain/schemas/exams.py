from __future__ import annotations

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from app.services.exams.evidence_contract import SpeakingTurnEvidence


class CriterionScore(BaseModel):
    criterion: str
    score: Optional[float] = None
    feedback: Optional[str] = None
    evidence: Optional[List[str]] = Field(default_factory=list)


class ExamScoringRequest(BaseModel):
    stageKey: str
    family: str
    skill: str
    taskType: Optional[str] = None
    promptText: Optional[str] = None
    responseText: Optional[str] = None
    mediaUrl: Optional[str] = None
    audioBase64: Optional[str] = None
    rubricCriteria: Optional[Dict[str, Any]] = None
    calibrationMeta: Optional[Dict[str, Any]] = None

    # Runtime V4 Chunk 17: Authoritative Evidence Contract & Provenance
    snapshotHash: Optional[str] = None
    turns: Optional[List[SpeakingTurnEvidence]] = None
    rubricVersion: Optional[str] = None
    providerVersion: Optional[str] = None
    requestHash: Optional[str] = None


class ExamScoringResponse(BaseModel):
    stageKey: str
    success: bool
    overallBand: Optional[float] = None
    criteria: List[CriterionScore] = Field(default_factory=list)
    turnDiagnostics: Optional[Dict[str, Any]] = None
    evidenceHash: Optional[str] = None
    outputHash: Optional[str] = None
    telemetry: Dict[str, Any] = Field(default_factory=dict)
    reviewerNotes: Optional[str] = None
    reviewRequired: bool = False
    abstention: Optional[Dict[str, Any]] = None
    errorMessage: Optional[str] = None
