"""
Deterministic Phoneme Sequence Alignment Engine (Levenshtein on Phone Sequences).
Supports Multi-Variant Canonical Matching, Phonological Cost Matrix, and Target Localization.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Any
from enum import Enum

from app.services.pronunciation.ecsm.crottc_label_mapping import crottc_label_to_ipa

class AlignmentOperation(str, Enum):
    MATCH = "MATCH"
    SUBSTITUTION = "SUBSTITUTION"
    DELETION = "DELETION"
    INSERTION = "INSERTION"
    UNCERTAIN = "UNCERTAIN"

# Equivalence aliases (e.g. r vs ɹ, i vs iː, u vs uː, a vs ɑ)
PHONE_ALIASES: Dict[str, str] = {
    "ɡ": "g",
    "ɹ": "r",
    "iː": "i",
    "uː": "u",
    "aː": "ɑ",
    "a": "ɑ",
    "e": "ɛ",
    "o": "oʊ",
    "ou": "oʊ",
    "ei": "eɪ",
    "ai": "aɪ",
    "au": "aʊ",
    "oi": "ɔɪ",
    "ʧ": "tʃ",
    "ʤ": "dʒ",
    "ə": "ʌ",
    "ɝ": "ɚ",
    "ɜːr": "ɚ",
    "ɒ": "ɔ",
}

def canonicalize_phone_symbol(p: str) -> str:
    """Normalizes IPA phone symbol to standard canonical form for comparison."""
    clean = p.strip().replace("\u0261", "g")
    return PHONE_ALIASES.get(clean, clean)

def are_phones_equivalent(p1: str, p2: str) -> bool:
    """Returns True if two phones represent the exact same phonological category."""
    if p1 == p2:
        return True
    return canonicalize_phone_symbol(p1) == canonicalize_phone_symbol(p2)

# Phonological category distance modifiers
FRICATIVES = {"f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ", "h"}
STOPS = {"p", "b", "t", "d", "k", "g"}
NASALS = {"m", "n", "ŋ"}
LIQUIDS_GLIDES = {"l", "r", "ɹ", "w", "j"}
VOWELS_DIPHTHONGS = {"i", "ɪ", "eɪ", "ɛ", "æ", "ɑ", "ɔ", "oʊ", "ʊ", "u", "ʌ", "ə", "ɚ", "ɝ", "aɪ", "aʊ", "ɔɪ"}

VOICING_PAIRS = {
    ("p", "b"), ("b", "p"),
    ("t", "d"), ("d", "t"),
    ("k", "g"), ("g", "k"),
    ("f", "v"), ("v", "f"),
    ("θ", "ð"), ("ð", "θ"),
    ("s", "z"), ("z", "s"),
    ("ʃ", "ʒ"), ("ʒ", "ʃ"),
    ("tʃ", "dʒ"), ("dʒ", "tʃ"),
}

def phone_substitution_cost(p_canon: str, p_perceived: str) -> float:
    """Computes phonologically informed distance between two phones."""
    c1 = canonicalize_phone_symbol(p_canon)
    c2 = canonicalize_phone_symbol(p_perceived)
    if c1 == c2:
        return 0.0
    
    # Voicing minimal pairs (e.g. s vs z, θ vs ð)
    if (c1, c2) in VOICING_PAIRS:
        return 0.6
    
    # Intraclass fricative confusion (e.g. θ vs s, ð vs d)
    if c1 in FRICATIVES and c2 in FRICATIVES:
        return 0.75
    
    # Dental to stop confusion (e.g. ð vs d, θ vs t)
    if (c1 in {"θ", "ð"} and c2 in {"t", "d"}) or (c2 in {"θ", "ð"} and c1 in {"t", "d"}):
        return 0.75
    
    # Within same manner class
    if (c1 in STOPS and c2 in STOPS) or (c1 in NASALS and c2 in NASALS) or (c1 in LIQUIDS_GLIDES and c2 in LIQUIDS_GLIDES):
        return 0.85
    
    # Vowel to vowel
    if c1 in VOWELS_DIPHTHONGS and c2 in VOWELS_DIPHTHONGS:
        return 0.90
    
    # Cross-manner substitution
    return 1.2

@dataclass
class TargetPhoneItem:
    word_id: str
    word_index: int
    target_word: str
    phone_id: str
    phone_index_within_word: int
    expected_phone: str
    accepted_variant_ids: List[str] = field(default_factory=list)

@dataclass
class AlignedPhoneEvidence:
    word_id: str
    word_index: int
    target_word: str
    phone_id: str
    phone_index_within_word: int
    expected_phone: str
    operation: AlignmentOperation
    perceived_phone: Optional[str] = None
    cost: float = 0.0
    is_insertion: bool = False
    safe_to_surface: bool = True
    evidence_source: str = "CROTTC_IF_L2_ARCTIC"

@dataclass
class SequenceAlignmentResult:
    canonical_phones: List[str]
    perceived_phones: List[str]
    total_cost: float
    match_count: int
    substitution_count: int
    deletion_count: int
    insertion_count: int
    aligned_evidence: List[AlignedPhoneEvidence]
    selected_variant_id: Optional[str] = None

class PhoneSequenceAligner:
    """Performs dynamic programming Needleman-Wunsch / Levenshtein sequence alignment on phonemes."""
    
    def __init__(self, insertion_cost: float = 1.0, deletion_cost: float = 1.0):
        self.insertion_cost = insertion_cost
        self.deletion_cost = deletion_cost

    def align_single_sequence(
        self,
        canonical_target: List[TargetPhoneItem],
        perceived_phones: List[str],
        variant_id: Optional[str] = None,
    ) -> SequenceAlignmentResult:
        m = len(canonical_target)
        n = len(perceived_phones)

        # DP tables: dp[i][j] is min cost aligning canonical[:i] with perceived[:j]
        dp = [[0.0] * (n + 1) for _ in range(m + 1)]
        # Track backtracking ops: 'M' (match/sub), 'D' (deletion), 'I' (insertion)
        backtrack = [[None] * (n + 1) for _ in range(m + 1)]

        for i in range(1, m + 1):
            dp[i][0] = i * self.deletion_cost
            backtrack[i][0] = 'D'

        for j in range(1, n + 1):
            dp[0][j] = j * self.insertion_cost
            backtrack[0][j] = 'I'

        for i in range(1, m + 1):
            c_phone = canonical_target[i - 1].expected_phone
            for j in range(1, n + 1):
                p_phone = perceived_phones[j - 1]
                sub_cost = phone_substitution_cost(c_phone, p_phone)
                
                cost_match = dp[i - 1][j - 1] + sub_cost
                cost_del = dp[i - 1][j] + self.deletion_cost
                cost_ins = dp[i][j - 1] + self.insertion_cost

                best_cost = cost_match
                best_op = 'M'

                if cost_del < best_cost:
                    best_cost = cost_del
                    best_op = 'D'
                if cost_ins < best_cost:
                    best_cost = cost_ins
                    best_op = 'I'

                dp[i][j] = best_cost
                backtrack[i][j] = best_op

        # Backtrack to build aligned evidence
        i, j = m, n
        aligned_items = []
        match_cnt = 0
        sub_cnt = 0
        del_cnt = 0
        ins_cnt = 0

        while i > 0 or j > 0:
            op = backtrack[i][j]
            if op == 'M':
                c_item = canonical_target[i - 1]
                p_phone = perceived_phones[j - 1]
                is_match = are_phones_equivalent(c_item.expected_phone, p_phone)
                cost = 0.0 if is_match else phone_substitution_cost(c_item.expected_phone, p_phone)
                
                if is_match:
                    match_cnt += 1
                    alignment_op = AlignmentOperation.MATCH
                else:
                    sub_cnt += 1
                    alignment_op = AlignmentOperation.SUBSTITUTION
                
                aligned_items.append(AlignedPhoneEvidence(
                    word_id=c_item.word_id,
                    word_index=c_item.word_index,
                    target_word=c_item.target_word,
                    phone_id=c_item.phone_id,
                    phone_index_within_word=c_item.phone_index_within_word,
                    expected_phone=c_item.expected_phone,
                    operation=alignment_op,
                    perceived_phone=p_phone,
                    cost=cost,
                    is_insertion=False,
                ))
                i -= 1
                j -= 1
            elif op == 'D':
                c_item = canonical_target[i - 1]
                del_cnt += 1
                aligned_items.append(AlignedPhoneEvidence(
                    word_id=c_item.word_id,
                    word_index=c_item.word_index,
                    target_word=c_item.target_word,
                    phone_id=c_item.phone_id,
                    phone_index_within_word=c_item.phone_index_within_word,
                    expected_phone=c_item.expected_phone,
                    operation=AlignmentOperation.DELETION,
                    perceived_phone=None,
                    cost=self.deletion_cost,
                    is_insertion=False,
                ))
                i -= 1
            elif op == 'I':
                p_phone = perceived_phones[j - 1]
                ins_cnt += 1
                # Anchor insertion to adjacent target word if available
                ref_item = canonical_target[min(i, m - 1)] if m > 0 else TargetPhoneItem("W_0", 0, "", "PH_0", 0, "")
                aligned_items.append(AlignedPhoneEvidence(
                    word_id=ref_item.word_id,
                    word_index=ref_item.word_index,
                    target_word=ref_item.target_word,
                    phone_id=f"INS_{ref_item.phone_id}_{j}",
                    phone_index_within_word=ref_item.phone_index_within_word,
                    expected_phone="",
                    operation=AlignmentOperation.INSERTION,
                    perceived_phone=p_phone,
                    cost=self.insertion_cost,
                    is_insertion=True,
                ))
                j -= 1

        aligned_items.reverse()
        total_cost = dp[m][n]

        return SequenceAlignmentResult(
            canonical_phones=[c.expected_phone for c in canonical_target],
            perceived_phones=perceived_phones,
            total_cost=total_cost,
            match_count=match_cnt,
            substitution_count=sub_cnt,
            deletion_count=del_cnt,
            insertion_count=ins_cnt,
            aligned_evidence=aligned_items,
            selected_variant_id=variant_id,
        )

    def align_multi_variant(
        self,
        candidate_variants: List[Tuple[str, List[TargetPhoneItem]]],
        perceived_phones: List[str],
    ) -> SequenceAlignmentResult:
        """Evaluates alignment across all candidate canonical variants and selects the best one."""
        if not candidate_variants:
            return self.align_single_sequence([], perceived_phones)
        
        best_result = None
        for variant_id, canonical_items in candidate_variants:
            result = self.align_single_sequence(canonical_items, perceived_phones, variant_id=variant_id)
            if best_result is None or result.total_cost < best_result.total_cost:
                best_result = result
                
        return best_result or self.align_single_sequence(candidate_variants[0][1], perceived_phones)
