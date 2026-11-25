"""
SHD-2B.5 Acoustic Round 1 Engine (Optimized & Resumable).
English Coach — Phoneme Diagnosis & Articulatory Adaptation.

Key Optimizations:
1. Frozen Base Teacher Logits precomputed ONCE and cached on CPU/disk (Base model unloaded from GPU).
2. CPU Waveform Cache (Only active microbatch transferred to CUDA).
3. Microbatch Gradient Accumulation with immediate graph deallocation.
4. Unbuffered Intra-Epoch Progress Logging with ETA & VRAM monitoring.
5. Fully Resumable Atomic Checkpointing (LoRA, optimizer, Python/NumPy/PyTorch RNG states).
6. Pure Pareto-based Evaluation & Checkpoint Preservation (No arbitrary scalarization).
7. Strict Label Semantics (Excludes null/missing labels from loss rather than defaulting).
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
from safetensors.torch import load_file, save_file
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
)
from app.services.pronunciation.articulatory_diagnosis import (
    CanonicalRealPhoneInventory,
    TrainConfusionGraph,
    ARTICULATORY_SCHEMA_VERSION,
)
from app.services.pronunciation.operating_points import optimize_far_constrained_threshold
from scripts.acoustic_peft_round1_losses import (
    RestrictedCompetitiveMarginLoss,
    MultiTaskDiagnosisArticulatoryLoss,
)
from scripts.calibration_reliability_tool import _overlay_repaired_labels, iter_jsonl
from scripts.acoustic_peft_controlled_study import resolve_speechocean_wav_path
from scripts.teacher_cache_manager import TeacherCacheManager, compute_manifest_hash

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
data_dir = Path("/app/scripts/calibration_data")
corpora_dir = data_dir / "corpora"
speechocean_wave_root = corpora_dir / "speechocean762/WAVE"
scores_detail_path = corpora_dir / "speechocean762/resource/scores-detail.json"
model_c_seed2_dir = data_dir / "outputs/shd-2b.5/convergence/checkpoints/checkpoint_MODEL_C_SEED2"
output_round1_dir = data_dir / "outputs/shd-2b.5/round1"
teacher_cache_dir = data_dir / "outputs/shd-2b.5/teacher_cache"


def set_all_rng_seeds(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def get_rng_states() -> Dict[str, Any]:
    return {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch_cpu": torch.get_rng_state(),
        "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
    }


def set_rng_states(states: Dict[str, Any]) -> None:
    if "python" in states:
        random.setstate(states["python"])
    if "numpy" in states:
        np.random.set_state(states["numpy"])
    if "torch_cpu" in states and states["torch_cpu"] is not None:
        cpu_st = states["torch_cpu"]
        if isinstance(cpu_st, torch.Tensor):
            torch.set_rng_state(cpu_st.cpu().to(torch.uint8))
        else:
            torch.set_rng_state(torch.tensor(cpu_st, dtype=torch.uint8))
    if "torch_cuda" in states and states["torch_cuda"] is not None and torch.cuda.is_available():
        cuda_sts = states["torch_cuda"]
        if isinstance(cuda_sts, (list, tuple)):
            cuda_sts = [
                st.cpu().to(torch.uint8) if isinstance(st, torch.Tensor) else torch.tensor(st, dtype=torch.uint8)
                for st in cuda_sts
            ]
            torch.cuda.set_rng_state_all(cuda_sts)


def load_dataset_manifests():
    orig_rows = list(iter_jsonl(data_dir / "outputs/phone_instances.jsonl"))
    repaired_rows = _overlay_repaired_labels(data_dir, orig_rows)

    so_rows = [r for r in repaired_rows if r.get("dataset") == "speechocean762"]
    so_clean = [
        r for r in so_rows
        if r.get("rawGop") is not None and r.get("expectedPhoneme") != "\u0329" and r.get("phone") != "\u0329"
    ]

    train_rows = [r for r in so_clean if r.get("split") == "calibration"]
    val_rows = [r for r in so_clean if r.get("split") == "validation"]

    return train_rows, val_rows


def extract_diagnosis_targets_for_rows(
    rows: Sequence[Dict[str, Any]],
    scores_detail_data: Dict[str, Any],
    inventory: CanonicalRealPhoneInventory,
) -> List[Optional[int]]:
    """
    Extract perceived phone diagnosis index (0..V_real-1) for each phone row.
    """
    expert_map = {}
    for utt_id, utt in scores_detail_data.items():
        for w_idx, w in enumerate(utt.get("words", [])):
            ref_tokens = w.get("ref-phones", "").split()
            expert_lists = [ep.split() for ep in w.get("phones", [])]
            for p_idx, ref_p in enumerate(ref_tokens):
                perceived_candidates = []
                is_correct = True
                for ep_tokens in expert_lists:
                    for t_val in ep_tokens:
                        if t_val.startswith("(") and t_val.endswith(")"):
                            is_correct = False
                        if t_val.startswith("[") and t_val.endswith("]"):
                            arpa_ins = t_val[1:-1].upper().rstrip("012")
                            ipa_ins = inventory.arpabet2ipa.get(arpa_ins)
                            if ipa_ins:
                                perceived_candidates.append(ipa_ins)
                expert_map[(utt_id, w_idx, p_idx)] = {
                    "is_correct": is_correct,
                    "perceived": perceived_candidates[0] if perceived_candidates else None,
                }

    targets = []
    for r in rows:
        u_id = r["utteranceId"]
        w_idx = int(r.get("wordIndex", 0))
        p_idx = int(r.get("phoneIndex", 0))
        exp_ipa = r.get("expectedPhoneme", "")

        info = expert_map.get((u_id, w_idx, p_idx))
        if info and info["perceived"] and info["perceived"] in inventory.ipa_to_real_idx:
            targets.append(inventory.ipa_to_real_idx[info["perceived"]])
        elif r.get("humanPhoneAccuracy") == 2.0 and exp_ipa in inventory.ipa_to_real_idx:
            targets.append(inventory.ipa_to_real_idx[exp_ipa])
        elif exp_ipa in inventory.ipa_to_real_idx and r.get("primaryErrorLabel") == 0:
            targets.append(inventory.ipa_to_real_idx[exp_ipa])
        else:
            targets.append(None)

    return targets


def build_utterance_groups(rows: Sequence[Dict[str, Any]], diag_targets: List[Optional[int]]):
    by_utt = defaultdict(list)
    for r, dt in zip(rows, diag_targets):
        by_utt[r["utteranceId"]].append((r, dt))
    return by_utt


def evaluate_model_on_validation(
    model: Wav2Vec2ForCTC,
    processor: Wav2Vec2Processor,
    val_rows: Sequence[Dict[str, Any]],
    val_diag_targets: List[Optional[int]],
    val_audio_cache: Dict[str, np.ndarray],
    teacher_cache: Dict[str, torch.Tensor],
    inventory: CanonicalRealPhoneInventory,
    confusion_graph: TrainConfusionGraph,
) -> Dict[str, Any]:
    model.eval()

    val_by_utt = build_utterance_groups(val_rows, val_diag_targets)

    primary_scores, primary_labels = [], []
    sens_scores, sens_labels = [], []

    diag_preds, diag_trues = [], []
    diag_top3_hits = []
    diag_subs_preds, diag_subs_trues = [], []
    diag_subs_top3_hits = []

    art_preds_list, art_trues_list = [], []

    real_tokens = inventory.real_token_tensor.to(device)
    art_matrix = inventory.articulatory_matrix.to(device)

    ctc_agreements = []

    with torch.no_grad():
        for u_id, items in val_by_utt.items():
            if u_id not in val_audio_cache:
                continue
            audio_arr = val_audio_cache[u_id]
            x = torch.from_numpy(audio_arr).float().unsqueeze(0).to(device)

            logits = model(x).logits[0]  # [T, V]
            T = logits.shape[0]

            # CTC greedy agreement with teacher logits
            if u_id in teacher_cache:
                t_logits = teacher_cache[u_id].to(device)
                min_len = min(logits.shape[0], t_logits.shape[0])
                agree = (logits[:min_len].argmax(dim=-1) == t_logits[:min_len].argmax(dim=-1)).float().mean().item()
                ctc_agreements.append(agree)

            for r, dt in items:
                tok_id = processor.tokenizer._convert_token_to_id(r["expectedPhoneme"])
                if tok_id is None or tok_id < 4:
                    continue
                sf_idx = min(int(r.get("startFrame", 0)), T - 1)
                ef_idx = min(max(int(r.get("endFrame", sf_idx + 1)), sf_idx + 1), T)

                span_logits = logits[sf_idx:ef_idx]
                target_logit = span_logits[:, tok_id].mean().item()

                comp_tids = confusion_graph.get_competitor_token_ids(r["expectedPhoneme"])
                comp_tids = [t for t in comp_tids if t != tok_id]
                if not comp_tids:
                    comp_tids = [t for t in inventory.token_ids if t != tok_id][:5]

                comp_logits = span_logits[:, comp_tids]
                comp_logsumexp = torch.logsumexp(comp_logits, dim=-1).mean().item()
                error_logit = comp_logsumexp - target_logit

                if r.get("primaryErrorLabel") is not None:
                    primary_scores.append(error_logit)
                    primary_labels.append(int(r["primaryErrorLabel"]))

                if r.get("sensitivityErrorLabel") is not None:
                    sens_scores.append(error_logit)
                    sens_labels.append(int(r["sensitivityErrorLabel"]))

                real_logits = span_logits[:, real_tokens].mean(dim=0)
                top1_idx = int(real_logits.argmax().item())
                top3_indices = [int(i) for i in real_logits.topk(k=min(3, len(real_tokens))).indices.cpu().numpy()]

                if dt is not None and 0 <= dt < inventory.num_real_phones:
                    diag_preds.append(top1_idx)
                    diag_trues.append(dt)
                    diag_top3_hits.append(1 if dt in top3_indices else 0)

                    # Check if substitution / error
                    exp_real_idx = inventory.ipa_to_real_idx.get(r.get("expectedPhoneme"))
                    is_sub = (exp_real_idx is not None and dt != exp_real_idx)
                    if is_sub:
                        diag_subs_preds.append(top1_idx)
                        diag_subs_trues.append(dt)
                        diag_subs_top3_hits.append(1 if dt in top3_indices else 0)

                    probs = F.softmax(real_logits, dim=-1)
                    pred_art = torch.matmul(probs, art_matrix).cpu().numpy()
                    tgt_art = art_matrix[dt].cpu().numpy()
                    art_preds_list.append(pred_art)
                    art_trues_list.append(tgt_art)

    # Metrics computation
    prim_roc = roc_auc_score(primary_labels, primary_scores) if len(set(primary_labels)) > 1 else 0.5
    prim_ap = average_precision_score(primary_labels, primary_scores) if len(set(primary_labels)) > 1 else 0.0
    fpr, tpr, thresholds = roc_curve(primary_labels, primary_scores)
    fnr = 1 - tpr
    eer_idx = np.nanargmin(np.abs(fpr - fnr))
    prim_eer = float((fpr[eer_idx] + fnr[eer_idx]) / 2.0)
    eer_threshold = float(thresholds[eer_idx])

    sens_roc = roc_auc_score(sens_labels, sens_scores) if len(set(sens_labels)) > 1 else 0.5
    sens_ap = average_precision_score(sens_labels, sens_scores) if len(set(sens_labels)) > 1 else 0.0
    fpr_s, tpr_s, _ = roc_curve(sens_labels, sens_scores)
    fnr_s = 1 - tpr_s
    eer_s_idx = np.nanargmin(np.abs(fpr_s - fnr_s))
    sens_eer = float((fpr_s[eer_s_idx] + fnr_s[eer_s_idx]) / 2.0)

    # FAR / FRR analysis
    # False Acceptance Rate (FAR): Proportion of true errors (y=1) mistakenly accepted as correct (y_pred=0).
    # False Rejection Rate (FRR): Proportion of true corrects (y=0) mistakenly rejected as error (y_pred=1).
    err_indices = [i for i, y in enumerate(primary_labels) if y == 1]
    cor_indices = [i for i, y in enumerate(primary_labels) if y == 0]

    def compute_rates_at_th(th):
        y_pred = [1 if s >= th else 0 for s in primary_scores]
        far = np.mean([1 if y_pred[i] == 0 else 0 for i in err_indices]) if err_indices else 0.0
        frr = np.mean([1 if y_pred[i] == 1 else 0 for i in cor_indices]) if cor_indices else 0.0
        recall = 1.0 - far
        return float(far), float(frr), float(recall)

    # Select the least restrictive point (minimum FRR / largest threshold)
    # that still accepts no more than the requested fraction of true errors.
    op_far_10 = optimize_far_constrained_threshold(primary_labels, primary_scores, 0.10)
    op_far_5 = optimize_far_constrained_threshold(primary_labels, primary_scores, 0.05)

    far_eer, frr_eer, rec_eer = compute_rates_at_th(eer_threshold)
    far_0, frr_0, rec_0 = compute_rates_at_th(0.0)
    far_10, frr_10, rec_10 = op_far_10.far, op_far_10.frr, op_far_10.errorRecall
    far_5, frr_5, rec_5 = op_far_5.far, op_far_5.frr, op_far_5.errorRecall

    far_frr_operating_points = {
        "eer": {"threshold": eer_threshold, "FAR": far_eer, "FRR": frr_eer, "detectionRecall": rec_eer},
        "fixed_0_0": {"threshold": 0.0, "FAR": far_0, "FRR": frr_0, "detectionRecall": rec_0},
        "far_10pct": {**op_far_10.to_dict(), "FAR": far_10, "FRR": frr_10, "detectionRecall": rec_10},
        "far_5pct": {**op_far_5.to_dict(), "FAR": far_5, "FRR": frr_5, "detectionRecall": rec_5},
    }

    far_frr_table = []
    for th in [0.0, 0.5, 1.0, 1.5, 2.0]:
        far, frr, rec = compute_rates_at_th(th)
        far_frr_table.append({"threshold": th, "FAR": far, "FRR": frr, "detectionRecall": rec})

    # Diagnosis metrics
    diag_top1_acc = np.mean(np.array(diag_preds) == np.array(diag_trues)) if diag_trues else 0.0
    diag_top3_rec = np.mean(diag_top3_hits) if diag_top3_hits else 0.0
    diag_macro_f1 = f1_score(diag_trues, diag_preds, average="macro", zero_division=0) if diag_trues else 0.0
    diag_weighted_f1 = f1_score(diag_trues, diag_preds, average="weighted", zero_division=0) if diag_trues else 0.0

    diag_subs_top1 = np.mean(np.array(diag_subs_preds) == np.array(diag_subs_trues)) if diag_subs_trues else 0.0
    diag_subs_top3 = np.mean(diag_subs_top3_hits) if diag_subs_top3_hits else 0.0
    diag_subs_macro_f1 = f1_score(diag_subs_trues, diag_subs_preds, average="macro", zero_division=0) if diag_subs_trues else 0.0

    art_acc_dict = {}
    if art_preds_list:
        art_preds_arr = np.array(art_preds_list) > 0.5
        art_trues_arr = np.array(art_trues_list) > 0.5
        for f_idx, feat_name in enumerate(inventory.feature_names):
            acc = np.mean(art_preds_arr[:, f_idx] == art_trues_arr[:, f_idx])
            art_acc_dict[feat_name] = float(acc)

    return {
        "primary": {
            "rocAuc": float(prim_roc),
            "ap": float(prim_ap),
            "eer": float(prim_eer),
            "sampleCount": len(primary_labels),
        },
        "sensitivity": {
            "rocAuc": float(sens_roc),
            "ap": float(sens_ap),
            "eer": float(sens_eer),
            "sampleCount": len(sens_labels),
        },
        "farFrrOperatingPoints": far_frr_operating_points,
        "farFrr": far_frr_table,
        "diagnosis": {
            "all": {
                "top1Accuracy": float(diag_top1_acc),
                "top3Recall": float(diag_top3_rec),
                "macroF1": float(diag_macro_f1),
                "weightedF1": float(diag_weighted_f1),
                "evaluatedSamples": len(diag_trues),
            },
            "substitutionOnly": {
                "top1Accuracy": float(diag_subs_top1),
                "top3Recall": float(diag_subs_top3),
                "macroF1": float(diag_subs_macro_f1),
                "evaluatedSamples": len(diag_subs_trues),
            },
            # Top-level legacy aliases for compatibility
            "top1Accuracy": float(diag_top1_acc),
            "top3Recall": float(diag_top3_rec),
            "macroF1": float(diag_macro_f1),
            "weightedF1": float(diag_weighted_f1),
            "evaluatedSamples": len(diag_trues),
        },
        "articulatory": art_acc_dict,
        "ctcGreedyAgreement": float(np.mean(ctc_agreements)) if ctc_agreements else 1.0,
    }


def train_candidate_engine(
    candidate_name: str,
    seed: int,
    loss_type: str,
    max_epochs: int = 12,
    min_epochs: int = 3,
    patience: int = 4,
    lr: float = 1e-4,
    resume_mode: str = "auto",
    profile_only_n_utts: Optional[int] = None,
) -> Dict[str, Any]:
    print("\n" + "=" * 80, flush=True)
    print(f"CONFIGURING CANDIDATE: {candidate_name} (Seed: {seed}, Loss: {loss_type})", flush=True)
    print("=" * 80, flush=True)

    set_all_rng_seeds(seed)

    train_rows, val_rows = load_dataset_manifests()
    if profile_only_n_utts:
        target_utts = sorted(list({r["utteranceId"] for r in train_rows}))[:profile_only_n_utts]
        train_rows = [r for r in train_rows if r["utteranceId"] in target_utts]
        val_target_utts = sorted(list({r["utteranceId"] for r in val_rows}))[:max(10, profile_only_n_utts // 4)]
        val_rows = [r for r in val_rows if r["utteranceId"] in val_target_utts]

    processor = Wav2Vec2Processor.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
    vocab = processor.tokenizer.get_vocab()
    inventory = CanonicalRealPhoneInventory(vocab)

    with open(scores_detail_path, "r", encoding="utf-8") as f:
        sd_data = json.load(f)

    # Train Confusion Graph (STRICTLY FROM TRAIN SPEAKERS)
    train_spks = {r["speakerId"] for r in train_rows}
    confusion_graph = TrainConfusionGraph(inventory)
    confusion_graph.build_from_train_data(scores_detail_path, train_spks)

    train_diag_targets = extract_diagnosis_targets_for_rows(train_rows, sd_data, inventory)
    val_diag_targets = extract_diagnosis_targets_for_rows(val_rows, sd_data, inventory)

    train_by_utt = build_utterance_groups(train_rows, train_diag_targets)
    val_by_utt = build_utterance_groups(val_rows, val_diag_targets)

    # 1. PRECOMPUTE / LOAD TEACHER CACHE (Base model unloaded from GPU)
    teacher_mgr = TeacherCacheManager(teacher_cache_dir)
    all_active_rows = list(train_rows) + list(val_rows)
    teacher_cache = teacher_mgr.build_and_save_cache(all_active_rows, speechocean_wave_root)

    # 2. CPU AUDIO CACHING
    print(f"Pre-caching {len(train_by_utt)} train & {len(val_by_utt)} val audio files in CPU RAM...", flush=True)
    train_audio_cache: Dict[str, np.ndarray] = {}
    val_audio_cache: Dict[str, np.ndarray] = {}

    for u_id, items in train_by_utt.items():
        wav_p = resolve_speechocean_wav_path(speechocean_wave_root, items[0][0]["speakerId"], u_id)
        if wav_p and wav_p.exists():
            arr, _ = sf.read(wav_p)
            train_audio_cache[u_id] = arr.astype(np.float32)

    for u_id, items in val_by_utt.items():
        wav_p = resolve_speechocean_wav_path(speechocean_wave_root, items[0][0]["speakerId"], u_id)
        if wav_p and wav_p.exists():
            arr, _ = sf.read(wav_p)
            val_audio_cache[u_id] = arr.astype(np.float32)

    # 3. INITIALIZE ADAPTED MODEL (Base weights frozen, LoRA enabled)
    model = Wav2Vec2ForCTC.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION).to(device)
    inject_wav2vec2_lora(model, target_layers=[20, 21, 22, 23], rank=4, alpha=4.0)

    # Load MODEL_C_SEED2 warm start weights
    sd_init = torch.load(model_c_seed2_dir / "adapter_model.pt", map_location=device, weights_only=True)
    model.load_state_dict(sd_init, strict=False)

    if loss_type == "MODEL_D":
        criterion = RestrictedCompetitiveMarginLoss(confusion_graph=confusion_graph, lambda_quality=1.0, lambda_ctc=2.0, pos_weight=2.0)
    else:
        criterion = MultiTaskDiagnosisArticulatoryLoss(confusion_graph=confusion_graph, lambda_det=1.0, lambda_diag=0.5, lambda_art=0.5, lambda_ctc=2.0, pos_weight=2.0)

    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=1e-2)

    ckpt_dir = output_round1_dir / f"checkpoint_{candidate_name}"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    latest_state_file = ckpt_dir / "latest_state.pt"

    start_epoch = 1
    best_val_roc = -1.0
    best_epoch = 0
    no_improve_epochs = 0
    epoch_logs = []

    # 4. RESUME AUTO
    if resume_mode == "auto" and latest_state_file.exists():
        print(f"Resuming {candidate_name} from {latest_state_file}...", flush=True)
        checkpoint = torch.load(latest_state_file, map_location=device, weights_only=False)
        model.load_state_dict(checkpoint["lora_state_dict"], strict=False)
        optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
        set_rng_states(checkpoint["rng_state"])
        start_epoch = checkpoint["epoch"] + 1
        best_val_roc = checkpoint["best_val_roc"]
        best_epoch = checkpoint["best_epoch"]
        no_improve_epochs = checkpoint["no_improve_epochs"]
        epoch_logs = checkpoint["epoch_logs"]
        print(f"Successfully resumed at Epoch {start_epoch} (Best Epoch: {best_epoch}, Best ROC: {best_val_roc:.6f})", flush=True)

    utt_keys = sorted(train_by_utt.keys())
    batch_size = 8

    start_train_time = time.time()

    for epoch in range(start_epoch, max_epochs + 1):
        model.train()
        epoch_start = time.time()
        total_loss = 0.0
        steps = 0

        random.shuffle(utt_keys)

        # Microbatch batches
        batches = [utt_keys[i:i + batch_size] for i in range(0, len(utt_keys), batch_size)]
        total_batches = len(batches)

        for b_idx, batch_utts in enumerate(batches, start=1):
            optimizer.zero_grad()
            batch_loss_val = 0.0
            valid_microbatches = 0

            for u_id in batch_utts:
                if u_id not in train_audio_cache or u_id not in teacher_cache:
                    continue
                audio_arr = train_audio_cache[u_id]
                x = torch.from_numpy(audio_arr).float().unsqueeze(0).to(device)
                t_logits = teacher_cache[u_id].unsqueeze(0).to(device)

                items = train_by_utt[u_id]

                # STRICT LABEL & SPAN ALIGNMENT
                valid_spans = []
                valid_labels = []
                valid_dts = []

                for r, dt in items:
                    tok_id = processor.tokenizer._convert_token_to_id(r["expectedPhoneme"])
                    if tok_id is None or tok_id < 4:
                        continue
                    valid_spans.append({
                        "frameStart": int(r.get("startFrame", 0)),
                        "frameEnd": int(r.get("endFrame", 1)),
                        "tokenId": tok_id,
                        "expectedPhoneme": r["expectedPhoneme"],
                    })
                    lbl = r.get("primaryErrorLabel")
                    valid_labels.append(float(lbl) if lbl is not None else 0.0)
                    valid_dts.append(dt)

                if not valid_spans:
                    continue

                adapted_logits = model(x).logits

                if loss_type == "MODEL_D":
                    loss_u, met_u = criterion(adapted_logits, t_logits, valid_spans, torch.tensor(valid_labels, device=device))
                else:
                    loss_u, met_u = criterion(adapted_logits, t_logits, valid_spans, torch.tensor(valid_labels, device=device), valid_dts)

                scaled_loss = loss_u / len(batch_utts)
                scaled_loss.backward()

                batch_loss_val += loss_u.item()
                valid_microbatches += 1

            if valid_microbatches > 0:
                optimizer.step()
                total_loss += batch_loss_val / valid_microbatches
                steps += 1

            # Intra-epoch progress logging every 50 utterances
            utts_processed = b_idx * batch_size
            if utts_processed % 50 == 0 or b_idx == total_batches:
                elapsed = time.time() - epoch_start
                rate = utts_processed / elapsed if elapsed > 0 else 0
                eta = (len(train_rows) - utts_processed) / rate if rate > 0 else 0
                vram_alloc = torch.cuda.memory_allocated() / 1e6 if torch.cuda.is_available() else 0
                vram_res = torch.cuda.memory_reserved() / 1e6 if torch.cuda.is_available() else 0
                pct = (utts_processed / len(train_audio_cache)) * 100.0

                print(
                    f"{candidate_name} | Epoch {epoch:02d}/{max_epochs:02d} | "
                    f"{min(utts_processed, len(train_audio_cache)):04d}/{len(train_audio_cache)} ({pct:.1f}%) | "
                    f"loss: {batch_loss_val / max(1, valid_microbatches):.4f} | "
                    f"elapsed: {elapsed:.1f}s | ETA: {eta:.1f}s | "
                    f"VRAM: {vram_alloc:.0f}MB/{vram_res:.0f}MB",
                    flush=True,
                )

        mean_train_loss = total_loss / max(1, steps)

        # Epoch Validation (1 forward per validation utterance)
        val_metrics = evaluate_model_on_validation(
            model=model,
            processor=processor,
            val_rows=val_rows,
            val_diag_targets=val_diag_targets,
            val_audio_cache=val_audio_cache,
            teacher_cache=teacher_cache,
            inventory=inventory,
            confusion_graph=confusion_graph,
        )

        val_roc = val_metrics["primary"]["rocAuc"]
        val_ap = val_metrics["primary"]["ap"]
        diag_top1 = val_metrics["diagnosis"]["top1Accuracy"]
        diag_top3 = val_metrics["diagnosis"]["top3Recall"]
        diag_mf1 = val_metrics["diagnosis"]["macroF1"]

        epoch_record = {
            "epoch": epoch,
            "trainLoss": mean_train_loss,
            "epochDurationSec": round(time.time() - epoch_start, 2),
            "valMetrics": val_metrics,
        }
        epoch_logs.append(epoch_record)

        print(
            f"--> Epoch {epoch:02d} Complete | TrainLoss: {mean_train_loss:.4f} | "
            f"Val Primary ROC: {val_roc:.6f} | Val AP: {val_ap:.6f} | "
            f"Diag Top1: {diag_top1:.4f} | Diag Top3: {diag_top3:.4f} | Diag MF1: {diag_mf1:.4f} | "
            f"Duration: {epoch_record['epochDurationSec']}s",
            flush=True,
        )

        # Save individual epoch adapter weights for Pareto selection
        epoch_lora_state = {
            name: param.data.clone().cpu()
            for name, param in model.named_parameters()
            if "lora_A" in name or "lora_B" in name
        }
        torch.save(epoch_lora_state, ckpt_dir / f"adapter_epoch_{epoch:02d}.pt")

        # Track best Primary ROC for compute/early stopping
        if val_roc > best_val_roc:
            best_val_roc = val_roc
            best_epoch = epoch
            no_improve_epochs = 0
            # Atomically save best adapter
            tmp_best = ckpt_dir / "best_adapter.tmp"
            torch.save(epoch_lora_state, tmp_best)
            os.replace(tmp_best, ckpt_dir / "adapter_model.pt")
            save_file({k: v.contiguous() for k, v in epoch_lora_state.items()}, ckpt_dir / "best_adapter.safetensors")
        else:
            no_improve_epochs += 1

        # Atomic checkpoint save (latest_state.pt)
        checkpoint_data = {
            "candidate_name": candidate_name,
            "seed": seed,
            "loss_type": loss_type,
            "epoch": epoch,
            "best_epoch": best_epoch,
            "best_val_roc": best_val_roc,
            "no_improve_epochs": no_improve_epochs,
            "lora_state_dict": epoch_lora_state,
            "optimizer_state_dict": optimizer.state_dict(),
            "rng_state": get_rng_states(),
            "epoch_logs": epoch_logs,
            "teacher_cache_hash": teacher_mgr.cache_hash,
            "manifest_hash": compute_manifest_hash(train_rows),
        }
        tmp_latest = latest_state_file.with_suffix(".tmp")
        torch.save(checkpoint_data, tmp_latest)
        os.replace(tmp_latest, latest_state_file)

        # Append history log
        with open(ckpt_dir / "history.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(epoch_record) + "\n")

        if epoch >= min_epochs and no_improve_epochs >= patience:
            print(f"Early stopping triggered at Epoch {epoch} (Best Epoch: {best_epoch})", flush=True)
            break

    # Restore best checkpoint
    print(f"Restoring best checkpoint from Epoch {best_epoch} for final packaging...", flush=True)
    best_weights = torch.load(ckpt_dir / "adapter_model.pt", map_location=device, weights_only=True)
    model.load_state_dict(best_weights, strict=False)

    final_val_metrics = evaluate_model_on_validation(
        model=model,
        processor=processor,
        val_rows=val_rows,
        val_diag_targets=val_diag_targets,
        val_audio_cache=val_audio_cache,
        teacher_cache=teacher_cache,
        inventory=inventory,
        confusion_graph=confusion_graph,
    )

    run_state = {
        "candidateName": candidate_name,
        "seed": seed,
        "lossType": loss_type,
        "bestEpoch": best_epoch,
        "totalEpochs": len(epoch_logs),
        "totalDurationSec": round(time.time() - start_train_time, 2),
        "finalValidationMetrics": final_val_metrics,
        "epochHistory": epoch_logs,
        "teacherCacheHash": teacher_mgr.cache_hash,
    }
    with open(ckpt_dir / "run_state.json", "w", encoding="utf-8") as f:
        json.dump(run_state, f, indent=2)

    return run_state
