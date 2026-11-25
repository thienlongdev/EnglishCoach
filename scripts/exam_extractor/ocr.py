"""OCR adapter interface + EasyOCR implementation + persistent cache (Phase 3D, limited sample only).

Flow: native text layer first; OCR only pages that have no usable text layer. OCR output keeps page identity:
every Row is tagged method='OCR' with the engine's mean confidence; nothing produced here is authoritative on its
own — structure and answer alignment must still validate.

Cache: imports/exams/staging/cache/ocr/<sourceSha256>/p<page>_<engine>_<engineVersion>_<dpi>.json
(never inside imports/source-files/**). An unchanged page is never OCR'd twice.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .pdf_layer import Row, Token, _DOTS_RE, DOTS

OCR_DPI = 200


class OcrUnavailable(RuntimeError):
    pass


class OcrAdapter:
    engine = "none"
    version = "0"

    def available(self) -> bool:
        return False

    def recognize(self, png_bytes: bytes) -> list:
        """[(bbox_points_in_pixels [x0,y0,x1,y1], text, confidence)]"""
        raise OcrUnavailable(self.engine)


class EasyOcrAdapter(OcrAdapter):
    engine = "easyocr"

    def __init__(self, languages=("en",)):
        self._reader = None
        self.languages = list(languages)
        try:
            import easyocr  # type: ignore
            self.version = getattr(easyocr, "__version__", "unknown")
            self._mod = easyocr
        except Exception:
            self._mod = None

    def available(self) -> bool:
        return self._mod is not None

    def recognize(self, png_bytes: bytes) -> list:
        if self._mod is None:
            raise OcrUnavailable("easyocr not installed")
        if self._reader is None:
            # local model files only (~/.EasyOCR); no network download is attempted
            self._reader = self._mod.Reader(self.languages, gpu=False, download_enabled=False, verbose=False)
        out = []
        for box, text, conf in self._reader.readtext(png_bytes, detail=1, paragraph=False):
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            out.append(([float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))], str(text), float(conf)))
        return out


class OcrCache:
    def __init__(self, root: Path, adapter: OcrAdapter):
        self.root = root
        self.adapter = adapter
        self.hits = 0
        self.misses = 0

    def path(self, sha: str, page: int, dpi: int) -> Path:
        return self.root / sha / f"p{page:04d}_{self.adapter.engine}_{self.adapter.version}_{dpi}.json"

    def page_rows(self, layer, page: int, dpi: int = OCR_DPI) -> Optional[list]:
        """OCR rows of one PDF page (cached). Coordinates are converted back to PDF points."""
        p = self.path(layer.sha256, page, dpi)
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            self.hits += 1
        else:
            if not self.adapter.available():
                return None
            pix = layer.render_page(page, dpi=dpi)
            res = self.adapter.recognize(pix.tobytes("png"))
            data = {"source": layer.rel_path, "sha256": layer.sha256, "page": page, "dpi": dpi,
                    "engine": self.adapter.engine, "engineVersion": self.adapter.version,
                    "results": [{"bbox": b, "text": t, "conf": round(c, 4)} for b, t, c in res]}
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            self.misses += 1
        scale = 72.0 / data["dpi"]
        lines = []
        for r in data["results"]:
            x0, y0, x1, y1 = [v * scale for v in r["bbox"]]
            text = _DOTS_RE.sub(f" {DOTS} ", r["text"])
            words = text.split()
            if not words:
                continue
            width = (x1 - x0) / max(len(text), 1)
            toks, pos = [], 0
            for w in words:
                i = text.find(w, pos)
                toks.append(Token(w, x0 + i * width, x0 + (i + len(w)) * width))
                pos = i + len(w)
            lines.append((y0, y1, x0, x1, toks, r["conf"]))
        from .pdf_layer import _group_rows
        rows = _group_rows([l[:5] for l in lines], page)
        confs = {id(t): l[5] for l in lines for t in l[4]}
        for row in rows:
            row.method = "OCR"
            cs = [confs.get(id(t), 0.0) for t in row.tokens]
            row.confidence = sum(cs) / len(cs) if cs else 0.0
        return rows
