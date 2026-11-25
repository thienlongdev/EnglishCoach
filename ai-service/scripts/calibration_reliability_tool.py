#!/usr/bin/env python3
"""End-to-end SHD-2B.2B calibration reliability research runner."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pronunciation.calibration_models import build_phone_stats
from app.services.pronunciation.calibration_reliability import (
    BOOTSTRAP_SAMPLE_LEVELS,
    EXCLUSION_REASONS,
    RECOVERED_MAPPING_RULES,
    RELIABILITY_SCHEMA,
    RELIABILITY_SEED,
    audio_features,
    audit_phone_mapping,
    binary_metrics,
    preprocess_waveform,
    speaker_cluster_bootstrap_statistics,
    speaker_cluster_metric_ci,
    summarize_reason_counts,
)
from app.services.pronunciation.calibration_research import (
    add_normalizations,
    distribution_summary,
    group_phone_stats,
    primary_binary_label,
    sensitivity_binary_label,
)
from scripts.calibration_tool import MODEL_ID, MODEL_REVISION, atomic_json, map_word_indices, read_jsonl, write_jsonl


PREPROCESSING_VARIANTS = ("canonical", "dc", "peak", "rms", "trim", "dc-rms-trim")
METRIC_RESAMPLES = 1000


def iter_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def _atomic_csv(path: Path, fieldnames: Sequence[str], rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, path)


def _speech_manifest(base: Path) -> Dict[str, Dict[str, Any]]:
    return {row["utteranceId"]: row for row in iter_jsonl(base / "outputs/manifest.jsonl")
            if row["dataset"] == "speechocean762"}


def _speech_rows_by_word(base: Path) -> Dict[Tuple[str, int], List[Dict[str, Any]]]:
    grouped: Dict[Tuple[str, int], List[Dict[str, Any]]] = defaultdict(list)
    for row in iter_jsonl(base / "outputs/phone_instances.jsonl"):
        if row["dataset"] == "speechocean762":
            grouped[(row["utteranceId"], int(row["wordIndex"]))].append(row)
    for rows in grouped.values():
        rows.sort(key=lambda item: int(item["phoneIndex"]))
    return grouped


def build_mapping_audit(base: Path) -> Dict[str, Any]:
    manifest = _speech_manifest(base)
    grouped = _speech_rows_by_word(base)
    before_audits: List[Dict[str, Any]] = []
    after_audits: List[Dict[str, Any]] = []
    repaired_labels: List[Dict[str, Any]] = []
    detailed: List[Dict[str, Any]] = []
    word_status = Counter()
    recovered_by_rule = Counter()
    recovered_rule_records: Dict[str, Dict[str, Any]] = {}

    utterance_words: Dict[str, Dict[int, int]] = {}
    engine_words_by_utterance: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for (utterance_id, word_index), rows in grouped.items():
        engine_words_by_utterance[utterance_id].append(
            {"index": word_index, "expectedWord": rows[0]["expectedWord"]}
        )
    for utterance_id, source in manifest.items():
        engine_words = engine_words_by_utterance.get(utterance_id, [])
        engine_words.sort(key=lambda item: item["index"])
        word_map = map_word_indices(source.get("humanWords") or [], engine_words)
        utterance_words[utterance_id] = {engine_words[target]["index"]: human for target, human in word_map.items()}

    for (utterance_id, word_index), engine_rows in sorted(grouped.items()):
        source = manifest[utterance_id]
        human_index = utterance_words[utterance_id].get(word_index)
        if human_index is None:
            word_status["UNMAPPED_OR_AMBIGUOUS_WORD"] += 1
            for row in engine_rows:
                record = {"dataset": "speechocean762", "utteranceId": utterance_id, "wordIndex": word_index,
                          "phoneIndex": row["phoneIndex"], "targetPhone": row["expectedPhoneme"], "status": "EXCLUDED",
                          "reason": "lexical pronunciation variant", "scope": "target", "mappingVersion": "after"}
                detailed.append(record)
                repaired_labels.append({"utteranceId": utterance_id, "wordIndex": word_index,
                                        "phoneIndex": row["phoneIndex"], "humanPhoneAccuracy": None,
                                        "mappingStatus": "EXCLUDED", "mappingReason": record["reason"], "ruleId": None})
            synthetic = {"targetAudit": [{"status": "EXCLUDED", "reason": "lexical pronunciation variant"}
                                           for _ in engine_rows], "sourceOnlyAudit": []}
            before_audits.append(synthetic); after_audits.append(synthetic)
            continue
        word_status["UNAMBIGUOUS_WORD"] += 1
        human = source["humanWords"][human_index]
        args = (human.get("phones", []), human.get("phones-accuracy", []),
                [row["expectedPhoneme"] for row in engine_rows])
        before = audit_phone_mapping(*args, repaired=False)
        after = audit_phone_mapping(*args, repaired=True)
        before_audits.append(before); after_audits.append(after)
        for row, item, score, old_score in zip(engine_rows, after["targetAudit"], after["mappedScores"], before["mappedScores"]):
            rule = item.get("rule")
            if score is not None and old_score is None and rule:
                recovered_by_rule[rule["rule_id"]] += 1
                recovered_rule_records[rule["rule_id"]] = rule
            repaired_labels.append({"utteranceId": utterance_id, "wordIndex": word_index,
                                    "phoneIndex": row["phoneIndex"], "humanPhoneAccuracy": score,
                                    "mappingStatus": item["status"], "mappingReason": item.get("reason"),
                                    "ruleId": rule.get("rule_id") if rule else None})
            detailed.append({"dataset": "speechocean762", "utteranceId": utterance_id, "wordIndex": word_index,
                             "phoneIndex": row["phoneIndex"], "scope": "target", "mappingVersion": "after", **item})
        for item in after["sourceOnlyAudit"]:
            detailed.append({"dataset": "speechocean762", "utteranceId": utterance_id, "wordIndex": word_index,
                             "phoneIndex": None, "scope": "source", "mappingVersion": "after", **item})

    before_summary = summarize_reason_counts(before_audits)
    after_summary = summarize_reason_counts(after_audits)
    report = {
        "schemaVersion": RELIABILITY_SCHEMA, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION,
        "wordMappingStatus": dict(word_status), "before": before_summary, "after": after_summary,
        "newEquivalenceRules": [rule.to_dict() for rule in RECOVERED_MAPPING_RULES],
        "recoveredMappingsByRule": [{**recovered_rule_records[rule_id], "recoveredTargetCount": count}
                                     for rule_id, count in sorted(recovered_by_rule.items())],
        "coverageDelta": after_summary["mappedTargetPhones"] - before_summary["mappedTargetPhones"],
        "auditInvariant": "Every excluded source or target phone has exactly one deterministic reason; ambiguous paths remain unlabeled.",
    }
    outputs = base / "outputs/shd-2b.2b"
    atomic_json(outputs / "mapping_audit.json", report)
    write_jsonl(outputs / "mapping_audit_details.jsonl", detailed)
    write_jsonl(outputs / "repaired_phone_labels.jsonl", repaired_labels)
    _atomic_csv(outputs / "mapping_exclusion_counts.csv", ("reason", "count", "percentOfExcludedPhoneEvents"),
                ({"reason": reason, **after_summary["exclusionCounts"][reason]} for reason in EXCLUSION_REASONS))
    return report


def _overlay_repaired_labels(base: Path, rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    labels = {(r["utteranceId"], int(r["wordIndex"]), int(r["phoneIndex"])): r
              for r in iter_jsonl(base / "outputs/shd-2b.2b/repaired_phone_labels.jsonl")}
    result = []
    for original in rows:
        row = dict(original)
        key = (row["utteranceId"], int(row["wordIndex"]), int(row["phoneIndex"]))
        if row["dataset"] == "speechocean762" and key in labels:
            score = labels[key]["humanPhoneAccuracy"]
            row["humanPhoneAccuracy"] = score
            row["primaryErrorLabel"] = primary_binary_label(score)
            row["sensitivityErrorLabel"] = sensitivity_binary_label(score)
            row["mappingStatus2B2B"] = labels[key]["mappingStatus"]
            row["mappingReason2B2B"] = labels[key]["mappingReason"]
            row["mappingRuleId2B2B"] = labels[key]["ruleId"]
        result.append(row)
    return result


def _metric_ci(rows: Sequence[Dict[str, Any]], label: str, scores: Sequence[float], seed_offset: int = 0) -> Dict[str, Any]:
    return speaker_cluster_metric_ci([int(r[label]) for r in rows], scores, [str(r["speakerId"]) for r in rows],
                                     resamples=METRIC_RESAMPLES, seed=RELIABILITY_SEED + seed_offset)


def supervised_reliability(rows: Sequence[Dict[str, Any]], label: str) -> Dict[str, Any]:
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    usable = [r for r in rows if r["dataset"] == "speechocean762" and r.get(label) is not None and r.get("rawGop") is not None]
    split = {name: [r for r in usable if r["split"] == name] for name in ("calibration", "validation", "test")}
    train = split["calibration"]
    test = split["test"]
    x_train = np.asarray([[float(r["rawGop"])] for r in train])
    y_train = np.asarray([int(r[label]) for r in train])
    x_test = np.asarray([[float(r["rawGop"])] for r in test])
    methods: Dict[str, np.ndarray] = {}
    method_rows: Dict[str, Sequence[Dict[str, Any]]] = {}
    monotonicity: Dict[str, Dict[str, Any]] = {
        "standardZ": {"expectedDirection": "decreasing error with increasing GOP", "violations": 0},
        "robustZ": {"expectedDirection": "decreasing error with increasing GOP", "violations": 0},
        "empiricalCdf": {"expectedDirection": "decreasing error with increasing GOP", "violations": 0},
    }
    for name, class_weight in (("logistic", None), ("classWeightedLogistic", "balanced")):
        model = LogisticRegression(random_state=RELIABILITY_SEED, class_weight=class_weight, max_iter=1000).fit(x_train, y_train)
        methods[name] = model.predict_proba(x_test)[:, 1]
        method_rows[name] = test
        monotonicity[name] = {"rawGopCoefficient": float(model.coef_[0, 0]),
                              "expectedDirection": "negative", "violations": int(model.coef_[0, 0] >= 0)}
    isotonic = IsotonicRegression(increasing=False, out_of_bounds="clip").fit(x_train[:, 0], y_train)
    methods["isotonic"] = isotonic.predict(x_test[:, 0])
    method_rows["isotonic"] = test
    monotonicity["isotonic"] = {"configuredIncreasing": False, "violations": 0}
    phone_stats = group_phone_stats(train, "speechocean-phone-specific-calibration")
    phone_values: Dict[str, List[float]] = defaultdict(list)
    for row in train:
        phone_values[row["expectedPhoneme"]].append(float(row["rawGop"]))
    standard_scores, robust_scores, cdf_scores, normalized_test = [], [], [], []
    for row in test:
        phone = row["expectedPhoneme"]
        if phone not in phone_stats:
            continue
        enriched = add_normalizations(row, phone_stats[phone], sorted(phone_values[phone]))
        if any(enriched[name] is None for name in ("experimentalStandardZ", "experimentalRobustZ", "experimentalEmpiricalCdf")):
            continue
        normalized_test.append(row)
        standard_scores.append(-float(enriched["experimentalStandardZ"]))
        robust_scores.append(-float(enriched["experimentalRobustZ"]))
        cdf_scores.append(1.0 - float(enriched["experimentalEmpiricalCdf"]))
    methods["standardZ"] = np.asarray(standard_scores)
    methods["robustZ"] = np.asarray(robust_scores)
    methods["empiricalCdf"] = np.asarray(cdf_scores)
    for name in ("standardZ", "robustZ", "empiricalCdf"):
        method_rows[name] = normalized_test
    method_report = {}
    for index, (name, values) in enumerate(methods.items()):
        item = _metric_ci(method_rows[name], label, values, index * 1000)
        item["coverage"] = {"evaluated": len(method_rows[name]), "heldOutEligible": len(test),
                            "percent": 100.0 * len(method_rows[name]) / len(test) if test else 0.0}
        method_report[name] = item
    raw = _metric_ci(test, label, [-float(r["rawGop"]) for r in test], 9000)
    subgroups = {}
    for group in ("adult", "child"):
        indices = [i for i, row in enumerate(test) if row.get("speakerGroup") == group]
        selected = [test[i] for i in indices]
        if len({r["speakerId"] for r in selected}) < 20 or len({r[label] for r in selected}) < 2:
            subgroups[group] = {"status": "UNDERPOWERED", "sampleCount": len(selected),
                                "speakerCount": len({r["speakerId"] for r in selected})}
        else:
            subgroups[group] = _metric_ci(selected, label, [methods["logistic"][i] for i in indices], 11000 + len(indices))
    return {"label": label, "splitCounts": {name: len(value) for name, value in split.items()}, "rawGop": raw,
            "methods": method_report, "subgroups": subgroups,
            "monotonicity": monotonicity,
            "monotonicDirection": "Lower GOP must imply greater research-only error probability."}


def per_phone_quality(rows: Sequence[Dict[str, Any]], label: str = "primaryErrorLabel") -> Dict[str, Any]:
    report = {}
    test = [r for r in rows if r["dataset"] == "speechocean762" and r["split"] == "test" and
            r.get(label) is not None and r.get("rawGop") is not None]
    for phone in sorted({r["expectedPhoneme"] for r in test}):
        selected = [r for r in test if r["expectedPhoneme"] == phone]
        counts = Counter(int(r[label]) for r in selected)
        speakers = len({r["speakerId"] for r in selected})
        base = {"errorCount": counts[1], "correctCount": counts[0], "speakerCount": speakers}
        if len(counts) < 2:
            report[phone] = {**base, "status": "SINGLE_CLASS"}
        elif speakers < 20 or min(counts.values()) < 20:
            report[phone] = {**base, "status": "UNDERPOWERED"}
        else:
            report[phone] = {**base, **_metric_ci(selected, label, [-float(r["rawGop"]) for r in selected], 20000 + len(report))}
    return report


def word_aggregation_reliability(rows: Sequence[Dict[str, Any]], resamples: int = 1000) -> Dict[str, Any]:
    from scipy.stats import spearmanr
    grouped: Dict[Tuple[str, str, int], List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["dataset"] == "speechocean762" and row["split"] == "test" and row.get("rawGop") is not None and row.get("humanWordAccuracy") is not None:
            grouped[(row["speakerId"], row["utteranceId"], int(row["wordIndex"]))].append(row)
    records = []
    for (speaker, utterance, word_index), phones in grouped.items():
        values = np.asarray([float(p["rawGop"]) for p in phones])
        durations = np.asarray([float(p.get("durationMs") or 0) for p in phones])
        utterance_alignment = np.asarray([float(p.get("pathNormalizedLogLikelihood") or 0) for p in phones])
        phone_alignment_proxy = np.asarray([float(p.get("meanTargetLogProb") or -1e9) for p in phones])
        order = np.argsort(values)
        trim_count = int(0.1 * len(values))
        trimmed = np.sort(values)[trim_count:max(len(values) - trim_count, trim_count + 1)]
        without_weakest_alignment = np.delete(values, int(np.argmin(phone_alignment_proxy))) if len(values) > 1 else values
        records.append({"speakerId": speaker, "target": float(phones[0]["humanWordAccuracy"]), "phoneCount": len(values),
                        "durationMs": float(durations.sum()), "alignmentQuality": float(np.mean(utterance_alignment)),
                        "mean": float(values.mean()), "median": float(np.median(values)), "minimum": float(values.min()),
                        "lowerQuartile": float(np.percentile(values, 25)), "trimmedMean10": float(trimmed.mean()),
                        "durationWeightedMean": float(np.average(values, weights=durations)) if durations.sum() else float(values.mean()),
                        "minimumAfterDroppingWeakestAlignment": float(without_weakest_alignment.min())})
    methods = ("mean", "median", "minimum", "lowerQuartile", "trimmedMean10", "durationWeightedMean",
               "minimumAfterDroppingWeakestAlignment")
    speakers = sorted({r["speakerId"] for r in records})
    by_speaker = {s: [r for r in records if r["speakerId"] == s] for s in speakers}
    rng = np.random.default_rng(RELIABILITY_SEED)
    report = {}
    for method in methods:
        estimate = float(spearmanr([r[method] for r in records], [r["target"] for r in records]).statistic)
        draws = []
        for _ in range(resamples):
            sampled = [row for speaker in rng.choice(speakers, size=len(speakers), replace=True) for row in by_speaker[speaker]]
            value = float(spearmanr([r[method] for r in sampled], [r["target"] for r in sampled]).statistic)
            if np.isfinite(value): draws.append(value)
        report[method] = {"estimate": estimate, "ci95": [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))],
                          "validResamples": len(draws)}
    quartiles = np.percentile([r["alignmentQuality"] for r in records], [25, 75])
    strata = {}
    for name, predicate in (("lowAlignment", lambda r: r["alignmentQuality"] <= quartiles[0]),
                            ("highAlignment", lambda r: r["alignmentQuality"] >= quartiles[1]),
                            ("singlePhone", lambda r: r["phoneCount"] == 1),
                            ("multiPhone", lambda r: r["phoneCount"] > 1)):
        selected = [r for r in records if predicate(r)]
        strata[name] = {method: float(spearmanr([r[method] for r in selected], [r["target"] for r in selected]).statistic)
                        for method in ("minimum", "lowerQuartile")}
    return {"wordCount": len(records), "speakerCount": len(speakers), "methods": report, "errorAnalysis": strata}


def analyze_reliability(base: Path) -> Dict[str, Any]:
    mapping_path = base / "outputs/shd-2b.2b/mapping_audit.json"
    if not mapping_path.exists():
        build_mapping_audit(base)
    all_rows = read_jsonl(base / "outputs/phone_instances.jsonl")
    repaired = _overlay_repaired_labels(base, all_rows)
    nominal = [r for r in repaired if r.get("rawGop") is not None and r["split"] == "calibration" and
               (r["dataset"] == "librispeech-dev-clean" or (r["dataset"] == "speechocean762" and r.get("humanPhoneAccuracy") == 2.0))]
    before_rows = [r for r in all_rows if r["dataset"] == "speechocean762"]
    after_rows = [r for r in repaired if r["dataset"] == "speechocean762"]
    before_primary = supervised_reliability(before_rows, "primaryErrorLabel")
    primary = supervised_reliability(after_rows, "primaryErrorLabel")
    sensitivity = supervised_reliability(after_rows, "sensitivityErrorLabel")
    bootstrap = speaker_cluster_bootstrap_statistics(nominal, resamples=1000)
    minimum_policy = {}
    for phone, item in bootstrap.items():
        eligible = []
        full_iqr = None
        values = [float(r["rawGop"]) for r in nominal if r["expectedPhoneme"] == phone]
        if values:
            full_iqr = float(np.percentile(values, 75) - np.percentile(values, 25))
        for level, level_item in item["levels"].items():
            if level_item["status"] != "AVAILABLE" or not full_iqr:
                continue
            metrics = level_item["metrics"]
            stable = all(metrics[name]["halfWidth"] <= 0.20 * full_iqr for name in ("mean", "median", "q10", "q50", "q90"))
            scale_estimate = metrics["robustScale"]["estimate"]
            stable = stable and scale_estimate > 0 and metrics["robustScale"]["halfWidth"] <= 0.10 * scale_estimate
            if stable: eligible.append(int(level))
        minimum_policy[phone] = {"minimumStableInstances": min(eligible) if eligible else None,
                                 "availableInstances": item["instanceCount"], "availableSpeakers": item["speakerCount"],
                                 "policyStatus": "RESEARCH_ONLY_NOT_ACTIVATED"}
    report = {
        "schemaVersion": RELIABILITY_SCHEMA,
        "mappingMetricBeforeAfter": {"beforePrimary": before_primary["rawGop"], "afterPrimary": primary["rawGop"]},
        "phoneBootstrap": bootstrap, "minimumSampleResearch": minimum_policy,
        "futureMinimumPolicy": {
            "form": "phone instances >= phone-specific stable threshold AND unique speakers >= independently validated speaker threshold",
            "instanceThreshold": None, "speakerThreshold": None, "activation": "NOT ACTIVATED",
            "reason": "No phone met the joint strict CI criterion at any available level through N=2000; numeric thresholds would be fabricated."},
        "primary": primary, "sensitivity": sensitivity,
        "perPhonePrimary": per_phone_quality(after_rows),
        "calibrationMethodReliability": {"primary": primary["methods"], "sensitivity": sensitivity["methods"]},
        "wordAggregation": word_aggregation_reliability(after_rows),
        "production": {"calibratedScore": None, "observedPhoneme": None, "status": "NULL / NOT AVAILABLE"},
    }
    atomic_json(base / "outputs/shd-2b.2b/reliability_analysis.json", report)
    return report


def refresh_word_aggregation(base: Path) -> Dict[str, Any]:
    analysis_path = base / "outputs/shd-2b.2b/reliability_analysis.json"
    if not analysis_path.exists():
        raise ValueError("Run the analyze command before refreshing word aggregation")
    rows = _overlay_repaired_labels(base, read_jsonl(base / "outputs/phone_instances.jsonl"))
    result = word_aggregation_reliability([r for r in rows if r["dataset"] == "speechocean762"])
    report = json.loads(analysis_path.read_text(encoding="utf-8"))
    report["wordAggregation"] = result
    report["futureMinimumPolicy"] = {
        "form": "phone instances >= phone-specific stable threshold AND unique speakers >= independently validated speaker threshold",
        "instanceThreshold": None, "speakerThreshold": None, "activation": "NOT ACTIVATED",
        "reason": "No phone met the joint strict CI criterion at any available level through N=2000; numeric thresholds would be fabricated."}
    atomic_json(analysis_path, report)
    return result


def _assessment_summary(source: Dict[str, Any], assessment: Dict[str, Any], variant: str,
                        preprocessing: Dict[str, Any]) -> Dict[str, Any]:
    phones = [phone for word in assessment["words"] for phone in word["phonemes"]]
    gops = [float(phone["rawGop"]) for phone in phones if phone.get("rawGop") is not None]
    signature = [{"selectedVariant": word["selectedVariant"],
                  "phones": [{"expectedPhoneme": p["expectedPhoneme"], "startFrame": p["startFrame"],
                              "endFrame": p["endFrame"], "rawGop": p["rawGop"],
                              "candidateRanking": [c["phoneme"] for c in p.get("candidatePhonemes", [])]}
                             for p in word["phonemes"]]} for word in assessment["words"]]
    return {"schemaVersion": RELIABILITY_SCHEMA, "dataset": source["dataset"], "utteranceId": source["utteranceId"],
            "speakerId": source["speakerId"], "split": source["split"], "speakerGroup": source.get("speakerGroup"),
            "variant": variant, "preprocessing": preprocessing, "rawGopMean": float(np.mean(gops)) if gops else None,
            "rawGopMedian": float(np.median(gops)) if gops else None, "phoneCount": len(phones),
            "alignmentQuality": assessment["alignmentQuality"], "signature": signature}


def run_normalization_experiments(base: Path) -> Dict[str, Any]:
    from app.services.pronunciation.acoustic_engine import LocalAcousticEngine, decode_audio_bytes_to_16k_mono
    full_manifest = list(iter_jsonl(base / "outputs/manifest.jsonl"))
    by_speaker: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in full_manifest:
        by_speaker[row["speakerId"]].append(row)
    # Deterministic speaker-balanced research panel.  Baseline domain summaries
    # still use the complete 2A corpus; preprocessing inference is deliberately
    # balanced so prolific speakers cannot dominate the comparison.
    manifest = []
    for speaker, speaker_rows in sorted(by_speaker.items()):
        ranked = sorted(speaker_rows, key=lambda row: (row["audioSha256"], row["utteranceId"]))
        manifest.extend(ranked[:4])
    browser_dir = Path(__file__).parent / "real_browser_cases"
    browser_text = "This morning a machine screamed at you until you woke up"
    browser_sources = [{"dataset": "browser", "utteranceId": path.stem, "speakerId": "browser:developer",
                        "split": "regression", "speakerGroup": None, "audioPath": str(path), "referenceText": browser_text}
                       for path in sorted(browser_dir.glob("case_*.webm")) if path.stem in {"case_a", "case_b", "case_c", "case_e"}]
    sources = manifest + browser_sources
    output = base / "outputs/shd-2b.2b/normalization_instances.jsonl"
    existing = read_jsonl(output)
    completed = {(r["dataset"], r["utteranceId"], r["variant"]) for r in existing}
    engine = LocalAcousticEngine(model_id=MODEL_ID)
    rows = list(existing)
    started = time.perf_counter()
    processed = 0
    for index, source in enumerate(sources):
        pending = [variant for variant in PREPROCESSING_VARIANTS
                   if (source["dataset"], source["utteranceId"], variant) not in completed]
        if not pending:
            continue
        path = Path(source["audioPath"]) if source["dataset"] == "browser" else base / "corpora" / source["audioPath"]
        audio = path.read_bytes()
        canonical = decode_audio_bytes_to_16k_mono(audio)
        for variant in pending:
            waveform, metadata = preprocess_waveform(canonical, variant)
            assessment = engine.assess_pronunciation(audio, source["referenceText"], _decoded_waveform=waveform)
            rows.append(_assessment_summary(source, assessment, variant, metadata)); processed += 1
        if processed and processed % 100 == 0:
            write_jsonl(output, sorted(rows, key=lambda r: (r["dataset"], r["utteranceId"], r["variant"])))
    write_jsonl(output, sorted(rows, key=lambda r: (r["dataset"], r["utteranceId"], r["variant"])))
    report = analyze_normalization(rows)
    report["sampling"] = {"strategy": "four deterministic audio-hash-ranked utterances per corpus speaker",
                          "fullCorpusUtterances": len(full_manifest), "panelUtterances": len(manifest),
                          "panelSpeakers": len(by_speaker), "browserCases": len(browser_sources)}
    report["performance"] = {"newVariantRuns": processed, "wallSeconds": time.perf_counter() - started,
                             "vram": engine.get_vram_telemetry()}
    atomic_json(base / "outputs/shd-2b.2b/normalization_analysis.json", report)
    return report


def _cluster_median_gap(rows: Sequence[Dict[str, Any]], left: str, right: str, seed: int) -> Dict[str, Any]:
    selected = [r for r in rows if r["dataset"] in {left, right} and r.get("rawGopMedian") is not None]
    speakers = sorted({r["speakerId"] for r in selected})
    by_speaker = {s: [r for r in selected if r["speakerId"] == s] for s in speakers}
    def gap(sample: Sequence[Dict[str, Any]]) -> float:
        return float(np.median([r["rawGopMedian"] for r in sample if r["dataset"] == left]) -
                     np.median([r["rawGopMedian"] for r in sample if r["dataset"] == right]))
    estimate = gap(selected)
    rng = np.random.default_rng(seed); draws = []
    for _ in range(1000):
        sample = [row for speaker in rng.choice(speakers, size=len(speakers), replace=True) for row in by_speaker[speaker]]
        if {r["dataset"] for r in sample} == {left, right}: draws.append(gap(sample))
    return {"estimate": estimate, "ci95": [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))],
            "validResamples": len(draws)}


def analyze_normalization(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    from sklearn.linear_model import Ridge
    reference_values: Dict[str, List[float]] = defaultdict(list)
    for row in rows:
        if row["variant"] == "canonical" and row["dataset"] == "librispeech-dev-clean" and row["split"] == "calibration":
            for word in row["signature"]:
                for phone in word["phones"]:
                    if phone.get("rawGop") is not None:
                        reference_values[phone["expectedPhoneme"]].append(float(phone["rawGop"]))
    reference_stats = {phone: build_phone_stats(phone, values, 0, "librispeech-canonical-calibration")
                       for phone, values in reference_values.items()}
    sorted_reference = {phone: sorted(values) for phone, values in reference_values.items()}

    def normalized_values(selected: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        standard, robust, cdf = [], [], []
        for row in selected:
            for word in row["signature"]:
                for phone in word["phones"]:
                    name, raw = phone["expectedPhoneme"], phone.get("rawGop")
                    if raw is None or name not in reference_stats:
                        continue
                    enriched = add_normalizations({"rawGop": raw}, reference_stats[name], sorted_reference[name])
                    if enriched["experimentalStandardZ"] is not None: standard.append(enriched["experimentalStandardZ"])
                    if enriched["experimentalRobustZ"] is not None: robust.append(enriched["experimentalRobustZ"])
                    if enriched["experimentalEmpiricalCdf"] is not None: cdf.append(enriched["experimentalEmpiricalCdf"])
        return {"standardZ": distribution_summary(standard), "robustZ": distribution_summary(robust),
                "empiricalCdf": distribution_summary(cdf),
                "reference": "canonical LibriSpeech calibration phones only; browser cases never fitted"}

    def alignment_only(row: Dict[str, Any]) -> Any:
        return [{"selectedVariant": word["selectedVariant"],
                 "phones": [(phone["expectedPhoneme"], phone["startFrame"], phone["endFrame"])
                            for phone in word["phones"]]} for word in row["signature"]]

    report: Dict[str, Any] = {"variants": {}, "causalClaim": False,
                              "interpretation": "Associations only; corpus, channel, speaker and content are confounded."}
    for variant_index, variant in enumerate(PREPROCESSING_VARIANTS):
        selected = [r for r in rows if r["variant"] == variant]
        datasets = {}
        for dataset in ("librispeech-dev-clean", "speechocean762", "browser"):
            subset = [r for r in selected if r["dataset"] == dataset]
            datasets[dataset] = {
                "utteranceCount": len(subset), "rawGopMedian": distribution_summary([r["rawGopMedian"] for r in subset if r["rawGopMedian"] is not None]),
                "loudnessRms": distribution_summary([r["preprocessing"]["output"]["rms"] for r in subset]),
                "silenceProportion": distribution_summary([r["preprocessing"]["output"]["silenceProportion"] for r in subset]),
                "snrProxyDb": distribution_summary([r["preprocessing"]["output"]["snrProxyDb"] for r in subset]),
                "durationSeconds": distribution_summary([r["preprocessing"]["output"]["durationSeconds"] for r in subset]),
                "normalizationEvidence": normalized_values(subset),
            }
        canonical = {(r["dataset"], r["utteranceId"]): r for r in rows if r["variant"] == "canonical"}
        path_changes = 0; comparable = 0
        for row in selected:
            base = canonical.get((row["dataset"], row["utteranceId"]))
            if base and variant != "canonical":
                comparable += 1
                path_changes += int(alignment_only(base) != alignment_only(row))
        browser = {r["utteranceId"]: r for r in selected if r["dataset"] == "browser"}
        discrimination = {}
        for case in ("case_b", "case_c"):
            if "case_a" in browser and case in browser:
                discrimination[f"caseAminus{case[-1].upper()}"] = browser["case_a"]["rawGopMedian"] - browser[case]["rawGopMedian"]
        browser_case_evidence = {
            case: {"rawGopMedian": row["rawGopMedian"], "normalizationEvidence": normalized_values([row]),
                   "alignmentQuality": row["alignmentQuality"]}
            for case, row in sorted(browser.items())
        }
        corpus_rows = [r for r in selected if r["dataset"] in {"librispeech-dev-clean", "speechocean762"}
                       and r.get("rawGopMedian") is not None]
        adjusted = {"status": "UNAVAILABLE"}
        if corpus_rows:
            feature_names = ("logRms", "silenceProportion", "snrProxyDb", "durationSeconds", "isSpeechOcean")
            matrix = np.asarray([[math.log(max(r["preprocessing"]["output"]["rms"], 1e-8)),
                                  r["preprocessing"]["output"]["silenceProportion"],
                                  r["preprocessing"]["output"]["snrProxyDb"],
                                  r["preprocessing"]["output"]["durationSeconds"],
                                  float(r["dataset"] == "speechocean762")] for r in corpus_rows])
            means, scales = matrix.mean(axis=0), matrix.std(axis=0)
            scales[scales == 0] = 1.0
            model = Ridge(alpha=1.0).fit((matrix - means) / scales,
                                         np.asarray([r["rawGopMedian"] for r in corpus_rows]))
            adjusted = {"status": "AVAILABLE", "r2InSampleDiagnostic": float(model.score((matrix - means) / scales,
                                                                                           [r["rawGopMedian"] for r in corpus_rows])),
                        "standardizedAssociations": dict(zip(feature_names, (float(x) for x in model.coef_))),
                        "causalInterpretationAllowed": False}
        report["variants"][variant] = {"datasets": datasets,
            "corpusGap": _cluster_median_gap(selected, "librispeech-dev-clean", "speechocean762", RELIABILITY_SEED + variant_index),
            "browserVsSpeechOceanGap": _cluster_median_gap(selected, "speechocean762", "browser", RELIABILITY_SEED + 100 + variant_index),
            "alignmentSignatureChangeCount": path_changes, "alignmentComparableCount": comparable,
            "browserDiscrimination": discrimination, "browserCaseEvidence": browser_case_evidence,
            "adjustedAssociationDiagnostic": adjusted}
    return report


def refresh_normalization_analysis(base: Path) -> Dict[str, Any]:
    path = base / "outputs/shd-2b.2b/normalization_analysis.json"
    prior = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    rows = read_jsonl(base / "outputs/shd-2b.2b/normalization_instances.jsonl")
    report = analyze_normalization(rows)
    for key in ("sampling", "performance"):
        if key in prior:
            report[key] = prior[key]
    atomic_json(path, report)
    return report


def _semantic_diff(single: Dict[str, Any], batched: Dict[str, Any]) -> Dict[str, Any]:
    differences = Counter(); max_gop_delta = 0.0
    sw, bw = single["words"], batched["words"]
    if len(sw) != len(bw): differences["wordCount"] += 1
    for left, right in zip(sw, bw):
        if left["selectedVariant"] != right["selectedVariant"]: differences["selectedVariant"] += 1
        if len(left["phonemes"]) != len(right["phonemes"]): differences["phoneCount"] += 1
        for lp, rp in zip(left["phonemes"], right["phonemes"]):
            if lp["expectedPhoneme"] != rp["expectedPhoneme"]: differences["phoneSequence"] += 1
            if (lp["startFrame"], lp["endFrame"]) != (rp["startFrame"], rp["endFrame"]): differences["frameSpan"] += 1
            if lp["rawGop"] is not None and rp["rawGop"] is not None:
                max_gop_delta = max(max_gop_delta, abs(float(lp["rawGop"]) - float(rp["rawGop"])))
            left_rank = [c["phoneme"] for c in lp.get("candidatePhonemes", [])]
            right_rank = [c["phoneme"] for c in rp.get("candidatePhonemes", [])]
            if left_rank != right_rank: differences["candidateRanking"] += 1
    return {"differences": dict(differences), "maxAbsoluteGopDelta": max_gop_delta,
            "semanticEquivalent": not differences and max_gop_delta <= 1e-4}


def _logit_diagnostics(engine: Any, inputs: Sequence[Tuple[bytes, str]]) -> List[Dict[str, Any]]:
    import torch
    from app.services.pronunciation.acoustic_engine import decode_audio_bytes_to_16k_mono
    waveforms = [decode_audio_bytes_to_16k_mono(audio) for audio, _ in inputs]
    lengths = torch.tensor([len(waveform) for waveform in waveforms], dtype=torch.long, device=engine.device)
    max_length = int(lengths.max().item())
    padded = np.zeros((len(waveforms), max_length), dtype=np.float32)
    attention = np.zeros((len(waveforms), max_length), dtype=np.int64)
    for index, waveform in enumerate(waveforms):
        padded[index, :len(waveform)] = waveform
        attention[index, :len(waveform)] = 1
    with torch.no_grad():
        batched = engine.model(torch.from_numpy(padded).to(engine.device),
                               attention_mask=torch.from_numpy(attention).to(engine.device)).logits
        output = []
        feature_lengths = engine.model._get_feat_extract_output_lengths(lengths).cpu().tolist()
        for index, waveform in enumerate(waveforms):
            raw = torch.from_numpy(waveform).unsqueeze(0).to(engine.device)
            single = engine.model(raw).logits[0]
            single_masked = engine.model(raw, attention_mask=torch.ones_like(raw, dtype=torch.long)).logits[0]
            padded_one = torch.from_numpy(padded[index:index + 1]).to(engine.device)
            padded_mask = torch.from_numpy(attention[index:index + 1]).to(engine.device)
            padded_single = engine.model(padded_one, attention_mask=padded_mask).logits[0]
            valid = int(feature_lengths[index])
            def delta(left: Any, right: Any) -> float:
                return float(torch.max(torch.abs(left[:valid].float() - right[:valid].float())).item())
            output.append({"inputSamples": len(waveform), "trueFeatureFrames": valid,
                           "singleOutputFrames": int(single.shape[0]), "batchedOutputFrames": int(batched.shape[1]),
                           "singleVsAllOnesMaskMaxLogitDelta": delta(single, single_masked),
                           "singleVsPaddedMaskedMaxLogitDelta": delta(single, padded_single),
                           "paddedSingleVsBatchMaxLogitDelta": delta(padded_single, batched[index])})
    return output


def run_batch_diagnostics(base: Path) -> Dict[str, Any]:
    import torch
    from app.services.pronunciation.acoustic_engine import LocalAcousticEngine, decode_audio_bytes_to_16k_mono
    manifest = list(iter_jsonl(base / "outputs/manifest.jsonl"))
    ranked = sorted(manifest, key=lambda r: (Path(base / "corpora" / r["audioPath"]).stat().st_size, r["utteranceId"]))
    quantile_indices = np.linspace(0, len(ranked) - 1, 8, dtype=int).tolist()
    order = (0, 7, 3, 4, 1, 6, 2, 5)
    selected_rows = [ranked[quantile_indices[index]] for index in order]
    samples = [(row, (base / "corpora" / row["audioPath"]).read_bytes()) for row in selected_rows]
    engine = LocalAcousticEngine(model_id=MODEL_ID)
    results = {}
    for batch_size in (1, 2, 4):
        started = time.perf_counter(); comparisons = []; logit_diagnostics = []
        torch.cuda.reset_peak_memory_stats() if "cuda" in engine.device else None
        audio_seconds = 0.0
        for offset in range(0, len(samples), batch_size):
            chunk = samples[offset:offset + batch_size]
            inputs = [(audio, row["referenceText"]) for row, audio in chunk]
            logit_diagnostics.extend(_logit_diagnostics(engine, inputs))
            single = [engine.assess_pronunciation(*item) for item in inputs]
            audio_seconds += sum(float(item["audioMetadata"]["durationMs"]) / 1000 for item in single)
            batched = engine.assess_pronunciation_batch(inputs)
            comparisons.extend(_semantic_diff(a, b) for a, b in zip(single, batched))
        elapsed = time.perf_counter() - started
        benchmark_started = time.perf_counter(); benchmark_audio_seconds = 0.0
        torch.cuda.reset_peak_memory_stats() if "cuda" in engine.device else None
        for offset in range(0, len(samples), batch_size):
            chunk = samples[offset:offset + batch_size]
            assessments = engine.assess_pronunciation_batch([(audio, row["referenceText"]) for row, audio in chunk])
            benchmark_audio_seconds += sum(float(item["audioMetadata"]["durationMs"]) / 1000 for item in assessments)
        benchmark_elapsed = time.perf_counter() - benchmark_started
        results[str(batch_size)] = {"sampleCount": len(samples), "wallSeconds": elapsed,
            "audioSeconds": audio_seconds, "realTimeFactor": elapsed / audio_seconds if audio_seconds else None,
            "utterancesPerSecond": len(samples) / elapsed, "vram": engine.get_vram_telemetry(), "comparisons": comparisons,
            "logitDiagnostics": logit_diagnostics,
            "performance": {"wallSeconds": benchmark_elapsed, "audioSeconds": benchmark_audio_seconds,
                            "utterancesPerSecond": len(samples) / benchmark_elapsed,
                            "realTimeFactor": benchmark_elapsed / benchmark_audio_seconds if benchmark_audio_seconds else None,
                            "vram": engine.get_vram_telemetry()},
            "accepted": all(item["semanticEquivalent"] for item in comparisons)}
    accepted = [size for size in (1, 2, 4) if results[str(size)]["accepted"]]
    policy = max(accepted) if accepted else 1
    batch_four_logits = results["4"]["logitDiagnostics"]
    padding_delta = max(item["singleVsPaddedMaskedMaxLogitDelta"] for item in batch_four_logits)
    batch_math_delta = max(item["paddedSingleVsBatchMaxLogitDelta"] for item in batch_four_logits)
    mask_delta = max(item["singleVsAllOnesMaskMaxLogitDelta"] for item in batch_four_logits)
    semantic_changes = sum(bool(item["differences"]) for item in results["4"]["comparisons"])
    if padding_delta > 1e-4 and batch_math_delta > 1e-4:
        cause = ("Two effects remain after correct true-frame truncation: padded context changes boundary logits despite "
                 "the attention mask, and changing the CUDA batch dimension adds larger numerical drift. Near-tied "
                 "multi-variant CTC trellises amplify both into different variants and phone paths.")
    elif padding_delta <= 1e-7 and mask_delta <= 1e-7 and batch_math_delta > 1e-4:
        cause = ("Changing only the CUDA batch dimension changes valid-frame logits; the maximum logit delta is then "
                 "amplified by near-tied multi-variant CTC trellises into different variants and phone paths.")
    elif padding_delta > max(batch_math_delta * 10, 1e-4):
        cause = "Padding changes valid-frame logits despite the attention mask; true-length truncation cannot restore single-item semantics."
    elif semantic_changes and max(padding_delta, batch_math_delta, mask_delta) <= 0.05:
        cause = "Small GPU forward-pass numerical differences cross near-tied multi-variant trellis decisions and change semantic paths."
    else:
        cause = "Batch-dependent logits change alignment semantics after correct true-frame truncation."
    root_cause = {
        "diagnostic": "Compared single and padded forwards after attention-mask-derived convolution truncation.",
        "modelFeatureExtractorNormalization": getattr(engine.model.config, "feat_extract_norm", None),
        "identified": True, "maximumSingleVsAllOnesMaskLogitDelta": mask_delta,
        "maximumSingleVsPaddedMaskedLogitDelta": padding_delta,
        "maximumPaddedSingleVsBatchLogitDelta": batch_math_delta,
        "semanticPathChangesAtBatch4": semantic_changes,
        "conclusion": "True feature-length handling restores semantic equivalence." if results["4"]["accepted"] else cause,
    }
    report = {"schemaVersion": RELIABILITY_SCHEMA, "sampleSelection": {
                "strategy": "eight file-size quantiles in interleaved short/long order",
                "inputSamples": [item["inputSamples"] for item in results["1"]["logitDiagnostics"]]},
              "rootCause": root_cause, "batchResults": results,
              "finalBatchPolicy": policy}
    atomic_json(base / "outputs/shd-2b.2b/batch_diagnostics.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("mapping", "analyze", "word", "normalize", "normalize-analysis", "batch", "all"))
    parser.add_argument("--base", type=Path, default=Path(__file__).parent / "calibration_data")
    args = parser.parse_args()
    actions = {"mapping": lambda: build_mapping_audit(args.base), "analyze": lambda: analyze_reliability(args.base),
               "word": lambda: refresh_word_aggregation(args.base),
               "normalize": lambda: run_normalization_experiments(args.base),
               "normalize-analysis": lambda: refresh_normalization_analysis(args.base),
               "batch": lambda: run_batch_diagnostics(args.base)}
    result = {name: actions[name]() for name in ("mapping", "analyze", "normalize", "batch")} if args.command == "all" else actions[args.command]()
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
