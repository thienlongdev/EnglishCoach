"""
SHD-2B.5 Acoustic Round 1 Research Runner (MODEL_D & MODEL_E).
English Coach — Phoneme Diagnosis & Articulatory Adaptation.
"""

from collections import Counter, defaultdict
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.metrics import average_precision_score, f1_score, precision_recall_curve, roc_auc_score, roc_curve
try:
    import soundfile as sf
except ImportError:
    sf = None
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

sys.path.insert(0, "/app")
from app.services.pronunciation.acoustic_peft import (
    CANONICAL_MODEL_ID,
    CANONICAL_MODEL_REVISION,
    inject_wav2vec2_lora,
    remove_wav2vec2_lora,
    load_wav2vec2_lora_checkpoint,
    export_lora_adapter_checkpoint,
)
from app.services.pronunciation.articulatory_diagnosis import (
    CanonicalRealPhoneInventory,
    TrainConfusionGraph,
    ARTICULATORY_SCHEMA_VERSION,
)
from scripts.calibration_reliability_tool import _overlay_repaired_labels, iter_jsonl
from scripts.acoustic_peft_controlled_study import resolve_speechocean_wav_path

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
data_dir = Path("/app/scripts/calibration_data")
corpora_dir = data_dir / "corpora"
speechocean_wave_root = corpora_dir / "speechocean762/WAVE"
scores_detail_path = corpora_dir / "speechocean762/resource/scores-detail.json"


class RestrictedCompetitiveMarginLoss(nn.Module):
    """MODEL_D: Restricted competitive margin error detection."""
    def __init__(
        self,
        confusion_graph: TrainConfusionGraph,
        lambda_quality: float = 1.0,
        lambda_ctc: float = 2.0,
        pos_weight: float = 2.0,
    ):
        super().__init__()
        self.confusion_graph = confusion_graph
        self.lambda_quality = lambda_quality
        self.lambda_ctc = lambda_ctc
        self.pos_weight_val = pos_weight

    def forward(
        self,
        adapted_logits: torch.Tensor,
        base_logits: torch.Tensor,
        phone_spans: Sequence[Dict[str, Any]],
        phone_labels: torch.Tensor,
    ) -> Tuple[torch.Tensor, Dict[str, float]]:
        dev = adapted_logits.device
        bce_criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([self.pos_weight_val], device=dev))

        adapted_log_probs = F.log_softmax(adapted_logits, dim=-1)
        base_probs = F.softmax(base_logits, dim=-1)
        loss_ctc = F.kl_div(adapted_log_probs, base_probs, reduction="batchmean")

        phone_logits_list = []
        target_labels_list = []

        for idx, span in enumerate(phone_spans):
            t_start = span["frameStart"]
            t_end = span["frameEnd"]
            token_id = span["tokenId"]
            expected_ipa = span.get("expectedPhoneme", "")
            label = phone_labels[idx].item()

            if t_start < adapted_logits.size(1) and t_end <= adapted_logits.size(1) and t_start < t_end:
                span_logits = adapted_logits[0, t_start:t_end]
                target_logit = span_logits[:, token_id].mean()

                # Get restricted competitor token IDs
                comp_tids = self.confusion_graph.get_competitor_token_ids(expected_ipa)
                # Filter out target token if present
                comp_tids = [t for t in comp_tids if t != token_id]
                if not comp_tids:
                    comp_tids = [t for t in self.confusion_graph.inventory.token_ids if t != token_id][:5]

                comp_logits = span_logits[:, comp_tids]
                comp_logsumexp = torch.logsumexp(comp_logits, dim=-1).mean()

                error_logit = comp_logsumexp - target_logit
                phone_logits_list.append(error_logit)
                target_labels_list.append(label)

        if phone_logits_list:
            pred_tensor = torch.stack(phone_logits_list)
            target_tensor = torch.tensor(target_labels_list, dtype=torch.float32, device=dev)
            loss_quality = bce_criterion(pred_tensor, target_tensor)
        else:
            loss_quality = torch.tensor(0.0, device=dev)

        total_loss = self.lambda_quality * loss_quality + self.lambda_ctc * loss_ctc
        metrics = {
            "loss_total": float(total_loss.item()),
            "loss_quality": float(loss_quality.item()),
            "loss_ctc": float(loss_ctc.item()),
        }
        return total_loss, metrics


