"""Exams Recovery Phase 4A / 4.1A — release-oriented processing of the human-QA queue (reports/qa_queue.json).

1. RELEASE PRIORITY (Phase 4A.1), independent of the Phase 3.6 extraction priority:
     P0  anything that can change correctness: answer key, question numbering, group boundary, passage / document /
         visual / audio association, missing item, wrong option
     P1  structural display correctness: multi-document split, group instructions, blank mapping display
     P2  media crop correctness: photo / chart / diagram / map crops
     P3  runtime interaction metadata: choose-TWO, matching, word limit, template structure
     P4  proofreading / cosmetic OCR that cannot change correctness
2. CROP REVIEW UNITS (Phase 4.1B): every image crop bound in a test is ONE unit (media_qa.py) carrying its technical
   result; all queue entries about that crop (Part 1 photo, Part 3/4 graphic, region heuristic, page-region
   rendering) are attached to the unit and close only with it. Unassigned page-region entries are assigned to the
   test(s) whose package references the crop.
3. RESOLUTION — an entry leaves the release blockers only by
     * DETERMINISTIC_PROOF: a resolver that admits exactly ONE interpretation, re-verified against the package
       (closed truth-value domain token 'NOTGIVEN'; a variant separator whose pieces are spellings of one word, the
       SAME number, or the only reading the printed word limit allows). Ambiguity is never resolved by proof;
     * a HUMAN DECISION in imports/exams/staging/qa/approvals.json:
         {"decisions": [{"entryId": <queue entry id | crop unit id>, "decision": "APPROVE"|"REJECT"|"CORRECT",
                         "reviewer": "...", "reviewedAt": "<ISO-8601>", "fingerprint": "sha256:...",
                         "correctedValue": <optional, CORRECT only>, "note": "..."}]}
       The fingerprint is the one printed on the reviewer sheet. It covers the source hash, location and the value /
       structure / crop actually bound in the package — a decision whose fingerprint no longer matches is STALE and
       ignored. A decision without reviewer, timestamp or fingerprint is INVALID and ignored.
     * OWNER_APPROVED_TECHNICAL_MEDIA: the owner's standing authorization for complete
       YBM/Economy TOEIC crops with current fingerprints and all technical checks passing.
       This records humanReviewed=false and never claims a per-crop human review.
     * CORRECT closes an entry only when the package now binds exactly the corrected value (CORRECTED); until then it
       is CORRECTION_PENDING (blocking).
4. OUTPUT
     reports/qa_release_review.json         counts, codes, locations, fingerprints, statuses (no exam text, no keys)
     reports/release_candidate_blockers.json per VALID_FULL candidate: exact open blockers, codes only
     qa/review/<book>__test-<n>/index.html  LOCAL reviewer sheet (source crop + bound value; untracked)
     qa/review/<book>__test-<n>/media.html  LOCAL crop contact sheet (media_qa.py)
   A package is QA_APPROVED only when it has no OPEN / REJECTED / STALE / CORRECTION_PENDING entry of release
   priority P0-P3.
"""
from __future__ import annotations

import glob
import hashlib
import html
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from .answer_keys import _number_value, fold, scorer_word_count
from .canonical_json import canonical_bytes
from .corpus import MANIFEST_DIR, raw_abs
from .staging import _write_json

BLOCKING_RELEASE_PRIORITIES = ("P0", "P1", "P2", "P3")
BLOCKING_STATUSES = ("OPEN", "REJECTED", "STALE_DECISION", "CORRECTION_PENDING")
CLOSED_STATUSES = ("RESOLVED_BY_PROOF", "APPROVED", "CORRECTED", "OWNER_APPROVED_TECHNICAL_MEDIA")
DECISIONS = ("APPROVE", "REJECT", "CORRECT", "OWNER_APPROVED_TECHNICAL_MEDIA")

_P0_TYPES = {"ANSWER_KEY", "TEST_NUMBER", "PART6_BLANK", "AUDIO_BOUNDARY", "AUDIO"}
_P0_SUBTYPES = {"QUESTION_NUMBER_GAP", "OPTION_PARSE_FAILED", "OPTION_LABEL_MISSING", "OPTION_LABEL_RECOGNISED",
                "OPTION_LABEL_RESTORED",
                "GROUP_BOUNDARY_UNPROVEN", "QUESTION_RANGE_MISMATCH", "PHOTO_MAPPING_UNPROVEN", "GRAPHIC_NOT_BOUND",
                "IMAGE_NOT_BOUND", "DUPLICATE_QUESTION_NUMBER"}
_P1_SUBTYPES = {"LAYOUT_LINEARIZED", "OCR_COLUMN_ORDER_INVERTED", "BLANK_NOT_FOUND", "WRITING_VISUAL_NOT_FOUND",
                "SOURCE_BLANK_GEOMETRY_RESTORED",
                "COMPLETION_TEMPLATE_PER_ITEM"}
_P2_SUBTYPES = {"PART1_PHOTO_CROP", "PART34_GRAPHIC_CROP", "IMAGE_REGION_HEURISTIC", "PAGE_REGION_RENDERING"}
_P3_SUBTYPES = {"SELECTION_METADATA", "WORD_LIMIT_RULE", "COMPLETION_TEMPLATE", "MATCHING_OPTIONS"}
_P4_SUBTYPES = {"OCR_LOW_CONFIDENCE", "OCR_TEXT_USED"}

