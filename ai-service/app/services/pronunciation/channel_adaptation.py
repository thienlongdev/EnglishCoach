"""
SHD-2B.3: Acoustic Channel Adaptation, Targeted L2 Phone Deficits,
and Training Foundation Services.

Research-only module. Production contracts remain strictly:
- calibratedScore = null
- observedPhoneme = null
"""

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# Constants and Invariants
# ---------------------------------------------------------------------------
SHD_2B3_SCHEMA = "shd-2b.3-adaptation-foundation-v1"
CALIBRATION_SEED = 20260830

# Deficient phonemes identified in SHD-2B.2B and SHD-2B.2C
UNDERPOWERED_PHONES: List[str] = [
    "aʊ", "b", "dʒ", "f", "h", "iː", "j", "k", "p", "tʃ",
    "u", "uː", "v", "ŋ", "ɐ", "ɑː", "ɔ", "ɔɪ", "əl", "ɚ",
    "ɡ", "ʃ", "ʒ", "θ", "ᵻ",
]
SINGLE_CLASS_PHONES: List[str] = ["oː"]
ALL_DEFICIENT_PHONES: List[str] = sorted(UNDERPOWERED_PHONES + SINGLE_CLASS_PHONES)

# ---------------------------------------------------------------------------
# 1. Deterministic Acoustic Channel Adaptation Candidates (Research Only)
# ---------------------------------------------------------------------------

def apply_dc_removal(waveform: np.ndarray) -> np.ndarray:
    """Subtract DC bias/mean from audio waveform."""
    if len(waveform) == 0:
        return waveform.copy()
    mean_val = float(np.mean(waveform))
    return (waveform - mean_val).astype(np.float32)


def apply_conservative_rms_norm(
    waveform: np.ndarray,
    target_rms: float = 0.08,
    max_gain_db: float = 12.0,
    peak_guard: float = 0.95,
) -> np.ndarray:
    """Apply gentle, peak-guarded RMS gain adjustment without aggressive compression."""
    if len(waveform) == 0:
        return waveform.copy()
    current_rms = float(np.sqrt(np.mean(np.square(waveform))))
    if current_rms < 1e-6:
        return waveform.copy()
    raw_gain = target_rms / current_rms
    max_linear_gain = 10.0 ** (max_gain_db / 20.0)
    clamped_gain = min(raw_gain, max_linear_gain)
    scaled = waveform * clamped_gain
    peak = float(np.max(np.abs(scaled)))
    if peak > peak_guard:
        scaled = scaled * (peak_guard / peak)
    return scaled.astype(np.float32)


def apply_conservative_peak_limit(
    waveform: np.ndarray,
    threshold: float = 0.95,
) -> np.ndarray:
    """Soft-knee peak limiter using smooth saturation to prevent hard clipping."""
    if len(waveform) == 0:
        return waveform.copy()
    peak = float(np.max(np.abs(waveform)))
    if peak <= threshold:
        return waveform.copy()
    # Smooth tanh scaling above threshold
    return (np.tanh(waveform / threshold) * threshold).astype(np.float32)


def apply_safe_silence_trim(
    waveform: np.ndarray,
    sample_rate: int = 16000,
    threshold_db: float = -45.0,
    pad_ms: int = 100,
) -> np.ndarray:
    """Trim leading and trailing digital silence with safety padding to prevent onset clipping."""
    if len(waveform) == 0:
        return waveform.copy()
    frame_len = int(sample_rate * 0.02)  # 20ms frame
    if len(waveform) < frame_len:
        return waveform.copy()
    hop_len = frame_len // 2
    num_frames = (len(waveform) - frame_len) // hop_len + 1
    energies = []
    for i in range(num_frames):
        seg = waveform[i * hop_len : i * hop_len + frame_len]
        rms = float(np.sqrt(np.mean(np.square(seg)) + 1e-12))
        db = 20.0 * math.log10(rms)
        energies.append(db)
    active_indices = [i for i, e in enumerate(energies) if e > threshold_db]
    if not active_indices:
        return waveform.copy()
    pad_samples = int(sample_rate * (pad_ms / 1000.0))
    start_sample = max(0, active_indices[0] * hop_len - pad_samples)
    end_sample = min(len(waveform), (active_indices[-1] + 1) * hop_len + frame_len + pad_samples)
    return waveform[start_sample:end_sample].astype(np.float32)


def apply_composite_adaptation(
    waveform: np.ndarray,
    sample_rate: int = 16000,
    target_rms: float = 0.08,
) -> np.ndarray:
    """Non-aggressive composite channel adaptation combining DC removal, safe trim, and RMS gain."""
    w = apply_dc_removal(waveform)
    w = apply_safe_silence_trim(w, sample_rate=sample_rate, threshold_db=-45.0, pad_ms=100)
    w = apply_conservative_rms_norm(w, target_rms=target_rms, max_gain_db=10.0, peak_guard=0.92)
    w = apply_conservative_peak_limit(w, threshold=0.95)
    return w


# ---------------------------------------------------------------------------
# 2. Channel-Invariant Representation Transforms
# ---------------------------------------------------------------------------

def transform_phone_centered_gop(raw_gop: float, phone_mean: float) -> float:
    """Center raw GOP relative to phone reference centroid."""
    return float(raw_gop - phone_mean)


def transform_standard_z(raw_gop: float, phone_mean: float, phone_std: float) -> float:
    """Standard z-score normalization relative to reference distribution."""
    if phone_std <= 1e-6:
        return 0.0
    return float((raw_gop - phone_mean) / phone_std)


def transform_duration_residual(
    raw_gop: float,
    duration_frames: int,
    phone_mean_gop: float,
    phone_mean_dur: float,
    slope: float = 0.05,
) -> float:
    """Remove duration confounding via linear residualization."""
    dur_offset = float(duration_frames - phone_mean_dur)
    return float((raw_gop - phone_mean_gop) - (slope * dur_offset))


# ---------------------------------------------------------------------------
# 3. Targeted Deficit Accounting Models
# ---------------------------------------------------------------------------

