import shutil
import subprocess
import unittest

import numpy as np

from app.services.audio_ingestion import AudioIngestionError, decode_browser_audio
from app.services.pronunciation.ecsm.unified_runtime import ECSMRuntime


def _fixture_bytes(*, sample_rate: int, channels: int, format_name: str) -> bytes:
    codec_args = ["-c:a", "libopus"] if format_name == "webm" else ["-c:a", "pcm_s16le"]
    command = [
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-ar", str(sample_rate), "-ac", str(channels), *codec_args, "-f", format_name, "pipe:1",
    ]
    return subprocess.run(command, check=True, stdout=subprocess.PIPE).stdout


class TestAudioIngestion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("ffmpeg") is None:
            raise unittest.SkipTest("FFmpeg is required for audio ingestion tests")

    def test_wav_sample_rates_normalize_to_16k_and_preserve_duration(self):
        for sample_rate in [16_000, 44_100, 48_000]:
            with self.subTest(sample_rate=sample_rate):
                raw = _fixture_bytes(sample_rate=sample_rate, channels=1, format_name="wav")
                audio = decode_browser_audio(raw, content_type="audio/wav", filename="recording.wav")
                self.assertEqual(audio.sample_rate, 16_000)
                self.assertEqual(audio.channels, 1)
                self.assertEqual(audio.waveform.dtype, np.float32)
                self.assertTrue(np.isfinite(audio.waveform).all())
                self.assertAlmostEqual(audio.duration_seconds, 1.0, delta=0.05)

    def test_webm_opus_uses_real_decode_path_and_is_not_treated_as_wav(self):
        raw = _fixture_bytes(sample_rate=48_000, channels=1, format_name="webm")
        self.assertEqual(raw[:4], b"\x1aE\xdf\xa3")
        audio = decode_browser_audio(raw, content_type="audio/webm;codecs=opus", filename="recording.webm")
        self.assertIn("webm", audio.source_container)
        self.assertEqual(audio.source_codec, "opus")
        self.assertEqual(audio.source_sample_rate, 48_000)
        self.assertEqual(audio.sample_rate, 16_000)
        self.assertEqual(audio.channels, 1)
        self.assertAlmostEqual(audio.duration_seconds, 1.0, delta=0.1)

        runtime = ECSMRuntime.get_instance()
        waveform, quality, error = runtime.decode_and_resample(raw, "audio/webm;codecs=opus")
        self.assertIsNone(error)
        self.assertIsNotNone(waveform)
        self.assertIsNotNone(quality)
        self.assertEqual(quality.sample_rate, 16_000)
        self.assertEqual(quality.num_channels, 1)

    def test_stereo_is_downmixed_to_mono(self):
        raw = _fixture_bytes(sample_rate=44_100, channels=2, format_name="wav")
        audio = decode_browser_audio(raw, content_type="audio/x-wav", filename="stereo.wav")
        self.assertEqual(audio.source_channels, 2)
        self.assertEqual(audio.channels, 1)
        self.assertEqual(audio.waveform.ndim, 1)

    def test_empty_and_corrupt_audio_are_controlled(self):
        cases = [(b"", "AUDIO_EMPTY"), (b"not audio", "AUDIO_DECODE_FAILED")]
        for payload, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(AudioIngestionError) as caught:
                    decode_browser_audio(payload, content_type="audio/webm", filename="recording.webm")
                self.assertEqual(caught.exception.code, expected_code)

    def test_declared_non_audio_mime_is_rejected_before_decode(self):
        with self.assertRaises(AudioIngestionError) as caught:
            decode_browser_audio(b"not audio", content_type="text/plain", filename="recording.txt")
        self.assertEqual(caught.exception.code, "AUDIO_UNSUPPORTED_FORMAT")


if __name__ == "__main__":
    unittest.main()
