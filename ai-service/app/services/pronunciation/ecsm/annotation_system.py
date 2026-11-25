"""
ECSM-v1 / EC-PRISM: Human Perception Pilot Annotation System.
Implements two-pass canonical firewall, Pass-A acoustic sealing, server-gated Pass-B release,
independent annotator session management, SQLite audit log, and agreement metrics.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
import datetime
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


VALID_PHONE_TOKENS: Set[str] = {
    # Real canonical phone profiles + special perception outcomes
    "b", "d", "dʒ", "ð", "f", "g", "h", "j", "k", "l", "m", "n", "ŋ",
    "p", "r", "s", "ʃ", "t", "tʃ", "θ", "v", "w", "z", "ʒ",
    "ə", "æ", "ʌ", "ɑː", "ɒ", "ɔː", "ʊ", "uː", "ɪ", "iː", "e", "ɜː",
    "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "ɪə", "eə", "ʊə",
    # Perceptual exception outcomes
    "OTHER",
    "UNCERTAIN",
    "UNINTELLIGIBLE",
    "MULTIPLE_EVENTS",
    "INSUFFICIENT_CONTEXT",
}

PASS_B_ERROR_TYPES: List[str] = [
    "MATCH",
    "VALID_VARIANT",
    "SUBSTITUTION",
    "INSERTION",
    "DELETION",
    "EPENTHESIS",
    "REPEAT",
    "FALSE_START",
    "PAUSE",
    "OTHER",
    "UNCERTAIN",
]


@dataclass(frozen=True)
class PassAPayload:
    """Client-facing payload for Pass-A: Acoustically Blind Perception."""
    presentation_id: str
    clip_id: str
    audio_url_or_path: str
    allowed_phone_tokens: List[str] = field(default_factory=lambda: sorted(list(VALID_PHONE_TOKENS)))
    context_policy: str = "target_plus_50ms"
    instructions: str = (
        "Listen to the audio clip. Choose the phone or sound you actually perceive. "
        "Do not guess the intended word or correct the speaker. If ambiguous, mark ambiguous and add alternatives."
    )


@dataclass
class PassASubmission:
    """Annotator response for Pass A."""
    presentation_id: str
    annotator_id: str
    primary_perceived_phone: str
    alternative_phones: List[str] = field(default_factory=list)
    confidence: int = 3  # 1 (very uncertain) to 5 (very confident)
    is_ambiguous: bool = False
    intelligibility_score: int = 5  # 1 (unintelligible) to 5 (crystal clear)
    quality_flag: str = "CLEAN"  # CLEAN, NOISY, CLIPPED, UNCERTAIN_BOUNDARIES
    articulatory_notes: str = ""
    duration_ms: int = 0
    replay_count: int = 1
    timestamp: str = ""
    seal_hash: str = ""

    def compute_seal_hash(self) -> str:
        data_str = f"{self.presentation_id}|{self.annotator_id}|{self.primary_perceived_phone}|{','.join(self.alternative_phones)}|{self.confidence}|{self.is_ambiguous}|{self.timestamp}"
        return hashlib.sha256(data_str.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PassBPayload:
    """Client-facing payload for Pass-B: Revealed Context & Pronunciation Judgment."""
    presentation_id: str
    expected_canonical_phone: str
    reference_word: str
    sentence_context: str
    valid_variants: List[str] = field(default_factory=list)
    locked_pass_a_summary: Dict[str, Any] = field(default_factory=dict)
    instructions: str = (
        "You now see the intended pronunciation context. "
        "Judge whether the acoustic realization you already recorded is acceptable in this context. "
        "You cannot change your Pass-A perception."
    )


@dataclass
class PassBSubmission:
    """Annotator response for Pass B."""
    presentation_id: str
    annotator_id: str
    reference_match: bool
    error_type: str  # e.g., MATCH, SUBSTITUTION, VALID_VARIANT
    is_valid_variant: bool = False
    dialect_or_contextual_variant: bool = False
    confidence: int = 3
    judgment_notes: str = ""
    duration_ms: int = 0
    timestamp: str = ""
    submission_hash: str = ""

    def compute_hash(self) -> str:
        data_str = f"{self.presentation_id}|{self.annotator_id}|{self.reference_match}|{self.error_type}|{self.is_valid_variant}|{self.timestamp}"
        return hashlib.sha256(data_str.encode("utf-8")).hexdigest()


class PassAFirewallValidator:
    """
    Strict validator ensuring Pass A client payload has ZERO canonical or model metadata.
    """
    FORBIDDEN_KEYS: Set[str] = {
        "expectedphone", "expectedphoneme", "canonicalphone", "canonicalphoneme",
        "targetphone", "targetphoneme", "referenceword", "word", "sentence",
        "transcript", "spelling", "g_valid", "tier1label", "humanlabel",
        "modele", "hubert", "wavlm", "modelpredictions", "riskscore",
        "confidencescore", "priorityscore", "prioritybucket", "bucket",
        "confusiondirection", "isminimalpair", "iscrossbackbonedisagree",
    }

    @classmethod
    def validate_payload(cls, payload: Dict[str, Any]) -> Tuple[bool, List[str]]:
        violations = []
        cls._recursive_check(payload, "", violations)
        return len(violations) == 0, violations

    @classmethod
    def _recursive_check(cls, obj: Any, current_path: str, violations: List[str]) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                normalized_k = str(k).lower().replace("_", "").replace("-", "")
                for forbidden in cls.FORBIDDEN_KEYS:
                    if forbidden in normalized_k:
                        violations.append(f"Forbidden key '{k}' found at path '{current_path}.{k}'")
                cls._recursive_check(v, f"{current_path}.{k}", violations)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                cls._recursive_check(item, f"{current_path}[{i}]", violations)
        elif isinstance(obj, str):
            # Check for suspicious phone confusion filenames, e.g. "s_to_th.wav"
            if "_to_" in obj and (".wav" in obj or ".flac" in obj):
                violations.append(f"Suspicious confusion filename '{obj}' found at '{current_path}'")


class AnnotationDatabase:
    """
    Isolated SQLite database for research annotation storage, audit logging, and seals.
    """
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def _get_connection(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pilot_items (
                    item_id TEXT PRIMARY KEY,
                    opaque_clip_id TEXT UNIQUE NOT NULL,
                    row_id TEXT NOT NULL,
                    utterance_id TEXT NOT NULL,
                    speaker_id TEXT NOT NULL,
                    expected_phone TEXT NOT NULL,
                    reference_word TEXT,
                    tier1_perceived_phone TEXT NOT NULL,
                    bucket TEXT NOT NULL,
                    source_split TEXT NOT NULL,
                    audio_clip_path TEXT NOT NULL,
                    audio_hash TEXT NOT NULL
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS assignments (
                    presentation_id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    annotator_id TEXT NOT NULL,
                    presentation_order INTEGER NOT NULL,
                    is_hidden_repeat INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'PENDING',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(item_id) REFERENCES pilot_items(item_id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pass_a_submissions (
                    presentation_id TEXT PRIMARY KEY,
                    annotator_id TEXT NOT NULL,
                    primary_phone TEXT NOT NULL,
                    alternative_phones TEXT,
                    confidence INTEGER NOT NULL,
                    is_ambiguous INTEGER NOT NULL,
                    intelligibility INTEGER NOT NULL,
                    quality_flag TEXT NOT NULL,
                    notes TEXT,
                    duration_ms INTEGER,
                    replay_count INTEGER,
                    sealed_at TEXT NOT NULL,
                    seal_hash TEXT NOT NULL,
                    FOREIGN KEY(presentation_id) REFERENCES assignments(presentation_id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pass_b_submissions (
                    presentation_id TEXT PRIMARY KEY,
                    annotator_id TEXT NOT NULL,
                    reference_match INTEGER NOT NULL,
                    error_type TEXT NOT NULL,
                    is_valid_variant INTEGER NOT NULL,
                    dialect_variant INTEGER NOT NULL,
                    confidence INTEGER NOT NULL,
                    notes TEXT,
                    duration_ms INTEGER,
                    submitted_at TEXT NOT NULL,
                    submission_hash TEXT NOT NULL,
                    FOREIGN KEY(presentation_id) REFERENCES assignments(presentation_id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    item_id TEXT,
                    presentation_id TEXT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    event_hash TEXT NOT NULL,
                    prev_hash TEXT
                )
            """)
            conn.commit()

    def log_event(self, actor_id: str, event_type: str, payload: Dict[str, Any], item_id: Optional[str] = None, presentation_id: Optional[str] = None) -> str:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT event_hash FROM audit_log ORDER BY event_id DESC LIMIT 1")
            row = cursor.fetchone()
            prev_hash = row["event_hash"] if row else "GENESIS_HASH"

            now_str = datetime.datetime.utcnow().isoformat() + "Z"
            payload_str = json.dumps(payload, sort_keys=True)
            event_hash = hashlib.sha256(f"{now_str}|{actor_id}|{event_type}|{payload_str}|{prev_hash}".encode("utf-8")).hexdigest()

            cursor.execute("""
                INSERT INTO audit_log (timestamp, actor_id, item_id, presentation_id, event_type, payload_json, event_hash, prev_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (now_str, actor_id, item_id, presentation_id, event_type, payload_str, event_hash, prev_hash))
            conn.commit()
            return event_hash

    def insert_pilot_item(self, item: Dict[str, Any]) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO pilot_items
                (item_id, opaque_clip_id, row_id, utterance_id, speaker_id, expected_phone, reference_word, tier1_perceived_phone, bucket, source_split, audio_clip_path, audio_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                item["itemId"], item["opaqueClipId"], item["rowId"], item["utteranceId"],
                item["speakerId"], item["expectedPhone"], item.get("referenceWord", ""),
                item["humanLabel"], item.get("bucket", "UNASSIGNED"),
                item.get("sourceSplit", "CALIBRATION"), item["audioClipPath"], item["audioHash"]
            ))
            conn.commit()

    def insert_assignment(self, assignment: Dict[str, Any]) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO assignments
                (presentation_id, item_id, annotator_id, presentation_order, is_hidden_repeat, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                assignment["presentationId"], assignment["itemId"], assignment["annotatorId"],
                assignment["presentationOrder"], 1 if assignment.get("isHiddenRepeat", False) else 0,
                assignment.get("status", "PENDING"), assignment["createdAt"]
            ))
            conn.commit()

    def seal_pass_a(self, sub: PassASubmission) -> str:
        if not sub.timestamp:
            sub.timestamp = datetime.datetime.utcnow().isoformat() + "Z"
        sub.seal_hash = sub.compute_seal_hash()

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO pass_a_submissions
                (presentation_id, annotator_id, primary_phone, alternative_phones, confidence, is_ambiguous, intelligibility, quality_flag, notes, duration_ms, replay_count, sealed_at, seal_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                sub.presentation_id, sub.annotator_id, sub.primary_perceived_phone,
                json.dumps(sub.alternative_phones), sub.confidence, 1 if sub.is_ambiguous else 0,
                sub.intelligibility_score, sub.quality_flag, sub.articulatory_notes,
                sub.duration_ms, sub.replay_count, sub.timestamp, sub.seal_hash
            ))
            cursor.execute("UPDATE assignments SET status = 'PASS_A_SEALED' WHERE presentation_id = ?", (sub.presentation_id,))
            conn.commit()

        self.log_event(
            actor_id=sub.annotator_id,
            event_type="PASS_A_SEALED",
            payload={"primaryPhone": sub.primary_perceived_phone, "confidence": sub.confidence, "sealHash": sub.seal_hash},
            presentation_id=sub.presentation_id,
        )
        return sub.seal_hash

    def submit_pass_b(self, sub: PassBSubmission) -> str:
        # Verify Pass A is sealed first
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT seal_hash FROM pass_a_submissions WHERE presentation_id = ?", (sub.presentation_id,))
            row = cursor.fetchone()
            if not row:
                raise ValueError(f"Cannot submit Pass B: Pass A is not sealed for presentation '{sub.presentation_id}'")

            if not sub.timestamp:
                sub.timestamp = datetime.datetime.utcnow().isoformat() + "Z"
            sub.submission_hash = sub.compute_hash()

            cursor.execute("""
                INSERT OR REPLACE INTO pass_b_submissions
                (presentation_id, annotator_id, reference_match, error_type, is_valid_variant, dialect_variant, confidence, notes, duration_ms, submitted_at, submission_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                sub.presentation_id, sub.annotator_id, 1 if sub.reference_match else 0,
                sub.error_type, 1 if sub.is_valid_variant else 0, 1 if sub.dialect_or_contextual_variant else 0,
                sub.confidence, sub.judgment_notes, sub.duration_ms, sub.timestamp, sub.submission_hash
            ))
            cursor.execute("UPDATE assignments SET status = 'COMPLETE' WHERE presentation_id = ?", (sub.presentation_id,))
            conn.commit()

        self.log_event(
            actor_id=sub.annotator_id,
            event_type="PASS_B_SUBMITTED",
            payload={"errorType": sub.error_type, "match": sub.reference_match, "hash": sub.submission_hash},
            presentation_id=sub.presentation_id,
        )
        return sub.submission_hash

    def get_pass_a_payload(self, presentation_id: str, annotator_id: str) -> PassAPayload:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT a.presentation_id, a.item_id, p.opaque_clip_id, p.audio_clip_path
                FROM assignments a
                JOIN pilot_items p ON a.item_id = p.item_id
                WHERE a.presentation_id = ? AND a.annotator_id = ?
            """, (presentation_id, annotator_id))
            row = cursor.fetchone()
            if not row:
                raise KeyError(f"Assignment '{presentation_id}' not found for annotator '{annotator_id}'")

            payload = PassAPayload(
                presentation_id=row["presentation_id"],
                clip_id=row["opaque_clip_id"],
                audio_url_or_path=row["audio_clip_path"],
            )

            # Assert firewall on the generated dictionary
            dict_payload = asdict(payload)
            is_valid, violations = PassAFirewallValidator.validate_payload(dict_payload)
            if not is_valid:
                raise RuntimeError(f"Pass-A Firewall Violation in generated payload: {violations}")

            return payload

    def get_pass_b_payload(self, presentation_id: str, annotator_id: str) -> PassBPayload:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT s.primary_phone, s.confidence, s.is_ambiguous, s.seal_hash,
                       p.expected_phone, p.reference_word
                FROM pass_a_submissions s
                JOIN assignments a ON s.presentation_id = a.presentation_id
                JOIN pilot_items p ON a.item_id = p.item_id
                WHERE s.presentation_id = ? AND s.annotator_id = ?
            """, (presentation_id, annotator_id))
            row = cursor.fetchone()
            if not row:
                raise PermissionError(f"Pass-B release forbidden: Pass-A must be sealed first for presentation '{presentation_id}'")

            return PassBPayload(
                presentation_id=presentation_id,
                expected_canonical_phone=row["expected_phone"],
                reference_word=row["reference_word"] or "",
                sentence_context="",
                locked_pass_a_summary={
                    "primaryPhone": row["primary_phone"],
                    "confidence": row["confidence"],
                    "isAmbiguous": bool(row["is_ambiguous"]),
                    "sealHash": row["seal_hash"],
                },
            )


