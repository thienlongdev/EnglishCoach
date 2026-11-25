"""
CROTTC-IF 2026 MDD Adapter for ECSM Pronunciation Engine V2.
Orchestrates prompt-free acoustic perceived phone sequence inference via mdd-service,
performs multi-variant canonical sequence alignment, and generates schema-valid PhoneEvidenceV2.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Any

from app.services.pronunciation.ecsm.crottc_label_mapping import crottc_label_to_ipa, normalize_crottc_sequence_to_ipa
from app.services.pronunciation.ecsm.mdd_sequence_alignment import (
    PhoneSequenceAligner,
    TargetPhoneItem,
    AlignedPhoneEvidence,
    SequenceAlignmentResult,
    AlignmentOperation,
)
from app.services.pronunciation.ecsm.mdd_client import MddServiceClient

logger = logging.getLogger("ai-service.crottc_adapter")

@dataclass
class CrottcMddResult:
    request_id: str
    attempt_id: Optional[str]
    case_id: Optional[str]
    engine: str
    model_revision: str
    perceived_labels: List[str]
    perceived_ipa: List[str]
    perceived_text: str
    sequence_tokens: List[int]
    alignment_result: SequenceAlignmentResult
    aligned_evidence_by_phone_id: Dict[str, AlignedPhoneEvidence]
    inference_ms: float
    vram_allocated_mb: float
    calibration_status: str = "UNCALIBRATED"
    confidence_semantics: str = "RAW_SEQUENCE_DECODED"
    warnings: List[str] = field(default_factory=list)

class CrottcMddAdapter:
    def __init__(self, mdd_client: Optional[MddServiceClient] = None):
        self.mdd_client = mdd_client or MddServiceClient()
        self.aligner = PhoneSequenceAligner(insertion_cost=1.0, deletion_cost=1.0)

    def analyze(
        self,
        audio_bytes: bytes,
        filename: str,
        target_words: List[Any],
        target_phones: List[Any],
        expected_text: Optional[str] = None,
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> CrottcMddResult:
        """
        Executes prompt-free acoustic inference on mdd-service, then aligns perceived phones
        against the target phone sequence using multi-variant Levenshtein alignment.
        """
        # 1. Call mdd-service
        raw_mdd = self.mdd_client.analyze_audio(
            audio_bytes=audio_bytes,
            filename=filename,
            expected_text=expected_text,
            attempt_id=attempt_id,
            case_id=case_id,
            request_id=request_id,
        )

        perceived_labels = raw_mdd.get("perceived_labels") or []
        perceived_ipa = raw_mdd.get("perceived_ipa") or []
        perceived_text = raw_mdd.get("perceived_text") or " ".join(perceived_labels)
        sequence_tokens = raw_mdd.get("sequence_tokens") or []
        model_revision = raw_mdd.get("model_revision") or "9149e5107b3332b9aa3f5573f6328a4e312006ad"
        inf_ms = raw_mdd.get("inference_ms") or 0.0
        vram_mb = raw_mdd.get("vram_allocated_mb") or 0.0

        # 2. Build canonical target items
        canonical_items: List[TargetPhoneItem] = []
        for p in target_phones:
            p_id = getattr(p, "phone_id", "") or p.get("phone_id", "")
            w_id = getattr(p, "word_id", "") or p.get("word_id", "")
            w_idx = getattr(p, "word_index", 0) if hasattr(p, "word_index") else p.get("word_index", 0)
            t_word = getattr(p, "target_word", "") if hasattr(p, "target_word") else p.get("target_word", "")
            p_idx = getattr(p, "phone_index_within_word", 0) if hasattr(p, "phone_index_within_word") else p.get("phone_index_within_word", 0)
            exp_p = getattr(p, "expected_phone", "") or p.get("expected_phone", "") or p.get("phone", "")
            
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

        # 4. Map aligned evidence by phone_id
        evidence_by_phone_id: Dict[str, AlignedPhoneEvidence] = {}
        for ev in alignment_res.aligned_evidence:
            if not ev.is_insertion and ev.phone_id:
                evidence_by_phone_id[ev.phone_id] = ev

        return CrottcMddResult(
            request_id=request_id or raw_mdd.get("request_id", ""),
            attempt_id=attempt_id,
            case_id=case_id,
            engine="CROTTC_IF",
            model_revision=model_revision,
            perceived_labels=perceived_labels,
            perceived_ipa=perceived_ipa,
            perceived_text=perceived_text,
            sequence_tokens=sequence_tokens,
            alignment_result=alignment_res,
            aligned_evidence_by_phone_id=evidence_by_phone_id,
            inference_ms=inf_ms,
            vram_allocated_mb=vram_mb,
            calibration_status="UNCALIBRATED",
            confidence_semantics="RAW_SEQUENCE_DECODED",
            warnings=[],
        )
