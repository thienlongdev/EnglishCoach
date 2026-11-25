"""Exams Recovery Phase 4.1B — media crop QA: deterministic TECHNICAL checks, crop review units, fingerprints and
LOCAL contact sheets for human review.

Technical checks (never a human approval): the raw source still has its recorded SHA-256, the page exists, the bbox is
inside the page, the derived PNG decodes, has non-zero size, the right MIME signature and a stable SHA-256 (file bytes
== asset hash == index hash), is not blank, is not overwhelmingly whitespace, is bound to at least one question group,
and is not bound to two different question groups unless both groups print it on the crop's own source page.
A crop that passes is TECHNICALLY_VALID. VALIDATED requires a current-fingerprint
APPROVE, or the owner's standing OWNER_APPROVED_TECHNICAL_MEDIA decision for complete
YBM/Economy TOEIC packages. The latter retains humanReviewed=false; it is never human QA.

A crop review unit = one crop (SHA-256) bound in one test. Its fingerprint covers what a reviewer actually judged: the
raw source hash, page, bbox, crop hash, the package id and the binding (questions, stimulus kinds, asset roles). It
deliberately excludes the package content hash / extractor version / validation state, so an unrelated re-extraction
does not invalidate a decision while any change to the crop or its binding does.

Outputs: reports/media_crop_validation.json (codes, hashes, numbers — no exam text) and LOCAL review sheets
qa/review/<book>__test-<n>/media.html (+ context / crop PNGs; untracked, never committed or published).
"""
from __future__ import annotations

import glob
import hashlib
import html
import io
import json
from pathlib import Path
from typing import Optional

from .canonical_json import canonical_bytes
from .corpus import HashCache, raw_abs
from .staging import _write_json

CROP_TECH_VERSION = "crop-tech-1"
WHITESPACE_FAIL_RATIO = 0.98     # >= 98 % near-white pixels => overwhelmingly whitespace (max observed crop: 94 %)
BLANK_STDDEV = 3.0               # grey-level standard deviation below this => blank
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
BBOX_TOLERANCE = 1.0             # points


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def package_files(staging: Path) -> dict:
    out = {}
    for f in glob.glob(str(staging / "extracted" / "**" / "*.json"), recursive=True):
        p = Path(f)
        book, _, test = p.stem.partition("__")
        fam = "toeic" if "toeic" in p.parts else "ielts"
        out[f"{fam}/{book}/{test}"] = p
    return out


def image_bindings(pkg: dict) -> list:
    """Every image asset of a package with what it is bound to (no text)."""
    stimuli = {s["id"]: s for s in pkg.get("stimuli", [])}
    groups_of = {}
    for gs in pkg.get("groupStimuli", []):
        groups_of.setdefault(gs["stimulusId"], set()).add(gs["groupId"])
    items_of = {}
    for it in pkg.get("items", []):
        items_of.setdefault(it["groupId"], []).append(it)
    out = []
    for a in pkg.get("assets", []):
        if not str(a.get("mimeType", "")).startswith("image/"):
            continue
        roles, kinds, gids, pages = set(), set(), set(), set()
        for sa in pkg.get("stimulusAssets", []):
            if sa["assetId"] != a["id"]:
                continue
            roles.add(sa.get("role"))
            st = stimuli.get(sa["stimulusId"])
            if st is None:
                continue
            kinds.add(st.get("kind"))
            body = st.get("bodyPayload") or {}
            if body.get("sourcePage") is not None:
                pages.add(str(body["sourcePage"]))
            gids |= groups_of.get(st["id"], set())
        questions, item_keys = set(), set()
        for g in gids:
            for it in items_of.get(g, []):
                qn = (it.get("optionDefinitions") or {}).get("questionNumber")
                if qn is not None:
                    questions.add(int(qn))
                item_keys.add(it.get("logicalItemKey"))
        out.append({"assetId": a["id"], "sha256": a.get("sha256Hash"), "mimeType": a.get("mimeType"),
                    "validationState": a.get("validationState"), "roles": sorted(r for r in roles if r),
                    "stimulusKinds": sorted(k for k in kinds if k), "groupIds": sorted(gids),
                    "questions": sorted(questions), "itemKeys": sorted(k for k in item_keys if k),
                    "stimulusSourcePages": sorted(pages)})
    return out


def unit_id(test_id: str, crop_sha: str) -> str:
    return "CROP-" + _sha(f"{test_id}|{crop_sha}".encode())[:16]


