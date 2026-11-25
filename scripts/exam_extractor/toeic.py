"""TOEIC Listening & Reading extractor (2016+ format: P5 101-130, P6 131-146 = 4 sets x 4, P7 147-200).

Structure evidence, never guessed:
  * question numbers fix the part (numbering is part of the public format);
  * Part 6/7 sets come ONLY from printed headers 'Questions 135-138 refer to the following e-mail.';
  * the number of documents in a Part 7 set comes from the header noun list ('Web page and e-mail' = 2);
  * Part 6 blank <-> question mapping is accepted only when the passage shows exactly one blank per question
    in reading order.
Options keep their printed text (no letter-only options). A missing key is never written; when the source has no
answer key at all the items are emitted WITHOUT answer specs (structure-review package) and the Phase 2 gate
blocks them (ANSWER_KEY_MISSING).
"""
from __future__ import annotations

import re
from typing import Optional

from .diagnostics import PROBABLE, DiagnosticLog, page_range
from .ielts_groups import BLANK
from .model import (ExtractedTest, Item, Option, Part, Passage, QuestionGroup, Section, SINGLE_CHOICE,
                    SourceDocument)
from .pdf_layer import DOTS, Row, clean_text, find_gutter, split_columns

# OCR may corrupt the tail of "following" (followina / fol1owing); the printed RANGE digits stay exact
_SET_SQUEEZED = re.compile(r"^Questions?(\d{3})[-–—](\d{3})refers?tothefo[l1I]{2}[o0]w[a-z1]{2,4}?(?=[a-z])(.+)$", re.I)
_FOLLOWING = re.compile(r"f\s*o\s*[l1I]\s*[l1I]\s*[o0]\s*w\s*i\s*n\s*[ga]\s+", re.I)


class _SetHeader:
    """'Questions 172-175 refer to the following schedule of events.' tolerant of OCR intra-word spaces
    ('Questi ons 181-185 refer to the fo ll owing ...'): matched on the space-free form."""

    @staticmethod
    def match(text: str):
        m = _SET_SQUEEZED.match(re.sub(r"\s+", "", text))
        if not m:
            return None
        f = _FOLLOWING.search(text)
        noun = (text[f.end():].strip() if f else m.group(3)).rstrip(".:;")
        return _Hit(m.group(1), m.group(2), noun)


class _Hit:
    def __init__(self, a, b, noun):
        self._g = (a, b, noun)

    def group(self, i):
        return self._g[i - 1]


SET_HEADER = _SetHeader()
ITEM_START = re.compile(r"^(\d{1,3})\s*[.,]\s*(.*)$")   # 1-3 digits: Listening 1-100, Reading 101-200
OPTION = re.compile(r"^\(([A-D8])\)\s*(.*)$")
BLANK_RUN = re.compile(r"-[\s-]{4,}-|_{4,}")
PART_OF = lambda n: 5 if 101 <= n <= 130 else 6 if 131 <= n <= 146 else 7 if 147 <= n <= 200 else 0

# Public TOEIC L&R numbering (format, not content): part -> (first, last) question number
FORMATS = {
    "TOEIC_LR_2016": {1: (1, 6), 2: (7, 31), 3: (32, 70), 4: (71, 100), 5: (101, 130), 6: (131, 146), 7: (147, 200)},
    "TOEIC_LR_PRE_2016": {1: (1, 10), 2: (11, 40), 3: (41, 70), 4: (71, 100), 5: (101, 140), 6: (141, 152),
                          7: (153, 200)},
}


def part_of(n: int, fmt: str = "TOEIC_LR_2016") -> int:
    for part, (a, b) in FORMATS[fmt].items():
        if a <= n <= b:
            return part
    return 0


def part_numbers(part: int, fmt: str = "TOEIC_LR_2016") -> list:
    a, b = FORMATS[fmt][part]
    return list(range(a, b + 1))


def _norm(text: str) -> str:
    t = clean_text(text)
    t = re.sub(r"\(\s*([A-D8])\s*\)", r"(\1)", t)
    m = re.match(r"^(\d{1,2})\s(\d{1,2})\s*\.", t)  # OCR '1 05.' / '11 5.' -> '105.' / '115.'
    if m and len(m.group(1) + m.group(2)) == 3:
        t = m.group(1) + m.group(2) + "." + t[m.end():]
    return t


