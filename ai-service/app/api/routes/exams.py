from __future__ import annotations

import hmac
import os
import logging
from typing import Any, Dict, List
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from app.domain.schemas.exams import ExamScoringRequest, ExamScoringResponse
from app.services.exams.evidence_contract import (
    SpeakingTurnEvidence,
    compute_evidence_hash,
    compute_request_hash,
    compute_output_hash,
    validate_speaking_turn_evidence_set
)
from app.services.exams.pipeline import execute_exam_scoring_stage

logger = logging.getLogger("exams_route")

router = APIRouter(prefix="/api/v1/exams", tags=["exams"])


def verify_exam_service_auth(authorization: str = Header(None)):
    """
    Internal service authentication protecting Exams AI judge endpoints
    from direct unauthorized browser client invocation.
    """
    # No default (security release 2026-11-16, SEC-03): an unconfigured judge refuses every call.
    expected_key = (os.getenv("EXAMS_SERVICE_KEY") or "").strip()
    if not expected_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Exams AI judge credential is not configured."
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Bearer authentication token for Exams AI service."
        )

    token = authorization.split("Bearer ", 1)[1].strip()
    if not hmac.compare_digest(token.encode("utf-8"), expected_key.encode("utf-8")):
        logger.warning("Unauthorized access attempt to /api/v1/exams/score with token mismatch")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: invalid internal Exams service credential."
        )


class EvidenceValidationRequest(BaseModel):
    family: str = "IELTS"
    skill: str = "SPEAKING"
    snapshotHash: str
    turns: List[SpeakingTurnEvidence]


class EvidenceValidationResponse(BaseModel):
    valid: bool
    evidenceHash: str
    turnCount: int
    partsPresent: List[str]
    hasAcousticEvidence: bool
    pronunciationAbstentionRequired: bool
    abstentionReason: str | None = None


@router.post("/validate-evidence", response_model=EvidenceValidationResponse, dependencies=[Depends(verify_exam_service_auth)])
async def validate_exam_evidence(request: EvidenceValidationRequest):
    """
    Validates turn-by-turn evidence, ensures zero band scores at turn level,
    verifies complete Part 1/2/3 set, and returns deterministic evidence hash.
    """
    try:
        val_res = validate_speaking_turn_evidence_set(request.turns)
        return EvidenceValidationResponse(
            valid=True,
            evidenceHash=val_res["evidenceHash"],
            turnCount=val_res["turnCount"],
            partsPresent=val_res["partsPresent"],
            hasAcousticEvidence=val_res["hasAcousticEvidence"],
            pronunciationAbstentionRequired=val_res["pronunciationAbstentionRequired"],
            abstentionReason=val_res["abstentionReason"]
        )
    except ValueError as val_err:
        logger.warning(f"Turn evidence validation rejected: {val_err}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(val_err))
    except Exception as exc:
        logger.error(f"Error validating evidence contract: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Evidence contract validation failed: {str(exc)}"
        )


@router.post("/score", response_model=ExamScoringResponse, dependencies=[Depends(verify_exam_service_auth)])
async def score_exam_stage(request: ExamScoringRequest):
    try:
        evidence_hash = None
        if request.turns:
            # Validate turn evidence contract
            val_res = validate_speaking_turn_evidence_set(request.turns)
            evidence_hash = val_res["evidenceHash"]

            # Validate request hash if provided
            computed_req_hash = compute_request_hash(
                stage_key=request.stageKey,
                family=request.family,
                skill=request.skill,
                snapshot_hash=request.snapshotHash,
                evidence_hash=evidence_hash
            )
            if request.requestHash and request.requestHash != computed_req_hash:
                raise ValueError(
                    f"REQUEST_HASH_MISMATCH: provided '{request.requestHash}', expected '{computed_req_hash}'"
                )

        response = execute_exam_scoring_stage(request)

        # Attach evidence and output hashes if not already populated
        if evidence_hash and not response.evidenceHash:
            response.evidenceHash = evidence_hash
        if response.evidenceHash and not response.outputHash:
            criteria_dicts = [
                {"criterion": c.criterion, "score": c.score}
                for c in response.criteria
            ]
            response.outputHash = compute_output_hash(
                stage_key=response.stageKey,
                overall_band=response.overallBand,
                criteria_scores=criteria_dicts,
                evidence_hash=response.evidenceHash
            )

        return response
    except ValueError as val_err:
        logger.warning(f"Invalid exam scoring request: {val_err}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(val_err))
    except Exception as exc:
        logger.error(f"Error during exam scoring stage: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Exam AI scoring failed: {str(exc)}"
        )


@router.get("/health")
async def exams_ai_health():
    return {
        "status": "healthy",
        "service": "exams-ai-judge",
        "supportedFamilies": ["IELTS", "TOEIC"],
        "supportedSkills": ["WRITING", "SPEAKING"],
        "evidenceContractVersion": "v4.0"
    }
