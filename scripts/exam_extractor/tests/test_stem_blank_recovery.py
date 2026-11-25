"""Restore only a blank proved inside its own printed stem."""
import unittest
from unittest.mock import patch
import numpy as np

from exam_extractor.ocr_quality import detect_blank_runs, recover_stem_blanks, insert_blanks
from exam_extractor.pdf_layer import Row, Token, DOTS


class StemBlankRecoveryTests(unittest.TestCase):
    def test_blank_stays_in_its_own_column_on_the_same_baseline(self):
        left = Row(1, 10, 20, 10, 100, [Token('left', 10, 100)])
        right = Row(1, 10, 20, 200, 300, [Token('right', 200, 300)])
        insert_blanks([left, right], [(15, 240, 260, 'DASH_RUN')])
        self.assertNotIn(DOTS, left.text)
        self.assertIn(DOTS, right.text)

    def test_blurred_dash_run_requires_four_pieces(self):
        for count in (3, 4):
            image = np.full((60, 160), 255, dtype=np.uint8)
            for x in range(5, 60, 12):
                image[5:27, x:x + 6] = 0
            for n in range(count):
                image[40:45, 60 + 12*n:70 + 12*n] = 0
            runs = detect_blank_runs(None, 1, (0, 0, 160, 60), dpi=72, image=image)
            self.assertEqual(int(count == 4), len(runs))

    def test_standalone_blank_is_inserted_before_options_only_when_unambiguous(self):
        for count in (1, 2):
            stem = Row(1, 10, 20, 10, 100, [Token('101.', 10, 25), Token('Printed stem', 30, 100)])
            option = Row(1, 40, 50, 30, 100, [Token('(A)', 30, 45), Token('choice', 50, 100)])
            rows = [stem, option]
            with patch('exam_extractor.ocr_quality.detect_blank_runs', return_value=[(30, 30, 60, 'DASH_RUN')]*count):
                recovered = recover_stem_blanks(None, rows, 101, 130)
            self.assertEqual(int(count == 1), len(recovered))
            if count == 1:
                self.assertEqual(DOTS, rows[1].text)
                self.assertIs(option, rows[2])


if __name__ == '__main__':
    unittest.main()
