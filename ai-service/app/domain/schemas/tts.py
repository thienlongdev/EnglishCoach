from typing import List, Literal, Optional
from pydantic import BaseModel, Field, field_validator

CanonicalVoiceId = Literal["us_male", "us_female", "uk_male", "uk_female"]
TtsLangMode = Literal["auto", "en", "vi"]

VALID_VOICE_IDS = {"us_male", "us_female", "uk_male", "uk_female"}
VALID_LANG_MODES = {"auto", "en", "vi"}


class OmniVoiceRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Text to synthesize (1-2000 characters). Cannot be blank.",
    )
    voiceId: str = Field(
        ...,
        description="Canonical voice ID: us_male, us_female, uk_male, uk_female",
    )
    lang: Optional[Literal["auto", "en", "vi"]] = Field(
        default="auto",
        description="Optional language routing mode: auto (clause-level EN vs VI+code-switch), en, or vi.",
    )

    @field_validator("text")
    @classmethod
    def validate_non_blank_text(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("text cannot be blank or whitespace-only")
        return stripped

    @field_validator("voiceId")
    @classmethod
    def validate_canonical_voice_id(cls, v: str) -> str:
        cleaned = v.strip().lower()
        if cleaned not in VALID_VOICE_IDS:
            raise ValueError(
                f"Invalid voiceId '{v}'. Must be one of canonical voices: {sorted(list(VALID_VOICE_IDS))}"
            )
        return cleaned

    @field_validator("lang", mode="before")
    @classmethod
    def normalize_lang(cls, v: Optional[str]) -> str:
        if v is None:
            return "auto"
        cleaned = str(v).strip().lower()
        if not cleaned:
            return "auto"
        if cleaned not in VALID_LANG_MODES:
            raise ValueError(f"Invalid lang '{v}'. Must be one of: auto, en, vi")
        return cleaned


class TtsStreamRequest(OmniVoiceRequest):
    pass


class VoiceMetadata(BaseModel):
    voiceId: str = Field(..., description="Canonical voice ID")
    displayName: str = Field(..., description="Human-friendly voice name")
    accent: str = Field(..., description="Regional accent (e.g. US, UK)")
    gender: str = Field(..., description="Voice gender (male, female)")


class VoicesResponse(BaseModel):
    voices: List[VoiceMetadata]
