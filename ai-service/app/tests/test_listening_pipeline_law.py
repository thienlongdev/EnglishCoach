"""
SUPREME LISTENING YOUTUBE IMPORT LAW (rules 10 §BE) — regression guard for the AI-service half.

One local pipeline (captions or local faster-whisper text, WhisperX alignment), no paid / remote ASR,
no synthetic word timing, fail closed. Runs without a GPU or network: every outside stage is stubbed.
"""
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services import listening_youtube_service as L
from app.services.listening_local_asr import LocalPipelineUnavailable
from app.services.listening_timing_gate import TimingRejected, assess_transcript_timing

SERVICES = Path(__file__).resolve().parents[1] / "services"
ROUTES = Path(__file__).resolve().parents[1] / "api" / "routes"


def test_capabilities_report_loaded_models_only(monkeypatch):
    from app.api.routes import listening as R
    from app.services import listening_local_asr as A
    monkeypatch.setattr(A, "_MODEL", None)
    monkeypatch.setattr(A, "_MODEL_DEVICE", None)
    monkeypatch.setattr(L, "_ALIGN_MODEL", None)
    monkeypatch.setattr(L, "_ALIGN_DEVICE", None)
    report = R.capabilities_endpoint()
    assert report["pipeline"] == "faster-whisper-large-v3+whisperx-wav2vec2"
    assert report["ready"] is False, "nothing loaded: not ready, whatever the configuration says"
    monkeypatch.setattr(A, "_MODEL", object())
    monkeypatch.setattr(A, "_MODEL_DEVICE", "cuda")
    assert R.capabilities_endpoint()["ready"] is False, "transcription alone is not the pipeline"
    monkeypatch.setattr(L, "_ALIGN_MODEL", object())
    monkeypatch.setattr(L, "_ALIGN_DEVICE", "cpu")
    assert R.capabilities_endpoint()["ready"] is False, "the production pipeline runs on the GPU"
    monkeypatch.setattr(L, "_ALIGN_DEVICE", "cuda")
    report = R.capabilities_endpoint()
    assert report["ready"] is True and report["transcription"]["model"] == "large-v3"


def test_capabilities_route_is_declared():
    assert '@router.get("/capabilities")' in (ROUTES / "listening.py").read_text(encoding="utf-8")


def seg(start, end, words):
    return {"startTimeMs": start, "endTimeMs": end, "text": " ".join(w for w, _, _ in words),
            "words": [{"word": w, "start": s, "end": e} for w, s, e in words]}


GOOD = [
    seg(163, 2038, [("The", 0.283, 0.404), ("Fox", 0.464, 0.767), ("and", 1.07, 1.211), ("Crow", 1.595, 1.918)]),
    seg(8844, 12390, [("Early", 8.964, 9.244), ("one", 9.385, 9.525), ("a", None, None), ("fox", 10.466, 10.79),
                      ("walking.", 11.01, 11.6)]),
    seg(13000, 17600, [("He", 13.1, 13.22), ("sees", 13.3, 13.61), ("a", 13.66, 13.71), ("crow", 13.8, 14.2),
                       ("in", 14.6, 14.7), ("the", 14.74, 14.83), ("tall", 14.9, 15.3), ("tree.", 15.35, 15.9)]),
]


# ------------------------------------------------------------------ timing gate

def test_gate_accepts_acoustic_timing_with_honest_gaps():
    report = assess_transcript_timing(GOOD, 198.28)
    assert report["alignedWords"] == 16 and report["words"] == 17


def test_gate_refuses_the_removed_openrouter_grid():
    # lesson 67 / 168 shape: 8-word chunks, start = i * 2500, even 0.4 s words, far past the media end
    grid = []
    for i in range(70):
        s = i * 2500
        grid.append(seg(s, s + 3200, [(f"w{k}", (s + k * 400) / 1000, (s + (k + 1) * 400) / 1000) for k in range(8)]))
    with pytest.raises(TimingRejected) as e:
        assess_transcript_timing(grid, 180)
    assert e.value.reason in {"BEYOND_MEDIA", "SYNTHETIC_GRID", "SYNTHETIC_UNIFORM"}