_PLURAL_DOC = re.compile(r"^(e-?mails|letters|articles|messages|notices|reviews|web pages|memos|advertisements|"
                         r"invoices|forms|schedules|reports|announcements)$", re.I)


def doc_nouns(noun_phrase: str) -> list:
    """Printed document nouns of a set header ('e-mail, list, and article'); OCR ';' for ',' is normalised."""
    np = re.sub(r"\s*;\s*", ", ", noun_phrase)
    return [p.strip() for p in re.split(r",\s*(?:and\s+)?|\s+and\s+", np) if p.strip()]


def doc_count(noun_phrase: str) -> int:
    """'Web page and e-mail' -> 2; 'e-mail, list, and article' -> 3; 'e-mails and form' -> 3 (a plural document
    noun in a set header names two documents); 'text-message chain' -> 1."""
    np = re.sub(r"\b(two|three)\b", lambda m: {"two": "x and x", "three": "x, x and x"}[m.group(1)], noun_phrase, flags=re.I)
    return sum(2 if _PLURAL_DOC.match(p) else 1 for p in doc_nouns(np)) or 1


def declared_types(noun_phrase: str) -> list:
    """One declared type per document ('e-mails and form' -> ['e-mail', 'e-mail', 'form'])."""
    out = []
    for p in doc_nouns(noun_phrase):
        if _PLURAL_DOC.match(p):
            out.extend([p[:-1], p[:-1]])
        else:
            out.append(p)
    return out


def _option_letter(s: str, expected: str) -> bool:
    return s == expected or (s == "8" and expected == "B")


def _parse_items(rows: list, numbers: list, log: DiagnosticLog, scope: str,
                 empty_stem_ok: Optional[bool] = None) -> Optional[list]:
    """Numbered stems + (A)-(D) options for exactly the given question numbers, in order."""
    items, cur, cur_opt = [], None, None
    previous_content_row = None
    want = list(numbers)
    for r in rows:
        t = _norm(r.text)
        if not t:
            continue
        m = ITEM_START.match(t)
        if m and want and int(m.group(1)) == want[0]:
            rest = m.group(2).strip()
            cur = Item(number=want.pop(0), prompt="", interaction=SINGLE_CHOICE, pages=[r.page])
            items.append(cur)
            cur_opt = None
            previous_content_row = r
            mo = OPTION.match(rest)
            if mo and mo.group(1) == "A":   # Part 6: '135. (A) reasons' (no printed stem)
                cur_opt = Option("A", mo.group(2).strip())
                cur.options.append(cur_opt)
            else:
                cur.prompt = rest
            continue
        if cur is None:
            continue
        # A printed next-Part heading closes the question block. Its directions
        # must not become a continuation of the preceding item's final option.
        if re.match(r"^PART\s+[1-7](?:\s|$)", t, re.I):
            break
        mo = OPTION.match(t)
        nxt = "ABCD"[len(cur.options)] if len(cur.options) < 4 else None
        if mo and nxt and _option_letter(mo.group(1), nxt):
            if mo.group(1) == "8":
                log.add("OCR_TEXT_USED", scope, "option letter (8) read as (B)", questions=str(cur.number))
            cur_opt = Option(nxt, mo.group(2).strip())
            cur.options.append(cur_opt)
            previous_content_row = r
            continue
        if cur_opt is not None:
            # A continuation must stay in the same printed question column and
            # adjacent line band. Headers, the next column and the next page do
            # not continue the preceding column's final option.
            if previous_content_row is not None and (
                    r.page != previous_content_row.page or
                    getattr(r, "column", None) != getattr(previous_content_row, "column", None) or
                    r.y0 - previous_content_row.y1 > 2 * max(previous_content_row.y1 - previous_content_row.y0, 1) or
                    r.y1 < previous_content_row.y0):
                if len(cur.options) < 4:
                    log.add("OPTION_CONTINUATION_UNPROVEN", scope,
                            "disconnected text before all option labels", questions=str(cur.number))
                    return None
                continue
            cur_opt.text = clean_text(cur_opt.text + " " + t)
        else:
            cur.prompt = clean_text(cur.prompt + " " + t)
        previous_content_row = r
    if want:
        log.add("QUESTION_NUMBER_GAP", scope, f"missing={len(want)}", questions=",".join(map(str, want[:10])))
        return None
    for it in items:
        if [o.id for o in it.options] != list("ABCD") or any(not o.text for o in it.options):
            log.add("OPTION_PARSE_FAILED", scope, f"options={len(it.options)}", questions=str(it.number))
            return None
        if not it.prompt and not (empty_stem_ok if empty_stem_ok is not None else PART_OF(it.number) == 6):
            log.add("QUESTION_BLOCK_NOT_FOUND", scope, "empty stem", questions=str(it.number))
            return None
    return items


