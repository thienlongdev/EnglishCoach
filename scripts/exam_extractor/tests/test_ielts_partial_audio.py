"""One unresolved section must not discard independently verified IELTS audio."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from exam_extractor.diagnostics import CONFIDENT, DiagnosticLog
from exam_extractor.pipeline import Extractor


class IeltsPartialAudioTest(unittest.TestCase):
    def binding(self, scope='WHOLE_TEST', part=None):
        return SimpleNamespace(scope=scope, sha256='raw-recording', part=part,
                               section=part, duration_ms=1800000 if part is None else 300000,
                               confidence=CONFIDENT)

    def segment(self, verified=True):
        return SimpleNamespace(technical_qa={'hashVerified': verified, 'durationAgrees': True})

    def bind(self, segments, bindings=None):
        extractor = Extractor.__new__(Extractor)
        extractor.staging = 'unused-test-staging'
        parts = [SimpleNamespace(number=n, code=f'LISTENING_PART_{n}', audio=[])
                 for n in range(1, 5)]
        test = SimpleNamespace(audio=[])
        log = DiagnosticLog()
        with patch('exam_extractor.audio_segment.confident_part_segments', return_value=segments):
            result = extractor._bind_ielts_audio(parts, bindings or [self.binding()], test, log)
        return result, test, log

    def test_verified_parts_survive_an_unbounded_section(self):
        segments = {1: self.segment(), 2: self.segment(), 4: self.segment()}
        result, test, log = self.bind(segments)
        self.assertEqual([1, 2, 3, 4], [p.number for p in result])
        self.assertEqual([], result[2].audio)
        for number, segment in segments.items():
            self.assertIs(segment, result[number - 1].audio[0])
            self.assertIn(segment, test.audio)
        self.assertTrue(any(d.code == 'AUDIO_SEGMENT_UNRESOLVED' for d in log.items))

    def test_unverified_segment_is_not_retained(self):
        rejected = self.segment(verified=False)
        result, test, _ = self.bind({1: self.segment(), 2: rejected, 4: self.segment()})
        self.assertEqual([], result[1].audio)
        self.assertNotIn(rejected, test.audio)
        self.assertEqual([], result[2].audio)

    def test_explicit_part_recording_can_fill_only_the_unbounded_part(self):
        segments = {1: self.segment(), 2: self.segment(), 4: self.segment()}
        direct = self.binding('PART_3', 3)
        result, test, _ = self.bind(segments, [self.binding(), direct])
        self.assertIs(direct, result[2].audio[0])
        self.assertIn(direct, test.audio)
        for number, segment in segments.items():
            self.assertIs(segment, result[number - 1].audio[0])


if __name__ == '__main__':
    unittest.main()
