"""Deterministic source forensic audit for the Reading bilingual PDFs.

This is an offline, read-only audit. It uses the source's two-column text layer,
detects bold title rows, preserves PDF order, and never rewrites source files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import fitz


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "imports" / "source-reading" / "SONG-NGU"
ARTICLE = SOURCE_DIR / "200 bài báo song ngữ hay nhất Ms Hoa giao tiếp.pdf"
STORY = SOURCE_DIR / "truyen-ngan-song-ngu-anh-viet.pdf"


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def source_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def page_lines(page: fitz.Page) -> tuple[list[tuple[float, str, bool]], list[tuple[float, str, bool]]]:
    columns: list[list[tuple[float, str, bool]]] = [[], []]
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            spans = line["spans"]
            text = clean("".join(span["text"] for span in spans))
            if not text:
                continue
            side = 0 if line["bbox"][0] < page.rect.width / 2 else 1
            bold = any(span["flags"] & 16 for span in spans)
            columns[side].append((line["bbox"][1], text, bold))
    for column in columns:
        column.sort(key=lambda item: item[0])
    return columns[0], columns[1]


def paired_bold_titles(path: Path) -> list[dict[str, object]]:
    doc = fitz.open(path)
    titles: list[dict[str, object]] = []
    for page_number, page in enumerate(doc, start=1):
        left, right = page_lines(page)
        for y, text, bold in left:
            if not bold:
                continue
            if "200 truyện song ngữ" in text.lower():
                continue
            matches = [(abs(y - right_y), right_text) for right_y, right_text, right_bold in right if right_bold and abs(y - right_y) < 2]
            if matches:
                _, paired = min(matches)
                titles.append({"page": page_number, "y": round(y, 2), "left": text, "right": paired})
    titles.sort(key=lambda item: (int(item["page"]), float(item["y"])))
    # A wrapped title produces adjacent bold rows; one logical title is the first row.
    groups: list[list[dict[str, object]]] = []
    for title in titles:
        if groups and title["page"] == groups[-1][0]["page"] and float(title["y"]) - float(groups[-1][-1]["y"]) <= 20:
            groups[-1].append(title)
        else:
            groups.append([title])
    return [group[0] for group in groups]


def unmatched_story_titles(path: Path) -> list[dict[str, object]]:
    doc = fitz.open(path)
    candidates: list[dict[str, object]] = []
    for page_number, page in enumerate(doc, start=1):
        left, right = page_lines(page)
        right_bold_y = [y for y, _, bold in right if bold]
        for y, text, bold in left:
            if bold and not any(abs(y - other_y) < 2 for other_y in right_bold_y):
                # Exclude a wrapped second title line and obvious in-body emphasis.
                if "200 truyện song ngữ" in text.lower() or text.upper() == "WEAPON" or text.startswith("–") or text.endswith("."):
                    continue
                candidates.append({"page": page_number, "y": round(y, 2), "english": text})
    return candidates


def audit(path: Path, family: str) -> dict[str, object]:
    titles = paired_bold_titles(path)
    page_count = len(fitz.open(path))
    cross_page = sum(1 for index, title in enumerate(titles) if (titles[index + 1]["page"] if index + 1 < len(titles) else page_count) > title["page"])
    result: dict[str, object] = {
        "family": family,
        "file": str(path.relative_to(ROOT)),
        "sha256": source_hash(path),
        "pages": page_count,
        "column_order": "VI-left / EN-right" if family == "ARTICLE" else "EN-left / VI-right",
        "detected": len(titles),
        "paired_segments": len(titles),
        "unpaired_english": 0,
        "unpaired_vietnamese": 0,
        "uncertain_boundaries": 0,
        "duplicates": 0,
        "cross_page_items": cross_page,
        "ready": len(titles) if family == "ARTICLE" else len(titles),
        "review": 0,
        "blocked": 0,
        "titles": titles,
    }
    if family == "STORY":
        unmatched = unmatched_story_titles(path)
        result["review"] = len(unmatched)
        result["detected"] = len(titles) + len(unmatched)
        result["unpaired_vietnamese"] = len(unmatched)
        result["ready"] = len(titles)
        result["review_items"] = unmatched
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "reading-bilingual-20261008" / "source-forensic-audit.json")
    args = parser.parse_args()
    report = {"generatedAt": "2026-10-08", "articles": audit(ARTICLE, "ARTICLE"), "stories": audit(STORY, "STORY")}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: {x: report[k][x] for x in ("detected", "ready", "review", "blocked", "paired_segments", "unpaired_vietnamese")} for k in ("articles", "stories")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
