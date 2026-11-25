"""
English Coach — Production-Hardened IPA & Pronunciation Pipeline (en-US default + en-GB support).
Architecture:
1. Spoken Text Normalization BEFORE punctuation stripping (Currencies $50/$50.50, Percentages 100%,
   Numbers/Years 2000/2015/2026, Ordinals, Decimals, Abbreviations U.S./Dr., Contractions)
2. Exact Token Full CMUdict Lexicon (125,764+ words in General American, plus optional en-GB British rules)
3. Phonotactic Syllabification & Maximal Onset Stress Engine
4. Heteronym & Alternative Pronunciation Preservation
5. Fail-Closed OOV Policy: Unresolved OOV tokens return `UNAVAILABLE` (zero GPLv3+ `phonemizer`/`espeak` runtime dependency)
6. Monosyllabic Display Policy: Clean unreduced monosyllables omit redundant initial ˈ
"""

import os
import re
import json
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict

# Target Accent & Version Metadata
TARGET_ACCENT = "GENERAL_AMERICAN"
PIPELINE_VERSION = "2.2.0-hardened"
MAX_MEMORY_CACHE_ENTRIES = 20_000

# General American Phonotactic Constants for Maximal Onset Syllabification
VALID_ONSET_CLUSTERS = {
    (),
    ('B',), ('CH',), ('D',), ('DH',), ('F',), ('G',), ('HH',), ('JH',), ('K',),
    ('L',), ('M',), ('N',), ('P',), ('R',), ('S',), ('SH',), ('T',), ('TH',),
    ('V',), ('W',), ('Y',), ('Z',), ('ZH',),
    ('P', 'R'), ('T', 'R'), ('K', 'R'), ('B', 'R'), ('D', 'R'), ('G', 'R'), ('F', 'R'), ('TH', 'R'), ('SH', 'R'),
    ('P', 'L'), ('K', 'L'), ('B', 'L'), ('G', 'L'), ('F', 'L'), ('S', 'L'),
    ('P', 'W'), ('T', 'W'), ('K', 'W'), ('D', 'W'), ('G', 'W'), ('S', 'W'), ('TH', 'W'),
    ('S', 'P'), ('S', 'T'), ('S', 'K'), ('S', 'M'), ('S', 'N'),
    ('S', 'P', 'R'), ('S', 'T', 'R'), ('S', 'K', 'R'), ('S', 'P', 'L'), ('S', 'K', 'W'),
}

VOWELS = {'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'}

VOWEL_MAP = {
    'AA': 'ɑ',
    'AE': 'æ',
    'AH': lambda s: 'ʌ' if s in ('1', '2') else 'ə',
    'AO': 'ɔ',
    'AW': 'aʊ',
    'AY': 'aɪ',
    'EH': 'ɛ',
    'ER': lambda s: 'ɝ' if s in ('1', '2') else 'ɚ',
    'EY': 'eɪ',
    'IH': 'ɪ',
    'IY': 'i',
    'OW': 'oʊ',
    'OY': 'ɔɪ',
    'UH': 'ʊ',
    'UW': 'u'
}

UK_VOWEL_MAP = {
    'AA': 'ɒ',
    'AE': 'æ',
    'AH': lambda s: 'ʌ' if s in ('1', '2') else 'ə',
    'AO': 'ɔː',
    'AW': 'aʊ',
    'AY': 'aɪ',
    'EH': 'e',
    'ER': lambda s: 'ɜː' if s in ('1', '2') else 'ə',
    'EY': 'eɪ',
    'IH': 'ɪ',
    'IY': 'iː',
    'OW': 'əʊ',
    'OY': 'ɔɪ',
    'UH': 'ʊ',
    'UW': 'uː',
}

UK_BATH_WORDS = {
    "bath", "path", "ask", "asked", "asking", "can't", "half", "dance", "danced", "dancing",
    "class", "classes", "fast", "faster", "glass", "glasses", "last", "pass", "passed",
    "passing", "past", "laugh", "laughed", "laughing", "after", "afternoon", "answer",
    "chance", "plant", "branch", "staff", "grass", "castle", "example", "command",
    "demand", "master", "task", "mask", "craft",
}

