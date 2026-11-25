"""Final Acoustic Round 2 execution engine.

The engine is intentionally research-only.  It never mutates production response
schemas and it requires an explicit train-only freeze record before validation.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:
    import soundfile as sf
except ImportError:
    sf = None

import numpy as np
from safetensors.torch import load_file
from sklearn.metrics import average_precision_score, roc_auc_score, roc_curve
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

from app.services.pronunciation.acoustic_peft import (
    CANONICAL_MODEL_ID,
    CANONICAL_MODEL_REVISION,
    inject_wav2vec2_lora,
)
from app.services.pronunciation.articulatory_diagnosis import CanonicalRealPhoneInventory, TrainConfusionGraph
from app.services.pronunciation.context_ctc_diagnosis import (
    MarginConfidenceCalibrator,
    PhoneRobustNormalizer,
    ROUND2_FEATURE_VERSION,
    Round2LogitCache,
    atomic_write_json,
    build_fold_candidate_graph,
    candidate_oracle_coverage,
    ctc_sequence_log_probability,
    derive_confidence_thresholds,
    deterministic_group_folds,
    evaluate_selective,
    paired_bootstrap_improvement,
    ranking_metrics,
    stable_log_softmax,
    tensor_sha256,
)
from app.services.pronunciation.operating_points import optimize_far_constrained_threshold
from scripts.acoustic_peft_controlled_study import resolve_speechocean_wav_path


SEED = 20260830
EXPECTED_REPOSITORY_COMMIT = "3430217bc6398f6ebe279ac42829607704d5f699"
EXPECTED_MODEL_E_HASH = "d12d360efbb21b794bc21416939fb5de396d624284b1a219545e4fd6f8840e5c"
EXPECTED_MODEL_E_BEST_EPOCH = 11
EXPECTED_MODEL_E_METRICS = {
    "rocAuc": 0.8614046594466042,
    "ap": 0.3029347875299305,
    "eer": 0.19541733988151422,
    "substitutionCount": 516,
}
ALLOWED_SPLITS = {"calibration", "validation"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def row_id(row: Mapping[str, Any]) -> str:
    return f"{row['utteranceId']}:{int(row['wordIndex'])}:{int(row['phoneIndex'])}"


def load_authorized_phone_rows(data_dir: Path, split: str) -> List[Dict[str, Any]]:
    """Deserialize only explicitly authorized JSONL rows.

    Locked split lines are checked lexically and skipped before ``json.loads``.
    """
    if split not in ALLOWED_SPLITS:
        raise ValueError(f"unauthorized SpeechOcean split: {split}")
    path = data_dir / "outputs/phone_instances.jsonl"
    split_pattern = re.compile(r'"split"\s*:\s*"([^\"]+)"')
    dataset_pattern = re.compile(r'"dataset"\s*:\s*"([^\"]+)"')
    rows: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            split_match = split_pattern.search(raw_line)
            dataset_match = dataset_pattern.search(raw_line)
            if not split_match or not dataset_match:
                continue
            if dataset_match.group(1) != "speechocean762" or split_match.group(1) != split:
                continue
            row = json.loads(raw_line)
            if row.get("split") != split or row.get("dataset") != "speechocean762":
                raise RuntimeError("lexical split guard disagrees with decoded row")
            if row.get("rawGop") is None or row.get("expectedPhoneme") == "\u0329" or row.get("phone") == "\u0329":
                continue
            row["rowId"] = row_id(row)
            rows.append(row)
    if not rows:
        raise RuntimeError(f"no authorized rows found for {split}")
    return rows


def overlay_authorized_repairs(data_dir: Path, rows: Sequence[Dict[str, Any]]) -> None:
    repairs_path = data_dir / "outputs/shd-2b.2b/repaired_phone_labels.jsonl"
    if not repairs_path.exists():
        return
    row_map = {row["rowId"]: row for row in rows}
    utterance_pattern = re.compile(r'"utteranceId"\s*:\s*"([^\"]+)"')
    word_pattern = re.compile(r'"wordIndex"\s*:\s*(\d+)')
    phone_pattern = re.compile(r'"phoneIndex"\s*:\s*(\d+)')
    with open(repairs_path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            u, w, p = utterance_pattern.search(raw_line), word_pattern.search(raw_line), phone_pattern.search(raw_line)
            if not (u and w and p):
                continue
            key = f"{u.group(1)}:{int(w.group(1))}:{int(p.group(1))}"
            if key not in row_map:
                continue
            repair = json.loads(raw_line)
            row_map[key]["humanPhoneAccuracy"] = repair.get("humanPhoneAccuracy")


def load_authorized_score_details(path: Path, utterance_ids: Iterable[str]) -> Dict[str, Any]:
    """Read only selected top-level entries from the pretty-printed corpus JSON.

    Non-authorized utterance bodies are streamed past and never accumulated or
    deserialized.  The corpus format has one top-level utterance key at indent 2.
    """
    allowed = set(str(value) for value in utterance_ids)
    key_pattern = re.compile(r'^  "([^"]+)"\s*:\s*(\{.*)$')
    result: Dict[str, Any] = {}
    current_key: Optional[str] = None
    buffer: List[str] = []

    def finish() -> None:
        nonlocal current_key, buffer
        if current_key is None:
            return
        text = "\n".join(buffer).rstrip()
        value, end = json.JSONDecoder().raw_decode(text)
        remainder = text[end:].strip()
        if remainder not in {"", ",", "}"}:
            raise RuntimeError(f"unexpected trailing data in authorized score detail {current_key}")
        result[current_key] = value
        current_key, buffer = None, []

    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            match = key_pattern.match(line)
            if match:
                finish()
                key = match.group(1)
                if key in allowed:
                    current_key = key
                    buffer = [match.group(2).rstrip("\r\n")]
                continue
            if current_key is not None:
                buffer.append(line.rstrip("\r\n"))
    finish()
    missing = sorted(allowed - set(result))
    if missing:
        raise RuntimeError(f"authorized score details missing for {len(missing)} utterances")
    return result


def _unwrap_phone(token: str) -> Tuple[str, str]:
    if len(token) >= 3 and token[0] in "([{\"" and token[-1] in ")]}\"":
        wrappers = {"(": "deleted", "[": "inserted", "{": "uncertain", '"': "quoted"}
        return wrappers[token[0]], token[1:-1]
    return "canonical", token


def extract_human_perceived_map(
    details: Mapping[str, Any], inventory: CanonicalRealPhoneInventory
) -> Dict[Tuple[str, int, int], str]:
    """Reproduce the accepted Round-1 physical human-annotation projection.

    SpeechOcean exposes perceived bracket phones at word/expert level rather than
    as a normalized per-reference-phone field.  Round 1 deterministically used the
    first valid bracket phone in expert order for each reference-phone row in that
    word.  Round 2 preserves that frozen projection so N=516 remains physically
    identical; it does not infer labels from acoustic scores or canonical phones.
    """
    resolved: Dict[Tuple[str, int, int], str] = {}
    for utterance_id, utterance in details.items():
        for word_index, word in enumerate(utterance.get("words", [])):
            reference = word.get("ref-phones", "").split()
            perceived_candidates: List[str] = []
            for expert in word.get("phones", []):
                tokens = expert.split()
                for token in tokens:
                    kind, inserted_arpa = _unwrap_phone(token)
                    if kind != "inserted":
                        continue
                    perceived = inventory.arpabet2ipa.get(inserted_arpa.upper().rstrip("012"))
                    if perceived in inventory.phone2profile:
                        perceived_candidates.append(perceived)
            if perceived_candidates:
                for phone_index in range(len(reference)):
                    resolved[(utterance_id, word_index, phone_index)] = perceived_candidates[0]
    return resolved


def attach_human_targets(
    rows: Sequence[Dict[str, Any]], perceived_map: Mapping[Tuple[str, int, int], str]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    diagnosed: List[Dict[str, Any]] = []
    substitutions: List[Dict[str, Any]] = []
    for original in rows:
        row = dict(original)
        key = (str(row["utteranceId"]), int(row["wordIndex"]), int(row["phoneIndex"]))
        perceived = perceived_map.get(key)
        if perceived:
            row["humanPerceivedPhoneme"] = perceived
        elif row.get("humanPhoneAccuracy") == 2.0:
            row["humanPerceivedPhoneme"] = row["expectedPhoneme"]
        else:
            continue
        diagnosed.append(row)
        if row["humanPerceivedPhoneme"] != row["expectedPhoneme"]:
            substitutions.append(row)
    return diagnosed, substitutions


def load_split_bundle(
    data_dir: Path, split: str, inventory: CanonicalRealPhoneInventory
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    rows = load_authorized_phone_rows(data_dir, split)
    overlay_authorized_repairs(data_dir, rows)
    utterance_ids = {str(row["utteranceId"]) for row in rows}
    details = load_authorized_score_details(
        data_dir / "corpora/speechocean762/resource/scores-detail.json", utterance_ids
    )
    perceived = extract_human_perceived_map(details, inventory)
    diagnosed, substitutions = attach_human_targets(rows, perceived)
    rows = [row for row in rows if row["expectedPhoneme"] in inventory.phone2profile]
    diagnosed = [
        row for row in diagnosed
        if row["expectedPhoneme"] in inventory.phone2profile
        and row["humanPerceivedPhoneme"] in inventory.phone2profile
    ]
    substitutions = [
        row for row in substitutions
        if row["expectedPhoneme"] in inventory.phone2profile
        and row["humanPerceivedPhoneme"] in inventory.phone2profile
    ]
    return rows, diagnosed, substitutions, details


def build_round1_detection_graph(
    details: Mapping[str, Any], inventory: CanonicalRealPhoneInventory
) -> Dict[str, Tuple[str, ...]]:
    """Reproduce Round-1 top-five empirical competitors from authorized train details."""
    counts: Dict[str, Counter[str]] = defaultdict(Counter)
    for utterance in details.values():
        for word in utterance.get("words", []):
            for expert in word.get("phones", []):
                tokens = expert.split()
                for index, token in enumerate(tokens):
                    kind, inserted = _unwrap_phone(token)
                    if kind != "inserted":
                        continue
                    target: Optional[str] = None
                    if index > 0 and _unwrap_phone(tokens[index - 1])[0] == "deleted":
                        target = _unwrap_phone(tokens[index - 1])[1]
                    elif index + 1 < len(tokens) and _unwrap_phone(tokens[index + 1])[0] == "deleted":
                        target = _unwrap_phone(tokens[index + 1])[1]
                    expected = inventory.arpabet2ipa.get(target.upper().rstrip("012")) if target else None
                    perceived = inventory.arpabet2ipa.get(inserted.upper().rstrip("012"))
                    if expected in inventory.phone2profile and perceived in inventory.phone2profile and expected != perceived:
                        counts[expected][perceived] += 1
    graph: Dict[str, Tuple[str, ...]] = {}
    for phone in inventory.phone2profile:
        competitors = {candidate for candidate, _ in counts[phone].most_common(5)}
        if len(competitors) < 4:
            for neighbor in inventory.get_articulatory_neighbors(phone, top_k=6):
                competitors.add(neighbor)
                if len(competitors) >= 6:
                    break
        graph[phone] = tuple(sorted(competitors))
    return graph


def preflight(repo_root: Path, data_dir: Path) -> Dict[str, Any]:
    head = os.environ.get("ROUND2_REPOSITORY_COMMIT", "").strip()
    if not head:
        head = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
    if head != EXPECTED_REPOSITORY_COMMIT:
        raise RuntimeError(f"unexpected repository HEAD: {head}")
    checkpoint_dir = data_dir / "outputs/shd-2b.5/round1/checkpoint_MODEL_E_SEED1"
    adapter_path = checkpoint_dir / "best_adapter.safetensors"
    checkpoint_hash = sha256_file(adapter_path)
    if checkpoint_hash != EXPECTED_MODEL_E_HASH:
        raise RuntimeError(f"MODEL_E_SEED1 checkpoint hash mismatch: {checkpoint_hash}")
    state = json.loads((checkpoint_dir / "run_state.json").read_text(encoding="utf-8"))
    metrics = state["finalValidationMetrics"]
    if state["seed"] != SEED or state["bestEpoch"] != EXPECTED_MODEL_E_BEST_EPOCH:
        raise RuntimeError("MODEL_E_SEED1 seed or best epoch mismatch")
    for key in ("rocAuc", "ap", "eer"):
        if abs(float(metrics["primary"][key]) - EXPECTED_MODEL_E_METRICS[key]) > 1e-12:
            raise RuntimeError(f"MODEL_E_SEED1 {key} provenance mismatch")
    if metrics["diagnosis"]["substitutionOnly"]["evaluatedSamples"] != 516:
        raise RuntimeError("MODEL_E_SEED1 substitution denominator mismatch")
    return {
        "repositoryCommit": head,
        "candidateId": "MODEL_E_SEED1",
        "seed": state["seed"],
        "bestEpoch": state["bestEpoch"],
        "checkpointPath": str(adapter_path),
        "checkpointSha256": checkpoint_hash,
        "baseModelId": CANONICAL_MODEL_ID,
        "baseModelRevision": CANONICAL_MODEL_REVISION,
        "lora": {"targetLayers": [20, 21, 22, 23], "rank": 4, "alpha": 4.0},
        "validationMetrics": metrics,
    }


def load_frozen_model(data_dir: Path, device: torch.device) -> Tuple[Any, Any, int]:
    processor = Wav2Vec2Processor.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
    model = Wav2Vec2ForCTC.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
    inject_wav2vec2_lora(model, target_layers=[20, 21, 22, 23], rank=4, alpha=4.0)
    weights = load_file(
        data_dir / "outputs/shd-2b.5/round1/checkpoint_MODEL_E_SEED1/best_adapter.safetensors",
        device="cpu",
    )
    model.load_state_dict(weights, strict=False)
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    if trainable != 0:
        raise RuntimeError(f"frozen acoustic model has {trainable} trainable parameters")
    model.eval().to(device)
    return processor, model, trainable


def build_cache_identity(provenance: Mapping[str, Any], processor: Any, split: str) -> Dict[str, Any]:
    return {
        "featureVersion": ROUND2_FEATURE_VERSION,
        "checkpointSha256": provenance["checkpointSha256"],
        "baseModelRevision": CANONICAL_MODEL_REVISION,
        "processorClass": processor.__class__.__name__,
        "tokenizerSize": len(processor.tokenizer.get_vocab()),
        "split": split,
    }


def cache_logits(
    rows: Sequence[Mapping[str, Any]],
    cache: Round2LogitCache,
    model: Any,
    wave_root: Path,
    device: torch.device,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    by_utterance: Dict[str, Mapping[str, Any]] = {}
    for row in rows:
        by_utterance.setdefault(str(row["utteranceId"]), row)
    utterances = sorted(by_utterance)
    if limit is not None:
        utterances = utterances[:limit]
    generated = reused = 0
    start = time.perf_counter()
    peak_vram = 0
    with torch.inference_mode():
        for utterance_id in utterances:
            row = by_utterance[utterance_id]
            audio_hash = str(row["manifestAudioSha256"])
            if cache.load(utterance_id, audio_hash) is not None:
                reused += 1
                continue
            wav_path = resolve_speechocean_wav_path(wave_root, row["speakerId"], utterance_id)
            if wav_path is None or not wav_path.exists():
                raise RuntimeError(f"authorized audio missing: {utterance_id}")
            audio, sample_rate = sf.read(wav_path)
            if sample_rate != 16000:
                raise RuntimeError(f"unexpected sample rate {sample_rate} for {utterance_id}")
            tensor = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0).to(device)
            logits = model(tensor).logits[0].detach().cpu().numpy().astype(np.float32, copy=False)
            cache.save(utterance_id, audio_hash, logits)
            generated += 1
            if torch.cuda.is_available():
                peak_vram = max(peak_vram, int(torch.cuda.max_memory_allocated()))
    elapsed = time.perf_counter() - start
    return {
        "utterances": len(utterances),
        "generated": generated,
        "reused": reused,
        "elapsedSec": elapsed,
        "utterancesPerSec": len(utterances) / elapsed if elapsed else 0.0,
        "peakVramBytes": peak_vram,
    }


def audit_cache_identity(
    rows: Sequence[Mapping[str, Any]],
    cache: Round2LogitCache,
    model: Any,
    wave_root: Path,
    device: torch.device,
    count: int = 10,
) -> Dict[str, Any]:
    by_utterance: Dict[str, Mapping[str, Any]] = {}
    for row in rows:
        by_utterance.setdefault(str(row["utteranceId"]), row)
    audited: List[Dict[str, Any]] = []
    with torch.inference_mode():
        for utterance_id in sorted(by_utterance)[:count]:
            row = by_utterance[utterance_id]
            audio_hash = str(row["manifestAudioSha256"])
            cached = cache.load(utterance_id, audio_hash)
            if cached is None:
                raise RuntimeError(f"audit cache entry missing: {utterance_id}")
            wav_path = resolve_speechocean_wav_path(wave_root, row["speakerId"], utterance_id)
            audio, _ = sf.read(wav_path)
            fresh = model(torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0).to(device)).logits[0]
            fresh_array = fresh.detach().cpu().numpy().astype(np.float32, copy=False)
            identical = cached.shape == fresh_array.shape and cached.dtype == fresh_array.dtype and np.array_equal(cached, fresh_array)
            if not identical:
                raise RuntimeError(f"cached acoustic logits are not identical for {utterance_id}")
            audited.append({"utteranceId": utterance_id, "sha256": tensor_sha256(cached)})
    return {"count": len(audited), "exactIdentity": True, "utterances": audited}


def word_groups(rows: Sequence[Mapping[str, Any]]) -> Dict[Tuple[str, int], List[Mapping[str, Any]]]:
    groups: Dict[Tuple[str, int], List[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(str(row["utteranceId"]), int(row["wordIndex"]))].append(row)
    for values in groups.values():
        values.sort(key=lambda row: int(row["phoneIndex"]))
    return groups


def articulatory_neighbor_map(inventory: CanonicalRealPhoneInventory) -> Dict[str, List[str]]:
    result: Dict[str, List[str]] = {}
    for phone, profile in inventory.phone2profile.items():
        candidates = []
        for other, other_profile in inventory.phone2profile.items():
            if phone == other or profile.isVowel != other_profile.isVowel:
                continue
            candidates.append((inventory.compute_articulatory_distance(phone, other), other))
        result[phone] = [phone_name for _, phone_name in sorted(candidates)[:6]]
    return result


def _context_rows(
    row: Mapping[str, Any], groups: Mapping[Tuple[str, int], Sequence[Mapping[str, Any]]], window: str
) -> Tuple[List[Mapping[str, Any]], int]:
    values = list(groups[(str(row["utteranceId"]), int(row["wordIndex"]))])
    target = next(index for index, value in enumerate(values) if value["rowId"] == row["rowId"])
    if window == "target":
        return [values[target]], 0
    if window == "neighbors":
        start, end = max(0, target - 1), min(len(values), target + 2)
        return values[start:end], target - start
    if window == "word":
        return values, target
    raise ValueError(f"unknown context window: {window}")


def score_substitution_row(
    row: Mapping[str, Any],
    all_groups: Mapping[Tuple[str, int], Sequence[Mapping[str, Any]]],
    logits: np.ndarray,
    candidate_graph: Mapping[str, Sequence[str]],
    inventory: CanonicalRealPhoneInventory,
    blank_id: int,
    window: str,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    context, target_index = _context_rows(row, all_groups, window)
    start = max(0, min(int(value["startFrame"]) for value in context))
    end = min(logits.shape[0], max(int(value["endFrame"]) for value in context))
    end = max(start + 1, end)
    local_log_probs = stable_log_softmax(logits[start:end])
    canonical = [inventory.phone2profile[str(value["expectedPhoneme"])].tokenId for value in context]
    # A CTC sequence can be structurally impossible when a very short aligned
    # window contains repeated labels.  Preserve it as a deterministic finite
    # floor for downstream ranking/features instead of leaking +/-inf into B.
    impossible_floor = float(np.min(local_log_probs) * max(1, len(local_log_probs)) - 50.0)
    canonical_score = ctc_sequence_log_probability(local_log_probs, canonical, blank_id)
    if not np.isfinite(canonical_score):
        canonical_score = impossible_floor
    expected = str(row["expectedPhoneme"])
    candidates = list(candidate_graph.get(expected, (expected,)))
    candidate_rows: List[Dict[str, Any]] = []
    target_start = max(0, min(int(row["startFrame"]), logits.shape[0] - 1))
    target_end = min(logits.shape[0], max(target_start + 1, int(row["endFrame"])))
    target_log_probs = stable_log_softmax(logits[target_start:target_end])
    for candidate in candidates:
        sequence = list(canonical)
        token_id = inventory.phone2profile[candidate].tokenId
        sequence[target_index] = token_id
        score = ctc_sequence_log_probability(local_log_probs, sequence, blank_id)
        if not np.isfinite(score):
            score = impossible_floor
        posterior_mean = float(np.mean(np.exp(target_log_probs[:, token_id])))
        left_agreement = float(np.max(np.exp(local_log_probs[0])))
        right_agreement = float(np.max(np.exp(local_log_probs[-1])))
        duration = float(target_end - target_start)
        delta = float(score - canonical_score)
        features = [
            delta,
            float(canonical_score / max(1, len(local_log_probs))),
            float(score / max(1, len(local_log_probs))),
            posterior_mean,
            float(np.max(target_log_probs[:, token_id])),
            float(np.mean(target_log_probs[:, token_id])),
            duration,
            float(score / max(1.0, duration)),
            left_agreement,
            right_agreement,
            float(inventory.compute_articulatory_distance(expected, candidate)),
            1.0 if candidate == expected else 0.0,
            float(len(context)),
        ]
        candidate_rows.append({"phone": candidate, "score": float(score), "delta": delta, "features": features})
    candidate_rows.sort(key=lambda value: (-value["delta"], value["phone"]))
    truth = str(row["humanPerceivedPhoneme"])
    ordered = [value["phone"] for value in candidate_rows]
    rank = ordered.index(truth) + 1 if truth in ordered else len(ordered) + 1
    margin = candidate_rows[0]["delta"] - candidate_rows[1]["delta"] if len(candidate_rows) > 1 else math.inf
    result = {
        "rowId": row["rowId"],
        "speakerId": row["speakerId"],
        "expectedPhoneme": expected,
        "humanPerceivedPhoneme": truth,
        "predictedPhoneme": candidate_rows[0]["phone"],
        "rank": rank,
        "margin": float(margin),
        "candidateCount": len(candidate_rows),
        "targetPresent": truth in ordered,
    }
    return result, candidate_rows


def baseline_substitution_row(
    row: Mapping[str, Any], logits: np.ndarray, inventory: CanonicalRealPhoneInventory
) -> Dict[str, Any]:
    start = max(0, min(int(row["startFrame"]), logits.shape[0] - 1))
    end = min(logits.shape[0], max(start + 1, int(row["endFrame"])))
    token_ids = inventory.token_ids
    means = np.mean(logits[start:end, token_ids], axis=0)
    phones = [profile.canonicalIpa for profile in inventory.real_phones]
    ordered = [phones[index] for index in np.argsort(-means, kind="stable")]
    truth = str(row["humanPerceivedPhoneme"])
    rank = ordered.index(truth) + 1 if truth in ordered else len(ordered) + 1
    return {
        "rowId": row["rowId"],
        "speakerId": row["speakerId"],
        "expectedPhoneme": row["expectedPhoneme"],
        "humanPerceivedPhoneme": truth,
        "predictedPhoneme": ordered[0],
        "rank": rank,
    }


def load_logits_for_row(row: Mapping[str, Any], cache: Round2LogitCache) -> np.ndarray:
    logits = cache.load(str(row["utteranceId"]), str(row["manifestAudioSha256"]))
    if logits is None:
        raise RuntimeError(f"missing logits for {row['utteranceId']}")
    return logits


def score_rows(
    rows: Sequence[Mapping[str, Any]],
    groups: Mapping[Tuple[str, int], Sequence[Mapping[str, Any]]],
    cache: Round2LogitCache,
    graph: Mapping[str, Sequence[str]],
    inventory: CanonicalRealPhoneInventory,
    blank_id: int,
    window: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    results: List[Dict[str, Any]] = []
    candidate_features: Dict[str, List[Dict[str, Any]]] = {}
    for row in sorted(rows, key=lambda value: value["rowId"]):
        result, features = score_substitution_row(
            row, groups, load_logits_for_row(row, cache), graph, inventory, blank_id, window
        )
        results.append(result)
        candidate_features[result["rowId"]] = features
    return results, candidate_features


def score_baseline_rows(
    rows: Sequence[Mapping[str, Any]], cache: Round2LogitCache, inventory: CanonicalRealPhoneInventory
) -> List[Dict[str, Any]]:
    return [
        baseline_substitution_row(row, load_logits_for_row(row, cache), inventory)
        for row in sorted(rows, key=lambda value: value["rowId"])
    ]


class TinyCandidateReranker(nn.Module):
    def __init__(self, feature_count: int):
        super().__init__()
        self.network = nn.Sequential(nn.Linear(feature_count, 32), nn.ReLU(), nn.Linear(32, 1))

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.network(features).squeeze(-1)


def fit_standardizer(feature_groups: Mapping[str, Sequence[Mapping[str, Any]]]) -> Tuple[np.ndarray, np.ndarray]:
    matrix = np.asarray(
        [candidate["features"] for group in feature_groups.values() for candidate in group], dtype=np.float32
    )
    if matrix.ndim != 2 or matrix.shape[0] == 0:
        raise ValueError("candidate feature groups are empty")
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return mean, scale


def rerank_predictions(
    model: TinyCandidateReranker,
    rows: Sequence[Mapping[str, Any]],
    feature_groups: Mapping[str, Sequence[Mapping[str, Any]]],
    mean: np.ndarray,
    scale: np.ndarray,
    device: torch.device,
) -> List[Dict[str, Any]]:
    model.eval()
    ordered_rows = sorted(rows, key=lambda value: value["rowId"])
    groups = [list(feature_groups[row["rowId"]]) for row in ordered_rows]
    lengths = [len(group) for group in groups]
    full_matrix = np.asarray(
        [candidate["features"] for group in groups for candidate in group], dtype=np.float32
    )
    full_matrix = (full_matrix - mean) / scale
    with torch.inference_mode():
        full_scores = model(torch.from_numpy(full_matrix).to(device)).detach().cpu().numpy()
    results: List[Dict[str, Any]] = []
    offset = 0
    for row, candidates, length in zip(ordered_rows, groups, lengths):
            scores = full_scores[offset:offset + length]
            offset += length
            order = sorted(range(len(candidates)), key=lambda index: (-float(scores[index]), candidates[index]["phone"]))
            ordered = [candidates[index]["phone"] for index in order]
            truth = str(row["humanPerceivedPhoneme"])
            rank = ordered.index(truth) + 1 if truth in ordered else len(ordered) + 1
            sorted_scores = [float(scores[index]) for index in order]
            margin = sorted_scores[0] - sorted_scores[1] if len(sorted_scores) > 1 else math.inf
            results.append({
                "rowId": row["rowId"],
                "speakerId": row["speakerId"],
                "expectedPhoneme": row["expectedPhoneme"],
                "humanPerceivedPhoneme": truth,
                "predictedPhoneme": ordered[0],
                "rank": rank,
                "margin": margin,
                "candidateCount": len(ordered),
                "targetPresent": truth in ordered,
            })
    return results


def train_reranker(
    train_rows: Sequence[Mapping[str, Any]],
    train_features: Mapping[str, Sequence[Mapping[str, Any]]],
    device: torch.device,
    epochs: int,
    held_rows: Optional[Sequence[Mapping[str, Any]]] = None,
    held_features: Optional[Mapping[str, Sequence[Mapping[str, Any]]]] = None,
    patience: int = 8,
    min_delta: float = 1e-4,
) -> Dict[str, Any]:
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    mean, scale = fit_standardizer(train_features)
    feature_count = len(mean)
    model = TinyCandidateReranker(feature_count).to(device)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    if parameter_count > 100_000:
        raise RuntimeError(f"reranker exceeds parameter limit: {parameter_count}")
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    class_support = Counter(str(row["humanPerceivedPhoneme"]) for row in train_rows)
    best_mrr = -math.inf
    best_epoch = epochs
    best_state: Optional[Dict[str, torch.Tensor]] = None
    stale = 0
    history: List[Dict[str, float | int]] = []
    sorted_train = sorted(train_rows, key=lambda value: value["rowId"])
    flattened: List[Sequence[float]] = []
    segments: List[Tuple[int, int, int, float]] = []
    for row in sorted_train:
        candidates = list(train_features[row["rowId"]])
        phones = [candidate["phone"] for candidate in candidates]
        truth = str(row["humanPerceivedPhoneme"])
        if truth not in phones:
            continue
        start = len(flattened)
        flattened.extend(candidate["features"] for candidate in candidates)
        segments.append((start, len(flattened), phones.index(truth), 1.0 / math.sqrt(class_support[truth])))
    train_matrix = (np.asarray(flattened, dtype=np.float32) - mean) / scale
    train_tensor = torch.from_numpy(train_matrix).to(device)
    for epoch in range(1, epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        logits = model(train_tensor)
        losses = [
            -F.log_softmax(logits[start:end], dim=0)[target] * weight
            for start, end, target, weight in segments
        ]
        loss = torch.stack(losses).mean()
        loss.backward()
        optimizer.step()
        record: Dict[str, float | int] = {"epoch": epoch, "loss": float(loss.detach().cpu())}
        if held_rows is not None and held_features is not None:
            held_predictions = rerank_predictions(model, held_rows, held_features, mean, scale, device)
            held_mrr = float(ranking_metrics(held_predictions)["mrr"])
            record["heldMrr"] = held_mrr
            if held_mrr > best_mrr + min_delta:
                best_mrr = held_mrr
                best_epoch = epoch
                stale = 0
                best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
            else:
                stale += 1
            if stale >= patience:
                history.append(record)
                break
        history.append(record)
    if best_state is not None:
        model.load_state_dict(best_state)
    return {
        "model": model,
        "mean": mean,
        "scale": scale,
        "parameterCount": parameter_count,
        "bestEpoch": best_epoch,
        "history": history,
        "classSupport": dict(class_support),
    }


def _calibrate_fold_predictions(
    fit_predictions: Sequence[Dict[str, Any]], held_predictions: Sequence[Dict[str, Any]]
) -> Tuple[Dict[str, Optional[float]], List[Dict[str, Any]]]:
    fit_margins = [float(row["margin"]) for row in fit_predictions]
    finite_fallback = max([value for value in fit_margins if np.isfinite(value)] or [0.0]) + 1.0
    fit_margins = [value if np.isfinite(value) else finite_fallback for value in fit_margins]
    fit_correct = [int(row["rank"] == 1) for row in fit_predictions]
    calibrator = MarginConfidenceCalibrator().fit(fit_margins, fit_correct)
    fit_confidence = calibrator.predict(fit_margins)
    thresholds = derive_confidence_thresholds(fit_confidence, fit_correct)
    held_margins = [float(row["margin"]) for row in held_predictions]
    held_margins = [value if np.isfinite(value) else finite_fallback for value in held_margins]
    held_confidence = calibrator.predict(held_margins)
    calibrated: List[Dict[str, Any]] = []
    for row, confidence in zip(held_predictions, held_confidence):
        enriched = dict(row)
        enriched["confidence"] = float(confidence)
        threshold70 = thresholds.get("precision_70")
        enriched["selectedAtPrecision70"] = bool(threshold70 is not None and float(confidence) >= threshold70)
        calibrated.append(enriched)
    return thresholds, calibrated


def _oof_selective_gate(rows: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    selected = [row for row in rows if row.get("selectedAtPrecision70")]
    return {
        "selected": len(selected),
        "coverage": len(selected) / len(rows) if rows else 0.0,
        "precision": float(np.mean([row["rank"] == 1 for row in selected])) if selected else 0.0,
    }


def run_train_grouped_cv(
    train_rows: Sequence[Dict[str, Any]],
    train_substitutions: Sequence[Dict[str, Any]],
    cache: Round2LogitCache,
    inventory: CanonicalRealPhoneInventory,
    blank_id: int,
    output_dir: Path,
    device: torch.device,
) -> Dict[str, Any]:
    if not train_substitutions:
        raise RuntimeError("no authorized train substitutions")
    folds = deterministic_group_folds([row["speakerId"] for row in train_rows], folds=5, seed=SEED)
    groups = word_groups(train_rows)
    neighbors = articulatory_neighbor_map(inventory)
    valid_phones = inventory.phone2profile.keys()
    window_results: Dict[str, Any] = {}
    feature_cache: Dict[Tuple[str, int, str], Dict[str, List[Dict[str, Any]]]] = {}

    for window in ("target", "neighbors", "word"):
        oof: List[Dict[str, Any]] = []
        baseline_oof: List[Dict[str, Any]] = []
        fold_reports: List[Dict[str, Any]] = []
        for fold_index, held_speakers in enumerate(folds):
            fold_train = [row for row in train_substitutions if row["speakerId"] not in held_speakers]
            fold_held = [row for row in train_substitutions if row["speakerId"] in held_speakers]
            graph = build_fold_candidate_graph(fold_train, neighbors, valid_phones)
            train_predictions, train_features = score_rows(
                fold_train, groups, cache, graph, inventory, blank_id, window
            )
            held_predictions, held_features = score_rows(
                fold_held, groups, cache, graph, inventory, blank_id, window
            )
            _, held_predictions = _calibrate_fold_predictions(train_predictions, held_predictions)
            held_baseline = score_baseline_rows(fold_held, cache, inventory)
            if [row["rowId"] for row in held_predictions] != [row["rowId"] for row in held_baseline]:
                raise RuntimeError("same-row OOF baseline alignment failed")
            for row in held_predictions:
                row["fold"] = fold_index
            oof.extend(held_predictions)
            baseline_oof.extend(held_baseline)
            feature_cache[(window, fold_index, "train")] = train_features
            feature_cache[(window, fold_index, "held")] = held_features
            fold_reports.append({
                "fold": fold_index,
                "trainSpeakers": len(set(row["speakerId"] for row in fold_train)),
                "heldSpeakers": len(held_speakers),
                "trainSubstitutions": len(fold_train),
                "oracle": candidate_oracle_coverage(fold_held, graph),
                "metrics": ranking_metrics(held_predictions),
                "selective": _oof_selective_gate(held_predictions),
                "graphHash": hashlib.sha256(json.dumps(graph, sort_keys=True).encode("utf-8")).hexdigest(),
            })
        oof.sort(key=lambda value: value["rowId"])
        baseline_oof.sort(key=lambda value: value["rowId"])
        metrics = ranking_metrics(oof)
        bootstrap = paired_bootstrap_improvement(oof, baseline_oof, resamples=2000, seed=SEED)
        window_results[window] = {
            "folds": fold_reports,
            "metrics": metrics,
            "selective": _oof_selective_gate(oof),
            "sameRowBaselineMetrics": ranking_metrics(baseline_oof),
            "sameRowBootstrap": bootstrap,
            "oofPredictions": oof,
            "baselinePredictions": baseline_oof,
        }

    selected_window = max(
        window_results,
        key=lambda name: (
            window_results[name]["metrics"]["mrr"],
            window_results[name]["metrics"]["top1"],
            window_results[name]["metrics"]["top3"],
            -list(("target", "neighbors", "word")).index(name),
        ),
    )
    selected = window_results[selected_window]
    a_gate = (
        selected["metrics"]["top1"] >= 0.05
        and selected["metrics"]["top3"] >= 0.15
        and selected["selective"]["precision"] >= 0.70
        and selected["selective"]["coverage"] >= 0.10
    )
    speaker_bootstrap = selected["sameRowBootstrap"]
    supported_gain = (
        speaker_bootstrap["speakerTop1Ci95"][0] > 0.0
        or speaker_bootstrap["speakerMrrCi95"][0] > 0.0
    )
    activate_b = not a_gate and supported_gain

    b_result: Optional[Dict[str, Any]] = None
    if activate_b:
        b_oof: List[Dict[str, Any]] = []
        fold_best_epochs: List[int] = []
        b_folds: List[Dict[str, Any]] = []
        for fold_index, held_speakers in enumerate(folds):
            fold_train = [row for row in train_substitutions if row["speakerId"] not in held_speakers]
            fold_held = [row for row in train_substitutions if row["speakerId"] in held_speakers]
            trained = train_reranker(
                fold_train,
                feature_cache[(selected_window, fold_index, "train")],
                device,
                epochs=100,
                held_rows=fold_held,
                held_features=feature_cache[(selected_window, fold_index, "held")],
            )
            train_predictions = rerank_predictions(
                trained["model"], fold_train, feature_cache[(selected_window, fold_index, "train")],
                trained["mean"], trained["scale"], device,
            )
            held_predictions = rerank_predictions(
                trained["model"], fold_held, feature_cache[(selected_window, fold_index, "held")],
                trained["mean"], trained["scale"], device,
            )
            _, held_predictions = _calibrate_fold_predictions(train_predictions, held_predictions)
            for row in held_predictions:
                row["fold"] = fold_index
            b_oof.extend(held_predictions)
            fold_best_epochs.append(int(trained["bestEpoch"]))
            b_folds.append({
                "fold": fold_index,
                "bestEpoch": trained["bestEpoch"],
                "parameterCount": trained["parameterCount"],
                "metrics": ranking_metrics(held_predictions),
                "selective": _oof_selective_gate(held_predictions),
            })
        b_oof.sort(key=lambda value: value["rowId"])
        final_epochs = max(1, int(math.floor(statistics.median(fold_best_epochs) + 0.5)))
        b_result = {
            "folds": b_folds,
            "foldBestEpochs": fold_best_epochs,
            "finalEpochCount": final_epochs,
            "metrics": ranking_metrics(b_oof),
            "selective": _oof_selective_gate(b_oof),
            "oofPredictions": b_oof,
        }

    final_candidate = "ROUND2_A" if a_gate or not activate_b else "ROUND2_B"
    cv_result = {
        "seed": SEED,
        "foldCount": 5,
        "selectedWindow": selected_window,
        "round2A": selected,
        "round2AGatePassed": a_gate,
        "supportedSameRowGain": supported_gain,
        "round2BActivated": activate_b,
        "round2B": b_result,
        "finalCandidate": final_candidate,
        "validationSelectionProhibited": True,
    }
    atomic_write_json(output_dir / "train_cv_results.json", cv_result)
    return cv_result


def fit_final_candidate(
    train_rows: Sequence[Dict[str, Any]],
    train_substitutions: Sequence[Dict[str, Any]],
    cache: Round2LogitCache,
    inventory: CanonicalRealPhoneInventory,
    blank_id: int,
    cv_result: Mapping[str, Any],
    output_dir: Path,
    device: torch.device,
) -> Dict[str, Any]:
    neighbors = articulatory_neighbor_map(inventory)
    graph = build_fold_candidate_graph(train_substitutions, neighbors, inventory.phone2profile.keys())
    groups = word_groups(train_rows)
    window = str(cv_result["selectedWindow"])
    a_predictions, features = score_rows(
        train_substitutions, groups, cache, graph, inventory, blank_id, window
    )
    final: Dict[str, Any] = {
        "graph": graph,
        "window": window,
        "finalCandidate": cv_result["finalCandidate"],
        "round2BActivated": cv_result["round2BActivated"],
        "validationSelectionProhibited": True,
    }

    if cv_result["finalCandidate"] == "ROUND2_A":
        fit_predictions = a_predictions
        final["reranker"] = None
    else:
        epoch_count = int(cv_result["round2B"]["finalEpochCount"])
        trained = train_reranker(train_substitutions, features, device, epochs=epoch_count)
        fit_predictions = rerank_predictions(
            trained["model"], train_substitutions, features, trained["mean"], trained["scale"], device
        )
        model_path = output_dir / "round2_b_final.pt"
        temporary = model_path.with_suffix(".tmp")
        torch.save({
            "stateDict": {key: value.detach().cpu() for key, value in trained["model"].state_dict().items()},
            "mean": trained["mean"],
            "scale": trained["scale"],
            "featureCount": len(trained["mean"]),
            "epochCount": epoch_count,
            "parameterCount": trained["parameterCount"],
        }, temporary)
        os.replace(temporary, model_path)
        final["reranker"] = {
            "model": trained["model"],
            "mean": trained["mean"],
            "scale": trained["scale"],
            "modelPath": str(model_path),
            "epochCount": epoch_count,
            "parameterCount": trained["parameterCount"],
        }

    margins = [float(row["margin"]) for row in fit_predictions]
    fallback = max([value for value in margins if np.isfinite(value)] or [0.0]) + 1.0
    finite_margins = [value if np.isfinite(value) else fallback for value in margins]
    correct = [int(row["rank"] == 1) for row in fit_predictions]
    calibrator = MarginConfidenceCalibrator().fit(finite_margins, correct)
    confidence = calibrator.predict(finite_margins)
    thresholds = derive_confidence_thresholds(confidence, correct)
    final["calibrator"] = calibrator
    final["confidenceFallback"] = fallback
    final["thresholds"] = thresholds
    final["trainOracle"] = candidate_oracle_coverage(train_substitutions, graph)
    final["trainMetrics"] = ranking_metrics(fit_predictions)

    freeze_record = {
        "createdBeforeValidation": True,
        "seed": SEED,
        "finalCandidate": final["finalCandidate"],
        "round2BActivated": final["round2BActivated"],
        "round2AValidationRole": "FINAL" if final["finalCandidate"] == "ROUND2_A" else "FROZEN_REFERENCE_ONLY",
        "contextWindow": window,
        "candidateGraph": graph,
        "candidateGraphSha256": hashlib.sha256(json.dumps(graph, sort_keys=True).encode("utf-8")).hexdigest(),
        "confidenceThresholds": thresholds,
        "reranker": None if final["reranker"] is None else {
            key: value for key, value in final["reranker"].items() if key not in {"model", "mean", "scale"}
        },
        "validationDecisionHierarchy": {
            "retrospectiveSelectionForbidden": True,
            "failureDecision": "FINAL_ACOUSTIC_R2_DETECTION_ONLY_DIAGNOSIS_INSUFFICIENT",
            "integrityFailureDecision": "FINAL_ACOUSTIC_R2_BLOCKED",
        },
    }
    freeze_record["freezeSha256"] = hashlib.sha256(
        json.dumps(freeze_record, sort_keys=True).encode("utf-8")
    ).hexdigest()
    atomic_write_json(output_dir / "validation_freeze_record.json", freeze_record)
    final["freezeRecord"] = freeze_record
    return final


def apply_final_confidence(
    predictions: Sequence[Dict[str, Any]], final: Mapping[str, Any]
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    margins = [float(row["margin"]) for row in predictions]
    fallback = float(final["confidenceFallback"])
    finite = [value if np.isfinite(value) else fallback for value in margins]
    confidence = final["calibrator"].predict(finite)
    enriched: List[Dict[str, Any]] = []
    for row, value in zip(predictions, confidence):
        item = dict(row)
        item["confidence"] = float(value)
        threshold = final["thresholds"].get("precision_70")
        item["candidateObservedPhoneme"] = item["predictedPhoneme"] if threshold is not None and value >= threshold else None
        item["candidateSource"] = "context_ctc" if final["finalCandidate"] == "ROUND2_A" else "context_reranker"
        item["observedPhoneme"] = None
        enriched.append(item)
    return enriched, evaluate_selective(confidence, [int(row["rank"] == 1) for row in predictions], final["thresholds"])


def evaluate_final_candidate(
    all_rows: Sequence[Dict[str, Any]],
    diagnosed_rows: Sequence[Dict[str, Any]],
    substitutions: Sequence[Dict[str, Any]],
    cache: Round2LogitCache,
    inventory: CanonicalRealPhoneInventory,
    blank_id: int,
    final: Mapping[str, Any],
    device: torch.device,
) -> Dict[str, Any]:
    groups = word_groups(all_rows)
    a_sub, sub_features = score_rows(
        substitutions, groups, cache, final["graph"], inventory, blank_id, final["window"]
    )
    a_correct_rows = [row for row in diagnosed_rows if row["humanPerceivedPhoneme"] == row["expectedPhoneme"]]
    a_correct, correct_features = score_rows(
        a_correct_rows, groups, cache, final["graph"], inventory, blank_id, final["window"]
    )
    reference = {
        "substitutionMetrics": ranking_metrics(a_sub),
        "correctPhoneMetrics": ranking_metrics(a_correct),
    }
    if final["finalCandidate"] == "ROUND2_B":
        reranker = final["reranker"]
        sub_predictions = rerank_predictions(
            reranker["model"], substitutions, sub_features, reranker["mean"], reranker["scale"], device
        )
        correct_predictions = rerank_predictions(
            reranker["model"], a_correct_rows, correct_features, reranker["mean"], reranker["scale"], device
        )
    else:
        sub_predictions, correct_predictions = a_sub, a_correct
    sub_predictions, selective = apply_final_confidence(sub_predictions, final)
    correct_predictions, correct_selective = apply_final_confidence(correct_predictions, final)
    sub_metrics = ranking_metrics(sub_predictions)
    correct_metrics = ranking_metrics(correct_predictions)
    selected70 = selective.get("precision_70", {})
    acceptance = (
        sub_metrics["top1"] >= 0.05
        and sub_metrics["top3"] >= 0.15
        and selected70.get("precision", 0.0) >= 0.70
        and selected70.get("coverage", 0.0) >= 0.10
    )
    return {
        "finalCandidate": final["finalCandidate"],
        "oracle": candidate_oracle_coverage(substitutions, final["graph"]),
        "substitutionMetrics": sub_metrics,
        "correctPhoneMetrics": correct_metrics,
        "selectiveDiagnosis": selective,
        "correctPhoneSelective": correct_selective,
        "round2AReference": reference if final["finalCandidate"] == "ROUND2_B" else None,
        "acceptanceGatePassed": acceptance,
        "substitutionPredictions": sub_predictions,
    }


def detection_error_score(
    row: Mapping[str, Any], logits: np.ndarray, graph: Mapping[str, Sequence[str]], inventory: CanonicalRealPhoneInventory
) -> float:
    start = max(0, min(int(row["startFrame"]), logits.shape[0] - 1))
    end = min(logits.shape[0], max(start + 1, int(row["endFrame"])))
    expected = str(row["expectedPhoneme"])
    target_id = inventory.phone2profile[expected].tokenId
    competitors = [
        inventory.phone2profile[phone].tokenId
        for phone in graph.get(expected, ())
        if phone != expected and phone in inventory.phone2profile
    ]
    if not competitors:
        competitors = [token for token in inventory.token_ids if token != target_id][:6]
    span = torch.from_numpy(np.asarray(logits[start:end], dtype=np.float32))
    return float(torch.logsumexp(span[:, competitors], dim=-1).mean() - span[:, target_id].mean())


def binary_detection_metrics(labels: Sequence[int], scores: Sequence[float]) -> Dict[str, Any]:
    y = np.asarray(labels, dtype=np.int8)
    s = np.asarray(scores, dtype=np.float64)
    fpr, tpr, _ = roc_curve(y, s)
    fnr = 1.0 - tpr
    index = int(np.nanargmin(np.abs(fpr - fnr)))
    return {
        "rocAuc": float(roc_auc_score(y, s)),
        "ap": float(average_precision_score(y, s)),
        "eer": float((fpr[index] + fnr[index]) / 2.0),
        "sampleCount": len(y),
        "far10": optimize_far_constrained_threshold(y, s, 0.10).to_dict(),
        "far5": optimize_far_constrained_threshold(y, s, 0.05).to_dict(),
    }


def evaluate_detector_from_cache(
    rows: Sequence[Mapping[str, Any]],
    cache: Round2LogitCache,
    graph: Mapping[str, Sequence[str]],
    inventory: CanonicalRealPhoneInventory,
) -> Dict[str, Any]:
    records = []
    for row in rows:
        if row["expectedPhoneme"] not in inventory.phone2profile:
            continue
        score = detection_error_score(row, load_logits_for_row(row, cache), graph, inventory)
        records.append({**row, "errorScore": score})
    primary = [row for row in records if row.get("primaryErrorLabel") is not None]
    sensitivity = [row for row in records if row.get("sensitivityErrorLabel") is not None]
    return {
        "records": records,
        "primary": binary_detection_metrics(
            [int(row["primaryErrorLabel"]) for row in primary], [float(row["errorScore"]) for row in primary]
        ),
        "sensitivity": binary_detection_metrics(
            [int(row["sensitivityErrorLabel"]) for row in sensitivity], [float(row["errorScore"]) for row in sensitivity]
        ),
    }


def evaluate_phone_normalization(
    train_detection: Mapping[str, Any], validation_detection: Mapping[str, Any]
) -> Dict[str, Any]:
    normalizer = PhoneRobustNormalizer(minimum_instances=30, minimum_speakers=5).fit(train_detection["records"])
    validation_primary = [row for row in validation_detection["records"] if row.get("primaryErrorLabel") is not None]
    raw = binary_detection_metrics(
        [int(row["primaryErrorLabel"]) for row in validation_primary],
        [float(row["errorScore"]) for row in validation_primary],
    )
    normalized = binary_detection_metrics(
        [int(row["primaryErrorLabel"]) for row in validation_primary],
        [normalizer.transform(str(row["expectedPhoneme"]), float(row["errorScore"])) for row in validation_primary],
    )
    return {"fitManifest": normalizer.manifest(), "raw": raw, "phoneConditionedRobust": normalized}


def checkpoint_hash_unchanged(data_dir: Path) -> bool:
    path = data_dir / "outputs/shd-2b.5/round1/checkpoint_MODEL_E_SEED1/best_adapter.safetensors"
    return sha256_file(path) == EXPECTED_MODEL_E_HASH


def evaluate_checkpoint_detector(
    candidate_id: str,
    checkpoint_path: Path,
    rows: Sequence[Mapping[str, Any]],
    graph: Mapping[str, Sequence[str]],
    inventory: CanonicalRealPhoneInventory,
    wave_root: Path,
    device: torch.device,
) -> Dict[str, Any]:
    model = Wav2Vec2ForCTC.from_pretrained(CANONICAL_MODEL_ID, revision=CANONICAL_MODEL_REVISION)
    inject_wav2vec2_lora(model, target_layers=[20, 21, 22, 23], rank=4, alpha=4.0)
    if checkpoint_path.suffix == ".safetensors":
        state = load_file(checkpoint_path, device="cpu")
    else:
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=False)
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    model.eval().to(device)
    by_utterance: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        by_utterance[str(row["utteranceId"])].append(row)
    records: List[Dict[str, Any]] = []
    started = time.perf_counter()
    with torch.inference_mode():
        for utterance_id in sorted(by_utterance):
            utterance_rows = by_utterance[utterance_id]
            first = utterance_rows[0]
            wav_path = resolve_speechocean_wav_path(wave_root, first["speakerId"], utterance_id)
            audio, _ = sf.read(wav_path)
            logits = model(torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0).to(device)).logits[0]
            array = logits.detach().cpu().numpy().astype(np.float32, copy=False)
            for row in utterance_rows:
                if row["expectedPhoneme"] in inventory.phone2profile:
                    records.append({**row, "errorScore": detection_error_score(row, array, graph, inventory)})
    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    primary = [row for row in records if row.get("primaryErrorLabel") is not None]
    return {
        "candidateId": candidate_id,
        "elapsedSec": time.perf_counter() - started,
        "primary": binary_detection_metrics(
            [int(row["primaryErrorLabel"]) for row in primary], [float(row["errorScore"]) for row in primary]
        ),
    }


def ctc_teacher_agreement(data_dir: Path, rows: Sequence[Mapping[str, Any]], cache: Round2LogitCache) -> float:
    teacher_path = data_dir / "outputs/shd-2b.5/teacher_cache/teacher_logits_fp32.pt"
    teacher = torch.load(teacher_path, map_location="cpu", weights_only=True)
    by_utterance: Dict[str, Mapping[str, Any]] = {}
    for row in rows:
        by_utterance.setdefault(str(row["utteranceId"]), row)
    agreements = []
    for utterance_id, row in by_utterance.items():
        if utterance_id not in teacher:
            continue
        logits = load_logits_for_row(row, cache)
        frozen = np.asarray(teacher[utterance_id])
        length = min(len(logits), len(frozen))
        agreements.append(float(np.mean(np.argmax(logits[:length], axis=-1) == np.argmax(frozen[:length], axis=-1))))
    del teacher
    return float(np.mean(agreements)) if agreements else 0.0
