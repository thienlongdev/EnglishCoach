"""Bounded English document extraction; geometry never leaves source coordinates."""
from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
from statistics import median
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    import fitz
except ImportError:
    fitz = None
try:
    import easyocr
except ImportError:
    easyocr = None

from app.domain.schemas.canonical_document import _bbox, make_block, make_document, make_page

MAX_PDF_PAGES = min(50, max(1, int(os.getenv("OCR_MAX_PDF_PAGES", "30"))))
MAX_SCANNED_PAGES = min(MAX_PDF_PAGES, max(1, int(os.getenv("OCR_MAX_SCANNED_PAGES", "15"))))
OCR_DPI = min(200, max(72, int(os.getenv("OCR_DPI", "150"))))
OCR_MAX_IMAGE_DIM = min(3000, max(800, int(os.getenv("OCR_MAX_IMAGE_DIM", "2400"))))
OCR_MIN_NATIVE_WORDS = int(os.getenv("OCR_MIN_NATIVE_WORDS", "3"))
OCR_MIN_NATIVE_CHARS = int(os.getenv("OCR_MIN_NATIVE_CHARS", "15"))
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_CANONICAL_BYTES = 12 * 1024 * 1024
READER = None


def _reader():
    global READER
    if READER is None:
        if easyocr is None:
            raise RuntimeError("EasyOCR is unavailable.")
        READER = easyocr.Reader(["en"], gpu=os.getenv("OCR_GPU", "true").lower() != "false")
    return READER


def has_meaningful_native_text(text: str) -> bool:
    words = [word for word in (text or "").split() if any(char.isalnum() for char in word)]
    return len(words) >= OCR_MIN_NATIVE_WORDS and sum(char.isalnum() for char in text or "") >= OCR_MIN_NATIVE_CHARS


def _ordered_blocks(blocks, page_width):
    """Use recursive whitespace cuts so columns are never globally y/x interleaved."""
    blocks = list(blocks)
    if len(blocks) < 2:
        return blocks
    by_x = sorted(blocks, key=lambda b: b["bbox"]["x"])
    right = by_x[0]["bbox"]["x"] + by_x[0]["bbox"]["width"]
    gaps = []
    for index, block in enumerate(by_x[1:], 1):
        if block["bbox"]["x"] - right > page_width * .035:
            gaps.append((block["bbox"]["x"] - right, index))
        right = max(right, block["bbox"]["x"] + block["bbox"]["width"])
    if gaps:
        _, index = max(gaps)
        left = _ordered_blocks(by_x[:index], page_width)
        right = _ordered_blocks(by_x[index:], page_width)
        for block in left:
            block.setdefault("column", 0)
        for block in right:
            block.setdefault("column", 1)
        return left + right
    # Separate full-width furniture from the column region before reading it.
    spanning = [block for block in blocks if block["bbox"]["width"] >= page_width * .65]
    for boundary in spanning:
        top = boundary["bbox"]["y"]
        bottom = top + boundary["bbox"]["height"]
        before = [block for block in blocks if block is not boundary and block["bbox"]["y"] + block["bbox"]["height"] <= top]
        after = [block for block in blocks if block is not boundary and block["bbox"]["y"] >= bottom]
        if len(before) + len(after) == len(blocks) - 1:
            return _ordered_blocks(before, page_width) + [boundary] + _ordered_blocks(after, page_width)
    return sorted(blocks, key=lambda b: (b["bbox"]["y"], b["bbox"]["x"]))


def _finish_page(number, width, height, blocks):
    ordered = _ordered_blocks(blocks, width)
    for index, block in enumerate(ordered):
        block["readingOrder"] = index
    return make_page(number, width, height, ordered), "\n\n".join(b["text"] for b in ordered)


def _table(block_id, rows, bounds, width, height):
    text = "\n".join("\t".join(cell["text"] for cell in row["cells"]) for row in rows)
    block = make_block(block_id=block_id, block_type="table", text=text,
                       bbox=_bbox(*bounds, width, height), reading_order=0)
    block["rows"] = rows
    return block