CONS_MAP = {
    'B': 'b', 'CH': 'tʃ', 'D': 'd', 'DH': 'ð', 'F': 'f',
    'G': 'ɡ', 'HH': 'h', 'JH': 'dʒ', 'K': 'k', 'L': 'l',
    'M': 'm', 'N': 'n', 'NG': 'ŋ', 'P': 'p', 'R': 'r',
    'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ', 'V': 'v',
    'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'
}

ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

ABBREV_MAP = {
    "mr.": "mister", "mr": "mister",
    "mrs.": "missus", "mrs": "missus",
    "ms.": "miz", "ms": "miz",
    "dr.": "doctor", "dr": "doctor",
    "u.s.": "u s", "u.s": "u s",
    "u.s.a.": "u s a", "u.s.a": "u s a",
    "u.k.": "u k", "u.k": "u k",
    "etc.": "etcetera", "etc": "etcetera",
    "vs.": "versus", "vs": "versus",
    "i.e.": "that is", "i.e": "that is",
    "e.g.": "for example", "e.g": "for example",
    "ai": "a i", "ceo": "c e o", "usa": "u s a",
}


def _normalize_accent(accent: Optional[str]) -> str:
    raw = (accent or "en-US").strip().lower().replace("_", "-")
    if raw in ("en-gb", "uk", "gb", "british", "rp"):
        return "en-GB"
    return "en-US"


def _accent_label(accent: str) -> str:
    return "BRITISH_ENGLISH" if accent == "en-GB" else TARGET_ACCENT


def num_to_words(n: int) -> str:
    """Convert integer to English words."""
    if n == 0:
        return "zero"
    if n < 0:
        return "negative " + num_to_words(-n)

    parts = []
    if n >= 1_000_000:
        millions = n // 1_000_000
        parts.append(num_to_words(millions) + " million")
        n %= 1_000_000
    if n >= 1_000:
        thousands = n // 1_000
        parts.append(num_to_words(thousands) + " thousand")
        n %= 1_000
    if n >= 100:
        hundreds = n // 100
        parts.append(ONES[hundreds] + " hundred")
        n %= 100
    if n >= 20:
        ten_val = n // 10
        rem = n % 10
        if rem > 0:
            parts.append(f"{TENS[ten_val]}-{ONES[rem]}")
        else:
            parts.append(TENS[ten_val])
    elif n >= 10:
        parts.append(TEENS[n - 10])
    elif n > 0:
        parts.append(ONES[n])

    return " ".join(parts).strip()


def normalize_token_for_spoken(token: str) -> str:
    """Expand numbers, ordinals, currencies ($50, $50.50), percentages (100%),
    decimals, years (2000, 2015, 2026), and common abbreviations (U.S., Dr.) into spoken English words."""
    t = token.strip()
    if not t:
        return t

    # Currency: $50, $15, $50,000, $50.50, $1.05
    if t.startswith("$") and len(t) > 1:
        num_part = t[1:].replace(",", "")
        if num_part.isdigit():
            val = int(num_part)
            unit = "dollar" if val == 1 else "dollars"
            return f"{num_to_words(val)} {unit}"
        m_cur = re.fullmatch(r"(\d+)\.(\d{1,2})", num_part)
        if m_cur:
            dollars = int(m_cur.group(1))
            cents_str = m_cur.group(2)
            cents = int(cents_str.ljust(2, "0"))
            d_unit = "dollar" if dollars == 1 else "dollars"
            if cents == 0:
                return f"{num_to_words(dollars)} {d_unit}"
            c_unit = "cent" if cents == 1 else "cents"
            return f"{num_to_words(dollars)} {d_unit} and {num_to_words(cents)} {c_unit}"

    # Percentages: 100%, 50.5%, 25%
    if t.endswith("%") and len(t) > 1:
        pct_part = t[:-1].replace(",", "")
        if pct_part.isdigit():
            return f"{num_to_words(int(pct_part))} percent"
        if re.fullmatch(r"\d+\.\d+", pct_part):
            parts = pct_part.split(".")
            integer_part = num_to_words(int(parts[0]))
            decimal_digits = " ".join(ONES[int(d)] if d != "0" else "zero" for d in parts[1])
            return f"{integer_part} point {decimal_digits} percent"

    # Decimals (3.14)
    if re.match(r"^\d+\.\d+$", t):
        parts = t.split(".")
        integer_part = num_to_words(int(parts[0]))
        decimal_digits = " ".join(ONES[int(d)] if d != "0" else "zero" for d in parts[1])
        return f"{integer_part} point {decimal_digits}"

    # Comma-separated numbers & 4-digit years (50,000, 2000, 2015, 2026)
    clean_num = t.replace(",", "")
    if clean_num.isdigit():
        val = int(clean_num)
        # 2000-2009 are spoken "two thousand" / "two thousand five", NOT "twenty hundred" / "twenty oh five"
        if 2000 <= val <= 2009 and len(clean_num) == 4 and "," not in t:
            return num_to_words(val)
        # Years 1900-1999 and 2010-2099 (when un-commaed 4-digit token)
        if ((1900 <= val <= 1999) or (2010 <= val <= 2099)) and len(clean_num) == 4 and "," not in t:
            c1 = val // 100
            c2 = val % 100
            if c2 == 0:
                return f"{num_to_words(c1)} hundred"
            elif c2 < 10:
                return f"{num_to_words(c1)} oh {num_to_words(c2)}"
            else:
                return f"{num_to_words(c1)} {num_to_words(c2)}"
        return num_to_words(val)

    # Ordinals (1st, 2nd, 3rd, 4th, 21st, etc.)
    ordinal_match = re.match(r"^(\d+)(st|nd|rd|th)$", t, re.IGNORECASE)
    if ordinal_match:
        val = int(ordinal_match.group(1))
        words = num_to_words(val)
        if words.endswith("one"):
            return words[:-3] + "first"
        elif words.endswith("two"):
            return words[:-3] + "second"
        elif words.endswith("three"):
            return words[:-5] + "third"
        elif words.endswith("five"):
            return words[:-4] + "fifth"
        elif words.endswith("eight"):
            return words + "h"
        elif words.endswith("nine"):
            return words[:-1] + "nth"
        elif words.endswith("twelve"):
            return words[:-2] + "fth"
        elif words.endswith("y"):
            return words[:-1] + "ieth"
        else:
            return words + "th"

    # Abbreviations & Initialisms (U.S., U.S.A., U.K., Dr., Mr., etc.)
    low = t.lower()
    if low in ABBREV_MAP:
        return ABBREV_MAP[low]

    return t


