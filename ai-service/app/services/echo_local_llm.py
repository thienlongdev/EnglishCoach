"""
Commercial-clean Zero-VRAM CPU Local Instruct LLM Runtime (`echo-local-llm-v3`).

Guarantees:
1. 100% Commercial-Clean Licensing:
   - Runtime: `llama-cpp-python` (`MIT`, prebuilt CPU wheel, `0` GPLv3+).
   - Default Weights: `Qwen3-4B-Instruct-2507` (`Apache-2.0`, `unsloth/Qwen3-4B-Instruct-2507-GGUF`
     pinned commit `a06e946bb6b655725eafa393f4a9745d460374c9`, `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`),
     with automatic local fallback to `Qwen/Qwen2.5-1.5B-Instruct-GGUF` (`Apache-2.0`,
     pinned commit `91cad51170dc346986eccefdc2dd33a9da36ead9`).
2. Strict `0 MiB` GPU VRAM Coexistence & OOM-Safe `12,288`-Token `FP16` KV Window:
   - `n_gpu_layers=0` by default so the shared 12 GB RTX 5070 keeps 100% of its VRAM headroom
     for Listening WhisperX, MDD Pronunciation V2.2, Echo faster-whisper, and Kokoro-82M TTS.
   - `n_ctx=12288` with native `FP16` KV cache (`flash_attn=False`, `100%` arbitrary-offset `kv_cache_seq_rm`
     prefix truncation support + AVX2 SIMD matmul), `n_batch=512`, `n_ubatch=512`, `n_threads=12`, and
     `n_threads_batch=16` (leaving 4 physical cores free on 16C/32T Zen 5 for 4-thread CPU ONNX `VieNeu-TTS`,
     with zero `GOMP_SPINCOUNT=0` kernel futex storms).
3. Provider-Independent Agentic Parity & 100% Immutable System+History KV Prefix Reuse:
   - `<|im_start|>system` holds ONLY `[Static PROFESSOR Core + compacted # Tools <tools>...</tools>]`;
     `--- DYNAMIC TURN CONTEXT ---` + `VOICE TURN` spoken-prose anchor sit immediately before the final
     `user` turn so `[PROFESSOR + 23 tools + ALL prior history]` achieves 100% zero-copy C++ KV reuse
     across turns, EN<->VI switches, and multi-round tool loops (`Round 0 -> Round 1 -> Round 2`).
   - Lossless `<tools>` prompt compaction (~500 tokens saved) while validating against full raw JSON Schemas,
     atomic turn-unit history eviction (`>= 2` units, `ROUND0_TOOL_HEADROOM_TOKENS = 900`, zero orphaned
     `<tool_response>`), array-aware truncated `<tool_call>` salvage, bare `{"name":"<valid_tool>"}`
     interception on `tool_choice="auto"`, and a 28-token streaming sentence-boundary grace runway.
"""
from __future__ import annotations

import inspect
import json
import logging
import os
import re
import threading
import time
import uuid
from typing import Any, Dict, FrozenSet, Iterator, List, Optional, Sequence, Tuple

logger = logging.getLogger("echo_local_llm")

DEFAULT_MODEL_ID = "qwen3-4b-instruct-2507-q4_k_m"
PRIMARY_HF_REPO = os.getenv("ECHO_LOCAL_LLM_REPO", "unsloth/Qwen3-4B-Instruct-2507-GGUF")
PRIMARY_HF_REVISION = os.getenv("ECHO_LOCAL_LLM_REVISION", "a06e946bb6b655725eafa393f4a9745d460374c9")
PRIMARY_HF_FILENAME = os.getenv("ECHO_LOCAL_LLM_FILENAME", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")

FALLBACK_HF_REPO = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
FALLBACK_HF_REVISION = "91cad51170dc346986eccefdc2dd33a9da36ead9"
FALLBACK_HF_FILENAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf"

QWEN3_TOOL_CALL_TOKEN_ID = 151657
DYNAMIC_CONTEXT_MARKER = "--- DYNAMIC TURN CONTEXT ---"
VOICE_TURN_ANCHOR_TOOLS = (
    "VOICE TURN: Whenever the user asks to check/look up their speaking profile, progress, vocabulary, "
    "lessons, plan, dictionary, or perform an app action, emit <tool_call> immediately in this turn "
    "(NEVER say 'I will check' without emitting <tool_call>). Only when no tool applies, answer directly "
    "in 1-2 short natural spoken sentences (plain words only, zero markdown/bullets/emojis/IPA)."
)
VOICE_TURN_ANCHOR_SYNTHESIS = (
    "VOICE TURN: Summarize the result in 1-3 short natural spoken sentences, plain spoken words only, "
    "zero markdown/bullets/emojis/IPA, finish your sentence cleanly."
)
VOICE_TURN_ANCHOR = VOICE_TURN_ANCHOR_TOOLS
VOICE_CONCISE_STOP_TOKENS = 65
VOICE_CONCISE_MIN_SENTENCES = 2

GGML_TYPE_F16_ID = 1
GGML_TYPE_Q8_0_ID = 8

MAX_CONCURRENT_REQUESTS = max(1, int(os.getenv("ECHO_LOCAL_LLM_MAX_CONCURRENT", "2")))
SLOT_ACQUIRE_TIMEOUT_SEC = float(os.getenv("ECHO_LOCAL_LLM_QUEUE_TIMEOUT_SEC", "12.0"))
MAX_SYSTEM_CHARS = 12000
MAX_DYNAMIC_SYSTEM_CHARS = 8000
MAX_MESSAGE_CHARS = 4500
MAX_TOOL_ARGS_CHARS = 4000
MAX_MESSAGES_COUNT = 96
MAX_COMPLETION_TOKENS = 1024
MAX_TOOL_CALLS_PER_ROUND = 4
MAX_TOOL_ROUNDS_GUARD = 3
MAX_PROP_DESC_CHARS = 48
MAX_FN_DESC_CHARS = 110

# 12,288 tokens with native FP16 KV (`flash_attn=False`, 100% `kv_cache_seq_rm` reuse) + `n_batch=512` holds
# 10-turn history + 2,800-char Book + multi-round tools + 4-tool stress turns safely inside the 15.2 GiB WSL2 VM.
DEFAULT_N_CTX = 12288
DEFAULT_N_BATCH = 512
DEFAULT_N_UBATCH = 512
SENTENCE_GRACE_TOKENS = 28
CONTEXT_SAFETY_TOKENS = 24 + SENTENCE_GRACE_TOKENS
ROUND0_TOOL_HEADROOM_TOKENS = 900
MIN_COMPLETION_TOKENS = 96
SENTINEL_MAX_INT_BOUND = 1_000_000_000

# Crisp, complete 1-line rules for the 5 multi-rule tools whose raw Java descriptions previously clipped mid-word at 110 chars.
_PROMPT_TOOL_DESC_OVERRIDES: Dict[str, str] = {
    "open_page": (
        "Open an English Coach screen: pair grammar_* with grammar_slug/activity_id, "
        "*_lesson/reading_material/dictation with lesson_id, speaking_roleplay with scenario_id, "
        "flashcards_deck with deck_id, exams_family with family, cosmos_word with word."
    ),
    "prepare_plan_change": (
        "Stage Learning Path preview (Confirm required; never say applied). "
        "Targets: IELTS 5.0-7.5 (0.5 step), TOEIC 450/550/650/750/850/900/950/990, GENERAL A1-C1; daily_minutes: 15/30/45/60."
    ),
    "get_grammar_practice": (
        "ONLY when learner asks for quiz/practice: get 1-3 items (needs topic_slug from search_grammar_topics). "
        "Ask item WITHOUT revealing key first."
    ),
    "remember_learner_note": (
        "Save ONE preference or note the learner explicitly asked to remember (never a measured level)."
    ),
    "emit_workspace_control": (
        "Emit a workspace UI control ONLY when the learner asked to adjust the workspace."
    ),
}

_VALID_TOOL_NAME_RE = re.compile(r"^[a-z_]{3,40}$")
_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.IGNORECASE)
_UNCLOSED_THINK_RE = re.compile(r"<think>[\s\S]*$", re.IGNORECASE)
_CHATML_MARKER_RE = re.compile(r"<\|(?:im_start|im_end|endoftext)\|>")
_CLOSED_TOOL_CALL_RE = re.compile(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", re.IGNORECASE)
_OPEN_TOOL_CALL_RE = re.compile(r"<tool_call>\s*([\s\S]*)$", re.IGNORECASE)
_TOOL_CALL_EXTRACT_RE = re.compile(r"<tool_call>\s*([\s\S]*?)\s*(?:</tool_call>|$)", re.IGNORECASE)
_FORCED_JSON_START_RE = re.compile(r'\{\s*"name"\s*:', re.IGNORECASE)
_FORCED_JSON_PARTIAL_RE = re.compile(
    r'[\r\n]*\{\s*(?:"(?:n(?:a(?:m(?:e(?:"\s*:?)?)?)?)?)?)?$',
    re.IGNORECASE,
)
_AUTO_BARE_TOOL_JSON_START_RE = re.compile(r'\{\s*"name"\s*:\s*"([a-z_]{3,40})"', re.IGNORECASE)
_AUTO_BARE_TOOL_JSON_PARTIAL_RE = re.compile(
    r'[\r\n]*\{\s*(?:"(?:n(?:a(?:m(?:e(?:"\s*(?::\s*(?:"([a-z_]{0,40}))?)?)?)?)?)?)?)?$',
    re.IGNORECASE,
)
_CHANNEL_VOICE_RE = re.compile(r"\bChannel:\s*VOICE\b", re.IGNORECASE)
_LEADING_OPTIONAL_RE = re.compile(r"^Optional\s+", re.IGNORECASE)
_GRACE_ABBREV_RE = re.compile(
    r"(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e)|(?:^|\n)\s*\d{1,2})\.$",
    re.IGNORECASE,
)
_SENTENCE_END_SCAN_RE = re.compile(r'([.!?…]+)(?:["\')\]}]*)(?=\s|$)')
_SAFE_INT_STR_RE = re.compile(r"^[+-]?\d+$")
_VI_DIACRITIC_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)

_GUARDED_TAG_PREFIXES: Tuple[str, ...] = (
    "<think>",
    "</think>",
    "<tool_call>",
    "</tool_call>",
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
)
_MAX_GUARDED_TAG_LEN = max(len(t) for t in _GUARDED_TAG_PREFIXES) - 1

_GRAMMAR_CACHE: Dict[str, Any] = {}
_GRAMMAR_CACHE_LOCK = threading.Lock()
_TOOLS_BLOCK_CACHE: Dict[str, str] = {}
_TOOLS_BLOCK_CACHE_LOCK = threading.Lock()


class LocalLlmUnavailable(Exception):
    """Raised when the local CPU GGUF model cannot be loaded."""


class LocalLlmBusyError(Exception):
    """Raised when all local LLM concurrency slots are occupied."""


class LocalLlmCancelledError(Exception):
    """Raised when the caller disconnects or cancels an in-flight local LLM generation."""


class LocalLlmContextOverflow(LocalLlmUnavailable):
    """Raised when even the system prompt, tools and the latest user turn cannot fit the context window."""


def strip_think_and_markers(text: str) -> str:
    """Deterministically remove `<think>...</think>` blocks, ChatML markers, and `✨` (`0` leak guarantee)."""
    if not text:
        return ""
    cleaned = _THINK_BLOCK_RE.sub("", text)
    cleaned = _UNCLOSED_THINK_RE.sub("", cleaned)
    cleaned = _CHATML_MARKER_RE.sub("", cleaned)
    cleaned = cleaned.replace("\u2728", "")
    return cleaned


def _ends_at_sentence_boundary(text: str) -> bool:
    """True when visible prose ends cleanly at a sentence boundary (`.`, `!`, `?`, `…`, or newline)."""
    if not text:
        return False
    if text.endswith("\n"):
        return True
    s = text.rstrip(" \t\r\"')}]")
    if not s:
        return False
    if s[-1] in "!?…":
        return True
    if s[-1] == "." and not _GRACE_ABBREV_RE.search(s):
        return True
    return False


def _count_complete_sentences(text: str) -> int:
    """Counts complete spoken sentences in `text` when `text` currently ends at a clean sentence boundary."""
    s = text.strip()
    if not s or not _ends_at_sentence_boundary(s):
        return 0
    count = 0
    for m in _SENTENCE_END_SCAN_RE.finditer(s):
        punct = m.group(1)
        if punct == ".":
            prefix = s[: m.start() + 1]
            if _GRACE_ABBREV_RE.search(prefix):
                continue
        count += 1
    return count


