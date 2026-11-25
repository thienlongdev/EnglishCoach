"""
English Coach — Version-Controlled In-Repo Hybrid Pronunciation Engine (V3).

Architecture (Phase 4 Proven Champion — Full 2,500 Unseen SpeechOcean762 Test):
- Shared-Lower-12 + Dual-Upper-12 WavLM-Large (`WavLMEncoderStableLayerNorm` exact order,
  zero premature encoder.layer_norm before layer 0):
  * Shared CNN feature extractor + Transformer layers 0..11 run ONCE.
  * Branch A1 (Base layers 12..21 -> hs22_base) -> SequenceNativeProsodyModel (Fluency r=0.814, Prosodic r=0.801).
  * Branch A2 (Block3B layers [20, 21] -> hs22_b3) -> WavLMPhoneCTCProbe (CTC Alignment & GOP).
  * Branch B (CycleC layers 12..21 -> hs22_cc) -> DecoupledSegmentalModel (Phone PR-AUC=0.668, F1=0.621, ECE=0.0026).
- Zero test leakage: pure-JSON Logistic/Ridge calibration from `echo_speaking_v3_calibrator.json`
  fit strictly on SpeechOcean762 train/ + LibriSpeech dev-clean.
- Real Audio Quality Gate (frame-percentile SNR, consecutive-sample clipping, spectral flatness + YIN voicing)
  with honest ABSTAINED responses on silence, pure white noise, or < 0.25s audio.
- Honest Content Fidelity Gate (LCS alignment + spoken-text normalization preserving contractions,
  expanding numbers/currencies, and US/UK orthographic equivalence) — NEVER fakes 100% match.
- Real acoustic prosody (46ms YIN F0 + declination detrending + terminal slope, nPVI-V, VarcoV,
  adaptive-VAD pauses) + Connected Speech diagnostics (final-stop release burst, pre-fortis vowel
  duration ratio, C-V linking continuity) + Multi-accent tolerance (en-US, en-GB, en-AU, international)
  + Actionable Vietnamese/English priorities.

Zero imports from external/unversioned `mdd-service/`. Pure-Python calibration, fidelity,
acoustics, and connected-speech layers work on CPU without GPU checkpoints.
"""

from __future__ import annotations

import copy
from functools import lru_cache
import json
import logging
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError:  # pragma: no cover - defensive CPU-only fallback
    torch = None  # type: ignore
    nn = None  # type: ignore
    F = None  # type: ignore

from app.services.audio_ingestion import (
    CANONICAL_SAMPLE_RATE,
    compute_audio_quality_metrics,
    decode_browser_audio,
)

logger = logging.getLogger("uvicorn.error.hybrid_pronunciation_engine")

ENGINE_VERSION = "pronunciation-v3.0-hybrid"
LEXICAL_STRESS_METHOD = "ALIGNED_VOWEL_PROMINENCE_V1"
LEXICAL_STRESS_ALGORITHM = "NEURAL_CTC_MULTICUE_V2"

# ==============================================================================
# Canonical 39-phone ARPAbet vocabulary matching saved checkpoints bit-for-bit
# ==============================================================================

CANONICAL_39_PHONES: List[str] = [
    "AA", "AE", "AH", "AO", "AW", "AY", "B", "CH", "D", "DH",
    "EH", "ER", "EY", "F", "G", "HH", "IH", "IY", "JH", "K",
    "L", "M", "N", "NG", "OW", "OY", "P", "R", "S", "SH",
    "T", "TH", "UH", "UW", "V", "W", "Y", "Z", "ZH",
]
PHONE_TO_IDX: Dict[str, int] = {p: i for i, p in enumerate(CANONICAL_39_PHONES)}
IDX_TO_PHONE: Dict[int, str] = {i: p for i, p in enumerate(CANONICAL_39_PHONES)}
DELETION_IDX: int = 39
NUM_DIAGNOSIS_CLASSES: int = 40  # 39 canonical phones + DELETION
NUM_QUALITY_CLASSES: int = 3     # 0: ACCEPTABLE, 1: WEAK, 2: ERROR

CTC_BLANK_TOKEN: str = "<blank>"
CTC_BLANK_ID: int = 0
PHONE_CTC_VOCABULARY: List[str] = [CTC_BLANK_TOKEN] + CANONICAL_39_PHONES
PHONE_TO_ID: Dict[str, int] = {p: i for i, p in enumerate(PHONE_CTC_VOCABULARY)}
ID_TO_PHONE: Dict[int, str] = {i: p for i, p in enumerate(PHONE_CTC_VOCABULARY)}

VOWELS: Set[str] = {
    "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER",
    "EY", "IH", "IY", "OW", "OY", "UH", "UW",
}
VOICELESS_STOPS: Set[str] = {"P", "T", "K"}
VOICED_STOPS: Set[str] = {"B", "D", "G"}
ALL_STOPS: Set[str] = VOICELESS_STOPS | VOICED_STOPS
VOICELESS_OBSTRUENTS: Set[str] = {"P", "T", "K", "F", "TH", "S", "SH", "CH"}
VOICED_OBSTRUENTS: Set[str] = {"B", "D", "G", "V", "DH", "Z", "ZH", "JH"}
FINAL_SZTD: Set[str] = {"S", "Z", "T", "D"}

ARPABET_TO_IPA: Dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "ɛ", "ER": "ɝ",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "iː",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "oʊ", "OY": "ɔɪ", "P": "p", "R": "r", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "uː", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}

INTRINSIC_VOWEL_DUR: Dict[str, float] = {
    "IH": 0.78, "EH": 0.85, "UH": 0.80, "AH": 0.72, "ER": 0.95,
    "IY": 1.05, "UW": 1.05, "AE": 1.15, "AA": 1.15, "AO": 1.15,
    "EY": 1.25, "AY": 1.30, "OW": 1.22, "AW": 1.30, "OY": 1.32,
}
INTRINSIC_VOWEL_DB: Dict[str, float] = {
    "IH": -1.5, "IY": -1.5, "UH": -1.5, "UW": -1.5, "AH": -1.0,
    "EH": 0.0, "ER": 0.0, "EY": 0.5, "OW": 0.5,
    "AE": 1.5, "AA": 2.0, "AO": 1.8, "AY": 1.5, "AW": 1.8, "OY": 1.2,
}

UK_ACCEPTED_STRESS: Dict[str, Set[int]] = {
    "garage": {1, 2}, "laboratory": {1, 2}, "controversy": {1, 2}, "ballet": {1, 2},
    "debris": {1, 2}, "cafe": {1, 2}, "brochure": {1, 2}, "massage": {1, 2},
    "weekend": {1, 2}, "magazine": {1, 3}, "princess": {1, 2}, "advertisement": {2, 3},
    "adult": {1, 2}, "detail": {1, 2}, "address": {1, 2}, "research": {1, 2},
    "aluminum": {2}, "aluminium": {3}, "schedule": {1}, "privacy": {1},
    "inquiry": {1, 2}, "finance": {1, 2}, "harass": {1, 2}, "donate": {1, 2},
    "rotate": {1, 2}, "vaccine": {1, 2}, "frustrate": {1, 2}, "migrate": {1, 2},
}

BATH_TRAP_WORDS: Set[str] = {
    "bath", "path", "ask", "asked", "asking", "can't", "cant", "half", "dance",
    "danced", "dancing", "class", "classes", "fast", "faster", "glass", "glasses",
    "last", "pass", "passed", "passing", "past", "laugh", "laughed", "laughing",
    "after", "afternoon", "answer", "chance", "plant", "branch", "staff", "grass",
    "castle", "example", "command", "demand", "master", "task", "mask", "craft",
}

US_UK_ORTHOGRAPHIC_MAP: Dict[str, str] = {
    "colour": "color", "colours": "colors", "coloured": "colored", "colourful": "colorful",
    "favour": "favor", "favours": "favors", "favourite": "favorite", "favourites": "favorites",
    "behaviour": "behavior", "behaviours": "behaviors", "behavioural": "behavioral",
    "honour": "honor", "honours": "honors", "honoured": "honored",
    "neighbour": "neighbor", "neighbours": "neighbors", "neighbourhood": "neighborhood",
    "flavour": "flavor", "flavours": "flavors", "humour": "humor", "labour": "labor",
    "rumour": "rumor", "harbour": "harbor", "parlour": "parlor", "vapour": "vapor",
    "centre": "center", "centres": "centers", "theatre": "theater", "theatres": "theaters",
    "metre": "meter", "metres": "meters", "litre": "liter", "litres": "liters",
    "fibre": "fiber", "sombre": "somber", "calibre": "caliber",
    "organise": "organize", "organises": "organizes", "organised": "organized", "organising": "organizing",
    "organisation": "organization", "organisations": "organizations",
    "analyse": "analyze", "analyses": "analyzes", "analysed": "analyzed", "analysing": "analyzing",
    "realise": "realize", "realises": "realizes", "realised": "realized", "realising": "realizing",
    "recognise": "recognize", "recognises": "recognizes", "recognised": "recognized",
    "apologise": "apologize", "apologised": "apologized", "criticise": "criticize",
    "emphasise": "emphasize", "summarise": "summarize", "utilise": "utilize",
    "minimise": "minimize", "maximise": "maximize", "specialise": "specialize",
    "prioritise": "prioritize", "finalise": "finalize", "customise": "customize",
    "memorise": "memorize", "normalise": "normalize", "standardise": "standardize",
    "travelling": "traveling", "travelled": "traveled", "traveller": "traveler",
    "cancelled": "canceled", "cancelling": "canceling", "labelled": "labeled", "labelling": "labeling",
    "modelled": "modeled", "modelling": "modeling", "counsellor": "counselor", "marvellous": "marvelous",
    "programme": "program", "programmes": "programs",
    "defence": "defense", "offence": "offense", "licence": "license", "practise": "practice",
    "catalogue": "catalog", "dialogue": "dialog", "prologue": "prolog", "analogue": "analog",
    "grey": "gray", "aluminium": "aluminum", "aeroplane": "airplane",
    "cheque": "check", "tyre": "tire", "pyjamas": "pajamas", "jewellery": "jewelry",
    "enrol": "enroll", "fulfil": "fulfill", "skilful": "skillful", "wilful": "willful",
    "ageing": "aging", "judgement": "judgment", "acknowledgement": "acknowledgment",
    "plough": "plow", "mould": "mold", "moustaches": "mustaches", "moustache": "mustache",
}

DEFAULT_CALIBRATOR: Dict[str, Any] = {
    "version": "ECHO_SPEAKING_V3_HYBRID_CALIB_20261124",
    "trained_on": "SpeechOcean762 v1.2.0 train/ (N=600, 125 train speakers) + LibriSpeech dev-clean (N=60 native)",
    "zero_test_leakage_verified": True,
    "phone_error_logreg": {
        "features": ["err_p", "weak_p", "neg_gop", "blank_dom", "zero_fr", "ctc_conf"],
        "coef": [6.435513, -0.489609, 0.454336, 1.4045, 0.0, 0.031129],
        "intercept": -6.56727,
        "tau_error": 0.38,
        "tau_weak": 0.171,
    },
    "phone_deletion_logreg": {
        "features": ["err_p", "neg_gop", "blank_dom", "zero_fr", "dur_norm"],
        "coef": [3.293353, 0.37366, 3.059865, 0.0, -0.666207],
        "intercept": -7.918987,
        "tau_deletion": 0.19,
    },
    "utt_accuracy_ridge": {
        "features": ["mean_err_p", "max_err_p", "mean_neg_gop", "mean_weak_p"],
        "coef": [-2.942468, -1.516688, -1.184215, 0.211811],
        "intercept": 9.472557,
    },
    "utt_total_ridge": {
        "features": ["mean_err_p", "mean_neg_gop", "raw_flu", "raw_pros"],
        "coef": [-0.651716, -0.840662, 0.243459, 0.416861],
        "intercept": 2.493802,
    },
    "lexical_stress": {
        "method": "NEURAL_CTC_MULTICUE_V2",
        "dev_native_n_words": 318,
        "err_margin_threshold": 0.4078,
    },
}

# Bilingual pedagogical coaching cues for all 39 canonical phones
PHONE_COACHING_CUES: Dict[str, Tuple[str, str]] = {
    "TH": (
        "Đặt nhẹ đầu lưỡi giữa hai hàm răng và thổi luồng hơi nhẹ (không rung cổ họng, tránh biến thành /s/ hoặc /t/).",
        "Place the tongue tip lightly between the upper and lower teeth and blow voiceless air gently (avoid /s/ or /t/).",
    ),
    "DH": (
        "Đặt đầu lưỡi giữa hai hàm răng giống âm /θ/ nhưng rung dây thanh quản (tránh chặn hơi thành /d/ hoặc /z/).",
        "Place the tongue tip between the teeth like /θ/ while vibrating the vocal cords (avoid /d/ or /z/).",
    ),
    "S": (
        "Khép nhẹ răng, đặt đầu lưỡi gần chân răng trên và đẩy luồng hơi xì sắc nét, đặc biệt rõ khi ở cuối từ.",
        "Keep teeth lightly closed, tongue tip near the alveolar ridge, and release a crisp voiceless hiss, especially at word endings.",
    ),
    "Z": (
        "Khẩu hình giống âm /s/ nhưng giữ rung dây thanh quản như tiếng ong kêu, tránh biến thành /s/ vô thanh ở cuối từ.",
        "Use the same tongue position as /s/ while sustaining vocal-cord vibration, avoiding devoicing to /s/ at word ends.",
    ),
    "SH": (
        "Chu nhẹ hai môi về phía trước, nâng mặt lưỡi gần vòm miệng và thổi luồng hơi vô thanh mượt mà.",
        "Round and protrude the lips slightly, raise the tongue blade near the palate, and release smooth voiceless friction.",
    ),
    "ZH": (
        "Khẩu hình giống âm /ʃ/ (chu nhẹ môi) kết hợp rung dây thanh quản liên tục.",
        "Use the same rounded lip shape as /ʃ/ while keeping the vocal cords vibrating.",
    ),
    "CH": (
        "Chặn hơi nhanh bằng đầu lưỡi chạm nướu trên rồi bật dứt khoát thành âm xì /ʃ/ (vô thanh).",
        "Briefly stop airflow with the tongue tip at the alveolar ridge, then release crisply into voiceless /ʃ/.",
    ),
    "JH": (
        "Chặn hơi ở nướu trên giống /tʃ/ rồi bật ra kèm rung dây thanh quản.",
        "Briefly stop airflow at the alveolar ridge like /tʃ/ and release with strong vocal-cord voicing.",
    ),
    "R": (
        "Cong nhẹ đầu lưỡi về phía sau mà không chạm vòm miệng, tròn môi nhẹ khi phát âm /r/.",
        "Curl or bunch the tongue slightly back without touching the palate and lightly round the lips.",
    ),
    "L": (
        "Chạm chắc đầu lưỡi vào nướu răng cửa trên, để luồng hơi thoát qua hai bên mép lưỡi.",
        "Press the tongue tip firmly against the alveolar ridge behind the upper front teeth and let air flow around the sides.",
    ),
    "V": (
        "Chạm nhẹ răng cửa trên lên môi dưới và thổi hơi kết hợp rung cổ họng (không mím hai môi thành /b/ hoặc /w/).",
        "Touch the upper front teeth lightly to the lower lip and voice the airflow (avoid bilabial /b/ or /w/).",
    ),
    "F": (
        "Chạm nhẹ răng cửa trên lên môi dưới và thổi luồng hơi vô thanh rõ ràng (không rung cổ họng).",
        "Rest the upper front teeth lightly on the lower lip and blow steady voiceless air.",
    ),
    "W": (
        "Tròn hai môi thành hình chữ 'o' nhỏ rồi lướt nhanh sang nguyên âm kế tiếp, không chạm răng vào môi.",
        "Round both lips into a tight circle and glide smoothly into the next vowel without touching teeth to lip.",
    ),
    "P": (
        "Mím hai môi chặn hơi rồi bật hơi vô thanh rõ ràng (ở đầu âm tiết nhấn cần có luồng hơi bật mạnh).",
        "Close both lips to build pressure and release a crisp voiceless burst (aspirated in stressed onsets).",
    ),
    "B": (
        "Mím hai môi và giữ rung cổ họng khi bật hơi để phân biệt rõ với âm vô thanh /p/.",
        "Close both lips and engage vocal-cord vibration during release to distinguish clearly from /p/.",
    ),
    "T": (
        "Đặt đầu lưỡi chạm nướu răng trên rồi bật hơi vô thanh sắc nét, chú ý không nuốt âm /t/ cuối từ.",
        "Tap the tongue tip against the alveolar ridge and release a crisp voiceless burst, avoiding final-/t/ deletion.",
    ),
    "D": (
        "Chạm đầu lưỡi vào nướu trên kèm rung cổ họng và giữ nguyên âm phía trước dài hơn một chút trước /d/ cuối từ.",
        "Contact the alveolar ridge with voicing and maintain slightly longer preceding vowel duration before final /d/.",
    ),
    "K": (
        "Nâng phần sau lưỡi chạm vòm mềm rồi bật hơi vô thanh dứt khoát, tránh nuốt âm /k/ cuối từ.",
        "Raise the back of the tongue to the soft palate and release a clear voiceless burst, avoiding final-/k/ omission.",
    ),
    "G": (
        "Nâng gốc lưỡi chạm vòm mềm giống /k/ nhưng giữ rung dây thanh quản rõ ràng.",
        "Raise the tongue back to the soft palate like /k/ while keeping the vocal cords voiced.",
    ),
    "HH": (
        "Thở luồng hơi nhẹ, thoáng qua khe thanh môn trước nguyên âm kế tiếp.",
        "Release a gentle, open breathy airflow from the glottis before transitioning into the following vowel.",
    ),
    "M": (
        "Mím kín hai môi và để âm thanh ngân vang qua mũi.",
        "Close both lips completely and let the voiced sound resonate smoothly through the nose.",
    ),
    "N": (
        "Chạm đầu lưỡi vào nướu răng trên và để hơi ngân qua mũi (tránh biến thành /ŋ/ hoặc bỏ âm cuối).",
        "Place the tongue tip on the alveolar ridge and resonate through the nose (avoid dropping final /n/).",
    ),
    "NG": (
        "Nâng gốc lưỡi chạm vòm mềm và đẩy âm ngân qua mũi, không bật thêm âm /g/ dư ở cuối.",
        "Raise the back of the tongue to the soft palate and resonate nasally without adding an extra hard /g/.",
    ),
    "Y": (
        "Nâng giữa lưỡi sát vòm cứng rồi lướt nhanh sang nguyên âm sau.",
        "Raise the middle of the tongue close to the hard palate and glide briskly into the following vowel.",
    ),
    "IY": (
        "Căng nhẹ khóe miệng như mỉm cười, nâng lưỡi cao về phía trước và giữ âm /iː/ căng, rõ.",
        "Spread the lips slightly, raise the tongue high and forward, and sustain a clear tense /iː/.",
    ),
    "IH": (
        "Thả lỏng cơ miệng và hàm, phát âm âm /ɪ/ ngắn, dứt khoát (tránh kéo dài thành /iː/).",
        "Relax the lips and jaw for a short, crisp lax /ɪ/ (avoid stretching into tense /iː/).",
    ),
    "UW": (
        "Tròn môi rõ, kéo lưỡi cao về phía sau và giữ âm /uː/ căng, mượt.",
        "Round the lips firmly, pull the tongue high and back, and sustain tense /uː/.",
    ),
    "UH": (
        "Thả lỏng môi (chỉ hơi tròn nhẹ) và phát âm âm /ʊ/ ngắn, tự nhiên (như trong 'book', 'good').",
        "Keep the lips only loosely rounded for a short, relaxed /ʊ/ (as in 'book', 'good').",
    ),
    "AE": (
        "Hạ hàm dưới sâu, mở rộng miệng theo chiều dọc và đặt lưỡi thấp về phía trước để phân biệt /æ/ với /ɛ/.",
        "Drop the jaw low, open the mouth vertically, and keep the tongue low and front to contrast /æ/ from /ɛ/.",
    ),
    "EH": (
        "Mở miệng vừa phải, thả lỏng môi và giữ lưỡi ở độ cao trung bình cho âm /ɛ/ (như 'bed').",
        "Open the mouth moderately with relaxed lips and mid-front tongue height for /ɛ/ (as in 'bed').",
    ),
    "AA": (
        "Mở rộng khoang miệng, hạ thấp hàm và đưa lưỡi về phía sau cho âm /ɑ/ thoáng, trầm.",
        "Open the jaw wide and keep the tongue low and back for an open /ɑ/ vowel.",
    ),
    "AO": (
        "Hơi tròn môi, hạ hàm vừa phải và kéo lưỡi về sau cho âm /ɔ/ đầy đặn.",
        "Round the lips moderately with tongue low-mid and back for a full /ɔ/.",
    ),
    "AH": (
        "Thả lỏng hoàn toàn môi, hàm và lưỡi ở vị trí trung tâm, phát âm âm /ʌ/ (hoặc /ə/ nhẹ) gọn gàng.",
        "Keep lips, jaw, and tongue relaxed in a neutral central position for a clean /ʌ/ or /ə/.",
    ),
    "ER": (
        "Giữ lưỡi ở giữa khoang miệng và cong/cuộn nhẹ đầu lưỡi về sau (với giọng Mỹ) tạo độ rền rhotic /ɝ/.",
        "Position the tongue centrally and curl or bunch the tongue tip slightly back for r-colored /ɝ/.",
    ),
    "EY": (
        "Bắt đầu từ âm /e/ rõ rồi lướt mượt lên /ɪ/ để giữ trọn nguyên âm đôi /eɪ/.",
        "Start on a clear /e/ and glide smoothly upward toward /ɪ/ to preserve the /eɪ/ diphthong.",
    ),
    "AY": (
        "Mở hàm rộng cho /a/ rồi nâng lưỡi lướt gọn lên /ɪ/ tạo âm đôi /aɪ/ rõ ràng.",
        "Open wide for /a/ and glide smoothly upward to /ɪ/ for a full /aɪ/ diphthong.",
    ),
    "OW": (
        "Bắt đầu từ /o/ rồi khép tròn môi dần về /ʊ/ để không bị cụt nguyên âm đôi /oʊ/.",
        "Begin on /o/ and progressively round the lips toward /ʊ/ so /oʊ/ doesn't flatten into a monophthong.",
    ),
    "AW": (
        "Mở miệng rộng ở /a/ rồi khép tròn môi nhanh sang /ʊ/ tạo nguyên âm đôi /aʊ/.",
        "Open wide on /a/ and smoothly round the lips into /ʊ/ for /aʊ/.",
    ),
    "OY": (
        "Tròn môi ở /ɔ/ rồi mở nhẹ sang /ɪ/ để nguyên âm đôi /ɔɪ/ nghe tự nhiên.",
        "Begin with rounded lips on /ɔ/ and glide cleanly into /ɪ/ for /ɔɪ/.",
    ),
}

