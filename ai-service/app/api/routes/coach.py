import asyncio
import json
import logging
import os
import queue
import threading
import time
from typing import Any, AsyncIterator, Dict, Literal, Optional
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.domain.schemas.coach import CoachRequest, CoachResponse
from app.services.echo_local_llm import (
    EchoLocalLlmService,
    LocalLlmBusyError,
    LocalLlmCancelledError,
    LocalLlmUnavailable,
)
from app.services.echo_realtime_voice import (
    EchoRealtimeVoiceService,
    RealtimeVoiceUnavailable,
    evaluate_smart_turn_pcm,
    transcribe_realtime_echo_pcm,
)
from app.workflows.coach_workflow import run_coach_workflow

logger = logging.getLogger("coach_routes")

router = APIRouter(prefix="/coach", tags=["coach"])

DISCONNECT_POLL_SEC = 0.05

if os.getenv("ECHO_JARVIS_WARMUP", "1") == "1" and not os.getenv("PYTEST_CURRENT_TEST"):
    threading.Thread(
        target=EchoRealtimeVoiceService.get_instance().warmup,
        name="echo-realtime-voice-warmup",
        daemon=True,
    ).start()
    if os.getenv("ECHO_LOCAL_LLM_WARMUP", "1") == "1":
        threading.Thread(
            target=EchoLocalLlmService.get_instance().warmup,
            name="echo-local-llm-warmup",
            daemon=True,
        ).start()


def _warmup_skip_response() -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "id": "chatcmpl-echo-warmup-skip",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "echo-local-instruct",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "ready"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        },
        headers={"Cache-Control": "no-store"},
    )


@router.post("/plan", response_model=CoachResponse)
def create_plan(request: CoachRequest) -> CoachResponse:
    return run_coach_workflow(request)


@router.post("/transcribe")
async def transcribe(
    request: Request,
    lang: Literal["vi", "en", "auto"] = "auto",
    mode: Literal["final", "partial"] = "final",
    session_id: Optional[str] = None,
    turn_seq: Optional[int] = None,
):
    clip = bytearray()
    async for chunk in request.stream():
        if len(clip) + len(chunk) > 640000:
            raise HTTPException(413, "Voice clip too long")
        clip.extend(chunk)
    if await request.is_disconnected():
        return JSONResponse(status_code=499, content={"detail": "Client disconnected"})
    try:
        return await run_in_threadpool(
            transcribe_realtime_echo_pcm,
            bytes(clip),
            lang,
            mode,
            session_id,
            turn_seq,
        )
    except ValueError:
        raise HTTPException(400, "Invalid voice clip")
    except (RealtimeVoiceUnavailable, RuntimeError):
        raise HTTPException(503, "Speech recognition unavailable")


@router.post("/turn-check")
async def turn_check(request: Request):
    clip = bytearray()
    async for chunk in request.stream():
        if len(clip) + len(chunk) > 262144:
            raise HTTPException(413, "Turn audio clip too long")
        clip.extend(chunk)
    try:
        return await run_in_threadpool(evaluate_smart_turn_pcm, bytes(clip))
    except ValueError:
        raise HTTPException(400, "Invalid voice clip")
    except (RealtimeVoiceUnavailable, RuntimeError):
        raise HTTPException(503, "Turn detection unavailable")


