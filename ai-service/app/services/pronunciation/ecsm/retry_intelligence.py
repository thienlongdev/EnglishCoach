"""
ECSM-v1 / EC-PRISM Phase P9: Retry Intelligence & Actionable Pronunciation Coaching Engine.

From Pronunciation Assessment to Actionable Pronunciation Coaching.
P8 answers: "What happened?"
P9 answers: "What should the learner fix next?"

Core Capabilities:
1. Inspect trustworthy assessment evidence
2. Identify actionable candidate issues & deduplicate correlated signals
3. Select ONE primary retry focus (ONE RETRY = ONE PRIMARY COACHING FOCUS)
4. Explain the issue safely with natural Vietnamese articulatory coaching cues
5. Create a deterministic micro-drill (Sound -> Contrast -> Word -> Phrase -> Sentence)
6. Guide the learner through a 5-level adaptive retry ladder
7. Compare before vs after retry (RESOLVED, IMPROVED, UNCHANGED, REGRESSED, UNCERTAIN, NOT_COMPARABLE)
8. Track within-session issue recurrence with stable keys (NEW, RECURRING, IMPROVING, RESOLVED, REGRESSED, UNCERTAIN)
9. Bridge evidence-supported recurring patterns to the Speaking Profile / Weakness Profile
10. Zero LLM diagnostic authority, pure deterministic execution, fail-closed safety.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import enum
import hashlib
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


class DecisionStatus(str, enum.Enum):
    NO_ACTION_NEEDED = "NO_ACTION_NEEDED"
    ACTIONABLE_FOCUS_FOUND = "ACTIONABLE_FOCUS_FOUND"
    PARTIAL_EVIDENCE = "PARTIAL_EVIDENCE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    RETRY_COMPARISON_AVAILABLE = "RETRY_COMPARISON_AVAILABLE"
    ASSESSMENT_UNAVAILABLE = "ASSESSMENT_UNAVAILABLE"


class PriorityTier(str, enum.Enum):
    TIER_0_BLOCKING = "TIER_0_BLOCKING"
    TIER_1_HIGH_IMPACT = "TIER_1_HIGH_IMPACT"
    TIER_2_NEXT = "TIER_2_NEXT"
    TIER_3_POLISH = "TIER_3_POLISH"
    TIER_4_DESCRIPTIVE_ONLY = "TIER_4_DESCRIPTIVE_ONLY"


class LadderLevel(str, enum.Enum):
    LEVEL_1_SOUND = "LEVEL_1_SOUND"
    LEVEL_2_CONTRAST = "LEVEL_2_CONTRAST"
    LEVEL_3_WORD = "LEVEL_3_WORD"
    LEVEL_4_PHRASE = "LEVEL_4_PHRASE"
    LEVEL_5_SENTENCE = "LEVEL_5_SENTENCE"
    # Legacy aliases
    LEVEL_0_ARTICULATORY_CUE = "LEVEL_0_ARTICULATORY_CUE"
    LEVEL_1_ISOLATED_PHONE = "LEVEL_1_ISOLATED_PHONE"
    LEVEL_2_SYLLABLE = "LEVEL_2_SYLLABLE"
    LEVEL_3_MINIMAL_PAIR = "LEVEL_3_MINIMAL_PAIR"
    LEVEL_4_TARGET_WORD = "LEVEL_4_TARGET_WORD"
    LEVEL_5_SHORT_PHRASE = "LEVEL_5_SHORT_PHRASE"
    LEVEL_6_ORIGINAL_SENTENCE = "LEVEL_6_ORIGINAL_SENTENCE"


# Backwards compatibility alias
ScaffoldLevel = LadderLevel


class TargetState(str, enum.Enum):
    IDENTIFIED = "IDENTIFIED"
    PRACTICING = "PRACTICING"
    IMPROVED_ONCE = "IMPROVED_ONCE"
    IMPROVED_CONFIRMED = "IMPROVED_CONFIRMED"
    STALLED = "STALLED"
    DEFERRED = "DEFERRED"
    RESOLVED_THIS_SESSION = "RESOLVED_THIS_SESSION"
    INCONCLUSIVE = "INCONCLUSIVE"


class RetryComparisonState(str, enum.Enum):
    RESOLVED = "RESOLVED"
    IMPROVED = "IMPROVED"
    UNCHANGED = "UNCHANGED"
    REGRESSED = "REGRESSED"
    UNCERTAIN = "UNCERTAIN"
    NOT_COMPARABLE = "NOT_COMPARABLE"
    # Legacy alias
    WORSENED = "REGRESSED"
    INCONCLUSIVE = "UNCERTAIN"
    TARGET_NOT_FOUND = "NOT_COMPARABLE"
    AUDIO_QUALITY_INVALID = "UNCERTAIN"


class WeaknessLifecycle(str, enum.Enum):
    NEW = "NEW"
    RECURRING = "RECURRING"
    IMPROVING = "IMPROVING"
    RESOLVED = "RESOLVED"
    REGRESSED = "REGRESSED"
    UNCERTAIN = "UNCERTAIN"


class DrillType(str, enum.Enum):
    CONTENT_RETRY = "CONTENT_RETRY"
    ARTICULATORY_PLACEMENT = "ARTICULATORY_PLACEMENT"
    ISOLATED_PHONE_PRACTICE = "ISOLATED_PHONE_PRACTICE"
    SYLLABLE_PRACTICE = "SYLLABLE_PRACTICE"
    MINIMAL_PAIR_CONTRAST = "MINIMAL_PAIR_CONTRAST"
    TARGET_WORD_PRACTICE = "TARGET_WORD_PRACTICE"
    WORD_IN_PHRASE = "WORD_IN_PHRASE"
    SHADOW_REFERENCE = "SHADOW_REFERENCE"
    STRESS_CONTRAST = "STRESS_CONTRAST"
    TIMING_ECHO = "TIMING_ECHO"
    PAUSE_CONTINUITY = "PAUSE_CONTINUITY"
    INTONATION_IMITATION = "INTONATION_IMITATION"
    REPEAT_ORIGINAL_SENTENCE = "REPEAT_ORIGINAL_SENTENCE"


# Curated, phonetically grounded articulatory cues with natural Vietnamese guidance
ARTICULATORY_CUE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "θ": {
        "contrast": "θ vs s/f/t",
        "cue": "Đặt đầu lưỡi nhẹ giữa hai hàm răng. Thổi luồng hơi nhẹ qua khe giữa lưỡi và răng cửa trên (không cắn chặt).",
        "cue_en": "Place the tongue tip lightly between the upper and lower front teeth. Blow air gently over the tongue.",
        "commonMistake": "Khép chặt răng (/s/), cắn môi dưới (/f/) hoặc thụt lưỡi vào trong phát âm thành /t/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "ð": {
        "contrast": "ð vs d/z",
        "cue": "Đặt đầu lưỡi giữa hai hàm răng giống âm /θ/, nhưng rung dây thanh quản (cảm nhận rung ở cổ họng).",
        "cue_en": "Place the tongue tip between the teeth and vibrate the vocal cords while gently releasing air.",
        "commonMistake": "Chặn hoàn toàn luồng hơi (/d/) hoặc thụt lưỡi ra sau răng (/z/).",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "r": {
        "contrast": "r vs l/w",
        "cue": "Cong nhẹ đầu lưỡi về phía vòm họng trên nhưng không chạm. Giữ hai bên mép lưỡi tựa vào hàm răng trên.",
        "cue_en": "Curl the tongue tip slightly back toward the roof of the mouth without touching it. Keep sides of tongue against upper molars.",
        "commonMistake": "Chạm đầu lưỡi vào chân răng (/l/) hoặc chu tròn môi quá mức (/w/).",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "l": {
        "contrast": "l vs r",
        "cue": "Đặt đầu lưỡi chạm chắc vào chân răng cửa trên (khớp nướu), để luồng hơi thoát ra hai bên cạnh lưỡi.",
        "cue_en": "Press the tip of the tongue firmly against the alveolar ridge behind upper teeth and let air escape around the sides.",
        "commonMistake": "Thụt lưỡi ra sau không chạm nướu răng (/r/).",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "v": {
        "contrast": "v vs w/b",
        "cue": "Đặt nhẹ hàng răng cửa trên lên môi dưới, thổi hơi nhẹ kết hợp rung dây thanh quản.",
        "cue_en": "Rest the upper front teeth lightly on the lower lip and vibrate the vocal cords while blowing air.",
        "commonMistake": "Mím cả hai môi lại (/w/ hoặc /b/) thay vì dùng răng trên chạm môi dưới.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "w": {
        "contrast": "w vs v",
        "cue": "Tròn môi lại thành hình chữ 'O' nhỏ, đẩy nhẹ môi về phía trước và lướt mượt mà sang nguyên âm sau (không chạm răng vào môi).",
        "cue_en": "Round lips into a small circle, push lips slightly forward and glide into the following vowel without teeth contact.",
        "commonMistake": "Chạm răng trên vào môi dưới biến thành âm /v/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "ɪ": {
        "contrast": "ɪ vs iː",
        "cue": "Thả lỏng cơ miệng và quai hàm, phát âm âm /i/ ngắn, dứt khoát (ở giữa âm 'i' và 'ê' tiếng Việt).",
        "cue_en": "Relax the mouth and jaw, pronounce a short, crisp lax /ɪ/ (between 'i' and 'e').",
        "commonMistake": "Căng miệng quá mức biến thành âm /iː/ dài.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "iː": {
        "contrast": "iː vs ɪ",
        "cue": "Căng khóe miệng sang hai bên như đang cười mỉm, nâng thân lưỡi cao lên vòm họng và kéo dài âm.",
        "cue_en": "Spread lip corners as if smiling gently, raise tongue body high and sustain the tense vowel.",
        "commonMistake": "Thả lỏng cơ miệng biến thành âm /ɪ/ ngắn.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "æ": {
        "contrast": "æ vs e",
        "cue": "Hạ quai hàm xuống sâu, mở rộng khẩu hình miệng theo chiều dọc và đè lưỡi phẳng xuống sàn miệng.",
        "cue_en": "Drop jaw low, open mouth wide vertically and keep tongue low and flat.",
        "commonMistake": "Khép khẩu hình quá hẹp biến thành âm /e/ (như 'bed' thay vì 'bad').",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "e": {
        "contrast": "e vs æ",
        "cue": "Mở miệng vừa phải, thả lỏng môi và hạ hàm một nửa so với âm /æ/.",
        "cue_en": "Open mouth moderately, relax lips and lower jaw halfway compared to /æ/.",
        "commonMistake": "Hạ hàm quá sâu làm nhầm lẫn với /æ/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "ʃ": {
        "contrast": "ʃ vs s",
        "cue": "Chu nhẹ hai môi về phía trước, nâng thân lưỡi gần vòm họng và thổi luồng hơi xì mạnh (không rung cổ họng).",
        "cue_en": "Flare lips slightly forward, raise tongue blade near hard palate and release strong unvoiced frication.",
        "commonMistake": "Kéo môi bè sang hai bên biến thành âm /s/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "tʃ": {
        "contrast": "tʃ vs ʃ/t",
        "cue": "Đặt đầu lưỡi chạm vào nướu răng trên để chặn luồng hơi trong tích tắc, sau đó bật dứt khoát thành âm /ʃ/.",
        "cue_en": "Touch tongue tip to alveolar ridge to stop airflow briefly, then release explosively into /ʃ/.",
        "commonMistake": "Không chặn luồng hơi biến thành âm /ʃ/ trơn (như 'share' thay vì 'chair').",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "z": {
        "contrast": "z vs s",
        "cue": "Khép nhẹ hai hàm răng, đặt đầu lưỡi gần chân răng trên và thổi hơi kết hợp rung dây thanh quản (tiếng ong kêu).",
        "cue_en": "Lightly close teeth, place tongue tip near alveolar ridge and release voiced buzzing sound.",
        "commonMistake": "Ngắt rung dây thanh quản ở cuối từ biến thành âm vô thanh /s/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "s": {
        "contrast": "s vs θ/z",
        "cue": "Khép nhẹ hai hàm răng, đặt đầu lưỡi gần chân răng trên và thổi luồng hơi xì sắc nét (không rung cổ họng, không đưa lưỡi ra ngoài răng).",
        "cue_en": "Lightly close teeth, place tongue tip near alveolar ridge and release crisp unvoiced hiss.",
        "commonMistake": "Thè đầu lưỡi ra ngoài răng biến thành /θ/ hoặc rung cổ họng biến thành /z/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "ʊ": {
        "contrast": "ʊ vs uː",
        "cue": "Thả lỏng môi (chỉ hơi tròn nhẹ) và phát âm âm /ʊ/ ngắn, tự nhiên (như trong 'book', 'full').",
        "cue_en": "Keep lips loosely rounded and pronounce a short, relaxed /ʊ/ (as in 'book', 'full').",
        "commonMistake": "Chu môi căng và kéo dài quá mức biến thành âm /uː/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "uː": {
        "contrast": "uː vs ʊ",
        "cue": "Chu tròn môi rõ ràng, kéo thân lưỡi cao về phía sau và giữ âm /uː/ căng, mượt.",
        "cue_en": "Round lips firmly, pull tongue high and back, and sustain a tense /uː/.",
        "commonMistake": "Thả lỏng môi và rút ngắn biến thành /ʊ/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "t": {
        "contrast": "t vs d",
        "cue": "Đặt đầu lưỡi chạm nướu răng trên rồi bật hơi vô thanh dứt khoát (không rung cổ họng), chú ý giữ rõ âm cuối.",
        "cue_en": "Contact the alveolar ridge with the tongue tip and release a crisp voiceless burst, especially in word-final position.",
        "commonMistake": "Nuốt âm /t/ cuối từ hoặc rung dây thanh quản biến thành /d/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "d": {
        "contrast": "d vs t",
        "cue": "Đặt đầu lưỡi chạm nướu răng trên kết hợp rung dây thanh quản rõ ràng, giữ nguyên âm đứng trước dài hơn nhẹ.",
        "cue_en": "Contact the alveolar ridge with vocal-cord vibration and keep the preceding vowel slightly longer.",
        "commonMistake": "Vô thanh hóa cuối từ biến thành /t/ hoặc bỏ âm cuối.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "p": {
        "contrast": "p vs b",
        "cue": "Mím kín hai môi chặn hơi rồi bật hơi vô thanh rõ nét (ở đầu từ có luồng gió bật mạnh ra ngoài).",
        "cue_en": "Press both lips together and release a crisp voiceless burst with clear aspiration in stressed onsets.",
        "commonMistake": "Không bật hơi hoặc rung cổ họng biến thành /b/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "b": {
        "contrast": "b vs p",
        "cue": "Mím hai môi và kích hoạt rung dây thanh quản ngay khi bật âm để phân biệt rõ với /p/.",
        "cue_en": "Close both lips and vibrate the vocal cords during release to contrast with voiceless /p/.",
        "commonMistake": "Mất rung dây thanh quản biến thành /p/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "k": {
        "contrast": "k vs g",
        "cue": "Nâng phần gốc lưỡi chạm vòm mềm rồi bật luồng hơi vô thanh sắc nét, tránh nuốt âm /k/ cuối từ.",
        "cue_en": "Raise the back of the tongue to the soft palate and release a crisp voiceless burst, avoiding final-/k/ omission.",
        "commonMistake": "Nuốt âm cuối hoặc rung cổ họng biến thành /ɡ/.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "g": {
        "contrast": "g vs k",
        "cue": "Nâng gốc lưỡi chạm vòm mềm giống /k/ nhưng giữ rung dây thanh quản liên tục.",
        "cue_en": "Raise the tongue back to the soft palate like /k/ while keeping the vocal cords voiced.",
        "commonMistake": "Ngắt rung cổ họng biến thành /k/ vô thanh.",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "f": {
        "contrast": "f vs v/p",
        "cue": "Chạm nhẹ răng cửa trên lên môi dưới và thổi luồng hơi vô thanh đều (không mím hai môi, không rung cổ họng).",
        "cue_en": "Rest the upper front teeth lightly on the lower lip and blow steady voiceless air.",
        "commonMistake": "Mím hai môi (/p/) hoặc rung dây thanh quản (/v/).",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "MINIMAL_PAIR_CONTRAST", "TARGET_WORD_PRACTICE"],
    },
    "VOICING": {
        "contrast": "Âm hữu thanh vs vô thanh",
        "cue": "Đặt ngón tay nhẹ lên cổ họng để cảm nhận độ rung của dây thanh quản khi phát âm âm hữu thanh.",
        "cue_en": "Touch throat lightly to feel vocal cord vibration during voiced sounds.",
        "commonMistake": "Mất âm rung ở phụ âm cuối từ (de-voicing final consonants).",
        "safeDrillTypes": ["ARTICULATORY_PLACEMENT", "SYLLABLE_PRACTICE"],
    },
    "LEXICAL_STRESS": {
        "contrast": "Trọng âm từ",
        "cue": "Nhấn trọng âm rõ ràng: phát âm âm tiết mang trọng âm to hơn, cao hơn và kéo dài hơn một chút so với các âm tiết còn lại.",
        "cue_en": "Make the stressed syllable slightly louder, higher in pitch, and longer than unstressed syllables.",
        "commonMistake": "Đọc đều đều các âm tiết với trường độ và độ cao bằng nhau.",
        "safeDrillTypes": ["STRESS_CONTRAST", "TARGET_WORD_PRACTICE", "WORD_IN_PHRASE"],
    },
    "PAUSE_FLOW": {
        "contrast": "Ngắt nghỉ tự nhiên",
        "cue": "Duy trì nhịp thở và ngắt nghỉ tự nhiên theo cụm từ (thought groups) thay vì dừng đột ngột giữa các từ.",
        "cue_en": "Group words into natural thought chunks rather than stopping unnaturally between words.",
        "commonMistake": "Ngập ngừng hoặc ngắt hơi sai vị trí liên kết từ.",
        "safeDrillTypes": ["PAUSE_CONTINUITY", "SHADOW_REFERENCE"],
    },
    "INTONATION_FLOW": {
        "contrast": "Ngữ điệu câu",
        "cue": "Lắng nghe và bắt chước độ lên xuống của giọng ở cuối cụm từ hoặc cuối câu mẫu.",
        "cue_en": "Listen to the reference audio and imitate the pitch rise and fall at phrase boundaries.",
        "commonMistake": "Giữ ngữ điệu phẳng (monotone) hoặc lên giọng sai vị trí cuối câu trần thuật.",
        "safeDrillTypes": ["INTONATION_IMITATION", "SHADOW_REFERENCE"],
    },
}

# Canonical IPA aliases for registry lookup (bridges CMUdict / G2P / CROTTC IPA variants)
IPA_CUE_ALIASES: Dict[str, str] = {
    "ɛ": "e",
    "ɹ": "r",
    "i": "iː",
    "u": "uː",
    "ɡ": "g",
    "ʧ": "tʃ",
    "ʤ": "dʒ",
}


def canonicalize_ipa_lookup_key(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return phone
    clean = phone.strip().replace("\u0261", "g")
    return IPA_CUE_ALIASES.get(clean, clean)


def lookup_articulatory_cue(phone: Optional[str]) -> Dict[str, Any]:
    """Canonicalized lookup into ARTICULATORY_CUE_REGISTRY (handles ɛ/e, ɹ/r, i/iː, u/uː, ɡ/g)."""
    if not phone:
        return ARTICULATORY_CUE_REGISTRY.get("VOICING", {})
    raw = phone.strip()
    if raw in ARTICULATORY_CUE_REGISTRY:
        return ARTICULATORY_CUE_REGISTRY[raw]
    canon = canonicalize_ipa_lookup_key(raw)
    if canon and canon in ARTICULATORY_CUE_REGISTRY:
        return ARTICULATORY_CUE_REGISTRY[canon]
    return ARTICULATORY_CUE_REGISTRY.get("VOICING", {})


def lookup_minimal_pairs(expected_phone: Optional[str], observed_phone: Optional[str]) -> Optional[List[Tuple[str, str]]]:
    """Canonicalized lookup into MINIMAL_PAIR_REGISTRY (handles ɛ/e, ɹ/r, i/iː, u/uː, ɡ/g)."""
    if not expected_phone or not observed_phone:
        return None
    c_exp = canonicalize_ipa_lookup_key(expected_phone) or expected_phone
    c_obs = canonicalize_ipa_lookup_key(observed_phone) or observed_phone
    for pair in ((expected_phone, observed_phone), (c_exp, c_obs), (observed_phone, expected_phone), (c_obs, c_exp)):
        if pair in MINIMAL_PAIR_REGISTRY:
            return MINIMAL_PAIR_REGISTRY[pair]
    return None


# Curated, linguistically valid minimal pair contrasts
MINIMAL_PAIR_REGISTRY: Dict[Tuple[str, str], List[Tuple[str, str]]] = {
    ("θ", "s"): [("think", "sink"), ("thin", "sin"), ("thick", "sick"), ("path", "pass"), ("mouth", "mouse"), ("math", "mass")],
    ("θ", "f"): [("three", "free"), ("thin", "fin"), ("thread", "fred"), ("death", "deaf")],
    ("θ", "t"): [("three", "tree"), ("thin", "tin"), ("thank", "tank"), ("theme", "team")],
    ("θ", "ð"): [("thigh", "thy"), ("teeth", "teethe"), ("bath", "bathe"), ("ether", "either")],
    ("ð", "θ"): [("thy", "thigh"), ("teethe", "teeth"), ("bathe", "bath"), ("either", "ether")],
    ("ð", "d"): [("they", "day"), ("then", "den"), ("there", "dare"), ("breathe", "breed")],
    ("ð", "z"): [("teethe", "tease"), ("clothe", "close"), ("breathe", "breeze")],
    ("r", "l"): [("red", "led"), ("right", "light"), ("road", "load"), ("pray", "play"), ("crown", "clown")],
    ("l", "r"): [("light", "right"), ("led", "red"), ("load", "road"), ("play", "pray"), ("clown", "crown")],
    ("v", "w"): [("vest", "west"), ("vine", "wine"), ("vet", "wet"), ("viper", "wiper")],
    ("w", "v"): [("west", "vest"), ("wine", "vine"), ("wet", "vet"), ("wiper", "viper")],
    ("v", "b"): [("vest", "best"), ("vote", "boat"), ("van", "ban"), ("very", "berry")],
    ("f", "v"): [("fan", "van"), ("leaf", "leave"), ("safe", "save"), ("fine", "vine")],
    ("v", "f"): [("van", "fan"), ("leave", "leaf"), ("save", "safe"), ("vine", "fine")],
    ("t", "d"): [("time", "dime"), ("hat", "had"), ("bet", "bed"), ("cart", "card")],
    ("d", "t"): [("dime", "time"), ("had", "hat"), ("bed", "bet"), ("card", "cart")],
    ("p", "b"): [("pat", "bat"), ("cap", "cab"), ("rip", "rib"), ("pear", "bear")],
    ("b", "p"): [("bat", "pat"), ("cab", "cap"), ("rib", "rip"), ("bear", "pear")],
    ("k", "g"): [("coat", "goat"), ("back", "bag"), ("cold", "gold"), ("pick", "pig")],
    ("g", "k"): [("goat", "coat"), ("bag", "back"), ("gold", "cold"), ("pig", "pick")],
    ("ɪ", "iː"): [("ship", "sheep"), ("fit", "feet"), ("sit", "seat"), ("hit", "heat"), ("bin", "bean")],
    ("iː", "ɪ"): [("sheep", "ship"), ("feet", "fit"), ("seat", "sit"), ("heat", "hit"), ("bean", "bin")],
    ("ʊ", "uː"): [("full", "fool"), ("pull", "pool"), ("look", "luke"), ("stood", "stewed")],
    ("uː", "ʊ"): [("fool", "full"), ("pool", "pull"), ("luke", "look"), ("stewed", "stood")],
    ("æ", "e"): [("bad", "bed"), ("man", "men"), ("pan", "pen"), ("bat", "bet")],
    ("e", "æ"): [("bed", "bad"), ("men", "man"), ("pen", "pan"), ("bet", "bat")],
    ("ʃ", "s"): [("she", "sea"), ("ship", "sip"), ("shoe", "sue"), ("shine", "sign")],
    ("s", "ʃ"): [("sea", "she"), ("sip", "ship"), ("sue", "shoe"), ("sign", "shine")],
    ("tʃ", "ʃ"): [("chair", "share"), ("catch", "cash"), ("cheap", "sheep"), ("chop", "shop")],
    ("z", "s"): [("zoo", "sue"), ("buzz", "bus"), ("zip", "sip"), ("prize", "price")],
    ("s", "z"): [("sue", "zoo"), ("bus", "buzz"), ("sip", "zip"), ("price", "prize")],
}


@dataclass
class PrimaryTarget:
    target_id: str
    issue_type: str
    level: str
    word_str: str
    word_index: int
    expected_phone: Optional[str]
    observed_phone: Optional[str]
    confidence: float
    is_articulatory_fallback: bool
    articulatory_contrast: Optional[str]
    time_start_sec: float
    time_end_sec: float
    evidence_refs: List[str]
    selection_reasons: List[str]
    priority_tier: str = PriorityTier.TIER_1_HIGH_IMPACT.value
    articulatory_class: Optional[str] = None
    recurrence_count: int = 1


@dataclass
class LadderStep:
    level: str  # LadderLevel enum
    level_index: int
    title_vi: str
    instructions_vi: str
    practice_text: str
    is_active: bool
    is_completed: bool


@dataclass
class RetryPlan:
    plan_id: str
    session_id: str
    attempt_id: str
    primary_target: Optional[PrimaryTarget]
    drill_type: str
    ladder_level: str
    ladder_steps: List[LadderStep]
    cue_key: Optional[str]
    articulatory_instructions: Optional[str]
    articulatory_instructions_vi: Optional[str]
    minimal_pair: Optional[Tuple[str, str]]
    practice_text: str
    success_criteria: List[str]
    fallback_drill_type: str
    reference_required: bool
    status: str
    reasons: List[str]
    non_selected_reasons: Dict[str, str] = field(default_factory=dict)
    provenance_hash: str = ""

    # Legacy property for backwards compatibility
    @property
    def scaffold_level(self) -> str:
        return self.ladder_level


@dataclass
class RetryDelta:
    target_error_prob_before: float
    target_error_prob_after: float
    target_observed_phone_before: Optional[str]
    target_observed_phone_after: Optional[str]
    error_prob_delta: float
    state_transition: str
    alignment_confidence: float


@dataclass
class RetryComparison:
    comparison_id: str
    session_id: str
    baseline_attempt_id: str
    retry_attempt_id: str
    target_id: str
    comparison_state: str  # RESOLVED, IMPROVED, UNCHANGED, REGRESSED, UNCERTAIN, NOT_COMPARABLE
    reasons: List[str]
    delta: RetryDelta
    target_state_after: str
    message_vi: str = ""
    resolved_this_session: bool = False
    provenance_hash: str = ""


@dataclass
class RecurrenceRecord:
    key: str
    issue_type: str
    expected_phone: Optional[str]
    articulatory_class: Optional[str]
    word_str: Optional[str]
    attempt_count: int
    supported_occurrences: int
    resolved_occurrences: int
    uncertain_occurrences: int
    first_seen_attempt: str
    last_seen_attempt: str
    lifecycle_state: str  # WeaknessLifecycle enum
    history_deltas: List[float] = field(default_factory=list)


@dataclass
class PracticeSessionState:
    session_id: str
    active_target: Optional[PrimaryTarget]
    target_state: str  # TargetState enum
    ladder_level: str  # LadderLevel enum
    current_attempt_index: int
    max_retries_per_target: int = 4
    target_attempt_count: int = 0
    resolved_targets: List[str] = field(default_factory=list)
    deferred_targets: List[str] = field(default_factory=list)
    pending_targets: List[PrimaryTarget] = field(default_factory=list)
    recurrence_map: Dict[str, RecurrenceRecord] = field(default_factory=dict)
    attempt_history_ids: Set[str] = field(default_factory=set)
    event_log: List[Dict[str, Any]] = field(default_factory=list)

    # Legacy property
    @property
    def scaffold_level(self) -> str:
        return self.ladder_level

    @scaffold_level.setter
    def scaffold_level(self, val: str) -> None:
        self.ladder_level = val


class TargetSelector:
    """
    Evaluates P8 assessment issues, validates evidence against gating policies,
    deduplicates correlated signals, and selects ONE primary actionable target.
    """
    @staticmethod
    def evaluate_attempt_decision(
        p8_assessment: Any,
        session_state: Optional[PracticeSessionState] = None,
        content_match_score: Optional[float] = None,
        recognized_words: Optional[List[str]] = None,
    ) -> Tuple[Optional[PrimaryTarget], Dict[str, str], str]:
        """
        Full decision evaluation returning (primary_target, non_selected_reasons, decision_status).
        """
        non_selected_reasons: Dict[str, str] = {}

        # 1. Content Gating Guard (Tier 0 Blocking)
        if content_match_score is not None and content_match_score < 50.0:
            content_target = PrimaryTarget(
                target_id="TGT_CONTENT_BLOCKING",
                issue_type="CONTENT_MISMATCH",
                level="UTTERANCE",
                word_str="whole_sentence",
                word_index=0,
                expected_phone=None,
                observed_phone=None,
                confidence=1.0,
                is_articulatory_fallback=False,
                articulatory_contrast=None,
                time_start_sec=0.0,
                time_end_sec=0.0,
                evidence_refs=[],
                selection_reasons=["CONTENT_DIVERGENCE_BLOCKING", "PRIORITIZE_TARGET_CONTENT_FIRST"],
                priority_tier=PriorityTier.TIER_0_BLOCKING.value,
            )
            return content_target, {"contentMismatch": "Learner content is substantially divergent (<50%). Focus on repeating target content first."}, DecisionStatus.INSUFFICIENT_EVIDENCE.value

        # 2. Check Session Target Stability
        if session_state and session_state.active_target and session_state.target_state in {TargetState.PRACTICING.value, TargetState.IMPROVED_ONCE.value}:
            return session_state.active_target, {"activeTargetLocked": "Session target stability maintains current active target."}, DecisionStatus.ACTIONABLE_FOCUS_FOUND.value

        all_issues: List[Any] = []
        if hasattr(p8_assessment, "primary_issues") and p8_assessment.primary_issues:
            all_issues.extend(p8_assessment.primary_issues)
        if hasattr(p8_assessment, "secondary_issues") and p8_assessment.secondary_issues:
            all_issues.extend(p8_assessment.secondary_issues)

        if not all_issues:
            return None, {"noIssuesDetected": "P8 assessment contains zero pronunciation errors."}, DecisionStatus.NO_ACTION_NEEDED.value

        # 3. Partial Content Match Word Filtering
        matched_word_indices: Optional[Set[int]] = None
        if content_match_score is not None and content_match_score >= 50.0 and content_match_score < 80.0 and recognized_words:
            matched_words_lower = {w.lower() for w in recognized_words}
            if hasattr(p8_assessment, "words"):
                matched_word_indices = {
                    idx for idx, w in enumerate(p8_assessment.words)
                    if w.word.lower() in matched_words_lower
                }

        # 4. Filter by Actionability & Safety Gating
        eligible: List[Tuple[Any, str, List[str]]] = []
        for iss in all_issues:
            # Check Product Safety Tier
            if getattr(iss, "safety_tier", "") in {"RESEARCH_ONLY", "UNAVAILABLE"}:
                non_selected_reasons[iss.issue_id] = "RESEARCH_ONLY_OR_UNAVAILABLE"
                continue

            # Skip uncalibrated statistics
            if "UNCALIBRATED" in iss.issue_type or "RHYTHM" in iss.issue_type:
                non_selected_reasons[iss.issue_id] = "RESEARCH_ONLY_RHYTHM_STATISTIC"
                continue

            # Actionability confidence threshold
            if iss.confidence < 0.70:
                non_selected_reasons[iss.issue_id] = "CONFIDENCE_BELOW_ACTIONABILITY_THRESHOLD"
                continue

            # Locate word index & word string
            w_idx = 0
            w_str = ""
            w_phones: List[str] = []
            if hasattr(p8_assessment, "words"):
                for idx, w in enumerate(p8_assessment.words):
                    if w.start_time_sec <= iss.time_start_sec and w.end_time_sec >= iss.time_end_sec - 0.05:
                        w_str = w.word
                        w_idx = idx
                        w_phones = getattr(w, "phones", []) or [p.expected_phone for p in getattr(w, "phone_assessments", [])]
                        break

            # Target-Membership Validation (Section 9, 10, 47)
            # If issue has an expectedPhone, it MUST exist in the valid target phones for this word!
            exp_p = iss.target_info.get("expectedPhone") if hasattr(iss, "target_info") else None
            if exp_p and w_str:
                from app.services.pronunciation.ipa_pipeline import get_ipa_pipeline
                canonical_phones = get_ipa_pipeline().get_word_phones(w_str)
                canon_set = {canonicalize_ipa_lookup_key(cp) for cp in canonical_phones}
                if canonical_phones and exp_p not in canonical_phones and canonicalize_ipa_lookup_key(exp_p) not in canon_set:
                    non_selected_reasons[iss.issue_id] = f"TARGET_PHONE_NOT_IN_WORD_LEXICON:{exp_p}_NOT_IN_{w_str}"
                    continue

            if not w_str and iss.level == "PHONE":
                non_selected_reasons[iss.issue_id] = "WORD_NOT_IDENTIFIABLE_FOR_PHONE_ISSUE"
                continue

            # If partial content, filter out issues on unaligned/missing words
            if matched_word_indices is not None and w_idx not in matched_word_indices:
                non_selected_reasons[iss.issue_id] = "WORD_UNALIGNED_IN_PARTIAL_CONTENT"
                continue

            # Assign Priority Tier
            if iss.issue_type == "PHONE_SUBSTITUTION" and iss.confidence >= 0.85:
                tier = PriorityTier.TIER_1_HIGH_IMPACT.value
            elif iss.issue_type == "LEXICAL_STRESS_MISMATCH" and iss.confidence >= 0.85:
                tier = PriorityTier.TIER_1_HIGH_IMPACT.value
            elif "ARTICULATORY" in iss.issue_type or iss.issue_type == "PHONE_SUBSTITUTION":
                tier = PriorityTier.TIER_2_NEXT.value
            elif iss.issue_type in {"DISRUPTIVE_PAUSE", "REFERENCE_RELATIVE_INTONATION"}:
                tier = PriorityTier.TIER_3_POLISH.value
            else:
                tier = PriorityTier.TIER_4_DESCRIPTIVE_ONLY.value

            reasons = ["SAFE_TO_SURFACE", "ACTIONABLE_FEEDBACK", f"TIER_{tier}"]
            eligible.append((iss, tier, reasons))

        if not eligible:
            is_partial = content_match_score is not None and content_match_score < 80.0
            status = DecisionStatus.PARTIAL_EVIDENCE.value if is_partial else DecisionStatus.NO_ACTION_NEEDED.value
            return None, non_selected_reasons, status

        # 5. Deduplicate Correlated Issues
        deduped_eligible: List[Tuple[Any, str, List[str]]] = []
        seen_regions: Set[Tuple[float, float]] = set()

        def sorting_key(item: Tuple[Any, str, List[str]]) -> Tuple[int, float, float]:
            iss, tier, _ = item
            tier_rank = {
                PriorityTier.TIER_1_HIGH_IMPACT.value: 3,
                PriorityTier.TIER_2_NEXT.value: 2,
                PriorityTier.TIER_3_POLISH.value: 1,
                PriorityTier.TIER_4_DESCRIPTIVE_ONLY.value: 0,
            }.get(tier, 0)
            return (tier_rank, iss.confidence, -iss.time_start_sec)

        sorted_candidates = sorted(eligible, key=sorting_key, reverse=True)

        for iss, tier, reasons in sorted_candidates:
            region_key = (round(iss.time_start_sec, 2), round(iss.time_end_sec, 2))
            if region_key in seen_regions:
                non_selected_reasons[iss.issue_id] = "CORRELATED_SUBORDINATE_SIGNAL_DEDUPLICATED"
                continue
            seen_regions.add(region_key)
            deduped_eligible.append((iss, tier, reasons))

        winner_iss, winner_tier, win_reasons = deduped_eligible[0]

        # Non-selected reasons for runners-up
        for other_iss, _, _ in deduped_eligible[1:]:
            non_selected_reasons[other_iss.issue_id] = "LOWER_PEDAGOGICAL_PRIORITY_THAN_PRIMARY_TARGET"

        # Find word string and index
        w_str = winner_iss.target_info.get("targetWord") if hasattr(winner_iss, "target_info") else ""
        w_idx = winner_iss.target_info.get("wordIndex", 0) if hasattr(winner_iss, "target_info") else 0
        if not w_str and hasattr(p8_assessment, "words"):
            for idx, w in enumerate(p8_assessment.words):
                if w.start_time_sec <= winner_iss.time_start_sec and w.end_time_sec >= winner_iss.time_end_sec - 0.05:
                    w_str = w.word
                    w_idx = idx
                    break

        exp_p = winner_iss.target_info.get("expectedPhone")
        obs_p = winner_iss.observed_info.get("observedPhone")
        art_diag = winner_iss.observed_info.get("articulatoryDiagnosis")
        is_art = obs_p is None and art_diag is not None

        # Clean local key per Section 26-29
        if obs_p and winner_iss.confidence >= 0.85:
            rec_key = f"PHONE_SUBSTITUTION:{exp_p}:{obs_p}:{w_str}"
        elif exp_p:
            rec_key = f"PHONE_PRODUCTION:{exp_p}:{w_str}"
        else:
            rec_key = f"{winner_iss.issue_type}:{w_str}"

        rec_count = 1
        if session_state and rec_key in session_state.recurrence_map:
            rec_count = session_state.recurrence_map[rec_key].supported_occurrences + 1

        primary = PrimaryTarget(
            target_id=f"TGT_{winner_iss.issue_id}",
            issue_type=winner_iss.issue_type,
            level=winner_iss.level,
            word_str=w_str or "unnamed_word",
            word_index=w_idx,
            expected_phone=exp_p,
            observed_phone=obs_p,
            confidence=winner_iss.confidence,
            is_articulatory_fallback=is_art,
            articulatory_contrast=art_diag,
            time_start_sec=winner_iss.time_start_sec,
            time_end_sec=winner_iss.time_end_sec,
            evidence_refs=winner_iss.evidence_refs,
            selection_reasons=win_reasons,
            priority_tier=winner_tier,
            articulatory_class=art_diag or (exp_p if exp_p else None),
            recurrence_count=rec_count,
        )

        decision_status = DecisionStatus.PARTIAL_EVIDENCE.value if (content_match_score is not None and content_match_score < 80.0) else DecisionStatus.ACTIONABLE_FOCUS_FOUND.value
        return primary, non_selected_reasons, decision_status

    @staticmethod
    def select_primary_target(
        p8_assessment: Any,
        session_state: Optional[PracticeSessionState] = None,
        content_match_score: Optional[float] = None,
        recognized_words: Optional[List[str]] = None,
    ) -> Tuple[Optional[PrimaryTarget], Dict[str, str]]:
        """
        Backwards-compatible convenience method returning (primary_target, non_selected_reasons).
        """
        target, non_sel, _ = TargetSelector.evaluate_attempt_decision(
            p8_assessment, session_state, content_match_score, recognized_words
        )
        return target, non_sel


class DrillPlanner:
    """
    Prescribes deterministic micro-drills and 5-level adaptive retry ladders.
    """
    @staticmethod
    def plan_drill(
        primary_target: Optional[PrimaryTarget],
        session_state: Optional[PracticeSessionState] = None,
        session_id: str = "SESSION_001",
        attempt_id: str = "ATTEMPT_001",
        sentence_text: str = "",
    ) -> RetryPlan:
        plan_id = f"PLAN_{attempt_id}_{hashlib.sha256(attempt_id.encode('utf-8')).hexdigest()[:8]}"

        # 1. No target needed -> General fluency repetition
        if primary_target is None:
            steps = [
                LadderStep(
                    level=LadderLevel.LEVEL_5_SENTENCE.value,
                    level_index=5,
                    title_vi="Luyện tập cả câu",
                    instructions_vi="Lặp lại trọn vẹn câu mẫu để tăng độ lưu loát và tự nhiên.",
                    practice_text=sentence_text or "Repeat sentence",
                    is_active=True,
                    is_completed=False,
                )
            ]
            return RetryPlan(
                plan_id=plan_id,
                session_id=session_id,
                attempt_id=attempt_id,
                primary_target=None,
                drill_type=DrillType.REPEAT_ORIGINAL_SENTENCE.value,
                ladder_level=LadderLevel.LEVEL_5_SENTENCE.value,
                ladder_steps=steps,
                cue_key=None,
                articulatory_instructions="Phát âm tốt! Không phát hiện lỗi ngữ âm nào ở mức độ rủi ro cao.",
                articulatory_instructions_vi="Phát âm tốt! Không phát hiện lỗi ngữ âm nào ở mức độ rủi ro cao.",
                minimal_pair=None,
                practice_text=sentence_text or "Great job! Repeat for fluency.",
                success_criteria=["MAINTAIN_FLUENCY", "NO_NEW_ERRORS"],
                fallback_drill_type=DrillType.REPEAT_ORIGINAL_SENTENCE.value,
                reference_required=False,
                status="NO_TARGET_NEEDED",
                reasons=["NO_ACTIONABLE_P8_ISSUES"],
            )

        # 2. Content Blocking -> Request Learner to Practice Target Content First
        if primary_target.issue_type == "CONTENT_MISMATCH":
            steps = [
                LadderStep(
                    level=LadderLevel.LEVEL_5_SENTENCE.value,
                    level_index=5,
                    title_vi="Nói đúng nội dung câu mẫu",
                    instructions_vi="Nghe lại câu mẫu và nói bám sát từng từ trong câu.",
                    practice_text=sentence_text or "Speak the target sentence",
                    is_active=True,
                    is_completed=False,
                )
            ]
            return RetryPlan(
                plan_id=plan_id,
                session_id=session_id,
                attempt_id=attempt_id,
                primary_target=primary_target,
                drill_type=DrillType.CONTENT_RETRY.value,
                ladder_level=LadderLevel.LEVEL_5_SENTENCE.value,
                ladder_steps=steps,
                cue_key=None,
                articulatory_instructions="Nội dung thu âm chưa khớp với câu mẫu. Vui lòng nghe lại câu mẫu và nói lại trọn vẹn câu.",
                articulatory_instructions_vi="Nội dung thu âm chưa khớp với câu mẫu. Vui lòng nghe lại câu mẫu và nói lại trọn vẹn câu.",
                minimal_pair=None,
                practice_text=sentence_text or "Target sentence",
                success_criteria=["CONTENT_MATCH_ABOVE_50"],
                fallback_drill_type=DrillType.SHADOW_REFERENCE.value,
                reference_required=True,
                status="CONTENT_RETRY_REQUIRED",
                reasons=["CONTENT_DIVERGENCE_GATING"],
            )

        active_ladder = session_state.ladder_level if session_state else LadderLevel.LEVEL_3_WORD.value
        exp_p = primary_target.expected_phone
        obs_p = primary_target.observed_phone
        word_str = primary_target.word_str

        cue_entry = lookup_articulatory_cue(exp_p)
        cue_vi = cue_entry.get("cue", "Tập trung phát âm chuẩn xác vị trí khẩu hình miệng.")
        cue_en = cue_entry.get("cue_en", cue_vi)

        # Build Minimal Pair if trusted (canonicalized across IPA variants)
        min_pair: Optional[Tuple[str, str]] = None
        if exp_p and obs_p:
            pairs = lookup_minimal_pairs(exp_p, obs_p)
            if pairs:
                min_pair = pairs[0]

        # Generate 5 Ladder Steps
        ladder_steps = [
            LadderStep(
                level=LadderLevel.LEVEL_1_SOUND.value,
                level_index=1,
                title_vi=f"Khẩu hình âm /{exp_p or 'âm'}/",
                instructions_vi=cue_vi,
                practice_text=f"/{exp_p}/" if exp_p else word_str,
                is_active=(active_ladder == LadderLevel.LEVEL_1_SOUND.value),
                is_completed=False,
            ),
            LadderStep(
                level=LadderLevel.LEVEL_2_CONTRAST.value,
                level_index=2,
                title_vi="Phân biệt cặp từ tương phản",
                instructions_vi=f"Phân biệt rõ giữa {min_pair[0] if min_pair else word_str} và {min_pair[1] if min_pair else 'âm tương tự'}.",
                practice_text=f"{min_pair[0]} vs {min_pair[1]}" if min_pair else word_str,
                is_active=(active_ladder == LadderLevel.LEVEL_2_CONTRAST.value),
                is_completed=False,
            ),
            LadderStep(
                level=LadderLevel.LEVEL_3_WORD.value,
                level_index=3,
                title_vi=f"Từ trọng tâm '{word_str}'",
                instructions_vi=f"Phát âm chính xác từ '{word_str}' với khẩu hình chuẩn.",
                practice_text=word_str,
                is_active=(active_ladder == LadderLevel.LEVEL_3_WORD.value),
                is_completed=False,
            ),
            LadderStep(
                level=LadderLevel.LEVEL_4_PHRASE.value,
                level_index=4,
                title_vi="Từ trong cụm ngắn",
                instructions_vi=f"Ghép từ '{word_str}' vào cụm từ liền kề.",
                practice_text=f"... {word_str} ...",
                is_active=(active_ladder == LadderLevel.LEVEL_4_PHRASE.value),
                is_completed=False,
            ),
            LadderStep(
                level=LadderLevel.LEVEL_5_SENTENCE.value,
                level_index=5,
                title_vi="Trọn vẹn câu mẫu",
                instructions_vi="Nói lại cả câu mẫu mượt mà, lưu loát.",
                practice_text=sentence_text or word_str,
                is_active=(active_ladder == LadderLevel.LEVEL_5_SENTENCE.value),
                is_completed=False,
            ),
        ]

        # 3. Segmental Substitution Focus
        if primary_target.issue_type == "PHONE_SUBSTITUTION" and exp_p:
            drill_type = DrillType.MINIMAL_PAIR_CONTRAST.value if (min_pair and active_ladder in {LadderLevel.LEVEL_2_CONTRAST.value, LadderLevel.LEVEL_3_MINIMAL_PAIR.value}) else DrillType.TARGET_WORD_PRACTICE.value
            practice_txt = f"{min_pair[0]} vs {min_pair[1]}" if (min_pair and drill_type == DrillType.MINIMAL_PAIR_CONTRAST.value) else word_str

            return RetryPlan(
                plan_id=plan_id,
                session_id=session_id,
                attempt_id=attempt_id,
                primary_target=primary_target,
                drill_type=drill_type,
                ladder_level=active_ladder,
                ladder_steps=ladder_steps,
                cue_key=exp_p,
                articulatory_instructions=cue_en,
                articulatory_instructions_vi=cue_vi,
                minimal_pair=min_pair,
                practice_text=practice_txt,
                success_criteria=["TARGET_ERROR_STATE_CLEARS", "TARGET_ERROR_CLEARS", "EXPECTED_PHONE_REALIZED"],
                fallback_drill_type=DrillType.ARTICULATORY_PLACEMENT.value,
                reference_required=False,
                status="PLAN_READY",
                reasons=["TARGETED_SEGMENTAL_CORRECTION"],
            )

        # 4. Broad Articulatory Contrast
        if primary_target.is_articulatory_fallback or "ARTICULATORY" in primary_target.issue_type:
            art_key = primary_target.articulatory_contrast or "VOICING"
            cue_entry = lookup_articulatory_cue(art_key)
            cue_vi = cue_entry.get("cue", "Điều chỉnh khẩu hình và luồng hơi chuẩn xác.")

            return RetryPlan(
                plan_id=plan_id,
                session_id=session_id,
                attempt_id=attempt_id,
                primary_target=primary_target,
                drill_type=DrillType.ARTICULATORY_PLACEMENT.value,
                ladder_level=LadderLevel.LEVEL_1_SOUND.value,
                ladder_steps=ladder_steps,
                cue_key=art_key,
                articulatory_instructions=cue_entry.get("cue_en", cue_vi),
                articulatory_instructions_vi=cue_vi,
                minimal_pair=None,
                practice_text=word_str,
                success_criteria=["ARTICULATORY_CONTRAST_IMPROVES"],
                fallback_drill_type=DrillType.ISOLATED_PHONE_PRACTICE.value,
                reference_required=False,
                status="PLAN_READY",
                reasons=["BROAD_ARTICULATORY_PLACEMENT_CORRECTION"],
            )

        # 5. Lexical Stress Mismatch
        if primary_target.issue_type == "LEXICAL_STRESS_MISMATCH":
            stress_cue = ARTICULATORY_CUE_REGISTRY["LEXICAL_STRESS"]
            return RetryPlan(
                plan_id=plan_id,
                session_id=session_id,
                attempt_id=attempt_id,
                primary_target=primary_target,
                drill_type=DrillType.STRESS_CONTRAST.value,
                ladder_level=LadderLevel.LEVEL_3_WORD.value,
                ladder_steps=ladder_steps,
                cue_key="LEXICAL_STRESS",
                articulatory_instructions=stress_cue["cue_en"],
                articulatory_instructions_vi=stress_cue["cue"],
                minimal_pair=None,
                practice_text=word_str,
                success_criteria=["PRIMARY_STRESS_PROMINENCE_CORRECTED"],
                fallback_drill_type=DrillType.SHADOW_REFERENCE.value,
                reference_required=True,
                status="PLAN_READY",
                reasons=["LEXICAL_STRESS_CORRECTION"],
            )

        # 6. Default Prosodic / Flow Practice
        prosody_key = "INTONATION_FLOW" if "INTONATION" in primary_target.issue_type else "PAUSE_FLOW"
        prosody_cue = ARTICULATORY_CUE_REGISTRY.get(prosody_key, ARTICULATORY_CUE_REGISTRY["PAUSE_FLOW"])
        return RetryPlan(
            plan_id=plan_id,
            session_id=session_id,
            attempt_id=attempt_id,
            primary_target=primary_target,
            drill_type=DrillType.INTONATION_IMITATION.value if "INTONATION" in primary_target.issue_type else DrillType.PAUSE_CONTINUITY.value,
            ladder_level=LadderLevel.LEVEL_4_PHRASE.value,
            ladder_steps=ladder_steps,
            cue_key=prosody_key,
            articulatory_instructions=prosody_cue["cue_en"],
            articulatory_instructions_vi=prosody_cue["cue"],
            minimal_pair=None,
            practice_text=word_str,
            success_criteria=["PROSODIC_FLOW_MATCHES_REFERENCE"],
            fallback_drill_type=DrillType.SHADOW_REFERENCE.value,
            reference_required=True,
            status="PLAN_READY",
            reasons=["PROSODIC_CONTINUITY_CORRECTION"],
        )


class RetryComparator:
    """
    Compares baseline P8 assessment vs retry P8 assessment strictly for the selected primary target.
    Classifies transition: RESOLVED, IMPROVED, UNCHANGED, REGRESSED, UNCERTAIN, NOT_COMPARABLE.
    """
    @staticmethod
    def compare_attempts(
        primary_target: PrimaryTarget,
        baseline_assessment: Any,
        retry_assessment: Any,
        session_id: str = "SESSION_001",
        baseline_attempt_id: str = "ATT_001",
        retry_attempt_id: str = "ATT_002",
        session_state: Optional[PracticeSessionState] = None,
    ) -> RetryComparison:
        comp_id = f"COMP_{baseline_attempt_id}_{retry_attempt_id}_{hashlib.sha256(primary_target.target_id.encode('utf-8')).hexdigest()[:8]}"

        # 1. Quality & Coverage Gate on Retry Assessment
        if not hasattr(retry_assessment, "words") or len(retry_assessment.words) == 0:
            return RetryComparison(
                comparison_id=comp_id,
                session_id=session_id,
                baseline_attempt_id=baseline_attempt_id,
                retry_attempt_id=retry_attempt_id,
                target_id=primary_target.target_id,
                comparison_state=RetryComparisonState.UNCERTAIN.value,
                reasons=["RETRY_AUDIO_UNPARSEABLE_OR_EMPTY"],
                delta=RetryDelta(1.0, 1.0, None, None, 0.0, "INVALID", 0.0),
                target_state_after=TargetState.INCONCLUSIVE.value,
                message_vi="Bản thu thử lại chưa trích xuất được âm thanh rõ ràng.",
                resolved_this_session=False,
            )

        # 2. Locate Target in Retry Assessment
        retry_word = None
        for w in retry_assessment.words:
            if w.word.lower() == primary_target.word_str.lower():
                retry_word = w
                break
        if not retry_word and primary_target.word_index < len(retry_assessment.words):
            retry_word = retry_assessment.words[primary_target.word_index]

        if not retry_word:
            return RetryComparison(
                comparison_id=comp_id,
                session_id=session_id,
                baseline_attempt_id=baseline_attempt_id,
                retry_attempt_id=retry_attempt_id,
                target_id=primary_target.target_id,
                comparison_state=RetryComparisonState.NOT_COMPARABLE.value,
                reasons=["TARGET_WORD_OMITTED_OR_UNALIGNED_IN_RETRY"],
                delta=RetryDelta(1.0, 1.0, None, None, 0.0, "MISSING", 0.0),
                target_state_after=TargetState.PRACTICING.value,
                message_vi="Từ trọng tâm chưa xuất hiện trong bản thu thử lại.",
                resolved_this_session=False,
            )

        # 3. Check Segmental Improvement
        if primary_target.issue_type == "PHONE_SUBSTITUTION":
            retry_pa = next((p for p in retry_word.phone_assessments if p.expected_phone == primary_target.expected_phone), retry_word.phone_assessments[0] if retry_word.phone_assessments else None)
            if not retry_pa:
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.UNCERTAIN.value,
                    reasons=["TARGET_PHONE_UNALIGNED"],
                    delta=RetryDelta(1.0, 1.0, None, None, 0.0, "UNALIGNED", 0.0),
                    target_state_after=TargetState.INCONCLUSIVE.value,
                    message_vi="Âm trọng tâm chưa được căn chỉnh rõ trong bản thu này.",
                    resolved_this_session=False,
                )

            err_before = 0.95
            err_after = retry_pa.error_probability
            obs_before = primary_target.observed_phone
            obs_after = retry_pa.observed_phone
            delta_err = round(err_before - err_after, 4)

            # Valid weak form / dialect variant match
            if getattr(retry_word, "is_valid_variant", False):
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.IMPROVED.value,
                    reasons=["RETRY_REALIZATION_MATCHES_G_VALID_VARIANT"],
                    delta=RetryDelta(err_before, err_after, obs_before, obs_after, delta_err, "G_VALID_MATCH", retry_word.confidence),
                    target_state_after=TargetState.IMPROVED_ONCE.value,
                    message_vi=f"Tiến bộ tốt! Phát âm từ '{primary_target.word_str}' đạt biến thể tự nhiên hợp lệ.",
                    resolved_this_session=False,
                )

            # Resolved or Strongly Improved
            if err_after <= 0.30 or obs_after == primary_target.expected_phone:
                is_resolved = bool(session_state and session_state.target_state == TargetState.IMPROVED_ONCE.value)
                comp_state = RetryComparisonState.RESOLVED.value if is_resolved else RetryComparisonState.IMPROVED.value
                tgt_state = TargetState.RESOLVED_THIS_SESSION.value if is_resolved else TargetState.IMPROVED_ONCE.value
                msg = f"Xuất sắc! Bạn đã làm chủ âm /{primary_target.expected_phone}/ trong từ '{primary_target.word_str}'!" if is_resolved else f"Tiến bộ rõ rệt! Âm /{primary_target.expected_phone}/ trong từ '{primary_target.word_str}' đã được phát âm chuẩn xác hơn."

                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=comp_state,
                    reasons=["TARGET_ERROR_CLEARED", "EXPECTED_PHONE_CORRECTLY_REALIZED"],
                    delta=RetryDelta(err_before, err_after, obs_before, obs_after, delta_err, "ERROR_CLEARED", retry_word.confidence),
                    target_state_after=tgt_state,
                    message_vi=msg,
                    resolved_this_session=is_resolved,
                )

            elif err_after >= 0.75:
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.UNCHANGED.value,
                    reasons=["PERSISTENT_SEGMENTAL_SUBSTITUTION_IN_RETRY"],
                    delta=RetryDelta(err_before, err_after, obs_before, obs_after, delta_err, "PERSISTENT_ERROR", retry_word.confidence),
                    target_state_after=TargetState.PRACTICING.value,
                    message_vi=f"Âm /{primary_target.expected_phone}/ trong từ '{primary_target.word_str}' vẫn cần chú ý khẩu hình.",
                    resolved_this_session=False,
                )
            else:
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.UNCERTAIN.value,
                    reasons=["ERROR_PROBABILITY_MARGINAL_UNCERTAIN"],
                    delta=RetryDelta(err_before, err_after, obs_before, obs_after, delta_err, "UNCERTAIN", retry_word.confidence),
                    target_state_after=TargetState.INCONCLUSIVE.value,
                    message_vi="Đã ghi nhận lượt thử lại. Hãy giữ âm lượng đều và thử lại lần nữa.",
                    resolved_this_session=False,
                )

        # 4. Check Lexical Stress Improvement
        if primary_target.issue_type == "LEXICAL_STRESS_MISMATCH":
            stress_iss = any(iss.issue_type == "LEXICAL_STRESS_MISMATCH" for iss in retry_word.issues)
            if not stress_iss:
                is_resolved = (session_state and session_state.target_state == TargetState.IMPROVED_ONCE.value)
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.RESOLVED.value if is_resolved else RetryComparisonState.IMPROVED.value,
                    reasons=["LEXICAL_STRESS_PROMINENCE_CORRECTED"],
                    delta=RetryDelta(1.0, 0.0, "UNSTRESSED", "STRESSED", 1.0, "STRESS_CORRECTED", retry_word.confidence),
                    target_state_after=TargetState.RESOLVED_THIS_SESSION.value if is_resolved else TargetState.IMPROVED_ONCE.value,
                    message_vi=f"Rất tốt! Trọng âm từ '{primary_target.word_str}' đã được nhấn đúng vị trí.",
                    resolved_this_session=is_resolved,
                )
            else:
                return RetryComparison(
                    comparison_id=comp_id,
                    session_id=session_id,
                    baseline_attempt_id=baseline_attempt_id,
                    retry_attempt_id=retry_attempt_id,
                    target_id=primary_target.target_id,
                    comparison_state=RetryComparisonState.UNCHANGED.value,
                    reasons=["STRESS_MISMATCH_PERSISTS"],
                    delta=RetryDelta(1.0, 1.0, "UNSTRESSED", "UNSTRESSED", 0.0, "STRESS_PERSISTS", retry_word.confidence),
                    target_state_after=TargetState.PRACTICING.value,
                    message_vi=f"Trọng âm từ '{primary_target.word_str}' vẫn chưa rõ. Hãy nhấn mạnh âm tiết mang trọng âm hơn.",
                    resolved_this_session=False,
                )

        # 5. Default Fallback Comparison
        return RetryComparison(
            comparison_id=comp_id,
            session_id=session_id,
            baseline_attempt_id=baseline_attempt_id,
            retry_attempt_id=retry_attempt_id,
            target_id=primary_target.target_id,
            comparison_state=RetryComparisonState.IMPROVED.value,
            reasons=["DESCRIPTIVE_TARGET_PRACTICE_COMPLETED"],
            delta=RetryDelta(0.5, 0.2, None, None, 0.3, "COMPLETED", 0.9),
            target_state_after=TargetState.IMPROVED_ONCE.value,
            message_vi=f"Đã hoàn thành luyện tập mục tiêu '{primary_target.word_str}'.",
            resolved_this_session=False,
        )


class SessionRecurrenceTracker:
    """
    Aggregates within-session issue recurrence across attempts with stable keys.
    Protects against learner fatigue and gates persistent weakness storage.
    """
    @staticmethod
    def get_recurrence_key(target: PrimaryTarget) -> str:
        exp = target.expected_phone or ""
        obs = target.observed_phone or ""
        if obs and target.confidence >= 0.85:
            return f"PHONE_SUBSTITUTION:{exp}:{obs}:{target.word_str}"
        elif exp:
            return f"PHONE_PRODUCTION:{exp}:{target.word_str}"
        return f"{target.issue_type}:{target.word_str}"

    @staticmethod
    def update_recurrence(
        session_state: PracticeSessionState,
        attempt_id: str,
        target: Optional[PrimaryTarget],
        comparison: Optional[RetryComparison] = None,
    ) -> PracticeSessionState:
        # Prevent double counting the same attempt
        if attempt_id in session_state.attempt_history_ids:
            return session_state
        session_state.attempt_history_ids.add(attempt_id)

        if target is None:
            return session_state

        rec_key = SessionRecurrenceTracker.get_recurrence_key(target)

        if rec_key not in session_state.recurrence_map:
            record = RecurrenceRecord(
                key=rec_key,
                issue_type=target.issue_type,
                expected_phone=target.expected_phone,
                articulatory_class=target.articulatory_class,
                word_str=target.word_str,
                attempt_count=1,
                supported_occurrences=1,
                resolved_occurrences=0,
                uncertain_occurrences=0,
                first_seen_attempt=attempt_id,
                last_seen_attempt=attempt_id,
                lifecycle_state=WeaknessLifecycle.NEW.value,
                history_deltas=[],
            )
            session_state.recurrence_map[rec_key] = record
        else:
            record = session_state.recurrence_map[rec_key]
            record.attempt_count += 1
            record.last_seen_attempt = attempt_id

            if comparison:
                c_state = comparison.comparison_state
                record.history_deltas.append(comparison.delta.error_prob_delta)

                if c_state == RetryComparisonState.RESOLVED.value:
                    record.resolved_occurrences += 1
                    record.lifecycle_state = WeaknessLifecycle.RESOLVED.value
                elif c_state == RetryComparisonState.IMPROVED.value:
                    record.lifecycle_state = WeaknessLifecycle.IMPROVING.value
                elif c_state == RetryComparisonState.REGRESSED.value:
                    record.lifecycle_state = WeaknessLifecycle.REGRESSED.value
                elif c_state == RetryComparisonState.UNCERTAIN.value:
                    record.uncertain_occurrences += 1
                else:  # UNCHANGED
                    record.supported_occurrences += 1
                    if record.supported_occurrences >= 2:
                        record.lifecycle_state = WeaknessLifecycle.RECURRING.value
            else:
                record.supported_occurrences += 1
                if record.supported_occurrences >= 2:
                    record.lifecycle_state = WeaknessLifecycle.RECURRING.value

        return session_state

    @staticmethod
    def export_speaking_profile_weaknesses(session_state: PracticeSessionState) -> List[Dict[str, Any]]:
        """
        Exports evidence-supported weaknesses for the Speaking Profile / Weakness Profile bridge.
        Strict rule: only patterns supported by >= 2 high-confidence occurrences that remain unresolved.
        """
        results: List[Dict[str, Any]] = []
        for rec_key, rec in session_state.recurrence_map.items():
            if rec.supported_occurrences >= 2 and rec.lifecycle_state in {WeaknessLifecycle.RECURRING.value, WeaknessLifecycle.REGRESSED.value}:
                label_vi = f"Âm /{rec.expected_phone}/" if rec.expected_phone else (f"Trọng âm từ '{rec.word_str}'" if rec.issue_type == "LEXICAL_STRESS_MISMATCH" else "Ngữ điệu và ngắt nghỉ")
                results.append({
                    "recurrenceKey": rec.key,
                    "issueType": rec.issue_type,
                    "expectedPhone": rec.expected_phone,
                    "articulatoryClass": rec.articulatory_class,
                    "wordStr": rec.word_str,
                    "labelVi": label_vi,
                    "occurrenceCount": rec.supported_occurrences,
                    "lifecycleState": rec.lifecycle_state,
                    "confidenceTier": "HIGH_EVIDENCE",
                    "provenance": "ECSM_P9_RETRY_INTELLIGENCE",
                })
        return results


class SessionStateMachine:
    """
    Manages within-session transitions, adaptive ladder climbing/fallbacks, and fatigue deferrals.
    """
    @staticmethod
    def transition(
        session_state: PracticeSessionState,
        comparison: RetryComparison,
    ) -> PracticeSessionState:
        session_state.target_attempt_count += 1
        session_state.current_attempt_index += 1

        state_res = comparison.comparison_state

        # Log event
        session_state.event_log.append({
            "attemptIndex": session_state.current_attempt_index,
            "targetId": comparison.target_id,
            "comparisonState": state_res,
            "reasons": comparison.reasons,
        })

        if state_res in {RetryComparisonState.RESOLVED.value, RetryComparisonState.IMPROVED.value}:
            if state_res == RetryComparisonState.RESOLVED.value or session_state.target_state == TargetState.IMPROVED_ONCE.value:
                # Fully resolved this session
                session_state.target_state = TargetState.RESOLVED_THIS_SESSION.value
                if comparison.target_id not in session_state.resolved_targets:
                    session_state.resolved_targets.append(comparison.target_id)
                session_state.active_target = None
                session_state.ladder_level = LadderLevel.LEVEL_5_SENTENCE.value
            else:
                session_state.target_state = TargetState.IMPROVED_ONCE.value
                # Climb ladder towards full sentence
                if session_state.ladder_level in {LadderLevel.LEVEL_1_SOUND.value, LadderLevel.LEVEL_0_ARTICULATORY_CUE.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_2_CONTRAST.value if session_state.ladder_level == LadderLevel.LEVEL_1_SOUND.value else LadderLevel.LEVEL_2_SYLLABLE.value
                elif session_state.ladder_level in {LadderLevel.LEVEL_2_CONTRAST.value, LadderLevel.LEVEL_3_MINIMAL_PAIR.value, LadderLevel.LEVEL_2_SYLLABLE.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_3_WORD.value if session_state.ladder_level == LadderLevel.LEVEL_2_CONTRAST.value else LadderLevel.LEVEL_4_TARGET_WORD.value
                elif session_state.ladder_level in {LadderLevel.LEVEL_3_WORD.value, LadderLevel.LEVEL_4_TARGET_WORD.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_4_PHRASE.value if session_state.ladder_level == LadderLevel.LEVEL_3_WORD.value else LadderLevel.LEVEL_6_ORIGINAL_SENTENCE.value
                elif session_state.ladder_level == LadderLevel.LEVEL_4_PHRASE.value:
                    session_state.ladder_level = LadderLevel.LEVEL_5_SENTENCE.value

        elif state_res in {RetryComparisonState.UNCHANGED.value, RetryComparisonState.REGRESSED.value}:
            if session_state.target_attempt_count >= session_state.max_retries_per_target:
                # Exceeded retries -> Stall and Defer to prevent learner fatigue
                session_state.target_state = TargetState.STALLED.value
                if comparison.target_id not in session_state.deferred_targets:
                    session_state.deferred_targets.append(comparison.target_id)
                session_state.active_target = None
            else:
                session_state.target_state = TargetState.PRACTICING.value
                # Step down ladder to isolate sub-skills
                if session_state.ladder_level in {LadderLevel.LEVEL_5_SENTENCE.value, LadderLevel.LEVEL_6_ORIGINAL_SENTENCE.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_3_WORD.value if session_state.ladder_level == LadderLevel.LEVEL_5_SENTENCE.value else LadderLevel.LEVEL_4_TARGET_WORD.value
                elif session_state.ladder_level in {LadderLevel.LEVEL_4_PHRASE.value, LadderLevel.LEVEL_4_TARGET_WORD.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_3_WORD.value if session_state.ladder_level == LadderLevel.LEVEL_4_PHRASE.value else LadderLevel.LEVEL_3_MINIMAL_PAIR.value
                elif session_state.ladder_level in {LadderLevel.LEVEL_3_WORD.value, LadderLevel.LEVEL_3_MINIMAL_PAIR.value}:
                    session_state.ladder_level = LadderLevel.LEVEL_2_CONTRAST.value if session_state.ladder_level == LadderLevel.LEVEL_3_WORD.value else LadderLevel.LEVEL_0_ARTICULATORY_CUE.value
                elif session_state.ladder_level == LadderLevel.LEVEL_2_CONTRAST.value:
                    session_state.ladder_level = LadderLevel.LEVEL_1_SOUND.value

        return session_state
