"""
SHD-2B.5 Phoneme Diagnosis & Articulatory Feature Schema (Round 1).
English Coach — Acoustic Diagnosis & Articulatory Feedback Module.

Features:
- Canonical Real-Phone Inventory: Strict filtering of real phonetic tokens (excludes blank, pad, special, unk, modifiers).
- Explicit, Versioned Articulatory Feature Table (Consonants: place, manner, voicing; Vowels: height, backness, rounding, tenseness, rhotic).
- Train-Only Empirical Confusion Graph & Restricted Competitor Sets.
- Differentiable Articulatory Feature Projection for Model E.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ARTICULATORY_SCHEMA_VERSION = "shd-2b5-articulatory-v1"


class ConsonantPlace(str, Enum):
    BILABIAL = "bilabial"
    LABIODENTAL = "labiodental"
    DENTAL = "dental"
    ALVEOLAR = "alveolar"
    POSTALVEOLAR = "postalveolar"
    PALATAL = "palatal"
    VELAR = "velar"
    GLOTTAL = "glottal"


class ConsonantManner(str, Enum):
    STOP = "stop"
    FRICATIVE = "fricative"
    AFFRICATE = "affricate"
    NASAL = "nasal"
    APPROXIMANT = "approximant"
    LATERAL = "lateral"


class Voicing(str, Enum):
    VOICED = "voiced"
    VOICELESS = "voiceless"


class VowelHeight(str, Enum):
    CLOSE = "close"
    NEAR_CLOSE = "near_close"
    CLOSE_MID = "close_mid"
    MID = "mid"
    OPEN_MID = "open_mid"
    NEAR_OPEN = "near_open"
    OPEN = "open"


class VowelBackness(str, Enum):
    FRONT = "front"
    CENTRAL = "central"
    BACK = "back"


class VowelRounding(str, Enum):
    ROUNDED = "rounded"
    UNROUNDED = "unrounded"


class VowelTenseness(str, Enum):
    TENSE = "tense"
    LAX = "lax"


@dataclass
class PhoneArticulatoryProfile:
    canonicalIpa: str
    tokenId: int
    isVowel: bool
    arpabetAliases: List[str] = field(default_factory=list)
    # Consonant features (None for vowels)
    place: Optional[ConsonantPlace] = None
    manner: Optional[ConsonantManner] = None
    voicing: Optional[Voicing] = None
    # Vowel features (None for consonants)
    height: Optional[VowelHeight] = None
    backness: Optional[VowelBackness] = None
    rounding: Optional[VowelRounding] = None
    tenseness: Optional[VowelTenseness] = None
    isRhotic: bool = False
    isDiphthong: bool = False


# Canonical phone definitions with full linguistic phonetic features
CANONICAL_PHONE_PROFILES: Dict[str, Dict[str, Any]] = {
    # Consonants
    "p": {"isVowel": False, "arpabet": ["P"], "place": ConsonantPlace.BILABIAL, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICELESS},
    "b": {"isVowel": False, "arpabet": ["B"], "place": ConsonantPlace.BILABIAL, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICED},
    "t": {"isVowel": False, "arpabet": ["T"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICELESS},
    "d": {"isVowel": False, "arpabet": ["D"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICED},
    "k": {"isVowel": False, "arpabet": ["K"], "place": ConsonantPlace.VELAR, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICELESS},
    "ɡ": {"isVowel": False, "arpabet": ["G"], "place": ConsonantPlace.VELAR, "manner": ConsonantManner.STOP, "voicing": Voicing.VOICED},
    "f": {"isVowel": False, "arpabet": ["F"], "place": ConsonantPlace.LABIODENTAL, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICELESS},
    "v": {"isVowel": False, "arpabet": ["V"], "place": ConsonantPlace.LABIODENTAL, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICED},
    "θ": {"isVowel": False, "arpabet": ["TH"], "place": ConsonantPlace.DENTAL, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICELESS},
    "ð": {"isVowel": False, "arpabet": ["DH"], "place": ConsonantPlace.DENTAL, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICED},
    "s": {"isVowel": False, "arpabet": ["S"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICELESS},
    "z": {"isVowel": False, "arpabet": ["Z"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICED},
    "ʃ": {"isVowel": False, "arpabet": ["SH"], "place": ConsonantPlace.POSTALVEOLAR, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICELESS},
    "ʒ": {"isVowel": False, "arpabet": ["ZH"], "place": ConsonantPlace.POSTALVEOLAR, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICED},
    "h": {"isVowel": False, "arpabet": ["HH"], "place": ConsonantPlace.GLOTTAL, "manner": ConsonantManner.FRICATIVE, "voicing": Voicing.VOICELESS},
    "m": {"isVowel": False, "arpabet": ["M"], "place": ConsonantPlace.BILABIAL, "manner": ConsonantManner.NASAL, "voicing": Voicing.VOICED},
    "n": {"isVowel": False, "arpabet": ["N"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.NASAL, "voicing": Voicing.VOICED},
    "ŋ": {"isVowel": False, "arpabet": ["NG"], "place": ConsonantPlace.VELAR, "manner": ConsonantManner.NASAL, "voicing": Voicing.VOICED},
    "l": {"isVowel": False, "arpabet": ["L"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.LATERAL, "voicing": Voicing.VOICED},
    "ɹ": {"isVowel": False, "arpabet": ["R"], "place": ConsonantPlace.POSTALVEOLAR, "manner": ConsonantManner.APPROXIMANT, "voicing": Voicing.VOICED},
    "r": {"isVowel": False, "arpabet": ["R"], "place": ConsonantPlace.ALVEOLAR, "manner": ConsonantManner.APPROXIMANT, "voicing": Voicing.VOICED},
    "j": {"isVowel": False, "arpabet": ["Y"], "place": ConsonantPlace.PALATAL, "manner": ConsonantManner.APPROXIMANT, "voicing": Voicing.VOICED},
    "w": {"isVowel": False, "arpabet": ["W"], "place": ConsonantPlace.BILABIAL, "manner": ConsonantManner.APPROXIMANT, "voicing": Voicing.VOICED},
    "tʃ": {"isVowel": False, "arpabet": ["CH"], "place": ConsonantPlace.POSTALVEOLAR, "manner": ConsonantManner.AFFRICATE, "voicing": Voicing.VOICELESS},
    "dʒ": {"isVowel": False, "arpabet": ["JH"], "place": ConsonantPlace.POSTALVEOLAR, "manner": ConsonantManner.AFFRICATE, "voicing": Voicing.VOICED},

    # Vowels - Monophthongs
    "iː": {"isVowel": True, "arpabet": ["IY", "IY0", "IY1", "IY2"], "height": VowelHeight.CLOSE, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "i": {"isVowel": True, "arpabet": ["IY"], "height": VowelHeight.CLOSE, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɪ": {"isVowel": True, "arpabet": ["IH", "IH0", "IH1", "IH2"], "height": VowelHeight.NEAR_CLOSE, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "e": {"isVowel": True, "arpabet": ["EY"], "height": VowelHeight.CLOSE_MID, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɛ": {"isVowel": True, "arpabet": ["EH", "EH0", "EH1", "EH2"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "æ": {"isVowel": True, "arpabet": ["AE", "AE0", "AE1", "AE2"], "height": VowelHeight.NEAR_OPEN, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "a": {"isVowel": True, "arpabet": ["AA"], "height": VowelHeight.OPEN, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɑː": {"isVowel": True, "arpabet": ["AA", "AA0", "AA1", "AA2"], "height": VowelHeight.OPEN, "backness": VowelBackness.BACK, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɑ": {"isVowel": True, "arpabet": ["AA"], "height": VowelHeight.OPEN, "backness": VowelBackness.BACK, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɒ": {"isVowel": True, "arpabet": ["AA"], "height": VowelHeight.OPEN, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.LAX},
    "ɔː": {"isVowel": True, "arpabet": ["AO", "AO0", "AO1", "AO2"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE},
    "ɔ": {"isVowel": True, "arpabet": ["AO"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE},
    "ʊ": {"isVowel": True, "arpabet": ["UH", "UH0", "UH1", "UH2"], "height": VowelHeight.NEAR_CLOSE, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.LAX},
    "uː": {"isVowel": True, "arpabet": ["UW", "UW0", "UW1", "UW2"], "height": VowelHeight.CLOSE, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE},
    "u": {"isVowel": True, "arpabet": ["UW"], "height": VowelHeight.CLOSE, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE},
    "ʌ": {"isVowel": True, "arpabet": ["AH", "AH0", "AH1", "AH2"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "ɜː": {"isVowel": True, "arpabet": ["ER", "ER0", "ER1", "ER2"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE, "isRhotic": True},
    "ə": {"isVowel": True, "arpabet": ["AX", "AH0"], "height": VowelHeight.MID, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "ɚ": {"isVowel": True, "arpabet": ["ER0", "AXR"], "height": VowelHeight.MID, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX, "isRhotic": True},
    "ɐ": {"isVowel": True, "arpabet": ["AH"], "height": VowelHeight.NEAR_OPEN, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "ɨ": {"isVowel": True, "arpabet": ["IX"], "height": VowelHeight.CLOSE, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX},
    "ʉ": {"isVowel": True, "arpabet": ["UX"], "height": VowelHeight.CLOSE, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.LAX},

    # Diphthongs / Triphthongs
    "eɪ": {"isVowel": True, "arpabet": ["EY", "EY0", "EY1", "EY2"], "height": VowelHeight.CLOSE_MID, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "aɪ": {"isVowel": True, "arpabet": ["AY", "AY0", "AY1", "AY2"], "height": VowelHeight.OPEN, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "ɔɪ": {"isVowel": True, "arpabet": ["OY", "OY0", "OY1", "OY2"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "oʊ": {"isVowel": True, "arpabet": ["OW", "OW0", "OW1", "OW2"], "height": VowelHeight.CLOSE_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "aʊ": {"isVowel": True, "arpabet": ["AW", "AW0", "AW1", "AW2"], "height": VowelHeight.OPEN, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "ɑːɹ": {"isVowel": True, "arpabet": ["AA R"], "height": VowelHeight.OPEN, "backness": VowelBackness.BACK, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE, "isRhotic": True, "isDiphthong": True},
    "ɔːɹ": {"isVowel": True, "arpabet": ["AO R"], "height": VowelHeight.OPEN_MID, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE, "isRhotic": True, "isDiphthong": True},
    "aɪɚ": {"isVowel": True, "arpabet": ["AY R"], "height": VowelHeight.OPEN, "backness": VowelBackness.FRONT, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.TENSE, "isRhotic": True, "isDiphthong": True},
    "ɪuː": {"isVowel": True, "arpabet": ["Y UW"], "height": VowelHeight.CLOSE, "backness": VowelBackness.BACK, "rounding": VowelRounding.ROUNDED, "tenseness": VowelTenseness.TENSE, "isDiphthong": True},
    "əl": {"isVowel": True, "arpabet": ["AH L", "EL"], "height": VowelHeight.MID, "backness": VowelBackness.CENTRAL, "rounding": VowelRounding.UNROUNDED, "tenseness": VowelTenseness.LAX, "isDiphthong": True},
}


class CanonicalRealPhoneInventory:
    """
    Manages the explicit inventory of valid, real phonetic tokens.
    Excludes blank, pad, special, unk, delimiters, modifiers.
    """

    def __init__(self, tokenizer_vocab: Dict[str, int]):
        self.tokenizer_vocab = tokenizer_vocab
        self.real_phones: List[PhoneArticulatoryProfile] = []
        self.phone2profile: Dict[str, PhoneArticulatoryProfile] = {}
        self.token2profile: Dict[int, PhoneArticulatoryProfile] = {}
        self.token_ids: List[int] = []
        self.ipa_to_real_idx: Dict[str, int] = {}
        self.arpabet2ipa: Dict[str, str] = {}

        # Special token exclusions
        self.excluded_tokens = {"<pad>", "<s>", "</s>", "<unk>", "|", " ", "\u0329"}

        for ipa, meta in CANONICAL_PHONE_PROFILES.items():
            if ipa in tokenizer_vocab:
                tid = tokenizer_vocab[ipa]
                if tid < 4:
                    continue
                profile = PhoneArticulatoryProfile(
                    canonicalIpa=ipa,
                    tokenId=tid,
                    isVowel=meta["isVowel"],
                    arpabetAliases=meta.get("arpabet", []),
                    place=meta.get("place"),
                    manner=meta.get("manner"),
                    voicing=meta.get("voicing"),
                    height=meta.get("height"),
                    backness=meta.get("backness"),
                    rounding=meta.get("rounding"),
                    tenseness=meta.get("tenseness"),
                    isRhotic=meta.get("isRhotic", False),
                    isDiphthong=meta.get("isDiphthong", False),
                )
                self.real_phones.append(profile)
                self.phone2profile[ipa] = profile
                self.token2profile[tid] = profile
                self.token_ids.append(tid)
                self.ipa_to_real_idx[ipa] = len(self.real_phones) - 1

                for arpa in meta.get("arpabet", []):
                    clean_arpa = arpa.upper().rstrip("012")
                    if clean_arpa not in self.arpabet2ipa:
                        self.arpabet2ipa[clean_arpa] = ipa
                    self.arpabet2ipa[arpa.upper()] = ipa

        self.num_real_phones = len(self.real_phones)
        self.real_token_tensor = torch.tensor(self.token_ids, dtype=torch.long)

        # Build articulatory feature matrix (V_real x D_art)
        self.articulatory_matrix, self.feature_names = self._build_articulatory_projection_matrix()

    def _build_articulatory_projection_matrix(self) -> Tuple[torch.Tensor, List[str]]:
        features = [
            # Consonant Place (8)
            "place_bilabial", "place_labiodental", "place_dental", "place_alveolar",
            "place_postalveolar", "place_palatal", "place_velar", "place_glottal",
            # Consonant Manner (6)
            "manner_stop", "manner_fricative", "manner_affricate", "manner_nasal",
            "manner_approximant", "manner_lateral",
            # Voicing (2)
            "voicing_voiced", "voicing_voiceless",
            # Vowel Height (7)
            "height_close", "height_near_close", "height_close_mid", "height_mid",
            "height_open_mid", "height_near_open", "height_open",
            # Vowel Backness (3)
            "backness_front", "backness_central", "backness_back",
            # Vowel Rounding (2)
            "rounding_rounded", "rounding_unrounded",
            # Extras (3)
            "is_vowel", "is_rhotic", "is_diphthong"
        ]
        feat2idx = {f: i for i, f in enumerate(features)}
        M = np.zeros((self.num_real_phones, len(features)), dtype=np.float32)

        for p_idx, profile in enumerate(self.real_phones):
            if profile.isVowel:
                M[p_idx, feat2idx["is_vowel"]] = 1.0
                if profile.height:
                    M[p_idx, feat2idx[f"height_{profile.height.value}"]] = 1.0
                if profile.backness:
                    M[p_idx, feat2idx[f"backness_{profile.backness.value}"]] = 1.0
                if profile.rounding:
                    M[p_idx, feat2idx[f"rounding_{profile.rounding.value}"]] = 1.0
                if profile.isRhotic:
                    M[p_idx, feat2idx["is_rhotic"]] = 1.0
                if profile.isDiphthong:
                    M[p_idx, feat2idx["is_diphthong"]] = 1.0
            else:
                if profile.place:
                    M[p_idx, feat2idx[f"place_{profile.place.value}"]] = 1.0
                if profile.manner:
                    M[p_idx, feat2idx[f"manner_{profile.manner.value}"]] = 1.0
                if profile.voicing:
                    M[p_idx, feat2idx[f"voicing_{profile.voicing.value}"]] = 1.0

        return torch.tensor(M, dtype=torch.float32), features

    def compute_articulatory_distance(self, p1: str, p2: str) -> float:
        """Compute phonetic distance between two real phones in articulatory space."""
        if p1 not in self.phone2profile or p2 not in self.phone2profile:
            return 999.0
        prof1 = self.phone2profile[p1]
        prof2 = self.phone2profile[p2]

        if prof1.isVowel != prof2.isVowel:
            return 10.0 # High penalty for consonant-vowel crossing

        if not prof1.isVowel: # Consonants
            dist = 0.0
            if prof1.place != prof2.place:
                dist += 1.5
            if prof1.manner != prof2.manner:
                dist += 2.0
            if prof1.voicing != prof2.voicing:
                dist += 1.0
            return dist
        else: # Vowels
            dist = 0.0
            if prof1.height != prof2.height:
                dist += 1.5
            if prof1.backness != prof2.backness:
                dist += 1.5
            if prof1.rounding != prof2.rounding:
                dist += 1.0
            if prof1.isRhotic != prof2.isRhotic:
                dist += 1.0
            return dist

    def get_articulatory_neighbors(self, target_ipa: str, top_k: int = 5) -> List[str]:
        """Find the top-K closest valid real phones in articulatory feature space."""
        if target_ipa not in self.phone2profile:
            return []
        candidates = []
        for p in self.phone2profile.keys():
            if p == target_ipa:
                continue
            d = self.compute_articulatory_distance(target_ipa, p)
            candidates.append((p, d))
        candidates.sort(key=lambda x: x[1])
        return [p for p, d in candidates[:top_k]]


class TrainConfusionGraph:
    """
    Builds empirical human mispronunciation confusion graph derived STRICTLY from TRAIN speakers.
    Guarantees zero data leakage from validation or historical test splits.
    """

    def __init__(self, inventory: CanonicalRealPhoneInventory):
        self.inventory = inventory
        self.train_confusion_counts: Dict[str, Counter] = defaultdict(Counter)
        self.train_substitution_rows = 0
        self.restricted_competitors: Dict[str, List[int]] = {}
        self.manifest_hash = ""

    def build_from_train_data(
        self,
        scores_detail_path: Path,
        train_speaker_ids: Set[str],
        min_competitors: int = 4
    ) -> None:
        with open(scores_detail_path, "r", encoding="utf-8") as f:
            sd_data = json.load(f)

        for utt_id, utt in sd_data.items():
            spk_num = int(utt_id[:5])
            spk_id = f"speechocean762:{spk_num:04d}"
            # STRICT TRAIN-ONLY FILTER
            if spk_id not in train_speaker_ids and f"SPEAKER{spk_num:04d}" not in train_speaker_ids and utt_id[:5] not in train_speaker_ids:
                continue

            for w in utt.get("words", []):
                ref_tokens = w.get("ref-phones", "").split()
                expert_lists = [ep.split() for ep in w.get("phones", [])]

                for ep_tokens in expert_lists:
                    for t_idx, tok in enumerate(ep_tokens):
                        if tok.startswith("[") and tok.endswith("]"):
                            # Perceived sound
                            arpa_ins = tok[1:-1].upper().rstrip("012")
                            ipa_ins = self.inventory.arpabet2ipa.get(arpa_ins)
                            if not ipa_ins:
                                continue

                            # Check adjacent error phone
                            target_arpa = None
                            if t_idx > 0 and ep_tokens[t_idx-1].startswith("(") and ep_tokens[t_idx-1].endswith(")"):
                                target_arpa = ep_tokens[t_idx-1][1:-1].upper().rstrip("012")
                            elif t_idx + 1 < len(ep_tokens) and ep_tokens[t_idx+1].startswith("(") and ep_tokens[t_idx+1].endswith(")"):
                                target_arpa = ep_tokens[t_idx+1][1:-1].upper().rstrip("012")

                            if target_arpa:
                                target_ipa = self.inventory.arpabet2ipa.get(target_arpa)
                                if target_ipa and target_ipa in self.inventory.phone2profile and ipa_ins in self.inventory.phone2profile:
                                    if target_ipa != ipa_ins:
                                        self.train_confusion_counts[target_ipa][ipa_ins] += 1
                                        self.train_substitution_rows += 1

        # Construct restricted competitor sets for every real phone
        for ipa, profile in self.inventory.phone2profile.items():
            comp_ipas = set()
            # 1. Add empirical train substitutions
            if ipa in self.train_confusion_counts:
                for sub_ipa, count in self.train_confusion_counts[ipa].most_common(5):
                    comp_ipas.add(sub_ipa)

            # 2. Add articulatory neighbors if empirical support < min_competitors
            if len(comp_ipas) < min_competitors:
                neighbors = self.inventory.get_articulatory_neighbors(ipa, top_k=min_competitors + 2)
                for n_ipa in neighbors:
                    comp_ipas.add(n_ipa)
                    if len(comp_ipas) >= min_competitors + 2:
                        break

            # Convert to token IDs (guaranteed real phone token IDs, >= 4)
            comp_token_ids = [self.inventory.phone2profile[c].tokenId for c in comp_ipas if c in self.inventory.phone2profile]
            if not comp_token_ids: # Fallback to real phone inventory (excluding target)
                comp_token_ids = [t for t in self.inventory.token_ids if t != profile.tokenId][:min_competitors]

            self.restricted_competitors[ipa] = sorted(comp_token_ids)

        hasher = hashlib.sha256()
        hasher.update(json.dumps({k: dict(v) for k, v in self.train_confusion_counts.items()}, sort_keys=True).encode("utf-8"))
        self.manifest_hash = hasher.hexdigest()

    def get_competitor_token_ids(self, target_ipa: str) -> List[int]:
        if target_ipa in self.restricted_competitors:
            return self.restricted_competitors[target_ipa]
        # Fallback to articulatory neighbors
        neighbors = self.inventory.get_articulatory_neighbors(target_ipa, top_k=5)
        tids = [self.inventory.phone2profile[n].tokenId for n in neighbors if n in self.inventory.phone2profile]
        if not tids:
            tids = [t for t in self.inventory.token_ids[:5]]
        return tids
