"""
Pure-Python Apache-2.0 / First-Party OOV Grapheme-to-IPA Fallback for Kokoro-82M.

Completely eliminates any dependency on GPLv3+ `phonemizer` / `libespeak-ng` /
`espeakng-loader` while guaranteeing that 100% of emitted symbols belong to
Kokoro-82M's exact 114-symbol phoneme vocabulary (`hexgrad/Kokoro-82M/config.json`).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, Optional, Tuple

# Exact verified 114-character vocabulary from hexgrad/Kokoro-82M/config.json
KOKORO_VOCAB_CHARS = frozenset(
    ' !"(),.:;?AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴ'
    'ɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻ—“”…→↓↗↘ꭧ'
)

# Curated US / UK Kokoro-Misaki IPA entries for English Coach domain terms, tech acronyms,
# and common Vietnamese proper nouns that may be OOV in Misaki's built-in dictionary.
_DOMAIN_LEXICON_US: Dict[str, str] = {
    "ielts": "ˈIɛlts",
    "toeic": "tˈOɪk",
    "toefl": "tˈOfᵊl",
    "cefr": "sˌiːˈiːɛfˈɑɹ",
    "jarvis": "ʤˈɑɹvɪs",
    "echo": "ˈɛkO",
    "kokoro": "kOkˈɔɹO",
    "vieneu": "vjˌɛtnˈuː",
    "odyssey": "ˈɑdəsi",
    "flashcard": "flˈæʃkˌɑɹd",
    "flashcards": "flˈæʃkˌɑɹdz",
    "shadowing": "ʃˈædOɪŋ",
    "mybooks": "mˈI bˈʊks",
    "studyspace": "stˈʌdi spˈAs",
    "bilingual": "bIˈlɪŋɡwᵊl",
    "collocation": "kˌɑləkˈAʃᵊn",
    "collocations": "kˌɑləkˈAʃᵊnz",
    "paraphrase": "pˈæɹəfɹˌAz",
    "paraphrasing": "pˈæɹəfɹˌAzɪŋ",
    "phoneme": "fˈOnim",
    "phonemes": "fˈOnimz",
    "phonetic": "fənˈɛTɪk",
    "phonetics": "fənˈɛTɪks",
    "pronunciation": "pɹənˌʌnsiˈAʃᵊn",
    "vocab": "vˈOkæb",
    "anki": "ˈɑŋki",
    "epub": "ˈiːpʌb",
    "pdf": "pˌiːdˌiːˈɛf",
    "tts": "tˌiːtˌiːˈɛs",
    "asr": "ˌAɛsˈɑɹ",
    "ipa": "ˌIpˌiːˈA",
    "llm": "ˌɛlɛlˈɛm",
    "api": "ˌApˌiːˈI",
    "esl": "ˌiːɛsˈɛl",
    "efl": "ˌiːɛfˈɛl",
    "hanoi": "hænˈY",
    "saigon": "sIɡˈɑn",
    "danang": "dɑːnˈæŋ",
    "vietnam": "vjˌɛtnˈɑm",
    "vietnamese": "vjˌɛtnəmˈiz",
    "pho": "fˈʌ",
    "banh": "bˈɑn",
    "mi": "mˈi",
    "sepay": "sˈiːpA",
    "chatgpt": "ʧˈætʤˌiːpˌiːtˈiː",
    "openai": "ˈOpənˌAˈI",
    "whisperx": "wˈɪspɚɛks",
    "englishcoach": "ˈɪŋɡlɪʃ kˈOʧ",
    "hochiminh": "hˈO ʧˈiː mˈɪn",
    "nghe": "ŋˈɛ",
    "doc": "dˈɑk",
    "viet": "vjˈɛt",
    "noi": "nˈY",
    "vs": "vˈɚsəs",
    "etc": "ɛtsˈɛtɚə",
}

_DOMAIN_LEXICON_UK: Dict[str, str] = {
    **_DOMAIN_LEXICON_US,
    "toeic": "tˈQɪk",
    "toefl": "tˈQfᵊl",
    "cefr": "sˌiːˈiːɛfˈɑː",
    "jarvis": "ʤˈɑːvɪs",
    "echo": "ˈɛkQ",
    "kokoro": "kQkˈɔːɹQ",
    "odyssey": "ˈɒdɪsi",
    "flashcard": "flˈaʃkɑːd",
    "flashcards": "flˈaʃkɑːdz",
    "shadowing": "ʃˈadQɪŋ",
    "collocation": "kˌɒləkˈAʃᵊn",
    "collocations": "kˌɒləkˈAʃᵊnz",
    "phoneme": "fˈQniːm",
    "phonemes": "fˈQniːmz",
    "phonetic": "fənˈɛtɪk",
    "phonetics": "fənˈɛtɪks",
    "vocab": "vˈQkab",
    "saigon": "sIɡˈɒn",
    "asr": "ˌAɛsˈɑː",
    "hochiminh": "hˈQ ʧˈiː mˈɪn",
    "doc": "dˈɒk",
    "vs": "vˈɜːsəs",
    "etc": "ɛtsˈɛtɹə",
}

_LETTER_NAMES: Dict[str, str] = {
    "a": "A",
    "b": "biː",
    "c": "siː",
    "d": "diː",
    "e": "iː",
    "f": "ɛf",
    "g": "ʤiː",
    "h": "Aʧ",
    "i": "I",
    "j": "ʤA",
    "k": "kA",
    "l": "ɛl",
    "m": "ɛm",
    "n": "ɛn",
    "o": "O",
    "p": "piː",
    "q": "kjuː",
    "r": "ɑɹ",
    "s": "ɛs",
    "t": "tiː",
    "u": "juː",
    "v": "viː",
    "w": "dˈʌbᵊljuː",
    "x": "ɛks",
    "y": "wI",
    "z": "ziː",
}

_DIGIT_WORDS: Dict[str, str] = {
    "0": "zˈɪɹO",
    "1": "wˈʌn",
    "2": "tˈuː",
    "3": "θɹˈiː",
    "4": "fˈɔɹ",
    "5": "fˈIv",
    "6": "sˈɪks",
    "7": "sˈɛvən",
    "8": "ˈAt",
    "9": "nˈIn",
}

_ASCII_WORD_RE = re.compile(r"[A-Za-z0-9]+")
_VOWELS = frozenset("aeiouy")


_NON_NFKD_LATIN_MAP = str.maketrans({
    "đ": "d",
    "Đ": "D",
    "ø": "o",
    "Ø": "O",
    "ł": "l",
    "Ł": "L",
    "ß": "ss",
    "æ": "ae",
    "Æ": "AE",
    "œ": "oe",
    "Œ": "OE",
})

_TEENS_WORDS: Dict[int, str] = {
    10: "tˈɛn",
    11: "ɪlˈɛvən",
    12: "twˈɛlv",
    13: "θˌɚtˈiːn",
    14: "fˌɔɹtˈiːn",
    15: "fˌɪftˈiːn",
    16: "sˌɪkstˈiːn",
    17: "sˌɛvəntˈiːn",
    18: "ˌAtˈiːn",
    19: "nˌIntˈiːn",
}

_TENS_WORDS: Dict[int, str] = {
    2: "twˈɛnti",
    3: "θˈɚti",
    4: "fˈɔɹti",
    5: "fˈɪfti",
    6: "sˈɪksti",
    7: "sˈɛvənti",
    8: "ˈAti",
    9: "nˈInti",
}


def sanitize_kokoro_phonemes(phonemes: str) -> str:
    """Filter any phoneme string strictly to Kokoro-82M's verified 114-symbol vocabulary."""
    if not phonemes:
        return ""
    return "".join(ch for ch in phonemes if ch in KOKORO_VOCAB_CHARS)


