"""IELTS family extractor: Listening (4 parts) / Reading (3 passages) / Writing (2 tasks) / Speaking (3 parts).

Unit of omission = one listening part / one reading passage / one writing task. A unit is emitted only when
every question group in it parsed, every question number of its printed range was found exactly once, and every
item has an answer key of the right syntax. Otherwise the unit is dropped with BLOCKING diagnostics (no
placeholder, no partial group).
"""
from __future__ import annotations

import re
import statistics
from typing import Optional

from .adapters.base import ANSWER_KEY, QUESTIONS, TRANSCRIPT, AnnotatedRow
from .answer_keys import parse_key_rows, resolve_key
from .diagnostics import AMBIGUOUS, CONFIDENT, PROBABLE, DiagnosticLog, page_range
from .ielts_groups import BLANK, parse_group, parse_range, row_text, _INSTRUCTION
from .media import IELTS_PART_SECONDS, WHOLE_LISTENING_SECONDS, capture_figure, figure_region
from .model import (GK_GAP, GK_LABEL, Part, Passage, Section, SpeakingPart, WritingTask)
from .pdf_layer import DOTS, clean_text, split_columns

_PART = re.compile(r"^(?:PART|SECTI?ON)\s*(\d)\b[.,]?\s*(.*)$")  # 'SECTON' is a printed typo in old volumes
_PASSAGE = re.compile(r"^(?:READING\s+)?PASSAGE\s+(\d)\s*$")
_SPEND = re.compile(r"you should spend (?:about|no more than) (\d+) minutes on (?:questions|this task)", re.I)
_TASK = re.compile(r"^(?:WRITING\s+)?TASK\s+(\d)\b", re.I)
_KEY_NOISE = re.compile(r"^(listening|reading|test \d+|listening and reading answer keys|answer keys?|"
                        r"answer key with extra( explanations)?|explanations|in resource bank|"
                        r"(part|section) \d+,? questions.*|reading passage \d+,?( questions.*)?|questions \d+.*|"
                        r"[-•]|ill|question|answer|location of answer in text|\d{1,2},|reading passage|"
                        r"(part|section) \d+,?|questions)$", re.I)
_BAND = re.compile(r"if you score|you are (un)?likely|acceptable|examination|recommend|improving|before you take|"
                   r"more practice|institutions|think about|remember that|lot of time|you may get|conditions|"
                   r"score under|your english|^(\d+\s*[-–]\s*\d+\s*)+$|^you take ielts", re.I)


def _rows(stream: list, region: str, test: int, skill: Optional[str]) -> list:
    return [a.row for a in stream if a.region == region and a.test == test and (skill is None or a.skill == skill)]


def _pages(rows: list) -> list:
    return sorted({r.page for r in rows})


# ─── Generic segmentation ──────────────────────────────────────────────────────────────────

def segment_groups(rows: list) -> list:
    """[(first, last, rows)] by 'Questions a-b' markers; containers ('PART 2 Questions 11-20' followed by
    'Questions 11-14') are not groups."""
    markers = []
    for idx, r in enumerate(rows):
        t = row_text(r)
        rng = parse_range(t)
        if rng:
            prev = row_text(rows[idx - 1]) if idx > 0 else ""
            # '... write the correct letter, A-H, next to' / 'Questions 15-20.' is a sentence tail, not a marker
            if t.rstrip().endswith(".") and prev and not re.search(r"[.?!:)]$", prev) and not parse_range(prev):
                continue
            markers.append((idx, rng[0], rng[1]))
    groups = []
    for k, (idx, a, b) in enumerate(markers):
        nxt = markers[k + 1] if k + 1 < len(markers) else None
        if nxt and nxt[1] == a and nxt[2] < b and (
                getattr(rows[idx], 'section_range_container', False) or nxt[0] - idx <= 3):
            continue  # container range
        if nxt and a <= nxt[1] <= b and nxt[1] != a and nxt[0] - idx <= 2 and (a, b) != (nxt[1], nxt[2]):
            pass
        end = nxt[0] if nxt else len(rows)
        groups.append((a, b, rows[idx + 1:end]))
    return groups