def unit_fingerprint(test_id: str, package_id: str, binding: dict, derived: Optional[dict]) -> str:
    core = {"testId": test_id, "packageId": package_id, "cropSha256": binding.get("sha256"),
            "rawSourceSha256": (derived or {}).get("rawSourceSha256"), "page": (derived or {}).get("page"),
            "bbox": (derived or {}).get("bbox"), "questions": binding.get("questions"),
            "itemKeys": binding.get("itemKeys"), "stimulusKinds": binding.get("stimulusKinds"),
            "roles": binding.get("roles")}
    return "sha256:" + _sha(canonical_bytes(core))


def _derived_for(index: dict, sha: str) -> Optional[dict]:
    rec = index.get(f"extracted/images/{sha}.png")
    if not rec or not rec.get("derivedFrom"):
        return None
    return rec["derivedFrom"][0]


class _Layers:
    def __init__(self):
        self.cache = {}

    def get(self, path: str, sha: str):
        if path not in self.cache:
            from .pdf_layer import PdfTextLayer
            self.cache[path] = PdfTextLayer(raw_abs(path), path, sha)
        return self.cache[path]


def technical_check(staging: Path, index: dict, binding: dict, all_bindings: list, hashes: HashCache,
                    layers: _Layers) -> dict:
    """Deterministic checks of ONE crop; returns {status, codes, checks}. Reads raw sources read-only."""
    sha = binding["sha256"] or ""
    checks, codes = {}, []
    rec = index.get(f"extracted/images/{sha}.png")
    derived = _derived_for(index, sha)
    checks["indexed"] = rec is not None and rec.get("sha256") == sha
    if not checks["indexed"]:
        codes.append("CROP_NOT_IN_ASSET_INDEX")
    if derived is None:
        codes.append("CROP_PROVENANCE_MISSING")
    else:
        try:
            full = raw_abs(derived["rawSourcePath"])
            checks["sourceHashMatches"] = full.is_file() and hashes.sha256(full) == derived["rawSourceSha256"]
        except Exception:
            checks["sourceHashMatches"] = False
        if not checks["sourceHashMatches"]:
            codes.append("SOURCE_HASH_MISMATCH")
        else:
            layer = layers.get(derived["rawSourcePath"], derived["rawSourceSha256"])
            page = int(derived.get("page") or 0)
            checks["pageExists"] = 1 <= page <= layer.page_count
            if not checks["pageExists"]:
                codes.append("SOURCE_PAGE_MISSING")
            else:
                w, h = layer.page_size(page)
                x0, y0, x1, y1 = derived.get("bbox") or (0, 0, 0, 0)
                t = BBOX_TOLERANCE
                checks["bboxInsidePage"] = (-t <= x0 < x1 <= w + t) and (-t <= y0 < y1 <= h + t)
                if not checks["bboxInsidePage"]:
                    codes.append("BBOX_OUTSIDE_PAGE")
    staged = staging / "assets" / "images" / f"{sha}.png"
    data = staged.read_bytes() if staged.is_file() else b""
    checks["fileExists"] = bool(data)
    checks["mimeSignature"] = data.startswith(PNG_SIGNATURE) and binding.get("mimeType") == "image/png"
    checks["sha256Stable"] = bool(data) and _sha(data) == sha
    if not checks["fileExists"]:
        codes.append("CROP_FILE_MISSING")
    elif not checks["mimeSignature"]:
        codes.append("CROP_MIME_MISMATCH")
    if data and not checks["sha256Stable"]:
        codes.append("CROP_HASH_UNSTABLE")
    width = height = 0
    if data:
        try:
            from PIL import Image, ImageStat
            im = Image.open(io.BytesIO(data))
            im.load()
            width, height = im.size
            grey = im.convert("L")
            hist = grey.histogram()
            n = sum(hist) or 1
            white = sum(hist[246:]) / n
            std = ImageStat.Stat(grey).stddev[0]
            checks.update({"decodes": True, "width": width, "height": height,
                           "nearWhiteRatio": round(white, 4), "greyStddev": round(std, 2)})
            if width <= 0 or height <= 0:
                codes.append("CROP_ZERO_SIZE")
            if std < BLANK_STDDEV:
                codes.append("CROP_BLANK")
            elif white >= WHITESPACE_FAIL_RATIO:
                codes.append("CROP_OVERWHELMINGLY_WHITESPACE")
        except Exception:
            checks["decodes"] = False
            codes.append("CROP_DECODE_FAILED")
    checks["bound"] = bool(binding.get("groupIds"))
    if not checks["bound"]:
        codes.append("CROP_NOT_BOUND")
    same = [b for b in all_bindings if b["sha256"] == sha]
    groups = {g for b in same for g in b["groupIds"]}
    if len(groups) > 1:
        page = str((derived or {}).get("page"))
        reuse = all(page in b["stimulusSourcePages"] for b in same) and page != "None"
        checks["duplicateBinding"] = "REUSE_PROVEN_SAME_SOURCE_PAGE" if reuse else "UNPROVEN"
        if not reuse:
            codes.append("DUPLICATE_CROP_BINDING")
    return {"status": "TECHNICALLY_VALID" if not codes else "TECHNICAL_FAIL", "codes": codes, "checks": checks,
            "derivedFrom": derived, "dimensions": f"{width}x{height}" if width else None}