def _strip_diacritics(text: str) -> str:
    mapped = (text or "").translate(_NON_NFKD_LATIN_MAP)
    nfkd = unicodedata.normalize("NFKD", mapped)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _two_digit_ipa(val: int, british: bool = False) -> str:
    if val <= 0:
        return _DIGIT_WORDS["0"]
    if val < 10:
        p = _DIGIT_WORDS[str(val)]
        return p.replace("ɔɹ", "ɔː").replace("O", "Q") if british else p
    if val < 20:
        p = _TEENS_WORDS[val]
        return p.replace("ɚ", "ɜː").replace("ɔɹ", "ɔː") if british else p
    tens, ones = divmod(val, 10)
    t_ipa = _TENS_WORDS[tens]
    if british:
        t_ipa = t_ipa.replace("ɚ", "ɜː").replace("ɔɹ", "ɔː")
    if ones == 0:
        return t_ipa
    o_ipa = _DIGIT_WORDS[str(ones)]
    if british:
        o_ipa = o_ipa.replace("ɔɹ", "ɔː").replace("O", "Q")
    return f"{t_ipa} {o_ipa}"


def _number_to_kokoro_ipa(digits: str, british: bool = False) -> str:
    if not digits or not digits.isdigit():
        return ""
    if len(digits) > 4 or (len(digits) > 1 and digits.startswith("0")):
        return sanitize_kokoro_phonemes(
            " ".join(
                (_DIGIT_WORDS[d].replace("ɔɹ", "ɔː").replace("O", "Q") if british else _DIGIT_WORDS[d])
                for d in digits
                if d in _DIGIT_WORDS
            )
        )
    val = int(digits)
    if val < 100:
        return sanitize_kokoro_phonemes(_two_digit_ipa(val, british))
    if val < 1000:
        h, rem = divmod(val, 100)
        h_ipa = f"{_two_digit_ipa(h, british)} hˈʌndɹəd"
        return sanitize_kokoro_phonemes(h_ipa if rem == 0 else f"{h_ipa} {_two_digit_ipa(rem, british)}")
    # 4-digit year style (e.g. 2026 -> twenty twenty six; 2005 -> two thousand five)
    hi, lo = divmod(val, 100)
    if 19 <= hi <= 20 and lo >= 10:
        return sanitize_kokoro_phonemes(f"{_two_digit_ipa(hi, british)} {_two_digit_ipa(lo, british)}")
    th, rem = divmod(val, 1000)
    th_ipa = f"{_two_digit_ipa(th, british)} θˈWzənd"
    if rem == 0:
        return sanitize_kokoro_phonemes(th_ipa)
    if rem < 100:
        return sanitize_kokoro_phonemes(f"{th_ipa} {_two_digit_ipa(rem, british)}")
    h, r2 = divmod(rem, 100)
    rest = f"{_two_digit_ipa(h, british)} hˈʌndɹəd" + (f" {_two_digit_ipa(r2, british)}" if r2 else "")
    return sanitize_kokoro_phonemes(f"{th_ipa} {rest}")


