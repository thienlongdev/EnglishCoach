# Architecture Decision Records (ADRs)

This document records the high-impact architectural decisions governing the **English Coach** platform, the trade-offs evaluated, and the operational invariants enforced in code and CI.

---

## ADR-001: Feature-Sliced Layered Monolith with Intentional Domain Exceptions

- **Status:** Accepted & Enforced
- **Context:** English Coach spans `42` backend domain packages (from authentication and SePay billing to IELTS/TOEIC CBT exams, spaced-repetition flashcards, Echo JARVIS voice orchestration, and interactive 3D worlds) deployed inside a tight `832 MiB` JVM container on a single production VPS connected over WAN to Azure PostgreSQL 17. Splitting into network-separated microservices would introduce distributed-transaction failure modes, serialization latency, and container memory overhead exceeding the VPS envelope. Conversely, an unstructured monolith risks circular package dependencies and controller-to-repository leakage.
- **Decision:**
  1. Standardize the backend on a **Feature-Sliced Layered Monolith** (`com.englishcoach.<domain>.{controller,dto,service,repository,entity}`).
  2. Permit documented, intentional internal architectures where domain complexity justifies them:
     - `com.englishcoach.garden`: Clean / DDD slice (`api -> application -> domain -> infra`) with pure deterministic simulation (`EconomySimulator`) and batched JDBC (`GardenJdbc`).
     - `com.englishcoach.exams`: Spring JDBC repositories and lease-based asynchronous worker (`ExamJobWorker`) isolated in PostgreSQL schema `exams`.
     - `com.englishcoach.ai`: Multimodal agentic router (`EchoRouter`, `EchoToolRegistry`, `CaMeLPolicyEngine`, `EchoVoiceWebSocketHandler`).
  3. Enforce acyclic cross-module boundaries (`common.event`, `common.contract`, leaf `PremiumEntitlementCache`) and controller-to-repository isolation via [`ArchitectureLayeringGuardTest`](../../backend/src/test/java/com/englishcoach/architecture/ArchitectureLayeringGuardTest.java).
- **Consequences:**
  - Single deployable JAR (`english-coach-backend:prod`) with atomic local database transactions and zero inter-service RPC overhead between learning modules.
  - Automated JUnit 5 guardrails prevent layering regressions without adding runtime frameworks or heavyweight build dependencies.

---

## ADR-002: Hybrid Multi-Tier AI Execution & Zero-VRAM CPU Failover

