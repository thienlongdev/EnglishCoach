"""
ECSM-v1 / EC-PRISM Phase P12: Real-User Validation Study Infrastructure.
Implements explicit study feature gate, informed adult consent engine, isolated research database,
dual PRODUCT_SAFE & FULL_RESEARCH snapshot storage, opaque audio hashing, configurable retention,
and participant withdrawal/deletion workflows.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
import datetime
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
from typing import Any, Dict, List, Optional, Tuple
import uuid

logger = logging.getLogger("ECSM_P12_STUDY_INFRA")

P12_PROTOCOL_VERSION = "ECSM_P12_PROTOCOL_v1.0"
DEFAULT_RETENTION_DAYS = 180


@dataclass
class ValidationStudyConfig:
    """Configuration for ECSM Real-User Validation Pilot."""
    study_id: str = "ECSM_PILOT_P12_2026_01"
    study_title: str = "ECSM-v1 Real-User Pronunciation Validation Pilot"
    protocol_version: str = P12_PROTOCOL_VERSION
    study_mode_enabled: bool = True
    adults_only_policy: bool = True
    target_participants: int = 30
    sentences_per_participant: int = 10
    target_initial_attempts: int = 300
    expert_reviews_per_attempt: int = 3
    target_expert_reviews: int = 900
    retention_days: int = DEFAULT_RETENTION_DAYS
    raw_audio_retention_consented_only: bool = True
    allow_synthetic_human_substitutes: bool = False  # Strictly False


@dataclass
class ConsentRecord:
    """Informed consent record for study participant."""
    consent_id: str
    participant_id: str
    protocol_version: str
    is_adult: bool
    consented_audio_capture: bool
    consented_expert_review: bool
    consented_research_analytics: bool
    timestamp_utc: str
    ip_hash: str = ""
    status: str = "ACTIVE"  # ACTIVE, WITHDRAWN, EXPIRED

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ParticipantRecord:
    """Pseudonymous participant record."""
    participant_id: str  # e.g., USR_001
    enrolled_at_utc: str
    assigned_bank_seed: int
    assigned_sentences: List[str]
    status: str = "ENROLLED"  # ENROLLED, IN_PROGRESS, COMPLETED, WITHDRAWN
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class StudyAttemptRecord:
    """Immutable study attempt record with dual product and research snapshots."""
    attempt_id: str
    session_id: str
    participant_id: str
    sentence_id: str
    expected_text: str
    is_retry: bool
    parent_attempt_id: Optional[str]
    active_target_id: Optional[str]
    audio_opaque_path: str
    audio_sha256: str
    captured_at_utc: str
    duration_sec: float
    product_safe_snapshot: Dict[str, Any]
    full_research_snapshot: Dict[str, Any]
    product_feedback_hash: str
    is_test_fixture: bool = False
    status: str = "RECORDED"  # RECORDED, EXPERT_REVIEW_PENDING, REVIEWED, ADJUDICATED, WITHDRAWN


class StudyStore:
    """
    Isolated research store for P12 validation study.
    Manages SQLite tables and consented audio files with strict separation from production tables.
    """

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.db_path = self.base_dir / "research_store.db"
        self.audio_dir = self.base_dir / "consented_audio"
        self.export_dir = self.base_dir / "exports"

        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)

        # Enforce gitignore in storage directory
        gitignore_path = self.base_dir / ".gitignore"
        if not gitignore_path.exists():
            gitignore_path.write_text("*\n!.gitignore\n", encoding="utf-8")

        self._init_db()

    @contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS participants (
                    participant_id TEXT PRIMARY KEY,
                    enrolled_at_utc TEXT,
                    assigned_bank_seed INTEGER,
                    assigned_sentences_json TEXT,
                    status TEXT,
                    metadata_json TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS consent_records (
                    consent_id TEXT PRIMARY KEY,
                    participant_id TEXT,
                    protocol_version TEXT,
                    is_adult INTEGER,
                    consented_audio_capture INTEGER,
                    consented_expert_review INTEGER,
                    consented_research_analytics INTEGER,
                    timestamp_utc TEXT,
                    status TEXT,
                    FOREIGN KEY(participant_id) REFERENCES participants(participant_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS study_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    session_id TEXT,
                    participant_id TEXT,
                    sentence_id TEXT,
                    expected_text TEXT,
                    is_retry INTEGER,
                    parent_attempt_id TEXT,
                    active_target_id TEXT,
                    audio_opaque_path TEXT,
                    audio_sha256 TEXT,
                    captured_at_utc TEXT,
                    duration_sec REAL,
                    product_safe_json TEXT,
                    full_research_json TEXT,
                    product_feedback_hash TEXT,
                    is_test_fixture INTEGER,
                    status TEXT,
                    FOREIGN KEY(participant_id) REFERENCES participants(participant_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS learner_feedback (
                    feedback_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    participant_id TEXT,
                    clarity_rating INTEGER,
                    helpfulness_rating INTEGER,
                    relevance_rating INTEGER,
                    comments TEXT,
                    submitted_at_utc TEXT,
                    FOREIGN KEY(attempt_id) REFERENCES study_attempts(attempt_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS withdrawal_records (
                    withdrawal_id TEXT PRIMARY KEY,
                    participant_id TEXT,
                    requested_at_utc TEXT,
                    audio_files_deleted_count INTEGER,
                    attempts_marked_count INTEGER,
                    audit_notes TEXT
                )
            """)
            conn.commit()

    def enroll_participant(
        self,
        participant_id: str,
        assigned_sentences: List[str],
        assigned_seed: int,
        consent: ConsentRecord,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ParticipantRecord:
        """Enroll participant with validated adult informed consent."""
        if not consent.is_adult or not consent.consented_audio_capture:
            raise ValueError("Explicit adult informed consent required for study enrollment.")

        now_str = datetime.datetime.utcnow().isoformat()
        participant = ParticipantRecord(
            participant_id=participant_id,
            enrolled_at_utc=now_str,
            assigned_bank_seed=assigned_seed,
            assigned_sentences=assigned_sentences,
            status="ENROLLED",
            metadata=metadata or {},
        )

        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT OR REPLACE INTO participants VALUES (?, ?, ?, ?, ?, ?)",
                (
                    participant.participant_id,
                    participant.enrolled_at_utc,
                    participant.assigned_bank_seed,
                    json.dumps(participant.assigned_sentences),
                    participant.status,
                    json.dumps(participant.metadata),
                ),
            )
            cur.execute(
                "INSERT OR REPLACE INTO consent_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    consent.consent_id,
                    consent.participant_id,
                    consent.protocol_version,
                    1 if consent.is_adult else 0,
                    1 if consent.consented_audio_capture else 0,
                    1 if consent.consented_expert_review else 0,
                    1 if consent.consented_research_analytics else 0,
                    consent.timestamp_utc,
                    consent.status,
                ),
            )
            conn.commit()

        return participant

    def save_study_attempt(
        self,
        participant_id: str,
        session_id: str,
        sentence_id: str,
        expected_text: str,
        audio_bytes: bytes,
        duration_sec: float,
        product_safe_resp: Dict[str, Any],
        full_research_resp: Dict[str, Any],
        is_retry: bool = False,
        parent_attempt_id: Optional[str] = None,
        active_target_id: Optional[str] = None,
        is_test_fixture: bool = False,
    ) -> StudyAttemptRecord:
        """Store consented study attempt with dual snapshots and opaque audio hashing."""
        # Verify active consent
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT status FROM consent_records WHERE participant_id = ? ORDER BY timestamp_utc DESC LIMIT 1",
                (participant_id,),
            )
            row = cur.fetchone()
            if not is_test_fixture and (not row or row[0] != "ACTIVE"):
                raise PermissionError(f"No active consent found for participant {participant_id}")

        audio_sha = hashlib.sha256(audio_bytes).hexdigest()
        opaque_audio_filename = f"AUD_{audio_sha[:16]}.wav"
        opaque_audio_path = self.audio_dir / opaque_audio_filename
        opaque_audio_path.write_bytes(audio_bytes)

        attempt_id = f"ATT_{uuid.uuid4().hex[:12]}"
        now_str = datetime.datetime.utcnow().isoformat()
        product_feedback_hash = hashlib.sha256(
            json.dumps(product_safe_resp, sort_keys=True).encode("utf-8")
        ).hexdigest()

        attempt = StudyAttemptRecord(
            attempt_id=attempt_id,
            session_id=session_id,
            participant_id=participant_id,
            sentence_id=sentence_id,
            expected_text=expected_text,
            is_retry=is_retry,
            parent_attempt_id=parent_attempt_id,
            active_target_id=active_target_id,
            audio_opaque_path=str(opaque_audio_path),
            audio_sha256=audio_sha,
            captured_at_utc=now_str,
            duration_sec=duration_sec,
            product_safe_snapshot=product_safe_resp,
            full_research_snapshot=full_research_resp,
            product_feedback_hash=product_feedback_hash,
            is_test_fixture=is_test_fixture,
            status="RECORDED",
        )

        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO study_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attempt.attempt_id,
                    attempt.session_id,
                    attempt.participant_id,
                    attempt.sentence_id,
                    attempt.expected_text,
                    1 if attempt.is_retry else 0,
                    attempt.parent_attempt_id,
                    attempt.active_target_id,
                    attempt.audio_opaque_path,
                    attempt.audio_sha256,
                    attempt.captured_at_utc,
                    attempt.duration_sec,
                    json.dumps(attempt.product_safe_snapshot),
                    json.dumps(attempt.full_research_snapshot),
                    attempt.product_feedback_hash,
                    1 if attempt.is_test_fixture else 0,
                    attempt.status,
                ),
            )
            conn.commit()

        return attempt

    def withdraw_participant(self, participant_id: str, reason: str = "USER_REQUEST") -> Dict[str, Any]:
        """
        Executes participant withdrawal:
        Deletes raw audio files from disk, marks database attempts & consent as WITHDRAWN,
        and logs audit trail.
        """
        deleted_audio_count = 0
        marked_attempts_count = 0

        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT attempt_id, audio_opaque_path FROM study_attempts WHERE participant_id = ?",
                (participant_id,),
            )
            attempts = cur.fetchall()
            for att_id, aud_path in attempts:
                if aud_path and Path(aud_path).exists():
                    try:
                        Path(aud_path).unlink()
                        deleted_audio_count += 1
                    except Exception as e:
                        logger.warning(f"Failed to delete audio file {aud_path}: {e}")

            # Mark records as withdrawn
            cur.execute(
                "UPDATE study_attempts SET status = 'WITHDRAWN', audio_opaque_path = '' WHERE participant_id = ?",
                (participant_id,),
            )
            marked_attempts_count = cur.rowcount

            cur.execute(
                "UPDATE consent_records SET status = 'WITHDRAWN' WHERE participant_id = ?",
                (participant_id,),
            )
            cur.execute(
                "UPDATE participants SET status = 'WITHDRAWN' WHERE participant_id = ?",
                (participant_id,),
            )

            withdrawal_id = f"WTH_{uuid.uuid4().hex[:10]}"
            now_str = datetime.datetime.utcnow().isoformat()
            cur.execute(
                "INSERT INTO withdrawal_records VALUES (?, ?, ?, ?, ?, ?)",
                (
                    withdrawal_id,
                    participant_id,
                    now_str,
                    deleted_audio_count,
                    marked_attempts_count,
                    f"Reason: {reason}",
                ),
            )
            conn.commit()

        return {
            "withdrawal_id": withdrawal_id,
            "participant_id": participant_id,
            "deleted_audio_files": deleted_audio_count,
            "marked_attempts": marked_attempts_count,
            "status": "WITHDRAWN_SUCCESSFUL",
        }

    def get_counts(self) -> Dict[str, int]:
        """Returns truthful counts of real study entities (excluding test fixtures)."""
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM participants WHERE status != 'WITHDRAWN'")
            part_count = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM study_attempts WHERE is_test_fixture = 0 AND is_retry = 0 AND status != 'WITHDRAWN'")
            init_attempts = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM study_attempts WHERE is_test_fixture = 0 AND is_retry = 1 AND status != 'WITHDRAWN'")
            retries = cur.fetchone()[0]

            return {
                "real_participants": part_count,
                "real_initial_attempts": init_attempts,
                "real_retries": retries,
            }
