"""SEC-01: the internal AI service refuses callers without the backend's credential (security release 2026-11-16)."""
import importlib

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

KEY = "k" * 48


def build(monkeypatch, key=KEY, disabled=None):
    if key is None:
        monkeypatch.delenv("AI_SERVICE_KEY", raising=False)
    else:
        monkeypatch.setenv("AI_SERVICE_KEY", key)
    if disabled is None:
        monkeypatch.delenv("AI_SERVICE_AUTH_DISABLED", raising=False)
    else:
        monkeypatch.setenv("AI_SERVICE_AUTH_DISABLED", disabled)
    import app.core.service_auth as sa
    importlib.reload(sa)
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/v1/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/v1/listening/capabilities")
    def caps():
        return {"ready": True}

    @app.post("/api/v1/writing/evaluate")
    async def evaluate(payload: dict):
        return {"echo": payload}

    @app.get("/api/v1/tts/stream")
    def stream():
        return StreamingResponse(iter([b"a", b"b", b"c"]), media_type="application/octet-stream")

    sa.install_service_auth(app)
    sa.install_service_auth(app)  # idempotent
    return app


def test_probes_stay_open(monkeypatch):
    c = TestClient(build(monkeypatch))
    assert c.get("/api/v1/health").status_code == 200
    assert c.get("/api/v1/listening/capabilities").status_code == 200


def test_protected_route_requires_the_key(monkeypatch):
    c = TestClient(build(monkeypatch))
    assert c.post("/api/v1/writing/evaluate", json={"a": 1}).status_code == 401
    assert c.post("/api/v1/writing/evaluate", json={"a": 1}, headers={"X-EC-Service-Key": "wrong"}).status_code == 401
    ok = c.post("/api/v1/writing/evaluate", json={"a": 1}, headers={"X-EC-Service-Key": KEY})
    assert ok.status_code == 200 and ok.json() == {"echo": {"a": 1}}


def test_streaming_passes_through(monkeypatch):
    c = TestClient(build(monkeypatch))
    r = c.get("/api/v1/tts/stream", headers={"X-EC-Service-Key": KEY})
    assert r.status_code == 200 and r.content == b"abc"


def test_fail_closed_without_or_with_a_short_key(monkeypatch):
    for key in (None, "short"):
        c = TestClient(build(monkeypatch, key=key))
        assert c.post("/api/v1/writing/evaluate", json={}, headers={"X-EC-Service-Key": "short"}).status_code == 503
        assert c.get("/api/v1/health").status_code == 200


def test_no_cors_for_browsers(monkeypatch):
    c = TestClient(build(monkeypatch))
    r = c.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_explicit_local_development_switch(monkeypatch):
    c = TestClient(build(monkeypatch, key=None, disabled="true"))
    assert c.post("/api/v1/writing/evaluate", json={}).status_code == 200
