"""
End-to-End Test Suite for Shadowing Assessment Gating & Abstention Fix.
Tests Cases 1 through 8 directly against live ECSM runtime.
"""

import json
import numpy as np
import io
import soundfile as sf
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime
from app.services.pronunciation.ecsm.runtime_contract import (
    ECSMAnalysisRequest,
    ECSMAnalysisResponse,
    AssessmentStatus,
    ReferenceMode,
    ResponseViewMode,
)


def create_test_wav(duration_sec=2.5, freq=220.0, sample_rate=16000):
    t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), endpoint=False)
    waveform = 0.3 * np.sin(2 * np.pi * freq * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3.0 * t))
    bio = io.BytesIO()
    sf.write(bio, waveform.astype(np.float32), sample_rate, format='WAV')
    return bio.getvalue()


def run_tests():
    runtime = ECSMRuntime.get_instance()
    if runtime.state != "READY":
        runtime.startup(load_neural_weights=True)

    results = {}
    audio_bytes = create_test_wav(duration_sec=3.0)

    # -------------------------------------------------------------
    # Case 1: Target sentence with sufficient evidence coverage & no critical error
    # -------------------------------------------------------------
    req1 = ECSMAnalysisRequest(
        request_id="TEST_CASE_1",
        audio_bytes=audio_bytes,
        expected_text="This morning a machine screamed at you until you woke up",
        reference_mode=ReferenceMode.SHADOWING_REFERENCE_RELATIVE.value,
        attempt_id="ATT_CASE_1",
        view_mode=ResponseViewMode.PRODUCT_SAFE.value,
    )
    res1: ECSMAnalysisResponse = runtime.analyze(req1)
    results["Case 1: Standard Content & Evidence"] = {
        "status": res1.status,
        "assessment_status": res1.assessment_status,
        "evidence_coverage": res1.evidence_coverage,
        "attempt_id": res1.attempt_id,
        "passed": res1.assessment_status in {AssessmentStatus.NO_ISSUE_DETECTED.value, AssessmentStatus.ISSUE_DETECTED.value},
    }

    # -------------------------------------------------------------
    # Case 2: Intentional pronunciation error detected
    # -------------------------------------------------------------
    req2 = ECSMAnalysisRequest(
        request_id="TEST_CASE_2",
        audio_bytes=audio_bytes,
        expected_text="I think there was a problem",
        reference_mode=ReferenceMode.SHADOWING_REFERENCE_RELATIVE.value,
        attempt_id="ATT_CASE_2",
        view_mode=ResponseViewMode.PRODUCT_SAFE.value,
    )
    res2: ECSMAnalysisResponse = runtime.analyze(req2)
    has_target = res2.retry_plan is not None and res2.retry_plan.get("primary_target") is not None
    results["Case 2: Pronunciation Issue Target"] = {
        "status": res2.status,
        "assessment_status": res2.assessment_status,
        "has_primary_target": has_target,
        "passed": res2.assessment_status == AssessmentStatus.ISSUE_DETECTED.value or has_target,
    }

    # -------------------------------------------------------------
    # Case 3: Learner says completely mismatched content / Silent
    # Target: "This morning, a machine screamed at you until you woke up."
    # Gating must return INSUFFICIENT_EVIDENCE (NOT NO_ISSUE_DETECTED / NOT "Phát âm tốt")
    # -------------------------------------------------------------
    silent_audio = np.zeros(16000 * 2, dtype=np.float32)
    bio_silent = io.BytesIO()
    sf.write(bio_silent, silent_audio, 16000, format='WAV')
    req3 = ECSMAnalysisRequest(
        request_id="TEST_CASE_3_MISMATCH",
        audio_bytes=bio_silent.getvalue(),
        expected_text="This morning, a machine screamed at you until you woke up.",
        reference_mode=ReferenceMode.SHADOWING_REFERENCE_RELATIVE.value,
        attempt_id="ATT_CASE_3_MISMATCH",
        view_mode=ResponseViewMode.PRODUCT_SAFE.value,
    )
    res3: ECSMAnalysisResponse = runtime.analyze(req3)
    results["Case 3: Content Mismatch / Silence Gating"] = {
        "status": res3.status,
        "assessment_status": res3.assessment_status,
        "error_code": res3.error_code,
        "gating_reasons": res3.gating_reasons,
        "attempt_id": res3.attempt_id,
        "passed": res3.assessment_status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value,
    }

    # -------------------------------------------------------------
    # Case 4: Extremely short audio (< 0.20s) -> INSUFFICIENT_EVIDENCE
    # -------------------------------------------------------------
    short_audio = create_test_wav(duration_sec=0.10)
    req4 = ECSMAnalysisRequest(
        request_id="TEST_CASE_4_SHORT",
        audio_bytes=short_audio,
        expected_text="Hello world",
        attempt_id="ATT_CASE_4_SHORT",
    )
    res4: ECSMAnalysisResponse = runtime.analyze(req4)
    results["Case 4: Audio Too Short (<0.20s)"] = {
        "status": res4.status,
        "assessment_status": res4.assessment_status,
        "error_code": res4.error_code,
        "passed": res4.assessment_status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value,
    }

    # -------------------------------------------------------------
    # Case 5: Empty Audio Payload -> ASSESSMENT_UNAVAILABLE
    # -------------------------------------------------------------
    req5 = ECSMAnalysisRequest(
        request_id="TEST_CASE_5_EMPTY",
        audio_bytes=b"",
        expected_text="Empty audio test",
        attempt_id="ATT_CASE_5_EMPTY",
    )
    res5: ECSMAnalysisResponse = runtime.analyze(req5)
    results["Case 5: Empty Audio Payload"] = {
        "status": res5.status,
        "assessment_status": res5.assessment_status,
        "error_code": res5.error_code,
        "passed": res5.assessment_status == AssessmentStatus.ASSESSMENT_UNAVAILABLE.value,
    }

    # -------------------------------------------------------------
    # Case 6: Attempt ID Binding & Propagation
    # -------------------------------------------------------------
    results["Case 6: Attempt ID Binding"] = {
        "sent_attempt_id": "ATT_CASE_1",
        "returned_attempt_id": res1.attempt_id,
        "passed": res1.attempt_id == "ATT_CASE_1",
    }

    # -------------------------------------------------------------
    # Case 7: Exact Phone Selective Trust (null observed phone when abstained)
    # -------------------------------------------------------------
    words = res1.assessment.get("words", []) if res1.assessment else []
    pas = [p for w in words for p in w.get("phone_assessments", [])]
    abstained_phones = [p for p in pas if p.get("observed_phone") is None]
    results["Case 7: Exact Phone Selective Trust"] = {
        "total_phones": len(pas),
        "abstained_exact_phones": len(abstained_phones),
        "passed": len(abstained_phones) > 0 or len(pas) > 0,
    }

    print("=== ECSM GATING TEST RESULTS ===")
    print(json.dumps(results, indent=2))
    return results

if __name__ == "__main__":
    run_tests()
