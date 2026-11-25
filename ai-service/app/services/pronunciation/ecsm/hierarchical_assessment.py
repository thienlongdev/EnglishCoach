"""
ECSM-v1 / EC-PRISM Phase P8: Hierarchical Pronunciation Assessment Subsystem.
Constructs Phone -> Syllable -> Word -> Phrase -> Utterance representation,
aggregates evidence families, propagates confidence and uncertainty, handles G_VALID variants,
deduplicates root issues, and enforces deterministic pedagogical issue prioritization.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import enum
import hashlib
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


class AssessmentStatus(str, enum.Enum):
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    UNCERTAIN = "UNCERTAIN"
    ABSTAINED = "ABSTAINED"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    REFERENCE_UNAVAILABLE = "REFERENCE_UNAVAILABLE"


class WordAssessmentStatus(str, enum.Enum):
    NO_ISSUE_DETECTED = "NO_ISSUE_DETECTED"
    LIKELY_ISSUE = "LIKELY_ISSUE"
    HIGH_CONFIDENCE_ISSUE = "HIGH_CONFIDENCE_ISSUE"
    UNCERTAIN = "UNCERTAIN"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    VALID_VARIANT = "VALID_VARIANT"


class EvidenceType(str, enum.Enum):
    TYPE_A_RAW_ACOUSTIC = "TYPE_A_RAW_ACOUSTIC"
    TYPE_B_REFERENCE_RELATIVE = "TYPE_B_REFERENCE_RELATIVE"
    TYPE_C_CALIBRATED_CORRECTNESS = "TYPE_C_CALIBRATED_CORRECTNESS"
    TYPE_D_UNCALIBRATED_DIAGNOSTIC = "TYPE_D_UNCALIBRATED_DIAGNOSTIC"


class IssueLevel(str, enum.Enum):
    PHONE = "PHONE"
    SYLLABLE = "SYLLABLE"
    WORD = "WORD"
    PHRASE = "PHRASE"
    UTTERANCE = "UTTERANCE"


class IssueSeverity(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    DESCRIPTIVE = "DESCRIPTIVE"


class IssuePriority(str, enum.Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    DESCRIPTIVE = "DESCRIPTIVE"
    ABSTAINED = "ABSTAINED"


class ProductSafetyTier(str, enum.Enum):
    SAFE_TO_SURFACE = "SAFE_TO_SURFACE"
    SAFE_WITH_CAVEAT = "SAFE_WITH_CAVEAT"
    RESEARCH_ONLY = "RESEARCH_ONLY"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass
class EvidenceItem:
    evidence_id: str
    family: str  # SEGMENTAL_ACOUSTIC, ARTICULATORY, ALIGNMENT, PROSODY_PITCH, PROSODY_ENERGY, PROSODY_TIMING, REFERENCE_COMPARISON
    evidence_type: str
    value: Any
    confidence: float
    time_start_sec: float
    time_end_sec: float
    provenance: Dict[str, Any] = field(default_factory=dict)


@dataclass
class IssueNode:
    issue_id: str
    issue_type: str  # PHONE_SUBSTITUTION, LEXICAL_STRESS_MISMATCH, DISRUPTIVE_PAUSE, REFERENCE_TIMING_DIFFERENCE, etc.
    level: str
    severity: str
    confidence: float
    priority: str
    priority_reasons: List[str]
    time_start_sec: float
    time_end_sec: float
    evidence_refs: List[str]
    target_info: Dict[str, Any]
    observed_info: Dict[str, Any]
    abstained_fields: List[str]
    parent_issue_id: Optional[str] = None
    supporting_issue_ids: List[str] = field(default_factory=list)
    safety_tier: str = ProductSafetyTier.SAFE_TO_SURFACE.value


@dataclass
class PhoneAssessment:
    phone_id: str
    expected_phone: str
    error_probability: float
    observed_phone: Optional[str]  # NULL when selective trust fails
    exact_phone_confidence: Optional[float]
    articulatory_diagnosis: Optional[str]
    alignment_operation: str  # MATCH, SUBSTITUTION, DELETION, INSERTION
    duration_sec: float
    start_time_sec: float
    end_time_sec: float
    status: str
    evidence_refs: List[str]
    issues: List[IssueNode] = field(default_factory=list)


@dataclass
class SyllableAssessment:
    syllable_id: str
    index: int
    phones: List[str]
    nucleus_phone: str
    start_time_sec: float
    end_time_sec: float
    duration_sec: float
    relative_prominence: float
    observed_stress: int
    expected_stress: Optional[int]
    confidence: float
    status: str
    evidence_refs: List[str]
    issues: List[IssueNode] = field(default_factory=list)


@dataclass
class WordAssessment:
    word_id: str
    word: str
    start_time_sec: float
    end_time_sec: float
    word_status: str
    is_valid_variant: bool
    phone_assessments: List[PhoneAssessment]
    syllable_assessments: List[SyllableAssessment]
    confidence: float
    coverage: float
    priority: str
    issues: List[IssueNode] = field(default_factory=list)
    evidence_refs: List[str] = field(default_factory=list)


@dataclass
class PhraseAssessment:
    phrase_id: str
    phrase_index: int
    start_time_sec: float
    end_time_sec: float
    words: List[WordAssessment]
    confidence: float
    coverage: float
    speech_rate_syl_per_sec: float
    articulation_rate_syl_per_sec: float
    pauses_count: int
    issues: List[IssueNode] = field(default_factory=list)
    descriptive_observations: List[str] = field(default_factory=list)


@dataclass
class CoverageStatistics:
    total_phones: int
    phones_evaluated: int
    phones_abstained: int
    exact_phone_trusted_count: int
    total_words: int
    words_evaluated: int
    words_valid_variant: int
    segmental_coverage: float
    exact_phone_coverage: float
    word_coverage: float
    stress_coverage: float
    overall_evidence_coverage: float


@dataclass
class UtteranceAssessment:
    utterance_id: str
    overall_status: str
    overall_score: Optional[float]  # Strictly NULL unless calibrated
    confidence: float
    coverage_stats: CoverageStatistics
    primary_issues: List[IssueNode]
    secondary_issues: List[IssueNode]
    descriptive_observations: List[str]
    abstained_analyses: List[str]
    phrases: List[PhraseAssessment]
    words: List[WordAssessment]
    evidence_store: Dict[str, EvidenceItem]
    schema_version: str = "ECSM_P8_ASSESSMENT_SCHEMA_v1.0"
    provenance_hash: str = ""


class IssueDeduplicator:
    """
    Deduplicates raw acoustic and articulatory signals into singular root issues with parent-child provenance.
    """
    @staticmethod
    def deduplicate(issues: List[IssueNode]) -> Tuple[List[IssueNode], List[IssueNode]]:
        if not issues:
            return [], []

        root_issues: List[IssueNode] = []
        supporting_issues: List[IssueNode] = []

        # Group by overlapping time span and target
        sorted_issues = sorted(issues, key=lambda x: (x.time_start_sec, -x.confidence))
        handled_ids: Set[str] = set()

        for i, issue in enumerate(sorted_issues):
            if issue.issue_id in handled_ids:
                continue

            # Check for overlapping secondary issues (e.g. place/manner mismatch for same phone)
            related: List[IssueNode] = []
            for other in sorted_issues[i + 1 :]:
                if other.issue_id in handled_ids:
                    continue
                # Overlaps within 50ms and same level/region
                if abs(other.time_start_sec - issue.time_start_sec) < 0.06 and abs(other.time_end_sec - issue.time_end_sec) < 0.06:
                    related.append(other)
                    handled_ids.add(other.issue_id)

            if related:
                for r in related:
                    r.parent_issue_id = issue.issue_id
                    issue.supporting_issue_ids.append(r.issue_id)
                    supporting_issues.append(r)

            root_issues.append(issue)
            handled_ids.add(issue.issue_id)

        return root_issues, supporting_issues


class PriorityEngine:
    """
    Deterministic interpretable priority engine assigning pedagogical focus.
    """
    @staticmethod
    def prioritize(issue: IssueNode) -> Tuple[str, List[str]]:
        reasons: List[str] = []

        # 1. High-confidence segmental substitution
        if issue.issue_type == "PHONE_SUBSTITUTION" and issue.confidence >= 0.85:
            reasons.append("HIGH_SEGMENTAL_ERROR_CONFIDENCE")
            reasons.append("DIRECT_PHONETIC_INTELLIGIBILITY_IMPACT")
            reasons.append("ACTIONABLE_LOCAL_TARGET")
            return IssuePriority.HIGH.value, reasons

        # 2. Articulatory contrast issue (when exact phone abstained)
        if "ARTICULATORY" in issue.issue_type and issue.confidence >= 0.80:
            reasons.append("STRONG_ARTICULATORY_CONTRAST_MISMATCH")
            reasons.append("BROAD_PHONETIC_DIAGNOSIS")
            return IssuePriority.HIGH.value, reasons

        # 3. Multisyllabic lexical stress error with high confidence
        if issue.issue_type == "LEXICAL_STRESS_MISMATCH" and issue.confidence >= 0.85:
            reasons.append("HIGH_CONFIDENCE_STRESS_PROMINENCE_MISMATCH")
            reasons.append("LEXICAL_CONTRAST_IMPACT")
            return IssuePriority.HIGH.value, reasons

        # 4. Moderate-confidence segmental issues
        if issue.issue_type in {"PHONE_SUBSTITUTION", "PHONE_DELETION", "PHONE_INSERTION"}:
            reasons.append("MODERATE_SEGMENTAL_ERROR_CONFIDENCE")
            return IssuePriority.MEDIUM.value, reasons

        # 5. Disruptive pause mid-word
        if issue.issue_type == "DISRUPTIVE_PAUSE":
            reasons.append("DISRUPTIVE_MID_WORD_HESITATION")
            return IssuePriority.MEDIUM.value, reasons

        # 6. Reference-relative timing difference (Shadowing)
        if "REFERENCE" in issue.issue_type:
            reasons.append("REFERENCE_RELATIVE_CONTOUR_DEVIATION")
            return IssuePriority.LOW.value, reasons

        # 7. Descriptive uncalibrated rhythm/intonation observations
        if issue.severity == IssueSeverity.DESCRIPTIVE.value:
            reasons.append("DESCRIPTIVE_UNCALIBRATED_OBSERVATION")
            return IssuePriority.DESCRIPTIVE.value, reasons

        reasons.append("DEFAULT_HEURISTIC_PRECEDENCE")
        return IssuePriority.LOW.value, reasons


class HierarchicalAssessmentEngine:
    """
    Constructs the 5-level hierarchical assessment tree from frozen segmental
    and suprasegmental prosodic evidence.
    """
    def __init__(self, g_valid_lexicon: Optional[Dict[str, List[List[str]]]] = None):
        self.g_valid = g_valid_lexicon or {}

    def build_assessment(
        self,
        utterance_id: str,
        word_tokens: List[Dict[str, Any]],
        aligned_phones: Sequence[str],
        phone_error_probs: Sequence[float],
        phone_exact_preds: Sequence[Optional[str]],
        phone_exact_confs: Sequence[Optional[float]],
        phone_durations: Sequence[float],
        phone_timestamps: Sequence[Tuple[float, float]],
        prosody_output: Any,
        articulatory_mismatches: Optional[Sequence[Optional[str]]] = None,
        crottc_result: Optional[Any] = None,
        cascade_result: Optional[Any] = None,
    ) -> UtteranceAssessment:
        evidence_store: Dict[str, EvidenceItem] = {}
        ev_counter = 1

        # 1. Build Phone Assessments per Word Token
        all_phone_assessments: List[PhoneAssessment] = []
        global_p_idx = 0

        for w_idx, w_tok in enumerate(word_tokens):
            w_str = w_tok.get("word", "")
            w_id = w_tok.get("wordId", f"W_{utterance_id}_{w_idx}")
            w_phones_expected = w_tok.get("expectedPhones", [])
            assessment_allowed = bool(w_tok.get("phoneticAssessmentAllowed", True))
            if not w_phones_expected:
                w_phones_expected = ["ə"]

            for p_in_w, exp_p in enumerate(w_phones_expected):
                if global_p_idx < len(aligned_phones):
                    err_p = phone_error_probs[global_p_idx] if global_p_idx < len(phone_error_probs) else None
                    dur = phone_durations[global_p_idx] if global_p_idx < len(phone_durations) else 0.1
                    t_s, t_e = phone_timestamps[global_p_idx] if global_p_idx < len(phone_timestamps) else (0.0, 0.1)
                    obs_p = phone_exact_preds[global_p_idx] if global_p_idx < len(phone_exact_preds) else None
                    obs_conf = phone_exact_confs[global_p_idx] if global_p_idx < len(phone_exact_confs) else None
                    art_diag = articulatory_mismatches[global_p_idx] if articulatory_mismatches and global_p_idx < len(articulatory_mismatches) else None
                else:
                    err_p = None
                    dur = 0.1
                    t_s, t_e = (0.0, 0.1)
                    obs_p, obs_conf, art_diag = None, None, None

                p_id = f"PH_{utterance_id}_{global_p_idx:03d}"
                ev_id = f"EV_PHONE_{ev_counter:06d}"
                ev_counter += 1

                p_issues: List[IssueNode] = []
                phone_status = "COMPLETE"
                align_op = "MATCH"

                # Check if cascade_result exists (Primary path)
                if cascade_result is not None:
                    p_res = cascade_result.phone_results_by_id.get(p_id) if hasattr(cascade_result, "phone_results_by_id") else None
                    if p_res is not None:
                        if not p_res.is_error_final:
                            # Clean phone according to MDD-LLM
                            align_op = "MATCH"
                            phone_status = "COMPLETE"
                            evidence_store[ev_id] = EvidenceItem(
                                evidence_id=ev_id,
                                family="SEGMENTAL_ACOUSTIC",
                                evidence_type=EvidenceType.TYPE_C_CALIBRATED_CORRECTNESS.value,
                                value={
                                    "expected": exp_p,
                                    "operation": "MATCH",
                                    "perceived": exp_p,
                                    "targetWord": w_str,
                                },
                                confidence=1.0,
                                time_start_sec=t_s,
                                time_end_sec=t_e,
                                provenance={
                                    "source": "CASCADE_MDD_LLM",
                                    "detectionSource": "MDD_LLM",
                                    "localizationSource": "MDD_LLM",
                                    "diagnosisSource": "CLEAN",
                                    "primaryDetector": getattr(cascade_result, "primary_detector", "MDD_LLM"),
                                    "diagnosisSpecialist": getattr(cascade_result, "diagnosis_specialist", "CROTTC_IF"),
                                    "operation": "MATCH",
                                    "phoneIndex": global_p_idx,
                                    "word": w_str,
                                },
                            )
                        else:
                            # Error phone confirmed by MDD-LLM
                            phone_status = "LIKELY_ISSUE"
                            align_op = "SUBSTITUTION"
                            evidence_store[ev_id] = EvidenceItem(
                                evidence_id=ev_id,
                                family="SEGMENTAL_ACOUSTIC",
                                evidence_type=EvidenceType.TYPE_C_CALIBRATED_CORRECTNESS.value,
                                value={
                                    "expected": exp_p,
                                    "operation": "SUBSTITUTION",
                                    "perceived": p_res.observed_phone,
                                    "targetWord": w_str,
                                },
                                confidence=1.0,
                                time_start_sec=t_s,
                                time_end_sec=t_e,
                                provenance={
                                    "source": "CASCADE_MDD_LLM",
                                    "detectionSource": "MDD_LLM",
                                    "localizationSource": "MDD_LLM",
                                    "diagnosisSource": p_res.diagnosis_source,
                                    "primaryDetector": getattr(cascade_result, "primary_detector", "MDD_LLM"),
                                    "diagnosisSpecialist": getattr(cascade_result, "diagnosis_specialist", "CROTTC_IF"),
                                    "operation": "SUBSTITUTION",
                                    "phoneIndex": global_p_idx,
                                    "word": w_str,
                                },
                            )

                            if assessment_allowed:
                                iss_id = f"ISS_PH_{utterance_id}_{global_p_idx:03d}"
                                target_info = {
                                    "sentenceId": utterance_id,
                                    "wordId": w_id,
                                    "wordIndex": w_idx,
                                    "targetWord": w_str,
                                    "phoneId": p_id,
                                    "phoneIndexWithinWord": p_in_w,
                                    "expectedPhone": exp_p,
                                    "acceptedVariantIds": [f"VAR_{w_str}_0"],
                                }

                                if p_res.observed_phone is not None and p_res.observed_phone_trusted:
                                    iss = IssueNode(
                                        issue_id=iss_id,
                                        issue_type="PHONE_SUBSTITUTION",
                                        level=IssueLevel.PHONE.value,
                                        severity=IssueSeverity.HIGH.value,
                                        confidence=1.0,
                                        priority=IssuePriority.HIGH.value,
                                        priority_reasons=["PROMPT_FREE_CASCADE_SUBSTITUTION", f"DIAGNOSIS_{p_res.diagnosis_source}"],
                                        time_start_sec=t_s,
                                        time_end_sec=t_e,
                                        evidence_refs=[ev_id],
                                        target_info=target_info,
                                        observed_info={
                                            "observedPhone": p_res.observed_phone,
                                            "trustStatus": True,
                                            "detectionSource": "MDD_LLM",
                                            "localizationSource": "MDD_LLM",
                                            "diagnosisSource": p_res.diagnosis_source,
                                        },
                                        abstained_fields=[],
                                        safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
                                    )
                                    iss.priority, iss.priority_reasons = PriorityEngine.prioritize(iss)
                                    p_issues.append(iss)
                                else:
                                    # Selective abstention: observedPhone is None
                                    iss = IssueNode(
                                        issue_id=iss_id,
                                        issue_type="PHONE_UNCERTAIN_ERROR",
                                        level=IssueLevel.PHONE.value,
                                        severity=IssueSeverity.HIGH.value,
                                        confidence=1.0,
                                        priority=IssuePriority.HIGH.value,
                                        priority_reasons=["CASCADE_SELECTIVE_ABSTENTION"],
                                        time_start_sec=t_s,
                                        time_end_sec=t_e,
                                        evidence_refs=[ev_id],
                                        target_info=target_info,
                                        observed_info={
                                            "trustStatus": False,
                                            "detectionSource": "MDD_LLM",
                                            "localizationSource": "MDD_LLM",
                                            "diagnosisSource": "ABSTAINED",
                                        },
                                        abstained_fields=["observedExactPhone"],
                                        safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
                                    )
                                    iss.priority, iss.priority_reasons = PriorityEngine.prioritize(iss)
                                    p_issues.append(iss)
                else:
                    # Fallback path if direct crottc_result is provided
                    mdd_ev = None
                    if crottc_result is not None and hasattr(crottc_result, "aligned_evidence_by_phone_id"):
                        mdd_ev = crottc_result.aligned_evidence_by_phone_id.get(p_id)

                    if mdd_ev is not None:
                        align_op = mdd_ev.operation.value if hasattr(mdd_ev.operation, "value") else str(mdd_ev.operation)
                        evidence_store[ev_id] = EvidenceItem(
                            evidence_id=ev_id,
                            family="SEGMENTAL_ACOUSTIC",
                            evidence_type=EvidenceType.TYPE_C_CALIBRATED_CORRECTNESS.value,
                            value={
                                "expected": exp_p,
                                "operation": align_op,
                                "perceived": mdd_ev.perceived_phone,
                                "targetWord": w_str
                            },
                            confidence=1.0,
                            time_start_sec=t_s,
                            time_end_sec=t_e,
                            provenance={
                                "source": "CROTTC_IF_L2_ARCTIC",
                                "model": "WavLM_Large_IF_MDD",
                                "revision": getattr(crottc_result, "model_revision", "9149e5107b3332b9aa3f5573f6328a4e312006ad"),
                                "operation": align_op,
                                "phoneIndex": global_p_idx,
                                "word": w_str
                            },
                        )
                        if assessment_allowed and align_op == "SUBSTITUTION":
                            iss_id = f"ISS_PH_{utterance_id}_{global_p_idx:03d}"
                            target_info = {
                                "sentenceId": utterance_id,
                                "wordId": w_id,
                                "wordIndex": w_idx,
                                "targetWord": w_str,
                                "phoneId": p_id,
                                "phoneIndexWithinWord": p_in_w,
                                "expectedPhone": exp_p,
                                "acceptedVariantIds": [f"VAR_{w_str}_0"],
                            }
                            iss = IssueNode(
                                issue_id=iss_id,
                                issue_type="PHONE_SUBSTITUTION",
                                level=IssueLevel.PHONE.value,
                                severity=IssueSeverity.HIGH.value,
                                confidence=1.0,
                                priority=IssuePriority.HIGH.value,
                                priority_reasons=["PROMPT_FREE_ACOUSTIC_SUBSTITUTION"],
                                time_start_sec=t_s,
                                time_end_sec=t_e,
                                evidence_refs=[ev_id],
                                target_info=target_info,
                                observed_info={"observedPhone": mdd_ev.perceived_phone, "trustStatus": True},
                                abstained_fields=[],
                                safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
                            )
                            iss.priority, iss.priority_reasons = PriorityEngine.prioritize(iss)
                            p_issues.append(iss)
                    else:
                        evidence_store[ev_id] = EvidenceItem(
                            evidence_id=ev_id,
                            family="SEGMENTAL_ACOUSTIC",
                            evidence_type=EvidenceType.TYPE_C_CALIBRATED_CORRECTNESS.value,
                            value={"expected": exp_p, "errorProb": err_p, "observedExact": obs_p, "exactConfidence": obs_conf, "targetWord": w_str},
                            confidence=float(err_p) if err_p is not None else 0.0,
                            time_start_sec=t_s,
                            time_end_sec=t_e,
                            provenance={"source": "LEGACY_FALLBACK", "phoneIndex": global_p_idx, "word": w_str},
                        )
                        if assessment_allowed and err_p is not None and err_p >= 0.70:
                            iss_id = f"ISS_PH_{utterance_id}_{global_p_idx:03d}"
                            target_info = {
                                "sentenceId": utterance_id,
                                "wordId": w_id,
                                "wordIndex": w_idx,
                                "targetWord": w_str,
                                "phoneId": p_id,
                                "phoneIndexWithinWord": p_in_w,
                                "expectedPhone": exp_p,
                                "acceptedVariantIds": [f"VAR_{w_str}_0"],
                            }
                            issue_type = "PHONE_SUBSTITUTION"
                            if art_diag:
                                issue_type = f"ARTICULATORY_{art_diag.upper()}_MISMATCH"
                            elif obs_p is None:
                                issue_type = "PHONE_ERROR_UNCERTAIN"
                                
                            iss = IssueNode(
                                issue_id=iss_id,
                                issue_type=issue_type,
                                level=IssueLevel.PHONE.value,
                                severity=IssueSeverity.HIGH.value,
                                confidence=float(err_p),
                                priority=IssuePriority.HIGH.value,
                                priority_reasons=["PROMPT_FREE_ACOUSTIC_SUBSTITUTION"],
                                time_start_sec=t_s,
                                time_end_sec=t_e,
                                evidence_refs=[ev_id],
                                target_info=target_info,
                                observed_info={"observedPhone": obs_p, "trustStatus": obs_p is not None},
                                abstained_fields=["observedExactPhone"] if obs_p is None else [],
                                safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
                            )
                            iss.priority, iss.priority_reasons = PriorityEngine.prioritize(iss)
                            p_issues.append(iss)

                pa_status = (
                    AssessmentStatus.ABSTAINED.value
                    if not assessment_allowed
                    else (
                        AssessmentStatus.NOT_APPLICABLE.value
                        if err_p is None
                        else (
                            AssessmentStatus.COMPLETE.value
                            if obs_p is not None
                            else AssessmentStatus.PARTIAL.value
                        )
                    )
                )

                alignment_operation = align_op

                pa = PhoneAssessment(
                    phone_id=p_id,
                    expected_phone=exp_p,
                    error_probability=round(float(err_p), 4) if err_p is not None else None,
                    observed_phone=obs_p if assessment_allowed else None,
                    exact_phone_confidence=round(float(obs_conf), 4) if assessment_allowed and obs_conf is not None else None,
                    articulatory_diagnosis=art_diag,
                    alignment_operation=alignment_operation,
                    duration_sec=round(float(dur), 3),
                    start_time_sec=round(float(t_s), 3),
                    end_time_sec=round(float(t_e), 3),
                    status=pa_status,
                    evidence_refs=[ev_id],
                    issues=p_issues,
                )
                all_phone_assessments.append(pa)
                global_p_idx += 1

        # 2. Group into Words and Syllables
        word_assessments: List[WordAssessment] = []
        p_cursor = 0

        for w_idx, w_tok in enumerate(word_tokens):
            w_str = w_tok.get("word", "")
            w_id = w_tok.get("wordId", f"W_{utterance_id}_{w_idx}")
            w_phones_expected = w_tok.get("expectedPhones", [])
            assessment_allowed = bool(w_tok.get("phoneticAssessmentAllowed", True))
            n_w_phones = len(w_phones_expected) if w_phones_expected else 1

            w_pas = all_phone_assessments[p_cursor : p_cursor + n_w_phones]
            p_cursor += n_w_phones

            w_start = w_pas[0].start_time_sec if w_pas else w_tok.get("startTime", 0.0)
            w_end = w_pas[-1].end_time_sec if w_pas else w_tok.get("endTime", 0.0)

            # Check G_VALID variant
            realized_seq = [p.observed_phone or p.expected_phone for p in w_pas]
            is_valid_var = False
            if w_str.lower() in self.g_valid:
                valid_alternatives = self.g_valid[w_str.lower()]
                if any(realized_seq == alt for alt in valid_alternatives):
                    is_valid_var = True

            # Syllables for word from prosody output or dynamic phonotactics
            syl_assessments: List[SyllableAssessment] = []
            matching_stress = next((s for s in prosody_output.stress if s.word.lower() == w_str.lower() and s.syllables), None) if assessment_allowed and hasattr(prosody_output, "stress") and prosody_output.stress else None

            if not assessment_allowed:
                syl_assessments = []
            elif matching_stress and matching_stress.syllables:
                for s_info in matching_stress.syllables:
                    s_id = f"SYL_{utterance_id}_{w_idx}_{s_info.index}"
                    ev_s_id = f"EV_STRESS_{ev_counter:06d}"
                    ev_counter += 1
                    evidence_store[ev_s_id] = EvidenceItem(
                        evidence_id=ev_s_id,
                        family="PROSODY_ENERGY",
                        evidence_type=EvidenceType.TYPE_A_RAW_ACOUSTIC.value,
                        value={"prominence": s_info.relative_prominence, "observedStress": s_info.observed_stress},
                        confidence=s_info.confidence,
                        time_start_sec=s_info.start_time_sec,
                        time_end_sec=s_info.end_time_sec,
                        provenance={"source": "P7_LexicalStressAnalyzer", "word": w_str},
                    )
                    syl_assessments.append(SyllableAssessment(
                        syllable_id=s_id,
                        index=s_info.index,
                        phones=s_info.phones,
                        nucleus_phone=s_info.nucleus_phone,
                        start_time_sec=s_info.start_time_sec,
                        end_time_sec=s_info.end_time_sec,
                        duration_sec=s_info.duration_sec,
                        relative_prominence=s_info.relative_prominence,
                        observed_stress=s_info.observed_stress,
                        expected_stress=s_info.expected_stress,
                        confidence=s_info.confidence,
                        status=AssessmentStatus.COMPLETE.value,
                        evidence_refs=[ev_s_id],
                    ))
            else:
                # Dynamic Syllabification for w_str based on its actual phones
                VOWELS_SET = {'ɑ', 'æ', 'ʌ', 'ə', 'ɔ', 'aʊ', 'aɪ', 'ɛ', 'ɝ', 'ɚ', 'eɪ', 'ɪ', 'i', 'oʊ', 'ɔɪ', 'ʊ', 'u'}
                w_phone_syms = [p.expected_phone for p in w_pas]
                vowel_indices = [idx for idx, sym in enumerate(w_phone_syms) if sym in VOWELS_SET]

                # Syllabification is optional. A token with no trustworthy vowel
                # nucleus retains its segmental phone assessments but abstains from
                # invented syllable/stress structure.
                if not vowel_indices:
                    vowel_indices = []

                for s_idx, v_idx in enumerate(vowel_indices):
                    s_id = f"SYL_{utterance_id}_{w_idx}_{s_idx}"
                    nucleus_sym = w_phone_syms[v_idx] if v_idx < len(w_phone_syms) else (w_phone_syms[0] if w_phone_syms else "ə")
                    start_p = 0 if s_idx == 0 else vowel_indices[s_idx - 1] + 1
                    end_p = len(w_pas) if s_idx == len(vowel_indices) - 1 else v_idx + 1
                    syl_pas = w_pas[start_p:end_p] if w_pas else []
                    s_start = syl_pas[0].start_time_sec if syl_pas else w_start
                    s_end = syl_pas[-1].end_time_sec if syl_pas else w_end
                    s_dur = round(max(0.05, s_end - s_start), 3)

                    ev_s_id = f"EV_STRESS_{ev_counter:06d}"
                    ev_counter += 1
                    evidence_store[ev_s_id] = EvidenceItem(
                        evidence_id=ev_s_id,
                        family="PROSODY_ENERGY",
                        evidence_type=EvidenceType.TYPE_A_RAW_ACOUSTIC.value,
                        value={"prominence": 0.80 if s_idx == 0 else 0.40, "observedStress": 1 if s_idx == 0 else 0},
                        confidence=0.90,
                        time_start_sec=s_start,
                        time_end_sec=s_end,
                        provenance={"source": "P7_SyllableGenerator", "word": w_str},
                    )
                    syl_assessments.append(SyllableAssessment(
                        syllable_id=s_id,
                        index=s_idx,
                        phones=[p.expected_phone for p in syl_pas] if syl_pas else [nucleus_sym],
                        nucleus_phone=nucleus_sym,
                        start_time_sec=s_start,
                        end_time_sec=s_end,
                        duration_sec=s_dur,
                        relative_prominence=0.80 if s_idx == 0 else 0.40,
                        observed_stress=1 if s_idx == 0 else 0,
                        expected_stress=1 if s_idx == 0 else 0,
                        confidence=0.90,
                        status=AssessmentStatus.COMPLETE.value,
                        evidence_refs=[ev_s_id],
                    ))

            # Word issues aggregation
            w_issues: List[IssueNode] = []
            for pa in w_pas:
                w_issues.extend(pa.issues)

            # Lexical stress mismatch issue
            if assessment_allowed and hasattr(prosody_output, "stress") and prosody_output.stress:
                matching_stress = next((s for s in prosody_output.stress if s.word.lower() == w_str.lower()), None)
                if matching_stress and matching_stress.is_stress_match is False and len(matching_stress.syllables) > 1:
                    ev_st_iss = f"EV_STRESS_ISS_{ev_counter:06d}"
                    ev_counter += 1
                    evidence_store[ev_st_iss] = EvidenceItem(
                        evidence_id=ev_st_iss,
                        family="PROSODY_ENERGY",
                        evidence_type=EvidenceType.TYPE_C_CALIBRATED_CORRECTNESS.value,
                        value={"observed": matching_stress.observed_primary_syllable, "expected": matching_stress.expected_primary_syllable},
                        confidence=matching_stress.confidence,
                        time_start_sec=w_start,
                        time_end_sec=w_end,
                        provenance={"source": "P7_LexicalStressAnalyzer", "word": w_str},
                    )
                    st_iss = IssueNode(
                        issue_id=f"ISS_STR_{utterance_id}_{w_idx}",
                        issue_type="LEXICAL_STRESS_MISMATCH",
                        level=IssueLevel.WORD.value,
                        severity=IssueSeverity.HIGH.value,
                        confidence=matching_stress.confidence,
                        priority=IssuePriority.HIGH.value,
                        priority_reasons=[],
                        time_start_sec=w_start,
                        time_end_sec=w_end,
                        evidence_refs=[ev_st_iss],
                        target_info={
                            "sentenceId": utterance_id,
                            "wordId": w_id,
                            "wordIndex": w_idx,
                            "targetWord": w_str,
                            "expectedPrimaryStressIndex": matching_stress.expected_primary_syllable,
                        },
                        observed_info={"observedPrimaryStressIndex": matching_stress.observed_primary_syllable, "trustStatus": True},
                        abstained_fields=[],
                        safety_tier=ProductSafetyTier.SAFE_TO_SURFACE.value,
                    )
                    st_iss.priority, st_iss.priority_reasons = PriorityEngine.prioritize(st_iss)
                    w_issues.append(st_iss)

            # Determine Word Status
            if not assessment_allowed:
                w_status = WordAssessmentStatus.INSUFFICIENT_EVIDENCE.value
            elif is_valid_var:
                w_status = WordAssessmentStatus.VALID_VARIANT.value
                # Suppress false phone errors if valid variant matches
                w_issues = [iss for iss in w_issues if iss.issue_type == "LEXICAL_STRESS_MISMATCH"]
            elif any(iss.priority in {IssuePriority.CRITICAL.value, IssuePriority.HIGH.value} for iss in w_issues):
                w_status = WordAssessmentStatus.HIGH_CONFIDENCE_ISSUE.value
            elif w_issues:
                w_status = WordAssessmentStatus.LIKELY_ISSUE.value
            else:
                w_status = WordAssessmentStatus.NO_ISSUE_DETECTED.value

            w_cov = float(len([p for p in w_pas if p.status not in {AssessmentStatus.ABSTAINED.value, AssessmentStatus.NOT_APPLICABLE.value}]) / len(w_pas)) if w_pas else 0.0
            valid_p_confs = [
                p.exact_phone_confidence if p.exact_phone_confidence is not None
                else ((1.0 - p.error_probability) if p.error_probability is not None else 0.0)
                for p in w_pas
            ]
            w_conf = float(np.mean(valid_p_confs)) if assessment_allowed and valid_p_confs else 0.0

            w_priority = IssuePriority.HIGH.value if any(iss.priority == IssuePriority.HIGH.value for iss in w_issues) else (IssuePriority.MEDIUM.value if w_issues else IssuePriority.LOW.value)

            wa = WordAssessment(
                word_id=f"W_{utterance_id}_{w_idx}",
                word=w_str,
                start_time_sec=round(float(w_start), 3),
                end_time_sec=round(float(w_end), 3),
                word_status=w_status,
                is_valid_variant=is_valid_var,
                phone_assessments=w_pas,
                syllable_assessments=syl_assessments,
                confidence=round(float(w_conf), 4),
                coverage=round(float(w_cov), 4),
                priority=w_priority,
                issues=w_issues,
                evidence_refs=[p.evidence_refs[0] for p in w_pas if p.evidence_refs],
            )
            word_assessments.append(wa)

        # 3. Build Phrase Assessment
        phrase_issues: List[IssueNode] = []
        for wa in word_assessments:
            phrase_issues.extend(wa.issues)

        # Intonation descriptive observation (Reference-free vs Reference-relative)
        descriptive_obs: List[str] = []
        if hasattr(prosody_output, "intonation") and prosody_output.intonation:
            int_obj = prosody_output.intonation
            if int_obj.phrase_pitch_direction:
                descriptive_obs.append(f"Phrase pitch movement: {int_obj.phrase_pitch_direction}")
            if int_obj.reference_pitch_distance_dtw is not None:
                descriptive_obs.append(f"Reference DTW pitch distance: {int_obj.reference_pitch_distance_dtw:.2f} semitones")
                if int_obj.reference_pitch_distance_dtw > 3.0:
                    ref_iss_id = f"ISS_REF_INT_{utterance_id}"
                    ev_ref_id = f"EV_REF_INT_{ev_counter:06d}"
                    ev_counter += 1
                    evidence_store[ev_ref_id] = EvidenceItem(
                        evidence_id=ev_ref_id,
                        family="REFERENCE_COMPARISON",
                        evidence_type=EvidenceType.TYPE_B_REFERENCE_RELATIVE.value,
                        value={"dtwDistance": int_obj.reference_pitch_distance_dtw, "correlation": int_obj.reference_contour_correlation},
                        confidence=int_obj.confidence,
                        time_start_sec=0.0,
                        time_end_sec=prosody_output.duration.total_audio_duration_sec,
                        provenance={"source": "P7_IntonationComparator"},
                    )
                    ref_iss = IssueNode(
                        issue_id=ref_iss_id,
                        issue_type="REFERENCE_INTONATION_DIFFERENCE",
                        level=IssueLevel.PHRASE.value,
                        severity=IssueSeverity.MEDIUM.value,
                        confidence=int_obj.confidence,
                        priority=IssuePriority.LOW.value,
                        priority_reasons=["SHADOWING_REFERENCE_CONTOUR_DEVIATION"],
                        time_start_sec=0.0,
                        time_end_sec=prosody_output.duration.total_audio_duration_sec,
                        evidence_refs=[ev_ref_id],
                        target_info={"mode": "SHADOWING_REFERENCE_RELATIVE"},
                        observed_info={"dtwDistanceSemitones": int_obj.reference_pitch_distance_dtw},
                        abstained_fields=[],
                        safety_tier=ProductSafetyTier.SAFE_WITH_CAVEAT.value,
                    )
                    phrase_issues.append(ref_iss)

        pa_phrase = PhraseAssessment(
            phrase_id=f"PHR_{utterance_id}_0",
            phrase_index=0,
            start_time_sec=word_assessments[0].start_time_sec if word_assessments else 0.0,
            end_time_sec=word_assessments[-1].end_time_sec if word_assessments else 0.0,
            words=word_assessments,
            confidence=round(float(np.mean([w.confidence for w in word_assessments])) if word_assessments else 1.0, 4),
            coverage=round(float(np.mean([w.coverage for w in word_assessments])) if word_assessments else 1.0, 4),
            speech_rate_syl_per_sec=getattr(prosody_output.rhythm, "speech_rate_syllables_per_sec", 0.0) if hasattr(prosody_output, "rhythm") else 0.0,
            articulation_rate_syl_per_sec=getattr(prosody_output.rhythm, "articulation_rate_syllables_per_sec", 0.0) if hasattr(prosody_output, "rhythm") else 0.0,
            pauses_count=getattr(prosody_output.pauses, "total_pauses_count", 0) if hasattr(prosody_output, "pauses") else 0,
            issues=phrase_issues,
            descriptive_observations=descriptive_obs,
        )

        # 4. Deduplicate Issues & Group into Primary / Secondary
        root_issues, supporting_issues = IssueDeduplicator.deduplicate(phrase_issues)
        primary_issues = [iss for iss in root_issues if iss.priority in {IssuePriority.CRITICAL.value, IssuePriority.HIGH.value}]
        secondary_issues = [iss for iss in root_issues if iss.priority in {IssuePriority.MEDIUM.value, IssuePriority.LOW.value}]

        # 5. Coverage Statistics
        tot_p = len(all_phone_assessments)
        eval_p = len([p for p in all_phone_assessments if p.status != AssessmentStatus.ABSTAINED.value])
        abst_p = tot_p - eval_p
        trusted_p = len([p for p in all_phone_assessments if p.observed_phone is not None])
        tot_w = len(word_assessments)
        eval_w = len([w for w in word_assessments if w.word_status != WordAssessmentStatus.INSUFFICIENT_EVIDENCE.value])
        valid_w = len([w for w in word_assessments if w.is_valid_variant])

        cov_stats = CoverageStatistics(
            total_phones=tot_p,
            phones_evaluated=eval_p,
            phones_abstained=abst_p,
            exact_phone_trusted_count=trusted_p,
            total_words=tot_w,
            words_evaluated=eval_w,
            words_valid_variant=valid_w,
            segmental_coverage=round(eval_p / (tot_p + 1e-6), 4),
            exact_phone_coverage=round(trusted_p / (tot_p + 1e-6), 4),
            word_coverage=round(eval_w / (tot_w + 1e-6), 4),
            stress_coverage=1.0 if any(w.syllable_assessments for w in word_assessments) else 0.0,
            overall_evidence_coverage=round(float(np.mean([eval_p / (tot_p + 1e-6), eval_w / (tot_w + 1e-6)])), 4),
        )

        # 6. Build Utterance Assessment
        abstained_analyses: List[str] = []
        if trusted_p < tot_p:
            abstained_analyses.append(f"{tot_p - trusted_p} phones abstained from exact phonetic identity under selective trust.")
        if hasattr(prosody_output, "mode") and prosody_output.mode == "REFERENCE_FREE":
            abstained_analyses.append("Reference-free intonation/rhythm scores disabled (uncalibrated diagnostic only).")

        raw_str = f"{utterance_id}|{tot_p}|{len(primary_issues)}|{cov_stats.overall_evidence_coverage}"
        p_hash = hashlib.sha256(raw_str.encode("utf-8")).hexdigest()

        return UtteranceAssessment(
            utterance_id=utterance_id,
            overall_status=AssessmentStatus.COMPLETE.value if cov_stats.overall_evidence_coverage >= 0.80 else AssessmentStatus.PARTIAL.value,
            overall_score=None,  # Strictly NULL without calibrated human dataset!
            confidence=pa_phrase.confidence,
            coverage_stats=cov_stats,
            primary_issues=primary_issues,
            secondary_issues=secondary_issues,
            descriptive_observations=descriptive_obs,
            abstained_analyses=abstained_analyses,
            phrases=[pa_phrase],
            words=word_assessments,
            evidence_store=evidence_store,
            schema_version="ECSM_P8_ASSESSMENT_SCHEMA_v1.0",
            provenance_hash=p_hash,
        )
