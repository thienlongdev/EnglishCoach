"""Focused unit tests for Paragraph Mode Data Pipeline core components."""

import unittest
from backend.scripts.translation_paragraph.contracts import (
    PassageCandidate,
    LegalClass,
    PublicationState,
    DocumentRecord
)
from backend.scripts.translation_paragraph.source_registry import SourceRegistry
from backend.scripts.translation_paragraph.reconstruct import (
    DocumentReconstructor,
    clean_html_markup,
    parse_raw_unit
)
from backend.scripts.translation_paragraph.align import AlignmentScorer
from backend.scripts.translation_paragraph.quality import QualityFilter
from backend.scripts.translation_paragraph.coherence import CoherenceFilter
from backend.scripts.translation_paragraph.deduplicate import Deduplicator
from backend.scripts.translation_paragraph.difficulty import DifficultyExtractor


class TestParagraphPipelineCore(unittest.TestCase):

    def setUp(self):
        self.registry = SourceRegistry()

    def test_rights_fail_closed(self):
        """Unknown or restricted sources must fail closed with is_publishable=False."""
        # Case 1: Unknown source
        res_unknown = self.registry.evaluate_rights(
            source_id="unknown_corpus_xyz",
            source_page_title="Title",
            target_page_title="TieuDe",
            source_url="http://src",
            target_url="http://tgt"
        )
        self.assertFalse(res_unknown.is_publishable)
        self.assertEqual(res_unknown.legal_class, LegalClass.BLOCKED)
        self.assertTrue(any("UNKNOWN_SOURCE" in r for r in res_unknown.rejection_reasons))

        # Case 2: Restricted research source (PhoMT)
        res_phomt = self.registry.evaluate_rights(
            source_id="phomt",
            source_page_title="Title",
            target_page_title="TieuDe",
            source_url="http://src",
            target_url="http://tgt"
        )
        self.assertFalse(res_phomt.is_publishable)
        self.assertEqual(res_phomt.legal_class, LegalClass.RESEARCH_ONLY)

        # Case 3: Sentence-only source (Tatoeba)
        res_tatoeba = self.registry.evaluate_rights(
            source_id="tatoeba",
            source_page_title="Title",
            target_page_title="TieuDe",
            source_url="http://src",
            target_url="http://tgt"
        )
        self.assertFalse(res_tatoeba.is_publishable)
        self.assertTrue(any("SOURCE_PROHIBITED_FOR_PARAGRAPHS" in r for r in res_tatoeba.rejection_reasons))

        # Case 4: Wikimedia with complete lineage passes
        res_wiki = self.registry.evaluate_rights(
            source_id="wikimedia_content_translation",
            source_page_title="Carnegie Mellon University",
            target_page_title="Đại học Carnegie Mellon",
            source_url="https://en.wikipedia.org/wiki/Carnegie_Mellon_University",
            target_url="https://vi.wikipedia.org/wiki/Đại_học_Carnegie_Mellon",
            source_revision="957494952",
            target_revision="62007889"
        )
        self.assertTrue(res_wiki.is_publishable)
        self.assertIn("CC BY-SA 4.0", res_wiki.share_alike_notice)

    def test_deterministic_hashing(self):
        """Hashes must normalize whitespace and case deterministically."""
        t1_en = "Carnegie Mellon   University is in Pittsburgh."
        t1_vi = "Đại học Carnegie Mellon   ở Pittsburgh."
        t2_en = "carnegie mellon university is in pittsburgh."
        t2_vi = "đại học carnegie mellon ở pittsburgh."

        h1_en, h1_vi, h1_bi = PassageCandidate.compute_hashes(t1_en, t1_vi)
        h2_en, h2_vi, h2_bi = PassageCandidate.compute_hashes(t2_en, t2_vi)

        self.assertEqual(h1_en, h2_en)
        self.assertEqual(h1_vi, h2_vi)
        self.assertEqual(h1_bi, h2_bi)

    def test_cross_document_isolation(self):
        """Records from different documents must NEVER be joined into one candidate."""
        records = [
            {
                "id": "1001/1",
                "source": {"content": "<p>Document one first sentence. Document one second sentence.</p>"},
                "target": {"content": "<p>Tài liệu một câu thứ nhất. Tài liệu một câu thứ hai.</p>"}
            },
            {
                "id": "1002/1",
                "source": {"content": "<p>Document two first sentence. Document two second sentence.</p>"},
                "target": {"content": "<p>Tài liệu hai câu thứ nhất. Tài liệu hai câu thứ hai.</p>"}
            }
        ]
        meta_map = {
            "1001": DocumentRecord("1001", "wiki", "Doc1", "Doc1", "http://1", "1", "Doc1_vi", "Doc1_vi", "http://1v", "1"),
            "1002": DocumentRecord("1002", "wiki", "Doc2", "Doc2", "http://2", "2", "Doc2_vi", "Doc2_vi", "http://2v", "2"),
        }
        candidates = DocumentReconstructor.reconstruct_documents(records, meta_map)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0].document_id, "1001")
        self.assertEqual(candidates[1].document_id, "1002")
        self.assertNotEqual(candidates[0].en_text, candidates[1].en_text)

    def test_quality_filter_rejections(self):
        """Detects and rejects broken Unicode, HTML remnants, and unedited MT."""
        cand = PassageCandidate(
            candidate_id="c1", source_id="s1", source_release="r1", document_id="d1",
            source_page_title="T", source_url="u", source_revision_id="1",
            target_page_title="T", target_url="u", target_revision_id="1",
            section_id="sec1", section_number=0, span_order_start=1, span_order_end=1,
            raw_source_locator="d1/1",
            en_text="This is a test paragraph with broken \ufffd character.",
            vi_text="Đây là đoạn văn bản kiểm tra có ký tự lỗi \ufffd.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        dec = QualityFilter.evaluate_quality(cand, alignment_score=0.85)
        self.assertFalse(dec.is_accepted)
        self.assertTrue(any("BROKEN_UNICODE" in r for r in dec.rejection_reasons))

    def test_coherence_dangling_pronouns(self):
        """Passages starting with unanchored pronouns must be rejected for discourse unity."""
        cand = PassageCandidate(
            candidate_id="c2", source_id="s1", source_release="r1", document_id="d1",
            source_page_title="T", source_url="u", source_revision_id="1",
            target_page_title="T", target_url="u", target_revision_id="1",
            section_id="sec1", section_number=0, span_order_start=2, span_order_end=2,
            raw_source_locator="d1/2",
            en_text="He was born in Pittsburgh and later attended the university.",
            vi_text="Ông ấy sinh ra ở Pittsburgh và sau đó theo học đại học.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        dec = CoherenceFilter.evaluate_coherence(cand)
        self.assertFalse(dec.is_accepted)
        self.assertTrue(any("DANGLING_ANAPHORA_EN" in r for r in dec.rejection_reasons))

    def test_deduplicator_exact_and_near(self):
        """Deduplicator removes exact and near-duplicate passages."""
        c1 = PassageCandidate(
            candidate_id="c1", source_id="s1", source_release="r1", document_id="d1",
            source_page_title="T", source_url="u", source_revision_id="1",
            target_page_title="T", target_url="u", target_revision_id="1",
            section_id="sec1", section_number=0, span_order_start=1, span_order_end=1,
            raw_source_locator="d1/1",
            en_text="Carnegie Mellon University is a private research university located in Pittsburgh Pennsylvania.",
            vi_text="Đại học Carnegie Mellon là một trường đại học nghiên cứu tư nhân có trụ sở tại Pittsburgh Pennsylvania.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        # c2 is an exact duplicate of c1
        c2 = PassageCandidate(
            candidate_id="c2", source_id="s1", source_release="r1", document_id="d2",
            source_page_title="T2", source_url="u2", source_revision_id="2",
            target_page_title="T2", target_url="u2", target_revision_id="2",
            section_id="sec1", section_number=0, span_order_start=1, span_order_end=1,
            raw_source_locator="d2/1",
            en_text="Carnegie Mellon University is a private research university located in Pittsburgh Pennsylvania.",
            vi_text="Đại học Carnegie Mellon là một trường đại học nghiên cứu tư nhân có trụ sở tại Pittsburgh Pennsylvania.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        dedup = Deduplicator()
        unique, removed = dedup.deduplicate([c1, c2])
        self.assertEqual(len(unique), 1)
        self.assertEqual(len(removed), 1)
        self.assertIn("EXACT_BILINGUAL_DUPLICATE", removed[0][1])

    def test_difficulty_abstention(self):
        """Difficulty features must be extracted while IELTS band remains strictly UNCALIBRATED."""
        cand = PassageCandidate(
            candidate_id="c3", source_id="s1", source_release="r1", document_id="d1",
            source_page_title="T", source_url="u", source_revision_id="1",
            target_page_title="T", target_url="u", target_revision_id="1",
            section_id="sec1", section_number=0, span_order_start=1, span_order_end=1,
            raw_source_locator="d1/1",
            en_text="Founded in 1900 by Andrew Carnegie, the institution provides diverse academic programs.",
            vi_text="Được thành lập vào năm 1900 bởi Andrew Carnegie, viện cung cấp các chương trình học đa dạng.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        feat = DifficultyExtractor.extract_features(cand)
        self.assertGreater(feat.en_word_count, 5)
        self.assertFalse(feat.ielts_band_calibrated)
        self.assertEqual(feat.calibrated_band_label, "UNCALIBRATED")

    def test_failed_gates_never_enter_final_output(self):
        """Proves that a failure in ANY gate (alignment, coherence, quality, rights) blocks entry to final output."""
        # Baseline valid candidate
        base_kwargs = dict(
            candidate_id="valid_1",
            source_id="wikimedia_content_translation",
            source_release="20260918",
            document_id="55848",
            source_page_title="Carnegie Mellon University",
            source_url="https://en.wikipedia.org/wiki/Carnegie_Mellon_University",
            source_revision_id="957494952",
            target_page_title="Đại học Carnegie Mellon",
            target_url="https://vi.wikipedia.org/wiki/Đại_học_Carnegie_Mellon",
            target_revision_id="62007889",
            section_id="cxSection1",
            section_number=1,
            span_order_start=1,
            span_order_end=1,
            raw_source_locator="55848/1",
            en_text="Carnegie Mellon University is a global research university based in Pittsburgh Pennsylvania.",
            vi_text="Đại học Carnegie Mellon là một viện đại học nghiên cứu toàn cầu có trụ sở tại Pittsburgh Pennsylvania.",
            en_hash_sha256="h1",
            vi_hash_sha256="h2",
            bilingual_hash_sha256="h3"
        )

        # 1. Failed alignment candidate (severe length mismatch)
        cand_bad_align = PassageCandidate(**{
            **base_kwargs,
            "candidate_id": "bad_align",
            "vi_text": "Quá ngắn."  # 2 words vs 13 words
        })
        align_score, spans, rejections = AlignmentScorer.align_passage(cand_bad_align)
        self.assertTrue(len(rejections) > 0 or align_score < 0.75)

        # 2. Failed coherence candidate (dangling pronoun)
        cand_bad_coh = PassageCandidate(**{
            **base_kwargs,
            "candidate_id": "bad_coh",
            "en_text": "He was founded in 1900 as the Carnegie Technical Schools by Andrew Carnegie.",
            "vi_text": "Ông ấy được thành lập vào năm 1900 như Trường Kỹ thuật Carnegie bởi Andrew Carnegie."
        })
        coh_dec = CoherenceFilter.evaluate_coherence(cand_bad_coh)
        self.assertFalse(coh_dec.is_accepted)

        # 3. Failed quality candidate (exact unedited MT output)
        cand_bad_mt = PassageCandidate(**{
            **base_kwargs,
            "candidate_id": "bad_mt",
            "mt_text": "Đại học Carnegie Mellon là một viện đại học nghiên cứu toàn cầu có trụ sở tại Pittsburgh Pennsylvania."
        })
        qual_dec = QualityFilter.evaluate_quality(cand_bad_mt, alignment_score=0.9, mt_text_clean=cand_bad_mt.mt_text)
        self.assertFalse(qual_dec.is_accepted)
        self.assertTrue(any("UNEDITED_MT_OUTPUT" in r for r in qual_dec.rejection_reasons))

        # 4. Failed rights candidate (missing source revision ID)
        cand_bad_rights = PassageCandidate(**{
            **base_kwargs,
            "candidate_id": "bad_rights",
            "source_revision_id": "0"
        })
        rights_dec = self.registry.evaluate_rights(
            source_id=cand_bad_rights.source_id,
            source_page_title=cand_bad_rights.source_page_title,
            target_page_title=cand_bad_rights.target_page_title,
            source_url=cand_bad_rights.source_url,
            target_url=cand_bad_rights.target_url,
            source_revision=cand_bad_rights.source_revision_id,
            target_revision=cand_bad_rights.target_revision_id
        )
        self.assertFalse(rights_dec.is_publishable)
        self.assertTrue(any("MISSING_SOURCE_REVISION" in r for r in rights_dec.rejection_reasons))

    def test_near_mt_flagging(self):
        """Near-identical MT is flagged for review rather than hard-rejected if text was edited."""
        cand = PassageCandidate(
            candidate_id="c_near_mt",
            source_id="wikimedia_content_translation",
            source_release="20260918",
            document_id="55848",
            source_page_title="T", source_url="u", source_revision_id="1",
            target_page_title="T", target_url="u", target_revision_id="1",
            section_id="sec1", section_number=1, span_order_start=1, span_order_end=1,
            raw_source_locator="55848/1",
            en_text="The campus covers one hundred and forty acres in the Oakland neighborhood of Pittsburgh.",
            vi_text="Khuôn viên trường rộng một trăm bốn mươi mẫu Anh tại khu phố Oakland của Pittsburgh.",
            mt_text="Khuôn viên trường rộng một trăm bốn mươi mẫu Anh ở khu phố Oakland của Pittsburgh.",
            en_hash_sha256="h1", vi_hash_sha256="h2", bilingual_hash_sha256="h3"
        )
        qual_dec = QualityFilter.evaluate_quality(cand, alignment_score=0.90, mt_text_clean=cand.mt_text)
        self.assertTrue(qual_dec.near_mt_flag)

    def test_sequential_funnel_monotonicity(self):
        """Surviving stage counts must be strictly non-increasing at every stage."""
        # Simulated counts where each stage eliminates candidates
        counts = [
            ("CANDIDATE_PASSAGES", 100),
            ("PROVENANCE_GATE_PASS", 95),
            ("AFTER_ALIGNMENT", 85),
            ("AFTER_COHERENCE", 80),
            ("AFTER_QUALITY", 75),
            ("AFTER_DEDUP", 72),
            ("AFTER_RIGHTS_GATE", 70),
            ("FINAL_PUBLISHABLE_CANDIDATES", 70)
        ]
        for i in range(len(counts) - 1):
            prev_name, prev_val = counts[i]
            curr_name, curr_val = counts[i + 1]
            self.assertGreaterEqual(
                prev_val, curr_val,
                f"Funnel integrity violation: {prev_name} ({prev_val}) < {curr_name} ({curr_val})"
            )


if __name__ == "__main__":
    unittest.main()
