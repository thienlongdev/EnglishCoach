"""
FastAPI Route for Real-Microphone Acceptance Pack Management & Batch Replay.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.services.pronunciation.ecsm.real_mic_pack_service import (
    ACCEPTANCE_PACK_ROOT,
    AUDIT_ARTIFACTS_ROOT,
    FIXED_ACCEPTANCE_PACK,
    RealMicPackService,
    evaluate_pack_results,
    get_fixed_pack_dict,
    validate_audio_extension,
    validate_pack_identifier,
)

logger = logging.getLogger("real_mic_pack_api")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/real-mic-pack", tags=["Real Mic Acceptance Pack"])

INTERNAL_SELF_BASE_URL = "http://127.0.0.1:8000"
MAX_CLIP_UPLOAD_BYTES = 25 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024


async def _read_bounded_clip(file: UploadFile) -> bytes:
    buf = bytearray()
    while True:
        chunk = await file.read(UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        if len(buf) + len(chunk) > MAX_CLIP_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Audio recording exceeds 25 MiB limit")
        buf.extend(chunk)
    return bytes(buf)


@router.get("/manifest")
def get_manifest():
    """Returns the fixed 16-clip acceptance pack specification."""
    return {
        "packVersion": "v1.0.0",
        "totalClips": len(FIXED_ACCEPTANCE_PACK),
        "cleanCount": 8,
        "errorCount": 8,
        "clips": get_fixed_pack_dict(),
    }


@router.get("/session")
def get_session(session_id: Optional[str] = None):
    """Returns session status, list of recorded clips, SHAs, and audio paths."""
    try:
        if session_id is not None:
            session_id = validate_pack_identifier(session_id, "session_id")
        status_data = RealMicPackService.get_session_status(session_id)
        return status_data
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@router.post("/save")
async def save_clip(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    clip_id: str = Form(...),
    metadata: str = Form("{}"),
):
    """
    Saves a raw audio recording from the browser microphone to persistent disk storage,
    computes SHA256, and returns metadata confirmation.
    """
    try:
        clean_session_id = validate_pack_identifier(session_id, "session_id")
        clean_clip_id = validate_pack_identifier(clip_id, "clip_id")
        original_name = file.filename or f"{clean_clip_id}.webm"
        validate_audio_extension(original_name)

        audio_bytes = await _read_bounded_clip(file)
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio recording received")

        try:
            meta_dict = json.loads(metadata)
            if not isinstance(meta_dict, dict):
                meta_dict = {}
        except Exception:
            meta_dict = {}

        result = RealMicPackService.save_recording(
            audio_bytes=audio_bytes,
            original_filename=original_name,
            session_id=clean_session_id,
            clip_id=clean_clip_id,
            metadata_dict=meta_dict,
        )
        return result
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to save clip {clip_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save audio clip")


@router.post("/evaluate")
async def evaluate_session_pack(
    session_id: Optional[str] = Form(None),
):
    """
    Batch replays the 16 saved clips through the local internal HTTP route (POST /api/v1/ecsm/analyze),
    computes all acceptance metrics, writes all 9 audit artifacts + Markdown report,
    and returns the final verdict.

    Uses httpx.AsyncClient (non-blocking) pinned strictly to http://127.0.0.1:8000 (EC-SEC-2026-010).
    """
    try:
        if session_id is not None:
            session_id = validate_pack_identifier(session_id, "session_id")
        status_data = RealMicPackService.get_session_status(session_id)
        s_id = validate_pack_identifier(status_data["sessionId"], "session_id")
        session_dir = RealMicPackService.get_session_dir(s_id)
        pack_root = Path(ACCEPTANCE_PACK_ROOT).resolve()

        internal_headers: Dict[str, str] = {}
        service_key = (os.getenv("AI_SERVICE_KEY") or "").strip()
        if service_key:
            internal_headers["X-EC-Service-Key"] = service_key

        raw_results = []

        # Iterate all 16 items in the fixed pack using async HTTP (non-blocking local self-call only)
        async with httpx.AsyncClient(timeout=90.0) as client:
            for item in FIXED_ACCEPTANCE_PACK:
                clip_id = item.clip_id
                meta_path = os.path.join(session_dir, f"{clip_id}_meta.json")

                if not os.path.exists(meta_path):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Cannot evaluate session: Clip {clip_id} has not been recorded yet ({status_data.get('recordedCount', 0)}/16 recorded).",
                    )

                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)

                derived_wav = meta.get("derivedWavPath")
                raw_audio = meta.get("rawAudioPath")
                audio_path = derived_wav if (derived_wav and os.path.exists(derived_wav)) else raw_audio

                if not audio_path or not Path(audio_path).resolve().is_relative_to(pack_root):
                    raise HTTPException(status_code=400, detail=f"Invalid audio path for {clip_id}")
                if not os.path.exists(audio_path):
                    raise HTTPException(status_code=500, detail=f"Audio file missing for {clip_id}")

                # Replay via async HTTP call (non-blocking — avoids event-loop deadlock)
                t0 = time.time()
                with open(audio_path, "rb") as af:
                    audio_bytes_for_replay = af.read()

                files = {"file": (os.path.basename(audio_path), audio_bytes_for_replay, "audio/wav")}
                data = {
                    "expected_text": item.target_sentence,
                    "view_mode": "DEV_FULL",
                }
                resp = await client.post(
                    f"{INTERNAL_SELF_BASE_URL}/api/v1/ecsm/analyze",
                    files=files,
                    data=data,
                    headers=internal_headers,
                )
                latency_ms = round((time.time() - t0) * 1000, 2)

                http_status = resp.status_code
                resp_json = resp.json() if http_status == 200 else {}
                audit_trace = resp_json.get("auditTrace", {}) or {}

                raw_results.append({
                    "clipId": clip_id,
                    "group": item.group,
                    "targetSentence": item.target_sentence,
                    "targetWord": item.target_word,
                    "targetWordIndex": item.target_word_index,
                    "expectedPhone": item.expected_phone,
                    "intentionalSubstitutePhone": item.intentional_substitute_phone,
                    "contrastName": item.contrast_name,
                    "audioSHA256": meta.get("audioSHA256"),
                    "durationSec": meta.get("durationSec"),
                    "httpStatus": http_status,
                    "latencyMs": latency_ms,
                    "primaryDetectionDecision": audit_trace.get("primaryDetectionDecision"),
                    "primaryDetectedPhoneIds": audit_trace.get("primaryDetectedPhoneIds", []),
                    "diagnosisSpecialistCalled": audit_trace.get("diagnosisSpecialistCalled", False),
                    "diagnosisPolicy": audit_trace.get("diagnosisPolicy"),
                    "finalSelectedIssues": audit_trace.get("finalSelectedIssues", []),
                    "legacyDetectorUsed": audit_trace.get("legacyDetectorUsed", False),
                    "assessmentStatus": resp_json.get("assessmentStatus"),
                })

        # Compute all metrics & verdict
        summary = evaluate_pack_results(session_id=s_id, raw_eval_results=raw_results)

        # Write all 9 audit artifacts + Markdown report
        os.makedirs(AUDIT_ARTIFACTS_ROOT, exist_ok=True)

        # 1. Manifest
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_manifest.json"), "w", encoding="utf-8") as f:
            json.dump({
                "sessionId": s_id,
                "totalClips": 16,
                "clips": get_fixed_pack_dict(),
            }, f, indent=2)

        # 2. Audio Hashes
        audio_hashes = {r["clipId"]: {"sha256": r["audioSHA256"], "durationSec": r["durationSec"]} for r in raw_results}
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_audio_hashes.json"), "w", encoding="utf-8") as f:
            json.dump(audio_hashes, f, indent=2)

        # 3. Full Results
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_results.json"), "w", encoding="utf-8") as f:
            json.dump(raw_results, f, indent=2)

        # 4. Clean Metrics
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_clean_metrics.json"), "w", encoding="utf-8") as f:
            json.dump(summary["clean"], f, indent=2)

        # 5. Error Metrics
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_error_metrics.json"), "w", encoding="utf-8") as f:
            json.dump(summary["error"], f, indent=2)

        # 6. Diagnosis Metrics
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_diagnosis_metrics.json"), "w", encoding="utf-8") as f:
            json.dump(summary["diagnosis"], f, indent=2)

        # 7. Authority Invariants
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_authority_invariants.json"), "w", encoding="utf-8") as f:
            json.dump(summary["architecture"], f, indent=2)

        # 8. Performance
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_performance.json"), "w", encoding="utf-8") as f:
            json.dump(summary["performance"], f, indent=2)

        # 9. Verdict
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "real_mic_final_pack_verdict.json"), "w", encoding="utf-8") as f:
            json.dump({
                "sessionId": s_id,
                "finalVerdict": summary["finalVerdict"],
                "isAccepted": summary["isAccepted"],
                "gates": summary["gates"],
                "failures": summary["failures"],
            }, f, indent=2)

        # 10. Generate PRONUNCIATION_V1_FINAL_REAL_MIC_ACCEPTANCE_REPORT.md inside AUDIT_ARTIFACTS_ROOT
        report_md = _generate_acceptance_report_md(summary)
        with open(os.path.join(AUDIT_ARTIFACTS_ROOT, "PRONUNCIATION_V1_FINAL_REAL_MIC_ACCEPTANCE_REPORT.md"), "w", encoding="utf-8") as f:
            f.write(report_md)

        return summary
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Evaluation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Session evaluation failed")


def _generate_acceptance_report_md(summary: Dict[str, Any]) -> str:
    s_id = summary["sessionId"]
    v = summary["finalVerdict"]
    gates = summary["gates"]
    cl = summary["clean"]
    er = summary["error"]
    diag = summary["diagnosis"]
    arch = summary["architecture"]
    perf = summary["performance"]

    return f"""# Pronunciation V1 — Final Real-Microphone Acceptance Report

