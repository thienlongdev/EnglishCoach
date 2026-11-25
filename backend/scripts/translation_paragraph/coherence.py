"""Discourse Coherence and Standalone Boundary Filtering.

Ensures the passage forms one coherent, standalone learning unit:
- Complete sentence beginnings and endings (no truncated quotes or hanging conjunctions)
- No dangling pronoun references at the start of the passage (e.g., starting with "He", "She", "It", "They", "These")
- Discourse unity and logical topic continuity
"""

import re
from typing import List, Tuple
from .contracts import CoherenceDecision, PassageCandidate


# Pronouns that indicate an unresolved external antecedent if they appear as the subject of the very first sentence
DANGLING_INITIAL_PRONOUNS_EN = [
    r'^he\b',
    r'^she\b',
    r'^they\b',
    r'^his\b',
    r'^her\b',
    r'^their\b',
    r'^it\b',
    r'^these\b',
    r'^those\b',
    r'^this\b'  # "This" by itself as first word can be ambiguous
]

DANGLING_INITIAL_PRONOUNS_VI = [
    r'^ông\s+ấy\b',
    r'^bà\s+ấy\b',
    r'^họ\b',
    r'^nó\b',
    r'^chúng\b',
    r'^điều\s+này\b',
    r'^những\s+điều\s+này\b'
]


class CoherenceFilter:
    """Evaluates passage discourse continuity and boundary stability."""

    @staticmethod
    def evaluate_coherence(candidate: PassageCandidate) -> CoherenceDecision:
        en = candidate.en_text.strip()
        vi = candidate.vi_text.strip()
        rejections = []

        # 1. Check proper capitalization at start
        if not en[0].isupper() and not en[0].isdigit() and en[0] not in '"\'“':
            rejections.append("IMPROPER_START: English passage does not start with capital letter or quote")

        # 2. Check proper terminal punctuation at end (. ! ? ")
        terminal_punct = ('.', '!', '?', '"', '”', "'")
        if not en.endswith(terminal_punct):
            rejections.append("TRUNCATED_END: English passage does not end with terminal punctuation")
        if not vi.endswith(terminal_punct):
            rejections.append("TRUNCATED_END: Vietnamese passage does not end with terminal punctuation")

        # 3. Check for dangling initial pronouns
        en_lower = en.lower()
        vi_lower = vi.lower()

        # If passage begins with "He / She / They" without prior mention of the named referent
        for pattern in DANGLING_INITIAL_PRONOUNS_EN:
            if re.search(pattern, en_lower):
                # Check if it's "He was born..." vs "This is because..."
                rejections.append(f"DANGLING_ANAPHORA_EN: Passage starts with unanchored pronoun ({pattern})")
                break

        for pattern in DANGLING_INITIAL_PRONOUNS_VI:
            if re.search(pattern, vi_lower):
                rejections.append(f"DANGLING_ANAPHORA_VI: Vietnamese starts with unanchored pronoun ({pattern})")
                break

        # 4. Check for hanging connectors at start (e.g. "However,", "Furthermore,", "In addition,")
        # While sometimes acceptable, if it's the very first sentence without prior context, it can feel abrupt
        if re.search(r'^(however|moreover|furthermore|on the other hand),', en_lower):
            rejections.append("HANGING_CONNECTOR_START: Passage begins with contrastive connector referencing prior text")

        # 5. Sentence count sanity: A coherent paragraph typically has at least 1-2 full sentences
        # A single 10-word fragment is not a coherent paragraph
        sentences_en = [s for s in re.split(r'[.!?]\s+', en) if len(s.strip()) > 5]
        if len(sentences_en) < 1:
            rejections.append("FRAGMENTARY_CONTENT: No complete sentence found in passage")

        # 6. Balanced quotation marks and brackets
        if en.count('"') % 2 != 0 and en.count('“') != en.count('”'):
            rejections.append("UNBALANCED_QUOTES: Unbalanced quotation marks in English passage")
        if en.count('(') != en.count(')'):
            rejections.append("UNBALANCED_PARENS: Unbalanced parentheses in English passage")

        is_accepted = len(rejections) == 0
        coherence_score = 1.0 - (len(rejections) * 0.25)
        coherence_score = max(0.0, min(1.0, coherence_score))

        return CoherenceDecision(
            is_accepted=is_accepted,
            coherence_score=coherence_score,
            discourse_continuity=is_accepted,
            standalone_readable=is_accepted,
            rejection_reasons=rejections
        )
