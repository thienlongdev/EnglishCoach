from __future__ import annotations

import math
import base64
import json
import logging
import os
from typing import Any, Dict, List, Optional
import httpx

from app.services.pronunciation.lexical_stress import apply_lexical_stress
from app.domain.schemas.exams import CriterionScore, ExamScoringRequest, ExamScoringResponse
from app.services.exams.evidence_contract import (
    SpeakingTurnEvidence,
    compute_evidence_hash,
    compute_output_hash,
    validate_speaking_turn_evidence_set,
)
from app.services.exams.prompts import IELTS_SPEAKING_SYSTEM_PROMPT
from app.services.llm_provider import get_llm

logger = logging.getLogger("ielts_speaking")


def _analyze_turn_audio_with_mdd(audio_bytes: bytes, expected_text: str, turn_key: str) -> Optional[Dict[str, Any]]:
    """
    Invokes the Pronunciation Engine V2.2 with WavLM alignment, segmental assessment and prosody
    hosted on mdd-service for real acoustic evaluation of candidate speech.
    """
    mdd_url = os.getenv("MDD_SERVICE_URL", "http://mdd-service:8010")
    target_url = f"{mdd_url.rstrip('/')}/v2/pronunciation/analyze"
    try:
        with httpx.Client(timeout=35.0) as client:
            files = {"file": (f"{turn_key}.webm", audio_bytes, "audio/webm")}
            data = {"expected_text": expected_text.strip() or "IELTS Speaking response"}
            mdd_key = os.getenv("MDD_SERVICE_KEY", "").strip()
            headers = {"X-EC-Service-Key": mdd_key} if mdd_key else {}
            resp = client.post(target_url, files=files, data=data, headers=headers)
            if resp.status_code == 200:
                return apply_lexical_stress(resp.json(), audio_bytes, f"{turn_key}.webm", "audio/webm")
            else:
                logger.warning(f"MDD V2 returned HTTP {resp.status_code} for turn {turn_key}: {resp.text[:200]}")
    except Exception as e:
        logger.warning(f"MDD V2 call failed for turn {turn_key}: {e}")
    return None


def _round_to_ielts_half_band(score: float) -> float:
    """Official IELTS half-band rounding: .25 rounds up to .5, .75 rounds up to next whole."""
    clamped = min(9.0, max(1.0, score))
    floor = int(clamped)
    rem = clamped - floor
    if rem < 0.25:
        return float(floor)
    elif rem < 0.75:
        return floor + 0.5
    else:
        return float(floor + 1)


