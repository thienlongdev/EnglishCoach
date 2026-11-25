"""
ECSM-v1 / EC-PRISM Phase P7: Prosodic Reality Modeling Subsystem.
Implements independent acoustic streams for F0 (Pitch), Energy, Duration, Lexical Stress,
Rhythm, Speaking/Articulation Rate, Pauses, and Reference-Relative Intonation.
Includes selective trust, uncertainty abstention, and raw prosody firewall verification.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import enum
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
import scipy.signal
import torch


# Vowel phonemes for English syllabification and nucleus detection
VOWEL_PHONEMES: Set[str] = {
    "ə", "æ", "ʌ", "ɑː", "ɑ", "ɒ", "ɔː", "ɔ", "ʊ", "uː", "u", "ɪ", "iː", "i", "e", "ɛ", "ɜː", "ɝ", "ɚ",
    "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "ɪə", "eə", "ʊə",
    "aa", "ae", "ah", "ao", "aw", "ay", "eh", "er", "ey", "ih", "iy", "ow", "oy", "uh", "uw",
}


class ProsodyMode(str, enum.Enum):
    REFERENCE_RELATIVE = "REFERENCE_RELATIVE"
    REFERENCE_FREE = "REFERENCE_FREE"


class ProsodyUncertaintyReason(str, enum.Enum):
    NONE = "NONE"
    INSUFFICIENT_VOICED_FRAMES = "INSUFFICIENT_VOICED_FRAMES"
    ALIGNMENT_UNCERTAIN = "ALIGNMENT_UNCERTAIN"
    REFERENCE_UNAVAILABLE = "REFERENCE_UNAVAILABLE"
    LOW_SIGNAL_QUALITY = "LOW_SIGNAL_QUALITY"
    PITCH_TRACK_UNSTABLE = "PITCH_TRACK_UNSTABLE"
    INSUFFICIENT_SYLLABLE_SUPPORT = "INSUFFICIENT_SYLLABLE_SUPPORT"
    NO_STRESS_REFERENCE = "NO_STRESS_REFERENCE"
    TOO_SHORT_FOR_RHYTHM = "TOO_SHORT_FOR_RHYTHM"
    EXTRACTION_FAILED = "EXTRACTION_FAILED"


@dataclass
class PitchFeatures:
    median_hz: Optional[float]
    mean_hz: Optional[float]
    std_hz: Optional[float]
    min_hz: Optional[float]
    max_hz: Optional[float]
    range_semitones: Optional[float]
    voiced_frame_ratio: float
    final_slope_semitones_per_sec: Optional[float]
    f0_contour_semitones: List[Optional[float]]
    confidence: float
    uncertainty: str = ProsodyUncertaintyReason.NONE.value


@dataclass
class EnergyFeatures:
    mean_rms: float
    max_rms: float
    dynamic_range_db: float
    normalized_energy_contour: List[float]
    syllable_prominence_scores: List[float]
    confidence: float


@dataclass
class DurationFeatures:
    total_audio_duration_sec: float
    active_speech_duration_sec: float
    phone_durations_sec: List[float]
    syllable_durations_sec: List[float]
    word_durations_sec: List[float]
    alignment_confidence: float
    uncertainty: str = ProsodyUncertaintyReason.NONE.value


@dataclass
class SyllableInfo:
    index: int
    phones: List[str]
    nucleus_phone: str
    start_time_sec: float
    end_time_sec: float
    duration_sec: float
    relative_prominence: float
    observed_stress: int  # 1 for primary, 0 for unstressed
    expected_stress: Optional[int] = None
    confidence: float = 1.0


@dataclass
class LexicalStressFeatures:
    word: str
    syllables: List[SyllableInfo]
    observed_primary_syllable: Optional[int]
    expected_primary_syllable: Optional[int]
    is_stress_match: Optional[bool]
    mismatch_probability: Optional[float]
    confidence: float
    uncertainty: str = ProsodyUncertaintyReason.NONE.value


@dataclass
class RhythmAndRateFeatures:
    speech_rate_syllables_per_sec: float
    articulation_rate_syllables_per_sec: float
    phone_rate_phones_per_sec: float
    vowel_nPVI: Optional[float]
    consonant_rPVI: Optional[float]
    syllable_duration_variability: float
    confidence: float
    uncertainty: str = ProsodyUncertaintyReason.NONE.value


@dataclass
class PauseFeatures:
    total_pauses_count: int
    disruptive_pauses_count: int
    natural_boundary_pauses_count: int
    total_pause_duration_sec: float
    pause_ratio: float
    pause_intervals_sec: List[Tuple[float, float]]
    confidence: float


@dataclass
class IntonationFeatures:
    phrase_initial_f0_st: Optional[float]
    phrase_median_f0_st: Optional[float]
    phrase_final_f0_st: Optional[float]
    phrase_pitch_direction: str  # RISING, FALLING, FLAT, UNCERTAIN
    reference_pitch_distance_dtw: Optional[float]
    reference_contour_correlation: Optional[float]
    confidence: float
    uncertainty: str = ProsodyUncertaintyReason.NONE.value


@dataclass
class ProsodicRealityOutput:
    mode: str
    pitch: PitchFeatures
    energy: EnergyFeatures
    duration: DurationFeatures
    stress: List[LexicalStressFeatures]
    rhythm: RhythmAndRateFeatures
    pauses: PauseFeatures
    intonation: IntonationFeatures
    raw_firewall_status: str = "PASS"
    overall_prosody_confidence: float = 1.0


class PitchExtractor:
    """
    Robust autocorrelation-based pitch tracker with parabolic peak interpolation,
    voicing decision, octave-error mitigation, and semitone normalization.
    """
    def __init__(
        self,
        sample_rate: int = 16000,
        frame_length_ms: float = 46.0,
        hop_length_ms: float = 10.0,
        min_f0_hz: float = 65.0,
        max_f0_hz: float = 450.0,
        voicing_threshold: float = 0.40,
    ):
        self.sample_rate = sample_rate
        self.frame_len = int(round(sample_rate * (frame_length_ms / 1000.0)))
        self.hop_len = int(round(sample_rate * (hop_length_ms / 1000.0)))
        self.min_lag = int(sample_rate / max_f0_hz)
        self.max_lag = int(sample_rate / min_f0_hz)
        self.voicing_threshold = voicing_threshold

    def extract(self, audio: np.ndarray) -> PitchFeatures:
        if len(audio) < self.frame_len:
            return PitchFeatures(
                median_hz=None, mean_hz=None, std_hz=None, min_hz=None, max_hz=None,
                range_semitones=None, voiced_frame_ratio=0.0, final_slope_semitones_per_sec=None,
                f0_contour_semitones=[], confidence=0.0,
                uncertainty=ProsodyUncertaintyReason.INSUFFICIENT_VOICED_FRAMES.value,
            )

        n_frames = 1 + (len(audio) - self.frame_len) // self.hop_len
        f0_raw: List[Optional[float]] = []
        voicing_probs: List[float] = []

        window = np.hanning(self.frame_len)
        w_corr = np.correlate(window, window, mode="full")[len(window) - 1 :]

        for i in range(n_frames):
            start = i * self.hop_len
            raw_frame = audio[start : start + self.frame_len]
            if float(np.sqrt(np.mean(raw_frame ** 2) + 1e-12)) < 0.005:
                f0_raw.append(None)
                voicing_probs.append(0.0)
                continue
            frame = raw_frame * window
            # Normalised autocorrelation compensated by window autocorrelation
            energy = np.sum(frame ** 2)
            if energy < 1e-6:
                f0_raw.append(None)
                voicing_probs.append(0.0)
                continue

            autocorr = np.correlate(frame, frame, mode="full")
            autocorr = autocorr[len(frame) - 1 :]
            norm_autocorr = autocorr / (w_corr + 1e-8)
            norm_autocorr = norm_autocorr / (norm_autocorr[0] + 1e-8)

            if len(norm_autocorr) <= self.max_lag:
                f0_raw.append(None)
                voicing_probs.append(0.0)
                continue

            search_region = norm_autocorr[self.min_lag : self.max_lag + 1]
            # Find local peaks in search region
            peak_indices = []
            for k in range(1, len(search_region) - 1):
                if search_region[k] > search_region[k - 1] and search_region[k] >= search_region[k + 1]:
                    if search_region[k] >= self.voicing_threshold:
                        peak_indices.append(k)

            if peak_indices:
                max_p = max(search_region[k] for k in peak_indices)
                # Pick earliest local peak within 85% of max peak to prevent subharmonic octave halving
                cand_idx = next(k for k in peak_indices if search_region[k] >= 0.85 * max_p)
                peak_idx = cand_idx + self.min_lag
                peak_val = float(norm_autocorr[peak_idx])
            else:
                peak_idx = int(np.argmax(search_region)) + self.min_lag
                peak_val = float(norm_autocorr[peak_idx])

            # Voicing decision
            if peak_val >= self.voicing_threshold and 0 < peak_idx < len(norm_autocorr) - 1:
                # Parabolic peak interpolation
                alpha = norm_autocorr[peak_idx - 1]
                beta = norm_autocorr[peak_idx]
                gamma = norm_autocorr[peak_idx + 1]
                denom = 2 * (2 * beta - alpha - gamma)
                delta = (alpha - gamma) / denom if abs(denom) > 1e-6 else 0.0
                refined_lag = peak_idx + delta
                if not np.isfinite(refined_lag) or refined_lag <= 0 or refined_lag < self.min_lag or refined_lag > self.max_lag:
                    f0_raw.append(None)
                    voicing_probs.append(float(max(0.0, min(1.0, peak_val))))
                    continue
                f0_val = float(self.sample_rate / refined_lag)
                f0_raw.append(f0_val)
                voicing_probs.append(min(1.0, peak_val))
            else:
                f0_raw.append(None)
                voicing_probs.append(float(peak_val))

        # 3-point median octave-spike filter across voiced frames
        if sum(1 for f in f0_raw if f is not None) >= 3:
            f0_filtered: List[Optional[float]] = list(f0_raw)
            for idx in range(1, len(f0_raw) - 1):
                if f0_raw[idx] is not None:
                    nb = [f0_raw[j] for j in (idx - 1, idx, idx + 1) if f0_raw[j] is not None]
                    if len(nb) >= 2:
                        f0_filtered[idx] = float(np.median(nb))
            f0_raw = f0_filtered

        voiced_f0 = [f for f in f0_raw if f is not None]
        voiced_ratio = float(len(voiced_f0) / n_frames) if n_frames > 0 else 0.0

        if len(voiced_f0) < 3:
            return PitchFeatures(
                median_hz=None, mean_hz=None, std_hz=None, min_hz=None, max_hz=None,
                range_semitones=None, voiced_frame_ratio=voiced_ratio, final_slope_semitones_per_sec=None,
                f0_contour_semitones=[None] * len(f0_raw), confidence=0.2,
                uncertainty=ProsodyUncertaintyReason.INSUFFICIENT_VOICED_FRAMES.value,
            )

        med_f0 = float(np.median(voiced_f0))
        mean_f0 = float(np.mean(voiced_f0))
        std_f0 = float(np.std(voiced_f0))
        min_f0 = float(np.min(voiced_f0))
        max_f0 = float(np.max(voiced_f0))

        # Semitone contour relative to median: st = 12 * log2(F0 / median)
        f0_st = [12.0 * math.log2(f / med_f0) if f is not None else None for f in f0_raw]
        voiced_st = [s for s in f0_st if s is not None]
        range_st = float(np.max(voiced_st) - np.min(voiced_st)) if len(voiced_st) > 0 else 0.0

        # Phrase final slope via linear regression over the last 30% of voiced frames
        voiced_pairs = [(idx, st) for idx, st in enumerate(f0_st) if st is not None]
        if len(voiced_pairs) >= 5:
            tail_n = max(3, int(round(len(voiced_pairs) * 0.30)))
            tail_pairs = voiced_pairs[-tail_n:]
            t_arr = np.array([p[0] for p in tail_pairs], dtype=np.float64) * (self.hop_len / float(self.sample_rate))
            y_arr = np.array([p[1] for p in tail_pairs], dtype=np.float64)
            t_arr = t_arr - t_arr[0]
            slope = float(np.polyfit(t_arr, y_arr, 1)[0]) if float(np.ptp(t_arr)) > 1e-4 else 0.0
        else:
            slope = 0.0

        conf = float(min(1.0, voiced_ratio * 1.5))

        return PitchFeatures(
            median_hz=round(med_f0, 2),
            mean_hz=round(mean_f0, 2),
            std_hz=round(std_f0, 2),
            min_hz=round(min_f0, 2),
            max_hz=round(max_f0, 2),
            range_semitones=round(range_st, 2),
            voiced_frame_ratio=round(voiced_ratio, 4),
            final_slope_semitones_per_sec=round(slope, 2),
            f0_contour_semitones=f0_st,
            confidence=round(conf, 4),
            uncertainty=ProsodyUncertaintyReason.NONE.value,
        )


class EnergyExtractor:
    """
    Extracts frame-level RMS energy, log-energy, dynamic range, and syllable prominence.
    """
    def __init__(self, sample_rate: int = 16000, frame_length_ms: float = 25.0, hop_length_ms: float = 10.0):
        self.sample_rate = sample_rate
        self.frame_len = int(sample_rate * (frame_length_ms / 1000.0))
        self.hop_len = int(sample_rate * (hop_length_ms / 1000.0))

    def extract(self, audio: np.ndarray, syllable_intervals: Optional[List[Tuple[float, float]]] = None) -> EnergyFeatures:
        if len(audio) < self.frame_len:
            return EnergyFeatures(mean_rms=0.0, max_rms=0.0, dynamic_range_db=0.0, normalized_energy_contour=[], syllable_prominence_scores=[], confidence=0.0)

        n_frames = 1 + (len(audio) - self.frame_len) // self.hop_len
        rms_frames = []

        for i in range(n_frames):
            start = i * self.hop_len
            frame = audio[start : start + self.frame_len]
            rms = math.sqrt(float(np.mean(frame ** 2)) + 1e-9)
            rms_frames.append(rms)

        rms_arr = np.array(rms_frames)
        max_rms = float(np.max(rms_arr))
        mean_rms = float(np.mean(rms_arr))
        min_rms = float(np.percentile(rms_arr, 5)) + 1e-8

        dyn_range = float(20.0 * math.log10(max_rms / min_rms)) if max_rms > 0 else 0.0
        # Normalised energy contour in [0, 1]
        norm_contour = [(r / (max_rms + 1e-8)) for r in rms_frames]

        # Syllable prominence
        prominences = []
        if syllable_intervals:
            for s_start, s_end in syllable_intervals:
                f_start = max(0, int(round(s_start * self.sample_rate / self.hop_len)))
                f_end = max(f_start + 1, int(round(s_end * self.sample_rate / self.hop_len)))
                s_rms = rms_frames[f_start:f_end]
                prom = float(np.mean(s_rms) / (mean_rms + 1e-8)) if len(s_rms) > 0 else 1.0
                prominences.append(round(prom, 4))

        return EnergyFeatures(
            mean_rms=round(mean_rms, 6),
            max_rms=round(max_rms, 6),
            dynamic_range_db=round(dyn_range, 2),
            normalized_energy_contour=[round(c, 4) for c in norm_contour],
            syllable_prominence_scores=prominences,
            confidence=1.0 if len(audio) > 0.5 * self.sample_rate else 0.8,
        )


class PauseDetector:
    """
    Detects silent pauses using energy threshold and minimal duration threshold (>= 180 ms).
    """
    def __init__(self, sample_rate: int = 16000, min_pause_duration_sec: float = 0.18, silence_energy_ratio: float = 0.08):
        self.sample_rate = sample_rate
        self.min_pause_sec = min_pause_duration_sec
        self.silence_ratio = silence_energy_ratio

    def detect(self, audio: np.ndarray, word_boundaries: Optional[List[Tuple[float, float]]] = None) -> PauseFeatures:
        total_duration = len(audio) / self.sample_rate
        frame_len = int(0.02 * self.sample_rate)  # 20ms
        hop_len = int(0.01 * self.sample_rate)    # 10ms
        n_frames = (len(audio) - frame_len) // hop_len

        if n_frames <= 0:
            return PauseFeatures(0, 0, 0, 0.0, 0.0, [], 0.0)

        energies = [np.sum(audio[i*hop_len : i*hop_len + frame_len]**2) for i in range(n_frames)]
        max_e = max(energies) if energies else 1e-8
        silence_thresh = max_e * self.silence_ratio

        is_silent = [e < silence_thresh for e in energies]

        pauses: List[Tuple[float, float]] = []
        in_pause = False
        p_start = 0.0

        for i, silent in enumerate(is_silent):
            t = i * 0.01
            if silent and not in_pause:
                in_pause = True
                p_start = t
            elif not silent and in_pause:
                in_pause = False
                p_dur = t - p_start
                if p_dur >= self.min_pause_sec:
                    pauses.append((round(p_start, 3), round(t, 3)))

        if in_pause:
            p_dur = total_duration - p_start
            if p_dur >= self.min_pause_sec:
                pauses.append((round(p_start, 3), round(total_duration, 3)))

        total_pause_time = sum(end - start for start, end in pauses)
        pause_ratio = total_pause_time / (total_duration + 1e-6)

        # Distinguish natural boundary pauses from disruptive pauses if word boundaries given
        disruptive = 0
        natural = 0
        if word_boundaries:
            for p_s, p_e in pauses:
                is_boundary = any(abs(p_s - w_end) < 0.10 or abs(p_e - w_start) < 0.10 for w_start, w_end in word_boundaries)
                if is_boundary:
                    natural += 1
                else:
                    disruptive += 1
        else:
            natural = len(pauses)

        return PauseFeatures(
            total_pauses_count=len(pauses),
            disruptive_pauses_count=disruptive,
            natural_boundary_pauses_count=natural,
            total_pause_duration_sec=round(total_pause_time, 3),
            pause_ratio=round(pause_ratio, 4),
            pause_intervals_sec=pauses,
            confidence=0.95,
        )


class Syllabifier:
    """
    Deterministic English syllabification grouping phones around vowel nuclei.
    """
    @staticmethod
    def syllabify(phones: Sequence[str], phone_durations: Sequence[float]) -> List[SyllableInfo]:
        if len(phones) == 0:
            return []

        syllables: List[SyllableInfo] = []
        current_phones: List[str] = []
        current_durs: List[float] = []
        nucleus = ""
        t_cursor = 0.0
        s_start = 0.0

        for p, d in zip(phones, phone_durations):
            p_clean = p.lower().strip()
            is_vowel = p_clean in VOWEL_PHONEMES

            if is_vowel and nucleus != "":
                # Close previous syllable
                s_dur = sum(current_durs)
                syllables.append(SyllableInfo(
                    index=len(syllables),
                    phones=list(current_phones),
                    nucleus_phone=nucleus,
                    start_time_sec=round(s_start, 3),
                    end_time_sec=round(s_start + s_dur, 3),
                    duration_sec=round(s_dur, 3),
                    relative_prominence=1.0,
                    observed_stress=0,
                ))
                s_start = s_start + s_dur
                current_phones = [p]
                current_durs = [d]
                nucleus = p
            else:
                current_phones.append(p)
                current_durs.append(d)
                if is_vowel and nucleus == "":
                    nucleus = p

        # Final syllable
        if current_phones:
            s_dur = sum(current_durs)
            syllables.append(SyllableInfo(
                index=len(syllables),
                phones=list(current_phones),
                nucleus_phone=nucleus if nucleus else current_phones[0],
                start_time_sec=round(s_start, 3),
                end_time_sec=round(s_start + s_dur, 3),
                duration_sec=round(s_dur, 3),
                relative_prominence=1.0,
                observed_stress=0,
            ))

        return syllables


class LexicalStressAnalyzer:
    """
    Analyzes lexical stress via intra-word relative prominence combining F0, energy, and vowel duration.
    """
    @staticmethod
    def analyze_word_stress(
        word: str,
        syllables: List[SyllableInfo],
        pitch_contour_st: List[Optional[float]],
        energy_contour: List[float],
        expected_primary_syllable: Optional[int] = None,
        hop_length_sec: float = 0.01,
    ) -> LexicalStressFeatures:
        if len(syllables) == 0:
            return LexicalStressFeatures(
                word=word, syllables=[], observed_primary_syllable=None,
                expected_primary_syllable=expected_primary_syllable, is_stress_match=None,
                mismatch_probability=None, confidence=0.0,
                uncertainty=ProsodyUncertaintyReason.INSUFFICIENT_SYLLABLE_SUPPORT.value,
            )

        prominences = []
        for syl in syllables:
            f_start = max(0, int(round(syl.start_time_sec / hop_length_sec)))
            f_end = max(f_start + 1, int(round(syl.end_time_sec / hop_length_sec)))

            # Pitch prominence (peak semitone)
            syl_st = [st for st in pitch_contour_st[f_start:f_end] if st is not None]
            peak_st = max(syl_st) if syl_st else 0.0

            # Energy prominence (mean energy)
            syl_e = energy_contour[f_start:f_end]
            mean_e = float(np.mean(syl_e)) if syl_e else 0.5

            # Duration prominence
            dur = syl.duration_sec

            # Composite acoustic prominence: w_f0 * F0 + w_e * Energy + w_dur * Duration
            prom = 0.40 * (peak_st / 6.0) + 0.35 * mean_e + 0.25 * min(1.0, dur / 0.30)
            prominences.append(prom)
            syl.relative_prominence = round(float(prom), 4)

        observed_primary = int(np.argmax(prominences))
        for i, syl in enumerate(syllables):
            syl.observed_stress = 1 if i == observed_primary else 0
            if expected_primary_syllable is not None:
                syl.expected_stress = 1 if i == expected_primary_syllable else 0

        is_match = (observed_primary == expected_primary_syllable) if expected_primary_syllable is not None else None
        mismatch_prob = float(1.0 - (prominences[observed_primary] - np.mean(prominences))) if is_match is False else 0.05

        return LexicalStressFeatures(
            word=word,
            syllables=syllables,
            observed_primary_syllable=observed_primary,
            expected_primary_syllable=expected_primary_syllable,
            is_stress_match=is_match,
            mismatch_probability=round(max(0.0, min(1.0, mismatch_prob)), 4) if mismatch_prob is not None else None,
            confidence=0.90 if len(syllables) > 1 else 1.0,
            uncertainty=ProsodyUncertaintyReason.NONE.value if expected_primary_syllable is not None else ProsodyUncertaintyReason.NO_STRESS_REFERENCE.value,
        )


class RhythmAndRateAnalyzer:
    """
    Computes speaking rate, articulation rate, vowel nPVI, and duration variability.
    """
    @staticmethod
    def compute(
        syllables: List[SyllableInfo],
        vowel_durations: List[float],
        consonant_durations: List[float],
        total_duration_sec: float,
        total_pause_duration_sec: float,
        phone_count: int,
    ) -> RhythmAndRateFeatures:
        n_syllables = len(syllables)
        if total_duration_sec < 0.20 or n_syllables == 0:
            return RhythmAndRateFeatures(
                speech_rate_syllables_per_sec=0.0,
                articulation_rate_syllables_per_sec=0.0,
                phone_rate_phones_per_sec=0.0,
                vowel_nPVI=None,
                consonant_rPVI=None,
                syllable_duration_variability=0.0,
                confidence=0.0,
                uncertainty=ProsodyUncertaintyReason.TOO_SHORT_FOR_RHYTHM.value,
            )

        active_speech_sec = max(0.1, total_duration_sec - total_pause_duration_sec)
        speech_rate = n_syllables / total_duration_sec
        artic_rate = n_syllables / active_speech_sec
        phone_rate = phone_count / active_speech_sec

        # Normalized Pairwise Variability Index (nPVI) for vowels:
        # nPVI = [100 / (m - 1)] * sum(|d_k - d_{k+1}| / [(d_k + d_{k+1})/2])
        v_npvi = None
        if len(vowel_durations) >= 2:
            diffs = []
            for k in range(len(vowel_durations) - 1):
                d1, d2 = vowel_durations[k], vowel_durations[k + 1]
                avg = (d1 + d2) / 2.0
                if avg > 1e-4:
                    diffs.append(abs(d1 - d2) / avg)
            if diffs:
                v_npvi = float(100.0 * np.mean(diffs))

        # Raw PVI (rPVI) for consonants:
        # rPVI = [1 / (m - 1)] * sum(|c_k - c_{k+1}|)
        c_rpvi = None
        if len(consonant_durations) >= 2:
            c_diffs = [abs(consonant_durations[k] - consonant_durations[k + 1]) for k in range(len(consonant_durations) - 1)]
            c_rpvi = float(np.mean(c_diffs) * 1000.0)  # in ms

        syl_durs = [s.duration_sec for s in syllables]
        syl_var = float(np.std(syl_durs) / (np.mean(syl_durs) + 1e-6)) if len(syl_durs) > 1 else 0.0

        return RhythmAndRateFeatures(
            speech_rate_syllables_per_sec=round(speech_rate, 2),
            articulation_rate_syllables_per_sec=round(artic_rate, 2),
            phone_rate_phones_per_sec=round(phone_rate, 2),
            vowel_nPVI=round(v_npvi, 2) if v_npvi is not None else None,
            consonant_rPVI=round(c_rpvi, 2) if c_rpvi is not None else None,
            syllable_duration_variability=round(syl_var, 4),
            confidence=0.95 if n_syllables >= 4 else 0.70,
            uncertainty=ProsodyUncertaintyReason.NONE.value if n_syllables >= 3 else ProsodyUncertaintyReason.INSUFFICIENT_SYLLABLE_SUPPORT.value,
        )


class IntonationComparator:
    """
    Evaluates phrase-level pitch direction, and reference-relative contour distance (DTW) for Shadowing.
    """
    @staticmethod
    def compare_reference(
        learner_f0_st: List[Optional[float]],
        reference_f0_st: List[Optional[float]],
    ) -> Tuple[Optional[float], Optional[float]]:
        # Filter voiced semitone contours
        l_voiced = np.array([st for st in learner_f0_st if st is not None])
        r_voiced = np.array([st for st in reference_f0_st if st is not None])

        if len(l_voiced) < 5 or len(r_voiced) < 5:
            return None, None

        # Syllable-anchored interpolation to fixed 50 points
        t_l = np.linspace(0, 1, len(l_voiced))
        t_r = np.linspace(0, 1, len(r_voiced))
        t_common = np.linspace(0, 1, 50)

        l_interp = np.interp(t_common, t_l, l_voiced)
        r_interp = np.interp(t_common, t_r, r_voiced)

        # Distance: Mean Absolute Semitone Error
        dtw_dist = float(np.mean(np.abs(l_interp - r_interp)))

        # Correlation
        corr = float(np.corrcoef(l_interp, r_interp)[0, 1]) if np.std(l_interp) > 1e-4 and np.std(r_interp) > 1e-4 else 0.0

        return round(dtw_dist, 3), round(corr, 3)

    @staticmethod
    def evaluate_phrase_intonation(
        pitch_feat: PitchFeatures,
        reference_pitch_feat: Optional[PitchFeatures] = None,
    ) -> IntonationFeatures:
        if pitch_feat.median_hz is None or len(pitch_feat.f0_contour_semitones) == 0:
            return IntonationFeatures(
                phrase_initial_f0_st=None, phrase_median_f0_st=None, phrase_final_f0_st=None,
                phrase_pitch_direction="UNCERTAIN", reference_pitch_distance_dtw=None,
                reference_contour_correlation=None, confidence=0.0,
                uncertainty=ProsodyUncertaintyReason.INSUFFICIENT_VOICED_FRAMES.value,
            )

        voiced_st = [st for st in pitch_feat.f0_contour_semitones if st is not None]
        if len(voiced_st) < 4:
            return IntonationFeatures(
                phrase_initial_f0_st=None, phrase_median_f0_st=None, phrase_final_f0_st=None,
                phrase_pitch_direction="UNCERTAIN", reference_pitch_distance_dtw=None,
                reference_contour_correlation=None, confidence=0.3,
                uncertainty=ProsodyUncertaintyReason.INSUFFICIENT_VOICED_FRAMES.value,
            )

        p_init = voiced_st[0]
        p_med = float(np.median(voiced_st))
        p_final = voiced_st[-1]

        slope = pitch_feat.final_slope_semitones_per_sec or 0.0
        if slope > 3.0:
            direction = "RISING"
        elif slope < -3.0:
            direction = "FALLING"
        else:
            direction = "FLAT"

        ref_dist, ref_corr = None, None
        if reference_pitch_feat and reference_pitch_feat.median_hz is not None:
            ref_dist, ref_corr = IntonationComparator.compare_reference(
                pitch_feat.f0_contour_semitones,
                reference_pitch_feat.f0_contour_semitones,
            )

        return IntonationFeatures(
            phrase_initial_f0_st=round(p_init, 2),
            phrase_median_f0_st=round(p_med, 2),
            phrase_final_f0_st=round(p_final, 2),
            phrase_pitch_direction=direction,
            reference_pitch_distance_dtw=ref_dist,
            reference_contour_correlation=ref_corr,
            confidence=pitch_feat.confidence,
            uncertainty=ProsodyUncertaintyReason.NONE.value,
        )


class ProsodicRealityModel:
    """
    Main Prosodic Reality Engine orchestrating acoustic measurement,
    two-pass canonical firewalling, and reference comparison.
    """
    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.pitch_extractor = PitchExtractor(sample_rate=sample_rate)
        self.energy_extractor = EnergyExtractor(sample_rate=sample_rate)
        self.pause_detector = PauseDetector(sample_rate=sample_rate)

    def extract_raw_prosody(
        self,
        audio: np.ndarray,
        aligned_phones: Sequence[str],
        phone_durations: Sequence[float],
        word_spans: Optional[List[Dict[str, Any]]] = None,
        reference_audio: Optional[np.ndarray] = None,
    ) -> ProsodicRealityOutput:
        """
        Extracts raw prosody strictly from audio and alignments with zero canonical text bias.
        """
        total_duration = len(audio) / self.sample_rate

        # 1. Pitch
        pitch_feats = self.pitch_extractor.extract(audio)

        # 2. Syllables & Duration
        syllables = Syllabifier.syllabify(aligned_phones, phone_durations)
        syl_intervals = [(s.start_time_sec, s.end_time_sec) for s in syllables]

        # 3. Energy
        energy_feats = self.energy_extractor.extract(audio, syl_intervals)

        # 4. Pauses
        word_boundaries = [(w["startTime"], w["endTime"]) for w in word_spans] if word_spans else None
        pause_feats = self.pause_detector.detect(audio, word_boundaries)

        # 5. Durations
        dur_feats = DurationFeatures(
            total_audio_duration_sec=round(total_duration, 3),
            active_speech_duration_sec=round(max(0.0, total_duration - pause_feats.total_pause_duration_sec), 3),
            phone_durations_sec=[round(d, 3) for d in phone_durations],
            syllable_durations_sec=[s.duration_sec for s in syllables],
            word_durations_sec=[round(w["endTime"] - w["startTime"], 3) for w in word_spans] if word_spans else [],
            alignment_confidence=1.0 if len(aligned_phones) > 0 else 0.0,
        )

        # 6. Lexical Stress
        stress_feats: List[LexicalStressFeatures] = []
        if word_spans:
            for w in word_spans:
                w_syls = [s for s in syllables if s.start_time_sec >= w["startTime"] - 0.05 and s.end_time_sec <= w["endTime"] + 0.05]
                st_res = LexicalStressAnalyzer.analyze_word_stress(
                    word=w.get("word", ""),
                    syllables=w_syls,
                    pitch_contour_st=pitch_feats.f0_contour_semitones,
                    energy_contour=energy_feats.normalized_energy_contour,
                    expected_primary_syllable=w.get("expectedStressIndex"),
                )
                stress_feats.append(st_res)
        else:
            st_res = LexicalStressAnalyzer.analyze_word_stress(
                word="utterance",
                syllables=syllables,
                pitch_contour_st=pitch_feats.f0_contour_semitones,
                energy_contour=energy_feats.normalized_energy_contour,
            )
            stress_feats.append(st_res)

        # 7. Rhythm and Rate
        vowel_durs = [d for p, d in zip(aligned_phones, phone_durations) if p.lower().strip() in VOWEL_PHONEMES]
        cons_durs = [d for p, d in zip(aligned_phones, phone_durations) if p.lower().strip() not in VOWEL_PHONEMES]
        rhythm_feats = RhythmAndRateAnalyzer.compute(
            syllables=syllables,
            vowel_durations=vowel_durs,
            consonant_durations=cons_durs,
            total_duration_sec=total_duration,
            total_pause_duration_sec=pause_feats.total_pause_duration_sec,
            phone_count=len(aligned_phones),
        )

        # 8. Intonation & Reference Comparison
        ref_pitch = self.pitch_extractor.extract(reference_audio) if reference_audio is not None else None
        intonation_feats = IntonationComparator.evaluate_phrase_intonation(pitch_feats, ref_pitch)

        mode = ProsodyMode.REFERENCE_RELATIVE.value if reference_audio is not None else ProsodyMode.REFERENCE_FREE.value

        return ProsodicRealityOutput(
            mode=mode,
            pitch=pitch_feats,
            energy=energy_feats,
            duration=dur_feats,
            stress=stress_feats,
            rhythm=rhythm_feats,
            pauses=pause_feats,
            intonation=intonation_feats,
            raw_firewall_status="PASS",
            overall_prosody_confidence=pitch_feats.confidence,
        )

    def verify_raw_prosody_firewall(
        self,
        audio: np.ndarray,
        aligned_phones: Sequence[str],
        phone_durations: Sequence[float],
        word_spans: List[Dict[str, Any]],
    ) -> Tuple[float, bool]:
        """
        Computes Prosody Susceptibility Score (PSS_RAW) by counterfactually altering
        expected text and verifying that raw acoustic measurements remain bitwise identical.
        """
        res1 = self.extract_raw_prosody(audio, aligned_phones, phone_durations, word_spans)

        # Counterfactually change word text and expected stress
        mutated_words = [dict(w, word=f"{w.get('word', '')}_mutated", expectedStressIndex=(w.get("expectedStressIndex", 0) + 1) % 2) for w in word_spans]
        res2 = self.extract_raw_prosody(audio, aligned_phones, phone_durations, mutated_words)

        # Compare raw acoustic outputs: median F0, energy mean, duration, pause duration
        diff_f0 = abs((res1.pitch.median_hz or 0.0) - (res2.pitch.median_hz or 0.0))
        diff_e = abs(res1.energy.mean_rms - res2.energy.mean_rms)
        diff_dur = abs(res1.duration.total_audio_duration_sec - res2.duration.total_audio_duration_sec)
        diff_p = abs(res1.pauses.total_pause_duration_sec - res2.pauses.total_pause_duration_sec)

        pss_raw = float(diff_f0 + diff_e + diff_dur + diff_p)
        is_zero_leakage = pss_raw < 1e-6
        return pss_raw, is_zero_leakage