def _marker_only(t: str) -> bool:
    return bool(re.fullmatch(r"[\s.,'’`\-]*(1\d\d\s*\.[\s.,'’`]*)+", t))


def _passage(rows: list, number: int, title: str, n_docs: int) -> Passage:
    paras, cur = [], []
    prev = None
    for r in rows:
        t = _norm(r.text)
        if not t or _marker_only(t):
            continue
        if prev is not None and (r.page != prev.page or r.y0 - prev.y1 > 6):
            if cur:
                paras.append({"id": None, "text": clean_text(" ".join(cur))})
            cur = []
        cur.append(t)
        prev = r
    if cur:
        paras.append({"id": None, "text": clean_text(" ".join(cur))})
    return Passage(number=number, title=title, paragraphs=paras, pages=sorted({r.page for r in rows}),
                   documents=[{"declaredType": d} for d in declared_types(title)] if n_docs >= 2 else [])


def extract_reading_test(rows: list, log: DiagnosticLog, layer, fmt: str = "TOEIC_LR_2016") -> list:
    """rows: one test's reading rows in reading order -> [Part 5, Part 6, Part 7]."""
    p6_first = FORMATS[fmt][6][0]
    headers = []
    for i, r in enumerate(rows):
        m = SET_HEADER.match(_norm(r.text))
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if p6_first <= a <= b <= 200:
                headers.append((i, a, b, m.group(3).strip()))
    parts = []
    # Part 5 --------------------------------------------------------------------------------
    p5_end = headers[0][0] if headers else len(rows)
    items = _parse_items(rows[:p5_end], part_numbers(5, fmt), log, "READING/PART_5", empty_stem_ok=False)
    if items:
        p = Part(code="READING_PART_5", number=5, pages=sorted({r.page for r in rows[:p5_end]}))
        g = QuestionGroup(first=FORMATS[fmt][5][0], last=FORMATS[fmt][5][1], kind="TOEIC_PART_5", items=items,
                          instructions=["Select the best answer to complete the sentence."])
        p.groups.append(g)
        parts.append(p)
    else:
        log.add("PART_OMITTED", "READING/PART_5", "structure")
    # Part 6 / 7 sets -------------------------------------------------------------------------
    sets = {6: [], 7: []}
    for k, (i, a, b, noun) in enumerate(headers):
        end = headers[k + 1][0] if k + 1 < len(headers) else len(rows)
        if part_of(a, fmt) in (6, 7):
            sets[part_of(a, fmt)].append((a, b, noun, rows[i + 1:end]))
    for part_no, expected_numbers in ((6, part_numbers(6, fmt)), (7, part_numbers(7, fmt))):
        scope = f"READING/PART_{part_no}"
        groups = []
        covered = []
        ok = True
        for a, b, noun, srows in sets.get(part_no, []):
            covered.extend(range(a, b + 1))
            g = _parse_set(part_no, a, b, noun, srows, log, scope, layer)
            if g is None:
                ok = False
                break
            groups.append(g)
        if ok and covered != list(expected_numbers):  # numbering VALIDATES the printed set headers
            log.add("QUESTION_RANGE_MISMATCH", scope, f"set headers cover {len(covered)} of {len(expected_numbers)} questions")
            ok = False
        if not ok or not groups:
            log.add("PART_OMITTED", scope, "structure")
            continue
        p = Part(code=f"READING_PART_{part_no}", number=part_no)
        p.groups = groups
        p.pages = sorted({pg for g in groups for pg in g.pages})
        parts.append(p)
    return parts


