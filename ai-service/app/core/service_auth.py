"""Service-to-service authentication of the internal AI service (security release 2026-11-16, SEC-01).

Every route requires the header ``X-EC-Service-Key`` carrying the shared secret ``AI_SERVICE_KEY``; only the liveness /
readiness probes are open (the container healthcheck and ``deploy/ai/verify-ai-service.ps1`` call them without a key).
The service is reached only by the English Coach backend over Tailscale: no browser origin is allowed (no CORS).

Fail closed: without ``AI_SERVICE_KEY`` every protected route answers 503. ``AI_SERVICE_AUTH_DISABLED=true`` exists for
an isolated local development stack only and is logged loudly; it must never be set on the GPU PC's production service.

A pure ASGI middleware (not ``BaseHTTPMiddleware``): request bodies (audio, documents) and streamed responses pass through
untouched. The key is compared in constant time and never logged.
"""
from __future__ import annotations

import hmac
import json
import logging
import os

logger = logging.getLogger("service_auth")

HEADER = b"x-ec-service-key"
MIN_KEY_LENGTH = 32

# (method, path) pairs that stay open: probes only, no inference, no learner data.
OPEN_PROBES = {
    ("GET", "/api/v1/health"),
    ("HEAD", "/api/v1/health"),
    ("GET", "/api/v1/listening/capabilities"),
}


class ServiceAuthMiddleware:
    def __init__(self, app, key: str | None, disabled: bool = False):
        self.app = app
        self.key = key.encode("utf-8") if key else None
        self.disabled = disabled

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        if kind not in ("http", "websocket") or self.disabled:
            await self.app(scope, receive, send)
            return
        if kind == "http" and (scope.get("method", "GET").upper(), scope.get("path", "")) in OPEN_PROBES:
            await self.app(scope, receive, send)
            return
        provided = None
        for name, value in scope.get("headers") or []:
            if name.lower() == HEADER:
                provided = value
                break
        if self.key is None:
            await _deny(scope, send, 503, "AI service credential is not configured")
            return
        if provided is None or not hmac.compare_digest(provided, self.key):
            await _deny(scope, send, 401, "Unauthorized internal service caller")
            return
        await self.app(scope, receive, send)


async def _deny(scope, send, status: int, detail: str) -> None:
    if scope.get("type") == "websocket":
        await send({"type": "websocket.close", "code": 1008})
        return
    body = json.dumps({"detail": detail}).encode("utf-8")
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes")


def install_service_auth(app) -> None:
    """Protect every route of ``app`` and remove any CORS middleware (idempotent)."""
    if getattr(app.state, "service_auth_installed", False):
        return
    from fastapi.middleware.cors import CORSMiddleware

    # Server-to-server only: a browser origin is never trusted. Drop CORS added by an older entry module.
    app.user_middleware[:] = [m for m in app.user_middleware if getattr(m, "cls", None) is not CORSMiddleware]

    key = (os.getenv("AI_SERVICE_KEY") or "").strip() or None
    disabled = _truthy(os.getenv("AI_SERVICE_AUTH_DISABLED"))
    if disabled:
        logger.warning("[Security] AI_SERVICE_AUTH_DISABLED=true: every route is open. Local development only.")
    elif key is None:
        logger.error("[Security] AI_SERVICE_KEY is not set: every protected route answers 503 (fail closed).")
    elif len(key) < MIN_KEY_LENGTH:
        logger.error("[Security] AI_SERVICE_KEY is shorter than %d characters: refused, every protected route answers 503.", MIN_KEY_LENGTH)
        key = None
    app.add_middleware(ServiceAuthMiddleware, key=key, disabled=disabled)
    app.state.service_auth_installed = True
