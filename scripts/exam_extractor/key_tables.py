"""TOEIC answer-key table recovery from scanned pages (Exams Recovery Phase 3.5F).

Compact key tables ('Actual Test 3' 10x10 grids of number/letter cells; 'TEST 3' boxes of 'NNN (X)' entries) are
read CELL BY CELL, never as a list bound by array position:

  1. header detection: 'TEST n' headers (normal or inverse-video bars) fix which test a block belongs to; a block
     without a readable header is never assigned (ANSWER_KEY_BLOCK_UNASSIGNED)
  2. glyph segmentation (adaptive threshold: robust to shaded cells) -> tokens (glyphs grouped by proximity)
  3. constrained recognition: number part with a digits allow-list, letter part with 'ABCD'
  4. LATTICE PROOF: tokens are clustered into grid rows/columns; the numbering orientation (column-major /
     row-major) and base are fitted by voting. A key is bound only when the cell's OWN printed number was read
     (>= 1 read, alternative preprocessing reads must not contradict) AND equals the number the lattice predicts
     for that position. Unread or conflicting numbers -> no key (ANSWER_KEY_NUMBER_UNREAD / _LATTICE_CONFLICT).
  5. letter: two independent reads (contrast-stretched, binarised) must agree, and the glyph must sit in the same
     cluster as the page's other glyphs of that letter (glyph-template consistency); else ANSWER_KEY_LETTER_UNCERTAIN.
  6. syntax by part: Part 2 keys A-C, all other parts A-D; numbers outside the block's expected range, blanks,
     words, months, units and punctuation never become keys (ANSWER_KEY_GARBAGE_REJECTED).
  7. block alignment: start/end/contiguity/duplicates/extras checked against the expected 1-100 / 101-200 range.

Every key carries question number, value, source file, page, bbox (number + letter cells), confidence and
extraction method. Nothing here writes into imports/source-files/**.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

from . import preprocess
from .diagnostics import CONFIDENT, UNRESOLVED
from .ocr_engine import OcrEngine, RegionOcrCache, pt_to_px, render_region

KEY_METHOD = "OCR_KEY_TABLE_V1"
KEY_DPI = 300
READ_A, READ_B = "P5", "P6"     # background-normalised grey / binarised: two independent reads
LETTERS = "ABCD"
_HEADER_RE = re.compile(r"T\s*[eE]\s*[sS5]\s*[tTl1]\s*0?(\d{1,2})\b|TEST\s*0?(\d{1,2})\b", re.I)
_NUM_RE = re.compile(r"^\d{1,3}$")
_LET_RE = re.compile(r"^\(?([A-D])\)?$")


@dataclass
class KeyCell:
    number: Optional[int]          # lattice-confirmed printed number (None when not proven)
    predicted: Optional[int]       # number the lattice predicts at this position
    letter: Optional[str]
    status: str                    # CONFIRMED | NUMBER_UNREAD | LATTICE_CONFLICT | LETTER_UNCERTAIN | SYNTAX_INVALID
    page: int
    number_bbox: Optional[tuple] = None
    letter_bbox: Optional[tuple] = None
    number_reads: list = field(default_factory=list)
    letter_reads: list = field(default_factory=list)
    confidence: str = UNRESOLVED
    adjudicated: bool = False      # number proven by the Phase 3.6 re-read (3 of 4 reads agree with the lattice)

    def to_dict(self) -> dict:
        out = {"q": self.predicted, "status": self.status, "letter": self.letter if self.status == "CONFIRMED" else None,
               "confidence": self.confidence, "page": self.page,
               "numberReads": self.number_reads, "letterReads": self.letter_reads,
               **({"adjudication": "REREAD_3_OF_4"} if self.adjudicated else {})}
        if self.number_bbox:
            out["numberBbox"] = [round(v, 1) for v in self.number_bbox]
        if self.letter_bbox:
            out["letterBbox"] = [round(v, 1) for v in self.letter_bbox]
        return out


@dataclass
class KeyBlock:
    test: Optional[int]
    page: int
    bbox: tuple
    header_text: str = ""
    cells: list = field(default_factory=list)
    orientation: Optional[str] = None
    base: Optional[int] = None
    lattice_support: float = 0.0
    diagnostics: list = field(default_factory=list)    # [(code, detail, questions)]
    skew: float = 0.0

    def keys(self) -> dict:
        return {c.number: c for c in self.cells if c.status == "CONFIRMED"}


# ── glyph / token segmentation ────────────────────────────────────────────────────────────────

@dataclass
class _Tok:
    x0: int
    y0: int
    x1: int
    y1: int
    comps: list           # [(x, y, w, h)]

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2


def _ink(gray: np.ndarray) -> np.ndarray:
    """Glyph ink of a key table: global stretch + Otsu (cell shading stays paper), ruling lines removed."""
    g = preprocess.stretch(preprocess.normalize_background(gray))
    m = (preprocess.binarize(g) < 128).astype(np.uint8)
    H, W = m.shape
    lines = np.zeros_like(m)
    for k in ((max(25, W // 25), 1), (1, max(25, H // 12))):
        ker = cv2.getStructuringElement(cv2.MORPH_RECT, k)
        lines |= cv2.morphologyEx(m, cv2.MORPH_OPEN, ker)
    m &= (1 - cv2.dilate(lines, np.ones((3, 3), np.uint8)))
    # specks (scan noise, dotted rules) are not glyphs
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    big = [st[i][3] for i in range(1, n) if st[i][3] >= 8]
    ch = float(np.median(big)) if big else 10.0
    for i in range(1, n):
        if st[i][4] < max(6, 0.06 * ch * ch) or st[i][3] < 0.35 * ch:
            m[lab == i] = 0
    return m.astype(bool)


def _tokens(mask: np.ndarray) -> list:
    n, _, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    comps = [tuple(st[i][:4]) for i in range(1, n) if st[i][4] >= 6]
    hs = [c[3] for c in comps if c[3] >= 8]
    if not hs:
        return []
    ch = float(np.median(hs))
    glyphs = [c for c in comps if 0.45 * ch <= c[3] <= 1.8 * ch and c[2] <= 2.5 * ch]
    glyphs.sort(key=lambda c: (c[1] + c[3] / 2, c[0]))
    toks: list = []
    for c in sorted(glyphs, key=lambda c: c[0]):
        cy = c[1] + c[3] / 2
        for t in toks:
            if abs(t.cy - cy) <= 0.5 * ch and -0.15 * ch <= c[0] - t.x1 <= 0.75 * ch:
                t.comps.append(c)
                t.x1, t.y0, t.y1 = max(t.x1, c[0] + c[2]), min(t.y0, c[1]), max(t.y1, c[1] + c[3])
                break
        else:
            toks.append(_Tok(c[0], c[1], c[0] + c[2], c[1] + c[3], [c]))
    return toks


def _box(cs: list) -> tuple:
    return (min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] + c[2] for c in cs), max(c[1] + c[3] for c in cs))


def _classify(t: _Tok, ch: float) -> tuple:
    """-> (kind, number_box, letter_box). kind ENTRY ('NNN (X)'), LETTER ('(X)' or 'X'), NUMBER ('NNN').

    An entry is split at its widest internal gap (the printed space); the letter is the widest glyph of the right
    part (parentheses are always narrower than A-D)."""
    comps = sorted(t.comps, key=lambda c: c[0])
    if len(comps) >= 3:
        gaps = [comps[i + 1][0] - (comps[i][0] + comps[i][2]) for i in range(len(comps) - 1)]
        gi = int(np.argmax(gaps))
        others = [g for i, g in enumerate(gaps) if i != gi] or [0]
        left, right = comps[:gi + 1], comps[gi + 1:]
        letter = max(right, key=lambda c: c[2])
        thin_sides = all(c is letter or c[2] <= 0.6 * letter[2] for c in right)
        # an entry 'NNN (X)': a real printed space, then a letter alone or a parenthesised letter
        if (gaps[gi] >= max(0.2 * ch, 1.8 * float(np.median(others)) + 1) and len(right) in (1, 3)
                and thin_sides and (len(right) == 1 or right[1] is letter)):
            return "ENTRY", _box(left), _box([letter])
        widest = max(comps, key=lambda c: c[2])
        mid = comps.index(widest)
        if len(comps) == 3 and mid == 1 and comps[0][2] <= 0.6 * widest[2] and comps[2][2] <= 0.6 * widest[2]:
            return "LETTER", None, _box([widest])                 # '(B)' standing alone
    if len(comps) == 1 and comps[0][2] >= 0.45 * ch:
        return "LETTER", None, _box(comps)                         # 'B' (or a single digit; decided by OCR)
    return "NUMBER", _box(comps), None


# ── reading one block ─────────────────────────────────────────────────────────────────────────

def _px_box_pt(b, region, dpi, pad=3):
    s = 72.0 / dpi
    return (region[0] + (b[0] - pad) * s, region[1] + (b[1] - pad) * s, region[0] + (b[2] + pad) * s,
            region[1] + (b[3] + pad) * s)


class _DigitCellEngine(OcrEngine):
    """Read each cell's own digit components; never receives a predicted ordinal."""
    name = 'segmented-cell-digits'

    def __init__(self, delegate, mode):
        self.delegate, self.mode = delegate, mode
        self.version = f'1:{delegate.name}:{delegate.version}:{mode}'

    def available(self):
        return self.delegate.available()

    def recognize_boxes(self, img, boxes, allowlist=None):
        if allowlist != '0123456789':
            raise ValueError('DIGIT_CELL_ALPHABET_REQUIRED')
        gray = preprocess.to_gray(img)
        out = []
        for x0, y0, x1, y1 in boxes:
            crop = gray[max(0, int(y0)):min(gray.shape[0], int(y1)),
                        max(0, int(x0)):min(gray.shape[1], int(x1))]
            if crop.size == 0:
                out.append(('', 0.0))
                continue
            crop = cv2.GaussianBlur(crop, (3, 3), 0)
            bw = (preprocess.binarize(preprocess.stretch(crop)) if self.mode == 'OTSU' else
                  np.where(crop < np.percentile(crop, 75) - 15, 0, 255).astype(np.uint8))
            _, _, stats, _ = cv2.connectedComponentsWithStats((bw < 128).astype(np.uint8))
            components = sorted([tuple(s[:4]) for s in stats[1:]
                                 if s[4] >= 15 and s[3] >= .45 * bw.shape[0]], key=lambda b: b[0])
            reads = []
            for x, y, w, h in components:
                digit = np.pad(bw[y:y+h, x:x+w], ((5, 5), (5, 5)), constant_values=255)
                reads.extend(self.delegate.recognize_boxes(digit, [(0, 0, digit.shape[1], digit.shape[0])], allowlist))
            text = ''.join(t for t, _ in reads)
            confidence = min([c for _, c in reads] or [0.0])
            # Low-confidence fragments cannot establish grid anchors or bind a key.
            out.append((text if confidence >= .9 and _NUM_RE.fullmatch(text) else '', confidence))
        return out