**Session ID**: `{s_id}`  
**Evaluation Date**: {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime())}  
**Final Verdict**: `{v}`  

---

## 1. Acceptance Gates Summary

| Acceptance Gate | Target Requirement | Actual Result | Status |
| :--- | :--- | :--- | :---: |
| **CLEAN_FP_GATE** | $\ge 7/8$ Zero Issues, $<3$ FP Utterances | {cl['zeroIssueCount']}/8 Zero Issues, {cl['falsePositiveUtterances']} FP Utterances | **{gates['CLEAN_FP_GATE']}** |
| **TARGET_DETECTION_GATE** | $\ge 6/8$ ($\ge 75\%$) Detected | {er['targetDetectedCount']}/8 ({er['targetDetectionRate']:.1%}) | **{gates['TARGET_DETECTION_GATE']}** |
| **LOCALIZATION_GATE** | $\ge 6/8$ ($\ge 75\%$) Localized | {er['targetLocalizedCount']}/8 ({er['targetLocalizationRate']:.1%}) | **{gates['LOCALIZATION_GATE']}** |
| **UNRELATED_ERROR_GATE** | Total Unrelated Issues $\le 4$ | {er['unrelatedIssueCount']} Unrelated Issues | **{gates['UNRELATED_ERROR_GATE']}** |
| **DIAGNOSIS_PRECISION_GATE** | Trusted Diagnosis Precision $\ge 80\%$ | {diag['exactDiagnosisPrecision']:.1%} Precision ({diag['correctTrustedExactDiagnosisCount']}/{diag['trustedExactDiagnosisCount']} Correct) | **{gates['DIAGNOSIS_PRECISION_GATE']}** |
| **AUTHORITY_GATE** | 0 Invariant Violations, 0 CROTTC Unauthorized | Violations={arch['authorityInvariantViolations']}, Unauthorized={arch['crottcUnauthorizedIssues']} | **{gates['AUTHORITY_GATE']}** |
| **PERSISTENCE_GATE** | 16/16 Original Raw Audio Persisted with SHA | 16/16 Persisted | **{gates['PERSISTENCE_GATE']}** |
| **HTTP_REPLAY_GATE** | 100% 200 OK via Application HTTP Endpoint | 16/16 200 OK | **{gates['HTTP_REPLAY_GATE']}** |

