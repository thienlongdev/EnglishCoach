"""Incremental extraction must never read the historical workspace named by a cache."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from exam_extractor.staging import Staging


class StagingRelocationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'imports/exams/staging'
        self.root.mkdir(parents=True)
        self.staging = Staging(self.root)
        self.test_id = 'ielts/cambridge-ielts-17/test-1'
        self.report = self.staging.report_path('ielts', 'cambridge-ielts-17', 1)
        self.report.parent.mkdir(parents=True)
        self.report.write_text(json.dumps({'testId': self.test_id, 'package': {'path': None}}), encoding='utf-8')
        self.staging.runs[self.test_id] = {'fingerprint': 'same', 'report': 'Z:/historical-forbidden/report.json'}

    def test_historical_cache_paths_are_never_accessed_and_current_report_is_used(self):
        original = Path.read_text
        accessed = []
        def read(path, *args, **kwargs):
            accessed.append(path)
            self.assertTrue(path.is_relative_to(self.root))
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', read):
            self.assertTrue(self.staging.unchanged(self.test_id, 'same'))
            self.assertEqual(self.test_id, self.staging.cached_report(self.test_id)['testId'])
        self.assertEqual([self.report, self.report], accessed)

    def test_missing_current_report_and_changed_input_require_extraction(self):
        self.assertFalse(self.staging.unchanged(self.test_id, 'changed'))
        self.report.unlink()
        self.assertFalse(self.staging.unchanged(self.test_id, 'same'))

    def test_wrong_report_identity_and_package_traversal_are_refused(self):
        self.report.write_text(json.dumps({'testId': 'toeic/ets-2026/test-1'}), encoding='utf-8')
        self.assertFalse(self.staging.unchanged(self.test_id, 'same'))
        self.report.write_text(json.dumps({'testId': self.test_id, 'package': {'path': 'imports/exams/staging/../../outside.json'}}), encoding='utf-8')
        self.assertFalse(self.staging.unchanged(self.test_id, 'same'))
        with self.assertRaises(ValueError):
            self.staging.cached_report('ielts/../../test-1')

    def test_missing_or_replaced_local_package_requires_extraction(self):
        package_path = self.root / 'extracted/ielts/cambridge/test.json'
        relative = 'imports/exams/staging/' + package_path.relative_to(self.root).as_posix()
        self.report.write_text(json.dumps({'testId': self.test_id, 'package': {'path': relative, 'contentHash': 'a'}}), encoding='utf-8')
        self.assertFalse(self.staging.unchanged(self.test_id, 'same'))
        package_path.parent.mkdir(parents=True)
        package_path.write_text(json.dumps({'manifest': {'contentHash': 'b'}}), encoding='utf-8')
        self.assertFalse(self.staging.unchanged(self.test_id, 'same'))
        package_path.write_text(json.dumps({'manifest': {'contentHash': 'a'}}), encoding='utf-8')
        self.assertTrue(self.staging.unchanged(self.test_id, 'same'))
