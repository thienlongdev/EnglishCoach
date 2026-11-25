"""Phase 3.5 OCR tools: answer-key table recovery reports and the OCR benchmark (structural metrics only).

Reports never contain exam text or key letters — question numbers, counts, cell statuses, pages, bboxes, hashes.
"""
from __future__ import annotations

import json
import time
from collections import Counter

from .corpus import HashCache, RawCorpusManifest, raw_abs, raw_rel
from .key_tables import alignment, read_key_page
from .layout import LayoutProfile, analyze_page, ocr_layout
from .ocr_engine import EasyOcrEngine, RegionOcrCache
from .ocr_quality import normalize_number_tokens, question_blocks, repair_option_labels, structure_metrics
from .pdf_layer import PdfTextLayer
from .staging import _write_json
from .toeic import part_of
from .diagnostics import EXTRACTOR_VERSION

# Key-table sources found by the Phase 3.5A forensics (collection profile knowledge, pages are 1-based)
KEY_SOURCES = {
    ("ets-2026", "READING"): ("toeic/ets/ETS 2026/READING ETS 2026.pdf", (302, 304), "TOEIC_LR_2016"),
    ("ets-2026", "LISTENING"): ("toeic/ets/ETS 2026/LISTENING ETS 2026.pdf", (142, 144), "TOEIC_LR_2016"),
    ("economy-vol-1", "READING"): ("toeic/economy/drive-download-20260911T144801Z-1-001/-TOEIC Economy RC 1000 Vol 1.pdf",
                                   (271, 272), "TOEIC_LR_PRE_2016"),
    ("economy-vol-1", "LISTENING"): ("toeic/economy/drive-download-20260911T144801Z-1-001/TOEIC Economy LC 1000 Vol 1.pdf",
                                     (146, 147), "TOEIC_LR_PRE_2016"),
    ("economy-vol-2", "READING"): ("toeic/economy/drive-download-20260911T144917Z-1-001/3Economy TOEIC RC 1000 volume 2.pdf",
                                   (269, 270), "TOEIC_LR_PRE_2016"),
    ("economy-vol-2", "LISTENING"): ("toeic/economy/drive-download-20260911T144917Z-1-001/TOEIC Economy LC 1000 Volume 2.PDF",
                                     (147, 148), "TOEIC_LR_PRE_2016"),
    ("ybm-vol-2", "READING"): ("toeic/ybm/YBM VOL 2/RC.pdf", (329, 338), "TOEIC_LR_2016"),
    ("economy-vol-4", "LISTENING"): ("toeic/economy/Economy TOEIC LC1000 volume 4-20260911T145033Z-1-001/Economy TOEIC LC1000 volume 4/[Nghetienganhpro].Economy TOEIC LC1000 volume 4.pdf",
                                     (164, 165), "TOEIC_LR_PRE_2016"),
    ("economy-vol-5", "LISTENING"): ("toeic/economy/drive-download-20260911T145114Z-1-001/8Economy TOEIC LC 1000 Volume 5.pdf",
                                     (158, 160), "TOEIC_LR_PRE_2016"),
}

# Benchmark pages (representative; Phase 3 had no OCR'd question pages that parsed)
BENCH_SETS = [
    {"name": "ets-2026 RC test 1 Part 5", "path": "toeic/ets/ETS 2026/READING ETS 2026.pdf", "pages": [1, 2, 3, 4],
     "questions": (101, 130)},
    {"name": "economy-vol-1 RC test 1 Part 5",
     "path": "toeic/economy/drive-download-20260911T144801Z-1-001/-TOEIC Economy RC 1000 Vol 1.pdf",
     "pages": [2, 3, 4, 5], "questions": (101, 140)},
]
BENCH_KEY = {"path": "toeic/ets/ETS 2026/READING ETS 2026.pdf", "page": 302, "test": 1}


def _layer(path: str, hashes: HashCache) -> PdfTextLayer:
    full = raw_abs(path)
    return PdfTextLayer(full, raw_rel(path), hashes.sha256(full))


