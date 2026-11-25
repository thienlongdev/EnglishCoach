"""TOEIC Part 6 blank<->question association by GEOMETRY and Part 7 document segmentation (Phase 3.5H / 3.5I).

Part 6
  passage -> blank position -> question -> options -> key
  A printed question number is tied to a blank only by layout: the number printed directly under the blank
  (ETS 2016+ books: '-------' with '135.' beneath it) or immediately beside it on the same line ('(135) ____').
  Accepted only when the mapping is a bijection between the set's questions and the passage's blanks and the
  numbers increase in reading order. Otherwise the set is dropped (PART6_BLANK_MAPPING_UNPROVEN) — no generic
  'Blank (n)' placeholder sentence is ever produced for a set whose blanks could not be tied to its questions.

Part 7
  A multi-document set ('Questions 176-180 refer to the following e-mail and invoice.') keeps its documents
  separate when the layout proves the boundaries: each document border (FRAME) is one document; outside frames
  a document break is a vertical gap of >= 2.2 line heights or a page break. The segmentation is accepted only when
  the number of documents equals the number declared by the set header; otherwise the passage stays one
  concatenated stimulus with documentBoundaries NOT_SEGMENTED (LAYOUT_LINEARIZED).
"""
from __future__ import annotations

import re
from typing import Optional

from .pdf_layer import DOTS, Row, clean_text

_LABEL = re.compile(r"^\(?(\d{3})\)?[.,]?$")


def _row_h(r: Row) -> float:
    return max(r.y1 - r.y0, 1.0)


def map_part6_blanks(passage_rows: list, numbers: list) -> tuple:
    """-> (mapping {q: (row_index, token_index)} or None, method, detail).

    method GEOMETRY_LABEL (number printed under/beside the blank) or None when unproven."""
    blanks = []        # (row_idx, tok_idx, token)
    labels = []        # (q, row_idx, tok_idx, token)
    for ri, r in enumerate(passage_rows):
        for ti, t in enumerate(r.tokens):
            if t.text == DOTS:
                blanks.append((ri, ti, t))
            else:
                m = _LABEL.match(t.text)
                if m and int(m.group(1)) in numbers:
                    labels.append((int(m.group(1)), ri, ti, t))
    if not labels:
        return None, None, f"no printed question labels (blanks={len(blanks)})"
    # one printed label read twice (line OCR + the digits re-read of the strip under its blank) is ONE label:
    # same number AND overlapping boxes; the same number printed at two different places stays a conflict
    uniq = []
    for lab in labels:
        q, ri, _ti, t = lab
        r = passage_rows[ri]
        dup = next((u for u in uniq if u[0] == q and min(t.x1, u[3].x1) - max(t.x0, u[3].x0) > 0
                    and abs(passage_rows[u[1]].y0 - r.y0) <= 1.2 * _row_h(r)), None)
        if dup is None:
            uniq.append(lab)
    labels = uniq
    mapping = {}
    used = set()
    for q, lri, lti, lt in labels:
        lr = passage_rows[lri]
        lcx = (lt.x0 + lt.x1) / 2
        cands = []
        for bi, (bri, bti, bt) in enumerate(blanks):
            br = passage_rows[bri]
            if br.page != lr.page:
                continue
            if bri == lri:
                # inline label: immediately beside the blank on the same line
                gap = min(abs(lt.x0 - bt.x1), abs(bt.x0 - lt.x1))
                if gap <= 1.5 * _row_h(lr):
                    cands.append((0.5 * gap, bi))
                continue
            dy = lr.y0 - br.y1
            if -0.9 * _row_h(br) <= dy <= 1.6 * _row_h(br) and bt.x0 - 6 <= lcx <= bt.x1 + 6:
                cands.append((abs(dy) + abs(lcx - (bt.x0 + bt.x1) / 2) * 0.1, bi))
        if len(cands) == 0:
            return None, None, f"label {q} has no blank above/beside it"
        cands.sort()
        if len(cands) > 1 and cands[1][0] - cands[0][0] < 1.0:
            return None, None, f"label {q} is equidistant from two blanks"
        bi = cands[0][1]
        if bi in used or q in mapping:
            return None, None, f"label {q} maps to an already used blank"
        used.add(bi)
        mapping[q] = (blanks[bi][0], blanks[bi][1])
    if sorted(mapping) != sorted(numbers):
        missing = [q for q in numbers if q not in mapping]
        return None, None, f"questions without a blank: {missing}"
    # every question owns exactly one blank (checked above); extra UNLABELLED rules (form fields, signature lines)
    # are plain rules of the document, not question blanks
    order = sorted(mapping.items(), key=lambda kv: (passage_rows[kv[1][0]].page, passage_rows[kv[1][0]].y0,
                                                   passage_rows[kv[1][0]].tokens[kv[1][1]].x0))
    seq = [q for q, _ in order]
    if seq != sorted(seq):
        return None, None, "blank numbers do not increase in reading order"
    extra = len(blanks) - len(numbers)
    return mapping, "GEOMETRY_LABEL", (f"{extra} unlabelled rules kept as plain rules" if extra else None)


