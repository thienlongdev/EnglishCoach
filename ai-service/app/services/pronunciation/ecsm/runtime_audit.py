"""Development-only active-runtime identity helpers.

The identity is derived from the source bytes executing in this container, the
reported model revision, and the container hostname.  It is telemetry only and
does not participate in pronunciation decisions.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Dict


ACTIVE_RUNTIME_FILES = (
    "app/api/routes/ecsm.py",
    "app/services/pronunciation/ecsm/unified_runtime.py",
    "app/services/pronunciation/ecsm/crottc_adapter.py",
    "app/services/pronunciation/ecsm/mdd_client.py",
    "app/services/pronunciation/ecsm/mdd_sequence_alignment.py",
    "app/services/pronunciation/ecsm/hierarchical_assessment.py",
    "app/services/pronunciation/ecsm/runtime_contract.py",
    "app/services/pronunciation/ecsm/retry_intelligence.py",
)


def runtime_source_hashes() -> Dict[str, str]:
    service_root = Path(__file__).resolve().parents[4]
    hashes: Dict[str, str] = {}
    for relative_path in ACTIVE_RUNTIME_FILES:
        path = service_root / relative_path
        hashes[relative_path] = (
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "MISSING"
        )
    return hashes


def runtime_build_id(model_revision: str) -> str:
    hashes = runtime_source_hashes()
    material = "\n".join(
        [*(f"{path}:{digest}" for path, digest in sorted(hashes.items())),
         f"modelRevision:{model_revision}",
         f"containerIdentity:{os.getenv('HOSTNAME', 'UNKNOWN')}"]
    )
    return f"PRON_RUNTIME_{hashlib.sha256(material.encode('utf-8')).hexdigest()[:16]}"