VALIDATOR_IMPACT = {
    "ANSWER_KEY": "semantic: a wrong key passes every structural rule; scoring would be wrong — human/proof only",
    "TEST_NUMBER": "a wrong test boundary mixes items of two tests; structural counts may still pass",
    "PART6_BLANK": "blank<->question association: wrong mapping scores the wrong blank",
    "IMAGE_CROP": "asset stays PENDING => MEDIA_READY = NO (Phase 2: UNVALIDATED_MEDIA warning for visuals)",
    "OCR_READING_ORDER": "MULTI_DOC NOT_SEGMENTED renders as one block (runner notice); 5-item sets need >= 2 documents (STANDARD)",
    "OCR": "option / number recognition: a misread can attach option text to the wrong letter",
    "AUDIO_BOUNDARY": "a wrong part boundary plays the wrong audio for a part",
    "RUNTIME_DISPLAY": "runner falls back to per-item rendering (RUNNER_COMPLETION_TEMPLATE_INCOMPLETE review); scoring unaffected",
    "OTHER": "group boundary: wrong boundary changes which stimulus a question uses",
}

WHY_BLOCKS = {
    "P0": "can change correctness (key / numbering / association) — a learner could be scored wrongly",
    "P1": "can change what a learner sees (document split / blank mapping) — display correctness",
    "P2": "media crop not approved — the asset stays PENDING, the runner refuses it, MEDIA_READY = NO",
    "P3": "interaction metadata — runtime behaviour may differ from the printed test",
    "P4": "cosmetic — does not block release",
}


def release_priority(entry: dict) -> str:
    t, st = entry.get("type"), entry.get("subtype")
    if t in _P0_TYPES or st in _P0_SUBTYPES:
        return "P0"
    if st in _P1_SUBTYPES:
        return "P1"
    if st in _P2_SUBTYPES or t == "IMAGE_CROP":
        return "P2"
    if st in _P3_SUBTYPES:
        return "P3"
    if st in _P4_SUBTYPES:
        return "P4"
    return "P1"  # unknown codes are never treated as cosmetic


def _package_files(staging: Path) -> dict:
    out = {}
    for f in glob.glob(str(staging / "extracted" / "**" / "*.json"), recursive=True):
        p = Path(f)
        book, _, test = p.stem.partition("__")
        fam = "toeic" if "toeic" in p.parts else "ielts"
        out[f"{fam}/{book}/{test}"] = p
    return out


