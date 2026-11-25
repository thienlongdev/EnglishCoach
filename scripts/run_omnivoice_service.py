import hmac
import json
import os
import sys
import logging
from pathlib import Path
from typing import Optional

# Add ai-service to sys.path so app imports work seamlessly
current_dir = Path(__file__).resolve().parent
repo_root = current_dir.parent if current_dir.name in ["scripts", "app"] else current_dir
ai_service_dir = repo_root / "ai-service"

if str(ai_service_dir) not in sys.path:
    sys.path.insert(0, str(ai_service_dir))
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

os.environ["REPO_ROOT"] = str(repo_root)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("OMNIVOICE_STANDALONE")

from contextlib import asynccontextmanager
from fastapi import FastAPI
import uvicorn

from app.api.routes.tts import playground_router as tts_playground_router
from app.api.routes.tts import router as tts_router
from app.services.tts.omnivoice_service import OmniVoiceService

SERVICE_KEY_HEADER = b"x-ec-service-key"
MIN_KEY_LENGTH = 32
OPEN_PROBES = {
    ("GET", "/health"),
}


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes")


async def _deny(scope, send, status_code: int, detail: str) -> None:
    if scope.get("type") == "websocket":
        await send({"type": "websocket.close", "code": 1008})
        return
    body = json.dumps({"detail": detail}).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status_code,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class OmniVoiceServiceAuthMiddleware:
    """Pure ASGI service-key authentication for standalone OmniVoice (EC-SEC-2026-007)."""

    def __init__(self, app, key: Optional[str], disabled: bool = False):
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
            if name.lower() == SERVICE_KEY_HEADER:
                provided = value
                break

        if self.key is None:
            await _deny(scope, send, 503, "OmniVoice service credential is not configured")
            return
        if provided is None or not hmac.compare_digest(provided, self.key):
            await _deny(scope, send, 401, "Unauthorized internal service caller")
            return

        await self.app(scope, receive, send)


def install_omnivoice_auth(target_app: FastAPI) -> None:
    """Protect all routes except GET /health with X-EC-Service-Key (fail closed)."""
    key = (
        (os.environ.get("OMNIVOICE_SERVICE_KEY") or "").strip()
        or (os.environ.get("AI_SERVICE_KEY") or "").strip()
        or None
    )
    disabled = _truthy(os.environ.get("OMNIVOICE_AUTH_DISABLED"))
    if disabled:
        logger.warning("[Security] OMNIVOICE_AUTH_DISABLED is set: every OmniVoice route is open. Local development only.")
    elif key is None:
        logger.error("[Security] OMNIVOICE_SERVICE_KEY / AI_SERVICE_KEY is not set: protected routes answer 503 (fail closed).")
    elif len(key) < MIN_KEY_LENGTH:
        logger.error(
            "[Security] OmniVoice service key is shorter than %d characters: refused, protected routes answer 503.",
            MIN_KEY_LENGTH,
        )
        key = None
    target_app.add_middleware(OmniVoiceServiceAuthMiddleware, key=key, disabled=disabled)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Startup: Initializing OmniVoice model and pre-computing reference voice prompts...")
    service = OmniVoiceService.get_instance()
    service.load_model()
    logger.info("OmniVoice is fully initialized and ready.")
    yield
    logger.info("Shutting down OmniVoice service...")


def create_app() -> FastAPI:
    application = FastAPI(
        title="English Coach - OmniVoice Local TTS Service",
        version="1.0.0",
        lifespan=lifespan,
    )

    application.include_router(tts_router)
    application.include_router(tts_router, prefix="/api/v1")

    if (os.environ.get("OMNIVOICE_ENABLE_PLAYGROUND") or "").strip().lower() == "true":
        application.include_router(tts_playground_router)
        application.include_router(tts_playground_router, prefix="/api/v1")

    @application.get("/health")
    def health():
        service = OmniVoiceService.get_instance()
        return {
            "status": "ok",
            "service": "omnivoice-local-tts",
            "model_loaded": service.is_loaded,
            "device": service.device,
            "voices": [v["voiceId"] for v in service.get_public_voices()],
        }

    # Internal server-to-server service: no browser CORS middleware; require X-EC-Service-Key everywhere except GET /health.
    install_omnivoice_auth(application)
    return application


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("OMNIVOICE_PORT") or os.environ.get("PORT") or "8005")
    host = (os.environ.get("OMNIVOICE_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    logger.info(f"Starting OmniVoice Local TTS Service on http://{host}:{port} ...")
    uvicorn.run(app, host=host, port=port, log_level="info")
