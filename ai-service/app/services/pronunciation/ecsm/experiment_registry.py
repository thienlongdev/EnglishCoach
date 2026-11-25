"""
ECSM Experiment Registry & Reproducibility Infrastructure.
Tracks immutable experiment provenance, dataset manifests, random seeds, hardware metrics, and artifact hashes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Dict, List, Mapping, Optional, Sequence
import numpy as np
import torch


def sha256_bytes(data: bytes) -> str:
    """Compute SHA-256 hex digest of raw bytes."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path | str) -> str:
    """Compute SHA-256 hex digest of a file."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    hasher = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def sha256_tensor(tensor: torch.Tensor | np.ndarray) -> str:
    """Compute deterministic SHA-256 hash of a PyTorch tensor or NumPy array."""
    if isinstance(tensor, torch.Tensor):
        array = tensor.detach().cpu().numpy()
    else:
        array = np.asarray(tensor)
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def sha256_json(obj: Any) -> str:
    """Compute deterministic SHA-256 hash of a JSON-serializable dictionary/list."""
    serialized = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return sha256_bytes(serialized)


def atomic_write_json(path: Path | str, payload: Any, indent: int = 2) -> None:
    """Atomically write a JSON file to prevent corrupted partially-written artifacts."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=indent, sort_keys=True, ensure_ascii=True).encode("utf-8")
    with tempfile.NamedTemporaryFile("wb", dir=target.parent, delete=False, suffix=".tmp") as tmp:
        tmp.write(serialized)
        tmp.flush()
        os.fsync(tmp.fileno())
        temp_name = tmp.name
    os.replace(temp_name, target)


def atomic_write_text(path: Path | str, text: str) -> None:
    """Atomically write a UTF-8 text file."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, suffix=".tmp", encoding="utf-8") as tmp:
        tmp.write(text)
        tmp.flush()
        os.fsync(tmp.fileno())
        temp_name = tmp.name
    os.replace(temp_name, target)


@dataclass
class HardwareProfile:
    gpuName: str = "N/A"
    cudaAvailable: bool = False
    vramTotalBytes: int = 0
    vramPeakBytes: int = 0
    cpuRamTotalBytes: int = 0
    cpuRamUsedBytes: int = 0
    rtf: float = 0.0
    utterancesPerSecond: float = 0.0

    @classmethod
    def capture(cls, rtf: float = 0.0, utt_per_sec: float = 0.0) -> "HardwareProfile":
        cuda_avail = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if cuda_avail else "CPU-Only"
        vram_total = torch.cuda.get_device_properties(0).total_memory if cuda_avail else 0
        vram_peak = torch.cuda.max_memory_allocated(0) if cuda_avail else 0
        return cls(
            gpuName=gpu_name,
            cudaAvailable=cuda_avail,
            vramTotalBytes=vram_total,
            vramPeakBytes=vram_peak,
            rtf=rtf,
            utterancesPerSecond=utt_per_sec,
        )


@dataclass
class ExperimentRunRecord:
    experimentId: str
    timestamp: str
    gitHash: str
    datasetManifestHash: str
    trainSpeakerHash: str
    validationSpeakerHash: str
    checkpointHash: str
    backboneId: str
    backboneRevision: str
    configuration: Dict[str, Any]
    seed: int
    metrics: Dict[str, Any]
    runtimeSeconds: float
    hardware: Dict[str, Any]
    decision: str
    artifactHashes: Dict[str, str] = field(default_factory=dict)
    schemaVersion: str = "ecsm-v1-registry-v1"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def save(self, registry_dir: Path | str) -> Path:
        out_dir = Path(registry_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        file_path = out_dir / f"{self.experimentId}_record.json"
        atomic_write_json(file_path, self.to_dict())
        return file_path
