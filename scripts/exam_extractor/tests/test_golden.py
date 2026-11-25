"""Phase 3 golden tests on the real local corpus (skipped when imports/source-files is absent).

Structural assertions only — counts, numbering, grouping, key alignment, provenance hashes, media binding and the
Phase 2 outcome (read from imports/exams/staging/reports/phase2_validation.json written by
ExamStagingPackageValidationTest). No source text is stored in this file.

Golden map (prompt Phase 3K):
  IELTS 1 complete READY test ........ cambridge-ielts-17/test-1   (VALID_FULL)
  IELTS 2 non-per-part audio ......... cambridge-ielts-21/test-3   (one whole-test recording -> practice only)
  IELTS 3 missing answer key ......... cambridge-ielts-3/test-1    (ANSWER_KEY_NOT_FOUND, never "")
  IELTS 4 scanned / OCR required ..... cambridge-ielts-14/test-1, cambridge-ielts-4/test-4
  IELTS 5 Academic Task 1 visual ..... cambridge-ielts-17/test-1   (MAP stimulus + rendered image asset)
  TOEIC 6 cleanest available ......... ets-2019/test-1 Part 5      (real stems + 4 printed options)
  TOEIC 7/8 Part 3 / Part 4 grouping . NO text-layer LC booklet in the corpus -> covered by Phase 2 validator tests
  TOEIC 9 Part 6 passage ............. ets-2019/test-1             (blank mapping ambiguous -> no passage-less group)
  TOEIC 10 Part 7 multi-document ..... ets-2019/test-1             (15 sets, documents from the set headers)
  TOEIC 11 Part 1 image binding ...... NO LC booklet text layer -> Part 1 never emitted without its photograph
  TOEIC 12 missing key ............... ets-2019/test-*             (no answer spec at all, validator blocks)
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from exam_extractor.corpus import RAW_ROOT, REPO_ROOT, RawCorpusManifest
from exam_extractor.package_builder import PackageBuilder
from exam_extractor.pipeline import STAGING_ROOT, Extractor
from exam_extractor.staging import extraction_status

HAVE_CORPUS = RAW_ROOT.exists() and (REPO_ROOT / "imports/exams/manifests/raw-source/raw_source_manifest.json").exists()


def phase2(package_id: str):
    f = STAGING_ROOT / "reports" / "phase2_validation.json"
    if not f.exists():
        return None
    for r in json.loads(f.read_text(encoding="utf-8"))["results"]:
        if r.get("packageId") == package_id:
            return r
    return None


def _spoken_segments_of(t) -> bool:
    """True when the REAL staging analysed this test's recording into four CONFIDENT spoken-announcement parts."""
    staging = REPO_ROOT / "imports" / "exams" / "staging" / "audio_segments"
    for b in t.audio:
        f = staging / f"{b.sha256}.json"
        if f.exists():
            d = json.loads(f.read_text(encoding="utf-8"))
            return d.get("model") == "IELTS_SPOKEN_PART_ANNOUNCEMENTS" and                 sum(1 for s in d.get("segments", []) if s.get("tier") == "CONFIDENT") == 4
    return False


