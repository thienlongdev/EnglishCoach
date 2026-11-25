#!/usr/bin/env python3
"""Deterministic, offline SHD-2B.2A corpus calibration research pipeline."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import sys
import tarfile
import time
import urllib.request
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pronunciation.calibration_models import build_phone_stats
from app.services.pronunciation.calibration_research import (
    add_normalizations,
    assert_zero_speaker_leakage,
    bootstrap_stability,
    deterministic_speaker_partition,
    distribution_summary,
    group_phone_stats,
    map_human_phone_labels,
    primary_binary_label,
    sensitivity_binary_label,
)

MODEL_ID = "facebook/wav2vec2-lv-60-espeak-cv-ft"
MODEL_REVISION = "ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4"
SCHEMA = "shd-2b.2a-research-v1"
DATASETS = {
    "speechocean762": {
        "identifier": "OpenSLR SLR101 / SpeechOcean762",
        "url": "https://www.openslr.org/resources/101/speechocean762.tar.gz",
        "license": "CC BY 4.0", "classification": "PRODUCTION_SAFE",
        "archive": "speechocean762.tar.gz", "bytes": 520810923,
        "sha256": "876c34b828c2ebcc35ba2ff1ba5947d50e6b0162fc4a4af91db0942422b3bdd5",
        "attribution": "SpeechOcean762 contributors; preserve corpus README and CC BY 4.0 attribution.",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "annotations": "Five-rater pronunciation annotations are included in the licensed corpus.",
        "derivativeStatistics": "Permitted with attribution under CC BY 4.0.",
    },
    "librispeech-dev-clean": {
        "identifier": "OpenSLR SLR12 / LibriSpeech dev-clean",
        "url": "https://www.openslr.org/resources/12/dev-clean.tar.gz",
        "license": "CC BY 4.0", "classification": "PRODUCTION_SAFE",
        "archive": "dev-clean.tar.gz", "bytes": 337926286,
        "sha256": "76f87d090650617fca0cac8f88b9416e0ebf80350acb97b343a85fa903728ab3",
        "attribution": "LibriSpeech contributors and source LibriVox readers; preserve README attribution.",
        "redistribution": "Permitted with attribution under CC BY 4.0.",
        "annotations": "Transcripts are included; no pronunciation-error phone labels.",
        "derivativeStatistics": "Permitted with attribution under CC BY 4.0.",
    },
}
AUDITED_NOT_SELECTED = [
    {"dataset": "L2-ARCTIC v5", "classification": "RESEARCH_ONLY", "reason": "CC BY-NC; excluded from production-safe processing."},
    {"dataset": "TIMIT LDC93S1W", "classification": "REJECTED", "reason": "LDC license; excluded from this phase."},
    {"dataset": "unverified mirrors/repackagings", "classification": "REJECTED", "reason": "Provenance and license not independently verified."},
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_jsonl(path: Path, rows: Sequence[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            target = (destination / member.name).resolve()
            if root != target and root not in target.parents:
                raise ValueError(f"Unsafe archive member: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"Archive links are not accepted: {member.name}")
        bundle.extractall(destination)


def download(base: Path) -> Dict[str, Any]:
    downloads, corpora = base / "downloads", base / "corpora"
    downloads.mkdir(parents=True, exist_ok=True)
    audit = []
    for name, metadata in DATASETS.items():
        archive = downloads / metadata["archive"]
        if not archive.exists() or archive.stat().st_size != metadata["bytes"]:
            partial = archive.with_suffix(archive.suffix + ".partial")
            urllib.request.urlretrieve(metadata["url"], partial)
            os.replace(partial, archive)
        digest = sha256_file(archive)
        if metadata["sha256"] and digest != metadata["sha256"]:
            raise ValueError(f"SHA-256 mismatch for {name}")
        metadata["sha256"] = digest
        expected_root = corpora / ("speechocean762" if name == "speechocean762" else "LibriSpeech/dev-clean")
        if not expected_root.exists():
            safe_extract(archive, corpora)
        http_metadata = {"contentLength": metadata["bytes"]}
        try:
            with urllib.request.urlopen(urllib.request.Request(metadata["url"], method="HEAD"), timeout=30) as response:
                http_metadata.update({key: response.headers.get(key) for key in ("Content-Type", "Content-Length", "ETag", "Last-Modified")})
                http_metadata["finalUrl"] = response.url
        except Exception as error:
            http_metadata["headRequestError"] = str(error)
        item = {**metadata, "dataset": name, "httpMetadata": http_metadata, "byteCount": archive.stat().st_size}
        readmes = list(expected_root.glob("README*")) + list(expected_root.parent.glob("README*"))
        item["internalReadme"] = str(readmes[0]) if readmes else "not found"
        audit.append(item)
    result = {"selected": audit, "auditedNotSelected": AUDITED_NOT_SELECTED}
    atomic_json(base / "outputs/license_audit.json", result)
    return result


def kaldi_map(path: Path) -> Dict[str, str]:
    result = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            key, value = line.rstrip().split(maxsplit=1)
            result[key] = value
    return result


def speechocean_manifest(root: Path) -> List[Dict[str, Any]]:
    scores = json.loads((root / "resource/scores.json").read_text(encoding="utf-8"))
    train_text = kaldi_map(root / "train/text")
    test_text = kaldi_map(root / "test/text")
    train_spk = kaldi_map(root / "train/utt2spk")
    test_spk = kaldi_map(root / "test/utt2spk")
    train_age = kaldi_map(root / "train/spk2age")
    test_age = kaldi_map(root / "test/spk2age")
    if set(train_spk.values()) & set(test_spk.values()):
        raise ValueError("SpeechOcean official train/test speaker overlap")
    assignment = deterministic_speaker_partition(set(train_spk.values()), "speechocean762", {"calibration": 100, "validation": 25})
    rows = []
    for source, texts, speakers, ages in (("train", train_text, train_spk, train_age), ("test", test_text, test_spk, test_age)):
        for utterance_id in sorted(texts):
            speaker = speakers[utterance_id]
            age = int(float(ages[speaker]))
            rows.append({
                "schemaVersion": SCHEMA, "dataset": "speechocean762", "utteranceId": utterance_id,
                "speakerId": f"speechocean762:{speaker}", "split": "test" if source == "test" else assignment[speaker],
                "audioPath": f"speechocean762/WAVE/SPEAKER{speaker}/{utterance_id}.WAV",
                "audioSha256": sha256_file(root / f"WAVE/SPEAKER{speaker}/{utterance_id}.WAV"),
                "referenceText": texts[utterance_id], "sourceSplit": source,
                "speakerGroup": "child" if age < 18 else "adult", "corpusAge": age,
                "humanWords": scores[utterance_id]["words"],
            })
    return rows


def librispeech_manifest(root: Path) -> List[Dict[str, Any]]:
    audio_files = sorted(root.rglob("*.flac"))
    speakers = {audio.stem.split("-")[0] for audio in audio_files}
    assignment = deterministic_speaker_partition(speakers, "librispeech-dev-clean", {"calibration": 28, "validation": 6, "test": 6})
    transcripts: Dict[str, str] = {}
    for path in root.rglob("*.trans.txt"):
        transcripts.update(kaldi_map(path))
    rows = []
    for audio in audio_files:
        utterance_id = audio.stem
        speaker = utterance_id.split("-")[0]
        rows.append({
            "schemaVersion": SCHEMA, "dataset": "librispeech-dev-clean", "utteranceId": utterance_id,
            "speakerId": f"librispeech-dev-clean:{speaker}", "split": assignment[speaker],
            "audioPath": f"LibriSpeech/dev-clean/{audio.relative_to(root).as_posix()}",
            "audioSha256": sha256_file(audio), "referenceText": transcripts[utterance_id],
            "sourceSplit": "dev-clean", "speakerGroup": None, "corpusAge": None, "humanWords": None,
        })
    return rows


def manifest(base: Path) -> Dict[str, Any]:
    rows = speechocean_manifest(base / "corpora/speechocean762") + librispeech_manifest(base / "corpora/LibriSpeech/dev-clean")
    rows.sort(key=lambda row: (row["dataset"], row["utteranceId"]))
    keys = [(row["dataset"], row["utteranceId"]) for row in rows]
    if len(keys) != len(set(keys)) or len(rows) != 7703:
        raise ValueError(f"Expected 7,703 unique utterances; found {len(rows)}")
    assert_zero_speaker_leakage(rows)
    out = base / "outputs/manifest.jsonl"
    write_jsonl(out, rows)
    fingerprint = sha256_file(out)
    splits = Counter((row["dataset"], row["split"]) for row in rows)
    summary = {"schemaVersion": SCHEMA, "utteranceCount": len(rows), "sha256": fingerprint,
               "splitUtterances": {f"{d}:{s}": n for (d, s), n in sorted(splits.items())},
               "speakerCounts": {d: len({r['speakerId'] for r in rows if r['dataset'] == d}) for d in DATASETS}}
    atomic_json(base / "outputs/manifest_summary.json", summary)
    return summary


def flatten(row: Dict[str, Any], assessment: Dict[str, Any]) -> List[Dict[str, Any]]:
    output = []
    human_words = row.get("humanWords") or []
    word_mapping = map_word_indices(human_words, assessment["words"]) if human_words else {}
    for word in assessment["words"]:
        phones = word["phonemes"]
        mapped: List[Optional[float]] = [None] * len(phones)
        human_word_accuracy = None
        human_index = word_mapping.get(word["index"])
        if human_index is not None:
            human = human_words[human_index]
            human_word_accuracy = human.get("accuracy")
            mapped = map_human_phone_labels(human.get("phones", []), human.get("phones-accuracy", []), [p["expectedPhoneme"] for p in phones])
        for phone, human_score in zip(phones, mapped):
            output.append({
                "schemaVersion": SCHEMA, "dataset": row["dataset"], "utteranceId": row["utteranceId"],
                "speakerId": row["speakerId"], "split": row["split"], "sourceSplit": row["sourceSplit"],
                "speakerGroup": row["speakerGroup"], "wordIndex": word["index"], "expectedWord": word["expectedWord"],
                "selectedVariant": word["selectedVariant"], "variantSource": word["variantSource"],
                "phoneIndex": phone["index"], "expectedPhoneme": phone["expectedPhoneme"],
                "observedPhoneme": None, "calibratedScore": None, "rawGop": phone["rawGop"],
                "startFrame": phone["startFrame"], "endFrame": phone["endFrame"], "durationMs": phone["durationMs"],
                "meanTargetLogProb": phone["meanTargetLogProb"], "meanTargetPosterior": phone["meanTargetPosterior"],
                "strongestCompetitor": phone["strongestCompetitor"],
                "strongestCompetitorMeanLogProb": phone["strongestCompetitorMeanLogProb"],
                "competitorFrameShare": phone["competitorFrameShare"], "candidatePhonemes": phone["candidatePhonemes"],
                "pathNormalizedLogLikelihood": assessment["alignmentQuality"].get("pathNormalizedLogLikelihood"),
                "meanPhonemeLogLikelihood": assessment["alignmentQuality"].get("meanPhonemeLogLikelihood"),
                "blankRatio": assessment["alignmentQuality"].get("blankRatio"),
                "phonemeCoverage": assessment["alignmentQuality"].get("phonemeCoverage"),
                "humanPhoneAccuracy": human_score, "primaryErrorLabel": primary_binary_label(human_score),
                "sensitivityErrorLabel": sensitivity_binary_label(human_score), "humanWordAccuracy": human_word_accuracy,
                "humanWordMappingStatus": "UNAMBIGUOUS" if human_index is not None else "UNMAPPED_OR_AMBIGUOUS",
                "modelId": MODEL_ID, "manifestAudioSha256": row["audioSha256"],
            })
    return output


def _word_key(value: str) -> str:
    return re.sub(r"[^a-z0-9']", "", value.lower().replace("’", "'"))


def map_word_indices(human_words: Sequence[Dict[str, Any]], engine_words: Sequence[Dict[str, Any]]) -> Dict[int, int]:
    """Unique minimum-edit word alignment; ambiguous paths attach no labels."""
    source = [_word_key(str(w.get("text", ""))) for w in human_words]
    target = [_word_key(str(w.get("expectedWord", ""))) for w in engine_words]
    n, m = len(source), len(target)
    cost = np.full((n + 1, m + 1), np.inf)
    ways = np.zeros((n + 1, m + 1), dtype=np.int64)
    back: Dict[Tuple[int, int], Tuple[int, int, str]] = {}
    cost[0, 0], ways[0, 0] = 0, 1
    for i in range(n + 1):
        for j in range(m + 1):
            if not np.isfinite(cost[i, j]):
                continue
            moves = []
            if i < n and j < m:
                moves.append((i + 1, j + 1, 0 if source[i] == target[j] else 2, "match"))
            if i < n: moves.append((i + 1, j, 1, "delete"))
            if j < m: moves.append((i, j + 1, 1, "insert"))
            for ni, nj, delta, kind in moves:
                candidate = cost[i, j] + delta
                if candidate < cost[ni, nj]:
                    cost[ni, nj], ways[ni, nj], back[(ni, nj)] = candidate, ways[i, j], (i, j, kind)
                elif candidate == cost[ni, nj]:
                    ways[ni, nj] += ways[i, j]
    if ways[n, m] != 1:
        return {}
    mapped = {}
    i, j = n, m
    while i or j:
        pi, pj, kind = back[(i, j)]
        if kind == "match" and source[pi] == target[pj]:
            mapped[pj] = pi
        i, j = pi, pj
    return mapped


def comparable(left: Sequence[Dict[str, Any]], right: Sequence[Dict[str, Any]], tolerance: float = 1e-4) -> bool:
    if len(left) != len(right):
        return False
    for a, b in zip(left, right):
        if len(a["words"]) != len(b["words"]):
            return False
        for aw, bw in zip(a["words"], b["words"]):
            if aw["selectedVariant"] != bw["selectedVariant"]:
                return False
            if len(aw["phonemes"]) != len(bw["phonemes"]):
                return False
            for ap, bp in zip(aw["phonemes"], bw["phonemes"]):
                if ap.get("expectedPhoneme") != bp.get("expectedPhoneme"):
                    return False
                if (ap["startFrame"], ap["endFrame"]) != (bp["startFrame"], bp["endFrame"]):
                    return False
                if ap["rawGop"] is not None and abs(ap["rawGop"] - bp["rawGop"]) > tolerance:
                    return False
                if [c.get("phoneme") for c in ap.get("candidatePhonemes", [])] != [
                    c.get("phoneme") for c in bp.get("candidatePhonemes", [])
                ]:
                    return False
    return True


def completed_utterance_keys(rows: Sequence[Dict[str, Any]]) -> set[Tuple[str, str]]:
    provenance: Dict[Tuple[str, str], Tuple[Any, Any]] = {}
    for row in rows:
        key = (row["dataset"], row["utteranceId"])
        signature = (row.get("modelId"), row.get("manifestAudioSha256"))
        if key in provenance and provenance[key] != signature:
            raise ValueError(f"Conflicting duplicate inference rows for {key}")
        provenance[key] = signature
    return set(provenance)


def infer(base: Path, requested_batch_size: int = 4, fallback_from: Optional[int] = None,
          inherited_fallback_reason: Optional[str] = None) -> Dict[str, Any]:
    from app.services.pronunciation.acoustic_engine import LocalAcousticEngine
    manifest_rows = read_jsonl(base / "outputs/manifest.jsonl")
    output_path = base / "outputs/phone_instances.jsonl"
    checkpoint_path = base / "checkpoints/inference.json"
    existing = read_jsonl(output_path)
    completed = completed_utterance_keys(existing)
    engine = LocalAcousticEngine(model_id=MODEL_ID)
    validation_rows = [row for row in manifest_rows if (row["dataset"], row["utteranceId"]) not in completed][:8]
    samples = [(base.joinpath("corpora", row["audioPath"]).read_bytes(), row["referenceText"]) for row in validation_rows]
    fallback_reason = inherited_fallback_reason
    batch_size = requested_batch_size
    if samples and requested_batch_size > 1:
        try:
            single = [engine.assess_pronunciation(audio, text) for audio, text in samples]
            batched = engine.assess_pronunciation_batch(samples)
            if not comparable(single, batched):
                batch_size, fallback_reason = 1, "batch validation mismatch"
        except RuntimeError as error:
            if "out of memory" not in str(error).lower():
                raise
            batch_size, fallback_reason = 1, "CUDA out of memory during batch validation"
    pending = [row for row in manifest_rows if (row["dataset"], row["utteranceId"]) not in completed]
    start = time.perf_counter()
    failures = []
    rows = list(existing)
    audio_seconds = 0.0
    for offset in range(0, len(pending), batch_size):
        chunk = pending[offset:offset + batch_size]
        inputs = [(base.joinpath("corpora", row["audioPath"]).read_bytes(), row["referenceText"]) for row in chunk]
        try:
            assessments = engine.assess_pronunciation_batch(inputs) if batch_size > 1 else [engine.assess_pronunciation(*inputs[0])]
            for source, assessment in zip(chunk, assessments):
                rows.extend(flatten(source, assessment))
                audio_seconds += assessment["audioMetadata"]["durationMs"] / 1000
        except RuntimeError as error:
            if batch_size > 1 and "out of memory" in str(error).lower():
                fallback_reason, batch_size = "CUDA out of memory during inference", 1
                return infer(base, 1, requested_batch_size, fallback_reason)
            failures.extend({"dataset": r["dataset"], "utteranceId": r["utteranceId"], "error": str(error)} for r in chunk)
        if (offset // max(batch_size, 1)) % 125 == 0:
            write_jsonl(output_path, sorted(rows, key=lambda r: (r["dataset"], r["utteranceId"], r["wordIndex"], r["phoneIndex"])))
            atomic_json(checkpoint_path, {"processedUtterances": len(completed) + offset + len(chunk), "failures": failures})
    rows.sort(key=lambda r: (r["dataset"], r["utteranceId"], r["wordIndex"], r["phoneIndex"]))
    write_jsonl(output_path, rows)
    elapsed = time.perf_counter() - start
    result = {"utterances": len({(r['dataset'], r['utteranceId']) for r in rows}), "phoneInstances": len(rows),
              "failures": failures, "requestedBatchSize": fallback_from or requested_batch_size, "effectiveBatchSize": batch_size,
              "fallbackReason": fallback_reason, "wallSeconds": elapsed, "audioSeconds": audio_seconds,
              "throughputUtterancesPerSecond": len(pending) / elapsed if elapsed else None,
              "realTimeFactor": elapsed / audio_seconds if audio_seconds else None,
              "vram": engine.get_vram_telemetry(), "outputSha256": sha256_file(output_path)}
    atomic_json(base / "outputs/performance.json", result)
    return result


def metric(rows: Sequence[Dict[str, Any]], label: str) -> Dict[str, Any]:
    selected = [r for r in rows if r.get(label) is not None and r.get("rawGop") is not None]
    counts = Counter(int(r[label]) for r in selected)
    speakers = len({r["speakerId"] for r in selected})
    result = {"count": len(selected), "errorPositive": counts[1], "correctNegative": counts[0], "speakerCount": speakers,
              "adequatePowerRule": ">=20 examples per class and >=5 speakers"}
    if counts[0] < 20 or counts[1] < 20 or speakers < 5:
        return {**result, "status": "UNAVAILABLE_OR_UNDERPOWERED"}
    from sklearn.metrics import average_precision_score, roc_auc_score
    y = np.asarray([int(r[label]) for r in selected])
    score = -np.asarray([float(r["rawGop"]) for r in selected])
    return {**result, "status": "AVAILABLE", "rocAuc": float(roc_auc_score(y, score)), "prAuc": float(average_precision_score(y, score))}


def supervised(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    speech = [r for r in rows if r["dataset"] == "speechocean762"]
    by_phone: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in speech:
        by_phone[row["expectedPhoneme"]].append(row)
    mapped = [r for r in speech if r.get("humanPhoneAccuracy") is not None and r.get("rawGop") is not None]
    from scipy.stats import pearsonr, spearmanr
    continuous = {"count": len(mapped), "pearson": None, "spearman": None}
    if len(mapped) > 2:
        raw = [r["rawGop"] for r in mapped]
        human = [r["humanPhoneAccuracy"] for r in mapped]
        continuous.update(pearson=float(pearsonr(raw, human).statistic), spearman=float(spearmanr(raw, human).statistic))
    return {
        "policy": {"primary": "<0.5 error vs ==2.0 confidently correct; [0.5,2.0) excluded", "sensitivity": "<2.0 error vs ==2.0", "continuousScorePreserved": True},
        "unmappedPhoneLabels": sum(r["humanPhoneAccuracy"] is None for r in speech),
        "excludedIntermediatePrimary": sum(r["humanPhoneAccuracy"] is not None and .5 <= r["humanPhoneAccuracy"] < 2 for r in speech),
        "continuousLabelCorrelation": continuous,
        "overall": {"primary": metric(speech, "primaryErrorLabel"), "sensitivity": metric(speech, "sensitivityErrorLabel")},
        "perPhone": {p: {"primary": metric(rs, "primaryErrorLabel"), "sensitivity": metric(rs, "sensitivityErrorLabel")} for p, rs in sorted(by_phone.items())},
        "experimentalCalibrators": {
            "primary": fit_calibrators(speech, "primaryErrorLabel"),
            "sensitivity": fit_calibrators(speech, "sensitivityErrorLabel"),
        },
        "continuousRegression": fit_continuous_regression(speech),
    }


def _evaluate_probabilities(y: np.ndarray, probability: np.ndarray, threshold: float = .5) -> Dict[str, Any]:
    from sklearn.metrics import average_precision_score, confusion_matrix, roc_auc_score, roc_curve
    if len(set(y.tolist())) < 2:
        return {"status": "UNAVAILABLE"}
    fpr, tpr, thresholds = roc_curve(y, probability)
    fnr = 1 - tpr
    eer_index = int(np.nanargmin(np.abs(fpr - fnr)))
    tn, fp, fn, tp = confusion_matrix(y, probability >= threshold, labels=[0, 1]).ravel()
    return {"status": "AVAILABLE", "rocAuc": float(roc_auc_score(y, probability)),
            "prAuc": float(average_precision_score(y, probability)),
            "eer": float((fpr[eer_index] + fnr[eer_index]) / 2),
            "confusionAtThreshold": {"threshold": float(threshold), "tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}


def fit_calibrators(rows: Sequence[Dict[str, Any]], label: str) -> Dict[str, Any]:
    """Fit on calibration speakers, select on validation, evaluate held-out test once."""
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    groups: Dict[str, List[Dict[str, Any]]] = {"ALL": list(rows)}
    for phone in sorted({r["expectedPhoneme"] for r in rows}):
        groups[phone] = [r for r in rows if r["expectedPhoneme"] == phone]
    report = {}
    for phone, phone_rows in groups.items():
        split_rows = {split: [r for r in phone_rows if r["split"] == split and r.get(label) is not None and r.get("rawGop") is not None]
                      for split in ("calibration", "validation", "test")}
        class_counts = {s: dict(Counter(int(r[label]) for r in rs)) for s, rs in split_rows.items()}
        sufficiently_powered = True
        for split in split_rows:
            split_counts = Counter(int(r[label]) for r in split_rows[split])
            sufficiently_powered &= (len(split_counts) == 2 and min(split_counts.values()) >= 5 and
                                      len({r["speakerId"] for r in split_rows[split]}) >= 5)
        if not sufficiently_powered:
            report[phone] = {"status": "UNAVAILABLE_OR_UNDERPOWERED", "classCounts": class_counts}
            continue
        x_train = np.asarray([[r["rawGop"]] for r in split_rows["calibration"]], dtype=float)
        y_train = np.asarray([r[label] for r in split_rows["calibration"]], dtype=int)
        logistic = LogisticRegression(random_state=20260830).fit(x_train, y_train)
        isotonic = IsotonicRegression(increasing=False, out_of_bounds="clip").fit(x_train[:, 0], y_train)
        models = {
            "logistic": lambda rs: logistic.predict_proba(np.asarray([[r["rawGop"]] for r in rs]))[:, 1],
            "isotonic": lambda rs: isotonic.predict(np.asarray([r["rawGop"] for r in rs])),
        }
        validation = {}
        for name, predict in models.items():
            y_val = np.asarray([r[label] for r in split_rows["validation"]], dtype=int)
            validation[name] = _evaluate_probabilities(y_val, predict(split_rows["validation"]))
        selected = max(models, key=lambda name: validation[name].get("rocAuc", -1))
        val_probability = models[selected](split_rows["validation"])
        y_val = np.asarray([r[label] for r in split_rows["validation"]], dtype=int)
        from sklearn.metrics import roc_curve
        fpr, tpr, thresholds = roc_curve(y_val, val_probability)
        threshold = float(thresholds[int(np.argmax(tpr - fpr))])
        y_test = np.asarray([r[label] for r in split_rows["test"]], dtype=int)
        report[phone] = {"status": "AVAILABLE", "classCounts": class_counts, "validation": validation,
                         "selectedOnValidation": selected, "thresholdSelection": "maximum validation Youden J",
                         "heldOutTest": _evaluate_probabilities(y_test, models[selected](split_rows["test"]), float(threshold))}
    return report


def fit_continuous_regression(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LinearRegression
    from sklearn.metrics import mean_absolute_error, r2_score
    groups = {"ALL": list(rows)}
    for phone in sorted({r["expectedPhoneme"] for r in rows}):
        groups[phone] = [r for r in rows if r["expectedPhoneme"] == phone]
    report = {}
    for phone, phone_rows in groups.items():
        splits = {s: [r for r in phone_rows if r["split"] == s and r.get("humanPhoneAccuracy") is not None and r.get("rawGop") is not None]
                  for s in ("calibration", "validation", "test")}
        if min(map(len, splits.values()), default=0) < 20 or any(len({r["speakerId"] for r in splits[s]}) < 5 for s in splits):
            report[phone] = {"status": "UNAVAILABLE_OR_UNDERPOWERED", "counts": {s: len(rs) for s, rs in splits.items()}}
            continue
        x_cal = np.asarray([[r["rawGop"]] for r in splits["calibration"]]); y_cal = np.asarray([r["humanPhoneAccuracy"] for r in splits["calibration"]])
        linear = LinearRegression().fit(x_cal, y_cal)
        isotonic = IsotonicRegression(increasing=True, out_of_bounds="clip").fit(x_cal[:, 0], y_cal)
        predict = {"linear": lambda rs: linear.predict(np.asarray([[r["rawGop"]] for r in rs])),
                   "isotonic": lambda rs: isotonic.predict(np.asarray([r["rawGop"] for r in rs]))}
        validation = {}
        y_val = np.asarray([r["humanPhoneAccuracy"] for r in splits["validation"]])
        for name, fn in predict.items():
            estimate = fn(splits["validation"])
            validation[name] = {"r2": float(r2_score(y_val, estimate)), "mae": float(mean_absolute_error(y_val, estimate))}
        selected = max(validation, key=lambda name: validation[name]["r2"])
        y_test = np.asarray([r["humanPhoneAccuracy"] for r in splits["test"]]); test_estimate = predict[selected](splits["test"])
        report[phone] = {"status": "AVAILABLE", "counts": {s: len(rs) for s, rs in splits.items()},
                         "selectedOnValidation": selected, "validation": validation,
                         "heldOutTest": {"r2": float(r2_score(y_test, test_estimate)), "mae": float(mean_absolute_error(y_test, test_estimate))}}
    return report


def normalization_report(rows: Sequence[Dict[str, Any]], stats: Dict[str, Any],
                         reference_rows: Optional[Sequence[Dict[str, Any]]] = None) -> Dict[str, Any]:
    normalized = []
    values_by_phone = defaultdict(list)
    for row in (reference_rows if reference_rows is not None else rows):
        if row.get("rawGop") is not None:
            values_by_phone[row["expectedPhoneme"]].append(float(row["rawGop"]))
    for row in rows:
        phone = row["expectedPhoneme"]
        if row.get("rawGop") is not None and phone in stats:
            normalized.append(add_normalizations(row, stats[phone], sorted(values_by_phone[phone])))
    return {
        "standardZ": distribution_summary([r["experimentalStandardZ"] for r in normalized if r["experimentalStandardZ"] is not None]),
        "robustZ": distribution_summary([r["experimentalRobustZ"] for r in normalized if r["experimentalRobustZ"] is not None]),
        "empiricalCdf": distribution_summary([r["experimentalEmpiricalCdf"] for r in normalized if r["experimentalEmpiricalCdf"] is not None]),
    }


def global_miscentering(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    valid = [r for r in rows if r.get("rawGop") is not None]
    global_stats = build_phone_stats("ALL", [r["rawGop"] for r in valid], len({r["speakerId"] for r in valid}), "pooledDiagnostic")
    per_phone = defaultdict(list)
    for row in valid:
        per_phone[row["expectedPhoneme"]].append(float(row["rawGop"]))
    return {"globalStats": global_stats.to_dict(),
            "phoneMedianGlobalZ": {phone: (float(np.median(values)) - global_stats.rawMean) / global_stats.rawStd
                                   for phone, values in sorted(per_phone.items()) if global_stats.rawStd}}


def group_audit(rows: Sequence[Dict[str, Any]], group: Optional[str], reference_stats: Dict[str, Any],
                reference_rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    selected = [r for r in rows if r["dataset"] == "speechocean762" and (group is None or r["speakerGroup"] == group)]
    per_phone = defaultdict(list)
    for row in selected:
        per_phone[row["expectedPhoneme"]].append(row)
    calibration = [r for r in selected if r["split"] == "calibration" and r.get("rawGop") is not None]
    return {"phoneInstances": len(selected), "speakers": len({r["speakerId"] for r in selected}),
            "rawGop": distribution_summary([r["rawGop"] for r in selected if r["rawGop"] is not None]),
            "phoneSpecificNormalizationBehavior": normalization_report(calibration, reference_stats, reference_rows),
            "normalizationReference": "all SpeechOcean calibration phones with human accuracy == 2.0",
            "mappingCount": sum(r["humanPhoneAccuracy"] is not None for r in selected),
            "primary": metric(selected, "primaryErrorLabel"), "sensitivity": metric(selected, "sensitivityErrorLabel"),
            "heldOutTest": {"primary": metric([r for r in selected if r["split"] == "test"], "primaryErrorLabel"),
                            "sensitivity": metric([r for r in selected if r["split"] == "test"], "sensitivityErrorLabel")},
            "perPhone": {p: {"samples": len(rs), "speakers": len({r['speakerId'] for r in rs}),
                              "rawGop": distribution_summary([r["rawGop"] for r in rs if r["rawGop"] is not None]),
                              "primary": metric(rs, "primaryErrorLabel"), "sensitivity": metric(rs, "sensitivityErrorLabel"),
                              "heldOutTestPrimary": metric([r for r in rs if r["split"] == "test"], "primaryErrorLabel"),
                              "heldOutTestSensitivity": metric([r for r in rs if r["split"] == "test"], "sensitivityErrorLabel")}
                         for p, rs in sorted(per_phone.items())}}


def word_aggregation(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    grouped = defaultdict(list)
    labels = {}
    for row in rows:
        if row["dataset"] == "speechocean762" and row.get("rawGop") is not None and row.get("humanWordAccuracy") is not None:
            key = (row["speakerId"], row["utteranceId"], row["wordIndex"], row["split"])
            grouped[key].append(row)
            labels[key] = float(row["humanWordAccuracy"])
    methods = defaultdict(list)
    targets = []
    for key, phones in grouped.items():
        values = np.asarray([p["rawGop"] for p in phones], dtype=float)
        durations = np.asarray([p["durationMs"] or 0 for p in phones], dtype=float)
        trim = np.sort(values)[int(.1 * len(values)):max(int(.9 * len(values)), int(.1 * len(values)) + 1)]
        methods["mean"].append(float(values.mean())); methods["median"].append(float(np.median(values)))
        methods["minimum"].append(float(values.min())); methods["lowerQuartile"].append(float(np.percentile(values, 25)))
        methods["trimmedMean10"].append(float(trim.mean()))
        methods["durationWeightedMean"].append(float(np.average(values, weights=durations)) if durations.sum() else float(values.mean()))
        targets.append(labels[key])
    from scipy.stats import spearmanr
    result = {}
    for name, values in methods.items():
        coefficient = float(spearmanr(values, targets).statistic)
        result[name] = {"wordCount": len(values), "spearmanWithHumanWordAccuracy": coefficient if np.isfinite(coefficient) else None}
    return result


def analyze(base: Path) -> Dict[str, Any]:
    rows = read_jsonl(base / "outputs/phone_instances.jsonl")
    if not rows:
        raise ValueError("No real inference rows are available")
    libri_cal = [r for r in rows if r["dataset"] == "librispeech-dev-clean" and r["split"] == "calibration"]
    speech_correct = [r for r in rows if r["dataset"] == "speechocean762" and r["split"] == "calibration" and r["humanPhoneAccuracy"] == 2.0]
    pooled = libri_cal + speech_correct
    distributions = {}
    for name, selected in (("librispeechCalibration", libri_cal), ("speechOceanPerfectCalibration", speech_correct), ("pooledDiagnostic", pooled)):
        stats = group_phone_stats(selected, name)
        distributions[name] = {p: s.to_dict() for p, s in stats.items()}
    pooled_stats = group_phone_stats(pooled, "pooledDiagnostic")
    speech_rows = [r for r in rows if r["dataset"] == "speechocean762"]
    supervised_result = supervised(rows)
    report = {
        "schemaVersion": SCHEMA, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION,
        "phoneRows": len(rows), "utterances": len({(r['dataset'], r['utteranceId']) for r in rows}),
        "phoneDistributions": distributions, "normalizations": normalization_report(pooled, pooled_stats),
        "globalNormalizationMiscentering": global_miscentering(pooled),
        "supervised": supervised_result,
        "childAdultAudit": {"all": group_audit(rows, None, group_phone_stats(speech_correct, "speechOceanPerfectCalibration"), speech_correct),
                            "adult": group_audit(rows, "adult", group_phone_stats(speech_correct, "speechOceanPerfectCalibration"), speech_correct),
                            "child": group_audit(rows, "child", group_phone_stats(speech_correct, "speechOceanPerfectCalibration"), speech_correct)},
        "alignmentQuality": {"rawGop": distribution_summary([r["rawGop"] for r in rows if r["rawGop"] is not None]),
                             "pathNormalizedLogLikelihood": distribution_summary([r["pathNormalizedLogLikelihood"] for r in rows if r["pathNormalizedLogLikelihood"] is not None]),
                             "meanPhonemeLogLikelihood": distribution_summary([r["meanPhonemeLogLikelihood"] for r in rows if r["meanPhonemeLogLikelihood"] is not None]),
                             "blankRatio": distribution_summary([r["blankRatio"] for r in rows if r["blankRatio"] is not None]),
                             "phonemeCoverage": distribution_summary([r["phonemeCoverage"] for r in rows if r["phonemeCoverage"] is not None])},
        "alignmentCorrelations": alignment_correlations(rows),
        "bootstrap": bootstrap_stability(pooled),
        "wordAggregation": word_aggregation(speech_rows),
        "speakerVariation": speaker_variation(rows),
        "channelVariation": {**{d: distribution_summary([r["rawGop"] for r in rows if r["dataset"] == d and r["rawGop"] is not None]) for d in DATASETS},
                             "browserControlledRecordings": browser_distribution()},
        "production": {"calibratedScore": None, "observedPhoneme": None, "frontendOrApiScoreExposed": False},
    }
    atomic_json(base / "outputs/analysis.json", report)
    with (base / "outputs/phone_coverage.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle); writer.writerow(["dataset", "split", "phone", "samples", "speakers"])
        keys = sorted({(r["dataset"], r["split"], r["expectedPhoneme"]) for r in rows})
        for dataset, split, phone in keys:
            selected = [r for r in rows if (r["dataset"], r["split"], r["expectedPhoneme"]) == (dataset, split, phone)]
            writer.writerow([dataset, split, phone, len(selected), len({r["speakerId"] for r in selected})])
    return report


def alignment_correlations(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    from scipy.stats import spearmanr
    def correlation(pairs: Sequence[Tuple[float, float]]) -> Optional[float]:
        if len(pairs) <= 2:
            return None
        value = float(spearmanr(*zip(*pairs)).statistic)
        return value if np.isfinite(value) else None
    result = {}
    for field in ("pathNormalizedLogLikelihood", "meanPhonemeLogLikelihood", "blankRatio", "phonemeCoverage"):
        raw_pairs = [(r[field], r["rawGop"]) for r in rows if r.get(field) is not None and r.get("rawGop") is not None]
        human_pairs = [(r[field], r["humanPhoneAccuracy"]) for r in rows if r.get(field) is not None and r.get("humanPhoneAccuracy") is not None]
        result[field] = {
            "rawGopSpearman": correlation(raw_pairs),
            "humanAccuracySpearman": correlation(human_pairs),
            "rawPairCount": len(raw_pairs), "humanPairCount": len(human_pairs),
        }
    return result


def browser_distribution() -> Dict[str, Any]:
    benchmark = Path(__file__).parent / "benchmark_results.json"
    if not benchmark.exists():
        return {"status": "UNAVAILABLE"}
    raw = json.loads(benchmark.read_text(encoding="utf-8"))["models"][MODEL_ID]["cases"]
    values = [p["rawGop"] for name in ("case_a", "case_b", "case_c", "case_e")
              for word in raw[name]["assessment"]["words"] for p in word["phonemes"] if p["rawGop"] is not None]
    return {**distribution_summary(values), "interpretation": "Corpus/channel-associated diagnostic only; no causal demographic or microphone claim."}


def speaker_variation(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    valid = [r for r in rows if r.get("rawGop") is not None]
    speaker_means = defaultdict(list)
    for row in valid:
        speaker_means[row["speakerId"]].append(float(row["rawGop"]))
    means = [float(np.mean(v)) for v in speaker_means.values()]
    within = [float(np.std(v)) for v in speaker_means.values()]
    return {"speakerCount": len(means), "betweenSpeakerStdOfMeans": float(np.std(means)), "medianWithinSpeakerStd": float(np.median(within))}


def sanity(base: Path) -> Dict[str, Any]:
    benchmark = Path(__file__).parent / "benchmark_results.json"
    if not benchmark.exists():
        result = {case: {"status": "UNAVAILABLE", "reason": "browser benchmark artifact absent"} for case in "ABCE"}
    else:
        raw = json.loads(benchmark.read_text(encoding="utf-8"))
        model = raw["models"][MODEL_ID]
        cases = model["cases"]
        corpus_rows = read_jsonl(base / "outputs/phone_instances.jsonl")
        nominal = [r for r in corpus_rows if r["split"] == "calibration" and
                   (r["dataset"] == "librispeech-dev-clean" or (r["dataset"] == "speechocean762" and r["humanPhoneAccuracy"] == 2.0))]
        stats = group_phone_stats(nominal, "pooledDiagnostic")
        values = defaultdict(list)
        for row in nominal:
            if row.get("rawGop") is not None:
                values[row["expectedPhoneme"]].append(float(row["rawGop"]))
        summarized = {}
        for case_name in ("case_a", "case_b", "case_c", "case_e"):
            assessment = cases[case_name]["assessment"]
            phone_rows = []
            for word in assessment["words"]:
                for phone in word["phonemes"]:
                    item = {"word": word["expectedWord"], "phone": phone["expectedPhoneme"], "rawGop": phone["rawGop"]}
                    if phone["rawGop"] is not None and phone["expectedPhoneme"] in stats:
                        enriched = add_normalizations({"rawGop": phone["rawGop"]}, stats[phone["expectedPhoneme"]], sorted(values[phone["expectedPhoneme"]]))
                        item.update({k: v for k, v in enriched.items() if k.startswith("experimental")})
                    phone_rows.append(item)
            summarized[case_name] = {"utteranceMeanRawGop": assessment["acousticEvidence"]["utteranceMeanRawGop"], "phones": phone_rows}
        def word_mean(case_name: str, word: str) -> Optional[float]:
            target = next((w for w in cases[case_name]["assessment"]["words"] if w["expectedWord"] == word), None)
            return target["diagnosticAggregates"]["meanRawGop"] if target else None
        vowel_evidence = model["errorSensitivity"]["vowelSubstitutionCaseADegradeToC"]
        a_word, b_word = word_mean("case_a", "screamed"), word_mean("case_b", "screamed")
        a_vowel = vowel_evidence["caseATargetEvidence"]["rawGop"]
        c_vowel = vowel_evidence["caseCTargetEvidence"]["rawGop"]
        result = {"status": "EXCLUDED_REGRESSION_ONLY", "source": str(benchmark), "cases": summarized,
                  "checks": {"caseBWorseThanAAtTargetWord": b_word < a_word,
                             "caseCWorseThanAAtVowel": c_vowel < a_vowel,
                             "caseEIndependentVariationNotTuned": True},
                  "rawComparisons": {"caseAScreamed": a_word, "caseBScreamed": b_word, "caseAIy": a_vowel, "caseCIy": c_vowel}}
    atomic_json(base / "outputs/browser_sanity.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["download", "manifest", "infer", "analyze", "sanity", "all"])
    parser.add_argument("--base", type=Path, default=Path(__file__).parent / "calibration_data")
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()
    actions = {"download": lambda: download(args.base), "manifest": lambda: manifest(args.base),
               "infer": lambda: infer(args.base, args.batch_size), "analyze": lambda: analyze(args.base),
               "sanity": lambda: sanity(args.base)}
    if args.command == "all":
        result = {name: actions[name]() for name in ("download", "manifest", "infer", "analyze", "sanity")}
    else:
        result = actions[args.command]()
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