def _numbers(spec) -> list:
    if spec is None:
        return []
    if isinstance(spec, int):
        return [spec]
    out = []
    for part in re.split(r"[,\s]+", str(spec)):
        m = re.match(r"^(\d+)(?:-(\d+))?$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2) or m.group(1))
            out.extend(range(a, b + 1))
    return out


def _skill_of(entry: dict):
    scope = entry.get("scope") or ""
    for s in ("LISTENING", "READING", "WRITING", "SPEAKING"):
        if s in scope.split("/"):
            return s
    return None


def _items_by_number(pkg: dict, skill: str | None) -> dict:
    sections = {s["id"]: s["skill"] for s in pkg["sections"]}
    parts = {p["id"]: sections.get(p["sectionId"]) for p in pkg["parts"]}
    group_skill = {fg["groupId"]: parts.get(fg["partId"]) for fg in pkg["formGroups"]}
    specs = {s["itemId"]: s for s in pkg["answerSpecs"]}
    out = {}
    for it in pkg["items"]:
        if skill and group_skill.get(it["groupId"]) != skill:
            continue
        qn = (it.get("optionDefinitions") or {}).get("questionNumber")
        if qn is not None:
            out[int(qn)] = (it, specs.get(it["id"]))
    return out


def _squash(s: str) -> str:
    return re.sub(r"\s+", "", str(s or "")).upper()


def _accepted(spec: dict | None) -> list:
    if not spec:
        return []
    return [v for v in ((spec.get("acceptedAnswers") or {}).get("values") or []) if isinstance(v, str) and v.strip()]


def prove_closed_domain_repair(entry: dict, pkg: dict | None):
    """ANSWER_KEY_OCR_REPAIRED whose raw OCR token matches exactly ONE option of a closed truth-value domain
    (TRUE/FALSE/NOT GIVEN, YES/NO/NOT GIVEN) modulo whitespace, and the bound key is that option. Returns evidence or
    None (unproven -> stays for a human)."""
    if pkg is None or entry.get("type") != "ANSWER_KEY" or entry.get("subtype") != "ANSWER_KEY_OCR_REPAIRED":
        return None
    token = _squash(entry.get("detail"))
    if not token or not re.fullmatch(r"[A-Z]+", token):
        return None
    skill = (entry.get("scope") or "").split("/")[-1] or None
    by_num = _items_by_number(pkg, skill)
    numbers = _numbers(entry.get("questions"))
    if not numbers:
        return None
    for n in numbers:
        it, spec = by_num.get(n, (None, None))
        if it is None or spec is None or it.get("interactionType") != "TRUTH_CLASSIFICATION":
            return None
        domain = [o.get("id") for o in (it.get("optionDefinitions") or {}).get("options", [])]
        if set(domain) not in ({"TRUE", "FALSE", "NOT GIVEN"}, {"YES", "NO", "NOT GIVEN"}):
            return None
        matches = [d for d in domain if _squash(d) == token]
        values = (spec.get("acceptedAnswers") or {}).get("values") or []
        if len(matches) != 1 or values != matches:
            return None
    return {"method": "DETERMINISTIC_CLOSED_DOMAIN_REPAIR",
            "evidence": f"token matches exactly one member of the closed truth-value domain for questions {numbers}; bound key equals it"}


_SEPARATOR_DETAIL = re.compile(r"^variant separator \((SAME_WORD_SPELLING|NUMERIC_FORMS|WORD_LIMIT_FORCED); glyph '(.)'\)$")


def _numbers_exempt(item: dict) -> bool:
    """Mirror of ExamAttemptSnapshotContent#wordLimitAllowsNumber."""
    group = (item.get("optionDefinitions") or {}).get("group") or {}
    text = " ".join([str(group.get("wordLimitRule") or "")] + [str(x) for x in group.get("instructions") or []]).upper()
    return "NUMBER" in text or "AND/OR" in text


def prove_separator_repair(entry: dict, pkg: dict | None):
    """ANSWER_KEY_OCR_REPAIRED 'variant separator (<method>; glyph 'g')', re-verified on the PACKAGE (the extractor's
    claim is not trusted): every bound value is a piece of the one repaired printed variant and
      SAME_WORD_SPELLING  all pieces fold to one word;
      NUMERIC_FORMS       all pieces denote the same number;
      WORD_LIMIT_FORCED   the glyph-joined text breaks the spec's word limit (server counting rule) while every piece is
                          a word that fits it — the printed rule admits no other reading.
    NUMERIC_NOTATIONS (different notations, value not provable) is never proven."""
    if pkg is None or entry.get("type") != "ANSWER_KEY" or entry.get("subtype") != "ANSWER_KEY_OCR_REPAIRED":
        return None
    m = _SEPARATOR_DETAIL.match(str(entry.get("detail") or ""))
    numbers = _numbers(entry.get("questions"))
    if not m or len(numbers) != 1:
        return None
    method, glyph = m.group(1), m.group(2)
    it, spec = _items_by_number(pkg, (entry.get("scope") or "").split("/")[-1] or None).get(numbers[0], (None, None))
    values = _accepted(spec)
    if it is None or len(values) < 2:
        return None
    ok = False
    if method == "SAME_WORD_SPELLING":
        ok = len({fold(v) for v in values}) == 1
    elif method == "NUMERIC_FORMS":
        nums = [_number_value(v) for v in values]
        ok = all(n is not None for n in nums) and len(set(nums)) == 1
    elif method == "WORD_LIMIT_FORCED":
        limit = spec.get("wordLimit")
        ex = _numbers_exempt(it)
        joined = f" {glyph} ".join(values)
        ok = (bool(limit) and scorer_word_count(joined, ex) > limit
              and all(re.search(r"[^\W\d_]{2,}", v) for v in values)
              and all(scorer_word_count(v, ex) <= limit for v in values))
    if not ok:
        return None
    return {"method": f"DETERMINISTIC_SEPARATOR_{method}",
            "evidence": f"question {numbers[0]}: lone '{glyph}' between {len(values)} pieces; {method} re-verified on the bound key"}


def prove_key_cell_reread(entry: dict, pkg: dict | None):
    """Close an adjudication only after re-verifying its numbered source cell and bound key."""
    if pkg is None or entry.get('subtype')!='KEY_CELL_REREAD_ADJUDICATED':
        return None
    numbers=_numbers(entry.get('questions'));skill=_skill_of(entry)
    if len(numbers)!=1 or skill not in ('LISTENING','READING'):
        return None
    docs=pkg['manifest'].get('metadata',{}).get('sourceDocuments',[])
    if not any(d.get('sha256')==entry.get('sha256') and d.get('path')==entry.get('source') for d in docs):
        return None
    match=re.fullmatch(r'toeic/[a-z0-9-]+/test-(\d+)',str(entry.get('testId','')))
    if not match:
        return None
    _,spec=_items_by_number(pkg,skill).get(numbers[0],(None,None))
    values=_accepted(spec)
    if len(values)!=1:
        return None
    try:
        blocks=_reread_source_key_blocks(entry['source'],entry['sha256'],int(entry['page']),skill)
    except (OSError,ValueError,RuntimeError):
        return None
    selected=[b for b in blocks if b.test==int(match.group(1)) and b.orientation is not None]
    if len(selected)!=1:
        return None
    cell=selected[0].keys().get(numbers[0])
    if (cell is None or not cell.adjudicated or cell.number!=cell.predicted or cell.letter!=values[0]
            or sum(str(v)==str(cell.number) for v in cell.number_reads[-4:])<3
            or len(cell.letter_reads)<2 or cell.letter_reads[-2:]!=[cell.letter,cell.letter]):
        return None
    return {'method':'SOURCE_KEY_CELL_NUMBER_AND_LETTER_CLOSURE',
            'evidence':f'question {cell.number}: own source digits agree in at least three final reads; independent letter reads equal the bound key'}


from functools import lru_cache

@lru_cache(maxsize=16)
def _reread_source_key_blocks(source,sha256,page,skill):
    from .pipeline import Extractor
    from .diagnostics import DiagnosticLog
    from .key_tables import read_key_page
    ex=Extractor();layer=ex.layer(source,DiagnosticLog(),'KEY_PROOF')
    if layer is None or layer.sha256!=sha256:
        return []
    expected=range(1,101) if skill=='LISTENING' else range(101,201)
    return read_key_page(layer,page,ex.region_cache(),expected)


PROOF_RESOLVERS = (prove_closed_domain_repair, prove_separator_repair, prove_key_cell_reread)


# ─── decision ledger ───────────────────────────────────────────────────────────────────────────────────────────

def _decision_problem(a: dict):
    if not a.get("entryId"):
        return "MISSING_ENTRY_ID"
    if a.get("decision") not in DECISIONS:
        return "UNKNOWN_DECISION"
    if a.get('decision') == 'OWNER_APPROVED_TECHNICAL_MEDIA' and (
            not str(a.get('entryId', '')).startswith('CROP-') or not a.get('ownerDecisionRef')
            or a.get('humanReviewed') is not False):
        return 'INVALID_OWNER_TECHNICAL_MEDIA_DECISION'
    if not a.get("reviewer") or not a.get("reviewedAt"):
        return "MISSING_REVIEWER_OR_TIMESTAMP"
    if not str(a.get("fingerprint") or "").startswith("sha256:"):
        return "MISSING_FINGERPRINT"
    if a["decision"] == "CORRECT" and a.get("correctedValue") in (None, "", []):
        return "CORRECT_WITHOUT_VALUE"
    return None


def read_ledger(staging: Path) -> tuple:
    """(valid decisions by id — latest wins, invalid records with reason). Legacy Phase 4 records
    ({"approvals": [{decision: APPROVED|REJECTED}]}) carry no fingerprint and are INVALID by construction."""
    f = staging / "qa" / "approvals.json"
    if not f.exists():
        return {}, []
    data = json.loads(f.read_text(encoding="utf-8"))
    valid, invalid = {}, []
    for a in list(data.get("decisions", [])) + list(data.get("approvals", [])):
        problem = _decision_problem(a)
        if problem:
            invalid.append({"entryId": a.get("entryId"), "reason": problem})
            continue
        prev = valid.get(a["entryId"])
        if prev is None or str(a["reviewedAt"]) >= str(prev["reviewedAt"]):
            valid[a["entryId"]] = a
    return valid, invalid


def load_decisions(staging: Path) -> dict:
    return read_ledger(staging)[0]


def _load_approvals(staging: Path) -> dict:
    """Phase 4 name kept for callers: the VALID decisions only (fingerprinted, reviewer + timestamp)."""
    return load_decisions(staging)


def _fp(obj) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(obj)).hexdigest()


