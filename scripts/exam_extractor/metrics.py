"""Content-Factory input metrics from the staged canonical packages (Exams Recovery Phase 3.6M).

The later original-content generator may take STRUCTURE and PROFILES from the source corpus — never its text.
This module therefore emits numbers only: distributions, lengths, ratios, durations, counts. No sentence, option,
passage, transcript or key letter leaves the packages.

  python scripts/extract_exam_packages.py metrics      -> imports/exams/staging/reports/content_factory_metrics.json

Metrics (per family, per part / question type, and per test):
  questionTypes          interaction / group-kind distribution
  groupSizes             items per group (TOEIC sets, IELTS printed ranges)
  documentsPerSet        TOEIC Part 7 documents per set (MULTI_DOC segmentation, header declaration)
  passageWords           words per passage / document (count only)
  lexical                mean word length, share of words >= 7 letters, type/token ratio (per passage, aggregated)
  questionDensity        items per 100 passage words
  optionProfile          options per item, words per option, share of word-form distractor sets (all options share
                         a 4-letter stem: 'satisfied / satisfaction / ...'), share of single-word option sets
  stemWords              words per printed stem
  audio                  part / recording durations (seconds) and answer-pause rhythm (from audio_segment analyses)
  speaking               prompts per speaking part
  timing                 blueprint section timings
"""
from __future__ import annotations

import glob
import json
import re
import statistics as st
from collections import Counter, defaultdict
from pathlib import Path

from .staging import _write_json

_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def _words(text: str) -> list:
    return _WORD.findall(text or "")


def _summ(vals: list) -> dict:
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"n": 0}
    out = {"n": len(vals), "mean": round(st.mean(vals), 2), "min": round(min(vals), 2), "max": round(max(vals), 2)}
    if len(vals) >= 2:
        out["median"] = round(st.median(vals), 2)
        out["sd"] = round(st.pstdev(vals), 2)
    return out


def _lexical(words: list) -> dict:
    if not words:
        return {}
    lw = [w.lower() for w in words]
    return {"meanWordLength": sum(len(w) for w in lw) / len(lw),
            "longWordShare": sum(1 for w in lw if len(w) >= 7) / len(lw),
            "typeTokenRatio": len(set(lw)) / len(lw)}


def _word_form_set(opts: list) -> bool:
    toks = [o.strip().lower() for o in opts]
    if len(toks) < 3 or any(len(t.split()) != 1 or len(t) < 4 for t in toks):
        return False
    return len({t[:4] for t in toks}) == 1