def _spell_acronym(raw: str, british: bool) -> str:
    parts = []
    for ch in raw.lower():
        if ch in _LETTER_NAMES:
            p = _LETTER_NAMES[ch]
            if british and ch == "r":
                p = "ɑː"
            elif british and ch == "o":
                p = "Q"
            elif british and ch == "z":
                p = "zɛd"
            parts.append(p)
        elif ch in _DIGIT_WORDS:
            parts.append(_DIGIT_WORDS[ch])
    if not parts:
        return ""
    if len(parts) > 1:
        parts[-1] = "ˈ" + parts[-1].lstrip("ˈˌ")
    return sanitize_kokoro_phonemes("".join(parts))


def _rule_g2p_word(word: str, british: bool = False) -> str:
    """Deterministic rule-based English grapheme-to-Kokoro-IPA fallback for unseen OOV tokens."""
    w = _strip_diacritics(word).lower()
    if not w:
        return ""
    if w.isdigit():
        return _number_to_kokoro_ipa(w, british=british)

    # Strip trailing silent 'e' marker for single-syllable/root vowel lengthening
    silent_e = len(w) >= 4 and w.endswith("e") and w[-2] not in _VOWELS and w[-3] in _VOWELS
    core = w[:-1] if silent_e else w

    out = []
    i = 0
    n = len(core)
    while i < n:
        rem = core[i:]
        # 4-letter suffixes / clusters
        if rem.startswith("tion"):
            out.append("ʃən")
            i += 4
            continue
        if rem.startswith("sion"):
            out.append("ʒən" if i > 0 and core[i - 1] in _VOWELS else "ʃən")
            i += 4
            continue
        if rem.startswith("ough"):
            out.append("O" if not british else "Q")
            i += 4
            continue
        if rem.startswith("ight"):
            out.append("It")
            i += 4
            continue
        if rem.startswith("ture") and i + 4 == n:
            out.append("ʧɚ" if not british else "ʧə")
            i += 4
            continue

        # 3-letter clusters
        if rem.startswith("igh"):
            out.append("I")
            i += 3
            continue
        if rem.startswith("tch"):
            out.append("ʧ")
            i += 3
            continue
        if rem.startswith("dge"):
            out.append("ʤ")
            i += 3
            continue
        if rem.startswith("ing") and i + 3 == n:
            out.append("ɪŋ")
            i += 3
            continue
        if rem.startswith("sch"):
            out.append("sk")
            i += 3
            continue

        # 2-letter digraphs
        if i + 2 <= n:
            dig = core[i : i + 2]
            if dig == "ch":
                out.append("ʧ")
                i += 2
                continue
            if dig == "sh":
                out.append("ʃ")
                i += 2
                continue
            if dig == "th":
                out.append("θ")
                i += 2
                continue
            if dig == "ph":
                out.append("f")
                i += 2
                continue
            if dig == "wh":
                out.append("w")
                i += 2
                continue
            if dig == "ng":
                out.append("ŋ")
                i += 2
                continue
            if dig == "ck":
                out.append("k")
                i += 2
                continue
            if dig == "qu":
                out.append("kw")
                i += 2
                continue
            if dig in ("ee", "ea"):
                out.append("iː")
                i += 2
                continue
            if dig == "oo":
                out.append("uː")
                i += 2
                continue
            if dig in ("ai", "ay"):
                out.append("A")
                i += 2
                continue
            if dig in ("oi", "oy"):
                out.append("Y")
                i += 2
                continue
            if dig in ("ou", "ow"):
                out.append("W")
                i += 2
                continue
            if dig in ("au", "aw"):
                out.append("ɔː")
                i += 2
                continue
            if dig == "oa":
                out.append("O" if not british else "Q")
                i += 2
                continue
            if dig in ("ew", "ue"):
                out.append("uː")
                i += 2
                continue
            if dig == "ar":
                out.append("ɑɹ" if not british else "ɑː")
                i += 2
                continue
            if dig in ("er", "ir", "ur"):
                out.append("ɚ" if not british else "ɜː")
                i += 2
                continue
            if dig == "or":
                out.append("ɔɹ" if not british else "ɔː")
                i += 2
                continue
            if dig[0] == dig[1] and dig[0] not in _VOWELS:
                # Geminate consonant -> single sound
                i += 1
                continue

        ch = core[i]
        nxt = core[i + 1] if i + 1 < n else ""
        is_last_vowel = silent_e and i == n - 2

        if ch == "a":
            out.append("A" if is_last_vowel else ("æ" if not british else "a"))
        elif ch == "e":
            out.append("iː" if is_last_vowel else "ɛ")
        elif ch == "i":
            out.append("I" if is_last_vowel else "ɪ")
        elif ch == "o":
            if is_last_vowel:
                out.append("O" if not british else "Q")
            else:
                out.append("ɑ" if not british else "ɒ")
        elif ch == "u":
            out.append("juː" if is_last_vowel else "ʌ")
        elif ch == "y":
            if i == 0:
                out.append("j")
            elif i == n - 1:
                out.append("i")
            else:
                out.append("ɪ")
        elif ch == "c":
            out.append("s" if nxt in ("e", "i", "y") else "k")
        elif ch == "g":
            out.append("ʤ" if nxt in ("e", "i", "y") else "ɡ")
        elif ch == "j":
            out.append("ʤ")
        elif ch == "q":
            out.append("k")
        elif ch == "r":
            out.append("ɹ")
        elif ch == "x":
            out.append("ks")
        elif ch in ("b", "d", "f", "h", "k", "l", "m", "n", "p", "s", "t", "v", "w", "z"):
            out.append(ch)
        elif ch in _DIGIT_WORDS:
            out.append(_DIGIT_WORDS[ch])
        i += 1

    raw_ipa = "".join(out)
    if not raw_ipa:
        return ""
    if "ˈ" not in raw_ipa:
        raw_ipa = "ˈ" + raw_ipa
    return sanitize_kokoro_phonemes(raw_ipa)


