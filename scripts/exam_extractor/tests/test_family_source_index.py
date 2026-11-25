import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from exam_extractor.source_index import (family_source_groups, source_matrix, profile_key_candidates,
                                         inspect_pdf, inspect_audio_metadata)


def source(path, family, sha='source'):
    return {'path': path, 'family': family, 'extension': '.pdf', 'sha256': sha}


class FamilySourceIndexTest(unittest.TestCase):
    def test_later_exact_byte_key_probe_updates_incomplete_family_survey(self):
        raw = source('toeic/economy/Volume 2/RC.pdf', 'toeic/economy', 'current')
        index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'files': [raw], 'archiveMembers': []}
        test = SimpleNamespace(collection='economy', book='economy-vol-2', test_number=8,
                               test_id='toeic/economy-vol-2/test-8', raw={'audio': []},
                               book_raw={'source_documents': []})
        with tempfile.TemporaryDirectory() as folder:
            staging = Path(folder)
            path = staging / 'reports/ocr_keys/economy-vol-2__reading.json'
            path.parent.mkdir(parents=True)
            probe = {'book': 'economy-vol-2', 'skill': 'READING', 'sha256': 'current',
                     'source': 'imports/source-files/' + raw['path'], 'extractorVersion': 'fixture',
                     'tests': [{'test': 8, 'page': 270, 'confirmed': 98, 'orientation': 'COLUMN_MAJOR'}]}
            path.write_text(json.dumps(probe), encoding='utf-8')
            report = source_matrix(SimpleNamespace(tests=[test]), index, staging, staging / 'out')
            self.assertEqual(98, report['forms'][0]['KEY_SOURCES'][0]['confirmedCells'])
            probe['sha256'] = 'stale'
            path.write_text(json.dumps(probe), encoding='utf-8')
            report = source_matrix(SimpleNamespace(tests=[test]), index, staging, staging / 'out')
            self.assertEqual([], report['forms'][0]['KEY_SOURCES'])

    def test_pdf_embedded_assets_and_annotations_are_indexed_without_source_text(self):
        annotation = SimpleNamespace(info={'content': 'Answers: private fixture text'}, type=(0, 'Text'))
        page = SimpleNamespace(get_text=lambda: '', get_images=lambda **kwargs: [(7,), (7,), (8,)],
                               annots=lambda: [annotation])
        class Document(list):
            def embfile_names(self): return ['supplement.pdf']
            def embfile_get(self, name): return b'embedded fixture'
        report = inspect_pdf(Document([page]))
        self.assertEqual(2, report['embeddedImageObjectCount'])
        self.assertEqual('supplement.pdf', report['embeddedFiles'][0]['name'])
        self.assertTrue(report['annotations'][0]['answerMarker'])
        self.assertNotIn('private fixture text', json.dumps(report))

    def test_audio_embedded_images_are_byte_indexed_without_tag_values(self):
        image = SimpleNamespace(data=b'image fixture', mime='image/jpeg')
        audio = SimpleNamespace(tags={'APIC:': image, 'TIT2': 'private title'})
        with patch('mutagen.File', return_value=audio):
            report = inspect_audio_metadata('fixture.mp3')
        self.assertEqual(['APIC:', 'TIT2'], report['tagKeys'])
        self.assertEqual(13, report['embeddedImages'][0]['size'])
        self.assertNotIn('private title', json.dumps(report))

    def test_discovery_overlay_invalidates_only_its_own_book(self):
        from exam_extractor.cli import family_key_inputs
        with tempfile.TemporaryDirectory() as folder:
            staging = Path(folder)
            (staging / 'phase-b').mkdir()
            path = staging / 'phase-b/ybm-key-candidates.json'
            data = {'sources': [{'sha256': 'mine', 'keyTables': []}, {'sha256': 'other', 'keyTables': []}]}
            path.write_text(json.dumps(data), encoding='utf-8')
            before = family_key_inputs(staging, 'ybm', {'mine'})
            data['sources'][1]['keyTables'] = [{'scope': 'LISTENING', 'page': 171, 'test': 1, 'confirmed': 100}]
            path.write_text(json.dumps(data), encoding='utf-8')
            self.assertEqual(before, family_key_inputs(staging, 'ybm', {'mine'}))
            data['sources'][0]['keyTables'] = data['sources'][1]['keyTables']
            path.write_text(json.dumps(data), encoding='utf-8')
            self.assertNotEqual(before, family_key_inputs(staging, 'ybm', {'mine'}))

    def test_key_tool_uses_discovered_pages_and_rejects_stale_bytes(self):
        from exam_extractor.ocr_tools import discovered_key_source
        raw = source('toeic/ybm/YBM VOL 2/LC.pdf', 'toeic/ybm', 'current')
        with tempfile.TemporaryDirectory() as folder:
            staging = Path(folder)
            (staging / 'phase-b').mkdir()
            index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'archiveMembers': [], 'files': [raw]}
            (staging / 'phase-b/source-index.json').write_text(json.dumps(index), encoding='utf-8')
            survey_path = staging / 'phase-b/ybm-key-candidates.json'
            survey = {'sources': [{'path': raw['path'], 'sha256': 'current', 'keyTables': [
                {'scope': 'LISTENING', 'page': 171}, {'scope': 'LISTENING', 'page': 201},
                {'scope': 'READING', 'page': 400}]}]}
            survey_path.write_text(json.dumps(survey), encoding='utf-8')
            self.assertEqual((raw['path'], [171, 201], 'TOEIC_LR_2016', 'current'),
                             discovered_key_source(staging, 'ybm-vol-2', 'LISTENING'))
            survey['sources'][0]['sha256'] = 'stale'
            survey_path.write_text(json.dumps(survey), encoding='utf-8')
            self.assertIsNone(discovered_key_source(staging, 'ybm-vol-2', 'LISTENING'))

    def test_profile_window_survives_full_page_tiny_letter_detection_failure(self):
        index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'archiveMembers': [], 'files': [
            source('toeic/economy/Volume 1/LC.pdf', 'toeic/economy', 'first')]}
        self.assertEqual({146, 147}, profile_key_candidates(index)['first'])

    def test_pinned_profile_rejects_changed_source_bytes(self):
        index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'archiveMembers': [], 'files': [
            source('toeic/ybm/YBM VOL 2/RC.pdf', 'toeic/ybm', 'changed')]}
        self.assertEqual({}, profile_key_candidates(index))

    def test_actual_files_include_ets_and_ielts_family_candidates(self):
        index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'archiveMembers': [], 'files': [
            source('toeic/ets/ETS 2021/Test03.pdf', 'toeic/ets'),
            source('ielts/cambridge/Cambridge-ielts-17/book.pdf', 'ielts/cambridge'),
            source('ielts/barrons/book.pdf', 'ielts/barrons')]}
        groups = family_source_groups(index)['families']
        self.assertEqual(3, groups['ets-2021'][0]['testCandidate'])
        self.assertIn('cambridge-ielts-17', groups)
        self.assertIn('family:ielts/barrons', groups)

    def test_printed_key_title_never_maps_another_volume_or_changed_source(self):
        a = source('toeic/economy/Volume 1/RC.pdf', 'toeic/economy', 'first')
        b = source('toeic/economy/Volume 2/RC.pdf', 'toeic/economy', 'second')
        index = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'files': [a, b], 'archiveMembers': []}
        test = SimpleNamespace(collection='economy', book='economy-vol-1', test_number=1,
                               test_id='toeic/economy-vol-1/test-1', raw={'audio': []},
                               book_raw={'source_documents': []})
        with tempfile.TemporaryDirectory() as folder:
            staging = Path(folder)
            (staging / 'phase-b').mkdir()
            survey = {'sources': [
                {'path': a['path'], 'sha256': 'stale', 'keyTables': [
                    {'test': 1, 'scope': 'READING', 'page': 1, 'confirmed': 100}]},
                {'path': b['path'], 'sha256': 'second', 'keyTables': [
                    {'test': 1, 'scope': 'READING', 'page': 1, 'confirmed': 100}]}]}
            path = staging / 'phase-b/economy-back-matter.json'
            path.write_text(json.dumps(survey), encoding='utf-8')
            report = source_matrix(SimpleNamespace(tests=[test]), index, staging, staging / 'out')
            self.assertEqual([], report['forms'][0]['KEY_SOURCES'])
            survey['sources'][0]['sha256'] = 'first'
            path.write_text(json.dumps(survey), encoding='utf-8')
            report = source_matrix(SimpleNamespace(tests=[test]), index, staging, staging / 'out')
            refs = report['forms'][0]['KEY_SOURCES']
            self.assertEqual([a['path']], [r['path'] for r in refs])
            self.assertEqual('LOCATED_PRINTED_TEST_CELL_PROOF', report['forms'][0]['KEY_SOURCE_STATUS'])


if __name__ == '__main__':
    unittest.main()