def content_metrics(staging: Path) -> dict:
    status = {}
    ss = staging / "reports" / "staging_status.json"
    if ss.exists():
        status = {r["testId"]: r.get("finalStatus") for r in json.loads(ss.read_text(encoding="utf-8"))["tests"]}
    fam = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))   # family -> part -> metric -> values
    per_test = []
    for f in sorted(glob.glob(str(staging / "extracted" / "**" / "*.json"), recursive=True)):
        pkg = json.loads(Path(f).read_text(encoding="utf-8"))
        meta = pkg["manifest"]["metadata"]
        prov = meta.get("sourceProvenance", {})
        family = pkg["form"]["family"]
        tid = (meta.get("sourceProvenance") or {}).get("rawManifestRef", "").split("#")[-1]
        parts = {p["id"]: p for p in pkg["parts"]}
        groups = {g["id"]: g for g in pkg["groups"]}
        fg = {x["groupId"]: parts[x["partId"]]["partCode"] for x in pkg["formGroups"]}
        stimuli = {s["id"]: s for s in pkg["stimuli"]}
        gstims = defaultdict(list)
        for x in pkg["groupStimuli"]:
            gstims[x["groupId"]].append(stimuli[x["stimulusId"]])
        items_by_group = defaultdict(list)
        for it in pkg["items"]:
            items_by_group[it["groupId"]].append(it)
        seen_passages = set()
        for gid, its in items_by_group.items():
            part = fg.get(gid, "?")
            m = fam[family][part]
            m["groupSize"].append(len(its))
            m["questionType"].extend(groups[gid]["questionType"] for _ in its)
            m["interaction"].extend(i["interactionType"] for i in its)
            passage_words = 0
            for s in gstims[gid]:
                body = s.get("bodyPayload") or {}
                if s["kind"] in ("TEXT", "MULTI_DOC") and ("text" in body or "documents" in body):
                    if s["id"] in seen_passages:
                        passage_words = max(passage_words, len(_words(body.get("text", ""))))
                        continue
                    seen_passages.add(s["id"])
                    ws = _words(body.get("text", ""))
                    if ws:
                        m["passageWords"].append(len(ws))
                        lex = _lexical(ws)
                        for k, v in lex.items():
                            m[k].append(v)
                        passage_words = len(ws)
                    docs = body.get("documents") or []
                    if s["kind"] == "MULTI_DOC":
                        m["documentsPerSet"].append(len(docs))
                        m["documentBoundaries"].append(body.get("documentBoundaries") or "NOT_SEGMENTED")
                        for d in docs:
                            dw = sum(len(_words(p.get("text", ""))) for p in d.get("paragraphs", []))
                            if dw:
                                m["documentWords"].append(dw)
                    elif "documents" not in body:
                        m["documentsPerSet"].append(1)
            if passage_words:
                m["itemsPer100PassageWords"].append(100.0 * len(its) / passage_words)
            for it in its:
                od = it.get("optionDefinitions") or {}
                opts = [o.get("text") if isinstance(o, dict) else str(o) for o in od.get("options", [])]
                opts = [o for o in opts if o]
                if opts:
                    m["optionsPerItem"].append(len(opts))
                    m["wordsPerOption"].extend(len(_words(o)) for o in opts)
                    m["wordFormDistractorSet"].append(1.0 if _word_form_set(opts) else 0.0)
                    m["singleWordOptionSet"].append(1.0 if all(len(_words(o)) == 1 for o in opts) else 0.0)
                if it["interactionType"] not in ("WRITING_RESPONSE", "SPEAKING_RESPONSE"):
                    m["stemWords"].append(len(_words(it.get("prompt", ""))))
                if it["interactionType"] == "SPEAKING_RESPONSE":
                    for s in gstims[gid]:
                        prompts = (s.get("bodyPayload") or {}).get("prompts")
                        if isinstance(prompts, list):
                            m["speakingPromptsPerPart"].append(len(prompts))
                if it["interactionType"] == "WRITING_RESPONSE":
                    m["writingMinimumWords"].append(od.get("minimumWords"))
        for a in pkg["assets"]:
            if str(a.get("mimeType", "")).startswith("audio/") and a.get("durationMs"):
                fam[family]["AUDIO"]["recordingSeconds"].append(a["durationMs"] / 1000)
        for seg in meta.get("audioSegments", []):
            fam[family][f"LISTENING_PART_{seg.get('part')}"]["audioSeconds"].append((seg["endMs"] - seg["startMs"]) / 1000)
        for sp in pkg.get("specifications", []):
            for k, v in (sp.get("timingPolicy") or {}).items():
                fam[family]["TIMING"][k].append(v)
        per_test.append({"testId": tid, "family": family, "finalStatus": status.get(tid),
                         "items": len(pkg["items"]), "groups": len(pkg["groups"]),
                         "sections": [s["skill"] for s in pkg["sections"]],
                         "collection": prov.get("collection"), "book": prov.get("book")})
    out = {"family": {}}
    for family, parts in fam.items():
        out["family"][family] = {}
        for part, ms in sorted(parts.items()):
            row = {}
            for k, vals in ms.items():
                if k in ("questionType", "interaction", "documentBoundaries"):
                    row[k] = dict(Counter(vals))
                elif k in ("wordFormDistractorSet", "singleWordOptionSet"):
                    row[k + "Share"] = round(sum(vals) / len(vals), 3) if vals else None
                else:
                    row[k] = _summ(vals)
            out["family"][family][part] = row
    # answer-pause rhythm of the analysed whole-test recordings (structure only)
    rhythm = []
    for p in sorted(glob.glob(str(staging / "audio_segments" / "*.json"))):
        d = json.loads(Path(p).read_text(encoding="utf-8"))
        if d.get("classes"):
            rhythm.append({"family": d.get("family"), "format": d.get("format"), "durationS": d.get("durationS"),
                           "shortAnswerPauseS": d["classes"].get("shortMedianS"),
                           "longAnswerPauseS": d["classes"].get("longMedianS"),
                           "parts": [{"part": s["part"], "seconds": round((s["endMs"] - s["startMs"]) / 1000, 1)}
                                     for s in d.get("segments", []) if s.get("tier") == "CONFIDENT"]})
    out["audioRhythm"] = rhythm
    out["tests"] = per_test
    out["note"] = ("Structure/profile metrics only (counts, lengths, ratios, durations). No source text, options, "
                   "transcripts or keys are copied. Input for a later ORIGINAL-content generator; no exam was generated.")
    out["generatedExams"] = 0
    _write_json(staging / "reports" / "content_factory_metrics.json", out)
    return out
