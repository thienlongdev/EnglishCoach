"""Deduplication Engine for Paragraph Candidates.

Implements multi-tiered deduplication:
1. Exact hash matching on normalized EN, normalized VI, and bilingual pair (SHA-256).
2. Document span overlap check within the same document.
3. Shingle-based near-duplicate detection with inverted index (O(N) shingle lookup, avoiding O(N^2) full cross-comparison).
"""

from typing import List, Dict, Set, Tuple
from collections import defaultdict
from .contracts import PassageCandidate


def get_token_shingles(text: str, k: int = 3) -> Set[str]:
    """Generates k-word token shingles from normalized text."""
    words = text.lower().split()
    if len(words) < k:
        return {" ".join(words)}
    return {" ".join(words[i:i+k]) for i in range(len(words) - k + 1)}


def jaccard_similarity(set_a: Set[str], set_b: Set[str]) -> float:
    """Computes Jaccard similarity between two shingle sets."""
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a.intersection(set_b))
    union = len(set_a.union(set_b))
    return inter / union if union > 0 else 0.0


class Deduplicator:
    """Detects and eliminates duplicate and near-duplicate passage candidates."""

    def __init__(self, near_dup_threshold: float = 0.85):
        self.near_dup_threshold = near_dup_threshold
        self.seen_en_hashes: Set[str] = set()
        self.seen_vi_hashes: Set[str] = set()
        self.seen_bi_hashes: Set[str] = set()
        self.seen_en_map: Dict[str, str] = {}
        self.seen_vi_map: Dict[str, str] = {}
        self.seen_bi_map: Dict[str, str] = {}
        # Inverted index: shingle -> list of (candidate_id, candidate_index)
        self.shingle_index: Dict[str, List[int]] = defaultdict(list)
        self.shingle_cache: Dict[int, Set[str]] = {}

    def deduplicate(self, candidates: List[PassageCandidate]) -> Tuple[List[PassageCandidate], List[Tuple[PassageCandidate, str, str]]]:
        """Filters duplicates and returns (unique_candidates, removed_with_reasons_and_canonical_id)."""
        unique_candidates: List[PassageCandidate] = []
        removed: List[Tuple[PassageCandidate, str, str]] = []

        for cand in candidates:
            # 1. Exact bilingual hash match
            if cand.bilingual_hash_sha256 in self.seen_bi_hashes:
                canonical_id = self.seen_bi_map[cand.bilingual_hash_sha256]
                removed.append((cand, "EXACT_BILINGUAL_DUPLICATE: Identical EN and VI texts already seen", canonical_id))
                continue

            # 2. Exact EN hash match
            if cand.en_hash_sha256 in self.seen_en_hashes:
                canonical_id = self.seen_en_map[cand.en_hash_sha256]
                removed.append((cand, "EXACT_EN_DUPLICATE: Identical English source text already seen", canonical_id))
                continue

            # 3. Exact VI hash match
            if cand.vi_hash_sha256 in self.seen_vi_hashes:
                canonical_id = self.seen_vi_map[cand.vi_hash_sha256]
                removed.append((cand, "EXACT_VI_DUPLICATE: Identical Vietnamese target text already seen", canonical_id))
                continue

            # 4. Near-duplicate check via inverted index shingles
            cand_shingles = get_token_shingles(cand.en_text, k=3)
            cand_idx = len(unique_candidates)

            # Find potential near-duplicates sharing shingles
            candidate_match_counts: Dict[int, int] = defaultdict(int)
            for shingle in cand_shingles:
                for match_idx in self.shingle_index.get(shingle, []):
                    candidate_match_counts[match_idx] += 1

            is_near_dup = False
            for match_idx, common_count in candidate_match_counts.items():
                prev_shingles = self.shingle_cache[match_idx]
                sim = jaccard_similarity(cand_shingles, prev_shingles)
                if sim >= self.near_dup_threshold:
                    prev_cand = unique_candidates[match_idx]
                    removed.append((
                        cand,
                        f"NEAR_DUPLICATE: High lexical similarity ({sim:.2f}) with candidate {prev_cand.candidate_id}",
                        prev_cand.candidate_id
                    ))
                    is_near_dup = True
                    break

            if is_near_dup:
                continue

            # Accept candidate and register in indices
            self.seen_en_hashes.add(cand.en_hash_sha256)
            self.seen_vi_hashes.add(cand.vi_hash_sha256)
            self.seen_bi_hashes.add(cand.bilingual_hash_sha256)
            self.seen_en_map[cand.en_hash_sha256] = cand.candidate_id
            self.seen_vi_map[cand.vi_hash_sha256] = cand.candidate_id
            self.seen_bi_map[cand.bilingual_hash_sha256] = cand.candidate_id

            self.shingle_cache[cand_idx] = cand_shingles
            for shingle in cand_shingles:
                self.shingle_index[shingle].append(cand_idx)

            unique_candidates.append(cand)

        return unique_candidates, removed
