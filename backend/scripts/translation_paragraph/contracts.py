"""Strongly typed contracts for Paragraph Mode Data Pipeline.

Every passage candidate tracks strict provenance across source, document,
revision, section, and contiguous order. Topic similarity cannot manufacture
a paragraph; authentic document continuity is enforced.
"""

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import List, Dict, Optional, Any
import hashlib
import json


class LegalClass(str, Enum):
    PRODUCTION_CANDIDATE = "A"  # Commercial publication and adaptation rights cleared
    RESEARCH_ONLY = "B"         # Explicitly permitted research use only, never learner-facing
    BLOCKED = "C"               # Unsafe / prohibited / missing rights grant / sentence-only


class PublicationState(str, Enum):
    UNREVIEWED = "UNREVIEWED"
    ELIGIBLE = "ELIGIBLE"
    QUARANTINED = "QUARANTINED"
    REJECTED = "REJECTED"
    PUBLISHED = "PUBLISHED"


class Genre(str, Enum):
    GENERAL = "GENERAL"
    ACADEMIC = "ACADEMIC"
    NEWS_EDITORIAL = "NEWS_EDITORIAL"
    TALK_SPEECH = "TALK_SPEECH"
    LITERATURE = "LITERATURE"
    DIALOGUE_FILM = "DIALOGUE_FILM"
    COMEDY_HUMOUR = "COMEDY_HUMOUR"
    POETRY = "POETRY"
    UNKNOWN = "UNKNOWN"


class Topic(str, Enum):
    EDUCATION = "EDUCATION"
    TECHNOLOGY = "TECHNOLOGY"
    HEALTH = "HEALTH"
    WORK = "WORK"
    SOCIETY = "SOCIETY"
    CULTURE = "CULTURE"
    FAMILY = "FAMILY"
    ENVIRONMENT = "ENVIRONMENT"
    TRAVEL = "TRAVEL"
    URBAN_LIFE = "URBAN_LIFE"
    GENERAL = "GENERAL"


@dataclass(frozen=True)
class SourceRecord:
    """Metadata identifying an upstream raw corpus release."""
    source_id: str
    source_name: str
    release: str
    official_url: str
    license_name: str
    license_version: str
    legal_class: LegalClass
    commercial_allowed: bool
    requires_attribution: bool
    share_alike: bool
    retrieved_at: str
    parser_version: str = "1.0.0"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["legal_class"] = self.legal_class.value
        return d


@dataclass(frozen=True)
class DocumentRecord:
    """Document/article-level lineage in both source and target languages."""
    document_id: str             # e.g., translation ID in Wikimedia ContentTranslation
    source_id: str               # foreign key to SourceRecord
    source_page_id: str          # upstream source page identifier / title
    source_title: str
    source_url: str
    source_revision_id: str
    target_page_id: str          # upstream target page identifier / title
    target_title: str
    target_url: str
    target_revision_id: str
    published_date: Optional[str] = None
    source_lang: str = "en"
    target_lang: str = "vi"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SectionRecord:
    """Structural section inside a document."""
    document_id: str
    section_id: str
    section_number: int          # 0-indexed original order within the document
    heading_en: Optional[str] = None
    heading_vi: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RawTranslationUnit:
    """Raw translation block/unit as extracted from the dump."""
    unit_id: str                 # e.g., "55848/3"
    document_id: str             # "55848"
    section_id: str              # "cxSourceSection1"
    section_number: int
    ordinal_in_doc: int          # numeric sequence order
    tag_name: str                # e.g., "p", "h2", "table", "ul"
    source_raw_html: str
    target_raw_html: str
    mt_raw_html: Optional[str]
    mt_engine: Optional[str]
    source_text_clean: str
    target_text_clean: str
    mt_text_clean: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AlignedSpan:
    """Bilingual alignment between source and target segments."""
    source_text: str
    target_text: str
    source_span_order: int
    target_span_order: int
    alignment_type: str          # "1:1", "1:N", "N:1", "N:M", "NULL"
    confidence_score: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RightsDecision:
    """Rights gate decision for a passage candidate."""
    legal_class: LegalClass
    is_publishable: bool
    license_name: str
    attribution_text: str
    share_alike_notice: Optional[str] = None
    rejection_reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["legal_class"] = self.legal_class.value
        return d


