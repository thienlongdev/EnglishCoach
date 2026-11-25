"""Research-only multi-channel data expansion and alignment reliability utilities for SHD-2B.2C.

This module provides data structures, sampling policies, tie-breaking heuristics,
human review protocols, and diagnostic statistics for the SHD-2B.2C research slice.
All scoring mappings remain strictly research-only; production contracts return NULL.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np

EXPANSION_SCHEMA = "shd-2b.2c-research-v1"
EXPANSION_SEED = 20260831
TIE_MARGIN_EPSILON = 1e-4

# Target thresholds for research statistical powering
TARGET_MIN_INSTANCES = 200
TARGET_MIN_SPEAKERS = 20
TARGET_MIN_ERRORS = 20

# Review taxonomy for human alignment / normalization review
HUMAN_REVIEW_CATEGORIES = (
    "alignment clearly correct",
    "alignment plausible",
    "alignment incorrect",
    "audio unusable",
    "pronunciation variant not represented",
    "uncertain",
)

# Canonical dataset provenance registry for SHD-2B.2C
DATASET_PROVENANCE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "speechocean762": {
        "dataset": "speechocean762",
        "officialSource": "OpenSLR SLR101 / SpeechOcean762",
        "url": "https://www.openslr.org/resources/101/speechocean762.tar.gz",
        "license": "CC BY 4.0",
        "commercialUse": "Permitted",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "speakerCount": 250,
        "approximateHours": 14.5,
        "accentCoverage": "Mandarin-accented English (L2 learners: 125 adult, 125 child)",
        "microphoneChannel": "Smartphone and near-field headset microphones (16kHz WAV)",
        "availableLabels": ["phone_accuracy_0_to_2", "word_accuracy", "stress_score", "fluency_score"],
        "nominalCalibrationSuitability": "Suitable (using perfect score == 2.0 calibration phones)",
        "errorSupervisionSuitability": "Primary supervised benchmark (five-rater expert scores)",
        "channelRobustnessSuitability": "Standard near-field mobile channel",
        "speakerRobustnessSuitability": "High (250 distinct L2 speakers across age groups)",
        "classification": "PRODUCTION_SAFE_RESEARCH",
    },
    "librispeech-dev-clean": {
        "dataset": "librispeech-dev-clean",
        "officialSource": "OpenSLR SLR12 / LibriSpeech dev-clean",
        "url": "https://www.openslr.org/resources/12/dev-clean.tar.gz",
        "license": "CC BY 4.0",
        "commercialUse": "Permitted",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "speakerCount": 40,
        "approximateHours": 5.4,
        "accentCoverage": "US English (Native L1 LibriVox readers)",
        "microphoneChannel": "Clean studio / home studio condenser microphones (16kHz FLAC/WAV)",
        "availableLabels": ["orthographic_transcript", "unsupervised_reference"],
        "nominalCalibrationSuitability": "Core baseline for nominal native calibration",
        "errorSupervisionSuitability": "Unsupervised nominal reference only (no human error labels)",
        "channelRobustnessSuitability": "Clean high-SNR baseline channel",
        "speakerRobustnessSuitability": "Moderate (40 native adult speakers)",
        "classification": "PRODUCTION_SAFE_RESEARCH",
    },
    "librispeech-dev-other": {
        "dataset": "librispeech-dev-other",
        "officialSource": "OpenSLR SLR12 / LibriSpeech dev-other",
        "url": "https://www.openslr.org/resources/12/dev-other.tar.gz",
        "license": "CC BY 4.0",
        "commercialUse": "Permitted",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "speakerCount": 33,
        "approximateHours": 5.3,
        "accentCoverage": "Varied North American & International English readers with regional accents",
        "microphoneChannel": "Heterogeneous consumer microphones, variable room acoustics, ambient noise",
        "availableLabels": ["orthographic_transcript", "unsupervised_reference"],
        "nominalCalibrationSuitability": "High (provides acoustic dispersion and channel diversity)",
        "errorSupervisionSuitability": "Unsupervised reference only",
        "channelRobustnessSuitability": "High (natural channel/reverb/noise diversity)",
        "speakerRobustnessSuitability": "Moderate (33 diverse speakers)",
        "classification": "PRODUCTION_SAFE_RESEARCH",
    },
    "librispeech-test-clean": {
        "dataset": "librispeech-test-clean",
        "officialSource": "OpenSLR SLR12 / LibriSpeech test-clean",
        "url": "https://www.openslr.org/resources/12/test-clean.tar.gz",
        "license": "CC BY 4.0",
        "commercialUse": "Permitted",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "speakerCount": 40,
        "approximateHours": 5.4,
        "accentCoverage": "US English (Native L1 LibriVox readers)",
        "microphoneChannel": "Clean condenser microphones (16kHz FLAC/WAV)",
        "availableLabels": ["orthographic_transcript", "unsupervised_reference"],
        "nominalCalibrationSuitability": "Strictly held out for unsupervised validation",
        "errorSupervisionSuitability": "Unsupervised validation",
        "channelRobustnessSuitability": "Standard clean validation channel",
        "speakerRobustnessSuitability": "Moderate (40 held-out native speakers)",
        "classification": "PRODUCTION_SAFE_RESEARCH",
    },
}

AUDITED_REJECTED_DATASETS: List[Dict[str, Any]] = [
    {
        "dataset": "L2-ARCTIC v5",
        "officialSource": "CNGL / LeVoice L2-ARCTIC Corpus",
        "exactLicense": "CC BY-NC 4.0 (Non-Commercial)",
        "commercialStatus": "Prohibited (NC restriction)",
        "redistributionConstraints": "Non-commercial only",
        "rejectionReason": "CC BY-NC license violates commercial deployment and unrestricted production derivation safety.",
        "classification": "REJECTED_LICENSE_INCOMPATIBLE",
    },
    {
        "dataset": "TIMIT Acoustic-Phonetic Continuous Speech",
        "officialSource": "Linguistic Data Consortium (LDC93S1W)",
        "exactLicense": "LDC Proprietary User Agreement",
        "commercialStatus": "Restricted / Paid License Required",
        "redistributionConstraints": "No redistribution permitted; member-restricted",
        "rejectionReason": "LDC proprietary license prevents open reproduction, redistribution, and autonomous test integration.",
        "classification": "REJECTED_LICENSE_INCOMPATIBLE",
    },
    {
        "dataset": "Mozilla Common Voice (Raw Dump)",
        "officialSource": "Common Voice / Mozilla Foundation",
        "exactLicense": "CC0 1.0 Universal",
        "commercialStatus": "Permitted (Public Domain)",
        "redistributionConstraints": "None",
        "rejectionReason": "Uncurated crowdsourced audio contains unverified phone alignability, variable sampling rates, and missing phonetic alignments.",
        "classification": "REJECTED_UNVERIFIED_LABELS",
    },
    {
        "dataset": "Unverified Third-Party Mirrors / Kaldi Repackagings",
        "officialSource": "Various third-party Hugging Face / GitHub mirrors",
        "exactLicense": "Unverified / Conflicting upstream terms",
        "commercialStatus": "Uncertain",
        "redistributionConstraints": "Uncertain provenance chain",
        "rejectionReason": "Missing authoritative provenance and cryptographic upstream validation.",
        "classification": "REJECTED_UNVERIFIED_PROVENANCE",
    },
]


@dataclass(frozen=True)
class UnderpoweredDeficit:
    phoneme: str
    status: str
    instanceCount: int
    speakerCount: int
    errorCount: int
    correctCount: int
    reason: str
    instanceDeficit: int
    speakerDeficit: int
    errorDeficit: int
    canRecoverFromNominalData: bool
    canRecoverFromSupervisedData: bool

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def audit_dataset_provenance(registry: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Audit all investigated, accepted, and rejected datasets for SHD-2B.2C."""
    reg = registry or DATASET_PROVENANCE_REGISTRY
    accepted = list(reg.values())
    rejected = AUDITED_REJECTED_DATASETS
    return {
        "schemaVersion": EXPANSION_SCHEMA,
        "acceptedCount": len(accepted),
        "rejectedCount": len(rejected),
        "accepted": accepted,
        "rejected": rejected,
        "complianceSummary": "All accepted datasets are explicitly licensed under CC BY 4.0; all non-commercial (NC) or proprietary sources are strictly rejected.",
    }


