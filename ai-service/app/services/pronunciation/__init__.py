"""
Pronunciation assessment package for English Coach.
"""

from app.services.pronunciation.reference_provider import (
    ReferencePronunciationProvider,
    ReferenceSentence,
    ReferenceWord,
    ReferenceVariant,
    VariantCategory,
    DEFAULT_SCORING_CATEGORIES,
    tokenize_espeak_phones,
    CANONICAL_ENGLISH_PHONEMES,
    WEAK_FORM_LEXICON,
    CONTRACTIONS_LEXICON
)
from app.services.pronunciation.calibration_models import (
    PhoneCalibrationStats,
    calculate_calibrated_score
)
from app.services.pronunciation.acoustic_engine import (
    LocalAcousticEngine,
    decode_audio_bytes_to_16k_mono,
    inspect_audio_metadata,
    multi_variant_viterbi_align,
    calculate_raw_gop_and_candidates
)
from app.services.pronunciation.model_adapter import (
    BaseAcousticModelAdapter,
    EspeakWav2Vec2Adapter,
    TimitXlsrAdapter,
    get_acoustic_adapter
)

__all__ = [
    "ReferencePronunciationProvider",
    "ReferenceSentence",
    "ReferenceWord",
    "ReferenceVariant",
    "VariantCategory",
    "DEFAULT_SCORING_CATEGORIES",
    "tokenize_espeak_phones",
    "CANONICAL_ENGLISH_PHONEMES",
    "WEAK_FORM_LEXICON",
    "CONTRACTIONS_LEXICON",
    "PhoneCalibrationStats",
    "calculate_calibrated_score",
    "LocalAcousticEngine",
    "decode_audio_bytes_to_16k_mono",
    "inspect_audio_metadata",
    "multi_variant_viterbi_align",
    "calculate_raw_gop_and_candidates",
    "BaseAcousticModelAdapter",
    "EspeakWav2Vec2Adapter",
    "TimitXlsrAdapter",
    "get_acoustic_adapter"
]