def _scope_items(entry: dict, pkg: dict) -> list:
    """Items the entry is about: by question numbers, else by the PART named in its scope, else none."""
    skill = _skill_of(entry)
    by_num = _items_by_number(pkg, skill)
    nums = _numbers(entry.get("questions"))
    m = re.search(r"/Q(\d+)-(\d+)$", entry.get("scope") or "")
    if not nums and m:
        nums = list(range(int(m.group(1)), int(m.group(2)) + 1))
    if nums:
        return [by_num[n] for n in nums if n in by_num]
    pm = re.search(r"PART_(\d+)", entry.get("scope") or "")
    if pm and skill:
        sections = {s["id"]: s for s in pkg["sections"]}
        part_ids = {p["id"] for p in pkg["parts"] if sections.get(p["sectionId"], {}).get("skill") == skill
                    and str(p.get("partCode", "")).endswith(pm.group(1))}
        groups = {fg["groupId"] for fg in pkg["formGroups"] if fg["partId"] in part_ids}
        specs = {s["itemId"]: s for s in pkg["answerSpecs"]}
        return [(it, specs.get(it["id"])) for it in pkg["items"] if it["groupId"] in groups]
    return []


def bound_value(entry: dict, pkg: dict | None) -> dict:
    """What the package currently binds for this entry (hashed into the fingerprint; never written to reports)."""
    if pkg is None:
        return {"package": None}
    items = _scope_items(entry, pkg)
    if entry.get("type") == "ANSWER_KEY":
        return {"keys": {str((it.get("optionDefinitions") or {}).get("questionNumber")):
                         {"values": _accepted(sp), "rejected": ((sp or {}).get("acceptedAnswers") or {}).get("rejectedAnswers"),
                          "policy": (sp or {}).get("normalizationPolicy"), "wordLimit": (sp or {}).get("wordLimit")}
                         for it, sp in items}} if items else {"packageContentHash": pkg["manifest"].get("contentHash")}
    if items:
        gids = sorted({it["groupId"] for it, _ in items})
        st_ids = {gs["stimulusId"] for gs in pkg.get("groupStimuli", []) if gs["groupId"] in gids}
        stimuli = sorted((s for s in pkg.get("stimuli", []) if s["id"] in st_ids), key=lambda s: s["id"])
        return {"items": [{"prompt": it.get("prompt"), "options": (it.get("optionDefinitions") or {}).get("options"),
                           "group": (it.get("optionDefinitions") or {}).get("group")} for it, _ in items],
                "stimuli": [{"kind": s.get("kind"), "body": s.get("bodyPayload")} for s in stimuli]}
    # no addressable scope: any change of the package invalidates a decision (conservative)
    return {"packageContentHash": pkg["manifest"].get("contentHash")}


def entry_fingerprint(entry: dict, package_id, pkg: dict | None) -> str:
    core = {k: entry.get(k) for k in ("id", "type", "subtype", "testId", "scope", "page", "bbox", "questions",
                                      "intervalMs", "cropSha256")}
    core["sourceSha256"] = entry.get("sha256")
    core["packageId"] = package_id
    core["bound"] = bound_value(entry, pkg)
    return _fp(core)


def _status(entry_id: str, fingerprint: str, proof, decisions: dict, current_value=None):
    if proof:
        return "RESOLVED_BY_PROOF", None
    d = decisions.get(entry_id)
    if d is None:
        return "OPEN", None
    if d["fingerprint"] != fingerprint:
        if d["decision"] == "CORRECT" and current_value is not None and current_value == d.get("correctedValue"):
            return "CORRECTED", d
        return "STALE_DECISION", d
    if d["decision"] == "APPROVE":
        return "APPROVED", d
    if d['decision'] == 'OWNER_APPROVED_TECHNICAL_MEDIA':
        return 'OWNER_APPROVED_TECHNICAL_MEDIA', d
    if d["decision"] == "REJECT":
        return "REJECTED", d
    return "CORRECTION_PENDING", d


