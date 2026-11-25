"""Document Reconstruction and Native Paragraph Formation.

Reconstructs the authentic document hierarchy:
Source -> Document -> Section -> Contiguous Native Paragraphs.
Enforces that no passage crosses document, revision, or section boundaries.
"""

import re
from typing import List, Dict, Any, Optional
from .contracts import (
    DocumentRecord,
    SectionRecord,
    RawTranslationUnit,
    PassageCandidate,
    PublicationState
)


def clean_html_markup(html_str: str) -> str:
    """Removes HTML tags, decoded entities, and reference footnote markers [1], [2], etc."""
    if not html_str:
        return ""
    # Strip citation templates and references
    text = re.sub(r'<ref[^>]*>.*?</ref>', '', html_str, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<ref[^>]*/>', '', text, flags=re.IGNORECASE)
    # Strip HTML tags
    text = re.sub(r'<[^>]+>', ' ', text)
    # Normalize HTML entities
    text = text.replace('&quot;', '"').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&nbsp;', ' ').replace('&#160;', ' ').replace(' ', ' ')
    # Strip footnote brackets like [1], [2], [14]
    text = re.sub(r'\[\s*\d+\s*\]', '', text)
    # Collapse multiple whitespaces
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def parse_raw_unit(record: Dict[str, Any], doc_id: str, default_ordinal: int) -> Optional[RawTranslationUnit]:
    """Parses a raw dump record into a strongly typed RawTranslationUnit."""
    rec_id = record.get("id", "")
    parts = rec_id.split("/", 1)
    unit_id = parts[1] if len(parts) > 1 else str(default_ordinal)

    src_dict = record.get("source", {}) or {}
    tgt_dict = record.get("target", {}) or {}
    mt_dict = record.get("mt", {}) or {}

    src_html = src_dict.get("content", "") or ""
    tgt_html = tgt_dict.get("content", "") or ""
    mt_html = mt_dict.get("content", "") or ""
    mt_engine = mt_dict.get("engine")

    # Extract section info
    sec_num_match = re.search(r'data-mw-section-number="(\d+)"', src_html)
    sec_number = int(sec_num_match.group(1)) if sec_num_match else 0

    sec_id_match = re.search(r'id="(cxSourceSection[^"]+)"', src_html)
    sec_id = sec_id_match.group(1) if sec_id_match else f"section_{sec_number}"

    # Determine tag type
    tag_name = "other"
    if "<p" in src_html:
        tag_name = "p"
    elif re.search(r'<h[1-6]', src_html):
        tag_name = "h"
    elif "<table" in src_html:
        tag_name = "table"
    elif "<ul" in src_html or "<ol" in src_html:
        tag_name = "list"

    # Numeric ordinal for sorting within document
    try:
        ordinal = int(unit_id)
    except ValueError:
        ordinal = default_ordinal

    return RawTranslationUnit(
        unit_id=rec_id,
        document_id=doc_id,
        section_id=sec_id,
        section_number=sec_number,
        ordinal_in_doc=ordinal,
        tag_name=tag_name,
        source_raw_html=src_html,
        target_raw_html=tgt_html,
        mt_raw_html=mt_html,
        mt_engine=mt_engine,
        source_text_clean=clean_html_markup(src_html),
        target_text_clean=clean_html_markup(tgt_html),
        mt_text_clean=clean_html_markup(mt_html)
    )


class DocumentReconstructor:
    """Reconstructs ordered document units and constructs authentic passage candidates."""

    @staticmethod
    def reconstruct_documents(
        raw_records: List[Dict[str, Any]],
        doc_metadata_map: Dict[str, DocumentRecord],
        source_release: str = "20260918"
    ) -> List[PassageCandidate]:
        """Groups raw units by document, sorts strictly by original order,
        and extracts native paragraph passages.
        """
        # Step 1: Group by document
        doc_units: Dict[str, List[RawTranslationUnit]] = {}
        for idx, rec in enumerate(raw_records):
            rec_id = rec.get("id", "")
            doc_id = rec_id.split("/")[0] if "/" in rec_id else "unknown"
            unit = parse_raw_unit(rec, doc_id, default_ordinal=idx)
            if unit:
                doc_units.setdefault(doc_id, []).append(unit)

        candidates: List[PassageCandidate] = []

        # Step 2: Process each document in strict order
        for doc_id, units in doc_units.items():
            doc_meta = doc_metadata_map.get(doc_id)
            if not doc_meta:
                continue

            # Sort units monotonically by ordinal_in_doc
            units_sorted = sorted(units, key=lambda u: u.ordinal_in_doc)

            # Step 3: Extract native paragraph units
            for u in units_sorted:
                # We strictly target native <p> paragraphs
                if u.tag_name != "p":
                    continue

                en_text = u.source_text_clean
                vi_text = u.target_text_clean

                # Initial structural sanity check: must have non-trivial content
                if len(en_text) < 30 or len(vi_text) < 30:
                    continue

                h_en, h_vi, h_bi = PassageCandidate.compute_hashes(en_text, vi_text)
                cand_id = f"cx_cand_{doc_id}_{u.ordinal_in_doc}"

                cand = PassageCandidate(
                    candidate_id=cand_id,
                    source_id="wikimedia_content_translation",
                    source_release=source_release,
                    document_id=doc_id,
                    source_page_title=doc_meta.source_title,
                    source_url=doc_meta.source_url,
                    source_revision_id=doc_meta.source_revision_id,
                    target_page_title=doc_meta.target_title,
                    target_url=doc_meta.target_url,
                    target_revision_id=doc_meta.target_revision_id,
                    section_id=u.section_id,
                    section_number=u.section_number,
                    span_order_start=u.ordinal_in_doc,
                    span_order_end=u.ordinal_in_doc,
                    raw_source_locator=u.unit_id,
                    en_text=en_text,
                    vi_text=vi_text,
                    en_hash_sha256=h_en,
                    vi_hash_sha256=h_vi,
                    bilingual_hash_sha256=h_bi,
                    publication_state=PublicationState.UNREVIEWED,
                    mt_text=u.mt_text_clean,
                    mt_engine=u.mt_engine
                )
                candidates.append(cand)

        return candidates
