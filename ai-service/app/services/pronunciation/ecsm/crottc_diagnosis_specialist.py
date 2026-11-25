"""
CROTTC-IF Diagnosis Specialist for ECSM Pronunciation Engine.
Reassigned from Primary Detector to Diagnosis Specialist ONLY.
Invoked only for MDD-confirmed phoneme error candidates.
Answers: "What phone did this sound like?"
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Set, Tuple, Optional, Any

from app.services.pronunciation.ecsm.mdd_sequence_alignment import (
    PhoneSequenceAligner,
    TargetPhoneItem,
    AlignedPhoneEvidence,
    SequenceAlignmentResult,
    AlignmentOperation,
)
from app.services.pronunciation.ecsm.mdd_client import MddServiceClient

logger = logging.getLogger("ai-service.crottc_diagnosis_specialist")

@dataclass
class CrottcDiagnosisResult:
    request_id: str
    attempt_id: Optional[str]
    case_id: Optional[str]
    engine: str
    model_revision: str
    checkpoint_sha256: str
    device: str
    audio_sha256: str
    crottc_called: bool
    perceived_labels: List[str]
    perceived_ipa: List[str]
    perceived_text: str
    alignment_result: Optional[SequenceAlignmentResult]
    aligned_evidence_by_phone_id: Dict[str, AlignedPhoneEvidence]
    crottc_candidate_by_phone_id: Dict[str, Optional[str]]
    crottc_evidence_score_by_phone_id: Dict[str, float]
    inference_ms: float
    vram_allocated_mb: float
    warnings: List[str] = field(default_factory=list)


class CrottcDiagnosisSpecialist:
    """
    Diagnosis specialist running CROTTC-IF (WavLM-Large + Prompt-Free CTC) to resolve
    phonetic substitute candidates for MDD-confirmed mispronunciations.
    """
    def __init__(self, mdd_client: Optional[MddServiceClient] = None):
        self.mdd_client = mdd_client or MddServiceClient()
        self.aligner = PhoneSequenceAligner(insertion_cost=1.0, deletion_cost=1.0)

    def diagnose(
        self,
        audio_bytes: bytes,
        filename: str,
        target_words: List[Any],
        target_phones: List[Any],
        mdd_detected_phone_ids: Set[str],
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> CrottcDiagnosisResult:
        # If MDD found zero errors, CROTTC is NOT called (Bypass rule)
        if not mdd_detected_phone_ids:
            logger.info("MDD-LLM classified clean; CROTTC diagnosis specialist bypassed.")
            return CrottcDiagnosisResult(
                request_id=request_id or "",
                attempt_id=attempt_id,
                case_id=case_id,
                engine="CROTTC_IF",
                model_revision="9149e5107b3332b9aa3f5573f6328a4e312006ad",
                checkpoint_sha256="3a9a4a03d2af6c90f71db8972a51dd4ce4559d1e9801f078904a65ce4aa113ef",
                device="cuda:0",
                audio_sha256="",
                crottc_called=False,
                perceived_labels=[],
                perceived_ipa=[],
                perceived_text="",
                alignment_result=None,
                aligned_evidence_by_phone_id={},
                crottc_candidate_by_phone_id={},
                crottc_evidence_score_by_phone_id={},
                inference_ms=0.0,
                vram_allocated_mb=0.0,
                warnings=[],
            )

        # 1. Call CROTTC diagnose endpoint on SAME audio bytes
        raw_crottc = self.mdd_client.diagnose_audio(
            audio_bytes=audio_bytes,
            filename=filename,
            attempt_id=attempt_id,
            case_id=case_id,
            request_id=request_id,
        )

        perceived_labels = raw_crottc.get("perceived_labels") or []
        perceived_ipa = raw_crottc.get("perceived_ipa") or []
        perceived_text = raw_crottc.get("perceived_text") or " ".join(perceived_labels)
        model_revision = raw_crottc.get("model_revision") or "9149e5107b3332b9aa3f5573f6328a4e312006ad"
        checkpoint_sha256 = raw_crottc.get("checkpoint_sha256") or "3a9a4a03d2af6c90f71db8972a51dd4ce4559d1e9801f078904a65ce4aa113ef"
        device = raw_crottc.get("device") or "cuda:0"
        audio_sha = raw_crottc.get("audio_sha256") or ""
        inf_ms = raw_crottc.get("inference_ms") or 0.0
        vram_mb = raw_crottc.get("vram_allocated_mb") or 0.0

        # 2. Build canonical target items
        canonical_items: List[TargetPhoneItem] = []
        for p in target_phones:
            p_id = getattr(p, "phone_id", "") if hasattr(p, "phone_id") else p.get("phone_id", "")
            w_id = getattr(p, "word_id", "") if hasattr(p, "word_id") else p.get("word_id", "")
            w_idx = getattr(p, "word_index", 0) if hasattr(p, "word_index") else p.get("word_index", 0)
            t_word = getattr(p, "target_word", "") if hasattr(p, "target_word") else p.get("target_word", "")
            p_idx = getattr(p, "phone_index_within_word", 0) if hasattr(p, "phone_index_within_word") else p.get("phone_index_within_word", 0)
            exp_p = getattr(p, "expected_phone", "") if hasattr(p, "expected_phone") else (p.get("expected_phone", "") or p.get("phone", ""))

            canonical_items.append(TargetPhoneItem(
                word_id=w_id,
                word_index=w_idx,
                target_word=t_word,
                phone_id=p_id,
                phone_index_within_word=p_idx,
                expected_phone=exp_p,
            ))

        # 3. Align sequence
        candidate_variants = [("VAR_DEFAULT", canonical_items)]
        alignment_res = self.aligner.align_multi_variant(candidate_variants, perceived_ipa)

        # 4. Map evidence
        evidence_by_phone_id: Dict[str, AlignedPhoneEvidence] = {}
        crottc_candidate_by_phone_id: Dict[str, Optional[str]] = {}
        crottc_evidence_score_by_phone_id: Dict[str, float] = {}

        for ev in alignment_res.aligned_evidence:
            if not ev.is_insertion and ev.phone_id:
                evidence_by_phone_id[ev.phone_id] = ev
                if ev.operation == AlignmentOperation.SUBSTITUTION:
                    crottc_candidate_by_phone_id[ev.phone_id] = ev.perceived_phone
                    crottc_evidence_score_by_phone_id[ev.phone_id] = 0.90 # Standard high acoustic evidence for substitution
                elif ev.operation == AlignmentOperation.MATCH:
                    crottc_candidate_by_phone_id[ev.phone_id] = ev.expected_phone
                    crottc_evidence_score_by_phone_id[ev.phone_id] = 0.50 # Match indication (diverges from MDD error)
                else:
                    crottc_candidate_by_phone_id[ev.phone_id] = None
                    crottc_evidence_score_by_phone_id[ev.phone_id] = 0.0

        return CrottcDiagnosisResult(
            request_id=request_id or raw_crottc.get("request_id", ""),
            attempt_id=attempt_id,
            case_id=case_id,
            engine="CROTTC_IF",
            model_revision=model_revision,
            checkpoint_sha256=checkpoint_sha256,
            device=device,
            audio_sha256=audio_sha,
            crottc_called=True,
            perceived_labels=perceived_labels,
            perceived_ipa=perceived_ipa,
            perceived_text=perceived_text,
            alignment_result=alignment_res,
            aligned_evidence_by_phone_id=evidence_by_phone_id,
            crottc_candidate_by_phone_id=crottc_candidate_by_phone_id,
            crottc_evidence_score_by_phone_id=crottc_evidence_score_by_phone_id,
            inference_ms=inf_ms,
            vram_allocated_mb=vram_mb,
            warnings=[],
        )
