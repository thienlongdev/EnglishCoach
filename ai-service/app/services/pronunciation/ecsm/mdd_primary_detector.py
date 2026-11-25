"""
MDD-LLM Primary Detector for ECSM Pronunciation Engine.
Owns error detection and word/phone localization using Haopeng/MDD-LLM-Llama3.2-1B-L2-ARCTIC.
Enforces hard invariant: MDD-LLM alone decides whether an error is present.
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

logger = logging.getLogger("ai-service.mdd_primary_detector")

@dataclass
class MddDetectionResult:
    request_id: str
    attempt_id: Optional[str]
    case_id: Optional[str]
    engine: str
    model_revision: str
    checkpoint_sha256: str
    device: str
    audio_sha256: str
    audio_duration_sec: float
    perceived_labels: List[str]
    perceived_ipa: List[str]
    perceived_text: str
    generated_tokens: List[Any]
    is_clean: bool
    detected_phone_ids: Set[str]
    localized_words: List[str]
    alignment_result: SequenceAlignmentResult
    aligned_evidence_by_phone_id: Dict[str, AlignedPhoneEvidence]
    mdd_candidate_by_phone_id: Dict[str, Optional[str]]
    inference_ms: float
    vram_allocated_mb: float
    warnings: List[str] = field(default_factory=list)


class MddPrimaryDetector:
    """
    Primary detector running MDD-LLM (Llama 3.2 1B + WavLM Large) for phoneme error
    detection and word/phone localization.
    """
    def __init__(self, mdd_client: Optional[MddServiceClient] = None):
        self.mdd_client = mdd_client or MddServiceClient()
        self.aligner = PhoneSequenceAligner(insertion_cost=1.0, deletion_cost=1.0)

    def detect(
        self,
        audio_bytes: bytes,
        filename: str,
        target_words: List[Any],
        target_phones: List[Any],
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> MddDetectionResult:
        # 1. Call MDD-LLM detect endpoint
        raw_mdd = self.mdd_client.detect_audio(
            audio_bytes=audio_bytes,
            filename=filename,
            attempt_id=attempt_id,
            case_id=case_id,
            request_id=request_id,
        )

        perceived_labels = raw_mdd.get("perceived_labels") or []
        perceived_ipa = raw_mdd.get("perceived_ipa") or []
        perceived_text = raw_mdd.get("perceived_text") or " ".join(perceived_labels)
        generated_tokens = raw_mdd.get("generated_tokens") or []
        model_revision = raw_mdd.get("model_revision") or "Haopeng/MDD-LLM-Llama3.2-1B-L2-ARCTIC"
        checkpoint_sha256 = raw_mdd.get("checkpoint_sha256") or "dfb2ed5be483bef0207dd41542a6ca0256be2dcadf534ccde1c3772f0859ce11"
        device = raw_mdd.get("device") or "cuda:0"
        audio_sha = raw_mdd.get("audio_sha256") or ""
        duration_sec = raw_mdd.get("audio_duration_sec") or 0.0
        inf_ms = raw_mdd.get("inference_ms") or 0.0
        vram_mb = raw_mdd.get("vram_allocated_mb") or 0.0

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

        # 4. Map aligned evidence by phone_id and detect errors
        evidence_by_phone_id: Dict[str, AlignedPhoneEvidence] = {}
        mdd_candidate_by_phone_id: Dict[str, Optional[str]] = {}
        detected_phone_ids: Set[str] = set()
        localized_words_set: Set[str] = set()

        for ev in alignment_res.aligned_evidence:
            if not ev.is_insertion and ev.phone_id:
                evidence_by_phone_id[ev.phone_id] = ev
                if ev.operation == AlignmentOperation.SUBSTITUTION:
                    detected_phone_ids.add(ev.phone_id)
                    mdd_candidate_by_phone_id[ev.phone_id] = ev.perceived_phone
                    if ev.target_word:
                        localized_words_set.add(ev.target_word)
                elif ev.operation == AlignmentOperation.DELETION:
                    detected_phone_ids.add(ev.phone_id)
                    mdd_candidate_by_phone_id[ev.phone_id] = None
                    if ev.target_word:
                        localized_words_set.add(ev.target_word)
                else:
                    mdd_candidate_by_phone_id[ev.phone_id] = None

        is_clean = len(detected_phone_ids) == 0

        return MddDetectionResult(
            request_id=request_id or raw_mdd.get("request_id", ""),
            attempt_id=attempt_id,
            case_id=case_id,
            engine="MDD_LLM",
            model_revision=model_revision,
            checkpoint_sha256=checkpoint_sha256,
            device=device,
            audio_sha256=audio_sha,
            audio_duration_sec=duration_sec,
            perceived_labels=perceived_labels,
            perceived_ipa=perceived_ipa,
            perceived_text=perceived_text,
            generated_tokens=generated_tokens,
            is_clean=is_clean,
            detected_phone_ids=detected_phone_ids,
            localized_words=sorted(list(localized_words_set)),
            alignment_result=alignment_res,
            aligned_evidence_by_phone_id=evidence_by_phone_id,
            mdd_candidate_by_phone_id=mdd_candidate_by_phone_id,
            inference_ms=inf_ms,
            vram_allocated_mb=vram_mb,
            warnings=[],
        )
