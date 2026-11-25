"""
FastAPI route for Pronunciation Engine V2/V3 Canonical Production Inference.
Supports engine modes via `PRONUNCIATION_ENGINE_MODE`:
- `auto` (default, also legacy `V2_AUTHORITATIVE`/`V2_SHADOW`/`V2_LIMITED`):
  prefers in-repo `HybridPronunciationEngine` when local checkpoints are available,
  falling back cleanly to configured `MDD_SERVICE_URL` if local checkpoints are absent.
- `inprocess`: executes in-repo `HybridPronunciationEngine` directly (no external HTTP hop).
- `remote`: forwards exclusively to `MDD_SERVICE_URL`.
- `V2_OFF` / `OFF`: circuit-breaker disabled (HTTP 503).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.services.audio_ingestion import AudioIngestionError, validate_audio_magic_bytes
from app.services.pronunciation.hybrid_engine import ENGINE_VERSION, HybridPronunciationEngine
from app.services.pronunciation.lexical_stress import apply_lexical_stress

logger = logging.getLogger("uvicorn.error.pronunciation_v2_api")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/pronunciation/v2", tags=["Pronunciation Engine V2"])

MDD_SERVICE_URL = os.getenv("MDD_SERVICE_URL", "http://mdd-service:8010")
PRONUNCIATION_ENGINE_MODE = os.getenv("PRONUNCIATION_ENGINE_MODE", "auto").strip().lower()
MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB (AI-10)
UPLOAD_READ_CHUNK_BYTES = 64 * 1024        # 64 KiB


def _resolve_engine_mode() -> str:
    raw = (os.getenv("PRONUNCIATION_ENGINE_MODE") or PRONUNCIATION_ENGINE_MODE or "auto").strip().lower()
    if raw in ("v2_off", "off", "disabled"):
        return "off"
    if raw in ("inprocess", "in_process", "local", "hybrid"):
        return "inprocess"
    if raw in ("remote", "mdd_only"):
        return "remote"
    return "auto"


def _resolve_mdd_url() -> str:
    return (os.getenv("MDD_SERVICE_URL") or MDD_SERVICE_URL or "http://mdd-service:8010").strip().rstrip("/")


async def _read_bounded_audio(file: UploadFile, max_bytes: int = MAX_AUDIO_UPLOAD_BYTES) -> bytes:
    """Stream-read an uploaded audio file in 64 KiB chunks, aborting with 413 over max_bytes."""
    buf = bytearray()
    while True:
        chunk = await file.read(UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        if len(buf) + len(chunk) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail="Audio file exceeds the 25 MiB upload limit.",
            )
        buf.extend(chunk)
    return bytes(buf)


def _mdd_auth_headers() -> dict:
    """Attach X-EC-Service-Key when MDD_SERVICE_KEY is configured (EC-SEC-2026-008)."""
    key = (os.getenv("MDD_SERVICE_KEY") or "").strip()
    return {"X-EC-Service-Key": key} if key else {}


async def _run_inprocess_hybrid(
    raw_bytes: bytes,
    *,
    expected_text: str,
    free_transcript: Optional[str],
    accent: Optional[str],
    session_id: Optional[str],
    attempt_id: Optional[str],
    filename: Optional[str],
    content_type: Optional[str],
) -> dict:
    engine = HybridPronunciationEngine.get_instance()
    return await asyncio.to_thread(
        engine.process_audio,
        raw_bytes,
        expected_text,
        filename=filename or "recording.wav",
        content_type=content_type,
        free_transcript=free_transcript,
        accent=accent,
        session_id=session_id,
        attempt_id=attempt_id,
    )


@router.get("/health")
async def pron_v2_health():
    """Returns status and active deployment mode of the Pronunciation Engine gateway."""
    mode = _resolve_engine_mode()
    return {
        "status": "UP",
        "service": "ai-service-pronunciation-v2-gateway",
        "engine_version": ENGINE_VERSION,
        "mode": mode,
        "mdd_target": _resolve_mdd_url(),
    }


@router.get("/mode")
async def get_mode():
    """Returns active feature flag mode."""
    return {
        "mode": _resolve_engine_mode(),
        "supported_modes": ["auto", "inprocess", "remote", "V2_OFF"],
    }


@router.post("/analyze")
async def analyze_v2(
    file: UploadFile = File(...),
    expected_text: str = Form(...),
    free_transcript: Optional[str] = Form(None),
    accent: Optional[str] = Form(None),
    session_id: Optional[str] = Form(None),
    attempt_id: Optional[str] = Form(None),
):
    """
    Runs pronunciation analysis via configured mode (`auto` | `inprocess` | `remote`).
    Enforces upload size limits, audio magic-byte validation, timeouts, and sanitized error responses.
    """
    if not expected_text or not expected_text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="expected_text is required.",
        )

    raw_bytes = await _read_bounded_audio(file)
    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio file payload is empty.",
        )

    try:
        validate_audio_magic_bytes(raw_bytes)
    except AudioIngestionError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error_code": exc.code, "message": "Unsupported or invalid audio payload."},
        ) from exc

    mode = _resolve_engine_mode()
    if mode == "off":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Pronunciation Engine V2 is currently disabled by feature flag.",
        )

    clean_expected = expected_text.strip()
    clean_free = free_transcript.strip() if free_transcript is not None else None
    clean_accent = accent.strip() if accent else None

    if mode == "inprocess" or (mode == "auto" and HybridPronunciationEngine.checkpoints_available()):
        try:
            return await _run_inprocess_hybrid(
                raw_bytes,
                expected_text=clean_expected,
                free_transcript=clean_free,
                accent=clean_accent,
                session_id=session_id,
                attempt_id=attempt_id,
                filename=file.filename,
                content_type=file.content_type,
            )
        except AudioIngestionError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error_code": exc.code, "message": "Audio payload could not be decoded."},
            ) from exc
        except Exception:
            if mode == "inprocess":
                logger.error("In-process HybridPronunciationEngine failed", exc_info=True)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Pronunciation analysis engine is temporarily unavailable.",
                )
            logger.warning(
                "In-process HybridPronunciationEngine failed in auto mode; falling back to remote MDD service.",
                exc_info=True,
            )

    # `remote` or `auto`: try remote MDD_SERVICE_URL first
    mdd_base = _resolve_mdd_url()
    target_url = f"{mdd_base}/v2/pronunciation/analyze"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            files = {"file": (file.filename or "recording.wav", raw_bytes, file.content_type or "audio/wav")}
            data = {"expected_text": clean_expected}
            if clean_free is not None:
                data["free_transcript"] = clean_free
            if clean_accent:
                data["accent"] = clean_accent
            if session_id:
                data["session_id"] = session_id
            if attempt_id:
                data["attempt_id"] = attempt_id

            resp = await client.post(target_url, files=files, data=data, headers=_mdd_auth_headers())

            if resp.status_code != 200:
                logger.error("MDD V2 returned HTTP %s: %s", resp.status_code, resp.text[:500])
                if resp.status_code >= 500:
                    return JSONResponse(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        content={"detail": "Pronunciation analysis upstream service failed."},
                    )
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"detail": "Pronunciation analysis request was rejected."},
                )

            return await asyncio.to_thread(
                apply_lexical_stress,
                resp.json(),
                raw_bytes,
                file.filename,
                file.content_type,
            )
    except HTTPException:
        raise
    except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as conn_exc:
        if mode == "remote":
            logger.error("Remote MDD service unreachable at %s: %s", mdd_base, type(conn_exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Pronunciation analysis service is temporarily unavailable.",
            ) from conn_exc

        logger.warning(
            "Remote MDD service unreachable at %s (%s); falling back to in-repo HybridPronunciationEngine.",
            mdd_base,
            type(conn_exc).__name__,
        )
        try:
            return await _run_inprocess_hybrid(
                raw_bytes,
                expected_text=clean_expected,
                free_transcript=clean_free,
                accent=clean_accent,
                session_id=session_id,
                attempt_id=attempt_id,
                filename=file.filename,
                content_type=file.content_type,
            )
        except AudioIngestionError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error_code": exc.code, "message": "Audio payload could not be decoded."},
            ) from exc
        except Exception:
            logger.error("In-repo HybridPronunciationEngine fallback failed", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Pronunciation analysis service is temporarily unavailable.",
            )
    except Exception:
        logger.error("Unexpected error in Pronunciation V2 gateway", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal pronunciation analysis failure.",
        )
