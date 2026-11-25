"""End-to-End Orchestrator for Paragraph Mode Data Pipeline.

Executes Phases 1–8:
1. Source Registry & Rights Gate initialization
2. Streaming raw Wikimedia ContentTranslation acquisition
3. Raw Schema Gate verification
4. Document reconstruction & native paragraph candidate formation
5. Monotonic bilingual alignment
6. Quality, MT artifact, and discourse coherence filtering
7. Deduplication
8. Genre/Topic classification and difficulty feature extraction
9. Production of pipeline data artifacts and funnel metrics
"""

import os
import sys
import json
import argparse
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple

from .contracts import (
    PipelineManifest,
    PassageCandidate,
    PublicationState,
    LegalClass
)
from .source_registry import SourceRegistry
from .staging import StagingManager
from .reconstruct import DocumentReconstructor
from .align import AlignmentScorer
from .quality import QualityFilter
from .coherence import CoherenceFilter
from .deduplicate import Deduplicator
from .classify import Classifier
from .difficulty import DifficultyExtractor


def run_pipeline(
    data_dir: str,
    max_bytes: int = 2_500_000,
    max_documents: int = 75,
    force_refresh: bool = False,
    full_corpus: bool = False
) -> PipelineManifest:
    """Executes the complete offline paragraph data pipeline on real raw data."""
    now_utc = datetime.now(timezone.utc)
    start_time = now_utc.isoformat()
    os.makedirs(data_dir, exist_ok=True)

    manifest = PipelineManifest(
        run_id=f"run_{now_utc.strftime('%Y%m%d_%H%M%S')}",
        started_at=start_time,
        source_id="wikimedia_content_translation",
        source_release="20260918"
    )

    print("==================================================")
    print("STARTING PARAGRAPH MODE DATA PIPELINE (PHASES 1–8)")
    print(f"Run ID: {manifest.run_id}")
    print(f"Data directory: {data_dir}")
    print(f"Mode: {'FULL CORPUS' if full_corpus else f'PILOT ({max_documents} docs)'}")
    print("==================================================")

    # Phase 2: Source Registry
    registry = SourceRegistry()
    src_record = registry.get_source_record(manifest.source_id, manifest.source_release)
    if not src_record:
        manifest.blockers.append("FATAL: Source is not registered in source registry")
        return manifest

    # Phase 3: Raw Acquisition
    staging = StagingManager(data_dir)
    try:
        if full_corpus:
            print("\n[PHASE 3] Acquiring FULL official Wikimedia ContentTranslation raw dump...")
            raw_path, raw_meta = staging.acquire_full_dump(force_refresh=force_refresh)
        else:
            print("\n[PHASE 3] Acquiring official Wikimedia ContentTranslation raw dump sample...")
            raw_path, raw_meta = staging.acquire_sample(max_bytes=max_bytes, force_refresh=force_refresh)
    except Exception as e:
        manifest.blockers.append(f"ACQUISITION_FAILED: {e}")
        return manifest

    manifest.raw_sha256 = raw_meta.get("sha256", "")
    print(f"Acquired dump ({raw_meta.get('downloaded_bytes')} bytes)")
    print(f"SHA-256: {manifest.raw_sha256}")

    # Phase 4: Stream and Prove Raw Schema
    print("\n[PHASE 4] Streaming records and proving raw schema...")
    
    # 1. Fast schema verification using initial sample
    sample_records = []
    stream_iter = staging.stream_json_records(raw_path)
    for _ in range(2000):
        try:
            sample_records.append(next(stream_iter))
        except StopIteration:
            break

    schema_gate = staging.verify_schema_gate(sample_records)
    print(f"DOCUMENT_CONTINUITY_GATE: {schema_gate['DOCUMENT_CONTINUITY_GATE']}")
    for k, v in schema_gate["proven_fields"].items():
        print(f"  - {k}: {'PROVEN' if v else 'FAIL'}")

    if schema_gate["DOCUMENT_CONTINUITY_GATE"] != "PASS":
        manifest.blockers.append("DOCUMENT_CONTINUITY_GATE = FAIL: Raw schema missing critical provenance fields")
        return manifest

    # 2. Identify all documents (translation IDs) in stream
    print("\nScanning stream to identify document boundaries...")
    doc_ids: List[str] = []
    doc_id_set = set()
    total_records = 0

    for r in staging.stream_json_records(raw_path):
        total_records += 1
        rec_id = r.get("id", "")
        if "/" in rec_id:
            did = rec_id.split("/")[0]
            if did not in doc_id_set:
                doc_id_set.add(did)
                doc_ids.append(did)

    manifest.raw_records_read = total_records
    manifest.documents_identified = len(doc_ids)
    print(f"Read {manifest.raw_records_read} raw records from dump")
    print(f"Identified {manifest.documents_identified} unique document translation IDs")

    if full_corpus:
        target_doc_ids = doc_ids
        print(f"Processing FULL eligible dataset: {len(target_doc_ids)} documents")
    else:
        target_doc_ids = doc_ids[:max_documents]
        print(f"Bounding pilot to first {len(target_doc_ids)} documents")

    target_doc_id_set = set(target_doc_ids)

    # 3. Fetch authentic document titles and URLs from MediaWiki API (with cache)
    print("Fetching authentic document metadata from MediaWiki cxpublishedtranslations API...")
    doc_metadata_map = staging.fetch_document_metadata_batch(target_doc_ids, cache_dir=data_dir)
    manifest.documents_with_order_proven = len(doc_metadata_map)
    print(f"Lineage order proven for {manifest.documents_with_order_proven} documents")

    # Phase 5: Document Reconstruction & Native Paragraph Candidate Formation
    # Stream-group records by document to reconstruct paragraphs with minimal memory usage
    print("\n[PHASE 5] Reconstructing document hierarchy and extracting native paragraphs (streaming)...")
    raw_candidates: List[PassageCandidate] = []
    current_doc_id: Optional[str] = None
    current_doc_records: List[Dict[str, Any]] = []
    units_processed = 0

    for r in staging.stream_json_records(raw_path):
        rec_id = r.get("id", "")
        did = rec_id.split("/")[0] if "/" in rec_id else "unknown"
        if did not in target_doc_id_set:
            continue

        units_processed += 1
        if current_doc_id is not None and did != current_doc_id:
            # Reconstruct previous document
            if current_doc_records:
                candidates = DocumentReconstructor.reconstruct_documents(
                    current_doc_records,
                    doc_metadata_map,
                    source_release=manifest.source_release
                )
                raw_candidates.extend(candidates)
            current_doc_records = [r]
            current_doc_id = did
        else:
            current_doc_id = did
            current_doc_records.append(r)

    # Reconstruct final document
    if current_doc_records:
        candidates = DocumentReconstructor.reconstruct_documents(
            current_doc_records,
            doc_metadata_map,
            source_release=manifest.source_release
        )
        raw_candidates.extend(candidates)

    manifest.raw_en_vi_units = units_processed
    manifest.candidate_passages = len(raw_candidates)
    print(f"Processed {manifest.raw_en_vi_units} translation units")
    print(f"Formed {manifest.candidate_passages} native paragraph candidates")

    # =========================================================================
    # INDEPENDENT DIAGNOSTICS (Evaluated independently across ALL candidates)
    # =========================================================================
    print("\n[DIAGNOSTICS] Computing independent filter metrics across all candidates...")
    for cand in raw_candidates:
        # 1. Independent Alignment
        a_score, spans, a_rej = AlignmentScorer.align_passage(cand)
        if a_rej or a_score < 0.55:
            manifest.alignment_reject_total += 1
        elif a_score >= 0.75:
            manifest.alignment_pass_total += 1
        else:
            manifest.alignment_review_total += 1

        # 2. Independent Coherence
        coh_d = CoherenceFilter.evaluate_coherence(cand)
        if coh_d.is_accepted:
            manifest.coherence_pass_total += 1

        # 3. Independent Quality & MT check
        q_d = QualityFilter.evaluate_quality(cand, alignment_score=a_score, mt_text_clean=cand.mt_text)
        if q_d.is_accepted:
            manifest.quality_pass_total += 1
        if any("UNEDITED_MT_OUTPUT" in r for r in q_d.rejection_reasons):
            manifest.exact_mt_rejected_total += 1
        if q_d.near_mt_flag:
            manifest.near_mt_flagged_total += 1

        # 4. Independent Rights
        r_d = registry.evaluate_rights(
            source_id=cand.source_id,
            source_page_title=cand.source_page_title,
            target_page_title=cand.target_page_title,
            source_url=cand.source_url,
            target_url=cand.target_url,
            source_revision=cand.source_revision_id,
            target_revision=cand.target_revision_id
        )
        if r_d.is_publishable:
            manifest.rights_pass_total += 1

    # =========================================================================
    # TRUE SEQUENTIAL FUNNEL (Monotonically non-increasing surviving counts)
    #
    # Final eligibility predicate:
    # final_publishable = provenance_pass ∩ alignment_pass ∩ coherence_pass
    #                   ∩ quality_pass ∩ dedupe_pass ∩ rights_pass
    # No later stage may resurrect a rejected candidate.
    # =========================================================================
    print("\n[SEQUENTIAL FUNNEL] Executing sequential filtering stages...")
    rejected_passages: List[Dict[str, Any]] = []

    # STAGE 1: PROVENANCE GATE
    # Enforces document lineage, revision IDs, original sequence order, and defensible boundaries.
    def check_provenance(c: PassageCandidate) -> Tuple[bool, List[str]]:
        reasons = []
        if not c.source_page_title or not c.source_url:
            reasons.append("PROVENANCE_MISSING_SOURCE_LINEAGE: Missing source article title or URL")
        if not c.target_page_title or not c.target_url:
            reasons.append("PROVENANCE_MISSING_TARGET_LINEAGE: Missing target article title or URL")
        if not c.source_revision_id or str(c.source_revision_id) == "0":
            reasons.append("PROVENANCE_MISSING_SOURCE_REVISION: Source revision ID not proven")
        if not c.target_revision_id or str(c.target_revision_id) == "0":
            reasons.append("PROVENANCE_MISSING_TARGET_REVISION: Target revision ID not proven")
        if c.span_order_start < 0:
            reasons.append("PROVENANCE_INVALID_ORDER: Original sequence order not proven")
        if not c.section_id:
            reasons.append("PROVENANCE_MISSING_SECTION: Section structural identity missing")
        words_en = len(c.en_text.split())
        words_vi = len(c.vi_text.split())
        if words_en < 15:
            reasons.append(f"DEFENSIBLE_BOUNDARY_SHORT_EN: EN text has only {words_en} words (min 15)")
        if words_vi < 10:
            reasons.append(f"DEFENSIBLE_BOUNDARY_SHORT_VI: VI text has only {words_vi} words (min 10)")
        if words_en > 300:
            reasons.append(f"DEFENSIBLE_BOUNDARY_LONG_EN: EN text has {words_en} words (max 300)")
        return len(reasons) == 0, reasons

    stage1_provenance_survivors: List[PassageCandidate] = []
    for cand in raw_candidates:
        prov_pass, prov_reasons = check_provenance(cand)
        if prov_pass:
            stage1_provenance_survivors.append(cand)
        else:
            rejected_passages.append({
                "candidate_id": cand.candidate_id,
                "document_id": cand.document_id,
                "stage": "PROVENANCE_GATE",
                "rejection_reasons": prov_reasons,
                "en_preview": cand.en_text[:120],
                "vi_preview": cand.vi_text[:120]
            })

    manifest.provenance_gate_pass = len(stage1_provenance_survivors)
    manifest.rejected_provenance = len(raw_candidates) - manifest.provenance_gate_pass
    print(f"  Stage 1 (Provenance): {manifest.provenance_gate_pass} survived ({manifest.rejected_provenance} rejected)")

    # STAGE 2: ALIGNMENT GATE
    # Evaluates bilingual correspondence on provenance survivors (requires score >= 0.75 and 0 rejections).
    stage2_alignment_survivors: List[Tuple[PassageCandidate, List[Any], float]] = []
    for cand in stage1_provenance_survivors:
        a_score, spans, a_rej = AlignmentScorer.align_passage(cand)
        if len(a_rej) == 0 and a_score >= 0.75:
            stage2_alignment_survivors.append((cand, spans, a_score))
        else:
            reasons = a_rej or [f"ALIGNMENT_SCORE_BELOW_THRESHOLD: {a_score:.2f} < 0.75"]
            rejected_passages.append({
                "candidate_id": cand.candidate_id,
                "document_id": cand.document_id,
                "stage": "ALIGNMENT_GATE",
                "rejection_reasons": reasons,
                "en_preview": cand.en_text[:120],
                "vi_preview": cand.vi_text[:120]
            })

    manifest.after_alignment = len(stage2_alignment_survivors)
    manifest.rejected_alignment = manifest.provenance_gate_pass - manifest.after_alignment
    print(f"  Stage 2 (Alignment):  {manifest.after_alignment} survived ({manifest.rejected_alignment} rejected)")

    # STAGE 3: COHERENCE GATE
    # Evaluates standalone discourse continuity, boundary integrity, and dangling anaphora.
    stage3_coherence_survivors: List[Tuple[PassageCandidate, List[Any], float, Any]] = []
    for cand, spans, a_score in stage2_alignment_survivors:
        coh_dec = CoherenceFilter.evaluate_coherence(cand)
        if coh_dec.is_accepted:
            stage3_coherence_survivors.append((cand, spans, a_score, coh_dec))
        else:
            rejected_passages.append({
                "candidate_id": cand.candidate_id,
                "document_id": cand.document_id,
                "stage": "COHERENCE_GATE",
                "rejection_reasons": coh_dec.rejection_reasons,
                "en_preview": cand.en_text[:120],
                "vi_preview": cand.vi_text[:120]
            })

    manifest.after_coherence = len(stage3_coherence_survivors)
    manifest.rejected_coherence = manifest.after_alignment - manifest.after_coherence
    print(f"  Stage 3 (Coherence):  {manifest.after_coherence} survived ({manifest.rejected_coherence} rejected)")

    # STAGE 4: QUALITY GATE (Text Integrity & Machine-Translation Filtering)
    # Detects residual markup, broken Unicode, control characters, and rejects 100% unedited MT.
    stage4_quality_survivors: List[Tuple[PassageCandidate, List[Any], float, Any, Any]] = []
    for cand, spans, a_score, coh_dec in stage3_coherence_survivors:
        qual_dec = QualityFilter.evaluate_quality(cand, alignment_score=a_score, mt_text_clean=cand.mt_text)
        if qual_dec.is_accepted:
            stage4_quality_survivors.append((cand, spans, a_score, coh_dec, qual_dec))
        else:
            rejected_passages.append({
                "candidate_id": cand.candidate_id,
                "document_id": cand.document_id,
                "stage": "QUALITY_GATE",
                "rejection_reasons": qual_dec.rejection_reasons,
                "en_preview": cand.en_text[:120],
                "vi_preview": cand.vi_text[:120]
            })

    manifest.after_quality = len(stage4_quality_survivors)
    manifest.rejected_quality = manifest.after_coherence - manifest.after_quality
    print(f"  Stage 4 (Quality):    {manifest.after_quality} survived ({manifest.rejected_quality} rejected)")

    # STAGE 5: DEDUPLICATION GATE
    # Eliminates exact hash matches and high lexical shingle near-duplicates.
    deduplicator = Deduplicator(near_dup_threshold=0.85)
    qual_item_map = {item[0].candidate_id: item for item in stage4_quality_survivors}
    candidates_to_dedup = [item[0] for item in stage4_quality_survivors]
    unique_candidates, removed_duplicates = deduplicator.deduplicate(candidates_to_dedup)

    for dup_cand, reason, canonical_id in removed_duplicates:
        rejected_passages.append({
            "candidate_id": dup_cand.candidate_id,
            "document_id": dup_cand.document_id,
            "stage": "DEDUPLICATION_GATE",
            "rejection_reasons": [reason],
            "canonical_id": canonical_id,
            "en_preview": dup_cand.en_text[:120],
            "vi_preview": dup_cand.vi_text[:120]
        })

    manifest.after_dedup = len(unique_candidates)
    manifest.duplicates_removed = len(removed_duplicates)
    print(f"  Stage 5 (Deduplication): {manifest.after_dedup} survived ({manifest.duplicates_removed} duplicates removed)")

    # STAGE 6: RIGHTS GATE
    # Enforces source policy and ensures authentic CC BY-SA attribution / revision provenance.
    stage6_rights_survivors: List[PassageCandidate] = []
    for cand in unique_candidates:
        orig_cand, spans, a_score, coh_dec, qual_dec = qual_item_map[cand.candidate_id]
        rights_dec = registry.evaluate_rights(
            source_id=cand.source_id,
            source_page_title=cand.source_page_title,
            target_page_title=cand.target_page_title,
            source_url=cand.source_url,
            target_url=cand.target_url,
            source_revision=cand.source_revision_id,
            target_revision=cand.target_revision_id
        )

        if rights_dec.is_publishable:
            # Classification & Feature Extraction for surviving publishable candidates
            class_res = Classifier.classify(cand)
            diff_feat = DifficultyExtractor.extract_features(cand)

            enriched_cand = PassageCandidate(
                candidate_id=cand.candidate_id,
                source_id=cand.source_id,
                source_release=cand.source_release,
                document_id=cand.document_id,
                source_page_title=cand.source_page_title,
                source_url=cand.source_url,
                source_revision_id=cand.source_revision_id,
                target_page_title=cand.target_page_title,
                target_url=cand.target_url,
                target_revision_id=cand.target_revision_id,
                section_id=cand.section_id,
                section_number=cand.section_number,
                span_order_start=cand.span_order_start,
                span_order_end=cand.span_order_end,
                raw_source_locator=cand.raw_source_locator,
                en_text=cand.en_text,
                vi_text=cand.vi_text,
                en_hash_sha256=cand.en_hash_sha256,
                vi_hash_sha256=cand.vi_hash_sha256,
                bilingual_hash_sha256=cand.bilingual_hash_sha256,
                aligned_spans=spans,
                rights=rights_dec,
                quality=qual_dec,
                coherence=coh_dec,
                classification=class_res,
                difficulty=diff_feat,
                publication_state=PublicationState.ELIGIBLE,
                mt_text=cand.mt_text,
                mt_engine=cand.mt_engine,
                near_mt_flag=qual_dec.near_mt_flag,
                is_canonical=True,
                duplicate_cluster_id=cand.candidate_id,
                pipeline_version="1.0.0"
            )
            stage6_rights_survivors.append(enriched_cand)
        else:
            rejected_passages.append({
                "candidate_id": cand.candidate_id,
                "document_id": cand.document_id,
                "stage": "RIGHTS_GATE",
                "rejection_reasons": rights_dec.rejection_reasons,
                "en_preview": cand.en_text[:120],
                "vi_preview": cand.vi_text[:120]
            })

    manifest.after_rights_gate = len(stage6_rights_survivors)
    manifest.rejected_rights = len(unique_candidates) - manifest.after_rights_gate
    print(f"  Stage 6 (Rights Gate): {manifest.after_rights_gate} survived ({manifest.rejected_rights} rejected)")

    # STAGE 7: FINAL PUBLISHABLE CANDIDATES
    # Canonical output row count must equal this metric exactly.
    accepted_passages: List[PassageCandidate] = stage6_rights_survivors
    manifest.final_publishable_candidates = len(accepted_passages)
    print(f"\nFINAL PUBLISHABLE CANDIDATES: {manifest.final_publishable_candidates}")

    # Accumulate classification and difficulty statistics on publishable passages
    genre_counts: Dict[str, int] = {}
    topic_counts: Dict[str, int] = {}
    for c in accepted_passages:
        if c.classification:
            g = c.classification.primary_genre.value
            t = c.classification.primary_topic.value
            genre_counts[g] = genre_counts.get(g, 0) + 1
            topic_counts[t] = topic_counts.get(t, 0) + 1

    manifest.genre_counts = genre_counts
    manifest.topic_counts = topic_counts
    manifest.difficulty_feature_complete = len(accepted_passages)
    manifest.difficulty_uncalibrated_count = len(accepted_passages)
    manifest.final_ielts_bands_calibrated = False

    # Persist Pipeline Data Artifacts in gitignored local data directory
    print("\n[WRITING PIPELINE ARTIFACTS]")
    artifacts = {
        "manifest.json": manifest.to_dict(),
        "candidate_passages.jsonl": [c.to_dict() for c in raw_candidates],
        "accepted_passages.jsonl": [c.to_dict() for c in accepted_passages],
        "rejected_passages.jsonl": rejected_passages,
        "pipeline_metrics.json": {
            "sequential_funnel": {
                "RAW_RECORDS_READ": manifest.raw_records_read,
                "DOCUMENTS_IDENTIFIED": manifest.documents_identified,
                "DOCUMENTS_WITH_ORDER_PROVEN": manifest.documents_with_order_proven,
                "RAW_EN_VI_UNITS": manifest.raw_en_vi_units,
                "CANDIDATE_PASSAGES": manifest.candidate_passages,
                "PROVENANCE_GATE_PASS": manifest.provenance_gate_pass,
                "REJECTED_PROVENANCE": manifest.rejected_provenance,
                "AFTER_ALIGNMENT": manifest.after_alignment,
                "REJECTED_ALIGNMENT": manifest.rejected_alignment,
                "AFTER_COHERENCE": manifest.after_coherence,
                "REJECTED_COHERENCE": manifest.rejected_coherence,
                "AFTER_QUALITY": manifest.after_quality,
                "REJECTED_QUALITY": manifest.rejected_quality,
                "AFTER_DEDUP": manifest.after_dedup,
                "DUPLICATES_REMOVED": manifest.duplicates_removed,
                "AFTER_RIGHTS_GATE": manifest.after_rights_gate,
                "REJECTED_RIGHTS": manifest.rejected_rights,
                "FINAL_PUBLISHABLE_CANDIDATES": manifest.final_publishable_candidates,
            },
            "independent_diagnostics": {
                "ALIGNMENT_PASS_TOTAL": manifest.alignment_pass_total,
                "ALIGNMENT_REVIEW_TOTAL": manifest.alignment_review_total,
                "ALIGNMENT_REJECT_TOTAL": manifest.alignment_reject_total,
                "COHERENCE_PASS_TOTAL": manifest.coherence_pass_total,
                "QUALITY_PASS_TOTAL": manifest.quality_pass_total,
                "RIGHTS_PASS_TOTAL": manifest.rights_pass_total,
                "EXACT_MT_REJECTED_TOTAL": manifest.exact_mt_rejected_total,
                "NEAR_MT_FLAGGED_TOTAL": manifest.near_mt_flagged_total
            },
            "genre_counts": manifest.genre_counts,
            "topic_counts": manifest.topic_counts,
            "difficulty": {
                "DIFFICULTY_FEATURE_COMPLETE": manifest.difficulty_feature_complete,
                "DIFFICULTY_UNCALIBRATED_COUNT": manifest.difficulty_uncalibrated_count,
                "FINAL_IELTS_LIKE_BANDS_CALIBRATED": False,
                "REASON": "No gold teacher-reviewed calibration dataset available in repository"
            }
        }
    }

    # Write JSON files
    for fname, data in artifacts.items():
        out_path = os.path.join(data_dir, fname)
        with open(out_path, "w", encoding="utf-8") as f:
            if fname.endswith(".jsonl"):
                for row in data:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
            else:
                json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"  Wrote {out_path} ({len(data)} items)")

    manifest.completed_at = datetime.now(timezone.utc).isoformat()
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Paragraph Mode Data Pipeline")
    parser.add_argument("--data-dir", default=os.path.join(os.path.dirname(__file__), "data"), help="Local data directory")
    parser.add_argument("--max-bytes", type=int, default=2_500_000, help="Max raw bytes to sample")
    parser.add_argument("--max-documents", type=int, default=75, help="Max documents for bounded pilot")
    parser.add_argument("--force-refresh", action="store_true", help="Force re-download of raw sample")
    parser.add_argument("--full-corpus", action="store_true", help="Process full official Wikimedia dump")
    args = parser.parse_args()

    manifest = run_pipeline(
        data_dir=args.data_dir,
        max_bytes=args.max_bytes,
        max_documents=args.max_documents,
        force_refresh=args.force_refresh,
        full_corpus=args.full_corpus
    )
    print("\nPipeline execution complete.")
