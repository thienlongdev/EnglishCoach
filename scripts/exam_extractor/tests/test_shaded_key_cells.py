import unittest
from unittest.mock import Mock
import numpy as np
from exam_extractor.key_tables import _DigitCellEngine, _shaded_grid_boxes, _lattice, KeyBlock


class ShadedKeyCellTests(unittest.TestCase):
    def grid(self):
        gray = np.full((562, 2100), 255, dtype=np.uint8)
        for c in range(10):
            gray[10:550, 20+c*200:115+c*200] = 210
        for y in range(10, 551, 54):
            gray[y:y+3, 20:2010] = 190
        return gray

    def test_physical_grid_proposes_geometry_without_numbers(self):
        boxes = _shaded_grid_boxes(self.grid())
        self.assertEqual(100, len(boxes))
        self.assertTrue(all(n[2] < a[0] for n, a in boxes))

    def test_score_conversion_and_irregular_cells_do_not_propose_grid(self):
        self.assertIsNone(_shaded_grid_boxes(np.full((600, 2000), 255, dtype=np.uint8)))
        gray = self.grid()
        gray[:, 20:115] = 255
        self.assertIsNone(_shaded_grid_boxes(gray))

    def pairs(self, contradict=False):
        result = []
        for c in range(10):
            for r in range(10):
                q = 1+c*10+r
                # Remove a full number row; its observed cell geometry remains.
                a = str(q+1 if contradict else q) if r != 4 else ''
                b = str(q) if r != 4 else ''
                result.append((((c*80, r*20, c*80+10, r*20+10), (a,1), (b,1)),
                               ((c*80+30, r*20, c*80+40, r*20+10), ('A',1), ('A',1))))
        return result

    def test_observed_rows_do_not_bind_an_unread_number(self):
        block = KeyBlock(1,1,(0,0,800,200))
        _lattice(block,self.pairs(),10,range(1,101),None,1,block.bbox,None,
                 physical_grid=([5+c*80 for c in range(10)],[5+r*20 for r in range(10)]))
        self.assertEqual('COLUMN_MAJOR',block.orientation)
        self.assertEqual(90,len(block.keys()))
        self.assertTrue(all(q not in block.keys() for q in range(5,101,10)))

    def test_disagreeing_own_numbers_cannot_prove_physical_grid(self):
        block = KeyBlock(1,1,(0,0,800,200))
        _lattice(block,self.pairs(True),10,range(1,101),None,1,block.bbox,None,
                 physical_grid=([5+c*80 for c in range(10)],[5+r*20 for r in range(10)]))
        self.assertIsNone(block.orientation)
        self.assertEqual({},block.keys())

    def test_low_confidence_digit_fragment_remains_unread(self):
        delegate = Mock(name='delegate')
        delegate.name, delegate.version = 'test', '1'
        delegate.recognize_boxes.return_value = [('8',.2)]
        image = np.full((32,32),255,dtype=np.uint8)
        image[5:27,10:20] = 0
        engine = _DigitCellEngine(delegate,'OTSU')
        self.assertEqual([('',.2)],engine.recognize_boxes(image,[(0,0,32,32)],'0123456789'))


if __name__ == '__main__':
    unittest.main()
