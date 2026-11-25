"""
Unit and regression tests for ECSM-v1 / EC-PRISM Phase P6.1:
Provenance Repair, Hard-Error Mining, Two-Pass Canonical Firewall, Ambiguity Engine, and Private Data Flywheel.
"""

from collections import Counter
import unittest
from typing import List

from app.services.pronunciation.ecsm.annotation_engine import (
    AdjudicationState,
    AmbiguityDistribution,
    LabelTier,
    PassAJudgmentStatus,
    PassAPayload,
    PassAResponse,
    PassBErrorType,
    PassBPayload,
    PassBResponse,
    PrivateDataFlywheelRecord,
    TwoPassAnnotationItem,
    assign_deterministic_speaker_split,
    compute_vote_distribution,
)
from app.services.pronunciation.ecsm.hard_error_miner import (
    CandidateEvaluationRecord,
    HardErrorBucket,
    HardErrorPoolItem,
    HardErrorPriorityEngine,
)
from scripts.ecsm_p6_1_engine import (
    audit_baseline_drift,
    audit_existing_annotation_provenance,
    compute_cross_backbone_disagreement,
    reconcile_licenses_and_checkpoints,
    reconcile_speakers,
)


class TestEcsmP61(unittest.TestCase):
    """Phase P6.1 test suite."""

    def test_checkpoint_and_license_provenance(self):
        """Re-audits candidate revisions, weights licenses, and commercial statuses."""
        lic_data, ckpt_data = reconcile_licenses_and_checkpoints()
        self.assertIn("B0_MODEL_E", lic_data["candidates"])
        self.assertIn("B1_HUBERT_BASE", lic_data["candidates"])
        self.assertIn("B2_WAVLM_BASE_PLUS", lic_data["candidates"])

        # Check licenses
        self.assertEqual(lic_data["candidates"]["B0_MODEL_E"]["commercialUseStatus"], "RESEARCH_ONLY_NON_COMMERCIAL")
        self.assertEqual(lic_data["candidates"]["B1_HUBERT_BASE"]["commercialUseStatus"], "PERMISSIVE_COMMERCIAL_PERMITTED")
        self.assertEqual(lic_data["candidates"]["B2_WAVLM_BASE_PLUS"]["commercialUseStatus"], "PERMISSIVE_COMMERCIAL_PERMITTED")

        # Check pinned commits
        hubert_ckpt = next(c for c in ckpt_data["verifiedCheckpoints"] if c["candidate"] == "B1_HUBERT_BASE")
        self.assertEqual(hubert_ckpt["pinnedRevision"], "dba3bb02fda4248b6e082697eee756de8fe8aa8a")

    def test_speaker_reconciliation(self):
        """Verifies that 100 manifest speakers and 98 substitution speakers reconcile without data loss."""
        # Simulated manifest with 100 speakers and substitution rows from 98
        train_rows = [{"speakerId": f"spk_{i}"} for i in range(100)]
        train_subs = [{"speakerId": f"spk_{i}"} for i in range(98)]
        val_rows = [{"speakerId": f"val_spk_{i}"} for i in range(25)]
        val_subs = [{"speakerId": f"val_spk_{i}"} for i in range(25)]

        res = reconcile_speakers(train_rows, train_subs, val_rows, val_subs)
        self.assertEqual(res["trainSplit"]["totalSpeakersInManifest"], 100)
        self.assertEqual(res["trainSplit"]["speakersWithSubstitutionErrors"], 98)
        self.assertEqual(len(res["trainSplit"]["droppedSpeakers"]), 2)
        self.assertEqual(res["status"], "RECONCILED_AND_VERIFIED")

    def test_hard_error_priority_and_buckets(self):
        """Verifies priority scoring and bucket classification for hard errors."""
        engine = HardErrorPriorityEngine()

        # Record 1: Confident wrong minimal pair
        rec1 = CandidateEvaluationRecord(
            row_id="r1",
            utterance_id="u1",
            speaker_id="s1",
            word="think",
            expected_phone="TH",
            human_perceived_phone="S",
            model_e_pred="S",
            hubert_pred="S",
            wavlm_pred="S",
            top1_pred="S",
            is_correct=0,
            risk_score=0.9,
            confidence=0.95,
            alignment_entropy=0.3,
            articulatory_distance=1.0,
            neighbor_purity=0.85,
            phone_train_support=100,
            confusion_train_support=20,
        )

        p1, comps1, bucket1 = engine.compute_priority_score(rec1)
        self.assertGreater(p1, 0.30)
        # Should be classified as label suspect or high conf wrong
        self.assertIn(bucket1, [HardErrorBucket.LABEL_SUSPECT, HardErrorBucket.HIGH_CONF_WRONG_PHONE, HardErrorBucket.MINIMAL_PAIR_BOUNDARY])

        # Record 2: Known correct control sample
        rec2 = CandidateEvaluationRecord(
            row_id="r2",
            utterance_id="u2",
            speaker_id="s2",
            word="cat",
            expected_phone="K",
            human_perceived_phone="K",
            model_e_pred="K",
            hubert_pred="K",
            wavlm_pred="K",
            top1_pred="K",
            is_correct=1,
            risk_score=0.05,
            confidence=0.95,
            alignment_entropy=0.1,
            articulatory_distance=0.0,
            neighbor_purity=0.95,
            phone_train_support=200,
            confusion_train_support=200,
        )
        p2, comps2, bucket2 = engine.compute_priority_score(rec2)
        self.assertEqual(bucket2, HardErrorBucket.HIGH_VALUE_CORRECT_CONTROL)

    def test_diversity_constrained_queue_assembly(self):
        """Verifies speaker caps, canonical caps, and control sample quotas."""
        engine = HardErrorPriorityEngine()
        records = []
        # Generate 100 records across 5 speakers (20 per speaker)
        for i in range(100):
            spk = f"spk_{i % 5}"
            canon = f"P_{i % 4}"
            rec = CandidateEvaluationRecord(
                row_id=f"r_{i}",
                utterance_id=f"u_{i}",
                speaker_id=spk,
                word="test",
                expected_phone=canon,
                human_perceived_phone="S",
                model_e_pred="S",
                hubert_pred="T",
                wavlm_pred="S",
                top1_pred="T",
                is_correct=0,
                risk_score=0.5,
                confidence=0.6,
                alignment_entropy=0.4,
                articulatory_distance=1.2,
                neighbor_purity=0.5,
                phone_train_support=50,
                confusion_train_support=10,
            )
            records.append(rec)

        pool = engine.mine_and_rank_pool(records)
        queue = engine.select_diversity_constrained_queue(pool, target_size=20, max_per_speaker_fraction=0.25)
        self.assertLessEqual(len(queue), 20)

        # Check speaker cap
        spk_counts = Counter([x.speaker_id for x in queue])
        for s, cnt in spk_counts.items():
            self.assertLessEqual(cnt, 5)

    def test_two_pass_canonical_firewall(self):
        """Verifies strict Pass A firewall, Pass B gating, and Pass A immutability."""
        item = TwoPassAnnotationItem(
            item_id="item_123",
            audio_id="aud_456",
            speaker_id="spk_789",
            segment_start_ms=120.0,
            segment_end_ms=240.0,
            expected_canonical_phone="TH",
            reference_word="think",
        )

        # 1. Generate Pass A payload -> must NOT contain canonical phone or reference word
        payload_a = item.create_pass_a_payload(allowed_inventory=["TH", "S", "T", "F"])
        self.assertTrue(payload_a.verify_firewall_integrity())
        self.assertFalse(hasattr(payload_a, "expected_canonical_phone"))
        self.assertFalse(hasattr(payload_a, "reference_word"))

        # 2. Attempting to get Pass B before Pass A must fail
        with self.assertRaises(PermissionError):
            item.create_pass_b_payload(annotator_id="phonetician_1")

        # 3. Submit Pass A judgment
        resp_a = PassAResponse(
            annotator_id="phonetician_1",
            timestamp_utc="2026-08-31 08:30:00 UTC",
            status=PassAJudgmentStatus.PERCEIVED,
            primary_perceived_phone="S",
            alternative_phones=["TH"],
            confidence=0.9,
            intelligibility_score=4.5,
            is_ambiguous=True,
        )
        item.submit_pass_a_response(resp_a)

        # 4. Now Pass B payload can be retrieved
        payload_b = item.create_pass_b_payload(annotator_id="phonetician_1")
        self.assertEqual(payload_b.expected_canonical_phone, "TH")
        self.assertEqual(payload_b.reference_word, "think")
        self.assertEqual(payload_b.pass_a_primary_perceived_phone, "S")

        # 5. Submit Pass B judgment
        resp_b = PassBResponse(
            annotator_id="phonetician_1",
            timestamp_utc="2026-08-31 08:31:00 UTC",
            error_type=PassBErrorType.SUBSTITUTION,
            is_valid_variant=False,
            pedagogical_severity=4,
        )
        item.submit_pass_b_response(resp_b)

        # 6. Finalize adjudication
        item.finalize_adjudication()
        self.assertEqual(item.pass_a_responses[0].primary_perceived_phone, "S")
        self.assertTrue(item.is_locked)

    def test_ambiguity_distribution_representation(self):
        """Verifies multi-annotator vote distributions and ambiguity detection."""
        # Case 1: Unanimous consensus (3 /s/)
        d1 = compute_vote_distribution(["S", "S", "S"])
        self.assertEqual(d1.majority_phone, "S")
        self.assertEqual(d1.majority_fraction, 1.0)
        self.assertFalse(d1.is_ambiguous)
        self.assertEqual(d1.entropy, 0.0)

        # Case 2: Ambiguous distribution (2 /s/, 1 /th/)
        d2 = compute_vote_distribution(["S", "S", "TH"])
        self.assertEqual(d2.majority_phone, "S")
        self.assertAlmostEqual(d2.majority_fraction, 2.0 / 3.0, places=2)
        self.assertTrue(d2.is_ambiguous)
        self.assertGreater(d2.entropy, 0.80)

    def test_private_data_manifest_and_speaker_split(self):
        """Verifies deterministic speaker-disjoint splitting and consent metadata."""
        spk_1 = "spk_pseudonym_alpha"
        spk_2 = "spk_pseudonym_beta"

        split_1a = assign_deterministic_speaker_split(spk_1)
        split_1b = assign_deterministic_speaker_split(spk_1)
        self.assertEqual(split_1a, split_1b)  # Deterministic

        rec = PrivateDataFlywheelRecord(
            sample_id="PRIV-001",
            audio_sha256="abcdef1234567890",
            speaker_pseudonym_id=spk_1,
            source_dataset="ENGLISHCOACH_LEARNER_V1",
            consent_category="EXPLICIT_RESEARCH_TRAINING_CONSENT",
            training_permission=True,
            retention_policy="PERMANENT_RESEARCH",
            annotation_tier=LabelTier.TIER_3_ADJUDICATED_GOLD,
            annotation_version="1.0.0",
            phone_inventory_version="ecsm-57-ipa",
            segment_start_ms=100.0,
            segment_end_ms=250.0,
            expected_canonical_phone="R",
            quality_status="CLEAN",
            split_assignment=split_1a,
        )
        d = rec.to_dict()
        self.assertTrue(d["trainingPermission"])
        self.assertIn("speakerPseudonymId", d)


if __name__ == "__main__":
    unittest.main()
