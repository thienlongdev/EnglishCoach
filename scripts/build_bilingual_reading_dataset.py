"""Build the deterministic bilingual Reading manifest from the audited PDFs."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import fitz

from reading_bilingual_forensics import ARTICLE, ROOT, STORY, clean, page_lines, paired_bold_titles, unmatched_story_titles, source_hash


def all_lines(path: Path) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    doc = fitz.open(path)
    columns = [[], []]
    for page_number, page in enumerate(doc, start=1):
        left, right = page_lines(page)
        for side, lines in enumerate((left, right)):
            for y, text, bold in lines:
                columns[side].append({"page": page_number, "y": y, "text": text, "bold": bold})
    return columns[0], columns[1]


def title_groups(path: Path, family: str) -> list[dict[str, object]]:
    left, right = all_lines(path)
    paired = paired_bold_titles(path)
    starts: list[dict[str, object]] = []
    # Rebuild grouped paired titles, preserving wrapped title lines.
    for title in paired:
        page, y = int(title["page"]), float(title["y"])
        left_rows = [row for row in left if row["page"] == page and abs(float(row["y"]) - y) <= 20 and row["bold"]]
        right_rows = [row for row in right if row["page"] == page and y - 1 <= float(row["y"]) <= y + 20 and row["bold"]]
        left_rows.sort(key=lambda row: float(row["y"]))
        right_rows.sort(key=lambda row: float(row["y"]))
        starts.append({
            "page": page,
            "y": y,
            "title_end_y": max([float(row["y"]) for row in left_rows + right_rows] or [y]),
            "title_left": " ".join(str(row["text"]) for row in left_rows),
            "title_right": " ".join(str(row["text"]) for row in right_rows),
            "title_vi_missing": False,
        })
    if family == "STORY":
        for item in unmatched_story_titles(path):
            starts.append({"page": int(item["page"]), "y": float(item["y"]), "title_end_y": float(item["y"]), "title_left": str(item["english"]), "title_right": None, "title_vi_missing": True})
    starts.sort(key=lambda item: (int(item["page"]), float(item["y"])))
    return starts


def normalize_body(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace("200 bài báo song ngữ hay nhất - Nguồn CEP, chia sẻ lại bởi ielts-fighter.com", "")
    text = text.replace("200 truyện song ngữ Anh – Việt", "")
    return re.sub(r"\s+", " ", text).strip()


def extract_items(path: Path, family: str) -> list[dict[str, object]]:
    left, right = all_lines(path)
    starts = title_groups(path, family)
    page_count = len(fitz.open(path))
    result: list[dict[str, object]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else {"page": page_count + 1, "y": 0}
        start_key = (int(start["page"]), float(start["title_end_y"]))
        end_key = (int(end["page"]), float(end["y"]) - 1.0)

        def rows_by_page(column: list[dict[str, object]]) -> dict[int, str]:
            grouped: dict[int, list[str]] = {}
            for row in column:
                key = (int(row["page"]), float(row["y"]))
                if key <= start_key or key >= end_key:
                    continue
                text = normalize_body(str(row["text"]))
                if text:
                    grouped.setdefault(int(row["page"]), []).append(text)
            return {page: normalize_body(" ".join(rows)) for page, rows in grouped.items()}

        left_pages, right_pages = rows_by_page(left), rows_by_page(right)
        if family == "ARTICLE":
            # A few source pages are printed in the opposite order.  Resolve the
            # orientation from the audited page evidence instead of assuming the
            # family-wide layout.
            reversed_page = int(start["page"]) in {8, 11}
            vi_pages, en_pages = (right_pages, left_pages) if reversed_page else (left_pages, right_pages)
            title_vi, title_en = ((str(start["title_right"]), str(start["title_left"])) if reversed_page else (str(start["title_left"]), str(start["title_right"])))
        else:
            reversed_page = int(start["page"]) in {41}
            en_pages, vi_pages = (right_pages, left_pages) if reversed_page else (left_pages, right_pages)
            title_en, title_vi = ((str(start["title_right"]), str(start["title_left"])) if reversed_page else (str(start["title_left"]), (None if start["title_vi_missing"] else str(start["title_right"]))))
        pages = sorted(set(en_pages) | set(vi_pages))
        segment_pages = [(page, en_pages.get(page, ""), vi_pages.get(page, "")) for page in pages]
        segment_pages = [(page, en, vi) for page, en, vi in segment_pages if len(en) >= 40 and len(vi) >= 40]
        en = normalize_body(" ".join(en for _, en, _ in segment_pages))
        vi = normalize_body(" ".join(vi for _, _, vi in segment_pages))
        # The source body is accepted only when both language sides contain text.
        ready = len(en) >= 80 and len(vi) >= 80
        if not ready:
            continue
        # Source identity is part of the logical key.  The corpus contains two
        # legitimate story entries with identical title/body text at different
        # source pages; body-only fingerprints would silently merge them.
        identity = "\0".join((family, path.name, str(start["page"]), str(end["page"] - 1), str(start["y"])))
        fingerprint = hashlib.sha256((identity + "\0" + title_en + "\0" + (title_vi or "") + "\0" + en + "\0" + vi).encode("utf-8")).hexdigest()
        result.append({
            "contentType": family,
            "sourceFile": path.name,
            "sourceHash": source_hash(path),
            "logicalPosition": len(result) + 1,
            "titleEn": title_en,
            "titleVi": title_vi,
            "level": None,
            "wordCount": len(en.split()),
            "estimatedMinutes": max(1, round(len(en.split()) / 200)),
            "itemFingerprint": fingerprint,
            "sourceReference": f"pages {start['page']}-{max(start['page'], int(end['page']) - 1)}",
            "segments": [{"position": i, "en": page_en, "vi": page_vi, "sourceReference": f"page {page}"} for i, (page, page_en, page_vi) in enumerate(segment_pages, 1)],
        })
    return result


def main() -> None:
    articles = extract_items(ARTICLE, "ARTICLE")
    stories = extract_items(STORY, "STORY")
    corpus = articles + stories
    manifest = {
        "schemaVersion": "bilingual-reading.v1",
        "sourceFiles": [{"path": str(ARTICLE.relative_to(ROOT)), "sha256": source_hash(ARTICLE)}, {"path": str(STORY.relative_to(ROOT)), "sha256": source_hash(STORY)}],
        "articlesDetected": 112,
        "storiesDetected": 82,
        "articlesReady": len(articles),
        "storiesBodyValid": len(stories),
        "items": corpus,
    }
    output = ROOT / "backend" / "src" / "main" / "resources" / "data" / "reading" / "bilingual-corpus.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"articles": len(articles), "stories": len(stories), "total": len(corpus), "bytes": output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
