"""
ECSM-v1 / EC-PRISM Phase P12: Multi-Stage Expert-Blind Pronunciation Review System.
Implements 3-stage blinded review:
- Pass E1: Acoustic-Only Blind (sealed with immutable SHA-256 hash)
- Pass E2: Revealed Pedagogical Context (server-gated on E1 seal, model still hidden)
- Pass E3: Model Feedback & Drill Audit (server-gated on E2 seal)
Ensures reviewer independence, immutable human judgments, append-only corrections,
and human adjudication queues without machine substitutes.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
import datetime
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
from typing import Any, Dict, List, Optional, Set, Tuple
import uuid

logger = logging.getLogger("ECSM_P12_EXPERT_SYSTEM")

VALID_PHONE_TOKENS: Set[str] = {
    "b", "d", "dʒ", "ð", "f", "g", "h", "j", "k", "l", "m", "n", "ŋ",
    "p", "r", "s", "ʃ", "t", "tʃ", "θ", "v", "w", "z", "ʒ",
    "ə", "æ", "ʌ", "ɑː", "ɒ", "ɔː", "ʊ", "uː", "ɪ", "iː", "e", "ɜː",
    "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "ɪə", "eə", "ʊə",
    "OTHER", "UNCERTAIN", "UNINTELLIGIBLE", "MULTIPLE_EVENTS", "INSUFFICIENT_CONTEXT",
}

E2_JUDGMENT_TYPES: List[str] = [
    "NO_CORRECTION_NEEDED",
    "ACCEPTABLE_VARIANT",
    "SEGMENTAL_CORRECTION_WARRANTED",
    "STRESS_CORRECTION_WARRANTED",
    "TIMING_CORRECTION_WARRANTED",
    "PAUSE_CORRECTION_WARRANTED",
    "REFERENCE_PROSODY_DIFFERENCE_WORTH_FEEDBACK",
    "UNCERTAIN",
    "QUALITY_REJECT",
]

E3_AUDIT_VERDICTS: List[str] = [
    "FEEDBACK_CORRECT",
    "FEEDBACK_CORRECT_BUT_OVERCONFIDENT",
    "FEEDBACK_PARTIALLY_CORRECT",
    "FEEDBACK_UNNECESSARY",
    "FEEDBACK_WRONG_LOCALIZATION",
    "FEEDBACK_WRONG_DIAGNOSIS",
    "FEEDBACK_MISLEADING",
    "FEEDBACK_UNSAFE_TO_TEACH",
    "ABSTENTION_APPROPRIATE",
    "ABSTENTION_TOO_CONSERVATIVE",
    "INSUFFICIENT_EVIDENCE",
]


@dataclass(frozen=True)
class PassE1Payload:
    """Acoustic-Only Blind Review Payload (E1)."""
    review_task_id: str
    attempt_id: str
    audio_opaque_url: str
    allowed_phone_tokens: List[str] = field(default_factory=lambda: sorted(list(VALID_PHONE_TOKENS)))
    instructions: str = (
        "Listen to the audio clip. Transcribe the phone or sound you actually perceive. "
        "Do not guess the intended sentence or correct the speaker. Mark ambiguous if uncertain."
    )


@dataclass
class PassE1Submission:
    """Expert submission for Pass E1."""
    review_task_id: str
    attempt_id: str
    expert_id: str
    perceived_phone: str
    alternative_phones: List[str] = field(default_factory=list)
    confidence: int = 4  # 1 (very uncertain) to 5 (very confident)
    is_ambiguous: bool = False
    quality_flag: str = "CLEAN"  # CLEAN, NOISY, CLIPPED, TOO_SHORT, UNINTELLIGIBLE
    notes: str = ""
    timestamp_utc: str = ""
    seal_hash: str = ""

    def compute_seal_hash(self) -> str:
        data = f"{self.review_task_id}|{self.attempt_id}|{self.expert_id}|{self.perceived_phone}|{','.join(self.alternative_phones)}|{self.confidence}|{self.is_ambiguous}|{self.timestamp_utc}"
        return hashlib.sha256(data.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PassE2Payload:
    """Revealed Pedagogical Context Payload (E2). Model diagnosis is STILL HIDDEN."""
    review_task_id: str
    attempt_id: str
    expected_sentence: str
    target_word: str
    valid_variants: List[str] = field(default_factory=list)
    reference_audio_url: Optional[str] = None
    locked_e1_perception: Dict[str, Any] = field(default_factory=dict)
    instructions: str = (
        "Review the target sentence context. Judge whether pronunciation correction is warranted. "
        "Your Pass-E1 acoustic perception is permanently locked."
    )


@dataclass
class PassE2Submission:
    """Expert submission for Pass E2."""
    review_task_id: str
    attempt_id: str
    expert_id: str
    pronunciation_judgment: str  # from E2_JUDGMENT_TYPES
    localized_word: str = ""
    localized_phone: str = ""
    correction_severity: str = "NONE"  # NONE, MINOR, MODERATE, SEVERE
    confidence: int = 4
    notes: str = ""
    timestamp_utc: str = ""
    seal_hash: str = ""

    def compute_seal_hash(self) -> str:
        data = f"{self.review_task_id}|{self.attempt_id}|{self.expert_id}|{self.pronunciation_judgment}|{self.localized_word}|{self.confidence}|{self.timestamp_utc}"
        return hashlib.sha256(data.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PassE3Payload:
    """Revealed Model Feedback & Drill Audit Payload (E3)."""
    review_task_id: str
    attempt_id: str
    product_safe_feedback: Dict[str, Any]
    prescribed_drill: Optional[Dict[str, Any]]
    locked_e1_summary: Dict[str, Any]
    locked_e2_summary: Dict[str, Any]
    instructions: str = (
        "Evaluate the actual feedback presented to the learner. "
        "Judge whether the diagnosis was accurate, misleading, or unnecessary."
    )


@dataclass
class PassE3Submission:
    """Expert submission for Pass E3."""
    review_task_id: str
    attempt_id: str
    expert_id: str
    verdict: str  # from E3_AUDIT_VERDICTS
    drill_appropriate: bool = True
    articulatory_cue_accurate: bool = True
    minimal_pair_appropriate: bool = True
    actionability_score: int = 4  # 1-5
    pedagogical_safety_notes: str = ""
    timestamp_utc: str = ""


class ExpertReviewStore:
    """
    Manages multi-stage expert review database, firewall checks, and immutability.
    """

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._init_tables()

    @contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_tables(self):
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS expert_accounts (
                    expert_id TEXT PRIMARY KEY,
                    qualification_category TEXT,
                    enrolled_at_utc TEXT,
                    status TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS review_tasks (
                    review_task_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    expert_id TEXT,
                    stage TEXT, -- E1_PENDING, E1_SEALED, E2_SEALED, E3_COMPLETED
                    assigned_at_utc TEXT,
                    UNIQUE(attempt_id, expert_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS expert_e1_reviews (
                    review_task_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    expert_id TEXT,
                    perceived_phone TEXT,
                    alternative_phones_json TEXT,
                    confidence INTEGER,
                    is_ambiguous INTEGER,
                    quality_flag TEXT,
                    notes TEXT,
                    timestamp_utc TEXT,
                    seal_hash TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS expert_e2_reviews (
                    review_task_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    expert_id TEXT,
                    pronunciation_judgment TEXT,
                    localized_word TEXT,
                    localized_phone TEXT,
                    correction_severity TEXT,
                    confidence INTEGER,
                    notes TEXT,
                    timestamp_utc TEXT,
                    seal_hash TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS expert_e3_reviews (
                    review_task_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    expert_id TEXT,
                    verdict TEXT,
                    drill_appropriate INTEGER,
                    articulatory_cue_accurate INTEGER,
                    minimal_pair_appropriate INTEGER,
                    actionability_score INTEGER,
                    pedagogical_safety_notes TEXT,
                    timestamp_utc TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS adjudications (
                    adjudication_id TEXT PRIMARY KEY,
                    attempt_id TEXT,
                    adjudicator_id TEXT,
                    resolved_phone TEXT,
                    resolved_judgment TEXT,
                    adjudication_rationale TEXT,
                    completed_at_utc TEXT
                )
            """)
            conn.commit()

    def get_e1_payload(self, review_task_id: str, expert_id: str) -> PassE1Payload:
        """Retrieves blinded Pass E1 payload."""
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT attempt_id, stage FROM review_tasks WHERE review_task_id = ? AND expert_id = ?",
                (review_task_id, expert_id),
            )
            row = cur.fetchone()
            if not row:
                raise KeyError(f"Review task {review_task_id} not assigned to {expert_id}")

            attempt_id = row["attempt_id"]
            # Fetch opaque audio path from study_attempts table
            cur.execute("SELECT audio_opaque_path FROM study_attempts WHERE attempt_id = ?", (attempt_id,))
            att_row = cur.fetchone()
            audio_path = att_row["audio_opaque_path"] if att_row else ""

            return PassE1Payload(
                review_task_id=review_task_id,
                attempt_id=attempt_id,
                audio_opaque_url=audio_path,
            )

    def submit_e1(self, submission: PassE1Submission) -> str:
        """Submits and permanently seals Pass E1 perception."""
        now_str = datetime.datetime.utcnow().isoformat()
        submission.timestamp_utc = now_str
        submission.seal_hash = submission.compute_seal_hash()

        with self._get_conn() as conn:
            cur = conn.cursor()
            # Check existing submission immutability
            cur.execute("SELECT seal_hash FROM expert_e1_reviews WHERE review_task_id = ?", (submission.review_task_id,))
            if cur.fetchone():
                raise PermissionError("E1 review already sealed and immutable.")

            cur.execute(
                """
                INSERT INTO expert_e1_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission.review_task_id,
                    submission.attempt_id,
                    submission.expert_id,
                    submission.perceived_phone,
                    json.dumps(submission.alternative_phones),
                    submission.confidence,
                    1 if submission.is_ambiguous else 0,
                    submission.quality_flag,
                    submission.notes,
                    submission.timestamp_utc,
                    submission.seal_hash,
                ),
            )
            cur.execute(
                "UPDATE review_tasks SET stage = 'E1_SEALED' WHERE review_task_id = ?",
                (submission.review_task_id,),
            )
            conn.commit()

        return submission.seal_hash

    def get_e2_payload(self, review_task_id: str, expert_id: str) -> PassE2Payload:
        """Retrieves Pass E2 payload only if E1 is sealed. Model diagnosis remains hidden."""
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT attempt_id, stage FROM review_tasks WHERE review_task_id = ? AND expert_id = ?",
                (review_task_id, expert_id),
            )
            row = cur.fetchone()
            if not row or row["stage"] not in ["E1_SEALED", "E2_SEALED", "E3_COMPLETED"]:
                raise PermissionError("Pass E1 must be sealed before Pass E2 is available.")

            attempt_id = row["attempt_id"]
            cur.execute("SELECT expected_text FROM study_attempts WHERE attempt_id = ?", (attempt_id,))
            att_row = cur.fetchone()
            expected_text = att_row["expected_text"] if att_row else ""

            cur.execute("SELECT * FROM expert_e1_reviews WHERE review_task_id = ?", (review_task_id,))
            e1_row = cur.fetchone()
            e1_summary = dict(e1_row) if e1_row else {}

            return PassE2Payload(
                review_task_id=review_task_id,
                attempt_id=attempt_id,
                expected_sentence=expected_text,
                target_word="",
                valid_variants=[],
                locked_e1_perception=e1_summary,
            )

    def submit_e2(self, submission: PassE2Submission) -> str:
        """Submits and permanently seals Pass E2 judgment."""
        now_str = datetime.datetime.utcnow().isoformat()
        submission.timestamp_utc = now_str
        submission.seal_hash = submission.compute_seal_hash()

        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT stage FROM review_tasks WHERE review_task_id = ?", (submission.review_task_id,))
            row = cur.fetchone()
            if not row or row["stage"] != "E1_SEALED":
                raise PermissionError("E1 must be sealed and E2 must be pending.")

            cur.execute(
                """
                INSERT INTO expert_e2_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission.review_task_id,
                    submission.attempt_id,
                    submission.expert_id,
                    submission.pronunciation_judgment,
                    submission.localized_word,
                    submission.localized_phone,
                    submission.correction_severity,
                    submission.confidence,
                    submission.notes,
                    submission.timestamp_utc,
                    submission.seal_hash,
                ),
            )
            cur.execute(
                "UPDATE review_tasks SET stage = 'E2_SEALED' WHERE review_task_id = ?",
                (submission.review_task_id,),
            )
            conn.commit()

        return submission.seal_hash

    def get_e3_payload(self, review_task_id: str, expert_id: str) -> PassE3Payload:
        """Retrieves Pass E3 payload only after E1 and E2 are sealed."""
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT attempt_id, stage FROM review_tasks WHERE review_task_id = ? AND expert_id = ?",
                (review_task_id, expert_id),
            )
            row = cur.fetchone()
            if not row or row["stage"] not in ["E2_SEALED", "E3_COMPLETED"]:
                raise PermissionError("Pass E1 and E2 must be sealed before Pass E3 model feedback is revealed.")

            attempt_id = row["attempt_id"]
            cur.execute("SELECT product_safe_json FROM study_attempts WHERE attempt_id = ?", (attempt_id,))
            att_row = cur.fetchone()
            product_safe = json.loads(att_row["product_safe_json"]) if att_row else {}

            cur.execute("SELECT * FROM expert_e1_reviews WHERE review_task_id = ?", (review_task_id,))
            e1_row = dict(cur.fetchone())

            cur.execute("SELECT * FROM expert_e2_reviews WHERE review_task_id = ?", (review_task_id,))
            e2_row = dict(cur.fetchone())

            return PassE3Payload(
                review_task_id=review_task_id,
                attempt_id=attempt_id,
                product_safe_feedback=product_safe,
                prescribed_drill=product_safe.get("retryPlan", {}).get("drill"),
                locked_e1_summary=e1_row,
                locked_e2_summary=e2_row,
            )

    def submit_e3(self, submission: PassE3Submission):
        """Submits Pass E3 model feedback audit."""
        now_str = datetime.datetime.utcnow().isoformat()
        submission.timestamp_utc = now_str

        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT stage FROM review_tasks WHERE review_task_id = ?", (submission.review_task_id,))
            row = cur.fetchone()
            if not row or row["stage"] != "E2_SEALED":
                raise PermissionError("Pass E2 must be sealed before submitting E3.")

            cur.execute(
                """
                INSERT INTO expert_e3_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission.review_task_id,
                    submission.attempt_id,
                    submission.expert_id,
                    submission.verdict,
                    1 if submission.drill_appropriate else 0,
                    1 if submission.articulatory_cue_accurate else 0,
                    1 if submission.minimal_pair_appropriate else 0,
                    submission.actionability_score,
                    submission.pedagogical_safety_notes,
                    submission.timestamp_utc,
                ),
            )
            cur.execute(
                "UPDATE review_tasks SET stage = 'E3_COMPLETED' WHERE review_task_id = ?",
                (submission.review_task_id,),
            )
            conn.commit()

    def get_expert_review_counts(self) -> Dict[str, int]:
        """Returns truthful count of real expert reviews (excluding test fixtures)."""
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT COUNT(*) FROM expert_e1_reviews e
                JOIN study_attempts a ON e.attempt_id = a.attempt_id
                WHERE a.is_test_fixture = 0 AND a.status != 'WITHDRAWN'
            """)
            e1_cnt = cur.fetchone()[0]
            cur.execute("""
                SELECT COUNT(*) FROM expert_e2_reviews e
                JOIN study_attempts a ON e.attempt_id = a.attempt_id
                WHERE a.is_test_fixture = 0 AND a.status != 'WITHDRAWN'
            """)
            e2_cnt = cur.fetchone()[0]
            cur.execute("""
                SELECT COUNT(*) FROM expert_e3_reviews e
                JOIN study_attempts a ON e.attempt_id = a.attempt_id
                WHERE a.is_test_fixture = 0 AND a.status != 'WITHDRAWN'
            """)
            e3_cnt = cur.fetchone()[0]
            cur.execute("""
                SELECT COUNT(*) FROM adjudications adj
                JOIN study_attempts a ON adj.attempt_id = a.attempt_id
                WHERE a.is_test_fixture = 0 AND a.status != 'WITHDRAWN'
            """)
            adj_cnt = cur.fetchone()[0]

            return {
                "e1_reviews_count": e1_cnt,
                "e2_reviews_count": e2_cnt,
                "e3_reviews_count": e3_cnt,
                "adjudications_count": adj_cnt,
            }
