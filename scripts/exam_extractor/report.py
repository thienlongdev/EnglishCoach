"""Merge extraction reports + the Java Phase 2 gate output into the final staging status, and compare
RAW SOURCE vs OLD GENERATED PACKAGE vs NEW PACKAGE (metrics only, no exam text).

Final staging status (reporting only; never a runtime status):
  INVALID_SOURCE       nothing extractable (scanned / unreliable text layer / no test boundary / no package)
  NEEDS_REVIEW         any BLOCKING extraction diagnostic, or Phase 2 status INVALID / UNKNOWN, or a contract violation
  VALID_PRACTICE_ONLY  extraction clean and Phase 2 status NEEDS_REVIEW with at least one practice skill
  VALID_FULL           extraction clean and Phase 2 status VALID (fullSimulationEligible)
Rights are reported separately: no staged package is importable by the PRODUCTION importer while the publisher
licence is UNKNOWN ("importable"); the Phase 3.6 LOCAL staging rights gate (owner authorization, Java
ExamProjectUsageAuthorization) is reported as "stagingImportPreparationEligible".
"""
from __future__ import annotations

import glob
import json
import re
from collections import Counter
from pathlib import Path

from .corpus import REPO_ROOT
from .staging import _write_json

PLACEHOLDER = [re.compile(p, re.I) for p in (
    r"mark your answer on your answer sheet \(a, b, c,? or d\)",
    r"choose the one word or phrase that best completes the sentence or passage",
    r"according to the speaker, what is key regarding")]


def final_status(ext: dict, p2: dict | None) -> str:
    if ext["extractionStatus"] == "INVALID_SOURCE" or p2 is None:
        return "INVALID_SOURCE"
    v = p2.get("phase2") or {}
    if ext["extractionStatus"] == "NEEDS_REVIEW" or v.get("status") in (None, "INVALID", "UNKNOWN") \
            or p2.get("closureStructuralErrors") or not p2.get("contentHashMatches"):
        return "NEEDS_REVIEW"
    if v.get("status") == "VALID" and v.get("fullSimulationEligible"):
        return "VALID_FULL"
    if v.get("practiceSkills"):
        return "VALID_PRACTICE_ONLY"
    return "NEEDS_REVIEW"


def package_metrics(pkg: dict) -> dict:
    items = pkg.get("items", [])
    keyed = {a["itemId"] for a in pkg.get("answerSpecs", []) if a.get("acceptedAnswers")}

    def letter_only(i):
        opts = (i.get("optionDefinitions") or {}).get("options") or []
        return bool(opts) and all(re.fullmatch(r"\(?[A-D]\)?", str(o.get("text") if isinstance(o, dict) else o) or "") for o in opts)

    stim_kinds = Counter(s["kind"] for s in pkg.get("stimuli", []))
    assets = pkg.get("assets", [])
    return {"items": len(items), "groups": len(pkg.get("groups", [])),
            "placeholder_prompts": sum(1 for i in items if any(p.search(i.get("prompt") or "") for p in PLACEHOLDER)),
            "letter_only_options": sum(1 for i in items if letter_only(i)),
            "items_without_key": sum(1 for i in items if i["id"] not in keyed),
            "passage_stimuli": sum(1 for s in pkg.get("stimuli", []) if "PASSAGE" in (s.get("logicalStimulusKey") or "")),
            "text_stimuli": stim_kinds.get("TEXT", 0) + stim_kinds.get("MULTI_DOC", 0),
            "audio_assets": sum(1 for a in assets if str(a.get("mimeType", "")).startswith("audio/")),
            "image_assets": sum(1 for a in assets if str(a.get("mimeType", "")).startswith("image/")),
            "validated_audio": sum(1 for a in assets if str(a.get("mimeType", "")).startswith("audio/")
                                   and a.get("validationState") == "VALIDATED")}


def compare(test_id: str, staging: Path) -> dict | None:
    matrix = json.loads((REPO_ROOT / "imports/exams/manifests/raw-source/raw_vs_generated_loss_matrix.json").read_text(encoding="utf-8"))
    old = next((p for p in matrix["packages"] if p.get("raw_test_id") == test_id), None)
    rep = next((json.loads(Path(f).read_text(encoding="utf-8")) for f in glob.glob(str(staging / "reports/extraction/*/*.json"))
                if json.loads(Path(f).read_text(encoding="utf-8"))["testId"] == test_id), None)
    if rep is None:
        return None
    new = None
    if rep["package"]["path"]:
        new = package_metrics(json.loads((REPO_ROOT / rep["package"]["path"]).read_text(encoding="utf-8")))
    return {"testId": test_id, "raw": old["raw"] if old else None,
            "oldGenerated": ({"path": old["generated_path"], **old["generated"], "losses": old.get("losses")} if old else None),
            "newPackage": new, "newExtractionStatus": rep["extractionStatus"]}