def _sha_paths() -> dict:
    files = json.loads((MANIFEST_DIR / "raw_source_files.json").read_text(encoding="utf-8"))["files"]
    return {f["sha256"]: f["path"] for f in files if f.get("sha256")}


def _review_source(entry: dict, docs: list) -> dict:
    """Use the queue's recorded source; a filename never overrides hash-bound attribution."""
    return {"path": entry.get("source"), "sha256": entry.get("sha256")}


def _locate(entry: dict, pkg: dict | None, ocr_key_blocks: dict) -> tuple:
    """(page, bbox|None, method) to show the reviewer: the entry's own location, the key-table block of an
    adjudicated cell, the key page of a key entry, or the source page of the scoped stimuli."""
    first_page = re.match(r"\s*(\d+)", str(entry.get("page") or ""))
    if first_page:
        return int(first_page.group(1)), entry.get("bbox"), "ENTRY_LOCATION"
    if pkg is not None:
        items = _scope_items(entry, pkg)
        if entry.get("type") == "ANSWER_KEY":
            pages = {((sp or {}).get("acceptedAnswers") or {}).get("keySource", {}).get("page") for _, sp in items}
            pages.discard(None)
            if len(pages) == 1:
                return int(pages.pop()), None, "ANSWER_KEY_PAGE"
        gids = {it["groupId"] for it, _ in items}
        st_ids = {gs["stimulusId"] for gs in pkg.get("groupStimuli", []) if gs["groupId"] in gids}
        pages = set()
        for s in pkg.get("stimuli", []):
            if s["id"] in st_ids:
                b = s.get("bodyPayload") or {}
                for p in re.findall(r"\d+", str(b.get("sourcePages") or b.get("sourcePage") or "")):
                    pages.add(int(p))
        if pages:
            return min(pages), None, "STIMULUS_SOURCE_PAGE"
    return None, None, "UNLOCATED"


