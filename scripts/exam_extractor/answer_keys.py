"""Answer-key extraction, syntax validation by question type, and alignment with the extracted items.

The old pipeline accepted blank keys, page debris and arbitrary tokens. Here a key is only bound when:
  * it was read from an answer-key region of the same test and section;
  * its question number exists in the extracted structure (no off-by-one, no extra, no duplicate);
  * its syntax matches the item's interaction (option id / TFNG / YNNG / heading numeral / text variant);
  * it is not page furniture (score bands, headers, explanations).
Anything else is a diagnostic; a missing key is never written as "".
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from .diagnostics import DiagnosticLog, CONFIDENT, PROBABLE
from .model import (AnswerKey, GK_GAP, GK_HEADINGS, GK_LABEL, GK_MATCHING, GK_MULTI_SELECT, GK_SHORT_ANSWER,
                    GK_SINGLE_CHOICE, GK_TFNG, GK_YNNG)
from .pdf_layer import DOTS, Row, clean_text

ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"]
TFNG_VALUES = {"TRUE", "FALSE", "NOT GIVEN"}
YNNG_VALUES = {"YES", "NO", "NOT GIVEN"}

# Page furniture that must never be read as an answer.
_GARBAGE = re.compile(r"(if you score|you are (un)?likely|acceptable score|examination conditions|answer key|"
                      r"resource bank|questions? \d|part \d|passage \d|listening|reading|photocopiable|"
                      r"explanations?|\bp\.\s*\d|www\.|http|©)", re.I)
_ENTRY_START = re.compile(r"^(\d{1,3})(?:\s*(?:&|and|,)\s*(\d{1,3}))?(?:\s*(?:&|and|,)\s*(\d{1,3}))?[.):]?$")
_EITHER = re.compile(r"in\s+either\s+order|either\s+way\s+round|any\s+order|in\s+any\s+order", re.I)


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


def _expand_optional(text: str) -> list:
    """'(the) harbour' -> ['the harbour', 'harbour']; 'metal(s)' -> ['metals', 'metal']."""
    m = re.search(r"\(([^()]{1,30})\)", text)
    if not m:
        return [re.sub(r"\s+", " ", text).strip()]
    before, inner, after = text[:m.start()], m.group(1), text[m.end():]
    with_part = _expand_optional(before + inner + after)
    without = _expand_optional((before.rstrip() + " " + after.lstrip()).strip() if before.endswith(" ") or after.startswith(" ") else before + after)
    out = []
    for v in with_part + without:
        v = re.sub(r"\s+", " ", v).strip(" ,;")
        if v and v not in out:
            out.append(v)
    return out


def expand_variants(raw: str) -> list:
    """Cambridge key syntax: '35 / thirty five', '(the) harbour', 'metal(s)', 'x OR y'."""
    out = []
    for _printed, expansions in expand_alternatives(raw):
        for v in expansions:
            if v and v not in out:
                out.append(v)
    return out


def expand_alternatives(raw: str) -> list:
    """[(printed alternative, its optional-word expansions)] — the printed '/' / OR alternatives kept apart, so a
    combination produced only by expanding '(...)' can be told from an alternative the key actually prints."""
    raw = clean_text(raw)
    raw = re.sub(r"\s*\[?\bOR\b\]?\s*", " / ", raw)
    parts = [p.strip() for p in re.split(r"\s*/\s*", raw) if p.strip()]
    return [(p, _expand_optional(p)) for p in parts]


# Examiner annotations printed inside a key entry (Phase 4.1C). They are instructions, never answer text:
#   '(do not accept 'lonely')'  -> 'lonely' is a REJECTED answer;   '(must have capitals)' -> capitals required.
_REJECT_NOTE = re.compile(r"\(\s*(?:do\s+not|don'?t)\s+accept\s+([^()]{1,40})\)", re.I)
_CAPITALS_NOTE = re.compile(r"\(\s*(?:must\s+(?:have|use|be\s+in|be\s+written\s+(?:in|with))|needs?)\s+"
                            r"capital(?:s|\s+letters?)?\s*\)", re.I)


def split_annotations(raw: str) -> tuple:
    """(answer text without annotations, rejected answers, flags). Deterministic: only the two printed forms above."""
    rejected, flags = [], set()
    for m in _REJECT_NOTE.finditer(raw):
        for v in re.split(r"\s*(?:/|,|\bor\b)\s*", m.group(1)):
            v = re.sub(r"^[^\w]+|[^\w]+$", "", v).strip()
            if v and v not in rejected:
                rejected.append(v)
    text = _REJECT_NOTE.sub(" ", raw)
    if _CAPITALS_NOTE.search(text):
        flags.add("CAPITALS_REQUIRED")
        text = _CAPITALS_NOTE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip(), rejected, flags


# ─── scorer-equivalent word count (mirror of ExamAnswerNormalizer#countWords, Phase 4 + 4.1) ────────────────
_SCORER_NUMBER_WORDS = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
                        "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
                        "hundred", "thousand", "million", "billion", "half", "quarter"}
MONTHS = {"january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"}


def _strip_edges(tok: str) -> str:
    return re.sub(r"^[^\w]+|[^\w]+$", "", tok)


def _scorer_number_word(tok: str) -> bool:
    t = _strip_edges(tok).lower()
    if not t:
        return False
    if re.fullmatch(r"\d+(st|nd|rd|th)", t):
        return True
    return all(p in _SCORER_NUMBER_WORDS for p in t.split("-"))


def _day(tok: str) -> bool:
    t = _strip_edges(tok).lower()
    m = re.fullmatch(r"(\d{1,2})(st|nd|rd|th)?", t)
    return bool(m) and 1 <= int(m.group(1)) <= 31


def date_token_indexes(tokens: list) -> set:
    """Indexes of tokens forming a calendar date ('(the) 13(th) (of) January', 'January (the) 13(th)').
    Under '... AND/OR A NUMBER' the whole date is the number (Phase 4.1C: the official keys print '(the)' / '(of)'
    as accepted parts of a date answer, which a strict word count could never admit)."""
    low = [_strip_edges(t).lower() for t in tokens]
    out: set = set()
    for i, t in enumerate(low):
        if t not in MONTHS:
            continue
        span = None
        j = i - 1
        if j >= 0 and low[j] == "of":
            j -= 1
        if j >= 0 and _day(tokens[j]):
            k = j - 1 if j - 1 >= 0 and low[j - 1] == "the" else j
            span = range(k, i + 1)
        else:
            j = i + 1
            if j < len(low) and low[j] == "the":
                j += 1
            if j < len(low) and _day(tokens[j]):
                span = range(i, j + 1)
        if span is not None:
            out.update(span)
    return out


def scorer_word_count(text: str, numbers_exempt: bool) -> int:
    """Exactly the server rule: whitespace tokens with a letter or digit; hyphenated = 1; under 'AND/OR A NUMBER'
    figures, number words, ordinals and a whole calendar date are the number."""
    tokens = [t for t in unicodedata.normalize("NFC", text or "").split() if re.search(r"[^\W_]", t)]
    dates = date_token_indexes(tokens) if numbers_exempt else set()
    words = 0
    for i, t in enumerate(tokens):
        if numbers_exempt:
            if i in dates or not re.search(r"[^\W\d_]", t) or _scorer_number_word(t):
                continue
            if (_strip_edges(t).lower() == "and" and 0 < i < len(tokens) - 1
                    and _scorer_number_word(tokens[i - 1]) and _scorer_number_word(tokens[i + 1])):
                continue
        words += 1
    return words


_SEPARATOR_GLYPHS = ("I", "1", "l", "|")


def _number_value(s: str):
    """Integer value of '250' / 'two hundred and fifty' / 'forty-eight'; None when not a plain cardinal."""
    s = s.strip().lower()
    if re.fullmatch(r"\d{1,9}", s):
        return int(s)
    units = {w: i for i, w in enumerate(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
                                          "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
                                          "sixteen", "seventeen", "eighteen", "nineteen"])}
    tens = {w: 10 * i for i, w in enumerate(["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
                                              "eighty", "ninety"]) if w}
    total, current, seen = 0, 0, False
    for w in [x for x in re.split(r"[\s\-]+", s) if x and x != "and"]:
        if w in units:
            current += units[w]
        elif w in tens:
            current += tens[w]
        elif w == "hundred":
            current = (current or 1) * 100
        elif w == "thousand":
            total += (current or 1) * 1000
            current = 0
        else:
            return None
        seen = True
    return total + current if seen else None


def separator_repair(variant: str, word_limit: Optional[int], numbers_exempt: bool):
    """A key whose variant separator '/' was printed / read as a lone 'I', '1', 'l' or '|'. Returns
    (pieces, method) when exactly one reading exists, else None:
      SAME_WORD_SPELLING  every piece folds to the same word ('cafe I café');
      NUMERIC_FORMS       every piece denotes the SAME number ('250 I two hundred and fifty');
      WORD_LIMIT_FORCED   the joined text breaks the item's printed word limit while every piece fits it and is a
                          word ('movie 1 film' under ONE WORD) — the printed rule admits no other reading."""
    for glyph in _SEPARATOR_GLYPHS:
        pieces = [p.strip() for p in re.split(r"\s" + re.escape(glyph) + r"\s", f" {variant} ")]
        pieces = [p for p in pieces if p]
        if len(pieces) < 2 or f" {glyph} " not in f" {variant} ":
            continue
        if len({fold(p) for p in pieces}) == 1:
            return pieces, "SAME_WORD_SPELLING", glyph
        values = [_number_value(p) for p in pieces]
        if all(v is not None for v in values) and len(set(values)) == 1:
            return pieces, "NUMERIC_FORMS", glyph
        if (word_limit and scorer_word_count(variant, numbers_exempt) > word_limit
                and all(re.search(r"[^\W\d_]{2,}", p) for p in pieces)
                and all(scorer_word_count(p, numbers_exempt) <= word_limit for p in pieces)):
            return pieces, "WORD_LIMIT_FORCED", glyph
        if glyph == "I" and all(_numberish(p) for p in pieces):
            # Phase 3.6 rule kept unchanged ('3.30 I half past three'): repaired, but NOT provable unless the
            # pieces denote the same number — the QA entry stays open for a human
            return pieces, "NUMERIC_NOTATIONS", glyph
    return None


def _is_letter(tok: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]", tok))


class KeyEntry:
    def __init__(self, numbers: list, page: int):
        self.numbers = numbers
        self.page = page
        self.tokens: list = []
        self.either = False


def parse_key_rows(rows: list, first: int, last: int, log: DiagnosticLog, scope: str) -> dict:
    """Sequential parser over answer-key rows of ONE test section (questions first..last).

    An entry starts with a number token equal to the next expected question number (or an 'a&b' pair);
    everything until the next entry start is its answer. Using the expected sequence (not any number) avoids
    reading numeric answers ("25") as entry numbers.
    """
    # Flatten to (text, page) tokens; glue '15', '&', '16' / '15&', '16' / '21 &22' into one '15&16' token.
    flat: list = []
    for row in rows:
        for t in row.tokens:
            if not t.text or t.text == DOTS:
                continue
            s = t.text.strip()
            # '21822 IN EITHER ORDER': the printed '&' read as '8' -> '21&22' ONLY when the digits split uniquely
            # into two consecutive question numbers and the row itself says IN EITHER ORDER (Phase 3.6)
            m8 = re.fullmatch(r"(\d{1,2})8(\d{1,2})", s)
            if m8 and int(m8.group(2)) == int(m8.group(1)) + 1 and _EITHER.search(row.text):
                log.add("ANSWER_KEY_OCR_REPAIRED", scope, "'&' read as '8' in an either-order pair",
                        questions=f"{m8.group(1)}&{m8.group(2)}", pages=str(row.page))
                s = f"{m8.group(1)}&{m8.group(2)}"
            if flat and flat[-1][1] == row.page and (
                    (re.fullmatch(r"&|and", s, re.I) and re.fullmatch(r"\d{1,3}", flat[-1][0]))
                    or (re.fullmatch(r"&?\d{1,3}", s) and re.fullmatch(r"\d{1,3}(&|and)", flat[-1][0], re.I))
                    or (re.fullmatch(r"&\d{1,3}", s) and re.fullmatch(r"\d{1,3}", flat[-1][0]))):
                flat[-1] = (flat[-1][0] + s, row.page)
                continue
            flat.append((s, row.page))
    entries: list = []
    expected = first
    current: Optional[KeyEntry] = None
    for s, page in flat:
        m = _ENTRY_START.match(s.replace(" ", "").replace("and", "&"))
        nums = [int(g) for g in m.groups() if g] if m else []
        is_start = (bool(nums) and nums[0] == expected and nums[-1] <= last
                    and all(n == nums[0] + k for k, n in enumerate(nums))
                    # a numeric ANSWER equal to the next number cannot start an entry before its own answer exists
                    and (current is None or bool(current.tokens)))
        if is_start:
            current = KeyEntry(nums, page)
            entries.append(current)
            expected = nums[-1] + 1
            continue
        if current is not None:
            current.tokens.append(s)
    keys: dict = {}
    for e in entries:
        text = clean_text(" ".join(e.tokens))
        if _EITHER.search(text):
            e.either = True
            text = _EITHER.sub(" ", text).strip()
        if len(e.numbers) > 1:
            letters = [tok for tok in re.split(r"[\s,]+", text) if tok]
            letters = [x for x in letters if _is_letter(x) or x.lower() in ROMAN]
            if len(letters) != len(e.numbers):
                log.add("ANSWER_KEY_SYNTAX_INVALID", scope, "multi-number entry letter count",
                        questions=f"{e.numbers[0]}-{e.numbers[-1]}", pages=str(e.page))
                continue
            for n in e.numbers:
                keys[n] = AnswerKey(n, list(letters), len(letters), CONFIDENT, list(e.numbers), e.page)
            continue
        if not text:
            log.add("ANSWER_KEY_MISSING_ITEM", scope, "empty entry", questions=str(e.numbers[0]), pages=str(e.page))
            continue
        keys[e.numbers[0]] = AnswerKey(e.numbers[0], [text], len(e.tokens), CONFIDENT, None, e.page)
    found = sorted(keys)
    missing = [n for n in range(first, last + 1) if n not in keys]
    if missing:
        log.add("ANSWER_KEY_MISSING_ITEM", scope, f"missing={len(missing)}", questions=_compact(missing))
    return keys


def _compact(nums: list) -> str:
    nums = sorted(nums)
    out, s, p = [], nums[0], nums[0]
    for n in nums[1:]:
        if n == p + 1:
            p = n
            continue
        out.append(f"{s}-{p}" if p != s else str(s))
        s = p = n
    out.append(f"{s}-{p}" if p != s else str(s))
    return ",".join(out)[:120]


_NUMBER_WORDS = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
                 "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
                 "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred",
                 "thousand", "million", "and", "point", "half", "quarter", "past", "o'clock", "pounds", "dollars",
                 "pence", "cents", "per", "cent", "percent", "a"}


def _numberish(s: str) -> bool:
    s = s.strip().lower()
    if re.fullmatch(r"[(]?[£$€]?\d[\d.,:/]*(%|st|nd|rd|th|am|pm|a\.m\.|p\.m\.)?[)]?", s):
        return True
    words = [w for w in re.split(r"[\s\-]+", s) if w]
    return bool(words) and all(w in _NUMBER_WORDS for w in words)


def _word_count(v: str, allow_number: bool) -> int:
    words = [w for w in re.split(r"[\s\-]+", v) if w]
    if allow_number:
        words = [w for w in words if not re.fullmatch(r"[£$€]?\d[\d.,:]*(%|am|pm|a\.m\.|p\.m\.)?", w, re.I)]
    return len(words)


def resolve_key(kind: str, raw: AnswerKey, option_ids: list, word_limit: Optional[int], allow_number: bool,
                log: DiagnosticLog, scope: str) -> Optional[list]:
    """Validate and normalise one raw key for an item of the given group kind. Returns accepted values or None."""
    values = []
    rawtext = " / ".join(raw.values)
    if _GARBAGE.search(rawtext) or len(rawtext) > 80:
        log.add("ANSWER_KEY_GARBAGE_REJECTED", scope, "page furniture or over-long key", questions=str(raw.number))
        return None
    if kind in (GK_SINGLE_CHOICE, GK_MULTI_SELECT, GK_MATCHING, GK_LABEL):
        ids = {o.upper() for o in option_ids}
        for v in raw.values:
            toks = [x for x in re.split(r"[\s/,]+", v) if x]
            if not toks or any(not _is_letter(x) or x not in ids for x in toks):
                log.add("ANSWER_KEY_TYPE_MISMATCH", scope, f"{kind} key not an option id", questions=str(raw.number))
                return None
            values.extend(toks)
        return sorted(set(values), key=values.index)
    if kind == GK_HEADINGS:
        ids = {o.lower() for o in option_ids}
        for v in raw.values:
            x = v.strip().lower().rstrip(".")
            if x not in ids:
                log.add("ANSWER_KEY_TYPE_MISMATCH", scope, "heading key not a listed numeral", questions=str(raw.number))
                return None
            values.append(x)
        return values
    if kind in (GK_TFNG, GK_YNNG):
        allowed = TFNG_VALUES if kind == GK_TFNG else YNNG_VALUES
        v = re.sub(r"\s+", " ", " ".join(raw.values).upper()).strip()
        if v == "NOTGIVEN":  # OCR dropped the space; no other reading exists
            v = "NOT GIVEN"
            log.add("ANSWER_KEY_OCR_REPAIRED", scope, "NOTGIVEN", questions=str(raw.number))
        if v not in allowed:
            log.add("ANSWER_KEY_TYPE_MISMATCH", scope, f"{kind} key outside allowed values", questions=str(raw.number))
            return None
        return [v]
    if kind in (GK_GAP, GK_SHORT_ANSWER):
        variants = []
        for v in raw.values:
            text, rejected, flags = split_annotations(v)
            if rejected or flags:
                # printed examiner notes are never answers (Phase 4.1C); kept as structured key metadata
                raw.rejected = sorted(set(getattr(raw, "rejected", None) or []) | set(rejected))
                raw.flags = sorted(set(getattr(raw, "flags", None) or []) | flags)
                log.add("ANSWER_KEY_ANNOTATION", scope, "examiner note separated from the answer"
                        + (" (rejected answer)" if rejected else "") + (" (capitals required)" if flags else ""),
                        questions=str(raw.number), severity="INFO")
            for printed, expansions in expand_alternatives(text):
                # Phase 4.1C: '(meeting) deadlines (for essays)' under NO MORE THAN THREE WORDS prints optional
                # words; the combination of ALL of them is produced only by our expansion and breaks the printed
                # rule, so it is not an accepted answer. A printed alternative itself is never dropped.
                if word_limit and len(expansions) > 1:
                    within = [x for x in expansions if scorer_word_count(x, allow_number) <= word_limit]
                    if within and len(within) < len(expansions):
                        log.add("ANSWER_KEY_OPTIONAL_EXPANSION_LIMITED", scope,
                                f"{len(expansions) - len(within)} optional-word combination(s) over the printed limit",
                                questions=str(raw.number), severity="INFO")
                        expansions = within
                for x in expansions:
                    if x not in variants:
                        variants.append(x)
        # The variant separator '/' printed / OCR'd as a lone 'I', '1', 'l' or '|'. Repaired ONLY when exactly one
        # reading exists (see separator_repair); the method is recorded so the QA proof can re-check it.
        repaired = []
        for x in variants:
            rep = separator_repair(x, word_limit, allow_number)
            if rep:
                pieces, method, glyph = rep
                repaired.extend(pieces)
                log.add("ANSWER_KEY_OCR_REPAIRED", scope, f"variant separator ({method}; glyph '{glyph}')",
                        questions=str(raw.number))
            else:
                repaired.append(x)
        variants = [v for i, v in enumerate(repaired) if v and v not in repaired[:i]]
        if not variants:
            log.add("ANSWER_KEY_SYNTAX_INVALID", scope, "no text variant", questions=str(raw.number))
            return None
        if word_limit:
            within = [v for v in variants if _word_count(v, allow_number) <= word_limit]
            if not within:
                log.add("ANSWER_KEY_WORD_LIMIT_CONFLICT", scope, f"all variants exceed {word_limit} word(s)",
                        questions=str(raw.number))
        return variants
    log.add("ANSWER_KEY_TYPE_MISMATCH", scope, f"unsupported kind {kind}", questions=str(raw.number))
    return None