def multi_channel_audio_features(waveform: Any, sample_rate: int = 16000) -> Dict[str, float]:
    """Compute detailed acoustic and channel properties for diagnostic characterization."""
    if isinstance(waveform, (bytes, bytearray)):
        from app.services.pronunciation.acoustic_engine import decode_audio_bytes_to_16k_mono
        waveform = decode_audio_bytes_to_16k_mono(bytes(waveform))
    if len(waveform) == 0:
        return {
            "durationSeconds": 0.0,
            "rms": 0.0,
            "peak": 0.0,
            "dcOffset": 0.0,
            "silenceProportion": 1.0,
            "snrProxyDb": 0.0,
            "clippingSampleCount": 0,
            "clippingProportion": 0.0,
        }
    float_wave = np.asarray(waveform, dtype=np.float32)
    peak = float(np.max(np.abs(float_wave)))
    dc_offset = float(np.mean(float_wave))
    centered = float_wave - dc_offset
    rms = float(np.sqrt(np.mean(centered ** 2)))
    duration = float(len(float_wave) / sample_rate)

    # Frame-level silence computation (25ms window, 10ms hop)
    frame_len = int(sample_rate * 0.025)
    hop_len = int(sample_rate * 0.010)
    if len(centered) >= frame_len:
        num_frames = 1 + (len(centered) - frame_len) // hop_len
        frame_rms = [
            float(np.sqrt(np.mean(centered[i * hop_len : i * hop_len + frame_len] ** 2)))
            for i in range(num_frames)
        ]
        silence_threshold = max(rms * 0.1, 1e-4)
        silence_frames = sum(1 for f in frame_rms if f < silence_threshold)
        silence_ratio = float(silence_frames / num_frames)
        # SNR proxy: ratio of 90th percentile frame energy to 10th percentile frame energy
        q10 = float(np.percentile(frame_rms, 10))
        q90 = float(np.percentile(frame_rms, 90))
        snr_proxy_db = float(20.0 * math.log10(max(q90, 1e-6) / max(q10, 1e-6)))
    else:
        silence_ratio = 0.0
        snr_proxy_db = 0.0

    # Clipping detection (|amplitude| >= 0.999)
    clipping_samples = int(np.sum(np.abs(float_wave) >= 0.999))
    clipping_ratio = float(clipping_samples / len(float_wave))

    return {
        "durationSeconds": round(duration, 4),
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "dcOffset": round(dc_offset, 6),
        "silenceProportion": round(silence_ratio, 4),
        "snrProxyDb": round(snr_proxy_db, 2),
        "clippingSampleCount": clipping_samples,
        "clippingProportion": round(clipping_ratio, 6),
    }


