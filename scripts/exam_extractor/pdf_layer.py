"""Native PDF text layer -> visual rows with page identity, extraction method and per-token typography.

Rows are what the family extractors parse. A row is one visual line (spans on the same baseline merged, sorted
by x). Tokens keep bold/italic flags because printed exams mark gap numbers in bold, and position because
item numbers sit at the left margin. Runs of dots/underscores (gap rulers in scanned/OCR layers) become one
DOTS token. Two-column pages are split into column streams (left then right) when a clear gutter exists.
"""
from __future__ import annotations

import hashlib
import io
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pymupdf

DOTS = "……"   # canonical gap ruler token
_DOTS_RE = re.compile(r"(?:[._…․‥·]\s?){3,}")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_WS_RE = re.compile(r"[ \t      　]+")


def clean_text(s: str) -> str:
    """NFC, no control characters (Jackson/Python escape parity), normalised spaces, no BOM."""
    s = unicodedata.normalize("NFC", s.replace("﻿", ""))
    s = s.replace(" ", " ").replace(" ", " ")
    s = _CTRL_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s)
    return s.strip()


@dataclass
class Token:
    text: str
    x0: float
    x1: float
    bold: bool = False
    italic: bool = False
    size: float = 0.0
    font: str = ""


@dataclass
class Row:
    page: int                 # 1-based
    y0: float
    y1: float
    x0: float
    x1: float
    tokens: list = field(default_factory=list)
    method: str = "NATIVE_TEXT"   # NATIVE_TEXT | OCR
    confidence: float = 1.0
    column: int = 0

    @property
    def text(self) -> str:
        return clean_text(" ".join(t.text for t in self.tokens))

    @property
    def size(self) -> float:
        sizes = [t.size for t in self.tokens if t.size]
        return max(sizes) if sizes else 0.0

    @property
    def all_bold(self) -> bool:
        toks = [t for t in self.tokens if t.text.strip()]
        return bool(toks) and all(t.bold for t in toks)

    @property
    def all_italic(self) -> bool:
        toks = [t for t in self.tokens if t.text.strip()]
        return bool(toks) and all(t.italic for t in toks)


def _is_bold(span: dict) -> bool:
    f = span.get("font", "")
    return bool(span.get("flags", 0) & 16) or "Bold" in f or "-Bd" in f or "Black" in f or "Heavy" in f


def _is_italic(span: dict) -> bool:
    f = span.get("font", "")
    return bool(span.get("flags", 0) & 2) or "Italic" in f or "Oblique" in f or "-It" in f


def _split_span(span: dict) -> list:
    """One span -> word-level tokens with interpolated x positions; dot runs become DOTS tokens."""
    raw = span.get("text", "")
    if not raw:
        return []
    x0, _, x1, _ = span["bbox"]
    width = max(x1 - x0, 0.1)
    n = max(len(raw), 1)
    out = []
    pos = 0
    text = _DOTS_RE.sub(lambda m: " " + "\x01" * len(m.group(0)) + " ", raw)
    for m in re.finditer(r"\S+", text):
        a, b = m.start(), m.end()
        piece = m.group(0)
        tx0 = x0 + width * (a / n)
        tx1 = x0 + width * (b / n)
        if set(piece) == {"\x01"}:
            out.append(Token(DOTS, tx0, tx1, _is_bold(span), _is_italic(span), span.get("size", 0), span.get("font", "")))
        else:
            piece = piece.replace("\x01", "")
            if piece:
                out.append(Token(piece, tx0, tx1, _is_bold(span), _is_italic(span), span.get("size", 0), span.get("font", "")))
        pos = b
    return out


