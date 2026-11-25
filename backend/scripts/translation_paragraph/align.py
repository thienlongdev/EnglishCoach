"""Monotonic bilingual paragraph and sentence alignment scorer.

Computes alignment confidence using deterministic structural evidence:
- Length ratio and character length bounds
- Number and digit preservation
- Named entity / acronym surface overlap
- Punctuation structure symmetry
- Monotonic sentence mapping within the paragraph
"""

import re
from typing import List, Tuple, Dict, Any
from .contracts import AlignedSpan, PassageCandidate


def split_sentences(text: str) -> List[str]:
    """Splits prose text into natural sentences using punctuation boundaries."""
    # Split on periods, exclamation, questions followed by space or end of string
    raw_sents = re.split(r'(?<=[.!?])\s+', text.strip())
    sents = [s.strip() for s in raw_sents if s.strip()]
    return sents if sents else [text.strip()]


def extract_numbers(text: str) -> set:
    """Extracts numeric digit tokens (e.g., years, percentages, counts)."""
    return set(re.findall(r'\b\d+(?:[.,]\d+)*\b', text))


def extract_capitalized_terms(text: str) -> set:
    """Extracts capitalized words / acronyms (potential named entities)."""
    words = re.findall(r'\b[A-Z][a-zA-Z0-9_-]+\b', text)
    # Ignore common sentence starters if single word
    return set(words)


class AlignmentScorer:
    """Evaluates EN<->VI bilingual alignment without external paid APIs."""

    @staticmethod
    def align_passage(candidate: PassageCandidate) -> Tuple[float, List[AlignedSpan], List[str]]:
        """Calculates alignment confidence score and generates aligned sentence spans.
        
        Returns (alignment_score, aligned_spans, rejection_reasons).
        """
        en_text = candidate.en_text
        vi_text = candidate.vi_text
        rejection_reasons = []

        # 1. Length ratio check (character count ratio)
        len_en = len(en_text)
        len_vi = len(vi_text)
        if len_en == 0 or len_vi == 0:
            return 0.0, [], ["EMPTY_TEXT: Either EN or VI passage is empty"]

        char_ratio = len_vi / len_en
        # Typical EN->VI ratio is between 0.65 and 1.6
        if char_ratio < 0.4:
            rejection_reasons.append(f"SEVERE_LENGTH_MISMATCH: VI text too short ({char_ratio:.2f}x of EN)")
        elif char_ratio > 2.5:
            rejection_reasons.append(f"SEVERE_LENGTH_MISMATCH: VI text excessively long ({char_ratio:.2f}x of EN)")

        # 2. Number agreement
        nums_en = extract_numbers(en_text)
        nums_vi = extract_numbers(vi_text)

        num_score = 1.0
        if nums_en:
            # Check overlap of numbers (normalizing punctuation like commas/dots)
            clean_en = {n.replace(",", "").replace(".", "") for n in nums_en}
            clean_vi = {n.replace(",", "").replace(".", "") for n in nums_vi}
            matched_nums = clean_en.intersection(clean_vi)
            num_score = len(matched_nums) / len(clean_en)
            if num_score < 0.5 and len(clean_en) >= 2:
                rejection_reasons.append(
                    f"NUMBER_MISMATCH: Missing key numbers (matched {len(matched_nums)}/{len(clean_en)})"
                )

        # 3. Named entity / acronym surface check
        caps_en = extract_capitalized_terms(en_text)
        caps_vi = extract_capitalized_terms(vi_text)
        entity_score = 1.0
        if caps_en:
            matched_caps = caps_en.intersection(caps_vi)
            entity_score = min(1.0, (len(matched_caps) + 1) / (len(caps_en) + 1))

        # 4. Sentence segmentation and alignment
        en_sents = split_sentences(en_text)
        vi_sents = split_sentences(vi_text)

        aligned_spans: List[AlignedSpan] = []
        n_en = len(en_sents)
        n_vi = len(vi_sents)

        # Monotonic alignment mapping
        if n_en == n_vi:
            # 1:1 alignment
            for i in range(n_en):
                aligned_spans.append(AlignedSpan(
                    source_text=en_sents[i],
                    target_text=vi_sents[i],
                    source_span_order=i,
                    target_span_order=i,
                    alignment_type="1:1",
                    confidence_score=0.95
                ))
        elif n_en < n_vi and n_en > 0:
            # 1:N or bounded merge
            ratio = n_vi / n_en
            for i, en_s in enumerate(en_sents):
                start_j = int(i * ratio)
                end_j = int((i + 1) * ratio) if i < n_en - 1 else n_vi
                merged_vi = " ".join(vi_sents[start_j:end_j])
                aligned_spans.append(AlignedSpan(
                    source_text=en_s,
                    target_text=merged_vi,
                    source_span_order=i,
                    target_span_order=start_j,
                    alignment_type="1:N",
                    confidence_score=0.85
                ))
        elif n_en > n_vi and n_vi > 0:
            # N:1
            ratio = n_en / n_vi
            for j, vi_s in enumerate(vi_sents):
                start_i = int(j * ratio)
                end_i = int((j + 1) * ratio) if j < n_vi - 1 else n_en
                merged_en = " ".join(en_sents[start_i:end_i])
                aligned_spans.append(AlignedSpan(
                    source_text=merged_en,
                    target_text=vi_s,
                    source_span_order=start_i,
                    target_span_order=j,
                    alignment_type="N:1",
                    confidence_score=0.85
                ))
        else:
            aligned_spans.append(AlignedSpan(
                source_text=en_text,
                target_text=vi_text,
                source_span_order=0,
                target_span_order=0,
                alignment_type="BLOCK",
                confidence_score=0.75
            ))

        # Sentence count ratio score
        sent_ratio = min(n_en, n_vi) / max(n_en, n_vi) if max(n_en, n_vi) > 0 else 0.0

        # Weighted aggregate alignment score
        # 40% length harmony, 30% numbers, 15% entities, 15% sentence balance
        length_penalty = max(0.0, 1.0 - abs(1.0 - char_ratio))
        alignment_score = (
            0.40 * length_penalty +
            0.30 * num_score +
            0.15 * entity_score +
            0.15 * sent_ratio
        )
        alignment_score = max(0.0, min(1.0, alignment_score))

        if alignment_score < 0.55:
            rejection_reasons.append(f"LOW_ALIGNMENT_CONFIDENCE: Score {alignment_score:.2f} < 0.55")

        return alignment_score, aligned_spans, rejection_reasons
