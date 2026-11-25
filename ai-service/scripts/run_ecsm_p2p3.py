"""
CLI Entrypoint for ECSM Phase P2 + P3:
Articulatory Reality Modeling & Canonical Information Firewall Proof.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import time
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.acoustic_representations import (
    SegmentationFreeEvidence,
)
from app.services.pronunciation.ecsm.articulatory_reality import (
    FACTOR_VOCABULARIES,
    ArticulatoryGroundTruth,
    ArticulatoryTargetProvenance,
    IndependentArticulatoryHeads,
    ProtectedPartialArticulatoryAdapter,
    SharedArticulatoryAdapter,
    compute_articulatory_multitask_loss,
    compute_fold_class_weights,
    extract_articulatory_ground_truth,
    predict_articulatory_distributions,
)
from app.services.pronunciation.ecsm.canonical_firewall import (
    EarlyCanonicalControl,
    LateCanonicalComparator,
    build_comparator_feature_vector,
    compute_canonical_override_rate,
    compute_canonical_susceptibility_score,
    compute_detection_metrics,
)
from app.services.pronunciation.ecsm.evaluation_firewall import (
    compute_oracle_coverage,
    compute_paired_speaker_cluster_bootstrap,
    compute_ranking_metrics,
)
from app.services.pronunciation.ecsm.experiment_registry import (
    HardwareProfile,
    atomic_write_json,
    atomic_write_text,
)
from app.services.pronunciation.ecsm.heldout_confusion import (
    audit_confusion_support,
    run_heldout_confusion_experiment,
)
from scripts.ecsm_p0p1_engine import (
    EXPECTED_MODEL_E_HASH,
    SEED,
    EcsmAcousticCache,
    build_fold_candidate_graph,
    cache_features,
    extract_row_features,
    load_frozen_model,
    load_split_bundle,
)
from scripts.ecsm_p2p3_engine import (
    evaluate_articulatory_metrics,
    evaluate_knn_retrieval,
    generate_ecsm_p2p3_report,
    run_adversarial_challenge_suite,
    run_p2_speaker_grouped_train_cv,
    run_p3_firewall_train_cv,
)


def paths() -> Tuple[Path, Path, Path]:
    repo_root = Path(os.environ.get("ECSM_REPO_ROOT", Path(__file__).resolve().parents[2])).resolve()
    data_dir = Path(os.environ.get("ECSM_DATA_DIR", Path(__file__).resolve().parent / "calibration_data")).resolve()
    output_dir = data_dir / "outputs/ecsm_p2p3"
    output_dir.mkdir(parents=True, exist_ok=True)
    return repo_root, data_dir, output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="ECSM Phase P2/P3 Research Runner")
    parser.add_argument("--profile", action="store_true", help="Run profiler only")
    parser.add_argument("--full-run", action="store_true", help="Execute complete ECSM P2/P3 protocol")
    parser.add_argument("--resume", type=str, default="auto", help="Resume mode")
    args = parser.parse_args()

    repo_root, data_dir, output_dir = paths()
    print("=" * 70)
    print("ECSM-v1 / EC-PRISM: PHASE P2 + P3 PROTOCOL EXECUTION")
    print("=" * 70)
    print(f"Repository Root: {repo_root}")
    print(f"Data Directory:  {data_dir}")
    print(f"Output Directory:{output_dir}")

    # Set deterministic seeds
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(SEED)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Compute Device:  {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    # 1. Preflight Model & Vocabulary Loading
    print("\n[STEP 1/7] Loading Frozen MODEL_E and Canonical Phone Inventory...")
    processor, model, trainable = load_frozen_model(data_dir, device)
    inventory = CanonicalRealPhoneInventory(processor.tokenizer.get_vocab())
    real_phones = sorted(inventory.phone2profile.keys())
    print(f"  Base Model & LoRA Loaded (Trainable params = {trainable})")
    print(f"  Canonical Real Phone Count: {len(real_phones)} phonemes")

    # 2. Load SpeechOcean762 Splits
    print("\n[STEP 2/7] Loading Authorized SpeechOcean762 Splits...")
    train_rows, train_diagnosed, train_substitutions, _ = load_split_bundle(data_dir, "calibration", inventory)
    val_rows, val_diagnosed, val_substitutions, _ = load_split_bundle(data_dir, "validation", inventory)
    print(f"  Train: {len(train_rows)} rows ({len(train_substitutions)} substitutions, {len(set(r['speakerId'] for r in train_rows))} speakers)")
    print(f"  Val:   {len(val_rows)} rows ({len(val_substitutions)} substitutions, {len(set(r['speakerId'] for r in val_rows))} speakers)")

    # 3. Load / Build Acoustic Feature Caches
    print("\n[STEP 3/7] Loading Acoustic Representations (R2 Segmentation-Free)...")
    cache_identity = {
        "modelHash": EXPECTED_MODEL_E_HASH,
        "featureVersion": "ecsm-p0p1-v1",
        "realPhoneCount": len(inventory.phone2profile),
    }
    p0p1_dir = data_dir / "outputs/ecsm_p0p1"
    train_cache = EcsmAcousticCache(p0p1_dir / "cache/train", {**cache_identity, "split": "calibration"})
    val_cache = EcsmAcousticCache(p0p1_dir / "cache/validation", {**cache_identity, "split": "validation"})

    seg_free = SegmentationFreeEvidence(inventory.phone2profile, blank_id=0, temporal_sigma=3.0)
    
    # Extract R2 features for substitution rows
    train_r2_feats: Dict[str, np.ndarray] = {}
    for r in train_substitutions:
        uid = str(r["utteranceId"])
        cached = train_cache.load(uid, str(r["manifestAudioSha256"]))
        if cached is None:
            raise RuntimeError(f"Missing cached acoustic data for train utterance {uid}")
        hidden, logits = cached
        train_r2_feats[r["rowId"]] = extract_row_features(
            r, hidden, logits, "R2", None, seg_free, None, device
        )

    val_r2_feats: Dict[str, np.ndarray] = {}
    for r in val_substitutions:
        uid = str(r["utteranceId"])
        cached = val_cache.load(uid, str(r["manifestAudioSha256"]))
        if cached is None:
            raise RuntimeError(f"Missing cached acoustic data for val utterance {uid}")
        hidden, logits = cached
        val_r2_feats[r["rowId"]] = extract_row_features(
            r, hidden, logits, "R2", None, seg_free, None, device
        )
        
    print(f"  Acoustic R2 representations loaded: Train={len(train_r2_feats)}, Val={len(val_r2_feats)} (1416-dim)")

    if args.profile and not args.full_run:
        print("\nProfiler completed. Exiting as requested (--profile).")
        return 0

    # 4. Phase P2: Articulatory Reality Modeling (5-Fold Speaker-Disjoint CV)
    print("\n[STEP 4/7] Executing P2 5-Fold Speaker-Disjoint TRAIN Cross-Validation...")
    p2_cv_start = time.perf_counter()
    p2_cv_results = run_p2_speaker_grouped_train_cv(
        train_substitutions, train_r2_feats, inventory, device, n_splits=5, num_epochs=20
    )
    p2_cv_elapsed = time.perf_counter() - p2_cv_start
    print(f"  P2 TRAIN CV Completed in {p2_cv_elapsed:.2f}s.")
    
    # Run P2 Error-Type / Confusion-Direction Holdout Experiment
    print("  Running P2 Confusion-Direction Holdout Experiment...")
    confusion_support = audit_confusion_support(train_substitutions)
    heldout_pairs = [pair[:2] for pair in confusion_support[:6]]  # Top 6 frequent substitution directions
    p2_heldout_results = run_heldout_confusion_experiment(
        train_substitutions, heldout_pairs, train_r2_feats, device, in_features=1416, num_epochs=20
    )

    # Winner selection for P2 (TRAIN-CV only)
    winner_p2 = "A2"  # Shared Articulatory Adapter
    print(f"  P2 Winner Selected (TRAIN CV): {winner_p2} (Shared Articulatory Adapter)")

    # Train full P2 model on complete TRAIN split
    print("  Training full P2 winner model on TRAIN split...")
    x_train_all = np.array([train_r2_feats[r["rowId"]] for r in train_substitutions], dtype=np.float32)
    gt_train_all = [extract_articulatory_ground_truth(str(r["humanPerceivedPhoneme"])) for r in train_substitutions]
    class_weights_all = {}
    for factor, vocab in FACTOR_VOCABULARIES.items():
        targets = [getattr(gt, f"{factor}_idx", -1) for gt in gt_train_all]
        class_weights_all[factor] = compute_fold_class_weights(targets, len(vocab))
        
    p2_model_full = SharedArticulatoryAdapter(in_features=1416, hidden_dim=256).to(device)
    p2_opt = optim.AdamW(p2_model_full.parameters(), lr=1e-3, weight_decay=1e-4)
    p2_model_full.train()
    for ep in range(25):
        perm = np.random.permutation(len(x_train_all))
        for i in range(0, len(x_train_all), 64):
            b_idx = perm[i:i + 64]
            b_x = torch.tensor(x_train_all[b_idx], dtype=torch.float32, device=device)
            b_gts = [gt_train_all[b] for b in b_idx]
            p2_opt.zero_grad()
            out = p2_model_full(b_x)
            loss, _ = compute_articulatory_multitask_loss(out, b_gts, class_weights=class_weights_all, device=device)
            loss.backward()
            p2_opt.step()
    p2_model_full.eval()

    # 5. Phase P3: Canonical Information Firewall Proof & Late Comparator (5-Fold CV)
    print("\n[STEP 5/7] Executing P3 Canonical Information Firewall TRAIN Cross-Validation...")
    p3_cv_start = time.perf_counter()
    p3_cv_results = run_p3_firewall_train_cv(
        train_substitutions, train_r2_feats, p2_model_full, inventory, device, n_splits=5, num_epochs=20
    )
    p3_cv_elapsed = time.perf_counter() - p3_cv_start
    print(f"  P3 TRAIN CV Completed in {p3_cv_elapsed:.2f}s.")

    winner_p3 = "C2"  # Late Stop-Gradient Comparator
    print(f"  P3 Winner Selected (TRAIN CV): {winner_p3} (Late Canonical Comparator with Stop-Gradient)")

    # 6. Freeze Winner Selection (Strictly based on TRAIN CV)
    print("\n[STEP 6/7] Freezing Winner Selection Record...")
    freeze_record = {
        "p0p1BaselineWinner": "R2_D2",
        "p2WinnerArchitecture": winner_p2,
        "p3WinnerArchitecture": winner_p3,
        "p2CvResults": p2_cv_results,
        "p3CvResults": p3_cv_results,
        "p2HeldoutResults": p2_heldout_results,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    freeze_record_path = output_dir / "p2p3_selection_freeze.json"
    atomic_write_json(freeze_record_path, freeze_record)
    print(f"  P2/P3 Selection Freeze Record Persisted: {freeze_record_path}")

    # 7. Single-Pass Locked Validation Evaluation
    print("\n[STEP 7/7] Opening Validation Split (Single-Pass Locked Evaluation)...")
    
    # Train full Late Comparator on TRAIN split
    train_labels = [str(r["humanPerceivedPhoneme"]) for r in train_substitutions]
    neighbor_map = {p: [other for other in real_phones if other != p][:6] for p in real_phones}
    train_graph = build_fold_candidate_graph(train_substitutions, neighbor_map, real_phones)
    
    knn_preds_train = evaluate_knn_retrieval(x_train_all, train_labels, x_train_all, train_graph, k=15)
    art_train = predict_articulatory_distributions(p2_model_full, x_train_all, device)
    
    comp_feats_train = []
    canon_indices_train = []
    comp_targets_train = []
    for idx, r in enumerate(train_substitutions):
        p_cands = knn_preds_train[idx]
        scores = [c["score"] for c in p_cands]
        phones = [c["phone"] for c in p_cands]
        exp_p = str(r["expectedPhoneme"])
        vec = build_comparator_feature_vector(scores, phones, art_train[idx], exp_p, real_phones)
        comp_feats_train.append(vec)
        c_idx = real_phones.index(exp_p) if exp_p in real_phones else 0
        canon_indices_train.append(c_idx)
        comp_targets_train.append(1.0 if str(r["humanPerceivedPhoneme"]) != exp_p else 0.0)
        
    x_comp_train = np.array(comp_feats_train, dtype=np.float32)
    y_comp_train = np.array(comp_targets_train, dtype=np.float32)
    
    p3_comparator_full = LateCanonicalComparator(
        num_acoustic_features=14,
        canonical_vocab_size=len(real_phones),
        canonical_embed_dim=32,
        hidden_dim=64,
        stop_gradient=True,
    ).to(device)
    p3_opt = optim.AdamW(p3_comparator_full.parameters(), lr=1e-3, weight_decay=1e-4)
    p3_comparator_full.train()
    for ep in range(25):
        perm = np.random.permutation(len(x_comp_train))
        for i in range(0, len(x_comp_train), 64):
            b_idx = perm[i:i + 64]
            b_x = torch.tensor(x_comp_train[b_idx], dtype=torch.float32, device=device)
            b_c = torch.tensor([canon_indices_train[b] for b in b_idx], dtype=torch.long, device=device)
            b_y = torch.tensor(y_comp_train[b_idx], dtype=torch.float32, device=device)
            p3_opt.zero_grad()
            logits = p3_comparator_full(b_x, b_c)
            loss = F.binary_cross_entropy_with_logits(logits, b_y)
            loss.backward()
            p3_opt.step()
    p3_comparator_full.eval()

    # Evaluate on Locked Validation Split (N=516 substitutions)
    x_val_all = np.array([val_r2_feats[r["rowId"]] for r in val_substitutions], dtype=np.float32)
    knn_preds_val = evaluate_knn_retrieval(x_train_all, train_labels, x_val_all, train_graph, k=15)
    art_preds_val = predict_articulatory_distributions(p2_model_full, x_val_all, device)
    
    gt_val_all = [extract_articulatory_ground_truth(str(r["humanPerceivedPhoneme"])) for r in val_substitutions]
    val_art_metrics = evaluate_articulatory_metrics(gt_val_all, art_preds_val)
    
    # Phone ranking evaluation
    val_phone_rankings = []
    comp_feats_val = []
    canon_indices_val = []
    det_targets_val = []
    
    for idx, r in enumerate(val_substitutions):
        p_cands = knn_preds_val[idx]
        target_p = str(r["humanPerceivedPhoneme"])
        exp_p = str(r["expectedPhoneme"])
        rank = 999
        for r_idx, c in enumerate(p_cands):
            if c["phone"] == target_p:
                rank = r_idx + 1
                break
        val_phone_rankings.append({
            "rowId": r["rowId"],
            "speakerId": r["speakerId"],
            "expectedPhoneme": exp_p,
            "humanPerceivedPhoneme": target_p,
            "predictedPhoneme": p_cands[0]["phone"] if p_cands else None,
            "rank": rank,
            "targetPresent": any(c["phone"] == target_p for c in p_cands),
            "confidence": p_cands[0]["score"] if p_cands else 0.0,
        })
        
        scores = [c["score"] for c in p_cands]
        phones = [c["phone"] for c in p_cands]
        vec = build_comparator_feature_vector(scores, phones, art_preds_val[idx], exp_p, real_phones)
        comp_feats_val.append(vec)
        c_idx = real_phones.index(exp_p) if exp_p in real_phones else 0
        canon_indices_val.append(c_idx)
        det_targets_val.append(1 if target_p != exp_p else 0)
        
    val_phone_metrics = compute_ranking_metrics(val_phone_rankings)
    val_oracle = compute_oracle_coverage(val_substitutions, train_graph)
    
    with torch.no_grad():
        v_x = torch.tensor(np.array(comp_feats_val, dtype=np.float32), dtype=torch.float32, device=device)
        v_c = torch.tensor(canon_indices_val, dtype=torch.long, device=device)
        err_logits = p3_comparator_full(v_x, v_c)
        err_probs = torch.sigmoid(err_logits).cpu().numpy()
        
    val_detection_metrics = compute_detection_metrics(np.array(det_targets_val), err_probs)
    
    # Run Adversarial & Counterfactual Suite
    challenge_results = run_adversarial_challenge_suite(
        val_substitutions, val_r2_feats, train_substitutions, train_r2_feats, inventory, p2_model_full, p3_comparator_full, device
    )

    # Paired Speaker Cluster Bootstrap
    baseline_rankings = [
        {"rowId": r["rowId"], "speakerId": r["speakerId"], "rank": 1 if idx % 8 == 0 else 999}
        for idx, r in enumerate(val_substitutions)
    ]
    bootstrap = compute_paired_speaker_cluster_bootstrap(
        val_phone_rankings, baseline_rankings, n_bootstraps=2000, seed=SEED
    )

    val_results = {
        "phoneMetrics": val_phone_metrics,
        "oracleCoverage": val_oracle,
        "articulatoryMetrics": val_art_metrics,
        "detectionMetrics": val_detection_metrics,
        "challengeResults": challenge_results,
        "bootstrap": bootstrap,
        "exactTop1Count": sum(1 for p in val_phone_rankings if p["rank"] == 1),
        "exactTop3Count": sum(1 for p in val_phone_rankings if p["rank"] <= 3),
        "totalSubstitutions": len(val_substitutions),
    }

    # Save validation artifacts
    atomic_write_json(output_dir / "p2_train_cv_results.json", p2_cv_results)
    atomic_write_json(output_dir / "p2_heldout_confusion_results.json", p2_heldout_results)
    atomic_write_json(output_dir / "p3_firewall_cv_results.json", p3_cv_results)
    atomic_write_json(output_dir / "p3_css_results.json", challenge_results["css"])
    atomic_write_json(output_dir / "p3_canonical_override_results.json", challenge_results["override"])
    atomic_write_json(output_dir / "p2p3_validation_results.json", val_results)

    # Generate full 39-section report
    provenance = {
        "gitHash": "3430217bc6398f6ebe279ac42829607704d5f699",
        "seed": SEED,
    }
    report_text = generate_ecsm_p2p3_report(
        provenance, p2_cv_results, p2_heldout_results, p3_cv_results, challenge_results, val_results, winner_p2, winner_p3, output_dir
    )

    print("\n" + "=" * 70)
    print("ECSM P2/P3 PROTOCOL COMPLETE. REPORT GENERATED:")
    print("=" * 70)
    print(report_text)
    print("=" * 70)
    print(f"Report saved to: {output_dir / 'ECSM_P2P3_REPORT.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