def review_queue(staging: Path, render: bool = True, only_release_candidates: bool = True) -> dict:
    from .media_qa import crop_units
    queue = json.loads((staging / "reports" / "qa_queue.json").read_text(encoding="utf-8"))
    status_rows = json.loads((staging / "reports" / "staging_status.json").read_text(encoding="utf-8"))["tests"]
    final = {r["testId"]: r.get("finalStatus") for r in status_rows}
    release_candidates = sorted(t for t, s in final.items() if s == "VALID_FULL")
    pkg_files = _package_files(staging)
    decisions, invalid = read_ledger(staging)
    pkg_cache = {tid: json.loads(pf.read_text(encoding="utf-8")) for tid, pf in pkg_files.items()}
    docs = {}
    for f in glob.glob(str(staging / "reports" / "extraction" / "*" / "*.json")):
        rep = json.loads(Path(f).read_text(encoding="utf-8"))
        docs[rep["testId"]] = rep.get("documents") or []

    media = crop_units(staging, render=render,
                       targets=None if not only_release_candidates else set(release_candidates))
    units = media["units"]
    unit_by_test_sha = {(u["testId"], u["cropSha256"]): u for u in units.values()}
    index_path = staging / "assets" / "asset_index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    sha_by_location = {}
    for rec in index.values():
        if rec.get("kind") == "IMAGE":
            for d in rec.get("derivedFrom", []):
                sha_by_location.setdefault((d.get("rawSourceSha256"), str(d.get("page"))), []).append(
                    (d.get("bbox"), rec["sha256"]))

    def crop_unit_for(e: dict, tid: str):
        sha = e.get("cropSha256")
        if not sha:
            cands = sha_by_location.get((e.get("sha256"), str(e.get("page"))), [])
            if e.get("bbox"):
                cands = [c for c in cands if c[0] and all(abs(a - b) <= 8 for a, b in zip(c[0], e["bbox"]))]
            in_pkg = [c for c in cands if (tid, c[1]) in unit_by_test_sha]
            sha = in_pkg[0][1] if len(in_pkg) == 1 else None
        return unit_by_test_sha.get((tid, sha)) if sha else None

    ocr_key_blocks = {}
    for f in glob.glob(str(staging / "reports" / "ocr_keys" / "*.json")):
        rep = json.loads(Path(f).read_text(encoding="utf-8"))
        for t in rep.get("tests", []):
            ocr_key_blocks[(rep["sha256"], t["page"], t["test"])] = t.get("blockBbox")

    packages: dict = defaultdict(lambda: {"entries": []})
    counts = Counter()
    unit_entries = defaultdict(list)
    for e in queue["entries"]:
        tids = [e["testId"]] if e.get("testId") else sorted(
            {u["testId"] for u in units.values() if u["cropSha256"] == e.get("cropSha256")}) or ["(unassigned)"]
        for tid in tids:
            rp = release_priority(e)
            counts[rp] += 1
            pkg = pkg_cache.get(tid)
            pid = pkg["manifest"]["packageId"] if pkg else None
            unit = crop_unit_for(e, tid) if e.get("type") == "IMAGE_CROP" else None
            proof = None
            for resolver in PROOF_RESOLVERS:
                proof = resolver(e, pkg)
                if proof:
                    break
            if unit is not None:
                fingerprint = unit["fingerprint"]
                status, dec = _status(unit["unitId"], fingerprint, None, decisions)
                if status == 'OWNER_APPROVED_TECHNICAL_MEDIA' and (
                        not tid.startswith(('toeic/ybm-', 'toeic/economy-'))
                        or unit['technical']['status'] != 'TECHNICALLY_VALID'):
                    status, dec = 'OPEN', None
            else:
                fingerprint = entry_fingerprint(e, pid, pkg)
                status, dec = _status(e["id"], fingerprint, proof, decisions,
                                      bound_value(e, pkg).get("keys") if e.get("type") == "ANSWER_KEY" else None)
            src = _review_source(e, docs.get(tid, []))
            page, bbox, how = _locate(e, pkg, ocr_key_blocks)
            if e.get("subtype") == "KEY_CELL_REREAD_ADJUDICATED":
                tno = int(re.search(r"test-(\d+)", tid).group(1)) if re.search(r"test-(\d+)", tid) else None
                bb = ocr_key_blocks.get((e.get("sha256"), e.get("page"), tno))
                if bb:
                    bbox, how = bb, "KEY_TABLE_BLOCK"
            row = {k: e.get(k) for k in ("id", "type", "subtype", "scope", "page", "bbox", "questions", "intervalMs",
                                         "confidence", "severity", "priority", "numberReads") if e.get(k) is not None}
            row.update({"testId": tid, "packageId": pid,
                        "packageVersion": pkg["manifest"].get("packageVersion") if pkg else None,
                        "packageContentHash": pkg["manifest"].get("contentHash") if pkg else None,
                        "sourceCollection": tid.split("/")[1].rsplit("-", 1)[0] if "/" in tid else None,
                        "sourceFile": src["path"], "sourceSha256": src["sha256"],
                        "reviewLocation": {"page": page, "bbox": bbox, "method": how},
                        "releasePriority": rp, "status": status, "fingerprint": fingerprint,
                        "whyBlocks": WHY_BLOCKS.get(rp), "validatorImpact": VALIDATOR_IMPACT.get(e.get("type"), "review"),
                        "candidateInterpretation": _candidate(e)})
            if e.get("type") in ("AUDIO_BOUNDARY", "AUDIO"):
                row["audio"] = {"parentFile": e.get("source"), "parentSha256": e.get("sha256"),
                                "intervalMs": e.get("intervalMs"), "confidence": e.get("confidence"),
                                "evidence": e.get("detail")}
            if unit is not None:
                row["cropUnitId"] = unit["unitId"]
                row["cropSha256"] = unit["cropSha256"]
                row["cropTechnical"] = unit["technical"]["status"]
                unit_entries[unit["unitId"]].append(e["id"])
            if proof:
                row["proof"] = proof
                row["resolutionMethod"] = "DETERMINISTIC_PROOF"
            if dec:
                row["decision"] = {k: dec.get(k) for k in ("decision", "reviewer", "reviewedAt")}
                if status in ("APPROVED", "CORRECTED", "REJECTED"):
                    row["resolutionMethod"] = "HUMAN_DECISION"
                elif status == 'OWNER_APPROVED_TECHNICAL_MEDIA':
                    row['resolutionMethod'] = 'OWNER_APPROVED_TECHNICAL_MEDIA'
            packages[tid]["entries"].append(row)

    # crop units without any queue entry still need a human decision before MEDIA_READY: add one entry per unit
    for u in units.values():
        if u["unitId"] in unit_entries or u["testId"] not in pkg_files:
            continue
        status, dec = _status(u["unitId"], u["fingerprint"], None, decisions)
        if status == 'OWNER_APPROVED_TECHNICAL_MEDIA' and (
                not u['testId'].startswith(('toeic/ybm-', 'toeic/economy-'))
                or u['technical']['status'] != 'TECHNICALLY_VALID'):
            status, dec = 'OPEN', None
        row = {"id": u["unitId"], "type": "IMAGE_CROP", "subtype": "CROP_REVIEW_UNIT", "testId": u["testId"],
               "packageId": u["packageId"], "packageVersion": u["packageVersion"], "releasePriority": "P2",
               "status": status, "fingerprint": u["fingerprint"], "cropUnitId": u["unitId"],
               "cropSha256": u["cropSha256"], "cropTechnical": u["technical"]["status"],
               "questions": ",".join(map(str, u["questions"])) or None, "whyBlocks": WHY_BLOCKS["P2"],
               "validatorImpact": VALIDATOR_IMPACT["IMAGE_CROP"],
               "candidateInterpretation": "rendered crop bound to the question(s); asset PENDING until approved"}
        if dec:
            row["decision"] = {k: dec.get(k) for k in ("decision", "reviewer", "reviewedAt")}
        counts["P2"] += 1
        packages[u["testId"]]["entries"].append(row)

    out_pk = {}
    for tid in sorted(set(packages) | set(pkg_files)):
        entries = packages[tid]["entries"] if tid in packages else []
        open_rows = {(r.get("cropUnitId") or r["id"]): r for r in entries if r["status"] in BLOCKING_STATUSES}
        open_by = Counter(r["releasePriority"] for r in open_rows.values())   # one per crop unit
        has_pkg = tid in pkg_files
        crop = [u for u in units.values() if u["testId"] == tid]
        unit_status = {}
        for u in crop:
            st = next((r["status"] for r in entries if r.get("cropUnitId") == u["unitId"]), "OPEN")
            unit_status[u["unitId"]] = {"cropSha256": u["cropSha256"], "technical": u["technical"]["status"],
                                        "technicalCodes": u["technical"]["codes"], "decisionStatus": st,
                                        "fingerprint": u["fingerprint"], "questions": u["questions"],
                                        "itemKeys": u["itemKeys"],
                                        "humanApproved": st == "APPROVED",
                                        "ownerTechnicalApproved": st == 'OWNER_APPROVED_TECHNICAL_MEDIA'}
        out_pk[tid] = {
            "package": str(pkg_files[tid].relative_to(staging)).replace("\\", "/") if has_pkg else None,
            "packageId": pkg_cache[tid]["manifest"]["packageId"] if has_pkg else None,
            "finalStatus": final.get(tid),
            "entries": entries,
            "cropUnits": unit_status,
            "openByReleasePriority": dict(sorted(open_by.items())),
            "qaApproved": has_pkg and not any(open_by.get(k) for k in BLOCKING_RELEASE_PRIORITIES),
        }
    statuses = Counter(r["status"] for p in out_pk.values() for r in p["entries"])
    resolved = Counter(r.get("resolutionMethod") for p in out_pk.values() for r in p["entries"] if r.get("resolutionMethod"))
    result = {
        "generatedBy": "scripts/exam_extractor/qa_review.py (Exams Recovery Phase 4A / 4.1A)",
        "rules": {"blockingReleasePriorities": list(BLOCKING_RELEASE_PRIORITIES),
                  "blockingStatuses": list(BLOCKING_STATUSES),
                  "resolution": "DETERMINISTIC_PROOF (single interpretation, re-verified on the package) or a "
                                "fingerprinted human decision in qa/approvals.json; never automatic approval",
                  "decisionFormat": {"entryId": "queue entry id or crop unit id", "decision": list(DECISIONS),
                                     "reviewer": "required", "reviewedAt": "required (ISO-8601)",
                                     "fingerprint": "required (from the reviewer sheet)",
                                     "correctedValue": "CORRECT only", "note": "optional"}},
        "summary": {
            "queueEntries": len(queue["entries"]),
            "reviewRows": sum(len(p["entries"]) for p in out_pk.values()),
            "byReleasePriority": dict(sorted(counts.items())),
            "byStatus": dict(sorted(statuses.items())),
            "byResolutionMethod": dict(sorted(resolved.items())),
            "decisionsValid": len(decisions),
            "decisionsInvalid": invalid,
            "staleDecisions": sorted({r["id"] for p in out_pk.values() for r in p["entries"] if r["status"] == "STALE_DECISION"}),
            "releaseCandidates": release_candidates,
            "releaseCandidateOpen": {t: out_pk.get(t, {}).get("openByReleasePriority", {}) for t in release_candidates},
            "qaApprovedPackages": sorted(t for t, p in out_pk.items() if p["qaApproved"] and p["package"]),
        },
        "packages": out_pk,
        "note": "codes, locations, fingerprints and counts only; local reviewer sheets: imports/exams/staging/qa/review/ (untracked)",
    }
    _write_json(staging / "reports" / "qa_release_review.json", result)
    _write_json(staging / "reports" / "release_candidate_blockers.json", candidate_blockers(result, media))
    if render:
        targets = release_candidates if only_release_candidates else sorted(out_pk)
        _render_sheets(staging, targets, out_pk, pkg_cache)
    return result