def _native_page(page, number):
    width, height = float(page.rect.width), float(page.rect.height)
    raw = page.get_text("dict")
    sizes = [span.get("size", 12) for block in raw.get("blocks", []) if block.get("type") == 0
             for line in block.get("lines", []) for span in line.get("spans", [])]
    typical_size = median(sizes) if sizes else 12
    blocks = []
    table_bounds = []
    try:
        finder = page.find_tables()
        for table_index, table in enumerate(finder.tables):
            values = table.extract()
            rows = []
            for row_index, row in enumerate(values or []):
                cells = []
                for column, value in enumerate(row):
                    cell_box = table.rows[row_index].cells[column] if row_index < len(table.rows) else table.bbox
                    cell_box = cell_box or table.bbox
                    cells.append({"column": column, "text": value or "", "bbox": _bbox(*cell_box, width, height)})
                rows.append({"index": row_index, "cells": cells})
            if rows:
                bounds = tuple(table.bbox)
                blocks.append(_table(f"p{number}-table{table_index}", rows, bounds, width, height))
                table_bounds.append(bounds)
    except Exception:
        # Table recognition is optional; ordinary native text remains usable.
        blocks = []
        table_bounds = []
    for index, raw_block in enumerate(raw.get("blocks", [])):
        if raw_block.get("type") != 0:
            continue
        rb = raw_block.get("bbox", [0, 0, 0, 0])
        if any(rb[0] >= bound[0] and rb[1] >= bound[1] and rb[2] <= bound[2] and rb[3] <= bound[3]
               for bound in table_bounds):
            continue
        lines = []
        for line in raw_block.get("lines", []):
            text = "".join(str(span.get("text", "")) for span in line.get("spans", [])).strip()
            if text:
                lines.append({"text": text, "bbox": _bbox(*line["bbox"], width, height), "spans": [
                    {"text": str(span.get("text", "")), "fontSize": span.get("size", 12),
                     "font": span.get("font", ""), "bbox": _bbox(*span["bbox"], width, height)}
                    for span in line.get("spans", [])]})
        if not lines:
            continue
        text = "\n".join(line["text"] for line in lines)
        max_size = max(span["fontSize"] for line in lines for span in line["spans"])
        kind = "heading" if max_size > typical_size * 1.2 else "list" if text.startswith(("•", "- ", "1.", "1)")) else "paragraph"
        blocks.append(make_block(block_id=f"p{number}-b{index}", block_type=kind, text=text,
                                 bbox=_bbox(*rb, width, height), reading_order=0,
                                 confidence=1.0, children=lines))
    return _finish_page(number, width, height, blocks)


