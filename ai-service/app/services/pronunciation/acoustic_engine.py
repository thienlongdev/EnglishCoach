"""
SHD-2B.1R2 Local Acoustic Engine & Multi-Variant CTC Aligner
English Coach — Self-Hosted Acoustic Pronunciation Assessment

Features:
- Wav2Vec2 CTC acoustic forward pass on NVIDIA RTX 5070 / CUDA
- Multi-variant branched CTC Viterbi Trellis alignment
- Linguistic fairness: evaluates allowed weak forms without score penalties
- Diagnostic alignment quality metrics & anomaly detection
- Clean diagnostic output with explicit observedPhoneme=None and calibratedScore=None
"""

import os
import sys
import time
import json
import logging
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Any, Optional, Tuple

import numpy as np
import torch
from transformers import AutoProcessor, Wav2Vec2ForCTC

from app.services.pronunciation.reference_provider import (
    ReferencePronunciationProvider,
    ReferenceSentence,
    ReferenceWord,
    ReferenceVariant,
    tokenize_espeak_phones
)
from app.services.pronunciation.calibration_models import (
    PhoneCalibrationStats,
    calculate_calibrated_score
)
from app.services.pronunciation.model_adapter import (
    get_acoustic_adapter,
    BaseAcousticModelAdapter
)

logger = logging.getLogger("acoustic_engine")
DEFAULT_MODEL_ID = "facebook/wav2vec2-lv-60-espeak-cv-ft"


def true_feature_lengths(model: Any, attention_mask: torch.Tensor) -> torch.Tensor:
    """Derive each item's unpadded convolution length from its sample mask."""
    input_lengths = attention_mask.sum(dim=-1).to(dtype=torch.long)
    return model._get_feat_extract_output_lengths(input_lengths)


def decode_audio_bytes_to_16k_mono(audio_bytes: bytes) -> np.ndarray:
    """
    Decode raw binary audio (WebM/Opus, WAV, OGG, MP3, MP4) directly into
    a 16kHz mono float32 waveform numpy array using FFmpeg.
    """
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-threads", "0",
        "-i", "pipe:0",
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-ac", "1",
        "-ar", "16000",
        "pipe:1"
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        out, err = proc.communicate(input=audio_bytes)
        if proc.returncode != 0:
            raise ValueError(f"FFmpeg audio decoding failed (exit code {proc.returncode}): {err.decode('utf-8', errors='ignore')}")
        if len(out) == 0:
            raise ValueError("Decoded audio stream is empty.")
        waveform = np.frombuffer(out, dtype=np.float32).copy()
        return waveform
    except FileNotFoundError:
        # Fallback if ffmpeg is not installed on system
        raise ValueError("FFmpeg executable not found on system path or corrupt audio bytes provided.")