def _runs(mask):
    changes = np.diff(np.r_[False, mask, False].astype(int))
    return list(zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)))


def _shaded_grid_boxes(gray):
    """Observed alternating shaded number cells and white answer cells; no ordinal inference."""
    bands = _runs(np.median(gray, axis=0) < 230)
    if len(bands) != 10:
        return None
    widths = np.array([b-a for a, b in bands])
    pitches = np.diff([(a+b)/2 for a, b in bands])
    if min(widths) < 20 or max(widths)/min(widths) > 1.25 or max(pitches)/min(pitches) > 1.15:
        return None
    if not 1.7 <= np.median(pitches)/np.median(widths) <= 2.4:
        return None
    rulers = _runs(np.percentile(gray[:, bands[0][0]:bands[-1][1]], 80, axis=1) < 245)
    if len(rulers) != 11:
        return None
    row_pitch = np.diff([(a+b)/2 for a, b in rulers])
    if min(row_pitch) < 20 or max(row_pitch)/min(row_pitch) > 1.15:
        return None
    pairs = []
    for left, right in bands:
        width = right-left
        for row in range(10):
            top, bottom = rulers[row][1]+6, rulers[row+1][0]-6
            nbox = (int(left+.23*width), int(top), int(right-.23*width), int(bottom))
            lbox = (int(right+.20*width), int(top), int(right+.80*width), int(bottom))
            if bottom-top < 8 or lbox[2] > gray.shape[1]:
                return None
            pairs.append((nbox, lbox))
    return pairs


