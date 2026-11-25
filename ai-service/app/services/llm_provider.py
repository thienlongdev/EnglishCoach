from __future__ import annotations

import os
import logging
from typing import Optional

logger = logging.getLogger("llm_provider")

# Explicit allowlist of approved OpenRouter / project LLM model IDs (AI-08).
# Additional models may be opted in by operators via AI_EXTRA_ALLOWED_MODELS (comma-separated).
ALLOWED_MODELS: frozenset[str] = frozenset({
    "google/gemini-2.0-flash-001",
    "openai/gpt-5.6-luna",
    "deepseek/deepseek-v3.2",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "openai/gpt-6-luna",
    "openai/gpt-6.1-terra",
    "openai/gpt-6.1-sol",
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-sonnet-5.5",
    "gpt-4o-mini",
    "openai/gpt-4o-mini",
})


class LLMConfigurationError(RuntimeError):
    pass


def get_allowed_models() -> frozenset[str]:
    """Return the active allowlist of permitted model IDs."""
    extra_raw = os.getenv("AI_EXTRA_ALLOWED_MODELS", "")
    extra = {m.strip() for m in extra_raw.split(",") if m.strip()}
    return ALLOWED_MODELS | extra if extra else ALLOWED_MODELS


def validate_model_override(model_override: Optional[str]) -> Optional[str]:
    """Validate a requested model_override against the approved allowlist (AI-08)."""
    if model_override is None:
        return None
    if not isinstance(model_override, str):
        raise ValueError("Invalid model override: must be a string.")
    candidate = model_override.strip()
    if not candidate:
        return None
    if candidate not in get_allowed_models():
        raise ValueError(f"Model override '{candidate}' is not in the approved model allowlist.")
    return candidate


def get_llm(
    temperature: float = 0.2,
    max_tokens: int = 1500,
    timeout: float = 30.0,
    exam_mode: bool = False,
    model_override: Optional[str] = None,
    json_mode: bool = False,
    reasoning_effort: Optional[str] = None,
    max_retries: int = 2,
):
    """
    Unified LLM provider factory for English Coach AI services.
    Supports OpenRouter and direct OpenAI-compatible endpoints.
    In exam_mode=True, missing credentials or configuration raises an explicit LLMConfigurationError.
    Rejects unapproved model_override values with ValueError before any API call.
    """
    validated_override = validate_model_override(model_override)

    api_key = os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key or not api_key.strip():
        if exam_mode:
            raise LLMConfigurationError("Exam scoring requires configured LLM API credentials (OPENROUTER_API_KEY or OPENAI_API_KEY).")
        return None

    try:
        from langchain_openai import ChatOpenAI

        base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
        model = validated_override or os.getenv("DEFAULT_MODEL", "google/gemini-2.0-flash-001").strip()

        model_kwargs = {}
        if json_mode:
            model_kwargs["response_format"] = {"type": "json_object"}

        extra_body = {}
        if reasoning_effort:
            extra_body["reasoning"] = {"effort": reasoning_effort}

        init_kwargs = {
            "api_key": api_key.strip(),
            "base_url": base_url if base_url else "https://openrouter.ai/api/v1",
            "model": model if model else "google/gemini-2.0-flash-001",
            "temperature": temperature,
            "max_tokens": max_tokens,
            "timeout": timeout,
            "max_retries": max_retries,
        }
        if model_kwargs:
            init_kwargs["model_kwargs"] = model_kwargs
        if extra_body:
            init_kwargs["extra_body"] = extra_body

        return ChatOpenAI(**init_kwargs)
    except Exception as exc:
        logger.error(f"Failed to initialize ChatOpenAI: {exc}")
        if exam_mode:
            raise LLMConfigurationError(f"Failed to instantiate Exam LLM provider: {exc}") from exc
        return None
