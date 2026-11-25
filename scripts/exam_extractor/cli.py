"""Command line: run extraction batches, then merge the Phase 2 validation result into the staging status.

  python scripts/extract_exam_packages.py extract --batch A            # 21 IELTS READY_FOR_EXTRACTION tests
  python scripts/extract_exam_packages.py extract --batch B            # other text-layer Cambridge IELTS tests
  python scripts/extract_exam_packages.py extract --batch C            # TOEIC text-layer sources (no OCR)
  python scripts/extract_exam_packages.py extract --batch D            # Phase 3 OCR sample (now layout-aware)
  python scripts/extract_exam_packages.py extract --batch E            # Phase 3.5 scanned TOEIC targets
  python scripts/extract_exam_packages.py extract --batch F            # Phase 3.5 scanned IELTS target
  python scripts/extract_exam_packages.py extract --batch G            # Phase 3.6 ETS 2026 test 3
  python scripts/extract_exam_packages.py extract --test ielts/cambridge-ielts-17/test-1 [--force]
  mvn -f backend/pom.xml test -Dtest=ExamStagingPackageValidationTest  # Phase 2 gate -> phase2_validation.json
  python scripts/extract_exam_packages.py report                       # merge -> staging_status.json / .md

Phase 3.5 tools (all bounded, cached, incremental; the planned work is printed before it starts):
  python scripts/extract_exam_packages.py ocr-keys --book ets-2026 --skill READING [--pages 302-304]
  python scripts/extract_exam_packages.py ocr-bench [--pages-budget 12]
  python scripts/extract_exam_packages.py audio-analyze --batch AUDIO-A|AUDIO-B [--render] [--no-asr]
  python scripts/extract_exam_packages.py qa-queue
  python scripts/extract_exam_packages.py metrics                      # Phase 3.6M content-factory metrics
  python scripts/extract_exam_packages.py qa-review [--all] [--no-render] # Phase 4A release QA review + local sheets
  python scripts/extract_exam_packages.py legacy-map                   # Phase 5G legacy -> canonical mapping plan
  python scripts/extract_exam_packages.py corpus-matrix                # Phase 5A corpus closure matrix (after the
                                                                       # Java ExamPhase5CorpusImportPlanTest)

Incremental by default: a test is skipped when its source hashes, audio hashes and the extractor version are
unchanged and its report exists (--force rebuilds). Never writes to imports/source-files/**.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

from .corpus import RawCorpusManifest
from .diagnostics import EXTRACTOR_VERSION
from .package_builder import PackageBuilder
from .pipeline import STAGING_ROOT, Extractor
from .staging import Staging, _write_json, extraction_status

BATCH_B_BOOKS = ("cambridge-ielts-14", "cambridge-ielts-4")
BATCH_C_BOOKS = ("ets-2019",)
BATCH_D_TESTS = ("toeic/ets-2026/test-1",)
# Phase 3.5 targets (chosen from the OCR forensics: sources holding answer-key tables / booklets)
BATCH_E_TESTS = ("toeic/ets-2026/test-1", "toeic/ets-2026/test-2", "toeic/economy-vol-1/test-1")
BATCH_F_TESTS = ("ielts/cambridge-ielts-16/test-1",)
# Phase 3.6: the third ETS 2026 test that has a recording in the corpus (tests 4-10 have none)
BATCH_G_TESTS = ("toeic/ets-2026/test-3",)
# AUDIO-A: whole-test recordings of three different producers / families
AUDIO_A_TESTS = ("toeic/economy-vol-1/test-1", "toeic/ets-2026/test-1", "ielts/cambridge-ielts-21/test-3")
# AUDIO-B (Phase 3.6): the other whole-test recordings whose question sources are staged
AUDIO_B_TESTS = ("toeic/ets-2026/test-2", "toeic/ets-2026/test-3", "ielts/cambridge-ielts-21/test-1",
                 "ielts/cambridge-ielts-21/test-2", "ielts/cambridge-ielts-21/test-4")
MAX_TESTS_PER_RUN = 12      # finite by construction: a batch never expands to the whole corpus


def select(manifest: RawCorpusManifest, batch: str) -> list:
    if batch == "A":
        return manifest.select(family="IELTS", readiness="READY_FOR_EXTRACTION")
    if batch == "B":
        return [t for t in manifest.select(family="IELTS") if t.book in BATCH_B_BOOKS
                and t.readiness != "READY_FOR_EXTRACTION"]
    if batch == "C":
        return [t for t in manifest.select(family="TOEIC") if t.book in BATCH_C_BOOKS]
    ids = {"D": BATCH_D_TESTS, "E": BATCH_E_TESTS, "F": BATCH_F_TESTS, "G": BATCH_G_TESTS, "AUDIO-A": AUDIO_A_TESTS,
           "AUDIO-B": AUDIO_B_TESTS}.get(batch)
    if ids is None:
        raise SystemExit(f"unknown batch {batch}")
    return [manifest.test(x) for x in ids if manifest.test(x)]


def inputs_of(test) -> dict:
    docs = [(d["path"], d.get("sha256")) for d in test.book_raw.get("source_documents", [])]
    audio = [(a["source"], a.get("archive_member"), a.get("sha256"), a.get("confidence")) for a in test.raw.get("audio", [])]
    return {"docs": docs, "audio": audio, "readiness": test.readiness}


def family_key_inputs(staging: Path, collection: str, source_hashes: set) -> dict:
    """Invalidate a book when either its full survey or discovery overlay changes."""
    inputs = {}
    for name in (f'{collection}-back-matter.json', f'{collection}-key-candidates.json'):
        path = staging / 'phase-b' / name
        if path.exists():
            survey = json.loads(path.read_text(encoding='utf-8'))
            inputs[name] = sorted([(source['sha256'], source.get('markers', []),
                                   [(key['scope'], key['page'], key.get('test'), key['confirmed'])
                                    for key in source.get('keyTables', [])])
                                  for source in survey.get('sources', []) if source.get('sha256') in source_hashes],
                                 key=lambda row: row[0])
    return inputs


def run_extract(args) -> int:
    manifest = RawCorpusManifest()
    ex = Extractor(manifest, STAGING_ROOT)
    staging = Staging(STAGING_ROOT)
    builder = PackageBuilder(ex.store)
    book = getattr(args, "book", None)
    tests = (ex.family_tests(book) if book else
             [manifest.test(args.test)] if args.test else select(manifest, args.batch))
    tests = [t for t in tests if t is not None]
    if not tests:
        raise SystemExit("no tests match the requested selection")
    skills = getattr(args, "skill", None)
    if skills and any(t.family != "TOEIC" for t in tests):
        raise SystemExit("--skill is currently supported only by TOEIC family recovery")
    ex.toeic_skills = tuple(skills or ("LISTENING", "READING"))
    if book and tests[0].collection in ("ybm", "economy", "cambridge"):
        from .source_index import inventory, family_source_groups
        from .corpus import RAW_ROOT
        index_path = STAGING_ROOT / 'phase-b' / 'source-index.json'
        actual_index = (json.loads(index_path.read_text(encoding='utf-8')) if index_path.is_file()
                        else inventory(RAW_ROOT, STAGING_ROOT / 'phase-b', manifest.files))
        ex.family_filesystem_sources = family_source_groups(actual_index)['families']
    if len(tests) > MAX_TESTS_PER_RUN and args.batch not in ("A", "B", "C"):
        raise SystemExit(f"refusing {len(tests)} tests in one OCR run (max {MAX_TESTS_PER_RUN})")
    batch = args.batch or (f"FAMILY_{book}" if book else "ADHOC")
    print(f"planned: {len(tests)} test(s) in batch {batch} (OCR page budget per test and skill: see scan profiles)")
    rows = []
    t0 = time.time()
    for test in tests:
        if getattr(ex, "family_filesystem_sources", None) is not None:
            from .source_index import discovered_audio
            audio = discovered_audio(test, ex.family_filesystem_sources.get(test.book, []))
            test = replace(test, raw={**test.raw, 'audio': audio})
        inputs = inputs_of(test)
        if getattr(ex, "family_filesystem_sources", None) is not None:
            inputs["familyFilesystemSources"] = [(s['sourceIdentity'], s['sha256'])
                                                for s in ex.family_filesystem_sources.get(test.book, [])]
            inputs['familyDiscoveredKeys'] = family_key_inputs(STAGING_ROOT, test.collection,
                {source['sha256'] for source in ex.family_filesystem_sources.get(test.book, [])})
        if skills:
            inputs["selectedSkills"] = sorted(set(skills))
        fp = staging.fingerprint(inputs)
        if not args.force and staging.unchanged(test.test_id, fp):
            rec = staging.cached_report(test.test_id)
            rows.append(rec)
            print(f"[skip] {test.test_id} unchanged ({rec['extractionStatus']})")
            continue
        t = ex.extract(test)
        package = None
        status = extraction_status(t)
        if status != "INVALID_SOURCE":
            summary = {"status": status, "extractorVersion": EXTRACTOR_VERSION,
                       "blockingCodes": sorted({d.code for d in t.diagnostics.items if d.severity == "BLOCKING"}),
                       "reviewCodes": sorted({d.code for d in t.diagnostics.items if d.severity == "REVIEW"})}
            corroborated = _audio_corroborated(t)
            package = builder.build(t, t.publisher, scope="FULL", extraction_summary=summary,
                                    corroborated_audio=corroborated)
            if t.family == 'TOEIC' and t.collection in ('ybm', 'economy'):
                from .toeic_completeness import assert_valid_source_parts
                try:
                    assert_valid_source_parts(package, require_full=len(package['items'])==200,
                                              require_audio=len(package['items'])==200)
                    # Technical validation reads the byte/provenance index from disk.
                    # Flush newly derived crops before evaluating their owner decision.
                    ex.store.save()
                    from .media_qa import record_owner_technical_crops, apply_crop_decisions
                    record_owner_technical_crops(package, test.test_id, STAGING_ROOT)
                    apply_crop_decisions(package, test.test_id, STAGING_ROOT)
                    from .canonical_json import package_content_hash
                    package['manifest']['contentHash'] = package_content_hash(package)
                except (AssertionError, KeyError, TypeError, ValueError) as exc:
                    t.diagnostics.add('SOURCE_PART_EXTRACTION_INVALID', 'TEST', str(exc))
                    package = None
        rep = staging.write(t, package, fp, batch)
        staging.save()
        ex.hashes.save()
        ex.store.save()
        rows.append(rep)
        s = rep["summary"]
        print(f"[{rep['extractionStatus']:<15}] {test.test_id:<40} items={s['itemsEmitted']:>3} keys={s['answerKeysBound']:>3} "
              f"blocking={s['diagnosticCounts']['BLOCKING']}")
    staging.save()
    ex.hashes.save()
    ex.store.save()
    rc = getattr(ex, "_region_cache", None)
    summary = {"batch": batch, "extractorVersion": EXTRACTOR_VERSION, "tests": len(rows),
               "byStatus": dict(Counter(r["extractionStatus"] for r in rows)),
               "topBlockingCodes": Counter(d["code"] for r in rows for d in r["diagnostics"]
                                           if d["severity"] == "BLOCKING").most_common(15),
               "seconds": round(time.time() - t0, 1),
               "ocrCache": rc.stats() if rc is not None else None,
               "results": [{"testId": r["testId"], "status": r["extractionStatus"], "package": r["package"]["path"],
                            "items": r["summary"]["itemsEmitted"], "keys": r["summary"]["answerKeysBound"]} for r in rows]}
    if args.batch or book:
        _write_json(STAGING_ROOT / "reports" / f"batch_{batch}.json", summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=1))
    return 0


def _audio_corroborated(t) -> bool:
    """A PROBABLE audio mapping counts only when the whole listening section is covered by distinct recordings
    of plausible duration under one naming rule (structure + duration confirm the naming convention)."""
    sec = t.section("LISTENING")
    if sec is None:
        return False
    bindings = [b for p in sec.parts for b in p.audio]
    whole = [b for b in bindings if (b.scope or "").startswith("WHOLE")]
    if whole:
        # one file per test, named per test, with a whole-listening duration: the convention is corroborated
        return len(whole) == 1 and all(b.technical_qa.get("decodable") for b in whole) and \
            900 <= whole[0].duration_ms / 1000 <= 3600
    if t.family == "IELTS":
        return (len(sec.parts) == 4 and len({b.sha256 for b in bindings}) == 4
                and len({b.rule for b in bindings}) == 1 and all(b.technical_qa.get("decodable") for b in bindings))
    return bool(bindings) and all(b.technical_qa.get("decodable") for b in bindings)


def run_report(args) -> int:
    from .report import merge_reports
    merge_reports(STAGING_ROOT)
    return 0


def run_ocr_keys(args) -> int:
    from .ocr_tools import ocr_keys
    return ocr_keys(args, STAGING_ROOT)


def run_ocr_bench(args) -> int:
    from .ocr_tools import ocr_bench
    return ocr_bench(args, STAGING_ROOT)


def run_audio(args) -> int:
    from .audio_segment import analyze_recording, render_confident
    from .corpus import HashCache, raw_abs
    manifest = RawCorpusManifest()
    book = getattr(args, 'book', None)
    tests = ([t for t in manifest.tests if t.book == book] if book else
             [manifest.test(args.test)] if args.test else select(manifest, args.batch or "AUDIO-A"))
    tests = [t for t in tests if t is not None]
    if not tests or len(tests) > MAX_TESTS_PER_RUN:
        raise SystemExit('audio selection must contain 1-12 tests')
    hashes = HashCache(STAGING_ROOT / "cache" / "raw_hashes.json")
    plan = [(t, a) for t in tests for a in t.raw.get("audio", []) if (a.get("scope") or "").startswith("WHOLE")]
    print(f"planned: {len(plan)} whole-test recording(s), "
          f"~{round(sum(float(a.get('duration_s') or 0) for _t, a in plan) / 60, 1)} min of audio")
    out = []
    for t, a in plan:
        if a.get("archive_member"):
            import hashlib, zipfile
            with zipfile.ZipFile(raw_abs(a["source"])) as z:
                sha = hashlib.sha256(z.read(a["archive_member"])).hexdigest()
        else:
            sha = hashes.sha256(raw_abs(a["source"]))
        from .toeic_scan import PROFILES
        profile = PROFILES.get(t.book)
        fmt = (profile.format_version if profile else "TOEIC_LR_2016") if t.family == "TOEIC" else None
        data = analyze_recording(STAGING_ROOT, a["source"], sha, t.family, fmt, a.get("archive_member"), args.force,
                                 asr=not args.no_asr)
        rendered = render_confident(STAGING_ROOT, data, a.get("archive_member")) if args.render else 0
        seg = Counter(s["tier"] for s in data.get("segments", []))
        out.append({"testId": t.test_id, "parentSha256": sha, "durationS": data["durationS"],
                    "model": data.get("model"), "checks": data.get("checks"), "classes": data.get("classes"),
                    "boundaries": data.get("boundaries"), "segmentTiers": dict(seg), "rendered": rendered,
                    "asrCues": data.get("asrCues")})
        print(f"{t.test_id:<38} {data.get('model'):<22} segments={dict(seg)} rendered={rendered}")
    hashes.save()
    # one report for every analysed recording (batches merge by parent hash)
    rep_path = STAGING_ROOT / "reports" / "audio_segmentation.json"
    prior = json.loads(rep_path.read_text(encoding="utf-8")).get("recordings", []) if rep_path.exists() else []
    merged = {r["parentSha256"]: r for r in prior}
    merged.update({r["parentSha256"]: r for r in out})
    from .audio_segment import ANALYSIS_VERSION
    _write_json(rep_path, {"analysisVersion": ANALYSIS_VERSION, "recordings": sorted(merged.values(), key=lambda r: r["testId"]),
                           "rawAudioModified": False})
    return 0


def run_metrics(args) -> int:
    from .metrics import content_metrics
    m = content_metrics(STAGING_ROOT)
    print(json.dumps({"families": list(m["family"]), "tests": len(m["tests"]), "generatedExams": m["generatedExams"]}))
    return 0


def run_qa(args) -> int:
    from .qa_queue import build_queue
    q = build_queue(STAGING_ROOT)
    print(json.dumps(q["summary"], indent=1))
    return 0


def run_qa_review(args) -> int:
    from .qa_review import review_queue
    r = review_queue(STAGING_ROOT, render=not args.no_render, only_release_candidates=not args.all)
    print(json.dumps(r["summary"], indent=1))
    return 0


def run_legacy_map(args) -> int:
    from .legacy_mapping import write
    out = write(STAGING_ROOT, STAGING_ROOT.parents[2])
    print(json.dumps({k: out[k] for k in ("legacyPackages", "byStatus", "canonicalSourcesWithExactLegacy")}, indent=1))
    return 0


def run_corpus_matrix(args) -> int:
    """Phase 5A matrix (needs phase5_import_plan.json from ExamPhase5CorpusImportPlanTest), then the Phase 5G
    legacy mapping again with the canonical dispositions."""
    from .corpus_matrix import write
    from .legacy_mapping import write as write_mapping
    m = write(STAGING_ROOT, STAGING_ROOT.parents[2])
    write_mapping(STAGING_ROOT, STAGING_ROOT.parents[2], {r["sourceKey"]: r["disposition"] for r in m["packages"]})
    print(json.dumps({k: m[k] for k in ("stagedPackages", "gateDimensions", "byDisposition", "unclassified")}, indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="extract_exam_packages")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    selection = e.add_mutually_exclusive_group(required=True)
    selection.add_argument("--batch", choices=["A", "B", "C", "D", "E", "F", "G"])
    selection.add_argument("--test")
    selection.add_argument("--book", help="bounded batch of every test in one source volume (max 12)")
    e.add_argument("--force", action="store_true")
    e.add_argument("--skill", choices=["LISTENING", "READING"], action="append",
                   help="TOEIC recovery scope; repeat for both (default both)")
    sub.add_parser("report")
    k = sub.add_parser("ocr-keys")
    k.add_argument("--book", required=True)
    k.add_argument("--skill", choices=["READING", "LISTENING"], default="READING")
    k.add_argument("--pages", help="first-last key pages (default: the scan profile's key window)")
    b = sub.add_parser("ocr-bench")
    b.add_argument("--pages-budget", type=int, default=12)
    a = sub.add_parser("audio-analyze")
    audio_selection = a.add_mutually_exclusive_group()
    audio_selection.add_argument("--batch", choices=["AUDIO-A", "AUDIO-B"])
    audio_selection.add_argument("--test")
    audio_selection.add_argument("--book", help="bounded whole-test audio analysis for one source volume")
    a.add_argument("--render", action="store_true", help="physically render CONFIDENT segments only")
    a.add_argument("--force", action="store_true")
    a.add_argument("--no-asr", action="store_true", help="pause structure only (no spoken-cue recognition)")
    sub.add_parser("qa-queue")
    sub.add_parser("metrics")
    q = sub.add_parser("qa-review")
    q.add_argument("--all", action="store_true", help="render reviewer sheets for every package, not only release candidates")
    q.add_argument("--no-render", action="store_true")
    sub.add_parser("legacy-map")
    sub.add_parser("corpus-matrix")
    source_index = sub.add_parser("source-index", help="owner-authorized recursive read-only raw filesystem/archive inventory")
    source_modes = source_index.add_mutually_exclusive_group()
    source_modes.add_argument("--scan-family", choices=["ybm", "economy"],
                              help="cached OCR search of actual family PDF back matter")
    source_modes.add_argument("--refresh-cached-family", choices=["ybm", "economy"],
                              help="reparse completed survey sources with current key discovery without overwriting a running survey")
    args = ap.parse_args(argv)
    if args.cmd == "extract":
        return run_extract(args)
    if args.cmd == "ocr-keys":
        return run_ocr_keys(args)
    if args.cmd == "ocr-bench":
        return run_ocr_bench(args)
    if args.cmd == "audio-analyze":
        return run_audio(args)
    if args.cmd == "qa-queue":
        return run_qa(args)
    if args.cmd == "metrics":
        return run_metrics(args)
    if args.cmd == "qa-review":
        return run_qa_review(args)
    if args.cmd == "legacy-map":
        return run_legacy_map(args)
    if args.cmd == "corpus-matrix":
        return run_corpus_matrix(args)
    if args.cmd == "source-index":
        from .source_index import run_source_index
        return run_source_index(args, STAGING_ROOT)
    return run_report(args)


if __name__ == "__main__":
    sys.exit(main())
