"""Legacy placeholder form -> canonical source identity -> intended replacement (Exams Recovery Phase 5G).

Reviewable, conservative mapping plan for Phase 10 reconciliation. Nothing is written to any database and nothing
is retired. Inputs (read-only): the 240 generated legacy packages under imports/exams/real/** (their form logical key,
package id, content hash and the SHA-256 of the raw file they were generated from), the Phase 1 raw-vs-generated loss
matrix (raw book / test / confidence / drift) and the canonical staged packages (sourceIdentity + raw document hashes).

Status (never decided by display-name similarity):
  EXACT_SOURCE_MATCH  loss matrix CONFIDENT with a raw test id, no source drift, a canonical package for the same raw
                      book + test + family exists, AND the legacy package's recorded raw SHA-256 is one of the canonical
                      package's raw source documents (byte-identical source file)
  REVIEW_REQUIRED     a canonical package for the same raw book + test exists but one proof is missing (PROBABLE
                      mapping, no raw test id, drift, or a different raw file hash)
  NO_SAFE_MATCH       no canonical package for that raw test, unmapped legacy package, or family mismatch

Output: imports/exams/staging/reports/legacy_replacement_mapping.json (+ .md) -- codes, keys and hashes only.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Optional

LOSS_MATRIX = Path("imports/exams/manifests/raw-source/raw_vs_generated_loss_matrix.json")
EXACT, REVIEW, NONE = "EXACT_SOURCE_MATCH", "REVIEW_REQUIRED", "NO_SAFE_MATCH"
ACTION = "CONSIDER_RETIRE_AFTER_REPLACEMENT_PUBLISHED"


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def source_key(family: str, source_identity: dict) -> str:
    """Same key as Java ExamPackageIdentity#sourceKey: FAMILY:collection/book/test-n (path part lower case)."""
    return f"{family}:" + f"{source_identity.get('collection')}/{source_identity['book']}/test-{source_identity['test']}".lower()


def canonical_index(staging_root: Path) -> dict:
    """(family, raw book, test number) -> canonical identity facts of the staged package."""
    out = {}
    for p in sorted((staging_root / "extracted").rglob("*.json")):
        pkg = _load(p)
        md = pkg["manifest"].get("metadata", {})
        si = md.get("sourceIdentity") or {}
        if not si.get("book") or si.get("test") is None:
            continue
        fam = pkg["form"]["family"]
        out[(fam, si["book"], int(si["test"]))] = {
            "sourceKey": source_key(fam, si),
            "packageId": pkg["manifest"]["packageId"],
            "formLogicalKey": pkg["form"]["logicalKey"],
            "rawSourceSha256": (si.get("rawSourceSha256") or "").lower() or None,
            "rawDocumentSha256": sorted({(d.get("sha256") or "").lower() for d in md.get("sourceDocuments", []) if d.get("sha256")}),
        }
    return out


def decide(entry: dict, legacy_sha: Optional[str], legacy_family: str, canonical: Optional[dict]) -> tuple:
    """-> (status, evidence codes, missing proofs)."""
    evidence, missing = [], []
    if entry.get("confidence") == "UNMAPPED" or not entry.get("raw_book"):
        return NONE, ["LOSS_MATRIX_UNMAPPED"], ["RAW_SOURCE_UNKNOWN"]
    if canonical is None:
        return NONE, [f"LOSS_MATRIX_{entry.get('confidence')}"], ["NO_CANONICAL_PACKAGE_FOR_RAW_TEST"]
    if entry.get("family") and entry["family"] != legacy_family:
        return NONE, [], ["FAMILY_MISMATCH"]
    evidence.append("RAW_BOOK_AND_TEST_MATCH")
    if entry.get("confidence") == "CONFIDENT":
        evidence.append("LOSS_MATRIX_CONFIDENT")
    else:
        missing.append(f"LOSS_MATRIX_{entry.get('confidence')}")
    if entry.get("raw_test_id"):
        evidence.append("RAW_TEST_ID_PRESENT")
    else:
        missing.append("RAW_TEST_ID_ABSENT")
    if entry.get("raw_source_drift"):
        missing.append(entry["raw_source_drift"])
    if legacy_sha and legacy_sha in canonical["rawDocumentSha256"]:
        evidence.append("RAW_SOURCE_SHA256_IDENTICAL")
    else:
        missing.append("RAW_SOURCE_SHA256_DIFFERENT_OR_ABSENT")
    return (EXACT if not missing else REVIEW), evidence, missing


