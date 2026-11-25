import tempfile
import unittest
from pathlib import Path
from exam_extractor.media import AssetStore
from exam_extractor.model import ExtractedTest, Section
from exam_extractor.package_builder import PackageBuilder


class SpecificationIdentityTest(unittest.TestCase):
    def build(self, version, skills):
        with tempfile.TemporaryDirectory() as temp:
            test = ExtractedTest('toeic/synthetic/test-1', 'TOEIC', 'STANDARD_FIXED_FORM',
                                 'synthetic', 'synthetic', 'Synthetic', 1, 'Synthetic')
            test.format_version = version
            test.sections = [Section(skill) for skill in skills]
            return PackageBuilder(AssetStore(Path(temp))).build(test, 'Synthetic')

    def test_formats_have_distinct_logical_identities(self):
        old = self.build('TOEIC_LR_PRE_2016', ['READING'])['specifications'][0]
        current = self.build('TOEIC_LR_2016', ['READING'])['specifications'][0]
        self.assertNotEqual(old['logicalCode'], current['logicalCode'])
        self.assertNotEqual(old['id'], current['id'])
        self.assertNotEqual(old['contentHash'], current['contentHash'])
        self.assertLessEqual(len(old['logicalCode']), 64)

    def test_shared_full_specification_does_not_depend_on_extraction_completeness(self):
        reading = self.build('TOEIC_LR_2016', ['READING'])['specifications'][0]
        both = self.build('TOEIC_LR_2016', ['LISTENING', 'READING'])['specifications'][0]
        self.assertEqual(reading, both)
