"""Data-driven Source Registry and Fail-Closed License Gate.

Enforces source-level and document-level legal policies.
Unknown rights fail closed (NOT publishable).
"""

from typing import Dict, Any, Optional
from datetime import datetime
from .contracts import LegalClass, RightsDecision, SourceRecord


# Configuration data: Declarative source policies
SOURCE_POLICIES: Dict[str, Dict[str, Any]] = {
    "wikimedia_content_translation": {
        "source_name": "Wikimedia ContentTranslation EN->VI",
        "default_release": "20260918",
        "official_url": "https://dumps.wikimedia.org/other/contenttranslation/20260918/",
        "license_name": "Creative Commons Attribution-ShareAlike 4.0 International",
        "license_version": "CC BY-SA 4.0",
        "legal_class": LegalClass.PRODUCTION_CANDIDATE,
        "commercial_allowed": True,
        "requires_attribution": True,
        "share_alike": True,
        "allowed_as_direct_paragraph": True,
        "conditions": [
            "Must preserve source and target article title and revision IDs",
            "Must preserve Wikipedia contributor / article history attribution",
            "Must preserve CC BY-SA 4.0 license notice",
            "Must pass text quality, MT artifact, and continuity checks"
        ]
    },
    "phomt": {
        "source_name": "PhoMT Machine Translation Benchmark",
        "default_release": "v1.0",
        "official_url": "https://github.com/VinAIResearch/PhoMT",
        "license_name": "Research and Educational Use Only",
        "license_version": "Non-commercial",
        "legal_class": LegalClass.RESEARCH_ONLY,
        "commercial_allowed": False,
        "requires_attribution": True,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,
        "conditions": ["Prohibited from learner publication"]
    },
    "ted2020": {
        "source_name": "TED2020 Bilingual Subtitles",
        "default_release": "v1",
        "official_url": "https://opus.nlpl.eu/datasets/TED2020",
        "license_name": "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0",
        "license_version": "CC BY-NC-ND 4.0",
        "legal_class": LegalClass.RESEARCH_ONLY,
        "commercial_allowed": False,
        "requires_attribution": True,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,
        "conditions": ["Requires written license for commercial or derivative use"]
    },
    "qed": {
        "source_name": "QED Educational Subtitles",
        "default_release": "v2.0a",
        "official_url": "https://opus.nlpl.eu/datasets/QED",
        "license_name": "QCRI Research Only",
        "license_version": "All Rights Reserved",
        "legal_class": LegalClass.RESEARCH_ONLY,
        "commercial_allowed": False,
        "requires_attribution": True,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,
        "conditions": ["Research only; no publication grant"]
    },
    "opensubtitles": {
        "source_name": "OpenSubtitles Bitext",
        "default_release": "v2024",
        "official_url": "https://opus.nlpl.eu/datasets/OpenSubtitles",
        "license_name": "Unverified Film Copyright",
        "license_version": "Unresolved",
        "legal_class": LegalClass.BLOCKED,
        "commercial_allowed": False,
        "requires_attribution": False,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,
        "conditions": ["Blocked without direct rights clearance from filmmakers"]
    },
    "tatoeba": {
        "source_name": "Tatoeba Community Translations",
        "default_release": "v2026-07-08",
        "official_url": "https://tatoeba.org/",
        "license_name": "Creative Commons Attribution 2.0 France",
        "license_version": "CC BY 2.0 FR",
        "legal_class": LegalClass.PRODUCTION_CANDIDATE,  # Only for sentences
        "commercial_allowed": True,
        "requires_attribution": True,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,  # FORBIDDEN FOR PARAGRAPH MODE
        "conditions": ["Sentence-only; strictly prohibited from paragraph joining"]
    },
    "wikimatrix": {
        "source_name": "WikiMatrix Mined Bitext",
        "default_release": "v1",
        "official_url": "https://opus.nlpl.eu/datasets/WikiMatrix",
        "license_name": "Creative Commons Attribution-ShareAlike 4.0",
        "license_version": "CC BY-SA 4.0",
        "legal_class": LegalClass.RESEARCH_ONLY,
        "commercial_allowed": True,
        "requires_attribution": True,
        "share_alike": True,
        "allowed_as_direct_paragraph": False,  # Mining-score ordered, not authentic document order
        "conditions": ["Candidate discovery only; cannot be used as direct paragraph input"]
    },
    "evbcorpus": {
        "source_name": "EVBCorpus Bilingual Books and News",
        "default_release": "v2",
        "official_url": "https://github.com/qhungngo/EVBCorpus",
        "license_name": "Unspecified Upstream Copyright",
        "license_version": "Unresolved",
        "legal_class": LegalClass.RESEARCH_ONLY,
        "commercial_allowed": False,
        "requires_attribution": True,
        "share_alike": False,
        "allowed_as_direct_paragraph": False,
        "conditions": ["Rights unresolved; no commercial learner publication"]
    }
}