def decode_audio_file_to_16k_mono(file_path: str) -> np.ndarray:
    """
    Read an audio file from disk and decode to 16kHz mono float32 waveform.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")
    with open(file_path, "rb") as f:
        audio_bytes = f.read()
    return decode_audio_bytes_to_16k_mono(audio_bytes)


def inspect_audio_metadata(audio_bytes: bytes, waveform: np.ndarray) -> Dict[str, Any]:
    """
    Extract container, codec, channels, sample rate, and energy telemetry.
    """
    container = "unknown"
    codec = "unknown"
    channels = 1
    source_sample_rate = 16000

    try:
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            "pipe:0"
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, _ = proc.communicate(input=audio_bytes)
        if proc.returncode == 0 and out:
            info = json.loads(out.decode("utf-8"))
            fmt = info.get("format", {})
            container = fmt.get("format_name", "unknown")
            streams = info.get("streams", [])
            for st in streams:
                if st.get("codec_type") == "audio":
                    codec = st.get("codec_name", "unknown")
                    channels = int(st.get("channels", 1))
                    source_sample_rate = int(st.get("sample_rate", 16000))
                    break
    except Exception:
        pass

    if container == "unknown" and len(audio_bytes) >= 4:
        if audio_bytes[:4] == b"\x1a\x45\xdf\xa3":
            container = "matroska,webm"
            codec = "opus"
        elif audio_bytes[:4] == b"RIFF":
            container = "wav"
            codec = "pcm_s16le"
        elif audio_bytes[:4] == b"OggS":
            container = "ogg"
            codec = "opus"
        elif audio_bytes[:3] == b"ID3" or (audio_bytes[0] == 0xFF and (audio_bytes[1] & 0xE0) == 0xE0):
            container = "mp3"
            codec = "mp3"

    duration_sec = len(waveform) / 16000.0
    rms = float(np.sqrt(np.mean(waveform ** 2))) if len(waveform) > 0 else 0.0
    peak = float(np.max(np.abs(waveform))) if len(waveform) > 0 else 0.0

    return {
        "container": container,
        "codec": codec,
        "sourceChannels": channels,
        "sourceSampleRate": source_sample_rate,
        "rawSizeBytes": len(audio_bytes),
        "canonicalChannels": 1,
        "canonicalSampleRate": 16000,
        "canonicalDtype": "float32",
        "sampleCount": len(waveform),
        "durationMs": round(duration_sec * 1000, 2),
        "rmsEnergy": round(rms, 6),
        "peakAmplitude": round(peak, 6)
    }


def multi_variant_viterbi_align(
    log_probs: np.ndarray,
    reference_words: List[ReferenceWord],
    blank_id: int = 0
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Multi-variant branched CTC Viterbi Trellis Alignment.
    
    Given word instances with one or more valid pronunciation variants,
    constructs a branched Trellis that evaluates all allowed variant sequences
    simultaneously in O(T * total_states) dynamic programming.
    
    Returns:
        word_alignments: List of selected variants and aligned phoneme spans per word
        alignment_diagnostics: Path likelihood, blank ratio, and suspicious alignment flags
    """
    T, V = log_probs.shape
    if T == 0 or not reference_words:
        return [], {"alignmentConfidence": 0.0, "suspiciousForcedAlignment": True}

    # Build the state graph
    # Inter-word blank states are placed at word boundaries.
    # For each word, each variant forms a parallel linear branch between the preceding and following word blanks.
    
    # State representation:
    # state_info[s] = {
    #    "token_id": int,
    #    "word_idx": int (-1 for boundary blanks),
    #    "var_idx": int (-1 for blanks),
    #    "phone_idx": int,
    #    "is_blank": bool
    # }
    
    states: List[Dict[str, Any]] = []
    word_variant_state_spans: List[List[List[int]]] = []
    
    # Root initial blank state (state 0)
    states.append({
        "token_id": blank_id,
        "word_idx": -1,
        "var_idx": -1,
        "phone_idx": -1,
        "is_blank": True
    })
    
    prev_boundary_blank_idx = 0
    boundary_blank_indices = [0]
    
    for w_idx, ref_w in enumerate(reference_words):
        var_spans_for_w = []
        next_boundary_blank_idx = None  # Will allocate after variants
        
        # Collect variant branches for this word
        variant_branches = []
        for v_idx, var in enumerate(ref_w.variants):
            branch_state_indices = []
            tokens = var.tokenIds
            # Branch structure: [b, p_1, b, p_2, ..., b, p_N]
            for p_idx, tid in enumerate(tokens):
                # Intermediate blank within variant
                if p_idx > 0:
                    b_idx = len(states)
                    states.append({
                        "token_id": blank_id,
                        "word_idx": w_idx,
                        "var_idx": v_idx,
                        "phone_idx": -1,
                        "is_blank": True
                    })
                    branch_state_indices.append(b_idx)
                
                # Label state for phoneme
                l_idx = len(states)
                states.append({
                    "token_id": tid,
                    "word_idx": w_idx,
                    "var_idx": v_idx,
                    "phone_idx": p_idx,
                    "is_blank": False,
                    "phoneme": var.phonemes[p_idx]
                })
                branch_state_indices.append(l_idx)
            
            var_spans_for_w.append(branch_state_indices)
            variant_branches.append(branch_state_indices)
            
        word_variant_state_spans.append(var_spans_for_w)
        
        # Word exit boundary blank state
        next_boundary_blank_idx = len(states)
        states.append({
            "token_id": blank_id,
            "word_idx": -1,
            "var_idx": -1,
            "phone_idx": -1,
            "is_blank": True
        })
        boundary_blank_indices.append(next_boundary_blank_idx)
        prev_boundary_blank_idx = next_boundary_blank_idx

    M = len(states)
    NEG_INF = -1e9
    
    # Trellis DP matrix: [T, M]
    trellis = np.full((T, M), NEG_INF, dtype=np.float32)
    backtrack = np.zeros((T, M), dtype=np.int32)
    
    # Initialize t = 0
    # Can start in state 0 (root blank) or in the first label of any variant of word 0
    trellis[0, 0] = log_probs[0, blank_id]
    if len(word_variant_state_spans) > 0:
        for v_branch in word_variant_state_spans[0]:
            first_label = v_branch[0]  # First label in variant
            trellis[0, first_label] = log_probs[0, states[first_label]["token_id"]]
            
    # Forward Dynamic Programming
    for t in range(1, T):
        for s in range(M):
            st_info = states[s]
            s_tok = st_info["token_id"]
            
            # Rule 1: stay in state s
            best_val = trellis[t - 1, s]
            best_prev = s
            
            # Rule 2: incoming transitions
            if st_info["is_blank"] and st_info["word_idx"] == -1:
                # This is a boundary blank after word w_idx
                # It can be entered from the end of any variant branch of word (boundary_idx - 1)
                b_pos = boundary_blank_indices.index(s)
                if b_pos > 0:
                    w_prev = b_pos - 1
                    for v_branch in word_variant_state_spans[w_prev]:
                        last_state = v_branch[-1]
                        if trellis[t - 1, last_state] > best_val:
                            best_val = trellis[t - 1, last_state]
                            best_prev = last_state
            elif st_info["is_blank"] and st_info["word_idx"] >= 0:
                # Internal blank inside variant
                # Entered from preceding label in same branch
                w_curr = st_info["word_idx"]
                v_curr = st_info["var_idx"]
                v_branch = word_variant_state_spans[w_curr][v_curr]
                pos_in_branch = v_branch.index(s)
                prev_state = v_branch[pos_in_branch - 1]
                if trellis[t - 1, prev_state] > best_val:
                    best_val = trellis[t - 1, prev_state]
                    best_prev = prev_state
            else:
                # This is a label state inside a variant
                w_curr = st_info["word_idx"]
                v_curr = st_info["var_idx"]
                v_branch = word_variant_state_spans[w_curr][v_curr]
                pos_in_branch = v_branch.index(s)
                
                if pos_in_branch == 0:
                    # First label in variant: entered from preceding boundary blank
                    b_idx = boundary_blank_indices[w_curr]
                    if trellis[t - 1, b_idx] > best_val:
                        best_val = trellis[t - 1, b_idx]
                        best_prev = b_idx
                else:
                    # Subsequent label: entered from preceding internal blank
                    prev_b_state = v_branch[pos_in_branch - 1]
                    if trellis[t - 1, prev_b_state] > best_val:
                        best_val = trellis[t - 1, prev_b_state]
                        best_prev = prev_b_state
                        
                    # Skip blank transition from s-2 if labels differ
                    if pos_in_branch >= 2:
                        prev_label_state = v_branch[pos_in_branch - 2]
                        if states[prev_label_state]["token_id"] != s_tok:
                            if trellis[t - 1, prev_label_state] > best_val:
                                best_val = trellis[t - 1, prev_label_state]
                                best_prev = prev_label_state
                                
            trellis[t, s] = best_val + log_probs[t, s_tok]
            backtrack[t, s] = best_prev

    # Backtracking termination
    # Best terminal state among final boundary blank and ends of final word variants
    final_boundary = boundary_blank_indices[-1]
    best_terminal = final_boundary
    best_terminal_val = trellis[T - 1, final_boundary]
    
    if len(word_variant_state_spans) > 0:
        for v_branch in word_variant_state_spans[-1]:
            last_st = v_branch[-1]
            if trellis[T - 1, last_st] > best_terminal_val:
                best_terminal_val = trellis[T - 1, last_st]
                best_terminal = last_st

    # Extract state path
    state_path = [0] * T
    curr = best_terminal
    for t in range(T - 1, -1, -1):
        state_path[t] = curr
        curr = backtrack[t, curr]

    # Analyze active variant and phoneme spans per word
    word_alignments = []
    blank_frames_count = 0
    path_log_probs = []
    
    for t, s in enumerate(state_path):
        st = states[s]
        path_log_probs.append(float(log_probs[t, st["token_id"]]))
        if st["is_blank"]:
            blank_frames_count += 1

    for w_idx, ref_w in enumerate(reference_words):
        # Determine which variant was selected in optimal path
        w_states_in_path = [s for s in state_path if states[s]["word_idx"] == w_idx and not states[s]["is_blank"]]
        
        if w_states_in_path:
            chosen_var_idx = states[w_states_in_path[0]]["var_idx"]
        else:
            # Fallback to primary variant (priority 1)
            chosen_var_idx = 0
            
        chosen_variant = ref_w.variants[chosen_var_idx]
        v_branch = word_variant_state_spans[w_idx][chosen_var_idx]
        
        # Extract phoneme spans
        aligned_phones = []
        for p_idx, phoneme in enumerate(chosen_variant.phonemes):
            # Find label state index for this phoneme
            l_state = [s for s in v_branch if states[s]["phone_idx"] == p_idx and not states[s]["is_blank"]][0]
            frames = [t for t, s in enumerate(state_path) if s == l_state]
            
            s_frame = min(frames) if frames else None
            e_frame = max(frames) if frames else None
            
            aligned_phones.append({
                "index": p_idx,
                "expectedPhoneme": phoneme,
                "tokenId": chosen_variant.tokenIds[p_idx],
                "startFrame": s_frame,
                "endFrame": e_frame
            })
            
        word_alignments.append({
            "wordIndex": w_idx,
            "word": ref_w.surfaceText,
            "selectedVariant": chosen_variant.phonemes,
            "variantSource": chosen_variant.source,
            "variantCategory": chosen_variant.category.value if hasattr(chosen_variant.category, "value") else str(chosen_variant.category),
            "alternativesEvaluated": [v.phonemes for v in ref_w.variants],
            "phonemes": aligned_phones
        })

    # Raw alignment diagnostics (pure metrics without uncalibrated threshold detectors)
    mean_path_lp = float(np.mean(path_log_probs)) if path_log_probs else -10.0
    blank_ratio = blank_frames_count / float(T) if T > 0 else 1.0
    
    # Collect log-probs for non-blank phoneme frames specifically
    phoneme_frame_lps = [
        float(log_probs[t, states[s]["token_id"]])
        for t, s in enumerate(state_path)
        if not states[s]["is_blank"]
    ]
    mean_phoneme_lp = float(np.mean(phoneme_frame_lps)) if phoneme_frame_lps else -10.0
    
    # Compute phoneme frame coverage
    total_expected_phones = sum(len(w["phonemes"]) for w in word_alignments)
    aligned_phones_count = sum(1 for w in word_alignments for p in w["phonemes"] if p["startFrame"] is not None)
    coverage = round(float(aligned_phones_count / total_expected_phones), 4) if total_expected_phones > 0 else 1.0

    # Uncalibrated confidence heuristic (explicitly experimental diagnostic only)
    norm_phone_conf = max(0.0, min(1.0, (mean_phoneme_lp + 3.0) / 3.0))
    conf = norm_phone_conf * (1.0 - max(0.0, blank_ratio - 0.5))
    confidence_score = round(float(np.clip(conf, 0.0, 1.0)), 4)

    diagnostics = {
        "pathNormalizedLogLikelihood": round(mean_path_lp, 4),
        "meanPhonemeLogLikelihood": round(mean_phoneme_lp, 4),
        "excessiveBlankRatio": round(blank_ratio, 4),
        "blankRatio": round(blank_ratio, 4),
        "phonemeCoverage": coverage,
        "experimentalDiagnosticOnly": {
            "alignmentConfidence": confidence_score,
            "rawAcousticEvidenceState": "severely_attenuated" if mean_phoneme_lp < -3.0 else "present",
            "blankDominanceState": "high" if blank_ratio > 0.85 else "nominal"
        }
    }

    return word_alignments, diagnostics


