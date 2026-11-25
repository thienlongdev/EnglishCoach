"""Phase 4.1 tests: source-faithful key repair (examiner annotations, optional-word expansion bounded by the printed
limit, variant separator printed / OCR'd as 'I' or '1', page folio, calendar dates as 'a number'), deterministic proofs,
the fingerprinted decision ledger (stale decisions rejected, valid ones persist, CORRECT semantics), crop technical
checks, and the completion-template mirror. Synthetic data only — no exam text.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from exam_extractor.answer_keys import (expand_alternatives, resolve_key, scorer_word_count, separator_repair,
                                        split_annotations)
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.ielts import is_page_folio
from exam_extractor.model import AnswerKey, GK_GAP
from exam_extractor.qa_queue import template_complete
from exam_extractor.qa_review import _status, entry_fingerprint, prove_separator_repair, read_ledger


def _resolve(raw: str, limit: int, allow_number: bool = False):
    log = DiagnosticLog()
    key = AnswerKey(5, [raw])
    return resolve_key(GK_GAP, key, [], limit, allow_number, log, "ANSWER_KEY/LISTENING"), key, log


class KeyRepairTest(unittest.TestCase):
    def test_slash_read_as_digit_is_a_separator_not_a_number(self):
        vals, _k, log = _resolve("alpha 1 beta", 1, True)
        self.assertEqual(["alpha", "beta"], vals)
        self.assertTrue(any("WORD_LIMIT_FORCED" in (d.detail or "") for d in log.items))
        self.assertIsNone(separator_repair("alpha 1 beta", 3, True), "within the limit '1' may be a real number")

    def test_capital_i_separator_and_pronoun(self):
        self.assertEqual(["colour", "color"], separator_repair("colour I color", 1, False)[0])
        self.assertIsNone(separator_repair("what I need", 3, False), "a pronoun inside a phrase is never split")
        self.assertEqual("NUMERIC_FORMS", separator_repair("250 I two hundred and fifty", 1, True)[1])

    def test_bracket_expansion_bounded_by_printed_limit(self):
        vals, _k, log = _resolve("(first) middle (last part)", 3)
        self.assertEqual(["first middle", "middle last part", "middle"], vals)
        self.assertNotIn("first middle last part", vals, "the all-optional combination breaks NO MORE THAN THREE WORDS")
        printed = _resolve("one two three four / five", 3)[0]
        self.assertIn("one two three four", printed, "a PRINTED alternative is never dropped (conflict stays visible)")

    def test_examiner_annotations_are_not_answers(self):
        self.assertEqual(("word one", ["other"], set()), split_annotations("word one (do not accept 'other')"))
        self.assertEqual(("Name Street", [], {"CAPITALS_REQUIRED"}), split_annotations("Name Street (must have capitals)"))
        vals, key, _log = _resolve("a b//c d (do not accept 'e')", 3)
        self.assertEqual(["a b", "c d"], vals)
        self.assertEqual(["e"], key.rejected)

    def test_date_variants_count_as_the_number(self):
        self.assertEqual(0, scorer_word_count("the 13th of January", True))
        self.assertEqual(0, scorer_word_count("January the 13th", True))
        self.assertEqual(4, scorer_word_count("the 13th of January", False))
        self.assertEqual(2, scorer_word_count("may be", True))
        vals = _resolve("(the) 13(th) (of) January / 13.01", 1, True)[0]
        self.assertIn("the 13th of January", vals, "printed optional date words are accepted, not pruned")

    def test_alternatives_keep_printed_units(self):
        self.assertEqual([("x", ["x"]), ("(y) z", ["y z", "z"])], expand_alternatives("x / (y) z"))


class FolioTest(unittest.TestCase):
    class Row:
        def __init__(self, text, y0):
            from exam_extractor.pdf_layer import Token
            self.tokens = [Token(text, 400, 420)]
            self.y0, self.y1, self.page = y0, y0 + 10, 122

    def test_folio_only_as_lowest_footer_number_near_the_page_index(self):
        folio, answer = self.Row("121", 660), self.Row("practise", 500)
        self.assertTrue(is_page_folio(folio, 122, 729, [answer, folio]))
        self.assertFalse(is_page_folio(self.Row("250", 660), 122, 729, [answer]), "an answer value is not a folio")
        low = self.Row("121", 300)
        self.assertFalse(is_page_folio(low, 122, 729, [low, answer]), "not in the page foot")


def _pkg(values, limit, rule="ONE WORD ONLY"):
    return {"sections": [{"id": "s", "skill": "READING"}], "parts": [{"id": "p", "sectionId": "s", "partCode": "PART_1"}],
            "formGroups": [{"groupId": "g", "partId": "p"}],
            "items": [{"id": "i", "groupId": "g", "interactionType": "TEXT_GAP",
                       "optionDefinitions": {"questionNumber": 26, "group": {"wordLimitRule": rule}}}],
            "answerSpecs": [{"itemId": "i", "wordLimit": limit, "acceptedAnswers": {"values": values}}],
            "stimuli": [], "groupStimuli": [], "manifest": {"contentHash": "h", "packageId": "P"}}


def _entry(detail, q="26"):
    return {"id": "e1", "type": "ANSWER_KEY", "subtype": "ANSWER_KEY_OCR_REPAIRED", "scope": "ANSWER_KEY/READING",
            "questions": q, "detail": detail, "sha256": "s"}


class ProofTest(unittest.TestCase):
    def test_separator_proof_is_reverified_on_the_package(self):
        e = _entry("variant separator (WORD_LIMIT_FORCED; glyph 'I')")
        self.assertEqual("DETERMINISTIC_SEPARATOR_WORD_LIMIT_FORCED",
                         prove_separator_repair(e, _pkg(["jewellery", "jewelry"], 1))["method"])
        self.assertIsNone(prove_separator_repair(e, _pkg(["jewellery", "jewelry"], 3)), "the limit would allow the phrase")
        self.assertIsNone(prove_separator_repair(_entry("variant separator (NUMERIC_NOTATIONS; glyph 'I')"),
                                                 _pkg(["3.30", "half past three"], 3)), "different notations: human")
        self.assertIsNotNone(prove_separator_repair(_entry("variant separator (NUMERIC_FORMS; glyph 'I')"),
                                                    _pkg(["250", "two hundred and fifty"], 1, "ONE WORD AND/OR A NUMBER")))
        self.assertIsNone(prove_separator_repair(_entry("variant separator (NUMERIC_FORMS; glyph 'I')"),
                                                 _pkg(["250", "two hundred"], 1)), "not the same number")


class LedgerTest(unittest.TestCase):
    def _ledger(self, decisions):
        d = tempfile.TemporaryDirectory()
        staging = Path(d.name)
        (staging / "qa").mkdir()
        (staging / "qa" / "approvals.json").write_text(json.dumps({"decisions": decisions}), encoding="utf-8")
        self.addCleanup(d.cleanup)
        return staging

    def test_stale_approval_rejected_and_unchanged_one_persists(self):
        e = _entry("x")
        fp = entry_fingerprint(e, "P", _pkg(["a"], 1))
        staging = self._ledger([{"entryId": "e1", "decision": "APPROVE", "reviewer": "owner",
                                 "reviewedAt": "2026-10-03T10:00:00Z", "fingerprint": fp}])
        decisions, invalid = read_ledger(staging)
        self.assertEqual([], invalid)
        self.assertEqual("APPROVED", _status("e1", fp, None, decisions)[0], "16. fingerprint unchanged ⇒ decision persists")
        changed = entry_fingerprint(e, "P", _pkg(["b"], 1))
        self.assertNotEqual(fp, changed)
        self.assertEqual("STALE_DECISION", _status("e1", changed, None, decisions)[0], "15. package value changed ⇒ stale")
        moved = entry_fingerprint({**e, "sha256": "other-source"}, "P", _pkg(["a"], 1))
        self.assertEqual("STALE_DECISION", _status("e1", moved, None, decisions)[0], "15. source changed ⇒ stale")

    def test_invalid_records_and_correct_semantics(self):
        staging = self._ledger([
            {"entryId": "a", "decision": "APPROVE", "reviewer": "o", "reviewedAt": "t"},                       # no fingerprint
            {"entryId": "b", "decision": "CORRECT", "reviewer": "o", "reviewedAt": "t", "fingerprint": "sha256:x"},  # no value
            {"entryId": "c", "decision": "CORRECT", "reviewer": "o", "reviewedAt": "t", "fingerprint": "sha256:x",
             "correctedValue": {"26": {"values": ["fixed"]}}},
            {"entryId": "d", "decision": "REJECT", "reviewer": "o", "reviewedAt": "t", "fingerprint": "sha256:y"},
        ])
        decisions, invalid = read_ledger(staging)
        self.assertEqual({"a": "MISSING_FINGERPRINT", "b": "CORRECT_WITHOUT_VALUE"}, {i["entryId"]: i["reason"] for i in invalid})
        self.assertEqual("CORRECTION_PENDING", _status("c", "sha256:x", None, decisions)[0])
        self.assertEqual("CORRECTED", _status("c", "sha256:new", None, decisions, {"26": {"values": ["fixed"]}})[0])
        self.assertEqual("STALE_DECISION", _status("c", "sha256:new", None, decisions, {"26": {"values": ["other"]}})[0])
        self.assertEqual("REJECTED", _status("d", "sha256:y", None, decisions)[0])
        self.assertEqual("RESOLVED_BY_PROOF", _status("d", "sha256:y", {"method": "X"}, decisions)[0])


class CropTechnicalTest(unittest.TestCase):
    def test_blank_whitespace_hash_and_binding_checks(self):
        from PIL import Image, ImageDraw
        from exam_extractor.media_qa import technical_check

        def png(draw):
            im = Image.new("RGB", (200, 120), "white")
            if draw:
                d = ImageDraw.Draw(im)
                for x in range(0, 200, 10):
                    d.line([(x, 0), (x, 120)], fill="black", width=3)
            b = io.BytesIO()
            im.save(b, "PNG")
            return b.getvalue()

        with tempfile.TemporaryDirectory() as d:
            staging = Path(d)
            (staging / "assets" / "images").mkdir(parents=True)
            out = {}
            for name, data in (("ink", png(True)), ("blank", png(False))):
                sha = hashlib.sha256(data).hexdigest()
                (staging / "assets" / "images" / f"{sha}.png").write_bytes(data)
                out[name] = sha
            index = {f"extracted/images/{s}.png": {"kind": "IMAGE", "sha256": s, "derivedFrom": []} for s in out.values()}

            def b(sha, groups=("g1",)):
                return {"sha256": sha, "mimeType": "image/png", "groupIds": list(groups), "stimulusSourcePages": []}

            ink = technical_check(staging, index, b(out["ink"]), [b(out["ink"])], None, None)
            self.assertNotIn("CROP_BLANK", ink["codes"])
            self.assertIn("CROP_PROVENANCE_MISSING", ink["codes"], "no provenance ⇒ never technically valid")
            blank = technical_check(staging, index, b(out["blank"]), [b(out["blank"])], None, None)
            self.assertIn("CROP_BLANK", blank["codes"])
            unbound = technical_check(staging, index, b(out["ink"], ()), [b(out["ink"], ())], None, None)
            self.assertIn("CROP_NOT_BOUND", unbound["codes"])
            dup = technical_check(staging, index, b(out["ink"], ("g1",)), [b(out["ink"], ("g1",)), b(out["ink"], ("g2",))], None, None)
            self.assertIn("DUPLICATE_CROP_BINDING", dup["codes"])
            (staging / "assets" / "images" / f"{out['ink']}.png").write_bytes(png(False))
            tampered = technical_check(staging, index, b(out["ink"]), [b(out["ink"])], None, None)
            self.assertIn("CROP_HASH_UNSTABLE", tampered["codes"])


class ApplyCropDecisionTest(unittest.TestCase):
    def test_validated_only_with_current_fingerprint_approval(self):
        from unittest import mock
        from exam_extractor import media_qa
        pkg = {"manifest": {"packageId": "P"},
               "assets": [{"id": "a1", "sha256Hash": "c" * 64, "mimeType": "image/png", "validationState": "PENDING"}],
               "stimulusAssets": [{"assetId": "a1", "stimulusId": "s1", "role": "VISIBLE_MEDIA"}],
               "stimuli": [{"id": "s1", "kind": "IMAGE", "bodyPayload": {"sourcePage": 3}}],
               "groupStimuli": [{"groupId": "g1", "stimulusId": "s1"}],
               "items": [{"id": "i1", "groupId": "g1", "logicalItemKey": "K1", "optionDefinitions": {"questionNumber": 1}}]}
        derived = {"rawSourceSha256": "r", "page": 3, "bbox": [0, 0, 10, 10]}
        valid = {"status": "TECHNICALLY_VALID", "codes": [], "checks": {}, "derivedFrom": derived}
        binding = media_qa.image_bindings(pkg)[0]
        fp = media_qa.unit_fingerprint("toeic/x/test-1", "P", binding, derived)
        uid = media_qa.unit_id("toeic/x/test-1", "c" * 64)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(media_qa, "technical_check", return_value=valid):
            staging = Path(d)
            (staging / "qa").mkdir()
            self.assertEqual(0, media_qa.apply_crop_decisions(json.loads(json.dumps(pkg)), "toeic/x/test-1", staging),
                             "technically valid alone is never VALIDATED")
            for fingerprint, expected in (("sha256:stale", 0), (fp, 1)):
                (staging / "qa" / "approvals.json").write_text(json.dumps({"decisions": [
                    {"entryId": uid, "decision": "APPROVE", "reviewer": "owner", "reviewedAt": "2026-10-03T10:00:00Z",
                     "fingerprint": fingerprint}]}), encoding="utf-8")
                copy = json.loads(json.dumps(pkg))
                self.assertEqual(expected, media_qa.apply_crop_decisions(copy, "toeic/x/test-1", staging), fingerprint)
                self.assertEqual("VALIDATED" if expected else "PENDING", copy["assets"][0]["validationState"])


class TemplateMirrorTest(unittest.TestCase):
    def test_matches_runtime_rule(self):
        self.assertTrue(template_complete("(1) ______ and (2) ______", [1, 2]))
        self.assertFalse(template_complete("(1) The word ______ here.\n(2) Another ______.", [1, 2]),
                         "sentence completion: number at line start ⇒ per-item fallback (needs human approval)")
        self.assertFalse(template_complete("(1) ______ (1) ______", [1]), "a blank twice")
        self.assertFalse(template_complete("(1) ______ (3) ______", [1]), "a foreign blank")


if __name__ == "__main__":
    unittest.main()
