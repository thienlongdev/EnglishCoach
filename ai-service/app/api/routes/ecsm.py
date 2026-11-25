"""
FastAPI route for ECSM (English Coach Speech Model) Pre-Production Inference.
Exposes internal endpoints for Shadowing analysis and retry evaluations,
strictly enforcing PRODUCT_SAFE serialization and zero score hallucination.
"""

from __future__ import annotations

import logging
import json
import os
from typing import Optional
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.services.pronunciation.ecsm.runtime_contract import (
    AnalysisStatus,
    ECSMAnalysisRequest,
    ECSMAnalysisResponse,
    ErrorCode,
    ReferenceMode,
    ResponseViewMode,
    RuntimeState,
)
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime
from app.services.audio_ingestion import MAX_AUDIO_BYTES

logger = logging.getLogger("uvicorn.error.ecsm_api")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/ecsm", tags=["ECSM Pronunciation"])
UPLOAD_READ_CHUNK_BYTES = 64 * 1024  # 64 KiB


async def _read_bounded_ecsm_audio(file: UploadFile, max_bytes: int = MAX_AUDIO_BYTES) -> bytes:
    """Stream-read uploaded audio in 64 KiB chunks, aborting with HTTP 413 above max_bytes."""
    buf = bytearray()
    while True:
        chunk = await file.read(UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        if len(buf) + len(chunk) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={"error_code": ErrorCode.AUDIO_TOO_LARGE.value, "message": "Audio file exceeds the configured size limit."},
            )
        buf.extend(chunk)
    return bytes(buf)