def ocr_keys(args, staging) -> int:
    key = (args.book, args.skill)
    discovered = discovered_key_source(staging, args.book, args.skill)
    if discovered:
        path, pages, fmt, expected_sha = discovered
    elif key in KEY_SOURCES:
        path, window, fmt = KEY_SOURCES[key]
        pages, expected_sha = list(range(window[0], window[1] + 1)), None
    else:
        raise SystemExit(f"no proven key-table source discovered for {key}")
    if args.pages:
        a, b = (int(x) for x in args.pages.split("-"))
        pages = list(range(a, b + 1))
    print(f"planned: {len(pages)} key page(s) of {path} ({fmt})")
    hashes = HashCache(staging / "cache" / "raw_hashes.json")
    layer = _layer(path, hashes)
    if expected_sha and layer.sha256 != expected_sha:
        raise SystemExit('discovered key source bytes changed; refresh actual source inventory')
    cache = RegionOcrCache(staging / "cache" / "ocr_regions", EasyOcrEngine())
    expected = range(1, 101) if args.skill == "LISTENING" else range(101, 201)
    tests, t0 = [], time.time()
    for p in pages:
        for blk in read_key_page(layer, p, cache, expected, lambda q: part_of(q, fmt)):
            al = alignment(blk, expected)
            al["diagnostics"] = [{"code": c, "detail": d} for c, d, _q in blk.diagnostics]
            al["blockBbox"] = [round(v, 1) for v in blk.bbox]
            al["skewDeg"] = getattr(blk, "skew", 0.0)
            al["missing"] = al["missing"][:40]
            # Phase 3.6 audit: every re-read adjudication (number reads only; letters never leave the cache)
            al["adjudicated"] = [{"q": c.predicted, "numberReads": c.number_reads, "status": c.status}
                                 for c in blk.cells if getattr(c, "adjudicated", False)]
            tests.append(al)
            print(f"  p{p} TEST {blk.test}: confirmed={al['confirmed']}/100 cells={al['cellStatus']} "
                  f"lattice={al['orientation']} support={al['latticeSupport']}")
    hashes.save()
    rep = {"book": args.book, "skill": args.skill, "extractorVersion": EXTRACTOR_VERSION,
           "source": layer.rel_path, "sha256": layer.sha256, "format": fmt,
           "pages": pages, "method": "OCR_KEY_TABLE_V1", "engine": f"easyocr {cache.engine.version}",
           "tests": tests, "confirmedTotal": sum(t["confirmed"] for t in tests),
           "cellsNotConfirmed": sum(sum(v for k, v in t["cellStatus"].items() if k != "CONFIRMED") for t in tests),
           "blocksSequenceUnproven": sum(1 for t in tests if t["orientation"] is None),
           "seconds": round(time.time() - t0, 1), "ocrCache": cache.stats(),
           "note": "key letters are not reported; they are bound only inside staged packages"}
    _write_json(staging / "reports" / "ocr_keys" / f"{args.book}__{args.skill.lower()}.json", rep)
    print(json.dumps({k: rep[k] for k in ("confirmedTotal", "cellsNotConfirmed", "blocksSequenceUnproven", "seconds")}))
    return 0


def discovered_key_source(staging, book, skill):
    """Use the same exact-byte family surveys as the extractor, without per-test registration."""
    from .source_index import family_source_groups
    from .toeic_scan import PROFILES
    index_path = staging / 'phase-b/source-index.json'
    if not index_path.exists() or book not in PROFILES:
        return None
    candidates = family_source_groups(json.loads(index_path.read_text(encoding='utf-8')))['families'].get(book, [])
    eligible = {s['sha256']: s for s in candidates if s['extension'] == '.pdf' and 'path' in s
                and s['scopeCandidate'] == skill}
    sources = {}
    family = book.split('-vol-')[0]
    for name in (f'{family}-back-matter.json', f'{family}-key-candidates.json'):
        survey = staging / 'phase-b' / name
        if not survey.exists():
            continue
        for source in json.loads(survey.read_text(encoding='utf-8')).get('sources', []):
            sha = source.get('sha256')
            if sha not in eligible or source.get('path') != eligible[sha]['path']:
                continue
            pages = {k['page'] for k in source.get('keyTables', []) if k.get('scope') == skill}
            if pages:
                sources.setdefault(sha, set()).update(pages)
    if len(sources) > 1:
        raise SystemExit('ambiguous discovered key-table sources; source identity must be proven')
    if not sources:
        return None
    sha, pages = next(iter(sources.items()))
    profile = PROFILES[book]
    window = profile.key_pages.get(skill)
    pinned = profile.source_hashes.get(skill)
    if window and (not pinned or pinned == sha):
        pages.update(range(window[0], window[1] + 1))
    return eligible[sha]['path'], sorted(pages), PROFILES[book].format_version, sha


def _old_rows(layer, page: int, staging):
    """Phase 3 reference: whole-page EasyOCR at 150 dpi (OcrCache) + Phase 3 page bands."""
    from .ocr import EasyOcrAdapter, OcrCache
    from .toeic import page_bands
    cache = OcrCache(staging / "cache" / "ocr", EasyOcrAdapter())
    rows = cache.page_rows(layer, page, dpi=150)
    return page_bands(layer, page, rows) if rows is not None else []


