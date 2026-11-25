"""Difficulty Feature Extraction and Calibration Harness.

Extracts objective linguistic features from the passage:
- Word and sentence counts
- Average sentence length
- Lexical diversity (Type-Token Ratio)
- Subordinate clause markers
- Passive voice indicators
- Information density (char/word ratio)
- Workload burden ratio (VI / EN words)

Enforces strict abstention on IELTS band labeling:
Until a teacher/learner gold calibrated dataset is available,
final_ielts_band is labeled UNCALIBRATED (no fabricated bands).
"""

import re
from typing import Dict, Any, List, Tuple
from .contracts import DifficultyFeatures, PassageCandidate


# Subordinating conjunctions in English
SUBORDINATE_CONJUNCTIONS = [
    r'\bbecause\b', r'\balthough\b', r'\beven though\b', r'\bwhile\b',
    r'\bwhereas\b', r'\bsince\b', r'\bif\b', r'\bunless\b', r'\buntil\b',
    r'\bwhether\b', r'\bwhich\b', r'\bwhose\b', r'\bwhere\b', r'\bthat\b'
]

# Passive voice proxy: form of "to be" + past participle ending (-ed, -en, -t)
PASSIVE_PATTERNS = [
    r'\b(?:is|are|was|were|been|being|be)\s+[a-z]+(?:ed|en|wn|lt|pt|ht)\b'
]


class DifficultyExtractor:
    """Extracts linguistic and workload features from candidate passages."""

    @staticmethod
    def extract_features(candidate: PassageCandidate) -> DifficultyFeatures:
        en = candidate.en_text.strip()
        vi = candidate.vi_text.strip()

        words_en = re.findall(r'\b[a-zA-Z0-9_-]+\b', en.lower())
        words_vi = vi.split()

        en_word_count = len(words_en)
        vi_word_count = len(words_vi)

        # Sentence counting
        sents_en = [s for s in re.split(r'[.!?]\s+', en) if s.strip()]
        sents_vi = [s for s in re.split(r'[.!?]\s+', vi) if s.strip()]

        en_sent_count = max(1, len(sents_en))
        vi_sent_count = max(1, len(sents_vi))

        avg_sent_len = en_word_count / en_sent_count if en_sent_count > 0 else 0.0

        # Lexical diversity: Type-Token Ratio (TTR)
        unique_words_en = set(words_en)
        ttr = len(unique_words_en) / en_word_count if en_word_count > 0 else 0.0

        # Subordinate connectors count
        sub_count = 0
        for pattern in SUBORDINATE_CONJUNCTIONS:
            sub_count += len(re.findall(pattern, en.lower()))

        # Passive voice markers
        passive_count = 0
        for pattern in PASSIVE_PATTERNS:
            passive_count += len(re.findall(pattern, en.lower()))

        # Information density proxy (characters per word)
        chars_en = sum(len(w) for w in words_en)
        info_density = chars_en / en_word_count if en_word_count > 0 else 0.0

        # Workload burden (Vietnamese word count relative to English word count)
        workload_ratio = vi_word_count / en_word_count if en_word_count > 0 else 1.0

        return DifficultyFeatures(
            en_word_count=en_word_count,
            vi_word_count=vi_word_count,
            en_sentence_count=en_sent_count,
            vi_sentence_count=vi_sent_count,
            avg_sentence_length_words=round(avg_sent_len, 2),
            lexical_diversity_ttr=round(ttr, 3),
            subordination_connector_count=sub_count,
            passive_voice_markers=passive_count,
            information_density_ratio=round(info_density, 2),
            workload_burden_ratio=round(workload_ratio, 2),
            ielts_band_calibrated=False,
            calibrated_band_label="UNCALIBRATED",
            notes="Requires empirical calibration with teacher-reviewed gold dataset"
        )


class DifficultyCalibrationHarness:
    """Interface for empirical difficulty calibration and training."""

    def __init__(self, model_version: str = "v1.0-uncalibrated"):
        self.model_version = model_version
        self.is_calibrated = False

    def predict_band(self, features: DifficultyFeatures) -> Tuple[str, bool]:
        """Returns (band_label, is_calibrated).
        
        Strictly abstains from returning a fake IELTS rating without gold calibration.
        """
        if not self.is_calibrated:
            return "UNCALIBRATED", False
        # When calibration weights are loaded, predict here
        return "UNCALIBRATED", False