def merge_reports(staging: Path) -> dict:
    p2_file = staging / "reports" / "phase2_validation.json"
    p2 = json.loads(p2_file.read_text(encoding="utf-8")) if p2_file.exists() else {"results": [], "contractViolations": ["phase2 report missing"]}
    by_file = {r["file"]: r for r in p2["results"]}
    rows = []
    for f in sorted(glob.glob(str(staging / "reports/extraction/*/*.json"))):
        ext = json.loads(Path(f).read_text(encoding="utf-8"))
        pkg_rel = ext["package"]["path"]
        key = pkg_rel.split("imports/exams/staging/", 1)[1] if pkg_rel else None
        pr = by_file.get(key) if key else None
        v = (pr or {}).get("phase2") or {}
        rows.append({
            "testId": ext["testId"], "family": ext["family"], "batch": ext["batch"],
            "phase1Readiness": ext["phase1Readiness"], "extractionStatus": ext["extractionStatus"],
            "phase2Status": v.get("status"), "finalStatus": final_status(ext, pr),
            "practiceSkills": v.get("practiceSkills", []), "simulationSkills": v.get("simulationSkills", []),
            "evidenceEligibleSkillsIfPublished": v.get("officialEvidenceSkillsIfPublished", []),
            "evidenceEligibleNow": [],  # DRAFT, not imported, rights pending: no evidence is possible
            "importable": bool((pr or {}).get("importable")), "rightsErrors": (pr or {}).get("closureRightsErrors", []),
            "stagingRights": (pr or {}).get("stagingRights"),
            "stagingImportPreparationEligible": bool((pr or {}).get("stagingImportPreparationEligible")),
            "items": ext["summary"]["itemsEmitted"], "answerKeysBound": ext["summary"]["answerKeysBound"],
            "phase2BlockingCodes": v.get("blockingCodes", []),
            "extractionBlockingCodes": sorted({d["code"] for d in ext["diagnostics"] if d["severity"] == "BLOCKING"}),
            "reviewCodes": sorted({d["code"] for d in ext["diagnostics"] if d["severity"] == "REVIEW"}),
            "package": pkg_rel})
    summary = {"tests": len(rows), "packages": sum(1 for r in rows if r["package"]),
               "byFinalStatus": dict(Counter(r["finalStatus"] for r in rows)),
               "byBatch": {b: dict(Counter(r["finalStatus"] for r in rows if r["batch"] == b))
                           for b in sorted({r["batch"] for r in rows})},
               "byPhase2Status": dict(Counter(r["phase2Status"] for r in rows if r["phase2Status"])),
               "importablePackages": sum(1 for r in rows if r["importable"]),
               "stagingRightsCleared": sum(1 for r in rows if (r["stagingRights"] or {}).get("stagingRightsCleared")),
               "stagingImportPreparationEligible": sum(1 for r in rows if r["stagingImportPreparationEligible"]),
               "contractViolations": p2.get("contractViolations", []),
               "topExtractionBlockingCodes": Counter(c for r in rows for c in r["extractionBlockingCodes"]).most_common(20),
               "topPhase2Codes": Counter(c for r in rows for c in r["phase2BlockingCodes"]).most_common(20)}
    comparisons = [c for c in (compare("ielts/cambridge-ielts-17/test-1", staging),
                               compare("ielts/cambridge-ielts-21/test-3", staging),
                               compare("toeic/ets-2019/test-1", staging),
                               compare("toeic/ets-2026/test-1", staging),
                               compare("toeic/economy-vol-1/test-1", staging),
                               compare("ielts/cambridge-ielts-16/test-1", staging)) if c]
    out = {"summary": summary, "tests": rows, "comparisons": comparisons, "delta": _delta(staging, rows)}
    _write_json(staging / "reports" / "staging_status.json", out)
    print(json.dumps(summary, indent=1))
    print(json.dumps(out["delta"]["counts"], indent=1))
    return out


def _delta(staging: Path, rows: list) -> dict:
    """BEFORE (previous phase snapshot: Phase 3.5 when present, else Phase 3) vs AFTER (this run), per test —
    regressions are listed, never hidden."""
    base_file = staging / "reports" / "phase35_baseline" / "staging_status.json"
    if not base_file.exists():
        base_file = staging / "reports" / "phase3_baseline" / "staging_status.json"
    if not base_file.exists():
        return {"counts": None, "changes": []}
    base = json.loads(base_file.read_text(encoding="utf-8"))
    before = {r["testId"]: r for r in base["tests"]}
    after = {r["testId"]: r for r in rows}
    rank = {"INVALID_SOURCE": 0, "NEEDS_REVIEW": 1, "VALID_PRACTICE_ONLY": 2, "VALID_FULL": 3}
    changes = []
    for tid in sorted(set(before) | set(after)):
        b, a = before.get(tid), after.get(tid)
        bs, as_ = (b or {}).get("finalStatus"), (a or {}).get("finalStatus")
        bp, ap = (b or {}).get("phase2Status"), (a or {}).get("phase2Status")
        if bs != as_ or bp != ap or (b or {}).get("items") != (a or {}).get("items") \
                or (b or {}).get("answerKeysBound") != (a or {}).get("answerKeysBound"):
            direction = ("NEW" if b is None else "UPGRADE" if as_ and bs and rank[as_] > rank[bs]
                         else "REGRESSION" if as_ and bs and rank[as_] < rank[bs] else "CHANGED")
            changes.append({"testId": tid, "direction": direction, "before": {"final": bs, "phase2": bp,
                            "items": (b or {}).get("items"), "keys": (b or {}).get("answerKeysBound")},
                            "after": {"final": as_, "phase2": ap, "items": (a or {}).get("items"),
                                      "keys": (a or {}).get("answerKeysBound")}})
    counts = {"before": {"final": base["summary"]["byFinalStatus"], "phase2": base["summary"]["byPhase2Status"]},
              "after": {"final": dict(Counter(r["finalStatus"] for r in rows)),
                        "phase2": dict(Counter(r["phase2Status"] for r in rows if r["phase2Status"]))},
              "upgrades": sum(1 for c in changes if c["direction"] == "UPGRADE"),
              "regressions": sum(1 for c in changes if c["direction"] == "REGRESSION"),
              "newTests": sum(1 for c in changes if c["direction"] == "NEW")}
    return {"baseline": str(base_file.relative_to(staging)).replace("\\", "/"), "counts": counts, "changes": changes}
