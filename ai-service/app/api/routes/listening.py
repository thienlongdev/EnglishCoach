import logging
import os
import tempfile
import threading
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException
from uuid import UUID
from pydantic import BaseModel

from app.services.listening_local_asr import LocalPipelineUnavailable, transcription_state
from app.services.listening_youtube_service import (
    normalize_youtube_url,
    validate_youtube_video_id,
    fetch_youtube_metadata_and_captions,
    download_youtube_audio,
    align_segments_with_whisperx,
    alignment_state,
    local_pipeline_unavailable,
    warm_up_pipeline,
)

logger = logging.getLogger("listening_routes")

router = APIRouter(prefix="/listening", tags=["listening"])

# Load the local WhisperX models in the background so the first import does not pay ~25 s of model loading.
if os.getenv("LISTENING_WARMUP", "1") == "1":
    threading.Thread(target=warm_up_pipeline, name="listening-warmup", daemon=True).start()

# Identifies THIS pipeline. /health answers 200 on any build, including an old rollback; this route does not exist there,
# so a healthy but incompatible service cannot be mistaken for the canonical one (rules 10 §BE, §BM).
PIPELINE_ID = "faster-whisper-large-v3+whisperx-wav2vec2"

@router.get("/capabilities")
def capabilities_endpoint():
    transcription = transcription_state()
    alignment = alignment_state()
    return {
        "pipeline": PIPELINE_ID,
        "transcription": transcription,
        "alignment": alignment,
        # Ready = both real models are in memory on the GPU. Never true from a config value.
        "ready": bool(transcription["loaded"] and alignment["loaded"]
                      and transcription["device"] == "cuda" and alignment["device"] == "cuda"),
    }

class ProcessYouTubeRequest(BaseModel):
    youtubeUrl: str
    videoId: Optional[str] = None
    # Private PC benchmark/quality override. The application always prefers verified captions.
    preferCaptions: bool = True

@router.post("/process-youtube")
def process_youtube_endpoint(request: ProcessYouTubeRequest):
    if request.videoId is not None and request.videoId != "":
        video_id = validate_youtube_video_id(request.videoId)
    else:
        video_id = validate_youtube_video_id(normalize_youtube_url(request.youtubeUrl))

    logger.info("Processing YouTube listening import videoId=%s", video_id)
    return fetch_youtube_metadata_and_captions(video_id, prefer_captions=request.preferCaptions)

class RealignSegmentsRequest(BaseModel):
    youtubeUrl: str
    videoId: Optional[str] = None
    segments: List[Dict[str, Any]]

@router.post("/realign")
def realign_segments_endpoint(request: RealignSegmentsRequest):
    if request.videoId is not None and request.videoId != "":
        video_id = validate_youtube_video_id(request.videoId)
    else:
        video_id = validate_youtube_video_id(normalize_youtube_url(request.youtubeUrl))
    url = f"https://www.youtube.com/watch?v={video_id}"
    logger.info("Re-aligning %d segments for videoId: %s using WhisperX", len(request.segments), video_id)
    with tempfile.TemporaryDirectory() as tmpdir:
        mp3_path = download_youtube_audio(url, video_id, tmpdir)
        try:
            aligned_segments = align_segments_with_whisperx(request.segments, mp3_path)
        except LocalPipelineUnavailable as e:
            raise local_pipeline_unavailable(e)
    return {"segments": aligned_segments}



# Private PC API; browser authorization and durable receipts belong to the backend.
@router.post("/jobs/{job_id}", status_code=202)
def create_job(job_id: UUID, request: ProcessYouTubeRequest):
    from app.services import listening_jobs
    video = validate_youtube_video_id(normalize_youtube_url(request.youtubeUrl))
    if request.videoId is not None and request.videoId != "":
        req_video_id = validate_youtube_video_id(request.videoId)
        if req_video_id != video:
            raise HTTPException(400, "Video identity mismatch")
    return listening_jobs.submit(str(job_id), video)


@router.get("/jobs/{job_id}")
def get_job(job_id: UUID):
    from app.services import listening_jobs
    return listening_jobs.get(str(job_id))


@router.get("/jobs/{job_id}/result")
def get_job_result(job_id: UUID):
    from app.services import listening_jobs
    return listening_jobs.get(str(job_id), result=True)


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: UUID):
    from app.services import listening_jobs
    return listening_jobs.cancel(str(job_id))