def _parse_set(part_no: int, a: int, b: int, noun: str, srows: list, log: DiagnosticLog, scope: str, layer):
    nums = list(range(a, b + 1))
    qscope = f"{scope}/Q{a}-{b}"
    n_docs = doc_count(noun)
    if part_no == 6:
        inline = _parse_part6_inline(a, b, noun, srows, log, qscope)
        if inline is not None:
            return inline if inline is not False else None
        opt_idx = next((i for i, r in enumerate(srows) if re.match(rf"^{a}\s*\.\s*\(\s*A\s*\)", _norm(r.text))), None)
        if opt_idx is None:
            log.add("OPTION_PARSE_FAILED", qscope, "option block not found")
            return None
        passage_rows, opt_rows = srows[:opt_idx], srows[opt_idx:]
        width = layer.page_size(opt_rows[0].page)[0] if layer else 600
        gut = find_gutter(opt_rows, width)
        if gut is not None:
            # Column order is local to one printed page. Sorting a following
            # page's Part 7 heading before the current page's right options
            # prematurely closes Part 6 and drops its final questions.
            opt_rows = [r for page in dict.fromkeys(r.page for r in opt_rows)
                        for r in split_columns([r for r in opt_rows if r.page == page],
                                               layer.page_size(page)[0] if layer else width)]
        items = _parse_items(opt_rows, nums, log, qscope, empty_stem_ok=True)
        if items is None:
            return None
        if any(t.text == DOTS for r in passage_rows for t in r.tokens):
            # geometric blank tokens (layout-aware OCR): the printed number under/beside each blank decides
            from .toeic_sets import label_passage_rows, map_part6_blanks
            mapping, method, detail = map_part6_blanks(passage_rows, nums)
            if mapping is None:
                log.add("PART6_BLANK_MAPPING_UNPROVEN", qscope, detail)
                return None
            log.add("PART6_BLANK_GEOMETRY", qscope, f"{len(mapping)} blanks tied to printed labels ({method})")
            passage = _passage(label_passage_rows(passage_rows, mapping, BLANK), a, noun, 1)
        else:
            text = " ".join(_norm(r.text) for r in passage_rows if not _marker_only(_norm(r.text)))
            blanks = BLANK_RUN.findall(text)
            if len(blanks) != len(nums):
                log.add("GROUP_STRUCTURE_AMBIGUOUS", qscope, f"blanks={len(blanks)} questions={len(nums)}")
                return None
            passage = _passage(passage_rows, a, noun, 1)
            # label blanks in reading order (one per question, verified above)
            counter = iter(nums)
            for para in passage.paragraphs:
                para["text"] = BLANK_RUN.sub(lambda m: f"({next(counter)}) {BLANK}", para["text"])
        for it in items:
            if not it.prompt:
                # Part 6 prints no stem: the item IS its numbered blank, shown exactly as marked in the passage
                it.prompt = f"({it.number}) {BLANK}"
        g = QuestionGroup(first=a, last=b, kind="TOEIC_PART_6", items=items, pages=sorted({r.page for r in srows}),
                          instructions=[f"Questions {a}-{b} refer to the following {noun}."])
        g.passage = passage
        return g
    # Part 7
    first_item = next((i for i, r in enumerate(srows) if (m := ITEM_START.match(_norm(r.text))) and int(m.group(1)) == a), None)
    if first_item is None:
        log.add("QUESTION_BLOCK_NOT_FOUND", qscope, "first question of the set not found")
        return None
    passage_rows, q_rows = srows[:first_item], srows[first_item:]
    items = _parse_items(q_rows, nums, log, qscope)
    if items is None:
        return None
    passage = _passage(passage_rows, a, noun, n_docs)
    if sum(len(p["text"]) for p in passage.paragraphs) < 150:
        log.add("PASSAGE_NOT_FOUND", qscope, "passage text too short")
        return None
    if n_docs >= 2:
        from .toeic_sets import doc_paragraphs, segment_documents
        body = [r for r in passage_rows if not _marker_only(_norm(r.text))]
        docs = segment_documents(body, n_docs) if any(hasattr(r, "frame") for r in body) else None
        if docs is not None:
            declared = declared_types(noun)
            passage.documents = [{"declaredType": declared[k] if k < len(declared) else None,
                                  "paragraphs": doc_paragraphs(d), "sourcePages": sorted({r.page for r in d})}
                                 for k, d in enumerate(docs)]
            passage.document_boundaries = "SEGMENTED"
            log.add("MULTI_DOC_SEGMENTED", qscope, f"{n_docs} documents separated by layout (frames / gaps)")
        else:
            log.add("LAYOUT_LINEARIZED", qscope, f"{n_docs} documents declared by the set header; document boundaries not segmented")
    g = QuestionGroup(first=a, last=b, kind="TOEIC_PART_7", items=items, pages=sorted({r.page for r in srows}),
                      instructions=[f"Questions {a}-{b} refer to the following {noun}."])
    g.passage = passage
    return g


