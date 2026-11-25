import math
import unittest

from exam_extractor.key_tables import _number_row_angles, _lattice, KeyBlock


class NumberRowGeometryTests(unittest.TestCase):
    def pairs(self, contradictory=False, warped=False):
        pairs = []
        for column in range(10):
            for row in range(10):
                number = 1 + column * 10 + row
                x = column * 80
                y = row * 18 + x * math.tan(math.radians(0.8))
                if warped:
                    y += column ** 2
                text = str(number)
                pairs.append((((x, y, x + 10, y + 10), (text, 1),
                               (str(number + 1) if contradictory else text, 1)), None))
        return pairs

    def test_printed_number_rows_recover_angle_when_border_is_unrelated(self):
        angles = _number_row_angles(self.pairs(), 10, range(1, 101))
        self.assertTrue(any(abs(angle - 0.8) < 0.001 for angle in angles))

    def test_disagreeing_numbers_cannot_define_geometry(self):
        self.assertEqual([], _number_row_angles(self.pairs(contradictory=True), 10, range(1, 101)))

    def test_curved_rows_cannot_be_proved_by_a_straight_angle(self):
        self.assertEqual([], _number_row_angles(self.pairs(warped=True), 10, range(1, 101)))

    def test_row_major_lc_grid_retains_own_printed_one_digit_numbers(self):
        pairs = []
        for row in range(20):
            for column in range(5):
                number = 1 + row * 5 + column
                x, y = column * 80, row * 18
                digits = ((x, y, x + 10, y + 10), (str(number), 1), (str(number), 1))
                letter = ((x + 20, y, x + 30, y + 10), ('A', 1), ('A', 1))
                pairs.append((digits, letter))
        block = KeyBlock(1, 1, (0, 0, 500, 500))
        _lattice(block, pairs, 10, range(1, 101), None, 1, block.bbox, None)
        self.assertEqual('ROW_MAJOR', block.orientation)
        self.assertEqual(set(range(1, 101)), set(block.keys()))


if __name__ == '__main__':
    unittest.main()