def _merge_overlaps(groups: list, scope: str, log: DiagnosticLog) -> list:
    out, seen = [], set()
    for a, b, rows in groups:
        nums = set(range(a, b + 1))
        if nums & seen:
            log.add("DUPLICATE_QUESTION_NUMBER", scope, "overlapping question ranges", questions=f"{a}-{b}")
            return []
        seen |= nums
        out.append((a, b, rows))
    return out


def _check_contiguous(groups: list, first: int, last: int, scope: str, log: DiagnosticLog) -> bool:
    nums = sorted(n for a, b, _ in groups for n in range(a, b + 1))
    if nums != list(range(first, last + 1)):
        missing = sorted(set(range(first, last + 1)) - set(nums))
        log.add("QUESTION_NUMBER_GAP", scope, f"missing={len(missing)}",
                questions=",".join(map(str, missing[:12])) or None)
        return False
    return True


# ─── Listening ────────────────────────────────────────────────────────────────────────────

def split_parts(rows: list, pattern=_PART) -> list:
    """[(part_no, rows)] in order of appearance."""
    parts, cur_no, cur = [], None, []
    for r in rows:
        m = pattern.match(row_text(r).upper() if pattern is _PART else row_text(r))
        if m:
            if cur_no is not None:
                parts.append((cur_no, cur))
            cur_no, cur = int(m.group(1)), []
            rest = m.group(2).strip() if m.lastindex and m.lastindex >= 2 else ""
            if rest:
                cur.append(_synthetic(r, rest))
            continue
        if cur_no is not None:
            cur.append(r)
    if cur_no is not None:
        parts.append((cur_no, cur))
    return parts


def _synthetic(r, text: str):
    """A row holding the remainder of a marker line ('PART 1 Questions 1-10' -> 'Questions 1-10')."""
    from .pdf_layer import Row, Token
    toks = [Token(w, r.x0, r.x1, False, False, r.size) for w in text.split()]
    result = Row(r.page, r.y0, r.y1, r.x0, r.x1, toks, r.method, r.confidence, r.column)
    result.section_range_container = True
    return result


def extract_listening(rows: list, scope_root: str, log: DiagnosticLog, ocr: bool, layer, store) -> list:
    out = []
    raw_parts = split_parts(rows)
    if not raw_parts:
        log.add("SECTION_NOT_FOUND", scope_root, "no PART/SECTION markers", pages=page_range(_pages(rows)))
        return out
    numbers = [n for n, _ in raw_parts]
    if numbers != sorted(set(numbers)):
        log.add("GROUP_STRUCTURE_AMBIGUOUS", scope_root, "part markers repeat or out of order")
    for no, prow in raw_parts:
        scope = f"{scope_root}/PART_{no}"
        groups = _merge_overlaps(segment_groups(prow), scope, log)
        if not groups:
            log.add("QUESTION_BLOCK_NOT_FOUND", scope, "no question groups", pages=page_range(_pages(prow)))
            log.add("PART_OMITTED", scope, "structure")
            continue
        first, last = groups[0][0], max(b for _, b, _ in groups)
        if not _check_contiguous(groups, first, last, scope, log):
            log.add("PART_OMITTED", scope, "numbering")
            continue
        part = Part(code=f"LISTENING_PART_{no}", number=no, pages=_pages(prow))
        failed = False
        for a, b, grows in groups:
            g = parse_group(grows, a, b, scope, log, ocr)
            if g is None:
                failed = True
                break
            if g.kind == GK_LABEL or (g.kind == GK_GAP and re.search(r"\b(diagram|map|plan)\b", " ".join(g.instructions), re.I)):
                if not _bind_group_figure(g, grows, layer, store, scope, log):
                    failed = True
                    break
            part.groups.append(g)
        if failed:
            log.add("PART_OMITTED", scope, "group parse")
            continue
        out.append(part)
    return out


