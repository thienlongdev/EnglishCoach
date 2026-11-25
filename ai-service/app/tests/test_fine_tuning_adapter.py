import json
import tempfile
import unittest
from pathlib import Path

import torch
import torch.nn as nn

from app.services.pronunciation.fine_tuning_adapter import (
    CANONICAL_BASELINE,
    CANONICAL_MODEL_ID,
    CANONICAL_MODEL_REVISION,
    AnnotationQueueManager,
    ClassWeightedBCELoss,
    FocalPronunciationLoss,
    L2CollectionManifestRecord,
    LinearProbeHead,
    LoRAAdapterLinear,
    MultiTaskPronunciationAdapter,
    PairwiseRankingLoss,
    export_experimental_checkpoint,
    map_supervision_targets,
    verify_speaker_partition_integrity,
)


class TestCanonicalBaselineAndSplits(unittest.TestCase):

    def test_canonical_baseline_snapshot(self):
        b = CANONICAL_BASELINE
        self.assertEqual(b.modelId, CANONICAL_MODEL_ID)
        self.assertEqual(b.modelRevision, CANONICAL_MODEL_REVISION)
        self.assertAlmostEqual(b.primaryRocAuc, 0.885882, places=5)
        self.assertAlmostEqual(b.primaryPrAuc, 0.264768, places=5)
        self.assertAlmostEqual(b.primaryEer, 0.193256, places=5)
        self.assertAlmostEqual(b.studioVsSpeechOceanGap, 2.9870, places=4)
        self.assertAlmostEqual(b.speechOceanVsBrowserGap, 3.5262, places=4)
        self.assertAlmostEqual(b.studioVsBrowserGap, 6.5132, places=4)

    def test_speaker_partition_leakage_assertion(self):
        train = [f"spk_{i:03d}" for i in range(100)]
        val = [f"spk_{i:03d}" for i in range(100, 125)]
        test = [f"spk_{i:03d}" for i in range(125, 250)]

        # Valid disjoint sets
        res = verify_speaker_partition_integrity(train, val, test)
        self.assertTrue(res["zeroLeakageVerified"])
        self.assertEqual(res["trainSpeakerCount"], 100)
        self.assertEqual(res["valSpeakerCount"], 25)
        self.assertEqual(res["testSpeakerCount"], 125)

        # Contaminated sets with leakage
        leaky_test = [f"spk_{i:03d}" for i in range(120, 245)]  # overlaps with val (120-124)
        with self.assertRaises(ValueError):
            verify_speaker_partition_integrity(train, val, leaky_test)