class SourceRegistry:
    """Registry managing source policies and evaluating publishability."""

    def __init__(self, custom_policies: Optional[Dict[str, Dict[str, Any]]] = None):
        self._policies = custom_policies or SOURCE_POLICIES

    def get_source_record(self, source_id: str, release: Optional[str] = None) -> Optional[SourceRecord]:
        policy = self._policies.get(source_id)
        if not policy:
            return None

        rel = release or policy.get("default_release", "unknown")
        return SourceRecord(
            source_id=source_id,
            source_name=policy["source_name"],
            release=rel,
            official_url=policy["official_url"],
            license_name=policy["license_name"],
            license_version=policy["license_version"],
            legal_class=policy["legal_class"],
            commercial_allowed=policy["commercial_allowed"],
            requires_attribution=policy["requires_attribution"],
            share_alike=policy["share_alike"],
            retrieved_at=datetime.utcnow().isoformat() + "Z"
        )

    def evaluate_rights(
        self,
        source_id: str,
        source_page_title: str,
        target_page_title: str,
        source_url: str,
        target_url: str,
        source_revision: Optional[str] = None,
        target_revision: Optional[str] = None
    ) -> RightsDecision:
        """Fail-closed rights evaluation.
        
        Unknown sources or sources not cleared for paragraph publication FAIL.
        """
        policy = self._policies.get(source_id)
        rejection_reasons = []

        # Gate 1: Source exists in registry
        if not policy:
            return RightsDecision(
                legal_class=LegalClass.BLOCKED,
                is_publishable=False,
                license_name="UNKNOWN",
                attribution_text="",
                rejection_reasons=["UNKNOWN_SOURCE: Source is not registered in source policy"]
            )

        legal_class = policy["legal_class"]

        # Gate 2: Legal class must be PRODUCTION_CANDIDATE
        if legal_class != LegalClass.PRODUCTION_CANDIDATE:
            rejection_reasons.append(
                f"SOURCE_NOT_PRODUCTION_CANDIDATE: Legal class is {legal_class.value} ({policy['source_name']})"
            )

        # Gate 3: Must be permitted as direct paragraph content
        if not policy.get("allowed_as_direct_paragraph", False):
            rejection_reasons.append(
                f"SOURCE_PROHIBITED_FOR_PARAGRAPHS: {source_id} cannot enter paragraph mode"
            )

        # Gate 4: Commercial publication permitted
        if not policy.get("commercial_allowed", False):
            rejection_reasons.append("COMMERCIAL_USE_PROHIBITED: Source license forbids commercial deployment")

        # Gate 5: Lineage completeness (provenance requirements)
        if not source_page_title or not source_url:
            rejection_reasons.append("MISSING_SOURCE_PROVENANCE: Missing source page title or URL")
        if not target_page_title or not target_url:
            rejection_reasons.append("MISSING_TARGET_PROVENANCE: Missing target page title or URL")
        if not source_revision or str(source_revision) == "0":
            rejection_reasons.append("MISSING_SOURCE_REVISION: Missing source revision ID required for authentic attribution")
        if not target_revision or str(target_revision) == "0":
            rejection_reasons.append("MISSING_TARGET_REVISION: Missing target revision ID required for authentic attribution")

        # Build attribution and share-alike notices
        attribution = ""
        share_alike_notice = None

        if source_id == "wikimedia_content_translation":
            src_rev_str = f" (rev {source_revision})" if source_revision and str(source_revision) != "0" else ""
            tgt_rev_str = f" (rev {target_revision})" if target_revision and str(target_revision) != "0" else ""
            attribution = (
                f"Adapted from Wikipedia articles '{source_page_title}'{src_rev_str} and "
                f"'{target_page_title}'{tgt_rev_str} via Wikimedia ContentTranslation. "
                f"Source: {source_url} | Target: {target_url}."
            )
            share_alike_notice = (
                "Content licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)."
            )

        if not attribution:
            rejection_reasons.append("MISSING_ATTRIBUTION: Attribution metadata could not be constructed")
        if policy.get("share_alike", False) and not share_alike_notice:
            rejection_reasons.append("MISSING_SHARE_ALIKE: CC BY-SA 4.0 license notice missing")

        is_publishable = len(rejection_reasons) == 0

        return RightsDecision(
            legal_class=legal_class,
            is_publishable=is_publishable,
            license_name=policy["license_name"],
            attribution_text=attribution,
            share_alike_notice=share_alike_notice,
            rejection_reasons=rejection_reasons
        )