def crop_units(staging: Path, render: bool = False, targets: Optional[set] = None) -> dict:
    """Build every crop review unit + technical result; write reports/media_crop_validation.json."""
    index_path = staging / "assets" / "asset_index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    hashes = HashCache(staging / "cache" / "raw_hashes.json")
    layers = _Layers()
    units = {}
    for tid, pf in sorted(package_files(staging).items()):
        pkg = json.loads(pf.read_text(encoding="utf-8"))
        bindings = image_bindings(pkg)
        pid = pkg["manifest"]["packageId"]
        for b in bindings:
            tech = technical_check(staging, index, b, bindings, hashes, layers)
            uid = unit_id(tid, b["sha256"])
            units[uid] = {"unitId": uid, "testId": tid, "packageId": pid,
                          "packageVersion": pkg["manifest"].get("packageVersion"),
                          "assetId": b["assetId"], "cropSha256": b["sha256"], "validationState": b["validationState"],
                          "roles": b["roles"], "stimulusKinds": b["stimulusKinds"], "questions": b["questions"],
                          "itemKeys": b["itemKeys"], "technical": tech,
                          "fingerprint": unit_fingerprint(tid, pid, b, tech["derivedFrom"])}
    hashes.save()
    by_status = {}
    for u in units.values():
        by_status[u["technical"]["status"]] = by_status.get(u["technical"]["status"], 0) + 1
    out = {"generatedBy": "scripts/exam_extractor/media_qa.py (Exams Recovery Phase 4.1B)",
           "checkVersion": CROP_TECH_VERSION,
           "thresholds": {"whitespaceFailRatio": WHITESPACE_FAIL_RATIO, "blankStddev": BLANK_STDDEV},
           "summary": {"cropUnits": len(units), "byTechnicalStatus": by_status,
                       "technicalStatusIsNotHumanApproval": True},
           "units": units,
           "note": "codes, hashes and numbers only; TECHNICALLY_VALID never means human-approved"}
    _write_json(staging / "reports" / "media_crop_validation.json", out)
    if render:
        render_contact_sheets(staging, units, layers, targets)
    return out


def classify_role(u: dict) -> str:
    kinds = set(u.get("stimulusKinds") or [])
    tid = u.get("testId") or ""
    if tid.startswith("ielts/") and any(k.startswith("RAW_") and "_W" in k for k in u.get("itemKeys") or []):
        return "IELTS_WRITING_TASK1_VISUAL"
    if tid.startswith("toeic/"):
        qs = u.get("questions") or []
        if qs and max(qs) <= 6:
            return "TOEIC_PART1_PHOTO"
        return "TOEIC_PART34_GRAPHIC"
    if "MAP" in kinds:
        return "MAP"
    if "DIAGRAM" in kinds:
        return "DIAGRAM"
    if "CHART" in kinds:
        return "CHART"
    return "IMAGE"


