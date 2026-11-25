"""
Unit tests for ECSM Phase P6.3:
Human Perception Pilot, Two-Pass Canonical Firewall, Pass-A Sealing, Pass-B Release Gate,
Annotator Independence, and Agreement Statistics.
"""

from pathlib import Path
import tempfile
import unittest
import numpy as np

from app.services.pronunciation.ecsm.annotation_system import (
    AgreementStatisticsEngine,
    AnnotationDatabase,
    PassAFirewallValidator,
    PassAPayload,
    PassASubmission,
    PassBPayload,
    PassBSubmission,
)
from scripts.ecsm_p6_3_engine import (
    freeze_metric_definitions,
    generate_annotator_assignments,
    generate_opaque_clip_manifest,
)


class TestEcsmP63(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_annotation.sqlite"
        self.db = AnnotationDatabase(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_pass_a_firewall_validation(self):
        """Proves Pass-A firewall blocks canonical and model leakage in payloads."""
        # 1. Clean payload -> PASS
        clean_payload = {
            "presentation_id": "PRES_001",
            "clip_id": "clip_7c83a1f4",
            "audio_url_or_path": "audio_clips/clip_7c83a1f4.wav",
            "allowed_phone_tokens": ["s", "t", "th"],
        }
        is_valid, violations = PassAFirewallValidator.validate_payload(clean_payload)
        self.assertTrue(is_valid)
        self.assertEqual(len(violations), 0)

        # 2. Leaky payload with expected phone -> FAIL
        leaky_payload = {
            "presentation_id": "PRES_001",
            "expectedPhone": "s",
            "audio_url_or_path": "audio_clips/clip_7c83a1f4.wav",
        }
        is_valid, violations = PassAFirewallValidator.validate_payload(leaky_payload)
        self.assertFalse(is_valid)
        self.assertGreater(len(violations), 0)

        # 3. Leaky payload with model prediction -> FAIL
        leaky_model = {
            "presentation_id": "PRES_001",
            "modelPredictions": {"huBERT": "s"},
        }
        is_valid, violations = PassAFirewallValidator.validate_payload(leaky_model)
        self.assertFalse(is_valid)

        # 4. Leaky filename with confusion direction -> FAIL
        leaky_filename = {
            "presentation_id": "PRES_001",
            "audio_path": "audio_clips/s_to_th.wav",
        }
        is_valid, violations = PassAFirewallValidator.validate_payload(leaky_filename)
        self.assertFalse(is_valid)

    def test_pass_a_seal_and_pass_b_gating(self):
        """Proves Pass B is strictly blocked until Pass A is cryptographically sealed."""
        # Insert pilot item & assignment
        self.db.insert_pilot_item({
            "itemId": "HE-001",
            "opaqueClipId": "clip_001",
            "rowId": "row_001",
            "utteranceId": "utt_001",
            "speakerId": "spk_001",
            "expectedPhone": "s",
            "referenceWord": "sun",
            "humanLabel": "th",
            "bucket": "HARD_SUBSTITUTION",
            "sourceSplit": "CALIBRATION",
            "audioClipPath": "audio_clips/clip_001.wav",
            "audioHash": "hash001",
        })

        self.db.insert_assignment({
            "presentationId": "PRES_ANN1_0001",
            "itemId": "HE-001",
            "annotatorId": "ANN_001",
            "presentationOrder": 1,
            "createdAt": "2026-08-31T12:00:00Z",
        })

        # 1. Attempting to fetch Pass B before Pass A seal must raise PermissionError
        with self.assertRaises(PermissionError):
            self.db.get_pass_b_payload("PRES_ANN1_0001", "ANN_001")

        # 2. Attempting to submit Pass B before Pass A seal must raise ValueError
        pass_b_sub = PassBSubmission(
            presentation_id="PRES_ANN1_0001",
            annotator_id="ANN_001",
            reference_match=False,
            error_type="SUBSTITUTION",
        )
        with self.assertRaises(ValueError):
            self.db.submit_pass_b(pass_b_sub)

        # 3. Seal Pass A
        pass_a_sub = PassASubmission(
            presentation_id="PRES_ANN1_0001",
            annotator_id="ANN_001",
            primary_perceived_phone="th",
            confidence=4,
            is_ambiguous=False,
        )
        seal_hash = self.db.seal_pass_a(pass_a_sub)
        self.assertTrue(len(seal_hash) == 64)

        # 4. Now Pass B payload is accessible and reveals context
        pass_b_payload = self.db.get_pass_b_payload("PRES_ANN1_0001", "ANN_001")
        self.assertEqual(pass_b_payload.expected_canonical_phone, "s")
        self.assertEqual(pass_b_payload.reference_word, "sun")
        self.assertEqual(pass_b_payload.locked_pass_a_summary["primaryPhone"], "th")
        self.assertEqual(pass_b_payload.locked_pass_a_summary["sealHash"], seal_hash)

        # 5. Submit Pass B
        sub_b_hash = self.db.submit_pass_b(pass_b_sub)
        self.assertTrue(len(sub_b_hash) == 64)

    def test_randomization_and_hidden_repeats(self):
        """Verifies deterministic randomization per annotator and 35 hidden repeat scheduling."""
        dummy_queue = [{"itemId": f"HE-{i:04d}", "utteranceId": f"utt_{i}", "speakerId": f"spk_{i%20}"} for i in range(500)]
        assignments, rand_man, repeat_man = generate_annotator_assignments(dummy_queue, hidden_repeat_count=35)

        # Check all 3 annotators
        self.assertEqual(len(assignments["assignments"]), 3)
        for ann_id in ["ANN_001", "ANN_002", "ANN_003"]:
            pres_list = assignments["assignments"][ann_id]
            self.assertEqual(len(pres_list), 535)  # 500 core + 35 repeats
            hidden_repeats = [p for p in pres_list if p["isHiddenRepeat"]]
            self.assertEqual(len(hidden_repeats), 35)

            # Unique core items must equal 500
            core_items = set(p["itemId"] for p in pres_list if not p["isHiddenRepeat"])
            self.assertEqual(len(core_items), 500)

        # Presentations must have different order for ANN_001 and ANN_002
        order1 = [p["itemId"] for p in assignments["assignments"]["ANN_001"][:20]]
        order2 = [p["itemId"] for p in assignments["assignments"]["ANN_002"][:20]]
        self.assertNotEqual(order1, order2)

    def test_agreement_statistics_engine(self):
        """Verifies Fleiss kappa, Krippendorff alpha, and vote entropy on test fixtures."""
        # 1. Unanimous matrix (10 items x 3 categories, 3 raters all agreeing)
        # Ratings matrix shape (N, categories): 10 items, 3 categories (e.g. s, th, t)
        unanimous_matrix = np.array([
            [3, 0, 0],
            [3, 0, 0],
            [0, 3, 0],
            [0, 3, 0],
            [0, 0, 3],
        ])
        kappa = AgreementStatisticsEngine.compute_fleiss_kappa(unanimous_matrix)
        self.assertAlmostEqual(kappa, 1.0, places=2)

        # 2. Complete disagreement matrix
        disagree_matrix = np.array([
            [1, 1, 1],
            [1, 1, 1],
            [1, 1, 1],
        ])
        kappa_dis = AgreementStatisticsEngine.compute_fleiss_kappa(disagree_matrix)
        self.assertLess(kappa_dis, 0.1)

        # 3. Krippendorff alpha with missing ratings
        units = [
            ["s", "s", "s"],
            ["th", "th", None],
            ["t", "t", "t"],
            ["s", "th", "s"],
        ]
        alpha = AgreementStatisticsEngine.compute_krippendorff_alpha_nominal(units)
        self.assertGreater(alpha, 0.5)

        # 4. Vote distribution & entropy
        dist = AgreementStatisticsEngine.compute_vote_distribution(["s", "s", "th"])
        self.assertAlmostEqual(dist["s"], 0.6667, places=3)
        self.assertAlmostEqual(dist["th"], 0.3333, places=3)
        ent = AgreementStatisticsEngine.compute_entropy(dist)
        self.assertGreater(ent, 0.8)

    def test_metric_definition_freeze(self):
        """Verifies metric definitions freeze hash and interpretive bands."""
        freeze = freeze_metric_definitions()
        self.assertIn("definitionFreezeHash", freeze)
        self.assertEqual(len(freeze["definitionFreezeHash"]), 64)
        self.assertIn("unanimousAgreement", freeze["interpretiveBands"])


if __name__ == "__main__":
    unittest.main()
