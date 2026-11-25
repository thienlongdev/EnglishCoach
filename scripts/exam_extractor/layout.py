"""Layout-aware page model (Exams Recovery Phase 3.5B): REGIONS FIRST, OCR SECOND.

    page render (analysis dpi)
      -> ink mask -> connected components (glyphs / figures / frames)
      -> text lines (horizontal smearing of glyph components only)
      -> header / footer bands (page furniture, excluded from content)
      -> column gutter per horizontal BAND (full-width lines split the page into bands, so a full-width passage
         above a two-column question block is never interleaved)
      -> regions: TEXT blocks per column, FULL_WIDTH blocks, FIGURE (photo / chart: dense), FRAME (document border)
      -> reading order: bands top-down; inside a band the left column, then the right column

The page model is generic; collection-specific knowledge enters only through a `LayoutProfile` (header/footer
bands, whether two columns are expected, preprocessing pipeline, OCR dpi). Coordinates are PDF points with page
identity; every region keeps its bbox so OCR results, crops and QA entries can be traced to the source page.
Nothing is OCR'd here — see `ocr_layout()` for the per-region OCR pass.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

from . import preprocess
from .ocr_engine import render_region
from .pdf_layer import DOTS, Row, Token, _DOTS_RE, clean_text

HEADER = "HEADER"
FOOTER = "FOOTER"
TEXT = "TEXT"
FULL_WIDTH = "FULL_WIDTH"
FIGURE = "FIGURE"
FRAME = "FRAME"
TABLE = "TABLE"
INVERSE = "INVERSE"     # white-on-dark block (section badges, thumb tabs): read with an inverted pipeline

LAYOUT_VERSION = "1"


@dataclass
class LayoutProfile:
    """Collection-specific layout knowledge feeding the common page model."""
    name: str = "default"
    header_frac: float = 0.075        # top band that may hold running heads
    footer_frac: float = 0.075        # bottom band that may hold page numbers / running footers
    two_column: Optional[bool] = None  # None = detect per band
    analysis_dpi: int = 100
    ocr_dpi: int = 300
    preprocess: str = "P1"
    figure_min_area: float = 0.02     # fraction of the page area
    gutter_band: tuple = (0.30, 0.70)  # where a column gutter may lie (fraction of width)
    furniture: tuple = ()             # regex of header/footer text (for diagnostics only)


DEFAULT_PROFILE = LayoutProfile()


def page_scaled_profile(width: float, height: float, profile: LayoutProfile) -> LayoutProfile:
    """Bound recognition density for scans with enlarged PDF units; source coordinates stay unchanged."""
    scale = max(width / 595.0, height / 842.0)
    if scale <= 1.5:
        return profile
    return replace(profile, analysis_dpi=max(1, round(profile.analysis_dpi / scale)),
                   ocr_dpi=max(1, round(profile.ocr_dpi / scale)))


@dataclass
class Region:
    kind: str
    bbox: tuple                 # PDF points
    page: int
    column: Optional[int] = None   # 0 left, 1 right, None full width
    band: int = 0
    order: int = 0
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "bbox": [round(v, 1) for v in self.bbox], "column": self.column,
                "band": self.band, "order": self.order, **({"meta": self.meta} if self.meta else {})}


@dataclass
class PageLayout:
    page: int
    width: float
    height: float
    regions: list = field(default_factory=list)
    gutters: list = field(default_factory=list)     # [(band_y0, band_y1, gutter_x)] in points
    line_height: float = 0.0                        # median text line height (points)
    profile: str = "default"
    diagnostics: list = field(default_factory=list)  # [(code, detail)]

    def ordered(self, kinds=(TEXT, FULL_WIDTH)) -> list:
        return sorted([r for r in self.regions if r.kind in kinds], key=lambda r: r.order)

    def figures(self) -> list:
        return [r for r in self.regions if r.kind == FIGURE]

    def to_dict(self) -> dict:
        return {"page": self.page, "size": [round(self.width, 1), round(self.height, 1)], "profile": self.profile,
                "lineHeight": round(self.line_height, 2), "gutters": [[round(a, 1), round(b, 1), round(g, 1)]
                                                                       for a, b, g in self.gutters],
                "regions": [r.to_dict() for r in sorted(self.regions, key=lambda r: r.order)],
                "diagnostics": [{"code": c, "detail": d} for c, d in self.diagnostics]}


# ── geometry helpers ──────────────────────────────────────────────────────────────────────────

@dataclass
class _Box:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2


def _union(boxes: list) -> tuple:
    return (min(b.x0 for b in boxes), min(b.y0 for b in boxes), max(b.x1 for b in boxes), max(b.y1 for b in boxes))


def _components(mask: np.ndarray) -> list:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        out.append((x, y, w, h, area))
    return out


def analyze_image(gray: np.ndarray, page: int, width_pt: float, height_pt: float,
                  profile: LayoutProfile = DEFAULT_PROFILE, image_blocks: Optional[list] = None) -> PageLayout:
    """Page model from a rendered grayscale page (any dpi; coordinates returned in points)."""
    if cv2 is None:
        raise RuntimeError("opencv is required for layout analysis")
    H, W = gray.shape[:2]
    sx, sy = width_pt / W, height_pt / H
    lay = PageLayout(page, width_pt, height_pt, profile=profile.name)
    mask = preprocess.ink_mask(gray)
    comps = _components(mask)
    if not comps:
        lay.diagnostics.append(("LAYOUT_EMPTY_PAGE", "no ink"))
        return lay
    heights = np.array([c[3] for c in comps if 3 <= c[3] <= H * 0.05 and c[2] <= H * 0.08])
    char_h = float(np.median(heights)) if len(heights) else 10.0
    figure_min = profile.figure_min_area * W * H
    glyph = np.zeros_like(mask, dtype=np.uint8)
    figures, frames, furniture = [], [], []
    for (x, y, w, h, area) in comps:
        box_area = w * h
        big = (w > 6 * char_h and h > 4 * char_h and box_area >= figure_min)
        edge = x <= 1 or y <= 1 or x + w >= W - 1 or y + h >= H - 1
        if big:
            fill = area / max(box_area, 1)
            if edge and (w > 0.9 * W or h > 0.9 * H):
                continue                     # scanner border / page shadow
            if fill >= 0.18 and _tonal(gray[y:y + h, x:x + w]):
                figures.append(_Box(x, y, x + w, y + h))     # photograph / tonal graphic
            elif fill >= 0.18:
                # shaded text container (chat bubbles, tinted boxes): a document frame whose glyphs are
                # recovered after dividing out the tint
                frames.append(_Box(x, y, x + w, y + h))
                _shaded_glyphs(gray, glyph, x, y, w, h, char_h)
            else:
                frames.append(_Box(x, y, x + w, y + h))
                # a frame's strokes are not glyphs; text inside it is kept by the glyph components themselves
            continue
        if area / max(box_area, 1) >= 0.45 and ((w >= 1.5 * char_h and h >= 1.8 * char_h)
                                                 or (w >= 3.0 * char_h and h >= 1.2 * char_h)) \
                and _holes(mask[y:y + h, x:x + w], char_h) >= 3:
            furniture.append(_Box(x, y, x + w, y + h))   # inverse-video block ('TEST 1' tab, 'LISTENING' badge)
            continue
        if h > 4 * char_h or w > 25 * char_h:
            continue                         # long rules / tall bars: not glyphs
        glyph[y:y + h, x:x + w] |= mask[y:y + h, x:x + w].astype(np.uint8)
    # fragments of an inverse-video block (white text splits its ink) are furniture too
    for f in furniture:
        m = int(round(0.6 * char_h))
        glyph[max(0, int(f.y0) - m):int(f.y1) + m, max(0, int(f.x0) - m):int(f.x1) + m] = 0
    # embedded raster images of a born-digital page are exact figure boxes
    for b in image_blocks or []:
        x0, y0, x1, y1 = b[0] / sx, b[1] / sy, b[2] / sx, b[3] / sy
        if (x1 - x0) * (y1 - y0) >= figure_min and (x1 - x0) < 0.98 * W:
            figures.append(_Box(x0, y0, x1, y1))
    figures = _merge_overlapping(figures)
    # glyphs inside a photo are image texture, not text
    for f in figures:
        glyph[int(f.y0):int(f.y1), int(f.x0):int(f.x1)] = 0
    # text lines: horizontal smear smaller than a column gutter, tiny vertical smear
    kx = max(3, int(round(char_h * 1.1)))
    ky = max(1, int(round(char_h * 0.15)))
    smear = cv2.dilate(glyph, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky)))
    lines = [_Box(x, y, x + w, y + h) for (x, y, w, h, _a) in _components(smear)
             if (h >= 0.45 * char_h and w >= 0.5 * char_h)
             or (w >= 2.5 * char_h and _dash_run(glyph[y:y + h, x:x + w], char_h))]   # a blank alone on its line
    lines = [l for l in lines if not (l.x1 < 0.06 * W or l.x0 > 0.94 * W)]   # margin furniture
    lines = _merge_same_row(lines, char_h)
    if not lines:
        lay.diagnostics.append(("LAYOUT_NO_TEXT_LINES", None))
    lay.line_height = float(np.median([l.h for l in lines])) * sy if lines else char_h * sy
    # page furniture: lines entirely inside the header / footer band and separated from the body
    body, header, footer = [], [], []
    top, bottom = profile.header_frac * H, (1 - profile.footer_frac) * H
    def near_figure(l):   # a number label beside a photo's top edge is content, not a running head
        return any(f.y0 - 2 * char_h <= l.y0 <= f.y1 and f.x0 - 12 * char_h <= l.x0 <= f.x1 for f in figures)

    for l in sorted(lines, key=lambda b: b.y0):
        if l.y1 <= top and not near_figure(l):
            header.append(l)
        elif l.y0 >= bottom and not near_figure(l):
            footer.append(l)
        else:
            body.append(l)
    # a band line that continues the body text (a body line just above / below it, same column) is content
    moved = True
    while moved:
        moved = False
        for l in list(footer):
            if any(0 <= l.y0 - b.y1 <= 1.6 * char_h and b.x0 - 4 * char_h <= l.x0 <= b.x1 for b in body):
                footer.remove(l)
                body.append(l)
                moved = True
        for l in list(header):
            if any(0 <= b.y0 - l.y1 <= 1.6 * char_h and b.x0 - 4 * char_h <= l.x0 <= b.x1 for b in body):
                header.remove(l)
                body.append(l)
                moved = True
    for group, kind in ((header, HEADER), (footer, FOOTER)):
        if group:
            x0, y0, x1, y1 = _union(group)
            lay.regions.append(Region(kind, (x0 * sx, y0 * sy, x1 * sx, y1 * sy), page, meta={"lines": len(group)}))
    # document frames are containers: their lines are ordered inside the frame, never across it
    containers = []
    rest = list(body)
    for fi, fr in enumerate(sorted(frames, key=lambda f: (f.y0, f.x0))):
        inside = [l for l in rest if fr.x0 - 2 <= (l.x0 + l.x1) / 2 <= fr.x1 + 2 and fr.y0 - 2 <= l.cy <= fr.y1 + 2]
        if not inside:
            continue
        rest = [l for l in rest if l not in inside]
        unit = _Box(fr.x0, fr.y0, fr.x1, fr.y1)
        unit.frame, unit.lines = fi, inside
        containers.append(unit)
    units = rest + containers
    units.sort(key=lambda b: (b.y0, b.x0))
    # column gutter per band (frames take part as single units)
    gutter = None if profile.two_column is False else _find_gutter(units, W, profile)
    gutter_of = None
    if gutter is not None and _crossing(units, gutter) > 2:
        # Phase 3.6: an unclean page-wide gutter (lines cross it) can be the gap between question numbers and
        # their text ('168.' | 'What does…') when a centred passage above a two-column question block hides the
        # real gutter. A vertical zone whose OWN lines prove a clean gutter elsewhere uses that one; every other
        # zone keeps the page gutter (unchanged behaviour).
        zg = _zone_gutters(units, W, profile, char_h)
        if zg and any(abs(g - gutter) > 4 * char_h for g in zg.values()):
            gutter_of = {id(u): zg.get(id(u), gutter) for u in units}
            lay.diagnostics.append(("LAYOUT_ZONE_GUTTERS", f"page x={gutter * sx:.0f} -> zones " +
                                    ",".join(f"{g * sx:.0f}" for g in sorted(set(zg.values())))))
            gutter = None
    elif gutter is None and profile.two_column is not False:
        # no page-wide gutter (a full-width passage crosses it): a zone BELOW the top zone — where a set's
        # question block is printed under its documents — may still prove two clean side-by-side columns
        zg = _zone_gutters(units, W, profile, char_h, below_top=True, glyph=glyph)
        if zg:
            units.sort(key=lambda b: (b.y0, b.x0))
            gutter_of = zg
            lay.diagnostics.append(("LAYOUT_ZONE_GUTTERS", "page none -> lower zones " +
                                    ",".join(f"{g * sx:.0f}" for g in sorted(set(zg.values())))))
    if profile.two_column and gutter is None and not gutter_of:
        lay.diagnostics.append(("LAYOUT_COLUMNS_NOT_FOUND", "two columns expected by the profile"))
    bands: list = []      # [{"full": [units] } | {"cols": ([left], [right]), "g": gutter}]
    for u in units:
        g = gutter if gutter_of is None else gutter_of.get(id(u))
        crosses = g is not None and u.x0 < g - 2 and u.x1 > g + 2
        if g is None or crosses:
            if bands and "full" in bands[-1]:
                bands[-1]["full"].append(u)
            else:
                bands.append({"full": [u]})
        else:
            if not bands or "cols" not in bands[-1] or bands[-1]["g"] != g:
                bands.append({"cols": ([], []), "g": g})
            bands[-1]["cols"][0 if u.x1 <= g + 2 else 1].append(u)
    # a "column band" one visual row tall with pieces on both sides is ONE line broken at a wide space
    med_h = float(np.median([l.h for l in lines])) if lines else char_h
    fixed: list = []
    for band in bands:
        if "cols" in band and band["cols"][0] and band["cols"][1]:
            members = band["cols"][0] + band["cols"][1]
            if max(m.y1 for m in members) - min(m.y0 for m in members) < 1.8 * med_h \
                    and not any(hasattr(m, "frame") for m in members):
                x0, y0, x1, y1 = _union(members)
                band = {"full": [_Box(x0, y0, x1, y1)]}
        if fixed and "full" in band and "full" in fixed[-1]:
            fixed[-1]["full"].extend(band["full"])
        else:
            fixed.append(band)
    bands = fixed
    counter = [0]

    def emit(us: list, kind: str, column, bi: int):
        plain = [u for u in us if not hasattr(u, "frame")]
        pending = [(min(b.y0 for b in blk), blk, None) for blk in _blocks(plain, char_h)]
        pending += [(u.y0, u.lines, u.frame) for u in us if hasattr(u, "frame")]
        for _y, blk, frame in sorted(pending, key=lambda t: t[0]):
            if frame is not None:
                # inside a frame: its own (rare) column split, else full-width blocks in y order
                inner = _find_gutter(blk, W, profile) if len(blk) >= 8 else None
                parts = ([[l for l in blk if l.x1 <= inner + 2], [l for l in blk if l.x1 > inner + 2]]
                         if inner is not None else [blk])
                for pi, part in enumerate(parts):
                    for sub in _blocks(part, char_h):
                        x0, y0, x1, y1 = _union(sub)
                        lay.regions.append(Region(kind if inner is None else TEXT,
                                                  (x0 * sx, y0 * sy, x1 * sx, y1 * sy), page,
                                                  column if inner is None else pi, bi, counter[0],
                                                  {"lines": len(sub), "frame": frame}))
                        counter[0] += 1
                continue
            x0, y0, x1, y1 = _union(blk)
            lay.regions.append(Region(kind, (x0 * sx, y0 * sy, x1 * sx, y1 * sy), page, column, bi, counter[0],
                                      {"lines": len(blk)}))
            counter[0] += 1

    for bi, band in enumerate(bands):
        if "full" in band:
            emit(band["full"], FULL_WIDTH, None, bi)
        else:
            left, right = band["cols"]
            ys = [b.y0 for b in left + right]
            ye = [b.y1 for b in left + right]
            lay.gutters.append((min(ys) * sy, max(ye) * sy, band["g"] * sx))
            emit(left, TEXT, 0, bi)
            emit(right, TEXT, 1, bi)
    for f in figures:
        col = None
        fg = gutter if gutter is not None else next((gx / sx for a, b, gx in lay.gutters
                                                      if a <= f.cy * sy <= b), None)
        if fg is not None:
            col = 0 if f.x1 <= fg + 4 else 1 if f.x0 >= fg - 4 else None
        lay.regions.append(Region(FIGURE, (f.x0 * sx, f.y0 * sy, f.x1 * sx, f.y1 * sy), page, col,
                                  meta={"areaFrac": round(f.w * f.h / (W * H), 4)}))
    for f in frames:
        lay.regions.append(Region(FRAME, (f.x0 * sx, f.y0 * sy, f.x1 * sx, f.y1 * sy), page,
                                  meta={"areaFrac": round(f.w * f.h / (W * H), 4)}))
    for f in furniture:
        lay.regions.append(Region(INVERSE, (f.x0 * sx, f.y0 * sy, f.x1 * sx, f.y1 * sy), page,
                                  meta={"horizontal": f.w >= f.h}))
    _merge_overlapping_regions(lay)
    _order_figures(lay)
    return lay


def dashed_frames(mask: np.ndarray, *, dotted: bool = False) -> list:
    """Rectangles drawn with a DASHED border (coupons, cut-out notices) on an ink mask -> [(x0, y0, x1, y1)] px.

    Phase 5B. A dashed border is invisible to the component-based frame test (each dash is a small component).
    Accepted only with structural proof: a top and a bottom run of >= 6 equal horizontal dashes each on one
    line, left edges aligned, overlapping by >= 60 % of the narrower run, plus a vertical dash run on the left or
    right edge covering >= 40 % of the height. A run may be interrupted (a badge printed over the border)."""
    if cv2 is None:
        return []
    n, _, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    comps = [tuple(int(v) for v in st[i][:4]) for i in range(1, n) if st[i][4] >= 2]
    H = mask.shape[0]
    heights = [c[3] for c in comps if 3 <= c[3] <= H * 0.05 and c[2] <= H * 0.08]
    ch = float(np.median(heights)) if heights else 10.0
    thin = max(3.0, 0.35 * ch)
    hd = [c for c in comps if c[3] <= thin and (0.2 if dotted else 1.0) * ch <= c[2] <= 3.5 * ch]
    vd = [c for c in comps if c[2] <= thin and (0.2 if dotted else 1.2) * ch <= c[3] <= 3.5 * ch]

    def runs(dashes, axis):          # axis 1: same y (horizontal run); axis 0: same x (vertical run)
        out = []
        for d in sorted(dashes, key=lambda c: (c[axis] + c[axis + 2] / 2, c[1 - axis])):
            centre = d[axis] + d[axis + 2] / 2
            run = next((r for r in out if abs(r["c"] - centre) <= 2), None)
            if run is None:
                out.append({"c": centre, "d": [d]})
            else:
                run["d"].append(d)
        good = []
        for r in out:
            ds = sorted(r["d"], key=lambda c: c[1 - axis])
            lens = sorted(c[2 + (1 - axis)] for c in ds)
            if len(ds) < (6 if axis == 1 else 3) or lens[-1] > 1.6 * lens[len(lens) // 2]:
                continue                 # too few dashes, or unequal pieces (text strokes, not a dashed rule)
            lo = ds[0][1 - axis]
            hi = max(c[1 - axis] + c[2 + (1 - axis)] for c in ds)
            good.append((r["c"], lo, hi, ds))
        return good

    hruns = runs(hd, 1)
    vruns = runs(vd, 0)
    boxes = []
    for i, (ty, tx0, tx1, _t) in enumerate(hruns):
        for by, bx0, bx1, _b in hruns[i + 1:]:
            if by - ty < 4 * ch or abs(tx0 - bx0) > 3 * ch:
                continue
            overlap = min(tx1, bx1) - max(tx0, bx0)
            if overlap < 0.6 * min(tx1 - tx0, bx1 - bx0):
                continue
            x0, x1 = min(tx0, bx0), max(tx1, bx1)
            side = [v for v in vruns if (abs(v[0] - x0) <= 2 * ch or abs(v[0] - x1) <= 2 * ch)
                    and min(v[2], by) - max(v[1], ty) >= 0.4 * (by - ty)]
            if not side:
                continue
            xs = [v[0] for v in side]
            boxes.append((int(min([x0] + xs) - 2), int(ty - 2), int(max([x1] + xs) + 2), int(by + 2)))
            if not dotted:
                break
    return boxes


def _merge_overlapping_regions(lay: PageLayout) -> None:
    """Content regions overlapping by > 25 % of the smaller one become one region (earliest reading order)."""
    content = [r for r in lay.regions if r.kind in (TEXT, FULL_WIDTH)]
    changed = True
    while changed:
        changed = False
        for i, a in enumerate(content):
            for b in content[i + 1:]:
                ix = min(a.bbox[2], b.bbox[2]) - max(a.bbox[0], b.bbox[0])
                iy = min(a.bbox[3], b.bbox[3]) - max(a.bbox[1], b.bbox[1])
                if ix <= 0 or iy <= 0:
                    continue
                small = min((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]), (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))
                if ix * iy > 0.25 * max(small, 1e-6):
                    keep, drop = (a, b) if a.order <= b.order else (b, a)
                    keep.bbox = (min(a.bbox[0], b.bbox[0]), min(a.bbox[1], b.bbox[1]),
                                 max(a.bbox[2], b.bbox[2]), max(a.bbox[3], b.bbox[3]))
                    if keep.column != drop.column:
                        keep.kind, keep.column = FULL_WIDTH, None
                    keep.meta["merged"] = keep.meta.get("merged", 0) + 1
                    content.remove(drop)
                    lay.regions.remove(drop)
                    changed = True
                    break
            if changed:
                break


def _tonal(crop: np.ndarray) -> bool:
    """Photographs are mostly mid-tones; a tinted text box is mostly light paper/tint with dark glyphs."""
    if crop.size == 0:
        return True
    white = float((crop >= 245).mean())
    mid = float(((crop > 60) & (crop < 200)).mean())
    # calibrated on ETS 2026 Part 1 photos (white <= 0.12, mid >= 0.6) vs a tinted chat box (white 0.5, mid 0.41)
    return not (white >= 0.3 and mid < 0.5)


def _shaded_glyphs(gray: np.ndarray, glyph: np.ndarray, x: int, y: int, w: int, h: int, char_h: float) -> None:
    crop = gray[y:y + h, x:x + w]
    m = (preprocess.binarize(preprocess.stretch(preprocess.normalize_background(crop))) < 128).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    for i in range(1, n):
        cx, cy, cw, chh, a = st[i]
        if 0.3 * char_h <= chh <= 2.5 * char_h and cw <= 6 * char_h:
            sub = (lab[cy:cy + chh, cx:cx + cw] == i).astype(np.uint8)
            glyph[y + cy:y + cy + chh, x + cx:x + cx + cw] |= sub


def _holes(crop: np.ndarray, char_h: float) -> int:
    """Enclosed paper regions inside an ink block: white letters of an inverse-video badge (a bold glyph has <= 2)."""
    white = (~crop).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
    H, W = crop.shape
    k = 0
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if x > 0 and y > 0 and x + w < W and y + h < H and a >= max(4, 0.04 * char_h * char_h):
            k += 1
    return k


def _merge_overlapping(boxes: list) -> list:
    out = []
    for b in sorted(boxes, key=lambda b: (b.y0, b.x0)):
        for o in out:
            if not (b.x1 < o.x0 or b.x0 > o.x1 or b.y1 < o.y0 or b.y0 > o.y1):
                o.x0, o.y0, o.x1, o.y1 = min(o.x0, b.x0), min(o.y0, b.y0), max(o.x1, b.x1), max(o.y1, b.y1)
                break
        else:
            out.append(_Box(b.x0, b.y0, b.x1, b.y1))
    return out


def _merge_same_row(lines: list, char_h: float, max_gap: float = 2.0) -> list:
    """Re-join fragments of ONE visual line split at a wide word space (justified text, a blank ruler).
    Never across a column gutter: a gap is a gutter when >= 2 neighbouring rows break at the same x."""
    lines = sorted(lines, key=lambda b: (b.cy, b.x0))
    raw = list(lines)

    def gutter_at(cx: float, cy: float) -> bool:
        rows = 0
        near = [r for r in raw if abs(r.cy - cy) <= 5 * char_h and abs(r.cy - cy) > 0.5 * char_h]
        for a in near:
            if a.x1 < cx and any(b is not a and abs(b.cy - a.cy) <= 0.5 * char_h and b.x0 > cx and b.x0 - a.x1 < 6 * char_h
                                 for b in near):
                rows += 1
        return rows >= 2

    out: list = []
    for l in lines:
        for o in out[-6:]:
            ov = min(o.y1, l.y1) - max(o.y0, l.y0)
            if ov >= 0.6 * min(o.h, l.h) and 0 <= l.x0 - o.x1 < max_gap * char_h                     and not gutter_at((o.x1 + l.x0) / 2, (o.cy + l.cy) / 2):
                o.x1, o.y0, o.y1 = max(o.x1, l.x1), min(o.y0, l.y0), max(o.y1, l.y1)
                break
        else:
            out.append(_Box(l.x0, l.y0, l.x1, l.y1))
    return out


def _find_gutter(lines: list, W: int, profile: LayoutProfile) -> Optional[float]:
    """x of a vertical whitespace gutter crossed by few lines, with enough lines on both sides."""
    if len(lines) < 8:
        return None
    lo, hi = int(W * profile.gutter_band[0]), int(W * profile.gutter_band[1])
    best = None
    for x in range(lo, hi, max(1, W // 400)):
        cross = sum(1 for l in lines if l.x0 < x - 2 and l.x1 > x + 2)
        left = sum(1 for l in lines if l.x1 <= x + 2)
        right = sum(1 for l in lines if l.x0 >= x - 2)
        if left < 3 or right < 3:
            continue
        key = (cross, -min(left, right))
        if best is None or key < best[0]:
            best = (key, [x])
        elif key == best[0]:
            best[1].append(x)
    if best is None:
        return None
    cross = best[0][0]
    if cross > max(2, 0.25 * len(lines)):
        return None
    xs = best[1]
    # widest contiguous run of best positions -> its centre is the gutter centre
    runs, cur = [], [xs[0]]
    step = max(1, W // 400)
    for x in xs[1:]:
        if x - cur[-1] <= step:
            cur.append(x)
        else:
            runs.append(cur)
            cur = [x]
    runs.append(cur)
    widest = max(runs, key=len)
    g = widest[len(widest) // 2]
    # a real column break: lines on both sides overlapping vertically (side-by-side text)
    left = [l for l in lines if l.x1 <= g + 2]
    right = [l for l in lines if l.x0 >= g - 2]
    side_by_side = sum(1 for a in left if any(b.y0 < a.y1 and b.y1 > a.y0 for b in right))
    return float(g) if side_by_side >= 3 else None


def _dash_run(crop: np.ndarray, char_h: float) -> bool:
    """A printed answer blank '--------' (>= 4 short flat dashes on one baseline) that sits alone on a line:
    too thin to pass the text-line height filter, but a line of the question (Phase 3.6, ETS Part 5 stems)."""
    n, _, st, _ = cv2.connectedComponentsWithStats(crop.astype(np.uint8), connectivity=8)
    comps = [st[i] for i in range(1, n) if st[i][4] >= 2]
    dashes = [c for c in comps if c[3] <= max(2, 0.4 * char_h) and c[2] >= 1.5 * c[3]]
    return len(dashes) >= 4 and len(comps) - len(dashes) <= 2


def _crossing(units: list, g: float) -> int:
    return sum(1 for u in units if u.x0 < g - 2 and u.x1 > g + 2)


def _zone_gutters(units: list, W: int, profile: LayoutProfile, char_h: float,
                  below_top: bool = False, glyph: Optional[np.ndarray] = None) -> Optional[dict]:
    """{id(unit): gutter} per vertical zone (zones are separated by page-wide whitespace >= 2.5 line heights);
    a zone gets a gutter only when its own lines prove two side-by-side columns that no line crosses.
    below_top: only zones below the page's top zone.
    glyph: when given, a line smeared across a narrow gutter ('164. …XC-35 ?' + '167. According…') is split at the
    gutter if its own ink leaves the gutter column empty (units is updated in place); otherwise the zone fails."""
    zones, cur, bottom = [], [], None
    for u in sorted(units, key=lambda b: (b.y0, b.x0)):
        if cur and u.y0 > bottom + 2.5 * char_h:
            zones.append(cur)
            cur = []
        cur.append(u)
        bottom = u.y1 if len(cur) == 1 else max(bottom, u.y1)
    if cur:
        zones.append(cur)
    if below_top:
        zones = zones[1:]
    out = {}
    for z in zones:
        g = _find_gutter(z, W, profile)
        if g is None:
            continue
        crossing = [u for u in z if u.x0 < g - 2 and u.x1 > g + 2]
        if crossing:
            if glyph is None:
                continue
            pieces = [_split_at(glyph, u, g) for u in crossing]
            if any(p is None for p in pieces) or len(crossing) > 2:
                continue
            for u, (a, b) in zip(crossing, pieces):
                i = units.index(u)
                units[i:i + 1] = [a, b]
                z[z.index(u):z.index(u) + 1] = [a, b]
        for u in z:
            out[id(u)] = g
    # a following zone that no line crosses continues the same columns ('165.', '166.' under '164.' while the
    # right column holds only '167.'): it shares the gutter, so the left column is read to its end first
    g = None
    for z in zones:
        if id(z[0]) in out:
            g = out[id(z[0])]
        elif g is not None and not any(u.x0 < g - 2 and u.x1 > g + 2 for u in z):
            for u in z:
                out[id(u)] = g
        else:
            g = None
    return out or None


def _split_at(glyph: np.ndarray, u, g: float):
    """(left, right) boxes of a line unit whose ink leaves the column g (+-1 px) empty; None otherwise."""
    if hasattr(u, "frame"):
        return None
    y0, y1, x0, x1, gi = int(u.y0), int(u.y1) + 1, int(u.x0), int(u.x1) + 1, int(round(g))
    band = glyph[y0:y1, x0:x1].astype(bool)
    if band.size == 0 or band[:, max(0, gi - 1 - x0):gi + 2 - x0].any():
        return None
    cols = band.any(axis=0)
    left = np.where(cols[:gi - x0])[0]
    right = np.where(cols[gi - x0:])[0]
    if len(left) == 0 or len(right) == 0:
        return None
    return (_Box(u.x0, u.y0, x0 + left[-1] + 1, u.y1), _Box(gi + right[0], u.y0, u.x1, u.y1))


def _blocks(lines: list, char_h: float) -> list:
    """Vertical grouping of lines into blocks (gap > 1.6 line heights starts a new block)."""
    lines = sorted(lines, key=lambda b: (b.y0, b.x0))
    out, cur = [], []
    for l in lines:
        if cur and l.y0 - max(c.y1 for c in cur) > 1.6 * char_h:
            out.append(cur)
            cur = []
        cur.append(l)
    if cur:
        out.append(cur)
    return out


def _order_figures(lay: PageLayout) -> None:
    """Give figures a reading-order slot just before the first text region below them in the same column."""
    text = lay.ordered()
    for f in lay.figures():
        after = [r for r in text if r.bbox[1] >= f.bbox[1] - 2 and (f.column is None or r.column in (None, f.column))]
        f.order = (min(r.order for r in after) - 0.5) if after else (max([r.order for r in text], default=0) + 0.5)
        f.band = after[0].band if after else 0


def analyze_page(layer, page: int, profile: LayoutProfile = DEFAULT_PROFILE, use_image_blocks: bool = True) -> PageLayout:
    w, h = layer.page_size(page)
    img = render_region(layer, page, (0, 0, w, h), dpi=profile.analysis_dpi)
    gray = preprocess.to_gray(img)
    blocks = None
    if use_image_blocks:
        raw = layer.image_blocks(page)
        coverage = sum(max(0, b[2] - b[0]) * max(0, b[3] - b[1]) for b in raw) / (w * h)
        # a scanned page is stored as one or more raster strips covering the page: those are not figures
        if coverage < 0.6:
            blocks = [b for b in raw if (b[2] - b[0]) < 0.9 * w and (b[3] - b[1]) < 0.9 * h]
    return analyze_image(gray, page, w, h, profile, blocks)


# ── per-region OCR -> Phase 3 rows ─────────────────────────────────────────────────────────────

def ocr_layout(layer, layout: PageLayout, cache, profile: LayoutProfile = DEFAULT_PROFILE,
               kinds=(TEXT, FULL_WIDTH), pad: float = 3.0, mode: str = "lines") -> list:
    """OCR each content region separately and return Phase 3 `Row`s in reading order (method='OCR').

    Column regions are recognised independently, so two columns can never merge into one line; header/footer
    regions are not part of the content stream.

    mode 'lines' (default): lines and words are segmented from the region's own ink (projection profiles) and the
    engine only RECOGNISES each word box — deterministic geometry, one token per printed word.
    mode 'detect': the engine's detector finds the words inside the region (benchmark reference).
    """
    out = []
    for reg in layout.ordered(kinds):
        x0, y0, x1, y1 = reg.bbox
        box = (max(0, x0 - pad), max(0, y0 - pad), min(layout.width, x1 + pad), min(layout.height, y1 + pad))
        if mode == "lines":
            img = render_region(layer, layout.page, box, dpi=profile.ocr_dpi)
            words = segment_words(preprocess.to_gray(img), box, profile.ocr_dpi)
            if not words:
                continue
            res = cache.recognize(layer, layout.page, box, dpi=profile.ocr_dpi, pipeline=profile.preprocess,
                                  boxes_pt=[w[1] for w in words if w[2] == WORD], image=img)
            if res is None:
                return []
            rows = _rows_from_segmented(words, res.words, layout.page)
            from .ocr_quality import detect_blank_runs, insert_blanks
            # Region-level rechecking retains blurred dash runs missed by the
            # line segmentation. Only physical dash runs are considered here;
            # table rules and underlines are not added to the content stream.
            source_blanks = [b for b in detect_blank_runs(layer, layout.page, box, profile.ocr_dpi, image=img)
                             if b[3] == 'DASH_RUN']
            reg.meta['sourceBlankRecovery'] = insert_blanks(rows, source_blanks)
        else:
            res = cache.recognize(layer, layout.page, box, dpi=profile.ocr_dpi, pipeline=profile.preprocess)
            if res is None:
                return []
            rows = words_to_rows(res.words, layout.page)
        for r in rows:
            r.column = reg.column if reg.column is not None else 0
            r.method = "OCR"
            r.region = reg.order
            r.frame = reg.meta.get("frame")
        out.extend(rows)
    return clean_rows(out)


_LABELISH = re.compile(r"^(\(?[A-Da-d]\)?[.,]?|\d{1,3}[.,]?|" + re.escape(DOTS) + ")$")


def clean_rows(rows: list) -> list:
    """Drop OCR debris rows (specks read as stray letters) and rows duplicated inside an overlapping row."""
    out = []
    for r in rows:
        toks = [t.text for t in r.tokens]
        singles = sum(1 for t in toks if len(t) == 1 and not _LABELISH.match(t))
        if toks and all(len(t) <= 2 and not _LABELISH.match(t) for t in toks)                 and not (len(toks) == 1 and re.fullmatch(r"[A-Z]", toks[0]) and r.confidence >= 0.8):
            continue                                    # 'F', '0 I': speck debris (a confidently read lone
                                                        # capital is kept: stacked answer-key letters 'E', 'H')
        if len(toks) >= 3 and (singles >= 0.6 * len(toks) or all(len(t) == 1 for t in toks)):
            continue                                    # '3 3 3 U' / '4 3 1 1 1' letter soup
        out.append(r)
    keep = []
    for r in out:
        dup = False
        for o in out:
            if o is r or len(o.tokens) <= len(r.tokens):
                continue
            ov = min(o.y1, r.y1) - max(o.y0, r.y0)
            if ov >= 0.6 * max(r.y1 - r.y0, 1.0) and o.x0 - 2 <= r.x0 and r.x1 <= o.x1 + 2 \
                    and clean_text(r.text) in clean_text(o.text):
                dup = True
                break
        if not dup:
            keep.append(r)
    return keep


def segment_lines(mask: np.ndarray) -> list:
    """Text-line y ranges of a single-column region from its horizontal ink projection.

    Touching lines are split only at a real projection valley, recursively, never into pieces thinner than
    0.6 of a text line (the line height comes from GLYPH heights, so small label lines cannot shrink it)."""
    prof = mask.sum(axis=1).astype(np.float64)
    if prof.max() <= 0:
        return []
    k = max(1, mask.shape[1] // 400)
    # a row is "on" with a little ink: a short line holding only '39 ........' carries far less ink per row than
    # running text, and below a high threshold its pieces would chain onto the line above (Phase 3.6)
    on = prof > max(1.0, 0.0015 * mask.shape[1]) * k
    runs, start = [], None
    for y, v in enumerate(on):
        if v and start is None:
            start = y
        elif not v and start is not None:
            runs.append([start, y])
            start = None
    if start is not None:
        runs.append([start, len(on)])
    if not runs:
        return []
    ch = None
    if cv2 is not None:
        n, _, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        hs = [st[i][3] for i in range(1, n) if 4 <= st[i][3] <= 0.3 * mask.shape[0] and st[i][4] >= 6]
        if hs:
            ch = float(np.percentile(hs, 80))     # ascender / cap height (the median is the x-height)
    if ch is None:
        hs = sorted(b - a for a, b in runs)
        ch = hs[len(hs) // 2] / 1.3
    L = 1.3 * ch                                  # ink height of one text line

    def split(a, b):
        pending, pieces = [(a, b)], []
        while pending:
            a, b = pending.pop()
            margin = max(1, int(0.7 * L))
            lo, hi = a + margin, b - margin
            if b - a <= 1.4 * L or hi <= lo:
                pieces.append([a, b])
                continue
            c = lo + int(np.argmin(prof[lo:hi]))
            # Keep the same ink-valley proof; each child must strictly shrink.
            limit = 0.2 if b - a > 1.9 * L else 0.05
            if not a < c < b or prof[c] > limit * prof[a:b].mean():
                pieces.append([a, b])
                continue
            pending.extend([(c, b), (a, c)])
        return pieces

    out = []
    for a, b in runs:
        pieces = split(a, b)
        for a2, b2 in pieces:
            if b2 - a2 < 0.45 * ch:               # dots / underline fragments: attach to the nearest line
                if out and a2 - out[-1][1] < 0.5 * L:
                    out[-1][1] = b2
                    continue
            out.append([a2, b2])
    return [(a, b) for a, b in out if b - a >= 3]


WORD = "WORD"
BLANK = "BLANK"


def _line_blanks(band: np.ndarray, ref_ch: Optional[float] = None) -> list:
    """Answer blanks inside one text line (pixel x ranges): >= 4 aligned short dashes, or a thin solid rule.
    ref_ch (the region's glyph height) is used for a band thinner than a glyph: a blank alone on its line."""
    if cv2 is None:
        return []
    h = band.shape[0]
    n, _, stats, _ = cv2.connectedComponentsWithStats(band.astype(np.uint8), connectivity=8)
    comps = [tuple(stats[i]) for i in range(1, n)]
    tall = [c[3] for c in comps if c[3] >= 0.3 * h]
    ch = float(np.median(tall)) if tall else 0.6 * h
    if ref_ch and h < 0.45 * ref_ch:
        ch = 0.8 * ref_ch
    # a dash may be up to 0.3 glyph heights thick (heavier older scans, Phase 3.6); a run still needs >= 4
    # aligned dashes, so a hyphen or a dash in running text never becomes a blank
    dashes = sorted([c for c in comps if c[3] <= max(2, 0.3 * ch) and c[2] >= 1.7 * c[3] and 0.2 * ch <= c[2] <= 1.6 * ch],
                    key=lambda c: c[0])
    out, run = [], []
    for d in dashes:
        if run and (d[0] - (run[-1][0] + run[-1][2]) > 1.1 * ch or abs((d[1] + d[3] / 2) - (run[-1][1] + run[-1][3] / 2)) > 0.2 * ch):
            if len(run) >= 4:
                out.append((run[0][0], run[-1][0] + run[-1][2]))
            run = []
        run.append(d)
    if len(run) >= 4:
        out.append((run[0][0], run[-1][0] + run[-1][2]))
    for c in comps:
        if c[3] <= max(2, 0.22 * ch) and c[2] > 2.5 * ch:
            out.append((c[0], c[0] + c[2]))
    # dotted answer lines ('1 ..........'): >= 6 small round dots on one baseline, evenly spaced
    dots = sorted([c for c in comps if c[2] <= 0.32 * ch and c[3] <= 0.32 * ch and 0.5 <= c[2] / max(c[3], 1) <= 2.0
                   and c[1] + c[3] >= 0.55 * h], key=lambda c: c[0])
    run = []
    for d in dots + [None]:
        if d is not None and run and d[0] - (run[-1][0] + run[-1][2]) <= 0.9 * ch \
                and abs((d[1] + d[3] / 2) - (run[-1][1] + run[-1][3] / 2)) <= 0.15 * ch:
            run.append(d)
            continue
        if len(run) >= 6:
            out.append((run[0][0], run[-1][0] + run[-1][2]))
        run = [d] if d is not None else []
    merged = []
    for a, b in sorted(out):
        if merged and a <= merged[-1][1] + 2:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def segment_words(gray: np.ndarray, region: tuple, dpi: int) -> list:
    """[(line_index, bbox in PDF points, kind)] from projection profiles: lines first, then word gaps.
    kind BLANK = an answer blank found geometrically (never sent to the recogniser)."""
    mask = preprocess.ink_mask(gray)
    if cv2 is not None:
        # tall non-glyph ink inside the crop (tabs, vertical rules, photo edges) would fuse all lines: drop it
        n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        # reference height from GLYPH-sized components only: dotted answer lines ('8 ............') are hundreds
        # of specks that would otherwise make every letter look like a "tall bar" (Phase 3.6, IELTS scans)
        hs = [st[i][3] for i in range(1, n) if st[i][4] > 8 and st[i][3] >= dpi / 40.0]
        if hs:
            # Dots can exceed the physical minimum on enlarged scan pages and
            # outnumber letters. The upper glyph-height percentile keeps those
            # letters from being removed as tall bars; rules still exceed 3x.
            med = float(np.percentile(hs, 80))
            for i in range(1, n):
                fill = st[i][4] / max(1, st[i][2] * st[i][3])
                if st[i][3] > 3.0 * med and (fill > 0.3 or fill < 0.12 or st[i][2] < 0.25 * st[i][3]):
                    # filled bars; tall narrow outlines and sparse border strokes (a Web page frame / scrollbar,
                    # a vertical table rule) — never text, which is neither that tall nor that sparse
                    mask[lab == i] = False
    s = 72.0 / dpi
    out = []
    pad = 2

    def pt(x0, y0, x1, y1):
        return (region[0] + (x0 - pad) * s, region[1] + (y0 - pad) * s, region[0] + (x1 + pad) * s, region[1] + (y1 + pad) * s)

    ref_ch = None
    if cv2 is not None:
        n2, _, st2, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        hs2 = [st2[i][3] for i in range(1, n2) if 4 <= st2[i][3] <= 0.3 * mask.shape[0] and st2[i][4] >= 6]
        ref_ch = float(np.percentile(hs2, 80)) if hs2 else None
    for li, (a, b) in enumerate(segment_lines(mask)):
        band = mask[a:b].copy()
        h = b - a
        blanks = _line_blanks(band, ref_ch)
        for bx0, bx1 in blanks:
            band[:, bx0:bx1] = False
            out.append((li, pt(bx0, a, bx1, b), BLANK))
        cols = band.sum(axis=0) > 0
        gap_min = max(2, int(0.33 * h))
        xs = np.where(cols)[0]
        if len(xs) == 0:
            continue
        runs, start, last = [], xs[0], xs[0]
        for x in xs[1:]:
            if x - last > gap_min or any(last < bx0 <= x for bx0, _ in blanks):
                runs.append((start, last + 1))
                start = x
            last = x
        runs.append((start, last + 1))
        for x0, x1 in runs:
            sub = band[:, x0:x1]
            ys = np.where(sub.sum(axis=1) > 0)[0]
            if len(ys) == 0 or (x1 - x0) < 2:
                continue
            out.append((li, pt(x0, a + ys[0], x1, a + ys[-1] + 1), WORD))
    return out


def _rows_from_segmented(words: list, recognised: list, page: int) -> list:
    rows: dict = {}
    rec = iter(recognised)
    for li, bbox, kind in words:
        if kind == BLANK:
            text, conf = DOTS, 1.0
        else:
            w = next(rec)
            text, conf = w.text.strip(), w.conf
        if not text:
            continue
        r = rows.get(li)
        if r is None:
            r = rows[li] = Row(page, bbox[1], bbox[3], bbox[0], bbox[2], [], "OCR", 0.0)
            r._confs = []
        r.tokens.append(Token(text, bbox[0], bbox[2]))
        if kind != BLANK:
            r._confs.append(conf)
        r.y0, r.y1, r.x0, r.x1 = min(r.y0, bbox[1]), max(r.y1, bbox[3]), min(r.x0, bbox[0]), max(r.x1, bbox[2])
    out = []
    for li in sorted(rows):
        r = rows[li]
        r.tokens.sort(key=lambda t: t.x0)
        r.confidence = sum(r._confs) / len(r._confs) if r._confs else 1.0
        del r._confs
        out.append(r)
    return out


def words_to_rows(words: list, page: int) -> list:
    """OCR words (PDF points) -> visual rows with interpolated word tokens (same contract as pdf_layer.Row)."""
    items = []
    for w in words:
        text = _DOTS_RE.sub(f" {DOTS} ", w.text)
        parts = text.split()
        if not parts:
            continue
        x0, y0, x1, y1 = w.bbox
        unit = (x1 - x0) / max(len(text), 1)
        toks, pos = [], 0
        for p in parts:
            i = text.find(p, pos)
            toks.append(Token(p, x0 + i * unit, x0 + (i + len(p)) * unit))
            pos = i + len(p)
        items.append((y0, y1, x0, x1, toks, w.conf))
    items.sort(key=lambda t: ((t[0] + t[1]) / 2, t[2]))
    rows: list = []
    for y0, y1, x0, x1, toks, conf in items:
        h = max(y1 - y0, 1.0)
        for r in reversed(rows[-4:]):
            rh = max(r.y1 - r.y0, 1.0)
            overlap = min(r.y1, y1) - max(r.y0, y0)
            if overlap >= 0.5 * min(h, rh) and not any(x0 < t.x1 - 1 and x1 > t.x0 + 1 for t in r.tokens):
                r.tokens.extend(toks)
                r.y0, r.y1, r.x0, r.x1 = min(r.y0, y0), max(r.y1, y1), min(r.x0, x0), max(r.x1, x1)
                r._confs.append(conf)
                break
        else:
            row = Row(page, y0, y1, x0, x1, list(toks), "OCR", conf)
            row._confs = [conf]
            rows.append(row)
    for r in rows:
        r.tokens.sort(key=lambda t: t.x0)
        r.confidence = sum(r._confs) / len(r._confs)
        del r._confs
    rows.sort(key=lambda r: ((r.y0 + r.y1) / 2, r.x0))
    return rows


def inverse_rows(layer, layout: PageLayout, cache) -> list:
    """Rows read from white-on-dark blocks (inverted pipeline P4); vertical thumb tabs are skipped."""
    out = []
    for reg in layout.regions:
        if reg.kind != INVERSE or not reg.meta.get("horizontal"):
            continue
        res = cache.recognize(layer, layout.page, reg.bbox, dpi=300, pipeline="P4")
        if res is None:
            continue
        for r in words_to_rows(res.words, layout.page):
            r.method, r.region = "OCR", "INVERSE"
            out.append(r)
    return out


def merge_by_y(rows: list, extra: list) -> list:
    """Insert extra rows before the first row that starts below them (single-column pages)."""
    out = list(rows)
    for e in sorted(extra, key=lambda r: r.y0):
        i = next((k for k, r in enumerate(out) if r.y0 >= e.y0 - 1), len(out))
        out.insert(i, e)
    return out


def furniture_text(layer, layout: PageLayout, cache, profile: LayoutProfile = DEFAULT_PROFILE) -> dict:
    """OCR of header/footer regions (page identity only — e.g. a running 'TEST 3' footer), never content."""
    out = {}
    for reg in layout.regions:
        if reg.kind in (HEADER, FOOTER):
            res = cache.recognize(layer, layout.page, reg.bbox, dpi=200, pipeline=profile.preprocess)
            if res is not None:
                out[reg.kind] = clean_text(" ".join(w.text for w in sorted(res.words, key=lambda w: (w.bbox[1], w.bbox[0]))))
    return out


def reading_order_inversions(rows: list, pattern=re.compile(r"^(\d{1,3})\s*[.,]")) -> tuple:
    """(#adjacent pairs of printed question numbers in descending order, #numbers) — column-order metric."""
    nums = []
    for r in rows:
        m = pattern.match(clean_text(r.text))
        if m:
            nums.append(int(m.group(1)))
    inv = sum(1 for a, b in zip(nums, nums[1:]) if b < a)
    return inv, len(nums)