def _bind_group_figure(g, grows: list, layer, store, scope: str, log: DiagnosticLog) -> bool:
    if layer is None or not grows:
        log.add("IMAGE_NOT_BOUND", scope, "no source layer for figure", questions=f"{g.first}-{g.last}")
        return False
    page = grows[0].page
    w, h = layer.page_size(page)
    y_from = min(r.y0 for r in grows if r.page == page)
    hit = figure_region(layer, page, y_from, h * 0.95)
    if hit is None:
        log.add("IMAGE_NOT_BOUND", scope, "no figure region on the group page", questions=f"{g.first}-{g.last}",
                pages=str(page))
        return False
    bbox, method = hit
    g.figure = capture_figure(layer, store, page, bbox, method, [r for r in grows if r.page == page])
    log.add("IMAGE_REGION_HEURISTIC", scope, method, questions=f"{g.first}-{g.last}", pages=str(page))
    return True


# ─── Reading ──────────────────────────────────────────────────────────────────────────────

def split_passages(rows: list) -> list:
    parts, cur_no, cur = [], None, []
    pending_reading = False
    for r in rows:
        t = row_text(r)
        m = _PASSAGE.match(t)
        if m and (t.startswith("READING") or pending_reading or t.startswith("PASSAGE")):
            if cur_no is not None:
                parts.append((cur_no, cur))
            cur_no, cur = int(m.group(1)), []
            pending_reading = False
            continue
        pending_reading = t.upper() == "READING"
        if pending_reading:
            continue
        if cur_no is not None:
            cur.append(r)
    if cur_no is not None:
        parts.append((cur_no, cur))
    return parts


def _paragraphs(rows: list) -> tuple:
    """Rows -> (title, paragraphs[{id,text}], notes). Paragraph breaks: vertical gaps, letter labels."""
    if not rows:
        return None, [], []
    body_size = statistics.median([r.size for r in rows if r.size] or [0])
    title_rows = []
    i = 0
    while i < len(rows) and i < 4:
        r = rows[i]
        t = row_text(r)
        bigger = r.size and body_size and r.size >= body_size + 1.5
        if (bigger or r.all_bold) and len(t) < 120:
            title_rows.append(t)
            i += 1
            continue
        break
    if not title_rows and rows and len(row_text(rows[0])) < 70 and not row_text(rows[0]).endswith("."):
        title_rows.append(row_text(rows[0]))
        i = 1
    body = rows[i:]
    gaps = [b.y0 - a.y1 for a, b in zip(body, body[1:]) if b.page == a.page and b.y0 > a.y1]
    typical = statistics.median(gaps) if gaps else 2.0
    paras, cur, cur_id, notes = [], [], None, []
    prev = None
    for r in body:
        t = row_text(r)
        if not t:
            continue
        if t.startswith("*"):
            notes.append(t)
            prev = r
            continue
        lab = re.fullmatch(r"([A-I])", t)
        first = [x for x in r.tokens if x.text.strip()]
        lead_label = None
        if first and re.fullmatch(r"[A-I]", first[0].text) and len(first) > 1 and first[1].x0 - first[0].x1 > 6:
            lead_label = first[0].text
        new_para = prev is None or lab is not None or lead_label is not None or (
            prev.page == r.page and r.y0 - prev.y1 > max(typical * 2.2, 4.5)) or (
            prev.page == r.page and r.x0 - prev.x0 > 8 and len(cur) > 0 and row_text(prev).endswith((".", "’", "'", "”", "?")))
        if new_para and cur:
            paras.append({"id": cur_id, "text": clean_text(" ".join(cur))})
            cur, cur_id = [], None
        if lab:
            cur_id = lab.group(1)
        else:
            if lead_label:
                cur_id = lead_label
                t = clean_text(" ".join(x.text for x in first[1:]))
            # de-hyphenate line-end breaks
            if cur and cur[-1].endswith("-") and t[:1].islower():
                cur[-1] = cur[-1][:-1] + t.split(" ", 1)[0]
                t = t.split(" ", 1)[1] if " " in t else ""
            if t:
                cur.append(t)
        prev = r
    if cur:
        paras.append({"id": cur_id, "text": clean_text(" ".join(cur))})
    title = clean_text(" ".join(title_rows)) if title_rows else None
    return title, paras, notes


