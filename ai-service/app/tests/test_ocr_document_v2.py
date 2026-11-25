import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
from PIL import Image

from app.services.ocr_service import OCRService, _ordered_blocks


class _FakeReader:
    def readtext(self, _image, detail=1, paragraph=False):
        assert detail == 1
        assert paragraph is False
        return [
            ([[10, 20], [210, 20], [210, 60], [10, 60]], "Scanned heading", 0.91),
            ([[10, 80], [190, 80], [190, 112], [10, 112]], "Scanned body", 0.84),
        ]


class TestOCRDocumentV2(unittest.TestCase):
    def test_native_pdf_preserves_pages_lines_and_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "native.pdf"
            document = fitz.open()
            page = document.new_page(width=600, height=800)
            page.insert_text((72, 100), "Native heading")
            page.insert_text((72, 140), "Native body with enough words")
            document.save(path)
            document.close()

            result = OCRService.extract_document(str(path), "native.pdf")

        self.assertEqual(result["schemaVersion"], "reading-document.v1")
        self.assertEqual(result["processing"]["nativePages"], 1)
        self.assertEqual(result["processing"]["ocrPages"], 0)
        self.assertIn("Native body", result["plainText"])
        page = result["pages"][0]
        self.assertEqual(page["pageNumber"], 1)
        self.assertGreaterEqual(len(page["blocks"]), 1)
        block = page["blocks"][0]
        self.assertTrue(block["children"])
        self.assertGreaterEqual(block["bbox"]["xNorm"], 0)
        self.assertLessEqual(block["bbox"]["xNorm"], 1)

    def test_scanned_image_fallback_preserves_confidence_and_normalized_bbox(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scan.png"
            Image.new("RGB", (400, 200), "white").save(path)
            with patch("app.services.ocr_service.READER", _FakeReader()):
                result = OCRService.extract_document(str(path), "scan.png")

        self.assertEqual(result["sourceType"], "IMAGE_OCR")
        self.assertEqual(result["processing"]["ocrPages"], 1)
        self.assertIn("Scanned heading", result["plainText"])
        self.assertIn("Scanned body", result["plainText"])
        self.assertTrue(result["pages"][0]["sourceImage"].startswith("data:image/jpeg;base64,"))
        block = result["pages"][0]["blocks"][0]
        self.assertEqual(block["confidence"], 0.91)
        self.assertAlmostEqual(block["bbox"]["xNorm"], 0.025)
        self.assertAlmostEqual(block["bbox"]["widthNorm"], 0.5)

    def test_column_ordering_and_backward_compatible_extract_text(self):
        blocks = [
            {"bbox": {"x": 340, "y": 10, "width": 100, "height": 20}, "text": "right"},
            {"bbox": {"x": 20, "y": 400, "width": 100, "height": 20}, "text": "left"},
        ]
        ordered = _ordered_blocks(blocks, 500)
        self.assertEqual([block["text"] for block in ordered], ["left", "right"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plain.pdf"
            document = fitz.open()
            page = document.new_page()
            page.insert_text((72, 72), "Legacy plain text response")
            document.save(path)
            document.close()
            self.assertIn("Legacy plain text", OCRService.extract_text(str(path)))

    def test_malformed_pdf_and_unsupported_input_fail_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            bad_pdf = Path(directory) / "bad.pdf"
            bad_pdf.write_bytes(b"not a pdf")
            with self.assertRaises(ValueError):
                OCRService.extract_document(str(bad_pdf))
            text_file = Path(directory) / "note.txt"
            text_file.write_text("hello")
            with self.assertRaises(ValueError):
                OCRService.extract_document(str(text_file))

    def test_native_ruled_table_remains_a_structured_block(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.pdf"
            document = fitz.open()
            page = document.new_page(width=400, height=300)
            for x in (50, 180, 320):
                page.draw_line((x, 50), (x, 150))
            for y in (50, 90, 120, 150):
                page.draw_line((50, y), (320, y))
            page.insert_text((60, 75), "Alpha value")
            page.insert_text((190, 75), "Beta value")
            page.insert_text((60, 110), "Gamma value")
            page.insert_text((190, 110), "Delta value")
            document.save(path)
            document.close()

            result = OCRService.extract_document(str(path), "table.pdf")

        table = next(block for block in result["pages"][0]["blocks"] if block["type"] == "table")
        self.assertEqual(len(table["rows"]), 3)
        self.assertEqual(table["rows"][0]["cells"][0]["text"], "Alpha value")
        self.assertEqual(table["rows"][0]["cells"][1]["text"], "Beta value")


if __name__ == "__main__":
    unittest.main()