def calculate_raw_gop_and_candidates(
    log_probs: np.ndarray,
    start_frame: Optional[int],
    end_frame: Optional[int],
    target_token_id: int,
    id2tok: Dict[int, str],
    blank_id: int = 0,
    top_k: int = 5
) -> Dict[str, Any]:
    """
    Compute raw acoustic evidence (GOP, target log-prob, target posterior)
    and candidate phoneme ranking for a specific frame span.
    """
    if start_frame is None or end_frame is None or start_frame > end_frame:
        return {
            "rawGop": None,
            "meanTargetLogProb": None,
            "meanTargetPosterior": None,
            "strongestCompetitor": None,
            "strongestCompetitorMeanLogProb": None,
            "competitorFrameShare": None,
            "candidatePhonemes": []
        }

    span_log_probs = log_probs[start_frame:end_frame + 1]
    n_frames = len(span_log_probs)

    target_log_probs = span_log_probs[:, target_token_id]
    mean_target_lp = float(np.mean(target_log_probs))
    mean_target_posterior = float(np.mean(np.exp(target_log_probs)))

    # Competitor max excluding blank and target
    competitor_lps = []
    competitor_ids = []
    for t in range(n_frames):
        frame_lp = span_log_probs[t].copy()
        if blank_id < len(frame_lp):
            frame_lp[blank_id] = -1e9  # Exclude blank token
        if target_token_id < len(frame_lp):
            frame_lp[target_token_id] = -1e9  # Exclude target phoneme
        competitor_id = int(np.argmax(frame_lp))
        competitor_ids.append(competitor_id)
        competitor_lps.append(float(frame_lp[competitor_id]))

    gop_frames = target_log_probs - np.array(competitor_lps)
    strongest_competitor_mean_lp = float(np.mean(competitor_lps))
    raw_gop = float(np.mean(gop_frames))
    competitor_counts: Dict[int, int] = {}
    for competitor_id in competitor_ids:
        competitor_counts[competitor_id] = competitor_counts.get(competitor_id, 0) + 1
    modal_competitor_id = min(
        competitor_counts,
        key=lambda cid: (-competitor_counts[cid], cid)
    )
    strongest_competitor = id2tok.get(modal_competitor_id, f"tok_{modal_competitor_id}")
    competitor_frame_share = competitor_counts[modal_competitor_id] / float(n_frames)

    # Top-K candidate phonemes
    mean_span_lps = np.mean(span_log_probs, axis=0)
    ranked_indices = np.argsort(mean_span_lps)[::-1]

    candidates = []
    for cid in ranked_indices:
        if cid == blank_id:
            continue
        tok_name = id2tok.get(int(cid), f"tok_{cid}")
        avg_lp = float(mean_span_lps[cid])
        posterior = float(np.exp(avg_lp))

        candidate_competitor_lps = []
        for t in range(n_frames):
            frame_lp = span_log_probs[t].copy()
            if blank_id < len(frame_lp):
                frame_lp[blank_id] = -1e9
            frame_lp[cid] = -1e9
            candidate_competitor_lps.append(np.max(frame_lp))

        candidate_competitor_mean_lp = float(np.mean(candidate_competitor_lps))
        candidate_raw_gop = float(
            np.mean(span_log_probs[:, cid] - np.array(candidate_competitor_lps))
        )
        candidates.append({
            "phoneme": tok_name,
            "avgLogProb": round(avg_lp, 4),
            "posterior": round(posterior, 4),
            "strongestCompetitorMeanLogProb": round(candidate_competitor_mean_lp, 4),
            "rawGop": round(candidate_raw_gop, 4)
        })
        if len(candidates) >= top_k:
            break

    return {
        "rawGop": round(raw_gop, 4),
        "meanTargetLogProb": round(mean_target_lp, 4),
        "meanTargetPosterior": round(mean_target_posterior, 4),
        "strongestCompetitor": strongest_competitor,
        "strongestCompetitorMeanLogProb": round(strongest_competitor_mean_lp, 4),
        "competitorFrameShare": round(competitor_frame_share, 4),
        "candidatePhonemes": candidates
    }