class PdfTextLayer:
    """Read-only view of one PDF. Never writes to the source file."""

    def __init__(self, full_path: Path, rel_path: str, sha256: str):
        self.full_path = full_path
        self.rel_path = rel_path
        self.sha256 = sha256
        self.doc = pymupdf.open(str(full_path))
        self._rows: dict = {}

    @property
    def page_count(self) -> int:
        return len(self.doc)

    def page_size(self, page: int) -> tuple:
        r = self.doc[page - 1].rect
        return r.width, r.height

    def raw_text(self, page: int) -> str:
        return self.doc[page - 1].get_text()

    def rows(self, page: int, split_columns: bool = False) -> list:
        key = (page, split_columns)
        if key in self._rows:
            return self._rows[key]
        pg = self.doc[page - 1]
        d = pg.get_text("dict")
        # Rotated pages (landscape answer keys): bring coordinates into the visual (rotated) frame.
        rot = pg.rotation_matrix if pg.rotation else None
        lines = []
        for b in d["blocks"]:
            if b.get("type") != 0:
                continue
            for ln in b["lines"]:
                dx, dy = ln.get("dir", (1, 0))
                bbox = ln["bbox"]
                spans = ln["spans"]
                if rot is not None:
                    v = pymupdf.Point(dx, dy) * pymupdf.Matrix(rot.a, rot.b, rot.c, rot.d, 0, 0)
                    dx, dy = v.x, v.y
                    bbox = tuple(pymupdf.Rect(bbox) * rot)
                    spans = [dict(sp, bbox=tuple(pymupdf.Rect(sp["bbox"]) * rot)) for sp in spans]
                if abs(dy) > 0.2 or dx < 0.5:
                    continue  # rotated sidebars / vertical labels
                toks = []
                for sp in spans:
                    toks.extend(_split_span(sp))
                if not toks:
                    continue
                x0, y0, x1, y1 = bbox
                lines.append((y0, y1, x0, x1, toks))
        rows = _group_rows(lines, page)
        if rot is None:
            _attach_rulers(rows, self.rulers(page))
        if split_columns:
            rows = _split_two_columns(rows, pg.rect.width)
        self._rows[key] = rows
        return rows

    def image_blocks(self, page: int) -> list:
        pg = self.doc[page - 1]
        out = []
        for b in pg.get_text("dict")["blocks"]:
            if b.get("type") == 1:
                out.append(tuple(b["bbox"]))
        return out

    def drawing_rects(self, page: int) -> list:
        pg = self.doc[page - 1]
        out = []
        try:
            for dr in pg.get_drawings():
                r = dr.get("rect")
                if r is not None:
                    out.append((r.x0, r.y0, r.x1, r.y1))
        except Exception:
            pass
        return out

    def rulers(self, page: int) -> list:
        """Short horizontal vector lines (answer blanks drawn as rules): [(y, x0, x1)]."""
        pg = self.doc[page - 1]
        out = []
        try:
            drawings = pg.get_drawings()
        except Exception:
            return out
        for dr in drawings:
            for it in dr.get("items", []):
                kind = it[0]
                if kind == "l":
                    p1, p2 = it[1], it[2]
                    if abs(p1.y - p2.y) < 1.2 and 14 <= abs(p2.x - p1.x) <= 260:
                        out.append(((p1.y + p2.y) / 2, min(p1.x, p2.x), max(p1.x, p2.x)))
                elif kind == "re":
                    r = it[1]
                    if r.height < 1.6 and 14 <= r.width <= 260:
                        out.append(((r.y0 + r.y1) / 2, r.x0, r.x1))
        return out

    def render_region(self, page: int, bbox: tuple, dpi: int = 150) -> bytes:
        pg = self.doc[page - 1]
        clip = pymupdf.Rect(*bbox) & pg.rect
        pix = pg.get_pixmap(dpi=dpi, clip=clip)
        return pix.tobytes("png"), pix.width, pix.height

    def render_page(self, page: int, dpi: int = 200):
        pg = self.doc[page - 1]
        return pg.get_pixmap(dpi=dpi)