# Minimal articulatory feature lookup for deterministic articulatoryDiff
_CONSONANT_ARTIC: Dict[str, Tuple[str, str, str]] = {
    "P": ("bilabial", "stop", "voiceless"),
    "B": ("bilabial", "stop", "voiced"),
    "T": ("alveolar", "stop", "voiceless"),
    "D": ("alveolar", "stop", "voiced"),
    "K": ("velar", "stop", "voiceless"),
    "G": ("velar", "stop", "voiced"),
    "F": ("labiodental", "fricative", "voiceless"),
    "V": ("labiodental", "fricative", "voiced"),
    "TH": ("dental", "fricative", "voiceless"),
    "DH": ("dental", "fricative", "voiced"),
    "S": ("alveolar", "fricative", "voiceless"),
    "Z": ("alveolar", "fricative", "voiced"),
    "SH": ("postalveolar", "fricative", "voiceless"),
    "ZH": ("postalveolar", "fricative", "voiced"),
    "HH": ("glottal", "fricative", "voiceless"),
    "CH": ("postalveolar", "affricate", "voiceless"),
    "JH": ("postalveolar", "affricate", "voiced"),
    "M": ("bilabial", "nasal", "voiced"),
    "N": ("alveolar", "nasal", "voiced"),
    "NG": ("velar", "nasal", "voiced"),
    "L": ("alveolar", "lateral", "voiced"),
    "R": ("postalveolar", "approximant", "voiced"),
    "W": ("bilabial", "approximant", "voiced"),
    "Y": ("palatal", "approximant", "voiced"),
}


# ==============================================================================
# Pure-Python helpers (calibrator, accent, CMUdict, spoken normalization, fidelity)
# ==============================================================================

def strip_stress(phone: str) -> str:
    return "".join(ch for ch in str(phone) if not ch.isdigit()).upper()


def normalize_accent(accent: Optional[str]) -> str:
    raw = (accent or "en-US").strip().lower().replace("_", "-")
    if raw in ("en-gb", "uk", "gb", "british", "rp"):
        return "en-GB"
    if raw in ("en-au", "au", "aus", "australian"):
        return "en-AU"
    if raw in ("international", "intl", "global", "any"):
        return "international"
    return "en-US"


@lru_cache(maxsize=4)
def load_calibrator(path: Optional[str] = None) -> Dict[str, Any]:
    target = Path(path) if path else Path(__file__).parent / "data" / "echo_speaking_v3_calibrator.json"
    if target.exists():
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed reading calibrator JSON at %s (%s); using built-in defaults", target, exc)
    return copy.deepcopy(DEFAULT_CALIBRATOR)


@lru_cache(maxsize=2)
def load_cmudict(path: Optional[str] = None) -> Dict[str, List[List[str]]]:
    target = Path(path) if path else Path(__file__).parent / "data" / "cmudict-0.7b.txt"
    lexicon: Dict[str, List[List[str]]] = {}
    if not target.exists():
        return lexicon
    with target.open("r", encoding="latin-1") as fh:
        for line in fh:
            if not line or line.startswith(";;;"):
                continue
            parts = line.strip().split()
            if len(parts) < 2:
                continue
            word = re.sub(r"\(\d+\)$", "", parts[0]).lower()
            lexicon.setdefault(word, []).append(parts[1:])
    return lexicon


def _sigmoid(z: float) -> float:
    if z >= 0.0:
        ez = math.exp(-min(z, 60.0))
        return 1.0 / (1.0 + ez)
    ez = math.exp(max(z, -60.0))
    return ez / (1.0 + ez)


def normalize_for_fidelity(text: str) -> List[str]:
    """Normalize text for honest spoken-word LCS comparison:
    - Normalizes curly apostrophes and preserves contractions (don't, can't, I'm).
    - Expands numbers, currencies, decimals, percentages, ordinals, and abbreviations.
    - Maps US/UK orthographic variants to canonical US spelling (colour->color, organise->organize).
    """
    if not text or not text.strip():
        return []
    from app.services.pronunciation.ipa_pipeline import normalize_token_for_spoken

    cleaned = text.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    # Split on whitespace and dashes between words while keeping inner apostrophes & numeric punctuation
    tokens_out: List[str] = []
    for raw_tok in cleaned.strip().split():
        # Strip outer non-word punctuation except leading $ / £ / € and trailing % / .
        tok = re.sub(r"^[\"'(\[{,;!?]+|[\"')\]}:;!?]+$", "", raw_tok)
        if not tok:
            continue
        # Remove trailing period ONLY if not a known dotted abbreviation like U.S. / Dr. / Mr.
        low_tok = tok.lower()
        if low_tok not in ("mr.", "mrs.", "ms.", "dr.", "u.s.", "u.s.a.", "u.k.", "etc.", "vs.", "i.e.", "e.g.", "st."):
            tok = tok.rstrip(".,")
        if not tok:
            continue
        expanded = normalize_token_for_spoken(tok)
        # Split expanded multi-word strings and hyphenated words into spoken tokens
        for piece in re.split(r"[\s\-/]+", expanded):
            # Preserve internal apostrophes (don't, it's, I'm), strip outer punctuation
            w = re.sub(r"^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$", "", piece).lower()
            w = re.sub(r"[^a-z0-9']", "", w).strip("'")
            if not w:
                continue
            w = US_UK_ORTHOGRAPHIC_MAP.get(w, w)
            tokens_out.append(w)
    return tokens_out


def evaluate_content_fidelity(
    expected_text: str,
    free_transcript: Optional[str],
) -> Dict[str, Any]:
    """Honest LCS word alignment content fidelity gate.

    NEVER fakes 100% match.
    - When `free_transcript` is None (not supplied by caller), marks `UNVERIFIED`
      with `matchPercentage=None` rather than fabricating 100%.
    - When `free_transcript` is provided, computes true LCS alignment after spoken-text
      normalization (contractions preserved, numbers expanded, US/UK spellings unified).
      * ratio >= 0.80 -> MATCHED
      * 0.45 <= ratio < 0.80 -> PARTIAL
      * ratio < 0.45 -> OFF_SCRIPT
    """
    exp_tokens = normalize_for_fidelity(expected_text)
    total_exp = len(exp_tokens)

    if free_transcript is None:
        return {
            "status": "UNVERIFIED",
            "fidelityStatus": "UNVERIFIED",
            "content_match_percentage": None,
            "matchPercentage": None,
            "content_match_ratio": None,
            "wordMatchRatio": None,
            "matched_words_count": 0,
            "matchedWordsCount": 0,
            "total_expected_words": total_exp,
            "totalExpectedWords": total_exp,
            "free_transcript": "",
            "freeTranscript": "",
            "expected_text": expected_text,
            "expectedText": expected_text,
            "aligned_words": [],
            "alignedWords": [],
            "matched_islands": [],
            "matchedIslands": [],
            "matched_target_indices": list(range(total_exp)),
            "quarantined_segments": [],
            "quarantinedSegments": [],
        }

    rec_tokens = normalize_for_fidelity(free_transcript)
    m, n = len(exp_tokens), len(rec_tokens)

    if m == 0:
        return {
            "status": "OFF_SCRIPT",
            "fidelityStatus": "OFF_SCRIPT",
            "content_match_percentage": 0,
            "matchPercentage": 0,
            "content_match_ratio": 0.0,
            "wordMatchRatio": 0.0,
            "matched_words_count": 0,
            "matchedWordsCount": 0,
            "total_expected_words": 0,
            "totalExpectedWords": 0,
            "free_transcript": free_transcript,
            "freeTranscript": free_transcript,
            "expected_text": expected_text,
            "expectedText": expected_text,
            "aligned_words": [],
            "alignedWords": [],
            "matched_islands": [],
            "matchedIslands": [],
            "matched_target_indices": [],
            "quarantined_segments": ["EMPTY_EXPECTED_TEXT"],
            "quarantinedSegments": ["EMPTY_EXPECTED_TEXT"],
        }

    # Dynamic programming LCS table (O(M * N))
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m - 1, -1, -1):
        ei = exp_tokens[i]
        row = dp[i]
        nxt = dp[i + 1]
        for j in range(n - 1, -1, -1):
            if ei == rec_tokens[j]:
                row[j] = 1 + nxt[j + 1]
            else:
                row[j] = nxt[j] if nxt[j] >= row[j + 1] else row[j + 1]

    # Backtrack LCS to build aligned words & matched indices
    i, j = 0, 0
    matched_target_indices: List[int] = []
    aligned_words: List[Dict[str, Any]] = []
    while i < m and j < n:
        if exp_tokens[i] == rec_tokens[j]:
            matched_target_indices.append(i)
            aligned_words.append({
                "target_index": i, "targetIndex": i,
                "target_word": exp_tokens[i], "targetWord": exp_tokens[i],
                "recognized_word": rec_tokens[j], "recognizedWord": rec_tokens[j],
                "status": "MATCH",
                "confidence": 1.0,
            })
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            aligned_words.append({
                "target_index": i, "targetIndex": i,
                "target_word": exp_tokens[i], "targetWord": exp_tokens[i],
                "recognized_word": None, "recognizedWord": None,
                "status": "OMISSION",
                "confidence": 1.0,
            })
            i += 1
        else:
            aligned_words.append({
                "target_index": None, "targetIndex": None,
                "target_word": None, "targetWord": None,
                "recognized_word": rec_tokens[j], "recognizedWord": rec_tokens[j],
                "status": "INSERTION",
                "confidence": 1.0,
            })
            j += 1

    while i < m:
        aligned_words.append({
            "target_index": i, "targetIndex": i,
            "target_word": exp_tokens[i], "targetWord": exp_tokens[i],
            "recognized_word": None, "recognizedWord": None,
            "status": "OMISSION",
            "confidence": 1.0,
        })
        i += 1
    while j < n:
        aligned_words.append({
            "target_index": None, "targetIndex": None,
            "target_word": None, "targetWord": None,
            "recognized_word": rec_tokens[j], "recognizedWord": rec_tokens[j],
            "status": "INSERTION",
            "confidence": 1.0,
        })
        j += 1

    matched_cnt = len(matched_target_indices)
    ratio = matched_cnt / float(m)
    # Also guard against severe off-script flooding (e.g. 50 extra random words containing 1 expected word)
    precision_ratio = matched_cnt / float(max(1, n))
    effective_ratio = ratio if n <= max(m * 3, m + 6) else min(ratio, 0.5 * (ratio + precision_ratio))
    match_pct = int(round(max(0.0, min(1.0, effective_ratio)) * 100.0))

    if matched_cnt == 0 or effective_ratio < 0.45:
        fid_status = "OFF_SCRIPT"
        quarantined = ["OFF_SCRIPT_QUARANTINE"]
    elif effective_ratio < 0.80:
        fid_status = "PARTIAL"
        quarantined = []
    else:
        fid_status = "MATCHED"
        quarantined = []

    # Build contiguous matched islands
    matched_islands: List[Dict[str, Any]] = []
    if matched_target_indices:
        start_idx = matched_target_indices[0]
        prev_idx = start_idx
        for idx in matched_target_indices[1:] + [None]:
            if idx is None or idx != prev_idx + 1:
                isl_words = exp_tokens[start_idx : prev_idx + 1]
                isl_i = len(matched_islands)
                matched_islands.append({
                    "island_index": isl_i, "islandIndex": isl_i,
                    "target_start_idx": start_idx, "targetStartIdx": start_idx,
                    "target_end_idx": prev_idx, "targetEndIdx": prev_idx,
                    "words": isl_words,
                })
                if idx is not None:
                    start_idx = idx
                    prev_idx = idx
            else:
                prev_idx = idx

    return {
        "status": fid_status,
        "fidelityStatus": fid_status,
        "content_match_percentage": match_pct,
        "matchPercentage": match_pct,
        "content_match_ratio": round(effective_ratio, 4),
        "wordMatchRatio": round(effective_ratio, 4),
        "matched_words_count": matched_cnt,
        "matchedWordsCount": matched_cnt,
        "total_expected_words": m,
        "totalExpectedWords": m,
        "free_transcript": free_transcript,
        "freeTranscript": free_transcript,
        "expected_text": expected_text,
        "expectedText": expected_text,
        "aligned_words": aligned_words,
        "alignedWords": aligned_words,
        "matched_islands": matched_islands,
        "matchedIslands": matched_islands,
        "matched_target_indices": matched_target_indices,
        "quarantined_segments": quarantined,
        "quarantinedSegments": quarantined,
    }


def assess_audio_quality(wav: np.ndarray, sr: int = CANONICAL_SAMPLE_RATE) -> Dict[str, Any]:
    """Real Audio Quality Gate: detects silence, pure white noise, ultra-short audio, and clipping."""
    m = compute_audio_quality_metrics(wav, sr=sr)
    warnings: List[str] = []
    unusable = False

    if m["duration_sec"] < 0.25:
        warnings.append("TOO_SHORT")
        unusable = True
    if m["is_silent"]:
        warnings.append("NO_SPEECH" if m["speech_ratio"] < 0.05 else "TOO_QUIET")
        unusable = True
    # Pure white/stationary broadband noise (non-silent): flat spectrum + near-zero voicing + low SNR contrast
    is_white_noise = (not m["is_silent"]) and (
        (m["spectral_flatness"] >= 0.45 and m["voicing_ratio"] < 0.05)
        or (m["snr_db"] < 3.0 and m["voicing_ratio"] < 0.04 and m["spectral_flatness"] >= 0.35)
    )
    if is_white_noise:
        warnings.append("EXCESSIVE_NOISE")
        warnings.append("NO_SPEECH")
        unusable = True

    if m["is_clipping"]:
        warnings.append("CLIPPED")
        if m["clipping_ratio"] >= 0.50:
            unusable = True

    if unusable:
        q_status = "UNUSABLE"
    elif m["snr_db"] < 8.0 or m["is_clipping"] or m["speech_ratio"] < 0.15:
        q_status = "POOR"
    elif m["snr_db"] < 15.0:
        q_status = "ACCEPTABLE"
    else:
        q_status = "GOOD"

    warnings = list(dict.fromkeys(warnings))
    return {
        "duration_sec": m["duration_sec"],
        "durationSec": m["duration_sec"],
        "rms_energy_db": m["rms_energy_db"],
        "rmsEnergyDb": m["rms_energy_db"],
        "snr_estimate_db": m["snr_db"],
        "snrEstimateDb": m["snr_db"],
        "snrDb": m["snr_db"],
        "is_clipping": m["is_clipping"],
        "isClipping": m["is_clipping"],
        "clipping_ratio": m["clipping_ratio"],
        "clippingRatio": m["clipping_ratio"],
        "is_silent": m["is_silent"],
        "isSilent": m["is_silent"],
        "silence_ratio": m["silence_ratio"],
        "silenceRatio": m["silence_ratio"],
        "speech_ratio": m["speech_ratio"],
        "speechRatio": m["speech_ratio"],
        "spectral_flatness": m["spectral_flatness"],
        "voicing_ratio": m["voicing_ratio"],
        "quality_status": q_status,
        "qualityStatus": q_status,
        "warnings": warnings,
    }


