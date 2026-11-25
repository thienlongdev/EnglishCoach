"""IELTS question-group recognition and parsing (Listening + Reading).

Input: the rows of ONE question group ("Questions a-b" up to the next marker). Output: a QuestionGroup whose
items carry real prompts and options, or None plus diagnostics. The printed range a-b is the contract: a group
parses only when every question number a..b is found exactly once, in order.
"""
from __future__ import annotations

import re
from typing import Optional

from .answer_keys import ROMAN
from .diagnostics import DiagnosticLog
from .model import (GK_GAP, GK_HEADINGS, GK_LABEL, GK_MATCHING, GK_MULTI_SELECT, GK_SHORT_ANSWER,
                    GK_SINGLE_CHOICE, GK_TFNG, GK_YNNG, HEADING_MATCHING, LABEL_ASSIGNMENT, MATCHING,
                    SHORT_ANSWER, SINGLE_CHOICE, TEXT_GAP, TRUTH_CLASSIFICATION, Item, Option, QuestionGroup)
from .pdf_layer import DOTS, Row, Token, clean_text

BLANK = "______"
NUM_WORDS = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5, "SIX": 6, "SEVEN": 7}

QUESTIONS_RE = re.compile(r"^(?:Questions?|QUESTIONS?)\s+(\d{1,2})\s*(?:[-–—]|to|and|&)\s*(\d{1,2})\b[.:]?(.*)$")
QUESTION_SINGLE_RE = re.compile(r"^(?:Question|QUESTION)\s+(\d{1,2})\s*$")
_INSTRUCTION = re.compile(
    r"^(complete|write|choose|answer the|label|match|classify|look at|list of|in boxes|do the following|"
    r"reading passage \d+ (has|contains)|the (reading )?passage has|nb\b|you may use|true\b|false\b|not given\b|"
    r"yes\b|no\b|which (paragraph|section) contains|circle|use no more|using no more|for each|"
    r"select|identify|questions? \d|write the correct|which (two|three|four|five)|example\b)", re.I)
_LETTER_RANGE = re.compile(r"\b([A-Z])\s*[-–—]\s*([A-Z])\b")
_LETTER_LIST = re.compile(r"\b([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?\s*(?:or|and)\s*([A-Z])\b")
_ROMAN_RANGE = re.compile(r"\b(i)\s*[-–—]\s*([xvi]+)\b")


def row_text(row: Row) -> str:
    return clean_text(" ".join(t.text for t in row.tokens if t.text != DOTS))


def parse_range(text: str) -> Optional[tuple]:
    m = QUESTIONS_RE.match(text.strip())
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        rest = m.group(3).strip()
        # a marker stands alone or is followed by a new sentence / another marker, never by a sentence tail
        if 1 <= a <= b <= 50 and (not rest or rest[:1].isupper() or rest[:1].isdigit()):
            return a, b, rest
    m = QUESTION_SINGLE_RE.match(text.strip())
    if m:
        a = int(m.group(1))
        return a, a, ""
    return None


def option_range(text: str) -> Optional[list]:
    """Option ids announced in the instructions: 'A-G' / 'A, B or C' / 'A, B, C or D'."""
    m = _LETTER_LIST.search(text)
    if m:
        letters = [g for g in m.groups() if g]
        return letters
    m = _LETTER_RANGE.search(text)
    if m and m.group(1) == "A" and m.group(2) > "A":
        return [chr(c) for c in range(ord("A"), ord(m.group(2)) + 1)]
    return None


def word_limit(text: str) -> tuple:
    """(max words, numbers allowed, printed rule) from instructions like 'NO MORE THAN TWO WORDS AND/OR A NUMBER'."""
    t = re.sub(r"\s+", " ", text.upper())
    num = bool(re.search(r"AND/OR A NUMBER|AND/OR NUMBERS|OR A NUMBER", t))
    m = re.search(r"NO MORE THAN (ONE|TWO|THREE|FOUR|FIVE) WORDS?", t)
    if m:
        return NUM_WORDS[m.group(1)], num, m.group(0) + (" AND/OR A NUMBER" if num else "")
    m = re.search(r"\b(ONE|TWO|THREE) WORDS? (ONLY|AND/OR)", t)
    if m:
        return NUM_WORDS[m.group(1)], num, m.group(0)
    m = re.search(r"\b(ONE|TWO|THREE) WORDS?\b", t)
    if m and "FOR EACH ANSWER" in t:
        return NUM_WORDS[m.group(1)], num, m.group(0)
    if re.search(r"\bONE NUMBER\b|\bA NUMBER\b", t):
        return 1, True, "ONE NUMBER"
    return None, num, None