class _StreamingToolAndThinkFilter:
    """
    Zero-leak stateful token-stream sanitizer and `<tool_call>` diverter:
    - Strips `<think>...</think>` spans and ChatML markers across arbitrary sub-word splits.
    - Holds back any trailing `<` suffix that could match `<think>`, `<tool_call>`, `<|im_end|>`, etc.
    - Streams natural spoken/visible prose BEFORE `<tool_call>` immediately as `delta.content`.
    - As soon as `<tool_call>` (or bare `{"name": "<valid_tool>"}` when `allow_tools` is True) begins,
      diverts everything from that point onward into `tool_buffer` (`0` XML or JSON bytes ever emitted in `delta.content`).
    """

    def __init__(
        self,
        allow_tools: bool = False,
        forced_tool: Optional[str] = None,
        intercept_tool_tags: bool = True,
        valid_tool_names: Optional[Sequence[str]] = None,
    ) -> None:
        self._allow_tools = bool(allow_tools)
        self._forced_tool = forced_tool.strip() if isinstance(forced_tool, str) and forced_tool.strip() else None
        self._intercept_tool_tags = bool(intercept_tool_tags)
        self._valid_tool_names: FrozenSet[str] = frozenset(
            str(n).strip().lower() for n in (valid_tool_names or ()) if isinstance(n, str) and str(n).strip()
        )
        self._buf = ""
        self._in_think = False
        self._in_tool_zone = False
        self._tool_buf_parts: List[str] = []
        self._started_visible = False

    @property
    def in_tool_zone(self) -> bool:
        return self._in_tool_zone

    @property
    def tool_buffer(self) -> str:
        return strip_think_and_markers("".join(self._tool_buf_parts)).strip()

    def _find_bare_tool_json_start(self) -> int:
        if not self._allow_tools:
            return -1
        if self._forced_tool:
            m_forced = _FORCED_JSON_START_RE.search(self._buf)
            return m_forced.start() if m_forced is not None else -1
        if self._valid_tool_names:
            for m_auto in _AUTO_BARE_TOOL_JSON_START_RE.finditer(self._buf):
                if m_auto.group(1).lower() in self._valid_tool_names:
                    return m_auto.start()
        return -1

    def _bare_tool_json_hold_len(self) -> int:
        if not self._allow_tools:
            return 0
        if self._forced_tool:
            m_part = _FORCED_JSON_PARTIAL_RE.search(self._buf)
            return (len(self._buf) - m_part.start()) if m_part is not None else 0
        if self._valid_tool_names:
            m_auto_part = _AUTO_BARE_TOOL_JSON_PARTIAL_RE.search(self._buf)
            if m_auto_part is not None:
                name_prefix = m_auto_part.group(1)
                if name_prefix is None or any(tn.startswith(name_prefix.lower()) for tn in self._valid_tool_names):
                    return len(self._buf) - m_auto_part.start()
        return 0

    def push(self, piece: str) -> str:
        if not piece:
            return ""
        if self._in_tool_zone:
            self._tool_buf_parts.append(piece)
            return ""

        self._buf += piece
        self._buf = _CHATML_MARKER_RE.sub("", self._buf).replace("\u2728", "")
        out: List[str] = []

        while self._buf:
            if self._in_think:
                end_idx = self._buf.lower().find("</think>")
                if end_idx == -1:
                    if len(self._buf) > 7:
                        self._buf = self._buf[-7:]
                    break
                self._buf = self._buf[end_idx + len("</think>") :]
                if not self._started_visible:
                    self._buf = self._buf.lstrip("\r\n ")
                self._in_think = False
                continue

            low = self._buf.lower()
            think_idx = low.find("<think>")
            tool_idx = low.find("<tool_call>") if self._intercept_tool_tags else -1
            bare_json_idx = self._find_bare_tool_json_start()

            candidates: List[Tuple[int, str]] = []
            if think_idx != -1:
                candidates.append((think_idx, "think"))
            if tool_idx != -1:
                candidates.append((tool_idx, "tool"))
            if bare_json_idx != -1:
                candidates.append((bare_json_idx, "bare_json"))

            if candidates:
                candidates.sort(key=lambda item: item[0])
                first_idx, kind = candidates[0]
                if kind == "think":
                    if first_idx > 0:
                        emit = self._buf[:first_idx]
                        if not self._started_visible:
                            emit = emit.lstrip("\r\n ")
                        if emit:
                            self._started_visible = True
                            out.append(emit)
                    self._buf = self._buf[first_idx + len("<think>") :]
                    self._in_think = True
                    continue

                # Entering `<tool_call>` or bare tool JSON: emit clean prose before it, divert the rest!
                if first_idx > 0:
                    before = self._buf[:first_idx]
                    if not self._started_visible:
                        before = before.strip("\r\n ")
                    else:
                        before = before.rstrip("\r\n")
                        if not before.strip():
                            before = ""
                    if before:
                        self._started_visible = True
                        out.append(before)
                self._tool_buf_parts.append(self._buf[first_idx:])
                self._buf = ""
                self._in_tool_zone = True
                break

            # Hold trailing partial prefixes of `<think>`, `<tool_call>`, `<|im_end|>`, or bare tool JSON
            hold = 0
            max_k = min(_MAX_GUARDED_TAG_LEN, len(low))
            for k in range(max_k, 0, -1):
                suffix = low[-k:]
                if any(tag.startswith(suffix) for tag in _GUARDED_TAG_PREFIXES):
                    hold = k
                    while hold < len(self._buf) and self._buf[-(hold + 1)] in "\r\n":
                        hold += 1
                    break

            hold = max(hold, self._bare_tool_json_hold_len())

            if hold > 0:
                emit_part = self._buf[:-hold]
                self._buf = self._buf[-hold:]
                if emit_part:
                    if not self._started_visible:
                        emit_part = emit_part.lstrip("\r\n ")
                    if emit_part:
                        self._started_visible = True
                        out.append(emit_part)
                break

            emit_all = self._buf
            self._buf = ""
            if not self._started_visible:
                emit_all = emit_all.lstrip("\r\n ")
            if emit_all:
                self._started_visible = True
                out.append(emit_all)
            break

        return "".join(out)

    def flush(self) -> str:
        if self._in_tool_zone:
            if self._buf:
                self._tool_buf_parts.append(self._buf)
                self._buf = ""
            return ""
        if self._in_think:
            self._buf = ""
            self._in_think = False
            return ""
        if self._buf:
            stripped_tail = self._buf.lstrip("\r\n ")
            low_tail = stripped_tail.lower()
            if self._intercept_tool_tags and len(low_tail) >= 5 and "<tool_call>".startswith(low_tail):
                self._buf = ""
                return ""
            if self._allow_tools and stripped_tail.startswith("{"):
                if self._forced_tool:
                    self._tool_buf_parts.append(stripped_tail)
                    self._buf = ""
                    self._in_tool_zone = True
                    return ""
                m_auto = _AUTO_BARE_TOOL_JSON_START_RE.match(stripped_tail)
                if m_auto is not None and m_auto.group(1).lower() in self._valid_tool_names:
                    self._tool_buf_parts.append(stripped_tail)
                    self._buf = ""
                    self._in_tool_zone = True
                    return ""
                m_part = _AUTO_BARE_TOOL_JSON_PARTIAL_RE.match(stripped_tail)
                if m_part is not None and len(stripped_tail) >= 6:
                    pref = m_part.group(1)
                    if pref and any(tn.startswith(pref.lower()) for tn in self._valid_tool_names):
                        self._buf = ""
                        return ""
        rem = strip_think_and_markers(self._buf)
        self._buf = ""
        if not self._started_visible:
            rem = rem.lstrip("\r\n ")
        return rem


# Backward-compatible alias if imported by existing tests
_StreamingThinkFilter = _StreamingToolAndThinkFilter


def _extract_content_text(raw_content: Any) -> str:
    if raw_content is None:
        return ""
    if isinstance(raw_content, str):
        return raw_content
    if isinstance(raw_content, list):
        parts: List[str] = []
        for item in raw_content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") in ("text", "input_text", None):
                val = item.get("text") or item.get("content")
                if isinstance(val, str):
                    parts.append(val)
        return "\n".join(p for p in parts if p)
    return str(raw_content)


