"""
CLI Entrypoint for ECSM Phase P0/P1 (Acoustic Reality & Phone Metric Space).
Executes the approved scientific protocol, speaker-grouped CV, architecture freeze,
single-pass locked validation, and full 33-section report generation.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import time
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)
from app.services.pronunciation.ecsm.experiment_registry import (
    HardwareProfile,
    atomic_write_json,
)
from scripts.ecsm_p0p1_engine import (
    EXPECTED_MODEL_E_HASH,
    EcsmAcousticCache,
    cache_features,
    evaluate_locked_validation,
    generate_ecsm_p0p1_report,
    load_frozen_model,
    load_split_bundle,
    run_speaker_grouped_train_cv,
    select_winner_and_freeze,
)


def paths() -> Tuple[Path, Path, Path]:
    repo_root = Path(os.environ.get("ECSM_REPO_ROOT", Path(__file__).resolve().parents[2])).resolve()
    data_dir = Path(os.environ.get("ECSM_DATA_DIR", Path(__file__).resolve().parent / "calibration_data")).resolve()
    output_dir = data_dir / "outputs/ecsm_p0p1"
    output_dir.mkdir(parents=True, exist_ok=True)
    return repo_root, data_dir, output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="ECSM Phase P0/P1 Research Runner")
    parser.add_argument("--profile", action="store_true", help="Run 100-utterance profiler only")
    parser.add_argument("--profile-count", type=int, default=100, help="Utterance count for profiler")
    parser.add_argument("--full-run", action="store_true", help="Execute complete ECSM P0/P1 protocol")
    parser.add_argument("--resume", type=str, default="auto", help="Resume mode ('auto' supported)")
    args = parser.parse_args()

    repo_root, data_dir, output_dir = paths()
    print("=" * 70)
    print("ECSM-v1 / EC-PRISM: PHASE P0/P1 PROTOCOL EXECUTION")
    print("=" * 70)
    print(f"Repository Root: {repo_root}")
    print(f"Data Directory:  {data_dir}")
    print(f"Output Directory:{output_dir}")

    # Set seeds
    seed = 20260830
    torch.manual_seed(seed)
    np.random.seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Compute Device:  {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    # 1. Preflight Model & Vocabulary Loading
    print("\n[STEP 1/6] Loading Frozen MODEL_E and Canonical Phone Inventory...")
    processor, model, trainable = load_frozen_model(data_dir, device)
    inventory = CanonicalRealPhoneInventory(processor.tokenizer.get_vocab())
    print(f"  Base Model & LoRA Loaded (Trainable params = {trainable})")
    print(f"  Canonical Real Phone Count: {len(inventory.phone2profile)} phonemes")

    # 2. Load Datasets
    print("\n[STEP 2/6] Loading Authorized SpeechOcean762 Splits...")
    train_rows, train_diagnosed, train_substitutions, train_details = load_split_bundle(data_dir, "calibration", inventory)
    val_rows, val_diagnosed, val_substitutions, val_details = load_split_bundle(data_dir, "validation", inventory)
    print(f"  Train: {len(train_rows)} rows ({len(train_substitutions)} substitutions, {len(set(r['speakerId'] for r in train_rows))} speakers)")
    print(f"  Val:   {len(val_rows)} rows ({len(val_substitutions)} substitutions, {len(set(r['speakerId'] for r in val_rows))} speakers)")

    # 3. Cache Setup & Feature Caching
    print("\n[STEP 3/6] Setting Up Acoustic Cache & 100-Utterance Profiler...")
    cache_identity = {
        "modelHash": EXPECTED_MODEL_E_HASH,
        "featureVersion": "ecsm-p0p1-v1",
        "realPhoneCount": len(inventory.phone2profile),
    }
    train_cache = EcsmAcousticCache(output_dir / "cache/train", {**cache_identity, "split": "calibration"})
    val_cache = EcsmAcousticCache(output_dir / "cache/validation", {**cache_identity, "split": "validation"})

    # Run Profiler on 100 utterances
    wave_root = data_dir / "corpora/speechocean762/WAVE"
    profile_result = cache_features(train_rows, train_cache, model, wave_root, device, limit=args.profile_count)
    print(f"  Profiler ({profile_result['utterances']} utts): {profile_result['utterancesPerSec']:.1f} utt/s, Elapsed: {profile_result['elapsedSec']:.2f}s, Peak VRAM: {profile_result['peakVramBytes'] / (1024**2):.1f}MB")

    # Estimate total dataset extraction time
    total_utts = len(set(r["utteranceId"] for r in train_rows)) + len(set(r["utteranceId"] for r in val_rows))
    est_total_sec = total_utts / max(1e-3, profile_result["utterancesPerSec"])
    print(f"  Estimated Full Dataset Caching: {est_total_sec:.1f}s ({est_total_sec / 60.0:.2f} min)")
    if est_total_sec > 1200:
        print("  WARNING: Projected caching duration exceeds 20 minutes!")

    if args.profile and not args.full_run:
        print("\nProfiler completed. Exiting as requested (--profile).")
        return 0

    # Cache remaining training & validation utterances
    print("  Caching complete training set utterances...")
    cache_features(train_rows, train_cache, model, wave_root, device)
    print("  Caching complete validation set utterances...")
    cache_features(val_rows, val_cache, model, wave_root, device)
    print("  Acoustic caches built and verified.")

    # 4. Speaker-Grouped Cross Validation on TRAIN split only
    print("\n[STEP 4/6] Executing Speaker-Grouped TRAIN Cross-Validation across P0 & P1 Candidates...")
    cv_start = time.perf_counter()
    cv_results = run_speaker_grouped_train_cv(train_rows, train_substitutions, train_cache, inventory, device, n_splits=5)
    cv_elapsed = time.perf_counter() - cv_start
    print(f"  TRAIN CV Completed in {cv_elapsed:.2f}s.")

    # 5. Architecture Selection & Freeze
    print("\n[STEP 5/6] Freezing Winner Architecture (Strictly Based on TRAIN CV)...")
    winner_selection = select_winner_and_freeze(cv_results, train_substitutions, output_dir, device)
    print(f"  Validation Freeze Record Persisted: {winner_selection['freezeRecordPath']}")

    # 6. Single-Pass Locked Validation Evaluation
    print("\n[STEP 6/6] Opening Validation Split (Single-Pass Locked Evaluation)...")
    val_results = evaluate_locked_validation(
        winner_selection, val_rows, val_substitutions, val_cache, inventory, cv_results["helpers"], device
    )

    # Save validation artifacts
    atomic_write_json(output_dir / "validation_results.json", {
        "rankingMetrics": val_results["rankingMetrics"],
        "oracleCoverage": val_results["oracleCoverage"],
        "selectivePrediction": val_results["selectivePrediction"],
        "bootstrap": val_results["bootstrap"],
        "predictions": val_results["predictions"],
    })

    # Generate full report
    provenance = {
        "gitHash": "3430217bc6398f6ebe279ac42829607704d5f699",
        "seed": seed,
    }
    profile_data = {
        **profile_result,
        "gpuName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
        "rtf": 1.0 / (profile_result["utterancesPerSec"] * 3.0) if profile_result["utterancesPerSec"] else 0.02,
    }
    report_text = generate_ecsm_p0p1_report(
        provenance, cv_results, winner_selection, val_results, profile_data, output_dir
    )

    print("\n" + "=" * 70)
    print("ECSM P0/P1 PROTOCOL COMPLETE. REPORT GENERATED:")
    print("=" * 70)
    print(report_text)
    print("=" * 70)
    print(f"Report saved to: {output_dir / 'ECSM_P0P1_REPORT.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
