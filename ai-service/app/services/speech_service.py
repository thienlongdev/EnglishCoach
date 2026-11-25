import os
import tempfile
import logging
from typing import Dict, Any, Optional
import httpx

logger = logging.getLogger(__name__)

def _get_stt_endpoint(base_url_env: Optional[str] = None) -> str:
    """
    Construct the Speech-to-Text endpoint from the OpenRouter base URL,
    ensuring /api/v1 is not double-appended.
    """
    raw_base = (base_url_env or os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")).strip()
    if not raw_base:
        raw_base = "https://openrouter.ai/api/v1"
    base_url = raw_base.rstrip("/")
    if base_url.endswith("/api/v1") or base_url.endswith("/v1"):
        return f"{base_url}/audio/transcriptions"
    return f"{base_url}/api/v1/audio/transcriptions"

def _get_mime_type(suffix: str, content_type: Optional[str] = None) -> str:
    """
    Map audio extension / content type to standard MIME type.
    """
    if content_type and "/" in content_type:
        return content_type
    mapping = {
        ".webm": "audio/webm",
        ".mp4": "audio/mp4",
        ".m4a": "audio/m4a",
        ".ogg": "audio/ogg",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
    }
    return mapping.get(suffix.lower(), "audio/webm")

def transcribe_audio_bytes(
    audio_bytes: bytes,
    filename: Optional[str] = None,
    content_type: Optional[str] = None
) -> Dict[str, Any]:
    """
    Transcribe raw audio bytes using OpenRouter Speech-to-Text API.
    Supports WebM, MP4, M4A, OGG, WAV, and MP3 formats.
    Guarantees temp file cleanup upon completion or failure.
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key or not api_key.strip():
        logger.warning("OPENROUTER_API_KEY is not set or empty. Speech-to-Text cannot reach provider.")
        return {
            "text": "",
            "confidence": None,
            "isMocked": True
        }

    # Determine appropriate audio extension based on filename or MIME type
    suffix = ".webm"
    if filename:
        ext = os.path.splitext(filename)[1].lower()
        if ext in [".webm", ".mp4", ".m4a", ".ogg", ".wav", ".mp3"]:
            suffix = ext
    elif content_type:
        content_type_lower = content_type.lower()
        if "mp4" in content_type_lower:
            suffix = ".mp4"
        elif "m4a" in content_type_lower:
            suffix = ".m4a"
        elif "ogg" in content_type_lower:
            suffix = ".ogg"
        elif "wav" in content_type_lower:
            suffix = ".wav"
        elif "mp3" in content_type_lower or "mpeg" in content_type_lower:
            suffix = ".mp3"

    temp_file = None
    try:
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        temp_file.write(audio_bytes)
        temp_file.flush()
        temp_file.close()

        endpoint = _get_stt_endpoint()
        model_name = (os.getenv("STT_MODEL") or "openai/whisper-1").strip()
        upload_filename = filename if filename else f"audio_{os.path.basename(temp_file.name)}"
        if not upload_filename.endswith(suffix):
            upload_filename = f"{upload_filename}{suffix}"

        mime_type = _get_mime_type(suffix, content_type)

        with open(temp_file.name, "rb") as f:
            files = {
                "file": (upload_filename, f, mime_type)
            }
            data = {
                "model": model_name,
                "language": "en"
            }
            headers = {
                "Authorization": f"Bearer {api_key.strip()}"
            }

            with httpx.Client(timeout=30.0) as client:
                response = client.post(
                    endpoint,
                    headers=headers,
                    data=data,
                    files=files
                )
                if response.status_code != 200:
                    logger.error(f"OpenRouter STT error (status {response.status_code}): {response.text}")
                    response.raise_for_status()

                result_json = response.json()
                if isinstance(result_json, dict):
                    recognized_text = result_json.get("text", "").strip()
                else:
                    recognized_text = str(result_json).strip()

                return {
                    "text": recognized_text,
                    "confidence": None,
                    "isMocked": False
                }
    except Exception as e:
        logger.error(f"Failed to transcribe audio with OpenRouter STT: {e}", exc_info=True)
    finally:
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except Exception as cleanup_err:
                logger.warning(f"Failed to delete temp audio file {temp_file.name}: {cleanup_err}")


def transcribe_detailed_audio_bytes(
    audio_bytes: bytes,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Detailed Speech-to-Text with timestamp support for examination acoustic and linguistic analysis.
    Unknown confidence remains explicitly None (never fake).
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key or not api_key.strip():
        logger.warning("OPENROUTER_API_KEY is not set. Cannot transcribe exam audio.")
        return {
            "text": "",
            "confidence": None,
            "segments": [],
            "words": [],
            "capabilities": {
                "timestamp_support": False,
                "confidence_support": False,
            },
            "isMocked": True,
        }

    temp_file = None
    try:
        suffix = ".wav"
        if filename and os.path.splitext(filename)[1]:
            suffix = os.path.splitext(filename)[1].lower()

        temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        temp_file.write(audio_bytes)
        temp_file.flush()
        temp_file.close()

        endpoint = _get_stt_endpoint()
        model_name = (os.getenv("STT_MODEL") or "openai/whisper-1").strip()
        mime_type = _get_mime_type(suffix, content_type)

        with open(temp_file.name, "rb") as f:
            files = {"file": (filename or f"audio{suffix}", f, mime_type)}
            data = {
                "model": model_name,
                "language": "en",
                "response_format": "verbose_json",
                "timestamp_granularities[]": "word",
            }
            headers = {"Authorization": f"Bearer {api_key.strip()}"}

            with httpx.Client(timeout=60.0) as client:
                response = client.post(endpoint, headers=headers, data=data, files=files)
                if response.status_code != 200:
                    # Fallback to standard request if verbose_json not supported by specific gateway
                    response = client.post(
                        endpoint,
                        headers=headers,
                        data={"model": model_name, "language": "en"},
                        files={"file": (filename or f"audio{suffix}", f, mime_type)},
                    )
                response.raise_for_status()
                res_json = response.json()

                if isinstance(res_json, dict):
                    text = res_json.get("text", "").strip()
                    segments = res_json.get("segments", [])
                    words = res_json.get("words", [])
                else:
                    text = str(res_json).strip()
                    segments = []
                    words = []

                return {
                    "text": text,
                    "confidence": None,
                    "segments": segments,
                    "words": words,
                    "capabilities": {
                        "timestamp_support": len(segments) > 0 or len(words) > 0,
                        "confidence_support": False,
                    },
                    "isMocked": False,
                }
    except Exception as e:
        logger.error(f"Detailed STT error: {e}", exc_info=True)
        raise e
    finally:
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except Exception as cleanup_err:
                logger.warning(f"Failed to delete temp audio file {temp_file.name}: {cleanup_err}")
