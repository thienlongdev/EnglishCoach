"""
Verification suite for Echo JARVIS Reforge ADR-1 GPU Speech Stack:
1. 100% Commercial-clean licensing: ZERO `CC-BY-NC` OmniVoice AND ZERO in-process GPLv3+
   (`phonemizer`, `espeakng_loader`, `misaki.espeak`, `kokoro.pipeline`) in TTS stack.
2. Pure-Python `KokoroOovFallback` 114-symbol Kokoro vocab validity across English Coach terms.
3. `jarvis-tts-v2`: Kokoro-82M (EN) + VieNeu-TTS-v3-Turbo ONNX INT8 (VI & EN-VI code-switching),
   consistent male/female pairing, `-18 LUFS` loudness parity, `8 ms` cosine crossfade,
   6-way concurrency, WAV drop-in + raw 24 kHz PCM16LE streaming.
4. 7-Layer Zero-Hallucination Streaming ASR Shield (`/api/v1/coach/transcribe`):
   - L1 RMS floor (`rms_silence`, 0 GPU compute)
   - L2 Universal `vad_filter=True` on ALL partials & finals
   - L3 Zero `hotwords` / `initial_prompt` poisoning
   - L4 Anti-loop decoding params (`temperature=(0.0,0.2,0.4)`, `no_repeat_ngram_size=3`, `repetition_penalty=1.10`)
   - L5 Constrained EN/VI language resolution (no `id`/`es`/`ko`/`pt`/`zh` leaks)
   - L6 Hard rejection of `"Writing, Writing, Writing..."` loops, high compression ratio, low logprob, phantom phrases
   - L7 Post-ASR domain canonicalizer (`IELTS`, `TOEIC`, `CEFR`, `Echo Jarvis`, `Odyssey`, `Study Space`)
   - Final-over-Partial priority gate (`_AsrPriorityGate`) & `LocalAgreement-2` partial stabilizer
   - Complete isolation from `listening_local_asr._RUN_LOCK`
5. `Smart Turn v3.2` semantic endpointing (`/api/v1/coach/turn-check`) in `< 15 ms`.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import io
import math
import threading
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.coach import router as coach_router
from app.api.routes.tts import router as tts_router
from app.services import listening_local_asr
from app.services.echo_realtime_voice import (
    EchoRealtimeVoiceService,
    LocalAgreementStabilizer,
    _AsrPriorityGate,
    apply_quiet_speech_pregain,
    canonicalize_domain_terms,
    compute_rms_dbfs,
    compute_smart_turn_log_mel,
    compute_windowed_rms_stats,
    has_repetition_loop,
)
from app.services.tts.jarvis_tts_service import (
    CROSSFADE_SAMPLES,
    ENGINE_ID,
    SAMPLE_RATE,
    VOICE_REGISTRY,
    JarvisTtsService,
    crossfade_float32_chunks,
    detect_clause_language,
    has_speakable_content,
    normalize_loudness_lufs,
    sanitize_speakable_text,
    split_text_clauses,
)
from app.services.tts.kokoro_oov_g2p import KOKORO_VOCAB_CHARS, KokoroOovFallback
from app.services.tts.omnivoice_service import OmniVoiceService

APP_DIR = Path(__file__).resolve().parents[1]


def _make_speech_pcm16(duration_sec: float = 1.0, amp: float = 0.25, freq: float = 220.0) -> bytes:
    n = int(round(duration_sec * 16000))
    t = np.arange(n, dtype=np.float32) / 16000.0
    sig = amp * np.sin(2.0 * np.pi * freq * t)
    return np.clip(np.rint(sig * 32767.0), -32768, 32767).astype("<i2").tobytes()


@pytest.fixture
def voice_test_app() -> TestClient:
    app = FastAPI()
    app.include_router(coach_router, prefix="/api/v1")
    app.include_router(tts_router)
    app.include_router(tts_router, prefix="/api/v1")
    return TestClient(app)


def test_zero_noncommercial_omnivoice_zero_gpl_tts_and_zero_listening_lock_coupling():
    tts_svc_src = (APP_DIR / "services" / "tts" / "omnivoice_service.py").read_text(encoding="utf-8")
    jarvis_src = (APP_DIR / "services" / "tts" / "jarvis_tts_service.py").read_text(encoding="utf-8")
    oov_src = (APP_DIR / "services" / "tts" / "kokoro_oov_g2p.py").read_text(encoding="utf-8")
    rt_src = (APP_DIR / "services" / "echo_realtime_voice.py").read_text(encoding="utf-8")
    coach_src = (APP_DIR / "api" / "routes" / "coach.py").read_text(encoding="utf-8")

    for src in (tts_svc_src, jarvis_src, oov_src):
        assert "from omnivoice" not in src
        assert "import omnivoice" not in src
        assert "OmniVoice.from_pretrained" not in src
        # ADR-1: ZERO in-process GPLv3+ phonemizer / libespeak-ng imports!
        assert "import phonemizer" not in src
        assert "from phonemizer" not in src
        assert "import espeakng_loader" not in src
        assert "from espeakng_loader" not in src
        assert "EspeakBackend" not in src
        assert "EspeakFallback" not in src
        assert "from kokoro import KPipeline" not in src

    # Ensure real-time coach ASR never imports or touches listening_local_asr._RUN_LOCK
    assert "listening_local_asr" not in coach_src
    assert "_RUN_LOCK" not in coach_src
    assert "from app.services import listening_local_asr" not in rt_src
    assert "from app.services.listening_local_asr" not in rt_src
    assert ENGINE_ID == "jarvis-tts-v2"


def test_kokoro_oov_g2p_114_vocab_validity_us_and_uk():
    words = [
        "IELTS", "TOEIC", "TOEFL", "CEFR", "Jarvis", "Echo", "Kokoro", "VieNeu",
        "Odyssey", "Flashcards", "Shadowing", "MyBooks", "StudySpace", "Hanoi",
        "Saigon", "Vietnam", "B2", "C1", "PDF", "API", "ESL", "Procrastination",
        "unbelievable", "supercalifragilistic", "re-reading", "2026",
    ]
    for british in (False, True):
        fb = KokoroOovFallback(british=british)
        for w in words:
            ph, rating = fb(SimpleNamespace(text=w))
            assert ph is not None and len(ph) > 0, f"Empty OOV phonemes for {w}"
            assert rating in (2, 3)
            bad = [c for c in ph if c not in KOKORO_VOCAB_CHARS]
            assert bad == [], f"Invalid Kokoro vocab chars {bad} for '{w}' -> '{ph}'"


def test_bilingual_clause_detection_voice_gender_pairing_lufs_and_crossfade():
    assert detect_clause_language("Hello, welcome back to Study Space!", "auto") == "en"
    assert detect_clause_language("Chào bạn, hôm nay chúng ta luyện IELTS nhé.", "auto") == "vi"
    assert detect_clause_language("Mình sẽ mở Reading và tạo Flashcards cho bài IELTS này ngay nhé!", "auto") == "vi"
    assert detect_clause_language("xin chao ban minh giup duoc gi", "auto") == "vi"
    assert detect_clause_language("Chào bạn", "en") == "en"
    assert detect_clause_language("Hello world", "vi") == "vi"

    # Distinct male & female VieNeu presets paired to canonical voices (no female-only whiplash)
    assert VOICE_REGISTRY["us_male"]["vieneu_voice"] != VOICE_REGISTRY["us_female"]["vieneu_voice"]
    assert VOICE_REGISTRY["uk_male"]["vieneu_voice"] != VOICE_REGISTRY["uk_female"]["vieneu_voice"]
    assert len({v["vieneu_voice"] for v in VOICE_REGISTRY.values()}) == 4

    mixed = "Hãy lặp lại câu mẫu sau: Practice makes perfect. Keep going every day!"
    clauses = split_text_clauses(mixed)
    assert len(clauses) >= 3
    assert detect_clause_language(clauses[0], "auto") == "vi"
    assert detect_clause_language(clauses[1], "auto") == "en"

    # Loudness normalization keeps EN (-26 dBFS raw) and VI (-14 dBFS raw) within < 1.0 dB!
    t = np.arange(12000, dtype=np.float32) / SAMPLE_RATE
    quiet_en = 0.05 * np.sin(2.0 * np.pi * 220.0 * t)
    loud_vi = 0.45 * np.sin(2.0 * np.pi * 310.0 * t)
    norm_en = normalize_loudness_lufs(quiet_en)
    norm_vi = normalize_loudness_lufs(loud_vi)
    db_en = 20.0 * math.log10(float(np.sqrt(np.mean(norm_en ** 2))))
    db_vi = 20.0 * math.log10(float(np.sqrt(np.mean(norm_vi ** 2))))
    assert abs(db_en - db_vi) < 1.0
    assert float(np.max(np.abs(norm_en))) <= 0.941
    assert float(np.max(np.abs(norm_vi))) <= 0.941

    # 8 ms cosine overlap-add crossfade removes hard step discontinuity
    c1 = np.full(1000, 0.25, dtype=np.float32)
    c2 = np.full(1000, -0.25, dtype=np.float32)
    merged = crossfade_float32_chunks([c1, c2], fade_samples=CROSSFADE_SAMPLES)
    assert merged.size == 2000 - CROSSFADE_SAMPLES
    assert float(np.max(np.abs(np.diff(merged)))) < 0.02


def test_tts_omnivoice_dropin_and_streaming_contracts_with_concurrency(monkeypatch, voice_test_app: TestClient):
    svc = JarvisTtsService()
    svc._is_loaded = True
    svc._device = "cuda"

    def fake_en(clause: str, voice_id: str) -> np.ndarray:
        time.sleep(0.005)
        t = np.linspace(0.0, 0.12, int(0.12 * SAMPLE_RATE), endpoint=False, dtype=np.float32)
        return normalize_loudness_lufs(0.35 * np.sin(2.0 * np.pi * 220.0 * t))

    def fake_vi_stream(clause: str, voice_id: str):
        time.sleep(0.005)
        t = np.linspace(0.0, 0.08, int(0.08 * SAMPLE_RATE), endpoint=False, dtype=np.float32)
        yield normalize_loudness_lufs(0.35 * np.sin(2.0 * np.pi * 310.0 * t))
        yield normalize_loudness_lufs(0.35 * np.sin(2.0 * np.pi * 330.0 * t))

    monkeypatch.setattr(svc, "_synth_en_clause", fake_en)
    monkeypatch.setattr(svc, "_stream_vi_clause_float32", fake_vi_stream)
    monkeypatch.setattr(JarvisTtsService, "get_instance", classmethod(lambda cls: svc))
    OmniVoiceService._instance = OmniVoiceService(delegate=svc)

    # 1. Public voices metadata
    voices_res = voice_test_app.get("/api/v1/tts/omnivoice/voices")
    assert voices_res.status_code == 200
    voice_ids = {v["voiceId"] for v in voices_res.json()["voices"]}
    assert voice_ids == {"us_female", "us_male", "uk_female", "uk_male"}

    # 2. Drop-in WAV on both /tts/omnivoice and /api/v1/tts/omnivoice
    for path in ("/tts/omnivoice", "/api/v1/tts/omnivoice"):
        res = voice_test_app.post(path, json={"text": "At your service. Chào bạn nhé!", "voiceId": "uk_male"})
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("audio/wav")
        assert res.headers["X-TTS-Engine"] == "jarvis-tts-v2"
        assert float(res.headers["X-Synthesis-Latency"]) >= 0.0
        assert float(res.headers["X-Audio-Duration"]) > 0.2
        with wave.open(io.BytesIO(res.content), "rb") as wf:
            assert wf.getframerate() == SAMPLE_RATE
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2

    # 3. 6 simultaneous concurrent requests must all succeed with 200 OK
    def _call_one(idx: int) -> int:
        vid = ["us_female", "us_male", "uk_female", "uk_male"][idx % 4]
        r = voice_test_app.post("/api/v1/tts/omnivoice", json={"text": f"Concurrent check {idx}.", "voiceId": vid})
        return r.status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(_call_one, range(6)))
    assert statuses == [200] * 6

    # 4. Streaming PCM16LE on both /tts/stream and /api/v1/tts/stream + multi-chunk generator verification
    direct_chunks = list(
        svc.stream_pcm_chunks("First clause ready. Câu thứ hai bằng tiếng Việt.", "us_female", lang="auto")
    )
    assert len(direct_chunks) >= 2
    assert all(len(c) > 0 and len(c) % 2 == 0 for c in direct_chunks)

    for path in ("/tts/stream", "/api/v1/tts/stream"):
        with voice_test_app.stream(
            "POST",
            path,
            json={"text": "First clause ready. Câu thứ hai bằng tiếng Việt.", "voiceId": "us_female", "lang": "auto"},
        ) as sres:
            assert sres.status_code == 200
            assert sres.headers["content-type"] == "audio/pcm;rate=24000;encoding=signed-integer;bits=16"
            assert sres.headers["X-Sample-Rate"] == "24000"
            assert sres.headers["X-TTS-Engine"] == "jarvis-tts-v2"
            total = b"".join(c for c in sres.iter_bytes() if c)
            assert len(total) > 4800 and len(total) % 2 == 0

    # 5. Reject invalid voiceId cleanly
    bad = voice_test_app.post("/api/v1/tts/stream", json={"text": "Hi", "voiceId": "invalid_voice"})
    assert bad.status_code == 422


def test_realtime_asr_7_layer_zero_hallucination_shield_and_isolation(monkeypatch, voice_test_app: TestClient):
    rt = EchoRealtimeVoiceService()
    calls = []
    next_response = {
        "segments": [
            SimpleNamespace(
                text="hi echo open reading for i elts",
                avg_logprob=-0.22,
                no_speech_prob=0.03,
                compression_ratio=1.15,
            )
        ],
        "info": SimpleNamespace(language="en", language_probability=0.97, all_language_probs=[("en", 0.97), ("vi", 0.02)]),
    }

    class FakeWhisper:
        def transcribe(self, audio, **kwargs):
            calls.append(kwargs)
            return next_response["segments"], next_response["info"]

    rt._asr_model = FakeWhisper()
    rt._asr_model_name = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    rt._asr_device = "cuda"
    monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))

    # Layer 1: Pure silence returns rms_silence with ZERO GPU transcribe calls!
    silence_pcm = np.zeros(16000, dtype="<i2").tobytes()
    res_sil = voice_test_app.post(
        "/api/v1/coach/transcribe?lang=auto&mode=final",
        content=silence_pcm,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res_sil.status_code == 200
    assert res_sil.json()["text"] == ""
    assert res_sil.json()["rejectedReason"] == "rms_silence"
    assert len(calls) == 0

    speech_pcm = _make_speech_pcm16(1.0, amp=0.25)

    # Hold listening_local_asr._RUN_LOCK to verify 100% independence from YouTube imports!
    assert listening_local_asr._RUN_LOCK.acquire(blocking=False)
    try:
        res_auto = voice_test_app.post(
            "/api/v1/coach/transcribe?lang=auto&mode=final",
            content=speech_pcm,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert res_auto.status_code == 200
        body = res_auto.json()
        assert body["text"] == "hi echo open reading for IELTS"  # Layer 7 canonicalized!
        assert body["reviewNeeded"] is False
        assert body["language"] == "en"
        assert body["durationMs"] == 1000
        assert body["noSpeechProb"] == pytest.approx(0.03)
        assert body["avgLogprob"] == pytest.approx(-0.22)
        assert body["compressionRatio"] == pytest.approx(1.15)
        assert body["rejectedReason"] is None

        # Verify ADR-1 decoding parameters (Layers 2, 3, 4, 5)
        kw = calls[-1]
        assert kw["vad_filter"] is True
        assert kw["hotwords"] is None
        assert kw["initial_prompt"] is None
        assert kw["condition_on_previous_text"] is False
        assert kw["temperature"] == (0.0, 0.2, 0.4)
        assert kw["no_repeat_ngram_size"] == 3
        assert kw["repetition_penalty"] == pytest.approx(1.10)
        assert kw["compression_ratio_threshold"] == pytest.approx(2.2)
        assert kw["multilingual"] is False
        assert kw["beam_size"] == 2

        # Partial pass ALSO uses vad_filter=True, hotwords=None, beam_size=1
        res_partial = voice_test_app.post(
            "/api/v1/coach/transcribe?lang=vi&mode=partial&session_id=s1&turn_seq=7",
            content=speech_pcm[:3200],
            headers={"Content-Type": "application/octet-stream"},
        )
        assert res_partial.status_code == 200
        assert calls[-1]["vad_filter"] is True
        assert calls[-1]["hotwords"] is None
        assert calls[-1]["beam_size"] == 1
        assert calls[-1]["language"] == "vi"

        # Layer 6a: Reject classic `"Writing, Writing, Writing..."` repetition loop!
        next_response["segments"] = [
            SimpleNamespace(
                text="IELTS, TOEIC, Writing, Writing, Writing, Writing, Writing, Writing",
                avg_logprob=-0.13,
                no_speech_prob=0.01,
                compression_ratio=1.9,
            )
        ]
        res_loop = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=partial", content=speech_pcm)
        assert res_loop.status_code == 200
        assert res_loop.json()["text"] == ""
        assert res_loop.json()["rejectedReason"] == "repetition_loop"

        # Layer 6b: Reject high compression_ratio > 2.2
        next_response["segments"] = [
            SimpleNamespace(text="hello world", avg_logprob=-0.2, no_speech_prob=0.05, compression_ratio=2.8)
        ]
        res_cr = voice_test_app.post("/api/v1/coach/transcribe?lang=en&mode=final", content=speech_pcm)
        assert res_cr.json()["text"] == ""
        assert res_cr.json()["rejectedReason"] == "compression_ratio"

        # Layer 6c: Reject low avg_logprob < -0.95
        next_response["segments"] = [
            SimpleNamespace(text="mumbled noise", avg_logprob=-1.25, no_speech_prob=0.1, compression_ratio=1.1)
        ]
        res_lp = voice_test_app.post("/api/v1/coach/transcribe?lang=en&mode=final", content=speech_pcm)
        assert res_lp.json()["text"] == ""
        assert res_lp.json()["rejectedReason"] == "low_logprob"

        # Layer 6d: Reject phantom YouTube phrase on short clip
        next_response["segments"] = [
            SimpleNamespace(text="Thank you for watching!", avg_logprob=-0.30, no_speech_prob=0.10, compression_ratio=1.1)
        ]
        res_ph = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=speech_pcm)
        assert res_ph.json()["text"] == ""
        assert res_ph.json()["rejectedReason"] == "phantom_phrase"

        # Layer 5: Constrained EN/VI language resolution (never emits 'id'/'es'/'ko')
        next_response["segments"] = [
            SimpleNamespace(text="Mở bài Reading IELTS", avg_logprob=-0.20, no_speech_prob=0.02, compression_ratio=1.1)
        ]
        next_response["info"] = SimpleNamespace(
            language="id", language_probability=0.51, all_language_probs=[("id", 0.51), ("vi", 0.38), ("en", 0.08)]
        )
        res_lang = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=speech_pcm)
        assert res_lang.json()["language"] == "vi"
        assert res_lang.json()["text"] == "Mở bài Reading IELTS"
    finally:
        listening_local_asr._RUN_LOCK.release()

    # Bounds checks
    assert voice_test_app.post("/api/v1/coach/transcribe?lang=en", content=b"\x00\x01\x02").status_code == 400
    assert voice_test_app.post("/api/v1/coach/transcribe?lang=en", content=b"\x00" * 640002).status_code == 413


def test_asr_priority_gate_local_agreement_and_domain_canonicalizer():
    # Final-over-partial priority gate: when all slots are occupied and a final is waiting, partial yields!
    gate = _AsrPriorityGate(capacity=1)
    assert gate.acquire("final", timeout=0.2) is True
    final_acquired = threading.Event()

    def _wait_final():
        if gate.acquire("final", timeout=1.0):
            final_acquired.set()
            time.sleep(0.05)
            gate.release()

    t = threading.Thread(target=_wait_final)
    t.start()
    time.sleep(0.02)
    # While a final is waiting, a partial must NOT acquire
    assert gate.acquire("partial", timeout=0.03) is False
    gate.release()
    t.join(timeout=1.5)
    assert final_acquired.is_set()

    # LocalAgreement-2 stabilizer
    stab = LocalAgreementStabilizer()
    assert stab.update("sess1", 1, "open reading passage") == ""
    assert stab.update("sess1", 1, "open reading for IELTS") == "open reading"
    assert stab.update("sess1", 1, "open reading for IELTS now") == "open reading for IELTS"
    stab.clear("sess1", 1)
    assert stab.update("sess1", 1, "new turn") == ""

    # Repetition detector + domain canonicalizer
    assert has_repetition_loop("Writing, Writing, Writing, Writing") is True
    assert has_repetition_loop("open reading, open reading, open reading") is True
    assert has_repetition_loop("I want to practice IELTS Reading today") is False
    assert canonicalize_domain_terms("open odissey and flash cards for toe ic and c e f r") == (
        "open Odyssey and Flashcards for TOEIC and CEFR"
    )


def test_smart_turn_v32_thresholds_and_latency(monkeypatch, voice_test_app: TestClient):
    tone = 0.2 * np.sin(2.0 * np.pi * 180.0 * np.arange(24000, dtype=np.float32) / 16000.0)
    mel = compute_smart_turn_log_mel(tone)
    assert mel.shape == (1, 80, 800) and mel.dtype == np.float32
    assert np.isfinite(mel).all()

    rt = EchoRealtimeVoiceService()
    try:
        sess = rt.load_turn_session()
        has_real_onnx = sess is not None
    except Exception:
        has_real_onnx = False

    if has_real_onnx:
        monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))
        pcm_bytes = (tone * 32767.0).astype("<i2").tobytes()
        for _ in range(3):
            rt.check_turn_complete(pcm_bytes)
        latencies_ms = []
        for _ in range(15):
            t0 = time.perf_counter()
            data = rt.check_turn_complete(pcm_bytes)
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            assert set(data.keys()) == {"complete", "probability", "recommendedWaitMs"}
            assert 0.0 <= data["probability"] <= 1.0
            assert 250 <= data["recommendedWaitMs"] <= 900
        assert float(np.median(latencies_ms)) < 35.0
        resp = voice_test_app.post("/api/v1/coach/turn-check", content=pcm_bytes)
        assert resp.status_code == 200
        assert set(resp.json().keys()) == {"complete", "probability", "recommendedWaitMs"}

    # 1. Multi-word utterance (> 950 ms voiced): fast 320 ms commit on high prob, 620 / 850 ms hesitation (0 multi-sec 2100 ms stalls!)
    long_pcm = _make_speech_pcm16(1.35, amp=0.20)
    for prob, exp_complete, exp_wait in [
        (0.82, True, 320),
        (0.55, True, 320),
        (0.40, False, 620),
        (0.28, False, 620),
        (0.12, False, 850),
    ]:
        class StubSession:
            def run(self, _out, _inp):
                return [np.array([[prob]], dtype=np.float32)]

        rt._turn_session = StubSession()
        monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))
        r = voice_test_app.post("/api/v1/coach/turn-check", content=long_pcm)
        assert r.status_code == 200
        assert r.json() == {
            "complete": exp_complete,
            "probability": round(prob, 4),
            "recommendedWaitMs": exp_wait,
        }

    # 2. Short command (<= 950 ms voiced, e.g. "Open Reading" + 400 ms pause): snappy 280 / 320 / 560 ms!
    short_cmd_pcm = _make_speech_pcm16(0.55, amp=0.22) + (b"\x00" * (int(0.40 * 16000) * 2))
    for prob, exp_complete, exp_wait in [
        (0.80, True, 280),
        (0.35, True, 320),
        (0.10, False, 560),
    ]:
        class ShortStubSession:
            def run(self, _out, _inp):
                return [np.array([[prob]], dtype=np.float32)]

        rt._turn_session = ShortStubSession()
        monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))
        r_short = voice_test_app.post("/api/v1/coach/turn-check", content=short_cmd_pcm)
        assert r_short.status_code == 200
        assert r_short.json() == {
            "complete": exp_complete,
            "probability": round(prob, 4),
            "recommendedWaitMs": exp_wait,
        }

    # 3. Ultra-short even-byte clip (< 640 B) returns structured incomplete wait instead of HTTP 400
    r_tiny = voice_test_app.post("/api/v1/coach/turn-check", content=b"\x00" * 320)
    assert r_tiny.status_code == 200
    assert r_tiny.json()["complete"] is False

    # Odd-byte malformed payload -> 400; > 8s payload -> 413
    assert voice_test_app.post("/api/v1/coach/turn-check", content=b"\x00" * 101).status_code == 400
    assert voice_test_app.post("/api/v1/coach/turn-check", content=b"\x00" * 262146).status_code == 413


def test_quiet_speech_pregain_windowed_rms_and_short_clip_no_speech_metadata(monkeypatch, voice_test_app: TestClient):
    rt = EchoRealtimeVoiceService()
    transcribe_inputs = []

    class InspectingWhisper:
        def transcribe(self, audio, **kwargs):
            transcribe_inputs.append((audio.copy(), kwargs))
            return [
                SimpleNamespace(
                    text="Open Reading",
                    avg_logprob=-0.30,
                    no_speech_prob=0.04,
                    compression_ratio=1.05,
                )
            ], SimpleNamespace(language="en", language_probability=0.95, all_language_probs=[("en", 0.95), ("vi", 0.03)])

    rt._asr_model = InspectingWhisper()
    monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))

    # 1. Short even-byte clips (< 3200 B final / < 1600 B partial) return 200 OK clean `no_speech` metadata (0 HTTP 400!)
    for short_len in (0, 640, 2400):
        res_short = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=b"\x00" * short_len)
        assert res_short.status_code == 200
        assert res_short.json()["text"] == ""
        assert res_short.json()["rejectedReason"] == "no_speech"
    assert len(transcribe_inputs) == 0

    # 2. Quiet laptop-mic utterance (-49 dBFS whole-clip RMS diluted by 0.5s pre-roll + 0.6s trailing silence)
    #    passes L1 via 100 ms windowed RMS and receives clean pre-gain before Whisper!
    pad = np.zeros(8000, dtype=np.float32)
    tail = np.zeros(9600, dtype=np.float32)
    t = np.arange(8000, dtype=np.float32) / 16000.0
    quiet_syllable = (0.0085 * np.sin(2.0 * np.pi * 210.0 * t)).astype(np.float32)
    full_clip = np.concatenate([pad, quiet_syllable, tail])
    whole_db = compute_rms_dbfs(full_clip)
    peak_db, floor_db = compute_windowed_rms_stats(full_clip)
    assert whole_db < -46.0  # Previously rejected by whole-clip -46 dBFS floor!
    assert peak_db - floor_db > 15.0

    quiet_pcm = np.clip(np.rint(full_clip * 32767.0), -32768, 32767).astype("<i2").tobytes()
    res_quiet = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=quiet_pcm)
    assert res_quiet.status_code == 200
    assert res_quiet.json()["text"] == "Open Reading"
    assert res_quiet.json()["rejectedReason"] is None
    assert len(transcribe_inputs) == 1
    boosted_audio, _ = transcribe_inputs[0]
    assert compute_rms_dbfs(boosted_audio) > whole_db + 10.0

    # 3. Stationary white noise at -50 dBFS has flat envelope (< 4.5 dB spread) -> rejected at L1 with 0 GPU calls & 0 pre-gain!
    rng = np.random.default_rng(77)
    flat_noise = (rng.normal(0.0, 10.0 ** (-50.0 / 20.0), 24000)).astype(np.float32)
    n_peak, n_floor = compute_windowed_rms_stats(flat_noise)
    assert np.allclose(apply_quiet_speech_pregain(flat_noise, n_peak, n_floor), flat_noise)
    noise_pcm = np.clip(np.rint(flat_noise * 32767.0), -32768, 32767).astype("<i2").tobytes()
    res_noise = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=noise_pcm)
    assert res_noise.status_code == 200
    assert res_noise.json()["text"] == ""
    assert res_noise.json()["rejectedReason"] == "rms_silence"
    assert len(transcribe_inputs) == 1  # Zero extra Whisper calls!


def test_foreign_latin_misdetection_redecode_and_vietnamese_domain_canonicalizer(monkeypatch, voice_test_app: TestClient):
    rt = EchoRealtimeVoiceService()
    pass_langs = []

    class PtMisdetectWhisper:
        def transcribe(self, audio, **kwargs):
            req_lang = kwargs.get("language")
            pass_langs.append(req_lang)
            if req_lang is None:
                # Reproduces live production incident where unconstrained Whisper detected Portuguese ('pt', 0.23)
                return [
                    SimpleNamespace(text="Obrigado por abrir a leitura", avg_logprob=-0.68, no_speech_prob=0.08, compression_ratio=1.1)
                ], SimpleNamespace(
                    language="pt",
                    language_probability=0.23,
                    all_language_probs=[("pt", 0.23), ("vi", 0.21), ("en", 0.14)],
                )
            if req_lang == "vi":
                return [
                    SimpleNamespace(text="Mở phần đọc eos reading và flashcast tô ích", avg_logprob=-0.19, no_speech_prob=0.02, compression_ratio=1.1)
                ], SimpleNamespace(language="vi", language_probability=1.0, all_language_probs=[("vi", 1.0)])
            return [], SimpleNamespace(language="en", language_probability=1.0, all_language_probs=[("en", 1.0)])

    rt._asr_model = PtMisdetectWhisper()
    monkeypatch.setattr(EchoRealtimeVoiceService, "get_instance", classmethod(lambda cls: rt))

    speech_pcm = _make_speech_pcm16(1.2, amp=0.24)
    res = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=speech_pcm)
    assert res.status_code == 200
    body = res.json()
    assert pass_langs == [None, "vi"]
    assert body["language"] == "vi"
    assert body["rejectedReason"] is None
    assert body["text"] == "Mở phần đọc IELTS reading và Flashcard TOEIC"

    # Also verify clear-speech accented short command at avg_logprob=-1.05 (nsp=0.04) survives with reviewNeeded=True
    class AccentedShortWhisper:
        def transcribe(self, audio, **kwargs):
            return [
                SimpleNamespace(text="Có ạ", avg_logprob=-1.05, no_speech_prob=0.04, compression_ratio=1.0)
            ], SimpleNamespace(language="vi", language_probability=0.92, all_language_probs=[("vi", 0.92), ("en", 0.05)])

    rt._asr_model = AccentedShortWhisper()
    res_acc = voice_test_app.post("/api/v1/coach/transcribe?lang=auto&mode=final", content=speech_pcm)
    assert res_acc.status_code == 200
    assert res_acc.json()["text"] == "Có ạ"
    assert res_acc.json()["reviewNeeded"] is True


def test_tts_markdown_action_tags_punctuation_only_and_vietnamese_oov_hardening(monkeypatch, voice_test_app: TestClient):
    # 1. Markdown headings, links, Echo action chips, IPA slashes, abbreviations & numbered VI lists
    md = "### 1. Mở phần Reading\nBạn hãy mở [Reading Practice](/reading) hoặc nhấn [Open Reading -> /reading] nhé!"
    clauses_md = split_text_clauses(md)
    assert clauses_md[0] == "1. Mở phần Reading."
    assert detect_clause_language(clauses_md[0], "auto") == "vi"
    joined_md = " ".join(clauses_md)
    assert "/reading" not in joined_md
    assert "->" not in joined_md
    assert "###" not in joined_md

    ipa_text = "Từ 'ephemeral' (/ɪˈfɛmərəl/) nghĩa là ngắn ngủi, e.g. Dr. Smith vs. Mr. Lee."
    cleaned_ipa = sanitize_speakable_text(ipa_text)
    assert "ɪˈfɛmərəl" not in cleaned_ipa
    assert "for example," in cleaned_ipa
    assert "versus" in cleaned_ipa
    abbrev_clauses = split_text_clauses("Dr. Smith scored Band 7.5 (i.e. ~88%) on IELTS.")
    assert not any(c.strip() == "Dr." for c in abbrev_clauses)

    numbered_vi = "1. Luyện Shadowing 10 phút. 2. Ôn 15 Flashcards."
    num_clauses = split_text_clauses(numbered_vi)
    assert num_clauses == ["1. Luyện Shadowing 10 phút.", "2. Ôn 15 Flashcards."]
    assert all(detect_clause_language(c, "auto") == "vi" for c in num_clauses)

    # 2. Punctuation-only, divider-only, emoji-only & [ECHO_META]-only fragments return 200 OK silent PCM (0 crashes/400s/hiss!)
    svc = JarvisTtsService()
    svc._is_loaded = True
    monkeypatch.setattr(JarvisTtsService, "get_instance", classmethod(lambda cls: svc))
    OmniVoiceService._instance = OmniVoiceService(delegate=svc)

    for fragment in ("...", "---", "***", "**[ECHO_META]{\"actions\":[]}", "✨🎉"):
        assert not has_speakable_content(sanitize_speakable_text(fragment))
        r_stream = voice_test_app.post("/api/v1/tts/stream", json={"text": fragment, "voiceId": "uk_male"})
        assert r_stream.status_code == 200
        assert len(r_stream.content) == 960
        assert np.all(np.frombuffer(r_stream.content, dtype="<i2") == 0)

        r_wav = voice_test_app.post("/api/v1/tts/omnivoice", json={"text": fragment, "voiceId": "uk_male"})
        assert r_wav.status_code == 200
        assert r_wav.headers["content-type"].startswith("audio/wav")

    # Truly blank whitespace still rejected cleanly by request schema
    assert voice_test_app.post("/api/v1/tts/stream", json={"text": "   ", "voiceId": "uk_male"}).status_code == 422

    # 3. KokoroOovFallback handles Vietnamese 'đ'/'Đ', accented compounds & natural numbers in 114-symbol vocab
    for british in (False, True):
        fb = KokoroOovFallback(british=british)
        for token in ("Đà Nẵng", "đọc", "résumé", "café", "15", "920", "2026"):
            ph, rating = fb(SimpleNamespace(text=token))
            assert ph is not None and len(ph) >= 2, f"Unexpected OOV output for {token}: {ph}"
            assert rating in (2, 3)
            assert [c for c in ph if c not in KOKORO_VOCAB_CHARS] == []
        # Verify 'Đọc' starts with alveolar 'd', not stripped to 'c'!
        ph_doc, _ = fb(SimpleNamespace(text="Đọc"))
        assert "d" in ph_doc


def test_echo_local_llm_openai_sse_nonstream_think_strip_and_tool_calls(monkeypatch, voice_test_app: TestClient):
    import json as _json
    from app.services.echo_local_llm import EchoLocalLlmService, strip_think_and_markers

    assert strip_think_and_markers("<think>\ninternal reasoning\n</think>Chào bạn!") == "Chào bạn!"
    assert strip_think_and_markers("Hello<think>unclosed") == "Hello"

    llm_svc = EchoLocalLlmService()
    assert llm_svc.n_gpu_layers == 0  # Strictly 0 MiB GPU VRAM!

    # 1. Streaming SSE with split `<think>...</think>` across token chunks + `length` finish normalization -> `"stop"`
    def fake_think_tokens(prompt, max_tokens, temperature, top_p, cancel_event=None):
        chunks = [
            ("<th", None),
            ("ink>secret chain of thought</th", None),
            ("ink>\nChào bạn! ", None),
            ("Hôm nay bạn nên luyện IELTS Reading nhé.", "length"),
        ]
        return iter(chunks), {"prompt_tokens": 42, "completion_tokens": 12}

    monkeypatch.setattr(llm_svc, "_raw_token_iterator", fake_think_tokens)
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: llm_svc))

    with voice_test_app.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "model": "local-echo-instruct",
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": "Hôm nay mình nên học gì?"}],
        },
    ) as sres:
        assert sres.status_code == 200
        assert sres.headers["content-type"].startswith("text/event-stream")
        assert sres.headers["x-accel-buffering"] == "no"
        raw_lines = [ln for ln in sres.iter_lines() if ln]

    assert raw_lines[-1] == "data: [DONE]"
    parsed_frames = [_json.loads(ln[len("data: ") :]) for ln in raw_lines[:-1] if ln.startswith("data: ")]
    streamed_text = "".join(
        f["choices"][0]["delta"].get("content", "") for f in parsed_frames
    )
    finish_reasons = [f["choices"][0]["finish_reason"] for f in parsed_frames if f["choices"][0]["finish_reason"]]
    assert "<think>" not in streamed_text and "secret chain" not in streamed_text
    assert streamed_text == "Chào bạn! Hôm nay bạn nên luyện IELTS Reading nhé."
    # `length` must be normalized to `"stop"` so EchoProviderStream.java never raises HTTP 422!
    assert finish_reasons == ["stop"]
    assert parsed_frames[-1]["usage"]["total_tokens"] == 54

    # 2. Non-streaming JSON mode
    r_json = voice_test_app.post(
        "/api/v1/coach/chat/completions",
        json={
            "model": "local-echo-instruct",
            "stream": False,
            "messages": [{"role": "user", "content": "Hôm nay mình nên học gì?"}],
        },
    )
    assert r_json.status_code == 200
    jbody = r_json.json()
    assert jbody["choices"][0]["message"]["content"] == "Chào bạn! Hôm nay bạn nên luyện IELTS Reading nhé."
    assert jbody["choices"][0]["finish_reason"] == "stop"

    # 3. Streaming OpenAI `tool_calls` extraction & EchoProviderStream schema compliance
    def fake_tool_tokens(prompt, max_tokens, temperature, top_p, cancel_event=None):
        chunks = [
            ("<tool_call>", None),
            ('{"name": "search_lessons", "arguments": {"skill": "reading", "query": "IELTS"}}', None),
            ("</tool_call>", "stop"),
        ]
        return iter(chunks), {"prompt_tokens": 60, "completion_tokens": 18}

    monkeypatch.setattr(llm_svc, "_raw_token_iterator", fake_tool_tokens)
    tools_spec = [
        {
            "type": "function",
            "function": {
                "name": "search_lessons",
                "description": "Search English Coach lessons",
                "parameters": {
                    "type": "object",
                    "properties": {"skill": {"type": "string"}, "query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }
    ]
    with voice_test_app.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "model": "local-echo-instruct",
            "stream": True,
            "messages": [{"role": "user", "content": "Find an IELTS reading lesson for me"}],
            "tools": tools_spec,
            "tool_choice": "auto",
        },
    ) as tres:
        assert tres.status_code == 200
        tlines = [ln for ln in tres.iter_lines() if ln]

    assert tlines[-1] == "data: [DONE]"
    tframes = [_json.loads(ln[len("data: ") :]) for ln in tlines[:-1] if ln.startswith("data: ")]
    # Zero `<tool_call>` text leaked into delta.content!
    assert all(not f["choices"][0]["delta"].get("content") for f in tframes)
    tc_deltas = [f["choices"][0]["delta"]["tool_calls"] for f in tframes if "tool_calls" in f["choices"][0]["delta"]]
    assert len(tc_deltas) == 1
    assert tc_deltas[0][0]["function"]["name"] == "search_lessons"
    assert _json.loads(tc_deltas[0][0]["function"]["arguments"]) == {"skill": "reading", "query": "IELTS"}
    assert tframes[-1]["choices"][0]["finish_reason"] == "tool_calls"

    # 4. Protected by `install_service_auth` (`X-EC-Service-Key` required!)
    from app.core.service_auth import install_service_auth

    monkeypatch.setenv("AI_SERVICE_KEY", "k" * 40)
    monkeypatch.delenv("AI_SERVICE_AUTH_DISABLED", raising=False)
    authed_app = FastAPI()
    authed_app.include_router(coach_router, prefix="/api/v1")
    install_service_auth(authed_app)
    authed_client = TestClient(authed_app)
    assert authed_client.post("/api/v1/coach/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]}).status_code == 401
    assert (
        authed_client.post(
            "/api/v1/coach/chat/completions",
            json={"messages": [{"role": "user", "content": "Find an IELTS reading lesson"}], "tools": tools_spec},
            headers={"X-EC-Service-Key": "k" * 40},
        ).status_code
        == 200
    )