def extract_reading(rows: list, scope_root: str, log: DiagnosticLog, ocr: bool) -> list:
    out = []
    raw = split_passages(rows)
    if not raw:
        log.add("SECTION_NOT_FOUND", scope_root, "no READING PASSAGE markers", pages=page_range(_pages(rows)))
        return out
    for no, prow in raw:
        scope = f"{scope_root}/PASSAGE_{no}"
        # passage header instruction: 'You should spend about 20 minutes on Questions 1-13 ...'
        header_idx, qa, qb = None, None, None
        for idx, r in enumerate(prow[:8]):
            t = row_text(r)
            m = re.search(r"questions?\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})", t, re.I)
            if _SPEND.search(t) or (m and "based on" in " ".join(row_text(x) for x in prow[idx:idx + 2]).lower()):
                header_idx = idx
                if m:
                    qa, qb = int(m.group(1)), int(m.group(2))
                break
        start = 0
        if header_idx is not None:
            start = header_idx + 1
            # header may wrap onto the next row ('Passage 1 below.')
            while start < len(prow) and re.search(r"(passage \d+( below| on pages?.*)?\.?|below\.)$", row_text(prow[start]), re.I) \
                    and len(row_text(prow[start])) < 70:
                start += 1
        body = prow[start:]
        groups = segment_groups(body)
        marker_idx = [i for i, r in enumerate(body) if parse_range(row_text(r))]
        first_marker = marker_idx[0] if marker_idx else len(body)
        passage_rows = body[:first_marker]
        part = Part(code=f"READING_PASSAGE_{no}", number=no, pages=_pages(prow))
        parsed = []
        failed = False
        groups = _merge_overlaps(groups, scope, log)
        for a, b, grows in groups:
            g = parse_group(grows, a, b, scope, log, ocr)
            if g is None:
                failed = True
                break
            # passage text printed after a question group (e.g. headings list first): rows after the last item
            if not passage_rows or sum(len(row_text(r)) for r in passage_rows) < 400:
                tail = _tail_after_items(grows, g)
                if sum(len(row_text(r)) for r in tail) > 800:
                    passage_rows = passage_rows + tail
            if g.kind == GK_LABEL or (g.kind == GK_GAP and re.search(r"\bdiagram\b", " ".join(g.instructions), re.I)):
                log.add("INTERACTION_NOT_REPRESENTABLE", scope, "reading diagram labelling needs a bound figure",
                        questions=f"{a}-{b}")
                failed = True
                break
            parsed.append(g)
        if failed or not groups:
            if not groups:
                log.add("QUESTION_BLOCK_NOT_FOUND", scope, "no question groups", pages=page_range(_pages(prow)))
            log.add("PART_OMITTED", scope, "group parse")
            continue
        first, last = groups[0][0], max(b for _, b, _ in groups)
        if qa is not None and (qa, qb) != (first, last):
            log.add("QUESTION_RANGE_MISMATCH", scope, f"header {qa}-{qb} vs groups {first}-{last}")
            log.add("PART_OMITTED", scope, "range")
            continue
        if not _check_contiguous(groups, first, last, scope, log):
            log.add("PART_OMITTED", scope, "numbering")
            continue
        title, paras, notes = _paragraphs(passage_rows)
        text_len = sum(len(p["text"]) for p in paras)
        if text_len < 1200:
            log.add("PASSAGE_NOT_FOUND", scope, f"passage text too short ({text_len} chars)",
                    pages=page_range(_pages(passage_rows)) if passage_rows else None)
            log.add("PART_OMITTED", scope, "passage")
            continue
        part.passage = Passage(number=no, title=title, paragraphs=paras, notes=notes, pages=_pages(passage_rows))
        part.groups = parsed
        out.append(part)
    return out


