import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from app.services.pronunciation.calibration_models import (
    build_phone_stats, calculate_calibrated_score, empirical_cdf,
    robust_scale, robust_z, standard_z,
)
from app.services.pronunciation.calibration_research import (
    assert_zero_speaker_leakage, bootstrap_stability,
    deterministic_speaker_partition, group_phone_stats,
    map_human_phone_labels, primary_binary_label,
    sensitivity_binary_label,
)


class CalibrationResearchTests(unittest.TestCase):
    def test_primary_policy_excludes_intermediate_scores(self):
        scores = [0.0, 0.49, 0.5, 1.0, 1.99, 2.0]
        self.assertEqual([primary_binary_label(s) for s in scores], [1, 1, None, None, None, 0])
        self.assertEqual(scores, [0.0, 0.49, 0.5, 1.0, 1.99, 2.0])

    def test_sensitivity_policy_is_separate(self):
        self.assertEqual([sensitivity_binary_label(s) for s in [0, .5, 1, 1.99, 2]], [1, 1, 1, 1, 0])

    def test_deterministic_split_and_leakage(self):
        speakers = [f"s{i}" for i in range(10)]
        first = deterministic_speaker_partition(speakers, "d", {"calibration": 6, "validation": 2, "test": 2})
        second = deterministic_speaker_partition(reversed(speakers), "d", {"calibration": 6, "validation": 2, "test": 2})
        self.assertEqual(first, second)
        with self.assertRaisesRegex(ValueError, "leakage"):
            assert_zero_speaker_leakage([{"dataset": "d", "speakerId": "s", "split": "calibration"},
                                         {"dataset": "d", "speakerId": "s", "split": "test"}])

    def test_group_audit_does_not_change_splits(self):
        rows = [{"dataset": "d", "speakerId": "a", "split": "calibration", "speakerGroup": "adult", "expectedPhoneme": "i", "rawGop": 1},
                {"dataset": "d", "speakerId": "c", "split": "test", "speakerGroup": "child", "expectedPhoneme": "i", "rawGop": -1}]
        before = [(r["speakerId"], r["split"]) for r in rows]
        group_phone_stats([r for r in rows if r["speakerGroup"] == "adult"], "adult")
        group_phone_stats([r for r in rows if r["speakerGroup"] == "child"], "child")
        self.assertEqual([(r["speakerId"], r["split"]) for r in rows], before)

    def test_phone_mapping(self):
        self.assertEqual(map_human_phone_labels(["IY1", "T"], [2, 0], ["iː", "t"]), [2, 0])
        self.assertEqual(map_human_phone_labels(["IY", "IY"], [2, 0], ["iː"]), [None])

    def test_word_level_mapping_is_deterministic_and_exact(self):
        from scripts.calibration_tool import map_word_indices
        human = [{"text": "Hello"}, {"text": "WORLD!"}]
        engine = [{"expectedWord": "hello"}, {"expectedWord": "world"}]
        self.assertEqual(map_word_indices(human, engine), {0: 0, 1: 1})
        self.assertEqual(map_word_indices([{"text": "a"}, {"text": "a"}], [{"expectedWord": "a"}]), {})

    def test_statistics_and_monotonicity(self):
        stats = build_phone_stats("i", [1, 1, 1, 3], 2, "fixture")
        self.assertEqual((stats.sampleCount, stats.speakerCount), (4, 2))
        self.assertAlmostEqual(robust_scale(stats), (stats.q75 - stats.q25) / 1.349)
        self.assertGreater(robust_z(3, stats), robust_z(1, stats))
        self.assertGreater(standard_z(3, stats), standard_z(1, stats))
        self.assertAlmostEqual(empirical_cdf(1, [1, 1, 3]), 1 / 3)
        self.assertGreater(empirical_cdf(3, [1, 1, 3]), empirical_cdf(1, [1, 1, 3]))

    def test_bootstrap_reproducibility(self):
        rows = [{"expectedPhoneme": "i", "speakerId": f"s{i % 3}", "rawGop": float(i)} for i in range(30)]
        self.assertEqual(bootstrap_stability(rows, 5, 7), bootstrap_stability(rows, 5, 7))

    def test_production_score_remains_null(self):
        self.assertIsNone(calculate_calibrated_score(1, build_phone_stats("i", [0, 1], 2, "fixture")))

    def test_safe_extraction(self):
        from scripts.calibration_tool import safe_extract
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bad.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                info, payload = tarfile.TarInfo("../escape"), b"bad"
                info.size = len(payload); bundle.addfile(info, io.BytesIO(payload))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                safe_extract(archive, Path(directory) / "out")

    def test_batch_comparison(self):
        from scripts.calibration_tool import comparable
        def assessment(gop=1, variant="i", span=(1, 2)):
            return {"words": [{"selectedVariant": variant, "phonemes": [{"expectedPhoneme": "i", "startFrame": span[0],
                     "endFrame": span[1], "rawGop": gop, "candidatePhonemes": [{"phoneme": "i"}, {"phoneme": "e"}]}]}]}
        self.assertTrue(comparable([assessment()], [assessment(1.00005)]))
        self.assertFalse(comparable([assessment()], [assessment(1.001)]))
        self.assertFalse(comparable([assessment()], [assessment(variant="x")]))
        self.assertFalse(comparable([assessment()], [assessment(span=(2, 3))]))
        changed_ranking = assessment(); changed_ranking["words"][0]["phonemes"][0]["candidatePhonemes"].reverse()
        self.assertFalse(comparable([assessment()], [changed_ranking]))
        for size in (1, 2, 4):
            values = [assessment() for _ in range(size)]
            self.assertTrue(comparable(values, values))

    def test_license_registry_and_resume_conflict(self):
        from scripts.calibration_tool import DATASETS, completed_utterance_keys
        for dataset in DATASETS.values():
            self.assertTrue(dataset["url"].startswith("https://www.openslr.org/"))
            self.assertEqual(dataset["license"], "CC BY 4.0")
            self.assertEqual(len(dataset["sha256"]), 64)
        rows = [{"dataset": "d", "utteranceId": "u", "modelId": "m", "manifestAudioSha256": "h"},
                {"dataset": "d", "utteranceId": "u", "modelId": "m", "manifestAudioSha256": "h"}]
        self.assertEqual(completed_utterance_keys(rows), {("d", "u")})
        rows.append({"dataset": "d", "utteranceId": "u", "modelId": "x", "manifestAudioSha256": "h"})
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            completed_utterance_keys(rows)

    def test_research_rows_keep_null_outputs(self):
        from scripts.calibration_tool import flatten
        source = {"dataset": "d", "utteranceId": "u", "speakerId": "s", "split": "calibration", "sourceSplit": "train", "speakerGroup": None, "humanWords": None, "audioSha256": "h"}
        phone = {"index": 0, "expectedPhoneme": "i", "rawGop": 1, "startFrame": 1, "endFrame": 2, "durationMs": 20,
                 "meanTargetLogProb": -1, "meanTargetPosterior": .3, "strongestCompetitor": "x",
                 "strongestCompetitorMeanLogProb": -2, "competitorFrameShare": .5, "candidatePhonemes": []}
        assessment = {"words": [{"index": 0, "expectedWord": "we", "selectedVariant": ["w", "i"], "variantSource": "g2p", "phonemes": [phone]}],
                      "alignmentQuality": {"normalizedAlignmentScore": 1, "alignmentMargin": .1}}
        row = flatten(source, assessment)[0]
        self.assertIsNone(row["observedPhoneme"]); self.assertIsNone(row["calibratedScore"])


if __name__ == "__main__":
    unittest.main()