@unittest.skipUnless(HAVE_CORPUS, "raw corpus / Phase 1 manifest not present")
class Golden(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.manifest = RawCorpusManifest()
        cls.ex = Extractor(cls.manifest, Path(cls.tmp.name))
        cls.builder = PackageBuilder(cls.ex.store)
        cls.cache = {}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_test(self, tid: str):
        if tid not in self.cache:
            t = self.ex.extract(self.manifest.test(tid))
            pkg = self.builder.build(t, t.publisher) if extraction_status(t) != "INVALID_SOURCE" else None
            self.cache[tid] = (t, pkg)
        return self.cache[tid]

    @staticmethod
    def codes(t):
        return {d.code for d in t.diagnostics.items}

    # IELTS 1 + 5 ---------------------------------------------------------------------------
    def test_ielts_complete_ready_test(self):
        t, pkg = self.run_test("ielts/cambridge-ielts-17/test-1")
        self.assertEqual(extraction_status(t), "EXTRACTED_CLEAN")
        lis, rea = t.section("LISTENING"), t.section("READING")
        self.assertEqual([p.code for p in lis.parts], [f"LISTENING_PART_{n}" for n in range(1, 5)])
        self.assertEqual([i.number for i in lis.items], list(range(1, 41)))
        self.assertEqual([p.code for p in rea.parts], [f"READING_PASSAGE_{n}" for n in range(1, 4)])
        self.assertEqual([i.number for i in rea.items], list(range(1, 41)))
        self.assertTrue(all(p.passage and len(p.passage.text()) > 3000 for p in rea.parts))
        # groups are not flattened: several question groups per part, kinds preserved
        self.assertGreaterEqual(sum(len(p.groups) for p in lis.parts), 8)
        kinds = {g.kind for p in rea.parts for g in p.groups}
        self.assertTrue({"TFNG", "YNNG", "GAP_COMPLETION", "MATCHING"} <= kinds, kinds)
        # every item keyed, options carry text, TFNG options explicit
        self.assertTrue(all(i.key is not None for i in lis.items + rea.items))
        self.assertTrue(all(o.text and o.text != o.id or i.interaction == "TRUTH_CLASSIFICATION"
                            for i in lis.items + rea.items for o in i.options))
        # either-order pair (15&16) is one unordered answer set across two question numbers
        self.assertEqual(lis.items[14].key.either_order, [15, 16])
        # audio: one recording per part, provenance by hash
        self.assertEqual(len({p.audio[0].sha256 for p in lis.parts}), 4)
        prov = pkg["manifest"]["metadata"]["sourceProvenance"]
        self.assertEqual(prov["rawSourceFile"]["sha256"], t.documents[0].sha256)
        self.assertEqual(len(prov["audio"]), 4)
        self.assertTrue(prov["rawSourceFile"]["path"].startswith("imports/source-files/"))
        # 5: Academic Task 1 visual bound as a media reference (no embedded payload)
        task1 = t.section("WRITING").writing_tasks[0]
        self.assertIsNotNone(task1.figure)
        self.assertEqual(task1.visual_kind, "MAP")
        img = [a for a in pkg["assets"] if a["mimeType"] == "image/png"]
        self.assertEqual(len(img), 1)
        self.assertTrue(img[0]["objectKey"].startswith("extracted/images/"))
        p2 = phase2(pkg["manifest"]["packageId"])
        if p2:
            self.assertTrue(p2["contentHashMatches"])
            self.assertEqual(p2["phase2"]["status"], "VALID")
            self.assertTrue(p2["phase2"]["fullSimulationEligible"])

    # IELTS 2 ---------------------------------------------------------------------------------
    def test_ielts_whole_test_recording_is_not_split(self):
        t, pkg = self.run_test("ielts/cambridge-ielts-21/test-3")
        self.assertIn("SOURCE_AUDIO_WHOLE_TEST_ONLY", self.codes(t))
        lis = t.section("LISTENING")
        bound = [p.number for p in lis.parts if p.audio]
        self.assertEqual(bound, [1])     # bound once where it starts; no invented part offsets
        p2 = phase2(pkg["manifest"]["packageId"])
        if p2:
            # Phase 3.6: the real staging may split the recording, but ONLY at CONFIDENT spoken 'Part n'
            # announcements (audio_segment.apply_spoken_ielts_parts); without them it stays practice-only
            seg = _spoken_segments_of(t)
            if seg:
                self.assertIn("LISTENING", p2["phase2"]["simulationSkills"])
            else:
                self.assertFalse(p2["phase2"]["fullSimulationEligible"])
                self.assertIn("LISTENING", p2["phase2"]["practiceSkills"])
                self.assertNotIn("LISTENING", p2["phase2"]["simulationSkills"])

    # IELTS 3 ---------------------------------------------------------------------------------
    def test_ielts_missing_key_is_never_blank(self):
        t, pkg = self.run_test("ielts/cambridge-ielts-3/test-1")
        self.assertIn("ANSWER_KEY_NOT_FOUND", self.codes(t))
        if pkg:
            for a in pkg["answerSpecs"]:
                vals = a["acceptedAnswers"].get("values")
                if vals is not None:
                    self.assertTrue(all(str(v).strip() for v in vals))

    # IELTS 4 ---------------------------------------------------------------------------------
    def test_ielts_scanned_sources_require_ocr(self):
        tid = "ielts/cambridge-ielts-4/test-4"
        t, pkg = self.run_test(tid)
        self.assertIn("OCR_REQUIRED", self.codes(t), tid)
        self.assertIsNone(pkg, tid)
        # The exact Cambridge14 source now has a bounded, hash-pinned OCR profile.
        t, pkg = self.run_test("ielts/cambridge-ielts-14/test-1")
        self.assertIn("OCR_LAYOUT_USED", self.codes(t))
        self.assertIn("OCR_TEXT_USED", self.codes(t))
        self.assertNotIn("OCR_REQUIRED", self.codes(t))
        self.assertIsNotNone(pkg)

    # TOEIC 6 / 9 / 10 / 12 ------------------------------------------------------------------
    def test_toeic_reading_structure(self):
        t, pkg = self.run_test("toeic/ets-2019/test-1")
        rea = t.section("READING")
        parts = {p.number: p for p in rea.parts}
        # 6: Part 5 real stems + four printed options, no placeholder, no letter-only option
        p5 = parts[5]
        self.assertEqual([i.number for i in p5.items], list(range(101, 131)))
        self.assertTrue(all([o.id for o in i.options] == list("ABCD") and all(o.text != o.id for o in i.options)
                            for i in p5.items))
        self.assertFalse(any("mark your answer" in i.prompt.lower() for i in p5.items))
        # 9: Part 6 is omitted when the blank<->question mapping is not provable (never a passage-less group)
        self.assertNotIn(6, parts)
        self.assertIn("GROUP_STRUCTURE_AMBIGUOUS", self.codes(t))
        # 10: Part 7 = 15 sets of 2-5 items, each with its passage; documents from the printed header
        p7 = parts[7]
        self.assertEqual(len(p7.groups), 15)
        self.assertEqual(sum(len(g.items) for g in p7.groups), 54)
        self.assertTrue(all(2 <= len(g.items) <= 5 for g in p7.groups))
        self.assertTrue(all(g.passage is not None for g in p7.groups))
        docs = {g.first: len(g.passage.documents) for g in p7.groups}
        self.assertEqual(docs[176], 2)
        self.assertEqual(docs[186], 3)
        # 12: the collection has no Reading key -> no answer spec at all (never "")
        self.assertIn("ANSWER_KEY_NOT_FOUND", self.codes(t))
        self.assertEqual(pkg["answerSpecs"], [])
        multi = [s for s in pkg["stimuli"] if s["kind"] == "MULTI_DOC"]
        self.assertGreaterEqual(len(multi), 5)
        p2 = phase2(pkg["manifest"]["packageId"])
        if p2:
            self.assertEqual(p2["phase2"]["status"], "INVALID")
            self.assertIn("ANSWER_KEY_MISSING", p2["phase2"]["blockingCodes"])
            self.assertNotIn("TOEIC_PART_7_GROUP_SIZE", p2["phase2"]["blockingCodes"])
            self.assertNotIn("PLACEHOLDER_OPTIONS", p2["phase2"]["blockingCodes"])

    def test_toeic_listening_never_emitted_without_source(self):
        t, pkg = self.run_test("toeic/ets-2019/test-1")
        self.assertIsNone(t.section("LISTENING"))      # no LC booklet, no audio: no Part 1-4 (no photos, no sets)
        self.assertIn("SOURCE_AUDIO_UNMAPPED", self.codes(t))

    def test_raw_source_is_not_modified(self):
        t, _ = self.run_test("ielts/cambridge-ielts-17/test-1")
        rec = self.manifest.file_record(t.documents[0].path.replace("imports/source-files/", ""))
        self.assertEqual(rec["sha256"], t.documents[0].sha256)


if __name__ == "__main__":
    unittest.main()