def label_passage_rows(passage_rows: list, mapping: dict, blank_text: str) -> list:
    """Copy of the passage rows with each mapped blank written '(q) <blank>' and the printed labels removed."""
    where = {v: q for q, v in mapping.items()}
    out = []
    for ri, r in enumerate(passage_rows):
        toks = []
        for ti, t in enumerate(r.tokens):
            if (ri, ti) in where:
                toks.append(type(t)(f"({where[(ri, ti)]})", t.x0, t.x0 + 1))
                toks.append(type(t)(blank_text, t.x0 + 1, t.x1))
                continue
            if t.text == DOTS:
                toks.append(type(t)("____", t.x0, t.x1))   # an unlabelled printed rule, not a question blank
                continue
            m = _LABEL.match(t.text)
            if m and int(m.group(1)) in mapping:
                continue
            toks.append(t)
        if not toks:
            continue
        nr = Row(r.page, r.y0, r.y1, r.x0, r.x1, toks, r.method, r.confidence, r.column)
        for k in ("region", "frame"):
            if hasattr(r, k):
                setattr(nr, k, getattr(r, k))
        out.append(nr)
    return out


def segment_documents(rows: list, declared: int) -> Optional[list]:
    """Split a Part 7 passage into documents by layout; None unless exactly `declared` documents result."""
    if declared < 2 or not rows:
        return None
    docs, cur = [], []
    prev = None
    for r in rows:
        frame = getattr(r, "frame", None)
        brk = False
        if prev is not None:
            pframe = getattr(prev, "frame", None)
            h = max(_row_h(prev), _row_h(r))
            if frame != pframe and (frame is not None or pframe is not None):
                brk = True
            elif r.page != prev.page:
                brk = False                  # a page turn alone never splits a document
            elif r.y0 - prev.y1 >= 2.2 * h and frame is None:
                brk = True
        if brk and cur:
            docs.append(cur)
            cur = []
        cur.append(r)
        prev = r
    if cur:
        docs.append(cur)
    if len(docs) != declared:
        return None
    return docs


def doc_paragraphs(rows: list) -> list:
    paras, cur, prev = [], [], None
    for r in rows:
        t = clean_text(r.text)
        if not t:
            continue
        if prev is not None and (r.page != prev.page or r.y0 - prev.y1 > 0.8 * _row_h(prev)):
            if cur:
                paras.append({"id": None, "text": clean_text(" ".join(cur))})
            cur = []
        cur.append(t)
        prev = r
    if cur:
        paras.append({"id": None, "text": clean_text(" ".join(cur))})
    return paras


def document_regions(rows: list, layouts: dict, declared: int) -> Optional[list]:
    """Source regions for complete documents, excluding nested table borders and scan debris.

    Only exact declared-count closure is accepted. A page's unframed prose is a
    separate region; framed documents must enclose at least three prose lines.
    Callers supply only rows between the printed set heading and first question.
    """
    out = []
    for page in dict.fromkeys(r.page for r in rows):
        page_rows = [r for r in rows if r.page == page]
        meaningful = [r for r in page_rows if r.y1-r.y0 >= 4 and
                      len(re.findall(r"[A-Za-z]{3,}", r.text)) >= 3]
        if not meaningful:
            continue
        frames = [reg.bbox for reg in layouts[page].regions if reg.kind == "FRAME"]
        # A printed schedule can yield overlapping vertical border fragments.
        # Join only touching ink regions with coextensive vertical extents; never
        # bridge a gap between independent documents or use the desired count.
        changed=True
        while changed:
            changed=False
            for i,a in enumerate(frames):
                for j in range(i+1,len(frames)):
                    b=frames[j]
                    overlap=min(a[2],b[2])-max(a[0],b[0])
                    vertical=min(a[3],b[3])-max(a[1],b[1])
                    if overlap>0 and vertical>=.8*min(a[3]-a[1],b[3]-b[1]):
                        frames[i]=(min(a[0],b[0]),min(a[1],b[1]),max(a[2],b[2]),max(a[3],b[3]))
                        frames.pop(j);changed=True;break
                if changed:break
        frames = [b for b in frames if sum(b[0] <= (r.x0+r.x1)/2 <= b[2] and
                  b[1] <= (r.y0+r.y1)/2 <= b[3] for r in meaningful) >= 3]
        frames = [b for b in frames if not any(b != other and other[0] <= b[0] and
                  other[1] <= b[1] and b[2] <= other[2] and b[3] <= other[3] for other in frames)]
        covered = set()
        for box in frames:
            members = [r for r in page_rows if box[0] <= (r.x0+r.x1)/2 <= box[2] and
                       box[1] <= (r.y0+r.y1)/2 <= box[3]]
            covered.update(id(r) for r in members)
            out.append((page, tuple(box), members))
        remaining = sorted([r for r in meaningful if id(r) not in covered], key=lambda r:(r.y0,r.x0))
        clusters = []
        for r in remaining:
            if not clusters or r.y0-clusters[-1][-1].y1 > 3*max(_row_h(r),_row_h(clusters[-1][-1])):
                clusters.append([])
            clusters[-1].append(r)
        for cluster in clusters:
            if len(cluster) < 3:
                return None  # unexplained prose must never be discarded to fit a count
            members = [r for r in page_rows if id(r) not in covered and
                       cluster[0].y0-50 <= r.y0 and r.y1 <= cluster[-1].y1+12]
            box = (min(r.x0 for r in members), min(r.y0 for r in members),
                   max(r.x1 for r in members), max(r.y1 for r in members))
            out.append((page, box, members))
    out.sort(key=lambda d:(d[0], d[1][1], d[1][0]))
    return out if len(out) == declared else None