def _read_shaded_grid(layer, page, region, cache, expected, part_of, gray):
    if cv2 is None or len(expected) != 100 or not hasattr(cache, 'engine'):
        return None
    boxes = _shaded_grid_boxes(gray)
    if boxes is None:
        return None
    num_boxes, let_boxes = zip(*boxes)
    number_reads = []
    for mode in ('OTSU', 'LOCAL_THRESHOLD'):
        own_cache = RegionOcrCache(cache.root, _DigitCellEngine(cache.engine, mode))
        number_reads.append(_recognize(layer, page, region, own_cache, list(num_boxes), '0123456789', 'P0'))
        cache.hits += own_cache.hits
        cache.misses += own_cache.misses
        cache.pages_touched.update(own_cache.pages_touched)
    letters = [_recognize(layer, page, region, cache, list(let_boxes), LETTERS, prep) for prep in ('P1', 'P2')]
    pairs = [((nbox, a, b), (lbox, c, d)) for (nbox, lbox), a, b, c, d in
             zip(boxes, *number_reads, *letters)]
    cols = _grid_lines([(b[0]+b[2])/2 for b in num_boxes], 1)
    rows = _grid_lines([(b[1]+b[3])/2 for b in num_boxes], 1)
    blk = KeyBlock(None, page, region)
    _lattice(blk, pairs, float(np.median([b[3]-b[1] for b in num_boxes])), expected,
             layer, page, region, part_of, cache=cache, physical_grid=(cols, rows))
    if blk.orientation is None:
        return None
    _glyph_consistency(blk, gray, region)
    blk.diagnostics.append(('ANSWER_KEY_PHYSICAL_CELL_READ',
                            'observed shaded cells; own segmented digit reads and printed lattice proof', None))
    return blk


def read_block(layer, page: int, bbox: tuple, cache, expected: range, part_of=None) -> KeyBlock:
    """Read one test's key table inside bbox (PDF points). expected = the question range of this block."""
    blk = KeyBlock(None, page, bbox)
    img = render_region(layer, page, bbox, KEY_DPI)
    gray = preprocess.to_gray(img)
    toks = _tokens(_ink(gray))
    if not toks:
        blk.diagnostics.append(("ANSWER_KEY_NOT_FOUND", "no glyph tokens in the block", None))
        return blk
    ch = float(np.median([t.y1 - t.y0 for t in toks]))
    classified = [(t, *_classify(t, ch)) for t in toks]
    number_centres = [(nb[0] + nb[2]) / 2 for _t, kind, nb, _lb in classified if kind in ('NUMBER', 'ENTRY')]
    number_columns = _grid_lines(number_centres, 1.2 * ch) if number_centres else []
    number_pitch = float(np.median(np.diff(number_columns))) if len(number_columns) >= 3 else 0.0
    entries = []     # (number_box_px, letter_box_px)
    numbers, letters = [], []
    for t, kind, nb, lb in classified:
        # '181' and '141' can resemble a parenthesised letter: two narrow 1s
        # surround a wide centre glyph. Keep the WHOLE token in a proven number
        # column, then let independent digit recognition prove its own value.
        if (kind == 'LETTER' and len(t.comps) >= 3 and number_pitch > 4 * ch
                and min(abs(t.cx - x) for x in number_columns) <= 0.2 * number_pitch):
            kind, nb, lb = 'NUMBER', _box(t.comps), None
        if kind == "ENTRY":
            entries.append((nb, lb))
        elif kind == "LETTER":
            letters.append(lb)
        else:
            numbers.append(nb)
    # single glyph blobs are letters or (fused) digits: an open read decides which allow-list applies
    numeric_columns = _grid_lines([(b[0] + b[2]) / 2 for b in numbers], 1.2 * ch) if numbers else []
    if len(numeric_columns) >= 3 and float(np.median(np.diff(numeric_columns))) > 4 * ch:
        # Unparenthesised grids have separate number and answer columns.
        # Geometry selects the alphabet; an A read as '4' must not move into
        # the numeric lattice. Every selected glyph is still independently read.
        tolerance = 0.25 * float(np.median(np.diff(numeric_columns)))
        if expected.start == 1:
            previous = numeric_columns[0] - 4 * tolerance
            candidates = [b for b in letters if abs((b[0] + b[2]) / 2 - previous) <= tolerance]
            if len(candidates) >= 4:
                numeric_columns.insert(0, previous)
        lone_nums = [b for b in letters if min(abs((b[0] + b[2]) / 2 - x) for x in numeric_columns) <= tolerance]
        letters = [b for b in letters if b not in lone_nums]
    else:
        kind = _recognize(layer, page, bbox, cache, letters, "0123456789ABCD", READ_A)
        lone_nums = [b for b, k in zip(letters, kind) if k[0][:1].isdigit()]
        letters = [b for b, k in zip(letters, kind) if not k[0][:1].isdigit()]
    num_boxes = [e[0] for e in entries] + numbers + lone_nums
    let_boxes = [e[1] for e in entries] + letters
    # two independent reads per cell (different preprocessing), each constrained to its alphabet
    r_num = _recognize(layer, page, bbox, cache, num_boxes, "0123456789", READ_A)
    r_num2 = _recognize(layer, page, bbox, cache, num_boxes, "0123456789", READ_B)
    r_let = _recognize(layer, page, bbox, cache, let_boxes, LETTERS, READ_A)
    r_let2 = _recognize(layer, page, bbox, cache, let_boxes, LETTERS, READ_B)
    nums = [(b, a, c) for b, a, c in zip(num_boxes, r_num, r_num2)]
    lets = [(b, a, c) for b, a, c in zip(let_boxes, r_let, r_let2)]
    # pair: entries pair themselves; loose numbers pair with the nearest letter to the right on the same row
    pairs = []
    used = set()
    for i, (nb, lb) in enumerate(entries):
        pairs.append((nums[i], lets[i]))
        used.add(i)
    loose_lets = lets[len(entries):]
    taken = set()
    for nrec in nums[len(entries):]:
        nb = nrec[0]
        cands = [(lb[0] - nb[2], j) for j, (lb, *_r) in enumerate(loose_lets)
                 if j not in taken and lb[0] >= nb[2] - 2 and abs((lb[1] + lb[3]) / 2 - (nb[1] + nb[3]) / 2) <= 0.6 * ch]
        if cands:
            _d, j = min(cands)
            # no other number between this number and its letter
            if not any(o[0][0] > nb[2] and o[0][2] < loose_lets[j][0][0] and abs(o[0][1] - nb[1]) < 0.6 * ch
                       for o in nums if o is not nrec):
                taken.add(j)
                pairs.append((nrec, loose_lets[j]))
                continue
        pairs.append((nrec, None))
    skew = -preprocess.deskew_angle(gray, max_deg=2.0, step=0.1)   # image angle (deskew_angle = correction)
    blk.skew = skew
    # Projection deskew can follow the table border rather than its number rows.
    # Prefer the unrotated grid when the printed numbers already prove it.
    _lattice(blk, pairs, ch, expected, layer, page, bbox, part_of, 0.0, cache)
    blk.skew = 0.0
    if blk.orientation is None:
        # Warped page borders need not follow the glyph rows. Candidate angles
        # may also come from independently agreeing printed number anchors.
        # Every candidate still goes through the unchanged lattice/cell proof.
        for candidate in [skew, *_number_row_angles(pairs, ch, expected)]:
            if not candidate:
                continue
            rotated = KeyBlock(None, page, bbox)
            _lattice(rotated, pairs, ch, expected, layer, page, bbox, part_of, candidate, cache)
            if rotated.orientation is not None:
                blk = rotated
                blk.skew = candidate
                break
    _glyph_consistency(blk, gray, bbox)
    if blk.orientation is None:
        fallback = _read_shaded_grid(layer, page, bbox, cache, expected, part_of, gray)
        if fallback is not None:
            return fallback
    return blk


