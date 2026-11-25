"""
ECSM-v1 / EC-PRISM Phase P2: Error-Type / Confusion-Direction Holdout Experiment.
Evaluates structured articulatory generalization when specific substitution confusions
are deliberately withheld from training supervision.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.metrics import accuracy_score, f1_score
import torch
import torch.nn as nn
import torch.optim as optim

from app.services.pronunciation.ecsm.articulatory_reality import (
    FACTOR_VOCABULARIES,
    SharedArticulatoryAdapter,
    compute_articulatory_multitask_loss,
    compute_fold_class_weights,
    extract_articulatory_ground_truth,
    predict_articulatory_distributions,
)
from app.services.pronunciation.ecsm.phone_metric_space import (
    MetricProjectionHead,
)


def audit_confusion_support(
    substitution_rows: Sequence[Mapping[str, Any]],
) -> List[Tuple[str, str, int]]:
    """
    Audits frequency of substitution directions (expected -> human_perceived) in dataset.
    """
    counter = Counter()
    for row in substitution_rows:
        exp = str(row.get("expectedPhoneme", ""))
        perc = str(row.get("humanPerceivedPhoneme", ""))
        if exp and perc and exp != perc:
            counter[(exp, perc)] += 1
            
    return [(pair[0], pair[1], count) for pair, count in counter.most_common()]


def run_heldout_confusion_experiment(
    train_rows: Sequence[Mapping[str, Any]],
    heldout_pairs: Sequence[Tuple[str, str]],
    row_features: Mapping[str, np.ndarray],
    device: torch.device,
    in_features: int = 1416,
    num_epochs: int = 15,
    seed: int = 20260830,
) -> Dict[str, Any]:
    """
    Trains articulatory model with specific confusion directions withheld,
    then evaluates whether articulatory attributes generalize to held-out error types.
    """
    torch.manual_seed(seed)
    np.random.seed(seed)
    
    heldout_set = set(heldout_pairs)
    
    # 1. Split training into clean train vs held-out target instances
    train_pool = []
    eval_pools: Dict[str, List[Mapping[str, Any]]] = {f"{exp}->{perc}": [] for exp, perc in heldout_pairs}
    
    for row in train_rows:
        exp = str(row["expectedPhoneme"])
        perc = str(row["humanPerceivedPhoneme"])
        pair = (exp, perc)
        if pair in heldout_set:
            eval_pools[f"{exp}->{perc}"].append(row)
        else:
            train_pool.append(row)
            
    # 2. Extract train features & ground truths
    x_train = np.array([row_features[r["rowId"]] for r in train_pool], dtype=np.float32)
    gt_train = [extract_articulatory_ground_truth(str(r["humanPerceivedPhoneme"])) for r in train_pool]
    
    # Compute class weights strictly on fold train
    class_weights = {}
    for factor, vocab in FACTOR_VOCABULARIES.items():
        targets = [getattr(gt, f"{factor}_idx", -1) for gt in gt_train]
        class_weights[factor] = compute_fold_class_weights(targets, len(vocab))
        
    # 3. Train Shared Articulatory Adapter
    model = SharedArticulatoryAdapter(in_features=in_features, hidden_dim=256).to(device)
    optimizer = optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    
    batch_size = 64
    n_samples = len(x_train)
    model.train()
    
    for epoch in range(num_epochs):
        perm = np.random.permutation(n_samples)
        for i in range(0, n_samples, batch_size):
            batch_idx = perm[i:i + batch_size]
            batch_x = torch.tensor(x_train[batch_idx], dtype=torch.float32, device=device)
            batch_gts = [gt_train[b] for b in batch_idx]
            
            optimizer.zero_grad()
            logits_dict = model(batch_x)
            loss, _ = compute_articulatory_multitask_loss(
                logits_dict, batch_gts, class_weights=class_weights, device=device
            )
            loss.backward()
            optimizer.step()
            
    # 4. Evaluate on each held-out confusion direction
    model.eval()
    pair_results: Dict[str, Any] = {}
    
    for pair_name, eval_rows in eval_pools.items():
        if not eval_rows:
            pair_results[pair_name] = {"support": 0, "status": "NO_SAMPLES"}
            continue
            
        x_eval = np.array([row_features[r["rowId"]] for r in eval_rows], dtype=np.float32)
        preds = predict_articulatory_distributions(model, x_eval, device)
        eval_gts = [extract_articulatory_ground_truth(str(r["humanPerceivedPhoneme"])) for r in eval_rows]
        
        factor_eval: Dict[str, Any] = {}
        for factor, vocab in FACTOR_VOCABULARIES.items():
            y_true = [getattr(gt, f"{factor}_idx", -1) for gt in eval_gts]
            valid_indices = [idx for idx, y in enumerate(y_true) if 0 <= y < len(vocab)]
            
            if not valid_indices:
                continue
                
            y_true_filtered = [y_true[idx] for idx in valid_indices]
            y_pred_filtered = [vocab.index(preds[idx][factor]["topValue"]) for idx in valid_indices]
            
            acc = float(accuracy_score(y_true_filtered, y_pred_filtered))
            macro_f1 = float(f1_score(y_true_filtered, y_pred_filtered, average="macro", zero_division=0))
            weighted_f1 = float(f1_score(y_true_filtered, y_pred_filtered, average="weighted", zero_division=0))
            
            factor_eval[factor] = {
                "accuracy": acc,
                "macroF1": macro_f1,
                "weightedF1": weighted_f1,
                "validSupport": len(valid_indices),
            }
            
        pair_results[pair_name] = {
            "support": len(eval_rows),
            "factorMetrics": factor_eval,
        }
        
    return {
        "trainSupport": len(train_pool),
        "heldoutSupportTotal": sum(len(pool) for pool in eval_pools.values()),
        "heldoutResults": pair_results,
    }
