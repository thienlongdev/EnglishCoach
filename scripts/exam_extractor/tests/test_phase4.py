"""Phase 4A tests: release priority of QA entries, deterministic proof resolvers (closed answer domain only — never an
ambiguous repair), human decisions only from the approvals ledger, QA_APPROVED derivation, and the golden invariant that
nothing in the release candidates is auto-approved.

Unit tests use synthetic packages / entries only — no exam text. Golden tests read the local staging and are skipped
when it is absent.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from exam_extractor.corpus import REPO_ROOT
from exam_extractor.qa_review import (BLOCKING_RELEASE_PRIORITIES, prove_closed_domain_repair, release_priority,
                                      _load_approvals)

STAGING = REPO_ROOT / "imports" / "exams" / "staging"
HAVE_REVIEW = (STAGING / "reports" / "qa_release_review.json").exists()


def _pkg(domain, key, interaction="TRUTH_CLASSIFICATION", qn=11):
    return {
        "sections": [{"id": "s1", "skill": "READING"}],
        "parts": [{"id": "p1", "sectionId": "s1"}],
        "formGroups": [{"groupId": "g1", "partId": "p1"}],
        "items": [{"id": "i1", "groupId": "g1", "interactionType": interaction,
                   "optionDefinitions": {"questionNumber": qn, "options": [{"id": d, "text": d} for d in domain]}}],
        "answerSpecs": [{"itemId": "i1", "acceptedAnswers": {"values": key}}],
    }


def _entry(detail, questions="11", subtype="ANSWER_KEY_OCR_REPAIRED", scope="ANSWER_KEY/READING"):
    return {"type": "ANSWER_KEY", "subtype": subtype, "detail": detail, "questions": questions, "scope": scope}


class ReleasePriorityTest(unittest.TestCase):
    def test_correctness_is_p0(self):
        for e in ({"type": "ANSWER_KEY", "subtype": "KEY_CELL_REREAD_ADJUDICATED"},
                  {"type": "OCR", "subtype": "QUESTION_NUMBER_GAP"},
                  {"type": "OCR", "subtype": "OPTION_LABEL_RECOGNISED"},
                  {"type": "PART6_BLANK", "subtype": "PART6_BLANK_MAPPING_UNPROVEN"},
                  {"type": "IMAGE_CROP", "subtype": "PHOTO_MAPPING_UNPROVEN"},
                  {"type": "TEST_NUMBER", "subtype": "TEST_BOUNDARY_NOT_FOUND"}):
            self.assertEqual("P0", release_priority(e), e)

    def test_display_crop_metadata_cosmetic(self):
        self.assertEqual("P1", release_priority({"type": "OCR_READING_ORDER", "subtype": "LAYOUT_LINEARIZED"}))
        self.assertEqual("P2", release_priority({"type": "IMAGE_CROP", "subtype": "PART1_PHOTO_CROP"}))
        self.assertEqual("P3", release_priority({"type": "OTHER", "subtype": "SELECTION_METADATA"}))
        self.assertEqual("P4", release_priority({"type": "OCR", "subtype": "OCR_LOW_CONFIDENCE"}))
        self.assertEqual("P1", release_priority({"type": "NEW", "subtype": "SOMETHING_UNKNOWN"}),
                         "unknown codes are never cosmetic")
        self.assertEqual(("P0", "P1", "P2", "P3"), BLOCKING_RELEASE_PRIORITIES)


class ProofResolverTest(unittest.TestCase):
    TFNG = ["TRUE", "FALSE", "NOT GIVEN"]

    def test_unique_closed_domain_match_is_proof(self):
        proof = prove_closed_domain_repair(_entry("NOTGIVEN"), _pkg(self.TFNG, ["NOT GIVEN"]))
        self.assertIsNotNone(proof)
        self.assertEqual("DETERMINISTIC_CLOSED_DOMAIN_REPAIR", proof["method"])

    def test_key_must_equal_the_match(self):
        self.assertIsNone(prove_closed_domain_repair(_entry("NOTGIVEN"), _pkg(self.TFNG, ["FALSE"])))

    def test_open_domains_and_ambiguity_stay_for_a_human(self):
        self.assertIsNone(prove_closed_domain_repair(_entry("NOTGIVEN"), _pkg(["A", "B", "C"], ["A"], "SINGLE_CHOICE")))
        self.assertIsNone(prove_closed_domain_repair(_entry("variant separator"), _pkg(self.TFNG, ["NOT GIVEN"])))
        self.assertIsNone(prove_closed_domain_repair(_entry("NOTGIVEN", subtype="KEY_CELL_REREAD_ADJUDICATED"),
                                                     _pkg(self.TFNG, ["NOT GIVEN"])))
        self.assertIsNone(prove_closed_domain_repair(_entry("NOTGIVEN", questions="12"), _pkg(self.TFNG, ["NOT GIVEN"])),
                          "an entry whose question is not in the package is never proven")
        self.assertIsNone(prove_closed_domain_repair(_entry("NOTGIVEN"), None))


class ApprovalsLedgerTest(unittest.TestCase):
    def test_only_complete_human_decisions_count(self):
        """Phase 4.1 contract: APPROVE / REJECT / CORRECT + reviewer + timestamp + fingerprint; Phase 4 records without a
        fingerprint are invalid (they cannot prove what was reviewed)."""
        with tempfile.TemporaryDirectory() as d:
            staging = Path(d)
            (staging / "qa").mkdir()
            self.assertEqual({}, _load_approvals(staging), "no ledger ⇒ no approval")
            (staging / "qa" / "approvals.json").write_text(json.dumps({"decisions": [
                {"entryId": "a", "decision": "APPROVE", "reviewer": "owner", "reviewedAt": "2026-10-03", "fingerprint": "sha256:x"},
                {"entryId": "b", "decision": "APPROVE", "fingerprint": "sha256:x"},          # no reviewer / date ⇒ ignored
                {"entryId": "c", "decision": "MAYBE", "reviewer": "x", "reviewedAt": "2026-10-03", "fingerprint": "sha256:x"},
            ], "approvals": [
                {"entryId": "d", "decision": "APPROVED", "reviewer": "owner", "reviewedAt": "2026-10-03"},   # Phase 4, no fingerprint
            ]}), encoding="utf-8")
            self.assertEqual({"a"}, set(_load_approvals(staging)))


@unittest.skipUnless(HAVE_REVIEW, "local staging review not present")
class GoldenReleaseReviewTest(unittest.TestCase):
    def test_nothing_auto_approved(self):
        r = json.loads((STAGING / "reports" / "qa_release_review.json").read_text(encoding="utf-8"))
        ledger = STAGING / "qa" / "approvals.json"
        if not ledger.exists():
            self.assertEqual(0, r["summary"]["byStatus"].get("APPROVED", 0))
        for tid, p in r["packages"].items():
            for e in p["entries"]:
                if e["status"] == "RESOLVED_BY_PROOF":
                    self.assertTrue(e["proof"]["method"].startswith("DETERMINISTIC_"), e["proof"])
                    self.assertEqual("DETERMINISTIC_PROOF", e["resolutionMethod"])
                    self.assertEqual("ANSWER_KEY_OCR_REPAIRED", e["subtype"])
            blocking = any(p["openByReleasePriority"].get(k) for k in BLOCKING_RELEASE_PRIORITIES)
            self.assertEqual(not blocking and p["package"] is not None, p["qaApproved"], tid)


if __name__ == "__main__":
    unittest.main()
