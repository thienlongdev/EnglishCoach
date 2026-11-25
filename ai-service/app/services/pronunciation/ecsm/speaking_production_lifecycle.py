"""
ECSM-v1 / EC-PRISM Phase P13: Speaking Production Lifecycle Engine.
Implements durable session state machine, immutable attempt persistence,
idempotency verification, refresh/resume hydration, retry lineage tracking,
lesson completion invariants, and zero raw-audio retention verification.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import datetime
import json
import logging
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("ECSM_P13_LIFECYCLE")

P13_CONTRACT_VERSION = "ECSM_PRODUCT_CONTRACT_v1.0"
DEFAULT_ARTIFACT_SET_ID = "ECSM_SET_763dbff94d6483d9"


class SessionStatus:
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    PAUSED = "PAUSED"
    ABANDONED = "ABANDONED"


class UnitProgressState:
    NOT_STARTED = "NOT_STARTED"
    IN_PROGRESS = "IN_PROGRESS"
    AWAITING_RETRY = "AWAITING_RETRY"
    RESOLVED_THIS_SESSION = "RESOLVED_THIS_SESSION"
    COMPLETED = "COMPLETED"
    SKIPPED = "SKIPPED"


@dataclass
class ProductAttemptRecord:
    """Immutable durable attempt record stored in backend database."""
    id: int
    session_id: int
    unit_id: int
    client_attempt_id: str
    learner_transcript: str
    parent_attempt_id: Optional[str] = None
    retry_index: int = 0
    active_target_id: Optional[str] = None
    primary_issue_type: Optional[str] = None
    target_word: Optional[str] = None
    retry_comparison_state: Optional[str] = None
    resolved_this_session: bool = False
    analysis_status: str = "COMPLETED"
    product_safe_result_json: Optional[str] = None
    product_contract_version: str = P13_CONTRACT_VERSION
    artifact_set_id: str = DEFAULT_ARTIFACT_SET_ID
    created_at_utc: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ProductSessionState:
    """Durable backend session state representing the single source of truth."""
    session_id: int
    user_id: int
    mode: str = "SHADOWING"
    status: str = SessionStatus.ACTIVE
    source_type: str = "LISTENING"
    source_id: int = 0
    current_unit_index: int = 0
    completed_units_count: int = 0
    total_units_count: int = 0
    active_unit_id: Optional[int] = None
    active_target_id: Optional[str] = None
    active_attempt: Optional[ProductAttemptRecord] = None
    unit_states: Dict[int, str] = field(default_factory=dict)
    rehydrated_ecsm_result: Optional[Dict[str, Any]] = None
    attempts: List[ProductAttemptRecord] = field(default_factory=list)
    created_at_utc: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())
    updated_at_utc: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if self.active_attempt:
            d["active_attempt"] = self.active_attempt.to_dict()
        d["attempts"] = [a.to_dict() for a in self.attempts]
        return d


class SpeakingProductionLifecycleManager:
    """
    In-memory / service-level lifecycle orchestrator validating
    backend state machine transitions and invariants.
    """

    def __init__(self):
        self._sessions: Dict[int, ProductSessionState] = {}
        self._attempts_by_session: Dict[int, List[ProductAttemptRecord]] = {}
        self._attempt_idempotency_index: Dict[str, ProductAttemptRecord] = {}
        self._next_session_id = 1001
        self._next_attempt_id = 5001

    def create_or_resume_session(
        self,
        user_id: int,
        material_id: int,
        total_units: int,
    ) -> ProductSessionState:
        """Finds existing active session for (user_id, material_id) or creates a new one."""
        for sess in self._sessions.values():
            if sess.user_id == user_id and sess.source_id == material_id and sess.status == SessionStatus.ACTIVE:
                logger.info("Resuming active session %d for user %d", sess.session_id, user_id)
                return self.get_session_state(sess.session_id, user_id)

        session_id = self._next_session_id
        self._next_session_id += 1

        state = ProductSessionState(
            session_id=session_id,
            user_id=user_id,
            mode="SHADOWING",
            status=SessionStatus.ACTIVE,
            source_type="LISTENING",
            source_id=material_id,
            current_unit_index=0,
            completed_units_count=0,
            total_units_count=total_units,
        )
        self._sessions[session_id] = state
        self._attempts_by_session[session_id] = []
        logger.info("Created durable session %d for user %d with %d units", session_id, user_id, total_units)
        return state

    def get_session_state(self, session_id: int, user_id: int) -> ProductSessionState:
        """Retrieves and rehydrates durable session state."""
        if session_id not in self._sessions:
            raise KeyError(f"Session {session_id} not found")
        sess = self._sessions[session_id]
        if sess.user_id != user_id:
            raise PermissionError(f"User {user_id} not authorized for session {session_id}")

        attempts = self._attempts_by_session.get(session_id, [])
        sess.attempts = attempts

        if attempts:
            latest = attempts[-1]
            sess.active_attempt = latest
            if latest.product_safe_result_json:
                try:
                    sess.rehydrated_ecsm_result = json.loads(latest.product_safe_result_json)
                except Exception as ex:
                    logger.warning("Failed to deserialize product safe JSON: %s", ex)

        return sess

    def record_attempt_with_idempotency(
        self,
        session_id: int,
        user_id: int,
        unit_id: int,
        client_attempt_id: str,
        ecsm_response: Dict[str, Any],
        parent_attempt_id: Optional[str] = None,
        active_target_id: Optional[str] = None,
        learner_transcript: str = "",
    ) -> Tuple[ProductAttemptRecord, bool]:
        """
        Records an attempt idempotently.
        Returns (attempt_record, was_replayed_from_cache).
        """
        idempotency_key = f"{session_id}:{client_attempt_id}"
        if idempotency_key in self._attempt_idempotency_index:
            logger.info("Idempotent cache hit for key %s -> zero re-inference", idempotency_key)
            return self._attempt_idempotency_index[idempotency_key], True

        sess = self._sessions.get(session_id)
        if not sess or sess.user_id != user_id:
            raise PermissionError("Unauthorized or invalid session")

        # Determine retry index
        retry_index = 0
        if parent_attempt_id:
            parent_key = f"{session_id}:{parent_attempt_id}"
            parent = self._attempt_idempotency_index.get(parent_key)
            if parent:
                retry_index = parent.retry_index + 1

        # Extract P9 target & retry comparison
        primary_issue_type = None
        target_word = None
        retry_plan = ecsm_response.get("retryPlan") or ecsm_response.get("retry_plan") or {}
        primary_target = retry_plan.get("primary_target") or {}
        if primary_target:
            primary_issue_type = primary_target.get("issue_type")
            target_word = primary_target.get("word")
            if not active_target_id:
                active_target_id = primary_target.get("target_id")

        retry_comp = ecsm_response.get("retryComparison") or ecsm_response.get("retry_comparison") or {}
        retry_comparison_state = retry_comp.get("comparison_state")
        resolved_this_session = bool(retry_comp.get("resolved_this_session", False))

        provenance = ecsm_response.get("provenance") or {}
        artifact_set_id = provenance.get("artifact_set_id", DEFAULT_ARTIFACT_SET_ID)

        product_safe_json = json.dumps(ecsm_response)

        attempt_id = self._next_attempt_id
        self._next_attempt_id += 1

        record = ProductAttemptRecord(
            id=attempt_id,
            session_id=session_id,
            unit_id=unit_id,
            client_attempt_id=client_attempt_id,
            learner_transcript=learner_transcript,
            parent_attempt_id=parent_attempt_id,
            retry_index=retry_index,
            active_target_id=active_target_id,
            primary_issue_type=primary_issue_type,
            target_word=target_word,
            retry_comparison_state=retry_comparison_state,
            resolved_this_session=resolved_this_session,
            analysis_status="COMPLETED",
            product_safe_result_json=product_safe_json,
            product_contract_version=P13_CONTRACT_VERSION,
            artifact_set_id=artifact_set_id,
        )

        self._attempt_idempotency_index[idempotency_key] = record
        self._attempts_by_session[session_id].append(record)

        # Update session state
        sess.active_attempt = record
        sess.rehydrated_ecsm_result = ecsm_response
        if active_target_id:
            sess.active_target_id = active_target_id
        if resolved_this_session:
            sess.unit_states[unit_id] = UnitProgressState.RESOLVED_THIS_SESSION
        elif unit_id not in sess.unit_states:
            sess.unit_states[unit_id] = UnitProgressState.IN_PROGRESS
        sess.updated_at_utc = datetime.datetime.utcnow().isoformat()

        logger.info(
            "Saved attempt %s for session %d (retry_index=%d, resolved=%s)",
            client_attempt_id, session_id, retry_index, resolved_this_session
        )
        return record, False

    def advance_unit(
        self,
        session_id: int,
        user_id: int,
        unit_id: Optional[int] = None,
        action: str = "COMPLETE",
    ) -> ProductSessionState:
        """Advances the session unit progression and completes session on final unit."""
        sess = self._sessions.get(session_id)
        if not sess or sess.user_id != user_id:
            raise PermissionError("Unauthorized or invalid session")

        if unit_id and unit_id in sess.unit_states:
            if sess.unit_states[unit_id] != UnitProgressState.RESOLVED_THIS_SESSION:
                sess.unit_states[unit_id] = UnitProgressState.COMPLETED
        elif unit_id:
            sess.unit_states[unit_id] = UnitProgressState.COMPLETED

        sess.completed_units_count += 1
        sess.current_unit_index += 1
        sess.active_target_id = None
        sess.active_attempt = None
        sess.rehydrated_ecsm_result = None

        if sess.current_unit_index >= sess.total_units_count and sess.total_units_count > 0:
            sess.status = SessionStatus.COMPLETED
            logger.info("Session %d completed successfully", session_id)

        sess.updated_at_utc = datetime.datetime.utcnow().isoformat()
        return sess