@router.post("/chat/completions")
async def chat_completions(request: Request):
    """
    OpenAI-compatible streaming SSE & non-streaming JSON chat completion endpoint
    (`POST /api/v1/coach/chat/completions`, protected by `X-EC-Service-Key`) backed by
    commercial-clean CPU GGUF `EchoLocalLlmService` (`0 MiB` GPU VRAM, `0` `<think>` leak).
    """
    raw_body = bytearray()
    async for chunk in request.stream():
        if len(raw_body) + len(chunk) > 524288:
            raise HTTPException(413, "Chat payload too large")
        raw_body.extend(chunk)

    try:
        payload: Dict[str, Any] = json.loads(bytes(raw_body).decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Invalid JSON payload")

    if not isinstance(payload, dict):
        raise HTTPException(400, "Invalid JSON payload")

    svc = EchoLocalLlmService.get_instance()
    is_warmup = request.headers.get("X-EC-Warmup", "").strip() == "1"
    if is_warmup and await run_in_threadpool(svc.is_busy_or_prefix_warm, payload):
        return _warmup_skip_response()

    stream_mode = bool(payload.get("stream", False))
    cancel_event = threading.Event()

    if not stream_mode:
        if is_warmup:
            svc.register_warmup_cancel(cancel_event)
        task = asyncio.ensure_future(
            run_in_threadpool(
                lambda: svc.create_chat_completion(payload, cancel_event, is_warmup=is_warmup)
            )
        )
        try:
            while not task.done():
                if await request.is_disconnected():
                    cancel_event.set()
                    return JSONResponse(status_code=499, content={"detail": "Client disconnected"})
                done, _ = await asyncio.wait({task}, timeout=DISCONNECT_POLL_SEC)
                if done:
                    break
            result = await task
            return JSONResponse(
                content=result,
                headers={"Cache-Control": "no-store"},
            )
        except ValueError as ve:
            raise HTTPException(400, str(ve))
        except LocalLlmCancelledError:
            if is_warmup:
                return _warmup_skip_response()
            return JSONResponse(status_code=499, content={"detail": "Request cancelled"})
        except LocalLlmBusyError:
            if is_warmup:
                return _warmup_skip_response()
            raise HTTPException(503, "Local chat service is busy")
        except LocalLlmUnavailable:
            raise HTTPException(503, "Local chat model unavailable")
        except Exception:
            logger.exception("Local chat completion failed")
            raise HTTPException(500, "Local chat completion failed")
        finally:
            cancel_event.set()
            if is_warmup:
                svc.clear_warmup_cancel(cancel_event)

    if is_warmup:
        svc.register_warmup_cancel(cancel_event)
    try:
        sse_iter = await run_in_threadpool(
            lambda: svc.stream_sse_events(payload, cancel_event, is_warmup=is_warmup)
        )
    except ValueError as ve:
        if is_warmup:
            svc.clear_warmup_cancel(cancel_event)
        raise HTTPException(400, str(ve))
    except LocalLlmCancelledError:
        if is_warmup:
            svc.clear_warmup_cancel(cancel_event)
        return JSONResponse(status_code=499, content={"detail": "Request cancelled"})
    except LocalLlmBusyError:
        if is_warmup:
            svc.clear_warmup_cancel(cancel_event)
            return _warmup_skip_response()
        raise HTTPException(503, "Local chat service is busy")
    except LocalLlmUnavailable:
        if is_warmup:
            svc.clear_warmup_cancel(cancel_event)
        raise HTTPException(503, "Local chat model unavailable")
    except Exception:
        if is_warmup:
            svc.clear_warmup_cancel(cancel_event)
        logger.exception("Local streaming chat initialization failed")
        raise HTTPException(500, "Local chat completion failed")

    out_q: "queue.Queue[Optional[object]]" = queue.Queue(maxsize=64)
    sentinel = object()

    def _produce() -> None:
        try:
            for sse_line in sse_iter:
                if cancel_event.is_set():
                    break
                out_q.put(sse_line)
        except LocalLlmCancelledError:
            pass
        except Exception as exc:
            # llama.cpp messages carry sizes, never learner text; the class name alone hid the 2026-11-25 context overflow.
            logger.warning("Local LLM stream ended early: %s: %s", type(exc).__name__, str(exc)[:200])
        finally:
            if is_warmup:
                svc.clear_warmup_cancel(cancel_event)
            out_q.put(sentinel)

    threading.Thread(target=_produce, name="echo-local-llm-sse", daemon=True).start()

    async def _async_sse() -> AsyncIterator[bytes]:
        try:
            # Flush HTTP 200 SSE headers immediately (< 2 ms) so upstream 15s first-byte timeout never trips during cold prefill
            yield b": ping\n\n"
            while True:
                if await request.is_disconnected():
                    cancel_event.set()
                    break
                try:
                    item = await run_in_threadpool(out_q.get, True, DISCONNECT_POLL_SEC)
                except queue.Empty:
                    continue
                if item is sentinel:
                    break
                if isinstance(item, str):
                    yield item.encode("utf-8")
        finally:
            cancel_event.set()
            if is_warmup:
                svc.clear_warmup_cancel(cancel_event)

    return StreamingResponse(
        _async_sse(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
