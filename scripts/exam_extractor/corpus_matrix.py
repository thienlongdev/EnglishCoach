"""Corpus closure matrix (Exams Recovery Phase 5A): ONE canonical, machine-readable disposition per staged package.

Built only from the canonical reports already produced by the pipeline -- no count is maintained by hand:
  staging_status.json            extraction status + blocking codes (Python extractor)
  extraction/<family>/<test>.json  per-diagnostic scope / detail / questions
  phase2_validation.json         Phase 2 structural status (Java, unchanged validator)
  phase4_release_readiness.json  release gate dimensions, runner / scoring / media blockers (Java)
  phase5_import_plan.json        package identity + gate-driven import plans (Java)
  qa_release_review.json         open human-QA entries by release priority
  raw-source manifest            what the corpus holds (keys, audio, question books)
Output: reports/corpus_closure_matrix.json + corpus_closure_matrix.md (rendered from the JSON).

Disposition (first rule that applies):
  RELEASE_CANDIDATE        release gate IMPORT_READY
  READY_EXCEPT_HUMAN_QA    every engineering dimension holds; only owner decisions remain (gate diagnostic)
  SOURCE_BLOCKED           a required source is absent / unprovable in the corpus (answer key, question book, audio)
  RUNTIME_BLOCKED          a required interaction is not supported by the declared runtime
  TECHNICALLY_RECOVERABLE  every blocker is an extractor / parser defect on source that exists
  NOT_RELEASEABLE          none of the above can be shown (never used to hide a reason)
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Optional

OBJECTIVE = {"SINGLE_CHOICE", "TEXT_GAP", "MATCHING", "TRUTH_CLASSIFICATION", "HEADING_MATCHING", "SHORT_ANSWER",
             "MULTIPLE_CHOICE_MULTI", "LABEL_ASSIGNMENT"}
SOURCE_REASONS = ("SOURCE_KEY_UNAVAILABLE", "SOURCE_KEY_UNPROVABLE", "SOURCE_PAGE_MISSING", "SOURCE_MEDIA_UNAVAILABLE")
CONSEQUENCE = {"PART_OMITTED", "SECTION_OMITTED"}


NEXT_ACTION = {
    "RELEASE_CANDIDATE": "Phase 10 reconciliation + reviewed production import basis",
    "READY_EXCEPT_HUMAN_QA": "owner decisions in imports/exams/staging/qa/approvals.json (fingerprinted), then re-run",
    "TECHNICALLY_RECOVERABLE": "targeted extractor remediation of the listed groups (see remediationYield)",
    "SOURCE_BLOCKED": "none from this corpus (missing / unprovable source); never a full form, never scored without truth",
    "RUNTIME_BLOCKED": "runtime + scorer support for the listed interaction first (declared UNSUPPORTED in ExamRunnerCapabilities)",
    "NOT_RELEASEABLE": "none",
}


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def declared_interaction_support(repo_root: Path, interaction: str) -> str:
    """Declared runner support of one interaction, read from the Java mirror of the runtime capabilities
    (ExamRunnerCapabilities.java == FE runnerCapabilities.ts, contract-checked). Missing / unreadable ⇒ UNSUPPORTED."""
    java = repo_root / "backend" / "src" / "main" / "java" / "com" / "englishcoach" / "exams" / "release" / "ExamRunnerCapabilities.java"
    try:
        text = java.read_text(encoding="utf-8")
    except OSError:
        return "UNSUPPORTED"
    m = re.search(r'entry\("' + re.escape(interaction) + r'",\s*Support\.([A-Z]+)\)', text)
    return m.group(1) if m else "UNSUPPORTED"


def reason_of(d: dict, raw_test: dict) -> Optional[tuple]:
    """(reason code, evidence) for one BLOCKING extraction diagnostic; None for consequences."""
    code, detail, scope = d["code"], d.get("detail") or "", d.get("scope") or ""
    if code in CONSEQUENCE:
        return None
    identity = str((raw_test or {}).get('test_id', ''))
    owner_confirmed_family = bool(re.fullmatch(r'toeic/(?:ybm|economy)-vol-[1-9][0-9]*/test-[1-9][0-9]*', identity))
    if owner_confirmed_family and code in {
            'SOURCE_PDF_MISSING', 'SOURCE_AUDIO_UNMAPPED', 'SOURCE_AUDIO_AMBIGUOUS', 'ANSWER_KEY_NOT_FOUND',
            'ANSWER_KEY_LATTICE_CONFLICT', 'ANSWER_KEY_NUMBER_UNREAD', 'ANSWER_KEY_LETTER_UNCERTAIN',
            'ANSWER_KEY_SEQUENCE_UNPROVEN', 'ANSWER_KEY_BLOCK_UNASSIGNED'}:
        # Owner-confirmed source coverage is not qualification. These diagnostics
        # describe the current selector/OCR/mapping outcome, not a raw-source audit
        # proving absence or an irrecoverable cell. Keep recovery open.
        return 'RECOVERABLE_SOURCE_DEFECT', f'{scope}: {code} (owner-confirmed family; filesystem recovery remains open)'
    if code == "SOURCE_PDF_MISSING":
        return "SOURCE_PAGE_MISSING", f"{scope}: question book absent from the corpus"
    if code in ("SOURCE_AUDIO_UNMAPPED", "SOURCE_AUDIO_AMBIGUOUS"):
        no_audio = (raw_test or {}).get("audio_mapping_confidence") in (None, "UNMAPPED")
        return ("SOURCE_MEDIA_UNAVAILABLE" if no_audio else "STRUCTURE_AMBIGUOUS"), f"{scope}: {code}"
    if code == "ANSWER_KEY_NOT_FOUND":
        if "exists in this collection" in detail or "no reading answer key" in detail.lower():
            return "SOURCE_KEY_UNAVAILABLE", f"{scope}: no answer key in the corpus"
        return "RECOVERABLE_SOURCE_DEFECT", f"{scope}: key rows for this test not parsed (key pages exist)"
    if code in ("ANSWER_KEY_LATTICE_CONFLICT", "ANSWER_KEY_NUMBER_UNREAD", "ANSWER_KEY_LETTER_UNCERTAIN",
                "ANSWER_KEY_SEQUENCE_UNPROVEN", "ANSWER_KEY_BLOCK_UNASSIGNED"):
        return "SOURCE_KEY_UNPROVABLE", f"{scope}: {code} (scanned key cell cannot be proven)"
    if code in ("GROUP_STRUCTURE_AMBIGUOUS", "PHOTO_MAPPING_UNPROVEN", "GROUP_BOUNDARY_UNPROVEN"):
        return "STRUCTURE_AMBIGUOUS", f"{scope}: {code}"
    # parser / layout / OCR defects on source that exists (TECH codes, unreliable text layer, OCR needed, ...)
    return "RECOVERABLE_SOURCE_DEFECT", f"{scope}: {code}"


def key_coverage(pkg: dict) -> dict:
    keyed = set()
    for s in pkg.get("answerSpecs", []):
        acc = s.get("acceptedAnswers") or {}
        vals = acc.get("values") or (acc.get("unorderedSet") or {}).get("values") or []
        if any(str(v).strip() for v in vals):
            keyed.add(s["itemId"])
    obj = [i for i in pkg.get("items", []) if i.get("interactionType") in OBJECTIVE]
    return {"objectiveItems": len(obj), "keyed": sum(1 for i in obj if i["id"] in keyed),
            "coverage": round(sum(1 for i in obj if i["id"] in keyed) / len(obj), 4) if obj else None}


def raw_tests(repo_root: Path) -> dict:
    m = _load(repo_root / "imports/exams/manifests/raw-source/raw_source_manifest.json")
    out = {}

    def walk(o):
        if isinstance(o, dict):
            if "tests" in o and "book" in o:
                for t in o["tests"]:
                    out[t["test_id"]] = t
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(m)
    return out


def classify(gate: dict, reasons: list, runner_blocking: list, scoring_blocking: list, runtime_unsupported: list) -> tuple:
    codes = {r["reason"] for r in reasons}
    if gate.get("IMPORT_READY"):
        return "RELEASE_CANDIDATE", "YES"
    if gate.get("READY_EXCEPT_HUMAN_QA"):
        return "READY_EXCEPT_HUMAN_QA", "AFTER_OWNER_QA"
    if codes & set(SOURCE_REASONS):
        return "SOURCE_BLOCKED", "NO_FROM_THIS_CORPUS"
    if runner_blocking or runtime_unsupported:
        return "RUNTIME_BLOCKED", "NO_UNTIL_RUNTIME_SUPPORT"
    if reasons and codes <= {"RECOVERABLE_SOURCE_DEFECT", "STRUCTURE_AMBIGUOUS"} and not scoring_blocking:
        return "TECHNICALLY_RECOVERABLE", "AFTER_REMEDIATION"
    return "NOT_RELEASEABLE", "NO"


def build(staging_root: Path, repo_root: Path) -> dict:
    rep = staging_root / "reports"
    status = _load(rep / "staging_status.json")
    p2 = {r["file"].split("/")[-1][:-5]: r for r in _load(rep / "phase2_validation.json")["results"]}
    p4 = {r["testId"]: r for r in _load(rep / "phase4_release_readiness.json")["results"]}
    p5 = {r["testId"]: r for r in _load(rep / "phase5_import_plan.json")["results"]}
    qa = _load(rep / "qa_release_review.json").get("packages", {})
    raw = raw_tests(repo_root)
    label_assignment_support = declared_interaction_support(repo_root, "LABEL_ASSIGNMENT")
    rows, without = [], []
    for t in status["tests"]:
        tid = t["testId"]
        fam, book, test = tid.split("/")
        rt = raw.get(tid, {})
        ex = _load(rep / "extraction" / fam / f"{book}__{test}.json")
        blocking = [d for d in ex["diagnostics"] if d.get("severity") == "BLOCKING"]
        reasons = []
        for d in blocking:
            r = reason_of(d, rt)
            if r is not None:
                reasons.append({"reason": r[0], "code": d["code"], "scope": d.get("scope"), "evidence": r[1],
                                "questions": d.get("questions")})
        for k in ex.get("answerKeys", []):
            # a scanned key table read at proof standard yields no key for the skill: the printed key exists but
            # cannot be proven from this scan (lattice support recorded) -> no answer truth from this corpus
            if k.get("method") == "OCR_KEY_TABLE_V1" and not k.get("keysParsed") and k.get("keysExpected"):
                reasons.append({"reason": "SOURCE_KEY_UNPROVABLE", "code": "ANSWER_KEY_TABLE_UNPROVEN",
                                "scope": f"ANSWER_KEY/{k.get('skill')}", "questions": None,
                                "evidence": f"0/{k['keysExpected']} keys proven (lattice support {k.get('latticeSupport')})"})
        if not t.get("package"):
            disp = "SOURCE_BLOCKED" if {r["reason"] for r in reasons} & set(SOURCE_REASONS) else "TECHNICALLY_RECOVERABLE"
            without.append({"testId": tid, "extractionStatus": t["extractionStatus"], "disposition": disp,
                            "stagedPackage": False, "blockingReasons": reasons,
                            "note": "no canonical package: the source needs work outside the Phase 5 scope "
                                    "(full-book OCR / unreliable text layer)"})
            continue
        r4, r5 = p4[tid], p5[tid]
        pkg = _load(repo_root / t["package"])
        gate = r4["gate"]
        phase2 = p2[f"{book}__{test}"]["phase2"]
        runtime_unsupported = []
        for rr in reasons:
            # an IELTS group that needs its own figure (label the map / plan / diagram) maps to LABEL_ASSIGNMENT; it is a
            # runtime block only while the declared runtime does not support that interaction (ExamRunnerCapabilities).
            # Once supported (Phase 6), the unbound figure stays what it is: an extraction defect on existing source.
            if (rr["code"] == "IMAGE_NOT_BOUND" and fam == "ielts" and "LISTENING" in (rr["scope"] or "")
                    and label_assignment_support != "SUPPORTED"):
                runtime_unsupported.append({"interaction": "LABEL_ASSIGNMENT", "scope": rr["scope"],
                                            "questions": rr["questions"]})
                rr["reason"] = "UNSUPPORTED_INTERACTION"
        disp, consider = classify(gate, reasons, r4["runnerBlocking"], r4["scoringBlocking"], runtime_unsupported)
        open_qa = qa.get(tid, {}).get("openByReleasePriority", {})
        reason_codes = sorted({r["reason"] for r in reasons})
        if disp == "READY_EXCEPT_HUMAN_QA":
            reason_codes = ["HUMAN_QA_REQUIRED"]
        media_problems = sorted(set(r4["media"]["blockers"]))
        expected = 200 if fam == "toeic" else 80          # TOEIC L+R / IELTS L+R objective items
        obj = key_coverage(pkg)["objectiveItems"]
        yield_ = "HIGH" if obj >= 0.85 * expected else ("MEDIUM" if obj >= 0.4 * expected else "LOW")
        practice = phase2.get("practiceSkills", [])
        cov = key_coverage(pkg)
        rows.append({
            "testId": tid, "packageId": pkg["manifest"]["packageId"], "sourceKey": r5["identity"]["sourceKey"],
            "family": pkg["form"]["family"], "examType": f"{pkg['form']['family']} {pkg['form']['variant']}",
            "collection": pkg["manifest"]["metadata"]["sourceIdentity"].get("collection"), "book": book,
            "test": int(test.split("-")[1]),
            "packageVersion": pkg["manifest"]["packageVersion"], "manifestContentHash": pkg["manifest"]["contentHash"],
            "semanticFingerprint": r5["identity"]["semanticFingerprint"],
            "extractorVersion": r5["identity"]["extractorVersion"],
            "phase2Status": phase2["status"], "validatorVersion": phase2["validatorVersion"],
            "phase2BlockingCodes": phase2["blockingCodes"], "practiceSkills": practice,
            "simulationSkills": phase2.get("simulationSkills", []),
            "gate": {k: gate.get(k) for k in ("STRUCTURAL_VALID", "QA_APPROVED", "RUNNER_COMPATIBLE", "SCORING_COMPATIBLE",
                                              "MEDIA_READY", "PROJECT_AUTHORIZED", "PROVENANCE_COMPLETE", "IMPORT_READY",
                                              "READY_EXCEPT_HUMAN_QA")},
            "humanReviewOpenByPriority": open_qa,
            "objectiveKeyCoverage": cov,
            "sourceOrKeyProblems": [r for r in reasons if r["reason"] in SOURCE_REASONS],
            "mediaProblems": media_problems,
            "unsupportedRuntimeInteractions": runtime_unsupported + [{"code": c} for c in r4["runnerBlocking"]],
            "scoringBlocking": r4["scoringBlocking"],
            "disposition": disp, "releaseConsideration": consider, "blockingReasonCodes": reason_codes,
            "remediationYield": yield_ if disp == "TECHNICALLY_RECOVERABLE" else None,
            "nextAction": NEXT_ACTION[disp],
            "blockingReasons": reasons,
            "importPlan": {"operation": r5["localPlan"]["operation"], "contentOperation": r5["localPlan"]["contentOperation"],
                           "blockers": r5["localPlan"]["blockers"], "planId": r5["localPlan"]["planId"],
                           "productionOperation": r5["productionPlan"]["operation"]},
            "practiceValue": {"skills": practice if cov["keyed"] or not cov["objectiveItems"] else
                              [s for s in practice if s in ("WRITING", "SPEAKING")],
                              "note": None if cov["keyed"] == cov["objectiveItems"] else
                              "objective items without answer truth are never scorable practice"},
        })
    dims = Counter()
    for r in rows:
        for k, v in r["gate"].items():
            if v:
                dims[k] += 1
    by_disp = Counter(r["disposition"] for r in rows)
    out = {"generatedBy": "scripts/exam_extractor/corpus_matrix.py (Exams Recovery Phase 5A)",
           "inputs": ["staging_status.json", "extraction/**", "phase2_validation.json", "phase4_release_readiness.json",
                      "phase5_import_plan.json", "qa_release_review.json", "raw_source_manifest.json"],
           "stagedPackages": len(rows),
           "gateDimensions": {k: dims.get(k, 0) for k in ("STRUCTURAL_VALID", "QA_APPROVED", "RUNNER_COMPATIBLE",
                                                          "SCORING_COMPATIBLE", "MEDIA_READY", "PROJECT_AUTHORIZED",
                                                          "PROVENANCE_COMPLETE", "IMPORT_READY", "READY_EXCEPT_HUMAN_QA")},
           "byDisposition": {k: by_disp.get(k, 0) for k in ("RELEASE_CANDIDATE", "READY_EXCEPT_HUMAN_QA",
                                                           "TECHNICALLY_RECOVERABLE", "SOURCE_BLOCKED", "RUNTIME_BLOCKED",
                                                           "NOT_RELEASEABLE")},
           "packages": sorted(rows, key=lambda r: r["testId"]),
           "testsWithoutPackage": sorted(without, key=lambda r: r["testId"])}
    unclassified = [r["testId"] for r in rows if not r["disposition"] or (r["disposition"] != "READY_EXCEPT_HUMAN_QA"
                                                                          and r["disposition"] != "RELEASE_CANDIDATE"
                                                                          and not r["blockingReasonCodes"])]
    out["unclassified"] = unclassified
    return out


def render_md(m: dict) -> str:
    L = ["# Corpus closure matrix (Exams Recovery Phase 5A — generated from corpus_closure_matrix.json)", "",
         f"Staged packages: **{m['stagedPackages']}**", "",
         "| Gate dimension | Packages |", "|---|---|"]
    L += [f"| {k} | {v} |" for k, v in m["gateDimensions"].items()]
    L += ["", "| Disposition | Packages |", "|---|---|"]
    L += [f"| {k} | {v} |" for k, v in m["byDisposition"].items()]
    L += ["", "| Test | Phase 2 | Disposition | Reasons | Key coverage | Open QA | Import plan |", "|---|---|---|---|---|---|---|"]
    for r in m["packages"]:
        kc = r["objectiveKeyCoverage"]
        L.append(f"| {r['testId']} | {r['phase2Status']} | {r['disposition']} | {', '.join(r['blockingReasonCodes']) or '-'} | "
                 f"{kc['keyed']}/{kc['objectiveItems']} | {r['humanReviewOpenByPriority'] or '-'} | "
                 f"{r['importPlan']['operation']} ({r['importPlan']['contentOperation']}) |")
    L += ["", "Tests without a staged package (outside the 32):", ""]
    L += [f"- {w['testId']}: {w['disposition']} ({', '.join(sorted({x['reason'] for x in w['blockingReasons']})) or '-'})"
          for w in m["testsWithoutPackage"]]
    return "\n".join(L) + "\n"


def write(staging_root: Path, repo_root: Path) -> dict:
    m = build(staging_root, repo_root)
    (staging_root / "reports" / "corpus_closure_matrix.json").write_text(json.dumps(m, indent=1, ensure_ascii=False),
                                                                        encoding="utf-8")
    (staging_root / "reports" / "corpus_closure_matrix.md").write_text(render_md(m), encoding="utf-8")
    return m
