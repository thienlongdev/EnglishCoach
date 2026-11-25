"""Late tests must remain discoverable through printed-number runs, never guessed pages."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from dataclasses import replace

from exam_extractor.toeic_scan import BudgetExhausted, PROFILES, test_pages
from exam_extractor.tests.test_phase35 import _text_row


class BookContext:
    def __init__(self, budget):
        self.layer = SimpleNamespace(page_count=100)
        self.profile = PROFILES["economy-vol-1"]
        self.cache = None
        self.pages = {}
        self.budget = budget

    def page(self, page):
        if len(self.pages) >= self.budget:
            raise BudgetExhausted("synthetic page budget exhausted")
        # Ten printed questions per page, ten pages per test, repeated ten times.
        first = 101 + ((page - 1) % 10) * 10
        rows = [_text_row(f"{number}. Sample", page=page, y=number)
                for number in range(first, first + 10)]
        self.pages[page] = (None, rows)
        return self.pages[page]


class DiscoveryBudgetTest(unittest.TestCase):
    def footer_context(self, conflicting=False, restart=False):
        context = BookContext(273)
        context.layer.page_count = 6
        context.profile = replace(PROFILES['ybm-vol-2'], discovered_key_pages={'LISTENING': [6]})
        def page(number):
            ordinals = {1: [], 2: [1, 2], 3: [3, 4], 4: [1] if restart else [5, 6], 5: [1]}
            rows = [_text_row(f'{q}. Sample', page=number, y=q) for q in ordinals[number]]
            layout = SimpleNamespace(width=600, height=800)
            context.pages[number] = (layout, rows)
            return layout, rows
        def recognize(layer, number, bbox, **kwargs):
            titles = {2: 'TEST 1', 5: 'TEST 2'}
            text = titles.get(number, '')
            if conflicting and number == 2 and kwargs.get('pipeline') == 'P2':
                text = 'TEST 7'
            return SimpleNamespace(words=[SimpleNamespace(text=text)])
        context.page = page
        context.cache = SimpleNamespace(recognize=recognize)
        return context

    def test_facing_tail_uses_own_continuing_ordinals_before_foreign_title(self):
        pages, numbers, identity = test_pages(self.footer_context(), 1, 1, 100)
        self.assertEqual([2, 3, 4], pages)
        self.assertEqual([1, 2, 3, 4, 5, 6], numbers)
        self.assertEqual([1], identity)

    def test_conflicting_footer_reads_never_assign_a_test(self):
        self.assertEqual(([], [], None), test_pages(self.footer_context(conflicting=True), 1, 1, 100))

    def test_unlabelled_restart_closes_proven_test(self):
        pages, numbers, _ = test_pages(self.footer_context(restart=True), 1, 1, 100)
        self.assertEqual([2, 3], pages)
        self.assertEqual([1, 2, 3, 4], numbers)

    def test_unrelated_cached_answer_page_cannot_extend_last_test_window(self):
        ctx=self.footer_context()
        original=ctx.cache.recognize
        ctx.cache.recognize=lambda layer,number,bbox,**kwargs: NS_result if number==5 else original(layer,number,bbox,**kwargs)
        NS_result=SimpleNamespace(words=[SimpleNamespace(text='')])
        ctx.pages[20]=(None,[_text_row('99. Answer material',page=20,y=99)])
        pages,numbers,_=test_pages(ctx,1,1,100)
        self.assertEqual([2,3,4],pages)
        self.assertEqual([1,2,3,4,5,6],numbers)

    @patch("exam_extractor.toeic_scan.furniture_text", return_value={})
    def test_late_printed_run_exceeds_old_pilot_budget(self, _furniture):
        with self.assertRaises(BudgetExhausted):
            test_pages(BookContext(72), 9, 101, 200)
        pages, numbers, furniture = test_pages(BookContext(PROFILES["economy-vol-1"].page_budget), 9, 101, 200)
        self.assertEqual(list(range(81, 91)), pages)
        self.assertEqual(list(range(101, 201)), numbers)
        self.assertEqual([], furniture)

    @patch("exam_extractor.toeic_scan.furniture_text", return_value={})
    def test_missing_run_is_not_invented(self, _furniture):
        self.assertEqual(([], [], None), test_pages(BookContext(273), 11, 101, 200))