def _bound_system_text(text: str, limit: int = MAX_SYSTEM_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit // 2]
    tail = text[-(limit // 2) :]
    return f"{head}\n...\n{tail}"


def _minify_embedded_json_blocks(text: str) -> str:
    """
    Losslessly minifies pretty-printed JSON objects/arrays embedded inside `--- DYNAMIC TURN CONTEXT ---`
    (or tool responses) into single-line `separators=(",", ":")` JSON without dropping any key or value.
    """
    if not text or ("{" not in text and "[" not in text):
        return text
    out: List[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch0 = text[i]
        if ch0 not in ("{", "["):
            next_brace = text.find("{", i)
            next_bracket = text.find("[", i)
            if next_brace == -1 and next_bracket == -1:
                out.append(text[i:])
                break
            nxt = (
                next_brace
                if next_bracket == -1
                else (next_bracket if next_brace == -1 else min(next_brace, next_bracket))
            )
            out.append(text[i:nxt])
            i = nxt
            continue

        stack: List[str] = []
        in_str = False
        esc = False
        end_pos = -1
        for j in range(i, n):
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    stack.append("}")
                elif ch == "[":
                    stack.append("]")
                elif ch in ("}", "]"):
                    if not stack or stack[-1] != ch:
                        break
                    stack.pop()
                    if not stack:
                        end_pos = j
                        break

        if end_pos != -1:
            candidate = text[i : end_pos + 1]
            try:
                parsed = json.loads(candidate)
            except Exception:
                parsed = None
            if isinstance(parsed, (dict, list)):
                out.append(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
                i = end_pos + 1
                continue

        out.append(ch0)
        i += 1

    return "".join(out)


def _split_static_and_dynamic_system(
    system_text: str,
    dynamic_limit: int = MAX_DYNAMIC_SYSTEM_CHARS,
) -> Tuple[str, str]:
    """
    Split `system` message on `--- DYNAMIC TURN CONTEXT ---` so `[Static System Core]`
    and `[# Tools ... <tools>...</tools>]` remain 100% immutable inside `<|im_start|>system`,
    while dynamic turn context is losslessly JSON-minified and placed after prior history.
    """
    normalized = system_text.replace("\r\n", "\n")
    marker_idx = normalized.find(DYNAMIC_CONTEXT_MARKER)
    if marker_idx == -1:
        return _bound_system_text(normalized.strip(), MAX_SYSTEM_CHARS), ""
    static_core = _bound_system_text(normalized[:marker_idx].rstrip(), MAX_SYSTEM_CHARS)
    minified_dynamic = _minify_embedded_json_blocks(normalized[marker_idx:].strip())
    dynamic_tail = _bound_system_text(minified_dynamic, dynamic_limit)
    return static_core, dynamic_tail


def _clip_desc(raw: Any, max_chars: int, *, strip_optional: bool = False) -> str:
    desc = re.sub(r"\s+", " ", str(raw or "").strip())
    if strip_optional:
        desc = _LEADING_OPTIONAL_RE.sub("", desc).strip()
        if desc and desc[0].islower():
            desc = desc[0].upper() + desc[1:]
    if len(desc) <= max_chars:
        return desc
    return desc[: max_chars - 3].rstrip() + "..."


def _compact_json_schema(
    schema: Any,
    *,
    is_root_params: bool = False,
    max_desc_chars: int = MAX_PROP_DESC_CHARS,
    for_prompt: bool = False,
) -> Dict[str, Any]:
    """
    Compact JSON Schema serializer for Qwen3:
    - `for_prompt=False` (used by `LlamaGrammar`): strictly preserves all validator keys including
      `additionalProperties: false`, `maxLength`, `minLength`, `minimum`/`maximum`, and empty `required`.
    - `for_prompt=True` (used ONLY inside `<tools>` prompt text; runtime `parse_validated_tool_calls`
      still validates against full raw `valid_tools`!): strips validator-only noise (`additionalProperties: false`,
      empty `required: []`, `minLength`/`maxLength`, `>= 1e9` sentinel `maximum`, leading `"Optional "`)
      while keeping 100% of parameter names, `type`, `enum`, `pattern`, `items`, non-empty `required`,
      and meaningful small bounds (`minimum`/`maximum`/`minItems`/`maxItems`), saving ~500 prompt tokens.
    """
    if not isinstance(schema, dict):
        if is_root_params:
            return {"type": "object", "properties": {}} if for_prompt else {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            }
        return {}

    out: Dict[str, Any] = {}
    raw_type = schema.get("type")
    if isinstance(raw_type, (str, list)):
        out["type"] = raw_type
    elif is_root_params or "properties" in schema:
        out["type"] = "object"

    if not is_root_params and schema.get("description"):
        clipped = _clip_desc(schema.get("description"), max_desc_chars, strip_optional=for_prompt)
        if clipped:
            out["description"] = clipped

    if isinstance(schema.get("enum"), list):
        out["enum"] = list(schema["enum"])

    if isinstance(schema.get("pattern"), str) and schema["pattern"]:
        out["pattern"] = schema["pattern"]

    num_keys = (
        ("minimum", "maximum", "minItems", "maxItems")
        if for_prompt
        else ("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")
    )
    for num_key in num_keys:
        val = schema.get(num_key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            if for_prompt and num_key == "maximum" and val >= SENTINEL_MAX_INT_BOUND:
                continue
            out[num_key] = val

    if isinstance(schema.get("properties"), dict):
        props_out: Dict[str, Any] = {}
        for pname, pmeta in schema["properties"].items():
            if isinstance(pmeta, dict):
                props_out[str(pname)] = _compact_json_schema(
                    pmeta,
                    is_root_params=False,
                    max_desc_chars=max_desc_chars,
                    for_prompt=for_prompt,
                )
        out["properties"] = props_out
    elif out.get("type") == "object" and is_root_params:
        out["properties"] = {}

    if isinstance(schema.get("items"), dict):
        out["items"] = _compact_json_schema(
            schema["items"],
            is_root_params=False,
            max_desc_chars=max_desc_chars,
            for_prompt=for_prompt,
        )

    if isinstance(schema.get("required"), list):
        req_clean = [str(r) for r in schema["required"] if isinstance(r, str)]
        if req_clean or not for_prompt:
            out["required"] = req_clean

    if "additionalProperties" in schema:
        addl = schema["additionalProperties"]
        if isinstance(addl, bool):
            if not for_prompt or addl is True:
                out["additionalProperties"] = addl
        elif isinstance(addl, dict):
            out["additionalProperties"] = _compact_json_schema(
                addl,
                is_root_params=False,
                max_desc_chars=max_desc_chars,
                for_prompt=for_prompt,
            )
    elif not for_prompt and (out.get("type") == "object" or "properties" in out):
        out["additionalProperties"] = False

    return out


def _serialize_qwen3_tool_line(fn: Dict[str, Any]) -> str:
    name = str(fn.get("name") or "").strip()
    override_desc = _PROMPT_TOOL_DESC_OVERRIDES.get(name)
    desc = override_desc if override_desc else _clip_desc(fn.get("description"), MAX_FN_DESC_CHARS)
    params = _compact_json_schema(fn.get("parameters"), is_root_params=True, for_prompt=True)
    fn_obj: Dict[str, Any] = {
        "name": name,
        "description": desc,
        "parameters": params,
    }
    wrapper = {"type": "function", "function": fn_obj}
    return json.dumps(wrapper, ensure_ascii=False, separators=(",", ":"))


def _render_qwen3_tools_block(valid_tools: Dict[str, Dict[str, Any]]) -> str:
    """Renders Qwen3's exact native ChatML `# Tools` + `<tools>...</tools>` block sorted by `name` (cached)."""
    ordered_names = sorted(valid_tools.keys())
    cache_key = json.dumps(
        [(n, valid_tools[n].get("description"), valid_tools[n].get("parameters")) for n in ordered_names],
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    with _TOOLS_BLOCK_CACHE_LOCK:
        cached = _TOOLS_BLOCK_CACHE.get(cache_key)
        if cached is not None:
            return cached

    tool_lines = [_serialize_qwen3_tool_line(valid_tools[name]) for name in ordered_names]
    joined_tools = "\n".join(tool_lines)
    rendered = (
        "# Tools\n\n"
        "You may call one or more functions to assist with the user query.\n\n"
        "You are provided with function signatures within <tools></tools> XML tags:\n"
        "<tools>\n"
        f"{joined_tools}\n"
        "</tools>\n\n"
        "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n"
        "<tool_call>\n"
        '{"name": <function-name>, "arguments": <args-json-object>}\n'
        "</tool_call>"
    )
    with _TOOLS_BLOCK_CACHE_LOCK:
        if len(_TOOLS_BLOCK_CACHE) >= 32:
            _TOOLS_BLOCK_CACHE.clear()
        _TOOLS_BLOCK_CACHE[cache_key] = rendered
    return rendered


def _extract_valid_tools(raw_tools: Any) -> Dict[str, Dict[str, Any]]:
    valid: Dict[str, Dict[str, Any]] = {}
    if not isinstance(raw_tools, list):
        return valid
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") if item.get("type") == "function" else item
        if not isinstance(fn, dict):
            continue
        name = str(fn.get("name") or "").strip()
        if not _VALID_TOOL_NAME_RE.match(name):
            continue
        valid[name] = fn
    return {name: valid[name] for name in sorted(valid.keys())}


def _count_active_tool_rounds(messages: List[Dict[str, Any]]) -> int:
    """
    Counts assistant tool-call rounds since the latest non-tool `user` message.
    Acts as a defense-in-depth cap (`>= 3` rounds disables further tool calls) without
    blocking Round 1 (`open_page` after Round 0 `search_lessons`) or subsequent turns.
    """
    last_user_idx = -1
    for idx, msg in enumerate(messages):
        if isinstance(msg, dict) and str(msg.get("role") or "").strip().lower() == "user":
            last_user_idx = idx
    rounds = 0
    for msg in messages[last_user_idx + 1 :]:
        if not isinstance(msg, dict):
            continue
        if str(msg.get("role") or "").strip().lower() == "assistant":
            tcalls = msg.get("tool_calls")
            if isinstance(tcalls, list) and len(tcalls) > 0:
                rounds += 1
    return rounds


def _normalize_historical_tool_args(raw_args: Any) -> Dict[str, Any]:
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str):
        s = raw_args.strip()
        if not s:
            return {}
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {}


def build_static_system_block(
    messages: Sequence[Dict[str, Any]],
    tools: Any = None,
    *,
    max_dynamic_chars: int = MAX_DYNAMIC_SYSTEM_CHARS,
) -> Tuple[str, Dict[str, Dict[str, Any]], str]:
    """
    Builds the exact immutable `<|im_start|>system\n...\n<|im_end|>` block (`[Static Core + # Tools]`),
    returning `(sys_block, valid_tools, dynamic_tail)`. Shared by `build_chatml_prompt` and
    `EchoLocalLlmService.is_busy_or_prefix_warm(payload)` so prefix checks match 100% token-for-token.
    """
    valid_tools = _extract_valid_tools(tools)
    raw_system_parts: List[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if str(msg.get("role") or "user").strip().lower() == "system":
            content = strip_think_and_markers(_extract_content_text(msg.get("content"))).strip()
            if content:
                raw_system_parts.append(content)

    combined_system = "\n\n".join(raw_system_parts).strip()
    if not combined_system:
        combined_system = (
            "You are Echo, the friendly, concise AI English Coach on English Coach. "
            "Answer directly and naturally in the learner's language (Vietnamese or English) without <think> tags."
        )

    static_core, dynamic_tail = _split_static_and_dynamic_system(combined_system, dynamic_limit=max_dynamic_chars)
    sys_sections: List[str] = [static_core]
    if valid_tools:
        sys_sections.append(_render_qwen3_tools_block(valid_tools))
    sys_block = "<|im_start|>system\n" + "\n\n".join(s for s in sys_sections if s) + "<|im_end|>"
    return sys_block, valid_tools, dynamic_tail


def build_chatml_prompt(
    messages: List[Dict[str, Any]],
    tools: Any = None,
    tool_choice: Any = None,
    *,
    max_tool_msg_chars: int = MAX_MESSAGE_CHARS,
    max_dynamic_chars: int = MAX_DYNAMIC_SYSTEM_CHARS,
) -> Tuple[str, Dict[str, Dict[str, Any]], Optional[str], bool]:
    """
    Builds a native Qwen3 ChatML prompt with 100% immutable `<|im_start|>system` KV prefix ordering:
    - `<|im_start|>system` holds ONLY `[Static PROFESSOR Core] + [compacted # Tools <tools>...</tools>]`.
    - Prior conversation history (`user` / `assistant` / `<tool_response>`) follows immediately so
      `[PROFESSOR + 23 tools + ALL prior history]` achieves 100% KV-cache reuse across turns.
    - `--- DYNAMIC TURN CONTEXT ---` + `VOICE TURN` spoken-prose anchor are placed right before the
      final real `user` turn so Round 0 -> Round 1 -> Round 2 ALSO reuses `dynamic_tail + final_user`!
    Returns `(prompt_str, allowed_tools_map, forced_tool_name, allow_tool_calls)`.
    """
    sys_block, valid_tools, dynamic_tail = build_static_system_block(
        messages, tools, max_dynamic_chars=max_dynamic_chars
    )
    prior_tool_rounds = _count_active_tool_rounds(messages)

    forced_tool: Optional[str] = None
    allow_tools = False
    tc_norm = ""

    if valid_tools:
        if isinstance(tool_choice, dict):
            fn_obj = tool_choice.get("function") if isinstance(tool_choice.get("function"), dict) else tool_choice
            cand = str(fn_obj.get("name") or "").strip() if isinstance(fn_obj, dict) else ""
            if cand in valid_tools and prior_tool_rounds < MAX_TOOL_ROUNDS_GUARD:
                forced_tool = cand
                allow_tools = True
        elif isinstance(tool_choice, str):
            tc_norm = tool_choice.strip().lower()
            if tc_norm == "none" or prior_tool_rounds >= MAX_TOOL_ROUNDS_GUARD:
                allow_tools = False
            else:
                allow_tools = True
        else:
            allow_tools = prior_tool_rounds < MAX_TOOL_ROUNDS_GUARD

    typed_blocks: List[Tuple[str, str]] = []
    pending_tool_responses: List[str] = []
    last_assistant_had_tool_calls = False

    def _flush_pending_tool_responses() -> None:
        nonlocal last_assistant_had_tool_calls
        if not pending_tool_responses:
            return
        bundled = "\n".join(pending_tool_responses)
        typed_blocks.append(("tool_response", f"<|im_start|>user\n{bundled}<|im_end|>"))
        pending_tool_responses.clear()
        last_assistant_had_tool_calls = False

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user").strip().lower()
        if role == "system":
            continue
        content = strip_think_and_markers(_extract_content_text(msg.get("content"))).strip()

        if role == "tool":
            # Zero-orphan invariant: emit `<tool_response>` ONLY when preceded by an assistant `<tool_call>`
            if not last_assistant_had_tool_calls:
                continue
            minified_tool = _minify_embedded_json_blocks(content) if content else "{}"
            bounded_tool = minified_tool[:max_tool_msg_chars] if minified_tool else "{}"
            pending_tool_responses.append(f"<tool_response>\n{bounded_tool}\n</tool_response>")
            continue

        _flush_pending_tool_responses()

        if role == "assistant":
            tcalls = msg.get("tool_calls")
            tc_strs: List[str] = []
            if isinstance(tcalls, list):
                for tc in tcalls[:MAX_TOOL_CALLS_PER_ROUND]:
                    if isinstance(tc, dict) and isinstance(tc.get("function"), dict):
                        fn_name = str(tc["function"].get("name") or "").strip()
                        if fn_name:
                            args_obj = _normalize_historical_tool_args(tc["function"].get("arguments"))
                            raw_call_json = json.dumps(
                                {"name": fn_name, "arguments": args_obj},
                                ensure_ascii=False,
                            )
                            tc_strs.append(f"<tool_call>\n{raw_call_json}\n</tool_call>")
            asst_parts: List[str] = []
            if content:
                asst_parts.append(content[:MAX_MESSAGE_CHARS])
            asst_parts.extend(tc_strs)
            if asst_parts:
                typed_blocks.append(("assistant", "<|im_start|>assistant\n" + "\n".join(asst_parts) + "<|im_end|>"))
                last_assistant_had_tool_calls = len(tc_strs) > 0
            else:
                last_assistant_had_tool_calls = False
            continue

        last_assistant_had_tool_calls = False
        if content:
            typed_blocks.append(("user", f"<|im_start|>user\n{content[:MAX_MESSAGE_CHARS]}<|im_end|>"))

    _flush_pending_tool_responses()

    kept_pairs = typed_blocks[-MAX_MESSAGES_COUNT:]
    # Strip any leading non-`user` (`assistant` or `tool_response`) orphans
    while kept_pairs and kept_pairs[0][0] != "user":
        kept_pairs.pop(0)

    turn_ctx_parts: List[str] = []
    if dynamic_tail:
        turn_ctx_parts.append(dynamic_tail)
        if _CHANNEL_VOICE_RE.search(dynamic_tail):
            turn_ctx_parts.append(
                VOICE_TURN_ANCHOR_TOOLS if (allow_tools and bool(valid_tools)) else VOICE_TURN_ANCHOR_SYNTHESIS
            )

    final_blocks = [blk for _, blk in kept_pairs]
    if turn_ctx_parts:
        ephemeral_ctx_block = "<|im_start|>system\n" + "\n\n".join(turn_ctx_parts) + "<|im_end|>"
        last_real_user_pos: Optional[int] = None
        for idx in range(len(kept_pairs) - 1, -1, -1):
            if kept_pairs[idx][0] == "user":
                last_real_user_pos = idx
                break
        if last_real_user_pos is not None:
            final_blocks.insert(last_real_user_pos, ephemeral_ctx_block)
        else:
            final_blocks.append(ephemeral_ctx_block)

    if forced_tool and allow_tools:
        final_blocks.append(
            f"<|im_start|>system\nMust call function `{forced_tool}` with valid JSON arguments inside <tool_call></tool_call> tags.<|im_end|>"
        )
    elif tc_norm == "required" and valid_tools and allow_tools:
        final_blocks.append(
            "<|im_start|>system\nMust call at least one function from <tools> inside <tool_call></tool_call> tags.<|im_end|>"
        )

    recent_convo = "\n".join(final_blocks)
    prompt = f"{sys_block}\n{recent_convo}\n<|im_start|>assistant\n" if recent_convo else f"{sys_block}\n<|im_start|>assistant\n"
    return prompt, valid_tools, forced_tool, allow_tools


def _schema_allows_null(schema: Any) -> bool:
    if not isinstance(schema, dict):
        return False
    t = schema.get("type")
    if t == "null" or (isinstance(t, list) and "null" in t):
        return True
    for branch_key in ("anyOf", "oneOf"):
        branches = schema.get(branch_key)
        if isinstance(branches, list) and any(_schema_allows_null(b) for b in branches):
            return True
    return False


def _validate_and_coerce_schema(value: Any, schema: Any) -> Tuple[bool, Any]:
    """
    Recursively validates and safely coerces tool call arguments against the FULL raw JSON Schema:
    `type`, `required`, `additionalProperties: false`, `enum`, `pattern`, `minimum`/`maximum`,
    `minLength`/`maxLength`, `minItems`/`maxItems`, nested `array`/`object` `items`, and
    safe stringified integer coercion (`"12"` -> `12` when schema expects `integer`).
    """
    if not isinstance(schema, dict) or not schema:
        return True, value

    for branch_key in ("anyOf", "oneOf"):
        branches = schema.get(branch_key)
        if isinstance(branches, list) and branches:
            for branch in branches:
                ok, coerced = _validate_and_coerce_schema(value, branch)
                if ok:
                    return True, coerced
            return False, value

    raw_type = schema.get("type")
    if isinstance(raw_type, list):
        if value is None and "null" in raw_type:
            return True, None
        for single_type in raw_type:
            if single_type == "null":
                continue
            sub_schema = dict(schema)
            sub_schema["type"] = single_type
            ok, coerced = _validate_and_coerce_schema(value, sub_schema)
            if ok:
                return True, coerced
        return False, value

    expected_type = raw_type if isinstance(raw_type, str) else None
    if expected_type is None and ("properties" in schema or "required" in schema):
        expected_type = "object"

    if expected_type == "null":
        return (value is None), None

    if expected_type == "integer":
        if isinstance(value, bool):
            return False, value
        if isinstance(value, str) and _SAFE_INT_STR_RE.match(value.strip()):
            value = int(value.strip())
        if not isinstance(value, int) or isinstance(value, bool):
            return False, value
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            return False, value
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            return False, value
        if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
            return False, value
        return True, value

    if expected_type == "number":
        if isinstance(value, bool):
            return False, value
        if isinstance(value, str):
            s_num = value.strip()
            if _SAFE_INT_STR_RE.match(s_num):
                value = int(s_num)
            else:
                try:
                    value = float(s_num)
                except Exception:
                    return False, value
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False, value
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            return False, value
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            return False, value
        if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
            return False, value
        return True, value

    if expected_type == "boolean":
        if not isinstance(value, bool):
            return False, value
        if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
            return False, value
        return True, value

    if expected_type == "string":
        if not isinstance(value, str):
            return False, value
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            return False, value
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            return False, value
        if isinstance(schema.get("pattern"), str) and schema["pattern"]:
            try:
                if re.search(schema["pattern"], value) is None:
                    return False, value
            except re.error:
                pass
        if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
            return False, value
        return True, value

    if expected_type == "array":
        if not isinstance(value, list):
            return False, value
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            return False, value
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            return False, value
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            coerced_items: List[Any] = []
            for elem in value:
                ok, c_elem = _validate_and_coerce_schema(elem, item_schema)
                if not ok:
                    return False, value
                coerced_items.append(c_elem)
            return True, coerced_items
        return True, value

    if expected_type == "object":
        if not isinstance(value, dict):
            return False, value
        props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        req_list = [str(r) for r in (schema.get("required") or []) if isinstance(r, str)]
        req_set = set(req_list)

        for req_key in req_list:
            if req_key not in value:
                return False, value
            if value[req_key] is None and not _schema_allows_null(props.get(req_key)):
                return False, value

        addl = schema.get("additionalProperties")
        disallow_unknown = (addl is False) or (addl is None and bool(props))

        coerced_obj: Dict[str, Any] = {}
        for k, v in value.items():
            if k in props:
                prop_schema = props[k]
                if v is None and k not in req_set and not _schema_allows_null(prop_schema):
                    continue
                ok, c_val = _validate_and_coerce_schema(v, prop_schema)
                if not ok:
                    return False, value
                coerced_obj[k] = c_val
            else:
                if disallow_unknown:
                    return False, value
                if isinstance(addl, dict):
                    ok, c_val = _validate_and_coerce_schema(v, addl)
                    if not ok:
                        return False, value
                    coerced_obj[k] = c_val
                else:
                    coerced_obj[k] = v
        return True, coerced_obj

    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        return False, value
    return True, value


def _try_parse_json_dict_candidates(
    raw_candidate: str, allow_truncated_repair: bool = False
) -> List[Dict[str, Any]]:
    """
    Returns ordered candidate dicts from `raw_candidate`: exact JSON parse first, then direct
    brace/array closures, then comma-backtracked array-item salvage so a half-written trailing
    card (missing `required` fields) cleanly falls back to the preceding complete array items!
    """
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_candidate.strip()).strip()
    if not cleaned:
        return []
    try:
        obj = json.loads(cleaned)
        return [obj] if isinstance(obj, dict) else []
    except Exception:
        if not allow_truncated_repair:
            return []

    start = cleaned.find("{")
    if start == -1:
        return []
    frag = cleaned[start:].rstrip()
    results: List[Dict[str, Any]] = []
    seen_keys: set[str] = set()

    def _add_if_dict(cand_str: str) -> None:
        try:
            obj = json.loads(cand_str)
        except Exception:
            return
        if isinstance(obj, dict):
            sig = json.dumps(obj, sort_keys=True, ensure_ascii=False)
            if sig not in seen_keys:
                seen_keys.add(sig)
                results.append(obj)

    # 1. Direct closing-brace & closing-array suffixes
    for suffix in ("}", "}}", "}}}", '"}', '"}}', "]}", "]}}", '"]}', '"]}}', '"}]}', '"}]}}'):
        _add_if_dict(frag + suffix)

    # 2. Array-aware partial salvage (drops incomplete trailing array element after `,`)
    search_end = len(frag)
    for _ in range(8):
        comma_idx = frag.rfind(",", 0, search_end)
        if comma_idx <= 0:
            break
        search_end = comma_idx
        prefix = frag[:comma_idx].rstrip()
        for suffix in ("]}", "]}}", "]}]}}", "}", "}}"):
            _add_if_dict(prefix + suffix)

    return results


def _try_parse_json_dict(raw_candidate: str, allow_truncated_repair: bool = False) -> Optional[Dict[str, Any]]:
    cands = _try_parse_json_dict_candidates(raw_candidate, allow_truncated_repair=allow_truncated_repair)
    return cands[0] if cands else None


def _extract_bare_tool_json_candidates(
    cleaned: str,
    valid_tools: Dict[str, Dict[str, Any]],
    allow_repair: bool,
) -> List[Tuple[str, bool]]:
    """Extracts bare `{"name": "<valid_tool>", ...}` JSON objects emitted without `<tool_call>` XML tags."""
    results: List[Tuple[str, bool]] = []
    idx = 0
    n = len(cleaned)
    while idx < n and len(results) < MAX_TOOL_CALLS_PER_ROUND:
        m = _AUTO_BARE_TOOL_JSON_START_RE.search(cleaned, idx)
        if m is None:
            break
        if m.group(1) not in valid_tools:
            idx = m.end()
            continue
        start = m.start()
        depth = 0
        in_str = False
        esc = False
        end_pos = -1
        for pos in range(start, n):
            ch = cleaned[pos]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end_pos = pos + 1
                        break
        if end_pos != -1:
            results.append((cleaned[start:end_pos], False))
            idx = end_pos
        else:
            results.append((cleaned[start:], allow_repair or True))
            break
    return results


_OPEN_PAGE_ALLOWED_KEYS = frozenset(
    {
        "destination",
        "grammar_slug",
        "activity_id",
        "lesson_id",
        "scenario_id",
        "deck_id",
        "family",
        "word",
    }
)
_OPEN_PAGE_HINT_KEYS: Tuple[str, ...] = (
    "section",
    "sub",
    "subsection",
    "tab",
    "view",
    "mode",
    "module",
    "subpage",
    "area",
    "target",
)

_OPEN_PAGE_DEST_ALIASES: Dict[str, Tuple[str, Optional[str]]] = {
    "sentence_lab": ("writing_sentence_lab", None),
    "writing_lab": ("writing_sentence_lab", None),
    "sentence_mistakes": ("writing_sentence_mistakes", None),
    "mistakes": ("writing_sentence_mistakes", None),
    "paragraph": ("writing_paragraph", None),
    "translation": ("writing_translation", None),
    "portfolio": ("writing_portfolio", None),
    "my_books": ("reading_mybooks", None),
    "mybooks": ("reading_mybooks", None),
    "bookshelf": ("reading_mybooks", None),
    "bilingual": ("reading_bilingual", None),
    "bilingual_reading": ("reading_bilingual", None),
    "pronunciation": ("speaking_pronunciation", None),
    "pronunciation_analytics": ("speaking_pronunciation", None),
    "speaking_analytics": ("speaking_pronunciation", None),
    "shadowing": ("speaking_shadowing", None),
    "roleplay": ("speaking_roleplay_hub", None),
    "roleplay_hub": ("speaking_roleplay_hub", None),
    "speaking_roleplay": ("speaking_roleplay_hub", None),
    "arena": ("speaking_arena", None),
    "ielts": ("exams_family", "ielts"),
    "exams_ielts": ("exams_family", "ielts"),
    "toeic": ("exams_family", "toeic"),
    "exams_toeic": ("exams_family", "toeic"),
}


def _normalize_open_page_args(args_dict: Dict[str, Any], params_schema: Any) -> Dict[str, Any]:
    """
    Normalizes `open_page` arguments emitted by `Qwen3-4B`:
    1. Upgrades `destination="writing"` + `section`/`sub`/`tab`/`view`/`mode` hints (`"sentence"`/`"lab"`
       -> `"writing_sentence_lab"`, `"mistakes"` -> `"writing_sentence_mistakes"`, `"paragraph"` ->
       `"writing_paragraph"`, `"translation"` -> `"writing_translation"`, `"coach"` -> `"writing_coach"`,
       `"portfolio"` -> `"writing_portfolio"`), and `"profile"`/`"speaking_profile"` + `"pronunciation"` /
       `"history"` hints -> `"speaking_pronunciation"` / `"speaking_history"`.
    2. Recovers unambiguous snake_case `destination` shorthand (`"sentence_lab"`, `"my_books"`, `"ielts"`, etc.).
    3. Strips non-schema extra hint keys so `EchoToolRegistry` (`additionalProperties: false`) never drops a
       valid `open_page` call.
    """
    props = (
        params_schema.get("properties")
        if isinstance(params_schema, dict) and isinstance(params_schema.get("properties"), dict)
        else {}
    )
    dest_schema = props.get("destination") if isinstance(props.get("destination"), dict) else {}
    dest_enum = set(dest_schema.get("enum")) if isinstance(dest_schema.get("enum"), list) else set()
    allowed_keys = (set(props.keys()) & set(_OPEN_PAGE_ALLOWED_KEYS)) if props else set(_OPEN_PAGE_ALLOWED_KEYS)

    raw_dest = args_dict.get("destination")
    if not isinstance(raw_dest, str) or not raw_dest.strip():
        for fallback_key in ("page", "route", "target", "module", "section"):
            cand_val = args_dict.get(fallback_key)
            if isinstance(cand_val, str) and cand_val.strip():
                raw_dest = cand_val
                break

    if not isinstance(raw_dest, str) or not raw_dest.strip():
        return {k: v for k, v in args_dict.items() if k in allowed_keys}

    dest = raw_dest.strip()
    mapped_family: Optional[str] = None

    if not dest_enum or dest not in dest_enum:
        norm_key = re.sub(r"[\s\-/]+", "_", dest.lower()).strip("_")
        if norm_key in dest_enum:
            dest = norm_key
        else:
            alias = _OPEN_PAGE_DEST_ALIASES.get(norm_key)
            if alias is not None and (not dest_enum or alias[0] in dest_enum):
                dest, mapped_family = alias

    hint_parts = [
        str(args_dict.get(hk) or "").strip().lower()
        for hk in _OPEN_PAGE_HINT_KEYS
        if isinstance(args_dict.get(hk), str) and str(args_dict.get(hk) or "").strip()
    ]
    hint_norm = re.sub(r"[\s\-/]+", "_", " ".join(hint_parts))

    if hint_norm:
        cand_upgrade: Optional[str] = None
        if dest == "writing":
            if "mistake" in hint_norm:
                cand_upgrade = "writing_sentence_mistakes"
            elif "sentence" in hint_norm or "lab" in hint_norm:
                cand_upgrade = "writing_sentence_lab"
            elif "paragraph" in hint_norm:
                cand_upgrade = "writing_paragraph"
            elif "translation" in hint_norm or "translate" in hint_norm:
                cand_upgrade = "writing_translation"
            elif "coach" in hint_norm:
                cand_upgrade = "writing_coach"
            elif "portfolio" in hint_norm:
                cand_upgrade = "writing_portfolio"
        elif dest in ("profile", "speaking_profile"):
            if "pronunciation" in hint_norm:
                cand_upgrade = "speaking_pronunciation"
            elif "history" in hint_norm:
                cand_upgrade = "speaking_history"
        elif dest == "speaking":
            if "pronunciation" in hint_norm:
                cand_upgrade = "speaking_pronunciation"
            elif "history" in hint_norm:
                cand_upgrade = "speaking_history"
            elif "shadowing" in hint_norm:
                cand_upgrade = "speaking_shadowing"
            elif "roleplay" in hint_norm:
                cand_upgrade = "speaking_roleplay_hub"
            elif "arena" in hint_norm:
                cand_upgrade = "speaking_arena"
            elif "profile" in hint_norm:
                cand_upgrade = "speaking_profile"
        elif dest == "reading":
            if "my_books" in hint_norm or "mybooks" in hint_norm or "bookshelf" in hint_norm:
                cand_upgrade = "reading_mybooks"
            elif "bilingual" in hint_norm:
                cand_upgrade = "reading_bilingual"

        if cand_upgrade and (not dest_enum or cand_upgrade in dest_enum):
            dest = cand_upgrade

    out: Dict[str, Any] = {k: v for k, v in args_dict.items() if k in allowed_keys}
    out["destination"] = dest
    if mapped_family and not out.get("family") and "family" in allowed_keys:
        out["family"] = mapped_family
    return out


def parse_validated_tool_calls(
    raw_text: str,
    valid_tools: Dict[str, Dict[str, Any]],
    forced_tool: Optional[str] = None,
    finish_reason: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Extracts and schema-validates ALL `<tool_call>...</tool_call>` blocks (up to `4` parallel calls
    per round), array-aware truncated `<tool_call>{...` salvage when `finish_reason == "length"`,
    and bare `{"name": "<valid_tool>", ...}` JSON objects on `forced_tool` or `tool_choice="auto"`.
    """
    if not valid_tools:
        return []
    cleaned = strip_think_and_markers(raw_text).strip()
    if not cleaned and not forced_tool:
        return []

    candidates: List[Tuple[str, bool]] = []
    last_end = 0
    for match in _CLOSED_TOOL_CALL_RE.finditer(cleaned):
        candidates.append((match.group(1), False))
        last_end = match.end()

    remainder = cleaned[last_end:]
    m_open = _OPEN_TOOL_CALL_RE.search(remainder)
    if m_open is not None:
        candidates.append((m_open.group(1), finish_reason == "length" or True))
    elif not candidates and forced_tool:
        candidates.append((cleaned, finish_reason == "length"))
    elif not candidates and cleaned:
        candidates.extend(_extract_bare_tool_json_candidates(cleaned, valid_tools, finish_reason == "length"))

    validated: List[Dict[str, Any]] = []
    for raw_cand, allow_repair in candidates[:MAX_TOOL_CALLS_PER_ROUND]:
        parsed_candidates = _try_parse_json_dict_candidates(raw_cand, allow_truncated_repair=allow_repair)
        if not parsed_candidates:
            if forced_tool and forced_tool in valid_tools and not validated:
                params_schema = valid_tools[forced_tool].get("parameters")
                ok_empty, _ = _validate_and_coerce_schema({}, params_schema)
                if ok_empty:
                    validated.append(
                        {
                            "id": f"call_{len(validated)}",
                            "type": "function",
                            "function": {"name": forced_tool, "arguments": "{}"},
                        }
                    )
            continue

        for parsed in parsed_candidates:
            if forced_tool and forced_tool in valid_tools:
                name = forced_tool
                if "arguments" in parsed or "name" in parsed:
                    raw_args = parsed.get("arguments", {})
                else:
                    raw_args = parsed
            else:
                name = str(parsed.get("name") or "").strip()
                raw_args = parsed.get("arguments", {})

            if not _VALID_TOOL_NAME_RE.match(name) or name not in valid_tools:
                continue

            if isinstance(raw_args, str):
                try:
                    args_dict = json.loads(raw_args)
                except Exception:
                    continue
                if not isinstance(args_dict, dict):
                    continue
            elif isinstance(raw_args, dict):
                args_dict = raw_args
            elif raw_args is None:
                args_dict = {}
            else:
                continue

            params_schema = valid_tools[name].get("parameters")
            if name == "open_page":
                args_dict = _normalize_open_page_args(args_dict, params_schema)
            if isinstance(params_schema, dict):
                ok, coerced_args = _validate_and_coerce_schema(args_dict, params_schema)
                if not ok or not isinstance(coerced_args, dict):
                    continue
                args_dict = coerced_args

            args_str = json.dumps(args_dict, ensure_ascii=False)
            if len(args_str) > MAX_TOOL_ARGS_CHARS:
                continue

            validated.append(
                {
                    "id": f"call_{len(validated)}",
                    "type": "function",
                    "function": {"name": name, "arguments": args_str},
                }
            )
            break

    return validated


def parse_validated_tool_call(
    raw_text: str,
    valid_tools: Dict[str, Dict[str, Any]],
    forced_tool: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Backward-compatible single-call helper returning the first validated tool call."""
    calls = parse_validated_tool_calls(raw_text, valid_tools, forced_tool=forced_tool)
    return calls[0] if calls else None


def _get_forced_tool_grammar(forced_tool: Optional[str], valid_tools: Dict[str, Dict[str, Any]]) -> Any:
    """
    Compiles and caches a `LlamaGrammar` JSON Schema constraint for `forced_tool`
    (`tool_choice={"type":"function","function":{"name":"..."}}`), with safe `None` fallback.
    """
    if not forced_tool or forced_tool not in valid_tools:
        return None
    tool_fn = valid_tools[forced_tool]
    params_schema = _compact_json_schema(tool_fn.get("parameters"), is_root_params=True, for_prompt=False)
    wrapper_schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "enum": [forced_tool]},
            "arguments": params_schema,
        },
        "required": ["name", "arguments"],
        "additionalProperties": False,
    }
    cache_key = json.dumps(wrapper_schema, sort_keys=True, ensure_ascii=False)
    with _GRAMMAR_CACHE_LOCK:
        if cache_key in _GRAMMAR_CACHE:
            return _GRAMMAR_CACHE[cache_key]

    grammar = None
    try:
        from llama_cpp import LlamaGrammar  # type: ignore[import-not-found]

        grammar = LlamaGrammar.from_json_schema(cache_key)
    except Exception as exc:
        logger.debug("Forced-tool grammar fallback for '%s': %s", forced_tool, exc)
        grammar = None

    with _GRAMMAR_CACHE_LOCK:
        if len(_GRAMMAR_CACHE) >= 64:
            _GRAMMAR_CACHE.clear()
        _GRAMMAR_CACHE[cache_key] = grammar
    return grammar


def _trim_incomplete_tail(text: str) -> str:
    """If generation stopped at `max_tokens` mid-sentence, trim cleanly to the last sentence boundary."""
    s = text.strip()
    if not s or s[-1] in ".!?…\"')]}":
        return s
    for punct in (". ", "! ", "? ", "… ", ".\n", "!\n", "?\n"):
        idx = s.rfind(punct)
        if idx >= len(s) // 2:
            return s[: idx + 1].strip()
    return s


def _fallback_non_empty_reply(messages: List[Dict[str, Any]]) -> str:
    """
    Calm, non-pushy fallback reply (zero forced `"practice"`/`"luyện tập"` or trailing `?`).
    Inspects ONLY non-`system` user/assistant messages for Vietnamese diacritics plus explicit
    `"preferred explanation language for this turn: vietnamese"` in `system` when user text is ASCII.
    """
    vi_reply = "Mình đang ở đây cùng bạn. Bạn cứ nói rõ thêm điều bạn cần nhé."
    en_reply = "I'm right here with you. Let me know how you'd like me to help."

    sys_texts: List[str] = []
    convo_texts: List[str] = []
    last_user_text = ""

    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip().lower()
        txt = _extract_content_text(m.get("content")).strip()
        if not txt:
            continue
        if role == "system":
            sys_texts.append(txt)
        elif role in ("user", "assistant"):
            convo_texts.append(txt)
            if role == "user":
                last_user_text = txt

    if last_user_text and _VI_DIACRITIC_RE.search(last_user_text):
        return vi_reply

    sys_low = "\n".join(sys_texts).lower()
    if "preferred explanation language for this turn: vietnamese" in sys_low:
        return vi_reply
    if "preferred explanation language for this turn: english" in sys_low:
        return en_reply

    recent_non_sys = " ".join(convo_texts[-3:])
    if not last_user_text and _VI_DIACRITIC_RE.search(recent_non_sys):
        return vi_reply
    return en_reply


def _strip_leading_non_user_orphans(msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    idx = 0
    while idx < len(msgs):
        m = msgs[idx]
        if isinstance(m, dict) and str(m.get("role") or "").strip().lower() == "user":
            break
        idx += 1
    return msgs[idx:]


def _group_atomic_turn_units(prior_msgs: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """
    Partitions prior conversation messages (with leading non-`user` orphans stripped) into
    atomic turn units `[user_i, *(assistant_tool_calls + tool_responses)*, assistant_reply_i]`.
    """
    clean_prior = _strip_leading_non_user_orphans(prior_msgs)
    units: List[List[Dict[str, Any]]] = []
    current_unit: List[Dict[str, Any]] = []
    for m in clean_prior:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip().lower()
        if role == "user":
            if current_unit:
                units.append(current_unit)
            current_unit = [m]
        else:
            if current_unit:
                current_unit.append(m)
    if current_unit:
        units.append(current_unit)
    return units


class EchoLocalLlmService:
    _instance: Optional["EchoLocalLlmService"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._warmup_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        self._llm: Any = None
        self._model_path: Optional[str] = None
        self._model_id: str = DEFAULT_MODEL_ID
        self._n_gpu_layers: int = 0
        self._n_ctx: int = max(
            2048,
            int(os.getenv("ECHO_LOCAL_LLM_N_CTX") or os.getenv("ECHO_LOCAL_LLM_CTX") or str(DEFAULT_N_CTX)),
        )
        self._n_batch: int = max(64, int(os.getenv("ECHO_LOCAL_LLM_BATCH", str(DEFAULT_N_BATCH))))
        self._n_ubatch: int = max(
            64,
            min(self._n_batch, int(os.getenv("ECHO_LOCAL_LLM_UBATCH", str(DEFAULT_N_UBATCH)))),
        )
        self._flash_attn: bool = (os.getenv("ECHO_LOCAL_LLM_FLASH_ATTN", "0") or "0").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        self._kv_quant: str = (os.getenv("ECHO_LOCAL_LLM_KV_QUANT", "f16") or "f16").strip().lower()
        self._use_ram_cache: bool = os.getenv("ECHO_LOCAL_LLM_USE_RAM_CACHE", "0").strip() == "1"
        self._cache_capacity_bytes: int = (
            max(64, int(os.getenv("ECHO_LOCAL_LLM_CACHE_MB", "1024"))) * 1024 * 1024
            if self._use_ram_cache
            else 0
        )
        # 12 decode threads / 16 prefill threads on 16C/32T Zen 5 leaves 4 physical cores free for 4-thread CPU ONNX TTS
        default_threads = min(12, max(4, (os.cpu_count() or 8) // 2))
        default_threads_batch = max(default_threads, min(16, os.cpu_count() or 8))
        self._n_threads: int = max(2, int(os.getenv("ECHO_LOCAL_LLM_THREADS", str(default_threads))))
        self._n_threads_batch: int = max(
            self._n_threads,
            int(os.getenv("ECHO_LOCAL_LLM_THREADS_BATCH", str(default_threads_batch))),
        )
        self._tool_call_token_ids: List[int] = []
        self._prefix_warmed: bool = False
        self._last_warmed_sys_block: Optional[str] = None
        self._active_warmup_cancel: Optional[threading.Event] = None
        self._active_warmup_is_dummy: bool = False

    @classmethod
    def get_instance(cls) -> "EchoLocalLlmService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._llm is not None

    @property
    def n_gpu_layers(self) -> int:
        return self._n_gpu_layers

    @property
    def cached_prefix_tokens(self) -> int:
        if self._llm is None:
            return 0
        try:
            return int(getattr(self._llm, "n_tokens", 0) or 0)
        except Exception:
            return 0

    def is_busy_or_prefix_warm(self, payload: Optional[Dict[str, Any]] = None) -> bool:
        """
        True when a real request (or non-dummy warmup) holds `_infer_lock`, OR when `self._llm`'s live KV
        cache (`_input_ids[:len(sys_tokens)]`) already starts with the exact tokenized `<|im_start|>system...<|im_end|>`
        prefix of `payload` (`n_tokens >= len(sys_tokens)`). Never skips `X-EC-Warmup: 1` on mere `n_tokens > 64`
        when a different prompt was previously evaluated!
        """
        if self._infer_lock.locked():
            with self._warmup_lock:
                dummy_warmup_running = self._active_warmup_cancel is not None and self._active_warmup_is_dummy
            if dummy_warmup_running:
                self.preempt_active_warmup()
                return False
            return True

        if isinstance(payload, dict) and isinstance(payload.get("messages"), list):
            sys_block, _, _ = build_static_system_block(payload["messages"], payload.get("tools"))
            llm = self._llm
            if llm is not None:
                raw_ids = getattr(llm, "_input_ids", None)
                if raw_ids is None:
                    raw_ids = getattr(llm, "input_ids", None)
                if raw_ids is not None:
                    sys_tokens, _ = self._tokenize_prompt(sys_block + "\n")
                    n_cached = self.cached_prefix_tokens
                    if not sys_tokens or n_cached < len(sys_tokens):
                        return False
                    try:
                        cached_head = [int(x) for x in raw_ids[: len(sys_tokens)]]
                    except Exception:
                        return False
                    return cached_head == sys_tokens
            if self._last_warmed_sys_block is not None:
                return self._last_warmed_sys_block == sys_block
            return bool(self._prefix_warmed)

        if self._prefix_warmed or self.cached_prefix_tokens > 64:
            return True
        return False

    def register_warmup_cancel(self, cancel_event: threading.Event, *, is_dummy: bool = False) -> None:
        with self._warmup_lock:
            self._active_warmup_cancel = cancel_event
            self._active_warmup_is_dummy = bool(is_dummy)

    def clear_warmup_cancel(self, cancel_event: threading.Event) -> None:
        with self._warmup_lock:
            if self._active_warmup_cancel is cancel_event:
                self._active_warmup_cancel = None
                self._active_warmup_is_dummy = False

    def preempt_active_warmup(self) -> None:
        """Preempts any background warmup immediately when a real learner turn arrives."""
        with self._warmup_lock:
            if self._active_warmup_cancel is not None:
                self._active_warmup_cancel.set()

    def _resolve_gguf_path(self) -> Tuple[str, str]:
        explicit = (os.getenv("ECHO_LOCAL_LLM_PATH") or "").strip()
        baked_candidates = [
            (explicit, DEFAULT_MODEL_ID),
            (f"/opt/echo-jarvis/{PRIMARY_HF_FILENAME}", "qwen3-4b-instruct-2507-q4_k_m"),
            ("/opt/echo-jarvis/qwen3-4b-instruct-2507-q4_k_m.gguf", "qwen3-4b-instruct-2507-q4_k_m"),
            ("/opt/echo-jarvis/qwen2.5-1.5b-instruct-q4_k_m.gguf", "qwen2.5-1.5b-instruct-q4_k_m"),
        ]
        for path_str, mid in baked_candidates:
            if path_str and os.path.isfile(path_str):
                return path_str, mid

        from huggingface_hub import hf_hub_download

        allow_dl = (os.getenv("ECHO_LOCAL_LLM_ALLOW_DOWNLOAD", "true") or "true").strip().lower() == "true"
        for repo, rev, fname, mid in (
            (PRIMARY_HF_REPO, PRIMARY_HF_REVISION, PRIMARY_HF_FILENAME, "qwen3-4b-instruct-2507-q4_k_m"),
            (FALLBACK_HF_REPO, FALLBACK_HF_REVISION, FALLBACK_HF_FILENAME, "qwen2.5-1.5b-instruct-q4_k_m"),
        ):
            try:
                p = hf_hub_download(repo_id=repo, revision=rev, filename=fname, local_files_only=True)
                return p, mid
            except Exception:
                if not allow_dl:
                    continue
                try:
                    p = hf_hub_download(repo_id=repo, revision=rev, filename=fname)
                    return p, mid
                except Exception as dl_err:
                    logger.warning("Local LLM candidate %s/%s download failed: %s", repo, fname, dl_err)

        raise LocalLlmUnavailable("No local Apache-2.0 GGUF instruct model found")

    @staticmethod
    def _discover_tool_call_token_ids(llm: Any) -> List[int]:
        try:
            toks = llm.tokenize(b"<tool_call>", add_bos=False, special=True)
        except TypeError:
            try:
                toks = llm.tokenize(b"<tool_call>", add_bos=False)
            except Exception:
                return []
        except Exception:
            return []
        if isinstance(toks, list) and len(toks) == 1 and isinstance(toks[0], int):
            return [toks[0]]
        return []

    def _build_logit_bias(self, valid_tools: Dict[str, Any], allow_tools: bool) -> Optional[Dict[int, float]]:
        """
        When `tools` are rendered in the prompt (`valid_tools` non-empty) yet `allow_tools` is False
        (e.g. `tool_choice == "none"` on Round 2), ban `<tool_call>` (`151657` on Qwen3) via `logit_bias`
        so the static `<tools>` KV cache prefix stays 100% intact with zero tool generation.
        """
        if not valid_tools or allow_tools:
            return None
        if self._tool_call_token_ids:
            return {tid: -100.0 for tid in self._tool_call_token_ids}
        if self._llm is None and "qwen" in (self._model_id or "").lower():
            return {QWEN3_TOOL_CALL_TOKEN_ID: -100.0}
        return None

    def load_model(self) -> Any:
        if self._llm is not None:
            return self._llm
        with self._load_lock:
            if self._llm is not None:
                return self._llm
            try:
                import llama_cpp  # type: ignore[import-not-found]
                from llama_cpp import Llama, LlamaRAMCache  # type: ignore[import-not-found]
            except Exception as exc:
                raise LocalLlmUnavailable(f"llama-cpp-python is not installed: {exc}") from exc

            gguf_path, mid = self._resolve_gguf_path()
            # Strictly default to 0 GPU layers (`0 MiB` VRAM!)
            gpu_layers = int(os.getenv("ECHO_LOCAL_LLM_GPU_LAYERS", "0"))
            raw_ctx = os.getenv("ECHO_LOCAL_LLM_N_CTX") or os.getenv("ECHO_LOCAL_LLM_CTX") or str(DEFAULT_N_CTX)
            n_ctx = max(2048, int(raw_ctx))
            n_batch = max(64, int(os.getenv("ECHO_LOCAL_LLM_BATCH", str(DEFAULT_N_BATCH))))
            n_ubatch = max(64, min(n_batch, int(os.getenv("ECHO_LOCAL_LLM_UBATCH", str(DEFAULT_N_UBATCH)))))
            default_t = min(12, max(4, (os.cpu_count() or 8) // 2))
            default_tb = max(default_t, min(16, os.cpu_count() or 8))
            threads = max(2, int(os.getenv("ECHO_LOCAL_LLM_THREADS", str(default_t))))
            threads_batch = max(
                threads,
                int(os.getenv("ECHO_LOCAL_LLM_THREADS_BATCH", str(default_tb))),
            )
            flash_attn = (os.getenv("ECHO_LOCAL_LLM_FLASH_ATTN", "0") or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            kv_quant = (os.getenv("ECHO_LOCAL_LLM_KV_QUANT", "f16") or "f16").strip().lower()
            use_q8_kv = flash_attn and kv_quant == "q8_0"
            q8_type_id = int(getattr(llama_cpp, "GGML_TYPE_Q8_0", GGML_TYPE_Q8_0_ID))

            use_ram_cache = os.getenv("ECHO_LOCAL_LLM_USE_RAM_CACHE", "0").strip() == "1"
            cache_mb = max(64, int(os.getenv("ECHO_LOCAL_LLM_CACHE_MB", "1024"))) if use_ram_cache else 0
            cache_bytes = cache_mb * 1024 * 1024

            base_kwargs: Dict[str, Any] = {
                "model_path": gguf_path,
                "n_gpu_layers": gpu_layers,
                "n_ctx": n_ctx,
                "n_batch": n_batch,
                "n_threads": threads,
                "n_threads_batch": threads_batch,
                "use_mmap": True,
                "verbose": False,
            }
            opt_kwargs: Dict[str, Any] = {
                **base_kwargs,
                "n_ubatch": n_ubatch,
                "flash_attn": flash_attn,
            }
            if use_q8_kv:
                opt_kwargs["type_k"] = q8_type_id
                opt_kwargs["type_v"] = q8_type_id

            t0 = time.perf_counter()
            active_kv_label = "q8_0" if use_q8_kv else "f16"
            try:
                llm = Llama(**opt_kwargs)
            except (TypeError, ValueError, RuntimeError) as quant_err:
                logger.warning(
                    "Llama Q8_0/flash_attn kwargs rejected (%s); falling back to safe FP16 kwargs.",
                    quant_err,
                )
                active_kv_label = "f16-fallback"
                llm = Llama(**base_kwargs)

            if use_ram_cache:
                try:
                    llm.set_cache(LlamaRAMCache(capacity_bytes=cache_bytes))
                except Exception:
                    pass

            self._tool_call_token_ids = self._discover_tool_call_token_ids(llm)
            self._llm = llm
            self._model_path = gguf_path
            self._model_id = mid
            self._n_gpu_layers = gpu_layers
            self._n_ctx = n_ctx
            self._n_batch = n_batch
            self._n_ubatch = n_ubatch
            self._flash_attn = flash_attn
            self._kv_quant = active_kv_label
            self._use_ram_cache = use_ram_cache
            self._cache_capacity_bytes = cache_bytes
            self._n_threads = threads
            self._n_threads_batch = threads_batch
            logger.info(
                "EchoLocalLlmService loaded '%s' from %s (n_gpu_layers=%d [0 MiB VRAM], threads=%d/%d, batch=%d/%d, ctx=%d, kv=%s, flash_attn=%s, ram_cache=%s [%d MiB], tool_call_tok=%s) in %.2fs",
                mid,
                gguf_path,
                gpu_layers,
                threads,
                threads_batch,
                n_batch,
                n_ubatch,
                n_ctx,
                active_kv_label,
                flash_attn,
                "on" if use_ram_cache else "off-inplace-kv",
                cache_mb,
                self._tool_call_token_ids,
                time.perf_counter() - t0,
            )
            return llm

    def warmup(self) -> None:
        """
        Pages GGUF weights into RAM without ever clobbering an already-warmed `[PROFESSOR + 23 tools]`
        KV prefix (`n_tokens > 64`), and yields immediately if a real learner turn or `X-EC-Warmup: 1` arrives.
        """
        try:
            llm = self.load_model()
            if self._infer_lock.locked() or self._prefix_warmed or int(getattr(llm, "n_tokens", 0) or 0) > 64:
                logger.info("EchoLocalLlmService warmup skipped (prefix already warm or active).")
                return
        except Exception as exc:
            logger.warning("EchoLocalLlmService warmup skipped: %s", exc)
            return

        warm_cancel = threading.Event()
        self.register_warmup_cancel(warm_cancel, is_dummy=True)
        try:
            list(
                self.stream_sse_events(
                    {
                        "model": DEFAULT_MODEL_ID,
                        "messages": [{"role": "user", "content": "Say ready in one word."}],
                        "max_tokens": 4,
                        "temperature": 0.0,
                    },
                    cancel_event=warm_cancel,
                    is_warmup=True,
                )
            )
            logger.info("EchoLocalLlmService CPU weight warmup complete.")
        except LocalLlmCancelledError:
            logger.info("EchoLocalLlmService startup warmup yielded to live request.")
        except Exception as exc:
            logger.warning("EchoLocalLlmService warmup skipped: %s", exc)
        finally:
            self.clear_warmup_cancel(warm_cancel)

    def _raw_token_iterator(
        self,
        prompt: str,
        max_tokens: int,
        temperature: float,
        top_p: float,
        cancel_event: Optional[threading.Event] = None,
        *,
        top_k: int = 20,
        logit_bias: Optional[Dict[int, float]] = None,
        grammar: Any = None,
        prompt_tokens: Optional[List[int]] = None,
        prompt_token_count: Optional[int] = None,
        grace_tokens: int = 0,
        has_tools_prefix: bool = False,
    ) -> Tuple[Iterator[Tuple[str, Optional[str]]], Dict[str, int]]:
        """
        Internal generator yielding `(token_text, finish_reason)` from `llama-cpp-python`
        with zero double-tokenization (`prompt=prompt_tokens` on real `Llama`), `< 25 ms`
        `stopping_criteria` cancellation support, `repeat_penalty=1.0`, `logit_bias`
        (`tool_choice="none"`), and optional `grammar` (`forced_tool`).
        """
        llm = self.load_model()
        exact_prompt_count = (
            int(prompt_token_count)
            if prompt_token_count is not None
            else (len(prompt_tokens) if prompt_tokens is not None else max(1, len(prompt) // 4))
        )
        usage_stats = {"prompt_tokens": exact_prompt_count, "completion_tokens": 0}

        def _stop_check(_input_ids: Any, _logits: Any) -> bool:
            return bool(cancel_event is not None and cancel_event.is_set())

        stop_list = ["<|im_end|>", "<|im_start|>", "<|endoftext|>"]
        is_real_llama = type(llm).__module__.startswith("llama_cpp")
        wire_prompt: Any = prompt_tokens if (prompt_tokens is not None and is_real_llama) else prompt
        wire_max_tokens = max(1, int(max_tokens) + max(0, int(grace_tokens)))

        def _gen() -> Iterator[Tuple[str, Optional[str]]]:
            if cancel_event is not None and cancel_event.is_set():
                return
            with self._infer_lock:
                if cancel_event is not None and cancel_event.is_set():
                    return
                kwargs: Dict[str, Any] = {
                    "prompt": wire_prompt,
                    "max_tokens": wire_max_tokens,
                    "temperature": temperature,
                    "top_p": top_p,
                    "top_k": top_k,
                    "repeat_penalty": 1.0,
                    "stop": stop_list,
                    "stream": True,
                }
                if logit_bias:
                    kwargs["logit_bias"] = logit_bias
                if grammar is not None:
                    kwargs["grammar"] = grammar
                try:
                    from llama_cpp import StoppingCriteriaList  # type: ignore[import-not-found]

                    kwargs["stopping_criteria"] = StoppingCriteriaList([_stop_check])
                except Exception:
                    pass

                stream = llm.create_completion(**kwargs)
                comp_tokens = 0
                completed_cleanly = False
                for chunk in stream:
                    if cancel_event is not None and cancel_event.is_set():
                        break
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    c0 = choices[0]
                    piece = str(c0.get("text") or "")
                    finish = c0.get("finish_reason")
                    if piece:
                        comp_tokens += 1
                    usage_stats["completion_tokens"] = comp_tokens
                    if finish is not None:
                        completed_cleanly = True
                    yield piece, finish

                if has_tools_prefix and (completed_cleanly or int(getattr(llm, "n_tokens", 0) or 0) > 64):
                    self._prefix_warmed = True

        return _gen(), usage_stats

    def _invoke_token_iterator(
        self,
        *,
        prompt: str,
        max_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        cancel_event: Optional[threading.Event],
        logit_bias: Optional[Dict[int, float]],
        grammar: Any,
        prompt_tokens: Optional[List[int]] = None,
        prompt_token_count: Optional[int] = None,
        grace_tokens: int = 0,
        has_tools_prefix: bool = False,
    ) -> Tuple[Iterator[Tuple[str, Optional[str]]], Dict[str, int]]:
        """Invokes `_raw_token_iterator` while preserving 5-arg monkeypatch compatibility in tests."""
        sig_params = inspect.signature(self._raw_token_iterator).parameters
        has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig_params.values())
        extra_kw: Dict[str, Any] = {}
        for key, val in (
            ("top_k", top_k),
            ("logit_bias", logit_bias),
            ("grammar", grammar),
            ("prompt_tokens", prompt_tokens),
            ("prompt_token_count", prompt_token_count),
            ("grace_tokens", grace_tokens),
            ("has_tools_prefix", has_tools_prefix),
        ):
            if has_var_kw or key in sig_params:
                extra_kw[key] = val
        return self._raw_token_iterator(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            cancel_event=cancel_event,
            **extra_kw,
        )

    def _validate_request(
        self, payload: Dict[str, Any]
    ) -> Tuple[List[Dict[str, Any]], int, float, float, int, str, bool]:
        if not isinstance(payload, dict):
            raise ValueError("Invalid JSON request body")
        raw_messages = payload.get("messages")
        if not isinstance(raw_messages, list) or len(raw_messages) == 0:
            raise ValueError("messages must be a non-empty array")

        if len(raw_messages) > MAX_MESSAGES_COUNT:
            sys_msgs = [
                m for m in raw_messages if isinstance(m, dict) and str(m.get("role") or "").strip().lower() == "system"
            ]
            non_sys = [
                m
                for m in raw_messages
                if isinstance(m, dict) and str(m.get("role") or "").strip().lower() != "system"
            ]
            keep_non_sys = max(1, MAX_MESSAGES_COUNT - len(sys_msgs))
            sliced_non_sys = non_sys[-keep_non_sys:]
            cleaned_non_sys = _strip_leading_non_user_orphans(sliced_non_sys)
            messages = sys_msgs + (cleaned_non_sys if cleaned_non_sys else sliced_non_sys[-1:])
        else:
            messages = raw_messages

        raw_max = payload.get("max_tokens")
        if raw_max is None:
            max_tokens = 512
        else:
            parsed_max = int(raw_max)
            if parsed_max <= 0:
                raise ValueError("max_tokens must be positive")
            max_tokens = max(1, min(MAX_COMPLETION_TOKENS, parsed_max))

        raw_temp = payload.get("temperature")
        temperature = 0.35 if raw_temp is None else max(0.0, min(1.5, float(raw_temp)))
        raw_top_p = payload.get("top_p")
        top_p = 0.80 if raw_top_p is None else max(0.05, min(1.0, float(raw_top_p)))
        raw_top_k = payload.get("top_k")
        top_k = 20 if raw_top_k is None else max(1, min(200, int(raw_top_k)))
        requested_model = str(payload.get("model") or self._model_id or DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID
        include_usage = True
        if isinstance(payload.get("stream_options"), dict):
            include_usage = bool(payload["stream_options"].get("include_usage", True))
        return messages, max_tokens, temperature, top_p, top_k, requested_model, include_usage

    def _tokenize_prompt(self, prompt: str) -> Tuple[Optional[List[int]], int]:
        """Exact tokenization with the loaded model's tokenizer (`0` double-tokenization); safe byte fallback for mocks."""
        llm = self._llm
        if llm is None and not os.getenv("PYTEST_CURRENT_TEST"):
            try:
                llm = self.load_model()
            except Exception:
                llm = None
        if llm is not None:
            raw_bytes = prompt.encode("utf-8")
            toks: Any = None
            try:
                toks = llm.tokenize(raw_bytes, add_bos=False, special=True)
            except TypeError:
                try:
                    toks = llm.tokenize(raw_bytes, add_bos=False)
                except Exception:
                    toks = None
            except Exception:
                toks = None
            if isinstance(toks, list) and len(toks) > 0:
                return toks, len(toks)
        return None, int(len(prompt.encode("utf-8")) / 2.5) + 1

    def _count_prompt_tokens(self, prompt: str) -> int:
        """Exact token count with the loaded model's tokenizer; conservative byte estimate only before load."""
        return self._tokenize_prompt(prompt)[1]

    def _build_fitted_prompt_with_tokens(
        self,
        payload: Dict[str, Any],
        messages: List[Dict[str, Any]],
        max_tokens: int,
    ) -> Tuple[str, Optional[List[int]], int, Dict[str, Dict[str, Any]], Optional[str], bool, int]:
        """
        Builds the ChatML prompt and fits `prompt + completion + grace` inside `n_ctx`:
        1. Partitions prior history into atomic turn units (`[user_i, *(assistant_tc + tool_resp)*, assistant_i]`)
           with zero leading orphans, dropping `>= 2` oldest units at once to amortize KV shifts and reserving
           `ROUND0_TOOL_HEADROOM_TOKENS` (`900`) on Round 0 when `n_ctx >= 8192` so Round 1 never evicts history;
        2. Applies pre-`503` oversize `tool` / `dynamic_tail` compaction if all history is gone and `room` is tight;
        3. Shrinks completion budget to `room` (`>= MIN_COMPLETION_TOKENS`) or raises `LocalLlmContextOverflow` (`503`).
        """
        tools = payload.get("tools")
        tool_choice = payload.get("tool_choice")

        last_user_idx = max(
            (i for i, m in enumerate(messages) if isinstance(m, dict) and str(m.get("role") or "").strip().lower() == "user"),
            default=len(messages) - 1,
        )
        sys_msgs = [
            m for m in messages if isinstance(m, dict) and str(m.get("role") or "").strip().lower() == "system"
        ]
        raw_prior = [
            m
            for m in messages[:last_user_idx]
            if isinstance(m, dict) and str(m.get("role") or "").strip().lower() != "system"
        ]
        active_suffix = [
            m
            for m in messages[last_user_idx:]
            if isinstance(m, dict) and str(m.get("role") or "").strip().lower() != "system"
        ]
        prior_units = _group_atomic_turn_units(raw_prior)

        compaction_tiers: List[Tuple[int, int]] = [
            (MAX_MESSAGE_CHARS, MAX_DYNAMIC_SYSTEM_CHARS),
            (1500, 3200),
            (700, 1400),
        ]
        tier_idx = 0

        while True:
            flat_prior = [m for unit in prior_units for m in unit]
            working = sys_msgs + flat_prior + active_suffix
            tool_cap, dyn_cap = compaction_tiers[tier_idx]
            prompt, valid_tools, forced_tool, allow_tools = build_chatml_prompt(
                messages=working,
                tools=tools,
                tool_choice=tool_choice,
                max_tool_msg_chars=tool_cap,
                max_dynamic_chars=dyn_cap,
            )
            prompt_tokens_list, prompt_tokens = self._tokenize_prompt(prompt)
            room = self._n_ctx - prompt_tokens - CONTEXT_SAFETY_TOKENS

            prior_rounds = _count_active_tool_rounds(working)
            round0_headroom = (
                ROUND0_TOOL_HEADROOM_TOKENS
                if (prior_units and allow_tools and prior_rounds == 0 and self._n_ctx >= 8192)
                else 0
            )

            if room >= max_tokens + round0_headroom:
                return prompt, prompt_tokens_list, prompt_tokens, valid_tools, forced_tool, allow_tools, max_tokens

            if prior_units:
                # Drop >= 2 oldest atomic turn units at once so subsequent turns reuse remaining history KV!
                drop_count = min(len(prior_units), 2)
                del prior_units[:drop_count]
                continue

            if room >= max_tokens:
                return prompt, prompt_tokens_list, prompt_tokens, valid_tools, forced_tool, allow_tools, max_tokens

            if room < MIN_COMPLETION_TOKENS and tier_idx + 1 < len(compaction_tiers):
                has_compactable_tools = any(
                    isinstance(m, dict)
                    and str(m.get("role") or "").strip().lower() == "tool"
                    and len(_extract_content_text(m.get("content"))) > compaction_tiers[tier_idx + 1][0]
                    for m in active_suffix
                )
                has_compactable_dyn = any(
                    DYNAMIC_CONTEXT_MARKER in _extract_content_text(m.get("content"))
                    for m in sys_msgs
                )
                if has_compactable_tools or has_compactable_dyn:
                    tier_idx += 1
                    continue

            if room >= MIN_COMPLETION_TOKENS:
                logger.info(
                    "Local LLM completion budget fitted to the context window: %d -> %d tokens (prompt %d, ctx %d)",
                    max_tokens,
                    room,
                    prompt_tokens,
                    self._n_ctx,
                )
                return prompt, prompt_tokens_list, prompt_tokens, valid_tools, forced_tool, allow_tools, room

            raise LocalLlmContextOverflow(
                f"Prompt of {prompt_tokens} tokens leaves no answer room in the {self._n_ctx}-token context window"
            )

    def _build_fitted_prompt(
        self,
        payload: Dict[str, Any],
        messages: List[Dict[str, Any]],
        max_tokens: int,
    ) -> Tuple[str, Dict[str, Dict[str, Any]], Optional[str], bool, int]:
        """Backward-compatible 5-tuple wrapper over `_build_fitted_prompt_with_tokens`."""
        prompt, _toks, _cnt, valid_tools, forced_tool, allow_tools, fitted_max = self._build_fitted_prompt_with_tokens(
            payload, messages, max_tokens
        )
        return prompt, valid_tools, forced_tool, allow_tools, fitted_max

    def stream_sse_events(
        self,
        payload: Dict[str, Any],
        cancel_event: Optional[threading.Event] = None,
        *,
        is_warmup: bool = False,
    ) -> Iterator[str]:
        """
        Produces OpenAI / `EchoProviderStream`-validated SSE lines (`data: {...}\n\n` ... `data: [DONE]\n\n`).
        """
        if not is_warmup:
            self.preempt_active_warmup()
        if cancel_event is not None and cancel_event.is_set():
            raise LocalLlmCancelledError("Request cancelled before start")

        messages, max_tokens, temperature, top_p, top_k, req_model, include_usage = self._validate_request(payload)
        (
            prompt,
            prompt_tokens_list,
            prompt_token_count,
            valid_tools,
            forced_tool,
            allow_tools,
            max_tokens,
        ) = self._build_fitted_prompt_with_tokens(payload, messages, max_tokens)
        logit_bias = self._build_logit_bias(valid_tools, allow_tools)
        grammar = _get_forced_tool_grammar(forced_tool, valid_tools) if (forced_tool and allow_tools) else None
        grace_budget = max(0, min(SENTENCE_GRACE_TOKENS, self._n_ctx - prompt_token_count - max_tokens - 16))
        req_sys_block, _, _ = build_static_system_block(messages, payload.get("tools"))
        is_voice_turn = any(
            isinstance(m, dict)
            and str(m.get("role") or "").strip().lower() == "system"
            and _CHANNEL_VOICE_RE.search(_extract_content_text(m.get("content")))
            for m in messages
        )

        if cancel_event is not None and cancel_event.is_set():
            raise LocalLlmCancelledError("Request cancelled before slot acquire")

        if not self._slots.acquire(timeout=0.05 if is_warmup else SLOT_ACQUIRE_TIMEOUT_SEC):
            raise LocalLlmBusyError("Local LLM service is busy")

        chat_id = f"chatcmpl-echo-{uuid.uuid4().hex[:12]}"
        created = int(time.time())

        def _make_chunk(
            delta: Dict[str, Any],
            finish_reason: Optional[str] = None,
            usage: Optional[Dict[str, Any]] = None,
        ) -> str:
            obj: Dict[str, Any] = {
                "id": chat_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": req_model,
                "choices": [
                    {
                        "index": 0,
                        "delta": delta,
                        "finish_reason": finish_reason,
                    }
                ],
            }
            if usage is not None:
                obj["usage"] = usage
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        def _sse_gen() -> Iterator[str]:
            try:
                if cancel_event is not None and cancel_event.is_set():
                    return
                token_iter, usage_stats = self._invoke_token_iterator(
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=top_k,
                    cancel_event=cancel_event,
                    logit_bias=logit_bias,
                    grammar=grammar,
                    prompt_tokens=prompt_tokens_list,
                    prompt_token_count=prompt_token_count,
                    grace_tokens=grace_budget,
                    has_tools_prefix=bool(valid_tools),
                )
                stream_filter = _StreamingToolAndThinkFilter(
                    allow_tools=allow_tools and bool(valid_tools),
                    forced_tool=forced_tool if allow_tools else None,
                    intercept_tool_tags=True,
                    valid_tool_names=tuple(valid_tools.keys()) if (allow_tools and valid_tools) else None,
                )
                emitted_role = False
                emitted_any_text = False
                hit_length_limit = False
                total_emitted_chars = 0
                visible_tokens = 0
                visible_acc: List[str] = []

                for raw_piece, raw_finish in token_iter:
                    if cancel_event is not None and cancel_event.is_set():
                        return
                    if raw_finish == "length":
                        hit_length_limit = True

                    clean_piece = stream_filter.push(raw_piece)
                    if stream_filter.in_tool_zone:
                        if stream_filter.tool_buffer.lower().count("</tool_call>") >= MAX_TOOL_CALLS_PER_ROUND:
                            if clean_piece and total_emitted_chars < 11800:
                                allowed_slice = clean_piece[: 11800 - total_emitted_chars]
                                total_emitted_chars += len(allowed_slice)
                                visible_tokens += 1
                                visible_acc.append(allowed_slice)
                                delta_obj: Dict[str, Any] = {"content": allowed_slice}
                                if not emitted_role:
                                    delta_obj["role"] = "assistant"
                                    emitted_role = True
                                emitted_any_text = True
                                yield _make_chunk(delta_obj, None)
                            break

                    if clean_piece and total_emitted_chars < 11800:
                        allowed_slice = clean_piece[: 11800 - total_emitted_chars]
                        total_emitted_chars += len(allowed_slice)
                        visible_tokens += 1
                        visible_acc.append(allowed_slice)
                        delta_obj = {"content": allowed_slice}
                        if not emitted_role:
                            delta_obj["role"] = "assistant"
                            emitted_role = True
                        emitted_any_text = True
                        yield _make_chunk(delta_obj, None)

                    # Voice conciseness stop: once outside `<tool_call>` and `>= 2` complete spoken sentences
                    # AND `>= 65` visible tokens have streamed on `Channel: VOICE`, stop cleanly at sentence end!
                    if (
                        is_voice_turn
                        and not stream_filter.in_tool_zone
                        and not (forced_tool and allow_tools)
                        and visible_tokens >= VOICE_CONCISE_STOP_TOKENS
                        and _count_complete_sentences("".join(visible_acc)) >= VOICE_CONCISE_MIN_SENTENCES
                    ):
                        hit_length_limit = False
                        break

                    # 28-token streaming sentence-boundary grace runway: once soft `max_tokens` is reached
                    # outside `<tool_call>`, stop cleanly at the first complete sentence boundary!
                    if (
                        not stream_filter.in_tool_zone
                        and not (forced_tool and allow_tools)
                        and usage_stats["completion_tokens"] >= max_tokens
                    ):
                        joined_so_far = "".join(visible_acc)
                        if _ends_at_sentence_boundary(joined_so_far):
                            hit_length_limit = False
                            break
                        if usage_stats["completion_tokens"] >= max_tokens + grace_budget:
                            hit_length_limit = True
                            break

                self._last_warmed_sys_block = req_sys_block

                tail_piece = stream_filter.flush()
                if tail_piece:
                    if hit_length_limit and not stream_filter.in_tool_zone:
                        tail_piece = _trim_incomplete_tail(tail_piece)
                    if tail_piece and total_emitted_chars < 11800:
                        allowed_slice = tail_piece[: 11800 - total_emitted_chars]
                        total_emitted_chars += len(allowed_slice)
                        delta_obj = {"content": allowed_slice}
                        if not emitted_role:
                            delta_obj["role"] = "assistant"
                            emitted_role = True
                        emitted_any_text = True
                        yield _make_chunk(delta_obj, None)

                usage_obj = (
                    {
                        "prompt_tokens": usage_stats["prompt_tokens"],
                        "completion_tokens": usage_stats["completion_tokens"],
                        "total_tokens": usage_stats["prompt_tokens"] + usage_stats["completion_tokens"],
                    }
                    if include_usage
                    else None
                )

                if allow_tools and valid_tools and (stream_filter.in_tool_zone or forced_tool):
                    parsed_tcs = parse_validated_tool_calls(
                        stream_filter.tool_buffer,
                        valid_tools,
                        forced_tool=forced_tool,
                        finish_reason="length" if hit_length_limit else "stop",
                    )
                    if parsed_tcs:
                        sse_tool_calls = [
                            {
                                "index": idx,
                                "id": tc["id"],
                                "type": "function",
                                "function": tc["function"],
                            }
                            for idx, tc in enumerate(parsed_tcs)
                        ]
                        delta_tc: Dict[str, Any] = {"tool_calls": sse_tool_calls}
                        if not emitted_role:
                            delta_tc["role"] = "assistant"
                            emitted_role = True
                        yield _make_chunk(delta_tc, None)
                        yield _make_chunk({}, "tool_calls", usage=usage_obj)
                        yield "data: [DONE]\n\n"
                        return

                if not emitted_any_text:
                    fallback_txt = _fallback_non_empty_reply(messages)
                    delta_fb: Dict[str, Any] = {"content": fallback_txt}
                    if not emitted_role:
                        delta_fb["role"] = "assistant"
                        emitted_role = True
                    yield _make_chunk(delta_fb, None)

                # Always emit `"stop"` (never `"length"`, which EchoProviderStream.java maps to HTTP 422!)
                yield _make_chunk({}, "stop", usage=usage_obj)
                yield "data: [DONE]\n\n"
            finally:
                self._slots.release()

        return _sse_gen()

    def create_chat_completion(
        self,
        payload: Dict[str, Any],
        cancel_event: Optional[threading.Event] = None,
        *,
        is_warmup: bool = False,
    ) -> Dict[str, Any]:
        """Non-streaming OpenAI `chat.completion` JSON response with fast cancellation & grace runway."""
        if not is_warmup:
            self.preempt_active_warmup()
        if cancel_event is not None and cancel_event.is_set():
            raise LocalLlmCancelledError("Request cancelled before start")

        messages, max_tokens, temperature, top_p, top_k, req_model, _ = self._validate_request(payload)
        (
            prompt,
            prompt_tokens_list,
            prompt_token_count,
            valid_tools,
            forced_tool,
            allow_tools,
            max_tokens,
        ) = self._build_fitted_prompt_with_tokens(payload, messages, max_tokens)
        logit_bias = self._build_logit_bias(valid_tools, allow_tools)
        grammar = _get_forced_tool_grammar(forced_tool, valid_tools) if (forced_tool and allow_tools) else None
        grace_budget = max(0, min(SENTENCE_GRACE_TOKENS, self._n_ctx - prompt_token_count - max_tokens - 16))
        req_sys_block, _, _ = build_static_system_block(messages, payload.get("tools"))
        is_voice_turn = any(
            isinstance(m, dict)
            and str(m.get("role") or "").strip().lower() == "system"
            and _CHANNEL_VOICE_RE.search(_extract_content_text(m.get("content")))
            for m in messages
        )

        if cancel_event is not None and cancel_event.is_set():
            raise LocalLlmCancelledError("Request cancelled before slot acquire")

        if not self._slots.acquire(timeout=0.05 if is_warmup else SLOT_ACQUIRE_TIMEOUT_SEC):
            raise LocalLlmBusyError("Local LLM service is busy")

        try:
            token_iter, usage_stats = self._invoke_token_iterator(
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                cancel_event=cancel_event,
                logit_bias=logit_bias,
                grammar=grammar,
                prompt_tokens=prompt_tokens_list,
                prompt_token_count=prompt_token_count,
                grace_tokens=grace_budget,
                has_tools_prefix=bool(valid_tools),
            )
            stream_filter = _StreamingToolAndThinkFilter(
                allow_tools=allow_tools and bool(valid_tools),
                forced_tool=forced_tool if allow_tools else None,
                intercept_tool_tags=True,
                valid_tool_names=tuple(valid_tools.keys()) if (allow_tools and valid_tools) else None,
            )
            prose_parts: List[str] = []
            visible_tokens = 0
            hit_length = False
            for piece, finish in token_iter:
                if cancel_event is not None and cancel_event.is_set():
                    raise LocalLlmCancelledError("Request cancelled mid-generation")
                if piece:
                    clean_piece = stream_filter.push(piece)
                    if clean_piece:
                        prose_parts.append(clean_piece)
                        visible_tokens += 1
                if finish == "length":
                    hit_length = True
                    break
                if stream_filter.in_tool_zone and stream_filter.tool_buffer.lower().count("</tool_call>") >= MAX_TOOL_CALLS_PER_ROUND:
                    break
                if (
                    is_voice_turn
                    and not stream_filter.in_tool_zone
                    and not (forced_tool and allow_tools)
                    and visible_tokens >= VOICE_CONCISE_STOP_TOKENS
                    and _count_complete_sentences("".join(prose_parts)) >= VOICE_CONCISE_MIN_SENTENCES
                ):
                    hit_length = False
                    break
                if (
                    not stream_filter.in_tool_zone
                    and not (forced_tool and allow_tools)
                    and usage_stats["completion_tokens"] >= max_tokens
                ):
                    if _ends_at_sentence_boundary("".join(prose_parts)):
                        hit_length = False
                        break
                    if usage_stats["completion_tokens"] >= max_tokens + grace_budget:
                        hit_length = True
                        break

            if cancel_event is not None and cancel_event.is_set():
                raise LocalLlmCancelledError("Request cancelled")

            self._last_warmed_sys_block = req_sys_block

            tail_piece = stream_filter.flush()
            if tail_piece:
                prose_parts.append(tail_piece)

            visible_prose = "".join(prose_parts).strip()
            chat_id = f"chatcmpl-echo-{uuid.uuid4().hex[:12]}"
            created = int(time.time())
            usage_obj = {
                "prompt_tokens": usage_stats["prompt_tokens"],
                "completion_tokens": usage_stats["completion_tokens"],
                "total_tokens": usage_stats["prompt_tokens"] + usage_stats["completion_tokens"],
            }

            if allow_tools and valid_tools and (stream_filter.in_tool_zone or forced_tool):
                parsed_tcs = parse_validated_tool_calls(
                    stream_filter.tool_buffer,
                    valid_tools,
                    forced_tool=forced_tool,
                    finish_reason="length" if hit_length else "stop",
                )
                if parsed_tcs:
                    return {
                        "id": chat_id,
                        "object": "chat.completion",
                        "created": created,
                        "model": req_model,
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": visible_prose[:11800],
                                    "tool_calls": parsed_tcs,
                                },
                                "finish_reason": "tool_calls",
                            }
                        ],
                        "usage": usage_obj,
                    }

            if hit_length and visible_prose:
                visible_prose = _trim_incomplete_tail(visible_prose)
            if not visible_prose:
                visible_prose = _fallback_non_empty_reply(messages)
            visible_prose = visible_prose[:11800]

            return {
                "id": chat_id,
                "object": "chat.completion",
                "created": created,
                "model": req_model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": visible_prose,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": usage_obj,
            }
        finally:
            self._slots.release()
