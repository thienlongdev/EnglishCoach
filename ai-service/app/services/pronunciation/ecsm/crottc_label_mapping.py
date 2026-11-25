"""
CROTTC-IF 44-label encoder to Project IPA bidirectional mapping.
Official model vocabulary: Haopeng/CROTTC-IF-l2-arctic (label_encoder.txt).
"""

from __future__ import annotations
from typing import Dict, Optional, Tuple, List

# Exact 44-label dictionary from official CROTTC-IF bundle
CROTTC_LABEL_TO_ID: Dict[str, int] = {
    "<blank>": 0,
    "ae": 1,
    "l": 2,
    "ay": 3,
    "k": 4,
    "r": 5,
    "iy": 6,
    "y": 7,
    "uw": 8,
    "sil": 9,
    "aa": 10,
    "eh": 11,
    "d": 12,
    "w": 13,
    "ah": 14,
    "z": 15,
    "ch": 16,
    "ey": 17,
    "n": 18,
    "jh": 19,
    "aw": 20,
    "hh": 21,
    "f": 22,
    "th": 23,
    "ih": 24,
    "m": 25,
    "dh": 26,
    "s": 27,
    "ao": 28,
    "ow": 29,
    "v": 30,
    "er": 31,
    "g": 32,
    "t": 33,
    "uh": 34,
    "zh": 35,
    "ng": 36,
    "err": 37,
    "p": 38,
    "b": 39,
    "oy": 40,
    "sh": 41,
    "<bos>": 42,
    "<eos>": 43,
}

ID_TO_CROTTC_LABEL: Dict[int, str] = {v: k for k, v in CROTTC_LABEL_TO_ID.items()}

# Mapping from CROTTC ARPAbet lowercase label to canonical project IPA
CROTTC_LABEL_TO_IPA: Dict[str, str] = {
    "ae": "æ",
    "l": "l",
    "ay": "aɪ",
    "k": "k",
    "r": "ɹ",
    "iy": "i",
    "y": "j",
    "uw": "u",
    "sil": "sil",
    "aa": "ɑ",
    "eh": "ɛ",
    "d": "d",
    "w": "w",
    "ah": "ʌ",
    "z": "z",
    "ch": "tʃ",
    "ey": "eɪ",
    "n": "n",
    "jh": "dʒ",
    "aw": "aʊ",
    "hh": "h",
    "f": "f",
    "th": "θ",
    "ih": "ɪ",
    "m": "m",
    "dh": "ð",
    "s": "s",
    "ao": "ɔ",
    "ow": "oʊ",
    "v": "v",
    "er": "ɚ",
    "g": "g",
    "t": "t",
    "uh": "ʊ",
    "zh": "ʒ",
    "ng": "ŋ",
    "err": "err",
    "p": "p",
    "b": "b",
    "oy": "ɔɪ",
    "sh": "ʃ",
    "<blank>": "<blank>",
    "<bos>": "<bos>",
    "<eos>": "<eos>",
}

# Reverse mapping from Project IPA (including common variant symbols) to CROTTC model label
IPA_TO_CROTTC_LABEL: Dict[str, str] = {
    "æ": "ae",
    "l": "l",
    "aɪ": "ay",
    "ai": "ay",
    "k": "k",
    "ɹ": "r",
    "r": "r",
    "i": "iy",
    "iː": "iy",
    "j": "y",
    "u": "uw",
    "uː": "uw",
    "ɑ": "aa",
    "a": "aa",
    "aː": "aa",
    "ɛ": "eh",
    "e": "eh",
    "d": "d",
    "w": "w",
    "ʌ": "ah",
    "ə": "ah",
    "z": "z",
    "tʃ": "ch",
    "ʧ": "ch",
    "eɪ": "ey",
    "ei": "ey",
    "n": "n",
    "dʒ": "jh",
    "ʤ": "jh",
    "aʊ": "aw",
    "au": "aw",
    "h": "hh",
    "f": "f",
    "θ": "th",
    "ɪ": "ih",
    "m": "m",
    "ð": "dh",
    "s": "s",
    "ɔ": "ao",
    "ɒ": "ao",
    "oʊ": "ow",
    "ou": "ow",
    "o": "ow",
    "v": "v",
    "ɚ": "er",
    "ɝ": "er",
    "ɜːr": "er",
    "g": "g",
    "ɡ": "g",
    "t": "t",
    "ʊ": "uh",
    "ʒ": "zh",
    "ŋ": "ng",
    "p": "p",
    "b": "b",
    "ɔɪ": "oy",
    "oi": "oy",
    "ʃ": "sh",
    "sil": "sil",
    "err": "err",
}

def crottc_label_to_ipa(label: str) -> str:
    """Converts a CROTTC label string to project standard IPA."""
    clean = label.strip().lower().replace("\u0261", "g")
    return CROTTC_LABEL_TO_IPA.get(clean, clean)

def ipa_to_crottc_label(ipa: str) -> Optional[str]:
    """Converts a project IPA symbol to CROTTC label, returning None if unmapped."""
    clean = ipa.strip().replace("\u0261", "g")
    return IPA_TO_CROTTC_LABEL.get(clean)

def normalize_crottc_sequence_to_ipa(tokens: List[str]) -> List[str]:
    """Filters special tokens (<blank>, <bos>, <eos>, sil) and converts labels to IPA."""
    res = []
    for tok in tokens:
        clean = tok.strip().lower()
        if clean in ("<blank>", "<bos>", "<eos>", "sil", ""):
            continue
        res.append(crottc_label_to_ipa(clean))
    return res