def render_contact_sheets(staging: Path, units: dict, layers: _Layers, targets: Optional[set] = None) -> None:
    """Per test: source page context (crop bbox outlined) + extracted crop + questions + role. LOCAL ONLY."""
    from PIL import Image, ImageDraw
    by_test = {}
    for u in units.values():
        if targets is None or u["testId"] in targets:
            by_test.setdefault(u["testId"], []).append(u)
    for tid, us in by_test.items():
        out_dir = staging / "qa" / "review" / tid.split("/", 1)[1].replace("/", "__")
        out_dir.mkdir(parents=True, exist_ok=True)
        rows = []
        for u in sorted(us, key=lambda x: (x["questions"] or [0])[0]):
            d = u["technical"].get("derivedFrom") or {}
            ctx_name = None
            if d.get("rawSourcePath") and u["technical"]["checks"].get("pageExists"):
                try:
                    layer = layers.get(d["rawSourcePath"], d["rawSourceSha256"])
                    page = int(d["page"])
                    w, h = layer.page_size(page)
                    x0, y0, x1, y1 = d["bbox"]
                    m = 72.0                                   # one inch of surrounding context, never the whole book
                    clip = (max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m))
                    dpi = 100
                    png, _, _ = layer.render_region(page, clip, dpi=dpi)
                    im = Image.open(io.BytesIO(png)).convert("RGB")
                    s = dpi / 72.0
                    ImageDraw.Draw(im).rectangle([(x0 - clip[0]) * s, (y0 - clip[1]) * s, (x1 - clip[0]) * s,
                                                  (y1 - clip[1]) * s], outline=(220, 0, 0), width=3)
                    ctx_name = f"{u['unitId']}__context.png"
                    im.save(out_dir / ctx_name)
                except Exception:
                    ctx_name = None
            crop_src = staging / "assets" / "images" / f"{u['cropSha256']}.png"
            crop_name = None
            if crop_src.is_file():
                crop_name = f"{u['unitId']}__crop.png"
                (out_dir / crop_name).write_bytes(crop_src.read_bytes())
            rows.append((u, ctx_name, crop_name))
        _write_media_html(out_dir / "media.html", tid, rows)
        produced = {n for _u, c, k in rows for n in (c, k) if n}
        for old in out_dir.glob("CROP-*__*.png"):          # superseded crops of this generated sheet only
            if old.name not in produced:
                old.unlink()


def _write_media_html(path: Path, tid: str, rows: list) -> None:
    parts = [f"<!doctype html><meta charset='utf-8'><title>Crop review {html.escape(tid)}</title>",
             "<style>body{font:14px system-ui;margin:16px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}"
             "table{border-collapse:collapse;width:100%}img{max-width:460px}code{font-size:12px}</style>",
             f"<h1>Crop review — {html.escape(tid)}</h1>",
             "<p>LOCAL ONLY — never commit or publish. For each unit: is the outlined region the complete, correct "
             "figure for the listed questions? Record a decision in imports/exams/staging/qa/approvals.json: "
             "<code>{\"entryId\": &lt;unit id&gt;, \"decision\": \"APPROVE\"|\"REJECT\"|\"CORRECT\", \"reviewer\", "
             "\"reviewedAt\", \"fingerprint\": &lt;fingerprint below&gt;, \"note\"}</code>. A decision whose "
             "fingerprint no longer matches is ignored (stale).</p>",
             "<table><tr><th>unit</th><th>role</th><th>questions</th><th>technical</th><th>source context "
             "(red = crop bbox)</th><th>extracted crop</th></tr>"]
    for u, ctx, crop in rows:
        d = u["technical"].get("derivedFrom") or {}
        meta = (f"{html.escape(u['unitId'])}<br><code>{html.escape(u['fingerprint'])}</code><br>"
                f"{html.escape(str(d.get('rawSourcePath')))}<br>sha256 {html.escape(str(d.get('rawSourceSha256'))[:16])}…"
                f"<br>page {html.escape(str(d.get('page')))} bbox {html.escape(str(d.get('bbox')))}")
        tech = html.escape(u["technical"]["status"] + (" " + ",".join(u["technical"]["codes"]) if u["technical"]["codes"] else ""))
        parts.append("<tr>" + f"<td>{meta}</td><td>{html.escape(classify_role(u))}<br>{html.escape(','.join(u['roles']))}</td>"
                     f"<td>{html.escape(','.join(map(str, u['questions'])) or ','.join(u['itemKeys']))}</td><td>{tech}</td>"
                     + (f"<td><img src='{html.escape(ctx)}' alt='context'></td>" if ctx else "<td>-</td>")
                     + (f"<td><img src='{html.escape(crop)}' alt='crop'></td>" if crop else "<td>-</td>") + "</tr>")
    parts.append("</table>")
    path.write_text("\n".join(parts), encoding="utf-8")


