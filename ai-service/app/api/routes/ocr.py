import asyncio
import os
import tempfile
from typing import Optional
import aiofiles
from fastapi import APIRouter, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from app.services.ocr_service import OCRService, MAX_SOURCE_BYTES

router = APIRouter()
_processing_lock = asyncio.Semaphore(1)

ALLOWED_OCR_SUFFIXES = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".webp"})


def sanitize_ocr_suffix(filename: Optional[str]) -> str:
    """Allowlist temporary OCR file suffixes to known image/PDF extensions (INFRA-11)."""
    ext = os.path.splitext(filename or "")[1].lower()
    return ext if ext in ALLOWED_OCR_SUFFIXES else ".bin"


@router.post("/extract")
async def extract_text(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No file uploaded")
    suffix = sanitize_ocr_suffix(file.filename)
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    path = temp.name
    temp.close()
    try:
        async with aiofiles.open(path, "wb") as output:
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    raise ValueError("Document exceeds the 20 MiB input limit.")
                await output.write(chunk)
        async with _processing_lock:
            document = await run_in_threadpool(OCRService.extract_document, path, file.filename)
        return {"success": True, "extracted_text": document["plainText"], "canonical_document": document}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
    finally:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