def candidate_blockers(review: dict, media: dict) -> dict:
    """Exact open QA blockers per release candidate (Phase 4.1A) — never buried in the global queue."""
    out = {}
    for tid in review["summary"]["releaseCandidates"]:
        p = review["packages"].get(tid, {})
        blockers = []
        for r in sorted(p.get("entries", []), key=lambda x: (x["releasePriority"], x.get("subtype") or "", x["id"])):
            if r["status"] not in BLOCKING_STATUSES or r["releasePriority"] not in BLOCKING_RELEASE_PRIORITIES:
                continue
            unit = (p.get("cropUnits") or {}).get(r.get("cropUnitId") or "")
            questions = (",".join(map(str, unit["questions"])) or ",".join(unit.get("itemKeys") or [])) if unit                 else r.get("questions")
            blockers.append({"id": r["id"], "priority": r["releasePriority"], "type": r["type"], "subtype": r.get("subtype"),
                             "scope": r.get("scope"), "questions": questions, "status": r["status"],
                             "cropUnitId": r.get("cropUnitId"), "cropTechnical": r.get("cropTechnical")})
        # one blocker per crop unit (several queue entries can describe the same crop)
        seen, compact = set(), []
        for b in blockers:
            key = b["cropUnitId"] or b["id"]
            if key in seen:
                continue
            seen.add(key)
            compact.append(b)
        units = p.get("cropUnits", {})
        out[tid] = {"packageId": p.get("packageId"), "qaApproved": p.get("qaApproved"),
                    "openBlockers": compact,
                    "openByPriority": dict(Counter(b["priority"] for b in compact)),
                    "cropUnits": len(units),
                    "cropUnitsTechnicallyValid": sum(1 for u in units.values() if u["technical"] == "TECHNICALLY_VALID"),
                    "cropUnitsHumanApproved": sum(1 for u in units.values() if u["humanApproved"]),
                    "requiresHumanOnly": all(b["status"] == "OPEN" for b in compact)
                                         and all(u["technical"] == "TECHNICALLY_VALID" for u in units.values())}
    return {"generatedBy": "scripts/exam_extractor/qa_review.py (Exams Recovery Phase 4.1A)", "candidates": out,
            "note": "codes only; open the LOCAL sheets qa/review/<book>__test-<n>/index.html + media.html"}


def _candidate(e: dict) -> str:
    t, st = e.get("type"), e.get("subtype")
    if t == "ANSWER_KEY":
        return "bound key in package (letters withheld in reports; shown on the local sheet)"
    if t == "IMAGE_CROP":
        return "rendered crop bound to the question(s); asset PENDING until approved"
    if st == "LAYOUT_LINEARIZED":
        return "documents kept in one stimulus (NOT_SEGMENTED); runner shows a boundaries-under-review notice"
    if st == "OPTION_LABEL_RECOGNISED":
        return "option label recovered by a constrained re-read matching the A-D sequence"
    if st == "OPTION_LABEL_RESTORED":
        return "label absent from the text layer, restored by the announced range + option-grid lattice"
    return e.get("detail") or st or t or "review"