def _number_row_angles(pairs: list, ch: float, expected: range) -> list:
    """Geometry candidates for a 100-cell grid, using its OWN equal digit reads.

    Try both 10x10 orientations. Neither predicts an unread cell or test title.
    At least three straight rows must support the same small angle.
    """
    if len(expected) != 100:
        return []
    anchors = []
    for number, _letter in pairs:
        box, a, b = number
        if a[0] == b[0] and _NUM_RE.fullmatch(a[0] or '') and int(a[0]) in expected:
            anchors.append((int(a[0]) - expected.start, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2))
    out = []
    for column_major in (True, False):
        slopes = []
        for row in range(10):
            points = [(x, y) for n, x, y in anchors if (n % 10 if column_major else n // 10) == row]
            if len(points) < 4:
                continue
            xs, ys = np.array(points).T
            if np.ptp(xs) < 10 * ch:
                continue
            slope, intercept = np.polyfit(xs, ys, 1)
            if np.max(np.abs(ys - (slope * xs + intercept))) <= 0.5 * ch:
                slopes.append(float(np.degrees(np.arctan(slope))))
        if len(slopes) >= 3:
            angle = float(np.median(slopes))
            if abs(angle) <= 2 and max(abs(s - angle) for s in slopes) <= 0.25:
                out.append(angle)
    return out


def _recognize(layer, page, region, cache, boxes_px: list, allow: str, pipeline: str) -> list:
    if not boxes_px:
        return []
    boxes_pt = [_px_box_pt(b, region, KEY_DPI) for b in boxes_px]
    res = cache.recognize(layer, page, region, dpi=KEY_DPI, pipeline=pipeline, allowlist=allow, boxes_pt=boxes_pt)
    if res is None:
        return [("", 0.0)] * len(boxes_px)
    return [(w.text.strip(), w.conf) for w in res.words]


def _cluster(values: list, tol: float) -> list:
    """1-D clustering -> cluster index per value (sorted cluster order)."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    idx = [0] * len(values)
    centres = []
    for i in order:
        v = values[i]
        if centres and abs(v - centres[-1][0]) <= tol:
            c = centres[-1]
            c[1].append(v)
            c[0] = sum(c[1]) / len(c[1])
        else:
            centres.append([v, [v]])
        idx[i] = len(centres) - 1
    return idx


def _grid_lines(values: list, tol: float) -> list:
    """Centres of 1-D clusters holding a real share of the anchors (>= 30 % of the median cluster size)."""
    idx = _cluster(values, tol)
    groups: dict = {}
    for v, i in zip(values, idx):
        groups.setdefault(i, []).append(v)
    sizes = sorted(len(g) for g in groups.values())
    med = sizes[len(sizes) // 2]
    return sorted(sum(g) / len(g) for g in groups.values() if len(g) >= max(2, 0.3 * med))


def _nearest(lines: list, v: float, tol: float) -> Optional[int]:
    best = min(range(len(lines)), key=lambda i: abs(lines[i] - v)) if lines else None
    return best if best is not None and abs(lines[best] - v) <= tol else None


def _lattice(blk: KeyBlock, pairs: list, ch: float, expected: range, layer, page, region, part_of,
             skew: float = 0.0, cache=None, physical_grid=None) -> None:
    if not pairs:
        blk.diagnostics.append(("ANSWER_KEY_NOT_FOUND", "no number/letter pairs", None))
        return
    xs = [(p[0][0][0] + p[0][0][2]) / 2 for p in pairs]
    ys = [(p[0][0][1] + p[0][0][3]) / 2 for p in pairs]
    if skew:
        # cluster in a de-skewed frame (crops stay axis-aligned: a token is far smaller than the skew effect)
        t = np.tan(np.radians(skew))
        xs, ys = [x + y * t for x, y in zip(xs, ys)], [y - x * t for x, y in zip(xs, ys)]
    reads = []
    for p in pairs:
        a, b = p[0][1], p[0][2]
        va = int(a[0]) if _NUM_RE.match(a[0] or "") else None
        vb = int(b[0]) if _NUM_RE.match(b[0] or "") else None
        reads.append((va, vb))
    anchors = [i for i, (va, vb) in enumerate(reads) if va is not None and va == vb and va in expected]
    if expected.start == 1:
        # In LC grids an isolated A/B/D glyph can be read twice as 4/8/0.
        # Locate the multi-digit number columns first. One-digit anchors are
        # possible only in the preceding column, never in the answer columns.
        multi = [i for i in anchors if reads[i][0] >= 10]
        multi_cols = _grid_lines([xs[i] for i in multi], 1.2 * ch) if multi else []
        if len(multi_cols) >= 3:
            pitch = float(np.median(np.diff(multi_cols)))
            first = multi_cols[0] - pitch
            preceding = [i for i in anchors if reads[i][0] < 10 and abs(xs[i] - first) <= 0.25 * pitch]
            number_columns = [first] if len(preceding) >= 4 else multi_cols
            # Row-major compact tables print1–9 in the SAME number columns
            # as11–100. Only a column-major grid has a preceding one-digit
            # column. Answer columns remain excluded in either layout.
            anchors = [i for i in anchors if reads[i][0] >= 10
                       or min(abs(xs[i] - x) for x in number_columns) <= 0.25 * pitch]
    if len(anchors) < 4:
        blk.diagnostics.append(("ANSWER_KEY_SEQUENCE_UNPROVEN", f"only {len(anchors)} agreeing number reads", None))
        return
    # grid lines from anchors only; sparse clusters (QR fragments, header remnants) are not grid lines
    cols = physical_grid[0] if physical_grid is not None else _grid_lines([xs[i] for i in anchors], 1.2 * ch)
    rows_ = physical_grid[1] if physical_grid is not None else _grid_lines([ys[i] for i in anchors], 0.6 * ch)
    # snap to grid lines within 40 % of the measured pitch (falls back to glyph-relative tolerance)
    tx = 0.4 * float(np.median(np.diff(cols))) if len(cols) > 1 else 1.2 * ch
    ty = 0.4 * float(np.median(np.diff(rows_))) if len(rows_) > 1 else 0.6 * ch
    col = [_nearest(cols, x, tx) for x in xs]
    row = [_nearest(rows_, y, ty) for y in ys]
    # strides from neighbouring anchors (same row: next column; same column: next row)
    da, db = Counter(), Counter()
    for i in anchors:
        for j in anchors:
            if col[i] is None or row[i] is None or col[j] is None or row[j] is None:
                continue
            if row[i] == row[j] and col[j] == col[i] + 1:
                da[reads[j][0] - reads[i][0]] += 1
            if col[i] == col[j] and row[j] == row[i] + 1:
                db[reads[j][0] - reads[i][0]] += 1
    if not da or not db:
        blk.diagnostics.append(("ANSWER_KEY_SEQUENCE_UNPROVEN", "grid strides not measurable", None))
        return
    a, b = da.most_common(1)[0][0], db.most_common(1)[0][0]
    on_grid = [i for i in anchors if col[i] is not None and row[i] is not None]
    bases = Counter(reads[i][0] - a * col[i] - b * row[i] for i in on_grid)
    base, support = bases.most_common(1)[0]
    orient = "COLUMN_MAJOR" if b == 1 else "ROW_MAJOR" if a == 1 else f"STRIDE_{a}_{b}"
    blk.orientation, blk.base = orient, base
    blk.lattice_support = round(support / max(1, len(on_grid)), 3)
    # proof of the sequence: >= 90 % of the grid-placed, independently read numbers agree with ONE numbering,
    # and >= 80 % of all agreeing reads sit on the grid
    if blk.lattice_support < 0.9 or len(on_grid) < 0.8 * len(anchors) or 1 not in (a, b):
        blk.diagnostics.append(("ANSWER_KEY_SEQUENCE_UNPROVEN",
                                f"lattice support {support}/{len(on_grid)} on-grid anchors ({len(anchors)} total), "
                                f"strides {a}/{b}", None))
        blk.orientation = None
        return
    seen = Counter()
    for p, (va, vb), c, r in zip(pairs, reads, col, row):
        if c is None or r is None:
            continue                       # off-grid token (not part of the table)
        pred = base + a * c + b * r
        nbox = _px_box_pt(p[0][0], region, KEY_DPI, 1)
        lrec = p[1]
        cell = KeyCell(None, pred, None, "NUMBER_UNREAD", page, nbox,
                       _px_box_pt(lrec[0], region, KEY_DPI, 1) if lrec else None,
                       [p[0][1][0], p[0][2][0]], [lrec[1][0], lrec[2][0]] if lrec else [])
        if pred not in expected:
            cell.status = "OUT_OF_RANGE"
            blk.cells.append(cell)
            continue
        if va == pred or vb == pred:
            other = vb if va == pred else va
            if other is not None and other != pred and other in expected:
                cell.status = "LATTICE_CONFLICT"     # two reads name two different valid questions
            else:
                cell.number = pred
                cell.status = "LETTER_UNCERTAIN"
        elif va is not None or vb is not None:
            cell.status = "LATTICE_CONFLICT"
        if cell.number is None and cache is not None:
            # Both initial reads can drop one of a compact number's digits.
            # Re-read its own padded glyph independently of the predicted value;
            # three of four fresh readings must agree with the proven lattice.
            extra = _reread_number(layer, page, nbox, cache, cell.letter_bbox)
            cell.number_reads.extend(extra)
            if len(extra) == 4 and extra.count(str(pred)) < 3:
                extra = _reread_number(layer, page, nbox, cache, cell.letter_bbox, high_resolution=True)
                cell.number_reads.extend(extra)
            if len(extra) == 4 and extra.count(str(pred)) >= 3:
                cell.number, cell.status, cell.adjudicated = pred, "LETTER_UNCERTAIN", True
                blk.diagnostics.append(("ANSWER_KEY_CELL_REREAD",
                                        f"Q{pred}: fresh glyph reads {extra} -> 3 of 4 agree with the lattice",
                                        str(pred)))
        if cell.number is not None:
            seen[pred] += 1
            if lrec is None:
                cell.status = "LETTER_MISSING"
            else:
                la, lb2 = _LET_RE.match(lrec[1][0] or ""), _LET_RE.match(lrec[2][0] or "")
                if not (la and lb2 and la.group(1) == lb2.group(1)) and cache is not None:
                    extra = _reread_letter(layer, page, cell.letter_bbox, cache)
                    cell.letter_reads.extend(extra)
                    # Two new independent readings must agree with at least
                    # one original reading: own glyph proof, never key frequency.
                    if len(extra) == 2 and extra[0] == extra[1] and _LET_RE.fullmatch(extra[0] or ''):
                        letter = extra[0]
                        if letter in [match.group(1) for match in (la, lb2) if match]:
                            la = lb2 = _LET_RE.fullmatch(letter)
                if la and lb2 and la.group(1) == lb2.group(1):
                    letter = la.group(1)
                    part = part_of(pred) if part_of else None
                    if part == 2 and letter == "D":
                        cell.status = "SYNTAX_INVALID"
                    else:
                        cell.letter = letter
                        cell.status = "CONFIRMED"
                        cell.confidence = CONFIDENT
        blk.cells.append(cell)
    for q, k in seen.items():
        if k > 1:
            for c in blk.cells:
                if c.predicted == q:
                    c.status, c.letter, c.confidence = "DUPLICATE", None, UNRESOLVED


REREAD_DPI = 600
REREAD_PIPELINES = ("P0", "P2")     # plain grey / Otsu-binarised: independent of the P5 / P6 table reads


def _reread_number(layer, page: int, nbox: tuple, cache, letter_box=None, *, high_resolution=False) -> list:
    """Four independent own-number reads with whitespace, excluding the adjacent answer."""
    x0, y0, x1, y1 = nbox
    right = min(x1 + 2, letter_box[0] - .5) if letter_box and letter_box[0] > x1 else x1 + 2
    vertical_pad = 2 if high_resolution else 4
    crop = (max(0, x0 - 2), max(0, y0 - vertical_pad), right, y1 + vertical_pad)
    out = []
    modes = ((900, 'P0'), (900, 'P2'), (600, 'P5'), (600, 'P6')) if high_resolution else (
        (600, 'P0'), (600, 'P2'), (450, 'P0'), (450, 'P2'))
    for dpi, pipe in modes:
        res = cache.recognize(layer, page, crop, dpi=dpi, pipeline=pipe, allowlist="0123456789",
                              boxes_pt=[crop])
        text = res.words[0].text.strip() if res is not None and res.words else ""
        out.append(text if _NUM_RE.fullmatch(text) else "")
    return out


def _reread_letter(layer, page: int, bbox: tuple, cache) -> list:
    x0, y0, x1, y1 = bbox
    crop = (max(0, x0 - 2), max(0, y0 - 4), x1 + 2, y1 + 4)
    out = []
    for pipeline in ('P0', 'P2'):
        result = cache.recognize(layer, page, crop, dpi=600, pipeline=pipeline,
                                 allowlist=LETTERS, boxes_pt=[crop])
        out.append(result.words[0].text.strip() if result and result.words else '')
    return out


def _glyph_consistency(blk: KeyBlock, gray: np.ndarray, region: tuple) -> None:
    """Third, model-free signal: each confirmed letter glyph must be nearest to its own letter's centroid."""
    conf = [c for c in blk.cells if c.status == "CONFIRMED" and c.letter_bbox]
    if len(conf) < 8:
        return
    vecs = []
    bw = preprocess.binarize(preprocess.stretch(preprocess.normalize_background(gray))) < 128
    for c in conf:
        x0, y0, x1, y1 = pt_to_px(c.letter_bbox, region, KEY_DPI)
        m = bw[max(0, int(y0)):int(y1), max(0, int(x0)):int(x1)].astype(np.uint8)
        if m.size == 0:
            vecs.append(None)
            continue
        ys, xs = np.where(m)
        if len(xs) == 0:
            vecs.append(None)
            continue
        m = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        v = cv2.resize(m.astype(np.float32), (16, 20), interpolation=cv2.INTER_AREA).ravel()
        vecs.append(v / (np.linalg.norm(v) or 1.0))
    cents = {}
    for L in LETTERS:
        vs = [v for v, c in zip(vecs, conf) if v is not None and c.letter == L]
        if vs:
            cents[L] = np.mean(vs, axis=0)
    for v, c in zip(vecs, conf):
        if v is None:
            c.status, c.letter, c.confidence = "LETTER_UNCERTAIN", None, UNRESOLVED
            continue
        near = min(cents, key=lambda L: float(np.linalg.norm(v - cents[L])))
        if near != c.letter:
            c.status, c.letter, c.confidence = "LETTER_UNCERTAIN", None, UNRESOLVED


# ── page level: headers -> blocks ─────────────────────────────────────────────────────────────

def reread_plain_key_title(layer, page: int, cache, bbox: tuple, padding: float = 3) -> tuple:
    """Three of four fresh caption readings must contain the same explicit TEST identity."""
    x0, y0, x1, y1 = bbox
    crop = (max(0, x0 - padding), max(0, y0 - padding), x1 + padding, y1 + padding)
    reads = []
    for dpi, pipeline in ((600, 'P0'), (600, 'P2'), (450, 'P0'), (450, 'P2')):
        result = cache.recognize(layer, page, crop, dpi=dpi, pipeline=pipeline, boxes_pt=[crop])
        text = ' '.join(word.text for word in result.words) if result else ''
        identities = {int(m.group(1) or m.group(2)) for m in _HEADER_RE.finditer(text)}
        reads.append(next(iter(identities)) if len(identities) == 1 and 1 <= next(iter(identities)) <= 10 else None)
    proven = {number for number in reads if number is not None and reads.count(number) >= 3}
    return (next(iter(proven)) if len(proven) == 1 else None), reads


def reread_economy_outlined_key_digit(layer, page, cache, bbox):
    """Read the actual numeral column, excluding outlined title letters/rules.

    Source-measured columns differ between the two immutable RC key pages.
    The caption proposes its vertical band; neither table order nor an
    expected test number is supplied to the recognizer.
    """
    if getattr(layer,'sha256',None)!='2bdf12f5b166a132010d6bd4ded4ab35cd9320be2e4120a24f6b0d5d1c42534c' or page not in (269,270):
        return None,[]
    x0,y0,x1,y1=bbox
    if not 90<=x0<=105 or not 135<=x1<=155:return None,[]
    crop=(139,y0+2,145.5,min(y1,y0+9.5)) if page==269 else (144,y0+.94,149.5,min(y1,y0+9.44))
    reads=[]
    for dpi,prep in ((600,'P0'),(600,'P2'),(450,'P0'),(450,'P6')):
        result=cache.recognize(layer,page,crop,dpi=dpi,pipeline=prep,allowlist='0123456789',boxes_pt=[crop])
        text=result.words[0].text.strip() if result and len(result.words)==1 and result.words[0].conf>=.6 else ''
        reads.append(int(text) if re.fullmatch('[1-9]',text) else None)
    proven={n for n in reads if n is not None and reads.count(n)>=3}
    return (next(iter(proven)) if len(proven)==1 else None),reads


def find_blocks(layer, page: int, cache) -> list:
    """Test blocks of a key page: [(test_number, bbox_pt, header_text)] from 'Test n' headers.

    Headers are read on the normal image and on inverted dark bars (white-on-grey headers)."""
    w, h = layer.page_size(page)
    heads = []
    bars = []
    # A page may mix ordinary and inverse-video headers. Finding one normal header
    # does not prove that the other test blocks were detected. Merge both reads.
    for pipeline in ("P1", "P4"):
        res = cache.recognize(layer, page, (0, 0, w, h), dpi=150, pipeline=pipeline)
        bare = []
        for wd in (res.words if res else []):
            m = _HEADER_RE.search(wd.text)
            if m and len(wd.text) <= 30:
                heads.append((int(m.group(1) or m.group(2)), tuple(wd.bbox), wd.text))
            elif re.search(r"T\s*[eE]\s*[sS5]\s*[tT][^\w]*$", wd.text) and len(wd.text) <= 20:
                bare.append(wd)
        # 'Actual Test' whose number was not part of the detected word: re-read the number from its own pixels
        # (digits allow-list); accepted only if it is consistent with the other headers' top-to-bottom order
        for wd in bare:
            x0, y0, x1, y1 = wd.bbox
            hh = y1 - y0
            box = (x1, y0 - 1, x1 + 2.2 * hh, y1 + 1)
            rr = cache.recognize(layer, page, (0, 0, w, h), dpi=300, pipeline=pipeline, allowlist="0123456789",
                                 boxes_pt=[box])
            txt = rr.words[0].text if rr and rr.words else ""
            if re.fullmatch(r"\d{1,2}", txt) and rr.words[0].conf >= 0.5:
                n = int(txt)
                below = [t for t, b, _ in heads if b[1] > y1]
                above = [t for t, b, _ in heads if b[3] < y0]
                if all(n < t for t in below) and all(n > t for t in above):
                    heads.append((n, (x0, y0, box[2], y1), wd.text + " " + txt))
    # Small handwritten chapter captions can read "Ackual tesk 07" at page
    # resolution. That only proposes an own-caption crop, never its test number.
    proposals = cache.recognize(layer, page, (0, 0, w, h), dpi=300, pipeline='P1')
    for word in (proposals.words if proposals else []):
        caption = word.text.strip('" ')
        explicit = _HEADER_RE.search(caption)
        noisy_actual = re.match(r'^A.{0,18}?(?:\s+[tTfFiI][eEiI][sS5][tTiIlL1]?|'
                                r'[vVtT][eE][sS5][tT]\s*[\dOo]{1,2}\b)', caption)
        if len(caption) > 30 or not (explicit or noisy_actual):
            continue
        number, reads = reread_plain_key_title(layer, page, cache, tuple(word.bbox))
        if number is None:
            # Excess white margin can merge a tiny handwritten digit with its
            # neighbour. A tighter own-caption crop must independently satisfy
            # the same three-of-four explicit TEST rule; no O-to-0 substitution.
            number, tighter_reads = reread_plain_key_title(layer, page, cache, tuple(word.bbox), padding=2)
            reads = reads + tighter_reads
        if number is None and getattr(layer, 'doc', None) is not None:
            # Outlined captions can lose the final numeral from the detector's
            # word box. Widen only that same physical label, and demand a new
            # three-of-four explicit TEST consensus. No neighboring identity
            # or table position supplies the missing number.
            x0, y0, x1, y1 = word.bbox
            extended = (x0, y0, min(w, x1 + 1.2 * (y1 - y0)), y1)
            number, wider_reads = reread_plain_key_title(layer, page, cache, extended, padding=1)
            reads = reads + wider_reads
        own_number,own=reread_economy_outlined_key_digit(layer,page,cache,tuple(word.bbox))
        if own_number is not None:number=own_number
        reads=reads+own
        if number is None and own and page==269:
            x0,y0,x1,y1=word.bbox
            crop=(139,y0+1,145,min(y1,y0+9))
            fallback=[]
            for prep in ('P0','P2','P5','P6'):
                result=cache.recognize(layer,page,crop,dpi=600,pipeline=prep,allowlist='0123456789',boxes_pt=[crop])
                text=result.words[0].text.strip() if result and len(result.words)==1 and result.words[0].conf>=.6 else ''
                fallback.append(int(text) if re.fullmatch('[1-9]',text) else None)
            proven={n for n in fallback if n is not None and fallback.count(n)>=3}
            if len(proven)==1:number=next(iter(proven))
            reads+=fallback
        x0, y0, x1, y1 = word.bbox
        if number is not None:
            heads = [head for head in heads if not (head[1][0] < x1 and head[1][2] > x0
                     and head[1][1] < y1 and head[1][3] > y0)]
        if number is not None or not any(head[1][0] < x1 and head[1][2] > x0
                                       and head[1][1] < y1 and head[1][3] > y0 for head in heads):
            heads.append((number, tuple(word.bbox), 'OWN_CAPTION_3_OF_4 ' + str(reads)))
    heads = _dedupe_heads(heads)
    if cv2 is not None and getattr(layer, "doc", None) is not None:
        gray = preprocess.to_gray(render_region(layer, page, (0, 0, w, h), 150))
        # A blurred inverse title still separates two tables. Retain its physical
        # boundary with NO test identity; neighbouring readable titles must not
        # absorb its cells. Only OCR-proven identities can bind a key block.
        for x0, y0, x1, y1 in _dark_bars(preprocess.stretch(preprocess.normalize_background(gray))):
            box = tuple(float(v) * 72 / 150 for v in (x0, y0, x1, y1))
            bars.append(box)
            if not any(abs(b[1] - box[1]) < 12 and b[0] < box[2] and b[2] > box[0]
                       for _n, b, _t in heads):
                heads.append((None, box, "unreadable inverse title"))
        heads.sort(key=lambda t: (t[1][1], t[1][0]))
    blocks = []
    margin = 24.0
    dense_regions = []
    if getattr(layer, 'doc', None) is not None:
        from .layout import analyze_page, LayoutProfile, TEXT, INVERSE
        layout = analyze_page(layer, page, LayoutProfile(name='key-table-boundaries'))
        dense_regions = [r.bbox for r in layout.regions if r.kind == TEXT and r.meta.get('lines', 0) >= 50]
        layout_bars = [r.bbox for r in layout.regions if r.kind == INVERSE and r.meta.get('horizontal')]
        bars.extend(layout_bars)
        # Compact chapter keys can have a faint inverse title which full-page
        # detection misses. Discover that title from its own physical bar only
        # when a dense grid lies immediately below it. Independent normal and
        # inverse reads must agree; chapter offsets/footer identities are not proof.
        for bar in layout_bars:
            grids = [r for r in dense_regions if 0 <= r[1] - bar[3] <= 25
                     and r[0] >= bar[0] - 5 and r[2] <= bar[2] + 5]
            if len(grids) != 1:
                continue
            title = read_compact_key_title(layer, page, cache, bar)
            if title is not None:
                n, box, txt = title
                heads = [head for head in heads if not (head[0] is None
                         and abs(head[1][1] - bar[1]) < 12)]
                heads.append((n, box, txt))
        heads = _dedupe_heads(heads)
        # A navigation footer below the physical grid is not another key block.
        compact_tests = {n for n, b, _t in heads if any(
            abs(bar[1] - b[1]) < 12 and any(0 <= r[1] - bar[3] <= 25
                and r[0] >= bar[0] - 5 and r[2] <= bar[2] + 5 for r in dense_regions)
            for bar in layout_bars)}
        heads = [head for head in heads if not (head[0] in compact_tests
                 and head[1][1] > 0.9 * h)]
    for n, box, txt in heads:
        # block = below its header, left edge just before the header, right edge just before the next header on
        # the same header row, bottom just above the next header below in the same column
        same_row = [b for _n, b, _t in heads if abs(b[1] - box[1]) < 30 and b is not box]
        right = min([b[0] - margin for b in same_row if b[0] > box[0]] + [w - 8])
        # A single centred title (YBM key sheets) labels the whole table.
        # Its x coordinate is not the table's left edge.
        left = 8.0 if len(heads) == 1 else max(0.0, box[0] - margin)
        below = [b for _n, b, _t in heads if b[1] > box[3] + 5 and b[0] < right and b[2] > left]
        bottom = min([b[1] - 4 for b in below] + [h])
        # A compact key grid may sit above the first explanation, rather than
        # filling a page. Its physical title bar and dense glyph region bound
        # the table; surrounding prose never enters its number lattice.
        own_bars = [b for b in bars if abs(b[1] - box[1]) < 12 and b[0] <= box[0] + 5
                    and b[2] >= box[2] - 5 and b[2] - b[0] < 0.6 * w]
        dense = [r for b in own_bars for r in dense_regions
                 if 0 <= r[1] - b[3] <= 25 and r[0] >= b[0] - 5 and r[2] <= b[2] + 5]
        if len(dense) == 1:
            r = dense[0]
            left, right = max(0, r[0] - 5), min(w, r[2] + 5)
            bottom = min(bottom, r[3] + 5)
        blocks.append((n, (left, box[3] + 1, right, bottom), txt))
    return blocks


def read_compact_key_title(layer, page: int, cache, bar) -> tuple | None:
    reads = []
    for pipeline in ('P1', 'P4'):
        result = cache.recognize(layer, page, bar, dpi=450, pipeline=pipeline)
        candidates = [(int(m.group(1) or m.group(2)), tuple(word.bbox), word.text)
                      for word in (result.words if result else [])
                      if word.conf >= 0.6 and len(word.text) <= 30
                      and (m := _HEADER_RE.search(word.text))]
        if len(candidates) != 1:
            return None
        reads.append(candidates[0])
    return reads[0] if reads[0][0] == reads[1][0] else None


def _dark_bars(gray: np.ndarray) -> list:
    m = (gray < 110).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if w > 4 * h and h > 12 and a / (w * h) > 0.5:
            out.append((x, y, x + w, y + h))
    return out


def _dedupe_heads(heads: list) -> list:
    out = []
    for n, box, txt in sorted(heads, key=lambda t: (round(t[1][1] / 20), t[1][0])):
        match = next((i for i, (_n, b, _t) in enumerate(out)
                      if abs(b[1] - box[1]) < 10 and (abs(b[0] - box[0]) < 15 or
                          max(0, min(b[2], box[2]) - max(b[0], box[0])) >=
                          .5 * min(b[2] - b[0], box[2] - box[0]))), None)
        if match is not None:
            previous, previous_box, previous_text = out[match]
            union = (min(previous_box[0], box[0]), min(previous_box[1], box[1]),
                     max(previous_box[2], box[2]), max(previous_box[3], box[3]))
            if previous != n:
                out[match] = (None, union, previous_text + " [conflicting test reads]")
            else:
                out[match] = (previous, union, previous_text)
            continue
        out.append((n, box, txt))
    return out


# ── whole key page -> per-test results + alignment checks ──────────────────────────────────────

def read_key_page(layer, page: int, cache, expected: range, part_of=None) -> list:
    out = []
    blocks = find_blocks(layer, page, cache)
    tests = [b[0] for b in blocks]
    for n, bbox, txt in blocks:
        blk = read_block(layer, page, bbox, cache, expected, part_of)
        blk.test, blk.header_text = n, txt
        if tests.count(n) > 1:
            blk.diagnostics.append(("ANSWER_KEY_BLOCK_UNASSIGNED", f"header 'TEST {n}' read twice on the page", None))
            blk.test = None
        out.append(blk)
    return out


def alignment(blk: KeyBlock, expected: range) -> dict:
    """Start / end / contiguity / duplicates / extras of the CONFIRMED keys vs the expected range."""
    keys = blk.keys()
    nums = sorted(keys)
    missing = [q for q in expected if q not in keys]
    status = Counter(c.status for c in blk.cells)
    return {"test": blk.test, "page": blk.page, "expected": len(expected), "confirmed": len(nums),
            "start": nums[0] if nums else None, "end": nums[-1] if nums else None,
            "missing": missing, "cellStatus": dict(status), "orientation": blk.orientation,
            "latticeSupport": blk.lattice_support, "cellsDetected": len(blk.cells),
            "extras": sorted({c.predicted for c in blk.cells if c.status == "OUT_OF_RANGE"})}