class AgreementStatisticsEngine:
    """
    Computes inter-rater agreement, Fleiss' kappa, Krippendorff's alpha,
    vote distributions, and comparison against frozen models.
    """

    @staticmethod
    def compute_vote_distribution(votes: Sequence[str]) -> Dict[str, float]:
        n = len(votes)
        if n == 0:
            return {}
        counts = Counter(votes)
        return {k: round(v / n, 4) for k, v in counts.items()}

    @staticmethod
    def compute_entropy(dist: Dict[str, float]) -> float:
        ent = 0.0
        for p in dist.values():
            if p > 0.0:
                ent -= p * math.log2(p)
        return round(float(ent), 4)

    @staticmethod
    def compute_fleiss_kappa(ratings_matrix: np.ndarray) -> float:
        """
        Computes Fleiss' kappa for N items across k categories where each item has n ratings.
        ratings_matrix: shape (N, k) containing vote counts per category.
        """
        n_items, n_categories = ratings_matrix.shape
        n_raters = np.sum(ratings_matrix[0, :])
        if n_items == 0 or n_raters <= 1:
            return 1.0

        p_j = np.sum(ratings_matrix, axis=0) / (n_items * n_raters)
        p_e = np.sum(p_j ** 2)

        p_i = (np.sum(ratings_matrix ** 2, axis=1) - n_raters) / (n_raters * (n_raters - 1))
        p_o = np.mean(p_i)

        if abs(1.0 - p_e) < 1e-8:
            return 1.0
        kappa = (p_o - p_e) / (1.0 - p_e)
        return round(float(kappa), 4)

    @staticmethod
    def compute_krippendorff_alpha_nominal(units_by_raters: List[List[Optional[str]]]) -> float:
        """
        Computes Krippendorff's alpha for nominal data with missing entries.
        units_by_raters: List of lists, outer is units/items, inner is ratings from raters.
        """
        pair_counts = defaultdict(int)
        val_counts = defaultdict(int)
        total_pairs = 0

        for row in units_by_raters:
            valid_vals = [v for v in row if v is not None]
            m_u = len(valid_vals)
            if m_u < 2:
                continue
            for val in valid_vals:
                val_counts[val] += 1

            for i in range(m_u):
                for j in range(m_u):
                    if i != j:
                        v1, v2 = valid_vals[i], valid_vals[j]
                        pair_counts[(v1, v2)] += 1.0 / (m_u - 1)
                        total_pairs += 1.0 / (m_u - 1)

        if total_pairs == 0:
            return 1.0

        # Observed disagreement: proportion of non-matching pairs
        d_o = sum(count for (v1, v2), count in pair_counts.items() if v1 != v2) / total_pairs

        # Expected disagreement
        total_vals = sum(val_counts.values())
        if total_vals <= 1:
            return 1.0
        d_e = 0.0
        for v1, c1 in val_counts.items():
            for v2, c2 in val_counts.items():
                if v1 != v2:
                    d_e += (c1 * c2) / (total_vals * (total_vals - 1))

        if d_e < 1e-8:
            return 1.0
        alpha = 1.0 - (d_o / d_e)
        return round(float(alpha), 4)
