"""Media binding: raw audio (Phase 1 manifest mapping) and visuals rendered from source pages.

Audio is NEVER copied: a staged asset references the raw file (or zip member) by path + SHA-256 and gets a
content-addressed object key (extracted/audio/<sha256>.<ext>). Rendered visuals are new derived files and are
written once, deduplicated by hash, to imports/exams/staging/assets/images/<sha256>.png.

Automated technical QA (decodable, duration agrees with the manifest, hash verified, mapping confidence) decides
whether an audio asset may be VALIDATED; anything else stays PENDING. Human audio QA is still required before
publication (recorded in the package metadata).
"""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Optional

from .corpus import HashCache, raw_abs, raw_rel
from .diagnostics import AMBIGUOUS, CONFIDENT, PROBABLE, UNRESOLVED, DiagnosticLog
from .model import AudioBinding, Figure

try:
    import mutagen  # type: ignore
except Exception:  # pragma: no cover
    mutagen = None

MIME_BY_EXT = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".png": "image/png"}

# IELTS listening part (section) recordings: plausible duration window in seconds.
IELTS_PART_SECONDS = (120, 1200)
TOEIC_PART_SECONDS = (60, 1500)
WHOLE_LISTENING_SECONDS = (900, 3600)


class AssetStore:
    """Content-addressed staging asset index (no media duplication)."""

    def __init__(self, staging_root: Path):
        self.root = staging_root
        self.images = staging_root / "assets" / "images"
        self.index_path = staging_root / "assets" / "asset_index.json"
        self.index = {}
        if self.index_path.exists():
            try:
                self.index = json.loads(self.index_path.read_text(encoding="utf-8"))
            except Exception:
                self.index = {}

    def put_image(self, png: bytes, provenance: dict) -> tuple:
        sha = hashlib.sha256(png).hexdigest()
        self.images.mkdir(parents=True, exist_ok=True)
        path = self.images / f"{sha}.png"
        if not path.exists():
            path.write_bytes(png)
        key = f"extracted/images/{sha}.png"
        rec = self.index.setdefault(key, {"kind": "IMAGE", "sha256": sha, "byteSize": len(png),
                                          "stagedPath": f"imports/exams/staging/assets/images/{sha}.png",
                                          "derivedFrom": []})
        if provenance not in rec["derivedFrom"]:
            rec["derivedFrom"].append(provenance)
        return key, sha, path

    def register_audio(self, binding: AudioBinding) -> str:
        ext = Path(binding.path.split("::")[-1]).suffix.lower() or ".mp3"
        key = f"extracted/audio/{binding.sha256}{ext}"
        rec = self.index.setdefault(key, {"kind": "AUDIO", "sha256": binding.sha256, "byteSize": binding.byte_size,
                                          "durationMs": binding.duration_ms, "rawSources": []})
        if binding.derived:
            # derived Part segment: the raw parent is referenced, the staged copy is the only new file
            rec["stagedPath"] = binding.derived["stagedPath"]
            prov = {k: binding.derived[k] for k in ("parentPath", "parentSha256", "startMs", "endMs", "method")}
            rec.setdefault("derivedFrom", [])
            if prov not in rec["derivedFrom"]:
                rec["derivedFrom"].append(prov)
            return key
        src = binding.path
        if src not in rec["rawSources"]:
            rec["rawSources"].append(src)
        return key

    def save(self) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(json.dumps(self.index, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8")


def _probe_duration(data_or_path) -> Optional[float]:
    if mutagen is None:
        return None
    try:
        f = mutagen.File(data_or_path)
        if f is not None and getattr(f, "info", None) is not None:
            return float(f.info.length)
    except Exception:
        return None
    return None


def bind_audio(test_raw: dict, family: str, hashes: HashCache, log: DiagnosticLog, scope: str = "LISTENING") -> list:
    """Phase 1 audio tracks of a test -> verified AudioBindings (per section/part, or whole test)."""
    out = []
    for a in test_raw.get("audio", []):
        conf = a.get("confidence") or UNRESOLVED
        src = a["source"]
        member = a.get("archive_member")
        try:
            full = raw_abs(src)
        except ValueError:
            log.add("SOURCE_AUDIO_UNMAPPED", scope, "path outside raw corpus")
            continue
        if not full.exists():
            log.add("SOURCE_AUDIO_UNMAPPED", scope, "raw audio file missing")
            continue
        qa = {"hashVerified": False, "decodable": False, "durationAgrees": False, "mappingConfidence": conf}
        if member:
            try:
                with zipfile.ZipFile(full) as z:   # read-only
                    data = z.read(member)
            except Exception:
                log.add("SOURCE_AUDIO_UNMAPPED", scope, "archive member unreadable")
                continue
            sha = hashlib.sha256(data).hexdigest()
            size = len(data)
            dur = _probe_duration(io.BytesIO(data))
            path_ref = f"{raw_rel(src)}::{member}"
            ext = Path(member).suffix.lower()
            qa["hashVerified"] = True  # computed from the member bytes just read
        else:
            sha = hashes.sha256(full)
            size = full.stat().st_size
            dur = _probe_duration(str(full))
            path_ref = raw_rel(src)
            ext = full.suffix.lower()
            qa["hashVerified"] = (a.get("sha256") in (None, sha))
            if a.get("sha256") and a["sha256"] != sha:
                log.add("SOURCE_HASH_MISMATCH", scope, "audio changed since Phase 1 manifest")
                continue
        manifest_dur = a.get("duration_s")
        qa["decodable"] = dur is not None and dur > 0
        if dur is None and manifest_dur:
            dur = float(manifest_dur)
        qa["durationAgrees"] = bool(dur and manifest_dur and abs(dur - float(manifest_dur)) <= 2.0) or (manifest_dur is None and bool(dur))
        if not dur:
            log.add("SOURCE_AUDIO_UNMAPPED", scope, "audio duration unknown")
            continue
        out.append(AudioBinding(path=path_ref, sha256=sha, duration_ms=int(round(dur * 1000)), byte_size=size,
                                mime=MIME_BY_EXT.get(ext, "audio/mpeg"), scope=a.get("scope") or "UNKNOWN",
                                section=a.get("section"), part=a.get("part"), confidence=conf, rule=a.get("rule"),
                                technical_qa=qa))
    return out


def audio_validation_state(b: AudioBinding, corroborated: bool) -> str:
    """VALIDATED only after automated technical QA AND a confident (or corroborated probable) mapping."""
    qa = b.technical_qa
    technical_ok = qa.get("hashVerified") and qa.get("decodable") and qa.get("durationAgrees")
    mapping_ok = b.confidence == CONFIDENT or (b.confidence == PROBABLE and corroborated)
    return "VALIDATED" if technical_ok and mapping_ok else "PENDING"


def figure_region(layer, page: int, y_from: float, y_to: float, min_area_ratio: float = 0.02,
                  raster: bool = False) -> Optional[tuple]:
    """Bounding box of the visual (embedded images first, else vector drawings) between two y positions.
    raster=True (Writing Task 1 only: everything below the prompt is the visual) adds the scanned-page path."""
    w, h = layer.page_size(page)
    imgs = [b for b in layer.image_blocks(page) if b[1] >= y_from - 4 and b[3] <= y_to + 4
            and (b[2] - b[0]) * (b[3] - b[1]) > min_area_ratio * w * h]
    if imgs:
        return (min(b[0] for b in imgs), min(b[1] for b in imgs), max(b[2] for b in imgs), max(b[3] for b in imgs)), "EMBEDDED_IMAGE"
    rects = [r for r in layer.drawing_rects(page)
             if r[1] >= y_from - 4 and r[3] <= y_to + 4 and not (r[2] - r[0] > 0.8 * w and r[3] - r[1] < 3)]
    if len(rects) >= 6:
        box = (min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects))
        if (box[2] - box[0]) * (box[3] - box[1]) > min_area_ratio * w * h:
            return box, "VECTOR_REGION"
    # Phase 3.6: a scanned page (one raster covering it) — the visual is the non-text ink (photos, line-art
    # diagrams, chart frames) the layout analysis finds between the two y positions
    raw = layer.image_blocks(page) if raster else []
    if raw and sum((b[2] - b[0]) * (b[3] - b[1]) for b in raw) >= 0.9 * w * h:
        from .layout import FIGURE, FRAME, analyze_page
        lay = analyze_page(layer, page, use_image_blocks=False)
        regs = [r.bbox for r in lay.regions if r.kind in (FIGURE, FRAME)
                and r.bbox[1] >= y_from - 4 and r.bbox[3] <= y_to + 4]
        if regs:
            seed = (min(b[0] for b in regs), min(b[1] for b in regs), max(b[2] for b in regs), max(b[3] for b in regs))
            box = _ink_band(layer, page, y_from, y_to, seed)
            if box is not None and (box[2] - box[0]) * (box[3] - box[1]) > min_area_ratio * w * h:
                return box, "RASTER_REGION"
    return None


def _ink_band(layer, page: int, y_from: float, y_to: float, seed: tuple, dpi: int = 100) -> Optional[tuple]:
    """Full extent of the visual on a scanned page: the contiguous band of ink (title, labels, drawing) below
    y_from that CONTAINS the seed figure; bands end at a blank gap >= 4 % of the page height. None when the
    seed is not inside one band (the crop would be partial)."""
    import numpy as np
    from . import preprocess
    from .ocr_engine import render_region
    w, h = layer.page_size(page)
    y0 = y_from + 2
    img = render_region(layer, page, (0, y0, w, y_to), dpi=dpi)
    mask = preprocess.ink_mask(preprocess.to_gray(img))
    s = 72.0 / dpi
    rows = mask.sum(axis=1) > max(2, 0.002 * mask.shape[1])
    gap = int(0.04 * h / s)
    bands, start, blank = [], None, 0
    for i, on in enumerate(rows):
        if on:
            if start is None:
                start = i
            blank = 0
        elif start is not None:
            blank += 1
            if blank >= gap:
                bands.append((start, i - blank + 1))
                start, blank = None, 0
    if start is not None:
        bands.append((start, len(rows) - blank))
    for a, b in bands:
        top, bot = y0 + a * s, y0 + b * s
        if top - 2 <= seed[1] and seed[3] <= bot + 2:
            cols = np.where(mask[a:b].any(axis=0))[0]
            return (cols[0] * s, top, (cols[-1] + 1) * s, bot)
    return None


def capture_figure(layer, store: AssetStore, page: int, bbox: tuple, method: str, text_rows: list = ()) -> Figure:
    """Render a page region (plus the labels printed inside it) to a staged PNG."""
    x0, y0, x1, y1 = bbox
    for r in text_rows:  # extend over labels that belong to the figure
        if r.page == page and r.y0 >= y0 - 2 and r.y1 <= y1 + 14:
            x0, y0, x1, y1 = min(x0, r.x0), min(y0, r.y0), max(x1, r.x1), max(y1, r.y1)
    box = (max(0, x0 - 6), max(0, y0 - 6), x1 + 6, y1 + 6)
    png, pw, ph = layer.render_region(page, box, dpi=150)
    prov = {"rawSourcePath": layer.rel_path, "rawSourceSha256": layer.sha256, "page": page,
            "bbox": [round(v, 1) for v in box], "method": method}
    key, sha, path = store.put_image(png, prov)
    return Figure(source_path=layer.rel_path, source_sha256=layer.sha256, page=page, bbox=box, method=method,
                  confidence=PROBABLE, staged_path=str(path), sha256=sha, byte_size=len(png), dimensions=f"{pw}x{ph}")