# Pattern matching special spoken tokens BEFORE punctuation stripping (currency, percentage, decimals, dotted abbrevs)
_SPECIAL_SPOKEN_TOKEN_RE = re.compile(
    r"^([\"'“”‘’(\[{]*)"
    r"(\$[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d+)?%|\d+\.\d+|[\d,]{4,}|(?:[A-Za-z]\.){2,}|(?:Mr|Mrs|Ms|Dr|etc|vs)\.)"
    r"([\"'“”‘’)\]},!?:;\.]*)$",
    re.IGNORECASE,
)


class IPAPipeline:
    """
    Unified High-Performance Pronunciation Pipeline (General American en-US default + British en-GB support).
    1. Spoken Text Normalization BEFORE punctuation stripping
    2. Full CMUdict Primary Dictionary Lookup (<0.001ms instant)
    3. Maximal Onset Syllabification & Stress Placement
    4. Heteronym & Multiple Pronunciation Variant Preservation
    5. Fail-Closed OOV Policy: Unresolved OOVs return UNAVAILABLE (zero GPLv3+ phonemizer/espeak dependency)
    """

    def __init__(self, dict_path: Optional[str] = None, max_cache_size: int = MAX_MEMORY_CACHE_ENTRIES):
        self.target_accent = TARGET_ACCENT
        self.pipeline_version = PIPELINE_VERSION
        self._max_cache_size = max(1, int(max_cache_size))
        self._memory_cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._cache_lock = threading.RLock()
        self._cmudict: Dict[str, List[List[str]]] = {}

        if dict_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            dict_path = os.path.join(base_dir, "data", "cmudict-0.7b.txt")

        self._load_cmudict(dict_path)

    def _cache_get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._cache_lock:
            value = self._memory_cache.get(key)
            if value is not None:
                self._memory_cache.move_to_end(key)
            return value

    def _cache_set(self, key: str, value: Dict[str, Any]) -> None:
        with self._cache_lock:
            if key in self._memory_cache:
                self._memory_cache.move_to_end(key)
            self._memory_cache[key] = value
            while len(self._memory_cache) > self._max_cache_size:
                self._memory_cache.popitem(last=False)

    def _load_cmudict(self, dict_path: str):
        """Load full CMUdict 0.7b lexicon into in-memory table."""
        if os.path.exists(dict_path):
            try:
                with open(dict_path, "r", encoding="latin-1") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith(";;;"):
                            continue
                        parts = line.split()
                        if len(parts) < 2:
                            continue
                        clean_w = re.sub(r"\(\d+\)$", "", parts[0]).lower()
                        if clean_w not in self._cmudict:
                            self._cmudict[clean_w] = []
                        self._cmudict[clean_w].append(parts[1:])
            except Exception as e:
                print(f"Warning: Failed to load CMUdict from {dict_path}: {e}")
        else:
            print(f"Warning: CMUdict file not found at {dict_path}")

    def phones_to_ipa(
        self,
        phones: List[str],
        is_monosyllable_strip_stress: bool = True,
        accent: Optional[str] = None,
        word_hint: Optional[str] = None,
    ) -> str:
        """
        Convert ARPAbet phone sequence to IPA with phonotactic maximal onset stress placement.
        Supports General American (`en-US`, default) and British RP (`en-GB`).
        """
        norm_accent = _normalize_accent(accent)
        vowel_count = sum(1 for p in phones if any(p.startswith(v) for v in VOWELS))

        parsed = []
        for p in phones:
            base = "".join([c for c in p if not c.isdigit()])
            stress = "".join([c for c in p if c.isdigit()])
            parsed.append({"base": base, "stress": stress, "raw": p, "is_vowel": base in VOWELS})

        vowel_indices = [i for i, x in enumerate(parsed) if x["is_vowel"]]
        stress_markers: Dict[int, str] = {}

        for vi_idx, vi in enumerate(vowel_indices):
            st = parsed[vi]["stress"]
            if st in ("1", "2"):
                if vowel_count == 1 and st == "1" and is_monosyllable_strip_stress:
                    continue
                mark = "ˈ" if st == "1" else "ˌ"

                if vi_idx == 0:
                    stress_markers[0] = mark
                else:
                    prev_vi = vowel_indices[vi_idx - 1]
                    between = [parsed[k]["base"] for k in range(prev_vi + 1, vi)]
                    onset_offset = len(between)
                    for start in range(len(between)):
                        if tuple(between[start:]) in VALID_ONSET_CLUSTERS:
                            onset_offset = start
                            break
                    onset_idx = prev_vi + 1 + onset_offset
                    stress_markers[onset_idx] = mark

        ipa_out: List[str] = []
        is_uk = norm_accent == "en-GB"
        is_bath = bool(word_hint and word_hint.lower() in UK_BATH_WORDS)
        v_map = UK_VOWEL_MAP if is_uk else VOWEL_MAP

        i = 0
        while i < len(parsed):
            x = parsed[i]
            if i in stress_markers:
                ipa_out.append(stress_markers[i])
            b = x["base"]
            s = x["stress"]

            if is_uk and x["is_vowel"]:
                # Non-rhotic vowel + coda /R/ fusion (when R is not followed by a vowel)
                nxt = parsed[i + 1] if i + 1 < len(parsed) else None
                nxt2 = parsed[i + 2] if i + 2 < len(parsed) else None
                if nxt is not None and nxt["base"] == "R" and (nxt2 is None or not nxt2["is_vowel"]):
                    r_fusion = {
                        "AA": "ɑː",
                        "AO": "ɔː",
                        "IH": "ɪə",
                        "EH": "eə",
                        "UH": "ʊə",
                        "ER": "ɜː" if s in ("1", "2") else "ə",
                    }
                    if b in r_fusion:
                        ipa_out.append(r_fusion[b])
                        i += 2  # consume post-vocalic R
                        continue
                if b == "AE" and is_bath:
                    ipa_out.append("ɑː")
                    i += 1
                    continue

            if x["is_vowel"]:
                fn = v_map.get(b)
                sym = fn(s) if callable(fn) else fn
            else:
                # Non-rhotic stray post-vocalic R (if vowel wasn't in fusion table)
                if is_uk and b == "R" and i > 0 and parsed[i - 1]["is_vowel"]:
                    nxt = parsed[i + 1] if i + 1 < len(parsed) else None
                    if nxt is None or not nxt["is_vowel"]:
                        i += 1
                        continue
                sym = CONS_MAP.get(b, b.lower())
            ipa_out.append(sym or "")
            i += 1

        return "".join(ipa_out)

    def lookup_single_base_word(self, clean_word: str, accent: Optional[str] = None) -> Dict[str, Any]:
        """
        Lookup a single normalized lowercase token.
        1. Exact CMUdict Lookup
        2. Hyphenated Sub-Token Composition
        3. Fails Closed: UNAVAILABLE
        """
        if not clean_word:
            return {"ipa": "", "source": "UNAVAILABLE", "alternatives": [], "status": "EMPTY"}

        norm_accent = _normalize_accent(accent)
        # Preserve plain clean_word cache keys for default en-US (backward compatibility with cache tests)
        cache_key = clean_word if norm_accent == "en-US" else f"{norm_accent}:{clean_word}"

        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached

        # 2. Check Exact CMUdict
        if clean_word in self._cmudict:
            phone_variants = self._cmudict[clean_word]
            ipa_variants = [self.phones_to_ipa(pv, accent=norm_accent, word_hint=clean_word) for pv in phone_variants]
            primary_ipa = ipa_variants[0]
            alts = list(dict.fromkeys(v for v in ipa_variants[1:] if v != primary_ipa))
            status = "MULTIPLE_VALID_PRONUNCIATIONS" if len(alts) > 0 else "EXACT_MATCH"
            res = {
                "ipa": primary_ipa,
                "source": "CMUDICT",
                "alternatives": alts,
                "status": status,
            }
            self._cache_set(cache_key, res)
            return res

        # 3. Check Hyphenated Sub-Tokens (e.g. well-known, sweet-talking, four-day)
        if "-" in clean_word:
            parts = [re.sub(r"^[^\w']+|[^\w']+$", "", p) for p in clean_word.split("-") if p]
            if parts:
                sub_res = [self.lookup_single_base_word(p, accent=norm_accent) for p in parts]
                if all(r["ipa"] for r in sub_res):
                    combined_ipa = " ".join(r["ipa"] for r in sub_res)
                    res = {
                        "ipa": combined_ipa,
                        "source": "CMUDICT",
                        "alternatives": [],
                        "status": "COMPOUND_RESOLVED",
                    }
                    self._cache_set(cache_key, res)
                    return res

        # 4. Fail Closed: Unavailable
        res = {
            "ipa": "",
            "source": "UNAVAILABLE",
            "alternatives": [],
            "status": "UNRESOLVABLE_OOV",
        }
        self._cache_set(cache_key, res)
        return res

    def lookup_word(self, surface_word: str, accent: Optional[str] = None) -> Dict[str, Any]:
        """
        Lookup IPA for a word token, normalizing spoken forms ($50, $50.50, 100%, 2000, U.S.)
        BEFORE stripping terminal punctuation.
        """
        norm_accent = _normalize_accent(accent)
        accent_label = _accent_label(norm_accent)
        surface = surface_word.strip()
        if not surface:
            return {
                "surface": surface,
                "normalized": "",
                "ipa": "",
                "source": "UNAVAILABLE",
                "alternatives": [],
                "targetAccent": accent_label,
                "pipelineVersion": self.pipeline_version,
            }

        # Strip surrounding quotes/brackets/commas/!/?/:; first WITHOUT destroying $, %, or dotted abbrevs (U.S., Dr.)
        soft_core = re.sub(r"^[\s\"'“”‘’\(\)\[\]]+|[\s\"'“”‘’\(\)\[\],!?:;]+$", "", surface)
        if not soft_core:
            soft_core = surface

        # Try spoken expansion BEFORE stripping trailing period (preserves U.S., Dr., $50.50, 100%)
        spoken_expanded = normalize_token_for_spoken(soft_core)
        if spoken_expanded != soft_core:
            clean_core = soft_core
        else:
            clean_core = re.sub(r"^[\s\"'“”‘’\(\)\[\]]+|[\s\"'“”‘’\(\)\[\]\.,!?:;]+$", "", surface)
            if not clean_core:
                clean_core = soft_core
            spoken_expanded = normalize_token_for_spoken(clean_core)

        sub_words = [re.sub(r"^[\s\"'“”‘’]+|[\s\"'“”‘’]+$", "", w).lower() for w in spoken_expanded.split() if w]

        if not sub_words:
            return {
                "surface": clean_core,
                "normalized": clean_core.lower(),
                "ipa": "",
                "source": "UNAVAILABLE",
                "alternatives": [],
                "targetAccent": accent_label,
                "pipelineVersion": self.pipeline_version,
            }

        sub_results = [self.lookup_single_base_word(sw, accent=norm_accent) for sw in sub_words]
        sub_ipas = [r["ipa"] for r in sub_results if r["ipa"]]
        sources = [r["source"] for r in sub_results]
        all_alts: List[str] = []
        for r in sub_results:
            all_alts.extend(r.get("alternatives", []))

        combined_ipa = " ".join(sub_ipas)
        final_source = "CMUDICT" if all(s == "CMUDICT" for s in sources) else "UNAVAILABLE"

        return {
            "surface": clean_core,
            "normalized": " ".join(sub_words),
            "ipa": combined_ipa,
            "source": final_source,
            "alternatives": all_alts,
            "targetAccent": accent_label,
            "pipelineVersion": self.pipeline_version,
        }

    def process_sentence(self, sentence_text: str, accent: Optional[str] = None) -> Dict[str, Any]:
        """
        Process a full sentence into structured word metadata and sentence-level IPA.
        Preserves spoken-normalization tokens ($50, $50.50, 100%, 2000, U.S.) before punctuation splitting.
        """
        norm_accent = _normalize_accent(accent)
        accent_label = _accent_label(norm_accent)
        if not sentence_text or not sentence_text.strip():
            return {
                "text": sentence_text,
                "normalizedText": "",
                "sentenceIpa": "",
                "words": [],
                "targetAccent": accent_label,
                "pipelineVersion": self.pipeline_version,
            }

        raw_tokens = sentence_text.strip().split()
        word_metas = []
        ipa_tokens_for_sentence = []

        for raw in raw_tokens:
            spec_m = _SPECIAL_SPOKEN_TOKEN_RE.match(raw)
            if spec_m:
                prefix = spec_m.group(1) or ""
                core = spec_m.group(2) or ""
                suffix = spec_m.group(3) or ""
            else:
                match = re.match(r"^([^\w']*)([\w'-]+)?([^\w']*)$", raw)
                if match:
                    prefix = match.group(1) or ""
                    core = match.group(2) or ""
                    suffix = match.group(3) or ""
                else:
                    prefix, core, suffix = "", raw, ""

            if not core:
                continue

            info = self.lookup_word(core, accent=norm_accent)
            combined_ipa = info.get("ipa", "")
            surface_clean = info.get("surface", core)

            word_metas.append({
                "surface": surface_clean,
                "normalized": info.get("normalized", surface_clean.lower()),
                "ipa": combined_ipa,
                "source": info.get("source", "CMUDICT"),
                "alternatives": info.get("alternatives", []),
                "prefix": prefix,
                "suffix": suffix,
                "targetAccent": accent_label,
                "pipelineVersion": self.pipeline_version,
            })

            if combined_ipa:
                ipa_tokens_for_sentence.append(f"{prefix}{combined_ipa}{suffix}")
            else:
                ipa_tokens_for_sentence.append(f"{prefix}{core}{suffix}")

        sentence_ipa = " ".join(ipa_tokens_for_sentence)

        return {
            "text": sentence_text,
            "sentenceIpa": sentence_ipa,
            "words": word_metas,
            "targetAccent": accent_label,
            "pipelineVersion": self.pipeline_version,
        }

    def get_word_phones(self, word_text: str) -> List[str]:
        """Returns list of canonical IPA phonemes for a word from CMUdict or G2P."""
        clean = re.sub(r"^[\s\"'“”‘’\(\)\[\]]+|[\s\"'“”‘’\(\)\[\]\.,!?:;]+$", "", word_text.strip()).lower()
        if not clean:
            return []
        if clean in self._cmudict:
            pv = self._cmudict[clean][0]
            phones = []
            for arp in pv:
                base = re.sub(r"\d", "", arp)
                stress = arp[-1] if arp[-1].isdigit() else "0"
                if base in VOWELS:
                    fn = VOWEL_MAP.get(base)
                    sym = fn(stress) if callable(fn) else fn
                else:
                    sym = CONS_MAP.get(base, base.lower())
                if sym:
                    phones.append(sym)
            return phones
        info = self.lookup_word(clean)
        ipa = info.get("ipa", "").replace("ˈ", "").replace("ˌ", "").replace(".", "").replace(" ", "")
        return list(ipa) if ipa else [clean]


# Global singleton instance
pipeline_instance = IPAPipeline()


def get_ipa_pipeline() -> IPAPipeline:
    return pipeline_instance
