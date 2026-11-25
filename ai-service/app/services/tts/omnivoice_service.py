"""
Commercial-clean facade for legacy `OmniVoiceService` callers.

Delegates 100% of synthesis and voice discovery to `JarvisTtsService` (`jarvis-tts-v2`:
Apache-2.0 `Kokoro-82M v1.0` + pinned Apache-2.0 `VieNeu-TTS-v3-Turbo` + `MOSS-Audio-Tokenizer-Nano`
+ `sea-g2p`), with zero `CC-BY-NC` weights and zero in-process `GPLv3+` dependencies.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from app.services.tts.jarvis_tts_service import (
    ENGINE_ID,
    SAMPLE_RATE,
    VOICE_REGISTRY as _JARVIS_VOICES,
    JarvisTtsService,
)

VOICE_REGISTRY: Dict[str, Dict[str, str]] = {
    k: {
        "displayName": str(v["displayName"]),
        "accent": str(v["accent"]),
        "gender": str(v["gender"]),
    }
    for k, v in _JARVIS_VOICES.items()
}


class OmniVoiceService:
    """Drop-in backwards-compatible facade backed exclusively by `JarvisTtsService`."""

    _instance: Optional["OmniVoiceService"] = None

    def __init__(self, delegate: Optional[JarvisTtsService] = None) -> None:
        self._delegate = delegate or JarvisTtsService.get_instance()
        self._sampling_rate = SAMPLE_RATE
        self.engine_id = ENGINE_ID

    @classmethod
    def get_instance(cls) -> "OmniVoiceService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load_model(self, force_reload: bool = False) -> None:
        self._delegate.load_model(force_reload=force_reload)

    def synthesize(self, text: str, voice_id: str, lang: str = "auto") -> Tuple[bytes, float, float]:
        return self._delegate.synthesize(text=text, voice_id=voice_id, lang=lang)

    def stream_pcm_chunks(self, text: str, voice_id: str, lang: str = "auto"):
        return self._delegate.stream_pcm_chunks(text=text, voice_id=voice_id, lang=lang)

    def get_public_voices(self) -> List[Dict[str, str]]:
        return self._delegate.get_public_voices()

    @property
    def is_loaded(self) -> bool:
        return self._delegate.is_loaded

    @property
    def device(self) -> str:
        return self._delegate.device

    @property
    def model_load_time_sec(self) -> float:
        return self._delegate.model_load_time_sec