@dataclass
class PhoneDeficitRecord:
    enginePhone: str
    humanCorrectInstances: int
    humanErrorInstances: int
    uniqueCorrectSpeakers: int
    uniqueErrorSpeakers: int
    availabilityStatus: str
    exactLimitingCondition: str
    targetAdditionalErrorInstances: str  # "TARGET_NOT_ESTABLISHED"
    targetAdditionalErrorSpeakers: str  # "TARGET_NOT_ESTABLISHED"
    planningHeuristicTargetErrors: int
    planningHeuristicTargetSpeakers: int
    derivationMethod: str  # "EMPIRICAL_UNDERPOWERED_AUDIT_WITH_PLANNING_HEURISTIC"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def calculate_phone_deficits(
    phone_instances: Optional[List[Dict[str, Any]]] = None,
    audit_data: Optional[Dict[str, Any]] = None,
    planning_error_instances_min: int = 30,
    planning_error_speakers_min: int = 20,
) -> List[PhoneDeficitRecord]:
    """Compute exact deficit table for all 26 deficient phonemes."""
    records = []

    # If structured audit data from underpowered_phone_audit.json is supplied, use it
    if audit_data and "deficits" in audit_data:
        audit_map = {d["phoneme"]: d for d in audit_data["deficits"]}
        for p in ALL_DEFICIENT_PHONES:
            d = audit_map.get(p, {})
            c_inst = d.get("correctCount", 0)
            e_inst = d.get("errorCount", 0)
            c_spk = d.get("speakerCount", 0)
            e_spk = min(e_inst, c_spk)
            status = d.get("status", "UNDERPOWERED")
            limiting = d.get("reason", "Insufficient research sample power.")

            records.append(
                PhoneDeficitRecord(
                    enginePhone=p,
                    humanCorrectInstances=c_inst,
                    humanErrorInstances=e_inst,
                    uniqueCorrectSpeakers=c_spk,
                    uniqueErrorSpeakers=e_spk,
                    availabilityStatus=status,
                    exactLimitingCondition=limiting,
                    targetAdditionalErrorInstances="TARGET_NOT_ESTABLISHED",
                    targetAdditionalErrorSpeakers="TARGET_NOT_ESTABLISHED",
                    planningHeuristicTargetErrors=planning_error_instances_min,
                    planningHeuristicTargetSpeakers=planning_error_speakers_min,
                    derivationMethod="EMPIRICAL_UNDERPOWERED_AUDIT_WITH_PLANNING_HEURISTIC",
                )
            )
        return records

    # Otherwise compute from phone instances
    stats: Dict[str, Dict[str, Any]] = {
        p: {
            "correct_inst": 0,
            "error_inst": 0,
            "correct_spks": set(),
            "error_spks": set(),
        }
        for p in ALL_DEFICIENT_PHONES
    }

    if phone_instances:
        for inst in phone_instances:
            p = inst.get("expectedPhoneme")
            if p not in stats:
                continue
            score = inst.get("humanPhoneAccuracy", inst.get("humanScore"))
            spk = inst.get("speakerId", "unknown")
            if score is None:
                continue
            f_score = float(score)
            is_correct = (f_score >= 2.0) if f_score <= 2.0 else (f_score >= 9.0)
            if is_correct:
                stats[p]["correct_inst"] += 1
                stats[p]["correct_spks"].add(spk)
            else:
                stats[p]["error_inst"] += 1
                stats[p]["error_spks"].add(spk)

    for p in ALL_DEFICIENT_PHONES:
        s = stats[p]
        c_inst = s["correct_inst"]
        e_inst = s["error_inst"]
        c_spk = len(s["correct_spks"])
        e_spk = len(s["error_spks"])

        if p in SINGLE_CLASS_PHONES or e_inst == 0:
            status = "SINGLE_CLASS"
            limiting = f"Zero human error instances observed in corpus (error count = {e_inst})"
        elif e_inst < 20 or e_spk < 20:
            status = "UNDERPOWERED"
            reasons = []
            if e_inst < 20:
                reasons.append(f"insufficient error instances ({e_inst} < 20)")
            if e_spk < 20:
                reasons.append(f"insufficient error speakers ({e_spk} < 20)")
            limiting = " and ".join(reasons)
        else:
            status = "POWERED"
            limiting = "NONE"

        records.append(
            PhoneDeficitRecord(
                enginePhone=p,
                humanCorrectInstances=c_inst,
                humanErrorInstances=e_inst,
                uniqueCorrectSpeakers=c_spk,
                uniqueErrorSpeakers=e_spk,
                availabilityStatus=status,
                exactLimitingCondition=limiting,
                targetAdditionalErrorInstances="TARGET_NOT_ESTABLISHED",
                targetAdditionalErrorSpeakers="TARGET_NOT_ESTABLISHED",
                planningHeuristicTargetErrors=planning_error_instances_min,
                planningHeuristicTargetSpeakers=planning_error_speakers_min,
                derivationMethod="EMPIRICAL_UNDERPOWERED_AUDIT_WITH_PLANNING_HEURISTIC",
            )
        )
    return records


# ---------------------------------------------------------------------------
# 4. Targeted Research Prompt Generator
# ---------------------------------------------------------------------------

