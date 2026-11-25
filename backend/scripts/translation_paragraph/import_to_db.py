"""
Offline Database Importer for Accepted Paragraph Translation Corpus.

Consumes verified pipeline artifact:
backend/scripts/translation_paragraph/data/accepted_passages.jsonl

Performs strictly idempotent persistence into:
- translation_paragraph_sources
- translation_paragraph_documents
- translation_paragraph_sections
- translation_paragraph_passages

Preserves complete provenance, hashes, quality/coherence/alignment scores,
rights decisions, attribution text, and uncalibrated difficulty feature vectors.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Set

import psycopg2
from psycopg2.extras import Json, execute_batch

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def validate_row(row: Dict[str, Any], line_num: int) -> Tuple[bool, Optional[str]]:
    """Validate that a row satisfies contract requirements and gate acceptance."""
    required_fields = [
        "candidate_id",
        "document_id",
        "section_id",
        "source_id",
        "source_release",
        "vi_text",
        "en_text",
        "vi_hash_sha256",
        "en_hash_sha256",
        "bilingual_hash_sha256",
        "alignment_decision",
        "coherence_decision",
        "quality_decision",
        "rights_decision",
        "genre",
        "topic",
    ]
    for rf in required_fields:
        if rf not in row or row[rf] is None or row[rf] == "":
            return False, f"Line {line_num}: missing required field '{rf}'"

    # Validate gate decisions
    if row.get("alignment_decision") not in ("ACCEPT", "ACCEPTED"):
        return False, f"Line {line_num}: alignment_decision is {row.get('alignment_decision')}"

    if row.get("coherence_decision") not in ("ACCEPT", "ACCEPTED"):
        return False, f"Line {line_num}: coherence_decision is {row.get('coherence_decision')}"

    if row.get("quality_decision") not in ("ACCEPT", "ACCEPTED"):
        return False, f"Line {line_num}: quality_decision is {row.get('quality_decision')}"

    if row.get("rights_decision") not in ("ACCEPT", "ACCEPTED", "ELIGIBLE"):
        return False, f"Line {line_num}: rights_decision is {row.get('rights_decision')}"

    rights = row.get("rights", {})
    if not rights.get("is_publishable", True):
        return False, f"Line {line_num}: rights is_publishable is False"

    return True, None


def run_import(
    artifact_path: Path,
    db_name: str = "english_coach",
    db_user: str = "postgres",
    db_password: str = "postgres",
    db_host: str = "localhost",
    db_port: int = 5432,
    db_url: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Execute idempotent import from JSONL artifact into PostgreSQL."""
    if not artifact_path.exists():
        raise FileNotFoundError(f"Artifact not found: {artifact_path}")

    if db_url:
        clean_url = db_url.replace("jdbc:", "")
        logger.info("Opening DB connection via URL...")
        conn = psycopg2.connect(clean_url, user=db_user, password=db_password)
    else:
        logger.info("Opening DB connection to %s@%s:%s/%s...", db_user, db_host, db_port, db_name)
        ssl_mode = "require" if "azure.com" in db_host else os.environ.get("PGSSLMODE", "prefer")
        conn = psycopg2.connect(
            dbname=db_name,
            user=db_user,
            password=db_password,
            host=db_host,
            port=db_port,
            sslmode=ssl_mode,
        )
    conn.autocommit = False
    cur = conn.cursor()

    stats = {
        "records_read": 0,
        "records_accepted": 0,
        "records_rejected": 0,
        "rejection_reasons": [],
        "sources_upserted": 0,
        "documents_upserted": 0,
        "sections_upserted": 0,
        "passages_inserted": 0,
        "passages_skipped_existing": 0,
    }

    valid_rows: List[Dict[str, Any]] = []

    try:
        with open(artifact_path, "r", encoding="utf-8") as f:
            for line_idx, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                stats["records_read"] += 1

                try:
                    row = json.loads(line)
                except Exception as e:
                    stats["records_rejected"] += 1
                    stats["rejection_reasons"].append(f"Line {line_idx}: invalid JSON ({e})")
                    continue

                valid, reason = validate_row(row, line_idx)
                if not valid:
                    stats["records_rejected"] += 1
                    stats["rejection_reasons"].append(reason)
                    continue

                stats["records_accepted"] += 1
                valid_rows.append(row)

        logger.info("Loaded %d valid candidate rows from %s", len(valid_rows), artifact_path.name)

        if not valid_rows:
            logger.warning("No valid rows to import.")
            return stats

        # 1. Resolve or Insert Source
        first_row = valid_rows[0]
        src_code = str(first_row["source_id"])
        src_release = str(first_row["source_release"])
        cur.execute(
            """
            INSERT INTO public.translation_paragraph_sources (
                source_code, source_name, source_release, source_type,
                legal_class, legal_review_state, publication_state,
                license_code, license_version, license_url,
                commercial_use_allowed, derivatives_allowed, attribution_required,
                source_url, pipeline_version
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s
            )
            ON CONFLICT (source_code, source_release) DO UPDATE SET
                updated_at = CURRENT_TIMESTAMP
            RETURNING id;
            """,
            (
                src_code,
                "Wikimedia ContentTranslation",
                src_release,
                "OFFICIAL_DUMP",
                first_row.get("rights", {}).get("legal_class", "A"),
                "APPROVED",
                "APPROVED",
                "CC_BY_SA_4_0",
                "4.0",
                "https://creativecommons.org/licenses/by-sa/4.0/",
                True,
                True,
                True,
                first_row.get("source_url"),
                first_row.get("pipeline_version", "1.0.0"),
            ),
        )
        source_db_id = str(cur.fetchone()[0])
        stats["sources_upserted"] += 1

        # 2. Preload and Batch Insert Documents
        logger.info("Resolving documents...")
        cur.execute("SELECT external_document_id, id FROM public.translation_paragraph_documents WHERE source_id = %s;", (source_db_id,))
        doc_id_map: Dict[str, str] = {row[0]: str(row[1]) for row in cur.fetchall()}
        logger.info("Preloaded %d existing documents from database", len(doc_id_map))

        new_docs: Dict[str, Tuple] = {}
        for row in valid_rows:
            ext_doc_id = str(row["document_id"])
            if ext_doc_id not in doc_id_map and ext_doc_id not in new_docs:
                src_rev = str(row.get("source_revision", ""))
                tgt_rev = str(row.get("target_revision", ""))
                doc_hash = hashlib.sha256(f"{ext_doc_id}:{src_rev}:{tgt_rev}".encode("utf-8")).hexdigest()
                new_docs[ext_doc_id] = (
                    source_db_id,
                    ext_doc_id,
                    row.get("source_page_title", ""),
                    row.get("target_page_title", ""),
                    row.get("source_url"),
                    row.get("target_url"),
                    src_rev,
                    tgt_rev,
                    "en",
                    "vi",
                    doc_hash,
                    True,
                    True,
                    "APPROVED",
                )

        if new_docs:
            logger.info("Batch inserting %d new documents...", len(new_docs))
            doc_insert_sql = """
                INSERT INTO public.translation_paragraph_documents (
                    source_id, external_document_id, source_title, target_title,
                    source_url, target_url, source_revision_id, target_revision_id,
                    source_language, target_language, document_hash,
                    original_order_proven, provenance_complete, publication_state
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (source_id, external_document_id, source_revision_id, target_revision_id) DO UPDATE SET
                    updated_at = CURRENT_TIMESTAMP;
            """
            execute_batch(cur, doc_insert_sql, list(new_docs.values()), page_size=1000)
            stats["documents_upserted"] += len(new_docs)

            # Reload all document IDs
            cur.execute("SELECT external_document_id, id FROM public.translation_paragraph_documents WHERE source_id = %s;", (source_db_id,))
            doc_id_map = {row[0]: str(row[1]) for row in cur.fetchall()}
            logger.info("Total resolved documents: %d", len(doc_id_map))

        # 3. Preload and Batch Insert Sections
        logger.info("Resolving sections...")
        cur.execute("SELECT document_id, external_section_id, id FROM public.translation_paragraph_sections;")
        sec_id_map: Dict[Tuple[str, str], str] = {(str(row[0]), str(row[1])): str(row[2]) for row in cur.fetchall()}
        logger.info("Preloaded %d existing sections from database", len(sec_id_map))

        # Track section ordinal per document to satisfy unique constraint uk_trans_para_sections_doc_ord within 32-bit INT
        cur.execute("SELECT document_id, COALESCE(MAX(ordinal), -1) FROM public.translation_paragraph_sections GROUP BY document_id;")
        doc_sec_max_ord: Dict[str, int] = {str(row[0]): int(row[1]) for row in cur.fetchall()}

        new_secs: Dict[Tuple[str, str], Tuple] = {}
        for row in valid_rows:
            ext_doc_id = str(row["document_id"])
            doc_db_id = doc_id_map[ext_doc_id]
            ext_sec_id = str(row["section_id"])
            sec_key = (doc_db_id, ext_sec_id)
            if sec_key not in sec_id_map and sec_key not in new_secs:
                current_ord = doc_sec_max_ord.get(doc_db_id, -1) + 1
                doc_sec_max_ord[doc_db_id] = current_ord
                raw_sec_num = row.get("section_number")
                sec_num = int(raw_sec_num) if (isinstance(raw_sec_num, int) and 0 <= raw_sec_num < 2147483647) else current_ord

                new_secs[sec_key] = (
                    doc_db_id,
                    ext_sec_id,
                    sec_num,
                    current_ord,
                    row.get("raw_source_locator"),
                )

        if new_secs:
            logger.info("Batch inserting %d new sections...", len(new_secs))
            sec_insert_sql = """
                INSERT INTO public.translation_paragraph_sections (
                    document_id, external_section_id, section_number, ordinal, source_locator
                ) VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (document_id, external_section_id) DO NOTHING;
            """
            execute_batch(cur, sec_insert_sql, list(new_secs.values()), page_size=1000)
            stats["sections_upserted"] += len(new_secs)

            # Reload all section IDs
            cur.execute("SELECT document_id, external_section_id, id FROM public.translation_paragraph_sections;")
            sec_id_map = {(str(row[0]), str(row[1])): str(row[2]) for row in cur.fetchall()}
            logger.info("Total resolved sections: %d", len(sec_id_map))

        # 4. Preload Existing Passages for Idempotency and Reconciliation
        logger.info("Preloading existing passages for reconciliation and dedup...")
        cur.execute("SELECT id, document_id, external_passage_id, bilingual_pair_hash FROM public.translation_paragraph_passages WHERE content_version = 1;")
        existing_rows = cur.fetchall()
        existing_by_ext_id: Dict[Tuple[str, str], str] = {(str(row[1]), str(row[2])): str(row[0]) for row in existing_rows}
        existing_by_bi_hash: Dict[Tuple[str, str], str] = {(str(row[1]), str(row[3]).strip()): str(row[0]) for row in existing_rows}
        logger.info("Preloaded %d existing passages from database (%d unique bi-hashes)", len(existing_by_ext_id), len(existing_by_bi_hash))

        cur.execute("SELECT document_id, COALESCE(MAX(passage_ordinal), -1) FROM public.translation_paragraph_passages GROUP BY document_id;")
        doc_pass_max_ord: Dict[str, int] = {str(row[0]): int(row[1]) for row in cur.fetchall()}

        reconcile_list: List[Tuple] = []
        insert_list: List[Tuple] = []
        seen_in_batch_ext: Set[Tuple[str, str]] = set()
        seen_in_batch_bi: Set[Tuple[str, str]] = set()

        for row in valid_rows:
            ext_doc_id = str(row["document_id"])
            doc_db_id = doc_id_map[ext_doc_id]
            ext_sec_id = str(row["section_id"])
            sec_db_id = sec_id_map[(doc_db_id, ext_sec_id)]
            ext_passage_id = str(row["candidate_id"])
            bi_hash = str(row["bilingual_hash_sha256"])

            ext_key = (doc_db_id, ext_passage_id)
            bi_key = (doc_db_id, bi_hash)

            existing_id = existing_by_ext_id.get(ext_key) or existing_by_bi_hash.get(bi_key)
            sec_topics = row.get("classification", {}).get("secondary_topics", [])

            if existing_id:
                reconcile_list.append((
                    row["topic"],
                    Json(sec_topics),
                    row.get("source_url"),
                    row.get("target_url"),
                    existing_id,
                ))
                stats["passages_skipped_existing"] += 1
            else:
                if ext_key in seen_in_batch_ext or bi_key in seen_in_batch_bi:
                    stats["passages_skipped_existing"] += 1
                    continue
                seen_in_batch_ext.add(ext_key)
                seen_in_batch_bi.add(bi_key)

                diff_features = row.get("difficulty", {})
                attrib_text = row.get("rights", {}).get(
                    "attribution_text",
                    f"Adapted from Wikipedia via Wikimedia ContentTranslation ({ext_doc_id}).",
                )
                
                # Ensure 32-bit integer boundaries for passage_ordinal and span orders
                raw_order = row.get("passage_order")
                if isinstance(raw_order, int) and 0 <= raw_order < 2147483647:
                    passage_order = raw_order
                else:
                    passage_order = doc_pass_max_ord.get(doc_db_id, -1) + 1
                    doc_pass_max_ord[doc_db_id] = passage_order

                span_start_raw = row.get("span_order_start")
                span_start = int(span_start_raw) if (isinstance(span_start_raw, int) and 0 <= span_start_raw < 2147483647) else passage_order
                span_end_raw = row.get("span_order_end")
                span_end = int(span_end_raw) if (isinstance(span_end_raw, int) and 0 <= span_end_raw < 2147483647) else passage_order

                src_rev = str(row.get("source_revision", ""))
                tgt_rev = str(row.get("target_revision", ""))

                insert_list.append((
                    doc_db_id,
                    sec_db_id,
                    ext_passage_id,
                    passage_order,
                    row["vi_text"],
                    row["en_text"],
                    span_start,
                    span_end,
                    span_start,
                    span_end,
                    src_rev,
                    tgt_rev,
                    row["vi_hash_sha256"],
                    row["en_hash_sha256"],
                    bi_hash,
                    1,  # content_version
                    float(row.get("alignment_score", 1.0)),
                    row.get("alignment_decision", "ACCEPTED"),
                    float(row.get("coherence_score", 1.0)),
                    row.get("coherence_decision", "ACCEPTED"),
                    float(row.get("quality_score", 1.0)),
                    row.get("quality_decision", "ACCEPTED"),
                    row.get("rights_decision", "ELIGIBLE"),
                    True,
                    row.get("duplicate_cluster_id"),
                    bool(row.get("is_canonical", True)),
                    row.get("genre", "GENERAL"),
                    row.get("topic", "GENERAL"),
                    Json(sec_topics),
                    row.get("difficulty_calibration_status", "UNCALIBRATED"),
                    Json(diff_features),
                    "APPROVED",
                    attrib_text,
                    "CC_BY_SA_4_0",
                    row.get("source_url"),
                    row.get("target_url"),
                    row.get("pipeline_version", "1.0.0"),
                ))
                stats["passages_inserted"] += 1

        # 5. Execute Batch Updates and Inserts
        if reconcile_list:
            logger.info("Batch updating %d existing passages for topic/url reconciliation...", len(reconcile_list))
            update_sql = """
                UPDATE public.translation_paragraph_passages
                SET topic = %s,
                    secondary_topics = %s,
                    source_url = COALESCE(source_url, %s),
                    target_url = COALESCE(target_url, %s),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s;
            """
            execute_batch(cur, update_sql, reconcile_list, page_size=1000)

        if insert_list:
            logger.info("Batch inserting %d new eligible passages...", len(insert_list))
            passage_insert_sql = """
                INSERT INTO public.translation_paragraph_passages (
                    document_id, section_id, external_passage_id, passage_ordinal,
                    source_vi, reference_en,
                    source_span_start, source_span_end, target_span_start, target_span_end,
                    source_revision_id, target_revision_id,
                    source_hash, reference_hash, bilingual_pair_hash, content_version,
                    alignment_score, alignment_decision,
                    coherence_score, coherence_decision,
                    quality_score, quality_decision,
                    rights_decision, rights_eligible,
                    duplicate_cluster_id, canonical_content,
                    genre, topic, secondary_topics,
                    difficulty_status, difficulty_features,
                    publication_state, attribution_text, license_code,
                    source_url, target_url, pipeline_version
                ) VALUES (
                    %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s
                )
                ON CONFLICT (document_id, external_passage_id, content_version) DO NOTHING;
            """
            execute_batch(cur, passage_insert_sql, insert_list, page_size=1000)

        if dry_run:
            logger.info("DRY RUN: Rolling back transaction.")
            conn.rollback()
        else:
            logger.info("Committing transaction...")
            conn.commit()

    except Exception as e:
        conn.rollback()
        logger.error("Import failed with error: %s", e)
        raise
    finally:
        cur.close()
        conn.close()

    logger.info("Import completed successfully. Stats: %s", json.dumps(stats, indent=2))
    return stats