class MultiTaskDiagnosisArticulatoryLoss(nn.Module):
    """MODEL_E: Detection + Perceived-Phone Diagnosis + Differentiable Articulatory Projection."""
    def __init__(
        self,
        confusion_graph: TrainConfusionGraph,
        lambda_det: float = 1.0,
        lambda_diag: float = 0.5,
        lambda_art: float = 0.5,
        lambda_ctc: float = 2.0,
        pos_weight: float = 2.0,
    ):
        super().__init__()
        self.confusion_graph = confusion_graph
        self.inventory = confusion_graph.inventory
        self.lambda_det = lambda_det
        self.lambda_diag = lambda_diag
        self.lambda_art = lambda_art
        self.lambda_ctc = lambda_ctc
        self.pos_weight_val = pos_weight

        # Articulatory matrix buffer [V_real, D_art]
        self.register_buffer("art_matrix", self.inventory.articulatory_matrix)
        self.real_token_tensor = self.inventory.real_token_tensor

    def forward(
        self,
        adapted_logits: torch.Tensor,
        base_logits: torch.Tensor,
        phone_spans: Sequence[Dict[str, Any]],
        phone_labels: torch.Tensor,
        diagnosis_targets: Sequence[Optional[int]], # Real phone index (0..V_real-1)
    ) -> Tuple[torch.Tensor, Dict[str, float]]:
        dev = adapted_logits.device
        bce_criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([self.pos_weight_val], device=dev))
        ce_criterion = nn.CrossEntropyLoss()
        art_bce_criterion = nn.BCELoss()

        # 1. CTC Preservation Loss
        adapted_log_probs = F.log_softmax(adapted_logits, dim=-1)
        base_probs = F.softmax(base_logits, dim=-1)
        loss_ctc = F.kl_div(adapted_log_probs, base_probs, reduction="batchmean")

        # 2. Detection & Diagnosis across spans
        det_logits_list = []
        det_targets_list = []
        diag_logits_list = []
        diag_targets_list = []

        real_tokens = self.real_token_tensor.to(dev)

        for idx, span in enumerate(phone_spans):
            t_start = span["frameStart"]
            t_end = span["frameEnd"]
            token_id = span["tokenId"]
            expected_ipa = span.get("expectedPhoneme", "")
            label = phone_labels[idx].item()
            diag_tgt = diagnosis_targets[idx]

            if t_start < adapted_logits.size(1) and t_end <= adapted_logits.size(1) and t_start < t_end:
                span_logits = adapted_logits[0, t_start:t_end]
                target_logit = span_logits[:, token_id].mean()

                # Detection (Restricted Margin)
                comp_tids = self.confusion_graph.get_competitor_token_ids(expected_ipa)
                comp_tids = [t for t in comp_tids if t != token_id]
                if not comp_tids:
                    comp_tids = [t for t in self.inventory.token_ids if t != token_id][:5]

                comp_logits = span_logits[:, comp_tids]
                comp_logsumexp = torch.logsumexp(comp_logits, dim=-1).mean()
                error_logit = comp_logsumexp - target_logit
                det_logits_list.append(error_logit)
                det_targets_list.append(label)

                # Diagnosis (Over Real Phone Inventory)
                real_phone_logits = span_logits[:, real_tokens].mean(dim=0) # [V_real]
                if diag_tgt is not None and 0 <= diag_tgt < self.inventory.num_real_phones:
                    diag_logits_list.append(real_phone_logits)
                    diag_targets_list.append(diag_tgt)

        # Detection Loss
        if det_logits_list:
            pred_det = torch.stack(det_logits_list)
            tgt_det = torch.tensor(det_targets_list, dtype=torch.float32, device=dev)
            loss_det = bce_criterion(pred_det, tgt_det)
        else:
            loss_det = torch.tensor(0.0, device=dev)

        # Diagnosis Loss & Articulatory Loss
        if diag_logits_list:
            pred_diag = torch.stack(diag_logits_list) # [N_diag, V_real]
            tgt_diag = torch.tensor(diag_targets_list, dtype=torch.long, device=dev) # [N_diag]
            loss_diag = ce_criterion(pred_diag, tgt_diag)

            # Differentiable Articulatory Projection
            art_matrix_dev = self.art_matrix.to(dev)
            diag_probs = F.softmax(pred_diag, dim=-1) # [N_diag, V_real]
            pred_art = torch.matmul(diag_probs, art_matrix_dev) # [N_diag, D_art]
            tgt_art = art_matrix_dev[tgt_diag] # [N_diag, D_art]
            loss_art = art_bce_criterion(pred_art, tgt_art)
        else:
            loss_diag = torch.tensor(0.0, device=dev)
            loss_art = torch.tensor(0.0, device=dev)

        total_loss = (
            self.lambda_det * loss_det
            + self.lambda_diag * loss_diag
            + self.lambda_art * loss_art
            + self.lambda_ctc * loss_ctc
        )
        metrics = {
            "loss_total": float(total_loss.item()),
            "loss_det": float(loss_det.item()),
            "loss_diag": float(loss_diag.item()),
            "loss_art": float(loss_art.item()),
            "loss_ctc": float(loss_ctc.item()),
        }
        return total_loss, metrics
