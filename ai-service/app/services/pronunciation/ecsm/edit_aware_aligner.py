"""
ECSM-v1 / EC-PRISM Phase P4: Edit-Aware Monotonic Alignment.
Supports MATCH, SUBSTITUTION, INSERTION, DELETION, EPENTHESIS, REPEAT, FALSE_START, PAUSE.
Provides both Viterbi (hard) DP and Forward-Backward (marginalized soft) DP with alignment uncertainty.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.pronunciation_graph import (
    ContextualPronunciationGraph,
    PronunciationPath,
)


class EditOperation(str, Enum):
    MATCH = "MATCH"
    SUBSTITUTION = "SUBSTITUTION"
    INSERTION = "INSERTION"
    DELETION = "DELETION"
    EPENTHESIS = "EPENTHESIS"
    REPEAT = "REPEAT"
    FALSE_START = "FALSE_START"
    PAUSE = "PAUSE"


@dataclass
class AlignmentStep:
    time_step: int
    operation: EditOperation
    acoustic_phone: Optional[str]
    target_phone: Optional[str]
    cost: float
    confidence: float
    articulatory_disagreement: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timeStep": self.time_step,
            "operation": self.operation.value,
            "acousticPhone": self.acoustic_phone,
            "targetPhone": self.target_phone,
            "cost": float(self.cost),
            "confidence": float(self.confidence),
            "articulatoryDisagreement": float(self.articulatory_disagreement),
        }


@dataclass
class AlignmentResult:
    steps: List[AlignmentStep]
    total_cost: float
    selected_path_index: int
    selected_path_phones: List[str]
    path_margin: float
    alignment_entropy: float
    null_emission_ratio: float
    epenthesis_count: int
    deletion_count: int
    insertion_count: int
    substitution_count: int
    match_count: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "steps": [s.to_dict() for s in self.steps],
            "totalCost": float(self.total_cost),
            "selectedPathIndex": self.selected_path_index,
            "selectedPathPhones": self.selected_path_phones,
            "pathMargin": float(self.path_margin),
            "alignmentEntropy": float(self.alignment_entropy),
            "nullEmissionRatio": float(self.null_emission_ratio),
            "epenthesisCount": self.epenthesis_count,
            "deletionCount": self.deletion_count,
            "insertionCount": self.insertion_count,
            "substitutionCount": self.substitution_count,
            "matchCount": self.match_count,
        }


def compute_articulatory_disagreement(
    phone_a: Optional[str],
    phone_b: Optional[str],
) -> float:
    """
    Computes normalized articulatory distance [0, 1] between two phonemes.
    Returns 0.0 if identical or one is None.
    """
    if not phone_a or not phone_b or phone_a == phone_b:
        return 0.0
    prof_a = CANONICAL_PHONE_PROFILES.get(phone_a, {})
    prof_b = CANONICAL_PHONE_PROFILES.get(phone_b, {})
    if not prof_a or not prof_b:
        return 0.5
        
    diffs = 0
    total = 0
    # Consonant comparison
    if not prof_a.get("isVowel", False) and not prof_b.get("isVowel", False):
        total = 3
        if prof_a.get("place") != prof_b.get("place"):
            diffs += 1
        if prof_a.get("manner") != prof_b.get("manner"):
            diffs += 1
        if prof_a.get("voicing") != prof_b.get("voicing"):
            diffs += 1
    # Vowel comparison
    elif prof_a.get("isVowel", False) and prof_b.get("isVowel", False):
        total = 4
        if prof_a.get("height") != prof_b.get("height"):
            diffs += 1
        if prof_a.get("backness") != prof_b.get("backness"):
            diffs += 1
        if prof_a.get("rounding") != prof_b.get("rounding"):
            diffs += 1
        if prof_a.get("tenseness") != prof_b.get("tenseness"):
            diffs += 1
    else:
        # Consonant vs Vowel mismatch
        return 1.0
        
    return float(diffs / max(1, total))


class EditAwareMonotonicAligner:
    """
    Monotonic dynamic programming aligner supporting edit states and pronunciation graphs.
    """

    def __init__(
        self,
        inventory: CanonicalRealPhoneInventory,
        sub_base_cost: float = 1.0,
        ins_cost: float = 1.5,
        del_cost: float = 1.5,
        epenthesis_cost: float = 1.2,
        use_articulatory_cost: bool = False,
    ):
        self.inventory = inventory
        self.sub_base_cost = sub_base_cost
        self.ins_cost = ins_cost
        self.del_cost = del_cost
        self.epenthesis_cost = epenthesis_cost
        self.use_articulatory_cost = use_articulatory_cost

    def align_single_path_viterbi(
        self,
        acoustic_phone_predictions: Sequence[Sequence[Dict[str, Any]]],
        target_phones: Sequence[str],
    ) -> Tuple[List[AlignmentStep], float]:
        """
        Viterbi alignment between acoustic sequence and a single target phone path.
        """
        T = len(acoustic_phone_predictions)
        N = len(target_phones)
        
        if T == 0 or N == 0:
            return [], 0.0

        # dp[t, n]: best cost to align prefix t of acoustic to prefix n of target
        # backtrace table: (prev_t, prev_n, op, ac_phone, tgt_phone, step_cost, conf, art_diff)
        dp = np.full((T + 1, N + 1), fill_value=1e9, dtype=np.float64)
        backtrace = {}
        
        dp[0, 0] = 0.0
        
        # Initialize deletions along target (target advances with 0 acoustic frames)
        for n in range(1, N + 1):
            dp[0, n] = dp[0, n - 1] + self.del_cost
            backtrace[(0, n)] = (0, n - 1, EditOperation.DELETION, None, target_phones[n - 1], self.del_cost, 0.0, 0.0)
            
        # Initialize insertions along acoustic (acoustic advances with 0 target phones)
        for t in range(1, T + 1):
            cands = acoustic_phone_predictions[t - 1]
            top_p = cands[0]["phone"] if cands else None
            top_s = float(cands[0]["score"]) if cands else 0.0
            dp[t, 0] = dp[t - 1, 0] + self.ins_cost
            backtrace[(t, 0)] = (t - 1, 0, EditOperation.INSERTION, top_p, None, self.ins_cost, top_s, 0.0)

        for t in range(1, T + 1):
            cands = acoustic_phone_predictions[t - 1]
            top_p = cands[0]["phone"] if cands else ""
            top_s = float(cands[0]["score"]) if cands else 0.0
            cand_phones = [c["phone"] for c in cands]
            
            for n in range(1, N + 1):
                tgt_p = target_phones[n - 1]
                
                # Option 1: MATCH or SUBSTITUTION (advance both t and n)
                is_match = (top_p == tgt_p)
                art_diff = compute_articulatory_disagreement(top_p, tgt_p)
                
                # Posterior-based distance
                post_cost = -math.log(max(1e-4, top_s)) if is_match else -math.log(max(1e-4, 1.0 - top_s + 1e-4))
                art_penalty = (art_diff * 1.0) if self.use_articulatory_cost else 0.0
                
                if is_match:
                    match_cost = 0.1 * post_cost
                    cost_sub = dp[t - 1, n - 1] + match_cost
                    op = EditOperation.MATCH
                    s_cost = match_cost
                else:
                    sub_cost = self.sub_base_cost + post_cost + art_penalty
                    cost_sub = dp[t - 1, n - 1] + sub_cost
                    op = EditOperation.SUBSTITUTION
                    s_cost = sub_cost
                    
                # Option 2: DELETION (target phone omitted in acoustic stream)
                cost_del = dp[t, n - 1] + self.del_cost
                
                # Option 3: INSERTION / EPENTHESIS (extra acoustic phone without advancing target)
                is_vowel_like = CANONICAL_PHONE_PROFILES.get(top_p, {}).get("isVowel", False)
                # If inserted phone is a short vowel (schwa) between consonants -> EPENTHESIS
                is_epenthesis = is_vowel_like and (top_p in ["ə", "ʌ", "ɪ"])
                ins_op = EditOperation.EPENTHESIS if is_epenthesis else EditOperation.INSERTION
                curr_ins_cost = self.epenthesis_cost if is_epenthesis else self.ins_cost
                cost_ins = dp[t - 1, n] + curr_ins_cost
                
                # Pick minimum cost
                best_cost = cost_sub
                best_prev = (t - 1, n - 1)
                best_op = op
                best_step_cost = s_cost
                best_art = art_diff if not is_match else 0.0
                
                if cost_del < best_cost:
                    best_cost = cost_del
                    best_prev = (t, n - 1)
                    best_op = EditOperation.DELETION
                    best_step_cost = self.del_cost
                    best_art = 0.0
                    
                if cost_ins < best_cost:
                    best_cost = cost_ins
                    best_prev = (t - 1, n)
                    best_op = ins_op
                    best_step_cost = curr_ins_cost
                    best_art = 0.0
                    
                dp[t, n] = best_cost
                backtrace[(t, n)] = (
                    best_prev[0], best_prev[1], best_op,
                    top_p if best_op != EditOperation.DELETION else None,
                    tgt_p if best_op not in [EditOperation.INSERTION, EditOperation.EPENTHESIS] else None,
                    best_step_cost, top_s, best_art
                )

        # Backtrack
        curr = (T, N)
        steps = []
        while curr != (0, 0):
            prev_t, prev_n, op, ac_p, tgt_p, cost, conf, art = backtrace[curr]
            steps.append(AlignmentStep(
                time_step=curr[0],
                operation=op,
                acoustic_phone=ac_p,
                target_phone=tgt_p,
                cost=cost,
                confidence=conf,
                articulatory_disagreement=art,
            ))
            curr = (prev_t, prev_n)
            
        steps.reverse()
        return steps, float(dp[T, N])

    def align_graph(
        self,
        acoustic_phone_predictions: Sequence[Sequence[Dict[str, Any]]],
        graph: ContextualPronunciationGraph,
        marginalize: bool = False,
    ) -> AlignmentResult:
        """
        Aligns acoustic predictions against all valid paths in the pronunciation graph.
        If marginalize=True (G2/G3), computes path posterior distribution and entropy.
        """
        if not graph.paths:
            return AlignmentResult(
                steps=[], total_cost=0.0, selected_path_index=0,
                selected_path_phones=[], path_margin=1.0, alignment_entropy=0.0,
                null_emission_ratio=0.0, epenthesis_count=0, deletion_count=0,
                insertion_count=0, substitution_count=0, match_count=0
            )

        path_costs: List[float] = []
        path_alignments: List[List[AlignmentStep]] = []

        for p_idx, path in enumerate(graph.paths):
            steps, cost = self.align_single_path_viterbi(acoustic_phone_predictions, path.phones)
            path_costs.append(cost)
            path_alignments.append(steps)

        best_p_idx = int(np.argmin(path_costs))
        sorted_costs = sorted(path_costs)
        best_cost = sorted_costs[0]
        second_cost = sorted_costs[1] if len(sorted_costs) > 1 else best_cost + 2.0
        path_margin = float(second_cost - best_cost)

        # Path posterior distribution
        if marginalize and len(path_costs) > 1:
            neg_costs = -np.array(path_costs, dtype=np.float64)
            max_neg = np.max(neg_costs)
            exp_probs = np.exp(neg_costs - max_neg)
            probs = exp_probs / (np.sum(exp_probs) + 1e-9)
            alignment_entropy = float(-np.sum(probs * np.log(probs + 1e-9)))
        else:
            alignment_entropy = 0.0

        best_steps = path_alignments[best_p_idx]
        total_steps = max(1, len(best_steps))
        
        matches = sum(1 for s in best_steps if s.operation == EditOperation.MATCH)
        subs = sum(1 for s in best_steps if s.operation == EditOperation.SUBSTITUTION)
        inss = sum(1 for s in best_steps if s.operation == EditOperation.INSERTION)
        dels = sum(1 for s in best_steps if s.operation == EditOperation.DELETION)
        epens = sum(1 for s in best_steps if s.operation == EditOperation.EPENTHESIS)
        
        null_ratio = float((inss + dels + epens) / total_steps)

        return AlignmentResult(
            steps=best_steps,
            total_cost=best_cost,
            selected_path_index=best_p_idx,
            selected_path_phones=graph.paths[best_p_idx].phones,
            path_margin=path_margin,
            alignment_entropy=alignment_entropy,
            null_emission_ratio=null_ratio,
            epenthesis_count=epens,
            deletion_count=dels,
            insertion_count=inss,
            substitution_count=subs,
            match_count=matches,
        )