class TestSupervisionAndLosses(unittest.TestCase):

    def test_supervision_target_mapping_0_to_2_scale(self):
        # Severe error (< 0.5)
        err = map_supervision_targets(0.2, score_scale="0_TO_2")
        self.assertEqual(err.primaryBinaryLabel, 1)
        self.assertEqual(err.sensitivityBinaryLabel, 1)
        self.assertFalse(err.isIntermediateExcluded)
        self.assertAlmostEqual(err.normalizedContinuousScore, 0.1)

        # Intermediate ([0.5, 2.0))
        inter = map_supervision_targets(1.0, score_scale="0_TO_2")
        self.assertIsNone(inter.primaryBinaryLabel)
        self.assertEqual(inter.sensitivityBinaryLabel, 1)
        self.assertTrue(inter.isIntermediateExcluded)
        self.assertAlmostEqual(inter.normalizedContinuousScore, 0.5)

        # Perfect native (== 2.0)
        perf = map_supervision_targets(2.0, score_scale="0_TO_2")
        self.assertEqual(perf.primaryBinaryLabel, 0)
        self.assertEqual(perf.sensitivityBinaryLabel, 0)
        self.assertFalse(perf.isIntermediateExcluded)
        self.assertAlmostEqual(perf.normalizedContinuousScore, 1.0)

    def test_supervision_target_mapping_0_to_10_scale(self):
        # 0-10 scale severe error (< 2.5 on 0-10 -> < 0.5 on 0-2)
        err = map_supervision_targets(1.5, score_scale="0_TO_10")
        self.assertEqual(err.primaryBinaryLabel, 1)
        self.assertEqual(err.sensitivityBinaryLabel, 1)

        # 0-10 scale perfect (10.0 -> 2.0 on 0-2)
        perf = map_supervision_targets(10.0, score_scale="0_TO_10")
        self.assertEqual(perf.primaryBinaryLabel, 0)
        self.assertEqual(perf.sensitivityBinaryLabel, 0)
        self.assertAlmostEqual(perf.normalizedContinuousScore, 1.0)

    def test_loss_formulations(self):
        logits = torch.tensor([2.0, -1.0, 0.5, -2.5], dtype=torch.float32)
        targets = torch.tensor([0.0, 1.0, 0.0, 1.0], dtype=torch.float32)

        # Class weighted BCE
        bce = ClassWeightedBCELoss(pos_weight=5.0)
        loss_bce = bce(logits, targets)
        self.assertTrue(torch.isfinite(loss_bce))
        self.assertGreater(loss_bce.item(), 0.0)

        # Focal loss
        focal = FocalPronunciationLoss(alpha=0.25, gamma=2.0)
        loss_focal = focal(logits, targets)
        self.assertTrue(torch.isfinite(loss_focal))
        self.assertGreater(loss_focal.item(), 0.0)

        # Ranking loss
        ranking = PairwiseRankingLoss(margin=0.5)
        pred_correct = torch.tensor([0.9, 0.8])
        pred_error = torch.tensor([0.2, 0.3])
        loss_rank = ranking(pred_correct, pred_error)
        self.assertTrue(torch.isfinite(loss_rank))
        self.assertEqual(loss_rank.item(), 0.0)  # Correct > error + margin


class TestModelArchitectures(unittest.TestCase):

    def test_linear_probe_head(self):
        head = LinearProbeHead(input_dim=128, hidden_dim=64)
        x = torch.randn(8, 128)
        out = head(x)
        self.assertEqual(out.shape, (8,))

    def test_lora_adapter_linear(self):
        base_lin = nn.Linear(128, 64)
        lora = LoRAAdapterLinear(base_lin, rank=4, alpha=8.0)
        self.assertFalse(base_lin.weight.requires_grad)
        self.assertTrue(lora.lora_A.requires_grad)
        self.assertTrue(lora.lora_B.requires_grad)

        x = torch.randn(4, 128)
        out = lora(x)
        self.assertEqual(out.shape, (4, 64))

    def test_multi_task_pronunciation_adapter(self):
        model = MultiTaskPronunciationAdapter(input_dim=128, vocab_size=50, adapter_rank=4)
        counts = model.count_trainable_parameters()
        self.assertGreater(counts["trainableParameters"], 0)
        self.assertGreater(counts["totalParameters"], counts["trainableParameters"])

        frame_feats = torch.randn(2, 50, 128)
        phone_feats = torch.randn(2, 10, 128)
        ctc_out, score_out = model(frame_feats, phone_feats)
        self.assertEqual(ctc_out.shape, (2, 50, 50))
        self.assertEqual(score_out.shape, (2, 10))


class TestL2CollectionAndQueueBlinding(unittest.TestCase):

    def test_annotation_queue_manager_blinding(self):
        records = [
            L2CollectionManifestRecord(
                recordId=f"rec_{i}",
                speakerId=f"spk_{i}",
                promptId=f"prompt_{i}",
                targetPhone="θ",
                targetWord="think",
                phonePosition="INITIAL",
                audioPath=f"audio/{i}.wav",
                audioSha256=f"hash_{i}",
                recordingEnvironment={"mic": "USB", "sampleRate": 16000},
                annotatorA_correct=(i % 2 == 0),
                annotatorB_correct=(i % 3 == 0),
            )
            for i in range(12)
        ]
        mgr = AnnotationQueueManager(records)

        # Test Annotator A blinded queue
        queue_a = mgr.generate_blinded_queue("annotator_1")
        self.assertEqual(len(queue_a), 12)
        for item in queue_a:
            self.assertNotIn("modelPrediction", item)
            self.assertNotIn("rawGop", item)
            self.assertNotIn("otherAnnotator", item)
            self.assertIn("targetPhone", item)
            self.assertIn("targetWord", item)

        # Test adjudication queue for disagreements
        adj_queue = mgr.generate_adjudication_queue()
        self.assertGreater(len(adj_queue), 0)
        for adj in adj_queue:
            self.assertNotEqual(adj["annotatorA_verdict"], adj["annotatorB_verdict"])


