"""Content-free stage telemetry and cooperative cancellation for the existing Listening pipeline."""
import contextvars
import json
import logging
import time
import uuid
from datetime import datetime, timezone

logger = logging.getLogger("listening_timing")
current = contextvars.ContextVar("listening_trace", default=None)


class PipelineCancelled(Exception):
    pass


class Trace:
    def __init__(self, job_id=None, progress=None, cancelled=None):
        self.id = job_id or str(uuid.uuid4())
        self.progress = progress
        self.cancelled = cancelled
        self.started = time.perf_counter()
        self.stages = []
        self.metadata = None

    def check(self):
        if self.cancelled and self.cancelled.is_set():
            raise PipelineCancelled()

    def call(self, name, fn, *args, **kwargs):
        self.check()
        if self.progress:
            self.progress(name)
        started = time.perf_counter()
        row = {"jobId": self.id, "stage": name, "startedAt": datetime.now(timezone.utc).isoformat()}
        try:
            result = fn(*args, **kwargs)
            row["success"] = True
            self.check()
            return result
        except BaseException:
            row["success"] = False
            raise
        finally:
            row.update(elapsedMs=round((time.perf_counter()-started)*1000, 2),
                       finishedAt=datetime.now(timezone.utc).isoformat())
            self.stages.append(row)
            logger.info(json.dumps(row))


def measured(name, fn, *args, **kwargs):
    trace = current.get()
    return trace.call(name, fn, *args, **kwargs) if trace else fn(*args, **kwargs)
