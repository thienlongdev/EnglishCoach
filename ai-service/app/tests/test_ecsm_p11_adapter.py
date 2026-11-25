"""
Unit and integration adapter tests for Phase P11 Slice 1: ECSM AI-Service Endpoint.
Verifies multipart upload handling, product-safe filtering, structured error mapping,
and score hallucination absence through FastAPI test client.
"""

import io
import unittest
import wave

from fastapi.testclient import TestClient
import numpy as np

from app.api.routes.ecsm import router as ecsm_router
from app.main import app
from app.services.pronunciation.ecsm.runtime_contract import AnalysisStatus, ErrorCode
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime

# Ensure ecsm router is registered on app instance in test runner
if not any(hasattr(r, "path") and r.path.startswith("/api/v1/ecsm") for r in app.routes):
    app.include_router(ecsm_router, prefix="/api/v1")


class TestECSMP11Adapter(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.runtime = ECSMRuntime.get_instance()
        cls.runtime.startup(load_neural_weights=False)

    def _make_wav_bytes(self, dur_sec: float = 2.0, silent: bool = False) -> bytes:
        n_samples = int(dur_sec * 16000)
        t = np.linspace(0, dur_sec, n_samples, endpoint=False)
        if silent:
            audio = np.zeros(n_samples, dtype=np.int16)
        else:
            audio = (0.2 * np.sin(2 * np.pi * 220.0 * t) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(audio.tobytes())
        return buf.getvalue()

    def test_ecsm_analyze_endpoint_success(self):
        wav_b = self._make_wav_bytes(2.5)
        files = {"file": ("test.wav", wav_b, "audio/wav")}
        data = {
            "expected_text": "I think there was a problem",
            "reference_mode": "SHADOWING_REFERENCE_RELATIVE",
            "session_id": "SESS_TEST_001",
            "attempt_id": "ATT_TEST_001",
        }
        resp = self.client.post("/api/v1/ecsm/analyze", files=files, data=data)
        self.assertEqual(resp.status_code, 200)

        json_data = resp.json()
        self.assertEqual(json_data["status"], AnalysisStatus.COMPLETE.value)
        self.assertEqual(json_data["errorCode"], ErrorCode.NONE.value)
        self.assertTrue(json_data["segmentalAvailable"])
        self.assertTrue(json_data["prosodyAvailable"])

        # Scientific safety invariants
        self.assertIsNone(json_data["assessment"]["overall_score"])
        self.assertNotIn("evidence_store", json_data["assessment"])
        self.assertIsNotNone(json_data["retryPlan"])

    def test_ecsm_analyze_empty_payload(self):
        files = {"file": ("empty.wav", b"", "audio/wav")}
        resp = self.client.post("/api/v1/ecsm/analyze", files=files, data={"expected_text": "Hello"})
        self.assertEqual(resp.status_code, 400)

    def test_ecsm_health_endpoint(self):
        resp = self.client.get("/api/v1/ecsm/health")
        self.assertEqual(resp.status_code, 200)
        json_data = resp.json()
        self.assertTrue(json_data["liveness"])
        self.assertTrue(json_data["readiness"])
        self.assertEqual(json_data["state"], "READY")


if __name__ == "__main__":
    unittest.main()