def classify(instr: str) -> Optional[tuple]:
    """Group kind (+ selection count for multi-select) from the printed instructions."""
    t = re.sub(r"\s+", " ", instr).strip()
    tl = t.lower()
    m = re.search(r"choose (two|three|four|five) (letters|answers|correct answers)", tl)
    if m and ("letters" in m.group(2) or re.search(r"\ba\s*[-–]\s*[a-z]\b", tl)) and "from the box" not in tl \
            and "next to" not in tl:
        return GK_MULTI_SELECT, NUM_WORDS[m.group(1).upper()]
    if re.search(r"which (two|three|four|five) ", tl) and re.search(r"choose|circle|write", tl) and "from the box" not in tl:
        m2 = re.search(r"which (two|three|four|five) ", tl)
        return GK_MULTI_SELECT, NUM_WORDS[m2.group(1).upper()]
    if re.search(r"\byes\b.*\bno\b.*not given|claims of the writer|views of the writer|writer's (views|claims)|"
                 r"agree with the (claims|views)", tl):
        return GK_YNNG, None
    if re.search(r"\btrue\b.*\bfalse\b.*not given|agree with the information", tl):
        return GK_TFNG, None
    if re.search(r"list of headings|correct heading", tl):
        return GK_HEADINGS, None
    if re.search(r"label the (map|plan|diagram|picture|chart)", tl) and re.search(r"correct letter|letters?,? [a-z]\s*[-–]", tl):
        return GK_LABEL, None
    if re.search(r"choose the correct letter|circle the (appropriate|correct) letters?|choose the (appropriate|correct) letter",
                 tl) and not re.search(r"from the (box|list)|list of", tl):
        return GK_SINGLE_CHOICE, None
    if re.search(r"which (paragraph|section) contains|from the (box|list)|list of|correct letter,? [a-z]\s*[-–]\s*[a-z]|"
                 r"match each|classify|correct (ending|person|researcher|option|statement)|"
                 r"write the (appropriate|correct) letters?|choose (four|five|six|seven|eight) answers", tl):
        return GK_MATCHING, None
    if re.search(r"answer the questions?", tl):
        return GK_SHORT_ANSWER, None
    if re.search(r"write no more than \w+ words?", tl) and not re.search(r"complete|label", tl):
        return GK_SHORT_ANSWER, None  # word-limited numbered questions without a completion text
    if re.search(r"(complete|label)( each| the)?", tl) and re.search(r"words?|number|answer", tl):
        return GK_GAP, None
    return None


# ─── Token helpers ────────────────────────────────────────────────────────────────────────

def _first(row: Row):
    toks = [t for t in row.tokens if t.text.strip()]
    return toks[0] if toks else None


def _num_token(tok) -> Optional[int]:
    if tok is None:
        return None
    s = tok.text.strip().strip(".")
    s = s[1:-1] if s.startswith("(") and s.endswith(")") else s
    return int(s) if re.fullmatch(r"\d{1,2}", s) else None


def _gap_number(row: Row, i: int, expected: int, ocr: bool) -> bool:
    """Is token i of row the printed gap marker of question `expected`?"""
    tok = row.tokens[i]
    n = _num_token(tok)
    if n != expected:
        return False
    nxt = row.tokens[i + 1] if i + 1 < len(row.tokens) else None
    prv = row.tokens[i - 1] if i > 0 else None
    if (nxt is not None and nxt.text == DOTS) or (prv is not None and prv.text == DOTS):
        return True
    if tok.bold and not all(t.bold for t in row.tokens if t.text.strip()):
        return True
    if tok.text.strip().startswith("(") and tok.text.strip().endswith(")"):
        return True
    if tok.bold and len([t for t in row.tokens if t.text.strip()]) == 1:
        return True
    # a lone number at the end of a row followed by a blank ruler drawn as vector (no text) -> a large gap after
    if nxt is not None and nxt.x0 - tok.x1 > 28:
        return True
    if nxt is None and not ocr and tok.bold:
        return True
    return False


def _row_starts_with_number(row: Row, n: int, left_margin: float) -> Optional[list]:
    """Tokens after the leading question number n (row must start at the item margin)."""
    toks = [t for t in row.tokens if t.text.strip()]
    if not toks:
        return None
    if _num_token(toks[0]) == n and toks[0].x0 <= left_margin + 30:
        return toks[1:]
    return None


def _letter_splits(row: Row, expected: str, strict_gap: bool) -> Optional[list]:
    """Split a row into options when it starts with the expected option letter (grid rows hold several)."""
    toks = [t for t in row.tokens if t.text.strip()]
    if not toks:
        return None
    out = []
    cur_letter, cur = None, []
    nxt = expected
    for i, t in enumerate(toks):
        s = t.text.strip().rstrip(".")
        s = s[1:-1] if s.startswith("(") and s.endswith(")") else s
        following = toks[i + 1] if i + 1 < len(toks) else None
        is_letter = (s == nxt and len(s) == 1 and (t.bold or following is None or following.x0 - t.x1 > 5.5
                                                   or not strict_gap))
        if is_letter and (i == 0 or cur_letter is not None):
            if cur_letter is not None:
                out.append((cur_letter, cur))
            cur_letter, cur = s, []
            nxt = chr(ord(s) + 1)
            continue
        if cur_letter is None:
            return None
        cur.append(t.text)
    if cur_letter is not None:
        out.append((cur_letter, cur))
    return out or None


