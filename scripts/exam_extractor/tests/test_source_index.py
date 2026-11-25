"""Filesystem discovery includes sources absent from the manifest and archive members."""
import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from exam_extractor.source_index import inventory, family_source_groups, discovered_audio
from types import SimpleNamespace


class SourceIndexTests(unittest.TestCase):
    def test_filesystem_audio_is_probable_and_byte_duplicates_are_not_added(self):
        test = SimpleNamespace(test_number=1, raw={'audio': []})
        candidate = {'roleCandidate': 'AUDIO_CANDIDATE', 'testCandidate': 1, 'partCandidate': None,
                     'path': 'toeic/ybm/YBM VOL 1/Test01.mp3', 'sha256': 'same',
                     'audio': {'durationSeconds': 1800}}
        audio = discovered_audio(test, [candidate, {**candidate, 'path': 'duplicate.mp3'}])
        self.assertEqual(1, len(audio))
        self.assertEqual('PROBABLE', audio[0]['confidence'])
        self.assertEqual([], test.raw['audio'])

    def test_filename_candidates_include_archive_audio_and_reject_conflicting_volumes(self):
        grouped = family_source_groups({'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'files': [
            {'path': 'toeic/economy/LC1000vol 3/AT01_Part 2.mp3', 'family': 'toeic/economy',
             'extension': '.mp3', 'audio': {'durationSeconds': 10}, 'sha256': 'first'},
            {'path': 'toeic/ybm/VOL 1/VOL 2/RC.pdf', 'family': 'toeic/ybm', 'extension': '.pdf'}],
            'archiveMembers': [{'archive': 'toeic/ybm/YBM VOL 2/audio.zip', 'member': 'Test 01.mp3',
                                'family': 'toeic/ybm', 'extension': '.mp3', 'audio': {}, 'sha256': 'second'}]})
        candidate = grouped['families']['economy-vol-3'][0]
        self.assertEqual((1, 2), (candidate['testCandidate'], candidate['partCandidate']))
        self.assertEqual(1, grouped['families']['ybm-vol-2'][0]['testCandidate'])
        self.assertEqual(1, len(grouped['unassigned']))

    def test_unlisted_nested_file_and_archive_bytes_are_indexed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            raw = base / 'raw'
            nested = raw / 'toeic/ybm/volume-1/back-matter'
            nested.mkdir(parents=True)
            data = b'fixture metadata'
            (nested / 'key.csv').write_bytes(data)
            with zipfile.ZipFile(nested / 'sources.zip', 'w') as archive:
                archive.writestr('keys/answers.txt', data)
            report = inventory(raw, base / 'staging', set())
            self.assertEqual(2, report['summary']['filesAbsentFromManifest'])
            self.assertEqual(1, len(report['archiveMembers']))
            self.assertEqual(hashlib.sha256(data).hexdigest(), report['archiveMembers'][0]['sha256'])
            self.assertEqual(data, (nested / 'key.csv').read_bytes())
            self.assertFalse(report['productionQualified'])


if __name__ == '__main__':
    unittest.main()
