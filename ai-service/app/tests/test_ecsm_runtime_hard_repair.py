import hashlib
import io
import math
import struct
import wave

from app.services.pronunciation.ecsm.hierarchical_assessment import HierarchicalAssessmentEngine
from app.services.pronunciation.ecsm.runtime_contract import (
    CONTENT_PHONETIC_GATE_MIN_MATCH,
    ECSMAnalysisRequest,
    RuntimeState,
)
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime


CASE_B_TEXT = "This morning, a machine screamed at you until you woke up."
CASE_C_TEXT = "So I think what I'll do is just call you a storyteller."


def _wav_bytes(duration_sec: float = 1.2, sample_rate: int = 16000) -> bytes:
    frames = bytearray()
    for index in range(int(duration_sec * sample_rate)):
        sample = int(0.16 * 32767 * math.sin(2 * math.pi * 180 * index / sample_rate))
        frames.extend(struct.pack("<h", sample))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))
    return output.getvalue()


def _runtime(pitch_extractor=None) -> ECSMRuntime:
    runtime = ECSMRuntime(enable_cache=False)
    runtime.state = RuntimeState.READY
    runtime.artifact_set_id = "ECSM_SET_TEST"
    runtime.acoustic_model = None
    runtime.processor = None
    runtime.assessment_engine = HierarchicalAssessmentEngine()
    runtime.pitch_extractor = pitch_extractor
    return runtime


def _request(
    expected_text: str,
    *,
    content_match_ratio: float,
    matched_indices: list[int],
    attempt_id: str,
    recognized_text: str | None = None,
    audio_identity: str | None = None,
) -> ECSMAnalysisRequest:
    audio = _wav_bytes()
    return ECSMAnalysisRequest(
        request_id=f"REQ_{attempt_id}",
        attempt_id=attempt_id,
        case_id=attempt_id[-1:],
        audio_bytes=audio,
        audio_format="wav",
        source_mime_type="audio/wav",
        source_filename="fixture.wav",
        expected_text=expected_text,
        recognized_text=recognized_text or expected_text,
        content_match_ratio=content_match_ratio,
        matched_target_word_indices=matched_indices,
        audio_identity=audio_identity or hashlib.sha256(audio).hexdigest(),
    )


def test_case_a_content_gate_is_successful_early_abstention():
    runtime = _runtime()
    before_p8 = runtime.counters.p8_assessment_count
    response = runtime.analyze(
        _request(
            CASE_B_TEXT,
            content_match_ratio=0.18,
            matched_indices=[],
            attempt_id="CASE_A",
            recognized_text="Hello excuse me sir",
        )
    )

    assert CONTENT_PHONETIC_GATE_MIN_MATCH == 0.50
    assert response.status == "COMPLETE"
    assert response.assessment_status == "INSUFFICIENT_EVIDENCE"
    assert response.error_code == "NONE"
    assert response.gating_reasons == ["CONTENT_DIVERGENCE_GATED"]
    assert response.segmental_available is False
    assert response.prosody_available is False
    assert response.target_phone_coverage == 0.0
    assert response.assessment["primary_issues"] == []
    assert response.assessment["coverage_stats"]["exact_phone_trusted_count"] == 0
    assert response.retry_plan["primary_target"]["issue_type"] == "CONTENT_MISMATCH"
    assert runtime.counters.p8_assessment_count == before_p8


def test_case_b_completes_dynamic_target_hierarchy():
    response = _runtime().analyze(
        _request(CASE_B_TEXT, content_match_ratio=1.0, matched_indices=list(range(11)), attempt_id="CASE_B")
    )
    assert response.status == "COMPLETE"
    assert response.error_code == "NONE"
    words = response.assessment["words"]
    assert [word["word"] for word in words] == [
        "This", "morning", "a", "machine", "screamed", "at", "you", "until", "you", "woke", "up"
    ]
    _assert_hierarchy_ids(words, response.request_id)