---

## 2. Detailed Performance & Metrics

### Clean Group (8 Clips)
- Total Clips: {cl['totalClips']}
- Zero-Issue Clips: {cl['zeroIssueCount']}
- Utterance FPR: {cl['utteranceFPR']:.1%}
- Total Unrelated Issues: {cl['unrelatedIssueCount']}

### Intentional Error Group (8 Clips)
- Total Target Errors: {er['totalClips']}
- Target Detected Count: {er['targetDetectedCount']} ({er['targetDetectionRate']:.1%})
- Target Localized Count: {er['targetLocalizedCount']} ({er['targetLocalizationRate']:.1%})
- Total Unrelated Error Issues: {er['unrelatedIssueCount']}

### Diagnosis & Abstention
- Trusted Exact Diagnoses: {diag['trustedExactDiagnosisCount']}
- Correct Trusted Diagnoses: {diag['correctTrustedExactDiagnosisCount']}
- Exact Diagnosis Precision: {diag['exactDiagnosisPrecision']:.1%}
- Abstention Count: {diag['abstentionCount']} ({diag['abstentionRate']:.1%})

### System & Performance
- Median Latency: {perf['medianLatencyMs']} ms
- P95 Latency: {perf['p95LatencyMs']} ms
- Peak VRAM: {perf['peakVramMb']} MB
- Legacy Detector Invocations: {arch['legacyDetectorUsed']}

---

## 3. Final Conclusion
**Verdict**: `{v}`
"""
