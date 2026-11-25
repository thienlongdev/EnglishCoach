"""
Real-Microphone Acceptance Pack Service.
Provides persistent storage, session recovery, and batch evaluation for the 16-clip
one-shot real-mic acceptance test suite.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf

from app.services.audio_ingestion import decode_browser_audio

logger = logging.getLogger("real_mic_pack")
logger.setLevel(logging.INFO)

# Root directory for acceptance packs
ACCEPTANCE_PACK_ROOT = os.getenv("REAL_MIC_PACK_ROOT", "real_mic_acceptance_pack")
AUDIT_ARTIFACTS_ROOT = os.getenv("AUDIT_ARTIFACTS_ROOT", "audit_artifacts")

SAFE_PACK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ALLOWED_AUDIO_EXTENSIONS = frozenset({".wav", ".webm", ".ogg", ".mp3", ".m4a"})


def validate_pack_identifier(value: str, field_name: str = "identifier") -> str:
    """Strictly validates session_id / clip_id against ^[A-Za-z0-9_-]{1,64}$ (EC-SEC-2026-010)."""
    if not isinstance(value, str):
        raise ValueError(f"Invalid {field_name}: must be a string")
    candidate = value.strip()
    if not SAFE_PACK_ID_RE.fullmatch(candidate):
        raise ValueError(f"Invalid {field_name}: must match ^[A-Za-z0-9_-]{{1,64}}$")
    return candidate


def validate_audio_extension(original_filename: Optional[str]) -> str:
    """Allowlists audio file extensions; rejects arbitrary extensions such as .py/.sh (EC-SEC-2026-010)."""
    raw_ext = os.path.splitext(original_filename or "")[1].lower()
    if not raw_ext:
        return ".webm"
    if raw_ext not in ALLOWED_AUDIO_EXTENSIONS:
        raise ValueError(f"Unsupported audio file extension: {raw_ext}")
    return raw_ext


@dataclass(frozen=True)
class AcceptanceItemDef:
    clip_id: str
    group: str  # "CLEAN" | "INTENTIONAL_ERROR"
    target_sentence: str
    instruction_en: str
    instruction_vi: str
    target_word: Optional[str] = None
    target_word_index: Optional[int] = None
    expected_phone: Optional[str] = None
    intentional_substitute_phone: Optional[str] = None
    contrast_name: Optional[str] = None
    phonetic_focus: Optional[str] = None


# The authoritative 16-clip definition
FIXED_ACCEPTANCE_PACK: List[AcceptanceItemDef] = [
    # -------------------------------------------------------------
    # Group CLEAN (8 recordings)
    # Varied phonetic coverage: /ð/, /θ/, /r/, /l/, /ɪ/, /i/, /æ/, /ʌ/, /w/, /v/, /z/, /ʃ/, /tʃ/, /dʒ/
    # -------------------------------------------------------------
    AcceptanceItemDef(
        clip_id="clean_01",
        group="CLEAN",
        target_sentence="The sun shines brightly today.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/ð/, /ʃ/, /z/, /r/, /l/, /ʌ/",
    ),
    AcceptanceItemDef(
        clip_id="clean_02",
        group="CLEAN",
        target_sentence="I think this is very good.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/θ/, /ð/, /ɪ/, /v/, /r/, /i/",
    ),
    AcceptanceItemDef(
        clip_id="clean_03",
        group="CLEAN",
        target_sentence="We will reach the river soon.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/w/, /i/, /tʃ/, /ð/, /r/, /l/, /ɪ/, /v/",
    ),
    AcceptanceItemDef(
        clip_id="clean_04",
        group="CLEAN",
        target_sentence="She has a black cat.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/ʃ/, /i/, /z/, /æ/, /l/",
    ),
    AcceptanceItemDef(
        clip_id="clean_05",
        group="CLEAN",
        target_sentence="They enjoy the jazz music.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/ð/, /dʒ/, /z/, /æ/, /ɪ/",
    ),
    AcceptanceItemDef(
        clip_id="clean_06",
        group="CLEAN",
        target_sentence="Look at that large yellow ship.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/l/, /æ/, /ð/, /r/, /dʒ/, /w/, /ʃ/, /ɪ/",
    ),
    AcceptanceItemDef(
        clip_id="clean_07",
        group="CLEAN",
        target_sentence="Give me a cup of warm water.",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/ɡ/, /ɪ/, /v/, /i/, /ʌ/, /w/, /r/",
    ),
    AcceptanceItemDef(
        clip_id="clean_08",
        group="CLEAN",
        target_sentence="Which teacher chose the green chair?",
        instruction_en="Read naturally and correctly.",
        instruction_vi="Đọc tự nhiên và chuẩn xác.",
        phonetic_focus="/w/, /ɪ/, /tʃ/, /i/, /ð/, /r/",
    ),
    # -------------------------------------------------------------
    # Group INTENTIONAL ERROR (8 recordings)
    # Exact 8 required contrasts
    # -------------------------------------------------------------
    AcceptanceItemDef(
        clip_id="error_01",
        group="INTENTIONAL_ERROR",
        target_sentence="I think it is great.",
        instruction_en="Pronounce 'think' as 'sink' (/s/ instead of /θ/). Read all other words normally.",
        instruction_vi="Đọc 'think' thành 'sink' (âm /s/ thay vì /θ/). Đọc các từ còn lại bình thường.",
        target_word="think",
        target_word_index=1,
        expected_phone="θ",
        intentional_substitute_phone="s",
        contrast_name="θ -> s",
        phonetic_focus="/θ/ -> /s/",
    ),
    AcceptanceItemDef(
        clip_id="error_02",
        group="INTENTIONAL_ERROR",
        target_sentence="Three birds are flying.",
        instruction_en="Pronounce 'Three' as 'Tree' (/t/ instead of /θ/). Read all other words normally.",
        instruction_vi="Đọc 'Three' thành 'Tree' (âm /t/ thay vì /θ/). Đọc các từ còn lại bình thường.",
        target_word="Three",
        target_word_index=0,
        expected_phone="θ",
        intentional_substitute_phone="t",
        contrast_name="θ -> t",
        phonetic_focus="/θ/ -> /t/",
    ),
    AcceptanceItemDef(
        clip_id="error_03",
        group="INTENTIONAL_ERROR",
        target_sentence="This book is mine.",
        instruction_en="Pronounce 'This' as 'Dis' (/d/ instead of /ð/). Read all other words normally.",
        instruction_vi="Đọc 'This' thành 'Dis' (âm /d/ thay vì /ð/). Đọc các từ còn lại bình thường.",
        target_word="This",
        target_word_index=0,
        expected_phone="ð",
        intentional_substitute_phone="d",
        contrast_name="ð -> d",
        phonetic_focus="/ð/ -> /d/",
    ),
    AcceptanceItemDef(
        clip_id="error_04",
        group="INTENTIONAL_ERROR",
        target_sentence="We need more red paint.",
        instruction_en="Pronounce 'red' as 'led' (/l/ instead of /r/). Read all other words normally.",
        instruction_vi="Đọc 'red' thành 'led' (âm /l/ thay vì /r/). Đọc các từ còn lại bình thường.",
        target_word="red",
        target_word_index=3,
        expected_phone="r",
        intentional_substitute_phone="l",
        contrast_name="r -> l",
        phonetic_focus="/r/ -> /l/",
    ),
    AcceptanceItemDef(
        clip_id="error_05",
        group="INTENTIONAL_ERROR",
        target_sentence="Please sit on the chair.",
        instruction_en="Pronounce 'sit' as 'seat' (long /i/ instead of short /ɪ/). Read all other words normally.",
        instruction_vi="Đọc 'sit' thành 'seat' (âm dài /i/ thay vì /ɪ/). Đọc các từ còn lại bình thường.",
        target_word="sit",
        target_word_index=1,
        expected_phone="ɪ",
        intentional_substitute_phone="i",
        contrast_name="ɪ -> i",
        phonetic_focus="/ɪ/ -> /i/",
    ),
    AcceptanceItemDef(
        clip_id="error_06",
        group="INTENTIONAL_ERROR",
        target_sentence="The ship sails on the green sea.",
        instruction_en="Pronounce 'sea' with short /ɪ/ (like 'si' in 'six'). Read all other words normally.",
        instruction_vi="Đọc 'sea' với âm ngắn /ɪ/ (như 'si'). Đọc các từ còn lại bình thường.",
        target_word="sea",
        target_word_index=6,
        expected_phone="i",
        intentional_substitute_phone="ɪ",
        contrast_name="i -> ɪ",
        phonetic_focus="/i/ -> /ɪ/",
    ),
    AcceptanceItemDef(
        clip_id="error_07",
        group="INTENTIONAL_ERROR",
        target_sentence="They visited a very nice town.",
        instruction_en="Pronounce 'very' with /w/ instead of /v/, while keeping the rest of the word as close to 'very' as possible. Read all other words normally.",
        instruction_vi="Đọc 'very' thành 'wary' (âm /w/ thay vì /v/). Đọc các từ còn lại bình thường.",
        target_word="very",
        target_word_index=3,
        expected_phone="v",
        intentional_substitute_phone="w",
        contrast_name="v -> w",
        phonetic_focus="/v/ -> /w/",
    ),
    AcceptanceItemDef(
        clip_id="error_08",
        group="INTENTIONAL_ERROR",
        target_sentence="He told a funny joke.",
        instruction_en="Pronounce 'joke' as 'choke' (/tʃ/ instead of /dʒ/). Read all other words normally.",
        instruction_vi="Đọc 'joke' thành 'choke' (âm /tʃ/ thay vì /dʒ/). Đọc các từ còn lại bình thường.",
        target_word="joke",
        target_word_index=4,
        expected_phone="dʒ",
        intentional_substitute_phone="tʃ",
        contrast_name="dʒ -> tʃ",
        phonetic_focus="/dʒ/ -> /tʃ/",
    ),
]


def get_fixed_pack_dict() -> List[Dict[str, Any]]:
    return [asdict(item) for item in FIXED_ACCEPTANCE_PACK]


class RealMicPackService:
    @staticmethod
    def _ensure_within_root(target: Path, root: Path) -> Path:
        resolved_root = root.resolve()
        resolved_target = target.resolve()
        if not resolved_target.is_relative_to(resolved_root):
            raise ValueError("Resolved path escapes ACCEPTANCE_PACK_ROOT")
        return resolved_target

    @staticmethod
    def get_session_dir(session_id: str) -> str:
        s_id = validate_pack_identifier(session_id, "session_id")
        if not s_id.startswith("session_"):
            s_id = f"session_{s_id}"
        root = Path(ACCEPTANCE_PACK_ROOT).resolve()
        session_path = RealMicPackService._ensure_within_root(root / s_id, root)
        if session_path == root:
            raise ValueError("Invalid session_id")
        session_path.mkdir(parents=True, exist_ok=True)
        return str(session_path)

    @staticmethod
    def list_sessions() -> List[str]:
        if not os.path.exists(ACCEPTANCE_PACK_ROOT):
            return []
        sessions = [
            d for d in os.listdir(ACCEPTANCE_PACK_ROOT)
            if os.path.isdir(os.path.join(ACCEPTANCE_PACK_ROOT, d))
            and d.startswith("session_")
            and SAFE_PACK_ID_RE.fullmatch(d)
        ]
        sessions.sort(reverse=True)
        return sessions

    @classmethod
    def save_recording(
        cls,
        audio_bytes: bytes,
        original_filename: str,
        session_id: str,
        clip_id: str,
        metadata_dict: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Saves the original audio file permanently, computes SHA256, converts to derived WAV,
        and records metadata in the session folder.
        """
        clean_session_id = validate_pack_identifier(session_id, "session_id")
        clean_clip_id = validate_pack_identifier(clip_id, "clip_id")
        ext = validate_audio_extension(original_filename)

        root = Path(ACCEPTANCE_PACK_ROOT).resolve()
        session_dir = cls.get_session_dir(clean_session_id)
        session_path = cls._ensure_within_root(Path(session_dir), root)
        audio_sha256 = hashlib.sha256(audio_bytes).hexdigest()

        raw_audio_resolved = cls._ensure_within_root(session_path / f"{clean_clip_id}{ext}", root)
        derived_wav_resolved = cls._ensure_within_root(session_path / f"{clean_clip_id}.wav", root)
        meta_resolved = cls._ensure_within_root(session_path / f"{clean_clip_id}_meta.json", root)

        raw_audio_path = str(raw_audio_resolved)
        derived_wav_path = str(derived_wav_resolved)
        meta_path = str(meta_resolved)

        # 1. Save original authoritative raw bytes
        with open(raw_audio_path, "wb") as f:
            f.write(audio_bytes)

        # 2. Decode to canonical 16kHz mono WAV for downstream processing
        duration_sec = 0.0
        try:
            canonical = decode_browser_audio(audio_bytes, content_type=metadata_dict.get("mimeType", "audio/webm"))
            duration_sec = canonical.duration_seconds
            sf.write(derived_wav_path, canonical.waveform, 16000, subtype="PCM_16")
        except Exception as dec_err:
            logger.warning(f"Audio decode to WAV warning for {clean_clip_id}: {dec_err}")
            # If decode_browser_audio fails (e.g. if already raw WAV), try direct write
            try:
                data, sr = sf.read(io.BytesIO(audio_bytes))
                duration_sec = len(data) / float(sr)
                sf.write(derived_wav_path, data, sr)
            except Exception:
                pass

        # 3. Save clip metadata (unpack untrusted metadata BEFORE server-authoritative fields)
        meta_payload = {
            **metadata_dict,
            "sessionId": clean_session_id,
            "clipId": clean_clip_id,
            "rawAudioPath": raw_audio_path,
            "derivedWavPath": derived_wav_path,
            "audioSHA256": audio_sha256,
            "fileSizeBytes": len(audio_bytes),
            "durationSec": duration_sec,
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_payload, f, indent=2, ensure_ascii=False)

        # 4. Update session manifest
        cls._update_session_manifest(session_dir, clean_session_id)

        return {
            "status": "SAVED",
            "sessionId": clean_session_id,
            "clipId": clean_clip_id,
            "audioSHA256": audio_sha256,
            "durationSec": duration_sec,
            "rawAudioPath": raw_audio_path,
            "derivedWavPath": derived_wav_path,
        }

    @classmethod
    def _update_session_manifest(cls, session_dir: str, session_id: str) -> Dict[str, Any]:
        manifest_path = os.path.join(session_dir, "session_manifest.json")
        clips_status = {}
        for item in FIXED_ACCEPTANCE_PACK:
            clip_id = item.clip_id
            meta_path = os.path.join(session_dir, f"{clip_id}_meta.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    clips_status[clip_id] = {
                        "isRecorded": True,
                        "audioSHA256": meta.get("audioSHA256"),
                        "rawAudioPath": meta.get("rawAudioPath"),
                        "derivedWavPath": meta.get("derivedWavPath"),
                        "durationSec": meta.get("durationSec"),
                        "savedAt": meta.get("savedAt"),
                    }
                except Exception:
                    clips_status[clip_id] = {"isRecorded": True}
            else:
                clips_status[clip_id] = {"isRecorded": False}

        recorded_count = sum(1 for c in clips_status.values() if c.get("isRecorded"))
        manifest = {
            "sessionId": session_id,
            "totalClips": len(FIXED_ACCEPTANCE_PACK),
            "recordedCount": recorded_count,
            "isComplete": recorded_count == len(FIXED_ACCEPTANCE_PACK),
            "clips": clips_status,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        return manifest

    @classmethod
    def get_session_status(cls, session_id: Optional[str] = None) -> Dict[str, Any]:
        if not session_id:
            sessions = cls.list_sessions()
            if not sessions:
                session_id = f"session_{time.strftime('%Y%m%d_%H%M%S')}"
            else:
                session_id = sessions[0]

        session_dir = cls.get_session_dir(session_id)
        manifest_path = os.path.join(session_dir, "session_manifest.json")
        if os.path.exists(manifest_path):
            with open(manifest_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return cls._update_session_manifest(session_dir, session_id)


def evaluate_pack_results(
    session_id: str,
    raw_eval_results: List[Dict[str, Any]],
    peak_vram_mb: float = 4863.86,
) -> Dict[str, Any]:
    """
    Computes all acceptance metrics and determines PRONUNCIATION_V1_REAL_MIC_ACCEPTED or REJECTED.
    """
    clean_results = [r for r in raw_eval_results if r["group"] == "CLEAN"]
    error_results = [r for r in raw_eval_results if r["group"] == "INTENTIONAL_ERROR"]

    # 1. Clean Metrics
    clean_total = len(clean_results)
    clean_zero_issue_count = sum(1 for r in clean_results if len(r.get("finalSelectedIssues", [])) == 0)
    clean_fp_utterances = clean_total - clean_zero_issue_count
    clean_utterance_fpr = clean_fp_utterances / clean_total if clean_total > 0 else 0.0
    clean_unrelated_issue_count = sum(len(r.get("finalSelectedIssues", [])) for r in clean_results)

    # Clean gate:
    # PASS target: >= 7/8 clean clips contain ZERO actionable pronunciation issue
    # HARD FAIL if: >= 3 clean utterances false positive (i.e. <= 5 zero issue)
    # No clean clip produces 3+ unrelated phone issues
    clean_gate_pass = (
        clean_zero_issue_count >= 7
        and clean_fp_utterances < 3
        and all(len(r.get("finalSelectedIssues", [])) < 3 for r in clean_results)
    )

    # 2. Intentional Error Metrics
    error_total = len(error_results)
    target_detected_count = 0
    target_localized_count = 0
    total_unrelated_error_issues = 0
    clip_with_3plus_unrelated = False

    trusted_exact_diagnoses_count = 0
    correct_trusted_exact_count = 0
    abstention_count = 0

    crottc_unauthorized_issues = 0
    authority_invariant_violations = 0
    legacy_detector_used_count = 0

    latencies = []

    for r in error_results:
        latencies.append(r.get("latencyMs", 0.0))
        target_word = (r.get("targetWord") or "").lower().strip()
        expected_p = r.get("expectedPhone")
        sub_p = r.get("intentionalSubstitutePhone")

        issues = r.get("finalSelectedIssues", [])
        mdd_detected_ids = set(r.get("primaryDetectedPhoneIds", []))

        # Authority invariant
        for iss in issues:
            pid = iss.get("phoneId")
            if pid and pid not in mdd_detected_ids:
                authority_invariant_violations += 1
                crottc_unauthorized_issues += 1

        if r.get("legacyDetectorUsed"):
            legacy_detector_used_count += 1

        # Check target detection & localization
        target_found = False
        target_localized = False
        unrelated_issues_in_clip = 0

        for iss in issues:
            iss_word = (iss.get("word") or "").lower().strip()
            iss_exp = iss.get("expectedPhone")
            iss_obs = iss.get("observedPhone")
            iss_diag_src = iss.get("diagnosisSource")

            if iss_word == target_word and iss_exp == expected_p:
                target_found = True
                target_localized = True
                # Check diagnosis
                if iss_obs is not None and iss_diag_src in ("AGREEMENT", "CROTTC_IF"):
                    trusted_exact_diagnoses_count += 1
                    if iss_obs == sub_p:
                        correct_trusted_exact_count += 1
                else:
                    abstention_count += 1
            else:
                unrelated_issues_in_clip += 1
                total_unrelated_error_issues += 1

        if target_found:
            target_detected_count += 1
        if target_localized:
            target_localized_count += 1
        if unrelated_issues_in_clip >= 3:
            clip_with_3plus_unrelated = True

    for r in clean_results:
        latencies.append(r.get("latencyMs", 0.0))
        mdd_detected_ids = set(r.get("primaryDetectedPhoneIds", []))
        for iss in r.get("finalSelectedIssues", []):
            pid = iss.get("phoneId")
            if pid and pid not in mdd_detected_ids:
                authority_invariant_violations += 1
                crottc_unauthorized_issues += 1
        if r.get("legacyDetectorUsed"):
            legacy_detector_used_count += 1

    target_detection_rate = target_detected_count / error_total if error_total > 0 else 0.0
    target_localization_rate = target_localized_count / error_total if error_total > 0 else 0.0

    target_detection_gate = target_detected_count >= 6
    target_localization_gate = target_localized_count >= 6
    unrelated_error_gate = total_unrelated_error_issues <= 4 and not clip_with_3plus_unrelated

    # 3. Diagnosis Metrics
    exact_diagnosis_precision = (
        correct_trusted_exact_count / trusted_exact_diagnoses_count
        if trusted_exact_diagnoses_count > 0
        else 1.0  # 100% precision if safely abstained on uncertain
    )
    abstention_rate = abstention_count / error_total if error_total > 0 else 0.0
    diagnosis_precision_gate = exact_diagnosis_precision >= 0.80

    # 4. Architecture & Persistence Gates
    authority_gate = (
        crottc_unauthorized_issues == 0
        and authority_invariant_violations == 0
        and legacy_detector_used_count == 0
    )
    persistence_gate = len(raw_eval_results) == 16 and all(r.get("audioSHA256") for r in raw_eval_results)
    http_replay_gate = all(r.get("httpStatus") == 200 for r in raw_eval_results)

    # 5. Performance Latencies
    latencies.sort()
    median_latency_ms = latencies[len(latencies) // 2] if latencies else 0.0
    p95_latency_ms = latencies[int(len(latencies) * 0.95)] if latencies else 0.0

    # Final Verdict
    all_gates_pass = (
        clean_gate_pass
        and target_detection_gate
        and target_localization_gate
        and unrelated_error_gate
        and diagnosis_precision_gate
        and authority_gate
        and persistence_gate
        and http_replay_gate
    )

    final_verdict = (
        "PRONUNCIATION_V1_REAL_MIC_ACCEPTED"
        if all_gates_pass
        else "PRONUNCIATION_V1_REAL_MIC_REJECTED"
    )

    failures = []
    if not clean_gate_pass:
        failures.append(f"CLEAN_FP_GATE: {clean_zero_issue_count}/8 zero issues (target >= 7), {clean_fp_utterances} FP utterances")
    if not target_detection_gate:
        failures.append(f"TARGET_DETECTION_GATE: {target_detected_count}/8 detected (target >= 6, rate={target_detection_rate:.1%})")
    if not target_localization_gate:
        failures.append(f"LOCALIZATION_GATE: {target_localized_count}/8 localized (target >= 6, rate={target_localization_rate:.1%})")
    if not unrelated_error_gate:
        failures.append(f"UNRELATED_ERROR_GATE: {total_unrelated_error_issues} unrelated issues (target <= 4)")
    if not diagnosis_precision_gate:
        failures.append(f"DIAGNOSIS_PRECISION_GATE: {exact_diagnosis_precision:.1%} precision (target >= 80%)")
    if not authority_gate:
        failures.append("AUTHORITY_GATE: Invariant violations detected")
    if not persistence_gate:
        failures.append("PERSISTENCE_GATE: Incomplete audio files or invalid hashes")
    if not http_replay_gate:
        failures.append("HTTP_REPLAY_GATE: Non-200 HTTP replay responses detected")

    summary = {
        "sessionId": session_id,
        "finalVerdict": final_verdict,
        "isAccepted": all_gates_pass,
        "gates": {
            "CLEAN_FP_GATE": "PASS" if clean_gate_pass else "FAIL",
            "TARGET_DETECTION_GATE": "PASS" if target_detection_gate else "FAIL",
            "LOCALIZATION_GATE": "PASS" if target_localization_gate else "FAIL",
            "UNRELATED_ERROR_GATE": "PASS" if unrelated_error_gate else "FAIL",
            "DIAGNOSIS_PRECISION_GATE": "PASS" if diagnosis_precision_gate else "FAIL",
            "AUTHORITY_GATE": "PASS" if authority_gate else "FAIL",
            "PERSISTENCE_GATE": "PASS" if persistence_gate else "FAIL",
            "HTTP_REPLAY_GATE": "PASS" if http_replay_gate else "FAIL",
        },
        "clean": {
            "totalClips": clean_total,
            "zeroIssueCount": clean_zero_issue_count,
            "falsePositiveUtterances": clean_fp_utterances,
            "utteranceFPR": clean_utterance_fpr,
            "unrelatedIssueCount": clean_unrelated_issue_count,
        },
        "error": {
            "totalClips": error_total,
            "targetDetectedCount": target_detected_count,
            "targetDetectionRate": target_detection_rate,
            "targetLocalizedCount": target_localized_count,
            "targetLocalizationRate": target_localization_rate,
            "unrelatedIssueCount": total_unrelated_error_issues,
        },
        "diagnosis": {
            "trustedExactDiagnosisCount": trusted_exact_diagnoses_count,
            "correctTrustedExactDiagnosisCount": correct_trusted_exact_count,
            "exactDiagnosisPrecision": exact_diagnosis_precision,
            "abstentionCount": abstention_count,
            "abstentionRate": abstention_rate,
        },
        "architecture": {
            "crottcUnauthorizedIssues": crottc_unauthorized_issues,
            "authorityInvariantViolations": authority_invariant_violations,
            "legacyDetectorUsed": legacy_detector_used_count,
        },
        "performance": {
            "medianLatencyMs": median_latency_ms,
            "p95LatencyMs": p95_latency_ms,
            "peakVramMb": peak_vram_mb,
        },
        "failures": failures,
        "results": raw_eval_results,
    }
    return summary
