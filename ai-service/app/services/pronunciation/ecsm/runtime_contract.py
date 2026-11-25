"""
ECSM-v1 / EC-PRISM Phase P10: Versioned Runtime Contracts, Error Taxonomy,
and Request/Response Schemas for Pre-Production Inference Hardening.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

ECSM_RUNTIME_VERSION: str = "ECSM_RUNTIME_v1.0"
ECSM_REQUEST_SCHEMA_VERSION: str = "ECSM_REQUEST_SCHEMA_v1.0"
ECSM_RESPONSE_SCHEMA_VERSION: str = "ECSM_RESPONSE_SCHEMA_v1.0"

# PRODUCT_HEURISTIC: authoritative minimum lexical correspondence required before
# target-relative phonetic assessment. This is a product safety policy, not a
# scientifically calibrated acoustic threshold.
CONTENT_PHONETIC_GATE_MIN_MATCH: float = 0.50


class RuntimeState(str, enum.Enum):
    UNINITIALIZED = "UNINITIALIZED"
    LOADING = "LOADING"
    READY = "READY"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"
    SHUTTING_DOWN = "SHUTTING_DOWN"


class AnalysisStatus(str, enum.Enum):
    COMPLETE = "COMPLETE"
    PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
    INSUFFICIENT_AUDIO = "INSUFFICIENT_AUDIO"
    FAILED = "FAILED"


class AssessmentStatus(str, enum.Enum):
    NO_ISSUE_DETECTED = "NO_ISSUE_DETECTED"
    ISSUE_DETECTED = "ISSUE_DETECTED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    ASSESSMENT_UNAVAILABLE = "ASSESSMENT_UNAVAILABLE"
    PARTIAL = "PARTIAL"


class ReferenceMode(str, enum.Enum):
    REFERENCE_FREE = "REFERENCE_FREE"
    SHADOWING_REFERENCE_RELATIVE = "SHADOWING_REFERENCE_RELATIVE"


class ResponseViewMode(str, enum.Enum):
    PRODUCT_SAFE = "PRODUCT_SAFE"
    FULL_RESEARCH = "FULL_RESEARCH"


class ErrorCode(str, enum.Enum):
    NONE = "NONE"
    INVALID_AUDIO = "INVALID_AUDIO"
    AUDIO_TOO_SHORT = "AUDIO_TOO_SHORT"
    AUDIO_TOO_LONG = "AUDIO_TOO_LONG"
    NO_SPEECH = "NO_SPEECH"
    UNSUPPORTED_CODEC = "UNSUPPORTED_CODEC"
    AUDIO_UNSUPPORTED_FORMAT = "AUDIO_UNSUPPORTED_FORMAT"
    AUDIO_DECODE_FAILED = "AUDIO_DECODE_FAILED"
    AUDIO_EMPTY = "AUDIO_EMPTY"
    AUDIO_TOO_LARGE = "AUDIO_TOO_LARGE"
    AUDIO_INVALID_DURATION = "AUDIO_INVALID_DURATION"
    AUDIO_NORMALIZATION_FAILED = "AUDIO_NORMALIZATION_FAILED"
    ECSM_INFERENCE_FAILED = "ECSM_INFERENCE_FAILED"
    ARTIFACT_MISMATCH = "ARTIFACT_MISMATCH"
    MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    DEVICE_UNAVAILABLE = "DEVICE_UNAVAILABLE"
    SEGMENTAL_UNAVAILABLE = "SEGMENTAL_UNAVAILABLE"
    PROSODY_UNAVAILABLE = "PROSODY_UNAVAILABLE"
    ALIGNMENT_UNAVAILABLE = "ALIGNMENT_UNAVAILABLE"
    REFERENCE_REQUIRED = "REFERENCE_REQUIRED"
    RUNTIME_BUSY = "RUNTIME_BUSY"
    TIMEOUT = "TIMEOUT"
    OUT_OF_MEMORY = "OUT_OF_MEMORY"
    INTERNAL_INFERENCE_ERROR = "INTERNAL_INFERENCE_ERROR"
    RESPONSE_SERIALIZATION_FAILURE = "RESPONSE_SERIALIZATION_FAILURE"
    TARGET_CONTRACT_INVALID = "TARGET_CONTRACT_INVALID"
    AUDIO_IDENTITY_MISMATCH = "AUDIO_IDENTITY_MISMATCH"
    PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
    RETRY_RUNTIME_MISMATCH = "RETRY_RUNTIME_MISMATCH"


@dataclass
class AudioQualityMetadata:
    duration_sec: float
    sample_rate: int
    num_channels: int
    rms_energy_db: float
    snr_estimate_db: float
    is_clipping: bool
    is_silent: bool
    quality_status: str


@dataclass
class RuntimeTimings:
    decode_ms: float = 0.0
    quality_gate_ms: float = 0.0
    target_build_ms: float = 0.0
    content_gate_ms: float = 0.0
    segmental_ms: float = 0.0
    prosody_ms: float = 0.0
    hierarchy_p8_ms: float = 0.0
    retry_p9_ms: float = 0.0
    total_ms: float = 0.0


@dataclass
class RuntimeProvenance:
    runtime_version: str = ECSM_RUNTIME_VERSION
    artifact_set_id: str = ""
    assessment_schema_version: str = "ECSM_P8_ASSESSMENT_SCHEMA_v1.0"
    retry_policy_version: str = "ECSM_P9_CORRECTIVE_LEARNING_POLICY_v1.0"
    model_backbone_id: str = "facebook/wav2vec2-lv-60-espeak-cv-ft"
    model_revision_short: str = "ae45363b"
    device_class: str = "CUDA"
    exact_phone_trust_policy: str = "P5.1_SELECTIVE_TRUST_LAYER"
    zero_llm_diagnostic_authority: bool = True


@dataclass
class ECSMAnalysisRequest:
    request_id: str
    audio_bytes: bytes
    audio_format: str = "wav"  # wav, webm, ogg, etc.
    source_mime_type: str = "application/octet-stream"
    source_filename: str = "upload"
    expected_text: str = ""
    recognized_text: Optional[str] = None
    content_match_ratio: Optional[float] = None
    matched_target_word_indices: Optional[List[int]] = None
    audio_identity: Optional[str] = None
    case_id: Optional[str] = None
    reference_mode: str = ReferenceMode.REFERENCE_FREE.value
    reference_audio_bytes: Optional[bytes] = None
    session_id: Optional[str] = None
    attempt_id: Optional[str] = None
    parent_attempt_id: Optional[str] = None
    target_id: Optional[str] = None
    previous_assessment_hash: Optional[str] = None
    view_mode: str = ResponseViewMode.PRODUCT_SAFE.value


@dataclass
class ECSMAnalysisResponse:
    request_id: str
    status: str  # AnalysisStatus enum
    assessment_status: str = AssessmentStatus.INSUFFICIENT_EVIDENCE.value  # NO_ISSUE_DETECTED, ISSUE_DETECTED, INSUFFICIENT_EVIDENCE, ASSESSMENT_UNAVAILABLE, PARTIAL
    evidence_coverage: float = 0.0
    target_word_coverage: float = 0.0
    target_phone_coverage: float = 0.0
    alignment_coverage: float = 0.0
    attempt_id: Optional[str] = None
    case_id: Optional[str] = None
    recognized_text: Optional[str] = None
    content_match_ratio: Optional[float] = None
    content_gate_min_match: float = CONTENT_PHONETIC_GATE_MIN_MATCH
    matched_target_word_indices: List[int] = field(default_factory=list)
    same_audio_verified: bool = False
    error_code: str = ErrorCode.NONE.value
    error_message: Optional[str] = None
    retryable: bool = False
    quality: Optional[AudioQualityMetadata] = None
    segmental_available: bool = False
    prosody_available: bool = False
    assessment: Optional[Dict[str, Any]] = None  # P8 assessment object
    retry_plan: Optional[Dict[str, Any]] = None  # P9 retry plan object
    retry_comparison: Optional[Dict[str, Any]] = None  # P9 retry comparison object
    warnings: List[str] = field(default_factory=list)
    unavailable_subsystems: List[str] = field(default_factory=list)
    gating_reasons: List[str] = field(default_factory=list)
    failure_stage: Optional[str] = None
    exception_type: Optional[str] = None
    internal_reason_code: Optional[str] = None
    timings: RuntimeTimings = field(default_factory=RuntimeTimings)
    provenance: RuntimeProvenance = field(default_factory=RuntimeProvenance)
    audit_trace: Optional[Dict[str, Any]] = None


@dataclass
class RuntimeHealthReport:
    liveness: bool
    readiness: bool
    state: str  # RuntimeState enum
    uptime_sec: float
    device: str
    vram_allocated_mb: float
    vram_reserved_mb: float
    cpu_rss_mb: float
    total_requests: int
    successful_requests: int
    failed_requests: int
    degraded_components: List[str] = field(default_factory=list)
    artifact_set_id: str = ""
