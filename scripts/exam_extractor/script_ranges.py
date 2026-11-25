"""Printed explanation ranges, attributed by key-chapter identity, never run position.

Only range numbers and source geometry leave this module. Script text stays in
the existing raw OCR cache and is never copied into a learner stimulus.
"""
from __future__ import annotations

import re
from collections import Counter

RANGE = re.compile(r"^(\d{2,3})\s*[-–—~]\s*(\d{2,3})$")
RANGE_PROPOSAL = re.compile(r"^[\dIOl]{2,3}\s*[-–—~]\s*[\dIOl]{2,3}(?:\s|$)")
SPEAKER = re.compile(r"^[MW]\s*[-–—]\s*[A-Za-z]{2,4}\b", re.I)


def parse_range(text):
    match = RANGE.fullmatch(text.strip())
    if not match:
        return None
    start, end = map(int, match.groups())
    return (start, end) if 1 <= start < end <= 100 else None


def chapter_interval(blocks, test_no, page_count):
    """Own printed key-table identity supplies the chapter start and next boundary."""
    block = blocks.get(test_no)
    if block is None or block.test != test_no or block.orientation is None:
        return None
    ordered = sorted((b.page, identity) for identity, b in blocks.items() if b is not None)
    if len({page for page, _ in ordered}) != len(ordered):
        return None  # several keys on one page are not explanation chapters
    following = [page for page, _ in ordered if page > block.page]
    return block.page, min(following, default=page_count + 1) - 1


def dialogue_header(words, word):
    """An isolated range above a physically adjacent printed speaker label."""
    x0, y0, x1, y1 = word.bbox
    if parse_range(word.text):
        for other in words:
            if other is word:
                continue
            a, b, c, d = other.bbox
            if abs((b + d) / 2 - (y0 + y1) / 2) < (y1 - y0) / 2 and 0 <= a - x1 < 25:
                return False
    return any(SPEAKER.match(other.text) and -5 <= other.bbox[0] - x0 <= 20
               and 5 <= other.bbox[1] - y1 <= 35 for other in words)


def script_box_below(layer, page, word, width, height):
    """A printed range directly above a long horizontal dialogue-box border."""
    import cv2
    import numpy as np
    from .ocr_engine import render_region
    from .preprocess import to_gray

    x0, _y0, _x1, y1 = word.bbox
    bbox = (max(0, x0 - 3), y1 + 1, min(width, x0 + width * .43), min(height, y1 + 25))
    if bbox[3] <= bbox[1]:
        return False
    gray = to_gray(render_region(layer, page, bbox, 300))
    ink = (gray < 190).astype(np.uint8)
    closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((1, 7), np.uint8))
    lines = cv2.morphologyEx(closed, cv2.MORPH_OPEN, np.ones((1, 250), np.uint8))
    return bool(np.any(lines.sum(axis=1) >= 250))


def range_glyph_bbox(layer, page, word, width, height):
    """Split the range from a same-line Korean title at its physical whitespace.

    Full-page OCR often combines both. Its prefix proposes a glyph count only;
    physical ink runs bound that crop. The two new readings must independently
    prove the actual numbers; no predicted range is supplied to recognition.
    """
    import numpy as np
    from .ocr_engine import render_region
    from .preprocess import to_gray

    x0, y0, x1, y1 = word.bbox
    bbox = (max(0, x0 - 2), max(0, y0 - 2), min(width, x1 + 2), min(height, y1 + 2))
    if parse_range(word.text):
        return bbox
    gray = to_gray(render_region(layer, page, bbox, 600))
    ink = np.any(gray < 160, axis=0)
    runs = []
    start = None
    for index, present in enumerate(ink):
        if present and start is None:
            start = index
        if start is not None and (not present or index == len(ink) - 1):
            end = index if not present else index + 1
            runs.append((start, end))
            start = None
    scale = 600 / 72
    for left, right in zip(runs, runs[1:]):
        if 18 <= left[1] / scale <= 36 and (right[0] - left[1]) / scale >= 2:
            return (bbox[0], bbox[1], bbox[0] + left[1] / scale + 1, bbox[3])
    prefix = re.match(r'^([\dIOl]{2,3}\s*[-–—~]\s*[\dIOl]{2,3})', word.text.strip())
    count = len(re.sub(r'\s', '', prefix.group(1))) if prefix else 0
    if count and len(runs) >= count:
        end = runs[count - 1][1]
        # A component at a distant border/title is not part of the numeral run.
        if all((b[0] - a[1]) / scale < (y1 - y0) * .6
               for a, b in zip(runs[:count], runs[1:count])):
            return (bbox[0], bbox[1], min(bbox[2], bbox[0] + end / scale + 1), bbox[3])
    for left, right in zip(runs, runs[1:]):
        if left[1] / scale >= 18 and (right[0] - left[1]) / scale >= 3:
            return (bbox[0], bbox[1], bbox[0] + left[1] / scale + 1, bbox[3])
    return bbox