class KokoroOovFallback:
    """
    Drop-in GPL-free `fallback` callable for `misaki.en.G2P(fallback=...)`.

    Accepts either a `misaki.en.MToken` (with `.text`) or a plain `str`, returning
    `(phonemes, rating)` where every character is verified against `KOKORO_VOCAB_CHARS`.
    """

    def __init__(self, british: bool = False) -> None:
        self.british = bool(british)
        self._lexicon = _DOMAIN_LEXICON_UK if self.british else _DOMAIN_LEXICON_US

    def __call__(self, token: Any) -> Tuple[Optional[str], Optional[int]]:
        raw = getattr(token, "text", token)
        if not isinstance(raw, str):
            return None, None
        cleaned = raw.strip()
        if not cleaned:
            return None, None

        stripped_clean = _strip_diacritics(cleaned)
        lower = stripped_clean.lower()
        if lower in self._lexicon:
            return sanitize_kokoro_phonemes(self._lexicon[lower]), 3

        # Handle hyphenated, accented, or alphanumeric compounds (e.g. "B2", "IELTS-ready", "Đà-Nẵng", "résumé")
        parts = _ASCII_WORD_RE.findall(stripped_clean)
        if not parts:
            return None, None

        phoneme_parts = []
        for part in parts:
            p_low = _strip_diacritics(part).lower()
            if p_low in self._lexicon:
                phoneme_parts.append(self._lexicon[p_low])
            elif part.isupper() and 2 <= len(part) <= 5 and not any(v in p_low for v in "aeiou"):
                phoneme_parts.append(_spell_acronym(part, self.british))
            elif len(part) == 2 and part[0].isalpha() and part[1].isdigit():
                # CEFR levels like A1, A2, B1, B2, C1, C2
                phoneme_parts.append(_spell_acronym(part, self.british))
            else:
                phoneme_parts.append(_rule_g2p_word(part, self.british))

        joined = sanitize_kokoro_phonemes(" ".join(p for p in phoneme_parts if p))
        if not joined:
            return None, None
        return joined, 2