def test_case_c_contraction_and_theta_target_bind_cleanly():
    response = _runtime().analyze(
        _request(CASE_C_TEXT, content_match_ratio=1.0, matched_indices=list(range(12)), attempt_id="CASE_C")
    )
    assert response.status == "COMPLETE"
    assert response.error_code == "NONE"
    words = response.assessment["words"]
    assert [word["word"] for word in words] == [
        "So", "I", "think", "what", "I'll", "do", "is", "just", "call", "you", "a", "storyteller"
    ]
    think = next(word for word in words if word["word"].lower() == "think")
    assert [phone["expected_phone"] for phone in think["phone_assessments"]] == ["θ", "ɪ", "ŋ", "k"]
    _assert_hierarchy_ids(words, response.request_id)


def test_partial_content_abstains_only_mismatched_target_region():
    target = "I think this is good."
    response = _runtime().analyze(
        _request(target, content_match_ratio=0.8, matched_indices=[0, 1, 3, 4], attempt_id="CASE_PARTIAL")
    )
    assert response.status == "COMPLETE"
    words = response.assessment["words"]
    blocked = next(word for word in words if word["word"].lower() == "this")
    assert blocked["word_status"] == "INSUFFICIENT_EVIDENCE"
    assert blocked["issues"] == []
    assert all(phone["status"] == "ABSTAINED" and phone["observed_phone"] is None for phone in blocked["phone_assessments"])
    allowed = next(word for word in words if word["word"].lower() == "think")
    assert all(phone["status"] != "ABSTAINED" for phone in allowed["phone_assessments"])


def test_contractions_and_punctuation_never_crash_target_builder():
    target = 'I\'ll I\'m I\'ve don\'t can\'t won\'t you\'re we\'re they\'ll morning, up. storyteller. don\'t. "think"'
    token_count = len(target.split())
    response = _runtime().analyze(
        _request(target, content_match_ratio=1.0, matched_indices=list(range(token_count)), attempt_id="ROBUSTNESS")
    )
    assert response.status in {"COMPLETE", "PARTIAL_SUCCESS"}
    assert response.error_code == "NONE"
    words = [word["word"] for word in response.assessment["words"]]
    assert words[:9] == ["I'll", "I'm", "I've", "don't", "can't", "won't", "you're", "we're", "they'll"]
    assert words[-5:] == ["morning", "up", "storyteller", "don't", "think"]


def test_optional_pitch_failure_preserves_segmental_assessment_as_partial():
    class FailingPitchExtractor:
        def extract(self, _waveform):
            raise RuntimeError("forced optional P7 failure")

    response = _runtime(FailingPitchExtractor()).analyze(
        _request(CASE_B_TEXT, content_match_ratio=1.0, matched_indices=list(range(11)), attempt_id="OPTIONAL_P7")
    )
    assert response.status == "PARTIAL_SUCCESS"
    assert response.assessment_status == "PARTIAL"
    assert response.segmental_available is True
    assert response.prosody_available is False
    assert "P7_PITCH" in response.unavailable_subsystems
    assert response.assessment is not None


def test_audio_identity_mismatch_fails_before_inference():
    request = _request(CASE_B_TEXT, content_match_ratio=1.0, matched_indices=list(range(11)), attempt_id="BAD_AUDIO_ID")
    request.audio_identity = "0" * 64
    response = _runtime().analyze(request)
    assert response.status == "FAILED"
    assert response.error_code == "AUDIO_IDENTITY_MISMATCH"
    assert response.failure_stage == "AUDIO_DECODE"


def _assert_hierarchy_ids(words: list[dict], request_id: str) -> None:
    word_ids = [word["word_id"] for word in words]
    phone_ids = [phone["phone_id"] for word in words for phone in word["phone_assessments"]]
    assert len(word_ids) == len(set(word_ids))
    assert len(phone_ids) == len(set(phone_ids))
    assert all(request_id in word_id for word_id in word_ids)
    assert all(request_id in phone_id for phone_id in phone_ids)
    for word in words:
        for issue in word["issues"]:
            assert issue["target_info"]["wordId"] == word["word_id"]
            assert issue["target_info"]["sentenceId"] == request_id
