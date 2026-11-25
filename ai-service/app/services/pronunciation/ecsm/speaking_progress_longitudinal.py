"""
ECSM-v1 / EC-PRISM Phase P14: Speaking Learning, Progress, and Longitudinal Evidence Engine.
Provides core aggregation, recurrence policy enforcement, distinct-session verification,
within-session resolution tracking, and zero-inference instrumentation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import datetime
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("ECSM_P14_PROGRESS")

PROGRESS_POLICY_VERSION = "SPEAKING_PROGRESS_POLICY_v1"
DEFAULT_LOOKBACK_DAYS = 30
MIN_DISTINCT_SESSIONS_FOR_RECURRENCE = 2


@dataclass
class SafeIssueRecord:
    issue_type: str
    target_word: Optional[str]
    target_phone: Optional[str]
    is_safe: bool
    is_variant: bool
    caveat_note: Optional[str] = None


@dataclass
class LongitudinalAttempt:
    attempt_id: str
    session_id: int
    user_id: int
    unit_id: int
    created_at_utc: str
    primary_issue_type: Optional[str]
    target_word: Optional[str]
    target_phone: Optional[str]
    retry_index: int
    retry_comparison_state: Optional[str]
    resolved_this_session: bool
    analysis_status: str


class SpeakingProgressAggregationEngine:
    """
    Core aggregation engine for longitudinal speaking practice evidence.
    Enforces SPEAKING_PROGRESS_POLICY_v1.
    """

    def __init__(self, policy_version: str = PROGRESS_POLICY_VERSION):
        self.policy_version = policy_version
        self.lookback_days = DEFAULT_LOOKBACK_DAYS
        self.min_distinct_sessions = MIN_DISTINCT_SESSIONS_FOR_RECURRENCE
        self.hubert_forward_count = 0
        self.ecsm_analysis_count = 0

    def compute_practice_summary(
        self,
        sessions: List[Dict[str, Any]],
        attempts: List[LongitudinalAttempt],
        now_utc: Optional[datetime.datetime] = None,
    ) -> Dict[str, Any]:
        """Aggregates neutral practice frequency and volume counts."""
        now = now_utc or datetime.datetime.utcnow()
        seven_days_ago = now - datetime.timedelta(days=7)
        thirty_days_ago = now - datetime.timedelta(days=30)

        completed_7d = 0
        completed_30d = 0
        sentences_7d = 0
        sentences_30d = 0
        practice_days_7d = set()
        practice_days_30d = set()

        for s in sessions:
            dt = datetime.datetime.fromisoformat(s["created_at_utc"])
            date_str = dt.strftime("%Y-%m-%d")
            sentences = s.get("completed_units_count", 0)

            if dt >= thirty_days_ago:
                practice_days_30d.add(date_str)
                sentences_30d += sentences
                if s.get("status") == "COMPLETED":
                    completed_30d += 1

            if dt >= seven_days_ago:
                practice_days_7d.add(date_str)
                sentences_7d += sentences
                if s.get("status") == "COMPLETED":
                    completed_7d += 1

        retries_30d = 0
        resolved_30d = 0
        for a in attempts:
            dt = datetime.datetime.fromisoformat(a.created_at_utc)
            if dt >= thirty_days_ago:
                if a.retry_index > 0:
                    retries_30d += 1
                if a.resolved_this_session:
                    resolved_30d += 1

        return {
            "sessionsCompleted7d": completed_7d,
            "sessionsCompleted30d": completed_30d,
            "sentencesPracticed7d": sentences_7d,
            "sentencesPracticed30d": sentences_30d,
            "practiceDays7d": len(practice_days_7d),
            "practiceDays30d": len(practice_days_30d),
            "retries30d": retries_30d,
            "resolvedThisSessionCount30d": resolved_30d,
        }

    def aggregate_recurring_issues(
        self,
        attempts: List[LongitudinalAttempt],
        now_utc: Optional[datetime.datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        Groups observed attempts by stable key and filters by distinct-session threshold.
        Strictly excludes VALID_VARIANT, NO_SAFE_TARGET, INCONCLUSIVE.
        """
        now = now_utc or datetime.datetime.utcnow()
        thirty_days_ago = now - datetime.timedelta(days=self.lookback_days)

        grouped: Dict[str, List[LongitudinalAttempt]] = {}

        for att in attempts:
            dt = datetime.datetime.fromisoformat(att.created_at_utc)
            if dt < thirty_days_ago:
                continue

            issue_type = att.primary_issue_type
            if not issue_type or issue_type in ("VALID_VARIANT", "NO_SAFE_TARGET", "INCONCLUSIVE"):
                continue

            word = (att.target_word or "").lower().strip()
            key = f"{issue_type}:{word}" if word else issue_type
            if key not in grouped:
                grouped[key] = []
            grouped[key].append(att)

        results = []
        for key, att_list in grouped.items():
            distinct_sessions = {a.session_id for a in att_list}

            if len(distinct_sessions) >= self.min_distinct_sessions:
                latest = att_list[-1]
                resolved_sessions = {a.session_id for a in att_list if a.resolved_this_session}

                results.append({
                    "issueKey": key,
                    "issueType": latest.primary_issue_type,
                    "targetWord": latest.target_word,
                    "targetPhone": None,
                    "distinctSessionsObserved": len(distinct_sessions),
                    "totalOccurrences": len(att_list),
                    "resolvedSessionCount": len(resolved_sessions),
                    "lastObservedAt": latest.created_at_utc,
                    "displayCue": self._generate_display_cue(latest.primary_issue_type, latest.target_word),
                    "evidenceWindow": f"Last {self.lookback_days} days",
                })

        # Stable sort: distinctSessionsObserved desc, lastObservedAt desc
        results.sort(key=lambda x: (-x["distinctSessionsObserved"], x["lastObservedAt"]), reverse=False)
        return results

    def aggregate_recent_improvements(
        self,
        attempts: List[LongitudinalAttempt],
        session_title_map: Optional[Dict[int, str]] = None,
        max_items: int = 5,
    ) -> List[Dict[str, Any]]:
        """Aggregates session-grounded within-session resolutions."""
        title_map = session_title_map or {}
        improvements = []

        for att in reversed(attempts):
            if att.resolved_this_session and att.primary_issue_type and att.primary_issue_type != "VALID_VARIANT":
                improvements.append({
                    "sessionId": att.session_id,
                    "materialTitle": title_map.get(att.session_id, "Shadowing Practice"),
                    "targetWord": att.target_word,
                    "targetPhone": None,
                    "issueType": att.primary_issue_type,
                    "retryCount": max(1, att.retry_index),
                    "resolvedAt": att.created_at_utc,
                    "note": "Resolved during practice session",
                })
                if len(improvements) >= max_items:
                    break
        return improvements

    def _generate_display_cue(self, issue_type: Optional[str], target_word: Optional[str]) -> str:
        if target_word:
            return f'Focus on clear articulation when pronouncing "{target_word}".'
        if issue_type and "STRESS" in issue_type.upper():
            return "Pay attention to syllable emphasis and natural rhythm."
        if issue_type and "INTONATION" in issue_type.upper():
            return "Match the pitch contour and natural rise/fall of the sentence."
        return "Practice consistent articulation across upcoming sentences."