class TestCheckpointSerialization(unittest.TestCase):

    def test_checkpoint_exporter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            model = LinearProbeHead(input_dim=32, hidden_dim=16)
            ckpt_dir = Path(tmpdir)
            target = export_experimental_checkpoint(
                checkpoint_dir=ckpt_dir,
                experiment_id="exp_test_01",
                model=model,
                model_family="LINEAR_PROBE_SCORING_HEAD",
                hyperparameters={"lr": 0.001, "batch_size": 32},
                metrics={"rocAuc": 0.886},
                train_manifest_hash="hash_train",
                val_manifest_hash="hash_val",
                seed=20260830,
            )

            self.assertTrue((target / "model_weights.pt").exists())
            self.assertTrue((target / "checkpoint_metadata.json").exists())

            meta = json.loads((target / "checkpoint_metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["experimentId"], "exp_test_01")
            self.assertEqual(meta["modelFamily"], "LINEAR_PROBE_SCORING_HEAD")
            self.assertEqual(meta["checkpointClassification"], "SCORING_HEAD_CHECKPOINT")
            self.assertFalse(meta["productionDeployable"])

    def test_trainable_parameter_count_exact_match(self):
        # Linear probe on 1D feature
        probe = LinearProbeHead(input_dim=1, hidden_dim=32)
        actual_numel = sum(p.numel() for p in probe.parameters() if p.requires_grad)
        # fc1: 32*1 + 32 = 64; fc2: 1*32 + 1 = 33 -> Total: 97
        self.assertEqual(actual_numel, 97)

        # LoRA adapter rank 4 on 1D feature
        base_lin = nn.Linear(1, 32)
        lora = LoRAAdapterLinear(base_lin, rank=4)
        out_lin = nn.Linear(32, 1)
        head = nn.Sequential(lora, nn.GELU(), out_lin)
        lora_trainable = sum(p.numel() for p in head.parameters() if p.requires_grad)
        # lora_A: 4*1 = 4; lora_B: 32*4 = 128; out_lin: 1*32 + 1 = 33 -> Total: 165
        self.assertEqual(lora_trainable, 165)


    def test_canonical_auc_equivalence(self):
        import numpy as np
        import scipy.stats as stats
        from sklearn.metrics import roc_auc_score, roc_curve, auc, average_precision_score

        # Deterministic synthetic test vectors with ties and realistic class imbalance
        np.random.seed(20260830)
        y = np.random.choice([0, 1], size=1000, p=[0.96, 0.04])
        scores = np.random.randn(1000)
        # Introduce deliberate ties
        scores[:50] = scores[50:100]

        # 1. roc_auc_score
        auc_sklearn = roc_auc_score(y, scores)

        # 2. roc_curve + auc
        fpr, tpr, _ = roc_curve(y, scores)
        auc_curve = auc(fpr, tpr)

        # 3. Mann-Whitney U rank AUC
        pos = scores[y == 1]
        neg = scores[y == 0]
        u_stat, _ = stats.mannwhitneyu(pos, neg, alternative="greater")
        auc_mw = u_stat / (len(pos) * len(neg))

        # Assert all three agree within numerical tolerance
        self.assertAlmostEqual(auc_sklearn, auc_curve, places=7)
        self.assertAlmostEqual(auc_sklearn, auc_mw, places=7)


if __name__ == "__main__":
    unittest.main()