def _option_start(r, q: int) -> bool:
    return bool(re.match(rf"^{q}\s*\.\s*\(\s*A\s*\)", _norm(r.text)))


def _parse_part6_inline(a: int, b: int, noun: str, srows: list, log: DiagnosticLog, qscope: str):
    """Pre-2016 Part 6 layout (Phase 3.6C): every question's option block ('141. (A) …' + (B)-(D)) is printed
    INSIDE the passage, directly under the line that holds its blank.

    -> None when the set is not laid out this way (caller uses the standard parser); False when it is but the
    structure is not proven (diagnostic logged); else the QuestionGroup.

    Proof per question: the block's first row carries the printed number; the passage line immediately above the
    block holds exactly ONE geometric blank token; that blank lies horizontally under/inside the block's column
    span; every blank is used once and numbers increase in reading order. Nothing is mapped by position alone."""
    nums = list(range(a, b + 1))
    # This adapter is for the three-blank pre-2016 layout. Modern four-item
    # option columns may interleave in OCR order without being inline blanks.
    if len(nums) != 3:
        return None
    starts = [next((i for i, r in enumerate(srows) if _option_start(r, q)), None) for q in nums]
    if all(s is not None for s in starts) and starts != sorted(starts):
        heads = [srows[s] for s in starts]
        # Inline option blocks can sit at different horizontal positions in
        # one continuous passage. A page-wide column sort moves a later left
        # block ahead of an earlier right block. Restore physical line order
        # only when the printed numbered heads occupy separate vertical bands.
        if all(right.page > left.page or
               (right.page == left.page and right.y0 - left.y0 >
                4 * max(left.y1-left.y0, right.y1-right.y0, 1))
               for left, right in zip(heads, heads[1:])):
            srows = sorted(srows, key=lambda r: (r.page, r.y0, r.x0))
            starts = [next(i for i, r in enumerate(srows) if _option_start(r, q)) for q in nums]
    if any(s is None for s in starts) or starts != sorted(starts):
        return None
    # interleaved = passage text between two consecutive blocks (otherwise the standard layout applies)
    blocks = []
    for k, s in enumerate(starts):
        x_col = srows[s].x0
        end = s + 1
        nxt = starts[k + 1] if k + 1 < len(starts) else len(srows)
        d_text_x = None
        while end < nxt and srows[end].x0 >= x_col - 10:
            # The passage may use the same left margin as the numbered head.
            # After D, only an adjacent indented continuation belongs to the
            # option. Paragraphs and their next blank remain stimulus text.
            previous = srows[end-1]
            if OPTION.match(_norm(previous.text)) and _norm(previous.text).startswith('(D)'):
                d_text_x = previous.tokens[1].x0 if len(previous.tokens)>1 else previous.x1
            if d_text_x is not None:
                if (srows[end].page != previous.page or
                        srows[end].x0 < d_text_x - 5 or
                        srows[end].y0 - previous.y1 > 1.5 * max(1,previous.y1-previous.y0) or
                        any(t.text == DOTS for t in srows[end].tokens)):
                    break
            end += 1
        blocks.append((s, end))
    gaps = [blocks[k + 1][0] - blocks[k][1] for k in range(len(blocks) - 1)]
    if not gaps or not any(g > 0 for g in gaps):
        return None
    # Interleaving needs an actual passage blank between option blocks.
    # An outdented option/continuation in a modern two-column answer area
    # does not establish the legacy inline layout.
    if not any(t.text == DOTS for k in range(len(blocks)-1)
               for r in srows[blocks[k][1]:blocks[k+1][0]] for t in r.tokens):
        return None
    block_idx = {i for s, e in blocks for i in range(s, e)}
    opt_rows = [r for s, e in blocks for r in srows[s:e]]
    items = _parse_items(opt_rows, nums, log, qscope, empty_stem_ok=True)
    if items is None:
        return False
    passage_rows = [r for i, r in enumerate(srows) if i not in block_idx and not _marker_only(_norm(r.text))]
    mapping = {}
    for q, (s, e) in zip(nums, blocks):
        head = srows[s]
        lh = max(head.y1 - head.y0, 1.0)
        bx0 = min(r.x0 for r in srows[s:e])
        bx1 = max(r.x1 for r in srows[s:e])
        # the printed line directly above the block (geometry, not stream order): ends within 2 line heights
        # above the block's first row on the same page
        above = [r for r in passage_rows if r.page == head.page and head.y0 - 2.0 * lh <= r.y1 <= head.y0 + 2]
        if above:
            # The immediately preceding printed line supplies the blank.
            # Decorative dot/rule bands higher in the two-line search window
            # are not additional blanks on that line.
            baseline = max(r.y1 for r in above)
            above = [r for r in above if baseline - r.y1 <= .4 * lh]
        hits = [(r, ti) for r in above for ti, tk in enumerate(r.tokens) if tk.text == DOTS]
        if len(hits) != 1:
            log.add("PART6_BLANK_MAPPING_UNPROVEN", qscope, f"Q{q}: {len(hits)} blanks on the line above its options")
            return False
        line, ti = hits[0]
        tk = line.tokens[ti]
        cx = (tk.x0 + tk.x1) / 2
        if not (bx0 - 20 <= cx <= bx1 + 20):
            log.add("PART6_BLANK_MAPPING_UNPROVEN", qscope, f"Q{q}: blank not above its option block")
            return False
        mapping[q] = (passage_rows.index(line), ti)
    if len({v for v in mapping.values()}) != len(mapping):
        log.add("PART6_BLANK_MAPPING_UNPROVEN", qscope, "two questions on one blank")
        return False
    from .toeic_sets import label_passage_rows
    log.add("PART6_BLANK_GEOMETRY", qscope, f"{len(mapping)} inline option blocks tied to the blank above each "
                                            f"(PRE_2016_INLINE_OPTIONS)")
    passage = _passage(label_passage_rows(passage_rows, mapping, BLANK), a, noun, 1)
    for it in items:
        if not it.prompt:
            it.prompt = f"({it.number}) {BLANK}"
    g = QuestionGroup(first=a, last=b, kind="TOEIC_PART_6", items=items, pages=sorted({r.page for r in srows}),
                      instructions=[f"Questions {a}-{b} refer to the following {noun}."])
    g.passage = passage
    return g