def test_gate_refuses_even_split_even_inside_the_media():
    even = [seg(i * 3100 + (i % 3) * 170, i * 3100 + (i % 3) * 170 + 2400,
                [(f"w{k}", (i * 3100 + (i % 3) * 170 + k * 300) / 1000, (i * 3100 + (i % 3) * 170 + (k + 1) * 300) / 1000)
                 for k in range(8)]) for i in range(10)]
    with pytest.raises(TimingRejected) as e:
        assess_transcript_timing(even, 60)
    assert e.value.reason == "SYNTHETIC_UNIFORM"


@pytest.mark.parametrize("bad, reason", [
    ([seg(0, 2000, [("a", 0.9, 0.5)])], "WORD_REVERSED"),
    ([seg(0, 2000, [("a", -0.1, 0.5)])], "WORD_REVERSED"),
    ([seg(3000, 4000, [("a", 3.1, 3.5)]), seg(1000, 2000, [("b", 1.1, 1.5)])], "SEGMENT_ORDER"),
    ([seg(0, 2000, [("a", 0.1, 0.4), ("b", None, None), ("c", None, None)])], "ALIGNMENT_INSUFFICIENT"),
    ([seg(0, 99000, [("a", 0.1, 0.4), ("b", 50.0, 50.3)])], "BEYOND_MEDIA"),
])
def test_gate_rules(bad, reason):
    with pytest.raises(TimingRejected) as e:
        assess_transcript_timing(bad, 60)
    assert e.value.reason == reason


def test_gate_requires_a_real_duration():
    with pytest.raises(TimingRejected) as e:
        assess_transcript_timing(GOOD, 0)
    assert e.value.reason == "DURATION_UNKNOWN"


def test_unscored_word_is_never_given_time():
    # WhisperX interpolates words it could not score; those carry no "score" and stay untimed here
    assert L._acoustic_time({"start": 1.0, "end": 1.2}, "start", 10.0) is None
    assert L._acoustic_time({"start": 1.0, "end": 1.2, "score": 0.8}, "start", 10.0) == 11.0


def test_edge_word_inside_the_previous_sentence_becomes_unaligned():
    a = seg(0, 2000, [("The", 0.28, 0.40), ("Crow", 1.59, 1.92)])
    b = seg(1700, 6400, [("A", 1.82, 1.96), ("version", 4.03, 4.37)])
    L._release_cross_segment_edges([a, b])
    assert b["words"][0]["start"] is None and b["words"][1]["start"] == 4.03


def test_real_pause_after_a_sentence_splits_the_line():
    s = seg(130791, 143980, [("Speak", 130.911, 131.311), ("and", 131.551, 131.671), ("say", 131.771, 132.011),
                             ("your", 132.051, 132.272), ("name.", 132.352, 132.632), ("Spell", 142.939, 143.3),
                             ("your", 143.36, 143.56), ("name.", 143.62, 143.86)])
    out = L._split_at_pauses([s])
    assert [o["text"] for o in out] == ["Speak and say your name.", "Spell your name."]
    assert out[0]["startTimeMs"] == 130791 and out[1]["startTimeMs"] == 142939 and out[1]["endTimeMs"] == 143980
    # no clause end before the pause: the line is kept whole
    t = seg(0, 9000, [("you", 1.0, 1.3), ("Anna", 6.0, 6.4)])
    assert len(L._split_at_pauses([t])) == 1


def test_lines_never_start_before_the_previous_one():
    a = {"startTimeMs": 499510, "endTimeMs": 499560}
    b = {"startTimeMs": 499501, "endTimeMs": 504439}
    L._keep_segment_order([a, b])
    assert b["startTimeMs"] == 499510 and b["endTimeMs"] == 504439


# ------------------------------------------------------------------ fail closed, one pipeline