def _calibrate_acoustic_pronunciation(
    avg_seg: Optional[float],
    avg_stress: Optional[float],
    avg_inton: Optional[float],
    avg_wpm: float,
    avg_silence: float,
) -> tuple[float, Dict[str, Any]]:
    """
    Calibrates acoustic pronunciation band using multi-factor composite telemetry:
    - Segmental accuracy (MDD phoneme recognition)
    - Prosodic stress & intonation control (MDD prosody engine)
    - Rhythm & silence penalty (penalizing excessive hesitation or slow tempo)

    Returns (calibrated_band, telemetry_breakdown).
    Prevents artificial inflation where high segmental accuracy on Whisper-aligned text (e.g. 93%)
    erroneously yields Band 8.5 for hesitant non-native speech with 60% silence.
    """
    prosody_measures = [v for v in (avg_stress, avg_inton) if v is not None]

    # Prosodic control index
    prosody_score = sum(prosody_measures) / len(prosody_measures) if prosody_measures else None

    # Rhythm & silence penalty
    # Connected conversational speech has silence ratio ~0.15 - 0.30.
    # Silence ratio > 0.35 indicates pronounced pauses/hesitations affecting phonological flow.
    silence_penalty = 0.0
    if avg_silence > 0.35:
        silence_penalty = min(25.0, (avg_silence - 0.35) * 55.0)

    # Conversational speech rate: 120-160 WPM. Slow speech (<110 WPM) indicates articulation struggle.
    tempo_penalty = 0.0
    if avg_wpm < 110.0:
        tempo_penalty = min(20.0, (110.0 - avg_wpm) * 0.35)

    rhythm_score = max(0.0, min(100.0, 100.0 - silence_penalty - tempo_penalty))

    # Composite acoustic index (0 - 100)
    weighted = [(rhythm_score, 0.20)]
    if avg_seg is not None:
        weighted.append((avg_seg, 0.45))
    if prosody_score is not None:
        weighted.append((prosody_score, 0.35))
    composite = sum(value * weight for value, weight in weighted) / sum(weight for _, weight in weighted)

    # Psychometrically conservative simulation mapping:
    # Band 8.5/9.0: Near-native phonology, effortless intelligibility (composite >= 95)
    # Band 8.0: High precision & natural rhythm (composite >= 89)
    # Band 7.5: Good control, occasional minor flaws (composite >= 82)
    # Band 7.0: Generally clear throughout (composite >= 75)
    # Band 6.5: Range of features, mixed control, clear overall (composite >= 67)
    # Band 6.0: Understandable, some pronunciation errors/accent impact (composite >= 58)
    # Band 5.5: Basic control, frequent mispronunciations (composite >= 49)
    # Band 5.0: Limited control, causes listener effort (composite >= 40)
    # Band 4.5: Frequent errors, difficulty for listener (composite >= 32)
    # Band 4.0: Limited phonological control (composite >= 25)
    # Band <= 3.5: Very low intelligibility (< 25)
    if composite >= 95.0:
        raw_band = 8.5 if composite < 98.0 else 9.0
    elif composite >= 89.0:
        raw_band = 8.0
    elif composite >= 82.0:
        raw_band = 7.5
    elif composite >= 75.0:
        raw_band = 7.0
    elif composite >= 67.0:
        raw_band = 6.5
    elif composite >= 58.0:
        raw_band = 6.0
    elif composite >= 49.0:
        raw_band = 5.5
    elif composite >= 40.0:
        raw_band = 5.0
    elif composite >= 32.0:
        raw_band = 4.5
    elif composite >= 25.0:
        raw_band = 4.0
    else:
        raw_band = 3.5

    band = _round_to_ielts_half_band(raw_band)
    meta: Dict[str, Any] = {
        "compositeIndex": round(composite, 2),
        "segmentalComponent": round(avg_seg, 2) if avg_seg is not None else None,
        "prosodyComponent": round(prosody_score, 2) if prosody_score is not None else None,
        "rhythmComponent": round(rhythm_score, 2),
        "silencePenalty": round(silence_penalty, 2),
        "tempoPenalty": round(tempo_penalty, 2),
        "calibratedPronunciationBand": band,
        "calibrationStatus": "SIMULATION_HEURISTIC_V3",
    }
    return band, meta


def evaluate_ielts_speaking(request: ExamScoringRequest) -> ExamScoringResponse:
    """
    Authoritative IELTS Speaking scoring engine for Runtime V4.
    Invariants:
    1. Turns carry evidence and diagnostics ONLY; never emit or average per-turn IELTS bands.
    2. Holistic session assessment across all authorized turns.
    3. Pronunciation strictly requires acoustic evidence; transcript alone never qualifies.
    4. Insufficient/silent/missing speech abstains honestly; never falls back to 0.0 or 1.0.
    """
    # ── Case A: Authoritative V4 Multi-Turn Evidence Set ──
    if request.turns and len(request.turns) > 0:
        return _evaluate_v4_speaking_session(request)

    # ── Case B: Legacy / Single-Prompt Fallback ──
    return ExamScoringResponse(stageKey=request.stageKey, success=False, reviewRequired=True,
                               abstention={"reason": "FULL_RECORDED_SESSION_REQUIRED"})