- **Status:** Accepted & Deployed
- **Context:** Real-time Echo JARVIS voice tutoring relies on cloud LLMs (OpenRouter) for primary reasoning, while the private RTX 5070 (`12,227 MiB` VRAM) GPU host concurrently runs Listening `faster-whisper-large-v3` + WhisperX alignment, isolated Echo `faster-whisper-large-v3-turbo` (`int8_float16`), `Kokoro-82M` EN TTS, EasyOCR, and the sibling `docker-mdd-service-1` pronunciation container. Two production risks emerged: (1) upstream CDN/relay `HTTP 400` incidents on cloud LLM providers can interrupt live voice sessions, and (2) loading a local LLM or Vietnamese TTS onto CUDA VRAM risks GPU OOM crashes under concurrent pronunciation/listening traffic. Additionally, all runtime speech and local LLM components must remain commercially clean (zero in-process GPLv3+ `espeak-ng` / `phonemizer`).
- **Decision:**
  1. Implement a **3-tier resilient LLM routing chain** in [`OpenRouterChatServiceImpl`](../../backend/src/main/java/com/englishcoach/ai/service/OpenRouterChatServiceImpl.java):
     - **Tier 1:** OpenRouter cloud (`openai/gpt-6-luna` / `openai/gpt-6.1-terra`, `reasoning: none`, latency-sorted) protected by a 1-hop circuit breaker (`180 s` base exponential backoff).
     - **Tier 2:** Optional OpenAI-compatible secondary cloud provider (`echo.secondary-provider.*`).
     - **Tier 3:** In-container commercial-clean CPU local LLM (`echo-local-llm-v3` in [`echo_local_llm.py`](../../ai-service/app/services/echo_local_llm.py)) running `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (`Apache-2.0`) via `llama-cpp-python==0.3.38` (`MIT`) with `n_gpu_layers=0` (`0 MiB` VRAM), `n_ctx=12288` native `FP16` KV cache (`flash_attn=False`), immutable `[PROFESSOR + 23 tools + history]` prefix reuse, and full native `<tool_call>` parity across all `23` `EchoTool`s.
  2. Run bilingual `jarvis-tts-v2` with **`Kokoro-82M` v1.0** (`Apache-2.0`, CUDA, via `kokoro.model.KModel` + pure-Python `KokoroOovFallback`) for English and **`VieNeu-TTS-v3-Turbo`** (`Apache-2.0`, CPU ONNX INT8, `0 MiB` VRAM) + `MOSS-Audio-Tokenizer-Nano-ONNX` + `sea-g2p` for Vietnamese and EN-VI code-switching, completely removing `espeakng-loader` and `phonemizer-fork`.
- **Consequences:**
  - Live voice sessions survive external OpenRouter relay outages with full 23-tool agentic capability and sub-second warm local TTFT.
  - RTX 5070 VRAM stays bounded under simultaneous Listening, Speaking MDD V2.2, Echo ASR, and Kokoro TTS load with zero GPLv3+ speech runtime exposure.

---

## ADR-003: Selective OSIV Exclusion & Concurrency Bulkheads Over Shared HikariCP Pool

- **Status:** Accepted & Enforced
- **Context:** Production Spring Boot connects to Azure Database for PostgreSQL 17 over WAN (~`90 ms` RTT) using the `V94` least-privilege `english_coach_app` role (`CONNECTION LIMIT 32` inside a `50`-connection server budget). With Spring Boot's default `open-in-view=true` (`DELAYED_ACQUISITION_AND_HOLD`), any HTTP request that reads an entity before waiting `5–60 s` for an LLM or GPU worker holds a HikariCP connection idle for the entire remote wait, causing rapid pool exhaustion under concurrent AI load.
- **Decision:**
  1. Size the shared HikariCP pool to `maximum-pool-size=24` (`minimum-idle=10`, `connection-timeout=10000 ms`) and cap Tomcat worker threads at `128`.
  2. Disable Spring Boot's default OSIV (`spring.jpa.open-in-view=false`) and register [`OpenEntityManagerInViewConfig`](../../backend/src/main/java/com/englishcoach/common/config/OpenEntityManagerInViewConfig.java), which excludes **`27` AI and media-upload request paths** so each short database read/write acquires and returns its pooled connection immediately.
  3. Enforce explicit semaphore bulkheads in front of high-latency or burst-prone subsystems:
     - [`AiRequestBulkhead`](../../backend/src/main/java/com/englishcoach/premium/interceptor/AiRequestBulkhead.java): `24` permits (`2,000 ms` wait -> `503 AI_BUSY`).
     - [`GardenContext`](../../backend/src/main/java/com/englishcoach/garden/application/GardenContext.java): `14` permits (`15,000 ms` wait -> `503 GARDEN_BUSY`).
     - [`EchoLifeBulkhead`](../../backend/src/main/java/com/englishcoach/echolife/EchoLifeBulkhead.java): `10` permits (`2,500 ms` wait -> `503 ECHO_LIFE_BUSY`).
- **Consequences:**
  - Core authentication, exam taking, reading, and payment endpoints retain guaranteed database connection capacity even when AI providers stall or 3D world saves burst.
  - Developers adding new AI-bound endpoints must ensure zero lazy JPA traversal outside `@Transactional` and register the path in `OpenEntityManagerInViewConfig.CONNECTION_FREE_PATHS`.

---

## ADR-004: Zero-WASM Main-Page CSP with Per-Request Nonces and Isolated Worker Origins

- **Status:** Accepted & Enforced
- **Context:** The platform operates high-trust authenticated sessions, admin WebAuthn controls, and payment flows alongside browser-heavy capabilities: real-time Echo voice DSP (acoustic echo cancellation, VAD, wake-word detection), 3D rigid-body physics (`Rapier3D 0.12.0`), and offline EN-VI subtitle translation (`opus-mt-en-vi` ONNX Runtime Web). Allowing `'unsafe-eval'` or `'wasm-unsafe-eval'` on main HTML documents weakens XSS defense-in-depth across every application route.
- **Decision:**
  1. Enforce a **dual-layer Content Security Policy**: [`deploy/nginx/default.conf`](../../deploy/nginx/default.conf) enforces strict origin allowlists without `'wasm-unsafe-eval'` or `'unsafe-eval'`, while [`frontend/src/proxy.ts`](../../frontend/src/proxy.ts) attaches a cryptographic per-request script nonce with `'strict-dynamic'`.
  2. Implement Echo JARVIS audio DSP (`echo-mic-worklet.js` + `echo-voice-dsp.worker.js`) in **pure JavaScript (Zero-WASM)** — including 8-partition PBFDAF AEC, Silero VAD v5, and INT8 OpenWakeWord — and ship all 3D GLB assets without Draco/KTX2 WebAssembly decoders.
  3. Confine the only two legitimate WebAssembly workloads to dedicated, SHA-256-verified worker script prefixes served with `add_header_inherit off` and narrow CSP headers (`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'`):
     - `/vendor/study-physics/` (`connect-src 'none'`, compiles pinned Rapier3D `0.12.0` WASM module).
     - `/vendor/listening-translator/` (`connect-src 'self'`, runs pinned Transformers.js `3.8.1` / ONNX Runtime Web verified by `MANIFEST.sha256`).