class _YDL:
    info = {"title": "T", "duration": 198, "formats": [{"acodec": "mp4a"}], "subtitles": {}, "automatic_captions": {}}

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False):
        if self.info is None:
            raise RuntimeError("Sign in to confirm you're not a bot")
        return dict(self.info)


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    monkeypatch.setattr(L, "yt_dlp", types.SimpleNamespace(YoutubeDL=_YDL))
    _YDL.info = dict(_YDL.info, duration=198) if _YDL.info else {"title": "T", "duration": 198, "formats": [{"acodec": "mp4a"}]}
    monkeypatch.setattr(L, "_captions_via_transcript_api", lambda v: (None, None))
    monkeypatch.setattr(L, "_captions_via_timedtext", lambda v, a, b: (None, None))
    mp3 = tmp_path / "x.mp3"
    mp3.write_bytes(b"\0" * 4096)
    monkeypatch.setattr(L, "download_youtube_audio", lambda url, vid, td: str(mp3))
    import numpy as np
    monkeypatch.setattr(L, "load_audio_for_alignment", lambda p: np.zeros(int(198.2 * 16000), dtype=np.float32))
    return monkeypatch


def test_local_transcription_unavailable_fails_closed_with_503(stubbed):
    def unavailable(path):
        raise LocalPipelineUnavailable("faster-whisper is not installed")
    stubbed.setattr(L, "transcribe_segments", unavailable)
    with pytest.raises(HTTPException) as e:
        L.fetch_youtube_metadata_and_captions("BF3bXji-J7I")
    assert e.value.status_code == 503 and "WhisperX" in e.value.detail


def test_alignment_unavailable_fails_closed_with_503(stubbed):
    stubbed.setattr(L, "transcribe_segments", lambda p: [seg(163 + 3000 * i, 2038 + 3000 * i, [(f"w{k}", None, None) for k in range(6)]) for i in range(3)])

    def no_model():
        raise RuntimeError("CUDA error")
    stubbed.setattr(L, "get_alignment_model", no_model)
    with pytest.raises(HTTPException) as e:
        L.fetch_youtube_metadata_and_captions("BF3bXji-J7I")
    assert e.value.status_code == 503


def test_youtube_refusing_metadata_never_defaults_the_duration(stubbed):
    _YDL.info = None
    try:
        with pytest.raises(HTTPException) as e:
            L.fetch_youtube_metadata_and_captions("BF3bXji-J7I")
        assert e.value.status_code == 503
    finally:
        _YDL.info = {"title": "T", "duration": 198, "formats": [{"acodec": "mp4a"}], "subtitles": {}, "automatic_captions": {}}


def test_successful_import_reports_whisperx_provenance(stubbed):
    words = [("Early", None, None), ("one", None, None), ("morning", None, None), ("the", None, None), ("fox", None, None)]
    stubbed.setattr(L, "transcribe_segments", lambda p: [seg(8844, 12390, words) for _ in range(1)] +
                    [seg(13000, 15000, [("a", None, None), ("fox", None, None), ("is", None, None), ("here", None, None),
                                        ("now", None, None), ("today", None, None), ("again", None, None)])])

    def aligned(segments, audio):
        t = 8.9
        for s in segments:
            for w in s["words"]:
                w["start"], w["end"] = round(t, 3), round(t + 0.21 + 0.07 * (len(w["word"]) % 3), 3)
                t = w["end"] + 0.05
            t += 0.6
        return segments
    stubbed.setattr(L, "align_loaded_audio", aligned)
    res = L.fetch_youtube_metadata_and_captions("BF3bXji-J7I")
    assert res["timing"]["alignment"] == "whisperx-wav2vec2"
    assert res["timing"]["transcript"].startswith("local-asr:faster-whisper")
    assert res["durationSeconds"] == 198


# ------------------------------------------------------------------ source guard

def test_listening_modules_never_reach_paid_or_remote_asr():
    for name in ("listening_youtube_service.py", "listening_local_asr.py", "listening_timing_gate.py"):
        src = (SERVICES / name).read_text(encoding="utf-8").lower()
        for forbidden in ("speech_service", "transcribe_detailed_audio_bytes", "openrouter.ai", "openai_api_key",
                          "/audio/transcriptions", "repair_unaligned_words", "* 2500", "chunk_size"):
            assert forbidden not in src, f"{name} contains {forbidden}"
    assert "local_files_only=True" in (SERVICES / "listening_local_asr.py").read_text(encoding="utf-8")