def footer_identity(ctx, page, width, height):
    band = ctx.profile.footer_identity_band
    bbox = (width * band[0], height * band[1], width * band[2], height * band[3])
    identities, proposals = [], []
    for pipeline in ('P1', 'P2'):
        result = ctx.cache.recognize(ctx.layer, page, bbox, dpi=ctx.profile.footer_identity_dpi,
                                     pipeline=pipeline)
        if result is None:
            return None
        text = ' '.join(word.text for word in result.words)
        proposals.extend(word for word in result.words if hasattr(word, 'bbox') and
                         re.fullmatch(r'T\s*E\s*S\s*T\s+\S', word.text.strip(), re.I))
        identities.append({int(m.group(1)) for m in re.finditer(ctx.profile.test_furniture, text, re.I)
                           if 1 <= int(m.group(1)) <= 10})
    if identities[0] == identities[1]:
        return identities[0]
    fresh = []
    for dpi, pipeline in ((600, 'P0'), (600, 'P2'), (900, 'P1'), (900, 'P2')):
        result = ctx.cache.recognize(ctx.layer, page, bbox, dpi=dpi, pipeline=pipeline)
        text = ' '.join(word.text for word in result.words) if result else ''
        own = {int(m.group(1)) for m in re.finditer(ctx.profile.test_furniture, text, re.I)
               if 1 <= int(m.group(1)) <= 10}
        fresh.append(next(iter(own)) if len(own) == 1 else None)
    votes = Counter(identity for identity in fresh if identity is not None)
    if votes:
        identity, count = votes.most_common(1)[0]
        if count >= 3:
            return {identity}
    # Tiny running digits can be read as punctuation by unconstrained OCR.
    # TEST proposes its own final ink glyph; digit-only reads prove identity.
    from .ocr_engine import render_region
    from .preprocess import to_gray
    import numpy as np
    for word in proposals:
        a, b, c, d = word.bbox
        region = (max(0, a - 1), max(0, b - 2), min(width, c + 1), min(height, d + 2))
        gray = to_gray(render_region(ctx.layer, page, region, 600))
        columns = np.flatnonzero(np.any(gray < 160, axis=0))
        if not len(columns):
            continue
        gaps = np.flatnonzero(np.diff(columns) > 1)
        start = columns[gaps[-1] + 1] if len(gaps) else columns[0]
        glyph = (max(region[0], region[0] + start * 72 / 600 - 1), region[1],
                 min(region[2], region[0] + columns[-1] * 72 / 600 + 1), region[3])
        if glyph[2] - glyph[0] > 12:
            continue
        own_digits = []
        for dpi, pipeline in ((600, 'P5'), (600, 'P6'), (900, 'P1'), (900, 'P2')):
            own = ctx.cache.recognize(ctx.layer, page, glyph, dpi=dpi, pipeline=pipeline,
                                      allowlist='0123456789', boxes_pt=[glyph])
            text = ''.join(w.text for w in own.words) if own else ''
            own_digits.append(int(text) if re.fullmatch(r'[1-9]', text) else None)
        votes = Counter(digit for digit in own_digits if digit is not None)
        if votes:
            digit, count = votes.most_common(1)[0]
            if count >= 3:
                return {digit}
    return None


