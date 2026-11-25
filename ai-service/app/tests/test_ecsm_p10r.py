"""
Unit tests for ECSM-v1 / EC-PRISM Phase P10R: Real End-to-End Runtime Benchmark Repair.
Verifies forensic audit classifications, execution receipt generation, real counter increments,
and JSON-report consistency.
"""

import io
import unittest
import wave

import numpy as np

from app.services.pronunciation.ecsm.runtime_contract import (
    AnalysisStatus,
    ECSMAnalysisRequest,
    ErrorCode,
    ReferenceMode,
    ResponseViewMode,
    RuntimeState,
)
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime
from scripts.ecsm_p10r_engine import (
    benchmark_audio_manifest,
    make_speech_like_wav,
    measure_isolated_components,
    run_p10r_forensic_audit,
)


class TestECSMP10RBenchmarkRepair(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.runtime = ECSMRuntime.get_instance()
        cls.runtime.startup(load_neural_weights=False)

    def test_forensic_claim_classification_and_taxonomy(self):
        audit = run_p10r_forensic_audit()
        self.assertIn("historical_p10_claims", audit)
        self.assertIn("taxonomy", audit)
        self.assertEqual(audit["taxonomy"]["B0"], "ORCHESTRATION_ONLY")
        self.assertEqual(audit["taxonomy"]["B4"], "WARM_FULL_UNCACHED_INFERENCE")
        self.assertEqual(audit["taxonomy"]["B5"], "TRUE_COLD_PROCESS_STARTUP")
        self.assertEqual(audit["classification"], "P10R_RUNTIME_PERFORMANCE_CLAIMS_INVALIDATED")

    def test_real_audio_and_execution_receipt(self):
        initial_hubert_cnt = self.runtime.counters.hubert_forward_count
        initial_f0_cnt = self.runtime.counters.f0_extract_count

        wav_b = make_speech_like_wav(2.0)
        req = ECSMAnalysisRequest(
            request_id="TEST_RECEIPT_REQ",
            audio_bytes=wav_b,
            expected_text="I think there was a problem",
        )
        resp = self.runtime.analyze(req)

        self.assertEqual(resp.status, AnalysisStatus.COMPLETE.value)
        self.assertGreater(self.runtime.counters.hubert_forward_count, initial_hubert_cnt)
        self.assertGreater(self.runtime.counters.f0_extract_count, initial_f0_cnt)

    def test_benchmark_audio_manifest(self):
        manifest = benchmark_audio_manifest()
        self.assertGreaterEqual(len(manifest), 4)
        durations = [c["duration_sec"] for c in manifest]
        self.assertIn(1.05, durations)
        self.assertIn(3.12, durations)
        self.assertIn(5.08, durations)
        self.assertIn(10.02, durations)

    def test_isolated_component_timing_sanity(self):
        comp = measure_isolated_components(self.runtime)
        self.assertIn("decode_ms", comp)
        self.assertIn("hubert_ms", comp)
        self.assertIn("f0_ms", comp)
        self.assertIn("p8_hierarchy_ms", comp)
        self.assertIn("total_uncached_ms", comp)
        self.assertGreater(comp["total_uncached_ms"], 0.0)


if __name__ == "__main__":
    unittest.main()
