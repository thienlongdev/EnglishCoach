import os
import unittest
from unittest.mock import patch, MagicMock
import httpx
from app.services.speech_service import (
    transcribe_audio_bytes,
    _get_stt_endpoint,
    _get_mime_type,
)

class TestSpeechServiceOpenRouter(unittest.TestCase):

    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {}, clear=True)
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def test_endpoint_construction(self):
        self.assertEqual(
            _get_stt_endpoint("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        )
        self.assertEqual(
            _get_stt_endpoint("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        )
        self.assertEqual(
            _get_stt_endpoint("https://openrouter.ai/v1"),
            "https://openrouter.ai/v1/audio/transcriptions"
        )
        self.assertEqual(
            _get_stt_endpoint("https://openrouter.ai"),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        )
        self.assertEqual(
            _get_stt_endpoint("https://openrouter.ai/"),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        )

    def test_mime_type_resolution(self):
        self.assertEqual(_get_mime_type(".webm"), "audio/webm")
        self.assertEqual(_get_mime_type(".mp4"), "audio/mp4")
        self.assertEqual(_get_mime_type(".m4a"), "audio/m4a")
        self.assertEqual(_get_mime_type(".ogg"), "audio/ogg")
        self.assertEqual(_get_mime_type(".wav"), "audio/wav")
        self.assertEqual(_get_mime_type(".mp3"), "audio/mpeg")
        self.assertEqual(_get_mime_type(".webm", "audio/webm;codecs=opus"), "audio/webm;codecs=opus")

    def test_missing_openrouter_api_key_returns_empty_mock(self):
        os.environ.pop("OPENROUTER_API_KEY", None)
        dummy_audio = b"FAKE_AUDIO_BYTES_TEST"
        result = transcribe_audio_bytes(dummy_audio, filename="test.webm")

        self.assertTrue(result.get("isMocked"))
        self.assertEqual(result.get("text"), "")
        self.assertIsNone(result.get("confidence"))
        self.assertNotIn("early bird", result.get("text").lower())

    def test_empty_string_openrouter_api_key_returns_empty_mock(self):
        os.environ["OPENROUTER_API_KEY"] = "   "
        dummy_audio = b"FAKE_AUDIO_BYTES_TEST"
        result = transcribe_audio_bytes(dummy_audio, filename="test.webm")

        self.assertTrue(result.get("isMocked"))
        self.assertEqual(result.get("text"), "")
        self.assertIsNone(result.get("confidence"))
        self.assertNotIn("early bird", result.get("text").lower())

    @patch("httpx.Client")
    def test_successful_transcription_openrouter(self, mock_client_cls):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-mock-secret-key"
        os.environ["OPENROUTER_BASE_URL"] = "https://openrouter.ai/api/v1"
        os.environ["STT_MODEL"] = "openai/whisper-1"

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"text": "Good afternoon, I would like to check in."}
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        dummy_audio = b"RIFF_FAKE_WAV_BYTES_FOR_UNIT_TEST"
        result = transcribe_audio_bytes(
            audio_bytes=dummy_audio,
            filename="recording.wav",
            content_type="audio/wav"
        )

        self.assertFalse(result.get("isMocked"))
        self.assertEqual(result.get("text"), "Good afternoon, I would like to check in.")
        self.assertIsNone(result.get("confidence"))

        # Verify POST arguments
        mock_client.post.assert_called_once()
        call_args, call_kwargs = mock_client.post.call_args
        self.assertEqual(call_args[0], "https://openrouter.ai/api/v1/audio/transcriptions")
        self.assertEqual(call_kwargs["headers"]["Authorization"], "Bearer sk-or-v1-mock-secret-key")
        self.assertEqual(call_kwargs["data"]["model"], "openai/whisper-1")
        self.assertEqual(call_kwargs["data"]["language"], "en")
        self.assertIn("file", call_kwargs["files"])

    @patch("httpx.Client")
    def test_empty_transcript_silence(self, mock_client_cls):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-mock-secret-key"

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"text": ""}
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        dummy_audio = b"RIFF_FAKE_WAV_BYTES"
        result = transcribe_audio_bytes(dummy_audio, filename="silence.wav")

        self.assertFalse(result.get("isMocked"))
        self.assertEqual(result.get("text"), "")
        self.assertNotIn("early bird", result.get("text").lower())

    @patch("httpx.Client")
    def test_provider_error_raises_exception_and_no_fake_transcript(self, mock_client_cls):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-mock-secret-key"

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_response.text = "Rate limit reached"
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Rate limit", request=MagicMock(), response=mock_response
        )
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        dummy_audio = b"RIFF_FAKE_WAV_BYTES"
        with self.assertRaises(Exception) as ctx:
            transcribe_audio_bytes(dummy_audio, filename="test.wav")

        self.assertIn("Rate limit", str(ctx.exception))

    @patch("httpx.Client")
    def test_various_audio_formats(self, mock_client_cls):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-mock-secret-key"

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"text": "Audio format test"}
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        formats = [
            ("test.webm", None, "audio/webm"),
            ("test.mp4", None, "audio/mp4"),
            ("test.m4a", None, "audio/m4a"),
            ("test.ogg", None, "audio/ogg"),
            ("test.wav", None, "audio/wav"),
            ("test.mp3", None, "audio/mpeg"),
            (None, "audio/webm", "audio/webm"),
            (None, "audio/mp4", "audio/mp4"),
            (None, "audio/ogg", "audio/ogg"),
            (None, "audio/wav", "audio/wav"),
            (None, "audio/mpeg", "audio/mpeg"),
        ]

        for fname, ctype, expected_mime in formats:
            mock_client.reset_mock()
            result = transcribe_audio_bytes(b"DATA", filename=fname, content_type=ctype)
            self.assertEqual(result.get("text"), "Audio format test")
            call_kwargs = mock_client.post.call_args[1]
            file_tuple = call_kwargs["files"]["file"]
            self.assertEqual(file_tuple[2], expected_mime)

    @patch("httpx.Client")
    def test_temp_file_cleanup_on_success_and_error(self, mock_client_cls):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-mock-secret-key"

        created_files = []
        real_named_temp = __import__("tempfile").NamedTemporaryFile

        def track_temp_file(*args, **kwargs):
            tf = real_named_temp(*args, **kwargs)
            created_files.append(tf.name)
            return tf

        with patch("tempfile.NamedTemporaryFile", side_effect=track_temp_file):
            # Test 1: Success cleanup
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"text": "Cleaned up"}
            mock_client.post.return_value = mock_response
            mock_client_cls.return_value.__enter__.return_value = mock_client

            transcribe_audio_bytes(b"TEST_CLEANUP", filename="sample.wav")
            self.assertEqual(len(created_files), 1)
            self.assertFalse(os.path.exists(created_files[0]))

            # Test 2: Error cleanup
            mock_client.post.side_effect = RuntimeError("Network breakdown")
            with self.assertRaises(RuntimeError):
                transcribe_audio_bytes(b"TEST_CLEANUP_ERR", filename="sample2.wav")
            self.assertEqual(len(created_files), 2)
            self.assertFalse(os.path.exists(created_files[1]))

if __name__ == "__main__":
    unittest.main()
