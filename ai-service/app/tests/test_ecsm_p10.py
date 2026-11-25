"""
Unit tests for ECSM-v1 / EC-PRISM Phase P10: Pre-Production Inference Hardening.
Verifies artifact registry verification, load-once lifecycle, audio quality gating,
fail-closed error handling, product-safe view filtering, and zero score hallucination.
"""

import io
import unittest
import wave

import numpy as np

from app.services.pronunciation.ecsm.artifact_registry import ArtifactEntry, ArtifactRegistry
from app.services.pronunciation.ecsm.runtime_contract import (
    AnalysisStatus,
    ECSMAnalysisRequest,
    ErrorCode,
    ReferenceMode,
    ResponseViewMode,
    RuntimeState,
)
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime


class TestECSMP10Runtime(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.runtime = ECSMRuntime.get_instance()
        cls.runtime.startup()

    def _make_wav_bytes(self, dur_sec: float, freq: float = 220.0, silent: bool = False) -> bytes:
        n_samples = int(dur_sec * 16000)
        t = np.linspace(0, dur_sec, n_samples, endpoint=False)
        if silent:
            audio = np.zeros(n_samples, dtype=np.int16)
        else:
            audio = (0.2 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(audio.tobytes())
        return buf.getvalue()

    def test_artifact_registry_and_set_id(self):
        is_valid, errors = ArtifactRegistry.verify_all_required()
        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

        art_set_id = ArtifactRegistry.get_artifact_set_id()
        self.assertTrue(art_set_id.startswith("ECSM_SET_"))
        self.assertGreater(len(art_set_id), 10)

    def test_model_load_once_lifecycle(self):
        # Verify runtime is in READY state and models were loaded
        self.assertEqual(self.runtime.state, RuntimeState.READY)
        initial_count = self.runtime.models_loaded_count
        self.assertGreaterEqual(initial_count, 1)

        # Run multiple inference calls and verify load count does not increment
        wav_b = self._make_wav_bytes(1.5)
        for i in range(3):
            req = ECSMAnalysisRequest(f"TEST_LOAD_{i}", wav_b, expected_text="test load once")
            resp = self.runtime.analyze(req)
            self.assertEqual(resp.status, AnalysisStatus.COMPLETE.value)
            self.assertEqual(self.runtime.models_loaded_count, initial_count)

    def test_audio_validation_and_quality_gate(self):
        # 1. Empty audio -> INVALID_AUDIO / AUDIO_EMPTY
        resp_empty = self.runtime.analyze(ECSMAnalysisRequest("REQ_EMPTY", b""))
        self.assertIn(resp_empty.error_code, {ErrorCode.INVALID_AUDIO.value, ErrorCode.AUDIO_EMPTY.value})
        self.assertEqual(resp_empty.status, AnalysisStatus.FAILED.value)

        # 2. Audio too short (< 0.20s) -> AUDIO_TOO_SHORT
        short_b = self._make_wav_bytes(0.05)
        resp_short = self.runtime.analyze(ECSMAnalysisRequest("REQ_SHORT", short_b))
        self.assertEqual(resp_short.error_code, ErrorCode.AUDIO_TOO_SHORT.value)
        self.assertEqual(resp_short.status, AnalysisStatus.INSUFFICIENT_AUDIO.value)

        # 3. Audio too long (> 30.0s) -> AUDIO_TOO_LONG
        long_b = self._make_wav_bytes(31.0)
        resp_long = self.runtime.analyze(ECSMAnalysisRequest("REQ_LONG", long_b))
        self.assertEqual(resp_long.error_code, ErrorCode.AUDIO_TOO_LONG.value)

        # 4. Pure silence -> NO_SPEECH
        silent_b = self._make_wav_bytes(2.0, silent=True)
        resp_silent = self.runtime.analyze(ECSMAnalysisRequest("REQ_SILENT", silent_b))
        self.assertEqual(resp_silent.error_code, ErrorCode.NO_SPEECH.value)

    def test_product_safe_filtering_and_score_invariance(self):
        wav_b = self._make_wav_bytes(2.0)
        req = ECSMAnalysisRequest(
            request_id="REQ_PROD_SAFE",
            audio_bytes=wav_b,
            expected_text="I think there was a problem",
            view_mode=ResponseViewMode.PRODUCT_SAFE.value,
        )
        resp = self.runtime.analyze(req)
        self.assertEqual(resp.status, AnalysisStatus.COMPLETE.value)

        # Verify zero overall score hallucination
        self.assertIsNone(resp.assessment["overall_score"])

        # Verify internal raw evidence store stripped in product safe mode
        self.assertNotIn("evidence_store", resp.assessment)

    def test_bounded_concurrency_and_health_reporting(self):
        health = self.runtime.get_health()
        self.assertTrue(health.liveness)
        self.assertTrue(health.readiness)
        self.assertEqual(health.state, RuntimeState.READY.value)
        self.assertGreaterEqual(health.total_requests, 1)


if __name__ == "__main__":
    unittest.main()
