import copy
import unittest
from exam_extractor.canonical_json import package_content_hash


class CanonicalRecordShapeTest(unittest.TestCase):
    def test_missing_nullable_fields_and_epoch_seconds_match_record_serialization(self):
        raw = {"manifest": {"createdAt": 1791244800.0}, "form": {}, "items": [{}]}
        normalized = {"manifest": {"createdAt": "2026-10-06T00:00:00Z"},
                      "form": {"primaryHealthStatus": None}, "items": [{"ordinal": None}]}
        before = copy.deepcopy(raw)
        self.assertEqual(package_content_hash(normalized), package_content_hash(raw))
        self.assertEqual(before, raw)

    def test_jackson_fractional_groups_and_metadata_remain_opaque(self):
        a = {"manifest": {"createdAt": "2026-10-06T00:00:00.1Z", "metadata": {"createdAt": 1.0}}}
        b = {"manifest": {"createdAt": "2026-10-06T00:00:00.100Z", "metadata": {"createdAt": 1.0}}}
        self.assertEqual(package_content_hash(a), package_content_hash(b))
        b["manifest"]["metadata"]["createdAt"] = "1970-01-01T00:00:01Z"
        self.assertNotEqual(package_content_hash(a), package_content_hash(b))