def _tail_after_items(grows: list, g) -> list:
    last_item_page = None
    idx_last = None
    for i, r in enumerate(grows):
        toks = [t for t in r.tokens if t.text.strip()]
        if toks and toks[0].text.strip().strip(".") == str(g.last):
            idx_last = i
    if idx_last is None:
        return []
    return grows[idx_last + 1:]


# ─── Writing / Speaking ───────────────────────────────────────────────────────────────────

def extract_writing(rows: list, scope_root: str, log: DiagnosticLog, layer, store, academic: bool) -> list:
    tasks, cur_no, cur = [], None, []
    pending = False
    segs = []
    for r in rows:
        t = row_text(r)
        if re.fullmatch(r"(?:X\s+)?SPEAKING(?:\s+X)?", t.strip(), re.I):
            # Explicit next-skill heading terminates Writing even if annotation drifted.
            if cur_no is not None:
                segs.append((cur_no, cur))
            cur_no, cur = None, []
            break
        m = _TASK.match(t)
        if m and (t.upper().startswith("WRITING") or pending or t.upper().startswith("TASK")):
            if cur_no is not None:
                segs.append((cur_no, cur))
            cur_no, cur = int(m.group(1)), []
            pending = False
            continue
        pending = t.upper() == "WRITING"
        if pending:
            continue
        if cur_no is not None:
            cur.append(r)
    if cur_no is not None:
        segs.append((cur_no, cur))
    seen_tasks = set()
    for no, trows in segs:
        scope = f"{scope_root}/TASK_{no}"
        if no in seen_tasks:
            # a second 'TASK n' in the same test = the General Training module printed after the Academic one
            log.add("GROUP_STRUCTURE_AMBIGUOUS", scope, "repeated task number (other module) ignored",
                    pages=page_range(_pages(trows)), severity="INFO")
            continue
        seen_tasks.add(no)
        if not trows:
            log.add("WRITING_TASK_NOT_FOUND", scope, "empty task")
            continue
        minutes, words = None, None
        figure, kind = None, None
        prompt_rows = trows
        if no == 1 and academic and layer is not None:
            page = trows[0].page
            w, h = layer.page_size(page)
            anchor = [r for r in trows if r.page == page and re.search(r"summari[sz]e|write at least|make comparisons", row_text(r), re.I)]
            y_from = max(r.y1 for r in anchor) if anchor else trows[0].y1
            # Phase 4.1B: the book's page-navigation marker in the page foot ('→ p. 127', with the folio) is not
            # part of the visual — the figure region stops above it
            nav = [r for r in layer.rows(page) if r.y0 >= 0.85 * h and r.y0 > y_from
                   and re.search(r"(?:^|\s)p\.\s*\d{1,3}(?:\s|$)", row_text(r))]
            y_to = min(r.y0 for r in nav) - 2 if nav else h * 0.95
            hit = figure_region(layer, page, y_from, y_to, raster=True)
            if hit:
                bbox, method = hit
                # Phase 4.1B: the figure's printed title (bold rows between the prompt and the drawing, e.g. the
                # units '(in £m)') belongs to the visual: the crop is extended over it
                titles = [r for r in trows if r.page == page and r.y0 >= y_from - 1 and r.y0 < bbox[1] - 1
                          and bbox[1] - r.y1 <= 30 and r.all_bold
                          and not re.search(r"summari[sz]e|write at least|make comparisons", row_text(r), re.I)]
                if titles:
                    bbox = (min(bbox[0], min(r.x0 for r in titles)), min(r.y0 for r in titles),
                            max(bbox[2], max(r.x1 for r in titles)), bbox[3])
                # ... and so do the axis labels / legend rows printed directly under the drawing (contiguous rows,
                # gap <= 16 pt, horizontally inside the figure), never the page-foot navigation marker
                bottom = bbox[3]
                for r in sorted(layer.rows(page), key=lambda x: x.y0):
                    if r.y0 < bottom - 2 or r.y0 >= y_to or r in nav:
                        continue
                    if r.y0 - bottom > 16 or r.x1 < bbox[0] or r.x0 > bbox[2]:
                        break
                    bottom = max(bottom, r.y1)
                bbox = (bbox[0], bbox[1], bbox[2], bottom)
                inside = [r for r in trows if r.page == page and r.y0 >= bbox[1] - 3 and r.y1 <= bbox[3] + 14
                          and not re.search(r"write at least", row_text(r), re.I)]
                figure = capture_figure(layer, store, page, bbox, method, inside)
                prompt_rows = [r for r in trows if r not in inside]
                log.add("IMAGE_REGION_HEURISTIC", scope, method, pages=str(page))
                tl = " ".join(row_text(r) for r in prompt_rows).lower()
                kind = "MAP" if re.search(r"\b(map|maps|plan|plans)\b", tl) else (
                    "IMAGE" if re.search(r"\b(diagram|process|stages)\b", tl) else "CHART")
            else:
                log.add("WRITING_VISUAL_NOT_FOUND", scope, "no figure region below the task prompt", pages=str(page))
        lines = []
        for r in prompt_rows:
            t = row_text(r)
            if not t:
                continue
            m = _SPEND.search(t)
            if m:
                minutes = int(m.group(1))
            m = re.search(r"write at least (\d{2,3}) words", t, re.I)
            if m:
                words = int(m.group(1))
            else:
                # Phase 5B: a text layer that splits the printed '150' as '1 50' -- joined only when the digits
                # give exactly the IELTS minimum of THIS task (Task 1: 150, Task 2: 250); anything else is unread
                m = re.search(r"write at least (\d)\s(\d{2}) words", t, re.I)
                if m and int(m.group(1) + m.group(2)) == {1: 150, 2: 250}.get(no):
                    words = int(m.group(1) + m.group(2))
                    log.add("WRITING_MIN_WORDS_SPLIT_DIGITS", scope, f"minimum words {words} printed as split digits",
                            pages=str(r.page))
            lines.append(t)
        prompt = clean_text(" ".join(lines))
        if len(prompt) < 60 or words is None:
            log.add("WRITING_TASK_NOT_FOUND", scope, "prompt or minimum words not found", pages=page_range(_pages(trows)))
            continue
        tasks.append(WritingTask(number=no, prompt=prompt[:3000], minimum_words=words, recommended_minutes=minutes,
                                 figure=figure, visual_kind=kind, pages=_pages(trows)))
    return tasks