def _group_rows(lines: list, page: int) -> list:
    lines.sort(key=lambda l: ((l[0] + l[1]) / 2, l[2]))
    rows: list = []
    for y0, y1, x0, x1, toks in lines:
        cy = (y0 + y1) / 2
        h = max(y1 - y0, 1.0)
        placed = False
        for r in reversed(rows[-6:]):
            rcy = (r.y0 + r.y1) / 2
            rh = max(r.y1 - r.y0, 1.0)
            if abs(rcy - cy) <= max(2.6, 0.38 * min(h, rh)):
                overlap = any(not (x1 <= t.x0 + 0.5 or x0 >= t.x1 - 0.5) for t in r.tokens)
                if overlap:
                    continue
                r.tokens.extend(toks)
                r.y0, r.y1 = min(r.y0, y0), max(r.y1, y1)
                r.x0, r.x1 = min(r.x0, x0), max(r.x1, x1)
                placed = True
                break
        if not placed:
            rows.append(Row(page, y0, y1, x0, x1, list(toks)))
    for r in rows:
        r.tokens.sort(key=lambda t: t.x0)
    rows.sort(key=lambda r: ((r.y0 + r.y1) / 2, r.x0))
    return rows


def _attach_rulers(rows: list, rulers: list) -> None:
    """Insert a DOTS token where a drawn answer rule sits on a row's baseline (and over no text)."""
    for y, x0, x1 in rulers:
        for r in rows:
            if not (r.y1 - 5 <= y <= r.y1 + 3.5):
                continue
            if any(t.x0 < x1 - 2 and t.x1 > x0 + 2 for t in r.tokens if t.text != DOTS and t.text.strip()):
                continue  # an underline under words, not a blank
            if x1 < r.x0 - 40 or x0 > r.x1 + 120:
                continue
            r.tokens.append(Token(DOTS, x0, x1))
            r.tokens.sort(key=lambda t: t.x0)
            r.x0, r.x1 = min(r.x0, x0), max(r.x1, x1)
            break


def find_gutter(rows: list, width: float) -> Optional[float]:
    """x of a vertical whitespace gutter near the page centre crossed by (almost) no token, else None."""
    toks = [t for r in rows for t in r.tokens if t.text.strip()]
    if len(toks) < 20:
        return None
    cands = []
    for i in range(50, 152):
        x = width * i / 200
        left = sum(1 for t in toks if t.x1 <= x)
        right = sum(1 for t in toks if t.x0 >= x)
        if left < 0.2 * len(toks) or right < 0.2 * len(toks):
            continue
        cands.append((sum(1 for t in toks if t.x0 < x - 1 and t.x1 > x + 1), x))
    if not cands:
        return None
    best_cross = min(c for c, _ in cands)
    if best_cross > 0.02 * len(toks):
        return None
    # centre of the widest run of minimal-crossing positions = middle of the whitespace gutter
    runs, cur = [], []
    for c, x in cands:
        if c == best_cross:
            cur.append(x)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    widest = max(runs, key=len)
    best = widest[len(widest) // 2]
    # the gutter must be a real column break: many rows have content on both sides of it
    both = sum(1 for r in rows if any(t.x1 <= best for t in r.tokens) and any(t.x0 >= best for t in r.tokens))
    return best if both >= 3 else None


def split_columns(rows: list, width: float, gutter_rows: Optional[list] = None) -> list:
    """Public helper: split already filtered rows (gutter computed on gutter_rows or rows)."""
    return _split_two_columns(rows, width, gutter_rows)


def _split_two_columns(rows: list, width: float, gutter_rows: Optional[list] = None) -> list:
    """Split a page into left then right column streams at a detected gutter (rows spanning it stay whole)."""
    gutter = find_gutter(gutter_rows if gutter_rows is not None else rows, width)
    if gutter is None:
        return rows
    out_left, out_right = [], []
    for r in rows:
        lt = [t for t in r.tokens if t.x1 <= gutter + 1]
        rt = [t for t in r.tokens if t.x0 >= gutter - 1]
        if len(lt) + len(rt) != len(r.tokens):
            r.column = 0
            out_left.append(r)  # spanning row (title / header): keep in the left stream at its position
            continue
        if lt:
            out_left.append(Row(r.page, r.y0, r.y1, lt[0].x0, max(t.x1 for t in lt), lt, r.method, r.confidence, 0))
        if rt:
            out_right.append(Row(r.page, r.y0, r.y1, rt[0].x0, max(t.x1 for t in rt), rt, r.method, r.confidence, 1))
    return out_left + out_right


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
