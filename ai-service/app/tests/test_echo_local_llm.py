"""
Unit tests for Workstream B1 — Provider-Independent Agentic Parity & High-Speed KV-Cached
Tool Calling on Local `Qwen3-4B-Instruct-2507` (`ai-service/app/services/echo_local_llm.py`).
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.coach import router as coach_router
from app.services import echo_local_llm
from app.services.echo_local_llm import (
    QWEN3_TOOL_CALL_TOKEN_ID,
    EchoLocalLlmService,
    _StreamingThinkFilter,
    _StreamingToolAndThinkFilter,
    _get_forced_tool_grammar,
    build_chatml_prompt,
    parse_validated_tool_call,
    parse_validated_tool_calls,
)


def _sample_echo_tools() -> List[Dict[str, Any]]:
    """Representative unsorted subset of Echo JARVIS tools including nested array `prepare_flashcards_batch`."""
    return [
        {
            "type": "function",
            "function": {
                "name": "search_lessons",
                "description": (
                    "Search official English Coach reading, listening, writing, or speaking lessons "
                    "in PostgreSQL with optional level and limit filters for grounded recommendations."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "maxLength": 120,
                            "description": (
                                "Topic or keyword to search across lesson titles, tags, and summaries "
                                "without inventing database identifiers or slugs."
                            ),
                        },
                        "skill": {
                            "type": "string",
                            "enum": ["reading", "listening", "writing", "speaking"],
                            "description": "Target skill module.",
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 10,
                            "description": "Max items to return.",
                        },
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "open_page",
                "description": "Navigate the learner to an English Coach module or specific lesson.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "destination": {
                            "type": "string",
                            "enum": [
                                "dashboard",
                                "reading",
                                "reading_mybooks",
                                "reading_bilingual",
                                "listening",
                                "writing",
                                "writing_sentence_lab",
                                "writing_sentence_mistakes",
                                "writing_paragraph",
                                "writing_translation",
                                "writing_coach",
                                "writing_portfolio",
                                "speaking",
                                "speaking_shadowing",
                                "speaking_pronunciation",
                                "speaking_history",
                                "speaking_roleplay_hub",
                                "speaking_arena",
                                "speaking_profile",
                                "profile",
                                "exams_family",
                                "flashcards",
                                "study_space",
                            ],
                            "description": "Canonical route destination key.",
                        },
                        "family": {
                            "type": "string",
                            "enum": ["ielts", "toeic"],
                            "description": "Optional exam family key.",
                        },
                        "lesson_id": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Optional verified DB lesson ID.",
                        },
                    },
                    "required": ["destination"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "prepare_flashcards_batch",
                "description": "Stage a grounded batch of vocabulary flashcards for learner confirmation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "deck_name": {
                            "type": "string",
                            "pattern": "^[A-Za-z0-9 _\\-]{2,60}$",
                            "maxLength": 60,
                            "description": "Target deck title.",
                        },
                        "cards": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 10,
                            "description": "Flashcards to stage.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "term": {"type": "string", "minLength": 1, "maxLength": 80},
                                    "meaning_vi": {"type": "string", "minLength": 1, "maxLength": 200},
                                    "pos": {
                                        "type": "string",
                                        "enum": ["noun", "verb", "adjective", "adverb", "phrase"],
                                    },
                                },
                                "required": ["term", "meaning_vi"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["cards"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_speaking_profile",
                "description": "Retrieve the learner's pronunciation weak sounds and speaking history summary.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
        },
    ]


@pytest.fixture
def coach_client() -> TestClient:
    app = FastAPI()
    app.include_router(coach_router, prefix="/api/v1")
    return TestClient(app)


def test_qwen3_native_tools_template_schema_fidelity_and_static_prefix_kv_reuse():
    tools = _sample_echo_tools()
    static_core = (
        "You are Echo, the PROFESSOR-grade AI English Coach on English Coach.\n"
        "Follow grounded pedagogy and never fabricate lesson IDs."
    )
    sys_learner_a = (
        f"{static_core}\n\n"
        "--- DYNAMIC TURN CONTEXT ---\n"
        "Learner profile: Minh (CEFR B1, goal IELTS 6.5)\n"
        "Current page: /reading (BILINGUAL_READING)"
    )
    sys_learner_b = (
        f"{static_core}\n\n"
        "--- DYNAMIC TURN CONTEXT ---\n"
        "Learner profile: Lan (CEFR C1, goal IELTS 8.0)\n"
        "Current page: /speaking (SPEAKING_SCENARIO, excerpt='Urbanization transforms modern cities...')"
    )

    prompt_a, valid_tools_a, forced_a, allow_a = build_chatml_prompt(
        messages=[
            {"role": "system", "content": sys_learner_a},
            {"role": "user", "content": "Explain present perfect briefly."},
        ],
        tools=tools,
        tool_choice="auto",
    )
    prompt_b, valid_tools_b, forced_b, allow_b = build_chatml_prompt(
        messages=[
            {"role": "system", "content": sys_learner_b},
            {"role": "user", "content": "How is my pronunciation lately?"},
        ],
        tools=list(reversed(tools)),  # Reversed input order must still sort deterministically!
        tool_choice="auto",
    )

    assert forced_a is None and forced_b is None
    assert allow_a is True and allow_b is True
    assert list(valid_tools_a.keys()) == [
        "get_speaking_profile",
        "open_page",
        "prepare_flashcards_batch",
        "search_lessons",
    ]
    assert list(valid_tools_a.keys()) == list(valid_tools_b.keys())

    # 1. Exact Qwen3 native ChatML `# Tools` + `<tools>` + `<tool_call>` format
    assert "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n" in prompt_a
    assert "You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n" in prompt_a
    assert (
        '</tools>\n\nFor each function call, return a json object with function name and arguments within '
        '<tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
    ) in prompt_a

    # 2. 100% Immutable `<|im_start|>system` KV prefix: `[Static System Core + # Tools ... </tool_call>]` ONLY inside
    #    `<|im_start|>system`, while `--- DYNAMIC TURN CONTEXT ---` sits right before the final `user` turn!
    tools_end_marker = '{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
    end_idx_a = prompt_a.index(tools_end_marker) + len(tools_end_marker)
    end_idx_b = prompt_b.index(tools_end_marker) + len(tools_end_marker)
    sys_end_a = prompt_a.index("<|im_end|>") + len("<|im_end|>")
    sys_end_b = prompt_b.index("<|im_end|>") + len("<|im_end|>")
    dyn_idx_a = prompt_a.index("--- DYNAMIC TURN CONTEXT ---")
    dyn_idx_b = prompt_b.index("--- DYNAMIC TURN CONTEXT ---")

    assert end_idx_a < sys_end_a < dyn_idx_a
    assert end_idx_b < sys_end_b < dyn_idx_b
    assert "--- DYNAMIC TURN CONTEXT ---" not in prompt_a[:sys_end_a]
    # 100% byte-for-byte identical `<|im_start|>system...<|im_end|>` prefix across different users, pages, and tool orders!
    assert prompt_a[:sys_end_a] == prompt_b[:sys_end_b]

    # 3. Verify lossless `<tools>` prompt compaction preserves `type`, `enum`, non-empty `required`, small `minimum`/`maximum`,
    #    `pattern`, `minItems`/`maxItems`, and nested `items`, while stripping validator-only noise (`additionalProperties: false`,
    #    empty `required: []`, `maxLength`, `>=1e9` sentinel `maximum`, leading `"Optional "`) in prompt text ONLY!
    tools_xml_inner = prompt_a.split("<tools>\n", 1)[1].split("\n</tools>", 1)[0]
    tool_entries = [json.loads(line) for line in tools_xml_inner.splitlines()]
    assert [t["function"]["name"] for t in tool_entries] == [
        "get_speaking_profile",
        "open_page",
        "prepare_flashcards_batch",
        "search_lessons",
    ]

    by_name = {t["function"]["name"]: t["function"]["parameters"] for t in tool_entries}
    search_params = by_name["search_lessons"]
    assert search_params["type"] == "object"
    assert search_params["required"] == ["query"]
    assert "additionalProperties" not in search_params
    assert search_params["properties"]["skill"]["enum"] == ["reading", "listening", "writing", "speaking"]
    assert search_params["properties"]["limit"]["minimum"] == 1
    assert search_params["properties"]["limit"]["maximum"] == 10
    assert "maxLength" not in search_params["properties"]["query"]
    assert len(search_params["properties"]["query"]["description"]) <= 48

    # Leading `"Optional "` stripped cleanly and `open_page` uses complete non-clipped 1-line rule override
    open_entry = next(t["function"] for t in tool_entries if t["function"]["name"] == "open_page")
    assert not open_entry["description"].endswith("...")
    assert "cosmos_word with word" in open_entry["description"]
    assert by_name["open_page"]["properties"]["family"]["description"] == "Exam family key."
    assert "required" not in by_name["get_speaking_profile"]

    batch_params = by_name["prepare_flashcards_batch"]
    assert batch_params["required"] == ["cards"]
    assert "additionalProperties" not in batch_params
    assert batch_params["properties"]["deck_name"]["pattern"] == "^[A-Za-z0-9 _\\-]{2,60}$"
    cards_prop = batch_params["properties"]["cards"]
    assert cards_prop["type"] == "array"
    assert cards_prop["minItems"] == 1
    assert cards_prop["maxItems"] == 10
    assert cards_prop["items"]["type"] == "object"
    assert cards_prop["items"]["required"] == ["term", "meaning_vi"]
    assert "additionalProperties" not in cards_prop["items"]
    assert cards_prop["items"]["properties"]["pos"]["enum"] == [
        "noun",
        "verb",
        "adjective",
        "adverb",
        "phrase",
    ]
    # Full raw `valid_tools_a` still retains `additionalProperties: False` and `maxLength` for strict runtime validation!
    assert valid_tools_a["search_lessons"]["parameters"]["additionalProperties"] is False
    assert valid_tools_a["search_lessons"]["parameters"]["properties"]["query"]["maxLength"] == 120


def test_multi_round_chatml_serialization_bundled_tool_responses_and_round1_parity():
    tools = _sample_echo_tools()
    sys_msg = {
        "role": "system",
        "content": "Static system core.\n\n--- DYNAMIC TURN CONTEXT ---\nPage: /dashboard",
    }
    round1_messages = [
        sys_msg,
        {"role": "user", "content": "Find an IELTS reading lesson and check my speaking profile, then open it."},
        {
            "role": "assistant",
            "content": "Let me look up both for you right now.",
            "tool_calls": [
                {
                    "id": "call_0",
                    "type": "function",
                    "function": {
                        "name": "search_lessons",
                        "arguments": '{"query": "IELTS", "skill": "reading", "limit": 2}',
                    },
                },
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "get_speaking_profile",
                        "arguments": "{}",
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_0",
            "content": '{"lessons":[{"id":42,"title":"IELTS Academic Passage 1"}]}',
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": '{"weakPhonemes":["/θ/","/ð/"]}',
        },
    ]

    prompt_r1, _, forced_r1, allow_r1 = build_chatml_prompt(
        messages=round1_messages,
        tools=tools,
        tool_choice="auto",
    )

    # Round 1 MUST still allow tool calls so Qwen3 can call `open_page(destination="reading", lesson_id=42)`!
    assert forced_r1 is None
    assert allow_r1 is True

    # Historical assistant `tool_calls` must emit raw JSON objects (NEVER double-escaped `"arguments": "{\"query\"..."`)
    expected_assistant_block = (
        "<|im_start|>assistant\n"
        "Let me look up both for you right now.\n"
        "<tool_call>\n"
        '{"name": "search_lessons", "arguments": {"query": "IELTS", "skill": "reading", "limit": 2}}\n'
        "</tool_call>\n"
        "<tool_call>\n"
        '{"name": "get_speaking_profile", "arguments": {}}\n'
        "</tool_call><|im_end|>"
    )
    assert expected_assistant_block in prompt_r1
    assert '\\"query\\"' not in prompt_r1

    # Consecutive `role="tool"` messages must be bundled into ONE `<|im_start|>user` block with NO `id="..."`
    expected_bundled_tool_block = (
        "<|im_start|>user\n"
        "<tool_response>\n"
        '{"lessons":[{"id":42,"title":"IELTS Academic Passage 1"}]}\n'
        "</tool_response>\n"
        "<tool_response>\n"
        '{"weakPhonemes":["/θ/","/ð/"]}\n'
        "</tool_response><|im_end|>"
    )
    assert expected_bundled_tool_block in prompt_r1
    assert "<tool_response id=" not in prompt_r1

    # Defense-in-depth guard: after 3 tool-call rounds in the SAME turn, `allow_tools` turns False
    round3_messages = list(round1_messages) + [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_2", "type": "function", "function": {"name": "open_page", "arguments": '{"destination":"reading"}'}}],
        },
        {"role": "tool", "tool_call_id": "call_2", "content": '{"ok":true}'},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_3", "type": "function", "function": {"name": "get_speaking_profile", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "call_3", "content": '{"ok":true}'},
    ]
    prompt_r3, _, _, allow_r3 = build_chatml_prompt(messages=round3_messages, tools=tools, tool_choice="auto")
    assert allow_r3 is False
    # `<tools>` block is STILL preserved in system prompt so KV prefix is not evicted!
    assert "<tools>\n" in prompt_r3

    # A brand-new user turn resets the active round counter back to 0 -> `allow_tools` is True again!
    next_turn_messages = round3_messages + [
        {"role": "assistant", "content": "Opened IELTS Passage 1 for you!"},
        {"role": "user", "content": "Now open Shadowing please."},
    ]
    _, _, _, allow_next_turn = build_chatml_prompt(messages=next_turn_messages, tools=tools, tool_choice="auto")
    assert allow_next_turn is True


def test_tool_choice_none_preserves_kv_prefix_and_suppresses_tool_calls(monkeypatch, coach_client: TestClient):
    tools = _sample_echo_tools()
    messages = [
        {
            "role": "system",
            "content": "Core system prompt.\n\n--- DYNAMIC TURN CONTEXT ---\nLearner: B2",
        },
        {"role": "user", "content": "Summarize the search results."},
    ]

    prompt_auto, _, _, allow_auto = build_chatml_prompt(messages, tools=tools, tool_choice="auto")
    prompt_none, valid_none, _, allow_none = build_chatml_prompt(messages, tools=tools, tool_choice="none")
    prompt_no_tools, valid_empty, _, allow_empty = build_chatml_prompt(messages, tools=None, tool_choice="auto")

    # `tool_choice="none"` with `tools` provided MUST produce the EXACT same prompt string as `tool_choice="auto"`!
    assert allow_auto is True
    assert allow_none is False
    assert len(valid_none) == 4
    assert prompt_none == prompt_auto

    # When `tools` is omitted/empty, `<tools>` is omitted normally
    assert valid_empty == {}
    assert allow_empty is False
    assert "<tools>" not in prompt_no_tools

    # Verify `logit_bias` bans Qwen3 `<tool_call>` token (151657) AND tool parsing is suppressed
    svc = EchoLocalLlmService()
    captured_kwargs: List[Dict[str, Any]] = []

    class FakeLlama:
        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            assert text_bytes == b"<tool_call>"
            assert add_bos is False and special is True
            return [QWEN3_TOOL_CALL_TOKEN_ID]

        def create_completion(self, **kwargs):
            captured_kwargs.append(kwargs)
            # Even if a model hypothetically emitted `<tool_call>`, `allow_tools=False` suppresses tool execution & XML leak!
            return iter(
                [
                    {"choices": [{"text": "Here is your concise summary.\n<tool_call>", "finish_reason": None}]},
                    {
                        "choices": [
                            {
                                "text": '{"name":"open_page","arguments":{"destination":"reading"}}</tool_call>',
                                "finish_reason": "stop",
                            }
                        ]
                    },
                ]
            )

    fake_llama = FakeLlama()
    svc._llm = fake_llama
    svc._tool_call_token_ids = svc._discover_tool_call_token_ids(fake_llama)
    assert svc._tool_call_token_ids == [151657]
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))

    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "model": "qwen3-4b-instruct-2507-q4_k_m",
            "stream": True,
            "messages": messages,
            "tools": tools,
            "tool_choice": "none",
        },
    ) as resp:
        assert resp.status_code == 200
        lines = [ln for ln in resp.iter_lines() if ln]

    assert len(captured_kwargs) == 1
    assert captured_kwargs[0]["logit_bias"] == {151657: -100.0}
    assert captured_kwargs[0]["repeat_penalty"] == 1.0
    assert captured_kwargs[0]["top_p"] == pytest.approx(0.80)
    assert captured_kwargs[0]["top_k"] == 20

    frames = [json.loads(ln[6:]) for ln in lines[:-1] if ln.startswith("data: ")]
    content = "".join(f["choices"][0]["delta"].get("content", "") for f in frames)
    assert content == "Here is your concise summary."
    assert "<tool_call>" not in content
    assert all("tool_calls" not in f["choices"][0]["delta"] for f in frames)
    assert frames[-1]["choices"][0]["finish_reason"] == "stop"


def test_kv_cache_sizing_n_ctx_threads_and_validation_ceilings(monkeypatch):
    for env_key in (
        "ECHO_LOCAL_LLM_N_CTX",
        "ECHO_LOCAL_LLM_CTX",
        "ECHO_LOCAL_LLM_BATCH",
        "ECHO_LOCAL_LLM_UBATCH",
        "ECHO_LOCAL_LLM_FLASH_ATTN",
        "ECHO_LOCAL_LLM_KV_QUANT",
        "ECHO_LOCAL_LLM_THREADS",
        "ECHO_LOCAL_LLM_THREADS_BATCH",
        "ECHO_LOCAL_LLM_CACHE_MB",
        "ECHO_LOCAL_LLM_USE_RAM_CACHE",
        "OMP_WAIT_POLICY",
        "GOMP_SPINCOUNT",
    ):
        monkeypatch.delenv(env_key, raising=False)

    svc = EchoLocalLlmService()
    assert svc.n_gpu_layers == 0
    assert svc._n_ctx == 12288
    assert svc._n_batch == 512
    assert svc._n_ubatch == 512
    assert svc._flash_attn is False
    assert svc._kv_quant == "f16"
    assert svc._use_ram_cache is False
    assert svc._cache_capacity_bytes == 0  # Zero-copy in-place C++ KV retention by default!
    assert svc._n_threads == min(12, max(4, (os.cpu_count() or 8) // 2))
    assert svc._n_threads_batch == max(svc._n_threads, min(16, os.cpu_count() or 8))
    assert os.environ.get("GOMP_SPINCOUNT") is None
    assert os.environ.get("OMP_WAIT_POLICY") is None

    # Verify `_validate_request` clamps `max_tokens` to 1024, defaults `top_p=0.80`/`top_k=20`,
    # preserves 42-46 message multi-tool histories intact (zero premature front-slice KV invalidation!),
    # and bounds >96-message conversations cleanly to <=96 messages with system + user alignment!
    msgs_46 = [{"role": "system", "content": "Sys"}] + [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"} for i in range(45)
    ]
    validated_msgs, max_tok, temp, top_p, top_k, _, _ = svc._validate_request(
        {"messages": msgs_46, "max_tokens": 2048}
    )
    assert len(validated_msgs) == 46
    assert max_tok == 1024
    assert temp == pytest.approx(0.35)
    assert top_p == pytest.approx(0.80)
    assert top_k == 20

    msgs_106 = [{"role": "system", "content": "Sys"}] + [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i}"} for i in range(105)
    ]
    trimmed_msgs, _, _, _, _, _, _ = svc._validate_request({"messages": msgs_106})
    assert len(trimmed_msgs) == 96
    assert trimmed_msgs[0]["role"] == "system"
    assert trimmed_msgs[1]["role"] == "user"
    assert trimmed_msgs[-1]["content"] == "turn 104"

    # 1. Default zero-copy FP16 mode (`ECHO_LOCAL_LLM_KV_QUANT=f16`, `flash_attn=False`):
    #    `n_ctx=12288`, `n_batch=512`, `type_k`/`type_v` omitted (`100%` `kv_cache_seq_rm` reuse), `set_cache` NOT called!
    import llama_cpp

    init_record: Dict[str, Any] = {}

    class StubCache:
        def __init__(self, capacity_bytes: int):
            init_record["cache_capacity_bytes"] = capacity_bytes

    class StubLlama:
        def __init__(self, **kwargs):
            init_record["llama_kwargs"] = kwargs

        def set_cache(self, cache_obj: Any) -> None:
            init_record["cache_obj"] = cache_obj

        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            init_record["tokenized"] = (text_bytes, add_bos, special)
            return [151657]

    monkeypatch.setattr(llama_cpp, "Llama", StubLlama)
    monkeypatch.setattr(llama_cpp, "LlamaRAMCache", StubCache)
    monkeypatch.setattr(svc, "_resolve_gguf_path", lambda: ("/tmp/qwen3-4b.gguf", "qwen3-4b-instruct-2507-q4_k_m"))

    svc.load_model()
    assert init_record["llama_kwargs"]["n_gpu_layers"] == 0
    assert init_record["llama_kwargs"]["n_ctx"] == 12288
    assert init_record["llama_kwargs"]["n_batch"] == 512
    assert init_record["llama_kwargs"]["n_ubatch"] == 512
    assert init_record["llama_kwargs"]["flash_attn"] is False
    assert "type_k" not in init_record["llama_kwargs"]
    assert "type_v" not in init_record["llama_kwargs"]
    assert init_record["llama_kwargs"]["n_threads"] == min(12, max(4, (os.cpu_count() or 8) // 2))
    assert init_record["llama_kwargs"]["n_threads_batch"] == max(
        init_record["llama_kwargs"]["n_threads"],
        min(16, os.cpu_count() or 8),
    )
    assert "cache_obj" not in init_record
    assert "cache_capacity_bytes" not in init_record
    assert init_record["tokenized"] == (b"<tool_call>", False, True)
    assert svc._tool_call_token_ids == [151657]
    assert svc._kv_quant == "f16"

    # 1a. Explicit opt-in `ECHO_LOCAL_LLM_FLASH_ATTN=1` + `ECHO_LOCAL_LLM_KV_QUANT=q8_0`
    monkeypatch.setenv("ECHO_LOCAL_LLM_FLASH_ATTN", "1")
    monkeypatch.setenv("ECHO_LOCAL_LLM_KV_QUANT", "q8_0")
    svc_q8 = EchoLocalLlmService()
    monkeypatch.setattr(svc_q8, "_resolve_gguf_path", lambda: ("/tmp/qwen3-4b.gguf", "qwen3-4b-instruct-2507-q4_k_m"))
    init_record.clear()
    svc_q8.load_model()
    assert init_record["llama_kwargs"]["flash_attn"] is True
    assert init_record["llama_kwargs"]["type_k"] == 8
    assert init_record["llama_kwargs"]["type_v"] == 8
    assert svc_q8._kv_quant == "q8_0"
    monkeypatch.delenv("ECHO_LOCAL_LLM_FLASH_ATTN", raising=False)
    monkeypatch.delenv("ECHO_LOCAL_LLM_KV_QUANT", raising=False)

    # 1b. Safe FP16 fallback when an older wheel / strict mock rejects `n_ubatch`/`flash_attn`
    class LegacyStubLlama:
        def __init__(self, *, model_path, n_gpu_layers, n_ctx, n_batch, n_threads, n_threads_batch, use_mmap, verbose):
            init_record["legacy_kwargs"] = {
                "n_ctx": n_ctx,
                "n_batch": n_batch,
                "n_threads": n_threads,
                "n_threads_batch": n_threads_batch,
            }

        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            return [151657]

    monkeypatch.setattr(llama_cpp, "Llama", LegacyStubLlama)
    svc_legacy = EchoLocalLlmService()
    monkeypatch.setattr(svc_legacy, "_resolve_gguf_path", lambda: ("/tmp/qwen3-4b.gguf", "qwen3-4b-instruct-2507-q4_k_m"))
    svc_legacy.load_model()
    assert init_record["legacy_kwargs"]["n_ctx"] == 12288
    assert init_record["legacy_kwargs"]["n_batch"] == 512
    assert svc_legacy._kv_quant == "f16-fallback"
    monkeypatch.setattr(llama_cpp, "Llama", StubLlama)

    # 2. Explicit `ECHO_LOCAL_LLM_USE_RAM_CACHE=1` opt-in attaches 1 GiB LlamaRAMCache
    monkeypatch.setenv("ECHO_LOCAL_LLM_USE_RAM_CACHE", "1")
    svc_optin = EchoLocalLlmService()
    monkeypatch.setattr(
        svc_optin, "_resolve_gguf_path", lambda: ("/tmp/qwen3-4b.gguf", "qwen3-4b-instruct-2507-q4_k_m")
    )
    init_record.clear()
    svc_optin.load_model()
    assert svc_optin._use_ram_cache is True
    assert init_record["cache_capacity_bytes"] == 1024 * 1024 * 1024
    assert "cache_obj" in init_record


def test_streaming_filter_think_prose_preamble_zero_leak_and_parallel_tool_calls(
    monkeypatch, coach_client: TestClient
):
    # Backward-compatible alias check
    assert _StreamingThinkFilter is _StreamingToolAndThinkFilter

    tools = _sample_echo_tools()
    svc = EchoLocalLlmService()
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))

    # (a) `<think>...</think>` split across sub-word tokens + pure `<tool_call>`
    def fake_think_then_tool(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        chunks = [
            ("<th", None),
            ("ink>internal plan</th", None),
            ("ink>\n<tool_", None),
            ('call>\n{"name":"get_speaking_profile","arguments":{}}\n</tool_call>', "stop"),
        ]
        return iter(chunks), {"prompt_tokens": 120, "completion_tokens": 16}

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_think_then_tool)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "How is my speaking pronunciation?"}],
            "tools": tools,
            "tool_choice": "auto",
        },
    ) as r_a:
        assert r_a.status_code == 200
        frames_a = [json.loads(ln[6:]) for ln in r_a.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"]

    assert "".join(f["choices"][0]["delta"].get("content", "") for f in frames_a) == ""
    tc_a = [f["choices"][0]["delta"]["tool_calls"] for f in frames_a if "tool_calls" in f["choices"][0]["delta"]]
    assert len(tc_a) == 1
    assert tc_a[0][0]["function"] == {"name": "get_speaking_profile", "arguments": "{}"}
    assert frames_a[-1]["choices"][0]["finish_reason"] == "tool_calls"

    # (b) Spoken prose BEFORE `<tool_call>` split across chunks -> streams prose immediately with ZERO `<tool_call>` leak!
    def fake_prose_then_tool(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        chunks = [
            ("<think>check route</think>Let me explain ", None),
            ("shadowing first.\n<tool_", None),
            ('call>{"name":"open_page",', None),
            ('"arguments":{"destination":"speaking_shadowing"}}</tool_', None),
            ("call><|im_", None),
            ("end|>", "stop"),
        ]
        return iter(chunks), {"prompt_tokens": 140, "completion_tokens": 28}

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_prose_then_tool)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "Explain shadowing and open it for me."}],
            "tools": tools,
            "tool_choice": "auto",
        },
    ) as r_b:
        assert r_b.status_code == 200
        frames_b = [json.loads(ln[6:]) for ln in r_b.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"]

    streamed_prose = "".join(f["choices"][0]["delta"].get("content", "") for f in frames_b)
    assert streamed_prose == "Let me explain shadowing first."
    assert "<tool" not in streamed_prose and "open_page" not in streamed_prose and "<|im_" not in streamed_prose
    tc_b = [f["choices"][0]["delta"]["tool_calls"] for f in frames_b if "tool_calls" in f["choices"][0]["delta"]]
    assert len(tc_b) == 1
    assert tc_b[0] == [
        {
            "index": 0,
            "id": "call_0",
            "type": "function",
            "function": {"name": "open_page", "arguments": '{"destination": "speaking_shadowing"}'},
        }
    ]
    assert frames_b[-1]["choices"][0]["finish_reason"] == "tool_calls"

    # Non-streaming parity for spoken prose + `<tool_call>`
    r_b_json = coach_client.post(
        "/api/v1/coach/chat/completions",
        json={
            "stream": False,
            "messages": [{"role": "user", "content": "Explain shadowing and open it for me."}],
            "tools": tools,
            "tool_choice": "auto",
        },
    ).json()
    msg_b = r_b_json["choices"][0]["message"]
    assert msg_b["content"] == "Let me explain shadowing first."
    assert msg_b["tool_calls"][0]["function"]["name"] == "open_page"
    assert r_b_json["choices"][0]["finish_reason"] == "tool_calls"

    # (c) Parallel `<tool_call>` blocks (`index: 0` and `index: 1`) in a single round!
    def fake_parallel_tools(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        chunks = [
            ('<tool_call>\n{"name":"search_lessons","arguments":{"query":"IELTS","skill":"reading","limit":"3"}}\n</tool_call>\n', None),
            ('<tool_call>\n{"name":"get_speaking_profile","arguments":{}}\n</tool_call>', "stop"),
        ]
        return iter(chunks), {"prompt_tokens": 150, "completion_tokens": 35}

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_parallel_tools)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "Search IELTS reading and check speaking profile"}],
            "tools": tools,
            "tool_choice": "auto",
        },
    ) as r_c:
        assert r_c.status_code == 200
        frames_c = [json.loads(ln[6:]) for ln in r_c.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"]

    assert "".join(f["choices"][0]["delta"].get("content", "") for f in frames_c) == ""
    tc_c = [f["choices"][0]["delta"]["tool_calls"] for f in frames_c if "tool_calls" in f["choices"][0]["delta"]]
    assert len(tc_c) == 1
    assert len(tc_c[0]) == 2
    assert tc_c[0][0]["index"] == 0 and tc_c[0][0]["id"] == "call_0"
    assert tc_c[0][0]["function"]["name"] == "search_lessons"
    # Stringified integer `"3"` coerced cleanly to integer `3`!
    assert json.loads(tc_c[0][0]["function"]["arguments"]) == {"query": "IELTS", "skill": "reading", "limit": 3}
    assert tc_c[0][1]["index"] == 1 and tc_c[0][1]["id"] == "call_1"
    assert tc_c[0][1]["function"]["name"] == "get_speaking_profile"
    assert frames_c[-1]["choices"][0]["finish_reason"] == "tool_calls"


def test_schema_validation_nested_flashcards_batch_coercion_truncation_and_forced_grammar(
    monkeypatch, coach_client: TestClient
):
    _, valid_tools, _, _ = build_chatml_prompt(
        [{"role": "user", "content": "Create flashcards"}],
        tools=_sample_echo_tools(),
    )

    # 1. Valid nested `prepare_flashcards_batch` passes!
    valid_batch_raw = (
        "<tool_call>\n"
        + json.dumps(
            {
                "name": "prepare_flashcards_batch",
                "arguments": {
                    "deck_name": "IELTS Reading Unit 4",
                    "cards": [
                        {"term": "mitigate", "meaning_vi": "giảm thiểu", "pos": "verb"},
                        {"term": "ubiquitous", "meaning_vi": "phổ biến khắp nơi", "pos": "adjective"},
                    ],
                },
            },
            ensure_ascii=False,
        )
        + "\n</tool_call>"
    )
    parsed_ok = parse_validated_tool_calls(valid_batch_raw, valid_tools)
    assert len(parsed_ok) == 1
    assert parsed_ok[0]["function"]["name"] == "prepare_flashcards_batch"
    assert len(json.loads(parsed_ok[0]["function"]["arguments"])["cards"]) == 2
    assert parse_validated_tool_call(valid_batch_raw, valid_tools) == parsed_ok[0]

    # 2. Reject unknown top-level or nested properties (`additionalProperties: false`) on non-`open_page` tools
    unknown_top = '<tool_call>{"name":"search_lessons","arguments":{"query":"IELTS","bogus":true}}</tool_call>'
    assert parse_validated_tool_calls(unknown_top, valid_tools) == []

    unknown_nested = (
        '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"cards":['
        '{"term":"mitigate","meaning_vi":"giảm thiểu","extra_field":"bad"}]}}</tool_call>'
    )
    assert parse_validated_tool_calls(unknown_nested, valid_tools) == []

    # 3. Reject invalid `enum`, missing `required`, `minimum`/`maximum`, `minItems`, `maxLength`, and `pattern`
    bad_enum = '<tool_call>{"name":"open_page","arguments":{"destination":"nonexistent_route"}}</tool_call>'
    assert parse_validated_tool_calls(bad_enum, valid_tools) == []

    bad_nested_enum = (
        '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"cards":['
        '{"term":"mitigate","meaning_vi":"giảm thiểu","pos":"interjection"}]}}</tool_call>'
    )
    assert parse_validated_tool_calls(bad_nested_enum, valid_tools) == []

    missing_nested_req = (
        '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"cards":[{"term":"mitigate"}]}}</tool_call>'
    )
    assert parse_validated_tool_calls(missing_nested_req, valid_tools) == []

    empty_cards = '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"cards":[]}}</tool_call>'
    assert parse_validated_tool_calls(empty_cards, valid_tools) == []

    out_of_range = '<tool_call>{"name":"search_lessons","arguments":{"query":"IELTS","limit":99}}</tool_call>'
    assert parse_validated_tool_calls(out_of_range, valid_tools) == []

    bad_pattern = (
        '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"deck_name":"bad$deck!",'
        '"cards":[{"term":"a","meaning_vi":"b"}]}}</tool_call>'
    )
    assert parse_validated_tool_calls(bad_pattern, valid_tools) == []

    # 4. Recover truncated `<tool_call>{...` when `finish_reason == "length"` cut off `</tool_call>`
    truncated = '<tool_call>\n{"name": "open_page", "arguments": {"destination": "reading", "lesson_id": "12"}'
    recovered = parse_validated_tool_calls(truncated, valid_tools, finish_reason="length")
    assert len(recovered) == 1
    assert json.loads(recovered[0]["function"]["arguments"]) == {"destination": "reading", "lesson_id": 12}

    # 5. Forced-tool `LlamaGrammar` caching + bare JSON streaming (`0` leak into `delta.content`)
    echo_local_llm._GRAMMAR_CACHE.clear()
    g1 = _get_forced_tool_grammar("prepare_flashcards_batch", valid_tools)
    g2 = _get_forced_tool_grammar("prepare_flashcards_batch", valid_tools)
    assert g1 is not None and g1 is g2

    svc = EchoLocalLlmService()
    seen_grammar = []

    def fake_forced_bare_json(prompt, max_tokens, temperature, top_p, cancel_event=None, *, grammar=None, **kwargs):
        seen_grammar.append(grammar)
        return (
            iter(
                [
                    ('{"na', None),
                    ('me": "open_page", "arguments": {"destination": "flashcards"}}', "stop"),
                ]
            ),
            {"prompt_tokens": 95, "completion_tokens": 14},
        )

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_forced_bare_json)
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))

    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "Take me to flashcards"}],
            "tools": _sample_echo_tools(),
            "tool_choice": {"type": "function", "function": {"name": "open_page"}},
        },
    ) as r_forced:
        assert r_forced.status_code == 200
        f_forced = [
            json.loads(ln[6:]) for ln in r_forced.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"
        ]

    assert len(seen_grammar) == 1 and seen_grammar[0] is not None
    assert "".join(f["choices"][0]["delta"].get("content", "") for f in f_forced) == ""
    tc_f = [f["choices"][0]["delta"]["tool_calls"] for f in f_forced if "tool_calls" in f["choices"][0]["delta"]]
    assert tc_f[0][0]["function"] == {"name": "open_page", "arguments": '{"destination": "flashcards"}'}
    assert f_forced[-1]["choices"][0]["finish_reason"] == "tool_calls"


def test_wave_c_fallback_language_sparkle_hygiene_and_open_page_aliases(monkeypatch, coach_client: TestClient):
    from app.services.echo_local_llm import _fallback_non_empty_reply, strip_think_and_markers

    # 1. Wave C [P1-3]: `system` mentioning `"In Vietnamese, always refer..."` MUST NOT misdetect English Turn 1!
    en_turn1 = [
        {"role": "system", "content": "In Vietnamese, always refer to the learner as 'bạn'."},
        {"role": "user", "content": "Hello Echo, could you help me with IELTS Reading"},
    ]
    fb_en = _fallback_non_empty_reply(en_turn1)
    assert fb_en == "I'm right here with you. Let me know how you'd like me to help."
    assert "practice" not in fb_en.lower() and "?" not in fb_en

    # ASCII-ambiguous user input with explicit turn-language directive in `system` -> Vietnamese
    vi_directive_turn = [
        {
            "role": "system",
            "content": "Core rules.\n--- DYNAMIC TURN CONTEXT ---\nPreferred explanation language for this turn: Vietnamese",
        },
        {"role": "user", "content": "ok"},
    ]
    fb_vi_dir = _fallback_non_empty_reply(vi_directive_turn)
    assert fb_vi_dir == "Mình đang ở đây cùng bạn. Bạn cứ nói rõ thêm điều bạn cần nhé."
    assert "luyện tập" not in fb_vi_dir.lower() and "?" not in fb_vi_dir

    # Vietnamese diacritics in user turn -> Vietnamese
    fb_vi = _fallback_non_empty_reply(
        [
            {"role": "system", "content": "Preferred explanation language for this turn: English"},
            {"role": "user", "content": "Chào Echo, giải thích giúp mình thì hiện tại hoàn thành"},
        ]
    )
    assert fb_vi == "Mình đang ở đây cùng bạn. Bạn cứ nói rõ thêm điều bạn cần nhé."

    # 2. Zero `✨` (`\u2728`) sparkle character hygiene in `strip_think_and_markers`, SSE, and JSON
    assert "\u2728" not in strip_think_and_markers("✨ Great job! ✨")
    assert strip_think_and_markers("<think>plan</think>✨Hello world✨").strip() == "Hello world"

    svc = EchoLocalLlmService()

    def fake_sparkle_tokens(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        return (
            iter([("✨ Sure! ", None), ("Here is your answer ✨.", "stop")]),
            {"prompt_tokens": 50, "completion_tokens": 8},
        )

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_sparkle_tokens)
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))

    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={"stream": True, "messages": [{"role": "user", "content": "Hi"}]},
    ) as r_sse:
        sse_frames = [
            json.loads(ln[6:]) for ln in r_sse.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"
        ]
    sse_txt = "".join(f["choices"][0]["delta"].get("content", "") for f in sse_frames)
    assert "\u2728" not in sse_txt
    assert sse_txt == "Sure! Here is your answer ."

    r_json = coach_client.post(
        "/api/v1/coach/chat/completions",
        json={"stream": False, "messages": [{"role": "user", "content": "Hi"}]},
    ).json()
    assert "\u2728" not in r_json["choices"][0]["message"]["content"]

    # 3. Safe `open_page` destination alias recovery (`ho_3`: `"sentence_lab"` -> `"writing_sentence_lab"`, etc.)
    _, valid_tools, _, _ = build_chatml_prompt([{"role": "user", "content": "open"}], tools=_sample_echo_tools())
    alias_cases = [
        ("sentence_lab", {"destination": "writing_sentence_lab"}),
        ("my_books", {"destination": "reading_mybooks"}),
        ("bookshelf", {"destination": "reading_mybooks"}),
        ("bilingual", {"destination": "reading_bilingual"}),
        ("pronunciation", {"destination": "speaking_pronunciation"}),
        ("pronunciation_analytics", {"destination": "speaking_pronunciation"}),
        ("shadowing", {"destination": "speaking_shadowing"}),
        ("roleplay", {"destination": "speaking_roleplay_hub"}),
        ("arena", {"destination": "speaking_arena"}),
        ("ielts", {"destination": "exams_family", "family": "ielts"}),
        ("toeic", {"destination": "exams_family", "family": "toeic"}),
    ]
    for shorthand, expected_args in alias_cases:
        raw_tc = f'<tool_call>{{"name":"open_page","arguments":{{"destination":"{shorthand}"}}}}</tool_call>'
        calls = parse_validated_tool_calls(raw_tc, valid_tools)
        assert len(calls) == 1, f"Expected alias '{shorthand}' to recover cleanly"
        assert json.loads(calls[0]["function"]["arguments"]) == expected_args

    # 4. Upgrade `writing`/`profile`/`speaking_profile` + `section`/`tab`/`sub`/`view`/`mode` hints AND strip redundant extra keys!
    hint_upgrade_cases = [
        (
            {"destination": "writing", "section": "Sentence Lab", "module": "writing"},
            {"destination": "writing_sentence_lab"},
        ),
        (
            {"destination": "writing", "tab": "mistakes"},
            {"destination": "writing_sentence_mistakes"},
        ),
        (
            {"destination": "writing", "sub": "paragraph"},
            {"destination": "writing_paragraph"},
        ),
        (
            {"destination": "writing", "view": "translation"},
            {"destination": "writing_translation"},
        ),
        (
            {"destination": "writing", "mode": "coach"},
            {"destination": "writing_coach"},
        ),
        (
            {"destination": "writing", "section": "portfolio"},
            {"destination": "writing_portfolio"},
        ),
        (
            {"destination": "profile", "tab": "pronunciation"},
            {"destination": "speaking_pronunciation"},
        ),
        (
            {"destination": "speaking_profile", "section": "history"},
            {"destination": "speaking_history"},
        ),
        (
            {"destination": "writing_sentence_lab", "section": "writing", "tab": "sentence_lab", "lesson_id": "7"},
            {"destination": "writing_sentence_lab", "lesson_id": 7},
        ),
    ]
    for raw_args, expected_clean in hint_upgrade_cases:
        raw_tc = f'<tool_call>{json.dumps({"name": "open_page", "arguments": raw_args})}</tool_call>'
        calls = parse_validated_tool_calls(raw_tc, valid_tools)
        assert len(calls) == 1, f"Expected hint upgrade/strip for {raw_args}"
        assert json.loads(calls[0]["function"]["arguments"]) == expected_clean


def test_incident_20261125_oversize_echo_prompt_is_fitted_never_refused(monkeypatch, coach_client: TestClient):
    """The production Echo prompt + tools + history exceeded the old 4,096-token window and llama.cpp raised
    `ValueError: Requested tokens (4540) exceed context window of 4096` mid-stream on EVERY turn. The service must
    fit the request instead: drop the oldest history, keep system + latest user turn + current tool round, shrink
    the completion budget, and only refuse (503, never 400) when no answer room remains."""

    class CountingLlama:
        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            return [0] * max(1, len(text_bytes) // 4)  # deterministic 4 bytes/token

    svc = EchoLocalLlmService()
    svc._llm = CountingLlama()
    svc._n_ctx = 2048
    big_system = "Static Echo policy. " * 300 + "\n\n--- DYNAMIC TURN CONTEXT ---\nChannel: VOICE"  # ~1,500 tokens
    history: List[Dict[str, Any]] = []
    for i in range(10):
        history.append({"role": "user", "content": f"old question {i} " + "x" * 400})
        history.append({"role": "assistant", "content": f"old answer {i} " + "y" * 400})
    messages = [{"role": "system", "content": big_system}] + history + [
        {"role": "user", "content": "LATEST: open the speaking module please"}
    ]
    prompt, _, _, _, max_tokens = svc._build_fitted_prompt({"tools": None}, messages, 360)
    assert "LATEST: open the speaking module please" in prompt
    assert "Static Echo policy." in prompt and "Channel: VOICE" in prompt
    assert "old question 0 " not in prompt  # oldest history went first
    assert svc._count_prompt_tokens(prompt) + max_tokens <= svc._n_ctx
    assert max_tokens >= echo_local_llm.MIN_COMPLETION_TOKENS

    # A tool round in progress (assistant tool_calls + tool result after the latest user turn) is never dropped.
    tool_round = messages + [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "open_page", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "{\"opened\":true}"},
    ]
    prompt2, _, _, _, _ = svc._build_fitted_prompt({"tools": None}, tool_round, 180)
    assert "<tool_response>" in prompt2 and "open_page" in prompt2

    # Irreducible overflow -> LocalLlmContextOverflow -> HTTP 503 (a capacity problem, never a 400 "bad request").
    svc._n_ctx = 2048
    huge = [{"role": "system", "content": "z " * 9000}, {"role": "user", "content": "hi"}]
    with pytest.raises(echo_local_llm.LocalLlmContextOverflow):
        svc._build_fitted_prompt({}, huge, 180)
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))
    resp = coach_client.post("/api/v1/coach/chat/completions", json={"messages": huge, "stream": True, "max_tokens": 180})
    assert resp.status_code == 503


def test_phase2_kv_history_invariance_atomic_eviction_salvage_grace_and_warmup(
    monkeypatch, coach_client: TestClient
):
    from app.services.echo_realtime_voice import canonicalize_domain_terms

    tools = _sample_echo_tools()

    # 1. Multi-turn `[PROFESSOR + tools + ALL prior history]` KV invariance across EN<->VI & page switches,
    #    plus `VOICE_TURN_ANCHOR` injection and Round 0 -> Round 1 prefix identity!
    static_prof = "You are Echo, the intelligent AI companion."
    turn1_msgs = [
        {
            "role": "system",
            "content": f"{static_prof}\n\n--- DYNAMIC TURN CONTEXT ---\nChannel: VOICE\nPreferred explanation language for this turn: English\nPage: /reading",
        },
        {"role": "user", "content": "What is the difference between make and do?"},
    ]
    turn2_msgs = [
        {
            "role": "system",
            "content": f"{static_prof}\n\n--- DYNAMIC TURN CONTEXT ---\nChannel: VOICE\nPreferred explanation language for this turn: Vietnamese\nPage: /speaking",
        },
        {"role": "user", "content": "What is the difference between make and do?"},
        {"role": "assistant", "content": "Use make for creating things and do for tasks or actions."},
        {"role": "user", "content": "Từ resilient nghĩa là gì?"},
    ]
    p_t1, _, _, _ = build_chatml_prompt(turn1_msgs, tools=tools, tool_choice="auto")
    p_t2, _, _, _ = build_chatml_prompt(turn2_msgs, tools=tools, tool_choice="auto")
    assert echo_local_llm.VOICE_TURN_ANCHOR in p_t1
    assert echo_local_llm.VOICE_TURN_ANCHOR in p_t2

    expected_cached_prefix_in_t2 = (
        p_t1.split("\n<|im_start|>system\n--- DYNAMIC TURN CONTEXT ---", 1)[0]
        + "\n<|im_start|>user\nWhat is the difference between make and do?<|im_end|>"
        + "\n<|im_start|>assistant\nUse make for creating things and do for tasks or actions.<|im_end|>"
    )
    assert p_t2.startswith(expected_cached_prefix_in_t2)

    # Round 0 -> Round 1 within Turn 2 keeps `[system + history + dynamic_tail + VOICE_TURN_ANCHOR + final_user]` 100% identical!
    turn2_round1_msgs = turn2_msgs + [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "c0", "type": "function", "function": {"name": "get_speaking_profile", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": "c0", "content": '{"overall":78}'},
    ]
    p_t2_r1, _, _, _ = build_chatml_prompt(turn2_round1_msgs, tools=tools, tool_choice="auto")
    r0_prefix_before_asst = p_t2[: -len("\n<|im_start|>assistant\n")]
    assert p_t2_r1.startswith(r0_prefix_before_asst)

    # 2. Zero orphaned `<tool_response>` & atomic `>= 2` turn-unit eviction + `ROUND0_TOOL_HEADROOM_TOKENS`
    orphan_msgs = [
        {"role": "system", "content": static_prof},
        {"role": "tool", "tool_call_id": "stale_0", "content": '{"stale":true}'},
        {"role": "assistant", "content": "Orphan leading assistant"},
        {"role": "user", "content": "Hello Echo"},
        {"role": "tool", "tool_call_id": "no_asst_tc", "content": '{"orphan_mid":true}'},
    ]
    p_clean, _, _, _ = build_chatml_prompt(orphan_msgs, tools=None)
    assert "<tool_response>" not in p_clean
    assert "Orphan leading assistant" not in p_clean
    assert "Hello Echo" in p_clean

    class CountingRealLlama:
        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            return [1] * max(1, len(text_bytes) // 4)

    svc = EchoLocalLlmService()
    svc._llm = CountingRealLlama()
    svc._n_ctx = 8192
    # Construct 4 prior atomic units (unit 0 includes a tool round!) that leave < 900 + 260 headroom on Round 0
    unit0 = [
        {"role": "user", "content": "u0 " + "a" * 2400},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "t0", "type": "function", "function": {"name": "open_page", "arguments": '{"destination":"reading"}'}}],
        },
        {"role": "tool", "tool_call_id": "t0", "content": '{"opened":true}' + "b" * 2400},
        {"role": "assistant", "content": "a0 " + "c" * 2000},
    ]
    unit1 = [
        {"role": "user", "content": "u1 " + "d" * 2000},
        {"role": "assistant", "content": "a1 " + "e" * 2000},
    ]
    unit2 = [
        {"role": "user", "content": "u2 " + "f" * 1600},
        {"role": "assistant", "content": "a2 " + "g" * 1600},
    ]
    unit3 = [
        {"role": "user", "content": "u3 " + "h" * 1600},
        {"role": "assistant", "content": "a3 " + "i" * 1600},
    ]
    sys_big = {"role": "system", "content": "Policy " * 1600 + "\n\n--- DYNAMIC TURN CONTEXT ---\nChannel: VOICE"}
    r0_msgs = [sys_big] + unit0 + unit1 + unit2 + unit3 + [{"role": "user", "content": "latest question"}]
    fitted_p, tok_list, tok_cnt, valid_map, _, _, _ = svc._build_fitted_prompt_with_tokens(
        {"tools": tools, "tool_choice": "auto"}, r0_msgs, 260
    )
    assert tok_list is not None and len(tok_list) == tok_cnt
    # Units 0 AND 1 dropped atomically together (>= 2 units at once, zero stranded `a0` or `t0`!)
    assert "u0 " not in fitted_p and "a0 " not in fitted_p and '"opened":true' not in fitted_p
    assert "u1 " not in fitted_p and "a1 " not in fitted_p
    assert "u2 " in fitted_p and "u3 " in fitted_p

    # Pre-503 oversize tool/dynamic compaction rescues extreme active turn without history!
    svc._n_ctx = 4096
    extreme_turn = [
        {"role": "system", "content": "Core.\n\n--- DYNAMIC TURN CONTEXT ---\n" + ("context " * 950)},
        {"role": "user", "content": "Summarize all 4 tool outputs"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": f"c{k}", "type": "function", "function": {"name": "search_lessons", "arguments": '{"query":"x"}'}}
                for k in range(4)
            ],
        },
        *[
            {"role": "tool", "tool_call_id": f"c{k}", "content": '{"items":"' + ("x" * 4200) + '"}'}
            for k in range(4)
        ],
    ]
    rescued_p, _, _ = svc._build_fitted_prompt({"tools": None}, extreme_turn, 180)[:3]
    assert "Summarize all 4 tool outputs" in rescued_p

    # 3. Array-aware truncated `<tool_call>` salvage (`prepare_flashcards_batch` cut off mid-2nd-card!)
    truncated_batch = (
        '<tool_call>{"name":"prepare_flashcards_batch","arguments":{"deck_name":"IELTS Core",'
        '"cards":[{"term":"resilient","meaning_vi":"kiên cường","pos":"adjective"},'
        '{"term":"ephem'
    )
    salvaged = parse_validated_tool_calls(truncated_batch, valid_map, finish_reason="length")
    assert len(salvaged) == 1
    salvaged_args = json.loads(salvaged[0]["function"]["arguments"])
    assert salvaged_args == {
        "deck_name": "IELTS Core",
        "cards": [{"term": "resilient", "meaning_vi": "kiên cường", "pos": "adjective"}],
    }

    # 4. Bare `{"name": "<valid_tool>"}` interception on `tool_choice="auto"` (zero leak into `delta.content`)
    monkeypatch.setattr(EchoLocalLlmService, "get_instance", classmethod(lambda cls: svc))

    def fake_auto_bare_json(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        return (
            iter(
                [
                    ("Sure, opening speaking now. ", None),
                    ('{"na', None),
                    ('me": "open_page", "arguments": {"destination": "speaking"}}', "stop"),
                ]
            ),
            {"prompt_tokens": 110, "completion_tokens": 18},
        )

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_auto_bare_json)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": "Open speaking module"}],
            "tools": tools,
            "tool_choice": "auto",
        },
    ) as r_bare:
        assert r_bare.status_code == 200
        raw_sse_lines = [ln for ln in r_bare.iter_lines() if ln]
        # Verify immediate `: ping` flush precedes data frames
        assert raw_sse_lines[0] == ": ping"
        bare_frames = [json.loads(ln[6:]) for ln in raw_sse_lines if ln.startswith("data: ") and ln != "data: [DONE]"]

    bare_content = "".join(f["choices"][0]["delta"].get("content", "") for f in bare_frames)
    assert bare_content.strip() == "Sure, opening speaking now."
    assert "open_page" not in bare_content and "{" not in bare_content
    bare_tcs = [f["choices"][0]["delta"]["tool_calls"] for f in bare_frames if "tool_calls" in f["choices"][0]["delta"]]
    assert len(bare_tcs) == 1 and bare_tcs[0][0]["function"]["name"] == "open_page"

    # 5. 28-token streaming sentence-boundary grace runway stops cleanly at `.` instead of cutting mid-sentence!
    svc._n_ctx = 16384

    def fake_grace_runway(prompt, max_tokens, temperature, top_p, cancel_event=None, *, grace_tokens=0, **kwargs):
        assert max_tokens == 4
        assert grace_tokens == 28
        pieces = [
            ("Use ", None),
            ("do ", None),
            ("for ", None),
            ("daily ", None),      # token 4 == soft `max_tokens` (mid-sentence!)
            ("tasks", None),       # grace token 1
            (".", None),           # grace token 2 -> clean sentence boundary!
            (" Extra rambling sentence that must not stream.", "stop"),
        ]
        usage = {"prompt_tokens": 80, "completion_tokens": 0}

        def _it():
            for txt, fin in pieces:
                usage["completion_tokens"] += 1
                yield txt, fin

        return _it(), usage

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_grace_runway)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "max_tokens": 4,
            "messages": [{"role": "user", "content": "Explain do briefly"}],
        },
    ) as r_grace:
        grace_frames = [json.loads(ln[6:]) for ln in r_grace.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"]

    grace_text = "".join(f["choices"][0]["delta"].get("content", "") for f in grace_frames)
    assert grace_text == "Use do for daily tasks."
    assert "Extra rambling" not in grace_text

    # 6. `X-EC-Warmup: 1` preempts startup 4-token dummy warmup (`is_dummy=True`) when `_prefix_warmed` is False,
    #    verifies EXACT `_input_ids[:len(sys_tokens)] == sys_tokens` prefix match (`P0-2` — NEVER skips on mere `n_tokens > 64`
    #    from a different prompt!), and fast-skips once the exact `[PROFESSOR + tools]` prefix is warm!
    import threading

    svc._prefix_warmed = False
    dummy_ev = threading.Event()
    svc.register_warmup_cancel(dummy_ev, is_dummy=True)
    svc._infer_lock.acquire()
    try:
        # Only startup dummy warmup holds `_infer_lock` -> preempts `dummy_ev` and returns False!
        assert svc.is_busy_or_prefix_warm({"messages": [{"role": "user", "content": "Hi"}]}) is False
        assert dummy_ev.is_set() is True
        svc.clear_warmup_cancel(dummy_ev)
        # Real learner turn holds `_infer_lock` (`_active_warmup_cancel` is None) -> returns True!
        assert svc.is_busy_or_prefix_warm({"messages": [{"role": "user", "content": "Hi"}]}) is True
    finally:
        svc._infer_lock.release()
        svc.clear_warmup_cancel(dummy_ev)

    class FakeKvLlama:
        def __init__(self) -> None:
            self.input_ids: List[int] = [999] * 5000  # > 64 tokens, but from a DIFFERENT synthetic prompt!
            self.n_tokens: int = 5000

        @property
        def _input_ids(self) -> List[int]:
            return self.input_ids[: self.n_tokens]

        def tokenize(self, text_bytes: bytes, add_bos: bool = False, special: bool = True) -> List[int]:
            # Deterministic content-sensitive token IDs so distinct prompts yield distinct token prefixes
            return [b + 10 for b in text_bytes[:512]]

    kv_llama = FakeKvLlama()
    svc._llm = kv_llama
    svc._prefix_warmed = True  # Even with `_prefix_warmed=True` & `n_tokens=5000`, mismatched `_input_ids` MUST NOT skip!

    real_warmup_payload = {
        "stream": False,
        "max_tokens": 1,
        "messages": [
            {"role": "system", "content": "Real EchoPolicy.PROFESSOR static core."},
            {"role": "user", "content": "ping"},
        ],
        "tools": tools,
    }
    assert svc.is_busy_or_prefix_warm(real_warmup_payload) is False

    warmup_runs: List[int] = []

    def fake_real_warmup_iter(prompt, max_tokens, temperature, top_p, cancel_event=None, *, prompt_tokens=None, **kwargs):
        warmup_runs.append(1)
        if prompt_tokens:
            kv_llama.input_ids = list(prompt_tokens) + [42]
            kv_llama.n_tokens = len(kv_llama.input_ids)
        return iter([("ready", "stop")]), {"prompt_tokens": len(prompt_tokens or []), "completion_tokens": 1}

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_real_warmup_iter)
    r_warm_cold_mismatch = coach_client.post(
        "/api/v1/coach/chat/completions",
        headers={"X-EC-Warmup": "1"},
        json=real_warmup_payload,
    )
    assert r_warm_cold_mismatch.status_code == 200
    assert len(warmup_runs) == 1  # Executed real prefix prefill!

    # Second `X-EC-Warmup: 1` with the SAME `[PROFESSOR + tools]` prefix now matches `_input_ids` -> instant skip!
    assert svc.is_busy_or_prefix_warm(real_warmup_payload) is True
    r_warm_matched = coach_client.post(
        "/api/v1/coach/chat/completions",
        headers={"X-EC-Warmup": "1"},
        json=real_warmup_payload,
    )
    assert r_warm_matched.status_code == 200
    assert len(warmup_runs) == 1  # Not called again!
    svc.warmup()  # Boot dummy warmup also skips without clobbering `n_tokens=512+`!
    assert len(warmup_runs) == 1

    # 8. Phase 2D (`P1-5` & Dynamic JSON Minification):
    #    - `VOICE_TURN_ANCHOR_TOOLS` vs `VOICE_TURN_ANCHOR_SYNTHESIS`
    #    - Lossless JSON minification inside `--- DYNAMIC TURN CONTEXT ---`
    #    - Voice conciseness early stop at `>= 2` complete sentences & `>= 65` visible tokens
    pretty_learner = json.dumps(
        {
            "verifiedProficiency": {"overall": {"currentCefr": "B1", "confidence": "VERIFIED"}},
            "rolling7Days": {"speakingSessions": 4, "focus": ["/θ/", "/ɹ/"]},
        },
        indent=2,
        ensure_ascii=False,
    )
    pretty_page = json.dumps(
        {
            "route": "/reading",
            "available": True,
            "clientVisibleExcerpt": 'He said {quietly} "Stay [resilient]!" during practice.',
        },
        indent=2,
        ensure_ascii=False,
    )
    voice_sys = (
        "Static PROFESSOR.\n\n--- DYNAMIC TURN CONTEXT ---\n"
        "Channel: VOICE\n"
        f"Untrusted learner profile (evidence-labelled JSON): {pretty_learner}\n"
        f"Untrusted current page (JSON, quoted data only): {pretty_page}"
    )
    p_voice_auto, _, _, _ = build_chatml_prompt(
        [{"role": "system", "content": voice_sys}, {"role": "user", "content": "Check my speaking profile."}],
        tools=tools,
        tool_choice="auto",
    )
    p_voice_none, _, _, _ = build_chatml_prompt(
        [{"role": "system", "content": voice_sys}, {"role": "user", "content": "Check my speaking profile."}],
        tools=tools,
        tool_choice="none",
    )
    assert echo_local_llm.VOICE_TURN_ANCHOR_TOOLS in p_voice_auto
    assert "NEVER say 'I will check' without emitting <tool_call>" in p_voice_auto
    assert echo_local_llm.VOICE_TURN_ANCHOR_SYNTHESIS in p_voice_none
    # Pretty-printed indentation stripped while nested quotes/braces inside string values stay 100% lossless!
    assert '\n  "verifiedProficiency"' not in p_voice_auto
    assert '{"verifiedProficiency":{"overall":{"currentCefr":"B1","confidence":"VERIFIED"}}' in p_voice_auto
    assert 'He said {quietly} \\"Stay [resilient]!\\" during practice.' in p_voice_auto

    def fake_long_voice_reply(prompt, max_tokens, temperature, top_p, cancel_event=None, **kwargs):
        # 35 words in sentence 1 + 35 words in sentence 2 (> 65 visible tokens total), followed by sentence 3
        s1_tokens = ["Word "] * 34 + ["one. "]
        s2_tokens = ["Word "] * 34 + ["two."]
        s3_tokens = [" Extra", " third", " sentence", " that", " should", " stop", " early."]
        all_toks = s1_tokens + s2_tokens + s3_tokens
        usage = {"prompt_tokens": 120, "completion_tokens": 0}

        def _gen_voice():
            for idx_t, tok in enumerate(all_toks):
                usage["completion_tokens"] += 1
                yield tok, ("stop" if idx_t == len(all_toks) - 1 else None)

        return _gen_voice(), usage

    monkeypatch.setattr(svc, "_raw_token_iterator", fake_long_voice_reply)
    with coach_client.stream(
        "POST",
        "/api/v1/coach/chat/completions",
        json={
            "stream": True,
            "max_tokens": 260,
            "messages": [
                {"role": "system", "content": "Static.\n\n--- DYNAMIC TURN CONTEXT ---\nChannel: VOICE"},
                {"role": "user", "content": "Explain make and do"},
            ],
        },
    ) as r_vstop:
        vstop_frames = [
            json.loads(ln[6:]) for ln in r_vstop.iter_lines() if ln.startswith("data: ") and ln != "data: [DONE]"
        ]
    vstop_txt = "".join(f["choices"][0]["delta"].get("content", "") for f in vstop_frames)
    assert vstop_txt.endswith("two.")
    assert "Extra third sentence" not in vstop_txt

    # 7. ASR Layer-7 `"High/Hay Echo"` -> `"Hi Echo"` canonicalization
    assert canonicalize_domain_terms("High echo, what is the difference between make and do?") == (
        "Hi echo, what is the difference between make and do?"
    )
    assert canonicalize_domain_terms("Hay Echo, open speaking") == "Hi Echo, open speaking"
