"""Exam-aware OCR validation, evidence-based repairs and structural quality metrics (Exams Recovery Phase 3.5E/K).

Structure validates OCR; it never creates content:

  * QUESTION_NUMBER_GAP     printed numbers 101, 103, 104 -> 102 is reported, nothing is renumbered
  * OPTION_LABEL_MISSING    options A, C, D -> B is NOT invented. A garbled/lost label is re-recognised from its
                            own pixels (label column crop, allow-list '(ABCD)'); the re-read is accepted only when it
                            equals the letter the A-D sequence expects at that position — agreement of two
                            independent signals (glyph + position). Anything else stays missing.
  * blanks                  answer blanks ('-------' dash runs, drawn rulers) are found in the IMAGE (geometry),
                            not in OCR text (engines drop dashes); OCR debris lying on a blank is replaced by the
                            canonical blank token and counted.

Quality is measured structurally (not character accuracy): question-number recall, option-label recall,
reading-order inversions, blank preservation, answer-key coverage.
"""
from __future__ import annotations

import re
from typing import Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

from . import preprocess
from .ocr_engine import pt_to_px, render_region
from .pdf_layer import DOTS, Row, Token, clean_text

LABEL_RE = re.compile(r"^\(?([A-D])\)?[.,]?$")
CLEAN_LABEL_RE = re.compile(r"^\(([A-D8])\)$")
QNUM_RE = re.compile(r"^(\d{1,3})\s*[.,_:;]\s*(.*)$")
_NUM_PUNCT = re.compile(r"^(\d{1,3})\s*[_:;.,]$")


# ── blanks (geometry) ──────────────────────────────────────────────────────────────────────────