def build(staging_root: Path, repo_root: Path, dispositions: Optional[dict] = None) -> dict:
    matrix = _load(repo_root / LOSS_MATRIX)
    canon = canonical_index(staging_root)
    rows = []
    for e in matrix["packages"]:
        gp = repo_root / e["generated_path"]
        legacy = _load(gp) if gp.is_file() else None
        lk = legacy["form"]["logicalKey"] if legacy else None
        md = (legacy or {}).get("manifest", {}).get("metadata", {}) or {}
        legacy_sha = (md.get("sourceSha256") or "").lower() or None
        fam = (legacy or {}).get("form", {}).get("family") or e.get("family")
        c = canon.get((fam, e.get("raw_book"), int(e["raw_test"]))) if e.get("raw_book") and e.get("raw_test") is not None else None
        status, evidence, missing = decide(e, legacy_sha, fam, c)
        row = {"legacyLogicalKey": lk, "legacyPackageId": (legacy or {}).get("manifest", {}).get("packageId"),
               "legacyContentHash": (legacy or {}).get("manifest", {}).get("contentHash"),
               "legacyRawSourceSha256": legacy_sha, "family": fam,
               "rawBook": e.get("raw_book"), "rawTest": e.get("raw_test"), "rawTestId": e.get("raw_test_id"),
               "lossMatrixConfidence": e.get("confidence"), "sourceDrift": e.get("raw_source_drift"),
               "legacyLosses": e.get("losses", []),
               "status": status, "evidence": evidence, "missingProof": missing,
               "canonical": None, "proposedAction": None, "executed": False}
        if c is not None:
            row["canonical"] = {k: c[k] for k in ("sourceKey", "packageId", "formLogicalKey")}
            disp = (dispositions or {}).get(c["sourceKey"])
            row["canonical"]["disposition"] = disp
            if status == EXACT:
                row["proposedAction"] = ACTION
                row["replacementReady"] = disp == "RELEASE_CANDIDATE"
        rows.append(row)
    rows.sort(key=lambda r: (r["status"], r["family"] or "", r["rawBook"] or "", r["rawTest"] or 0, r["legacyLogicalKey"] or ""))
    counts = Counter(r["status"] for r in rows)
    return {"generatedBy": "scripts/exam_extractor/legacy_mapping.py (Exams Recovery Phase 5G)",
            "policy": "never by display name; EXACT needs CONFIDENT mapping + raw test id + no drift + identical raw "
                      "SHA-256; retirement is a later reviewed publication decision, never executed here",
            "legacyPackages": len(rows), "byStatus": dict(sorted(counts.items())),
            "canonicalSourcesWithExactLegacy": len({r["canonical"]["sourceKey"] for r in rows if r["status"] == EXACT}),
            "mappings": rows}


def write(staging_root: Path, repo_root: Path, dispositions: Optional[dict] = None) -> dict:
    out = build(staging_root, repo_root, dispositions)
    rep = staging_root / "reports"
    (rep / "legacy_replacement_mapping.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    lines = ["# Legacy placeholder -> canonical replacement mapping (Phase 5G, generated)", "",
             f"Legacy packages: {out['legacyPackages']} · " + " · ".join(f"{k} {v}" for k, v in out["byStatus"].items()), "",
             "| Status | Legacy form key | Raw book / test | Canonical source | Canonical disposition | Missing proof |",
             "|---|---|---|---|---|---|"]
    for r in out["mappings"]:
        if r["status"] == NONE:
            continue
        c = r["canonical"] or {}
        lines.append(f"| {r['status']} | `{r['legacyLogicalKey']}` | {r['rawBook']} / {r['rawTest']} | "
                     f"{c.get('sourceKey', '-')} | {c.get('disposition') or '-'} | {', '.join(r['missingProof']) or '-'} |")
    lines += ["", f"NO_SAFE_MATCH rows ({out['byStatus'].get(NONE, 0)}) are listed in the JSON only."]
    (rep / "legacy_replacement_mapping.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out
