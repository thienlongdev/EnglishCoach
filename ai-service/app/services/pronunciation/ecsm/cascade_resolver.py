"""
Pronunciation Cascade Resolver for ECSM Pronunciation Engine.
Implements POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC.
Enforces hard authority:
- MDD-LLM owns error detection and localization.
- CROTTC-IF provides selective acoustic diagnosis for confirmed errors.
- Final error phone IDs are strictly a subset of MDD-LLM detected phone IDs.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Set, Tuple, Optional, Any

from app.services.pronunciation.ecsm.mdd_primary_detector import MddDetectionResult
from app.services.pronunciation.ecsm.crottc_diagnosis_specialist import CrottcDiagnosisResult

logger = logging.getLogger("ai-service.cascade_resolver")

POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC = "POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC"

@dataclass
class CascadePhoneResult:
    phone_id: str
    expected_phone: str
    word_id: str
    target_word: str
    is_error_mdd: bool
    mdd_substitute: Optional[str]
    crottc_substitute: Optional[str]
    crottc_evidence_score: float
    # Cascade Decisions
    is_error_final: bool
    observed_phone: Optional[str]
    observed_phone_trusted: bool
    diagnosis_source: str  # "CLEAN", "AGREEMENT", "CROTTC_IF", "MDD_LLM", "ABSTAINED"


@dataclass
class CascadeResolutionResult:
    request_id: str
    attempt_id: Optional[str]
    case_id: Optional[str]
    # Telemetry
    primary_detector: str = "MDD_LLM"
    primary_detector_revision: str = ""
    primary_detector_called: bool = True
    primary_detection_decision: str = "CLEAN"  # "CLEAN" or "ERROR"
    primary_detected_phone_ids: List[str] = field(default_factory=list)
    primary_localized_words: List[str] = field(default_factory=list)

    diagnosis_specialist: str = "CROTTC_IF"
    diagnosis_specialist_revision: str = "9149e5107b3332b9aa3f5573f6328a4e312006ad"
    diagnosis_specialist_called: bool = False
    diagnosis_policy: str = "POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC"
    crottc_diagnosed_phone_ids: List[str] = field(default_factory=list)

    final_selected_phone_ids: List[str] = field(default_factory=list)
    legacy_detector_used: bool = False

    # Per-phone resolved items
    phone_results: List[CascadePhoneResult] = field(default_factory=list)
    phone_results_by_id: Dict[str, CascadePhoneResult] = field(default_factory=dict)

    # Invariant verification
    invariants_passed: bool = True
    invariant_violations: List[str] = field(default_factory=list)


class PronunciationCascadeResolver:
    """
    Production Resolver for MDD-LLM Primary Detector + CROTTC-IF Diagnosis Specialist.
    """
    def resolve(
        self,
        mdd_result: MddDetectionResult,
        crottc_result: CrottcDiagnosisResult,
        target_phones: List[Any],
    ) -> CascadeResolutionResult:
        phone_results: List[CascadePhoneResult] = []
        phone_results_by_id: Dict[str, CascadePhoneResult] = {}
        final_selected_ids: List[str] = []
        crottc_diagnosed_ids: List[str] = []
        violations: List[str] = []

        mdd_detected_ids = mdd_result.detected_phone_ids

        for p in target_phones:
            p_id = getattr(p, "phone_id", "") if hasattr(p, "phone_id") else p.get("phone_id", "")
            exp_p = getattr(p, "expected_phone", "") if hasattr(p, "expected_phone") else (p.get("expected_phone", "") or p.get("phone", ""))
            w_id = getattr(p, "word_id", "") if hasattr(p, "word_id") else p.get("word_id", "")
            t_word = getattr(p, "target_word", "") if hasattr(p, "target_word") else p.get("target_word", "")

            is_err_mdd = p_id in mdd_detected_ids
            mdd_sub = mdd_result.mdd_candidate_by_phone_id.get(p_id)
            crottc_sub = crottc_result.crottc_candidate_by_phone_id.get(p_id)
            crottc_score = crottc_result.crottc_evidence_score_by_phone_id.get(p_id, 0.0)

            if not is_err_mdd:
                # Rule 1: Clean in MDD-LLM -> Clean in Final (Hard Authority)
                res = CascadePhoneResult(
                    phone_id=p_id,
                    expected_phone=exp_p,
                    word_id=w_id,
                    target_word=t_word,
                    is_error_mdd=False,
                    mdd_substitute=mdd_sub,
                    crottc_substitute=crottc_sub,
                    crottc_evidence_score=crottc_score,
                    is_error_final=False,
                    observed_phone=None,
                    observed_phone_trusted=False,
                    diagnosis_source="CLEAN",
                )
            else:
                # MDD-LLM Confirmed Error
                final_selected_ids.append(p_id)
                if crottc_sub:
                    crottc_diagnosed_ids.append(p_id)

                # Policy C Diagnosis Selection:
                if mdd_sub and crottc_sub and mdd_sub == crottc_sub:
                    # Case A: Agreement
                    res = CascadePhoneResult(
                        phone_id=p_id,
                        expected_phone=exp_p,
                        word_id=w_id,
                        target_word=t_word,
                        is_error_mdd=True,
                        mdd_substitute=mdd_sub,
                        crottc_substitute=crottc_sub,
                        crottc_evidence_score=crottc_score,
                        is_error_final=True,
                        observed_phone=crottc_sub,
                        observed_phone_trusted=True,
                        diagnosis_source="AGREEMENT",
                    )
                elif crottc_sub and crottc_score >= 0.80 and crottc_sub != exp_p:
                    # Case B: Strong CROTTC acoustic evidence
                    res = CascadePhoneResult(
                        phone_id=p_id,
                        expected_phone=exp_p,
                        word_id=w_id,
                        target_word=t_word,
                        is_error_mdd=True,
                        mdd_substitute=mdd_sub,
                        crottc_substitute=crottc_sub,
                        crottc_evidence_score=crottc_score,
                        is_error_final=True,
                        observed_phone=crottc_sub,
                        observed_phone_trusted=True,
                        diagnosis_source="CROTTC_IF",
                    )
                elif mdd_sub and mdd_sub != exp_p:
                    # Case C: MDD-LLM diagnosis candidate
                    res = CascadePhoneResult(
                        phone_id=p_id,
                        expected_phone=exp_p,
                        word_id=w_id,
                        target_word=t_word,
                        is_error_mdd=True,
                        mdd_substitute=mdd_sub,
                        crottc_substitute=crottc_sub,
                        crottc_evidence_score=crottc_score,
                        is_error_final=True,
                        observed_phone=mdd_sub,
                        observed_phone_trusted=True,
                        diagnosis_source="MDD_LLM",
                    )
                else:
                    # Case D: Selective Abstention
                    res = CascadePhoneResult(
                        phone_id=p_id,
                        expected_phone=exp_p,
                        word_id=w_id,
                        target_word=t_word,
                        is_error_mdd=True,
                        mdd_substitute=mdd_sub,
                        crottc_substitute=crottc_sub,
                        crottc_evidence_score=crottc_score,
                        is_error_final=True,
                        observed_phone=None,
                        observed_phone_trusted=False,
                        diagnosis_source="ABSTAINED",
                    )

            phone_results.append(res)
            phone_results_by_id[p_id] = res

        # Hard Invariant Checks:
        # A. final_selected_phone_ids must be a subset of mdd_detected_ids
        for pid in final_selected_ids:
            if pid not in mdd_detected_ids:
                violations.append(f"INVARIANT_VIOLATION: Phone {pid} in final issues but not in MDD detections")

        # B. If MDD clean -> final issues == 0
        if mdd_result.is_clean and len(final_selected_ids) > 0:
            violations.append("INVARIANT_VIOLATION: MDD is clean but final issues count > 0")

        # C. If MDD clean -> crottc_called == False
        if mdd_result.is_clean and crottc_result.crottc_called:
            violations.append("INVARIANT_VIOLATION: MDD is clean but CROTTC was called")

        primary_decision = "CLEAN" if mdd_result.is_clean else "ERROR"

        return CascadeResolutionResult(
            request_id=mdd_result.request_id,
            attempt_id=mdd_result.attempt_id,
            case_id=mdd_result.case_id,
            primary_detector="MDD_LLM",
            primary_detector_revision=mdd_result.model_revision,
            primary_detector_called=True,
            primary_detection_decision=primary_decision,
            primary_detected_phone_ids=sorted(list(mdd_detected_ids)),
            primary_localized_words=mdd_result.localized_words,
            diagnosis_specialist="CROTTC_IF",
            diagnosis_specialist_revision=crottc_result.model_revision,
            diagnosis_specialist_called=crottc_result.crottc_called,
            diagnosis_policy="POLICY_C_AGREEMENT_OR_SELECTIVE_CROTTC",
            crottc_diagnosed_phone_ids=sorted(crottc_diagnosed_ids),
            final_selected_phone_ids=sorted(final_selected_ids),
            legacy_detector_used=False,
            phone_results=phone_results,
            phone_results_by_id=phone_results_by_id,
            invariants_passed=len(violations) == 0,
            invariant_violations=violations,
        )