def compute_underpowered_deficits(per_phone_quality: Dict[str, Any]) -> Dict[str, Any]:
    """Explicitly account for all underpowered and single-class phonemes."""
    records: List[UnderpoweredDeficit] = []
    recovered_to_available: List[str] = []
    still_underpowered: List[str] = []
    single_class_phones: List[str] = []

    for phone, item in sorted(per_phone_quality.items()):
        status = item.get("status", "AVAILABLE")
        inst = item.get("sampleCount", item.get("correctCount", 0) + item.get("errorCount", 0))
        spk = item.get("speakerCount", 0)
        err = item.get("errorCount", 0)
        corr = item.get("correctCount", 0)

        inst_def = max(0, TARGET_MIN_INSTANCES - inst)
        spk_def = max(0, TARGET_MIN_SPEAKERS - spk)
        err_def = max(0, TARGET_MIN_ERRORS - err)

        if status == "SINGLE_CLASS":
            single_class_phones.append(phone)
            reason = "Zero error events observed in held-out test split (100% correct class dominance)."
            can_nom = False
            can_sup = True
        elif status == "UNDERPOWERED":
            still_underpowered.append(phone)
            reasons = []
            if spk < TARGET_MIN_SPEAKERS:
                reasons.append(f"unique speakers ({spk} < {TARGET_MIN_SPEAKERS})")
            if err < TARGET_MIN_ERRORS:
                reasons.append(f"error occurrences ({err} < {TARGET_MIN_ERRORS})")
            if inst < TARGET_MIN_INSTANCES:
                reasons.append(f"total instances ({inst} < {TARGET_MIN_INSTANCES})")
            reason = f"Insufficient research sample power: {', '.join(reasons)}."
            can_nom = inst_def > 0 or spk_def > 0
            can_sup = err_def > 0
        else:
            recovered_to_available.append(phone)
            reason = "Adequately powered for primary metric estimation."
            can_nom = True
            can_sup = True

        records.append(
            UnderpoweredDeficit(
                phoneme=phone,
                status=status,
                instanceCount=inst,
                speakerCount=spk,
                errorCount=err,
                correctCount=corr,
                reason=reason,
                instanceDeficit=inst_def,
                speakerDeficit=spk_def,
                errorDeficit=err_def,
                canRecoverFromNominalData=can_nom,
                canRecoverFromSupervisedData=can_sup,
            )
        )

    return {
        "schemaVersion": EXPANSION_SCHEMA,
        "totalEvaluatedPhones": len(records),
        "availableCount": len(recovered_to_available),
        "underpoweredCount": len(still_underpowered),
        "singleClassCount": len(single_class_phones),
        "underpoweredPhones": still_underpowered,
        "singleClassPhones": single_class_phones,
        "recoveredPhones": recovered_to_available,
        "deficits": [r.to_dict() for r in records],
        "findingsSummary": (
            f"{len(still_underpowered)} phonemes remain UNDERPOWERED and {len(single_class_phones)} SINGLE_CLASS. "
            "Additional native/unsupervised speech expands correct instances and speaker diversity for nominal "
            "distributions, but cannot artificially manufacture human-rated L2 pronunciation error instances."
        ),
    }