def extract_toeic(extractor, test, adapter, t: ExtractedTest) -> None:
    log = t.diagnostics
    t.variant = "STANDARD_FIXED_FORM"
    t.format_version = "TOEIC_LR_2016"
    docs = [d for d in test.book_raw.get("source_documents", []) if d.get("role") == "QUESTION_BOOK"]
    rc = [d for d in docs if d.get("scope") == "READING" and d.get("text_layer") in ("TEXT", "MIXED")]
    lc = [d for d in docs if d.get("scope") == "LISTENING"]
    if not lc:
        log.add("SOURCE_PDF_MISSING", "LISTENING", "no Listening question book in this collection")
    if not test.raw.get("audio"):
        log.add("SOURCE_AUDIO_UNMAPPED", "LISTENING", "no audio track mapped to this test")
    log.add("SECTION_OMITTED", "LISTENING", "no LC source")
    if not rc:
        log.add("PDF_NO_TEXT_LAYER", "READING", "no text-layer Reading book")
        log.add("OCR_REQUIRED", "READING")
        return
    layer = extractor.layer(rc[0]["path"], log)
    if layer is None:
        return
    t.documents.append(SourceDocument(layer.rel_path, layer.sha256, rc[0]["role"], rc[0]["text_layer"], layer.page_count))
    t.extraction_methods.add("NATIVE_TEXT")
    log.add("OCR_TEXT_USED", "READING", "embedded OCR text layer: spacing/character errors are possible (human proofreading required)")
    pages = _test_pages(layer, test.test_number, log)
    if not pages:
        log.add("TEST_BOUNDARY_NOT_FOUND", "READING", "no 'READING TEST' start page for this test")
        return
    rows = []
    for p in pages:
        rows.extend(page_bands(layer, p))
    parts = extract_reading_test(rows, log, layer)
    if not parts:
        log.add("SECTION_OMITTED", "READING", "no complete part")
        return
    for p in parts:
        for g in p.groups:
            if getattr(g, "passage", None) is not None:
                pass
    log.add("ANSWER_KEY_NOT_FOUND", "ANSWER_KEY/READING", "no Reading answer key exists in this collection")
    sec = Section("READING", parts=parts, pages=pages)
    t.sections.append(sec)
    log.add("PUBLISHER_LICENCE_NOT_ESTABLISHED", "TEST", "third-party publication; publisher licence UNKNOWN / PENDING (unchanged)")
    log.add("PROJECT_USAGE_OWNER_AUTHORIZED", "TEST", "project-owner authorization 2026-10-03 (not a publisher licence)")


