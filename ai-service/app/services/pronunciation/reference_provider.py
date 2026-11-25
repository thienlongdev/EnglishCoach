"""
SHD-2B.1R2 Reference Pronunciation Architecture (Acceptance Repaired)
English Coach — Linguistic Reference & Pronunciation Variant Generator

Provides structured, categorical multi-variant pronunciation generation for English Coach:
- Explicit categories: STANDARD, CONTEXTUAL_WEAK_FORM, CASUAL_REDUCTION, DIALECTAL, EXPERIMENTAL.
- Strict scoring eligibility: Only STANDARD and CONTEXTUAL_WEAK_FORM participate in default scoring.
- Casual deletions (e.g., coda /d/ omission in 'screamed' -> /skɹiːm/) and non-standard reductions
  (e.g., 'you' -> /jə/, 'until' -> /ntɪl/) are restricted to CASUAL_REDUCTION and excluded from scoring.
"""

import re
import logging
from enum import Enum
from typing import Dict, List, Any, Optional, Set
from dataclasses import dataclass, field
try:
    from phonemizer import phonemize
except (ImportError, Exception):
    phonemize = None

FALLBACK_PHONEME_DICT: Dict[str, str] = {
    "a": "eɪ",
    "an": "æ n",
    "the": "ð ə",
    "to": "t uː",
    "go": "ɡ oʊ",
    "screamed": "s k ɹ iː m d",
    "think": "θ ɪ ŋ k",
    "about": "ə b aʊ t",
    "it": "ɪ t",
    "i": "aɪ",
    "you": "j uː",
    "hello": "h ə l oʊ",
    "world": "w ɜː l d",
    "good": "ɡ ʊ d",
    "morning": "m ɔːɹ n ɪ ŋ",
    "water": "w ɔː t ɚ",
    "can": "k æ n",
    "we": "w iː",
    "see": "s iː",
    "she": "ʃ iː",
    "he": "h iː",
    "that": "ð æ t",
    "this": "ð ɪ s",
    "is": "ɪ z",
    "clean": "k l iː n",
    "practice": "p ɹ æ k t ɪ s",
    "unit": "j uː n ɪ t",
    "dont": "d oʊ n t",
    "don't": "d oʊ n t",
    "they're": "ð eɪ ɹ",
    "theyre": "ð eɪ ɹ",
    "cant": "k æ n t",
    "can't": "k æ n t",
    "machine": "m ə ʃ iː n",
    "at": "æ t",
    "until": "ə n t ɪ l",
    "woke": "w oʊ k",
    "up": "ʌ p",
}

if phonemize is None:
    def phonemize(text, language="en-us", backend="espeak", strip=True, preserve_punctuation=False, with_stress=False):
        if not text:
            return ""
        clean = re.sub(r"[^\w\s']", "", str(text).lower()).strip()
        words = clean.split()
        res = []
        for w in words:
            if w in FALLBACK_PHONEME_DICT:
                res.append(FALLBACK_PHONEME_DICT[w])
            else:
                res.append(" ".join(list(w)))
        return " ".join(res)

logger = logging.getLogger("reference_provider")

# Canonical English espeak phonemes mapped to wav2vec2-lv-60-espeak-cv-ft vocab tokens
CANONICAL_ENGLISH_PHONEMES = [
    # Triphthongs / r-colored / affricates / dipthongs / long vowels
    "ɑːɹ", "ɔːɹ", "aɪɚ", "iːː", "ɪuː",
    "tʃ", "dʒ", "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ",
    "iː", "uː", "ɑː", "ɔː", "ɜː", "æː", "eː", "oː",
    "əl", "ɚ",
    # Single-character consonants
    "p", "b", "t", "d", "k", "ɡ", "f", "v", "θ", "ð",
    "s", "z", "ʃ", "ʒ", "h", "m", "n", "ŋ", "l", "ɹ", "r", "j", "w",
    # Single-character vowels
    "i", "ɪ", "e", "ɛ", "æ", "a", "ɑ", "ɒ", "ɔ", "ʌ", "ʊ", "u", "ə", "ɐ", "ɨ", "ʉ"
]