- **Consequences:**
  - Zero `'wasm-unsafe-eval'` exposure on any HTML route, verified automatically by `npm run test:security` and live deployment canaries.
  - WebAssembly physics and offline translation remain strictly isolated from DOM execution and external network origins.

---

## ADR-005: Strict Source-Only Git Repository Policy & External Runtime Provisioning

- **Status:** Accepted & Enforced
- **Context:** Over multi-wave development, large binary datasets (`dictionary_en_vi.db`, `444 MiB` exam visuals, `6.24 GiB` user/lesson media, `13.27 GiB` authoring corpora, `4.77 GiB` pronunciation models, and multi-gigabyte HuggingFace weights), environment secrets, and ad-hoc verification outputs accumulate rapidly. Tracking runtime binaries or secrets in Git degrades clone performance, risks credential exposure, and creates third-party license ambiguity.
- **Decision:**
  1. Keep Git strictly **source-only**: application code, Flyway migrations, lockfiles, Docker/Nginx recipes, maintained test suites, provenance-verified small UI/3D assets, and documentation.
  2. Enforce a permanent automated guardrail ([`scripts/ci/repo_hygiene_check.py`](../../scripts/ci/repo_hygiene_check.py)) in both local pre-commit checks and GitHub Actions CI:
     - Root directory and file allowlists.
     - `15 MiB` maximum tracked file ceiling.
     - Denylist of model/dump/archive/key extensions (`.pt`, `.onnx`, `.gguf`, `.dump`, `.pem`, `.key`, `.zip`, etc.) and runtime data prefixes (`audit_artifacts/`, `english-coach-models/`, `backend/storage/`, `frontend/public/storage/`, `imports/`, `data/`, `content/`).
     - Automated secret-pattern scanning and relative Markdown link validation across `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `docs/`.
  3. Document every excluded external runtime binary, mount point, SHA-256 checksum, license notice, and provisioning command in [`docs/operations/external-resources.md`](../operations/external-resources.md).
- **Consequences:**
  - Clean, fast, auditable Git repository ready for enterprise handover and open engineering review.
  - New environments require following the deterministic provisioning checklist in [`docs/operations/external-resources.md`](../operations/external-resources.md) before executing full-stack runtime features.