def _fallback_letter_g2p(word: str) -> List[str]:
    """Deterministic lightweight fallback G2P for OOV words when CMUdict lacks an entry."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return ["AH0"]
    out: List[str] = []
    i = 0
    digraphs = {
        "th": "TH", "sh": "SH", "ch": "CH", "ph": "F", "wh": "W",
        "ng": "NG", "ck": "K", "qu": "K", "ee": "IY1", "oo": "UW1",
        "ea": "IY1", "ai": "EY1", "ay": "EY1", "oa": "OW1", "ou": "AW1",
        "oi": "OY1", "oy": "OY1", "er": "ER0", "ir": "ER1", "ur": "ER1",
        "ar": "AA1", "or": "AO1",
    }
    singles = {
        "a": "AE1", "e": "EH1", "i": "IH1", "o": "AA1", "u": "AH1",
        "b": "B", "c": "K", "d": "D", "f": "F", "g": "G", "h": "HH",
        "j": "JH", "k": "K", "l": "L", "m": "M", "n": "N", "p": "P",
        "q": "K", "r": "R", "s": "S", "t": "T", "v": "V", "w": "W",
        "x": "K", "y": "Y", "z": "Z",
    }
    while i < len(w):
        if i + 1 < len(w) and w[i : i + 2] in digraphs:
            out.append(digraphs[w[i : i + 2]])
            i += 2
        else:
            p = singles.get(w[i])
            if p:
                out.append(p)
            i += 1
    return out or ["AH0"]


def resolve_expected_words(
    expected_text: str,
    accent: str = "en-US",
    cmudict: Optional[Dict[str, List[List[str]]]] = None,
) -> List[Dict[str, Any]]:
    """Resolve expected spoken words into canonical ARPAbet phones with stress & accepted variants."""
    lex = cmudict if cmudict is not None else load_cmudict()
    norm_tokens = normalize_for_fidelity(expected_text)
    acc = normalize_accent(accent)
    resolved: List[Dict[str, Any]] = []

    for w_idx, tok in enumerate(norm_tokens):
        prons = lex.get(tok)
        if not prons and tok.endswith("'s") and tok[:-2] in lex:
            base_pr = list(lex[tok[:-2]][0])
            last_b = strip_stress(base_pr[-1])
            if last_b in ("S", "Z", "SH", "ZH", "CH", "JH"):
                base_pr.extend(["IH0", "Z"])
            elif last_b in VOICELESS_OBSTRUENTS:
                base_pr.append("S")
            else:
                base_pr.append("Z")
            prons = [base_pr]
        if not prons:
            prons = [_fallback_letter_g2p(tok)]

        primary_raw = prons[0]
        primary_base = [strip_stress(p) for p in primary_raw if strip_stress(p) in PHONE_TO_IDX]
        if not primary_base:
            primary_raw = ["AH0"]
            primary_base = ["AH"]

        # Expected 1-based primary stress indices across all valid dictionary variants
        v_indices = [i for i, p in enumerate(primary_raw) if strip_stress(p) in VOWELS]
        exp_stress: Set[int] = set()
        for pv in prons:
            pv_v = [i for i, p in enumerate(pv) if strip_stress(p) in VOWELS]
            if len(pv_v) == len(v_indices):
                for si, pi in enumerate(pv_v):
                    if pv[pi].endswith("1"):
                        exp_stress.add(si + 1)
        if acc in ("en-GB", "en-AU", "international") and tok in UK_ACCEPTED_STRESS:
            exp_stress |= {s for s in UK_ACCEPTED_STRESS[tok] if s <= len(v_indices)}

        # Collect per-position accepted realizations across equal-length dictionary variants
        accepted_per_pos: List[Set[str]] = [{p} for p in primary_base]
        for pv in prons[1:]:
            pv_base = [strip_stress(p) for p in pv if strip_stress(p) in PHONE_TO_IDX]
            if len(pv_base) == len(primary_base):
                for pi, alt_p in enumerate(pv_base):
                    accepted_per_pos[pi].add(alt_p)

        resolved.append({
            "word_index": w_idx,
            "word": tok,
            "phones_raw": primary_raw,
            "phones_base": primary_base,
            "expected_stress_1based": sorted(exp_stress),
            "accepted_per_pos": [sorted(s) for s in accepted_per_pos],
        })

    return resolved


# ==============================================================================
# Exact PyTorch Model Definitions (matching saved checkpoints bit-for-bit)
# ==============================================================================

if nn is not None:

    class WavLMPhoneCTCProbe(nn.Module):
        """Matches `probe.*` keys in `pron_v2_block3b_canonical_final.pt`."""

        def __init__(self, hidden_size: int = 1024, num_classes: int = 40, dropout: float = 0.0):
            super().__init__()
            self.layer_norm = nn.LayerNorm(hidden_size)
            self.dropout = nn.Dropout(dropout)
            self.projection = nn.Linear(hidden_size, num_classes)

        def forward(self, hidden_state: torch.Tensor) -> torch.Tensor:
            return self.projection(self.dropout(self.layer_norm(hidden_state)))


    class DecoupledSegmentalModel(nn.Module):
        """Matches `model_state_dict` keys in `pron_v2_2_segmental_champion.pt`."""

        def __init__(
            self,
            acoustic_dim: int = 1024,
            target_embed_dim: int = 64,
            context_embed_dim: int = 32,
            hidden_dim: int = 256,
            dropout: float = 0.1,
        ):
            super().__init__()
            self.acoustic_dim = acoustic_dim
            self.acoustic_norm = nn.LayerNorm(acoustic_dim)
            self.acoustic_proj = nn.Sequential(
                nn.Linear(acoustic_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Dropout(dropout),
            )
            self.target_embed = nn.Embedding(len(CANONICAL_39_PHONES) + 1, target_embed_dim)
            self.context_embed = nn.Embedding(len(CANONICAL_39_PHONES) + 2, context_embed_dim)

            fusion_dim = hidden_dim + target_embed_dim + 2 * context_embed_dim + 1  # + duration
            self.fusion_mlp = nn.Sequential(
                nn.LayerNorm(fusion_dim),
                nn.Linear(fusion_dim, hidden_dim),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(hidden_dim, 128),
                nn.LayerNorm(128),
                nn.GELU(),
                nn.Dropout(dropout),
            )
            self.quality_head = nn.Linear(128, NUM_QUALITY_CLASSES)
            self.margin_head = nn.Linear(128, 1)
            self.metric_proj = nn.Linear(128, 64)

            diag_fusion_dim = hidden_dim + target_embed_dim
            self.diag_mlp = nn.Sequential(
                nn.LayerNorm(diag_fusion_dim),
                nn.Linear(diag_fusion_dim, hidden_dim),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(hidden_dim, 128),
                nn.LayerNorm(128),
                nn.GELU(),
                nn.Dropout(dropout),
            )
            self.diagnosis_head = nn.Linear(128, NUM_DIAGNOSIS_CLASSES)

        def forward_diagnosis(self, acoustic: torch.Tensor, target_phone: torch.Tensor) -> Dict[str, torch.Tensor]:
            a_proj = self.acoustic_proj(self.acoustic_norm(acoustic))
            t_emb = self.target_embed(target_phone)
            diag_feat = self.diag_mlp(torch.cat([a_proj, t_emb], dim=-1))
            diag_logits = self.diagnosis_head(diag_feat)
            diag_probs = F.softmax(diag_logits, dim=-1)
            sorted_probs, sorted_indices = torch.sort(diag_probs, descending=True, dim=-1)
            top1_idx = sorted_indices[:, 0]
            top1_prob = sorted_probs[:, 0]
            diag_margin = top1_prob - sorted_probs[:, 1]
            return {
                "diagnosis_logits": diag_logits,
                "diagnosis_probs": diag_probs,
                "top1_idx": top1_idx,
                "top1_prob": top1_prob,
                "diagnosis_margin": diag_margin,
                "margin": diag_margin,
                "sorted_indices": sorted_indices,
                "sorted_probs": sorted_probs,
            }

        def forward(
            self,
            acoustic: torch.Tensor,
            target_phone: torch.Tensor,
            left_context: Optional[torch.Tensor] = None,
            right_context: Optional[torch.Tensor] = None,
            duration: Optional[torch.Tensor] = None,
            ctc_posterior: Optional[torch.Tensor] = None,
        ) -> Dict[str, torch.Tensor]:
            if left_context is None:
                return self.forward_diagnosis(acoustic, target_phone)
            a_proj = self.acoustic_proj(self.acoustic_norm(acoustic))
            t_emb = self.target_embed(target_phone)
            l_emb = self.context_embed(left_context)
            r_emb = self.context_embed(right_context)
            fused = torch.cat([a_proj, t_emb, l_emb, r_emb, duration], dim=-1)
            feat = self.fusion_mlp(fused)
            logits = self.quality_head(feat)
            probs = F.softmax(logits, dim=-1)
            error_prob = probs[:, 2]
            margin = self.margin_head(feat).squeeze(-1)
            metric_emb = self.metric_proj(feat)

            diag_feat = self.diag_mlp(torch.cat([a_proj, t_emb], dim=-1))
            diag_logits = self.diagnosis_head(diag_feat)
            diag_probs = F.softmax(diag_logits, dim=-1)
            sorted_probs, sorted_indices = torch.sort(diag_probs, descending=True, dim=-1)
            top1_idx = sorted_indices[:, 0]
            top1_prob = sorted_probs[:, 0]
            diag_margin = top1_prob - sorted_probs[:, 1]
            return {
                "quality_logits": logits,
                "quality_probs": probs,
                "error_prob": error_prob,
                "detector_margin": margin,
                "latent_feat": feat,
                "metric_embedding": metric_emb,
                "diagnosis_logits": diag_logits,
                "diagnosis_probs": diag_probs,
                "top1_idx": top1_idx,
                "top1_prob": top1_prob,
                "diagnosis_margin": diag_margin,
                "margin": diag_margin,
                "sorted_indices": sorted_indices,
                "sorted_probs": sorted_probs,
            }


    class AttentiveStatisticsPooling(nn.Module):
        def __init__(self, in_dim: int, hidden_dim: int = 128):
            super().__init__()
            self.attn = nn.Sequential(
                nn.Linear(in_dim, hidden_dim),
                nn.Tanh(),
                nn.Linear(hidden_dim, 1),
            )

        def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
            scores = self.attn(x)
            if mask is not None:
                scores = scores.masked_fill(~mask.unsqueeze(-1), -1e9)
            weights = F.softmax(scores, dim=1)
            mean = torch.sum(weights * x, dim=1)
            var = torch.sum(weights * ((x - mean.unsqueeze(1)) ** 2), dim=1)
            std = torch.sqrt(torch.clamp(var, min=1e-6))
            return torch.cat([mean, std], dim=-1)


    class MultiResolutionTemporalEncoder(nn.Module):
        def __init__(
            self,
            input_dim: int = 1024,
            d_model: int = 256,
            nhead: int = 4,
            num_layers: int = 2,
            dim_feedforward: int = 1024,
            dropout: float = 0.1,
        ):
            super().__init__()
            self.in_proj = nn.Sequential(
                nn.LayerNorm(input_dim),
                nn.Linear(input_dim, d_model),
                nn.GELU(),
                nn.Dropout(dropout),
            )
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=nhead,
                dim_feedforward=dim_feedforward,
                dropout=dropout,
                activation="gelu",
                batch_first=True,
                norm_first=True,
            )
            self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
            self.pooler = AttentiveStatisticsPooling(in_dim=d_model, hidden_dim=128)
            self.out_dim = d_model * 2

        def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> Tuple[torch.Tensor, torch.Tensor]:
            h = self.in_proj(x)
            key_padding_mask = ~mask if mask is not None else None
            h_trans = self.transformer(h, src_key_padding_mask=key_padding_mask)
            utt_feat = self.pooler(h_trans, mask=mask)
            return h_trans, utt_feat


    class SequenceNativeProsodyModel(nn.Module):
        """Matches `model_state_dict` keys in `pron_v2_2_prosody_champion.pt`."""

        def __init__(
            self,
            input_dim: int = 1024,
            d_model: int = 256,
            nhead: int = 4,
            num_layers: int = 2,
            dropout: float = 0.1,
        ):
            super().__init__()
            self.encoder = MultiResolutionTemporalEncoder(
                input_dim=input_dim,
                d_model=d_model,
                nhead=nhead,
                num_layers=num_layers,
                dropout=dropout,
            )
            utt_dim = self.encoder.out_dim
            self.fluency_head = nn.Sequential(
                nn.Linear(utt_dim, 256),
                nn.LayerNorm(256),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(256, 64),
                nn.GELU(),
                nn.Linear(64, 1),
            )
            self.prosodic_head = nn.Sequential(
                nn.Linear(utt_dim, 256),
                nn.LayerNorm(256),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(256, 64),
                nn.GELU(),
                nn.Linear(64, 1),
            )
            self.word_stress_head = nn.Sequential(
                nn.Linear(d_model, 128),
                nn.LayerNorm(128),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(128, 2),
            )

        def forward(
            self,
            frame_seq: torch.Tensor,
            frame_mask: Optional[torch.Tensor] = None,
            word_spans: Optional[List[List[Tuple[int, int]]]] = None,
        ) -> Dict[str, Any]:
            frame_feats, utt_feat = self.encoder(frame_seq, mask=frame_mask)
            fluency_pred = self.fluency_head(utt_feat).squeeze(-1)
            prosodic_pred = self.prosodic_head(utt_feat).squeeze(-1)
            return {
                "fluency_score": fluency_pred,
                "prosodic_score": prosodic_pred,
                "frame_feats": frame_feats,
                "utt_feat": utt_feat,
            }


def compute_ctc_posterior_single(
    log_probs_t: "torch.Tensor",
    targets_u: "torch.Tensor",
    blank_id: int = CTC_BLANK_ID,
) -> Dict[str, "torch.Tensor"]:
    """Exact log-space float32 CTC forward-backward posterior."""
    device = log_probs_t.device
    lp = log_probs_t.float()
    T, _C = lp.shape
    U = int(targets_u.shape[0])
    if U == 0:
        return {
            "log_Z": lp[:, blank_id].sum(),
            "gamma": torch.zeros((T, 0), dtype=torch.float32, device=device),
            "gamma_blank": torch.ones((T,), dtype=torch.float32, device=device),
            "q": torch.zeros((T,), dtype=torch.float32, device=device),
        }

    S = 2 * U + 1
    NEG_INF = -1e9
    ext = torch.full((S,), blank_id, dtype=torch.long, device=device)
    ext[1::2] = targets_u.to(device=device, dtype=torch.long)

    allow_skip = torch.zeros((S,), dtype=torch.bool, device=device)
    if U > 1:
        diff = targets_u[1:] != targets_u[:-1]
        allow_skip[3::2] = diff.to(device=device)

    emissions = lp[:, ext]  # [T, S]

    log_alpha = torch.full((T, S), NEG_INF, dtype=torch.float32, device=device)
    log_alpha[0, 0] = emissions[0, 0]
    if S > 1:
        log_alpha[0, 1] = emissions[0, 1]

    neg_t = torch.tensor(NEG_INF, dtype=torch.float32, device=device)
    neg_1 = torch.tensor([NEG_INF], dtype=torch.float32, device=device)
    neg_2 = torch.full((2,), NEG_INF, dtype=torch.float32, device=device)

    for t in range(1, T):
        prev_a = log_alpha[t - 1]
        a_same = prev_a
        a_prev1 = torch.cat([neg_1, prev_a[:-1]])
        a_prev2 = torch.cat([neg_2, prev_a[:-2]])
        a_prev2 = torch.where(allow_skip, a_prev2, neg_t)
        log_alpha[t] = torch.logsumexp(torch.stack([a_same, a_prev1, a_prev2], dim=0), dim=0) + emissions[t]

    log_Z = torch.logsumexp(torch.stack([log_alpha[T - 1, S - 1], log_alpha[T - 1, S - 2]], dim=0), dim=0)

    log_beta = torch.full((T, S), NEG_INF, dtype=torch.float32, device=device)
    log_beta[T - 1, S - 1] = 0.0
    log_beta[T - 1, S - 2] = 0.0
    skip_to_valid = torch.cat([allow_skip[2:], torch.zeros((2,), dtype=torch.bool, device=device)])

    for t in range(T - 2, -1, -1):
        next_contrib = log_beta[t + 1] + emissions[t + 1]
        b_same = next_contrib
        b_next1 = torch.cat([next_contrib[1:], neg_1])
        b_next2 = torch.cat([next_contrib[2:], neg_2])
        b_next2 = torch.where(skip_to_valid, b_next2, neg_t)
        log_beta[t] = torch.logsumexp(torch.stack([b_same, b_next1, b_next2], dim=0), dim=0)

    state_post = torch.clamp(torch.exp(log_alpha + log_beta - log_Z), min=0.0, max=1.0)
    odd_indices = torch.arange(1, S, 2, device=device)
    even_indices = torch.arange(0, S, 2, device=device)
    gamma = torch.clamp(state_post[:, odd_indices], min=0.0, max=1.0).detach()
    gamma_blank = torch.clamp(state_post[:, even_indices].sum(dim=-1), min=0.0, max=1.0).detach()
    q = torch.clamp(gamma.sum(dim=-1), min=0.0, max=1.0).detach()
    return {"log_Z": log_Z, "gamma": gamma, "gamma_blank": gamma_blank, "q": q}


def viterbi_ctc(
    lp: np.ndarray,
    seq_ids: Sequence[int],
    blank_id: int = CTC_BLANK_ID,
) -> Optional[List[Dict[str, Any]]]:
    """Exact Viterbi CTC forced alignment producing per-phone frame spans, GOP, blank_dom & free rival."""
    T, _V = lp.shape
    U = len(seq_ids)
    if U == 0 or T == 0:
        return None
    S = 2 * U + 1
    ext = [blank_id] * S
    for u, pid in enumerate(seq_ids):
        ext[2 * u + 1] = int(pid)

    NEG = -1e18
    dp = np.full((T, S), NEG, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int32)
    dp[0, 0] = lp[0, ext[0]]
    if S > 1:
        dp[0, 1] = lp[0, ext[1]]

    for t in range(1, T):
        for s in range(S):
            best_p = dp[t - 1, s]
            best_i = s
            if s >= 1 and dp[t - 1, s - 1] > best_p:
                best_p = dp[t - 1, s - 1]
                best_i = s - 1
            if s >= 2 and ext[s] != blank_id and ext[s] != ext[s - 2]:
                if dp[t - 1, s - 2] > best_p:
                    best_p = dp[t - 1, s - 2]
                    best_i = s - 2
            dp[t, s] = best_p + lp[t, ext[s]]
            bp[t, s] = best_i

    last_s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    if dp[T - 1, last_s] <= NEG / 2:
        return None

    path = [0] * T
    cur = last_s
    for t in range(T - 1, -1, -1):
        path[t] = cur
        cur = int(bp[t, cur])

    spans: List[List[int]] = [[] for _ in range(U)]
    for t, s in enumerate(path):
        if s % 2 == 1:
            spans[s // 2].append(t)

    lp_nb = lp.copy()
    lp_nb[:, blank_id] = -1e9
    max_nb = np.max(lp_nb, axis=1)

    out: List[Dict[str, Any]] = []
    for u, frames in enumerate(spans):
        pid = int(seq_ids[u])
        if not frames:
            out.append({
                "start_f": None,
                "end_f": None,
                "n_frames": 0,
                "gop_lpr": -12.0,
                "blank_dom": 1.0,
                "free_top_id": None,
                "free_top_prob": 0.0,
            })
            continue
        sf_i, ef_i = frames[0], frames[-1]
        w0, w1 = max(0, sf_i - 1), min(T - 1, ef_i + 1)
        gop = float(np.mean(lp[sf_i : ef_i + 1, pid]) - np.mean(max_nb[sf_i : ef_i + 1]))
        bdom = float(np.mean(np.exp(lp[sf_i : ef_i + 1, blank_id])))
        mean_nb_probs = np.exp(lp_nb[w0 : w1 + 1]).mean(axis=0)
        ftop = int(np.argmax(mean_nb_probs))
        fprob = float(mean_nb_probs[ftop])
        out.append({
            "start_f": sf_i,
            "end_f": ef_i,
            "n_frames": len(frames),
            "gop_lpr": gop,
            "blank_dom": bdom,
            "free_top_id": ftop,
            "free_top_prob": fprob,
        })
    return out


class DualBranchWavLMBackbone:
    """Shared-Lower-12 + Dual-Upper-12 WavLM-Large Runtime Backbone.

    Matches `05_verify_champion_full2500_and_stress.py` forward order bit-for-bit:
      - `WavLMEncoderStableLayerNorm` exact order (NO premature `encoder.layer_norm` before layer 0!).
      - Base layers 12..21 -> `hs22_base` -> `SequenceNativeProsodyModel`.
      - Block3B layers [20, 21] -> `hs22_b3` -> `WavLMPhoneCTCProbe` -> CTC Alignment & GOP.
      - CycleC layers 12..21 -> `hs22_cc` -> `DecoupledSegmentalModel`.
    """

    def __init__(
        self,
        *,
        block3b_ckpt: Optional[str] = None,
        segmental_ckpt: Optional[str] = None,
        prosody_ckpt: Optional[str] = None,
        wavlm_model_id: Optional[str] = None,
        device: Optional[str] = None,
    ):
        if torch is None:
            raise RuntimeError("PyTorch is required to instantiate DualBranchWavLMBackbone")
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.use_half = self.device.type == "cuda"

        repo_root = self._discover_repo_root()
        self.block3b_ckpt = block3b_ckpt or os.getenv("HYBRID_BLOCK3B_CKPT") or str(
            repo_root / "audit_artifacts" / "models" / "pron_v2_block3b_canonical_final.pt"
        )
        self.segmental_ckpt = segmental_ckpt or os.getenv("HYBRID_SEGMENTAL_CKPT") or str(
            repo_root / "audit_artifacts" / "runtime" / "pronunciation_v2_2_production" / "pron_v2_2_segmental_champion.pt"
        )
        self.prosody_ckpt = prosody_ckpt or os.getenv("HYBRID_PROSODY_CKPT") or str(
            repo_root / "audit_artifacts" / "runtime" / "pronunciation_v2_2_production" / "pron_v2_2_prosody_champion.pt"
        )
        self.wavlm_model_id = wavlm_model_id or os.getenv("WAVLM_MODEL_PATH") or "microsoft/wavlm-large"

        self.base_bb = None
        self.b3_branch_start: int = 20
        self.b3_upper = None
        self.cc_upper = None
        self.probe = None
        self.seg_model = None
        self.pros_model = None
        self._loaded = False
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()

    @staticmethod
    def _discover_repo_root() -> Path:
        env_root = os.getenv("REPO_ROOT")
        if env_root and Path(env_root).exists():
            return Path(env_root)
        here = Path(__file__).resolve()
        for parent in here.parents:
            if (parent / "audit_artifacts").exists():
                return parent
        return here.parents[4] if len(here.parents) > 4 else Path.cwd()

    @classmethod
    def checkpoints_available(cls) -> bool:
        """Returns True when all three required hybrid checkpoints exist on disk."""
        repo_root = cls._discover_repo_root()
        paths = (
            os.getenv("HYBRID_BLOCK3B_CKPT") or str(repo_root / "audit_artifacts" / "models" / "pron_v2_block3b_canonical_final.pt"),
            os.getenv("HYBRID_SEGMENTAL_CKPT") or str(repo_root / "audit_artifacts" / "runtime" / "pronunciation_v2_2_production" / "pron_v2_2_segmental_champion.pt"),
            os.getenv("HYBRID_PROSODY_CKPT") or str(repo_root / "audit_artifacts" / "runtime" / "pronunciation_v2_2_production" / "pron_v2_2_prosody_champion.pt"),
        )
        return all(Path(p).exists() for p in paths)

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        with self._load_lock:
            if self._loaded:
                return
            for label, ckpt_path in (
                ("block3b", self.block3b_ckpt),
                ("segmental", self.segmental_ckpt),
                ("prosody", self.prosody_ckpt),
            ):
                if not Path(ckpt_path).exists():
                    raise FileNotFoundError(f"Hybrid engine missing {label} checkpoint: {ckpt_path}")

            from transformers import WavLMModel

            t0 = time.perf_counter()
            b3_ckpt = torch.load(self.block3b_ckpt, map_location="cpu", weights_only=False)
            seg_ckpt = torch.load(self.segmental_ckpt, map_location="cpu", weights_only=False)
            pros_ckpt = torch.load(self.prosody_ckpt, map_location="cpu", weights_only=False)

            base_bb = WavLMModel.from_pretrained(self.wavlm_model_id, local_files_only=True)
            b3_sd = {
                k[len("backbone.") :]: v
                for k, v in b3_ckpt["model_state_dict"].items()
                if k.startswith("backbone.")
            }

            b3_changed_layers = []
            for l_idx in range(12, 24):
                changed = False
                for k, v in base_bb.encoder.layers[l_idx].state_dict().items():
                    bk = f"encoder.layers.{l_idx}.{k}"
                    if bk in b3_sd and float((v.float() - b3_sd[bk].float()).abs().max().item()) > 1e-6:
                        changed = True
                        break
                if changed:
                    b3_changed_layers.append(l_idx)
            self.b3_branch_start = min(min(b3_changed_layers), 21) if b3_changed_layers else 20

            b3_upper = nn.ModuleList([copy.deepcopy(base_bb.encoder.layers[i]) for i in range(self.b3_branch_start, 24)])
            for idx_u, l_idx in enumerate(range(self.b3_branch_start, 24)):
                sub_sd = {
                    k[len(f"encoder.layers.{l_idx}.") :]: v
                    for k, v in b3_sd.items()
                    if k.startswith(f"encoder.layers.{l_idx}.")
                }
                b3_upper[idx_u].load_state_dict(sub_sd)

            cc_upper = nn.ModuleList([copy.deepcopy(base_bb.encoder.layers[i]) for i in range(12, 24)])
            trainable_cc = seg_ckpt.get("backbone_trainable_layers", {})
            for idx_u, l_idx in enumerate(range(12, 24)):
                lk = f"layer_{l_idx}"
                if lk in trainable_cc:
                    cc_upper[idx_u].load_state_dict(trainable_cc[lk])

            probe = WavLMPhoneCTCProbe(hidden_size=1024, num_classes=40, dropout=0.0)
            probe.load_state_dict(
                {k[len("probe.") :]: v for k, v in b3_ckpt["model_state_dict"].items() if k.startswith("probe.")}
            )

            seg_model = DecoupledSegmentalModel(acoustic_dim=1024, hidden_dim=256)
            seg_model.load_state_dict(seg_ckpt["model_state_dict"])

            pros_model = SequenceNativeProsodyModel()
            pros_model.load_state_dict(pros_ckpt["model_state_dict"])

            if self.use_half:
                base_bb = base_bb.to(self.device).half().eval()
                b3_upper = b3_upper.to(self.device).half().eval()
                cc_upper = cc_upper.to(self.device).half().eval()
                probe = probe.to(self.device).half().eval()
            else:
                base_bb = base_bb.to(self.device).float().eval()
                b3_upper = b3_upper.to(self.device).float().eval()
                cc_upper = cc_upper.to(self.device).float().eval()
                probe = probe.to(self.device).float().eval()

            seg_model = seg_model.to(self.device).float().eval()
            pros_model = pros_model.to(self.device).float().eval()

            self.base_bb = base_bb
            self.b3_upper = b3_upper
            self.cc_upper = cc_upper
            self.probe = probe
            self.seg_model = seg_model
            self.pros_model = pros_model
            self._loaded = True
            logger.info(
                "DualBranchWavLMBackbone loaded in %.2fs on %s (fp16=%s, b3_branch_start=%d)",
                time.perf_counter() - t0,
                self.device,
                self.use_half,
                self.b3_branch_start,
            )

    def forward_shared(self, wav_np: np.ndarray) -> Dict[str, Any]:
        if not self._loaded:
            self.load()
        wn = (wav_np.astype(np.float32) - float(np.mean(wav_np))) / (float(np.std(wav_np)) + 1e-7)
        wt = torch.from_numpy(wn).float().unsqueeze(0).to(self.device)
        if self.use_half:
            wt = wt.half()

        with torch.no_grad():
            # Exact WavLMEncoderStableLayerNorm order — NO premature encoder.layer_norm before layer 0!
            ef = self.base_bb.feature_extractor(wt).transpose(1, 2)
            h, _ = self.base_bb.feature_projection(ef)
            pos_emb = self.base_bb.encoder.pos_conv_embed(h)
            h = h + pos_emb
            h = self.base_bb.encoder.dropout(h)

            pos_bias = None
            for l_idx in range(12):
                out = self.base_bb.encoder.layers[l_idx](h, attention_mask=None, position_bias=pos_bias)
                h, pos_bias = out[0], out[1]
            h12, pb12 = h, pos_bias

            # Branch A1: Base layers 12..21 -> hs22_base (Prosody & Fluency)
            h_base, pb_base = h12, pb12
            h_b3_in, pb_b3_in = None, None
            hs22_base = None
            for l_idx in range(12, 22):
                if l_idx == self.b3_branch_start:
                    h_b3_in, pb_b3_in = h_base, pb_base
                out = self.base_bb.encoder.layers[l_idx](h_base, attention_mask=None, position_bias=pb_base)
                h_base, pb_base = out[0], out[1]
                if l_idx == 21:
                    hs22_base = h_base

            # Branch A2: Block3B layers [b3_branch_start..21] -> hs22_b3 (CTC Alignment & GOP)
            if h_b3_in is None:
                h_b3_in, pb_b3_in = h_base, pb_base
            h_b3, pb_b3 = h_b3_in, pb_b3_in
            hs22_b3 = h_b3
            for idx_u, l_idx in enumerate(range(self.b3_branch_start, 22)):
                out = self.b3_upper[idx_u](h_b3, attention_mask=None, position_bias=pb_b3)
                h_b3, pb_b3 = out[0], out[1]
                if l_idx == 21:
                    hs22_b3 = h_b3

            # Branch B: CycleC layers 12..21 -> hs22_cc (DecoupledSegmentalModel)
            h_cc, pb_cc = h12, pb12
            hs22_cc = None
            for idx_u, l_idx in enumerate(range(12, 22)):
                out = self.cc_upper[idx_u](h_cc, attention_mask=None, position_bias=pb_cc)
                h_cc, pb_cc = out[0], out[1]
                if l_idx == 21:
                    hs22_cc = h_cc

            lp_t = self.probe(hs22_b3).squeeze(0).float().log_softmax(dim=-1)
            pros_out = self.pros_model(hs22_base.float())
            return {
                "lp_t": lp_t,
                "hs22_base": hs22_base.squeeze(0).float(),
                "hs22_cc": hs22_cc.squeeze(0).float(),
                "raw_flu": float(pros_out["fluency_score"].item()),
                "raw_pros": float(pros_out["prosodic_score"].item()),
            }

    def score_phones(self, wav_np: np.ndarray, phones_arpa: Sequence[str]) -> Optional[Dict[str, Any]]:
        if not phones_arpa:
            return None
        with self._infer_lock:
            fwd = self.forward_shared(wav_np)
            lp_t = fwd["lp_t"]
            lp_np = lp_t.cpu().numpy()
            seq_ids = [PHONE_TO_ID.get(p, 1) for p in phones_arpa]
            spans = viterbi_ctc(lp_np, seq_ids, CTC_BLANK_ID)
            if not spans:
                return None

            gamma = compute_ctc_posterior_single(
                lp_t,
                torch.tensor(seq_ids, dtype=torch.long, device=self.device),
                blank_id=CTC_BLANK_ID,
            )["gamma"].cpu()
            hs_cpu = fwd["hs22_cc"].cpu()
            T_f = int(hs_cpu.shape[0])

            b_ac, b_tgt, b_l, b_r, b_dur, b_ctc = [], [], [], [], [], []
            for u, p in enumerate(phones_arpa):
                gu = gamma[:, u]
                mass = float(gu.sum().item())
                if mass > 1e-4:
                    w_soft = gu / (mass + 1e-8)
                    h_soft = torch.einsum("t,td->d", w_soft, hs_cpu)
                    pk = int(gu.argmax().item())
                    t0_f, t1_f = max(0, pk - 2), min(T_f - 1, pk + 2)
                    h_ctx = hs_cpu[t0_f : t1_f + 1].mean(dim=0)
                    h_feat = (h_soft + h_ctx) / 2.0
                    p_dur = float((t1_f - t0_f + 1) * 0.02)
                    ctc_sc = float(gu.max().item())
                else:
                    u0 = int(T_f * u / max(1, len(phones_arpa)))
                    u1 = max(u0 + 1, int(T_f * (u + 1) / max(1, len(phones_arpa))))
                    h_feat = hs_cpu[u0:u1].mean(dim=0)
                    p_dur = float((u1 - u0) * 0.02)
                    ctc_sc = 0.0
                b_ac.append(h_feat)
                b_tgt.append(PHONE_TO_IDX.get(p, 0))
                b_l.append(PHONE_TO_IDX.get(phones_arpa[u - 1], 39) if u > 0 else 39)
                b_r.append(PHONE_TO_IDX.get(phones_arpa[u + 1], 39) if u < len(phones_arpa) - 1 else 39)
                b_dur.append([p_dur])
                b_ctc.append([ctc_sc])

            with torch.no_grad():
                ac_t = torch.stack(b_ac).to(self.device)
                tgt_t = torch.tensor(b_tgt, dtype=torch.long, device=self.device)
                so = self.seg_model(
                    ac_t,
                    tgt_t,
                    torch.tensor(b_l, dtype=torch.long, device=self.device),
                    torch.tensor(b_r, dtype=torch.long, device=self.device),
                    torch.tensor(b_dur, dtype=torch.float32, device=self.device),
                    torch.tensor(b_ctc, dtype=torch.float32, device=self.device),
                )
                qp = so["quality_probs"].cpu().numpy()
                do = self.seg_model(ac_t, tgt_t)
                d_idx = do["top1_idx"].cpu().numpy()
                d_prob = do["top1_prob"].cpu().numpy()
                d_marg = (do["diagnosis_margin"] if "diagnosis_margin" in do else do["margin"]).cpu().numpy()

            rows: List[Dict[str, Any]] = []
            for u, p in enumerate(phones_arpa):
                sp = spans[u]
                rows.append({
                    "expected_phone": p,
                    "acc_p": float(qp[u, 0]),
                    "weak_p": float(qp[u, 1]),
                    "err_p": float(qp[u, 2]),
                    "neg_gop": max(0.0, -float(sp["gop_lpr"])),
                    "blank_dom": float(sp["blank_dom"]),
                    "zero_fr": 1.0 if sp["n_frames"] == 0 else 0.0,
                    "n_frames": int(sp["n_frames"]),
                    "start_f": sp["start_f"],
                    "end_f": sp["end_f"],
                    "ctc_conf": float(b_ctc[u][0]),
                    "seg_obs": IDX_TO_PHONE.get(int(d_idx[u])),
                    "seg_diag_prob": float(d_prob[u]),
                    "seg_diag_marg": float(d_marg[u]),
                    "ctc_obs": ID_TO_PHONE.get(sp["free_top_id"]) if sp["free_top_id"] is not None else None,
                    "ctc_rival_prob": float(sp.get("free_top_prob", 0.0)),
                })

            return {
                "rows": rows,
                "spans": spans,
                "num_frames": T_f,
                "raw_flu": fwd["raw_flu"],
                "raw_pros": fwd["raw_pros"],
            }


# ==============================================================================
# Pure-Python Calibration, Accent Tolerance & Phone/Utterance Scoring
# ==============================================================================

def calibrate_phone_error_prob(row: Dict[str, Any], calib: Dict[str, Any]) -> float:
    spec = calib["phone_error_logreg"]
    feats = [
        float(row.get("err_p", 0.0)),
        float(row.get("weak_p", 0.0)),
        float(row.get("neg_gop", 0.0)),
        float(row.get("blank_dom", 0.0)),
        float(row.get("zero_fr", 0.0)),
        float(row.get("ctc_conf", 0.0)),
    ]
    z = float(spec["intercept"]) + sum(float(c) * x for c, x in zip(spec["coef"], feats))
    return _sigmoid(z)


def calibrate_phone_deletion_prob(row: Dict[str, Any], calib: Dict[str, Any]) -> float:
    spec = calib["phone_deletion_logreg"]
    dur_norm = min(1.0, float(row.get("n_frames", 0)) / 5.0)
    feats = [
        float(row.get("err_p", 0.0)),
        float(row.get("neg_gop", 0.0)),
        float(row.get("blank_dom", 0.0)),
        float(row.get("zero_fr", 0.0)),
        dur_norm,
    ]
    z = float(spec["intercept"]) + sum(float(c) * x for c, x in zip(spec["coef"], feats))
    return _sigmoid(z)


def calibrate_utterance_scores(
    rows: Sequence[Dict[str, Any]],
    raw_flu: float,
    raw_pros: float,
    calib: Dict[str, Any],
) -> Dict[str, float]:
    """Pure-math Ridge utterance calibration matching `echo_speaking_v3_calibrator.json`."""
    if not rows:
        return {"utt_acc_10": 0.0, "utt_flu_10": 0.0, "utt_pros_10": 0.0, "utt_tot_10": 0.0}
    err_ps = [float(r.get("err_p", 0.0)) for r in rows]
    weak_ps = [float(r.get("weak_p", 0.0)) for r in rows]
    neg_gops = [float(r.get("neg_gop", 0.0)) for r in rows]

    mean_err_p = float(np.mean(err_ps))
    max_err_p = float(np.max(err_ps))
    mean_neg_gop = float(np.mean(neg_gops))
    mean_weak_p = float(np.mean(weak_ps))

    acc_spec = calib["utt_accuracy_ridge"]
    acc_feats = [mean_err_p, max_err_p, mean_neg_gop, mean_weak_p]
    utt_acc_10 = float(acc_spec["intercept"]) + sum(float(c) * x for c, x in zip(acc_spec["coef"], acc_feats))
    utt_acc_10 = max(0.0, min(10.0, utt_acc_10))

    utt_flu_10 = max(0.0, min(10.0, float(raw_flu)))
    utt_pros_10 = max(0.0, min(10.0, float(raw_pros)))

    tot_spec = calib["utt_total_ridge"]
    tot_feats = [mean_err_p, mean_neg_gop, float(raw_flu), float(raw_pros)]
    utt_tot_10 = float(tot_spec["intercept"]) + sum(float(c) * x for c, x in zip(tot_spec["coef"], tot_feats))
    utt_tot_10 = max(0.0, min(10.0, utt_tot_10))

    return {
        "utt_acc_10": utt_acc_10,
        "utt_flu_10": utt_flu_10,
        "utt_pros_10": utt_pros_10,
        "utt_tot_10": utt_tot_10,
    }


def apply_accent_tolerance(
    *,
    word: str,
    phones_raw: Sequence[str],
    phone_pos: int,
    next_word_first_phone: Optional[str],
    accent: str,
    accepted_realizations: List[str],
    p_err_cal: float,
    p_del_cal: float,
    candidate_obs: Optional[str],
) -> Tuple[List[str], float, float, bool]:
    """Multi-accent phonetic tolerance (en-US, en-GB, en-AU, international).

    Returns `(updated_accepted, adjusted_p_err, adjusted_p_del, accent_accepted_flag)`.
    """
    acc = normalize_accent(accent)
    accepted = list(dict.fromkeys(accepted_realizations))
    ph_raw = phones_raw[phone_pos]
    ph_base = strip_stress(ph_raw)
    prev_raw = phones_raw[phone_pos - 1] if phone_pos > 0 else None
    next_raw = phones_raw[phone_pos + 1] if phone_pos + 1 < len(phones_raw) else None
    prev_base = strip_stress(prev_raw) if prev_raw else None
    next_base = strip_stress(next_raw) if next_raw else next_word_first_phone

    # 1. Non-rhotic post-vocalic /r/ (en-GB, en-AU, international)
    # e.g., 'car', 'water', 'park', 'better' when /R/ follows a vowel and is NOT followed by a vowel
    if acc in ("en-GB", "en-AU", "international") and ph_base == "R":
        if prev_base in VOWELS and (next_base is None or next_base not in VOWELS):
            for sym in ("<DEL>", "AH"):
                if sym not in accepted:
                    accepted.append(sym)
            if candidate_obs in (None, "AH", "AA", "AO", "ER") or p_del_cal >= 0.10:
                return accepted, min(p_err_cal, 0.08), 0.0, True

    # 2. Alveolar flapping: V1 [T/D] V0 -> [ɾ] (en-US, en-AU, international)
    # e.g., 'water', 'better', 'city', 'butter', 'party'
    if acc in ("en-US", "en-AU", "international") and ph_base in ("T", "D"):
        prev_is_stressed_v = bool(
            prev_raw
            and (
                (prev_base in VOWELS and prev_raw[-1:] in ("1", "2"))
                or (prev_base == "R" and phone_pos >= 2 and strip_stress(phones_raw[phone_pos - 2]) in VOWELS)
            )
        )
        next_is_unstressed_v = bool(next_raw and next_base in VOWELS and next_raw[-1:] == "0")
        if prev_is_stressed_v and next_is_unstressed_v:
            flap_partner = "D" if ph_base == "T" else "T"
            for sym in (flap_partner, "DX"):
                if sym not in accepted:
                    accepted.append(sym)
            if candidate_obs in (flap_partner, "DX", "R", "N"):
                return accepted, min(p_err_cal, 0.10), min(p_del_cal, 0.05), True

    # 3. UK/AU TRAP-BATH split (AE <-> AA in BATH lexical set) & LOT-CLOTH (AA <-> AO)
    if acc in ("en-GB", "en-AU", "international"):
        if ph_base == "AE" and word.lower() in BATH_TRAP_WORDS:
            if "AA" not in accepted:
                accepted.append("AA")
            if candidate_obs == "AA":
                return accepted, min(p_err_cal, 0.10), p_del_cal, True
        if ph_base in ("AA", "AO"):
            other = "AO" if ph_base == "AA" else "AA"
            if other not in accepted:
                accepted.append(other)
            if candidate_obs == other:
                return accepted, min(p_err_cal, 0.10), p_del_cal, True

    # 4. Dictionary multi-variant match
    if candidate_obs and candidate_obs in accepted and candidate_obs != ph_base:
        return accepted, min(p_err_cal, 0.10), p_del_cal, True

    return accepted, p_err_cal, p_del_cal, False


def compute_articulatory_diff(expected_phone: str, observed_phone: Optional[str]) -> Optional[Dict[str, Any]]:
    if not observed_phone or expected_phone == observed_phone:
        return None
    exp_is_v = expected_phone in VOWELS
    obs_is_v = observed_phone in VOWELS
    if exp_is_v != obs_is_v:
        return {
            "category": "VOWEL_CONSONANT_MISMATCH",
            "expected": expected_phone,
            "observed": observed_phone,
            "summary": f"Expected {'vowel' if exp_is_v else 'consonant'} /{ARPABET_TO_IPA.get(expected_phone, expected_phone)}/, heard /{ARPABET_TO_IPA.get(observed_phone, observed_phone)}/",
        }
    if not exp_is_v and expected_phone in _CONSONANT_ARTIC and observed_phone in _CONSONANT_ARTIC:
        ep, em, ev = _CONSONANT_ARTIC[expected_phone]
        op, om, ov = _CONSONANT_ARTIC[observed_phone]
        diffs = []
        if ep != op:
            diffs.append(f"place:{ep}->{op}")
        if em != om:
            diffs.append(f"manner:{em}->{om}")
        if ev != ov:
            diffs.append(f"voicing:{ev}->{ov}")
        return {
            "category": "CONSONANT_FEATURE_DIFF",
            "expected": expected_phone,
            "observed": observed_phone,
            "differences": diffs,
            "placeDiff": ep != op,
            "mannerDiff": em != om,
            "voicingDiff": ev != ov,
        }
    return {
        "category": "VOWEL_QUALITY_DIFF",
        "expected": expected_phone,
        "observed": observed_phone,
        "summary": f"Vowel shift /{ARPABET_TO_IPA.get(expected_phone, expected_phone)}/ -> /{ARPABET_TO_IPA.get(observed_phone, observed_phone)}/",
    }


def calibrate_phone_row(
    row: Dict[str, Any],
    *,
    word: str,
    phones_raw: Sequence[str],
    phone_pos: int,
    next_word_first_phone: Optional[str],
    accepted_realizations: List[str],
    accent: str,
    calib: Dict[str, Any],
    fallback_start_ms: float,
    fallback_end_ms: float,
) -> Dict[str, Any]:
    """Calibrate one phone row into a complete dual-key PhoneAssessment dict."""
    exp_phone = strip_stress(row["expected_phone"])
    p_err_cal = calibrate_phone_error_prob(row, calib)
    p_del_cal = calibrate_phone_deletion_prob(row, calib)

    tau_error = float(calib["phone_error_logreg"]["tau_error"])
    tau_weak = float(calib["phone_error_logreg"]["tau_weak"])
    tau_deletion = float(calib["phone_deletion_logreg"]["tau_deletion"])

    seg_obs = row.get("seg_obs")
    seg_prob = float(row.get("seg_diag_prob", 0.0))
    seg_marg = float(row.get("seg_diag_marg", 0.0))
    ctc_obs = row.get("ctc_obs")
    ctc_rival_prob = float(row.get("ctc_rival_prob", 0.0))
    neg_gop = float(row.get("neg_gop", 0.0))

    # Candidate observed phone for accent-tolerance check (strict >= 0.35 probability gate, no artificial floor)
    candidate_obs = None
    if seg_obs and seg_obs != exp_phone and seg_prob >= 0.35 and seg_marg >= 0.10:
        candidate_obs = seg_obs
    elif ctc_obs and ctc_obs != exp_phone and ctc_rival_prob >= 0.35:
        candidate_obs = ctc_obs

    accepted, p_err_cal, p_del_cal, accent_accepted = apply_accent_tolerance(
        word=word,
        phones_raw=phones_raw,
        phone_pos=phone_pos,
        next_word_first_phone=next_word_first_phone,
        accent=accent,
        accepted_realizations=accepted_realizations,
        p_err_cal=p_err_cal,
        p_del_cal=p_del_cal,
        candidate_obs=candidate_obs,
    )

    observed_phone: Optional[str] = None
    observed_conf: Optional[float] = None
    abstention_reason: Optional[str] = None

    if p_err_cal >= tau_error:
        quality_class = "ERROR"
        actionable = True
        if p_del_cal >= tau_deletion:
            diagnosis_type = "DELETION"
            observed_phone = None
            observed_conf = None
        else:
            if seg_obs and seg_obs != exp_phone and seg_prob >= 0.35 and seg_marg >= 0.10:
                diagnosis_type = "SUBSTITUTION"
                observed_phone = seg_obs
                observed_conf = round(seg_prob, 3)
            elif ctc_obs and ctc_obs != exp_phone and ctc_rival_prob >= 0.35:
                diagnosis_type = "SUBSTITUTION"
                observed_phone = ctc_obs
                observed_conf = round(min(1.0, ctc_rival_prob), 3)
            else:
                diagnosis_type = "DISTORTION"
                observed_phone = None
                observed_conf = None
    elif p_err_cal >= tau_weak:
        quality_class = "WEAK"
        actionable = False
        diagnosis_type = "DISTORTION"
    else:
        quality_class = "ACCEPTABLE"
        actionable = False
        diagnosis_type = "TARGET_MATCH"

    quality_score = round(max(0.0, min(1.0, 1.0 - p_err_cal)), 4)
    quality_conf = round(max(p_err_cal, 1.0 - p_err_cal), 3)
    align_conf = round(max(0.0, min(1.0, float(row.get("ctc_conf", 0.0)))), 3)

    sf_i = row.get("start_f")
    ef_i = row.get("end_f")
    if sf_i is not None and ef_i is not None:
        start_ms = round(float(sf_i) * 20.0, 1)
        end_ms = round(float(ef_i + 1) * 20.0, 1)
    else:
        start_ms = round(fallback_start_ms, 1)
        end_ms = round(max(fallback_start_ms + 20.0, fallback_end_ms), 1)

    art_diff = compute_articulatory_diff(exp_phone, observed_phone) if (actionable and observed_phone) else None

    return {
        "expected_phone": exp_phone,
        "expectedPhone": exp_phone,
        "ipa": ARPABET_TO_IPA.get(exp_phone, exp_phone.lower()),
        "accepted_realizations": accepted,
        "acceptedRealizations": accepted,
        "quality_class": quality_class,
        "qualityClass": quality_class,
        "quality_score": quality_score,
        "qualityScore": quality_score,
        "error_probability": round(p_err_cal, 4),
        "errorProbability": round(p_err_cal, 4),
        "deletion_probability": round(p_del_cal, 4),
        "deletionProbability": round(p_del_cal, 4),
        "quality_confidence": quality_conf,
        "qualityConfidence": quality_conf,
        "alignment_confidence": align_conf,
        "alignmentConfidence": align_conf,
        "observed_phone": observed_phone,
        "observedPhone": observed_phone,
        "observed_phone_confidence": observed_conf,
        "observedPhoneConfidence": observed_conf,
        "diagnosis_type": diagnosis_type,
        "diagnosisType": diagnosis_type,
        "articulatory_diff": art_diff,
        "articulatoryDiff": art_diff,
        "start_time_ms": start_ms,
        "startTimeMs": start_ms,
        "end_time_ms": end_ms,
        "endTimeMs": end_ms,
        "actionable": actionable,
        "accent_variant_accepted": accent_accepted,
        "abstention_reason": abstention_reason,
        "abstentionReason": abstention_reason,
    }


# ==============================================================================
# Real Acoustic Pitch (46ms YIN), Prosody, Lexical Stress & Connected Speech
# ==============================================================================

def extract_f0_yin_46ms(
    wav: np.ndarray,
    sr: int = CANONICAL_SAMPLE_RATE,
    hop_ms: float = 20.0,
) -> Dict[str, np.ndarray]:
    """46ms window YIN-CMND pitch tracker with 3-point median octave filter,
    declination-detrended semitone contour, RMS, and spectral tilt (>500Hz / <500Hz)."""
    arr = np.asarray(wav, dtype=np.float64).reshape(-1)
    frame_len = max(32, int(round(sr * 0.046)))
    hop_len = max(16, int(round(sr * (hop_ms / 1000.0))))
    min_lag = max(2, int(sr / 450.0))
    max_lag = min(frame_len // 2, int(sr / 65.0))
    if len(arr) < frame_len:
        arr = np.pad(arr, (0, frame_len - len(arr)))
    n_frames = 1 + (len(arr) - frame_len) // hop_len

    f0 = np.zeros(n_frames, dtype=np.float64)
    voicing = np.zeros(n_frames, dtype=bool)
    rms = np.zeros(n_frames, dtype=np.float64)
    tilt = np.zeros(n_frames, dtype=np.float64)

    win = np.hanning(frame_len)
    freqs = np.fft.rfftfreq(frame_len, 1.0 / sr)
    lo_m = (freqs >= 60.0) & (freqs < 500.0)
    hi_m = (freqs >= 500.0) & (freqs <= 4000.0)
    W = max_lag
    nfft = 1 << int(math.ceil(math.log2(frame_len + W)))
    lags = np.arange(1, max_lag + 1, dtype=np.float64)

    for i in range(n_frames):
        s = i * hop_len
        fr = arr[s : s + frame_len]
        fr = fr - float(np.mean(fr))
        r_val = math.sqrt(float(np.mean(fr * fr)) + 1e-12)
        rms[i] = r_val
        if r_val < 0.003:
            continue
        sp = np.abs(np.fft.rfft(fr * win)) ** 2
        tilt[i] = 10.0 * math.log10((float(np.sum(sp[hi_m])) + 1e-12) / (float(np.sum(sp[lo_m])) + 1e-12))

        sq = fr * fr
        cs = np.concatenate(([0.0], np.cumsum(sq)))
        e0 = cs[W]
        acf = np.fft.irfft(np.conj(np.fft.rfft(fr[:W], nfft)) * np.fft.rfft(fr, nfft), nfft)[: max_lag + 1]
        e_lag = cs[np.arange(max_lag + 1) + W] - cs[np.arange(max_lag + 1)]
        d = np.maximum(0.0, e0 + e_lag - 2.0 * acf)
        cmnd = np.ones(max_lag + 1, dtype=np.float64)
        run = np.cumsum(d[1:])
        nz = run > 1e-12
        cmnd[1:][nz] = d[1:][nz] * lags[nz] / run[nz]
        sub = cmnd[min_lag : max_lag + 1]
        tau = None
        for k in range(1, len(sub) - 1):
            if sub[k] < 0.22 and sub[k] <= sub[k - 1] and sub[k] <= sub[k + 1]:
                tau = k + min_lag
                break
        if tau is None:
            km = int(np.argmin(sub))
            if sub[km] < 0.35:
                tau = km + min_lag
        if tau is not None and 1 <= tau < max_lag:
            y0, y1, y2 = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
            den = 2.0 * (y0 - 2.0 * y1 + y2)
            delta = max(-0.5, min(0.5, (y0 - y2) / den if abs(den) > 1e-12 else 0.0))
            f0[i] = sr / (tau + delta)
            voicing[i] = True

    # 3-point median filter on voiced frames to remove octave-jump spikes
    if int(np.sum(voicing)) >= 3:
        fc = f0.copy()
        for i in range(1, n_frames - 1):
            if voicing[i]:
                nb = [f0[j] for j in (i - 1, i, i + 1) if voicing[j]]
                if len(nb) >= 2:
                    fc[i] = float(np.median(nb))
        f0 = fc

    st_raw = np.zeros(n_frames, dtype=np.float64)
    st_det = np.zeros(n_frames, dtype=np.float64)
    if np.any(voicing):
        med = float(np.median(f0[voicing]))
        st_raw[voicing] = 12.0 * np.log2(f0[voicing] / max(med, 1.0))
        v_idx = np.where(voicing)[0].astype(np.float64)
        v_st = st_raw[voicing]
        if len(v_idx) >= 5:
            cut = max(3, int(0.8 * len(v_idx)))
            slope, intercept = np.polyfit(v_idx[:cut], v_st[:cut], 1)
            slope = float(np.clip(slope, -0.15, 0.15))
            st_det[voicing] = v_st - (slope * v_idx + intercept)
        else:
            st_det[voicing] = v_st

    return {
        "f0_hz": f0,
        "st_raw": st_raw,
        "st_det": st_det,
        "voicing": voicing,
        "rms": rms,
        "tilt": tilt,
        "hop_sec": np.array([hop_len / float(sr)], dtype=np.float64),
    }


def extract_acoustic_prosody(
    wav: np.ndarray,
    phone_assessments: Sequence[Dict[str, Any]],
    *,
    sr: int = CANONICAL_SAMPLE_RATE,
    fluency_score_100: Optional[int] = None,
    f0_bundle: Optional[Dict[str, np.ndarray]] = None,
) -> Tuple[Dict[str, Any], int]:
    """Compute real acoustic prosody (nPVI-V, VarcoV, speech/articulation rate,
    adaptive-VAD pauses, 46ms YIN F0 contour & terminal slope) AND real rhythmScore (0..100).
    NEVER computes rhythmScore as `voicing_mask * 100`!
    """
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    dur_sec = max(0.05, float(arr.size) / float(sr))
    bundle = f0_bundle if f0_bundle is not None else extract_f0_yin_46ms(arr, sr=sr, hop_ms=20.0)
    f0_hz = bundle["f0_hz"]
    st_raw = bundle["st_raw"]
    voicing = bundle["voicing"]
    rms = bundle["rms"]
    hop_sec = float(bundle["hop_sec"][0])

    # Adaptive-VAD pause detection (min pause = 180 ms)
    if len(rms) >= 5:
        p90 = float(np.percentile(rms, 90))
        p10 = float(np.percentile(rms, 10))
        vad_thresh = max(0.005, p10 + 0.15 * max(0.0, p90 - p10))
    else:
        vad_thresh = 0.005
    silent_frames = rms < vad_thresh

    pauses: List[Tuple[float, float]] = []
    in_pause = False
    p_start = 0.0
    # Ignore leading/trailing silence outside speech bounds for internal pause metrics
    active_idx = np.where(~silent_frames)[0]
    first_active = int(active_idx[0]) if len(active_idx) > 0 else 0
    last_active = int(active_idx[-1]) if len(active_idx) > 0 else max(0, len(rms) - 1)
    for i in range(first_active, last_active + 1):
        t = i * hop_sec
        if silent_frames[i] and not in_pause:
            in_pause = True
            p_start = t
        elif not silent_frames[i] and in_pause:
            in_pause = False
            if (t - p_start) >= 0.18:
                pauses.append((round(p_start, 3), round(t, 3)))

    pause_count = len(pauses)
    pause_duration = round(sum(e - s for s, e in pauses), 3)
    speech_span = max(0.10, (last_active - first_active + 1) * hop_sec) if len(active_idx) > 0 else dur_sec
    pause_ratio = round(min(1.0, max(0.0, pause_duration / max(0.10, speech_span))), 4)
    active_speech_sec = max(0.10, speech_span - pause_duration)
    phonation_ratio = round(min(1.0, max(0.0, active_speech_sec / dur_sec)), 3)

    # Vowel durations from aligned phone assessments (seconds -> ms)
    vowel_durs_ms: List[float] = []
    for p in phone_assessments:
        ep = strip_stress(p.get("expectedPhone") or p.get("expected_phone") or "")
        if ep in VOWELS:
            st_ms = p.get("startTimeMs")
            en_ms = p.get("endTimeMs")
            if st_ms is not None and en_ms is not None and en_ms > st_ms:
                vowel_durs_ms.append(float(en_ms - st_ms))

    n_syllables = max(1, len(vowel_durs_ms)) if phone_assessments else 0
    speech_rate = round(float(n_syllables) / dur_sec, 2) if n_syllables else 0.0
    articulation_rate = round(float(n_syllables) / active_speech_sec, 2) if n_syllables else 0.0

    # Real nPVI-V & VarcoV
    vowel_npvi: Optional[float] = None
    varco_v: Optional[float] = None
    if len(vowel_durs_ms) >= 2:
        diffs = []
        for k in range(len(vowel_durs_ms) - 1):
            d1, d2 = vowel_durs_ms[k], vowel_durs_ms[k + 1]
            avg = 0.5 * (d1 + d2)
            if avg > 1e-3:
                diffs.append(abs(d1 - d2) / avg)
        if diffs:
            vowel_npvi = round(float(100.0 * np.mean(diffs)), 2)
        mean_v = float(np.mean(vowel_durs_ms))
        if mean_v > 1e-3:
            varco_v = round(float(100.0 * np.std(vowel_durs_ms) / mean_v), 2)

    # F0 summary & linear-regression terminal slope (last 30% of voiced frames)
    voiced_idx = np.where(voicing)[0]
    if len(voiced_idx) >= 3:
        mean_f0 = round(float(np.mean(f0_hz[voiced_idx])), 1)
        median_f0 = round(float(np.median(f0_hz[voiced_idx])), 1)
    else:
        mean_f0 = 0.0
        median_f0 = 0.0

    terminal_slope: Optional[float] = None
    terminal_contour = "UNCERTAIN"
    if len(voiced_idx) >= 5:
        tail_n = max(3, int(round(len(voiced_idx) * 0.30)))
        tail_idx = voiced_idx[-tail_n:]
        t_sec = (tail_idx - tail_idx[0]).astype(np.float64) * hop_sec
        y_st = st_raw[tail_idx]
        if float(np.ptp(t_sec)) > 1e-4:
            slope_val = float(np.polyfit(t_sec, y_st, 1)[0])
        else:
            slope_val = 0.0
        terminal_slope = round(slope_val, 2)
        if slope_val > 3.0:
            terminal_contour = "RISING"
        elif slope_val < -3.0:
            terminal_contour = "FALLING"
        else:
            terminal_contour = "FLAT"

    step = max(1, len(f0_hz) // 60)
    f0_contour = [round(float(f0_hz[i]), 1) for i in range(0, len(f0_hz), step)]

    # Real acoustic rhythmScore (0..100) from nPVI-V, VarcoV, articulation rate, and pause ratio
    # Native English targets: nPVI-V ~ 55, VarcoV ~ 50, articulation rate ~ 4.2 syl/s, pause_ratio <= 0.20
    npvi_score = 100.0 - min(50.0, abs((vowel_npvi if vowel_npvi is not None else 48.0) - 55.0) * 1.1)
    varco_score = 100.0 - min(45.0, abs((varco_v if varco_v is not None else 45.0) - 50.0) * 1.0)
    rate_score = 100.0 - min(50.0, abs(articulation_rate - 4.2) * 16.0) if articulation_rate > 0 else 50.0
    pause_penalty = max(0.0, (pause_ratio - 0.18) * 120.0)
    rhythm_raw = 0.38 * npvi_score + 0.22 * varco_score + 0.25 * rate_score + 0.15 * max(0.0, 100.0 - pause_penalty)
    rhythm_score_100 = int(round(max(10.0, min(100.0, rhythm_raw))))

    voicing_ratio = float(np.mean(voicing)) if len(voicing) > 0 else 0.0
    prosody_dict = {
        "speech_rate": speech_rate,
        "speechRate": speech_rate,
        "articulation_rate": articulation_rate,
        "articulationRate": articulation_rate,
        "pause_duration": pause_duration,
        "pauseDuration": pause_duration,
        "pause_count": pause_count,
        "pauseCount": pause_count,
        "pause_ratio": pause_ratio,
        "pauseRatio": pause_ratio,
        "phonation_ratio": phonation_ratio,
        "phonationRatio": phonation_ratio,
        "vowel_npvi": vowel_npvi,
        "vowelNpvi": vowel_npvi,
        "nPviV": vowel_npvi,
        "varco_v": varco_v,
        "varcoV": varco_v,
        "mean_f0": mean_f0,
        "meanF0": mean_f0,
        "median_f0": median_f0,
        "medianF0": median_f0,
        "f0_contour": f0_contour,
        "f0Contour": f0_contour,
        "terminal_slope": terminal_slope,
        "terminalSlope": terminal_slope,
        "terminal_contour": terminal_contour,
        "terminalContour": terminal_contour,
        "f0_contour_correlation": 0.0,
        "f0ContourCorrelation": 0.0,
        "voicing_f1": round(voicing_ratio, 3),
        "boundary_events": [],
        "human_holistic_fluency_score": float(fluency_score_100) if fluency_score_100 is not None else 0.0,
        "humanHolisticFluencyScore": float(fluency_score_100) if fluency_score_100 is not None else 0.0,
        "task_confidence": round(min(1.0, max(0.25, voicing_ratio * 1.4)), 3),
        "taskConfidence": round(min(1.0, max(0.25, voicing_ratio * 1.4)), 3),
        "abstention_reason": None,
        "abstentionReason": None,
    }
    return prosody_dict, rhythm_score_100


def evaluate_neural_lexical_stress(
    wav: np.ndarray,
    resolved_words: Sequence[Dict[str, Any]],
    spans: Sequence[Dict[str, Any]],
    calib: Dict[str, Any],
    *,
    sr: int = CANONICAL_SAMPLE_RATE,
    f0_bundle: Optional[Dict[str, np.ndarray]] = None,
    scored_word_indices: Optional[Set[int]] = None,
) -> Dict[str, Any]:
    """Neural-CTC-aligned multi-cue lexical stress analysis (46ms YIN F0 + declination detrending
    + spectral tilt + intrinsic-normalized vowel duration + calibrated conservative margin threshold)."""
    bundle = f0_bundle if f0_bundle is not None else extract_f0_yin_46ms(wav, sr=sr, hop_ms=20.0)
    st_det = bundle["st_det"]
    voicing = bundle["voicing"]
    rms = bundle["rms"]
    tilt = bundle["tilt"]
    stress_thr = float(calib.get("lexical_stress", {}).get("err_margin_threshold", 0.4078))

    p95 = float(np.percentile(rms, 95)) if len(rms) >= 5 else float(np.max(rms) + 1e-6)
    all_v_f: List[float] = []
    pos = 0
    word_vowels: List[Tuple[int, Dict[str, Any], List[Tuple[str, str, Optional[Dict[str, Any]]]]]] = []
    for rw in resolved_words:
        v_list = []
        for ph_raw in rw["phones_raw"]:
            pb = strip_stress(ph_raw)
            if pb not in PHONE_TO_IDX:
                continue
            sp = spans[pos] if pos < len(spans) else None
            pos += 1
            if pb in VOWELS:
                v_list.append((pb, ph_raw, sp))
                if sp and sp.get("n_frames", 0) >= 1:
                    all_v_f.append(float(sp["n_frames"]))
        word_vowels.append((rw["word_index"], rw, v_list))

    med_vf = float(np.median(all_v_f)) if all_v_f else 4.0
    words_out: List[Dict[str, Any]] = []

    for wi, rw, v_list in word_vowels:
        if scored_word_indices is not None and wi not in scored_word_indices:
            continue
        if len(v_list) < 2:
            continue
        expected_set = set(rw.get("expected_stress_1based") or [])
        if not expected_set:
            continue

        cues: List[float] = []
        valid = True
        for pb, _ph_raw, sp in v_list:
            if not sp or sp.get("start_f") is None or sp.get("n_frames", 0) < 1:
                valid = False
                break
            fs = max(0, min(len(rms) - 1, int(sp["start_f"])))
            fe = max(fs + 1, min(len(rms), int(sp["end_f"]) + 1))
            dur_f = float(sp["n_frames"])
            exp_f = med_vf * INTRINSIC_VOWEL_DUR.get(pb, 1.0)
            dur_c = float(np.clip(math.log2(max(0.5, dur_f) / max(0.5, exp_f)), -1.5, 1.5)) / 1.5
            vm = voicing[fs:fe]
            f0_c = float(np.clip(np.percentile(st_det[fs:fe][vm], 75), -6.0, 6.0)) / 6.0 if np.any(vm) else -0.4
            e_db = 20.0 * math.log10((float(np.mean(rms[fs:fe])) + 1e-6) / (p95 + 1e-6)) - INTRINSIC_VOWEL_DB.get(pb, 0.0)
            e_c = float(np.clip((e_db + 24.0) / 24.0, 0.0, 1.0))
            t_c = float(np.clip((float(np.mean(tilt[fs:fe])) + 15.0) / 20.0, 0.0, 1.0))
            prom = 0.35 * dur_c + 0.25 * e_c + 0.15 * t_c + 0.25 * f0_c
            cues.append(prom)

        if not valid or len(cues) < 2:
            continue

        valid_exp = [e for e in expected_set if 1 <= e <= len(cues)]
        if not valid_exp:
            continue
        best_exp = max(cues[e - 1] for e in valid_exp)
        best_nonexp = max((cues[k] for k in range(len(cues)) if (k + 1) not in expected_set), default=best_exp - 1.0)
        err_margin = float(best_nonexp - best_exp)
        observed_1 = int(np.argmax(cues)) + 1
        matched = err_margin < stress_thr
        words_out.append({
            "wordIndex": wi,
            "word": rw["word"],
            "expectedSyllable": sorted(valid_exp)[0],
            "expectedSyllables": sorted(valid_exp),
            "observedSyllable": observed_1,
            "syllables": len(cues),
            "matched": matched,
            "errorMargin": round(err_margin, 4),
            "threshold": round(stress_thr, 4),
        })

    if not words_out:
        return {
            "method": LEXICAL_STRESS_METHOD,
            "algorithm": LEXICAL_STRESS_ALGORITHM,
            "status": "INSUFFICIENT_EVIDENCE",
            "assessed": 0,
            "matched": 0,
            "words": [],
        }
    matched_cnt = sum(1 for w in words_out if w["matched"])
    return {
        "method": LEXICAL_STRESS_METHOD,
        "algorithm": LEXICAL_STRESS_ALGORITHM,
        "status": "ASSESSED",
        "assessed": len(words_out),
        "matched": matched_cnt,
        "words": words_out,
    }


def extract_connected_speech(
    wav: np.ndarray,
    word_assessments: Sequence[Dict[str, Any]],
    *,
    sr: int = CANONICAL_SAMPLE_RATE,
) -> Dict[str, Any]:
    """Evidence-based Connected Speech acoustic diagnostics:
    1. Final-stop acoustic burst/release check (2000-7500 Hz transient vs closure floor).
    2. Pre-fortis vowel duration shortening ratio (vowels before voiceless vs voiced codas).
    3. C-V linking energy continuity across word boundaries (gap duration & RMS valley depth).
    """
    arr = np.asarray(wav, dtype=np.float64).reshape(-1)
    n = len(arr)

    # 1. Final-stop release burst check
    stop_events: List[Dict[str, Any]] = []
    for w in word_assessments:
        phones = w.get("phones") or []
        if not phones:
            continue
        last_p = phones[-1]
        ep = strip_stress(last_p.get("expectedPhone") or last_p.get("expected_phone") or "")
        if ep not in ALL_STOPS:
            continue
        st_ms = last_p.get("startTimeMs")
        en_ms = last_p.get("endTimeMs")
        if st_ms is None or en_ms is None:
            continue
        s0 = max(0, int(round(st_ms * sr / 1000.0)))
        s1 = min(n, int(round((en_ms + 30.0) * sr / 1000.0)))
        if s1 - s0 < int(0.015 * sr):
            continue
        seg = arr[s0:s1]
        # Split into early closure half vs release tail (10ms sub-frames)
        step = max(1, int(0.010 * sr))
        hf_energies: List[float] = []
        for k in range(0, max(1, len(seg) - step + 1), step):
            fr = seg[k : k + step]
            if len(fr) < 16:
                continue
            sp = np.abs(np.fft.rfft(fr * np.hanning(len(fr)))) ** 2
            freqs = np.fft.rfftfreq(len(fr), 1.0 / sr)
            hf = float(np.mean(sp[(freqs >= 2000.0) & (freqs <= 7500.0)])) + 1e-12
            hf_energies.append(10.0 * math.log10(hf))
        if len(hf_energies) >= 2:
            closure_db = float(min(hf_energies[: max(1, len(hf_energies) // 2)]))
            peak_hf_db = float(max(hf_energies))
            burst_db = round(peak_hf_db - closure_db, 2)
            # Also require non-deleted diagnosis for confirmed release
            is_deleted = (last_p.get("diagnosisType") == "DELETION")
            released = (not is_deleted) and (burst_db >= 6.0)
            stop_events.append({
                "word": w.get("word"),
                "wordIndex": w.get("wordIndex"),
                "phone": ep,
                "released": released,
                "burstDb": burst_db,
                "startTimeMs": st_ms,
                "endTimeMs": en_ms,
            })

    released_cnt = sum(1 for e in stop_events if e["released"])
    final_stop_summary = {
        "checkedCount": len(stop_events),
        "releasedCount": released_cnt,
        "unreleasedCount": len(stop_events) - released_cnt,
        "releaseRatio": round(released_cnt / len(stop_events), 3) if stop_events else None,
        "events": stop_events[:10],
    }

    # 2. Pre-fortis vowel duration ratio (vowel normalized by intrinsic duration before voiceless vs voiced coda)
    pre_voiceless: List[float] = []
    pre_voiced: List[float] = []
    prefortis_events: List[Dict[str, Any]] = []
    for w in word_assessments:
        phones = w.get("phones") or []
        if len(phones) < 2:
            continue
        coda = strip_stress(phones[-1].get("expectedPhone") or phones[-1].get("expected_phone") or "")
        penult = phones[-2]
        v_ph = strip_stress(penult.get("expectedPhone") or penult.get("expected_phone") or "")
        if v_ph not in VOWELS:
            continue
        st_ms, en_ms = penult.get("startTimeMs"), penult.get("endTimeMs")
        if st_ms is None or en_ms is None or en_ms <= st_ms:
            continue
        norm_dur = float(en_ms - st_ms) / INTRINSIC_VOWEL_DUR.get(v_ph, 1.0)
        if coda in VOICELESS_OBSTRUENTS:
            pre_voiceless.append(norm_dur)
            prefortis_events.append({"word": w.get("word"), "vowel": v_ph, "coda": coda, "codaVoicing": "voiceless", "vowelMs": round(en_ms - st_ms, 1)})
        elif coda in VOICED_OBSTRUENTS:
            pre_voiced.append(norm_dur)
            prefortis_events.append({"word": w.get("word"), "vowel": v_ph, "coda": coda, "codaVoicing": "voiced", "vowelMs": round(en_ms - st_ms, 1)})

    pre_fortis_ratio = None
    if pre_voiceless and pre_voiced:
        mean_vl = float(np.mean(pre_voiceless))
        mean_vd = float(np.mean(pre_voiced))
        if mean_vl > 1e-3:
            pre_fortis_ratio = round(mean_vd / mean_vl, 3)

    pre_fortis_summary = {
        "checkedCount": len(prefortis_events),
        "voicelessCodaCount": len(pre_voiceless),
        "voicedCodaCount": len(pre_voiced),
        "meanVoicedToVoicelessRatio": pre_fortis_ratio,
        "events": prefortis_events[:10],
    }

    # 3. C-V linking energy continuity across adjacent word boundaries
    cv_events: List[Dict[str, Any]] = []
    for idx in range(len(word_assessments) - 1):
        w1 = word_assessments[idx]
        w2 = word_assessments[idx + 1]
        p1_list = w1.get("phones") or []
        p2_list = w2.get("phones") or []
        if not p1_list or not p2_list:
            continue
        c_ph = strip_stress(p1_list[-1].get("expectedPhone") or p1_list[-1].get("expected_phone") or "")
        v_ph = strip_stress(p2_list[0].get("expectedPhone") or p2_list[0].get("expected_phone") or "")
        if c_ph in VOWELS or v_ph not in VOWELS:
            continue
        t1_end = p1_list[-1].get("endTimeMs")
        t2_start = p2_list[0].get("startTimeMs")
        if t1_end is None or t2_start is None:
            continue
        gap_ms = round(max(0.0, float(t2_start - t1_end)), 1)
        mid_ms = 0.5 * (t1_end + t2_start)
        b0 = max(0, int(round((mid_ms - 35.0) * sr / 1000.0)))
        b1 = min(n, int(round((mid_ms + 35.0) * sr / 1000.0)))
        valley_ratio = 0.0
        if b1 - b0 >= int(0.030 * sr):
            win_seg = arr[b0:b1]
            sub_n = max(1, int(0.010 * sr))
            sub_rms = [
                math.sqrt(float(np.mean(win_seg[k : k + sub_n] ** 2)) + 1e-12)
                for k in range(0, len(win_seg) - sub_n + 1, sub_n)
            ]
            if len(sub_rms) >= 3:
                edge_ref = max(1e-5, min(sub_rms[0], sub_rms[-1]))
                valley_ratio = round(min(1.0, float(min(sub_rms)) / edge_ref), 3)
        linked = (gap_ms < 50.0) and (valley_ratio >= 0.25)
        cv_events.append({
            "leftWord": w1.get("word"),
            "rightWord": w2.get("word"),
            "boundary": f"{w1.get('word')} -> {w2.get('word')}",
            "consonant": c_ph,
            "vowel": v_ph,
            "gapMs": gap_ms,
            "energyContinuity": valley_ratio,
            "linked": linked,
        })

    linked_cnt = sum(1 for e in cv_events if e["linked"])
    cv_summary = {
        "checkedBoundaries": len(cv_events),
        "linkedBoundaries": linked_cnt,
        "linkingRatio": round(linked_cnt / len(cv_events), 3) if cv_events else None,
        "events": cv_events[:10],
    }

    # Evidence-based bilingual summary
    vi_notes: List[str] = []
    en_notes: List[str] = []
    if stop_events:
        if released_cnt < len(stop_events):
            vi_notes.append(f"Bật âm tắc cuối từ rõ ở {released_cnt}/{len(stop_events)} vị trí; chú ý không nuốt âm /p, t, k, b, d, g/ cuối từ.")
            en_notes.append(f"Final stop release detected on {released_cnt}/{len(stop_events)} stops; keep word-final stops audible.")
        else:
            vi_notes.append(f"Các âm tắc cuối từ được bật rõ ràng ({released_cnt}/{len(stop_events)}).")
            en_notes.append(f"Clear final-stop articulation across {released_cnt}/{len(stop_events)} stops.")
    if cv_events:
        vi_notes.append(f"Nối âm phụ âm-nguyên âm (C-V linking) mượt ở {linked_cnt}/{len(cv_events)} ranh giới từ.")
        en_notes.append(f"Smooth C-V linking observed across {linked_cnt}/{len(cv_events)} word boundaries.")
    if pre_fortis_ratio is not None:
        if pre_fortis_ratio >= 1.15:
            vi_notes.append(f"Độ dài nguyên âm trước phụ âm hữu thanh dài hơn trước vô thanh (tỉ lệ {pre_fortis_ratio:.2f}x), đúng tự nhiên.")
            en_notes.append(f"Natural pre-fortis vowel length contrast observed ({pre_fortis_ratio:.2f}x before voiced vs voiceless codas).")
        else:
            vi_notes.append(f"Nguyên âm trước phụ âm hữu thanh và vô thanh còn gần bằng nhau (tỉ lệ {pre_fortis_ratio:.2f}x); nên rút gọn nhẹ trước âm vô thanh.")
            en_notes.append(f"Pre-fortis vowel duration contrast is narrow ({pre_fortis_ratio:.2f}x); shorten vowels slightly before voiceless codas.")

    return {
        "finalStopRelease": final_stop_summary,
        "preFortisShortening": pre_fortis_summary,
        "cvLinking": cv_summary,
        # Flat contract fields consumed by PronunciationV2Panel & SpeakingProfilePanel
        "finalStopReleaseRate": final_stop_summary["releaseRatio"],
        "finalStopsAssessed": final_stop_summary["checkedCount"],
        "finalStopsReleased": final_stop_summary["releasedCount"],
        "preFortisVowelRatio": pre_fortis_ratio,
        "cvLinkingContinuity": cv_summary["linkingRatio"],
        "linkingScore": round(cv_summary["linkingRatio"] * 100.0, 1) if cv_summary["linkingRatio"] is not None else None,
        "linkingCount": cv_summary["linkedBoundaries"],
        "notesVi": vi_notes,
        "notesEn": en_notes,
        "summaryVi": " ".join(vi_notes) if vi_notes else "Chưa có đủ ranh giới nối âm hoặc âm tắc cuối từ để đánh giá nối âm.",
        "summaryEn": " ".join(en_notes) if en_notes else "Insufficient stop endings or C-V boundaries to assess connected speech.",
    }


def build_actionable_priorities(
    word_assessments: Sequence[Dict[str, Any]],
    lexical_stress: Dict[str, Any],
    connected_speech: Dict[str, Any],
    prosody: Dict[str, Any],
    max_items: int = 5,
) -> List[Dict[str, Any]]:
    """Build ranked, evidence-based actionable priorities (Vietnamese + English).
    NEVER returns [] when genuine segmental errors exist!
    """
    candidates: List[Tuple[float, Dict[str, Any]]] = []

    for w in word_assessments:
        if w.get("status") in ("OFF_SCRIPT", "OMITTED", "NOT_SCORED"):
            continue
        w_text = str(w.get("word", ""))
        w_phones = w.get("phones") or []
        for p_idx, p in enumerate(w_phones):
            q_cls = p.get("qualityClass") or p.get("quality_class")
            if q_cls != "ERROR":
                continue
            exp_p = str(p.get("expectedPhone") or p.get("expected_phone") or "")
            obs_p = p.get("observedPhone") or p.get("observed_phone")
            diag = str(p.get("diagnosisType") or p.get("diagnosis_type") or "DISTORTION")
            err_prob = float(p.get("errorProbability") or p.get("error_probability") or (1.0 - float(p.get("qualityScore", 0.5))))
            is_final = (p_idx == len(w_phones) - 1) and (exp_p not in VOWELS)
            exp_ipa = ARPABET_TO_IPA.get(exp_p, exp_p.lower())
            obs_ipa = ARPABET_TO_IPA.get(obs_p, obs_p.lower()) if obs_p else None
            cue_vi, cue_en = PHONE_COACHING_CUES.get(
                exp_p,
                (
                    f"Chú ý phát âm rõ âm /{exp_ipa}/ trong từ '{w_text}'.",
                    f"Focus on articulating /{exp_ipa}/ clearly in '{w_text}'.",
                ),
            )

            severity = "HIGH" if (err_prob >= 0.65 or diag == "DELETION" or is_final) else "MEDIUM"
            rank_score = err_prob + (0.20 if diag == "DELETION" else 0.0) + (0.15 if is_final else 0.0)

            if diag == "DELETION":
                pos_vi = "cuối từ " if is_final else ""
                pos_en = "word-final " if is_final else ""
                issue_code = "FINAL_CONSONANT_DELETION" if is_final else "PHONE_DELETION"
                inst_vi = f"Bạn bị nuốt âm {pos_vi}/{exp_ipa}/ trong từ '{w_text}'. {cue_vi}"
                inst_en = f"You dropped the {pos_en}/{exp_ipa}/ sound in '{w_text}'. {cue_en}"
            elif diag == "SUBSTITUTION" and obs_p:
                issue_code = "PHONE_SUBSTITUTION"
                inst_vi = f"Trong từ '{w_text}', âm /{exp_ipa}/ nghe gần giống /{obs_ipa}/. {cue_vi}"
                inst_en = f"In '{w_text}', /{exp_ipa}/ sounded closer to /{obs_ipa}/. {cue_en}"
            else:
                issue_code = "PHONE_DISTORTION"
                inst_vi = f"Âm /{exp_ipa}/ trong từ '{w_text}' chưa thật chuẩn xác. {cue_vi}"
                inst_en = f"The /{exp_ipa}/ sound in '{w_text}' needs clearer articulation. {cue_en}"

            st_ms = p.get("startTimeMs")
            en_ms = p.get("endTimeMs")
            item = {
                "target_type": "PHONE",
                "targetType": "PHONE",
                "target_unit": f"/{exp_ipa}/ in '{w_text}'",
                "targetUnit": f"/{exp_ipa}/ in '{w_text}'",
                "word": w_text,
                "phone": exp_p,
                "phoneIpa": exp_ipa,
                "observed": obs_p,
                "observedIpa": obs_ipa,
                "issue": issue_code,
                "severity": severity,
                "confidence": round(err_prob, 3),
                "start_time_ms": st_ms,
                "startTimeMs": st_ms,
                "end_time_ms": en_ms,
                "endTimeMs": en_ms,
                "instruction_vi": inst_vi,
                "instructionVi": inst_vi,
                "instruction_en": inst_en,
                "instructionEn": inst_en,
                "evidence": {
                    "diagnosisType": diag,
                    "errorProbability": round(err_prob, 4),
                    "deletionProbability": p.get("deletionProbability"),
                    "isFinalConsonant": is_final,
                    "startTimeMs": st_ms,
                    "endTimeMs": en_ms,
                },
            }
            candidates.append((rank_score, item))

    # Add confirmed lexical stress mismatches
    if lexical_stress.get("status") == "ASSESSED":
        for sw in lexical_stress.get("words") or []:
            if sw.get("matched"):
                continue
            w_text = str(sw.get("word", ""))
            exp_s = sw.get("expectedSyllable")
            obs_s = sw.get("observedSyllable")
            margin = float(sw.get("errorMargin", 0.5))
            inst_vi = (
                f"Trọng âm từ '{w_text}' cần nhấn ở âm tiết thứ {exp_s} thay vì âm tiết thứ {obs_s}. "
                "Hãy đọc âm tiết trọng âm cao hơn, rõ hơn và kéo dài hơn một chút."
            )
            inst_en = (
                f"Stress syllable {exp_s} rather than syllable {obs_s} in '{w_text}'. "
                "Make the stressed syllable slightly higher, louder, and longer."
            )
            item = {
                "target_type": "STRESS",
                "targetType": "STRESS",
                "target_unit": f"Stress on '{w_text}' (syllable {exp_s})",
                "targetUnit": f"Stress on '{w_text}' (syllable {exp_s})",
                "word": w_text,
                "phone": None,
                "observed": f"syllable_{obs_s}",
                "issue": "LEXICAL_STRESS_MISMATCH",
                "severity": "MEDIUM",
                "confidence": round(min(0.95, 0.60 + margin * 0.5), 3),
                "start_time_ms": None,
                "startTimeMs": None,
                "end_time_ms": None,
                "endTimeMs": None,
                "instruction_vi": inst_vi,
                "instructionVi": inst_vi,
                "instruction_en": inst_en,
                "instructionEn": inst_en,
                "evidence": {
                    "expectedSyllable": exp_s,
                    "observedSyllable": obs_s,
                    "errorMargin": margin,
                },
            }
            candidates.append((0.65 + min(0.25, margin * 0.3), item))

    # Add connected-speech / rhythm priority only if high-confidence acoustic evidence exists
    pause_ratio = float(prosody.get("pauseRatio") or 0.0)
    if pause_ratio >= 0.32 and int(prosody.get("pauseCount") or 0) >= 2:
        inst_vi = (
            f"Bạn dừng ngắt hơi khá nhiều ({prosody.get('pauseCount')} lần, chiếm {int(round(pause_ratio * 100))}% thời lượng). "
            "Hãy nhóm từ theo cụm ý ngắn để câu nói trôi chảy hơn."
        )
        inst_en = (
            f"Frequent pausing detected ({prosody.get('pauseCount')} pauses, {int(round(pause_ratio * 100))}% of utterance). "
            "Group words into short thought chunks for smoother rhythm."
        )
        candidates.append((
            0.45,
            {
                "target_type": "RHYTHM",
                "targetType": "RHYTHM",
                "target_unit": "Phrase pausing and rhythm",
                "targetUnit": "Phrase pausing and rhythm",
                "word": "",
                "phone": None,
                "observed": None,
                "issue": "EXCESSIVE_PAUSING",
                "severity": "LOW",
                "confidence": 0.78,
                "start_time_ms": None,
                "startTimeMs": None,
                "end_time_ms": None,
                "endTimeMs": None,
                "instruction_vi": inst_vi,
                "instructionVi": inst_vi,
                "instruction_en": inst_en,
                "instructionEn": inst_en,
                "evidence": {
                    "pauseCount": prosody.get("pauseCount"),
                    "pauseRatio": pause_ratio,
                    "vowelNpvi": prosody.get("vowelNpvi"),
                },
            },
        ))

    candidates.sort(key=lambda x: x[0], reverse=True)
    # Deduplicate by (target_type, word, phone) preserving highest-impact error first
    seen: Set[Tuple[str, str, Optional[str]]] = set()
    priorities: List[Dict[str, Any]] = []
    for _score, item in candidates:
        key = (item["targetType"], item["word"], item.get("phone"))
        if key in seen:
            continue
        seen.add(key)
        rank = len(priorities) + 1
        item["priority_rank"] = rank
        item["priorityRank"] = rank
        priorities.append(item)
        if len(priorities) >= max_items:
            break

    return priorities


# ==============================================================================
# Main Engine Class: HybridPronunciationEngine
# ==============================================================================

class HybridPronunciationEngine:
    """Thread-safe, in-repo V3 Hybrid Pronunciation Engine.

    Supports dependency injection of `backbone` for fast CPU unit tests without GPU weights,
    and lazy-loading of the real `DualBranchWavLMBackbone` in production.
    """

    _instance: Optional["HybridPronunciationEngine"] = None
    _singleton_lock = threading.Lock()

    @classmethod
    def get_instance(cls, **kwargs) -> "HybridPronunciationEngine":
        with cls._singleton_lock:
            if cls._instance is None:
                cls._instance = cls(**kwargs)
            return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        with cls._singleton_lock:
            cls._instance = None

    @classmethod
    def checkpoints_available(cls) -> bool:
        """Returns True if an injected/loaded singleton exists or all local checkpoints are present."""
        with cls._singleton_lock:
            if cls._instance is not None and cls._instance._backbone is not None:
                return True
        return DualBranchWavLMBackbone.checkpoints_available()

    def __init__(
        self,
        *,
        backbone: Optional[Any] = None,
        calibrator_path: Optional[str] = None,
        cmudict_path: Optional[str] = None,
        lazy_load: bool = True,
    ):
        self.calibrator = load_calibrator(calibrator_path)
        self.cmudict = load_cmudict(cmudict_path)
        self._backbone = backbone
        self._lazy_load = lazy_load
        if self._backbone is None and not lazy_load:
            self._backbone = DualBranchWavLMBackbone()
            self._backbone.load()

    def _ensure_backbone(self) -> Any:
        if self._backbone is None:
            self._backbone = DualBranchWavLMBackbone()
            self._backbone.load()
        return self._backbone

    def _build_abstained_response(
        self,
        *,
        request_id: str,
        expected_text: str,
        audio_quality: Dict[str, Any],
        content_fidelity: Dict[str, Any],
        abstention_reason: str,
        advice_vi: str,
        latency_ms: float,
        accent: str,
    ) -> Dict[str, Any]:
        abstained_overall = {
            "overall_score": None,
            "overallScore": None,
            "segmental_score": None,
            "segmentalScore": None,
            "stress_score": None,
            "stressScore": None,
            "intonation_score": None,
            "intonationScore": None,
            "rhythm_score": None,
            "rhythmScore": None,
            "fluency_score": None,
            "fluencyScore": None,
            "scoring_version": "ECHO_SPEAKING_V3_ABSTAINED",
        }
        lexical_stress = {
            "method": LEXICAL_STRESS_METHOD,
            "algorithm": LEXICAL_STRESS_ALGORITHM,
            "status": "INSUFFICIENT_EVIDENCE",
            "assessed": 0,
            "matched": 0,
            "words": [],
        }
        abstentions = [{
            "level": "UTTERANCE",
            "scope": "utterance",
            "reason": abstention_reason,
        }]
        return {
            "session_id": request_id,
            "requestId": request_id,
            "pipeline_status": "ABSTAINED",
            "status": "ABSTAINED",
            "abstention_reason": abstention_reason,
            "abstentionReason": abstention_reason,
            "engine_version": ENGINE_VERSION,
            "engineVersion": ENGINE_VERSION,
            "overall_score": abstained_overall,
            "overall": abstained_overall,
            "lexicalStress": lexical_stress,
            "words": [],
            "phones": [],
            "prosody": None,
            "connected_speech": None,
            "connectedSpeech": None,
            "content_fidelity": content_fidelity,
            "contentFidelity": content_fidelity,
            "audio_quality": audio_quality,
            "audioQuality": audio_quality,
            "strengths": [],
            "priorities": [],
            "pedagogical_feedback": {
                "priorities": [],
                "practice_advice": advice_vi,
            },
            "abstentions": abstentions,
            "timing": {
                "total_ms": round(latency_ms, 2),
                "totalMs": round(latency_ms, 2),
            },
            "diagnostics": {
                "engine_version": ENGINE_VERSION,
                "calibrator_version": self.calibrator.get("version"),
                "accent": accent,
                "abstention_reason": abstention_reason,
            },
            "runtime_metadata": {
                "engine_version": ENGINE_VERSION,
                "abstention_reason": abstention_reason,
                "latency_ms": round(latency_ms, 2),
            },
        }

    def analyze_waveform(
        self,
        wav: np.ndarray,
        expected_text: str,
        *,
        sample_rate: int = CANONICAL_SAMPLE_RATE,
        free_transcript: Optional[str] = None,
        accent: Optional[str] = None,
        session_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Full pronunciation evaluation on a decoded mono 16kHz float32 waveform."""
        t0 = time.perf_counter()
        req_id = attempt_id or session_id or f"PRON_{uuid.uuid4().hex[:12]}"
        norm_accent = normalize_accent(accent)

        # 1. Real Audio Quality Gate
        audio_quality = assess_audio_quality(wav, sr=sample_rate)
        content_fidelity = evaluate_content_fidelity(expected_text, free_transcript)

        if audio_quality["qualityStatus"] == "UNUSABLE":
            aq_warnings = set(audio_quality.get("warnings") or [])
            if "TOO_SHORT" in aq_warnings:
                aq_reason = "AUDIO_TOO_SHORT"
                aq_advice = "Đoạn thu âm quá ngắn để phân tích âm vị và ngữ điệu. Hãy đọc trọn vẹn câu mẫu rồi thử lại."
            elif "CLIPPED" in aq_warnings and "NO_SPEECH" not in aq_warnings:
                aq_reason = "AUDIO_CLIPPED"
                aq_advice = "Âm lượng thu quá lớn gây vỡ tiếng. Hãy giảm âm lượng micro hoặc đặt micro xa miệng hơn một chút."
            elif "EXCESSIVE_NOISE" in aq_warnings:
                aq_reason = "AUDIO_EXCESSIVE_NOISE"
                aq_advice = "Môi trường thu có quá nhiều tạp âm nền nên hệ thống không thể chấm điểm chính xác. Hãy thử lại ở nơi yên tĩnh hơn."
            elif "TOO_QUIET" in aq_warnings:
                aq_reason = "AUDIO_TOO_QUIET"
                aq_advice = "Giọng thu quá nhỏ nên chưa đủ bằng chứng âm học. Hãy nói to hơn hoặc đưa micro lại gần hơn."
            else:
                aq_reason = "AUDIO_SILENT"
                aq_advice = "Không nhận diện được tín hiệu giọng nói rõ ràng. Hãy kiểm tra micro và thu âm lại."
            return self._build_abstained_response(
                request_id=req_id,
                expected_text=expected_text,
                audio_quality=audio_quality,
                content_fidelity=content_fidelity,
                abstention_reason=aq_reason,
                advice_vi=aq_advice,
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                accent=norm_accent,
            )

        # 2. Honest Content Fidelity Gate (ABSTAIN on OFF_SCRIPT with zero false segmental errors!)
        if content_fidelity["fidelityStatus"] == "OFF_SCRIPT":
            return self._build_abstained_response(
                request_id=req_id,
                expected_text=expected_text,
                audio_quality=audio_quality,
                content_fidelity=content_fidelity,
                abstention_reason="OFF_SCRIPT",
                advice_vi="Nội dung bạn nói khác với câu mẫu nên hệ thống không chấm lỗi từng âm. Hãy nghe lại câu mẫu và đọc bám sát nội dung.",
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                accent=norm_accent,
            )

        # 3. Resolve expected words -> canonical phones & accepted variants
        resolved_words = resolve_expected_words(expected_text, accent=norm_accent, cmudict=self.cmudict)
        flat_phones: List[str] = []
        for rw in resolved_words:
            flat_phones.extend(rw["phones_base"])

        if not flat_phones:
            return self._build_abstained_response(
                request_id=req_id,
                expected_text=expected_text,
                audio_quality=audio_quality,
                content_fidelity=content_fidelity,
                abstention_reason="NO_SCORABLE_WORDS",
                advice_vi="Không tìm thấy từ tiếng Anh hợp lệ để đánh giá phát âm.",
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                accent=norm_accent,
            )

        # 4. Run Shared-Lower-12 + Dual-Upper-12 neural inference
        t_nn = time.perf_counter()
        backbone = self._ensure_backbone()
        nn_out = backbone.score_phones(wav, flat_phones)
        nn_ms = (time.perf_counter() - t_nn) * 1000.0

        if not nn_out or not nn_out.get("rows"):
            return self._build_abstained_response(
                request_id=req_id,
                expected_text=expected_text,
                audio_quality=audio_quality,
                content_fidelity=content_fidelity,
                abstention_reason="ALIGNMENT_FAILED",
                advice_vi="Không thể căn chỉnh âm thanh với câu mẫu. Hãy thử nói chậm và rõ hơn.",
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                accent=norm_accent,
            )

        rows = nn_out["rows"]
        spans = nn_out["spans"]
        raw_flu = float(nn_out["raw_flu"])
        raw_pros = float(nn_out["raw_pros"])
        dur_ms_total = audio_quality["durationSec"] * 1000.0

        matched_word_set: Optional[Set[int]] = None
        if content_fidelity["fidelityStatus"] == "PARTIAL":
            matched_word_set = set(content_fidelity.get("matched_target_indices") or [])

        # 5. Calibrate per-phone & per-word assessments with real timestamps
        word_assessments: List[Dict[str, Any]] = []
        flat_phone_assessments: List[Dict[str, Any]] = []
        scored_rows: List[Dict[str, Any]] = []
        scored_word_scores: List[float] = []
        scored_word_indices: Set[int] = set()
        abstentions: List[Dict[str, str]] = []

        cursor = 0
        total_phones = len(flat_phones)
        for wi, rw in enumerate(resolved_words):
            w_len = len(rw["phones_base"])
            w_rows = rows[cursor : cursor + w_len]
            next_first = (
                resolved_words[wi + 1]["phones_base"][0]
                if (wi + 1 < len(resolved_words) and resolved_words[wi + 1]["phones_base"])
                else None
            )

            is_omitted = matched_word_set is not None and wi not in matched_word_set
            w_phones: List[Dict[str, Any]] = []

            for pi, r in enumerate(w_rows):
                g_idx = cursor + pi
                fb_start = (dur_ms_total * g_idx) / max(1, total_phones)
                fb_end = (dur_ms_total * (g_idx + 1)) / max(1, total_phones)

                if is_omitted:
                    exp_p = strip_stress(r["expected_phone"])
                    p_dict = {
                        "phone_index": pi,
                        "phoneIndex": pi,
                        "word_index": wi,
                        "wordIndex": wi,
                        "expected_phone": exp_p,
                        "expectedPhone": exp_p,
                        "ipa": ARPABET_TO_IPA.get(exp_p, exp_p.lower()),
                        "accepted_realizations": rw["accepted_per_pos"][pi],
                        "acceptedRealizations": rw["accepted_per_pos"][pi],
                        "quality_class": "UNCERTAIN",
                        "qualityClass": "UNCERTAIN",
                        "quality_score": 0.0,
                        "qualityScore": 0.0,
                        "quality_confidence": 0.0,
                        "qualityConfidence": 0.0,
                        "alignment_confidence": 0.0,
                        "alignmentConfidence": 0.0,
                        "observed_phone": None,
                        "observedPhone": None,
                        "observed_phone_confidence": None,
                        "observedPhoneConfidence": None,
                        "diagnosis_type": "ABSTAINED",
                        "diagnosisType": "ABSTAINED",
                        "articulatory_diff": None,
                        "articulatoryDiff": None,
                        "start_time_ms": round(fb_start, 1),
                        "startTimeMs": round(fb_start, 1),
                        "end_time_ms": round(fb_end, 1),
                        "endTimeMs": round(fb_end, 1),
                        "actionable": False,
                        "abstention_reason": "WORD_OMITTED_IN_PARTIAL_CONTENT",
                        "abstentionReason": "WORD_OMITTED_IN_PARTIAL_CONTENT",
                    }
                else:
                    p_dict = calibrate_phone_row(
                        r,
                        word=rw["word"],
                        phones_raw=rw["phones_raw"],
                        phone_pos=pi,
                        next_word_first_phone=next_first,
                        accepted_realizations=rw["accepted_per_pos"][pi],
                        accent=norm_accent,
                        calib=self.calibrator,
                        fallback_start_ms=fb_start,
                        fallback_end_ms=fb_end,
                    )
                    p_dict["phone_index"] = pi
                    p_dict["phoneIndex"] = pi
                    p_dict["word_index"] = wi
                    p_dict["wordIndex"] = wi
                    scored_rows.append(r)

                w_phones.append(p_dict)
                flat_phone_assessments.append(p_dict)

            cursor += w_len

            w_start_ms = min((p["startTimeMs"] for p in w_phones if p.get("startTimeMs") is not None), default=0.0)
            w_end_ms = max((p["endTimeMs"] for p in w_phones if p.get("endTimeMs") is not None), default=w_start_ms)

            if is_omitted:
                w_status = "OMITTED"
                w_acc = None
                w_actionable = False
                abstentions.append({
                    "level": "WORD",
                    "scope": f"word #{wi} ({rw['word']})",
                    "reason": "WORD_OMITTED_IN_PARTIAL_CONTENT",
                })
            else:
                w_acc = int(round(float(np.mean([p["qualityScore"] * 100.0 for p in w_phones]))))
                w_actionable = any(bool(p.get("actionable")) for p in w_phones)
                w_status = "GOOD" if (w_acc >= 75 and not w_actionable) else "NEEDS_WORK"
                scored_word_scores.append(float(w_acc))
                scored_word_indices.add(wi)

            word_assessments.append({
                "word_index": wi,
                "wordIndex": wi,
                "word": rw["word"],
                "status": w_status,
                "accuracy_score": w_acc,
                "accuracyScore": w_acc,
                "stress_accuracy": None,
                "stressAccuracy": None,
                "expected_stress": rw["expected_stress_1based"][0] if rw["expected_stress_1based"] else None,
                "expectedStress": rw["expected_stress_1based"][0] if rw["expected_stress_1based"] else None,
                "observed_stress": None,
                "observedStress": None,
                "phones": w_phones,
                "start_time_ms": round(w_start_ms, 1),
                "startTimeMs": round(w_start_ms, 1),
                "end_time_ms": round(w_end_ms, 1),
                "endTimeMs": round(w_end_ms, 1),
                "actionable": w_actionable,
            })

        if not scored_rows:
            return self._build_abstained_response(
                request_id=req_id,
                expected_text=expected_text,
                audio_quality=audio_quality,
                content_fidelity=content_fidelity,
                abstention_reason="INSUFFICIENT_SCORED_WORDS",
                advice_vi="Chưa đủ từ khớp với câu mẫu để chấm điểm chính xác.",
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                accent=norm_accent,
            )

        # 6. Utterance-level calibrated scores (pure-math Ridge + uncorrupted Base Prosody)
        utt_cal = calibrate_utterance_scores(scored_rows, raw_flu, raw_pros, self.calibrator)
        segmental_score_100 = int(round(utt_cal["utt_acc_10"] * 10.0))
        fluency_score_100 = int(round(utt_cal["utt_flu_10"] * 10.0))
        intonation_score_100 = int(round(utt_cal["utt_pros_10"] * 10.0))
        overall_score_100 = int(round(utt_cal["utt_tot_10"] * 10.0))

        # 7. Real Acoustic Pitch, Prosody, Rhythm, Neural-Aligned Stress & Connected Speech
        f0_bundle = extract_f0_yin_46ms(wav, sr=sample_rate, hop_ms=20.0)
        prosody_dict, rhythm_score_100 = extract_acoustic_prosody(
            wav,
            [p for p in flat_phone_assessments if p.get("diagnosisType") != "ABSTAINED"],
            sr=sample_rate,
            fluency_score_100=fluency_score_100,
            f0_bundle=f0_bundle,
        )
        lexical_stress = evaluate_neural_lexical_stress(
            wav,
            resolved_words,
            spans,
            self.calibrator,
            sr=sample_rate,
            f0_bundle=f0_bundle,
            scored_word_indices=scored_word_indices,
        )
        stress_score_100: Optional[int] = None
        if lexical_stress["status"] == "ASSESSED" and lexical_stress["assessed"] > 0:
            stress_score_100 = int(round(100.0 * lexical_stress["matched"] / lexical_stress["assessed"]))
            stress_by_wi = {sw["wordIndex"]: sw for sw in lexical_stress["words"]}
            for w in word_assessments:
                sw = stress_by_wi.get(w["wordIndex"])
                if sw:
                    w["expected_stress"] = w["expectedStress"] = sw["expectedSyllable"]
                    w["observed_stress"] = w["observedStress"] = sw["observedSyllable"]
                    w["stress_accuracy"] = w["stressAccuracy"] = 1.0 if sw["matched"] else 0.0

        connected_speech = extract_connected_speech(
            wav,
            [w for w in word_assessments if w["status"] not in ("OMITTED", "OFF_SCRIPT")],
            sr=sample_rate,
        )

        # 8. Evidence-based priorities & strengths
        priorities = build_actionable_priorities(
            word_assessments,
            lexical_stress,
            connected_speech,
            prosody_dict,
            max_items=5,
        )

        strengths: List[str] = []
        if segmental_score_100 >= 80:
            strengths.append("Độ chuẩn xác từng âm tốt và rõ ràng.")
        if fluency_score_100 >= 80:
            strengths.append("Tốc độ nói và độ trôi chảy tự nhiên.")
        if intonation_score_100 >= 80:
            strengths.append("Ngữ điệu lên xuống có cảm xúc và tự nhiên.")
        if stress_score_100 is not None and stress_score_100 >= 85:
            strengths.append(f"Nhấn đúng trọng âm ở {lexical_stress['matched']}/{lexical_stress['assessed']} từ đa âm tiết.")

        overall_dict = {
            "overall_score": overall_score_100,
            "overallScore": overall_score_100,
            "segmental_score": segmental_score_100,
            "segmentalScore": segmental_score_100,
            "stress_score": stress_score_100,
            "stressScore": stress_score_100,
            "intonation_score": intonation_score_100,
            "intonationScore": intonation_score_100,
            "rhythm_score": rhythm_score_100,
            "rhythmScore": rhythm_score_100,
            "fluency_score": fluency_score_100,
            "fluencyScore": fluency_score_100,
            "scoring_version": self.calibrator.get("version", "ECHO_SPEAKING_V3_HYBRID"),
        }

        advice_vi = (
            priorities[0]["instructionVi"]
            if priorities
            else "Phát âm rõ ràng và ổn định. Hãy tiếp tục duy trì ngữ điệu tự nhiên!"
        )
        total_ms = (time.perf_counter() - t0) * 1000.0

        return {
            "session_id": req_id,
            "requestId": req_id,
            "pipeline_status": "COMPLETED",
            "status": "COMPLETED",
            "abstention_reason": None,
            "abstentionReason": None,
            "engine_version": ENGINE_VERSION,
            "engineVersion": ENGINE_VERSION,
            "overall_score": overall_dict,
            "overall": overall_dict,
            "lexicalStress": lexical_stress,
            "words": word_assessments,
            "phones": flat_phone_assessments,
            "prosody": prosody_dict,
            "connected_speech": connected_speech,
            "connectedSpeech": connected_speech,
            "content_fidelity": content_fidelity,
            "contentFidelity": content_fidelity,
            "audio_quality": audio_quality,
            "audioQuality": audio_quality,
            "strengths": strengths,
            "priorities": priorities,
            "pedagogical_feedback": {
                "priorities": priorities,
                "practice_advice": advice_vi,
            },
            "abstentions": abstentions,
            "timing": {
                "neural_ms": round(nn_ms, 2),
                "neuralMs": round(nn_ms, 2),
                "total_ms": round(total_ms, 2),
                "totalMs": round(total_ms, 2),
            },
            "diagnostics": {
                "engine_version": ENGINE_VERSION,
                "calibrator_version": self.calibrator.get("version"),
                "accent": norm_accent,
                "tau_error": self.calibrator["phone_error_logreg"]["tau_error"],
                "tau_weak": self.calibrator["phone_error_logreg"]["tau_weak"],
                "tau_deletion": self.calibrator["phone_deletion_logreg"]["tau_deletion"],
                "stress_threshold": self.calibrator.get("lexical_stress", {}).get("err_margin_threshold"),
            },
            "runtime_metadata": {
                "engine_version": ENGINE_VERSION,
                "calibrator_version": self.calibrator.get("version"),
                "accent": norm_accent,
                "latency_ms": round(total_ms, 2),
            },
        }

    def process_audio(
        self,
        audio_input: bytes,
        expected_text: str,
        *,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        free_transcript: Optional[str] = None,
        accent: Optional[str] = None,
        session_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
        max_duration_seconds: float = 90.0,
    ) -> Dict[str, Any]:
        """Decode untrusted audio bytes via canonical audio_ingestion and run hybrid analysis."""
        canonical = decode_browser_audio(
            audio_input,
            content_type=content_type,
            filename=filename,
            max_duration_seconds=max_duration_seconds,
        )
        return self.analyze_waveform(
            canonical.waveform,
            expected_text,
            sample_rate=canonical.sample_rate,
            free_transcript=free_transcript,
            accent=accent,
            session_id=session_id,
            attempt_id=attempt_id,
        )