@dataclass(frozen=True)
class QualityDecision:
    """Quality and text integrity evaluation."""
    is_accepted: bool
    text_quality_score: float    # 0.0 - 1.0
    mt_artifact_risk: float      # 0.0 - 1.0
    alignment_score: float       # 0.0 - 1.0
    near_mt_flag: bool = False
    rejection_reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CoherenceDecision:
    """Discourse and coherence evaluation."""
    is_accepted: bool
    coherence_score: float       # 0.0 - 1.0
    discourse_continuity: bool
    standalone_readable: bool
    rejection_reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ClassificationResult:
    """Offline genre and topic classification."""
    primary_genre: Genre
    genre_confidence: float
    primary_topic: Topic
    topic_confidence: float
    secondary_topics: List[Topic] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "primary_genre": self.primary_genre.value,
            "genre_confidence": self.genre_confidence,
            "primary_topic": self.primary_topic.value,
            "topic_confidence": self.topic_confidence,
            "secondary_topics": [t.value for t in self.secondary_topics]
        }


@dataclass(frozen=True)
class DifficultyFeatures:
    """Linguistic and workload feature vector extracted from the passage."""
    en_word_count: int
    vi_word_count: int
    en_sentence_count: int
    vi_sentence_count: int
    avg_sentence_length_words: float
    lexical_diversity_ttr: float         # Type-token ratio
    subordination_connector_count: int
    passive_voice_markers: int
    information_density_ratio: float      # Character to word ratio
    workload_burden_ratio: float          # VI words / EN words
    ielts_band_calibrated: bool = False
    calibrated_band_label: str = "UNCALIBRATED"
    notes: str = "Final IELTS band uncalibrated without gold teacher validation dataset"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PassageCandidate:
    """A reconstructed, contiguous, authentic paragraph candidate with full provenance."""
    candidate_id: str
    source_id: str
    source_release: str
    document_id: str
    source_page_title: str
    source_url: str
    source_revision_id: str
    target_page_title: str
    target_url: str
    target_revision_id: str
    section_id: str
    section_number: int
    span_order_start: int
    span_order_end: int
    raw_source_locator: str
    en_text: str
    vi_text: str
    en_hash_sha256: str
    vi_hash_sha256: str
    bilingual_hash_sha256: str
    aligned_spans: List[AlignedSpan] = field(default_factory=list)
    rights: Optional[RightsDecision] = None
    quality: Optional[QualityDecision] = None
    coherence: Optional[CoherenceDecision] = None
    classification: Optional[ClassificationResult] = None
    difficulty: Optional[DifficultyFeatures] = None
    publication_state: PublicationState = PublicationState.UNREVIEWED
    mt_text: Optional[str] = None
    mt_engine: Optional[str] = None
    near_mt_flag: bool = False
    is_canonical: bool = True
    duplicate_cluster_id: Optional[str] = None
    pipeline_version: str = "1.0.0"

    @staticmethod
    def compute_hashes(en: str, vi: str) -> tuple[str, str, str]:
        norm_en = " ".join(en.strip().lower().split())
        norm_vi = " ".join(vi.strip().lower().split())
        h_en = hashlib.sha256(norm_en.encode("utf-8")).hexdigest()
        h_vi = hashlib.sha256(norm_vi.encode("utf-8")).hexdigest()
        h_bi = hashlib.sha256(f"{norm_en}|||{norm_vi}".encode("utf-8")).hexdigest()
        return h_en, h_vi, h_bi

    def to_dict(self) -> Dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "document_id": self.document_id,
            "section_id": self.section_id,
            "passage_order": self.span_order_start,
            "source_id": self.source_id,
            "source_release": self.source_release,
            "source_page_title": self.source_page_title,
            "source_url": self.source_url,
            "source_revision": self.source_revision_id,
            "target_page_title": self.target_page_title,
            "target_url": self.target_url,
            "target_revision": self.target_revision_id,
            "span_order_start": self.span_order_start,
            "span_order_end": self.span_order_end,
            "raw_source_locator": self.raw_source_locator,
            "en_text": self.en_text,
            "vi_text": self.vi_text,
            "mt_engine": self.mt_engine,
            "near_mt_flag": self.near_mt_flag or (self.quality.near_mt_flag if self.quality else False),
            "en_hash_sha256": self.en_hash_sha256,
            "vi_hash_sha256": self.vi_hash_sha256,
            "bilingual_hash_sha256": self.bilingual_hash_sha256,
            "alignment_decision": "ACCEPTED" if (self.quality and self.quality.alignment_score >= 0.75) else ("REVIEW" if (self.quality and self.quality.alignment_score >= 0.55) else "REJECTED"),
            "alignment_score": self.quality.alignment_score if self.quality else 0.0,
            "coherence_decision": "ACCEPTED" if (self.coherence and self.coherence.is_accepted) else "REJECTED",
            "coherence_score": self.coherence.coherence_score if self.coherence else 0.0,
            "quality_decision": "ACCEPTED" if (self.quality and self.quality.is_accepted) else "REJECTED",
            "quality_score": self.quality.text_quality_score if self.quality else 0.0,
            "rights_decision": "ELIGIBLE" if (self.rights and self.rights.is_publishable) else "REJECTED",
            "is_canonical": self.is_canonical,
            "duplicate_cluster_id": self.duplicate_cluster_id or self.candidate_id,
            "genre": self.classification.primary_genre.value if self.classification else "UNKNOWN",
            "topic": self.classification.primary_topic.value if self.classification else "GENERAL",
            "difficulty_calibration_status": self.difficulty.calibrated_band_label if self.difficulty else "UNCALIBRATED",
            "pipeline_version": self.pipeline_version,
            "publication_state": self.publication_state.value,
            "aligned_spans": [s.to_dict() for s in self.aligned_spans],
            "rights": self.rights.to_dict() if self.rights else None,
            "quality": self.quality.to_dict() if self.quality else None,
            "coherence": self.coherence.to_dict() if self.coherence else None,
            "classification": self.classification.to_dict() if self.classification else None,
            "difficulty": self.difficulty.to_dict() if self.difficulty else None,
        }


