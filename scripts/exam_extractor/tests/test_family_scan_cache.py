"""Family sharing must not let a parser mutate another test's page input."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from exam_extractor.toeic_scan import ScanContext, ScanProfile, split_inline_columns, _read_key_blocks, test_pages
from exam_extractor.layout import LayoutProfile
from exam_extractor.pdf_layer import Row, Token
from exam_extractor.ocr_quality import question_blocks


class FamilyScanCacheTests(unittest.TestCase):
    def test_unassigned_key_block_affects_only_overlapping_or_unproven_dependency(self):
        from exam_extractor.toeic_scan import key_blocks
        from exam_extractor.diagnostics import DiagnosticLog
        identity=('source','family','READING',101,201,'format')
        for bbox,complete,expected in [((10,10,90,90),True,'UNRELATED_KEY_BLOCK_UNASSIGNED'),
                                       ((10,150,90,250),True,'ANSWER_KEY_BLOCK_UNASSIGNED'),
                                       ((10,10,90,90),False,'UNRELATED_KEY_BLOCK_UNASSIGNED'),
                                       ((10,10,90,90),None,'ANSWER_KEY_BLOCK_UNASSIGNED')]:
            diagnostics=DiagnosticLog();d=diagnostics.add('ANSWER_KEY_BLOCK_UNASSIGNED','ANSWER_KEY/READING','unknown',pages='1')
            d.key_block_bbox=bbox;d.key_block_page=1
            selected=SimpleNamespace(page=1,bbox=(10,100,90,200),keys=lambda: dict.fromkeys(range(101,201 if complete else 200 if complete is False else 101)))
            ctx=SimpleNamespace(ex=SimpleNamespace(_scan_key_blocks={identity:({2:selected},diagnostics)}),
                                layer=SimpleNamespace(sha256='source'),profile=SimpleNamespace(book='family'),log=DiagnosticLog())
            key_blocks(ctx,'READING',range(101,201),'format',2)
            self.assertEqual(expected,ctx.log.items[0].code)

    def test_right_heading_in_wrapped_left_stem_is_split_by_own_margin(self):
        def row(y,tokens):return Row(1,y,y+10,tokens[0].x0,tokens[-1].x1,tokens)
        rows=[row(100,[Token('102.',10,25),Token('Left stem',30,85)]),
              row(115,[Token('Wrapped stem',30,85),Token('105.',130,145),Token('Right stem',150,220)]),
              row(130,[Token('(A)',30,45),Token('left option',50,90),Token('(A)',150,165),Token('right option',170,220)]),
              row(145,[Token('106.',130,145),Token('Another right stem',150,240)])]
        result=split_inline_columns(rows)
        right=[r for r in result if r.column==1]
        self.assertTrue(any(r.text.startswith('105.') for r in right))
        self.assertTrue(any('right option' in r.text for r in right))
        self.assertFalse(any('105.' in r.text for r in result if r.column==0))

    def test_reading_footer_identity_precedes_restart_counting(self):
        profile = ScanProfile('family', 'TOEIC_LR_PRE_2016', LayoutProfile(name='family'),
                              reading_furniture_identity=True, key_pages={'READING': (8, 8)})
        ctx = SimpleNamespace(profile=profile, layer=SimpleNamespace(page_count=8), pages={})
        def page(n):
            values={1:[101,102],2:[103,104],3:[196,200],4:[101,108],5:[109,118],6:[119,140],7:[141,152]}
            rows=[Row(n,100,110,10,30,[Token(str(q)+'.',10,30)]) for q in values.get(n,[])]
            ctx.pages[n]=(SimpleNamespace(width=500,height=700),rows)
            return ctx.pages[n]
        def footer(layer,n,bbox,**kwargs):
            return SimpleNamespace(words=[SimpleNamespace(text={2:'Actual Test 03',3:'Actual Test 03',5:'Actual Test 04',7:'Actual Test 04'}.get(n,''))])
        ctx.page=page;ctx.cache=SimpleNamespace(recognize=footer)
        with patch('exam_extractor.toeic_scan.furniture_text',side_effect=lambda layer,lay,cache,profile: {'FOOTER': footer(layer,next(n for n,v in ctx.pages.items() if v[0] is lay),None).words[0].text}):
            pages,numbers,identity=test_pages(ctx,4,101,200)
        self.assertEqual([4,5,6,7],pages)
        self.assertEqual([4],identity)
        self.assertNotIn(196,numbers)

    def test_unlabelled_facing_page_retains_only_its_printed_continuation(self):
        profile = ScanProfile('family', 'TOEIC_LR_2016', LayoutProfile(name='family'),
                              listening_furniture_identity=True, discovered_key_pages={'LISTENING': [171]})
        ctx = SimpleNamespace(profile=profile, layer=SimpleNamespace(page_count=465), pages={})
        def page(n):
            numbers = [91] if n == 30 else list(range(92, 101)) if n == 31 else [1] if n == 34 else []
            rows = [Row(n, 100, 110, 10, 30, [Token(str(q) + '.', 10, 30)]) for q in numbers]
            ctx.pages[n] = (SimpleNamespace(width=500, height=700), rows)
            return ctx.pages[n]
        def footer(layer, n, bbox, **kwargs):
            text = 'TEST 1' if n in (20, 22, 24, 26, 28, 30) else 'TEST 2' if n == 34 else 'preface'
            return SimpleNamespace(words=[SimpleNamespace(text=text)])
        ctx.page = page
        ctx.cache = SimpleNamespace(recognize=footer)
        pages, numbers, identity = test_pages(ctx, 1, 1, 100)
        self.assertEqual(list(range(20, 32)), pages)
        self.assertEqual(list(range(91, 101)), numbers)
        self.assertEqual([1], identity)
        self.assertNotIn(34, pages)

    def test_printed_footer_bounds_questions_before_discovered_answer_book(self):
        profile = ScanProfile('family', 'TOEIC_LR_2016', LayoutProfile(name='family'),
                              listening_furniture_identity=True, footer_identity_dpi=450,
                              footer_identity_band=(.75, .92, 1, .98),
                              discovered_key_pages={'LISTENING': [171]})
        class Context:
            def __init__(self):
                self.profile = profile
                self.layer = SimpleNamespace(page_count=465)
                self.pages = {}
                self.cache = SimpleNamespace(recognize=self.recognize)
                self.crops = []
            def page(self, page):
                self.pages[page] = (SimpleNamespace(width=500, height=700), [])
                return self.pages[page]
            def recognize(self, layer, page, bbox, **kwargs):
                self.crops.append((page, bbox, kwargs['dpi']))
                text = 'TEST 1' if 20 <= page <= 30 else 'TEST 2' if page == 31 else 'preface'
                return SimpleNamespace(words=[SimpleNamespace(text=text)])
        ctx = Context()
        pages, numbers, identity = test_pages(ctx, 1, 1, 100)
        self.assertEqual(list(range(20, 31)), pages)
        self.assertEqual([1], identity)
        self.assertEqual([], numbers)
        self.assertEqual(31, max(ctx.pages))
        self.assertTrue(all(dpi == 450 and bbox == (375, 644, 500, 686) for _, bbox, dpi in ctx.crops))

    def test_partial_discovery_preserves_known_key_pages_without_duplicates(self):
        profile = ScanProfile('family', 'TOEIC_LR_2016', LayoutProfile(name='family'),
                              key_search_last={'LISTENING': 0},
                              key_pages={'LISTENING': (146, 147)},
                              discovered_key_pages={'LISTENING': [147, 171]})
        ctx = SimpleNamespace(profile=profile, layer=SimpleNamespace(page_count=201), cache=None)
        with patch('exam_extractor.toeic_scan.read_key_page', return_value=[]) as read:
            _read_key_blocks(ctx, 'LISTENING', range(1, 101), 'TOEIC_LR_2016')
            self.assertEqual([146, 147, 171], [call.args[1] for call in read.call_args_list])

    def test_fused_number_keeps_single_column_options_with_their_question(self):
        def row(y, tokens):
            return Row(1, y, y + 8, tokens[0].x0, tokens[-1].x1, tokens, 'OCR')
        rows = [row(100, [Token('147.', 10, 28), Token('Prompt?', 30, 80), Token('148.', 105, 123)]),
                row(115, [Token('(A)', 15, 28), Token('Left option', 30, 90)]),
                row(130, [Token('(B)', 15, 28), Token('Left option', 30, 90)]),
                row(100, [Token('Right prompt?', 125, 200)]),
                row(115, [Token('(A)', 110, 123), Token('Right option', 125, 200)])]
        blocks = question_blocks(split_inline_columns(rows), 147, 148)
        self.assertEqual([147, 148], [q for q, _ in blocks])
        self.assertEqual(2, sum(r.text.startswith('(') for r in blocks[0][1]))
        self.assertTrue(any('Right prompt' in r.text for r in blocks[1][1]))

    def test_shared_baseline_is_copied_and_budget_stays_per_context(self):
        extractor = SimpleNamespace()
        layer = SimpleNamespace(sha256='source-hash')
        profile = ScanProfile('family', 'TOEIC_LR_2016', LayoutProfile(name='family'), page_budget=1)
        first = ScanContext(extractor, layer, None, profile, None, None)
        second = ScanContext(extractor, layer, None, profile, None, None)
        layout = SimpleNamespace(markers=['printed'])
        with patch('exam_extractor.toeic_scan.analyze_page', return_value=layout) as analyze, \
                patch('exam_extractor.toeic_scan.ocr_layout', return_value=[]):
            first.page(1)[0].markers.append('parser mutation')
            self.assertEqual(['printed'], second.page(1)[0].markers)
            self.assertEqual(1, analyze.call_count)
            self.assertEqual([1], second.used)


if __name__ == '__main__':
    unittest.main()