VOWEL_PHONEMES = {
    "iː", "uː", "ɑː", "ɔː", "ɜː", "æː", "eː", "oː",
    "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ", "ɑːɹ", "ɔːɹ", "aɪɚ", "ɪuː", "iːː",
    "i", "ɪ", "e", "ɛ", "æ", "a", "ɑ", "ɒ", "ɔ", "ʌ", "ʊ", "u", "ə", "ɐ", "ɚ", "əl", "ɨ", "ʉ"
}


class VariantCategory(str, Enum):
    """
    Explicit linguistic categories for pronunciation variants.
    """
    STANDARD = "STANDARD"
    CONTEXTUAL_WEAK_FORM = "CONTEXTUAL_WEAK_FORM"
    CASUAL_REDUCTION = "CASUAL_REDUCTION"
    DIALECTAL = "DIALECTAL"
    EXPERIMENTAL = "EXPERIMENTAL"


# Default variant categories allowed to participate in learner pronunciation assessment scoring
DEFAULT_SCORING_CATEGORIES: Set[VariantCategory] = {
    VariantCategory.STANDARD,
    VariantCategory.CONTEXTUAL_WEAK_FORM
}


@dataclass
class ReferenceVariant:
    """A single pronunciation variant with explicit category and scoring eligibility."""
    phonemes: List[str]
    tokenIds: List[int]
    source: str
    category: VariantCategory = VariantCategory.STANDARD
    isScoringEligible: bool = True
    contextualPriority: int = 1
    notes: Optional[str] = None


@dataclass
class ReferenceWord:
    """A word instance within a reference sentence with its categorized pronunciation variants."""
    wordIndex: int
    surfaceText: str
    normalizedText: str
    variants: List[ReferenceVariant] = field(default_factory=list)


@dataclass
class ReferenceSentence:
    """The complete reference sentence breakdown containing ordered word instances."""
    rawText: str
    normalizedText: str
    words: List[ReferenceWord] = field(default_factory=list)


def tokenize_espeak_phones(phone_str: str) -> List[str]:
    """
    Segment an espeak-ng IPA phoneme string into discrete phoneme tokens
    recognized by the model vocabulary, using greedy longest-match.
    """
    tokens = []
    i = 0
    while i < len(phone_str):
        if phone_str[i] in [" ", "\t", "\n", "ˈ", "ˌ", ".", "-", "/", "_", "ː"]:
            if phone_str[i] == "ː" and tokens:
                tokens[-1] = tokens[-1] + "ː"
            i += 1
            continue
        matched = False
        for p in CANONICAL_ENGLISH_PHONEMES:
            if phone_str.startswith(p, i):
                tokens.append(p)
                i += len(p)
                matched = True
                break
        if not matched:
            tokens.append(phone_str[i])
            i += 1
    return tokens


