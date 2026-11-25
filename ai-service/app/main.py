from contextlib import asynccontextmanager
import logging
import os
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
from fastapi import FastAPI
from app.api.routes.health import router as health_router
from app.api.routes.coach import router as coach_router
from app.api.routes.speaking import router as speaking_router
from app.api.routes.dictionary import router as dictionary_router
from app.api.routes.ocr import router as ocr_router
from app.api.routes.ecsm import router as ecsm_router
from app.api.routes.pronunciation_v2 import router as pron_v2_router
from app.api.routes.writing import router as writing_router
from app.api.routes.exams import router as exams_router
from app.api.routes.reading import router as reading_router
from app.api.routes.listening import router as listening_router
from app.api.routes.tts import playground_router as tts_playground_router
from app.api.routes.tts import router as tts_router
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime

logger = logging.getLogger("MAIN")

@asynccontextmanager
async def lifespan(app: FastAPI):
    enable_ecsm = os.getenv("ENABLE_ECSM_RUNTIME", "false").strip().lower() == "true"
    if enable_ecsm:
        logger.info("Initializing ECSM Unified Runtime on service startup (ENABLE_ECSM_RUNTIME=true)...")
        try:
            runtime = ECSMRuntime.get_instance()
            runtime.startup(load_neural_weights=True)
        except Exception as e:
            logger.error(f"Failed to initialize ECSM Runtime on startup: {e}", exc_info=True)
    else:
        logger.info("Skipping legacy ECSM Unified Runtime startup (ENABLE_ECSM_RUNTIME=false); VRAM preserved.")
    yield
    logger.info("Shutting down AI Service...")

app = FastAPI(title="English Coach AI Service", version="1.0.0", lifespan=lifespan)
app.include_router(health_router, prefix="/api/v1")
app.include_router(coach_router, prefix="/api/v1")
app.include_router(speaking_router, prefix="/api/v1")
app.include_router(ecsm_router, prefix="/api/v1")
app.include_router(pron_v2_router)
app.include_router(pron_v2_router, prefix="/api/v1")
if os.getenv("ENABLE_REAL_MIC_PACK_DEV_ROUTES", "").strip().lower() == "true":
    from app.api.routes.real_mic_pack import router as real_mic_pack_router
    app.include_router(real_mic_pack_router, prefix="/api/v1")
app.include_router(dictionary_router, prefix="/api/v1")
app.include_router(reading_router, prefix="/api/v1")
app.include_router(listening_router, prefix="/api/v1")
app.include_router(ocr_router, prefix="/api/v1/ocr", tags=["OCR"])
app.include_router(writing_router, prefix="/api/v1/writing", tags=["Writing"])
app.include_router(exams_router)
app.include_router(tts_router)
app.include_router(tts_router, prefix="/api/v1")
if os.getenv("OMNIVOICE_ENABLE_PLAYGROUND", "").strip().lower() == "true":
    app.include_router(tts_playground_router)
    app.include_router(tts_playground_router, prefix="/api/v1")

# Every route requires the backend's service credential (X-EC-Service-Key / AI_SERVICE_KEY); only the health and
# capability probes stay open. No browser origin is allowed: the wildcard CORS policy was removed (SEC-01).
from app.core.service_auth import install_service_auth  # noqa: E402

install_service_auth(app)