def record_owner_technical_crops(pkg: dict, test_id: str, staging: Path) -> int:
    """Apply the owner's explicit standing YBM/Economy decision to current technical facts.

    This records technical authorization, never a per-crop human review. The
    local owner decision file is not supplied by an uploaded package.
    """
    from datetime import datetime, timezone
    from .qa_review import load_decisions
    from .toeic_completeness import assert_valid_source_parts
    policy_path = staging / 'qa' / 'owner-technical-media-authorization.json'
    if not policy_path.is_file() or not test_id.startswith(('toeic/ybm-', 'toeic/economy-')):
        return 0
    policy = json.loads(policy_path.read_text(encoding='utf-8'))
    if (policy.get('basis') != 'OWNER_APPROVED_TECHNICAL_MEDIA' or not policy.get('ownerDecisionRef')
            or policy.get('humanReviewed') is not False or policy.get('authorizedBy') != 'PROJECT_OWNER'):
        return 0
    assert_valid_source_parts(pkg, require_full=len(pkg['items'])==200, require_audio=len(pkg['items'])==200)
    index_path = staging / 'assets' / 'asset_index.json'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    hashes = HashCache(staging / 'cache' / 'raw_hashes.json')
    layers, bindings = _Layers(), image_bindings(pkg)
    path = staging / 'qa' / 'approvals.json'
    ledger = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {'decisions': []}
    old = load_decisions(staging)
    count = 0
    for binding in bindings:
        technical = technical_check(staging, index, binding, bindings, hashes, layers)
        if technical['status'] != 'TECHNICALLY_VALID':
            continue
        uid = unit_id(test_id, binding['sha256'])
        fingerprint = unit_fingerprint(test_id, pkg['manifest']['packageId'], binding, technical['derivedFrom'])
        previous = old.get(uid)
        if previous and previous.get('fingerprint') == fingerprint:
            continue
        ledger.setdefault('decisions', []).append(dict(entryId=uid, decision='OWNER_APPROVED_TECHNICAL_MEDIA',
            reviewer='PROJECT_OWNER', reviewedAt=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
            fingerprint=fingerprint, ownerDecisionRef=policy['ownerDecisionRef'], humanReviewed=False,
            note='Standing owner authorization; automated technical checks passed; no per-crop human review.'))
        count += 1
    if count:
        _write_json(path, ledger)
    hashes.save()
    return count


def apply_crop_decisions(pkg: dict, test_id: str, staging: Path) -> int:
    """Package builder hook: an image asset becomes VALIDATED only when (a) its crop passes every technical check
    and (b) an authorized crop decision is recorded with the CURRENT unit fingerprint. Returns the
    number of assets validated. Never validates on a technical result alone."""
    from .qa_review import load_decisions
    decisions = load_decisions(staging)
    if not decisions:
        return 0
    index_path = staging / "assets" / "asset_index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    hashes = HashCache(staging / "cache" / "raw_hashes.json")
    layers = _Layers()
    bindings = image_bindings(pkg)
    pid = pkg["manifest"]["packageId"]
    n = 0
    for b in bindings:
        uid = unit_id(test_id, b["sha256"])
        dec = decisions.get(uid)
        if not dec or dec["decision"] not in ("APPROVE", "OWNER_APPROVED_TECHNICAL_MEDIA"):
            continue
        owner_technical = dec["decision"] == "OWNER_APPROVED_TECHNICAL_MEDIA"
        if owner_technical and not (test_id.startswith(('toeic/ybm-', 'toeic/economy-'))
                                    and dec.get('ownerDecisionRef')
                                    and dec.get('humanReviewed') is False):
            continue
        tech = technical_check(staging, index, b, bindings, hashes, layers)
        if tech["status"] != "TECHNICALLY_VALID":
            continue
        if dec.get("fingerprint") != unit_fingerprint(test_id, pid, b, tech["derivedFrom"]):
            continue                                            # stale decision: the crop or its binding changed
        for a in pkg["assets"]:
            if a["id"] == b["assetId"] and a.get("validationState") != "VALIDATED":
                a["validationState"] = "VALIDATED"
                n += 1
        if owner_technical:
            records = pkg['manifest'].setdefault('metadata', {}).setdefault('technicalMediaApprovals', {})
            records[uid] = {'basis': 'OWNER_APPROVED_TECHNICAL_MEDIA',
                            'ownerDecisionRef': dec['ownerDecisionRef'],
                            'recordedAt': dec['reviewedAt'], 'fingerprint': dec['fingerprint'],
                            'humanReviewed': False, 'technicalChecks': tech['checks']}
    metadata = pkg['manifest'].get('metadata', {})
    if metadata.get('technicalMediaApprovals'):
        all_valid = all(a.get('validationState') == 'VALIDATED' for a in pkg['assets']
                        if str(a.get('mimeType', '')).startswith('image/'))
        metadata['visualQAStatus'] = ('OWNER_APPROVED_TECHNICAL_MEDIA' if all_valid
                                      else 'PARTIAL_OWNER_TECHNICAL_MEDIA')
    hashes.save()
    return n