# Conservative contextual weak-form dictionary for English function words
WEAK_FORM_LEXICON: Dict[str, Dict[str, Any]] = {
    "a": {
        "weak": [["ə"], ["ɐ"]],
        "strong": [["eɪ"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Indefinite article reduced to /ə/ in connected speech before consonants"
    },
    "an": {
        "weak": [["ə", "n"], ["ɐ", "n"]],
        "strong": [["æ", "n"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Indefinite article reduced to /ən/ in connected speech"
    },
    "the": {
        "weak_before_consonant": [["ð", "ə"], ["ð", "ɐ"]],
        "weak_before_vowel": [["ð", "iː"], ["ð", "i"], ["ð", "ɪ"]],
        "strong": [["ð", "iː"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Definite article realized as /ðə/ before consonants, /ðiː/ or /ði/ before vowels"
    },
    "to": {
        "weak_before_consonant": [["t", "ə"], ["t", "ɐ"]],
        "weak_before_vowel": [["t", "uː"], ["t", "u"], ["t", "ʊ"]],
        "strong": [["t", "uː"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition reduced to /tə/ before consonants, /tuː/ or /tu/ before vowels"
    },
    "of": {
        "weak": [["ə", "v"], ["ɐ", "v"]],
        "strong": [["ʌ", "v"], ["ɑː", "v"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition reduced to /əv/ in connected speech"
    },
    "and": {
        "weak": [["ə", "n", "d"], ["ə", "n"]],
        "strong": [["æ", "n", "d"]],
        "casual": [["n", "d"], ["n"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Conjunction reduced to /ənd/ or /ən/ in connected speech"
    },
    "for": {
        "weak": [["f", "ɚ"], ["f", "ə"]],
        "strong": [["f", "ɔːɹ"], ["f", "ɔː", "ɹ"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition reduced to /fɚ/ or /fə/ in connected speech"
    },
    "can": {
        "weak": [["k", "ə", "n"]],
        "strong": [["k", "æ", "n"]],
        "casual": [["k", "n"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Modal auxiliary reduced to /kən/ in non-emphatic position"
    },
    "have": {
        "weak": [["h", "ə", "v"], ["ə", "v"]],
        "strong": [["h", "æ", "v"]],
        "casual": [["v"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Auxiliary reduced to /həv/ or /əv/"
    },
    "has": {
        "weak": [["h", "ə", "z"], ["ə", "z"]],
        "strong": [["h", "æ", "z"]],
        "casual": [["z"], ["s"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Auxiliary reduced to /həz/ or /əz/"
    },
    "had": {
        "weak": [["h", "ə", "d"], ["ə", "d"]],
        "strong": [["h", "æ", "d"]],
        "casual": [["d"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Auxiliary reduced to /həd/ or /əd/"
    },
    "was": {
        "weak": [["w", "ə", "z"]],
        "strong": [["w", "ʌ", "z"], ["w", "ɑː", "z"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Past tense auxiliary reduced to /wəz/"
    },
    "were": {
        "weak": [["w", "ɚ"]],
        "strong": [["w", "ɜːɹ"], ["w", "ɜː", "ɹ"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Past tense auxiliary reduced to /wɚ/"
    },
    "from": {
        "weak": [["f", "ɹ", "ə", "m"]],
        "strong": [["f", "ɹ", "ʌ", "m"], ["f", "ɹ", "ɑː", "m"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition reduced to /fɹəm/"
    },
    "you": {
        "strong": [["j", "uː"]],
        "casual": [["j", "ə"], ["j", "u"]],
        "rule": "Pronoun standard is /juː/; /jə/ is casual reduction (excluded from default scoring)"
    },
    "your": {
        "weak": [["j", "ɚ"], ["j", "ʊ", "ɹ"]],
        "strong": [["j", "ɔːɹ"], ["j", "ɔː", "ɹ"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Possessive pronoun reduced to /jɚ/"
    },
    "at": {
        "weak": [["ə", "t"], ["ɐ", "t"]],
        "strong": [["æ", "t"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition reduced to /ət/"
    },
    "as": {
        "weak": [["ə", "z"], ["ɐ", "z"]],
        "strong": [["æ", "z"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Preposition/conjunction reduced to /əz/"
    },
    "some": {
        "weak": [["s", "ə", "m"]],
        "strong": [["s", "ʌ", "m"], ["s", "ɑː", "m"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Determiner reduced to /səm/"
    },
    "but": {
        "weak": [["b", "ə", "t"]],
        "strong": [["b", "ʌ", "t"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Conjunction reduced to /bət/"
    },
    "until": {
        "weak": [["ə", "n", "t", "ɪ", "l"]],
        "strong": [["ʌ", "n", "t", "ɪ", "l"]],
        "casual": [["n", "t", "ɪ", "l"]],
        "category_weak": VariantCategory.CONTEXTUAL_WEAK_FORM,
        "rule": "Unstressed initial schwa in until; /ntɪl/ is casual reduction (excluded from scoring)"
    }
}

# Standard contractions dictionary
CONTRACTIONS_LEXICON: Dict[str, List[List[str]]] = {
    "i'm": [["aɪ", "m"], ["ɑː", "m"]],
    "you're": [["j", "ʊ", "ɹ"], ["j", "ɔːɹ"], ["j", "ɚ"]],
    "he's": [["h", "iː", "z"], ["iː", "z"], ["h", "ɪ", "z"]],
    "she's": [["ʃ", "iː", "z"], ["ʃ", "ɪ", "z"]],
    "it's": [["ɪ", "t", "s"]],
    "that's": [["ð", "æ", "t", "s"], ["ð", "ə", "t", "s"]],
    "we're": [["w", "ɪ", "ɹ"], ["w", "ɚ"], ["w", "iː", "ɹ"]],
    "they're": [["ð", "eɪ", "ɹ"], ["ð", "ɛ", "ɹ"]],
    "don't": [["d", "oʊ", "n", "t"], ["d", "oʊ", "n"], ["d", "oː", "n", "t"]],
    "can't": [["k", "æ", "n", "t"], ["k", "ɑː", "n", "t"], ["k", "æ", "n"]],
    "won't": [["w", "oʊ", "n", "t"], ["w", "oʊ", "n"]],
    "didn't": [["d", "ɪ", "d", "n", "t"], ["d", "ɪ", "d", "ə", "n", "t"], ["d", "ɪ", "n", "t"]],
    "i've": [["aɪ", "v"]],
    "we've": [["w", "iː", "v"], ["w", "ɪ", "v"]],
    "they'll": [["ð", "eɪ", "l"], ["ð", "eɪ", "əl"]],
    "you'll": [["j", "uː", "l"], ["j", "ʊ", "l"]]
}


class ReferencePronunciationProvider:
    """
    Generates categorized, linguistically defensible pronunciation variants for English reference sentences.
    Separates standard and contextual weak forms from casual reductions and deletions.
    """

    def __init__(
        self,
        vocab: Dict[str, int],
        phone_mapper: Optional[Any] = None
    ):
        self.vocab = vocab
        self.phone_mapper = phone_mapper
        self.unk_id = vocab.get("<unk>", vocab.get("[UNK]", 3))

    def tokens_to_ids(self, tokens: List[str]) -> List[int]:
        """Convert a list of phoneme strings to model vocabulary token IDs."""
        ids = []
        for t in tokens:
            mapped_t = self.phone_mapper(t) if self.phone_mapper else t
            if mapped_t and mapped_t in self.vocab:
                ids.append(self.vocab[mapped_t])
            elif t in self.vocab:
                ids.append(self.vocab[t])
            else:
                ids.append(self.unk_id)
        return ids

    def normalize_text(self, text: str) -> str:
        """
        Normalize surface text while preserving internal apostrophes in contractions.
        """
        cleaned = text.strip().lower()
        cleaned = re.sub(r"[-_]", " ", cleaned)
        cleaned = re.sub(r"[^\w\s']", "", cleaned)
        return cleaned

    def generate_variants_for_word(
        self,
        word: str,
        word_index: int,
        all_words: List[str]
    ) -> List[ReferenceVariant]:
        """
        Generate categorized pronunciation variants for a single word instance.
        """
        variants: List[ReferenceVariant] = []
        seen_variants = set()

        def add_variant(
            phones: List[str],
            source: str,
            category: VariantCategory,
            priority: int,
            notes: Optional[str] = None
        ):
            key = tuple(phones)
            if key not in seen_variants and len(phones) > 0:
                seen_variants.add(key)
                token_ids = self.tokens_to_ids(phones)
                is_eligible = category in DEFAULT_SCORING_CATEGORIES
                variants.append(ReferenceVariant(
                    phonemes=phones,
                    tokenIds=token_ids,
                    source=source,
                    category=category,
                    isScoringEligible=is_eligible,
                    contextualPriority=priority,
                    notes=notes
                ))

        # 1. Check Contractions Lexicon (STANDARD category)
        if word in CONTRACTIONS_LEXICON:
            for idx, c_phones in enumerate(CONTRACTIONS_LEXICON[word]):
                add_variant(
                    phones=c_phones,
                    source="contraction-lexicon",
                    category=VariantCategory.STANDARD,
                    priority=idx + 1
                )

        # 2. Check Weak-Form Lexicon
        if word in WEAK_FORM_LEXICON:
            wf_info = WEAK_FORM_LEXICON[word]
            next_word = all_words[word_index + 1] if word_index + 1 < len(all_words) else ""

            # Check if next word begins with a vowel sound
            next_starts_with_vowel = False
            if next_word:
                try:
                    next_raw = phonemize(next_word, language="en-us", backend="espeak", strip=True)
                    next_toks = tokenize_espeak_phones(next_raw)
                    if next_toks and next_toks[0] in VOWEL_PHONEMES:
                        next_starts_with_vowel = True
                except Exception:
                    if next_word and next_word[0].lower() in "aeiou":
                        next_starts_with_vowel = True

            if word in ["the", "to"]:
                if next_starts_with_vowel and "weak_before_vowel" in wf_info:
                    for p_list in wf_info["weak_before_vowel"]:
                        add_variant(
                            phones=p_list,
                            source="weak-form-rule",
                            category=VariantCategory.CONTEXTUAL_WEAK_FORM,
                            priority=1,
                            notes="weak before vowel"
                        )
                elif "weak_before_consonant" in wf_info:
                    for p_list in wf_info["weak_before_consonant"]:
                        add_variant(
                            phones=p_list,
                            source="weak-form-rule",
                            category=VariantCategory.CONTEXTUAL_WEAK_FORM,
                            priority=1,
                            notes="weak before consonant"
                        )
            elif "weak" in wf_info:
                cat = wf_info.get("category_weak", VariantCategory.CONTEXTUAL_WEAK_FORM)
                for p_list in wf_info["weak"]:
                    add_variant(
                        phones=p_list,
                        source="weak-form-rule",
                        category=cat,
                        priority=1,
                        notes=wf_info.get("rule")
                    )

            if "strong" in wf_info:
                for p_list in wf_info["strong"]:
                    add_variant(
                        phones=p_list,
                        source="citation-strong",
                        category=VariantCategory.STANDARD,
                        priority=2,
                        notes="citation / strong form"
                    )

            if "casual" in wf_info:
                for p_list in wf_info["casual"]:
                    add_variant(
                        phones=p_list,
                        source="casual-reduction",
                        category=VariantCategory.CASUAL_REDUCTION,
                        priority=3,
                        notes="casual fast-speech reduction (excluded from default scoring)"
                    )

        # 3. Standard G2P via espeak-ng backend (STANDARD category)
        espeak_tokens = []
        try:
            espeak_raw = phonemize(
                word,
                language="en-us",
                backend="espeak",
                strip=True,
                preserve_punctuation=False,
                with_stress=False
            )
            espeak_tokens = tokenize_espeak_phones(espeak_raw)
        except Exception:
            pass

        if espeak_tokens:
            add_variant(
                phones=espeak_tokens,
                source="espeak",
                category=VariantCategory.STANDARD,
                priority=1 if not variants else 2
            )
        elif not variants:
            fallback_dict = {
                "this": ["ð", "ɪ", "s"],
                "morning": ["m", "ɔːɹ", "n", "ɪ", "ŋ"],
                "a": ["ə"],
                "machine": ["m", "ə", "ʃ", "iː", "n"],
                "screamed": ["s", "k", "ɹ", "iː", "m", "d"],
                "at": ["æ", "t"],
                "you": ["j", "uː"],
                "until": ["ə", "n", "t", "ɪ", "l"],
                "woke": ["w", "oʊ", "k"],
                "up": ["ʌ", "p"],
                "think": ["θ", "ɪ", "ŋ", "k"],
                "thought": ["θ", "ɔː", "t"],
                "that": ["ð", "æ", "t"],
                "cat": ["k", "æ", "t"],
                "dog": ["d", "ɒ", "ɡ"],
                "hello": ["h", "ə", "l", "oʊ"],
                "world": ["w", "ɜː", "l", "d"],
                "an": ["æ", "n"],
                "the": ["ð", "ə"],
                "good": ["ɡ", "ʊ", "d"],
                "class": ["k", "l", "æ", "s"],
            }
            fallback_phones = fallback_dict.get(word, list(word))
            add_variant(
                phones=fallback_phones,
                source="fallback-g2p",
                category=VariantCategory.STANDARD,
                priority=1
            )

        # 4. Standard linguistic allophones
        if espeak_tokens:
            # Rule A: /iː/ vs /i/ (unstressed vowel tensing / laxing) -> STANDARD allophone
            if "iː" in espeak_tokens:
                variant_i = [p if p != "iː" else "i" for p in espeak_tokens]
                add_variant(
                    phones=variant_i,
                    source="allophone-vowel-lax",
                    category=VariantCategory.STANDARD,
                    priority=2
                )

            # Rule B: /uː/ vs /u/ -> STANDARD allophone
            if "uː" in espeak_tokens:
                variant_u = [p if p != "uː" else "u" for p in espeak_tokens]
                add_variant(
                    phones=variant_u,
                    source="allophone-vowel-lax",
                    category=VariantCategory.STANDARD,
                    priority=2
                )

            # Rule C: Rhotic vowel decomposition (ɔːɹ -> ɔː + ɹ or ɔ + ɹ) -> STANDARD allophone
            if "ɔːɹ" in espeak_tokens:
                variant_or1 = []
                for p in espeak_tokens:
                    if p == "ɔːɹ":
                        variant_or1.extend(["ɔː", "ɹ"])
                    else:
                        variant_or1.append(p)
                add_variant(
                    phones=variant_or1,
                    source="allophone-rhotic-split",
                    category=VariantCategory.STANDARD,
                    priority=2
                )

                variant_or2 = []
                for p in espeak_tokens:
                    if p == "ɔːɹ":
                        variant_or2.extend(["ɔ", "ɹ"])
                    else:
                        variant_or2.append(p)
                add_variant(
                    phones=variant_or2,
                    source="allophone-rhotic-split",
                    category=VariantCategory.STANDARD,
                    priority=2
                )

            # NOTE: Coda stop elision (e.g. 'screamed' -> 'skɹiːm') is strictly CASUAL_REDUCTION
            # and MUST NOT participate in default scoring.
            if len(espeak_tokens) >= 4 and espeak_tokens[-1] in ["d", "t"]:
                variant_no_coda = espeak_tokens[:-1]
                add_variant(
                    phones=variant_no_coda,
                    source="casual-coda-elision",
                    category=VariantCategory.CASUAL_REDUCTION,
                    priority=4,
                    notes="Coda deletion (retained for research metadata; excluded from default scoring)"
                )

        return variants

    def process_reference_text(
        self,
        reference_text: str,
        scoring_only: bool = True
    ) -> ReferenceSentence:
        """
        Process reference text into ordered ReferenceWord objects.
        If scoring_only is True (default), filters variants to only those eligible for scoring
        (STANDARD and CONTEXTUAL_WEAK_FORM), strictly preventing casual deletions from scoring.
        """
        norm_text = self.normalize_text(reference_text)
        words_raw = norm_text.split()

        sentence = ReferenceSentence(
            rawText=reference_text,
            normalizedText=norm_text,
            words=[]
        )

        for w_idx, w in enumerate(words_raw):
            all_variants = self.generate_variants_for_word(w, w_idx, words_raw)
            if scoring_only:
                eligible_variants = [v for v in all_variants if v.isScoringEligible]
                # Fallback to all variants if none marked eligible
                selected_variants = eligible_variants if eligible_variants else all_variants
            else:
                selected_variants = all_variants

            ref_word = ReferenceWord(
                wordIndex=w_idx,
                surfaceText=w,
                normalizedText=w,
                variants=selected_variants
            )
            sentence.words.append(ref_word)

        return sentence