def _page_image(image):
    preview = image.copy()
    preview.thumbnail((1200, 1600))
    output = io.BytesIO()
    preview.convert("RGB").save(output, format="JPEG", quality=78, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def _render_page(page):
    scale = min(OCR_DPI / 72, OCR_MAX_IMAGE_DIM / max(page.rect.width, page.rect.height))
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    return Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB")


def _grid_tables(image, blocks, number, width, height):
    """Detect only ruled grids; borderless tables remain ordinary blocks."""
    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 15, 10)
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((1, max(20, image.width // 30)), np.uint8))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((max(20, image.height // 30), 1), np.uint8))
    contours, _ = cv2.findContours(cv2.bitwise_or(horizontal, vertical), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    sx, sy = width / image.width, height / image.height
    tables, consumed = [], set()
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < image.width * .15 or h < 30:
            continue
        def positions(values):
            groups = []
            for value in values:
                if groups and value - groups[-1][-1] <= 3:
                    groups[-1].append(int(value))
                else:
                    groups.append([int(value)])
            return [sum(group) / len(group) for group in groups]
        xs = positions(np.where((vertical[y:y+h, x:x+w] > 0).sum(axis=0) > h * .65)[0] + x)
        ys = positions(np.where((horizontal[y:y+h, x:x+w] > 0).sum(axis=1) > w * .65)[0] + y)
        if not 3 <= len(xs) <= 30 or not 3 <= len(ys) <= 100:
            continue
        rows, local = [], set()
        for row_index in range(len(ys) - 1):
            cells = []
            for column in range(len(xs) - 1):
                members = []
                for index, block in enumerate(blocks):
                    b = block["bbox"]
                    cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
                    if xs[column]*sx <= cx < xs[column+1]*sx and ys[row_index]*sy <= cy < ys[row_index+1]*sy:
                        # A line crossing a column separator is ambiguous; keep it outside the table.
                        if b["x"] + b["width"] > xs[column+1]*sx + 3:
                            continue
                        members.append(block)
                        local.add(index)
                cells.append({"column": column, "text": "\n".join(b["text"] for b in sorted(members, key=lambda b: (b["bbox"]["y"], b["bbox"]["x"]))),
                              "bbox": _bbox(xs[column]*sx, ys[row_index]*sy, xs[column+1]*sx, ys[row_index+1]*sy, width, height)})
            rows.append({"index": row_index, "cells": cells})
        if local:
            tables.append(_table(f"p{number}-table{len(tables)}", rows,
                                 (xs[0]*sx, ys[0]*sy, xs[-1]*sx, ys[-1]*sy), width, height))
            consumed.update(local)
    return [block for index, block in enumerate(blocks) if index not in consumed] + tables


def _ocr_page(image, number, width, height):
    bounded = image.copy()
    bounded.thumbnail((OCR_MAX_IMAGE_DIM, OCR_MAX_IMAGE_DIM))
    sx, sy = width / bounded.width, height / bounded.height
    results = _reader().readtext(np.asarray(bounded), detail=1, paragraph=False)
    blocks = []
    for index, result in enumerate(results):
        if not isinstance(result, (list, tuple)) or len(result) < 3:
            continue
        polygon, text, confidence = result[0], str(result[1]).strip(), float(result[2])
        if not text:
            continue
        points = [[round(float(point[0]) * sx, 3), round(float(point[1]) * sy, 3)] for point in polygon]
        xs, ys = [point[0] for point in points], [point[1] for point in points]
        block = make_block(block_id=f"p{number}-b{index}", block_type="line", text=text,
                           bbox=_bbox(min(xs), min(ys), max(xs), max(ys), width, height),
                           reading_order=0, confidence=round(confidence, 4))
        block["polygon"] = points
        blocks.append(block)
    return _finish_page(number, width, height, _grid_tables(bounded, blocks, number, width, height))


class OCRService:
    @staticmethod
    def extract_document(file_path: str, file_name: str | None = None) -> dict[str, Any]:
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError("Uploaded file is unavailable.")
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("Document exceeds the 20 MiB input limit.")
        pages, parts, scanned = [], [], 0
        if path.suffix.lower() == ".pdf":
            if fitz is None:
                raise RuntimeError("PyMuPDF is unavailable.")
            try:
                document = fitz.open(path)
            except Exception as exc:
                raise ValueError("Malformed or unreadable PDF.") from exc
            with document:
                if document.is_encrypted or not 0 < len(document) <= MAX_PDF_PAGES:
                    raise ValueError(f"PDF must be unencrypted and contain 1–{MAX_PDF_PAGES} pages.")
                for number, page in enumerate(document, 1):
                    image = _render_page(page)
                    if has_meaningful_native_text(page.get_text()):
                        structured, text = _native_page(page, number)
                    else:
                        scanned += 1
                        if scanned > MAX_SCANNED_PAGES:
                            raise ValueError(f"OCR is limited to {MAX_SCANNED_PAGES} scanned pages.")
                        structured, text = _ocr_page(image, number, page.rect.width, page.rect.height)
                    structured["sourceImage"] = _page_image(image)
                    pages.append(structured)
                    parts.append(text)
                    if sum(len(page.get("sourceImage", "")) for page in pages) > MAX_CANONICAL_BYTES:
                        raise ValueError("Document preview exceeds the safe payload limit.")
            source_type = "PDF_NATIVE_OR_SCANNED"
        elif path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            with Image.open(path) as original:
                if original.width * original.height > 40_000_000:
                    raise ValueError("Image exceeds the 40 megapixel limit.")
                image = ImageOps.exif_transpose(original).convert("RGB")
            structured, text = _ocr_page(image, 1, image.width, image.height)
            structured["sourceImage"] = _page_image(image)
            pages, parts, scanned = [structured], [text], 1
            source_type = "IMAGE_OCR"
        else:
            raise ValueError("Unsupported file format.")
        plain = "\n\n".join(parts).strip()
        if not plain:
            raise ValueError("No readable text was found in the document.")
        result = make_document(source_type=source_type, file_name=file_name or path.name,
                               plain_text=plain, pages=pages, processing={
                                   "nativePages": len(pages) - scanned, "ocrPages": scanned,
                                   "engine": "pymupdf+easyocr+opencv-grid", "layoutVersion": "xy-cut-grid.v1"})
        if len(json.dumps(result).encode("utf-8")) > MAX_CANONICAL_BYTES:
            raise ValueError("Structured document exceeds the safe payload limit.")
        return result

    @staticmethod
    def extract_text(file_path: str) -> str:
        return OCRService.extract_document(file_path)["plainText"]