@dataclass
class PipelineManifest:
    """Execution manifest and audit log for a pipeline run."""
    run_id: str
    started_at: str
    completed_at: Optional[str] = None
    source_id: str = ""
    source_release: str = ""
    raw_sha256: str = ""
    pipeline_version: str = "1.0.0"

    # Sequential Funnel Metrics (monotonically non-increasing after candidate_passages)
    raw_records_read: int = 0
    documents_identified: int = 0
    documents_with_order_proven: int = 0
    raw_en_vi_units: int = 0
    candidate_passages: int = 0
    provenance_gate_pass: int = 0
    rejected_provenance: int = 0
    after_alignment: int = 0
    rejected_alignment: int = 0
    after_coherence: int = 0
    rejected_coherence: int = 0
    after_quality: int = 0
    rejected_quality: int = 0
    after_dedup: int = 0
    duplicates_removed: int = 0
    after_rights_gate: int = 0
    rejected_rights: int = 0
    final_publishable_candidates: int = 0

    # Independent Diagnostic Totals (evaluated across all candidate passages)
    alignment_pass_total: int = 0
    alignment_review_total: int = 0
    alignment_reject_total: int = 0
    coherence_pass_total: int = 0
    quality_pass_total: int = 0
    rights_pass_total: int = 0
    exact_mt_rejected_total: int = 0
    near_mt_flagged_total: int = 0

    # Distributions & Metadata
    genre_counts: Dict[str, int] = field(default_factory=dict)
    topic_counts: Dict[str, int] = field(default_factory=dict)
    difficulty_feature_complete: int = 0
    difficulty_uncalibrated_count: int = 0
    final_ielts_bands_calibrated: bool = False
    blockers: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
