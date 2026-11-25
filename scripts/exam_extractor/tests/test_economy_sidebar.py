"""Source profile geometry must remove only detached right-margin tokens."""
import unittest

from exam_extractor.pdf_layer import Row, Token
from exam_extractor.toeic_scan import remove_economy_sidebar
from exam_extractor.toeic_scan import repair_economy_source_text
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.model import Item, Section


class EconomySidebarTests(unittest.TestCase):
    def test_source_text_repair_requires_exact_source_page_and_prior_text(self):
        prior = "AlI the accountants are required to compile a report which …… annual corporate spenaing:"
        section = Section(skill="READING")
        from exam_extractor.model import Part, QuestionGroup
        item = Item(number=140, prompt=prior, interaction="SINGLE_CHOICE", pages=[31])
        group = QuestionGroup(first=140, last=140, kind="TOEIC_PART_5", items=[item])
        section.parts = [Part(code="READING_PART_5", number=5, groups=[group])]
        source = "87a169d8855ad44c3d17641f9cfcc9b53e0419af6f5877845b0de3df08d2826b"
        log = DiagnosticLog()
        repair_economy_source_text(section, "another-edition", 2, log)
        repair_economy_source_text(section, source, 3, log)
        self.assertEqual(prior, item.prompt)
        item.pages = [32]
        repair_economy_source_text(section, source, 2, log)
        self.assertEqual(prior, item.prompt)
        item.pages = [31]
        repair_economy_source_text(section, source, 2, log)
        self.assertTrue(item.prompt.endswith("annual corporate spending."))
        self.assertEqual(["SOURCE_PROVEN_TEXT_CORRECTION"], [d.code for d in log.items])
        repair_economy_source_text(section, source, 2, log)
        self.assertEqual(1, len(log.items))

    def test_detached_margin_token_removed(self):
        tokens = [Token("(B)", 320, 337), Token("synthetic", 350, 403), Token("r9", 555, 567)]
        row = Row(31, 629, 641, 320, 567, tokens)
        self.assertEqual(remove_economy_sidebar([row], 595), 1)
        self.assertEqual(row.text, "(B) synthetic")
        self.assertEqual(row.x1, 403)

    def test_contiguous_body_text_at_right_margin_retained(self):
        tokens = [Token("synthetic", 490, 550), Token("ending", 555, 590)]
        row = Row(31, 629, 641, 490, 590, tokens)
        self.assertEqual(remove_economy_sidebar([row], 595), 0)
        self.assertEqual(row.text, "synthetic ending")

    def test_detached_token_inside_body_retained(self):
        tokens = [Token("synthetic", 320, 403), Token("body", 500, 525)]
        row = Row(31, 629, 641, 320, 525, tokens)
        self.assertEqual(remove_economy_sidebar([row], 595), 0)
        self.assertEqual(row.text, "synthetic body")