# Phase 5B: the only label glyph observed to be dropped by a publisher text layer (a lone vertical stroke the
# layer's own OCR does not keep; same family as the Phase 4.1 'I' separator). Other letters are never restored.
DROPPABLE_LABELS = ("I",)


def restore_dropped_label(content: list, announced: Optional[list], log: DiagnosticLog, scope: str,
                          qrange: str) -> int:
    """Restore ONE option label the text layer dropped, only when the printed layout leaves a single reading:
    the instructions announce the letters; every other announced letter is printed exactly once as a bold label
    followed by plain text, in row-major lattice order; the label grid has fixed columns; and the orphan text
    starts exactly at the text column of the lattice cell that follows the missing letter's predecessor, with no
    label in that cell (single-column lists: every option is one line, the next row at the list's line pitch).
    Inserts a synthetic label token and returns 1, else 0 (nothing changed)."""
    if not announced or len(announced) < 3:
        return 0
    letters = set(announced)
    labels = []                        # (row index, token index, letter, token)
    for ri, r in enumerate(content):
        toks = r.tokens
        for ti, t in enumerate(toks):
            s = t.text.strip()
            nxt = toks[ti + 1] if ti + 1 < len(toks) else None
            if len(s) == 1 and s in letters and t.bold and nxt is not None and nxt.text.strip() and not nxt.bold:
                labels.append((ri, ti, s, t))
    found = [x[2] for x in labels]
    missing = [L for L in announced if L not in found]
    if len(missing) != 1 or missing[0] not in DROPPABLE_LABELS or len(set(found)) != len(found):
        return 0
    miss = missing[0]
    k = announced.index(miss)
    if k == 0 or found != [L for L in announced if L != miss]:
        return 0
    # label columns (x of the bold letters) and their text columns (x of the word after each letter)
    cols: list = []
    for _ri, _ti, _s, t in labels:
        c = next((i for i, cx in enumerate(cols) if abs(cx - t.x0) <= 6), None)
        if c is None:
            cols.append(t.x0)
    cols.sort()
    def col_of(t):
        return next((i for i, cx in enumerate(cols) if abs(cx - t.x0) <= 6), None)
    text_x = {}
    for ri, ti, _s, t in labels:
        text_x.setdefault(col_of(t), []).append(content[ri].tokens[ti + 1].x0)
    text_x = {c: sorted(v)[len(v) // 2] for c, v in text_x.items()}
    if len(text_x) != len(cols) or any(max(v) - min(v) > 4 for c, v in
                                       ((c, [content[ri].tokens[ti + 1].x0 for ri, ti, _s, t in labels
                                             if col_of(t) == c]) for c in text_x)):
        return 0
    # lattice cells of the printed labels, row-major
    label_rows = sorted({ri for ri, *_ in labels})
    pri, pti, _ps, ptok = labels[k - 1]
    pcol = col_of(ptok)
    if pcol + 1 < len(cols):
        tri, tcol = pri, pcol + 1                       # next cell on the same printed row
    else:
        tri, tcol = pri + 1, 0                          # first cell of the next printed row
        if tri >= len(content):
            return 0
        if len(cols) == 1:
            # single-column list: every option is exactly one line, rows at a regular pitch
            if label_rows != list(range(label_rows[0], label_rows[-1] + 1)):
                return 0
            pitches = [content[b].y0 - content[a].y0 for a, b in zip(label_rows, label_rows[1:])]
            if not pitches:
                return 0
            pitch = sorted(pitches)[len(pitches) // 2]
            if abs((content[tri].y0 - content[pri].y0) - pitch) > 0.3 * pitch:
                return 0
    row = content[tri]
    if any(col_of(t) == tcol and abs(t.x0 - cols[tcol]) <= 6 and t.text.strip() in letters and t.bold
           for t in row.tokens):
        return 0                                        # the cell has a printed label: nothing was dropped
    cand = next((i for i, t in enumerate(row.tokens) if t.text.strip() and abs(t.x0 - text_x[tcol]) <= 4), None)
    if cand is None:
        return 0
    if cand > 0 and row.tokens[cand].x0 - row.tokens[cand - 1].x1 < 20:
        return 0                                        # continuation of the previous cell, not a new cell
    # the successor letter (if any) must open the lattice cell right after the restored one
    if k + 1 < len(announced):
        sri, _sti, _ss, stok = labels[k]
        exp_row, exp_col = (tri, tcol + 1) if tcol + 1 < len(cols) else (tri + 1, 0)
        if (sri, col_of(stok)) != (exp_row, exp_col):
            return 0
    ref = labels[k - 1][3]
    row.tokens.insert(cand, Token(miss, cols[tcol], cols[tcol] + (ref.x1 - ref.x0), bold=True, size=ref.size,
                                  font=ref.font))
    log.add("OPTION_LABEL_RESTORED", scope, f"label {miss} absent from the text layer; restored by the announced "
            f"range and the option-grid lattice ({len(cols)} column(s))", questions=qrange,
            pages=str(row.page))
    return 1


def _grid_text_columns(row: Row, splits: list) -> list:
    """x where each split option's TEXT starts on its printed row (the token after its label), in split order."""
    toks = [t for t in row.tokens if t.text.strip()]
    out, i = [], 0
    for letter, _parts in splits:
        while i < len(toks):
            s = toks[i].text.strip().rstrip(".")
            s = s[1:-1] if s.startswith("(") and s.endswith(")") else s
            i += 1
            if s == letter:
                break
        out.append(toks[i].x0 if i < len(toks) else (toks[i - 1].x1 if toks else 0.0))
    return out


def _append_continuation(row: Row, row_opts: list, cur_opt: Option) -> None:
    """A wrapped line of an option grid continues the option whose TEXT column it sits under (Phase 5B: in a
    multi-column box the continuation of column 1 is not the text of the row's last option). One-column
    lists keep the previous behaviour (the current option)."""
    if len(row_opts) < 2:
        cur_opt.text = clean_text(cur_opt.text + " " + row_text(row))
        return
    for t in row.tokens:
        if not t.text.strip() or t.text == DOTS:
            continue
        owner = row_opts[0][0]
        for opt, tx in row_opts:
            if tx <= t.x0 + 4:
                owner = opt
        owner.text = clean_text(owner.text + " " + t.text)


def _roman_start(row: Row, expected_idx: int) -> Optional[list]:
    toks = [t for t in row.tokens if t.text.strip()]
    if not toks or expected_idx >= len(ROMAN):
        return None
    s = toks[0].text.strip().rstrip(".").lower()
    if s == ROMAN[expected_idx]:
        return toks[1:]
    return None


def _join(tokens) -> str:
    return clean_text(" ".join(t if isinstance(t, str) else t.text for t in tokens if (t if isinstance(t, str) else t.text) != DOTS))


def _is_heading_row(row: Row) -> bool:
    t = row_text(row)
    return bool(t) and (row.all_bold or row.size >= 13) and len(t) < 90 and not re.search(r"\d", t[:3])


# ─── Group parsing ────────────────────────────────────────────────────────────────────────

def split_preamble(rows: list, first: int, ocr: bool) -> tuple:
    """(instruction rows, content rows): instructions run until the first item / option / gap / list row."""
    for idx, r in enumerate(rows):
        t = row_text(r)
        f = _first(r)
        if _num_token(f) == first:
            return rows[:idx], rows[idx:]
        if any(_gap_number(r, i, first, ocr) for i in range(len(r.tokens))):
            return rows[:idx], rows[idx:]
        if f is not None and f.text.strip() in ("A", "(A)") and idx > 0 and not _INSTRUCTION.match(t):
            return rows[:idx], rows[idx:]
        if re.match(r"^list of (headings|people|researchers|features|statements|events|words|phrases|findings|"
                    r"theories|countries|places|dates|options|endings|scientists|experts|factors|effects|causes)\b",
                    t, re.I):
            return rows[:idx], rows[idx:]
        if f is not None and f.text.strip() == "i" and idx > 0:
            return rows[:idx], rows[idx:]
    return rows, []


def parse_group(rows: list, first: int, last: int, scope: str, log: DiagnosticLog, ocr: bool = False,
                left_margin: Optional[float] = None) -> Optional[QuestionGroup]:
    pages = sorted({r.page for r in rows})
    qrange = f"{first}-{last}"
    if not rows:
        log.add("QUESTION_BLOCK_NOT_FOUND", scope, "empty group", questions=qrange)
        return None
    pre, content = split_preamble(rows, first, ocr)
    instr_text = " ".join(row_text(r) for r in pre)
    kind = classify(instr_text)
    # split_preamble deliberately leaves the printed option-list title in
    # content. That own title identifies headings even when an instruction's
    # final glyph is damaged and its generic 'from the list' matches first.
    if content and re.fullmatch(r'list of headings[.:]?', row_text(content[0]), re.I):
        kind = GK_HEADINGS, None
    if kind is None:
        # instructions may be the leading content rows (some books print the stem first)
        kind = classify(" ".join(row_text(r) for r in rows[:8]))
    if kind is None:
        log.add("GROUP_TYPE_UNKNOWN", scope, "instructions not recognised", questions=qrange,
                pages=",".join(map(str, pages)))
        return None
    gk, count = kind
    wl, allow_num, wl_text = word_limit(instr_text)
    margin = left_margin if left_margin is not None else min((r.x0 for r in rows), default=0)
    g = QuestionGroup(first=first, last=last, kind=gk, pages=pages, word_limit=wl, word_limit_text=wl_text,
                      allow_number=allow_num)
    g.instructions = [row_text(r) for r in pre if _INSTRUCTION.match(row_text(r)) or r.all_italic][:8]
    stem_rows = [r for r in pre if r not in [x for x in pre if _INSTRUCTION.match(row_text(x)) or x.all_italic]]
    ok = False
    if gk == GK_GAP:
        # Completion titles, context and wrapped sentence prefixes belong to the
        # template. They precede the first numbered blank and are not instructions.
        ok = _parse_gap(g, stem_rows + content, log, scope, ocr)
    elif gk in (GK_SINGLE_CHOICE,):
        ok = _parse_mcq(g, content, log, scope, margin, option_range(instr_text))
    elif gk == GK_MULTI_SELECT:
        ok = _parse_multi(g, pre, content, log, scope, count, option_range(instr_text))
    elif gk in (GK_SHORT_ANSWER, GK_TFNG, GK_YNNG):
        ok = _parse_numbered(g, content, log, scope, margin)
        if ok and gk == GK_SHORT_ANSWER:
            for it in g.items:
                it.interaction = SHORT_ANSWER
        if ok and gk in (GK_TFNG, GK_YNNG):
            vals = ["TRUE", "FALSE", "NOT GIVEN"] if gk == GK_TFNG else ["YES", "NO", "NOT GIVEN"]
            for it in g.items:
                it.interaction = TRUTH_CLASSIFICATION
                it.options = [Option(v, v) for v in vals]
    elif gk == GK_HEADINGS:
        ok = _parse_headings(g, content, log, scope, margin)
    elif gk in (GK_MATCHING, GK_LABEL):
        announced = option_range(instr_text)
        restore_dropped_label(content, announced, log, scope, qrange)
        ok = _parse_matching(g, content, log, scope, margin, announced, instr_text, ocr)
    if not ok:
        return None
    if stem_rows and not g.stem:
        g.stem = "\n".join(row_text(r) for r in stem_rows if row_text(r))[:1500] or None
    nums = [i.number for i in g.items]
    if nums != list(range(first, last + 1)):
        log.add("QUESTION_RANGE_MISMATCH", scope, f"found={len(nums)} expected={last - first + 1}", questions=qrange)
        return None
    for it in g.items:
        it.pages = it.pages or pages
        if not it.prompt.strip():
            log.add("QUESTION_BLOCK_NOT_FOUND", scope, "empty prompt", questions=str(it.number))
            return None
    return g


def _parse_gap(g: QuestionGroup, content: list, log: DiagnosticLog, scope: str, ocr: bool) -> bool:
    """Completion text: every question number marks exactly one blank (a printed ruler / dots run, or the
    number itself when no ruler exists). Numbered-sentence layout ('24 An undesirable trait such as loss of
    ...... may be caused') is handled: the number starts the sentence and the blank is its ruler."""
    expected = g.first
    stem_lines = []
    multi_cell_rows = 0
    prev_text = None
    sentence = None   # [number, parts, page] of a numbered sentence awaiting its blank
    items_by_no = {}

    def close_sentence():
        nonlocal sentence
        if sentence is None:
            return True
        n, parts, page = sentence
        txt = clean_text(" ".join(parts))
        sentence = None
        if txt.count(BLANK) != 1:
            log.add("GROUP_STRUCTURE_AMBIGUOUS", scope, f"blank position not unique ({txt.count(BLANK)})", questions=str(n))
            return False
        items_by_no[n] = Item(number=n, prompt=txt[:500], interaction=TEXT_GAP, word_limit=g.word_limit, pages=[page])
        return True

    for r in content:
        toks = [t for t in r.tokens if t.text.strip()]
        if not toks:
            continue
        # numbered sentence start: the expected number leads the row and plain text follows directly
        if expected <= g.last and _num_token(toks[0]) == expected and len(toks) > 1 and toks[1].text != DOTS \
                and toks[1].x0 - toks[0].x1 < 22:
            if not close_sentence():
                return False
            parts = [BLANK if t.text == DOTS else t.text for t in toks[1:]]
            sentence = [expected, parts, r.page]
            stem_lines.append(f"({expected}) " + clean_text(" ".join(parts)))
            expected += 1
            continue
        if sentence is not None and not any(_gap_number(r, i, expected, ocr) for i in range(len(toks))) and \
                not (expected <= g.last and _num_token(toks[0]) == expected):
            parts = [BLANK if t.text == DOTS else t.text for t in toks]
            sentence[1].extend(parts)
            stem_lines[-1] = clean_text(stem_lines[-1] + " " + " ".join(parts))
            continue
        if not close_sentence():
            return False
        parts, found = [], []
        i = 0
        while i < len(toks):
            t = toks[i]
            if expected <= g.last and _gap_number(r, i, expected, ocr):
                found.append(expected)
                # the number's blank is the next ruler within two tokens (e.g. '10 £ ......'), else the number
                j = i + 1
                ruler = None
                while j < len(toks) and j <= i + 2:
                    if toks[j].text == DOTS:
                        ruler = j
                        break
                    j += 1
                if ruler is None:
                    parts.append(f"({expected}) {BLANK}")
                    i += 1
                else:
                    parts.extend(x.text for x in toks[i + 1:ruler])
                    parts.append(f"({expected}) {BLANK}")
                    i = ruler + 1
                expected += 1
                continue
            parts.append(BLANK if t.text == DOTS else t.text)
            i += 1
        gaps_x = [b.x0 - a.x1 for a, b in zip(toks, toks[1:])]
        if sum(1 for x in gaps_x if x > 40) >= 1 and len(toks) > 2:
            multi_cell_rows += 1
        line = clean_text(" ".join(parts)).lstrip("•−–-").strip()
        stem_lines.append(line)
        for n in found:
            local = line.replace(f"({n}) {BLANK}", BLANK)
            words = [w for w in local.replace(BLANK, " ").split() if not re.fullmatch(r"\(\d+\)", w)]
            if len(words) < 3 and prev_text:
                local = (prev_text + " / " + local).strip()
            items_by_no[n] = Item(number=n, prompt=local[:500], interaction=TEXT_GAP, word_limit=g.word_limit,
                                  pages=[r.page])
        if line:
            prev_text = line
    if not close_sentence():
        return False
    if expected <= g.last and multi_cell_rows >= 2 and sentence is None:
        # Phase 5B: a TABLE's cells interleave in y order ('4' one point above '2'), so stream order is not the
        # printed order; bind by the printed number instead when every number is printed exactly once beside
        # its own blank (never by position)
        bound = _table_gaps_by_number(g, content, ocr)
        if bound is not None:
            items_by_no, stem_lines = bound
            expected = g.last + 1
            log.add("GAP_TABLE_BOUND_BY_NUMBER", scope, "table gaps bound by their printed numbers (cells "
                    "interleave in reading order)", questions=f"{g.first}-{g.last}")
    if expected <= g.last:
        log.add("QUESTION_NUMBER_GAP", scope, f"gap markers found up to {expected - 1}", questions=f"{g.first}-{g.last}")
        return False
    g.items.extend(items_by_no[n] for n in sorted(items_by_no))
    g.stem = "\n".join(l for l in stem_lines if l)[:6000]
    if content and multi_cell_rows >= max(2, 0.25 * len(content)):
        g.layout_linearized = True
        log.add("LAYOUT_LINEARIZED", scope, "table layout represented as text rows", questions=f"{g.first}-{g.last}",
                pages=",".join(map(str, g.pages)) if g.pages else None)
    return True


def _table_gaps_by_number(g: QuestionGroup, content: list, ocr: bool) -> Optional[tuple]:
    """(items_by_no, stem_lines) when each question number first..last is printed EXACTLY once directly beside a
    blank ruler; else None. Order-independent: the printed number, not the stream position, names the gap."""
    hits: dict = {}
    for ri, r in enumerate(content):
        toks = r.tokens
        for i, t in enumerate(toks):
            n = _num_token(t)
            if n is None or not (g.first <= n <= g.last):
                continue
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if nxt is not None and nxt.text == DOTS and _gap_number(r, i, n, ocr):
                hits.setdefault(n, []).append((ri, i))
    if sorted(hits) != list(range(g.first, g.last + 1)) or any(len(v) != 1 for v in hits.values()):
        return None
    by_row: dict = {}
    for n, [(ri, i)] in hits.items():
        by_row.setdefault(ri, {})[i] = n
    stem_lines, items, prev_text = [], {}, None
    for ri, r in enumerate(content):
        marks = by_row.get(ri, {})
        parts, i = [], 0
        while i < len(r.tokens):
            t = r.tokens[i]
            if i in marks:
                parts.append(f"({marks[i]}) {BLANK}")
                i += 2                      # the number and its own blank ruler
                continue
            if t.text.strip():
                parts.append(BLANK if t.text == DOTS else t.text)
            i += 1
        line = clean_text(" ".join(parts)).lstrip("•−–-").strip()
        stem_lines.append(line)
        for n in marks.values():
            local = line.replace(f"({n}) {BLANK}", BLANK)
            for m in marks.values():
                local = local.replace(f"({m}) {BLANK}", BLANK)
            words = [w for w in local.replace(BLANK, " ").split() if not re.fullmatch(r"\(\d+\)", w)]
            if len(words) < 3 and prev_text:
                local = (prev_text + " / " + local).strip()
            items[n] = Item(number=n, prompt=local[:500], interaction=TEXT_GAP, word_limit=g.word_limit, pages=[r.page])
        if line:
            prev_text = line
    return items, stem_lines


def _parse_mcq(g: QuestionGroup, content: list, log: DiagnosticLog, scope: str, margin: float,
               announced: Optional[list]) -> bool:
    expected = g.first
    cur: Optional[Item] = None
    cur_opt: Optional[list] = None
    title_rows = []
    for r in content:
        after = _row_starts_with_number(r, expected, margin) if expected <= g.last else None
        if after is not None:
            cur = Item(number=expected, prompt=_join(after), interaction=SINGLE_CHOICE, pages=[r.page])
            cur_opt = None
            g.items.append(cur)
            expected += 1
            continue
        if cur is None:
            title_rows.append(row_text(r))
            continue
        nxt_letter = chr(ord("A") + len(cur.options))
        splits = _letter_splits(r, nxt_letter, strict_gap=False)
        if splits:
            for letter, toks in splits:
                cur.options.append(Option(letter, _join(toks)))
            cur_opt = cur.options[-1]
            continue
        if cur_opt is not None:
            cur_opt.text = clean_text(cur_opt.text + " " + row_text(r))
        else:
            cur.prompt = clean_text(cur.prompt + " " + row_text(r))
    if title_rows:
        g.stem = "\n".join(title_rows)[:500]
    for it in g.items:
        n = len(it.options)
        if n < 3 or (announced and n != len(announced)) or any(not o.text for o in it.options):
            log.add("OPTION_PARSE_FAILED", scope, f"options={n}", questions=str(it.number))
            return False
    return bool(g.items)


def _parse_multi(g: QuestionGroup, pre: list, content: list, log: DiagnosticLog, scope: str, count: Optional[int],
                 announced: Optional[list]) -> bool:
    numbers = g.numbers
    if count and count != len(numbers):
        log.add("GROUP_STRUCTURE_AMBIGUOUS", scope, f"choose {count} vs {len(numbers)} question numbers",
                questions=f"{g.first}-{g.last}")
        return False
    stem_lines, opts = [], []
    cur = None
    for r in pre + content:
        nxt = chr(ord("A") + len(opts))
        splits = _letter_splits(r, nxt, strict_gap=False)
        if splits and (r in content or r.tokens[0].bold):
            for letter, toks in splits:
                opts.append(Option(letter, _join(toks)))
            cur = opts[-1]
            continue
        t = row_text(r)
        if cur is not None:
            cur.text = clean_text(cur.text + " " + t)
        elif t and not re.match(r"^(choose|write|circle|nb\b|you may|in boxes)", t, re.I):
            stem_lines.append(t)
    if len(opts) < len(numbers) + 1 or (announced and len(opts) != len(announced)) or any(not o.text for o in opts):
        log.add("OPTION_PARSE_FAILED", scope, f"multi-select options={len(opts)}", questions=f"{g.first}-{g.last}")
        return False
    stem = clean_text(" ".join(stem_lines)) or None
    if not stem:
        log.add("QUESTION_BLOCK_NOT_FOUND", scope, "multi-select question text missing", questions=f"{g.first}-{g.last}")
        return False
    g.stem = stem
    g.options = opts
    for n in numbers:
        g.items.append(Item(number=n, prompt=stem, interaction=SINGLE_CHOICE, options=list(opts),
                            selection={"count": len(numbers), "questions": numbers}, pages=g.pages))
    log.add("MULTI_SELECT_PAIR", scope, f"choose {len(numbers)}", questions=f"{g.first}-{g.last}")
    return True


def _parse_numbered(g: QuestionGroup, content: list, log: DiagnosticLog, scope: str, margin: float) -> bool:
    expected = g.first
    cur = None
    for r in content:
        after = _row_starts_with_number(r, expected, margin) if expected <= g.last else None
        if after is not None:
            cur = Item(number=expected, prompt=_join(after), interaction=SHORT_ANSWER, word_limit=g.word_limit,
                       pages=[r.page])
            g.items.append(cur)
            expected += 1
            continue
        if cur is not None:
            t = row_text(r)
            if t and len(cur.prompt) < 400:
                cur.prompt = clean_text(cur.prompt + " " + t)
    for it in g.items:
        it.prompt = re.sub(re.escape(BLANK) + r"$", "", it.prompt.replace(DOTS, BLANK)).strip()
    return bool(g.items)


def _parse_headings(g: QuestionGroup, content: list, log: DiagnosticLog, scope: str, margin: float) -> bool:
    heads, expected = [], g.first
    cur_head = None
    in_items = False
    for r in content:
        t = row_text(r)
        if re.match(r"^list of headings", t, re.I):
            continue
        rs = _roman_start(r, len(heads)) if not in_items else None
        if rs is not None:
            cur_head = Option(ROMAN[len(heads)], _join(rs))
            heads.append(cur_head)
            continue
        after = _row_starts_with_number(r, expected, margin) if expected <= g.last else None
        if after is not None:
            in_items = True
            g.items.append(Item(number=expected, prompt=_join(after), interaction=HEADING_MATCHING, pages=[r.page]))
            expected += 1
            continue
        if cur_head is not None and not in_items and t:
            cur_head.text = clean_text(cur_head.text + " " + t)
        elif in_items and g.items and t and len(t) < 40 and not re.match(r"^example", t, re.I):
            continue
    if len(heads) < len(g.items) or not heads or any(not h.text for h in heads):
        log.add("OPTION_PARSE_FAILED", scope, f"headings={len(heads)}", questions=f"{g.first}-{g.last}")
        return False
    g.options = heads
    for it in g.items:
        it.options = list(heads)
    return bool(g.items)


def _parse_matching(g: QuestionGroup, content: list, log: DiagnosticLog, scope: str, margin: float,
                    announced: Optional[list], instr: str, ocr: bool) -> bool:
    """Option list (A..) + numbered items, or a completion text whose gaps are answered with option letters."""
    opts: list = []
    cur_opt = None
    expected = g.first
    cur_item = None
    # gap mode = the first question number sits INSIDE a text line (summary/flow-chart with a word list);
    # a number leading its row is a matching item ('27 Medical terminology ......')
    def _inline_gap(r):
        toks = [t for t in r.tokens if t.text.strip()]
        return any(_gap_number(r, i, g.first, ocr) for i in range(len(r.tokens))) and not (
            toks and _num_token(toks[0]) == g.first)
    # Phase 5B: the printed instructions ('Complete the summary using the list of words, A-J') already say the
    # numbers are gaps of a text answered from a word list, even when a wrapped line starts with '27 ......'
    # (sentence-ending and numbered-sentence tasks are not covered by this rule)
    gap_mode = bool(re.search(r"\bcomplete (the|each) (summary|notes|table|flow-?chart|text)\b", instr, re.I)
                    and re.search(r"\b(list|box)\b", instr, re.I)) or any(_inline_gap(r) for r in content)
    if gap_mode:
        # summary/flow-chart completion using a list of options: the option grid is before or after the text
        # a bold title that merely begins with the word 'A' ('A birthday gift') is not the option grid (Phase 5B)
        grid_idx = [i for i, r in enumerate(content) if _first(r) is not None
                    and _first(r).text.strip().rstrip(".") in ("A", "(A)") and _letter_splits(r, "A", True)
                    and not r.all_bold]
        if not grid_idx:
            text_rows, grid_rows = content, []
        else:
            gi = grid_idx[0]
            before_has_gap = any(_gap_number(r, i, g.first, ocr) for r in content[:gi] for i in range(len(r.tokens)))
            if before_has_gap:
                text_rows, grid_rows = content[:gi], content[gi:]
            else:
                end = gi
                letters = 0
                for j in range(gi, len(content)):
                    sp = _letter_splits(content[j], chr(ord("A") + letters), True)
                    if sp:
                        letters += len(sp)
                        end = j + 1
                    else:
                        break
                grid_rows, text_rows = content[gi:end], content[end:]
        if not _parse_gap(g, text_rows, log, scope, ocr):
            return False
        row_opts: list = []
        for r in grid_rows:
            nxt = chr(ord("A") + len(opts))
            sp = _letter_splits(r, nxt, strict_gap=True)
            if sp:
                row_opts = []
                for (letter, toks), tx in zip(sp, _grid_text_columns(r, sp)):
                    opts.append(Option(letter, _join(toks)))
                    row_opts.append((opts[-1], tx))
                cur_opt = opts[-1]
            elif cur_opt is not None and row_text(r) and not _is_heading_row(r):
                _append_continuation(r, row_opts, cur_opt)
        for it in g.items:
            it.interaction = MATCHING
    else:
        row_opts = []
        for r in content:
            after = _row_starts_with_number(r, expected, margin) if expected <= g.last else None
            if after is not None:
                cur_item = Item(number=expected, prompt=_join(after), interaction=MATCHING, pages=[r.page])
                g.items.append(cur_item)
                expected += 1
                cur_opt = None
                continue
            nxt = chr(ord("A") + len(opts))
            sp = _letter_splits(r, nxt, strict_gap=True)
            if sp and (announced is None or nxt in announced):
                row_opts = []
                for (letter, toks), tx in zip(sp, _grid_text_columns(r, sp)):
                    opts.append(Option(letter, _join(toks)))
                    row_opts.append((opts[-1], tx))
                cur_opt = opts[-1]
                cur_item = None
                continue
            t = row_text(r)
            if cur_opt is not None and t and not _is_heading_row(r):
                _append_continuation(r, row_opts, cur_opt)
            elif cur_item is not None and t and not _is_heading_row(r) and len(cur_item.prompt) < 300:
                cur_item.prompt = clean_text(cur_item.prompt + " " + t)
    if not opts and announced:
        # 'Which paragraph contains ...' / map letters: the option ids are the announced letters
        label = "Paragraph" if re.search(r"paragraph", instr, re.I) else ("Section" if re.search(r"section", instr, re.I) else "")
        opts = [Option(L, f"{label} {L}".strip()) for L in announced]
    if not opts:
        log.add("OPTION_PARSE_FAILED", scope, "no option list", questions=f"{g.first}-{g.last}")
        return False
    if announced and [o.id for o in opts] != announced:
        log.add("OPTION_PARSE_FAILED", scope, f"options={len(opts)} announced={len(announced)}",
                questions=f"{g.first}-{g.last}")
        return False
    if any(not o.text for o in opts):
        log.add("OPTION_PARSE_FAILED", scope, "empty option text", questions=f"{g.first}-{g.last}")
        return False
    g.options = opts
    for it in g.items:
        it.options = list(opts)
        if g.kind == GK_LABEL:
            it.interaction = LABEL_ASSIGNMENT
    return bool(g.items)