def ocr_bench(args, staging) -> int:
    total_pages = sum(len(s["pages"]) for s in BENCH_SETS) + 1
    if total_pages > args.pages_budget:
        raise SystemExit(f"benchmark needs {total_pages} pages > budget {args.pages_budget}")
    print(f"planned: {total_pages} page(s) x variants (old whole-page; layout+detect P1; layout+lines P0/P1/P2/P3)")
    hashes = HashCache(staging / "cache" / "raw_hashes.json")
    cache = RegionOcrCache(staging / "cache" / "ocr_regions", EasyOcrEngine())
    results = []
    variants = [("OLD_WHOLE_PAGE_150DPI", None, None), ("LAYOUT_DETECT_P1_300DPI", "detect", "P1"),
                ("LAYOUT_LINES_P0_300DPI", "lines", "P0"), ("LAYOUT_LINES_P1_300DPI", "lines", "P1"),
                ("LAYOUT_LINES_P2_300DPI", "lines", "P2"), ("LAYOUT_LINES_P3_300DPI", "lines", "P3")]
    for bs in BENCH_SETS:
        layer = _layer(bs["path"], hashes)
        lo, hi = bs["questions"]
        for name, mode, prep in variants:
            t0 = time.time()
            rows = []
            for p in bs["pages"]:
                if mode is None:
                    rows.extend(_old_rows(layer, p, staging))
                else:
                    prof = LayoutProfile(name="bench", preprocess=prep)
                    lay = analyze_page(layer, p, prof)
                    rows.extend(ocr_layout(layer, lay, cache, prof, mode=mode))
            normalize_number_tokens(rows)
            before = structure_metrics(rows, list(range(lo, hi + 1)), blank_required=True)
            lab = None
            if mode == "lines":
                lab = repair_option_labels(layer, question_blocks(rows, lo, hi), cache)
            after = structure_metrics(rows, list(range(lo, hi + 1)), blank_required=True)
            results.append({"set": bs["name"], "variant": name, "pages": bs["pages"],
                            "seconds": round(time.time() - t0, 1), "metrics": after,
                            "optionLabelRecallBeforeRepair": before["optionLabelRecall"], "labelRepair": lab})
            m = after
            print(f"{bs['name']:<34} {name:<26} qnum={m['questionNumberRecall']:.3f} labels={m['optionLabelRecall']:.3f} "
                  f"inv={m['readingOrderInversions']} blanks={m['blankPreservation']} ({round(time.time() - t0, 1)}s)")
    # answer-key recall: Phase 3 sequential parser on whole-page OCR vs the Phase 3.5 key-table reader
    kl = _layer(BENCH_KEY["path"], hashes)
    from .diagnostics import DiagnosticLog
    from .ocr import EasyOcrAdapter, OcrCache
    from .pdf_layer import split_columns
    from .toeic_ocr import parse_ocr_key
    import re
    old_cache = OcrCache(staging / "cache" / "ocr", EasyOcrAdapter())
    rows = old_cache.page_rows(kl, BENCH_KEY["page"], dpi=150) or []
    w = kl.page_size(BENCH_KEY["page"])[0]
    col = [r for r in split_columns(rows, w) if r.column == 0]
    start = next((i for i, r in enumerate(col) if re.search(r"\bTEST\s*1\b(?!\d)", r.text)), None)
    stop = next((i for i in range(start + 1, len(col)) if re.search(r"\bTEST\s*\d", col[i].text)), len(col)) if start is not None else 0
    log = DiagnosticLog()
    old_keys = parse_ocr_key(col[start + 1:stop], 101, 200, log, "K") if start is not None else {}
    new_blocks = [b for b in read_key_page(kl, BENCH_KEY["page"], cache, range(101, 201)) if b.test == BENCH_KEY["test"]]
    new_keys = new_blocks[0].keys() if new_blocks else {}
    key_cmp = {"page": BENCH_KEY["page"], "test": BENCH_KEY["test"],
               "old": {"method": "Phase 3 whole-page OCR + sequence parser", "keysRead": len(old_keys),
                       "digitRepairs": sum(d.occurrences for d in log.items if d.code == "ANSWER_KEY_OCR_REPAIRED"),
                       "confidence": "PROBABLE"},
               "new": {"method": "key-table reader (cells, lattice proof, dual read, glyph check)",
                       "keysConfirmed": len(new_keys), "digitRepairs": 0, "confidence": "CONFIDENT"}}
    print("answer key", json.dumps(key_cmp))
    hashes.save()
    _write_json(staging / "reports" / "ocr_benchmark.json",
                {"engine": f"easyocr {cache.engine.version}", "variants": [v[0] for v in variants],
                 "results": results, "answerKey": key_cmp, "ocrCache": cache.stats()})
    return 0