def _render_sheets(staging: Path, targets: list, out_pk: dict, pkg_cache: dict) -> None:
    try:
        from .pdf_layer import PdfTextLayer
    except Exception:  # pragma: no cover - rendering is optional
        return
    sha_paths = _sha_paths()
    layers: dict = {}
    for tid in targets:
        p = out_pk.get(tid)
        if not p or not p["entries"]:
            continue
        book_test = tid.split("/", 1)[1].replace("/", "__")
        out_dir = staging / "qa" / "review" / book_test
        out_dir.mkdir(parents=True, exist_ok=True)
        pkg = pkg_cache.get(tid)
        rows = []
        for r in p["entries"]:
            img = None
            if r.get("cropUnitId"):
                rows.append((r, None, _bound_values(r, pkg)))       # the crop itself is on media.html
                continue
            sha = r.get("sourceSha256")
            loc = r.get("reviewLocation") or {}
            page = loc.get("page")
            if sha in sha_paths and page:
                try:
                    layer = layers.get(sha) or PdfTextLayer(raw_abs(sha_paths[sha]), sha_paths[sha], sha)
                    layers[sha] = layer
                    pg = int(page)
                    if loc.get("bbox"):
                        x0, y0, x1, y1 = loc["bbox"]
                        w, h = layer.page_size(pg)
                        png, _, _ = layer.render_region(pg, (max(0, x0 - 18), max(0, y0 - 18), min(w, x1 + 18),
                                                             min(h, y1 + 18)), dpi=150)
                    else:
                        w, h = layer.page_size(pg)
                        png, _, _ = layer.render_region(pg, (0, 0, w, h), dpi=80)   # one page, low resolution
                    img = f"{r['id']}.png"
                    (out_dir / img).write_bytes(png)
                except Exception:
                    img = None
            rows.append((r, img, _bound_values(r, pkg)))
        _write_html(out_dir / "index.html", tid, rows)
        produced = {img for _r, img, _b in rows if img}
        for old in out_dir.glob("*.png"):                  # superseded previews of this generated sheet only
            if re.fullmatch(r"[0-9a-f]{16}\.png", old.name) and old.name not in produced:
                old.unlink()


def _bound_values(r: dict, pkg: dict | None) -> str:
    if pkg is None or r.get("type") != "ANSWER_KEY":
        return ""
    skill = (r.get("scope") or "").split("/")[-1] or None
    by_num = _items_by_number(pkg, skill if skill in ("LISTENING", "READING") else None)
    vals = []
    for n in _numbers(r.get("questions")):
        it, spec = by_num.get(n, (None, None))
        if spec:
            vals.append(f"Q{n}: {', '.join(_accepted(spec))}")
    return "; ".join(vals)


def _write_html(path: Path, tid: str, rows: list) -> None:
    parts = [f"<!doctype html><meta charset='utf-8'><title>QA review {html.escape(tid)}</title>",
             "<style>body{font:14px system-ui;margin:16px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}"
             "table{border-collapse:collapse;width:100%}img{max-width:460px}code{font-size:11px;word-break:break-all}</style>",
             f"<h1>QA review — {html.escape(tid)}</h1><p>LOCAL ONLY — never commit or publish. Crops: see "
             "<a href='media.html'>media.html</a>. Record a decision in imports/exams/staging/qa/approvals.json as "
             "<code>{\"decisions\": [{\"entryId\", \"decision\": \"APPROVE\"|\"REJECT\"|\"CORRECT\", \"reviewer\", "
             "\"reviewedAt\", \"fingerprint\", \"correctedValue\"?, \"note\"?}]}</code> — copy the fingerprint shown "
             "here; it becomes stale when the source or the packaged value changes.</p>",
             "<table><tr><th>entry / fingerprint</th><th>release</th><th>status</th><th>code</th><th>source</th>"
             "<th>where</th><th>bound value</th><th>why it blocks</th><th>source crop</th></tr>"]
    for r, img, bound in sorted(rows, key=lambda x: (x[0]["releasePriority"], x[0]["id"])):
        loc = r.get("reviewLocation") or {}
        where = (f"page {loc.get('page', r.get('page', '?'))} bbox {loc.get('bbox') or r.get('bbox') or '-'} "
                 f"({loc.get('method', '-')}) Q{r.get('questions', '-')} {r.get('scope') or ''}")
        if r.get("audio"):
            where += f" audio {r['audio'].get('intervalMs')} ({r['audio'].get('confidence')})"
        if r.get("cropUnitId"):
            where += f" → crop unit {r['cropUnitId']} ({r.get('cropTechnical')})"
        src = f"{r.get('sourceFile') or '-'} sha256 {str(r.get('sourceSha256') or '')[:16]}…"
        parts.append("<tr>" + f"<td>{html.escape(r['id'])}<br><code>{html.escape(r.get('fingerprint') or '')}</code></td>" +
                     "".join(f"<td>{html.escape(str(v))}</td>" for v in (
                         r["releasePriority"], r["status"], f"{r.get('type')}/{r.get('subtype')}", src, where,
                         bound or r.get("candidateInterpretation") or "", r.get("whyBlocks") or "")) +
                     (f"<td><img src='{html.escape(img)}' alt='source'></td>" if img else "<td>-</td>") + "</tr>")
    parts.append("</table>")
    path.write_text("\n".join(parts), encoding="utf-8")