@router.post("/analyze")
async def analyze_ecsm(
    file: UploadFile = File(...),
    expected_text: str = Form(""),
    recognized_text: Optional[str] = Form(None),
    content_match_ratio: Optional[float] = Form(None),
    matched_target_word_indices_json: Optional[str] = Form(None),
    audio_identity: Optional[str] = Form(None),
    case_id: Optional[str] = Form(None),
    reference_mode: str = Form(ReferenceMode.SHADOWING_REFERENCE_RELATIVE.value),
    session_id: Optional[str] = Form(None),
    attempt_id: Optional[str] = Form(None),
    parent_attempt_id: Optional[str] = Form(None),
    active_target_id: Optional[str] = Form(None),
    view_mode: str = Form(ResponseViewMode.PRODUCT_SAFE.value),
):
    """
    Executes unified ECSM acoustic pronunciation analysis for a learner audio recording.
    Returns schema-valid PRODUCT_SAFE assessment with zero score hallucination.
    """
    request_id = f"REQ_{uuid.uuid4().hex[:12]}"
    try:
        audio_bytes = await _read_bounded_ecsm_audio(file, max_bytes=MAX_AUDIO_BYTES)
        if not audio_bytes:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error_code": ErrorCode.AUDIO_EMPTY.value, "message": "Audio file payload is empty."},
            )

        # Enforce server-side PRODUCT_SAFE view
        safe_view = ResponseViewMode.PRODUCT_SAFE.value

        matched_indices = None
        if matched_target_word_indices_json:
            try:
                parsed_indices = json.loads(matched_target_word_indices_json)
                if not isinstance(parsed_indices, list) or any(not isinstance(i, int) or i < 0 for i in parsed_indices):
                    raise ValueError("matched target word indices must be non-negative integers")
                matched_indices = sorted(set(parsed_indices))
            except (json.JSONDecodeError, ValueError) as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"error_code": "MATCHED_REGION_CONTRACT_INVALID", "message": str(exc)},
                )

        req = ECSMAnalysisRequest(
            request_id=request_id,
            audio_bytes=audio_bytes,
            expected_text=expected_text.strip(),
            recognized_text=recognized_text.strip() if recognized_text is not None else None,
            content_match_ratio=content_match_ratio,
            matched_target_word_indices=matched_indices,
            audio_identity=audio_identity,
            case_id=case_id,
            reference_mode=reference_mode,
            session_id=session_id,
            attempt_id=attempt_id,
            parent_attempt_id=parent_attempt_id,
            target_id=active_target_id,
            view_mode=safe_view,
            audio_format="wav" if file.filename and file.filename.endswith(".wav") else "webm",
            source_mime_type=file.content_type or "application/octet-stream",
            source_filename=file.filename or "upload",
        )

        logger.info(
            "ecsm_upload requestId=%s filename=%s contentType=%s size=%s firstBytes=%s",
            request_id,
            file.filename or "upload",
            file.content_type or "application/octet-stream",
            len(audio_bytes),
            audio_bytes[:12].hex(),
        )

        runtime = ECSMRuntime.get_instance()
        if runtime.state == RuntimeState.UNINITIALIZED:
            logger.info("ECSM Runtime uninitialized, starting on-demand...")
            runtime.startup(load_neural_weights=True)

        response: ECSMAnalysisResponse = runtime.analyze(req)

        # Handle runtime backpressure
        if response.error_code == ErrorCode.RUNTIME_BUSY.value:
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={
                    "requestId": response.request_id,
                    "status": response.status,
                    "errorCode": response.error_code,
                    "errorMessage": response.error_message,
                    "retryable": True,
                },
            )

        # Map response to product-safe DTO dict
        payload = {
            "requestId": response.request_id,
            "status": response.status,
            "assessmentStatus": response.assessment_status,
            "evidenceCoverage": response.evidence_coverage,
            "targetWordCoverage": response.target_word_coverage,
            "targetPhoneCoverage": response.target_phone_coverage,
            "alignmentCoverage": response.alignment_coverage,
            "attemptId": response.attempt_id,
            "caseId": response.case_id,
            "recognizedTranscript": response.recognized_text,
            "contentMatchRatio": response.content_match_ratio,
            "contentMatchPercentage": round(response.content_match_ratio * 100) if response.content_match_ratio is not None else None,
            "contentGateMinMatch": response.content_gate_min_match,
            "matchedTargetWordIndices": response.matched_target_word_indices,
            "sameAudioVerified": response.same_audio_verified,
            "errorCode": response.error_code,
            "errorMessage": response.error_message,
            "retryable": response.retryable,
            "gatingReasons": response.gating_reasons,
            "failureStage": response.failure_stage,
            "exceptionType": response.exception_type,
            "internalReasonCode": response.internal_reason_code,
            "quality": {
                "durationSec": response.quality.duration_sec if response.quality else 0.0,
                "rmsEnergyDb": response.quality.rms_energy_db if response.quality else -50.0,
                "snrEstimateDb": response.quality.snr_estimate_db if response.quality else 0.0,
                "isClipping": response.quality.is_clipping if response.quality else False,
                "isSilent": response.quality.is_silent if response.quality else False,
                "qualityStatus": response.quality.quality_status if response.quality else "UNKNOWN",
            } if response.quality else None,
            "segmentalAvailable": response.segmental_available,
            "prosodyAvailable": response.prosody_available,
            "assessment": response.assessment,
            "retryPlan": response.retry_plan,
            "retryComparison": response.retry_comparison,
            "warnings": response.warnings,
            "timings": {
                "totalMs": response.timings.total_ms if response.timings else 0.0,
                "decodeMs": response.timings.decode_ms if response.timings else 0.0,
                "targetBuildMs": response.timings.target_build_ms if response.timings else 0.0,
                "contentGateMs": response.timings.content_gate_ms if response.timings else 0.0,
                "segmentalMs": response.timings.segmental_ms if response.timings else 0.0,
                "prosodyMs": response.timings.prosody_ms if response.timings else 0.0,
                "p8Ms": response.timings.hierarchy_p8_ms if response.timings else 0.0,
                "p9Ms": response.timings.retry_p9_ms if response.timings else 0.0,
            } if response.timings else None,
            "provenance": {
                "runtimeVersion": response.provenance.runtime_version if response.provenance else "ECSM_RUNTIME_v1.0",
                "artifactSetId": response.provenance.artifact_set_id if response.provenance else "",
            } if response.provenance else None,
        }
        if response.audit_trace is not None:
            payload["auditTrace"] = response.audit_trace
            payload["devTrace"] = response.audit_trace
        return payload

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ECSM analyze endpoint exception: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error_code": ErrorCode.INTERNAL_INFERENCE_ERROR.value,
                "message": "Internal pronunciation inference failure.",
            },
        )


@router.get("/health")
async def ecsm_health():
    """
    Returns ECSM runtime liveness and readiness diagnostics.
    """
    runtime = ECSMRuntime.get_instance()
    if runtime.state == RuntimeState.UNINITIALIZED:
        logger.info("ECSM Runtime uninitialized during health check, starting on-demand...")
        runtime.startup(load_neural_weights=True)
    health = runtime.get_health()
    return {
        "liveness": health.liveness,
        "readiness": health.readiness,
        "state": health.state,
        "uptimeSec": health.uptime_sec,
        "device": health.device,
        "vramAllocatedMb": health.vram_allocated_mb,
        "totalRequests": health.total_requests,
        "successfulRequests": health.successful_requests,
        "failedRequests": health.failed_requests,
        "artifactSetId": health.artifact_set_id,
    }
