from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List, Optional, Set
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger("evidence_contract")


class SpeakingTurnEvidence(BaseModel):
    """
    Authoritative evidence container for a single IELTS Speaking turn.
    Strict architectural invariant: Turns carry evidence and diagnostics ONLY.
    Never emit or store independent IELTS band values at the turn level.
    """
    turnKey: str = Field(..., min_length=1, description="Stable source-derived turn identifier")
    turnSequence: int = Field(..., ge=1, description="1-based chronological turn sequence")
    partKey: str = Field(..., description="Parent IELTS part grouping: Part 1, Part 2, or Part 3")
    promptId: Optional[str] = None
    promptText: Optional[str] = None
    recordingId: Optional[str] = None
    durationMs: Optional[int] = Field(None, ge=0)
    transcriptText: Optional[str] = None
    transcriptStatus: Optional[str] = Field("NOT_REQUESTED", description="READY, PENDING, FAILED, ABSTAINED")
    audioBase64: Optional[str] = None
    acousticEvidence: Optional[Dict[str, Any]] = Field(default_factory=dict)
    diagnostics: Optional[Dict[str, Any]] = Field(default_factory=dict)
    confidence: Optional[float] = Field(None, ge=0.0, le=1.0)
    abstention: Optional[Dict[str, Any]] = None

    model_config = {
        "extra": "forbid"  # Strictly forbid unknown fields to prevent accidental injection
    }

    @model_validator(mode="before")
    @classmethod
    def reject_forbidden_turn_fields(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values

        # 1. Architectural Invariant: Turns must never have independent IELTS band scores
        forbidden_band_fields = {"band", "ieltsBand", "bandScore", "score", "turnBand", "estimatedBand"}
        for f in forbidden_band_fields:
            if f in values and values[f] is not None:
                raise ValueError(
                    f"FORBIDDEN_TURN_BAND_SCORE: Turn '{values.get('turnKey')}' carries '{f}'={values[f]}. "
                    "Speaking turn evidence must remain free of independent IELTS band values. "
                    "IELTS Speaking is a holistic session-level assessment only."
                )

        # 2. Architectural Invariant: Exclude examiner presentation media from candidate scorer inputs
        forbidden_examiner_media = {"examinerAudioUrl", "examinerVideoUrl", "examinerAudioBase64", "examinerMedia"}
        for m in forbidden_examiner_media:
            if m in values and values[m] is not None:
                raise ValueError(
                    f"FORBIDDEN_EXAMINER_MEDIA: Scorer inputs must not receive examiner presentation media '{m}'."
                )

        # 3. Validate partKey canonical format
        part_key = values.get("partKey")
        if part_key:
            normalized_part = str(part_key).strip().title()
            if normalized_part not in {"Part 1", "Part 2", "Part 3"}:
                raise ValueError(
                    f"INVALID_PART_KEY: partKey must be 'Part 1', 'Part 2', or 'Part 3', got '{part_key}'"
                )
            values["partKey"] = normalized_part

        return values


def compute_evidence_hash(turns: List[SpeakingTurnEvidence]) -> str:
    """
    Computes a deterministic SHA-256 digest over the sorted canonical evidence fields
    of every authorized turn in the Speaking session.
    """
    canonical_items = []
    # Sort turns deterministically by sequence and turnKey
    sorted_turns = sorted(turns, key=lambda t: (t.turnSequence, t.turnKey))
    for t in sorted_turns:
        item = {
            "turnKey": t.turnKey,
            "turnSequence": t.turnSequence,
            "partKey": t.partKey,
            "recordingId": str(t.recordingId) if t.recordingId else None,
            "durationMs": t.durationMs,
            "transcriptText": (t.transcriptText or "").strip(),
            "transcriptStatus": t.transcriptStatus or "NOT_REQUESTED",
            "hasAcoustic": bool(t.acousticEvidence and len(t.acousticEvidence) > 0),
            "audioBytesLength": len(t.audioBase64) if t.audioBase64 else 0
        }
        canonical_items.append(item)

    payload_str = json.dumps(canonical_items, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_str.encode("utf-8")).hexdigest()


def compute_request_hash(
    stage_key: str,
    family: str,
    skill: str,
    snapshot_hash: Optional[str],
    evidence_hash: Optional[str]
) -> str:
    """
    Computes a deterministic SHA-256 digest over the normalized request parameters.
    """
    canonical_req = {
        "stageKey": stage_key,
        "family": family.upper(),
        "skill": skill.upper(),
        "snapshotHash": snapshot_hash or "",
        "evidenceHash": evidence_hash or ""
    }
    payload_str = json.dumps(canonical_req, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_str.encode("utf-8")).hexdigest()


def compute_output_hash(
    stage_key: str,
    overall_band: Optional[float],
    criteria_scores: List[Dict[str, Any]],
    evidence_hash: Optional[str]
) -> str:
    """
    Computes a deterministic SHA-256 digest over the score output.
    """
    sorted_criteria = sorted(criteria_scores, key=lambda c: str(c.get("criterion", "")))
    canonical_out = {
        "stageKey": stage_key,
        "overallBand": round(overall_band, 2) if overall_band is not None else None,
        "criteria": [
            {
                "criterion": c.get("criterion"),
                "score": round(float(c.get("score", 0.0)), 2)
            }
            for c in sorted_criteria
        ],
        "evidenceHash": evidence_hash or ""
    }
    payload_str = json.dumps(canonical_out, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_str.encode("utf-8")).hexdigest()


def validate_speaking_turn_evidence_set(
    turns: List[SpeakingTurnEvidence],
    required_parts: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Validates the complete authorized turn evidence set for an IELTS Speaking session.
    Enforces:
    1. Turns list is non-empty.
    2. No duplicate turnKey values.
    3. Contiguous 1-based turnSequence.
    4. All required parts present (defaults to Part 1, Part 2, Part 3).
    5. Checks acoustic evidence presence for Pronunciation scoring.
    """
    if not turns:
        raise ValueError("EMPTY_TURN_EVIDENCE_SET: Speaking scoring requires authorized turn evidence.")

    if required_parts is None:
        required_parts = ["Part 1", "Part 2", "Part 3"]

    seen_keys: Set[str] = set()
    seen_sequences: Set[int] = set()
    parts_present: Set[str] = set()
    has_acoustic_evidence = False
    missing_recordings = []

    sorted_turns = sorted(turns, key=lambda t: t.turnSequence)

    for idx, turn in enumerate(sorted_turns, start=1):
        # Unique turn keys
        if turn.turnKey in seen_keys:
            raise ValueError(f"DUPLICATE_TURN_KEY: Multiple turns carry turnKey '{turn.turnKey}'")
        seen_keys.add(turn.turnKey)

        # Contiguous sequence check
        if turn.turnSequence in seen_sequences:
            raise ValueError(f"DUPLICATE_TURN_SEQUENCE: Duplicate sequence number {turn.turnSequence}")
        seen_sequences.add(turn.turnSequence)

        if turn.turnSequence != idx:
            raise ValueError(
                f"NON_CONTIGUOUS_TURN_SEQUENCE: Expected sequence {idx}, but found {turn.turnSequence} for turn '{turn.turnKey}'"
            )

        parts_present.add(turn.partKey)

        # Recording ID tracking
        if not turn.recordingId:
            missing_recordings.append(turn.turnKey)

        # Check acoustic evidence: must have duration > 0 and either audioBase64 or non-empty acoustic metrics
        if (turn.durationMs and turn.durationMs > 500) or (turn.audioBase64 and len(turn.audioBase64) >= 1000):
            if turn.acousticEvidence and turn.acousticEvidence.get("totalBytes", 0) > 0:
                has_acoustic_evidence = True
            elif turn.audioBase64 and len(turn.audioBase64) >= 1000:
                has_acoustic_evidence = True

    # Check required parts
    missing_parts = [p for p in required_parts if p not in parts_present]
    if missing_parts:
        raise ValueError(
            f"INCOMPLETE_SPEAKING_PARTS: Authorized turn evidence set missing required parts: {missing_parts}. "
            f"Present parts: {sorted(list(parts_present))}"
        )

    evidence_hash = compute_evidence_hash(turns)

    # Pronunciation acoustic requirement
    pronunciation_abstention_required = not has_acoustic_evidence

    return {
        "valid": True,
        "turnCount": len(turns),
        "partsPresent": sorted(list(parts_present)),
        "evidenceHash": evidence_hash,
        "missingRecordings": missing_recordings,
        "hasAcousticEvidence": has_acoustic_evidence,
        "pronunciationAbstentionRequired": pronunciation_abstention_required,
        "abstentionReason": "PRONUNCIATION_LACKS_ACOUSTIC_EVIDENCE" if pronunciation_abstention_required else None
    }


def compute_writing_evidence_hash(
    prompt_text: Optional[str],
    response_text: Optional[str],
    stage_key: str,
    task_type: Optional[str] = None
) -> str:
    """
    Computes a deterministic SHA-256 digest over the canonical Writing evidence parameters.
    """
    canonical = {
        "promptText": (prompt_text or "").strip(),
        "responseText": (response_text or "").strip(),
        "stageKey": stage_key,
        "taskType": (task_type or "TASK_GENERAL").strip()
    }
    payload_str = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_str.encode("utf-8")).hexdigest()