@dataclass
class TargetedPromptItem:
    promptId: str
    targetPhone: str
    targetWord: str
    lexicalPronunciation: List[str]
    phonePosition: str  # INITIAL, MEDIAL, FINAL, MINIMAL_PAIR
    stressContext: str  # PRIMARY, SECONDARY, UNSTRESSED
    neighboringPhones: str
    expectedPronunciationVariant: str
    difficultyTier: str  # EASY, MEDIUM, HARD
    promptText: str
    contextType: str  # ISOLATED_WORD, SHORT_PHRASE, NATURAL_SENTENCE, CONTRAST_PAIR

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# Comprehensive phoneme elicitation lexicon mapping for all 26 deficient phonemes
TARGETED_PHONE_ELICITATION_SEEDS: Dict[str, List[Dict[str, Any]]] = {
    "aʊ": [
        {"word": "house", "pron": ["h", "aʊ", "s"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "The old house stands on the hill.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "out", "pron": ["aʊ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Step out into the fresh air.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "now", "pron": ["n", "aʊ"], "pos": "FINAL", "stress": "PRIMARY", "text": "We must leave right now.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "cloud", "pron": ["k", "l", "aʊ", "d"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "A dark cloud covered the sun.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "brown", "pron": ["b", "ɹ", "aʊ", "n"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "brown / brain contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
    ],
    "b": [
        {"word": "boat", "pron": ["b", "oʊ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "The wooden boat docked safely.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "table", "pron": ["t", "eɪ", "b", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Please clear the kitchen table.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "club", "pron": ["k", "l", "ʌ", "b"], "pos": "FINAL", "stress": "PRIMARY", "text": "Join our weekly chess club.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "bat", "pron": ["b", "æ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "bat / pat contrast", "tier": "EASY", "type": "CONTRAST_PAIR"},
        {"word": "cabin", "pron": ["k", "æ", "b", "ɪ", "n"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "We stayed at a quiet cabin in the woods.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "dʒ": [
        {"word": "judge", "pron": ["dʒ", "ʌ", "dʒ"], "pos": "INITIAL", "stress": "PRIMARY", "text": "The judge listened to the arguments.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "bridge", "pron": ["b", "ɹ", "ɪ", "dʒ"], "pos": "FINAL", "stress": "PRIMARY", "text": "Walk across the stone bridge.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "major", "pron": ["m", "eɪ", "dʒ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "This is a major discovery in science.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "gin", "pron": ["dʒ", "ɪ", "n"], "pos": "INITIAL", "stress": "PRIMARY", "text": "gin / chin contrast", "tier": "HARD", "type": "CONTRAST_PAIR"},
        {"word": "engine", "pron": ["ɛ", "n", "dʒ", "ɪ", "n"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "The car engine started smoothly.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "f": [
        {"word": "fox", "pron": ["f", "ɑː", "k", "s"], "pos": "INITIAL", "stress": "PRIMARY", "text": "A swift fox ran through the forest.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "coffee", "pron": ["k", "ɑː", "f", "i"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Fresh morning coffee smells great.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "leaf", "pron": ["l", "iː", "f"], "pos": "FINAL", "stress": "PRIMARY", "text": "A single green leaf fell from the branch.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "fan", "pron": ["f", "æ", "n"], "pos": "INITIAL", "stress": "PRIMARY", "text": "fan / van contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "effort", "pron": ["ɛ", "f", "ɚ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Great effort leads to strong results.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "h": [
        {"word": "hat", "pron": ["h", "æ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "He wore a warm winter hat.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "ahead", "pron": ["ə", "h", "ɛ", "d"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Look ahead at the open road.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "heart", "pron": ["h", "ɑː", "ɹ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "heart / art contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "behind", "pron": ["b", "ɪ", "h", "aɪ", "n", "d"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Stay behind the safety line.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "iː": [
        {"word": "eat", "pron": ["iː", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Let us eat dinner together.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "seat", "pron": ["s", "iː", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Please take a comfortable seat.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "see", "pron": ["s", "iː"], "pos": "FINAL", "stress": "PRIMARY", "text": "I can see the mountains clearly.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "sheep", "pron": ["ʃ", "iː", "p"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "sheep / ship contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "machine", "pron": ["m", "ə", "ʃ", "iː", "n"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "This modern machine works efficiently.", "tier": "HARD", "type": "NATURAL_SENTENCE"},
    ],
    "j": [
        {"word": "yes", "pron": ["j", "ɛ", "s"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Yes, we agree with the plan.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "beyond", "pron": ["b", "ɪ", "j", "ɑː", "n", "d"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Look beyond the horizon.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "year", "pron": ["j", "ɪ", "ɹ"], "pos": "INITIAL", "stress": "PRIMARY", "text": "year / ear contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "music", "pron": ["m", "j", "uː", "z", "ɪ", "k"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "The soft music filled the quiet room.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "k": [
        {"word": "cat", "pron": ["k", "æ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "The curious cat climbed the fence.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "market", "pron": ["m", "ɑː", "ɹ", "k", "ɪ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "We visited the local farmers market.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "park", "pron": ["p", "ɑː", "ɹ", "k"], "pos": "FINAL", "stress": "PRIMARY", "text": "Children play in the sunny park.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "coat", "pron": ["k", "oʊ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "coat / goat contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "pocket", "pron": ["p", "ɑː", "k", "ɪ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Keep the key in your front pocket.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "p": [
        {"word": "pen", "pron": ["p", "ɛ", "n"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Write your name with a blue pen.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "apple", "pron": ["æ", "p", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "She sliced a crisp red apple.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "cup", "pron": ["k", "ʌ", "p"], "pos": "FINAL", "stress": "PRIMARY", "text": "Fill the cup with warm water.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "pin", "pron": ["p", "ɪ", "n"], "pos": "INITIAL", "stress": "PRIMARY", "text": "pin / bin contrast", "tier": "EASY", "type": "CONTRAST_PAIR"},
        {"word": "simple", "pron": ["s", "ɪ", "m", "p", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Follow these simple instructions carefully.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "tʃ": [
        {"word": "chair", "pron": ["tʃ", "ɛ", "ɹ"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Sit in the wooden chair.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "teacher", "pron": ["t", "iː", "tʃ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Our science teacher explained the lesson.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "match", "pron": ["m", "æ", "tʃ"], "pos": "FINAL", "stress": "PRIMARY", "text": "They played an exciting soccer match.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "cheap", "pron": ["tʃ", "iː", "p"], "pos": "INITIAL", "stress": "PRIMARY", "text": "cheap / sheep contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "nature", "pron": ["n", "eɪ", "tʃ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "We enjoy the beauty of nature.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "u": [
        {"word": "put", "pron": ["p", "u", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Put the book back on the shelf.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "foot", "pron": ["f", "u", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "He walked on foot across the town.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "look", "pron": ["l", "u", "k"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "look / Luke contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "sugar", "pron": ["ʃ", "u", "ɡ", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Add a small spoon of sugar.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "uː": [
        {"word": "moon", "pron": ["m", "uː", "n"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "The full moon shone brightly tonight.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "blue", "pron": ["b", "l", "uː"], "pos": "FINAL", "stress": "PRIMARY", "text": "The ocean was a deep blue color.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "pool", "pron": ["p", "uː", "l"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "pool / pull contrast", "tier": "HARD", "type": "CONTRAST_PAIR"},
        {"word": "group", "pron": ["ɡ", "ɹ", "uː", "p"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "A small group gathered in the hall.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "food", "pron": ["f", "uː", "d"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Healthy food gives you lasting energy.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "v": [
        {"word": "voice", "pron": ["v", "ɔɪ", "s"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Her clear voice reached everyone in the room.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "river", "pron": ["ɹ", "ɪ", "v", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "The calm river flows toward the sea.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "leave", "pron": ["l", "iː", "v"], "pos": "FINAL", "stress": "PRIMARY", "text": "We must leave before dark.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "vest", "pron": ["v", "ɛ", "s", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "vest / west contrast", "tier": "HARD", "type": "CONTRAST_PAIR"},
        {"word": "travel", "pron": ["t", "ɹ", "æ", "v", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "They love to travel around the world.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "ŋ": [
        {"word": "sing", "pron": ["s", "ɪ", "ŋ"], "pos": "FINAL", "stress": "PRIMARY", "text": "Birds sing early in the morning.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "finger", "pron": ["f", "ɪ", "ŋ", "ɡ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "He pointed with his index finger.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "ring", "pron": ["ɹ", "ɪ", "ŋ"], "pos": "FINAL", "stress": "PRIMARY", "text": "ring / rim contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "long", "pron": ["l", "ɑː", "ŋ"], "pos": "FINAL", "stress": "PRIMARY", "text": "It was a long and pleasant journey.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "language", "pron": ["l", "æ", "ŋ", "ɡ", "w", "ɪ", "dʒ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Learning a new language opens many doors.", "tier": "HARD", "type": "NATURAL_SENTENCE"},
    ],
    "ɐ": [
        {"word": "butter", "pron": ["b", "ɐ", "t", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Spread the butter on the warm toast.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "cup", "pron": ["k", "ɐ", "p"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "cup / cap contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "mother", "pron": ["m", "ɐ", "ð", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Her mother greeted us warmly at the door.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "ɑː": [
        {"word": "car", "pron": ["k", "ɑː", "ɹ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "We drove the car down the coast.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "father", "pron": ["f", "ɑː", "ð", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "His father taught him to play guitar.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "calm", "pron": ["k", "ɑː", "m"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Stay calm during the test.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "heart", "pron": ["h", "ɑː", "ɹ", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "heart / hat contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
    ],
    "ɔ": [
        {"word": "thought", "pron": ["θ", "ɔ", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "I gave it some careful thought.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "law", "pron": ["l", "ɔ"], "pos": "FINAL", "stress": "PRIMARY", "text": "The new law was passed yesterday.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "caught", "pron": ["k", "ɔ", "t"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "caught / cot contrast", "tier": "HARD", "type": "CONTRAST_PAIR"},
        {"word": "daughter", "pron": ["d", "ɔ", "t", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Their daughter loves reading science books.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "ɔɪ": [
        {"word": "boy", "pron": ["b", "ɔɪ"], "pos": "FINAL", "stress": "PRIMARY", "text": "The little boy ran across the yard.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "coin", "pron": ["k", "ɔɪ", "n"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "He found an old silver coin.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "voice", "pron": ["v", "ɔɪ", "s"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Her voice was calm and steady.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "oil", "pron": ["ɔɪ", "l"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Add a few drops of olive oil.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "choice", "pron": ["tʃ", "ɔɪ", "s"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "choice / chase contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
    ],
    "əl": [
        {"word": "little", "pron": ["l", "ɪ", "t", "əl"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "A little patience solves many problems.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "people", "pron": ["p", "iː", "p", "əl"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "Many people attended the festival.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "bottle", "pron": ["b", "ɑː", "t", "əl"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "Recycle the glass bottle.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "travel", "pron": ["t", "ɹ", "æ", "v", "əl"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "travel / driver contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
    ],
    "ɚ": [
        {"word": "water", "pron": ["w", "ɑː", "t", "ɚ"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "Drink a glass of cold water.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "brother", "pron": ["b", "ɹ", "ʌ", "ð", "ɚ"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "My older brother lives in Chicago.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "dinner", "pron": ["d", "ɪ", "n", "ɚ"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "We enjoyed a delicious dinner.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "better", "pron": ["b", "ɛ", "t", "ɚ"], "pos": "FINAL", "stress": "UNSTRESSED", "text": "better / bitter contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
    ],
    "ɡ": [
        {"word": "game", "pron": ["ɡ", "eɪ", "m"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Let us play a friendly game.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "sugar", "pron": ["ʃ", "u", "ɡ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Please pass the bowl of sugar.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "dog", "pron": ["d", "ɔ", "ɡ"], "pos": "FINAL", "stress": "PRIMARY", "text": "The faithful dog waited by the gate.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "goat", "pron": ["ɡ", "oʊ", "t"], "pos": "INITIAL", "stress": "PRIMARY", "text": "goat / coat contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "begin", "pron": ["b", "ɪ", "ɡ", "ɪ", "n"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "We will begin the session shortly.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "ʃ": [
        {"word": "ship", "pron": ["ʃ", "ɪ", "p"], "pos": "INITIAL", "stress": "PRIMARY", "text": "A large cargo ship sailed into port.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "nation", "pron": ["n", "eɪ", "ʃ", "ən"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "The entire nation celebrated the victory.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "fish", "pron": ["f", "ɪ", "ʃ"], "pos": "FINAL", "stress": "PRIMARY", "text": "Colorful fish swam near the coral reef.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "shoe", "pron": ["ʃ", "uː"], "pos": "INITIAL", "stress": "PRIMARY", "text": "shoe / sue contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "special", "pron": ["s", "p", "ɛ", "ʃ", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Today is a very special occasion.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "ʒ": [
        {"word": "measure", "pron": ["m", "ɛ", "ʒ", "ɚ"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Carefully measure the width of the table.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "vision", "pron": ["v", "ɪ", "ʒ", "ən"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Clear vision requires good lighting.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "garage", "pron": ["ɡ", "ə", "ɹ", "ɑː", "ʒ"], "pos": "FINAL", "stress": "PRIMARY", "text": "Park the car inside the garage.", "tier": "HARD", "type": "NATURAL_SENTENCE"},
        {"word": "casual", "pron": ["k", "æ", "ʒ", "u", "əl"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "casual / catch contrast", "tier": "HARD", "type": "CONTRAST_PAIR"},
        {"word": "decision", "pron": ["d", "ɪ", "s", "ɪ", "ʒ", "ən"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "They reached a final decision.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
    ],
    "θ": [
        {"word": "think", "pron": ["θ", "ɪ", "ŋ", "k"], "pos": "INITIAL", "stress": "PRIMARY", "text": "Take your time to think carefully.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "method", "pron": ["m", "ɛ", "θ", "əd"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "This scientific method is very reliable.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "breath", "pron": ["b", "ɹ", "ɛ", "θ"], "pos": "FINAL", "stress": "PRIMARY", "text": "Take a deep breath and relax.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "thick", "pron": ["θ", "ɪ", "k"], "pos": "INITIAL", "stress": "PRIMARY", "text": "thick / sick contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "author", "pron": ["ɔ", "θ", "ɚ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "The famous author wrote a new novel.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "ᵻ": [
        {"word": "music", "pron": ["m", "j", "uː", "z", "ᵻ", "k"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "The music played softly in the background.", "tier": "MEDIUM", "type": "NATURAL_SENTENCE"},
        {"word": "rabbit", "pron": ["ɹ", "æ", "b", "ᵻ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "The wild rabbit hopped across the field.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "visit", "pron": ["v", "ɪ", "z", "ᵻ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "We plan to visit the historical museum.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "ticket", "pron": ["t", "ɪ", "k", "ᵻ", "t"], "pos": "MEDIAL", "stress": "UNSTRESSED", "text": "Keep your train ticket in a safe place.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
    "oː": [
        {"word": "door", "pron": ["d", "oː", "ɹ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "Please close the front door.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "four", "pron": ["f", "oː", "ɹ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "There are four seasons in the year.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "store", "pron": ["s", "t", "oː", "ɹ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "We bought fresh fruit from the store.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
        {"word": "floor", "pron": ["f", "l", "oː", "ɹ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "floor / flower contrast", "tier": "MEDIUM", "type": "CONTRAST_PAIR"},
        {"word": "morning", "pron": ["m", "oː", "ɹ", "n", "ɪ", "ŋ"], "pos": "MEDIAL", "stress": "PRIMARY", "text": "The early morning air was cool.", "tier": "EASY", "type": "NATURAL_SENTENCE"},
    ],
}


def generate_targeted_prompt_corpus() -> List[TargetedPromptItem]:
    """Generate deterministic, deduplicated research prompt corpus for all 26 deficient phonemes."""
    corpus: List[TargetedPromptItem] = []
    seen_prompts: Set[str] = set()

    for phone, items in TARGETED_PHONE_ELICITATION_SEEDS.items():
        for idx, item in enumerate(items):
            word = item["word"]
            pron = item["pron"]
            pos = item["pos"]
            stress = item["stress"]
            text = item["text"]
            tier = item["tier"]
            c_type = item["type"]

            # Neighboring phones description
            p_idx = pron.index(phone) if phone in pron else 0
            left = pron[p_idx - 1] if p_idx > 0 else "START"
            right = pron[p_idx + 1] if p_idx < len(pron) - 1 else "END"
            neighbors = f"{left}-{phone}-{right}"

            prompt_key = f"{phone}_{word}_{pos}"
            if prompt_key in seen_prompts:
                continue
            seen_prompts.add(prompt_key)

            p_id = f"prompt_{phone}_{word}_{idx:02d}".replace("ː", "L").replace("əl", "el").replace("ɚ", "er").replace("ᵻ", "ix")

            corpus.append(
                TargetedPromptItem(
                    promptId=p_id,
                    targetPhone=phone,
                    targetWord=word,
                    lexicalPronunciation=pron,
                    phonePosition=pos,
                    stressContext=stress,
                    neighboringPhones=neighbors,
                    expectedPronunciationVariant="STANDARD",
                    difficultyTier=tier,
                    promptText=text,
                    contextType=c_type,
                )
            )
    return corpus


# ---------------------------------------------------------------------------
# 5. Error-Type Taxonomy per Deficient Phoneme
# ---------------------------------------------------------------------------

class ErrorCategory(str, Enum):
    SUBSTITUTION = "SUBSTITUTION"
    DELETION = "DELETION"
    INSERTION = "INSERTION"
    DEVOICING = "DEVOICING"
    VOICING_CONFUSION = "VOICING_CONFUSION"
    VOWEL_QUALITY_SHIFT = "VOWEL_QUALITY_SHIFT"
    VOWEL_LENGTH_CONFUSION = "VOWEL_LENGTH_CONFUSION"
    PLACE_CONFUSION = "PLACE_CONFUSION"
    MANNER_CONFUSION = "MANNER_CONFUSION"
    RHOTICITY_ERROR = "RHOTICITY_ERROR"
    FINAL_CONSONANT_DELETION = "FINAL_CONSONANT_DELETION"


@dataclass
class PhoneErrorTaxonomyItem:
    targetPhone: str
    primaryErrorType: str
    commonSubstitutions: List[str]
    phonologicalMechanism: str
    highRiskL1Backgrounds: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


PHONE_ERROR_TAXONOMY: Dict[str, PhoneErrorTaxonomyItem] = {
    "aʊ": PhoneErrorTaxonomyItem("aʊ", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["oʊ", "aɪ", "ɑː"], "Monophthongization or offglide centralization", ["Mandarin", "Spanish", "Japanese"]),
    "b": PhoneErrorTaxonomyItem("b", ErrorCategory.DEVOICING.value, ["p", "v"], "Lack of voiced onset time or labial friction substitution", ["German", "Mandarin", "Spanish"]),
    "dʒ": PhoneErrorTaxonomyItem("dʒ", ErrorCategory.MANNER_CONFUSION.value, ["ʒ", "tʃ", "z", "j"], "De-affrication to fricative or devoicing", ["Spanish", "French", "Japanese", "Mandarin"]),
    "f": PhoneErrorTaxonomyItem("f", ErrorCategory.PLACE_CONFUSION.value, ["p", "h", "θ"], "Bilabial substitution or glottalization", ["Korean", "Japanese", "Tagalog"]),
    "h": PhoneErrorTaxonomyItem("h", ErrorCategory.DELETION.value, ["∅", "x", "f"], "H-dropping in onset or velar frication", ["French", "Italian", "Russian"]),
    "iː": PhoneErrorTaxonomyItem("iː", ErrorCategory.VOWEL_LENGTH_CONFUSION.value, ["ɪ", "eɪ"], "Tense/lax neutralization without duration contrast", ["Spanish", "Arabic", "Portuguese"]),
    "j": PhoneErrorTaxonomyItem("j", ErrorCategory.INSERTION.value, ["dʒ", "ʒ", "i"], "Affrication to /dʒ/ or vocalization", ["Spanish", "Brazilian Portuguese"]),
    "k": PhoneErrorTaxonomyItem("k", ErrorCategory.DEVOICING.value, ["ɡ", "x", "ʔ"], "Aspiration loss or glottal stop replacement", ["Mandarin", "Vietnamese", "French"]),
    "p": PhoneErrorTaxonomyItem("p", ErrorCategory.DEVOICING.value, ["b", "f", "ʔ"], "Aspiration deficit in onset or unreleased coda deletion", ["Arabic", "Korean", "Vietnamese"]),
    "tʃ": PhoneErrorTaxonomyItem("tʃ", ErrorCategory.MANNER_CONFUSION.value, ["ʃ", "ts", "t"], "De-affrication or alveolar dentalization", ["French", "Spanish", "Japanese"]),
    "u": PhoneErrorTaxonomyItem("u", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["uː", "oʊ", "ʌ"], "Tense/lax back vowel neutralization", ["Spanish", "Japanese", "Mandarin"]),
    "uː": PhoneErrorTaxonomyItem("uː", ErrorCategory.VOWEL_LENGTH_CONFUSION.value, ["u", "juː", "oʊ"], "Diphthongization or fronting", ["Mandarin", "French", "Spanish"]),
    "v": PhoneErrorTaxonomyItem("v", ErrorCategory.PLACE_CONFUSION.value, ["w", "b", "f"], "Labio-dental to labial-velar approximation confusion", ["German", "Hindi", "Spanish", "Mandarin"]),
    "ŋ": PhoneErrorTaxonomyItem("ŋ", ErrorCategory.PLACE_CONFUSION.value, ["n", "ŋɡ", "m"], "Alveolar fronting /n/ or stop epenthesis /ŋɡ/", ["Mandarin", "Spanish", "Russian"]),
    "ɐ": PhoneErrorTaxonomyItem("ɐ", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["ɑː", "æ", "ə"], "Central/back vowel quality confusion", ["Japanese", "French", "Italian"]),
    "ɑː": PhoneErrorTaxonomyItem("ɑː", ErrorCategory.VOWEL_LENGTH_CONFUSION.value, ["æ", "ʌ", "ɔ"], "Low-back vowel shortening or fronting", ["Mandarin", "Spanish", "Korean"]),
    "ɔ": PhoneErrorTaxonomyItem("ɔ", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["ɑː", "oʊ", "ʌ"], "Cot-caught merger overgeneralization or raising", ["Spanish", "Japanese", "Mandarin"]),
    "ɔɪ": PhoneErrorTaxonomyItem("ɔɪ", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["oʊ", "aɪ", "ɔ"], "Offglide reduction or vowel harmony shift", ["Mandarin", "Arabic"]),
    "əl": PhoneErrorTaxonomyItem("əl", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["l", "oʊ", "ə"], "Dark-L vocalization or vowel epenthesis", ["Japanese", "Mandarin", "Korean"]),
    "ɚ": PhoneErrorTaxonomyItem("ɚ", ErrorCategory.RHOTICITY_ERROR.value, ["ə", "ɑː", "ɹ"], "De-rhoticization to non-rhotic schwa", ["Mandarin", "Cantonese", "French", "German"]),
    "ɡ": PhoneErrorTaxonomyItem("ɡ", ErrorCategory.DEVOICING.value, ["k", "ɣ", "d"], "Coda devoicing or spirantization", ["German", "Russian", "Spanish"]),
    "ʃ": PhoneErrorTaxonomyItem("ʃ", ErrorCategory.PLACE_CONFUSION.value, ["s", "tʃ", "ɕ"], "Alveolar dentalization /s/ or alveolo-palatal shift", ["Spanish", "Mandarin", "Greek"]),
    "ʒ": PhoneErrorTaxonomyItem("ʒ", ErrorCategory.DEVOICING.value, ["ʃ", "dʒ", "z"], "Devoicing to /ʃ/ or affrication to /dʒ/", ["German", "Spanish", "Japanese"]),
    "θ": PhoneErrorTaxonomyItem("θ", ErrorCategory.PLACE_CONFUSION.value, ["s", "t", "f"], "Dental fricative stopping to /t/ or sibilantization to /s/", ["French", "German", "Japanese", "Mandarin", "Russian"]),
    "ᵻ": PhoneErrorTaxonomyItem("ᵻ", ErrorCategory.VOWEL_QUALITY_SHIFT.value, ["ɪ", "iː", "ə"], "Weak vowel fronting or full vowel restoration", ["Spanish", "Italian", "Mandarin"]),
    "oː": PhoneErrorTaxonomyItem("oː", ErrorCategory.VOWEL_LENGTH_CONFUSION.value, ["oʊ", "ɔː", "ɑː"], "Diphthongization or low-back quality shift", ["Mandarin", "Spanish", "Japanese"]),
}


# ---------------------------------------------------------------------------
# 6. L2 Dataset Search and Commercial License Registry
# ---------------------------------------------------------------------------

@dataclass
class L2DatasetCandidate:
    datasetName: str
    officialSource: str
    exactLicense: str
    commercialUsePermitted: bool
    redistributionRestrictions: str
    speakerCount: int
    l1Diversity: List[str]
    approxHours: float
    labelGranularity: str  # PHONE_SCORE, WORD_SCORE, ALIGNMENT_ONLY, PHONETIC_TRANSCRIPTION
    humanAnnotationQuality: str
    phoneErrorCoverage: str
    downloadableWithoutPrivateCredentials: bool
    suitableForModelFineTuning: bool
    auditStatus: str  # ACCEPTED_BASELINE, REJECTED_LICENSE, REJECTED_UNVERIFIED_LABELS, AUDITED_RESEARCH_CANDIDATE
    rejectionRationale: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


L2_DATASET_CANDIDATES: List[L2DatasetCandidate] = [
    L2DatasetCandidate(
        datasetName="speechocean762",
        officialSource="OpenSLR SLR101",
        exactLicense="CC BY 4.0",
        commercialUsePermitted=True,
        redistributionRestrictions="Attribution required; no additional restrictions",
        speakerCount=250,
        l1Diversity=["Mandarin"],
        approxHours=14.5,
        labelGranularity="PHONE_SCORE",
        humanAnnotationQuality="5 expert annotators with phone-level scores (0-10) and word-level accuracy/fluency/prosody",
        phoneErrorCoverage="Covers 48 CMU phones; 22 powered, 25 underpowered, 1 single-class",
        downloadableWithoutPrivateCredentials=True,
        suitableForModelFineTuning=True,
        auditStatus="ACCEPTED_BASELINE",
        rejectionRationale=None,
    ),
    L2DatasetCandidate(
        datasetName="L2-ARCTIC v5",
        officialSource="CNGL / LeVoice",
        exactLicense="CC BY-NC 4.0",
        commercialUsePermitted=False,
        redistributionRestrictions="Non-commercial clause prohibits production distribution and commercial derivative use",
        speakerCount=24,
        l1Diversity=["Arabic", "Mandarin", "Hindi", "Korean", "Spanish", "Vietnamese"],
        approxHours=27.0,
        labelGranularity="PHONETIC_TRANSCRIPTION",
        humanAnnotationQuality="Annotated phone substitutions, deletions, insertions (human verified alignments)",
        phoneErrorCoverage="High coverage of ESL phonetic substitutions across 6 distinct L1s",
        downloadableWithoutPrivateCredentials=True,
        suitableForModelFineTuning=False,
        auditStatus="REJECTED_LICENSE",
        rejectionRationale="CC BY-NC 4.0 non-commercial restriction violates commercial safety and unrestricted derivative usage.",
    ),
    L2DatasetCandidate(
        datasetName="EdAcc (Edinburgh Accented Speech)",
        officialSource="University of Edinburgh / OpenSLR",
        exactLicense="CC BY 4.0",
        commercialUsePermitted=True,
        redistributionRestrictions="Attribution required",
        speakerCount=200,
        l1Diversity=["50+ diverse global L1 accents"],
        approxHours=55.0,
        labelGranularity="ALIGNMENT_ONLY",
        humanAnnotationQuality="Orthographic transcriptions with forced alignments; lacks human phoneme-error scores",
        phoneErrorCoverage="Acoustically rich accented speech, but zero supervised human mispronunciation labels",
        downloadableWithoutPrivateCredentials=True,
        suitableForModelFineTuning=False,
        auditStatus="AUDITED_RESEARCH_CANDIDATE",
        rejectionRationale="Lacks phone-level pronunciation error ratings; suitable for unsupervised acoustic adaptation only.",
    ),
    L2DatasetCandidate(
        datasetName="EpaDB (Accented English from Spanish Learners)",
        officialSource="University of Buenos Aires / PLAP",
        exactLicense="Academic / Custom Non-Commercial",
        commercialUsePermitted=False,
        redistributionRestrictions="Non-commercial academic research only",
        speakerCount=50,
        l1Diversity=["Spanish"],
        approxHours=8.0,
        labelGranularity="PHONE_SCORE",
        humanAnnotationQuality="Expert phonetician error annotations on specific targeted phonetic contrasts",
        phoneErrorCoverage="Targeted Spanish L1 ESL errors (/v/-/b/, /s/-/z/, vowel contrasts)",
        downloadableWithoutPrivateCredentials=False,
        suitableForModelFineTuning=False,
        auditStatus="REJECTED_LICENSE",
        rejectionRationale="Restricted academic license prohibits commercial deployment.",
    ),
    L2DatasetCandidate(
        datasetName="AESRC 2020 (Accented English Speech Recognition Challenge)",
        officialSource="SpeechOcean / Interspeech 2020",
        exactLicense="Challenge Participant Agreement (Proprietary)",
        commercialUsePermitted=False,
        redistributionRestrictions="Restricted to challenge evaluation; no commercial or redistribution rights",
        speakerCount=300,
        l1Diversity=["8 regional accents (Chinese, Indian, Japanese, Korean, Russian, etc.)"],
        approxHours=160.0,
        labelGranularity="ALIGNMENT_ONLY",
        humanAnnotationQuality="Utterance transcriptions and accent labels; zero phone error scoring",
        phoneErrorCoverage="Unsupervised accent acoustic diversity only",
        downloadableWithoutPrivateCredentials=False,
        suitableForModelFineTuning=False,
        auditStatus="REJECTED_LICENSE",
        rejectionRationale="Proprietary challenge agreement prohibits open distribution and commercial deployment.",
    ),
]


# ---------------------------------------------------------------------------
# 7. Human Data Collection and Double-Annotation Protocol
# ---------------------------------------------------------------------------

@dataclass
class HumanL2AnnotationRecord:
    recordId: str
    speakerId: str
    promptId: str
    audioPath: str
    targetWord: str
    targetPhone: str
    phonePosition: str
    recordingEnvironment: Dict[str, Any]
    annotatorA_correct: Optional[bool] = None
    annotatorA_errorType: Optional[str] = None
    annotatorA_observedPhone: Optional[str] = None
    annotatorA_confidence: Optional[float] = None
    annotatorB_correct: Optional[bool] = None
    annotatorB_errorType: Optional[str] = None
    annotatorB_observedPhone: Optional[str] = None
    annotatorB_confidence: Optional[float] = None
    adjudicator_correct: Optional[bool] = None
    adjudicator_errorType: Optional[str] = None
    adjudicator_observedPhone: Optional[str] = None
    adjudicationStatus: str = "PENDING_ANNOTATION"  # PENDING_ANNOTATION, AGREED, ADJUDICATED, REJECTED_AUDIO

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def calculate_inter_annotator_agreement(
    records: List[HumanL2AnnotationRecord],
) -> Dict[str, Any]:
    """Compute Cohen's Kappa and observed agreement across double-annotated items."""
    completed = [r for r in records if r.annotatorA_correct is not None and r.annotatorB_correct is not None]
    if not completed:
        return {
            "status": "NOT_PERFORMED",
            "evaluatedItems": 0,
            "observedAgreement": None,
            "cohensKappa": None,
            "interpretation": "Requires independent human double-annotation.",
        }

    # Confusion matrix
    a_pos = [1 if r.annotatorA_correct else 0 for r in completed]
    b_pos = [1 if r.annotatorB_correct else 0 for r in completed]
    n = len(completed)
    po = sum(1 for a, b in zip(a_pos, b_pos) if a == b) / float(n)
    p_a1 = sum(a_pos) / float(n)
    p_b1 = sum(b_pos) / float(n)
    pe = (p_a1 * p_b1) + ((1.0 - p_a1) * (1.0 - p_b1))
    kappa = (po - pe) / (1.0 - pe) if pe < 1.0 else 1.0

    return {
        "status": "COMPLETED",
        "evaluatedItems": n,
        "observedAgreement": float(po),
        "cohensKappa": float(kappa),
        "interpretation": "Substantial agreement" if kappa > 0.6 else "Moderate/fair agreement",
    }


# ---------------------------------------------------------------------------
# 8. Synthetic Error Research (Strictly Isolated Diagnostics)
# ---------------------------------------------------------------------------

@dataclass
class SyntheticErrorItem:
    syntheticId: str
    sourceUtteranceId: str
    originalPhone: str
    corruptedPhone: str
    corruptionType: str  # SUBSTITUTION, DELETION, DURATION_DISTORTION, NOISE_INJECTION
    syntheticSeverity: float
    rawGopBefore: float
    rawGopAfter: float
    deltaGop: float
    isSynthetic: bool = True  # Strict invariant tag

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def assert_human_synthetic_isolation(
    evaluation_dataset: List[Dict[str, Any]],
) -> None:
    """Strict gate asserting that synthetic items never contaminate human error evaluation."""
    for idx, item in enumerate(evaluation_dataset):
        if item.get("isSynthetic") is True or item.get("syntheticId") is not None:
            raise ValueError(
                f"INVARIANT VIOLATION: Synthetic error item detected at index {idx} in human evaluation dataset! "
                "Synthetic data must remain strictly isolated for diagnostic stress-testing only."
            )


# ---------------------------------------------------------------------------
# 9. Fine-Tuning Readiness Assessment Gate
# ---------------------------------------------------------------------------

@dataclass
class FineTuningReadinessAssessment:
    readinessStatus: str  # NOT_READY, HEAD_ONLY_READY, PARTIAL_FINE_TUNE_READY, FULL_FINE_TUNE_READY
    evaluatedCriteria: Dict[str, Dict[str, Any]]
    blockingDeficits: List[str]
    overfittingRisk: str
    recommendedNextStep: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def evaluate_fine_tuning_readiness(
    human_l2_speakers: int,
    powered_phones_count: int,
    underpowered_phones_count: int,
    single_class_phones_count: int,
    independent_l2_corpora_count: int,
    cross_channel_l2_hours: float,
) -> FineTuningReadinessAssessment:
    """Rigorous evidence-based gate determining whether data volume, balance, and diversity warrant model fine-tuning."""
    criteria = {
        "speaker_diversity": {
            "current": human_l2_speakers,
            "planning_heuristic_target": 500,
            "met": human_l2_speakers >= 500,
            "notes": f"Measured {human_l2_speakers} L2 speakers is insufficient to prevent speaker memorization on 317M parameter backbone",
        },
        "phone_coverage": {
            "current_powered": powered_phones_count,
            "required_powered": 48,
            "met": underpowered_phones_count == 0 and single_class_phones_count == 0,
            "notes": f"Measured {underpowered_phones_count} underpowered and {single_class_phones_count} single-class phones lack positive/negative error supervision",
        },
        "channel_diversity": {
            "current_hours": cross_channel_l2_hours,
            "planning_heuristic_hours": 50.0,
            "met": cross_channel_l2_hours >= 50.0,
            "notes": f"Measured {cross_channel_l2_hours}h of L2 speech is concentrated in a single recording campaign without multi-channel diversity",
        },
        "independent_corpora": {
            "current": independent_l2_corpora_count,
            "required_min": 2,
            "met": independent_l2_corpora_count >= 2,
            "notes": f"Only {independent_l2_corpora_count} verified commercial L2 dataset available (SpeechOcean762); lacks independent validation corpus",
        },
    }

    blocking = []
    if not criteria["speaker_diversity"]["met"]:
        blocking.append("Speaker diversity deficit (planning target: >= 500 L2 speakers)")
    if not criteria["phone_coverage"]["met"]:
        blocking.append(f"Phone coverage deficit ({underpowered_phones_count} underpowered and {single_class_phones_count} single-class phonemes lack error supervision)")
    if not criteria["channel_diversity"]["met"]:
        blocking.append("Acoustic channel deficit (planning target: >= 50h multi-channel L2 speech)")
    if not criteria["independent_corpora"]["met"]:
        blocking.append("Single-corpus dependency (no independent commercial validation corpus to detect memorization)")

    # Status determination based on empirical deficits
    if len(blocking) >= 3:
        status = "NOT_READY"
        risk = "EXTREME: Fine-tuning on single-source 14.5h dataset will cause severe catastrophic forgetting and speaker memorization."
        rec = "Execute targeted L2 data collection across 26 deficient phonemes and multi-channel environments prior to unfreezing weights."
    elif len(blocking) >= 1:
        status = "HEAD_ONLY_READY"
        risk = "HIGH: Linear probe / CTC head adaptation only; backbone must remain strictly frozen."
        rec = "Limit any experimental adaptation to lightweight linear projection or experimental candidate LoRA adapters on calibration partition."
    else:
        status = "FULL_FINE_TUNE_READY"
        risk = "LOW: Data volume, phone balance, and acoustic diversity sufficient for stable parameter updates."
        rec = "Proceed with staged learning rate schedule and validation early-stopping."

    return FineTuningReadinessAssessment(
        readinessStatus=status,
        evaluatedCriteria=criteria,
        blockingDeficits=blocking,
        overfittingRisk=risk,
        recommendedNextStep=rec,
    )


# ---------------------------------------------------------------------------
# 10. Portable Model Checkpoint Specification
# ---------------------------------------------------------------------------

PORTABLE_CHECKPOINT_SCHEMA: Dict[str, Any] = {
    "directoryName": "english-coach-pronunciation-v1",
    "requiredFiles": [
        "config.json",
        "model.safetensors",
        "processor/preprocessor_config.json",
        "processor/tokenizer_config.json",
        "processor/vocab.json",
        "phone_inventory.json",
        "pronunciation_rules.json",
        "training_manifest_hash.json",
        "evaluation_report.json",
        "model_card.md",
    ],
    "standaloneRequirements": [
        "Must be loadable via HuggingFace Transformers and PyTorch without ai-service application dependencies",
        "Must include exact SHA-256 digests in training_manifest_hash.json",
        "Must document evaluation metrics and demographic parity in evaluation_report.json",
    ],
}


# ---------------------------------------------------------------------------
# 11. Frozen Baseline Comparison Metrics
# ---------------------------------------------------------------------------

@dataclass
class FrozenBaselineMetrics:
    modelId: str
    modelRevision: str
    primaryRocAuc: float
    primaryPrAuc: float
    primaryEer: float
    primaryRocAucCi95: List[float]
    primaryPrAucCi95: List[float]
    primaryEerCi95: List[float]
    adultPrimaryRocAuc: float
    childPrimaryRocAuc: float
    sensitivityRocAuc: float
    sensitivityPrAuc: float
    sensitivityEer: float
    wordAggregationRho: float  # minimum aggregator
    browserUtteranceGopMedian: float
    libriSpeechDevCleanGopMedian: float
    speechOceanGopMedian: float
    studioVsSpeechOceanGap: float
    speechOceanVsBrowserGap: float
    studioVsBrowserGap: float
    inferenceThroughputUttPerSec: float
    inferenceLatencyMsPerUtt: float
    peakVramMb: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


FROZEN_SHD_2B2C_BASELINE = FrozenBaselineMetrics(
    modelId="facebook/wav2vec2-lv-60-espeak-cv-ft",
    modelRevision="ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4",
    primaryRocAuc=0.885882,
    primaryPrAuc=0.264768,
    primaryEer=0.193256,
    primaryRocAucCi95=[0.870848, 0.902914],
    primaryPrAucCi95=[0.188954, 0.331760],
    primaryEerCi95=[0.171053, 0.209521],
    adultPrimaryRocAuc=0.891035,
    childPrimaryRocAuc=0.869838,
    sensitivityRocAuc=0.717973,
    sensitivityPrAuc=0.358241,
    sensitivityEer=0.339255,
    wordAggregationRho=0.336845,
    browserUtteranceGopMedian=-2.4656,
    libriSpeechDevCleanGopMedian=4.0476,
    speechOceanGopMedian=1.0606,
    studioVsSpeechOceanGap=2.9870,
    speechOceanVsBrowserGap=3.5262,
    studioVsBrowserGap=6.5132,
    inferenceThroughputUttPerSec=5.80,
    inferenceLatencyMsPerUtt=172.3,
    peakVramMb=1986.0,
)
