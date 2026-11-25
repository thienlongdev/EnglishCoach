import unittest
from unittest.mock import patch
import numpy as np
from exam_extractor.layout import segment_lines, segment_words, WORD, LayoutProfile, page_scaled_profile


class LineSegmentationProgress(unittest.TestCase):
    def test_enlarged_pdf_units_bound_density_without_changing_source_coordinates(self):
        original = LayoutProfile(name='own-page', preprocess='P2')
        self.assertIs(original, page_scaled_profile(595, 842, original))
        scaled = page_scaled_profile(1612.5, 2280, original)
        self.assertEqual((37, 111), (scaled.analysis_dpi, scaled.ocr_dpi))
        self.assertEqual(('own-page', 'P2'), (scaled.name, scaled.preprocess))
        self.assertEqual((100, 300), (original.analysis_dpi, original.ocr_dpi))

    def test_dotted_leaders_do_not_erase_taller_letters(self):
        image = np.full((100, 1000), 255, dtype=np.uint8)
        for x in range(20, 220, 10):
            image[30:55, x:x + 7] = 0
        for x in range(250, 750, 10):
            image[51:55, x:x + 4] = 0
        # A real vertical rule remains removable alongside the preserved letters.
        image[5:95, 900:903] = 0
        words = segment_words(image, (0, 0, 1000, 100), dpi=108)
        letters = [box for _, box, kind in words if kind == WORD and box[0] < 150]
        self.assertTrue(letters)
        self.assertTrue(any(box[3] - box[1] > 15 for box in letters))
        self.assertFalse(any(box[0] > 590 for _, box, _ in words))

    def test_tiny_noise_height_cannot_repeat_the_same_interval(self):
        mask = np.zeros((80, 100), dtype=np.uint8)
        mask[0, :2] = 1
        mask[10, :2] = 1
        mask[11:50, :30] = 1
        with patch('exam_extractor.layout.cv2', None):
            lines = segment_lines(mask)
        self.assertEqual([(10, 50)], lines)

    def test_tall_solid_region_is_not_forcibly_split(self):
        mask = np.zeros((120, 100), dtype=np.uint8)
        mask[10:110, :50] = 1
        self.assertEqual([(10, 110)], segment_lines(mask))