def main():
    parser = argparse.ArgumentParser(description="Import accepted paragraph translations into PostgreSQL")
    parser.add_argument(
        "--artifact",
        type=Path,
        default=Path(__file__).resolve().parent / "data" / "accepted_passages.jsonl",
        help="Path to accepted_passages.jsonl",
    )
    parser.add_argument("--db-name", default=os.environ.get("POSTGRES_DB", "english_coach"))
    parser.add_argument("--db-user", default=os.environ.get("POSTGRES_USER", "postgres"))
    parser.add_argument("--db-password", default=os.environ.get("POSTGRES_PASSWORD", "postgres"))
    parser.add_argument("--db-host", default=os.environ.get("POSTGRES_HOST", "localhost"))
    parser.add_argument("--db-port", type=int, default=int(os.environ.get("POSTGRES_PORT", 5432)))
    parser.add_argument("--db-url", default=os.environ.get("DB_URL") or os.environ.get("POSTGRES_URL"))
    parser.add_argument("--dry-run", action="store_true", help="Perform dry run without committing")

    args = parser.parse_args()
    stats = run_import(
        artifact_path=args.artifact,
        db_name=args.db_name,
        db_user=args.db_user,
        db_password=args.db_password,
        db_host=args.db_host,
        db_port=args.db_port,
        db_url=args.db_url,
        dry_run=args.dry_run,
    )
    print(f"IMPORT_SUMMARY: {json.dumps(stats)}")


if __name__ == "__main__":
    main()
