"""Phase 3.5 tests: layout-aware OCR, exam-aware OCR validation, answer-key tables, Part 6/7 geometry, Part 1
photo mapping, OCR cache keys, audio segmentation, raw-source integrity and package/validator invariants.

Unit tests use synthetic inputs only (pages drawn with OpenCV, stub OCR engines, synthetic pause lists) — no exam
text. Golden tests read the local corpus / staging reports and are skipped when those are absent.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

from exam_extractor import key_tables as kt
from exam_extractor.audio_segment import analyze_ielts, analyze_toeic
from exam_extractor.corpus import RAW_ROOT, REPO_ROOT, raw_abs
from exam_extractor.diagnostics import AMBIGUOUS, CONFIDENT, UNRESOLVED, DiagnosticLog
from exam_extractor.layout import FIGURE, FOOTER, HEADER, LayoutProfile, PageLayout, Region, analyze_image
from exam_extractor.ocr_engine import OcrEngine, OcrWord, RegionOcrCache, RegionResult
from exam_extractor.ocr_quality import question_blocks, repair_option_labels, sequence_diagnostics, structure_metrics
from exam_extractor.pdf_layer import DOTS, Row, Token
from exam_extractor.toeic import _parse_items
from exam_extractor.toeic_sets import map_part6_blanks, segment_documents

STAGING = REPO_ROOT / "imports" / "exams" / "staging"
HAVE_CORPUS = RAW_ROOT.exists() and (REPO_ROOT / "imports/exams/manifests/raw-source/raw_source_manifest.json").exists()


def _row(tokens, page=1, y=100.0, h=10.0, **attrs):
    toks = [Token(t, x, x + 6 * len(t)) for t, x in tokens]
    r = Row(page, y, y + h, toks[0].x0, toks[-1].x1, toks, "OCR", 0.9)
    for k, v in attrs.items():
        setattr(r, k, v)
    return r


def _text_row(text, x=60.0, y=100.0, page=1, **attrs):
    toks, cx = [], x
    for w in text.split():
        toks.append((w, cx))
        cx += 6 * len(w) + 4
    return _row(toks, page, y, **attrs)


# ── synthetic page images ────────────────────────────────────────────────────────────────────

def _page(lines_left, lines_right=(), header=None, footer=None, W=850, H=1100):
    img = np.full((H, W), 255, np.uint8)
    font = cv2.FONT_HERSHEY_SIMPLEX
    if header:
        cv2.putText(img, header, (60, 40), font, 0.5, 0, 1, cv2.LINE_AA)
    if footer:
        cv2.putText(img, footer, (380, 1080), font, 0.5, 0, 1, cv2.LINE_AA)
    for i, t in enumerate(lines_left):
        cv2.putText(img, t, (60, 160 + 22 * i), font, 0.5, 0, 1, cv2.LINE_AA)
    for i, t in enumerate(lines_right):
        cv2.putText(img, t, (470, 160 + 22 * i), font, 0.5, 0, 1, cv2.LINE_AA)
    return img


@unittest.skipIf(cv2 is None, "opencv not installed")
class LayoutTests(unittest.TestCase):
    def test_fine_dotted_border_needs_horizontal_and_vertical_ink_runs(self):
        from exam_extractor.layout import dashed_frames
        mask = np.zeros((400,600),np.uint8)
        for x in range(100,400,10):
            mask[50:52,x:x+3] = 1
            mask[200:202,x:x+3] = 1
        for y in range(50,200,10):
            mask[y:y+3,100:102] = 1
            mask[y:y+3,398:400] = 1
        cv2.putText(mask,'SOURCE MAP',(140,110),cv2.FONT_HERSHEY_SIMPLEX,.5,1,1)
        self.assertTrue(dashed_frames(mask,dotted=True))
        mask[52:200,98:105] = 0
        mask[52:200,395:403] = 0
        self.assertEqual([],dashed_frames(mask,dotted=True))

    def test_01_two_columns_left_before_right(self):
        left = [f"10{i}. alpha beta gamma delta" for i in range(1, 9)]
        right = [f"11{i}. epsilon zeta eta theta" for i in range(1, 9)]
        lay = analyze_image(_page(left, right), 1, 612, 792, LayoutProfile())
        content = lay.ordered()
        self.assertTrue(lay.gutters, "two-column band expected")
        cols = [r.column for r in content]
        self.assertIn(0, cols)
        self.assertIn(1, cols)
        last_left = max(r.order for r in content if r.column == 0)
        first_right = min(r.order for r in content if r.column == 1)
        self.assertLess(last_left, first_right, "every left-column block precedes the right column in a band")

    def test_02_header_footer_excluded(self):
        lay = analyze_image(_page([f"line {i} of body text here" for i in range(10)], header="TEST 1 RUNNING HEAD",
                                  footer="GO ON TO THE NEXT PAGE 21"), 1, 612, 792, LayoutProfile())
        kinds = {r.kind for r in lay.regions}
        self.assertIn(HEADER, kinds)
        self.assertIn(FOOTER, kinds)
        head = [r for r in lay.regions if r.kind == HEADER][0]
        foot = [r for r in lay.regions if r.kind == FOOTER][0]
        for r in lay.ordered():
            self.assertGreater(r.bbox[1], head.bbox[3] - 0.5)
            self.assertLess(r.bbox[3], foot.bbox[1] + 0.5)


class ExamAwareOcrTests(unittest.TestCase):
    def test_03_question_number_gap_detected_not_renumbered(self):
        self.assertEqual(sequence_diagnostics([101, 103, 104], [101, 102, 103, 104]), [("QUESTION_NUMBER_GAP", [102])])
        rows = [_text_row("101. a ……", y=100), _text_row("103. b ……", y=130), _text_row("104. c ……", y=160)]
        m = structure_metrics(rows, [101, 102, 103, 104])
        self.assertEqual(m["missing"], [102])
        self.assertEqual(m["questionsFound"], 3)
        log = DiagnosticLog()
        self.assertIsNone(_parse_items(rows, [101, 102, 103, 104], log, "P5"))
        self.assertEqual(log.items[0].code, "QUESTION_NUMBER_GAP")

    def test_04_missing_option_letter_not_invented(self):
        rows = [_text_row("101. The stem ……", y=100), _text_row("(A) one", x=70, y=115),
                _text_row("two", x=90, y=130), _text_row("(C) three", x=70, y=145), _text_row("(D) four", x=70, y=160)]
        log = DiagnosticLog()
        self.assertIsNone(_parse_items(rows, [101], log, "P5"))
        self.assertEqual(log.items[0].code, "OPTION_PARSE_FAILED")
        # a constrained re-read that disagrees with the expected letter is never accepted
        for reread, accepted in (("(C)", False), ("(B)", True)):
            rs = [Row(r.page, r.y0, r.y1, r.x0, r.x1, [Token(t.text, t.x0, t.x1) for t in r.tokens]) for r in rows]
            stats = repair_option_labels(None, question_blocks(rs, 101, 101), _StubCache(reread))
            texts = [r.tokens[0].text for r in rs]
            if accepted:
                self.assertEqual(texts[2], "(B)")
                self.assertEqual(stats["labelsRecognised"], 1)
            else:
                self.assertEqual(texts[2], "two")
                self.assertGreater(stats["labelsMissing"], 0)


class _StubCache:
    def __init__(self, text, conf=0.99):
        self.text, self.conf = text, conf

    def recognize(self, layer, page, bbox, dpi=300, pipeline="P1", allowlist=None, boxes_pt=None, image=None):
        return RegionResult(page, bbox, dpi, "stub", "1", pipeline, "boxes",
                            [OcrWord(self.text, tuple(bbox), self.conf)])


class OptionLabelProofTests(unittest.TestCase):
    def test_dotted_graphic_requires_enclosed_region_without_question(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from exam_extractor.toeic_scan import _dashed_boxes
        from exam_extractor.layout import TEXT
        region = Region(TEXT,(270,50,455,170),1)
        def ctx(rows):
            return SimpleNamespace(layer=SimpleNamespace(page_size=lambda p:(600,800)),
                                   pages={1:(SimpleNamespace(regions=[region]),rows)},
                                   profile=SimpleNamespace(layout=SimpleNamespace(analysis_dpi=72)))
        with patch('exam_extractor.toeic_scan.render_region',return_value=np.full((800,600),255,np.uint8)), \
             patch('exam_extractor.toeic_scan.dashed_frames',side_effect=lambda mask,**kw:[(272,50,453,168)] if kw else []):
            self.assertEqual([(268,48,457,172)],_dashed_boxes(ctx([]),1))
            self.assertEqual([],_dashed_boxes(ctx([_text_row('98. Question',x=280,y=100)]),1))
        with patch('exam_extractor.toeic_scan.render_region',return_value=np.full((800,600),255,np.uint8)), \
             patch('exam_extractor.toeic_scan.dashed_frames',return_value=[(300,80,350,130)]):
            self.assertNotIn((268,48,457,172),_dashed_boxes(ctx([]),1))

    def test_photo_label_uses_number_ink_not_merged_image_text(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from exam_extractor.toeic_scan import _photo_mapping
        figure = Region(FIGURE,(100,100,450,350),1,meta={'areaFrac':.2})
        layout = SimpleNamespace(width=600,height=800,figures=lambda:[figure],regions=[figure])
        label = _row([('5.',50),('noise',400)],y=100)
        ctx = SimpleNamespace(pages={1:(layout,[label])},
                              profile=SimpleNamespace(book='fixture',listening_furniture_identity=False))
        with patch('exam_extractor.toeic_scan._merge_stacked_pieces',return_value=[figure]):
            mapping,problems = _photo_mapping(ctx,[1],[5])
        self.assertEqual([5],list(mapping))
        self.assertEqual([],problems)

    def test_overlapping_graphic_fragments_do_not_duplicate_source_visual(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from exam_extractor.toeic_scan import _graphic_regions
        boxes = [(40,50,223,155),(157,50,227,156),(260,50,460,155)]
        layout = SimpleNamespace(regions=[Region(FIGURE,b,1) for b in boxes])
        ctx = SimpleNamespace(pages={1:(layout,[])})
        with patch('exam_extractor.toeic_scan._dashed_boxes',return_value=[]):
            result = _graphic_regions(ctx,[1])
        self.assertEqual([(1,(40,50,227,156)),(1,(260,50,460,155))],result)

    def test_part6_column_order_stays_on_its_printed_page(self):
        from unittest.mock import patch
        from exam_extractor.toeic import _parse_set
        rows = [_text_row('Passage …… ……', y=40),
                _text_row('145. (A) alpha', x=50, y=100),
                _text_row('146. (A) beta', x=350, y=100),
                _text_row('PART 7', x=50, y=20, page=2)]
        captured = []
        def capture(items, *args, **kwargs):
            captured.extend(items)
            return None
        with patch('exam_extractor.toeic._parse_part6_inline', return_value=None), \
             patch('exam_extractor.toeic.find_gutter', return_value=300), \
             patch('exam_extractor.toeic.split_columns', side_effect=lambda rs, w: sorted(rs, key=lambda r: (r.x0, r.y0))), \
             patch('exam_extractor.toeic._parse_items', side_effect=capture):
            _parse_set(6,145,146,'notice',rows,DiagnosticLog(),'PART_6',None)
        self.assertEqual([1,1,2], [r.page for r in captured])
        self.assertTrue(captured[1].text.startswith('146.'))

    def test_table_graphic_fallback_preserves_column_and_question_boundary(self):
        from exam_extractor.toeic_scan import _graphic_for_set
        first=_text_row('62. Source question',x=280,y=200,column=1)
        rows=[_text_row('Source coupon',x=280,y=50,column=1),
              _text_row('Sofas $50 off',x=280,y=75,column=1),
              _text_row('Chairs $25 off',x=280,y=100,column=1),
              _text_row('Expires June 30',x=280,y=125,column=1),first]
        self.assertIsNotNone(_graphic_for_set(first,[],rows)[0])
        previous=_text_row('61. Another question',x=280,y=20,column=1)
        self.assertIsNone(_graphic_for_set(first,[],[previous]+rows)[0])
        for r in rows[:-1]:r.column=0
        self.assertIsNone(_graphic_for_set(first,[],rows)[0])

    @unittest.skipIf(cv2 is None, 'opencv not installed')
    def test_bright_photo_recovery_does_not_capture_black_text_table(self):
        from exam_extractor.ocr_quality import tonal_photo_boxes
        image=np.full((1000,700),255,np.uint8)
        image[100:330,110:580]=np.tile(np.linspace(70,235,470,dtype=np.uint8),(230,1))
        self.assertEqual(1,len(tonal_photo_boxes(image,700,1000)))
        image[:]=255
        for y in range(100,330,30):cv2.putText(image,'TABLE 123',(110,y),cv2.FONT_HERSHEY_SIMPLEX,1,0,2)
        self.assertEqual([],tonal_photo_boxes(image,700,1000))

    def test_blank_label_tight_crop_requires_agreement_and_conflict_vote(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from exam_extractor.ocr_quality import reread_blank_labels
        for wide, tight, expected in [(('1435','1435'),'143',1),
                                      (('138','188'),'138',1), (('138','188'),'136',0)]:
            class CropCache(_StubCache):
                def recognize(self, *args, **kwargs):
                    self.text = tight if args[2][0] else wide[kwargs['pipeline']=='P2']
                    return super().recognize(*args, **kwargs)
            rows=[_row([(DOTS,100)],y=100)]
            with patch('exam_extractor.ocr_quality._label_band',
                       side_effect=lambda *a, **k: (1 if k['digit_only'] else 0,110,120,120)):
                self.assertEqual(expected,reread_blank_labels(SimpleNamespace(sha256='source'),rows,CropCache(''),131,146))
            if expected:self.assertEqual([int(tight)]*2,rows[1].blank_label_proof['reads'])
            else:self.assertTrue(rows[0].blank_label_conflict)

    def test_inline_a_anchors_two_damaged_part6_labels(self):
        from types import SimpleNamespace
        class CellCache(_StubCache):
            def recognize(self, *args, **kwargs):
                self.text = '(B)' if args[2][1] < 118 else '(C)'
                return super().recognize(*args, **kwargs)
        rows=[_row([('132.',75),('(A)',100),('alpha',125)],y=100),
              _row([('8.',100),('beta',125)],y=112),
              _row([('8.',100),('gamma',125)],y=124),
              _row([('(D)',100),('delta',125)],y=136)]
        stats=repair_option_labels(SimpleNamespace(sha256='source'),[(132,rows)],CellCache(''))
        self.assertEqual(2,stats['labelsRecognised'])
        self.assertEqual(['(B)','(C)'],[r.tokens[0].text for r in rows[1:3]])
        self.assertTrue(all(p['dualRead'] for p in stats['locations']))

    def test_detached_debris_before_first_a_still_starts_sequence(self):
        rows=[_text_row('199. Synthetic question', y=80),
              _row([('}',75),('(A)',100),('alpha',125)],y=100),
              _row([('(B)',100),('beta',125)],y=112),
              _row([('(C)',100),('gamma',125)],y=124),
              _row([('(D)',100),('delta',125)],y=136)]
        stats=repair_option_labels(None,[(199,rows)],None)
        self.assertEqual(4,stats['labelsClean'])
        self.assertEqual('(A)',rows[1].tokens[0].text)

    @unittest.skipIf(cv2 is None, 'opencv not installed')
    def test_faint_bleed_cannot_hide_or_invent_a_dash_blank(self):
        from exam_extractor.ocr_quality import detect_blank_runs
        img=np.full((100,400),255,np.uint8)
        # Many small pale reverse-page glyphs distort the component median.
        for x in range(0,380,12):
            cv2.rectangle(img,(x,5),(x+4,12),210,-1)
        for x in range(40,230,28):
            cv2.rectangle(img,(x,60),(x+17,63),110,-1)
        cv2.putText(img,'Text',(260,60),cv2.FONT_HERSHEY_SIMPLEX,1.0,0,2)
        runs=detect_blank_runs(None,1,(0,0,48,12),dpi=600,image=img,text_height_pt=10)
        self.assertEqual(1,len([r for r in runs if r[3]=='DASH_RUN']))
        no_blank=img.copy();no_blank[55:70,:]=255
        self.assertEqual([],detect_blank_runs(None,1,(0,0,48,12),dpi=600,image=no_blank,text_height_pt=10))

    def test_detached_debris_before_aligned_labels_keeps_all_options(self):
        rows = [_text_row('101. Synthetic stem', y=80),
                _row([('(A)',100),('alpha',125)],y=100),
                _row([("4'",75),('(B)',100),('beta',125)],y=112),
                _row([("' 1",65),('(C)',100),('gamma',125)],y=124),
                _row([('(D)',100),('delta',125)],y=136)]
        stats = repair_option_labels(None,[(101,rows)],None)
        self.assertEqual(4,stats['labelsClean'])
        self.assertEqual(['(A)','(B)','(C)','(D)'],[r.tokens[0].text for r in rows[1:]])
        self.assertEqual('gamma',rows[3].tokens[-1].text)

    def test_lexical_prefix_before_label_is_not_discarded(self):
        from exam_extractor.ocr_quality import _label_at
        row = _row([('in',75),('(B)',100),('text',125)])
        # A real word may be short, so require nonlexical debris.
        self.assertIsNone(_label_at(row,100,18))

    def test_independent_agreement_is_source_bound(self):
        from types import SimpleNamespace
        rows = [_text_row("101. stem", y=100), _text_row("(A) one", x=70, y=115),
                _text_row("two", x=90, y=130), _text_row("(C) three", x=70, y=145),
                _text_row("(D) four", x=70, y=160)]
        stats = repair_option_labels(SimpleNamespace(sha256='source'), question_blocks(rows, 101, 101), _StubCache('(B)'))
        self.assertTrue(stats['locations'][0]['dualRead'])
        self.assertEqual(['B', 'B'], stats['dualReadProofs'][0]['reads'])
        self.assertEqual('source', stats['dualReadProofs'][0]['sourceSha256'])

    def test_independent_conflict_keeps_review_required(self):
        from types import SimpleNamespace
        class ConflictingCache(_StubCache):
            def recognize(self, *args, **kwargs):
                self.text = '(C)' if kwargs.get('pipeline') == 'P2' else '(B)'
                return super().recognize(*args, **kwargs)
        rows = [_text_row("101. stem", y=100), _text_row("(A) one", x=70, y=115),
                _text_row("two", x=90, y=130), _text_row("(C) three", x=70, y=145),
                _text_row("(D) four", x=70, y=160)]
        stats = repair_option_labels(SimpleNamespace(sha256='source'), question_blocks(rows, 101, 101), ConflictingCache('(B)'))
        self.assertFalse(stats['locations'][0]['dualRead'])
        self.assertEqual([], stats['dualReadProofs'])


# ── answer-key tables (lattice logic, OCR-free) ───────────────────────────────────────────────

def _pairs(grid, letters, ch=30.0, numbers_override=None, letter_override=None):
    """grid: [(q, col, row)]; boxes laid out row-major with pitch 200 x 50 px."""
    out = []
    for q, c, r in grid:
        x, y = 100 + 200 * c, 100 + 50 * r
        na = nb = str(q)
        if numbers_override and q in numbers_override:
            na, nb = numbers_override[q]
        la = lb = letters[q]
        if letter_override and q in letter_override:
            la, lb = letter_override[q]
        out.append((((x, y, x + 50, y + ch), (na, 0.99), (nb, 0.99)), ((x + 60, y, x + 80, y + ch), (la, 0.99), (lb, 0.99))))
    return out


class KeyTableTests(unittest.TestCase):
    def test_high_resolution_retry_proves_its_own_number_or_stays_unbound(self):
        from unittest.mock import patch
        pairs = _pairs(self.grid, self.letters, numbers_override={114: ('114', '115')})
        for high, recovered in ((['114', '114', '114', '115'], True),
                                (['114', '114', '115', '115'], False), (['115'] * 4, False)):
            block = kt.KeyBlock(1, 1, (0, 0, 500, 500))
            with patch.object(kt, '_reread_number', side_effect=[['115'] * 4, high]) as reread:
                kt._lattice(block, pairs, 30.0, range(101, 121), None, 1,
                            (0, 0, 500, 500), None, cache=object())
            self.assertEqual(recovered, 114 in block.keys())
            self.assertTrue(reread.call_args.kwargs['high_resolution'])
            self.assertEqual(10, len(next(c for c in block.cells if c.predicted == 114).number_reads))

    def test_letter_retry_requires_two_new_reads_and_an_original_vote(self):
        from unittest.mock import patch
        pairs = _pairs(self.grid, self.letters, letter_override={105: ('AC', 'A')})
        for fresh, recovered in ((['A', 'A'], True), (['A', 'C'], False), (['C', 'C'], False)):
            block = kt.KeyBlock(1, 1, (0, 0, 500, 500))
            with patch.object(kt, '_reread_letter', return_value=fresh):
                kt._lattice(block, pairs, 30.0, range(101, 121), None, 1,
                            (0, 0, 500, 500), None, cache=object())
            self.assertEqual(recovered, 105 in block.keys(), fresh)

    def test_own_glyph_recovers_digits_dropped_by_both_initial_reads(self):
        from unittest.mock import patch
        pairs = _pairs(self.grid, self.letters, numbers_override={114: ('11', '14')})
        for fresh, recovered in ((['114'] * 4, True), (['114', '114', '114', '14'], True),
                                 (['114', '114', '14', '14'], False), (['115'] * 4, False)):
            block = kt.KeyBlock(1, 1, (0, 0, 500, 500))
            with patch.object(kt, '_reread_number', return_value=fresh):
                kt._lattice(block, pairs, 30.0, range(101, 121), None, 1,
                            (0, 0, 500, 500), None, cache=object())
            self.assertEqual(recovered, 114 in block.keys(), fresh)

    def setUp(self):
        self.grid = [(101 + r * 5 + c, c, r) for r in range(4) for c in range(5)]       # row-major 101-120
        self.letters = {q: "ABCD"[q % 4] for q, _c, _r in self.grid}

    def _run(self, pairs, expected=range(101, 121), part_of=None):
        blk = kt.KeyBlock(1, 1, (0, 0, 500, 500))
        kt._lattice(blk, pairs, 30.0, expected, None, 1, (0, 0, 500, 500), part_of)
        return blk

    def test_05_table_reconstructed_by_lattice(self):
        blk = self._run(_pairs(self.grid, self.letters))
        self.assertEqual(blk.orientation, "ROW_MAJOR")
        keys = blk.keys()
        self.assertEqual(sorted(keys), list(range(101, 121)))
        self.assertTrue(all(keys[q].letter == self.letters[q] for q in keys))

    def test_06_invalid_key_tokens_rejected(self):
        blk = self._run(_pairs(self.grid, self.letters, letter_override={105: ("E", "E"), 106: ("AB", "AB"),
                                                                         107: ("B", "C"), 108: ("", "")}))
        st = {c.predicted: c.status for c in blk.cells}
        for q in (105, 106, 107, 108):
            self.assertNotEqual(st[q], "CONFIRMED", q)
            self.assertNotIn(q, blk.keys())
        # Part 2 accepts A-C only
        grid = [(11 + r, 0, r) for r in range(10)]
        letters = {q: "D" for q, _c, _r in grid}
        blk2 = kt.KeyBlock(1, 1, (0, 0, 500, 500))
        kt._lattice(blk2, _pairs(grid, letters), 30.0, range(1, 101), None, 1, (0, 0, 500, 500),
                    lambda q: 2 if 11 <= q <= 40 else 1)
        self.assertTrue(all(c.status == "SYNTAX_INVALID" for c in blk2.cells))

    def test_07_numbering_alignment_conflicts(self):
        # 114 read as 116 by one pipeline -> conflict; 117 unreadable -> not bound by position; 102 printed twice
        blk = self._run(_pairs(self.grid, self.letters, numbers_override={114: ("114", "116"), 117: ("x", "")}))
        st = {c.predicted: c.status for c in blk.cells}
        self.assertEqual(st[114], "LATTICE_CONFLICT")
        self.assertEqual(st[117], "NUMBER_UNREAD")
        self.assertNotIn(114, blk.keys())
        self.assertNotIn(117, blk.keys())
        # most numbers disagreeing with any single lattice -> the sequence is not proven, nothing is bound
        bad = {q: (str(200 - q), str(200 - q)) for q, c, r in self.grid if (q % 3)}
        blk3 = self._run(_pairs(self.grid, self.letters, numbers_override=bad))
        self.assertEqual(blk3.keys(), {})


# ── TOEIC Part 6 / Part 7 ───────────────────────────────────────────────────────────────────────

class ToeicSetTests(unittest.TestCase):
    def test_overlapping_schedule_border_fragments_are_one_source_document(self):
        from types import SimpleNamespace
        from exam_extractor.layout import FRAME
        from exam_extractor.toeic_sets import document_regions
        rows=[_text_row('Source schedule time column',x=60,y=100),
              _text_row('Source schedule activity column',x=190,y=112),
              _text_row('Source schedule location column',x=270,y=124)]
        layouts={1:SimpleNamespace(regions=[Region(FRAME,(50,90,140,180),1),
                 Region(FRAME,(180,90,480,180),1),Region(FRAME,(100,92,260,179),1)])}
        self.assertEqual((50,90,480,180),document_regions(rows,layouts,1)[0][1])
        self.assertIsNone(document_regions(rows,layouts,2))

    def test_document_regions_exclude_nested_table_and_preserve_next_page_notice(self):
        from types import SimpleNamespace
        from exam_extractor.layout import FRAME
        from exam_extractor.toeic_sets import document_regions
        rows = [_text_row('First source document prose', y=100),
                _text_row('More source document prose', y=112),
                _text_row('Final source document prose', y=124),
                _text_row('Second source document prose', y=220),
                _text_row('More second document prose', y=232),
                _text_row('Final second document prose', y=244)]
        layouts = {1:SimpleNamespace(regions=[Region(FRAME,(20,90,500,150),1),
                    Region(FRAME,(30,95,490,140),1),Region(FRAME,(20,210,500,270),1)])}
        regions = document_regions(rows,layouts,2)
        self.assertEqual(2,len(regions))
        self.assertEqual((20,90,500,150),regions[0][1])
        self.assertIsNone(document_regions(rows,layouts,3))
        notice = [_text_row('PUBLIC NOTICE',y=70),_text_row('Third source document prose',y=100),
                  _text_row('More third document prose',y=112),_text_row('Final third document prose',y=124)]
        for row in notice:
            row.page=2
        layouts[2]=SimpleNamespace(regions=[])
        regions=document_regions(rows+notice,layouts,3)
        self.assertEqual(3,len(regions))
        self.assertEqual(70,regions[-1][1][1])

    def test_08_part6_blanks_map_by_geometry(self):
        rows = [_row([("Dear", 60), ("team,", 90), (DOTS, 130), ("thanks", 190)], y=100),
                _row([("135.", 135)], y=111, h=8),
                _row([("We", 60), (DOTS, 90), ("again", 150)], y=130),
                _row([("136.", 95)], y=141, h=8)]
        mapping, method, _d = map_part6_blanks(rows, [135, 136])
        self.assertEqual(method, "GEOMETRY_LABEL")
        self.assertEqual(mapping[135][0], 0)
        self.assertEqual(mapping[136][0], 2)
        # a label far from any blank -> unproven (dropped), never mapped by order
        rows[3] = _row([("136.", 400)], y=141, h=8)
        mapping, method, detail = map_part6_blanks(rows, [135, 136])
        self.assertIsNone(mapping)
        self.assertIn("136", detail)

    def test_09_part7_documents_stay_separate(self):
        rows = [_text_row("Invoice 23", y=100, frame=0), _text_row("Item total", y=112, frame=0),
                _text_row("Dear Ms Lee", y=200, frame=None), _text_row("Thank you for", y=212, frame=None)]
        docs = segment_documents(rows, 2)
        self.assertEqual(len(docs), 2)
        self.assertEqual([len(d) for d in docs], [2, 2])
        self.assertIsNone(segment_documents(rows, 3), "declared 3 but layout shows 2 -> not segmented")


class PhotoMappingTests(unittest.TestCase):
    def test_10_part1_photos_one_to_one(self):
        from exam_extractor.toeic_scan import _photo_mapping
        lay = PageLayout(3, 612, 792, regions=[Region(FIGURE, (90, 100, 400, 330), 3, meta={"areaFrac": 0.15}),
                                                Region(FIGURE, (90, 420, 400, 650), 3, meta={"areaFrac": 0.15})])
        rows = [_row([("1.", 80)], page=3, y=95), _row([("2.", 80)], page=3, y=415)]

        class Ctx:
            pages = {3: (lay, rows)}
            from exam_extractor.toeic_scan import ScanProfile
            profile = ScanProfile('photo-mapping-fixture', 'TOEIC_LR_2016', LayoutProfile(name='photo-mapping-fixture'))
        mapping, problems = _photo_mapping(Ctx(), [3], [1, 2])
        self.assertEqual(problems, [])
        self.assertEqual(mapping[1][1].bbox[1], 100)
        self.assertEqual(mapping[2][1].bbox[1], 420)
        # one photo for two numbers -> unproven
        lay.regions = lay.regions[:1]
        mapping, problems = _photo_mapping(Ctx(), [3], [1, 2])
        self.assertTrue(problems)

    def test_nonadjacent_artwork_number_does_not_override_complete_photo_mapping(self):
        from exam_extractor.toeic_scan import _photo_mapping, ScanProfile
        from types import SimpleNamespace
        lay = PageLayout(3, 612, 792, regions=[
            Region(FIGURE, (90, 100, 400, 330), 3, meta={'areaFrac': .15})])
        rows = [_row([('1.', 80)], page=3, y=95),
                _row([('1.', 420)], page=3, y=250)]
        ctx = SimpleNamespace(pages={3: (lay, rows)},
            profile=ScanProfile('photo-fixture', 'TOEIC_LR_2016', LayoutProfile()))
        mapping, problems = _photo_mapping(ctx, [3], [1])
        self.assertEqual([1], sorted(mapping))
        self.assertEqual([], problems)
        # A second adjacent label is a competing association, still blocked.
        rows[1] = _row([('2.', 80)], page=3, y=95)
        _, problems = _photo_mapping(ctx, [3], [1, 2])
        self.assertIn('Q2: photo already mapped', problems)
        # Without the own adjacent label, required-number coverage fails.
        rows[:] = [_row([('1.', 420)], page=3, y=250)]
        mapping, problems = _photo_mapping(ctx, [3], [1])
        self.assertEqual({}, mapping)
        self.assertIn('unmapped [1]', problems)


# ── OCR cache ─────────────────────────────────────────────────────────────────────────────────

class _CountingEngine(OcrEngine):
    name = "stub"

    def __init__(self, version="1"):
        self.version = version
        self.calls = 0

    def available(self):
        return True

    def detect(self, img, allowlist=None):
        self.calls += 1
        return [((0, 0, 10, 10), "x", 0.9)]


class _FakeLayer:
    rel_path = "imports/source-files/x.pdf"

    def __init__(self, sha):
        self.sha256 = sha


class CacheTests(unittest.TestCase):
    def test_11_cache_key_invalidation(self):
        base = dict(source_sha="a" * 64, page=3, bbox=(10, 10, 100, 100), dpi=300, engine="easyocr",
                    engine_version="1.7.2", prep="P1v1", mode="detect", allowlist=None)
        k = RegionOcrCache.key(**base)
        for change in ({"source_sha": "b" * 64}, {"bbox": (10, 10, 100, 101)}, {"dpi": 200},
                       {"engine_version": "1.7.3"}, {"prep": "P2v1"}, {"allowlist": "ABCD"}):
            self.assertNotEqual(k, RegionOcrCache.key(**dict(base, **change)), change)
        with tempfile.TemporaryDirectory() as tmp:
            eng = _CountingEngine()
            cache = RegionOcrCache(Path(tmp), eng)
            img = np.full((50, 50, 3), 255, np.uint8)
            layer = _FakeLayer("c" * 64)
            cache.recognize(layer, 1, (0, 0, 20, 20), dpi=300, image=img)
            cache.recognize(layer, 1, (0, 0, 20, 20), dpi=300, image=img)
            self.assertEqual(eng.calls, 1, "unchanged crop served from cache")
            cache.recognize(layer, 1, (0, 0, 20, 20), dpi=200, image=img)
            self.assertEqual(eng.calls, 2, "dpi change invalidates")
            cache.recognize(_FakeLayer("d" * 64), 1, (0, 0, 20, 20), dpi=300, image=img)
            self.assertEqual(eng.calls, 3, "source hash change invalidates")
            cache2 = RegionOcrCache(Path(tmp), _CountingEngine("2"))
            cache2.recognize(layer, 1, (0, 0, 20, 20), dpi=300, image=img)
            self.assertEqual(cache2.engine.calls, 1, "engine version change invalidates")


# ── audio segmentation ────────────────────────────────────────────────────────────────────────

def _toeic_pauses(extra_long_in_part3=False):
    """Pre-2016 structure: P1 10 x 5 s, P2 30 x 5 s, P3/P4 10 sets x 3 x 8 s (synthetic timeline)."""
    t, out = 60.0, []
    for _ in range(10):
        t += 18
        out.append((t, 5.0))
        t += 5
    t += 80   # Part 2 directions
    for _ in range(30):
        t += 12
        out.append((t, 5.0))
        t += 5
    for part in (3, 4):
        t += 70 if part == 4 else 50
        for s in range(10):
            t += 40
            for q in range(3):
                t += 4
                out.append((t, 8.0))
                t += 8
            if extra_long_in_part3 and part == 3 and s == 5:
                t += 4.8
                out.append((t, 8.0))
                t += 8
    return out, t + 30


class AudioTests(unittest.TestCase):
    def test_12_candidate_metadata_reproducible(self):
        pauses, dur = _toeic_pauses()
        a = analyze_toeic(pauses, dur, "TOEIC_LR_PRE_2016")
        b = analyze_toeic(pauses, dur, "TOEIC_LR_PRE_2016")
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertEqual([x["tier"] for x in a["boundaries"]], [CONFIDENT] * 3)
        self.assertEqual([s["tier"] for s in a["segments"]], [CONFIDENT] * 4)

    def test_13_ambiguous_boundary_stays_unresolved(self):
        pauses, dur = _toeic_pauses(extra_long_in_part3=True)
        a = analyze_toeic(pauses, dur, "TOEIC_LR_PRE_2016")
        tiers = {x["between"]: x["tier"] for x in a["boundaries"]}
        self.assertNotEqual(tiers["3|4"], CONFIDENT)
        self.assertEqual({s["part"]: s["tier"] for s in a["segments"]}[4] != CONFIDENT, True)
        flat = analyze_toeic([(10 + 20 * i, 5.0) for i in range(100)], 2500, "TOEIC_LR_PRE_2016")
        self.assertTrue(all(x["tier"] == UNRESOLVED for x in flat["boundaries"]), "silence alone never splits")
        ielts = analyze_ielts([(60, 30.0), (400, 30.0)], 1800)
        self.assertTrue(all(s["tier"] == AMBIGUOUS for s in ielts["segments"]))


# ── raw source integrity + package / validator invariants (golden) ─────────────────────────────

@unittest.skipUnless(HAVE_CORPUS, "raw corpus not present")
class IntegrityGolden(unittest.TestCase):
    def test_14_raw_sources_unchanged(self):
        files = json.loads((REPO_ROOT / "imports/exams/manifests/raw-source/raw_source_files.json").read_text(encoding="utf-8"))
        rec = {r["path"]: r for r in files["files"]}
        for p in ("toeic/ets/ETS 2026/READING ETS 2026.pdf", "toeic/ets/ETS 2026/LISTENING ETS 2026.pdf",
                  "toeic/economy/drive-download-20260911T144801Z-1-001/-TOEIC Economy RC 1000 Vol 1.pdf",
                  "toeic/economy/drive-download-20260911T144801Z-1-001/AUDIO ECONOMY VOL 1/01.mp3"):
            if p not in rec or not rec[p].get("sha256"):
                continue
            h = hashlib.sha256(raw_abs(p).read_bytes()).hexdigest()
            self.assertEqual(h, rec[p]["sha256"], p)
        with self.assertRaises(ValueError):
            raw_abs("../../staging/x.pdf")


def _phase35_packages():
    out = []
    for f in sorted((STAGING / "reports" / "extraction" / "toeic").glob("*.json")) if STAGING.exists() else []:
        rep = json.loads(f.read_text(encoding="utf-8"))
        if rep.get("extractor", {}).get("version", "")[:3] in ("3.5", "3.6") and rep["package"]["path"]:
            out.append((rep, json.loads((REPO_ROOT / rep["package"]["path"]).read_text(encoding="utf-8"))))
    return out


@unittest.skipUnless(HAVE_CORPUS and (STAGING / "reports" / "phase2_validation.json").exists(), "staging not built")
class PackageGolden(unittest.TestCase):
    def test_15_canonical_hash_matches(self):
        from exam_extractor.canonical_json import package_content_hash
        p2 = json.loads((STAGING / "reports" / "phase2_validation.json").read_text(encoding="utf-8"))
        by_id = {r.get("packageId"): r for r in p2["results"]}
        for rep, pkg in _phase35_packages():
            self.assertEqual(package_content_hash(pkg), pkg["manifest"]["contentHash"], rep["testId"])
            r = by_id.get(pkg["manifest"]["packageId"])
            if r is not None:
                self.assertTrue(r.get("contentHashMatches"), rep["testId"])

    def test_16_phase2_validator_applied(self):
        p2 = json.loads((STAGING / "reports" / "phase2_validation.json").read_text(encoding="utf-8"))
        ids = {r.get("packageId") for r in p2["results"]}
        for rep, pkg in _phase35_packages():
            self.assertIn(pkg["manifest"]["packageId"], ids, f"{rep['testId']} not judged by the Phase 2 gate")

    def test_17_no_placeholder_fallback(self):
        import re
        bad = re.compile(r"mark your answer on your answer sheet \(a, b, c|choose the one word or phrase|^blank \(\d+\)", re.I)
        for rep, pkg in _phase35_packages():
            specs = {a["itemId"]: a for a in pkg["answerSpecs"]}
            for it in pkg["items"]:
                self.assertFalse(bad.search(it["prompt"]), it["logicalItemKey"])
                part = it["optionDefinitions"].get("questionNumber", 0)
                opts = [o.get("text", "") for o in it["optionDefinitions"].get("options", [])]
                if part >= 32 and opts:          # Parts 3-7: printed option text, never letter-only
                    self.assertFalse(all(re.fullmatch(r"\(?[A-D]\)?", o or "") for o in opts), it["logicalItemKey"])
                spec = specs.get(it["id"])
                if spec is not None:
                    self.assertTrue(spec["acceptedAnswers"]["values"], it["logicalItemKey"])
                    self.assertNotIn("", spec["acceptedAnswers"]["values"])