def tonal_photo_boxes(image, width_pt, height_pt):
    """Join grain separated by bright photo regions; text-only boxes cannot qualify.

    Bounded to the page's central image column. Candidate boxes still need an
    independently read printed Part 1 number before becoming a question photo.
    """
    if cv2 is None:
        return []
    gray = preprocess.to_gray(image)
    height, width = gray.shape
    left, right = int(.14*width), int(.86*width)
    body = gray[:,left:right]
    mask = (body < 240).astype(np.uint8)
    size = max(3, round(width*.015))
    joined = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((size,size),np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    boxes = []
    for x,y,w,h,area in stats[1:count]:
        if w < .35*width or h < .15*height or h > .6*height:
            continue
        crop=body[y:y+h,x:x+w]
        if ((crop>60)&(crop<220)).mean() < .1:
            continue
        boxes.append(((left+x)*width_pt/width, y*height_pt/height,
                      (left+x+w)*width_pt/width, (y+h)*height_pt/height))
    return sorted(boxes,key=lambda box:box[1])

def detect_blank_runs(layer, page: int, bbox: tuple, dpi: int = 300, image: Optional[np.ndarray] = None,
                      text_height_pt: Optional[float] = None) -> list:
    """Answer blanks inside a region: runs of >= 4 short aligned dashes, or a solid thin rule.
    -> [(y_pt, x0_pt, x1_pt, kind)]"""
    if cv2 is None:
        return []
    img = image if image is not None else render_region(layer, page, bbox, dpi)
    mask = preprocess.ink_mask(preprocess.to_gray(img)).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    comps = [tuple(stats[i]) for i in range(1, n)]
    hs = [c[3] for c in comps if 6 <= c[3] <= 80]
    if not hs:
        return []
    ch = text_height_pt * dpi / 72 if text_height_pt is not None else float(np.median(hs))
    dashes, rules = [], []
    for x, y, w, h, area in comps:
        # Raster blur can make a printed dash five pixels high at a 22-pixel
        # text height (YBM sheets). Keep the four-piece alignment proof, with
        # pixel-rounded height and a two-to-one dash aspect ratio.
        if h <= max(2, np.ceil(0.25 * ch)) and w >= 1.8 * h:
            if (.15 if text_height_pt is not None else .2) * ch <= w <= 1.6 * ch:
                dashes.append((x, y, w, h))
            elif w > 2.5 * ch:
                rules.append((x, y, w, h))
    dashes.sort(key=lambda d: (d[1], d[0]))
    runs, used = [], set()
    for i, d in enumerate(dashes):
        if i in used:
            continue
        run = [d]
        used.add(i)
        cy = d[1] + d[3] / 2
        for j in range(i + 1, len(dashes)):
            if j in used:
                continue
            e = dashes[j]
            if abs((e[1] + e[3] / 2) - cy) <= 0.2 * ch and 0 <= e[0] - (run[-1][0] + run[-1][2]) <= 1.1 * ch:
                run.append(e)
                used.add(j)
        if len(run) >= 4:
            runs.append((run[0][0], cy, run[-1][0] + run[-1][2], "DASH_RUN"))
    for x, y, w, h in rules:
        runs.append((x, y + h / 2, x + w, "RULER"))
    s = 72.0 / dpi
    return [(bbox[1] + cy * s, bbox[0] + x0 * s, bbox[0] + x1 * s, kind) for x0, cy, x1, kind in runs]


def insert_blanks(rows: list, blanks: list) -> dict:
    """Place a canonical blank token on the row carrying each blank; OCR debris on the blank is replaced."""
    stats = {"blanks": len(blanks), "placed": 0, "debrisReplaced": 0, "underlineSkipped": 0}
    for y, x0, x1, kind in blanks:
        best = None
        for r in rows:
            h = max(r.y1 - r.y0, 1.0)
            if (r.y0 - 0.2 * h <= y <= r.y1 + 0.35 * h
                    and r.x0 - 1.5 * h <= x1 and r.x1 + 1.5 * h >= x0):
                d = abs((r.y0 + r.y1) / 2 - y)
                if best is None or d < best[0]:
                    best = (d, r)
        if best is None:
            continue
        r = best[1]
        if kind == "RULER" and any(t.x0 < x1 - 2 and t.x1 > x0 + 2 and re.search(r"[A-Za-z]{2}", t.text)
                                   and _overlap(t, x0, x1) < 0.7 for t in r.tokens):
            stats["underlineSkipped"] += 1      # a rule under words is an underline, not a blank
            continue
        # Line segmentation and region recovery can see the same dash run
        # at different widths. They are one physical blank when most of the
        # smaller span overlaps; preserve the full observed ink span.
        for token in r.tokens:
            if token.text == DOTS and max(0, min(token.x1, x1) - max(token.x0, x0)) >= .7 * min(token.x1-token.x0, x1-x0):
                x0, x1 = min(x0, token.x0), max(x1, token.x1)
        keep = []
        for t in r.tokens:
            if _overlap(t, x0, x1) >= 0.7:
                stats["debrisReplaced"] += 1
                continue
            keep.append(t)
        keep.append(Token(DOTS, x0, x1))
        keep.sort(key=lambda t: t.x0)
        r.tokens = keep
        r.x0, r.x1 = min(r.x0, x0), max(r.x1, x1)
        stats["placed"] += 1
    return stats


def _overlap(t: Token, x0: float, x1: float) -> float:
    w = max(t.x1 - t.x0, 0.1)
    return max(0.0, min(t.x1, x1) - max(t.x0, x0)) / w


def reread_blank_labels(layer, rows: list, cache, lo: int, hi: int) -> int:
    """Part 6 prints a small question number under (or beside) each blank. The strip directly beneath every blank
    is read with a digits allow-list; a label row is inserted only when it reads as ONE number in [lo, hi]."""
    n = 0
    added = []
    for r in rows:
        h = max(r.y1 - r.y0, 1.0)
        for b in [t for t in r.tokens if t.text == DOTS]:
            conflicting_votes = set()
            recovered = False
            for digit_only, read_dpi in ((False, 400), (True, 400), (True, 600)):
                crop = _label_band(layer, r.page, b, r.y0, r.y1 + 1.2 * h, digit_only=digit_only)
                if crop is None:
                    continue
                reads = [cache.recognize(layer, r.page, crop, dpi=read_dpi, pipeline=pipeline,
                                        allowlist="0123456789.", boxes_pt=[crop]) for pipeline in ('P1', 'P2')]
                matches = [_LABEL3.fullmatch(result.words[0].text.strip())
                           if result is not None and len(result.words) == 1 and result.words[0].conf >= .5 else None
                           for result in reads]
                if not all(matches):
                    continue
                m, second_match = matches
                if m.group(1) != second_match.group(1):
                    conflicting_votes.update((m.group(1), second_match.group(1)))
                    continue
                if not lo <= int(m.group(1)) <= hi:
                    continue
                if conflicting_votes and m.group(1) not in conflicting_votes:
                    continue
                res = reads[0]
                lab = Row(r.page, crop[1], crop[3], b.x0, b.x1, [Token(f"{m.group(1)}.", b.x0, b.x1)], "OCR",
                          res.words[0].conf, r.column)
                for k in ("region", "frame"):
                    if hasattr(r, k):
                        setattr(lab, k, getattr(r, k))
                lab.blank_label = True
                lab.blank_label_proof = {'page': r.page, 'bbox': list(crop), 'number': int(m.group(1)),
                                         'reads': [int(m.group(1)), int(second_match.group(1))],
                                         'dpi': read_dpi, 'digitOnly': digit_only,
                                         'sourceSha256': layer.sha256}
                added.append((r, lab))
                n += 1
                recovered = True
                break
            if conflicting_votes and not recovered:
                r.blank_label_conflict = True
    for r, lab in added:
        rows.insert(rows.index(r) + 1, lab)
    return n


def label_glyphs(comps: list, line_h: float) -> list:
    """Components (x, y, w, h) of the label printed just below a blank's dashes.

    Phase 5B: the band of a row that OCR fused with its small label line can reach the NEXT line's blank in the
    same column; only this blank's own dash run (the topmost) counts, and the label lies above any lower run."""
    candidates = [c for c in comps if c[3] <= 6 and c[2] >= 2.2 * c[3]]
    # A short horizontal piece of neighbouring text is not another blank.
    # Require an aligned printed dash run before it can close the label band.
    dashes = [c for c in candidates if sum(abs(c[1]-d[1]) <= 3 for d in candidates) >= 2]
    if not dashes:
        return []
    top = min(c[1] for c in dashes)
    own = [c for c in dashes if c[1] <= top + 6]
    lower_top = min((c[1] for c in dashes if c not in own), default=None)
    dash_bottom = max(c[1] + c[3] for c in own)
    return [c for c in comps if c not in dashes and c[3] >= 0.25 * line_h
            and dash_bottom - 2 <= c[1] <= dash_bottom + 0.8 * line_h
            and (lower_top is None or c[1] + c[3] <= lower_top)]


def _label_band(layer, page: int, b: Token, y0: float, y1: float, dpi: int = 300,
                digit_only: bool = False) -> Optional[tuple]:
    """Bbox (points) of the glyphs printed just below the blank's dashes, within the blank's own column."""
    if cv2 is None:
        return None
    x0, x1 = b.x0 - 8, b.x1 + 8
    img = render_region(layer, page, (x0, y0, x1, y1), dpi)
    m = preprocess.ink_mask(preprocess.to_gray(img)).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    comps = [tuple(st[i][:4]) for i in range(1, n) if st[i][4] >= 4]
    glyphs = label_glyphs(comps, (y1 - y0) / 2.2 * dpi / 72.0)
    if not glyphs:
        return None
    # Only the nearest glyph baseline under this blank is its label. A fused
    # OCR line can extend to the next passage line; that text must not enter
    # the digit crop (YBM Part 6 label strips).
    nearest = min(c[1] for c in glyphs)
    glyph_h = float(np.median([c[3] for c in glyphs]))
    glyphs = [c for c in glyphs if c[1] <= nearest + 0.35 * glyph_h]
    # A printed trailing period is not a digit. On small YBM labels OCR
    # reads it as a fourth digit ("1435"); crop only the tall digit glyphs.
    if digit_only:
        tallest = max(c[3] for c in glyphs)
        glyphs = [c for c in glyphs if c[3] >= .55 * tallest]
    gx0, gy0 = min(c[0] for c in glyphs), min(c[1] for c in glyphs)
    gx1, gy1 = max(c[0] + c[2] for c in glyphs), max(c[1] + c[3] for c in glyphs)
    k = 72.0 / dpi
    return (x0 + (gx0 - 3) * k, y0 + (gy0 - 3) * k,
            x0 + (gx1 + (1 if digit_only else 4)) * k, y0 + (gy1 + 3) * k)


_LABEL3 = re.compile(r"^\(?(\d{3})\)?\.?$")


# ── question blocks + option labels ────────────────────────────────────────────────────────────

def normalize_number_tokens(rows: list) -> int:
    """'109_' / '109:' -> '109.' (punctuation only; digits are never changed). Returns the count."""
    n = 0
    for r in rows:
        if r.tokens and _NUM_PUNCT.match(r.tokens[0].text) and r.tokens[0].text != _NUM_PUNCT.match(r.tokens[0].text).group(1) + ".":
            r.tokens[0].text = _NUM_PUNCT.match(r.tokens[0].text).group(1) + "."     # '109_', '7 .' -> '109.', '7.'
            n += 1
        # '17 .' -> '17.' : the period recognised as its own word right after the number
        h = max(r.y1 - r.y0, 1.0)
        if len(r.tokens) >= 2 and re.fullmatch(r"\d{1,3}", r.tokens[0].text) and r.tokens[1].text in (".", ",") \
                and r.tokens[1].x0 - r.tokens[0].x1 <= 0.6 * h:
            r.tokens[0].text += "."
            r.tokens[0].x1 = r.tokens[1].x1
            del r.tokens[1]
            n += 1
        # Phase 3.6: '61 0 What…' — the period read as a letter-like glyph: a token far narrower than any digit
        # (<= 0.3 line heights) touching the number is its period (the number's own digits are never changed)
        elif len(r.tokens) >= 3 and re.fullmatch(r"\d{1,3}", r.tokens[0].text) and r.tokens[1].text in ("0", "o", "O", "°") \
                and r.tokens[1].x1 - r.tokens[1].x0 <= 0.3 * h and r.tokens[1].x0 - r.tokens[0].x1 <= 0.3 * h:
            r.tokens[0].text += "."
            r.tokens[0].x1 = r.tokens[1].x1
            del r.tokens[1]
            n += 1
        # a speck read as one character in front of an option label ('K (A) To review…') is not text
        if len(r.tokens) >= 2 and len(r.tokens[0].text) == 1 and re.fullmatch(r"\([A-D]\)", r.tokens[1].text) \
                and r.tokens[0].x1 - r.tokens[0].x0 <= 0.25 * h:
            del r.tokens[0]
            r.x0 = r.tokens[0].x0
            n += 1
    return n


def reread_gap_numbers(layer, rows: list, cache, lo: int = 1, hi: int = 40) -> int:
    """Phase 3.6F — IELTS gap numbers WITHOUT font metadata: a completion gap prints its question number
    directly left of the answer line ('19]' / 'Of 40' before '……'). The ink cluster immediately left of every
    blank (within 1.4 line heights) is re-read with a digits-only allow-list; a clean 1-2 digit number in
    [lo, hi] becomes its own token. The group parser still accepts it only as the NEXT number of the printed
    sequence, so a misread can never create or reorder a question. Returns the number of tokens inserted."""
    n = 0
    for r in rows:
        h = max(r.y1 - r.y0, 1.0)
        for i, b in enumerate(list(r.tokens)):
            if b.text != DOTS or i == 0:
                continue
            k = r.tokens.index(b)
            prev = r.tokens[k - 1]
            if re.fullmatch(r"\(?\d{1,2}\)?\.?", prev.text) or b.x0 - prev.x1 > 1.5 * h:
                continue                      # already a clean number, or nothing printed right before the blank
            x0 = max(prev.x0, b.x0 - 1.4 * h)
            crop = (x0 - 1.0, r.y0 - 1.0, b.x0 + 0.5, r.y1 + 1.0)
            res = cache.recognize(layer, r.page, crop, dpi=300, pipeline="P1", allowlist="0123456789",
                                  boxes_pt=[crop])
            txt = res.words[0].text.strip() if res is not None and res.words else ""
            if not re.fullmatch(r"\d{1,2}", txt) or not (lo <= int(txt) <= hi) or res.words[0].conf < 0.5:
                continue
            # the misread token keeps only its text left of the number (if any): 'Of 40' -> 'Of'
            head = prev.text[:-len(txt)].rstrip() if prev.text.endswith(txt) else ""
            if prev.x0 < x0 - 2 and head:
                prev.text, prev.x1 = head, x0 - 1
                r.tokens.insert(k, Token(txt, x0, b.x0 - 0.5))
            else:
                r.tokens[k - 1] = Token(txt, prev.x0, prev.x1)
            n += 1
    return n


def normalize_split_labels(rows: list) -> int:
    """Phase 3.6: re-join glyphs of ONE printed label that the word segmentation split (geometry only, the
    characters are never changed): a row-initial question number '1' + '45.' (touching, together 3 digits) ->
    '145.'; an option label '(' + 'B)' / '(' + 'B' + ')' -> '(B)'; '(D' + '1' (the closing parenthesis read as a
    stroke) -> '(D)'. Returns the number of joins."""
    n = 0
    for r in rows:
        toks = r.tokens
        h = max(r.y1 - r.y0, 1.0)
        # a lone stroke (box border piece) right before a printed question number: '| 150. (A) …'
        if len(toks) >= 2 and toks[0].text in ("|", "1", "I", "l", "!") and toks[0].x1 - toks[0].x0 <= 0.45 * h \
                and re.fullmatch(r"\d{3}[.,]", toks[1].text) and toks[1].x0 - toks[0].x1 >= 0.5 * h:
            del toks[0]
            r.x0 = toks[0].x0
            n += 1
        if len(toks) >= 2 and re.fullmatch(r"\d{1,2}", toks[0].text) and re.fullmatch(r"\d{1,2}[.,]", toks[1].text) \
                and len(toks[0].text + toks[1].text) == 4 and toks[1].x0 - toks[0].x1 <= 0.5 * h:
            toks[0:2] = [Token(toks[0].text + toks[1].text[:-1] + ".", toks[0].x0, toks[1].x1)]
            n += 1
        i = 0
        while i < len(toks) - 1:
            a, b = toks[i], toks[i + 1]
            close = b.x0 - a.x1 <= 0.35 * h
            if a.text == "(" and close and re.fullmatch(r"[A-D]\)?", b.text):
                j = i + 2 if b.text.endswith(")") else i + 2
                end = b.x1
                if not b.text.endswith(")") and i + 2 < len(toks) and toks[i + 2].text in (")", "1", "l", "I", "|") \
                        and toks[i + 2].x0 - b.x1 <= 0.35 * h:
                    end, j = toks[i + 2].x1, i + 3
                toks[i:j] = [Token(f"({b.text[0]})", a.x0, end)]
                n += 1
            elif re.fullmatch(r"\([A-D]", a.text) and close and b.text in (")", "1", "l", "I", "|"):
                toks[i:i + 2] = [Token(f"{a.text})", a.x0, b.x1)]
                n += 1
            i += 1
    return n


_STROKE = {"1", "I", "l", "|", "!", "[", "]", "(", ")", "J", "L"}


def strip_scan_furniture(rows: list) -> int:
    """Phase 3.6 (older scans): remove (a) tokens that are pieces of a box border — a narrow stroke ('1', 'I', '|')
    standing >= 1 line height apart from the text, at the same x in >= 4 rows of the page, as a row's first or
    last token — and (b) background-texture rows: thinner than half a text line and made only of 1-2 character
    debris. A pronoun 'I' at a margin is followed by a normal word space, so it is never a border piece.
    Returns the number of tokens/rows removed."""
    if not rows:
        return 0
    hs = sorted(max(r.y1 - r.y0, 1.0) for r in rows)
    med = hs[len(hs) // 2]
    cands = []                                    # (x_center, row, index)
    for r in rows:
        h = max(r.y1 - r.y0, 1.0)
        toks = r.tokens
        for k in (0, len(toks) - 1) if len(toks) >= 2 else ():
            t = toks[k]
            nb = toks[1] if k == 0 else toks[-2]
            gap = (nb.x0 - t.x1) if k == 0 else (t.x0 - nb.x1)
            if t.text in _STROKE and (t.x1 - t.x0) <= 0.45 * h and gap >= 1.0 * h:
                cands.append(((t.x0 + t.x1) / 2, r, k))
    removed = 0
    drop = []
    for x, r, k in cands:
        same = {id(r2) for x2, r2, _k in cands if abs(x2 - x) <= 3.0 and r2.page == r.page}
        if len(same) >= 4:
            drop.append((r, r.tokens[k]))
    for r, t in drop:
        if t in r.tokens and len(r.tokens) > 1:
            r.tokens.remove(t)
            r.x0, r.x1 = r.tokens[0].x0, r.tokens[-1].x1
            removed += 1
    keep = []
    for r in rows:
        toks = [t.text for t in r.tokens]
        if max(r.y1 - r.y0, 1.0) < 0.5 * med and len(toks) >= 3 and all(len(t) <= 2 for t in toks):
            removed += 1
            continue
        keep.append(r)
    # (c) one printed line read twice (overlapping line bands on a textured scan): the second reading is dropped
    #     when it is far less confident (debris) or a near-duplicate of the fuller reading
    from difflib import SequenceMatcher
    out = []
    for r in keep:
        h = max(r.y1 - r.y0, 1.0)
        dup = False
        for o in keep:
            if o is r or o.page != r.page:
                continue
            ov = min(o.y1, r.y1) - max(o.y0, r.y0)
            if ov < 0.5 * h or not (o.x0 - 5 <= r.x0 and r.x1 <= o.x1 + 5):
                continue
            rt, ot = clean_text(r.text), clean_text(o.text)
            shorter = len(rt) < len(ot) or (len(rt) == len(ot) and (r.y0, r.x0) > (o.y0, o.x0))
            if r.confidence < o.confidence - 0.25 or (
                    shorter and SequenceMatcher(None, rt, ot[:len(rt)]).ratio() >= 0.85):
                dup = True
                break
        if dup:
            removed += 1
            continue
        out.append(r)
    rows[:] = out
    return removed


def question_blocks(rows: list, lo: int, hi: int) -> list:
    """Split rows at printed question numbers in [lo, hi] -> [(number, [rows])] in reading order."""
    out, cur = [], None
    for r in rows:
        m = QNUM_RE.match(clean_text(r.text))
        if m and lo <= int(m.group(1)) <= hi and r.tokens and re.match(r"^\d{1,3}", r.tokens[0].text):
            cur = (int(m.group(1)), [r])
            out.append(cur)
            continue
        if cur is not None:
            cur[1].append(r)
    return out


def recover_stem_blanks(layer, rows: list, lo: int, hi: int) -> list:
    """Re-read missing blanks within one printed stem, before its first option.

    A run must have at least four source dashes. No blank is inferred from the
    interaction type, and an ambiguous/multipage stem is left unchanged.
    """
    locations = []
    for number, block in question_blocks(rows, lo, hi):
        first_option = next((i for i, r in enumerate(block) if r.tokens and CLEAN_LABEL_RE.match(r.tokens[0].text)), None)
        if first_option is None:
            continue
        stem = block[:first_option]
        if not stem or any(DOTS in r.text for r in stem) or len({r.page for r in stem + [block[first_option]]}) != 1:
            continue
        bbox = (min(r.x0 for r in stem), min(r.y0 for r in stem), max(r.x1 for r in stem), block[first_option].y0 - 1)
        # Bleed-through contributes many tiny components and distorts the
        # component median. Use the observed stem line height for this bounded
        # recovery crop; four separate aligned source dashes remain required.
        text_height = float(np.median([r.y1-r.y0 for r in stem]))
        blanks = [b for b in detect_blank_runs(layer, stem[0].page, bbox, dpi=600,
                                             text_height_pt=text_height) if b[3] == 'DASH_RUN']
        dual_mask = False
        if not blanks or len(blanks)==1:
            # Dark source strokes separate from pale reverse-page print.
            # Both masks must independently show the same sole dash run.
            gray = preprocess.to_gray(render_region(layer, stem[0].page, bbox, 600))
            runs = [[b for b in detect_blank_runs(layer, stem[0].page, bbox, dpi=600,
                     image=np.where(gray < threshold, 0, 255).astype(np.uint8),
                     text_height_pt=text_height) if b[3] == 'DASH_RUN'] for threshold in (120,140,160,180)]
            proven=[]
            for left,right in zip(runs,runs[1:]):
                if len(left)!=1 or len(right)!=1:continue
                a,b=left[0],right[0]
                overlap=max(0,min(a[2],b[2])-max(a[1],b[1]))
                if abs(a[0]-b[0]) <= 1 and overlap >= .8*max(a[2]-a[1],b[2]-b[1]):proven.append(b)
            # Multiple agreeing pairs must describe the same physical blank.
            if proven and all(abs(a[0]-proven[0][0])<=1 and
                    max(0,min(a[2],proven[0][2])-max(a[1],proven[0][1])) >=
                    .8*max(a[2]-a[1],proven[0][2]-proven[0][1]) for a in proven):
                blanks=[proven[0]]
                dual_mask = bool(getattr(layer,'sha256',None))
        if len(blanks) != 1:
            continue
        placed = insert_blanks(stem, blanks)['placed']
        if not placed:
            y, x0, x1, _kind = blanks[0]
            blank_row = Row(stem[0].page, y - 1, y + 1, x0, x1, [Token(DOTS, x0, x1)], 'OCR', 1.0, stem[0].column)
            rows.insert(next(i for i, r in enumerate(rows) if r is block[first_option]), blank_row)
        locations.append({'q': number, 'page': stem[0].page, 'bbox': list(bbox),
                          'sourceSha256': getattr(layer,'sha256',None), 'dualMask': dual_mask,
                          'dashRun': list(blanks[0])})
    return locations


def repair_option_labels(layer, blocks: list, cache, expected: int = 4, pad: float = 1.5) -> dict:
    """Re-recognise missing / garbled option labels from the label column of each question block.

    A row receives a label only when the constrained re-read equals the next letter of the A-D sequence."""
    stats = {"blocks": 0, "labelsClean": 0, "labelsRecognised": 0, "labelsMissing": 0, "conflicts": 0,
             "locations": [], "dualReadProofs": []}  # every repair retains its source location
    letters = "ABCD"[:expected]
    for number, rows in blocks:
        stats["blocks"] += 1
        clean = []
        for i, r in enumerate(rows):
            for token in r.tokens[:4]:
                if (CLEAN_LABEL_RE.fullmatch(token.text)
                        and _label_at(r, token.x0, token.x1-token.x0) is not None):
                    clean.append((i, r, token))
                    break
        head = rows[0].tokens if rows else []
        inline_a = (len(head) >= 2 and QNUM_RE.match(head[0].text)
                    and CLEAN_LABEL_RE.fullmatch(head[1].text)
                    and CLEAN_LABEL_RE.fullmatch(head[1].text).group(1) == 'A')
        if inline_a:
            clean.insert(0, (0, rows[0], head[1]))
        if not clean:
            stats["labelsMissing"] += expected
            continue
        lx0 = float(np.median([token.x0 for _i, r, token in clean]))
        lw = float(np.median([token.x1 - token.x0 for _i, r, token in clean]))
        texts = [r.tokens[r.tokens.index(token)+1].x0 for _i, r, token in clean
                 if r.tokens.index(token)+1 < len(r.tokens)]
        tx0 = float(np.median(texts)) if texts else lx0 + 1.4 * lw     # option-text column
        first, first_row, first_label = clean[0]
        k = letters.find(CLEAN_LABEL_RE.match(first_label.text).group(1).replace("8", "B"))
        # options start at the first clean label; only when that label is B/C/D may exactly k earlier rows of the
        # label column be options whose labels were lost (their re-read must still confirm the letter)
        start = first
        if k > 0:
            prev = [i for i in range(first - 1, 0, -1) if abs(rows[i].x0 - lx0) <= 0.6 * lw][:k]
            if len(prev) == k and prev == list(range(first - 1, first - 1 - k, -1)):
                start = first - k
        # rows in the label column, or starting at the option-text column (label lost, or a wrapped option line)
        opts = [r for r in rows[start:] if abs(r.x0 - lx0) <= 0.8 * lw or abs(r.x0 - tx0) <= 0.8 * lw
                or _label_at(r, lx0, lw) is not None
                or (r.tokens and LABEL_RE.match(r.tokens[0].text))]
        seq = 0
        # '145. (A) verify': option (A) printed on the question-number row (Part 6 / pre-2016 layouts) counts
        head = rows[0].tokens
        if inline_a:
            seq = 1
        for r in opts:
            if seq >= expected:
                break
            want = letters[seq]
            lab = _label_at(r, lx0, lw)
            if lab is not None:
                if lab == want or (lab == "8" and want == "B"):
                    # Detached scan debris can precede a clean label. Keep
                    # only the physically aligned label and its full text.
                    label_index = next(i for i, token in enumerate(r.tokens)
                                       if CLEAN_LABEL_RE.fullmatch(token.text)
                                       and abs(token.x0 - lx0) <= .8 * lw)
                    if label_index:
                        r.tokens = r.tokens[label_index:]
                        r.x0 = r.tokens[0].x0
                    stats["labelsClean"] += 1
                    seq += 1
                    continue
                if lab in letters and lab != want:
                    stats["conflicts"] += 1
                    break
            # constrained re-read of the label cell
            crop = (lx0 - pad, r.y0 - pad, lx0 + lw + pad, r.y1 + pad)
            res = cache.recognize(layer, r.page, crop, dpi=300, pipeline="P1", allowlist="(ABCD)", boxes_pt=[crop])
            got = None
            raw = res.words[0].text.strip() if res is not None and res.words else ""
            if not raw:
                continue        # empty label cell: a wrapped line of the previous option, not a lost label
            m = LABEL_RE.match(raw)
            if m and res.words[0].conf >= 0.4:
                got = m.group(1)
            if got == want:
                second = cache.recognize(layer, r.page, crop, dpi=300, pipeline="P2", allowlist="(ABCD)", boxes_pt=[crop])
                second_raw = second.words[0].text.strip() if second is not None and len(second.words) == 1 else ""
                second_match = LABEL_RE.fullmatch(second_raw)
                proven = bool(getattr(layer, 'sha256', None) and second_match and second_match.group(1) == want and second.words[0].conf >= .4)
                r.tokens = [t for t in r.tokens if t.x1 > lx0 + lw + 0.5 or t.x0 > lx0 + lw - 0.5]
                r.tokens.insert(0, Token(f"({want})", lx0, lx0 + lw))
                r.x0 = min(r.x0, lx0)
                stats["labelsRecognised"] += 1
                stats["locations"].append({"q": number, "page": r.page, "dualRead": proven})
                if proven:
                    stats["dualReadProofs"].append({"q": number, "page": r.page, "bbox": list(crop),
                                                   "sourceSha256": layer.sha256, "reads": [got, second_match.group(1)]})
                seq += 1
            else:
                if got is not None:
                    stats["conflicts"] += 1
                stats["labelsMissing"] += expected - seq
                seq = expected
                break
        if seq < expected:
            stats["labelsMissing"] += expected - seq
    return stats


def _label_at(r: Row, lx0: float, lw: float) -> Optional[str]:
    if not r.tokens:
        return None
    for i, t in enumerate(r.tokens[:4]):
        if abs(t.x0 - lx0) > .8 * lw:
            continue
        m = CLEAN_LABEL_RE.fullmatch(t.text)
        if m and all(len(p.text.replace(' ', '')) <= 2 and (not re.search('[A-Za-z]', p.text) or p.text in _STROKE)
                     and p.x1 < t.x0 - .5 * lw for p in r.tokens[:i]):
            return m.group(1)
    return None


# ── structural metrics ─────────────────────────────────────────────────────────────────────────

def structure_metrics(rows: list, expected_numbers: list, options: int = 4, blank_required: bool = False) -> dict:
    """Question-number recall, option-label recall, reading-order inversions and blank preservation."""
    lo, hi = min(expected_numbers), max(expected_numbers)
    blocks = question_blocks(rows, lo, hi)
    found = [n for n, _ in blocks]
    uniq = [n for n in expected_numbers if found.count(n) == 1]
    labels = 0
    blanks = 0
    for n, rs in blocks:
        seen = []
        for r in rs:
            if r.tokens and CLEAN_LABEL_RE.match(r.tokens[0].text):
                seen.append(CLEAN_LABEL_RE.match(r.tokens[0].text).group(1).replace("8", "B"))
            for t in r.tokens[1:]:   # options printed side by side on one line
                m = CLEAN_LABEL_RE.match(t.text)
                if m:
                    seen.append(m.group(1).replace("8", "B"))
        labels += len(set(seen) & set("ABCD"[:options]))
        stem = [t.text for r in rs for t in r.tokens if not (CLEAN_LABEL_RE.match(r.tokens[0].text) if r.tokens else False)]
        if DOTS in stem:
            blanks += 1
    inv = sum(1 for a, b in zip(found, found[1:]) if b < a)
    return {"expectedQuestions": len(expected_numbers), "questionsFound": len(uniq),
            "questionNumberRecall": round(len(uniq) / len(expected_numbers), 3),
            "duplicates": sorted({n for n in found if found.count(n) > 1}),
            "missing": [n for n in expected_numbers if n not in found][:20],
            "optionLabelRecall": round(labels / max(1, options * len(blocks)), 3),
            "readingOrderInversions": inv,
            "blankPreservation": round(blanks / max(1, len(blocks)), 3) if blank_required else None}


def sequence_diagnostics(found: list, expected: list) -> list:
    """[(code, questions)] for gaps / duplicates / extras of printed question numbers — never renumbered."""
    out = []
    missing = [n for n in expected if n not in found]
    dups = sorted({n for n in found if found.count(n) > 1})
    extra = sorted({n for n in found if n not in expected})
    if missing:
        out.append(("QUESTION_NUMBER_GAP", missing))
    if dups:
        out.append(("DUPLICATE_QUESTION_NUMBER", dups))
    if extra:
        out.append(("QUESTION_RANGE_MISMATCH", extra))
    return out
