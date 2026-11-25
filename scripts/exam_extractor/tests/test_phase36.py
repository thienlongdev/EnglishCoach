"""Phase 3.6 tests: Part 7 multi-document segmentation, Part 3/4 sets only from source evidence (spoken
announcements + answer-pause rhythm), pre-2016 Part 6 inline-option geometry, IELTS gap numbers without font
metadata, completion templates, cross-source identity, owner authorization vs publisher provenance, and the
golden invariants (Phase 2 containment, raw source unchanged, no placeholders, no guessed keys / audio offsets).

Unit tests use synthetic rows / cue lists only — no exam text. Golden tests read the local staging and are
skipped when it is absent.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import glob
import hashlib
import json
import re
import unittest
from pathlib import Path

from exam_extractor.asr_cues import announced_sets, parse_cues, words_to_int
from exam_extractor.audio_segment import analyze_toeic, apply_spoken_parts
from exam_extractor.corpus import RAW_ROOT, REPO_ROOT, TestRecord, companion_matches, raw_abs
from exam_extractor.diagnostics import CONFIDENT, DiagnosticLog
from exam_extractor.ielts_groups import BLANK, _gap_number, parse_group
from exam_extractor.model import ExtractedTest, Item, Option, Part, QuestionGroup, Section, SINGLE_CHOICE, SourceDocument
from exam_extractor.ocr_quality import normalize_split_labels, reread_gap_numbers
from exam_extractor.package_builder import PackageBuilder
from exam_extractor.pdf_layer import DOTS, Row, Token
from exam_extractor.toeic import _parse_part6_inline, declared_types, doc_count
from exam_extractor.toeic_sets import segment_documents

STAGING = REPO_ROOT / "imports" / "exams" / "staging"
HAVE_STAGING = (STAGING / "reports" / "phase2_validation.json").exists()
HAVE_CORPUS = RAW_ROOT.exists() and (REPO_ROOT / "imports/exams/manifests/raw-source/raw_source_manifest.json").exists()


def _row(tokens, page=1, y=100.0, h=10.0, conf=0.9, **attrs):
    toks = [Token(t, x0, x1) for t, x0, x1 in tokens]
    r = Row(page, y, y + h, toks[0].x0, toks[-1].x1, toks, "OCR", conf)
    for k, v in attrs.items():
        setattr(r, k, v)
    return r


def _text(text, x=60.0, y=100.0, page=1, **attrs):
    toks, cx = [], x
    for w in text.split():
        toks.append((w, cx, cx + 5 * len(w)))
        cx += 5 * len(w) + 4
    return _row(toks, page, y, **attrs)


# ── Part 7 multi-document segmentation ──────────────────────────────────────────────────────────

class Part7Tests(unittest.TestCase):
    def test_01_single_document_set(self):
        self.assertEqual(doc_count("article"), 1)
        self.assertEqual(doc_count("text-message chain"), 1)
        rows = [_text("Synthetic line one", y=100 + 12 * i) for i in range(6)]
        self.assertIsNone(segment_documents(rows, 1), "a single-document set is never split")

    def test_02_double_document_set(self):
        self.assertEqual(doc_count("article and e-mail"), 2)
        rows = [_text("line a", y=100 + 12 * i, frame=0) for i in range(4)] + \
               [_text("line b", y=200 + 12 * i, frame=1) for i in range(4)]
        docs = segment_documents(rows, 2)
        self.assertIsNotNone(docs)
        self.assertEqual([len(d) for d in docs], [4, 4])

    def test_03_triple_document_set(self):
        # plural document noun = two documents; OCR ';' for ',' is normalised
        self.assertEqual(doc_count("e-mails and form"), 3)
        self.assertEqual(declared_types("e-mails and form"), ["e-mail", "e-mail", "form"])
        self.assertEqual(doc_count("advertisement; form, and review"), 3)
        rows = [_text("x", y=100 + 40 * k + 12 * i, frame=k) for k in range(3) for i in range(3)]
        docs = segment_documents(rows, 3)
        self.assertIsNotNone(docs)
        self.assertEqual([len(d) for d in docs], [3, 3, 3])

    def test_04_no_multi_document_inference_without_visible_evidence(self):
        # declared 3 documents, but the page shows ONE continuous block: never segmented by expectation
        rows = [_text("continuous text", y=100 + 12 * i) for i in range(9)]
        self.assertIsNone(segment_documents(rows, 3))
        # two framed blocks but the header declares 3 -> still not segmented
        rows2 = [_text("a", y=100 + 12 * i, frame=0) for i in range(3)] + \
                [_text("b", y=200 + 12 * i, frame=1) for i in range(3)]
        self.assertIsNone(segment_documents(rows2, 3))


# ── Part 3 / 4 sets from spoken announcements ───────────────────────────────────────────────────

def _cues_and_pauses(lo, hi, size=3, drop=None, t0=1000.0):
    cues, pauses, t = [], [], t0
    for a in range(lo, hi + 1, size):
        b = a + size - 1
        if a != drop:
            cues.append({"kind": "SET", "a": a, "b": b, "atS": t, "pos": 0})
        for k in range(size):
            pauses.append((t + 30 + 12 * k, 8.0))
        t += 80.0
    return cues, pauses, t


class Part34SetTests(unittest.TestCase):
    def test_partial_proven_boundaries_preserve_only_fully_bounded_parts(self):
        from exam_extractor.diagnostics import UNRESOLVED
        from exam_extractor.audio_segment import _segments
        out = {'boundaries': [{'between': '1|2', 'tier': CONFIDENT},
                              {'between': '2|3', 'tier': CONFIDENT},
                              {'between': '3|4', 'tier': UNRESOLVED}]}
        result = _segments(out, 3000, (260, 800, None))['segments']
        self.assertEqual([CONFIDENT, CONFIDENT, UNRESOLVED, UNRESOLVED], [s['tier'] for s in result])
        self.assertEqual((260000, 800000), (result[1]['startMs'], result[1]['endMs']))
        self.assertNotIn('startMs', result[2])

    def test_reversed_proven_boundaries_never_render_segments(self):
        from exam_extractor.diagnostics import UNRESOLVED
        from exam_extractor.audio_segment import _segments
        out = {'boundaries': [{'between': key, 'tier': CONFIDENT} for key in ('1|2', '2|3', '3|4')]}
        result = _segments(out, 3000, (800, 260, None))['segments']
        self.assertTrue(all(s['tier'] == UNRESOLVED for s in result))

    def test_05_part3_sets_only_with_source_evidence(self):
        cues, pauses, end = _cues_and_pauses(32, 70)
        sets, detail = announced_sets(cues, 32, 70, pauses, end)
        self.assertEqual(len(sets), 13)
        self.assertEqual(sets[0][:2], (32, 34))
        self.assertEqual(sets[-1][:2], (68, 70))

    def test_06_part4_sets_only_with_source_evidence(self):
        cues, pauses, end = _cues_and_pauses(71, 100, t0=3000.0)
        sets, _ = announced_sets(cues, 71, 100, pauses, end)
        self.assertEqual([s[:2] for s in sets][:2], [(71, 73), (74, 76)])
        # the spoken range must be corroborated by the audio rhythm: a set followed by 2 answer pauses is refused
        pauses_bad = [p for i, p in enumerate(pauses) if i != 4]
        self.assertIsNone(announced_sets(cues, 71, 100, pauses_bad, end)[0])

    def test_07_expected_group_count_validates_but_never_creates(self):
        # the triplet rhythm is perfect, but one announcement was not heard: nothing is inferred from 39/3
        cues, pauses, end = _cues_and_pauses(32, 70, drop=44)
        sets, detail = announced_sets(cues, 32, 70, pauses, end)
        self.assertIsNone(sets)
        self.assertIn("44", detail)
        self.assertIsNone(announced_sets([], 32, 70, pauses, end)[0])

    def test_07b_cue_parsing_numbers_and_parts(self):
        self.assertEqual(words_to_int("thirty-two"), 32)
        c = parse_cues("Questions 71 through 73 refer to the following talk.", 12.0)
        self.assertEqual((c[0]["kind"], c[0]["a"], c[0]["b"]), ("SET", 71, 73))
        c = parse_cues("Part 2. Directions: you will hear", 5.0)
        self.assertEqual((c[0]["kind"], c[0]["n"], c[0]["pos"]), ("PART", 2, 0))

    def test_07c_spoken_part_boundary_needs_pause_class_and_number(self):
        # 6 short + 25 short + 39 long + 30 long answer pauses; a spoken 'Part 2' right after the 6th short pause
        pauses, t = [], 50.0
        for i in range(31):
            pauses.append((t, 5.0)); t += 25.0
        t += 40
        for i in range(69):
            pauses.append((t, 8.0)); t += 25.0 if i % 3 != 2 else 60.0
        out = analyze_toeic(pauses, t + 30, "TOEIC_LR_2016")
        p2_at = round(pauses[5][0] + 5.0, 2)
        cues = [{"kind": "PART", "n": 2, "atS": p2_at, "pos": 0},
                {"kind": "NUMBER", "n": 6, "atS": round(pauses[4][0] + 5.0, 2), "pos": 0}]
        res = apply_spoken_parts(dict(out), cues, t + 30, "TOEIC_LR_2016")
        b12 = next(b for b in res["boundaries"] if b["between"] == "1|2")
        self.assertEqual(b12["tier"], CONFIDENT)
        self.assertAlmostEqual(b12["atS"], p2_at, places=2)
        # a 'Part 2' cue without a matching pause / number never moves a boundary to CONFIDENT
        res2 = apply_spoken_parts(dict(out), [{"kind": "PART", "n": 2, "atS": pauses[10][0] + 1.0, "pos": 0}],
                                  t + 30, "TOEIC_LR_2016")
        b12b = next(b for b in res2["boundaries"] if b["between"] == "1|2")
        self.assertNotEqual(b12b.get("atS"), round(pauses[10][0] + 1.0, 2))


# ── Part 6 pre-2016 inline options ──────────────────────────────────────────────────────────────

def _inline_set(blank_x=(260.0, 300.0), block_x=250.0):
    rows = []
    y = 100.0
    for q in (141, 142, 143):
        rows.append(_row([("Synthetic", 60, 110), ("text", 114, 140), (DOTS, *blank_x), ("words", 310, 340)], y=y))
        y += 14
        rows.append(_row([(f"{q}.", block_x, block_x + 20), ("(A)", block_x + 24, block_x + 38), ("alpha", block_x + 42, block_x + 70)], y=y))
        for k, lab in enumerate("BCD"):
            y += 14
            rows.append(_row([(f"({lab})", block_x + 24, block_x + 38), ("word", block_x + 42, block_x + 66)], y=y))
        y += 18
        rows.append(_text("continuation of the passage", y=y))
        y += 14
    return rows


class Part6InlineTests(unittest.TestCase):
    def test_modern_four_item_set_uses_standard_blank_mapping(self):
        self.assertIsNone(_parse_part6_inline(139,142,'article',_inline_set(),DiagnosticLog(),'PART_6'))

    def test_inline_option_block_does_not_consume_same_margin_passage(self):
        rows = _inline_set(blank_x=(80,105),block_x=60)
        group = _parse_part6_inline(141,143,'article',rows,DiagnosticLog(),'PART_6')
        self.assertTrue(group)
        self.assertEqual([141,142,143],[i.number for i in group.items])
        text = group.passage.text()
        self.assertIn('continuation of the passage',text)
        self.assertNotIn('alpha',text)

    def test_inline_blocks_restore_physical_order_after_column_sort(self):
        rows = _inline_set()
        # Layout output placed the middle inline block in a right column.
        # Its printed number and unique blank still prove the actual order.
        middle = rows[6:12]
        rest = [r for r in rows if r not in middle]
        group = _parse_part6_inline(141,143,'article',rest+middle,DiagnosticLog(),'PART_6')
        self.assertTrue(group)
        self.assertEqual([141,142,143],[i.number for i in group.items])

    def test_blank_comes_from_nearest_line_not_a_higher_dot_band(self):
        rows = _inline_set()
        rows.insert(0, _row([(DOTS, 260, 300)], y=90))
        group = _parse_part6_inline(141, 143, 'article', rows, DiagnosticLog(), 'READING/PART_6')
        self.assertTrue(group)
        self.assertEqual([141, 142, 143], [item.number for item in group.items])

    def test_08_economy_part6_geometry(self):
        log = DiagnosticLog()
        g = _parse_part6_inline(141, 143, "article", _inline_set(), log, "READING/PART_6/Q141-143")
        self.assertTrue(g)
        self.assertEqual([it.number for it in g.items], [141, 142, 143])
        self.assertTrue(all(it.prompt == f"({it.number}) {BLANK}" for it in g.items))
        text = " ".join(p["text"] for p in g.passage.paragraphs)
        self.assertEqual(text.count(BLANK), 3)
        self.assertNotIn("Blank (141) in the text", text)
        # an option block that is NOT under its blank is refused (no positional mapping)
        log2 = DiagnosticLog()
        self.assertIs(_parse_part6_inline(141, 143, "article", _inline_set(blank_x=(60.0, 90.0), block_x=400.0),
                                          log2, "S"), False)
        self.assertIn("PART6_BLANK_MAPPING_UNPROVEN", {d.code for d in log2.items})

    def test_08b_split_labels_rejoined_by_geometry(self):
        r = _row([("1", 280, 284), ("45.", 285, 300), ("(", 305, 307), ("B)", 308, 318), ("word", 322, 340)], h=10)
        normalize_split_labels([r])
        self.assertEqual([t.text for t in r.tokens][:3], ["145.", "(B)", "word"])


class Part1PhotoTests(unittest.TestCase):
    def test_08c_split_photo_merged_but_two_photos_never(self):
        from exam_extractor.layout import FIGURE, Region
        from exam_extractor.toeic_scan import _merge_stacked_pieces
        area = 612 * 792
        top = Region(FIGURE, (96, 437, 461, 487), 3, meta={"areaFrac": 0.038})
        bottom = Region(FIGURE, (96, 560, 462, 703), 3, meta={"areaFrac": 0.107})
        debris = _row([("3", 180, 186), ("3", 190, 196), ("mm", 200, 214)], page=3, y=520)   # texture inside the band
        merged = _merge_stacked_pieces([top, bottom], [debris], area)
        self.assertEqual(len(merged), 1)
        self.assertGreaterEqual(merged[0].meta["areaFrac"], 0.05)
        # a printed number level with the lower photo's top edge separates two photographs
        label = _row([("4.", 67, 80)], page=3, y=562)
        self.assertEqual(len(_merge_stacked_pieces([top, bottom], [label], area)), 2)


# ── IELTS scanned gap numbers / completion templates ────────────────────────────────────────────

class _StubCache:
    def __init__(self, text):
        self.text = text

    def recognize(self, layer, page, crop, **kw):
        class W:
            pass
        w = W()
        w.text, w.conf = self.text, 0.99

        class R:
            words = [w]
        return R()


class IeltsGapTests(unittest.TestCase):
    def test_09_gap_number_without_bold_metadata(self):
        r = _row([("Held", 55, 77), ("on", 80, 92), ("8", 95, 102), (DOTS, 104, 190), ("from", 192, 214)])
        self.assertFalse(any(t.bold for t in r.tokens))
        self.assertTrue(_gap_number(r, 2, 8, ocr=True))
        # a misread number fused with a word left of the blank is re-read from its own ink (digits only)
        r2 = _row([("lot", 139, 151), ("Of40", 153, 180), (DOTS, 181, 267)])
        n = reread_gap_numbers(None, [r2], _StubCache("40"))
        self.assertEqual(n, 1)
        self.assertTrue(_gap_number(r2, [t.text for t in r2.tokens].index("40"), 40, ocr=True))

    def test_10_completion_template_preserves_blanks(self):
        rows = [_text("Complete the notes below.", y=60), _text("Write ONE WORD ONLY for each answer.", y=74)]
        y = 100
        for q in range(1, 4):
            rows.append(_row([("Line", 60, 80), ("item", 84, 104), (str(q), 108, 114), (DOTS, 116, 200),
                              ("tail", 204, 224)], y=y))
            y += 16
        log = DiagnosticLog()
        g = parse_group(rows, 1, 3, "LISTENING/PART_1", log, ocr=True)
        self.assertIsNotNone(g, [d.code for d in log.items])
        self.assertEqual([i.number for i in g.items], [1, 2, 3])
        for q in range(1, 4):
            self.assertIn(f"({q}) {BLANK}", g.stem)
        self.assertEqual(g.word_limit, 1)


# ── cross-source identity ───────────────────────────────────────────────────────────────────────

class CrossSourceTests(unittest.TestCase):
    def test_11_cross_source_binding_rejects_mismatched_identity(self):
        rec = TestRecord("TOEIC", "ets", "ets-2026", "ETS 2026", "toeic/ets-2026/test-1", 1,
                         {"audio": [{"source": "toeic/ets/ETS 2026/AUDIO/AUDIO TEST 1.mp3"}]},
                         {"source_documents": []})
        ok, _ = companion_matches(rec, {"book": "ets-2026", "testNumber": 1,
                                        "path": "imports/source-files/toeic/ets/ETS 2026/AUDIO/AUDIO TEST 1.mp3"})
        self.assertTrue(ok)
        # same question ranges, different test / book / file: never bound
        self.assertFalse(companion_matches(rec, {"book": "ets-2026", "testNumber": 2})[0])
        self.assertFalse(companion_matches(rec, {"book": "ets-2020", "testNumber": 1})[0])
        self.assertFalse(companion_matches(rec, {"book": "ets-2026", "testNumber": 1,
                                                 "path": "imports/source-files/toeic/ets/ETS 2026/AUDIO/AUDIO TEST 2.mp3"})[0])


# ── rights: owner authorization vs publisher provenance ─────────────────────────────────────────

class _Store:
    def register_audio(self, b):
        return "x"


def _mini_test() -> ExtractedTest:
    t = ExtractedTest(test_id="toeic/ets-2026/test-1", family="TOEIC", variant="STANDARD_FIXED_FORM",
                      collection="ets", book="ets-2026", book_title="ETS TOEIC 2026", test_number=1, publisher="ETS",
                      readiness_phase1="NEEDS_REVIEW", raw_manifest_ref="toeic/ets-2026/test-1")
    t.documents.append(SourceDocument("imports/source-files/toeic/ets/ETS 2026/READING ETS 2026.pdf", "a" * 64,
                                      "QUESTION_BOOK", "SCANNED", 304))
    it = Item(number=101, prompt="stub ______", interaction=SINGLE_CHOICE, options=[Option(x, x.lower()) for x in "ABCD"])
    part = Part(code="READING_PART_5", number=5)
    part.groups.append(QuestionGroup(first=101, last=101, kind="TOEIC_PART_5", items=[it]))
    t.sections.append(Section("READING", parts=[part], pages=[2]))
    return t


class RightsTests(unittest.TestCase):
    def test_12_owner_authorization_preserves_publisher_provenance(self):
        pkg = PackageBuilder(_Store()).build(_mini_test(), "ETS")
        pub = next(s for s in pkg["sources"] if s["sourceType"] == "THIRD_PARTY_PUBLICATION")
        lic = next(l for l in pkg["licenses"] if l["sourceId"] == pub["id"])
        self.assertEqual(pub["publisher"], "ETS")
        self.assertEqual((lic["provenanceCategory"], lic["legalStatus"]), ("UNKNOWN", "PENDING"))
        self.assertFalse(lic["commercialRights"] or lic["redistributionRights"])
        meta = pkg["manifest"]["metadata"]
        self.assertEqual(meta["sourceIdentity"]["publisher"], "ETS")
        self.assertEqual(meta["sourceIdentity"]["book"], "ets-2026")
        self.assertEqual(meta["sourceProvenance"]["rawSourceFile"]["path"],
                         "imports/source-files/toeic/ets/ETS 2026/READING ETS 2026.pdf")
        # display name is separate from provenance and may change later
        self.assertEqual(meta["displayName"]["policy"], "DISPLAY_NAME_MAY_CHANGE_SOURCE_PROVENANCE_MUST_NOT")

    def test_13_owner_authorized_staging_path_recorded(self):
        meta = PackageBuilder(_Store()).build(_mini_test(), "ETS")["manifest"]["metadata"]
        auth = meta["projectUsageAuthorization"]
        self.assertEqual(auth["status"], "OWNER_AUTHORIZED")
        self.assertIn("LOCAL_STAGING_IMPORT_PREPARATION", auth["permits"])
        self.assertEqual(auth["productionImport"], "OWNER_AUTHORIZED_PRODUCTION_USE")
        self.assertEqual(auth["decisionRef"], "EXAMS_CORPUS_OWNER_PRODUCTION_AUTHORIZATION_20261006")
        self.assertIn("PRODUCTION_IMPORT", auth["permits"])

    def test_14_no_publisher_licence_claim(self):
        pkg = PackageBuilder(_Store()).build(_mini_test(), "ETS")
        auth = pkg["manifest"]["metadata"]["projectUsageAuthorization"]
        self.assertFalse(auth["publisherEndorsement"])
        self.assertEqual(auth["publisherLicence"], "NOT_ESTABLISHED")
        blob = json.dumps(pkg).lower()
        for claim in ("licensed by", "official partner", "publisher-certified", "certified by", "officially licensed"):
            self.assertNotIn(claim, blob)
        self.assertNotIn('"provenancecategory": "licensed"', blob)


# ── golden invariants over the local staging ────────────────────────────────────────────────────

def _packages():
    for f in sorted(glob.glob(str(STAGING / "extracted" / "**" / "*.json"), recursive=True)):
        yield f, json.loads(Path(f).read_text(encoding="utf-8"))


@unittest.skipUnless(HAVE_STAGING, "staging not built")
class StagingGolden(unittest.TestCase):
    def test_13b_staging_rights_cleared_production_still_refused(self):
        p2 = json.loads((STAGING / "reports" / "phase2_validation.json").read_text(encoding="utf-8"))
        rows = [r for r in p2["results"] if "stagingRights" in r]
        if not rows:
            self.skipTest("phase2 report predates the Phase 3.6 staging gate")
        for r in rows:
            self.assertFalse(r["importable"], r["file"])          # production importer semantics unchanged
            self.assertTrue(r["stagingRights"]["ownerAuthorized"], r["file"])
            self.assertTrue(r["stagingRights"]["stagingRightsCleared"], r["file"])

    def test_15_phase2_containment_still_passes(self):
        p2 = json.loads((STAGING / "reports" / "phase2_validation.json").read_text(encoding="utf-8"))
        self.assertEqual(p2["contractViolations"], [])
        for r in p2["results"]:
            self.assertTrue(r["contentHashMatches"], r["file"])
            self.assertTrue(r["sourceProvenancePresent"], r["file"])

    def test_17_no_placeholder_generation(self):
        bad = re.compile(r"mark your answer on your answer sheet \(a, b, c|choose the one word or phrase|"
                         r"^blank \(\d+\)|blank \(\d+\) in the text", re.I)
        for f, pkg in _packages():
            for it in pkg["items"]:
                self.assertFalse(bad.search(it["prompt"] or ""), f"{f}: {it['logicalItemKey']}")

    def test_18_no_guessed_answer(self):
        allowed = {"OCR_KEY_TABLE_V1", "OCR_KEY_TABLE_V1+REREAD", None}
        for f, pkg in _packages():
            if pkg["form"]["family"] != "TOEIC":
                continue
            for a in pkg["answerSpecs"]:
                src = a["acceptedAnswers"].get("keySource", {})
                self.assertEqual(src.get("confidence"), CONFIDENT, f)
                self.assertIn(src.get("method"), allowed, f)
                self.assertTrue(a["acceptedAnswers"]["values"], f)
        for f in glob.glob(str(STAGING / "reports" / "ocr_keys" / "*.json")):
            for t in json.loads(Path(f).read_text(encoding="utf-8"))["tests"]:
                for a in t.get("adjudicated", []):
                    agree = sum(1 for x in a["numberReads"] if x == str(a["q"]))
                    self.assertGreaterEqual(agree, 3, f"{f} Q{a['q']}")

    def test_19_no_guessed_audio_offset(self):
        for f, pkg in _packages():
            for seg in pkg["manifest"]["metadata"].get("audioSegments", []):
                ana = STAGING / "audio_segments" / f"{seg['parentSha256']}.json"
                self.assertTrue(ana.exists(), f)
                data = json.loads(ana.read_text(encoding="utf-8"))
                match = [s for s in data["segments"] if s["part"] == seg["part"]]
                self.assertTrue(match and match[0]["tier"] == CONFIDENT, f)
                self.assertEqual((match[0]["startMs"], match[0]["endMs"]), (seg["startMs"], seg["endMs"]), f)
                cuts = {round(b["atS"] * 1000) for b in data["boundaries"] if b.get("atS") is not None}
                for edge in (seg["startMs"], seg["endMs"]):
                    if 0 < edge < round(data["durationS"] * 1000) - 1:
                        self.assertIn(edge, cuts, f"{f}: segment edge not a CONFIDENT evidence boundary")
                for b in data["boundaries"]:
                    self.assertTrue(b["evidence"], f"{f}: boundary without evidence")


@unittest.skipUnless(HAVE_CORPUS, "raw corpus not present")
class RawIntegrityGolden(unittest.TestCase):
    def test_16_raw_source_unchanged(self):
        files = json.loads((REPO_ROOT / "imports/exams/manifests/raw-source/raw_source_files.json").read_text(encoding="utf-8"))
        rec = {r["path"]: r for r in files["files"]}
        checked = 0
        for p in ("toeic/ets/ETS 2026/AUDIO/AUDIO TEST 1.mp3", "toeic/ets/ETS 2026/AUDIO/AUDIO TEST 2.mp3",
                  "ielts/cambridge/Cambridge-ielts-21/Cambridge IELTS 21 Audio/Cambridge 21 - Test 3.mp3"):
            if p in rec and rec[p].get("sha256"):
                self.assertEqual(hashlib.sha256(raw_abs(p).read_bytes()).hexdigest(), rec[p]["sha256"], p)
                checked += 1
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()
