import logging
import os
import threading
from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import HTMLResponse, StreamingResponse

from app.domain.schemas.tts import OmniVoiceRequest, TtsStreamRequest, VoicesResponse
from app.services.tts.jarvis_tts_service import ENGINE_ID, SAMPLE_RATE, JarvisTtsService, TtsBusyError
from app.services.tts.omnivoice_service import OmniVoiceService

logger = logging.getLogger("tts_routes")

router = APIRouter(tags=["TTS"])
playground_router = APIRouter(tags=["TTS"])


def _warm_tts_background() -> None:
    try:
        JarvisTtsService.get_instance().load_model()
    except Exception as exc:
        logger.warning("Background TTS warmup skipped: %s", exc)


if os.getenv("ECHO_JARVIS_WARMUP", "1") == "1" and not os.getenv("PYTEST_CURRENT_TEST"):
    threading.Thread(target=_warm_tts_background, name="jarvis-tts-warmup", daemon=True).start()


def _is_playground_enabled() -> bool:
    return (os.getenv("OMNIVOICE_ENABLE_PLAYGROUND") or "").strip().lower() == "true"


@router.get("/tts/omnivoice/voices", response_model=VoicesResponse)
def get_voices():
    """Returns public metadata for the four canonical Echo voices."""
    service = OmniVoiceService.get_instance()
    return VoicesResponse(voices=service.get_public_voices())


@router.post("/tts/omnivoice")
def synthesize_speech(request: OmniVoiceRequest):
    """
    Synthesizes 24 kHz mono WAV speech using commercial-clean `jarvis-tts-v2`
    (Kokoro-82M Apache-2.0 EN + VieNeu-TTS-v3-Turbo Apache-2.0 VI/EN-VI code-switching)
    with up to 6 concurrent streams and zero in-process GPLv3 dependencies.
    """
    service = OmniVoiceService.get_instance()
    try:
        wav_bytes, latency, duration = service.synthesize(
            text=request.text,
            voice_id=request.voiceId,
            lang=request.lang or "auto",
        )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'inline; filename="omnivoice_{request.voiceId}.wav"',
                "X-Synthesis-Latency": f"{latency:.3f}",
                "X-Audio-Duration": f"{duration:.3f}",
                "X-TTS-Engine": ENGINE_ID,
            },
        )
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(ve),
        )
    except TtsBusyError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech service is busy",
        )
    except Exception:
        logger.exception("TTS synthesis failed for voiceId=%s", request.voiceId)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Speech synthesis failed",
        )


@router.post("/tts/stream")
def stream_speech(request: TtsStreamRequest):
    """
    Streams raw 24 kHz signed 16-bit little-endian mono PCM (`PCM16LE`) clause-by-clause
    and chunk-by-chunk (`jarvis-tts-v2`, `-18 LUFS` normalized, `8 ms` cosine crossfade).
    """
    service = JarvisTtsService.get_instance()
    try:
        pcm_stream = service.stream_pcm_chunks(
            text=request.text,
            voice_id=request.voiceId,
            lang=request.lang or "auto",
        )
        return StreamingResponse(
            pcm_stream,
            media_type=f"audio/pcm;rate={SAMPLE_RATE};encoding=signed-integer;bits=16",
            headers={
                "X-Sample-Rate": str(SAMPLE_RATE),
                "X-TTS-Engine": ENGINE_ID,
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(ve),
        )
    except TtsBusyError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech service is busy",
        )
    except Exception:
        logger.exception("Streaming TTS failed for voiceId=%s", request.voiceId)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Streaming speech synthesis failed",
        )


@playground_router.get("/tts/omnivoice/playground", response_class=HTMLResponse)
def get_playground():
    """Serves the minimal local testing playground for voice quality evaluation (dev-only)."""
    if not _is_playground_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    html_content = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Echo JARVIS Local TTS Playground</title>
</head>
<body>
  <h1>Echo JARVIS TTS Playground (jarvis-tts-v2)</h1>
</body>
</html>"""
    return HTMLResponse(content=html_content)
