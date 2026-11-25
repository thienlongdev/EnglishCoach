"""OCR engine abstraction + region-level OCR cache (Exams Recovery Phase 3.5C).

The pipeline is not coupled to one engine. An `OcrEngine` recognises a RENDERED REGION (never a whole page by
default) and reports engine name/version and per-word confidence:

  * `EasyOcrEngine`     local EasyOCR models only (download disabled; nothing leaves the machine)
  * `NativeTextEngine`  the PDF's own text layer inside a region (no recognition; confidence 1.0 for born-digital
                        text, but an embedded third-party OCR layer is reported as such by the caller)

Two recognition modes:
  detect     the engine finds the words inside the region (text blocks, columns)
  boxes      the caller supplies word/cell boxes (layout-derived); the engine only recognises them, optionally
             with an allow-list (answer-key cells: digits / A-D) — this is where structure constrains OCR.

Cache (`RegionOcrCache`): imports/exams/staging/cache/ocr_regions/<sourceSha256>/<key>.json where key =
sha256(source sha256, page, bbox (0.1 pt), dpi, engine, engine version, preprocessing id+version, mode, allow-list,
supplied boxes). Changing ANY of these invalidates the entry; an unchanged crop is never OCR'd twice. The cache is
derived data and lives outside imports/source-files/**.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

from . import preprocess

DEFAULT_DPI = 300


@dataclass
class OcrWord:
    text: str
    bbox: tuple            # PDF points (x0, y0, x1, y1) on the source page
    conf: float
    engine: str = ""

    def to_dict(self) -> dict:
        return {"text": self.text, "bbox": [round(v, 2) for v in self.bbox], "conf": round(self.conf, 4)}


@dataclass
class RegionResult:
    page: int
    bbox: tuple
    dpi: int
    engine: str
    engine_version: str
    preprocess: str
    mode: str
    words: list = field(default_factory=list)   # OcrWord
    cached: bool = False
    meta: dict = field(default_factory=dict)

    @property
    def mean_conf(self) -> float:
        return sum(w.conf for w in self.words) / len(self.words) if self.words else 0.0


class OcrUnavailable(RuntimeError):
    pass


class OcrEngine:
    name = "none"
    version = "0"

    def available(self) -> bool:
        return False

    def detect(self, img: np.ndarray, allowlist: Optional[str] = None) -> list:
        """[(bbox_px (x0,y0,x1,y1), text, conf)] for the words the engine finds in the image."""
        raise OcrUnavailable(self.name)

    def recognize_boxes(self, img: np.ndarray, boxes: list, allowlist: Optional[str] = None) -> list:
        """[(text, conf)] for each supplied pixel box (x0,y0,x1,y1), same order."""
        raise OcrUnavailable(self.name)


class EasyOcrEngine(OcrEngine):
    name = "easyocr"

    def __init__(self, languages=("en",)):
        self._reader = None
        self.languages = list(languages)
        try:
            import easyocr  # type: ignore
            self._mod = easyocr
            self.version = getattr(easyocr, "__version__", "unknown")
        except Exception:
            self._mod = None

    def available(self) -> bool:
        return self._mod is not None

    def _r(self):
        if self._mod is None:
            raise OcrUnavailable("easyocr not installed")
        if self._reader is None:
            import warnings
            warnings.filterwarnings("ignore", message=".*pin_memory.*")
            # local model files only (~/.EasyOCR); no network download is attempted
            self._reader = self._mod.Reader(self.languages, gpu=False, download_enabled=False, verbose=False)
        return self._reader

    def detect(self, img: np.ndarray, allowlist: Optional[str] = None) -> list:
        out = []
        kw = {"allowlist": allowlist} if allowlist else {}
        for box, text, conf in self._r().readtext(img, detail=1, paragraph=False, **kw):
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            out.append(((float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))), str(text), float(conf)))
        return out

    def recognize_boxes(self, img: np.ndarray, boxes: list, allowlist: Optional[str] = None) -> list:
        if not boxes:
            return []
        gray = preprocess.to_gray(img)
        kw = {"allowlist": allowlist} if allowlist else {}
        ints, valid = [], []
        for (x0, y0, x1, y1) in boxes:
            b = (max(0, int(x0)), max(0, int(y0)), min(gray.shape[1], int(round(x1))), min(gray.shape[0], int(round(y1))))
            ints.append(b)
            valid.append(b[2] - b[0] >= 2 and b[3] - b[1] >= 2)
        todo = sorted({b for b, ok in zip(ints, valid) if ok})
        corners = [(b[0], b[1]) for b in todo]
        if len(set(corners)) != len(corners):   # two boxes share a corner: the coordinate re-binding would be ambiguous
            out = []
            for b, ok in zip(ints, valid):
                r = self._r().recognize(gray, horizontal_list=[[b[0], b[2], b[1], b[3]]], free_list=[], detail=1,
                                        paragraph=False, **kw) if ok else []
                out.append((str(r[0][1]), float(r[0][2])) if r else ("", 0.0))
            return out
        found: dict = {}
        if todo:
            # EasyOCR re-sorts its batch output; each result echoes its input (x_min, y_min) -> re-bind by coordinates
            res = self._r().recognize(gray, horizontal_list=[[b[0], b[2], b[1], b[3]] for b in todo], free_list=[],
                                      detail=1, paragraph=False, **kw)
            for box, text, conf in res:
                found.setdefault((int(box[0][0]), int(box[0][1])), (str(text), float(conf)))
        return [found.get((b[0], b[1]), ("", 0.0)) if ok else ("", 0.0) for b, ok in zip(ints, valid)]


class NativeTextEngine(OcrEngine):
    """Words of the PDF text layer inside a region (pymupdf 'words'); used where the text layer is reliable."""
    name = "native-text"
    version = "pymupdf"

    def available(self) -> bool:
        return True

    def region_words(self, layer, page: int, bbox: tuple) -> list:
        import pymupdf
        pg = layer.doc[page - 1]
        r = pymupdf.Rect(*bbox)
        out = []
        for x0, y0, x1, y1, w, *_ in pg.get_text("words", clip=r):
            out.append(OcrWord(w, (x0, y0, x1, y1), 1.0, self.name))
        return out


def render_region(layer, page: int, bbox: tuple, dpi: int = DEFAULT_DPI) -> np.ndarray:
    """Render a PDF region (points) to an RGB numpy array. Read-only on the source PDF."""
    import pymupdf
    pg = layer.doc[page - 1]
    clip = pymupdf.Rect(*bbox) & pg.rect
    pix = pg.get_pixmap(dpi=dpi, clip=clip, alpha=False)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n).copy()


def px_to_pt(bbox_px: tuple, region: tuple, dpi: int) -> tuple:
    s = 72.0 / dpi
    x0, y0 = region[0], region[1]
    return (x0 + bbox_px[0] * s, y0 + bbox_px[1] * s, x0 + bbox_px[2] * s, y0 + bbox_px[3] * s)


def pt_to_px(bbox_pt: tuple, region: tuple, dpi: int) -> tuple:
    s = dpi / 72.0
    return ((bbox_pt[0] - region[0]) * s, (bbox_pt[1] - region[1]) * s,
            (bbox_pt[2] - region[0]) * s, (bbox_pt[3] - region[1]) * s)


class RegionOcrCache:
    """Region OCR with a persistent, fully keyed cache (Phase 3.5C.1)."""

    def __init__(self, root: Path, engine: OcrEngine):
        self.root = root
        self.engine = engine
        self.hits = 0
        self.misses = 0
        self.pages_touched: set = set()

    @staticmethod
    def key(source_sha: str, page: int, bbox: tuple, dpi: int, engine: str, engine_version: str, prep: str,
            mode: str, allowlist: Optional[str], boxes: Optional[list] = None) -> str:
        blob = json.dumps({"src": source_sha, "page": page, "bbox": [round(v, 1) for v in bbox], "dpi": dpi,
                           "engine": engine, "engineVersion": engine_version, "prep": prep, "mode": mode,
                           "allow": allowlist or "", "boxes": [[round(v, 1) for v in b] for b in (boxes or [])]},
                          sort_keys=True).encode()
        return hashlib.sha256(blob).hexdigest()[:32]

    def path(self, source_sha: str, key: str) -> Path:
        # short path (Windows MAX_PATH); the full source sha256 + key are stored in the entry and verified on read
        return self.root / source_sha[:16] / f"{key}.json"

    def recognize(self, layer, page: int, bbox: tuple, dpi: int = DEFAULT_DPI, pipeline: str = "P1",
                  allowlist: Optional[str] = None, boxes_pt: Optional[list] = None,
                  image: Optional[np.ndarray] = None) -> Optional[RegionResult]:
        """OCR one page region. boxes_pt given -> recognition-only mode on those boxes (PDF points)."""
        prep = preprocess.pipeline_id(pipeline)
        mode = "boxes" if boxes_pt is not None else "detect"
        key = self.key(layer.sha256, page, bbox, dpi, self.engine.name, self.engine.version, prep, mode, allowlist,
                       boxes_pt)
        p = self.path(layer.sha256, key)
        self.pages_touched.add((layer.sha256, page))
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("sha256") == layer.sha256 and data.get("key") == key:
                self.hits += 1
                return self._result(data, cached=True)
        if not self.engine.available():
            return None
        img = image if image is not None else render_region(layer, page, bbox, dpi)
        proc, meta = preprocess.apply(pipeline, img)
        words = []
        if boxes_pt is not None:
            boxes_px = [pt_to_px(b, bbox, dpi) for b in boxes_pt]
            for b_pt, (text, conf) in zip(boxes_pt, self.engine.recognize_boxes(proc, boxes_px, allowlist)):
                words.append({"text": text, "bbox": [round(v, 2) for v in b_pt], "conf": round(conf, 4)})
        else:
            for b_px, text, conf in self.engine.detect(proc, allowlist):
                words.append({"text": text, "bbox": [round(v, 2) for v in px_to_pt(b_px, bbox, dpi)],
                              "conf": round(conf, 4)})
        data = {"key": key, "source": layer.rel_path, "sha256": layer.sha256, "page": page,
                "bbox": [round(v, 1) for v in bbox], "dpi": dpi, "engine": self.engine.name,
                "engineVersion": self.engine.version, "preprocess": prep, "mode": mode,
                "allowlist": allowlist or "", "meta": meta, "words": words}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        self.misses += 1
        return self._result(data, cached=False)

    def _result(self, data: dict, cached: bool) -> RegionResult:
        words = [OcrWord(w["text"], tuple(w["bbox"]), w["conf"], data["engine"]) for w in data["words"]]
        return RegionResult(data["page"], tuple(data["bbox"]), data["dpi"], data["engine"], data["engineVersion"],
                            data["preprocess"], data["mode"], words, cached, data.get("meta", {}))

    def stats(self) -> dict:
        return {"regionsOcrd": self.misses, "regionsFromCache": self.hits,
                "pagesTouched": len(self.pages_touched)}