def speaking_turn_prompts(number: int, lines: list) -> list:
    """Bind printed question sentences/cue card without generating or dropping a turn."""
    if number == 2:
        text = clean_text(" ".join(lines))
        if (not re.match(r"Describe\b", text, re.I) or not re.search(r"You should say", text, re.I)
                or not re.search(r"\bexplain\b", text, re.I)
                or re.search(r"\bYou (?:will|can)\b|\b1 to 2\b", text)):
            return []
        return [text]
    starts = re.compile(r"^(What|When|Where|Who|Why|Which|How|Do|Does|Did|Is|Are|Was|Were|Would|Will|Can|Could|Should|Have|Has|If|Tell me|In what ways|In your opinion|To what extent)\b", re.I)
    turns, pending = [], []
    for line in lines:
        if starts.match(line):
            if pending:
                return []  # a new question before the previous sentence ends
            pending = [line]
        elif pending:
            pending.append(line)
        elif re.fullmatch(r"\[.*\]", line) and turns:
            turns[-1] = clean_text(turns[-1] + " " + line)
        elif "?" in line:
            return []  # unreadable question start must not be silently dropped
        if pending and ("?" in line or (pending[0].lower().startswith("tell me") and line.endswith("."))):
            turns.append(clean_text(" ".join(pending)))
            pending = []
    if pending or not 1 <= len(turns) <= 12:
        return []
    return turns