def explanation_ranges(ctx, test_no, fmt, blocks):
    """Dual own-header reads inside an exact-byte, printed-identity chapter.

    Facing pages may omit TEST furniture. They remain inside two explicit
    chapter boundaries; disagreeing or foreign furniture rejects their ranges.
    At least one range page must corroborate the chapter's TEST identity.
    """
    from .toeic import part_of

    interval = chapter_interval(blocks, test_no, ctx.layer.page_count)
    if interval is None:
        return None
    if hasattr(ctx.ex, 'staging'):
        import json
        cached = ctx.ex.staging / 'reports/ocr_script_ranges' / f'{ctx.profile.book}__test-{test_no}.json'
        try:
            proof = json.loads(cached.read_text(encoding='utf-8'))
            if (proof.get('sha256') == ctx.layer.sha256 and proof.get('test') == test_no
                    and proof.get('chapterPages') == list(interval)
                    and proof.get('identityBasis') == 'PRINTED_KEY_CHAPTER_AND_DUAL_FOOTER'
                    and not proof.get('rejected') and proof.get('ranges')
                    and any(r.get('footerIdentity') == [test_no] for r in proof['ranges'])):
                retained = {}
                for entry in proof['ranges']:
                    start, end = entry['range']
                    part = part_of(start, fmt)
                    assert interval[0] <= entry['page'] <= interval[1]
                    assert entry.get('footerIdentity') in ([], [test_no])
                    import math
                    bbox = entry['bbox']
                    width, height = ctx.layer.page_size(entry['page'])
                    assert len(bbox) == 4 and all(math.isfinite(v) for v in bbox)
                    assert 0 <= bbox[0] < bbox[2] <= width and 0 <= bbox[1] < bbox[3] <= height
                    assert part in (3, 4) and part_of(end, fmt) == part and start < end
                    assert (start, end) not in retained.get(part, [])
                    retained.setdefault(part, []).append((start, end))
                from .toeic import part_numbers
                if all([q for a, b in retained.get(part, []) for q in range(a, b + 1)] == part_numbers(part, fmt)
                       for part in (3, 4)):
                    ctx.ex._script_range_evidence = getattr(ctx.ex, '_script_range_evidence', {})
                    ctx.ex._script_range_evidence[(ctx.layer.sha256, test_no)] = proof
                    return retained
        except (OSError, ValueError, KeyError, TypeError, AssertionError):
            pass
    out, evidence, rejected, corroborated = {}, [], [], False
    for page in range(interval[0], interval[1] + 1):
        if page not in ctx.used:
            if len(ctx.used) >= ctx.budget:
                from .toeic_scan import BudgetExhausted
                raise BudgetExhausted(f'page budget {ctx.budget} exhausted at script page {page}')
            ctx.used.append(page)
        width, height = ctx.layer.page_size(page)
        result = ctx.cache.recognize(ctx.layer, page, (0, 0, width, height), dpi=150, pipeline='P1')
        if result is None:
            continue
        candidates = [w for w in result.words if RANGE_PROPOSAL.match(w.text.strip())
                      and (dialogue_header(result.words, w)
                           or script_box_below(ctx.layer, page, w, width, height))]
        if not candidates:
            continue
        identity = footer_identity(ctx, page, width, height)
        if identity is None:
            rejected.append({'page': page, 'reason': 'FOOTER_READ_CONFLICT', 'candidates': len(candidates)})
            continue
        if identity and identity != {test_no}:
            return None
        corroborated |= identity == {test_no}
        for word in sorted(candidates, key=lambda w: (w.bbox[0] > width / 2, w.bbox[1])):
            bbox = range_glyph_bbox(ctx.layer, page, word, width, height)
            reads = []
            for pipeline in ('P1', 'P2'):
                own = ctx.cache.recognize(ctx.layer, page, bbox, dpi=600, pipeline=pipeline,
                                          allowlist='0123456789-–—~', boxes_pt=[bbox])
                text = ''.join(w.text for w in own.words) if own else ''
                reads.append(parse_range(text.strip('~–—- ')))
            if reads[0] is None or reads[0] != reads[1]:
                fresh = []
                for dpi, pipeline in ((600, 'P5'), (600, 'P6'), (900, 'P1'), (900, 'P2')):
                    own = ctx.cache.recognize(ctx.layer, page, bbox, dpi=dpi, pipeline=pipeline,
                                              allowlist='0123456789-–—~', boxes_pt=[bbox])
                    text = ''.join(w.text for w in own.words) if own else ''
                    fresh.append(parse_range(text.strip('~–—- ')))
                votes = Counter(pair for pair in fresh if pair is not None)
                if votes:
                    pair, count = votes.most_common(1)[0]
                    if count >= 3:
                        reads = [pair, pair]
            if reads[0] is None or reads[0] != reads[1]:
                rejected.append({'page': page, 'reason': 'RANGE_READ_CONFLICT',
                                 'bbox': list(bbox), 'reads': reads})
                continue
            start, end = reads[0]
            part = part_of(start, fmt)
            if part not in (3, 4) or part_of(end, fmt) != part:
                continue
            pair = (start, end)
            if pair in out.get(part, []):
                return None  # duplicate printed headers need reconciliation
            out.setdefault(part, []).append(pair)
            evidence.append({'page': page, 'range': list(pair), 'bbox': list(bbox),
                             'footerIdentity': sorted(identity)})
    if not corroborated:
        return None
    ctx.ex._script_range_evidence = getattr(ctx.ex, '_script_range_evidence', {})
    proof = {
        'sha256': ctx.layer.sha256, 'test': test_no, 'chapterPages': list(interval),
        'identityBasis': 'PRINTED_KEY_CHAPTER_AND_DUAL_FOOTER', 'ranges': evidence, 'rejected': rejected}
    ctx.ex._script_range_evidence[(ctx.layer.sha256, test_no)] = proof
    if hasattr(ctx.ex, 'staging'):
        from .staging import _write_json
        from .diagnostics import EXTRACTOR_VERSION
        _write_json(ctx.ex.staging / 'reports/ocr_script_ranges' / f'{ctx.profile.book}__test-{test_no}.json',
                    {'extractorVersion': EXTRACTOR_VERSION, 'productionQualified': False, **proof})
    return out or None
