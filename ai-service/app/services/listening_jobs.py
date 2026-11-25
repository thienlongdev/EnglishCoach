"""Bounded PC work receipts. PostgreSQL on the backend owns durable lifecycle and ownership.

Repeating a UUID after a backend restart attaches to this same computation/result. A PC restart
loses receipts; the backend may explicitly retry the same durable job, never its final DB commit.
"""
import threading
import time
from collections import OrderedDict
from queue import Queue
from fastapi import HTTPException
from app.services.listening_trace import Trace, PipelineCancelled
from app.services.listening_youtube_service import fetch_youtube_metadata_and_captions

_lock = threading.RLock()
_jobs = OrderedDict()
_queue = Queue(maxsize=8)


def _view(job, result=False):
    out = {k: job[k] for k in ("id", "status", "stage", "message")}
    if result and job["status"] == "READY":
        out["result"] = job["result"]
    return out


def submit(job_id, video_id):
    with _lock:
        now = time.monotonic()
        for key, job in list(_jobs.items()):
            if job["status"] in {"READY", "FAILED", "CANCELLED"} and now-job["updated"] > 7200:
                del _jobs[key]
        if job_id in _jobs:
            if _jobs[job_id]["video"] is not None and _jobs[job_id]["video"] != video_id:
                raise HTTPException(409, "Job identity conflict")
            return _view(_jobs[job_id])
        if len(_jobs) >= 24 or _queue.full():
            raise HTTPException(503, "Máy xử lý đang bận. Vui lòng thử lại sau.")
        job = dict(id=job_id, video=video_id, status="QUEUED", stage="QUEUED", message=None,
                   result=None, cancel=threading.Event(), updated=now)
        _jobs[job_id] = job
        _queue.put_nowait(job_id)
        return _view(job)


def get(job_id, result=False):
    with _lock:
        if job_id not in _jobs:
            raise HTTPException(404, "Không tìm thấy tác vụ trên máy xử lý.")
        return _view(_jobs[job_id], result)


def cancel(job_id):
    with _lock:
        if job_id not in _jobs:
            # A tombstone also covers cancel racing with a delayed submit.
            if len(_jobs) >= 24:
                raise HTTPException(503, "Máy xử lý đang bận.")
            _jobs[job_id] = dict(id=job_id, video=None, status="CANCELLED", stage="CANCELLED",
                message=None, result=None, cancel=threading.Event(), updated=time.monotonic())
        job = _jobs[job_id]
        job["cancel"].set()
        job["result"] = None
        job["status"] = "CANCELLED"
        job["stage"] = "CANCELLED"
        job["updated"] = time.monotonic()
        return _view(job)


def _worker():
    while True:
        job_id = _queue.get()
        job = _jobs[job_id]
        try:
            if job["cancel"].is_set():
                continue
            with _lock:
                job["status"] = "RUNNING"
            def progress(stage):
                with _lock:
                    job["stage"] = stage
                    job["updated"] = time.monotonic()
            result = fetch_youtube_metadata_and_captions(job["video"], Trace(job_id, progress, job["cancel"]))
            with _lock:
                if not job["cancel"].is_set():
                    job.update(status="READY", stage="READY", result=result)
        except PipelineCancelled:
            with _lock:
                job.update(status="CANCELLED", stage="CANCELLED")
        except Exception as exc:
            with _lock:
                if not job["cancel"].is_set():
                    # Only deliberate HTTP detail reaches the backend, never a raw runtime/URL error.
                    message = str(exc.detail) if isinstance(exc, HTTPException) else "Máy xử lý không hoàn tất tác vụ. Vui lòng thử lại."
                    job.update(status="FAILED", stage="FAILED", message=message)
        finally:
            job["updated"] = time.monotonic()
            _queue.task_done()


threading.Thread(target=_worker, name="listening-import-worker", daemon=True).start()