class LocalAcousticEngine:
    """
    Production-grade local acoustic pronunciation assessment engine.
    Supports multi-variant pronunciation generation, branched Viterbi alignment,
    diagnostic word aggregations, and extensible model selection.
    """

    def __init__(self, model_id: str = DEFAULT_MODEL_ID, device: Optional[str] = None):
        if device is None:
            self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        logger.info(f"Initializing LocalAcousticEngine [{model_id}] on device: {self.device}")

        t0 = time.perf_counter()
        self.model_id = model_id
        self.adapter = get_acoustic_adapter(model_id=model_id, device=self.device)
        self.processor = self.adapter.processor
        self.model = self.adapter.model

        self.vocab = self.adapter.vocab
        self.id2tok = self.adapter.id2tok
        self.blank_id = self.adapter.blank_id

        self.reference_provider = ReferencePronunciationProvider(
            vocab=self.vocab,
            phone_mapper=self.adapter.map_reference_phone
        )
        self.load_duration_ms = (time.perf_counter() - t0) * 1000
        logger.info(f"Engine initialized in {self.load_duration_ms:.2f} ms. Vocab size: {len(self.vocab)}")

    def get_vram_telemetry(self) -> Dict[str, Any]:
        """Query PyTorch CUDA memory allocation stats."""
        if "cuda" in self.device and torch.cuda.is_available():
            allocated_mb = torch.cuda.memory_allocated() / (1024 ** 2)
            reserved_mb = torch.cuda.memory_reserved() / (1024 ** 2)
            max_allocated_mb = torch.cuda.max_memory_allocated() / (1024 ** 2)
            device_name = torch.cuda.get_device_name(0)
            return {
                "device": self.device,
                "deviceName": device_name,
                "allocatedVramMb": round(allocated_mb, 2),
                "reservedVramMb": round(reserved_mb, 2),
                "peakAllocatedVramMb": round(max_allocated_mb, 2)
            }
        return {
            "device": self.device,
            "deviceName": "CPU",
            "allocatedVramMb": 0.0,
            "reservedVramMb": 0.0,
            "peakAllocatedVramMb": 0.0
        }

    def assess_pronunciation(
        self,
        audio_bytes: bytes,
        reference_text: str,
        _decoded_waveform: Optional[np.ndarray] = None,
        _precomputed_log_probs: Optional[np.ndarray] = None
    ) -> Dict[str, Any]:
        """
        Full acoustic assessment pipeline:
        1. Decode WebM/Opus or WAV audio to 16kHz float32.
        2. Acoustic model forward pass -> frame log-posteriors [T, V].
        3. Multi-variant reference linguistic breakdown (weak forms, contractions, etc.).
        4. Branched CTC Trellis alignment -> Optimal variant path & frame boundaries.
        5. Raw GOP computation, candidate distributions, and diagnostic aggregations.
        """
        t_start = time.perf_counter()

        # Step 1: Decode Audio
        t_decode_0 = time.perf_counter()
        waveform = (
            _decoded_waveform
            if _decoded_waveform is not None
            else decode_audio_bytes_to_16k_mono(audio_bytes)
        )
        t_decode_ms = (time.perf_counter() - t_decode_0) * 1000
        audio_meta = inspect_audio_metadata(audio_bytes, waveform)

        # Step 2: Forward Pass
        t_infer_0 = time.perf_counter()
        if _precomputed_log_probs is None:
            audio_tensor = torch.from_numpy(waveform).unsqueeze(0).to(self.device)
            with torch.no_grad():
                logits = self.model(audio_tensor).logits
                log_probs = torch.log_softmax(logits, dim=-1)[0].cpu().numpy()
            if "cuda" in self.device:
                torch.cuda.synchronize()
        else:
            log_probs = _precomputed_log_probs
        t_infer_ms = (time.perf_counter() - t_infer_0) * 1000

        T, V = log_probs.shape
        audio_duration_ms = audio_meta["durationMs"]
        frame_duration_ms = audio_duration_ms / T if T > 0 else 20.0

        # Step 3: Multi-Variant Reference Generation (Scoring-Eligible Variants Only)
        t_g2p_0 = time.perf_counter()
        ref_sentence = self.reference_provider.process_reference_text(reference_text, scoring_only=True)
        t_g2p_ms = (time.perf_counter() - t_g2p_0) * 1000

        # Step 4: Multi-Variant CTC Viterbi Alignment
        t_align_0 = time.perf_counter()
        word_alignments, align_diag = multi_variant_viterbi_align(
            log_probs,
            ref_sentence.words,
            blank_id=self.blank_id
        )
        t_align_ms = (time.perf_counter() - t_align_0) * 1000

        # Step 5: Compute Phoneme & Word GOP Evidence
        t_gop_0 = time.perf_counter()
        words_output = []
        reference_words_summary = []
        all_aligned_gops = []
        all_phoneme_durations = []

        for w_align in word_alignments:
            w_idx = w_align["wordIndex"]
            w_word = w_align["word"]
            
            reference_words_summary.append({
                "index": w_idx,
                "surface": w_word,
                "selectedVariant": w_align["selectedVariant"],
                "variantSource": w_align["variantSource"],
                "variantCategory": w_align["variantCategory"],
                "alternativesEvaluated": w_align["alternativesEvaluated"]
            })

            cleaned_phonemes = []
            word_gops = []
            word_durations = []
            valid_starts = []
            valid_ends = []

            for p_data in w_align["phonemes"]:
                s_frame = p_data["startFrame"]
                e_frame = p_data["endFrame"]
                
                if s_frame is not None and e_frame is not None:
                    start_ms = round(s_frame * frame_duration_ms)
                    end_ms = round((e_frame + 1) * frame_duration_ms)
                    duration_ms = end_ms - start_ms
                    valid_starts.append(start_ms)
                    valid_ends.append(end_ms)
                    word_durations.append(duration_ms)
                    all_phoneme_durations.append(duration_ms)
                else:
                    start_ms = None
                    end_ms = None
                    duration_ms = None

                gop_info = calculate_raw_gop_and_candidates(
                    log_probs=log_probs,
                    start_frame=s_frame,
                    end_frame=e_frame,
                    target_token_id=p_data["tokenId"],
                    id2tok=self.id2tok,
                    blank_id=self.blank_id,
                    top_k=5
                )

                raw_gop = gop_info["rawGop"]
                if raw_gop is not None:
                    word_gops.append(raw_gop)
                    all_aligned_gops.append(raw_gop)

                cleaned_phonemes.append({
                    "index": p_data["index"],
                    "expectedPhoneme": p_data["expectedPhoneme"],
                    "observedPhoneme": None,  # Strictly null in SHD-2B.2A
                    "tokenId": p_data["tokenId"],
                    "rawGop": raw_gop,
                    "calibratedScore": calculate_calibrated_score(raw_gop),  # Strictly null in SHD-2B.2A
                    "startFrame": s_frame,
                    "endFrame": e_frame,
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "durationMs": duration_ms,
                    "meanTargetLogProb": gop_info["meanTargetLogProb"],
                    "meanTargetPosterior": gop_info["meanTargetPosterior"],
                    "strongestCompetitor": gop_info["strongestCompetitor"],
                    "strongestCompetitorMeanLogProb": gop_info["strongestCompetitorMeanLogProb"],
                    "competitorFrameShare": gop_info["competitorFrameShare"],
                    "candidatePhonemes": gop_info["candidatePhonemes"]
                })

            # Calculate diagnostic word-level aggregations
            w_start_ms = min(valid_starts) if valid_starts else None
            w_end_ms = max(valid_ends) if valid_ends else None

            if word_gops:
                mean_gop = round(float(np.mean(word_gops)), 4)
                median_gop = round(float(np.median(word_gops)), 4)
                min_gop = round(float(np.min(word_gops)), 4)
                
                # Duration-weighted mean GOP
                total_dur = sum(word_durations)
                if total_dur > 0 and len(word_durations) == len(word_gops):
                    weighted_mean = round(float(sum(d * g for d, g in zip(word_durations, word_gops)) / total_dur), 4)
                else:
                    weighted_mean = mean_gop
            else:
                mean_gop = None
                median_gop = None
                min_gop = None
                weighted_mean = None

            words_output.append({
                "index": w_idx,
                "expectedWord": w_word,
                "selectedVariant": w_align["selectedVariant"],
                "variantSource": w_align["variantSource"],
                "variantCategory": w_align["variantCategory"],
                "startMs": w_start_ms,
                "endMs": w_end_ms,
                "diagnosticAggregates": {
                    "meanRawGop": mean_gop,
                    "medianRawGop": median_gop,
                    "minRawGop": min_gop,
                    "durationWeightedMeanRawGop": weighted_mean
                },
                "phonemes": cleaned_phonemes
            })

        t_gop_ms = (time.perf_counter() - t_gop_0) * 1000
        total_latency_ms = (time.perf_counter() - t_start) * 1000

        utterance_mean_raw_gop = round(float(np.mean(all_aligned_gops)), 4) if all_aligned_gops else None
        
        # Add duration span metrics to alignment diagnostics
        align_diag["minPhonemeDurationMs"] = min(all_phoneme_durations) if all_phoneme_durations else None
        align_diag["maxPhonemeDurationMs"] = max(all_phoneme_durations) if all_phoneme_durations else None

        vram_stats = self.get_vram_telemetry()

        return {
            "assessmentAvailable": True,
            "engine": {
                "name": "local-ctc-gop",
                "modelId": self.model_id,
                "scoringSchemaVersion": "spike-2",
                "backend": "local_pytorch_cuda",
                "device": self.device,
                "computeCapability": "sm_120 / 12.0" if "cuda" in self.device else "N/A",
                "isMocked": False
            },
            "audioMetadata": audio_meta,
            "telemetry": {
                "totalLatencyMs": round(total_latency_ms, 2),
                "audioDecodeMs": round(t_decode_ms, 2),
                "inferenceLatencyMs": round(t_infer_ms, 2),
                "g2pDurationMs": round(t_g2p_ms, 2),
                "ctcAlignmentMs": round(t_align_ms, 2),
                "gopCalculationMs": round(t_gop_ms, 2),
                "vramUsage": vram_stats
            },
            "alignmentQuality": align_diag,
            "reference": {
                "rawText": reference_text,
                "normalizedText": ref_sentence.normalizedText,
                "words": reference_words_summary
            },
            "acousticEvidence": {
                "utteranceMeanRawGop": utterance_mean_raw_gop,
                "totalPhonemes": sum(len(w["phonemes"]) for w in words_output),
                "alignedPhonemes": len(all_aligned_gops)
            },
            "words": words_output
        }

    def assess_pronunciation_batch(
        self,
        items: List[Tuple[bytes, str]]
    ) -> List[Dict[str, Any]]:
        """Offline microbatch inference with per-item alignment and scoring."""
        if not items:
            return []

        waveforms = [decode_audio_bytes_to_16k_mono(audio) for audio, _ in items]
        lengths = torch.tensor([len(w) for w in waveforms], dtype=torch.long)
        max_length = int(lengths.max().item())
        padded = np.zeros((len(waveforms), max_length), dtype=np.float32)
        attention = np.zeros((len(waveforms), max_length), dtype=np.int64)
        for index, waveform in enumerate(waveforms):
            padded[index, :len(waveform)] = waveform
            attention[index, :len(waveform)] = 1

        input_values = torch.from_numpy(padded).to(self.device)
        attention_mask = torch.from_numpy(attention).to(self.device)
        with torch.no_grad():
            logits = self.model(
                input_values,
                attention_mask=attention_mask
            ).logits
            batched_log_probs = torch.log_softmax(logits, dim=-1).cpu().numpy()
        if "cuda" in self.device:
            torch.cuda.synchronize()

        feature_lengths = true_feature_lengths(self.model, attention_mask).cpu().numpy()
        def finish(index_and_item: Tuple[int, Tuple[bytes, str]]) -> Dict[str, Any]:
            index, (audio_bytes, reference_text) = index_and_item
            valid_frames = int(feature_lengths[index])
            return self.assess_pronunciation(
                audio_bytes,
                reference_text,
                _decoded_waveform=waveforms[index],
                _precomputed_log_probs=batched_log_probs[index, :valid_frames]
            )

        # The shared model forward pass is complete. Remaining reference
        # generation/alignment is independent per utterance and CPU-bound.
        with ThreadPoolExecutor(max_workers=min(4, len(items))) as executor:
            return list(executor.map(finish, enumerate(items)))
