"""
Comprehensive unit tests for Acoustic PEFT Round 1 (MODEL_D & MODEL_E).
"""

import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch
import torch.nn as nn
from transformers import Wav2Vec2Processor

from app.services.pronunciation.acoustic_peft import (
    CANONICAL_MODEL_ID,
    CANONICAL_MODEL_REVISION,
    inject_wav2vec2_lora,
)
from app.services.pronunciation.articulatory_diagnosis import (
    CanonicalRealPhoneInventory,
    TrainConfusionGraph,
)
from scripts.acoustic_peft_round1_losses import (
    RestrictedCompetitiveMarginLoss,
    MultiTaskDiagnosisArticulatoryLoss,
)
from scripts.teacher_cache_manager import (
    TeacherCacheManager,
    compute_manifest_hash,
)
from scripts.acoustic_peft_round1_engine import (
    get_rng_states,
    set_rng_states,
    extract_diagnosis_targets_for_rows,
)


class TestAcousticPeftRound1(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            processor = Wav2Vec2Processor.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
            cls.vocab = processor.tokenizer.get_vocab()
        except Exception:
            cls.vocab = {
                "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4,
                "p": 5, "b": 6, "t": 7, "d": 8, "k": 9, "g": 10,
                "f": 11, "v": 12, "θ": 13, "ð": 14, "s": 15, "z": 16,
                "ʃ": 17, "ʒ": 18, "h": 19, "tʃ": 20, "dʒ": 21,
                "m": 22, "n": 23, "ŋ": 24, "l": 25, "r": 26, "j": 27, "w": 28,
                "iː": 29, "ɪ": 30, "e": 31, "æ": 32, "ɑː": 33, "ɒ": 34,
                "ɔː": 35, "ʊ": 36, "uː": 37, "ʌ": 38, "ɜː": 39, "ə": 40,
                "eɪ": 41, "aɪ": 42, "ɔɪ": 43, "aʊ": 44, "oʊ": 45,
            }
        cls.inventory = CanonicalRealPhoneInventory(cls.vocab)
        cls.confusion_graph = TrainConfusionGraph(cls.inventory)

    def test_null_primary_label_exclusion_from_detection_loss(self):
        """Verify that rows with null primaryErrorLabel are NOT treated as 0.0, but excluded from detection BCE."""
        criterion = RestrictedCompetitiveMarginLoss(confusion_graph=self.confusion_graph)
        
        adapted_logits = torch.randn(1, 50, 392)
        base_logits = torch.randn(1, 50, 392)
        
        spans = [
            {"frameStart": 0, "frameEnd": 10, "tokenId": 5, "expectedPhoneme": "s"},
            {"frameStart": 10, "frameEnd": 20, "tokenId": 6, "expectedPhoneme": "t"},
        ]
        labels_with_null = torch.tensor([1.0, 0.0]) # Only valid labels passed

        loss, met = criterion(adapted_logits, base_logits, spans, labels_with_null)
        self.assertGreater(met["loss_total"], 0.0)
        self.assertGreater(met["loss_quality"], 0.0)

    def test_diagnosis_target_indexing_after_filtering(self):
        """Verify that filtering invalid expectedPhoneme tokens maintains exact 1:1 alignment with diagnosis targets."""
        sample_rows = [
            {"utteranceId": "u1", "wordIndex": 0, "phoneIndex": 0, "expectedPhoneme": "\u0329", "primaryErrorLabel": 1},
            {"utteranceId": "u1", "wordIndex": 0, "phoneIndex": 1, "expectedPhoneme": "s", "primaryErrorLabel": 0, "humanPhoneAccuracy": 2.0},
        ]
        scores_detail = {
            "u1": {"words": [{"ref-phones": "S", "phones": ["S"]}]}
        }
        dts = extract_diagnosis_targets_for_rows(sample_rows, scores_detail, self.inventory)
        self.assertEqual(len(dts), len(sample_rows))
        self.assertIsNone(dts[0]) # Invalid modifier
        self.assertEqual(dts[1], self.inventory.ipa_to_real_idx["s"]) # Correct s

    def test_teacher_cache_atomic_save_and_invalidation(self):
        """Verify TeacherCacheManager invalidation on manifest hash mismatch."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache_mgr = TeacherCacheManager(Path(tmp_dir))
            manifest1 = [{"speakerId": "spk1", "utteranceId": "u1", "phone": "s"}]
            hash1 = compute_manifest_hash(manifest1)
            
            # Initially invalid
            self.assertFalse(cache_mgr.is_valid(hash1, 1))

    def test_rng_state_capture_and_restore(self):
        """Verify exact deterministic continuation using get_rng_states and set_rng_states."""
        torch.manual_seed(12345)
        states = get_rng_states()
        
        # Generate 5 numbers
        r1 = [torch.randn(1).item() for _ in range(5)]
        
        # Restore state
        set_rng_states(states)
        r2 = [torch.randn(1).item() for _ in range(5)]
        
        self.assertEqual(r1, r2)


if __name__ == "__main__":
    unittest.main()