def page_bands(layer, page: int, rows: Optional[list] = None) -> list:
    """Reading order of one TOEIC page. A page is cut into horizontal bands at set headers; inside a band the
    full-width passage rows stay whole and only the question/option block below them is split into columns
    (splitting the whole page would interleave passage half-lines)."""
    rows = [r for r in (rows if rows is not None else layer.rows(page)) if not _noise(r)]
    w = layer.page_size(page)[0]
    cuts = [i for i, r in enumerate(rows) if SET_HEADER.match(_norm(r.text)) and r.x0 < 0.3 * w]
    bounds = [0] + [c for c in cuts if c > 0] + [len(rows)]
    out = []
    for a, b in zip(bounds, bounds[1:]):
        band = rows[a:b]
        q = next((i for i, r in enumerate(band) if _starts_question_block(r)), None)
        if q is None:
            out.extend(band)
            continue
        out.extend(band[:q])
        out.extend(split_columns(band[q:], w))
    return out


def _starts_question_block(r: Row) -> bool:
    m = ITEM_START.match(_norm(r.text))
    return bool(m) and 101 <= int(m.group(1)) <= 200


def _noise(r: Row) -> bool:
    t = clean_text(r.text)
    return (not t or bool(re.fullmatch(r"(GO ON TO THE NEXT PAGE.*|TEST\s*\d+\s*\d*|\d{1,3}|[|I!~\[\]';:.\-•]+.{0,3})", t, re.I))
            or len(t) <= 2)


def _test_pages(layer, n: int, log: DiagnosticLog) -> list:
    starts = [p for p in range(1, layer.page_count + 1)
              if re.search(r"^\s*READING\s*T\s*E\s*S\s*T\b", layer.raw_text(p), re.M)]
    if len(starts) < n:
        return []
    start = starts[n - 1]
    end = starts[n] - 1 if n < len(starts) else layer.page_count
    # confirm with the running footer 'TEST n'
    footers = sum(1 for p in range(start, end + 1) if re.search(rf"\bTEST\s*{n}\b", layer.raw_text(p)))
    if footers < 0.35 * (end - start + 1):  # the footer is printed on every other page
        log.add("SOURCE_PAGE_RANGE_UNCERTAIN", "READING", f"footer 'TEST {n}' on {footers}/{end - start + 1} pages",
                pages=f"{start}-{end}")
        return []
    return list(range(start, end + 1))