def deterministic_trellis_tie_break(
    candidate_variants: Sequence[Dict[str, Any]],
    epsilon: float = TIE_MARGIN_EPSILON,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Deterministic tie-breaking policy for near-tied pronunciation variant branches in CTC trellis.

    Rules:
    1. If the likelihood score margin between Rank 1 and Rank 2 exceeds epsilon, strictly select Rank 1.
    2. If score margin <= epsilon (a near tie):
       - Prioritize standard lexical category over optional casual reductions / weak forms.
       - Secondary priority: shorter canonical phoneme sequence (fewer spurious insertions).
       - Tertiary priority: deterministic lowest original variant index.
    3. Never select a lower-scoring variant when margin > epsilon.
    """
    if not candidate_variants:
        raise ValueError("candidate_variants must not be empty")

    sorted_by_score = sorted(
        candidate_variants,
        key=lambda v: (-float(v.get("pathScore", 0.0)), v.get("variantIndex", 0)),
    )
    top1 = sorted_by_score[0]
    top1_score = float(top1.get("pathScore", 0.0))

    if len(sorted_by_score) == 1:
        margin = float("inf")
        tie_occurred = False
        selected = top1
    else:
        top2 = sorted_by_score[1]
        top2_score = float(top2.get("pathScore", 0.0))
        margin = top1_score - top2_score
        tie_occurred = margin <= epsilon

        if tie_occurred:
            # Gather all candidates within epsilon of top1
            near_tied = [
                v for v in sorted_by_score if (top1_score - float(v.get("pathScore", 0.0))) <= epsilon
            ]

            def tie_priority_key(item: Dict[str, Any]) -> Tuple[int, int, int]:
                cat = str(item.get("category", "")).upper()
                cat_priority = 0 if "STANDARD" in cat else (1 if "WEAK" in cat else 2)
                phone_count = len(item.get("phonemes", []))
                var_idx = int(item.get("variantIndex", 0))
                return (cat_priority, phone_count, var_idx)

            selected = min(near_tied, key=tie_priority_key)
        else:
            selected = top1

    diagnostics = {
        "top1Score": top1_score,
        "margin": margin,
        "isNearTie": tie_occurred,
        "epsilonTolerance": epsilon,
        "selectedVariantIndex": selected.get("variantIndex", 0),
        "tieBreakApplied": tie_occurred and (selected != top1),
        "candidatesEvaluated": len(candidate_variants),
    }
    return selected, diagnostics


def create_human_review_item(
    utterance_id: str,
    speaker_id: str,
    word_index: int,
    word_text: str,
    selected_variant: List[str],
    aligned_phones: List[Dict[str, Any]],
    raw_gop_mean: float,
    alignment_margin: float,
    preprocessing_variant: str,
    audio_path: str,
) -> Dict[str, Any]:
    """Create a structured, blinded human review item for alignment and preprocessing validation."""
    return {
        "schemaVersion": EXPANSION_SCHEMA,
        "utteranceId": utterance_id,
        "speakerId": speaker_id,
        "wordIndex": word_index,
        "wordText": word_text,
        "selectedVariant": selected_variant,
        "alignedPhones": aligned_phones,
        "rawGopMean": round(raw_gop_mean, 4),
        "alignmentMargin": round(alignment_margin, 6),
        "preprocessingVariant": preprocessing_variant,
        "audioPath": audio_path,
        "validReviewCategories": HUMAN_REVIEW_CATEGORIES,
        "reviewStatus": "PENDING",
    }


def compute_inter_rater_agreement(ratings: Sequence[Tuple[str, str]]) -> Dict[str, Any]:
    """Compute Cohen's Kappa for paired blinded human review annotations."""
    if not ratings:
        return {"status": "EMPTY", "cohensKappa": None, "observedAgreement": None}

    cat_set = sorted(list(HUMAN_REVIEW_CATEGORIES))
    cat2idx = {cat: i for i, cat in enumerate(cat_set)}
    k = len(cat_set)
    matrix = np.zeros((k, k), dtype=np.int32)

    for r1, r2 in ratings:
        if r1 in cat2idx and r2 in cat2idx:
            matrix[cat2idx[r1], cat2idx[r2]] += 1

    n = len(ratings)
    if n == 0:
        return {"status": "EMPTY", "cohensKappa": None, "observedAgreement": None}

    po = float(np.trace(matrix)) / n
    row_marginals = matrix.sum(axis=1) / float(n)
    col_marginals = matrix.sum(axis=0) / float(n)
    pe = float(np.sum(row_marginals * col_marginals))

    if pe >= 1.0:
        kappa = 1.0
    else:
        kappa = float((po - pe) / (1.0 - pe))

    return {
        "status": "AVAILABLE",
        "sampleCount": n,
        "observedAgreement": round(po, 4),
        "expectedAgreement": round(pe, 4),
        "cohensKappa": round(kappa, 4),
        "interpretation": "Substantial" if kappa >= 0.6 else ("Moderate" if kappa >= 0.4 else "Fair"),
    }