def _evaluate_v4_speaking_session(request: ExamScoringRequest) -> ExamScoringResponse:
    try:
        validation = validate_speaking_turn_evidence_set(request.turns)
    except ValueError as exc:
        logger.warning(f"Turn evidence validation rejected: {exc}")
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=None,
            criteria=[],
            turnDiagnostics={},
            evidenceHash=None,
            outputHash=None,
            telemetry={"validationError": str(exc)},
            reviewerNotes=f"Invalid turn evidence contract: {str(exc)}",
            reviewRequired=True,
            abstention={"reason": "INVALID_TURN_EVIDENCE", "error": str(exc)},
            errorMessage=str(exc)
        )

    evidence_hash = validation["evidenceHash"]
    pronunciation_abstention_required = validation["pronunciationAbstentionRequired"]
    sorted_turns = sorted(request.turns, key=lambda t: t.turnSequence)

    turn_diagnostics: Dict[str, Any] = {}
    session_transcripts: List[str] = []
    total_words = 0
    total_duration_ms = 0
    total_audio_bytes = 0
    total_audio_duration_ms = 0
    total_speech_duration_ms = 0
    valid_acoustic_segments = 0
    wpm_list: List[float] = []
    silence_ratios: List[float] = []

    mdd_segmental_scores: List[float] = []
    mdd_fluency_scores: List[float] = []
    mdd_stress_scores: List[float] = []
    mdd_intonation_scores: List[float] = []
    mdd_speech_rates: List[float] = []

    for t in sorted_turns:
        transcript = (t.transcriptText or "").strip()
        audio_bytes = None
        turn_acoustic = dict(t.acousticEvidence or {})
        turn_abstention = dict(t.abstention or {}) if t.abstention else None
        turn_dur_ms = t.durationMs or 0

        if t.audioBase64 and len(t.audioBase64) >= 1000:
            try:
                audio_bytes = base64.b64decode(t.audioBase64)
                total_audio_bytes += len(audio_bytes)
                from app.services.exams.audio_evidence import extract_speaking_evidence
                ev = extract_speaking_evidence(audio_bytes)
                transcript = (ev.transcript_text or "").strip()
                if not turn_acoustic and ev.acoustic_features:
                    turn_acoustic = ev.acoustic_features
                if ev.abstention_required and not turn_abstention:
                    turn_abstention = {"reason": ev.abstention_reason}
                if ev.speech_rate_wpm > 0:
                    wpm_list.append(ev.speech_rate_wpm)
                if ev.silence_ratio is not None:
                    silence_ratios.append(ev.silence_ratio)

                # Fix aggregation/metadata serialization bug:
                # If t.durationMs was missing or 0, use true decoded duration
                if ev.duration_seconds > 0:
                    turn_dur_ms = int(round(ev.duration_seconds * 1000.0))

                if ev.duration_seconds > 0 and not ev.abstention_required:
                    valid_acoustic_segments += 1
                    total_speech_duration_ms += int(round(ev.duration_seconds * (1.0 - ev.silence_ratio) * 1000.0))

                # Invoke authoritative trained Pronunciation Engine V2.2
                mdd_res = _analyze_turn_audio_with_mdd(
                    audio_bytes=audio_bytes,
                    expected_text=transcript,
                    turn_key=t.turnKey
                ) if transcript and not ev.abstention_required else None
                if mdd_res and str(mdd_res.get("status", "")).upper() == "COMPLETED":
                    ov = dict(mdd_res.get("overall") or {})
                    if mdd_res.get("engine_version") == "pronunciation-v2.2" and (mdd_res.get("lexicalStress") or {}).get("status") != "ASSESSED":
                        for field in ("stress_score", "stressScore", "confidence"):
                            ov.pop(field, None)
                    seg = ov.get("segmental_score", ov.get("segmentalScore"))
                    flu = ov.get("fluency_score", ov.get("fluencyScore"))
                    stress = ov.get("stress_score", ov.get("stressScore"))
                    inton = ov.get("intonation_score", ov.get("intonationScore"))
                    if seg is not None:
                        mdd_segmental_scores.append(float(seg))
                    if flu is not None:
                        mdd_fluency_scores.append(float(flu))
                    if stress is not None:
                        mdd_stress_scores.append(float(stress))
                    if inton is not None:
                        mdd_intonation_scores.append(float(inton))
                    pros = mdd_res.get("prosody") or {}
                    sr = pros.get("speech_rate")
                    if sr and float(sr) > 0:
                        mdd_speech_rates.append(float(sr))
                    turn_acoustic["mdd"] = {
                        "overall": ov,
                        "prosody": pros,
                        "runtime_metadata": mdd_res.get("runtime_metadata") or {},
                        "engine_version": (mdd_res.get("runtime_metadata") or {}).get("engine_version", "pronunciation-v2.2")
                    }
            except Exception as exc:
                logger.warning(f"Error extracting audio evidence for turn {t.turnKey}: {exc}")

        words = transcript.split()
        word_count = len(words)
        total_words += word_count
        total_duration_ms += turn_dur_ms
        total_audio_duration_ms += turn_dur_ms

        # Invariant: Turns carry diagnostics/evidence only. NEVER emit an IELTS band score here.
        turn_diagnostics[t.turnKey] = {
            "turnKey": t.turnKey,
            "turnSequence": t.turnSequence,
            "partKey": t.partKey,
            "durationMs": turn_dur_ms,
            "wordCount": word_count,
            "transcriptText": transcript,
            "transcriptStatus": t.transcriptStatus or ("READY" if transcript else "NOT_REQUESTED"),
            "hasAcoustic": bool(turn_acoustic.get("totalBytes", 0) > 0 or audio_bytes),
            "abstention": turn_abstention
        }

        session_transcripts.append(
            f"[{t.partKey} - Turn {t.turnSequence} ({t.turnKey})]\n"
            f"Prompt: {t.promptText or 'Prompt not provided'}\n"
            f"Candidate Speech: {transcript or '(No speech recognized)'}"
        )

    # 1. Speech sufficiency gate
    if total_words < 5:
        logger.info(f"Insufficient candidate speech across session: total_words={total_words}")
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=None,  # NEVER 0.0 or 1.0
            criteria=[],       # No fake criterion scores
            turnDiagnostics=turn_diagnostics,
            evidenceHash=evidence_hash,
            outputHash=None,
            telemetry={
                "wordCount": total_words,
                "rule": "MIN_SPEECH_INSUFFICIENT",
                "turnCount": len(sorted_turns)
            },
            reviewerNotes=f"Candidate produced {total_words} recognized words across the session (fewer than 5 words minimum). Scoring abstained; review required.",
            reviewRequired=True,
            abstention={
                "reason": "MIN_SPEECH_INSUFFICIENT",
                "wordCount": total_words
            },
            errorMessage=None
        )

    # 2. Pronunciation acoustic evidence requirement gate
    if pronunciation_abstention_required:
        logger.info("Session lacks acoustic evidence for Pronunciation evaluation. Abstaining Pronunciation.")
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=None,  # Holistic band requires all 4 criteria with valid evidence
            criteria=[],
            turnDiagnostics=turn_diagnostics,
            evidenceHash=evidence_hash,
            outputHash=None,
            telemetry={
                "wordCount": total_words,
                "rule": "PRONUNCIATION_LACKS_ACOUSTIC_EVIDENCE",
                "turnCount": len(sorted_turns)
            },
            reviewerNotes="Pronunciation evaluation requires acoustic evidence. No valid candidate audio evidence was provided across session turns.",
            reviewRequired=True,
            abstention={
                "criterion": "PRONUNCIATION",
                "reason": "PRONUNCIATION_LACKS_ACOUSTIC_EVIDENCE"
            },
            errorMessage=None
        )

    # 3. Sufficient speech & valid acoustic evidence: invoke holistic assessment
    avg_wpm = sum(wpm_list) / len(wpm_list) if wpm_list else 120.0
    avg_silence = sum(silence_ratios) / len(silence_ratios) if silence_ratios else 0.15
    total_duration_sec = total_duration_ms / 1000.0

    avg_mdd_seg = sum(mdd_segmental_scores) / len(mdd_segmental_scores) if mdd_segmental_scores else None
    avg_mdd_flu = sum(mdd_fluency_scores) / len(mdd_fluency_scores) if mdd_fluency_scores else None
    avg_mdd_stress = sum(mdd_stress_scores) / len(mdd_stress_scores) if mdd_stress_scores else None
    avg_mdd_inton = sum(mdd_intonation_scores) / len(mdd_intonation_scores) if mdd_intonation_scores else None

    # ── Speaking Acoustic Sanity Guard ──
    # Validates decoded audio duration, speech duration, audio byte length, silence ratio, and no NaN/Inf
    is_valid_audio_duration = total_audio_duration_ms > 0
    is_valid_speech_duration = total_speech_duration_ms > 0
    is_valid_bytes = total_audio_bytes > 0
    is_valid_silence = (0.0 <= avg_silence < 0.95) if silence_ratios else True
    is_not_nan_or_inf = not (
        math.isnan(avg_wpm) or math.isinf(avg_wpm) or
        math.isnan(avg_silence) or math.isinf(avg_silence) or
        (avg_mdd_seg is not None and (math.isnan(avg_mdd_seg) or math.isinf(avg_mdd_seg))) or
        (avg_mdd_flu is not None and (math.isnan(avg_mdd_flu) or math.isinf(avg_mdd_flu))) or
        (avg_mdd_stress is not None and (math.isnan(avg_mdd_stress) or math.isinf(avg_mdd_stress))) or
        (avg_mdd_inton is not None and (math.isnan(avg_mdd_inton) or math.isinf(avg_mdd_inton)))
    )

    acoustic_evidence_valid = bool(
        is_valid_audio_duration and
        is_valid_speech_duration and
        is_valid_bytes and
        is_valid_silence and
        valid_acoustic_segments == len(sorted_turns) and
        len(mdd_segmental_scores) == len(sorted_turns) and
        all(d.get("wordCount", 0) > 0 and not d.get("abstention") for d in turn_diagnostics.values()) and
        is_not_nan_or_inf
    )

    pron_calibration_meta: Optional[Dict[str, Any]] = None
    if acoustic_evidence_valid:
        acoustic_pr_band, pron_calibration_meta = _calibrate_acoustic_pronunciation(
            avg_seg=avg_mdd_seg,
            avg_stress=avg_mdd_stress,
            avg_inton=avg_mdd_inton,
            avg_wpm=avg_wpm,
            avg_silence=avg_silence
        )
        # Supporting acoustic context for fluency telemetry (not raw FC band)
        acoustic_fc_band = _round_to_ielts_half_band(4.0 + (avg_mdd_flu / 100.0) * 5.0) if avg_mdd_flu is not None else (7.5 if avg_wpm >= 140 else 6.5)
    else:
        logger.warning(
            f"Speaking acoustic sanity guard triggered: audio_dur={total_audio_duration_ms}ms, "
            f"speech_dur={total_speech_duration_ms}ms, bytes={total_audio_bytes}, "
            f"silence={avg_silence:.2f}, valid_segs={valid_acoustic_segments}. "
            "Acoustic evidence invalid; refusing to convert into confident PR band."
        )
        return ExamScoringResponse(stageKey=request.stageKey, success=False, reviewRequired=True,
                                   evidenceHash=evidence_hash, turnDiagnostics=turn_diagnostics, abstention={"reason": "UNRELIABLE_SPEECH_EVIDENCE"})

    try:
        llm = get_llm(temperature=0.1, max_tokens=3500, exam_mode=True, json_mode=True, reasoning_effort="low", timeout=75, max_retries=0)
    except Exception:
        llm = None
    if not llm:
        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=False,
            overallBand=None,
            criteria=[],
            turnDiagnostics=turn_diagnostics,
            evidenceHash=evidence_hash,
            outputHash=None,
            telemetry={"wordCount": total_words},
            reviewerNotes="Scoring provider unavailable.",
            reviewRequired=True,
            errorMessage="AI LLM provider not configured or available."
        )

    formatted_transcripts = "\n\n".join(session_transcripts)
    acoustic_info_lines = []
    if avg_mdd_seg is not None:
        acoustic_info_lines.append(f"- Segmental Accuracy (Pronunciation V2.2): {avg_mdd_seg:.1f}/100")
    if avg_mdd_stress is not None:
        acoustic_info_lines.append(f"- Prosodic Stress Control: {avg_mdd_stress:.1f}/100")
    if avg_mdd_inton is not None:
        acoustic_info_lines.append(f"- Intonation Control: {avg_mdd_inton:.1f}/100")
    if avg_mdd_flu is not None:
        acoustic_info_lines.append(f"- Acoustic Tempo Pacing: {avg_mdd_flu:.1f}/100")
    if acoustic_pr_band is not None:
        acoustic_info_lines.append(f"- Acoustic Pronunciation Reference Band: {acoustic_pr_band} (simulation composite)")
    acoustic_info_str = "\n".join(acoustic_info_lines) if acoustic_info_lines else "- Acoustic engine: Baseline audio features extracted"

    user_prompt = f"""Official IELTS Speaking Session Examination
Total Word Count: {total_words}
Total Spoken Duration: {total_duration_sec:.1f}s
Acoustic Telemetry (Pronunciation Engine V2.2 - Simulation Heuristic):
{acoustic_info_str}
- Speech Rate: ~{avg_wpm:.1f} WPM, Silence Ratio: ~{avg_silence:.2f}

Full Session Transcript by Part:
{formatted_transcripts}
"""

    try:
        from langchain_core.messages import SystemMessage, HumanMessage
        messages = [
            SystemMessage(content=IELTS_SPEAKING_SYSTEM_PROMPT),
            HumanMessage(content=user_prompt)
        ]

        ai_msg = llm.invoke(messages)
        content = ai_msg.content if hasattr(ai_msg, "content") else str(ai_msg)
        content = content.strip()
        if content.startswith("```json") and content.endswith("```"):
            content = content[7:-3].strip()
        data = json.loads(content)
        required = {"FLUENCY_COHERENCE", "LEXICAL_RESOURCE", "GRAMMATICAL_RANGE", "PRONUNCIATION"}
        rows = data["criteria"]
        if len(rows) != len(required) or {row["criterion"] for row in rows} != required:
            raise ValueError("Incomplete speaking criteria")

        criteria_list: List[CriterionScore] = []
        raw_criterion_dicts: List[Dict[str, Any]] = []
        total_scores = 0.0

        for c in data.get("criteria", []):
            crit_name = str(c.get("criterion", "GENERAL"))
            score = c["score"]
            if type(score) not in (int, float) or not 1 <= score <= 9 or score * 2 != int(score * 2) or not c.get("feedback") or not c.get("evidence"):
                raise ValueError("Invalid speaking criterion")
            score = _round_to_ielts_half_band(score)
            # Anchor PRONUNCIATION strictly in acoustic MDD composite evidence when available and valid
            # Task A Invariant: Pronunciation must be based on actual audio/acoustic evidence; never invented by LLM from text
            if "PRONUNCIATION" in crit_name and acoustic_pr_band is not None:
                score = acoustic_pr_band
            total_scores += score
            raw_ev = c.get("evidence", [])
            if isinstance(raw_ev, str):
                parsed_ev = [raw_ev]
            elif isinstance(raw_ev, list):
                parsed_ev = [str(x) for x in raw_ev]
            else:
                parsed_ev = []

            criteria_list.append(CriterionScore(
                criterion=crit_name,
                score=score,
                feedback=c.get("feedback"),
                evidence=parsed_ev
            ))
            raw_criterion_dicts.append({
                "criterion": crit_name,
                "score": score
            })

        if criteria_list:
            avg = total_scores / len(criteria_list)
            overall = _round_to_ielts_half_band(avg)
        else:
            overall = _round_to_ielts_half_band(float(data.get("overallBand", 5.0)))

        output_hash = compute_output_hash(request.stageKey, overall, raw_criterion_dicts, evidence_hash)

        # Structured holistic session feedback
        overall_feedback = data.get("overallFeedback")
        strongest_area = data.get("strongestArea")
        main_weakness = data.get("mainWeakness")
        next_recommended_focus = data.get("nextRecommendedFocus")
        strengths = data.get("strengths") or []
        weaknesses = data.get("weaknesses") or []
        next_steps = data.get("nextSteps") or []

        # Parse per-turn qualitative feedback
        raw_turn_fb = data.get("turnFeedback", [])
        turn_feedback_map: Dict[str, Dict[str, Any]] = {}
        if isinstance(raw_turn_fb, list):
            for tf in raw_turn_fb:
                if isinstance(tf, dict) and "turnKey" in tf:
                    turn_feedback_map[str(tf["turnKey"])] = {
                        "strengths": tf.get("strengths", []),
                        "issues": tf.get("issues", []),
                        "suggestion": tf.get("suggestion", "")
                    }

        for tk, diag in turn_diagnostics.items():
            if tk in turn_feedback_map:
                diag["turnFeedback"] = turn_feedback_map[tk]

        telemetry_data = {
            "wordCount": total_words,
            "turnCount": len(sorted_turns),
            "totalAudioDurationMs": total_audio_duration_ms,
            "totalSpeechDurationMs": total_speech_duration_ms,
            "totalAudioBytes": total_audio_bytes,
            "validAcousticSegments": valid_acoustic_segments,
            "silenceRatio": round(avg_silence, 3),
            "speechRateWpm": round(avg_wpm, 1),
            "segmentalAccuracy": round(avg_mdd_seg, 2) if avg_mdd_seg is not None else None,
            "prosodicStress": round(avg_mdd_stress, 2) if avg_mdd_stress is not None else None,
            "intonationControl": round(avg_mdd_inton, 2) if avg_mdd_inton is not None else None,
            "acousticFluency": round(avg_mdd_flu, 2) if avg_mdd_flu is not None else None,
            "pronunciationBand": acoustic_pr_band if acoustic_evidence_valid else None,
            "pronunciationCalibration": pron_calibration_meta if acoustic_evidence_valid else None,
            "calibrationStatus": "SIMULATION_HEURISTIC_V3",
            "acousticEvidenceValid": acoustic_evidence_valid,
            "wpm": round(avg_wpm, 1),
            "duration": round(total_duration_sec, 1),
            "scorerIdentifier": "Pronunciation V2.2 (WavLM alignment, segmental and prosody models)",
            "modelVersion": "2.2.0-production",
            "acousticEngine": "PronunciationV2_2Orchestrator",
            "acousticAnalyzedTurns": len(mdd_segmental_scores),
            "overallFeedback": overall_feedback,
            "strongestArea": strongest_area,
            "mainWeakness": main_weakness,
            "nextRecommendedFocus": next_recommended_focus,
            "strengths": strengths,
            "weaknesses": weaknesses,
            "nextSteps": next_steps,
            "turnFeedback": turn_feedback_map
        }

        return ExamScoringResponse(
            stageKey=request.stageKey,
            success=True,
            overallBand=overall,
            criteria=criteria_list,
            turnDiagnostics=turn_diagnostics,
            evidenceHash=evidence_hash,
            outputHash=output_hash,
            telemetry=telemetry_data,
            reviewerNotes=data.get("reviewerNotes", "Holistic IELTS Speaking simulation scoring complete (acoustic-anchored pronunciation V2)."),
            reviewRequired=False,
            abstention=None,
            errorMessage=None
        )

    except Exception as exc:
        logger.warning("Speaking assessment unavailable (%s)", type(exc).__name__)
        return ExamScoringResponse(stageKey=request.stageKey, success=False, reviewRequired=True,
                                   evidenceHash=evidence_hash, abstention={"reason": "PROVIDER_OR_ASSESSMENT_INVALID"})
