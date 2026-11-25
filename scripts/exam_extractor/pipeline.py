"""Per-test orchestration: source checks -> structure -> keys -> media -> canonical package -> staging report."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Optional

from .adapters import adapter_for
from .adapters.base import QUESTIONS, TRANSCRIPT
from .answer_keys import parse_key_rows, resolve_key
from .corpus import REPO_ROOT, HashCache, RawCorpusManifest, TestRecord, raw_abs, raw_rel
from .diagnostics import (BLOCKING, CONFIDENT, PROBABLE, REVIEW, DiagnosticLog, page_range)
from .ielts import (extract_listening, extract_reading, extract_speaking, extract_writing, skill_key_rows)
from .ielts_groups import parse_range, row_text
from .media import AssetStore, IELTS_PART_SECONDS, WHOLE_LISTENING_SECONDS, bind_audio
from .model import ExtractedTest, Section, SourceDocument
from .pdf_layer import PdfTextLayer

STAGING_ROOT = REPO_ROOT / "imports" / "exams" / "staging"

# Phase 3.5 scanned IELTS books: page windows read from the book's printed contents page (PDF page = book page + 1
# for Cambridge 16). Only these windows are OCR'd (finite budget); everything else stays OCR_REQUIRED.
IELTS_SCAN_PROFILES = {
    "cambridge-ielts-11": {
        # This compiled scan omits the contents pages. Its own chapter headings
        # and key badges establish all four windows; no textbook offset is reused.
        "source_sha256": "41042360d098946cae5c68961ba639b23ac665bda781da3b7e16396d7193121c",
        "test_pages": {1: (8, 32), 2: (33, 56), 3: (57, 79), 4: (80, 102)},
        "key_pages_by_test": {1: (124, 125), 2: (126, 127), 3: (128, 129), 4: (130, 131)},
        "budget": 28,
    },
    "cambridge-ielts-19": {
        "source_sha256": "5c90a5e726950294982f8971a1c15b1ccd74fff6e7d8c040d602116825ad6f38",
        "test_pages": {1: (9, 31), 2: (32, 53), 3: (54, 76), 4: (77, 97)},
        "key_pages_by_test": {1: (119, 120), 2: (121, 122), 3: (123, 124), 4: (125, 126)},
        "budget": 25,
    },
    "cambridge-ielts-12": {
        # Printed contents (PDF3) and own chapter headings match PDF numbering.
        # Reading keys continue the explicitly labelled Listening key chapter.
        "source_sha256": "d86604dbe2245f4873206e2f44ae3de21295f41e10d4e3f3b4613f91c4288185",
        "test_pages": {5: (10, 29), 6: (30, 52), 7: (53, 73), 8: (74, 94)},
        "key_pages_by_test": {5: (116, 117), 6: (118, 119), 7: (120, 121), 8: (122, 123)},
        "budget": 25,
    },
    "cambridge-ielts-6": {
        # Per-test immutable PDFs: Test1 includes printed keys; Tests2–4 end at Speaking.
        # The separate retyped key differs from printed truth and is not used here.
        "source_sha256_by_test": {
            1: "02b1c74296b6585303273a4eacbc33e973788891e3a37a234bff33ab01cd8761",
            2: "0322233ce0644024319c45ec67fcbaa60a2be64e8ad149c5293b72ee9f23a756",
            3: "d4ed25cc3e64913b7d969b8b31057a3e78878da93ca9e5724e3a2010b2fc1413",
            4: "c0c2e814bed5af59401f65bfeb22131968dbf1f40ac46ac05e734f25a74b6f53",
        },
        "test_pages": {1: (5, 27), 2: (1, 22), 3: (1, 24), 4: (1, 24)},
        "key_pages_by_test": {1: (28, 29), 2: (0, -1), 3: (0, -1), 4: (0, -1)},
        "key_test_from_source": {1: 1}, "budget": 25,
    },
    # This exact compiled source starts at printed Test1 and ends at Test4's Reading key.
    # Read its whole bounded graph and let printed headings assign identities; no inferred page offsets.
    "cambridge-ielts-14": {
        "source_sha256": "5e6dca0a8d3f1c011f57b7ad8faca7272ff888e2a12c0f99c078fb4359cf5302",
        "test_pages": {n: (1, 95) for n in range(1, 5)}, "whole_book": True, "force_ocr": True, "budget": 95,
        "key_pages": (88, 95),  # printed Test1 Listening through Test4 Reading, exact source above
    },
    "cambridge-ielts-16": {
        "source_sha256": "618f6c90c14ecba0ef99eeddf40a3c8dd71138d20670b56bc6968e4f8d420b2d",
        "test_pages": {1: (11, 32), 2: (33, 55), 3: (56, 76), 4: (77, 98)},
        "key_pages_by_test": {1: (122, 123), 2: (124, 125), 3: (126, 127), 4: (128, 129)},
        "budget": 26,
    },
}


def text_layer_quality(layer: PdfTextLayer, pages: list) -> tuple:
    """(reliable, metrics): Cyrillic homoglyphs / symbol debris mark an unusable OCR text layer."""
    alpha, cyr, weird, total = 0, 0, 0, 0
    for p in pages[:40]:
        for r in layer.rows(p):
            for t in r.tokens:
                s = t.text
                if not s.strip() or s == "……":
                    continue
                total += 1
                if any(ch.isalpha() for ch in s):
                    alpha += 1
                if any("CYRILLIC" in unicodedata.name(ch, "") for ch in s):
                    cyr += 1
                if re.search(r"[~^\\{}|]|[a-z][A-Z]{2,}[a-z]", s):
                    weird += 1
    metrics = {"tokens": total, "cyrillicTokens": cyr, "debrisTokens": weird}
    if total < 200:
        return False, metrics
    reliable = cyr / max(alpha, 1) < 0.002 and weird / total < 0.02
    return reliable, metrics


class Extractor:
    def __init__(self, manifest: Optional[RawCorpusManifest] = None, staging_root: Path = STAGING_ROOT):
        self.manifest = manifest or RawCorpusManifest()
        self.staging = staging_root
        self.hashes = HashCache(staging_root / "cache" / "raw_hashes.json")
        self.store = AssetStore(staging_root)
        self._layers: dict = {}
        self._streams: dict = {}

    def family_tests(self, book: str) -> list:
        """Supplement incomplete manifest identities from own printed chapter badges."""
        tests=list(self.manifest.select(book=book))
        if book == 'ets-2026' and tests:
            # The manifest indexed only the three tests with recordings. The
            # Reading book's own complete numbered key tables establish other
            # source identities; question runs must still validate extraction.
            from copy import deepcopy
            from .toeic_scan import ScanContext, PROFILES, key_blocks
            doc = next((d for d in tests[0].book_raw.get('source_documents', [])
                        if d.get('scope') == 'READING' and d.get('role') == 'QUESTION_BOOK'), None)
            layer = self.layer(doc['path'], DiagnosticLog(), 'FAMILY_DISCOVERY') if doc else None
            if layer is not None:
                ctx = ScanContext(self,layer,self.region_cache(),deepcopy(PROFILES[book]),DiagnosticLog(),self.store)
                blocks = key_blocks(ctx,'READING',range(101,201),'TOEIC_LR_2016')
                existing = {t.test_number for t in tests}
                basis = tests[0]
                for number,block in sorted(blocks.items()):
                    if (number in existing or not 1 <= number <= 10 or block is None
                            or sorted(block.keys()) != list(range(101,201))):
                        continue
                    tid = f'toeic/{book}/test-{number}'
                    raw = {'test_id':tid,'test_number':number,'audio':[],
                           'identified_by':['OWN_COMPLETE_PRINTED_READING_KEY_TABLE'],
                           'extraction_readiness':'NEEDS_REVIEW','answer_key_status':'KEY_PRESENT',
                           'flags':['PIPELINE_DISCOVERED_PRINTED_KEY_TABLE'],
                           'discovery':{'source':doc['path'],'sha256':layer.sha256,
                                        'page':block.page,'printedTest':number}}
                    tests.append(TestRecord(basis.family,basis.collection,book,basis.book_title,tid,
                                            number,raw,basis.book_raw))
                return sorted(tests,key=lambda t:t.test_number)
        profile=IELTS_SCAN_PROFILES.get(book)
        books=getattr(self.manifest,'books',{})
        if book in books and books[book][1]=='practice-tests-plus':
            from .family_discovery import discover_cambridge_family
            discovered,discovered_profile=discover_cambridge_family(self,book)
            if discovered_profile:
                IELTS_SCAN_PROFILES[book]=discovered_profile
                return discovered
        if not tests and book in self.manifest.books:
            from .family_discovery import discover_cambridge_family
            discovered,discovered_profile=discover_cambridge_family(self,book)
            if discovered_profile:
                IELTS_SCAN_PROFILES[book]=discovered_profile
            return discovered
        if not tests or not profile or not profile.get('source_sha256'):
            return tests
        missing=set(profile['test_pages'])-{t.test_number for t in tests}
        if not missing:
            return tests
        documents=tests[0].book_raw.get('source_documents',[])
        sources=[d for d in documents if d.get('sha256')==profile['source_sha256']]
        if len(sources)!=1:
            return tests
        layer=self.layer(sources[0]['path'],DiagnosticLog(),'FAMILY_DISCOVERY')
        if layer is None or layer.sha256!=profile['source_sha256']:
            return tests
        cache=self.region_cache()
        for expected in sorted(missing):
            page=profile['test_pages'][expected][0]
            w,h=layer.page_size(page)
            detected=cache.recognize(layer,page,(0,0,w,.25*h),dpi=200,pipeline='P0')
            candidates=[word for word in (detected.words if detected else [])
                        if re.fullmatch(r'TEST\s*\d{1,2}',word.text.strip(),re.I)]
            if len(candidates)!=1:
                continue
            badge=candidates[0];x0,y0,x1,y1=badge.bbox
            height=y1-y0
            box=(max(0,x0-.2*height),max(0,y0-.2*height),min(w,x1+.2*height),min(h,y1+.2*height))
            reads=[]
            for prep in ('P0','P2'):
                result=cache.recognize(layer,page,box,dpi=300,pipeline=prep,
                    allowlist='TESTtest0123456789',boxes_pt=[box])
                if not result or len(result.words)!=1 or result.words[0].conf<.85:
                    break
                text=re.sub(r'\s+','',result.words[0].text).upper()
                match=re.fullmatch(r'TEST(\d{1,2})',text)
                if not match:break
                reads.append(int(match[1]))
            if reads != [expected,expected]:
                continue
            basis=tests[0]
            raw={'test_id':f'{basis.family.lower()}/{book}/test-{reads[0]}','test_number':reads[0],
                 'identified_by':['OWN_PRINTED_CHAPTER_DUAL_READ'],'source_documents':[],
                 'audio':[],'extraction_readiness':'NEEDS_REVIEW','answer_key_status':'UNKNOWN_NEEDS_OCR',
                 'transcript_status':'UNKNOWN_NEEDS_OCR','flags':['PIPELINE_DISCOVERED_PRINTED_CHAPTER'],
                 'discovery':{'source':sources[0]['path'],'sha256':layer.sha256,'page':page,'printedTest':reads[0]}}
            tests.append(TestRecord(basis.family,basis.collection,book,basis.book_title,raw['test_id'],reads[0],raw,basis.book_raw))
        return sorted(tests,key=lambda t:t.test_number)

    # ── sources ──────────────────────────────────────────────────────────────────────────

    def layer(self, corpus_path: str, log: DiagnosticLog, scope: str = "SOURCE") -> Optional[PdfTextLayer]:
        if corpus_path in self._layers:
            return self._layers[corpus_path]
        try:
            full = raw_abs(corpus_path)
        except ValueError:
            log.add("SOURCE_PDF_MISSING", scope, "outside raw corpus")
            return None
        if not full.exists():
            log.add("SOURCE_PDF_MISSING", scope, "file not found")
            return None
        rec = self.manifest.file_record(corpus_path) or {}
        sha = self.hashes.sha256(full)
        if rec.get("sha256") and rec["sha256"] != sha:
            log.add("SOURCE_HASH_MISMATCH", scope, "PDF changed since the Phase 1 manifest")
            return None
        try:
            layer = PdfTextLayer(full, raw_rel(corpus_path), sha)
        except Exception:
            log.add("SOURCE_PDF_UNREADABLE", scope, "PDF cannot be opened")
            return None
        self._layers[corpus_path] = layer
        return layer

    def region_cache(self):
        if getattr(self, "_region_cache", None) is None:
            from .ocr_engine import EasyOcrEngine, RegionOcrCache
            self._region_cache = RegionOcrCache(self.staging / "cache" / "ocr_regions", EasyOcrEngine())
        return self._region_cache

    def stream(self, adapter, layer: PdfTextLayer) -> list:
        key = layer.rel_path
        if key not in self._streams:
            w, h = layer.page_size(1)
            self._streams[key] = adapter.annotate([(p, layer.rows(p)) for p in range(1, layer.page_count + 1)], w, h)
        return self._streams[key]

    # ── IELTS ────────────────────────────────────────────────────────────────────────────

    def extract(self, test: TestRecord) -> ExtractedTest:
        adapter = adapter_for(test)
        t = ExtractedTest(test_id=test.test_id, family=test.family,
                          variant=adapter.variant(test) if adapter else "ACADEMIC", collection=test.collection,
                          book=test.book, book_title=test.book_title, test_number=test.test_number,
                          publisher=adapter.publisher if adapter else "UNKNOWN",
                          readiness_phase1=test.readiness, raw_manifest_ref=test.test_id)
        log = t.diagnostics
        if adapter is None:
            log.add("SOURCE_ADAPTER_UNSUPPORTED", "TEST", "no collection adapter for this source; not proof of missing source")
            return t
        if test.family == "IELTS":
            self._extract_ielts(test, adapter, t)
        elif adapter.name == "toeic-scanned-ocr":
            # Phase 3.5: layout-aware OCR (region cache); the Phase 3 whole-page path (toeic_ocr.py) is kept only
            # as the benchmark reference
            from .ocr_engine import EasyOcrEngine, RegionOcrCache
            from .toeic_scan import extract_toeic_scanned
            extract_toeic_scanned(self, test, t, self.region_cache())
        else:
            from .toeic import extract_toeic
            extract_toeic(self, test, adapter, t)
        return t

    def _extract_ielts(self, test: TestRecord, adapter, t: ExtractedTest) -> None:
        log = t.diagnostics
        docs = adapter.question_documents(test, self.manifest)
        if not docs:
            code='QUESTION_SOURCE_SELECTION_UNRESOLVED' if any(d.get('path','').lower().endswith('.pdf') for d in test.book_raw.get('source_documents',[])) else 'SOURCE_PDF_MISSING'
            log.add(code, "TEST", "no proven question document selected from the indexed sources")
            return
        doc = docs[0]
        rec = next((d for d in test.book_raw["source_documents"] if d["path"] == doc), {})
        ocr = False
        prof = IELTS_SCAN_PROFILES.get(test.book)
        if rec.get("text_layer") == "SCANNED" or (prof and prof.get("force_ocr")):
            if prof is None or test.test_number not in prof["test_pages"]:
                log.add("PDF_NO_TEXT_LAYER", "TEST", "scanned question book")
                log.add("OCR_REQUIRED", "TEST", "question book needs OCR (outside the Phase 3.5 target batch)")
                return
            ocr = True
        layer = self.layer(doc, log)
        if layer is None:
            return
        expected_sha = (prof.get("source_sha256_by_test", {}).get(test.test_number)
                        or prof.get("source_sha256")) if ocr else None
        if ocr and expected_sha != layer.sha256:
            log.add("SOURCE_PAGE_RANGE_UNCERTAIN", "TEST", "scan profile does not cover this source hash")
            return
        t.documents.append(SourceDocument(layer.rel_path, layer.sha256, rec.get("role", "QUESTION_BOOK"),
                                          rec.get("text_layer", "?"), layer.page_count))
        if ocr:
            stream = self._ocr_stream(adapter, layer, IELTS_SCAN_PROFILES[test.book], test.test_number, t)
            if stream is None:
                return
        else:
            t.extraction_methods.add("NATIVE_TEXT")
            stream = self.stream(adapter, layer)
        q = [a for a in stream if a.region == QUESTIONS and a.test == test.test_number]
        if not q and ocr:
            log.add("TEST_BOUNDARY_NOT_FOUND", "TEST", "no OCR question rows for this test number")
            return
        if not q:
            blank = sum(1 for p in range(1, layer.page_count + 1) if len(layer.raw_text(p).strip()) < 200)  # watermark-only pages count
            if blank >= 0.2 * layer.page_count:
                log.add("PDF_NO_TEXT_LAYER", "TEST", f"{blank}/{layer.page_count} pages have no text layer")
                log.add("OCR_REQUIRED", "TEST", "this test's pages are image-only (Phase 3.5)")
            else:
                text_pages = [p for p in range(1, layer.page_count + 1) if layer.raw_text(p).strip()]
                ok, metrics = text_layer_quality(layer, text_pages[10:50])
                if not ok:
                    log.add("TEXT_LAYER_UNRELIABLE", "TEST",
                            f"cyrillic={metrics['cyrillicTokens']} debris={metrics['debrisTokens']} (book sample)")
            log.add("TEST_BOUNDARY_NOT_FOUND", "TEST", "no question rows for this test number")
            return
        pages = sorted({a.row.page for a in q})
        reliable, metrics = (True, {}) if ocr else text_layer_quality(layer, pages)
        if not reliable and metrics["tokens"] < 200:
            log.add("PDF_NO_TEXT_LAYER", "TEST", f"only {metrics['tokens']} text tokens on this test's pages",
                    pages=page_range(pages))
            log.add("OCR_REQUIRED", "TEST", "this test's pages are image-only (Phase 3.5)")
            return
        if not reliable:
            log.add("TEXT_LAYER_UNRELIABLE", "TEST", f"cyrillic={metrics['cyrillicTokens']} debris={metrics['debrisTokens']} "
                    f"tokens={metrics['tokens']}", pages=page_range(pages))
            return

        def rows(skill):
            return [a.row for a in q if a.skill == skill]

        # Listening ------------------------------------------------------------------------
        lrows = rows("LISTENING")
        if lrows:
            parts = extract_listening(lrows, "LISTENING", log, ocr, layer, self.store)
            bindings = bind_audio(test.raw, "IELTS", self.hashes, log)
            parts = self._bind_ielts_audio(parts, bindings, t, log)
            last = _max_marker(lrows) or 40
            parts = self._attach_keys(parts, stream, test.test_number, "LISTENING", layer, last, log, t)
            if parts:
                sec = Section("LISTENING", parts=parts, pages=sorted({p for x in parts for p in x.pages}))
                t.sections.append(sec)
            else:
                log.add("SECTION_OMITTED", "LISTENING", "no complete part")
        else:
            log.add("SECTION_NOT_FOUND", "LISTENING")
        # Reading --------------------------------------------------------------------------
        rrows = rows("READING")
        if rrows:
            parts = extract_reading(rrows, "READING", log, ocr)
            last = _max_marker(rrows) or 40
            parts = self._attach_keys(parts, stream, test.test_number, "READING", layer, last, log, t)
            if parts:
                t.sections.append(Section("READING", parts=parts, pages=sorted({p for x in parts for p in x.pages})))
            else:
                log.add("SECTION_OMITTED", "READING", "no complete passage")
        else:
            log.add("SECTION_NOT_FOUND", "READING")
        # Writing --------------------------------------------------------------------------
        wrows = rows("WRITING")
        tasks = extract_writing(wrows, "WRITING", log, layer, self.store, t.variant == "ACADEMIC") if wrows else []
        if tasks:
            t.sections.append(Section("WRITING", writing_tasks=tasks, pages=sorted({p for x in tasks for p in x.pages})))
        else:
            log.add("SECTION_OMITTED", "WRITING", "no task extracted")
        # Speaking -------------------------------------------------------------------------
        srows = rows("SPEAKING")
        sparts = extract_speaking(srows, "SPEAKING", log, layer) if srows else []
        if sparts:
            t.sections.append(Section("SPEAKING", speaking_parts=sparts, pages=sorted({p for x in sparts for p in x.pages})))
        else:
            log.add("SPEAKING_PROMPTS_NOT_FOUND", "SPEAKING")
        # Transcript references (never text) --------------------------------------------------
        tr = [a.row.page for a in stream if a.region == TRANSCRIPT and a.test == test.test_number]
        if tr:
            t.transcript_refs.append({"path": layer.rel_path, "sha256": layer.sha256, "pages": page_range(tr)})
            log.add("TRANSCRIPT_REFERENCED", "LISTENING", "audioscript pages referenced, text not embedded",
                    pages=page_range(tr))
        else:
            log.add("TRANSCRIPT_NOT_FOUND", "LISTENING")
        log.add("PUBLISHER_LICENCE_NOT_ESTABLISHED", "TEST", "third-party publication; publisher licence UNKNOWN / PENDING (unchanged)")
        log.add("PROJECT_USAGE_OWNER_AUTHORIZED", "TEST", "project-owner authorization 2026-10-03 (not a publisher licence)")

    def _ocr_stream(self, adapter, layer, prof: dict, test_no: int, t: ExtractedTest):
        """Annotated row stream of a scanned IELTS book from layout-aware OCR (bounded page windows)."""
        from .layout import LayoutProfile, analyze_page, inverse_rows, merge_by_y, ocr_layout, page_scaled_profile
        from .ocr_quality import normalize_number_tokens, reread_gap_numbers
        log = t.diagnostics
        cache = self.region_cache()
        if not cache.engine.available():
            log.add("OCR_UNAVAILABLE", "TEST", "no OCR engine installed")
            return None
        a, b = prof["test_pages"][test_no]
        whole_book = prof.get("whole_book", False)
        ka, kb = (prof.get("key_pages", (0, -1)) if whole_book else
                  (prof["key_pages_by_test"][test_no] if "key_pages_by_test" in prof else prof["key_pages"]))
        pages = sorted(set(range(a, b + 1)) | set(range(ka, kb + 1)))
        if len(pages) > prof["budget"]:
            log.add("OCR_BUDGET_EXHAUSTED", "TEST", f"{len(pages)} pages > budget {prof['budget']}")
            return None
        lp = LayoutProfile(name=f"{t.book}")
        out, keys = [], []
        reread = 0
        for p in pages:
            # Preserve proven key reads; question pages use their own physical
            # dimensions to avoid magnifying scan artifacts into fake glyphs.
            own_lp = lp if ka <= p <= kb else page_scaled_profile(*layer.page_size(p), lp)
            lay = analyze_page(layer, p, own_lp)
            rows = merge_by_y(ocr_layout(layer, lay, cache, own_lp), inverse_rows(layer, lay, cache))
            normalize_number_tokens(rows)
            if not whole_book and not ka <= p <= kb:
                from .ielts_key_ocr import normalize_chapter_headings
                normalize_chapter_headings(layer, rows)
                reread += reread_gap_numbers(layer, rows, cache)
            (keys if ka <= p <= kb else out).append((p, rows))
        if reread:
            log.add("GAP_NUMBER_GEOMETRY", "TEST", f"{reread} gap numbers re-read from the ink left of their blank "
                                                   f"(digits only; accepted only in printed sequence)")
        t.extraction_methods.add("OCR")
        t.ocr_pages.setdefault(layer.rel_path, set()).update(pages)
        log.add("OCR_LAYOUT_USED", "TEST", f"layout-aware OCR pages={len(pages)}", pages=page_range(pages))
        log.add("OCR_TEXT_USED", "TEST", "OCR text: character errors possible (human proofreading required)")
        w, h = layer.page_size(a)
        # Hash-pinned contents windows contain questions only. A map legend named "Key"
        # cannot move the remaining question pages into back matter.
        annotation_args=dict(question_window=not whole_book or bool(keys))
        identity=prof.get('printed_identity_proofs',{}).get(test_no)
        if identity and identity.get('printedTest')==test_no and identity.get('page')==a:
            annotation_args['proven_test']=test_no
        stream = adapter.annotate(out, w, h, **annotation_args)
        # answer-key window (from the book's printed contents page): a row is a key row only after the page's own
        # 'TEST n' badge and a LISTENING / READING marker; the heading itself may be split / misread by OCR
        from difflib import SequenceMatcher
        from .adapters.base import ANSWER_KEY, AnnotatedRow
        test = prof.get("key_test_from_source", {}).get(test_no)
        for p, rows in keys:
            if not any(re.fullmatch(r'(?:LISTENING|READING)', r.text.strip(), re.I) for r in rows):
                from .ielts_key_ocr import recover_key_skill_heading
                heading_row = recover_key_skill_heading(layer, rows, cache)
                if heading_row is not None:
                    rows = list(rows)
                    # Place a continued page's own heading before its first
                    # key block; only a printed badge supplies test identity.
                    heading_index = next((i for i,r in enumerate(rows) if r.y0 >= heading_row.y1),0)
                    rows.insert(heading_index, heading_row)
            # A Reading key page can continue the preceding printed TEST badge.
            # Identity comes from that badge inside this hash-pinned key window,
            # never from the requested test number or page position.
            skill = None
            printed_badge = False
            for r in rows:
                txt = re.sub(r"\s+", "", r.text).upper()
                if r.method == 'OCR' and txt.startswith('TEST'):
                    from .ielts_key_ocr import own_glyph_text
                    reread_badge = own_glyph_text(layer, r, cache, r.x0, r.x1, 'TEST0123456789')
                    if reread_badge and re.fullmatch(r'TEST0?\d{1,2}', reread_badge):
                        txt = reread_badge
                m = re.fullmatch(r"TEST0?(\d{1,2})", txt)
                if m:
                    test = int(m.group(1))
                    skill = None
                    printed_badge = True
                    continue
                heading = re.sub(r"^(?:ACADEMIC|GENERALTRAINING)", "", txt)
                hit = [k for k in ("LISTENING", "READING") if len(heading) <= 11 and SequenceMatcher(None, heading, k).ratio() >= 0.8]
                if hit:
                    skill = hit[0]
                    # Listening begins the next key chapter. Without its own
                    # badge, a previous chapter cannot supply its identity.
                    if skill == "LISTENING" and not printed_badge and not prof.get("key_test_from_source"):
                        test = None
                    continue
                if test is not None and skill is not None:
                    stream.append(AnnotatedRow(r, ANSWER_KEY, test, skill))
        return stream

    def _bind_ielts_audio(self, parts: list, bindings: list, t: ExtractedTest, log: DiagnosticLog) -> list:
        if not parts:
            return parts
        whole = [b for b in bindings if (b.scope or "").startswith("WHOLE")]
        if len(whole) == 1:
            # Phase 3.6: CONFIDENT part segments of the one whole-test recording (spoken 'Part n' announcements,
            # audio_segment.py) replace the whole file; a part without one keeps the Phase 3 behaviour
            from .audio_segment import confident_part_segments
            segs = confident_part_segments(self.staging, whole[0].sha256, None)
            if segs:
                for p in parts:
                    seg = segs.get(p.number)
                    if seg is not None and seg.technical_qa.get("hashVerified") and seg.technical_qa.get("durationAgrees"):
                        p.audio = [seg]
                        t.audio.append(seg)
                        log.add("AUDIO_SEGMENT_CONFIDENT", f"LISTENING/PART_{p.number}",
                                "derived Part segment (spoken part announcement boundaries)")
                if all(p.audio for p in parts):
                    return parts
                log.add("AUDIO_SEGMENT_UNRESOLVED", "LISTENING",
                        "not every part has a CONFIDENT segment; independently verified segments retained")
        out = []
        first_part = min(p.number for p in parts)
        for p in parts:
            if p.audio:
                out.append(p)
                continue
            mine = [b for b in bindings if (b.section == p.number or b.part == p.number) and b not in whole]
            scope = f"LISTENING/PART_{p.number}"
            if len(mine) > 1:
                log.add("SOURCE_AUDIO_AMBIGUOUS", scope, f"{len(mine)} candidate recordings")
                log.add("PART_OMITTED", scope, "audio")
                continue
            if not mine and len(whole) == 1:
                # one continuous recording: bound once, to the part where it starts; the other parts carry no
                # audio of their own (part offsets are unknown -> the validator reports per-part audio missing)
                log.add("SOURCE_AUDIO_WHOLE_TEST_ONLY", scope, "one continuous recording for the whole listening test")
                if p.number != first_part:
                    out.append(p)
                    continue
                mine = whole
            elif not mine and len(whole) > 1:
                log.add("SOURCE_AUDIO_AMBIGUOUS", scope, f"{len(whole)} whole-test recordings")
                log.add("PART_OMITTED", scope, "audio")
                continue
            if not mine:
                log.add("SOURCE_AUDIO_UNMAPPED", scope, "no recording mapped to this part")
                log.add("PART_OMITTED", scope, "audio")
                continue
            b = mine[0]
            if b.confidence not in (CONFIDENT, PROBABLE):
                log.add("SOURCE_AUDIO_AMBIGUOUS", scope, f"mapping {b.confidence}")
                log.add("PART_OMITTED", scope, "audio")
                continue
            lo, hi = WHOLE_LISTENING_SECONDS if b in whole else IELTS_PART_SECONDS
            if not (lo <= b.duration_ms / 1000 <= hi):
                log.add("SOURCE_AUDIO_DURATION_IMPLAUSIBLE", scope, f"{b.duration_ms // 1000}s")
                log.add("PART_OMITTED", scope, "audio")
                continue
            p.audio = [b]
            if b not in t.audio:
                t.audio.append(b)
            out.append(p)
        return out

    def _attach_keys(self, parts: list, stream: list, test_no: int, skill: str, layer, last: int,
                     log: DiagnosticLog, t: ExtractedTest) -> list:
        if not parts:
            return parts
        krows = skill_key_rows(stream, test_no, skill, layer, log, f"ANSWER_KEY/{skill}")
        scope = f"ANSWER_KEY/{skill}"
        question_kinds={item.number:group.kind for part in parts for group in part.groups for item in group.items}
        if any(r.method == 'OCR' for r in krows):
            from .ielts_key_ocr import reread_key_ordinals, recover_either_order_rows, remove_score_header_rows, recover_merged_roman_key_rows, recover_merged_enum_key_rows, reread_typed_key_values
            recover_merged_roman_key_rows(layer, krows, self.region_cache(), log, scope,question_kinds=question_kinds)
            recover_merged_enum_key_rows(layer, krows, self.region_cache(), log, scope,question_kinds=question_kinds)
            remove_score_header_rows(layer, krows, self.region_cache(), log, scope)
            reread_key_ordinals(layer, krows, self.region_cache(), log, scope)
            recover_either_order_rows(layer, krows, self.region_cache(), log, scope)
            reread_typed_key_values(layer, krows, self.region_cache(), log, scope,question_kinds=question_kinds)
        if not krows:
            log.add("ANSWER_KEY_NOT_FOUND", scope, "no answer-key rows for this test/skill")
            for p in parts:
                log.add("PART_OMITTED", f"{skill}/{p.code}", "answer key")
            return []
        keys = parse_key_rows(krows, 1, last, log, scope)
        t.answer_key_refs.append({"skill": skill, "path": layer.rel_path, "sha256": layer.sha256,
                                  "pages": page_range({r.page for r in krows}), "keysParsed": len(keys)})
        out = []
        for p in parts:
            ok = True
            for g in p.groups:
                ids = [o.id for o in (g.options or (g.items[0].options if g.items else []))]
                for it in g.items:
                    raw = keys.get(it.number)
                    if raw is None:
                        ok = False
                        continue
                    vals = resolve_key(g.kind, raw, [o.id for o in it.options] or ids, g.word_limit, g.allow_number,
                                       log, scope)
                    if not vals:
                        ok = False
                        continue
                    raw.values = vals
                    it.key = raw
            if ok:
                out.append(p)
            else:
                log.add("PART_OMITTED", f"{skill}/{p.code}", "answer key")
        return out


def _max_marker(rows: list) -> Optional[int]:
    """Highest question number announced anywhere in the section ('PART 4 Questions 31-40' included)."""
    best = None
    for r in rows:
        for a, b in re.findall(r"\bQuestions?\s+(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\b", row_text(r), re.I):
            if int(a) <= int(b) <= 50:
                best = max(best or 0, int(b))
    return best