def extract_speaking(rows: list, scope_root: str, log: DiagnosticLog, layer) -> list:
    parts = []
    for no, prow in split_parts(rows):
        if not prow:
            continue
        w = layer.page_size(prow[0].page)[0] if layer else 600
        prompts = []
        for r in prow:
            toks = [t for t in r.tokens if t.x1 < 0.64 * w] if no == 2 else r.tokens
            t = clean_text(" ".join(x.text for x in toks)).lstrip("•").strip()
            if not t or re.match(r"^(example\b.*|example speaking test video)$", t, re.I):
                continue
            prompts.append(t[:300])
        turns = speaking_turn_prompts(no, prompts)
        if prompts and turns:
            parts.append(SpeakingPart(number=no, title=prompts[0][:120], prompts=prompts, pages=_pages(prow), turn_prompts=turns))
        elif prompts:
            log.add("SPEAKING_TURN_STRUCTURE_UNPROVEN", f"{scope_root}/PART_{no}",
                    "printed question boundaries or complete cue card not proven", pages=page_range(_pages(prow)))
    if [p.number for p in parts] != [1, 2, 3]:
        log.add("SPEAKING_PROMPTS_NOT_FOUND", scope_root, f"parts={[p.number for p in parts]}")
    return parts


# ─── Answer keys ──────────────────────────────────────────────────────────────────────────

def is_page_folio(row, page: int, page_height: float, page_rows: list) -> bool:
    """A printed page number: a row holding ONLY a 1-3 digit number, the LOWEST row of the page, in its bottom 15%,
    whose value is within 12 of the physical page index (folios track the page; an answer such as '250' would not).
    Phase 4.1C: the Cambridge 16 folio '121' was read as part of the last key entry of the page."""
    text = row_text(row).strip()
    if not re.fullmatch(r"\d{1,3}", text) or not page_height:
        return False
    lowest = all(r is row or r.y0 < row.y0 for r in page_rows)
    return lowest and row.y0 >= 0.85 * page_height and abs(int(text) - page) <= 12


def skill_key_rows(stream: list, test: int, skill: str, layer, log=None, scope: str = "") -> list:
    """Rows of the LISTENING / READING key block of a test, column-split per page, page furniture removed."""
    sel = [a.row for a in stream if a.region == ANSWER_KEY and a.test == test and a.skill == skill]
    res = []
    for page in sorted({r.page for r in sel}):
        prs = [r for r in sel if r.page == page]
        h = layer.page_size(page)[1] if layer else 0
        folios = [r for r in prs if is_page_folio(r, page, h, prs)]
        if folios:
            prs = [r for r in prs if r not in folios]
            if log is not None:
                log.add("ANSWER_KEY_PAGE_FOLIO_REMOVED", scope, "printed page number in the key block",
                        pages=str(page), severity="INFO")
        no_band = [r for r in prs if not _BAND.search(row_text(r))]
        w = layer.page_size(page)[0] if layer else 600
        # split BEFORE dropping headers: a header cell ('Questions 14-26') may share a visual row with a key cell
        # Score prose has a different column grid. Measure the key gutter on
        # its own printed numeric rows, preserving all answer tokens.
        anchors = [r for r in no_band if len(r.tokens) >= 2
                   and re.fullmatch(r'\d{1,2}',r.tokens[0].text.strip())
                   and 1 <= int(r.tokens[0].text) <= 40]
        key_columns = split_columns(no_band, w, gutter_rows=anchors if len(anchors)>=6 else None)
        if any(r.column == 1 for r in key_columns):
            # Region OCR can deliver an upper right-column remainder after
            # a lower merged block. Its own y coordinate supplies order.
            key_columns.sort(key=lambda r:(r.column,r.y0,r.x0))
        for r in key_columns:
            if not _KEY_NOISE.match(row_text(r)):
                res.append(r)
    return res
