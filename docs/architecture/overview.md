# English Coach — System Architecture Overview

> **Scope:** Production architecture of **English Coach (Echo Ocean)** (`https://englishcoach.io.vn`), reflecting the Spring Boot 3.5 / Java 21 backend (`42` top-level domain packages), Next.js 16.4.5 / React 19 frontend, private RTX 5070 GPU inference cluster (`englishcoach-ai-whisperx` + `docker-mdd-service-1`), Azure PostgreSQL 17 (`public` + `exams`, Flyway `V1`–`V140`), and the **Echo Anywhere** Chrome Manifest V3 extension.

---

## 1. System Context

English Coach is a full-stack AI-assisted English learning platform combining structured IELTS/TOEIC CBT examination preparation, real-time bilingual voice coaching (**Echo JARVIS**), phoneme-level pronunciation diagnosis (**MDD V2.2**), SM-2 spaced-repetition flashcards, bilingual reading and dictation studios, competitive multiplayer games, and interactive WebGL2 3D environments (**Study Space** and **Speaking Arena**).

```mermaid
flowchart LR
  Learner["Learner (Web Browser / Echo Anywhere Extension)"]
  Admin["Administrator (WebAuthn / TOTP MFA)"]
  CF["Cloudflare Edge Proxy & Turnstile Bot Guard"]
  VPS["Production VPS Cluster (Nginx + Next.js 16 + Spring Boot 3.5)"]
  GPU["Private GPU Host ({GPU_PRIVATE_MESH_HOST}:8000 FastAPI + MDD :8010)"]
  PG[("Azure PostgreSQL 17 ({AZURE_POSTGRES_HOST}, public + exams, Flyway V140)")]
  OR["OpenRouter API (Tier-1 Cloud LLM: gpt-6-luna / gpt-6.1-terra)"]
  SECLLM["Optional Secondary Provider (Tier-2 OpenAI-Compatible LLM)"]
  LK["LiveKit Cloud WebRTC (Speaking Arena Spatial Audio)"]
  SEPAY["SePay VietQR Gateway (Premium Settlement Webhooks)"]
  GOOG["Google OAuth 2.0 / SMTP Mail / HIBP k-Anonymity"]
  RSS["Public News Feeds (BBC / The Guardian RSS)"]

  Learner -->|"HTTPS 443 / WSS (STOMP + Binary Voice)"| CF
  Admin -->|"HTTPS 443 + Step-Up MFA"| CF
  CF -->|"TLS Upstream"| VPS
  SEPAY -->|"POST /api/v1/payments/webhooks/sepay (HMAC-SHA256)"| CF
  Learner <-->|"WebRTC Audio Stream"| LK
  VPS -->|"Room Access Token"| LK
  VPS <-->|"JDBC TLS verify-full (HikariCP max=24)"| PG
  VPS <-->|"Private Encrypted Mesh + X-EC-Service-Key"| GPU
  VPS -->|"HTTPS SSE / JSON (180s Circuit Breaker)"| OR
  VPS -.->|"Tier-2 Failover"| SECLLM
  VPS <-->|"OAuth / Mail / Breach Check"| GOOG
  VPS -->|"Scheduled 3h RSS Ingestion"| RSS
```

**Primary configuration references:** [`docker-compose.prod.yml`](../../docker-compose.prod.yml), [`deploy/nginx/default.conf`](../../deploy/nginx/default.conf), [`deploy/ai/docker-compose.gpu.yml`](../../deploy/ai/docker-compose.gpu.yml), and [`backend/src/main/resources/application.yml`](../../backend/src/main/resources/application.yml).

---

## 2. Container & GPU/CPU Allocation Topology

Production separates stateless web serving, transactional business logic, and heavy neural inference across two host tiers connected exclusively over a private encrypted mesh network. On the RTX 5070 (`12,227 MiB` VRAM) GPU host, neural workloads are explicitly partitioned between CUDA VRAM and host CPU (`0 MiB` VRAM) so continuous speech synthesis, ASR, local LLM failover, and phoneme scoring coexist without out-of-memory contention.

```mermaid
flowchart TB
  subgraph VPS_HOST["Production Linux VPS ({VPS_HOST} — Docker Compose)"]
    NGINX["nginx (nginx:alpine, 160M RAM, 64 PIDs, read_only, ports 80/443)"]
    FE["frontend (node:24-alpine, Next.js 16.4.5, 256M RAM, 192M V8 heap, port 3000)"]
    BE["backend (Temurin 21 JRE, Spring Boot 3.5.16, 832M RAM, Xmx416m, port 8080)"]
    VOL_ST[("Volume backend_storage (/app/storage)")]
    VOL_KING[("Read-Only Host Mounts (king/packages & king/state)")]
    BK["Nightly Backup (deploy/ops/ec-backup.sh: pg_dump + AES-256-GCM)"]
  end

  subgraph GPU_HOST["Private GPU Host ({GPU_PRIVATE_MESH_HOST} — RTX 5070 12,227 MiB VRAM)"]
    AI_API["englishcoach-ai-whisperx (FastAPI :8000, X-EC-Service-Key)"]
    CUDA_POOL["CUDA VRAM Pool: faster-whisper large-v3 + WhisperX + faster-whisper-large-v3-turbo (int8_float16) + Kokoro-82M EN TTS + EasyOCR"]
    CPU_POOL["CPU 0-MiB-VRAM Pool: Qwen3-4B-Instruct GGUF (12,288 FP16 KV) + VieNeu-TTS-v3-Turbo ONNX INT8 VI + Smart Turn v3.2"]
    MDD["docker-mdd-service-1 (Internal :8010: CROTTC-IF + MDD-LLM-Llama3.2-1B)"]
    HF_CACHE[("HuggingFace Cache + :ro audit_artifacts & acceptance pack")]
  end

  NGINX -->|"SSR / Static Chunks / BFF /api/auth/* / /storage/exams"| FE
  NGINX -->|"REST /api/v1/* + Unbuffered SSE + WSS /ws-card-blast*"| BE
  FE -->|"Signed Internal Calls (InternalServiceAuthFilter)"| BE
  BE <--> VOL_ST
  BE --- VOL_KING
  VOL_ST -.-> BK
  BE <-->|"HTTP Keep-Alive over Private Mesh (:8000)"| AI_API
  AI_API --> CUDA_POOL
  AI_API --> CPU_POOL
  AI_API -->|"Internal docker_default HTTP (:8010)"| MDD
  HF_CACHE --- AI_API
```

### Key Resource Isolation Controls

- **Backend cgroup discipline (`832M`):** Runs with `-Xms192m -Xmx416m -XX:NewRatio=3 -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:ReservedCodeCacheSize=96m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=64m -Xss512k`, `MALLOC_ARENA_MAX=2`, Tomcat `max-threads=128`, and a zero-Python Bash `/dev/tcp` healthcheck.
- **Frontend secret minimization (`256M`):** Does not mount `.env.production`. Receives only `NEXTAUTH_*`, Google OAuth client credentials, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, and `APP_SECURITY_INTERNAL_SERVICE_KEY`; never receives database, JWT signing, payment, mail, MFA encryption, or LLM API secrets.
- **Zero-VRAM CPU coexistence:** `echo_local_llm.py` (`echo-local-llm-v3`) pins `n_gpu_layers=0`, `n_ctx=12288`, native `FP16` KV cache (`flash_attn=False`), `n_batch=512`, `threads=12/16`, while `VieNeu-TTS-v3-Turbo` runs on CPU ONNX INT8, preserving full CUDA VRAM headroom for WhisperX, `faster-whisper-large-v3-turbo`, `Kokoro-82M`, and `docker-mdd-service-1`.

---

## 3. Frontend Architecture: Next.js 16, Single-Context WebGL2 & Isolated Workers

The frontend combines server-rendered App Router pages, a security-hardened Backend-for-Frontend (BFF) layer, a single-renderer 3D companion entity, two full-screen 3D learning worlds, and three off-main-thread Web Workers governed by strict Content Security Policy boundaries.

```mermaid
flowchart TB
  REQ["Browser HTTPS Request"] --> PROXY["frontend/src/proxy.ts (Per-Request CSP Nonce, Zero wasm-unsafe-eval on HTML)"]

  subgraph SHELLS["Next.js 16.4.5 App Router Shells & BFF Routes"]
    WS_TABS["(workspace)/layout.tsx -> WorkspaceTabs.tsx (Instant Client Tab Switching)"]
    S_STUDY["/study-space (3D Study Space / Echo Life World)"]
    S_ARENA["/speaking/arena (3D Echo Archipelago + LiveKit Spatial Voice)"]
    S_EXAM["/exams/* (IELTS & TOEIC CBT Runner + Echo Sentinel Lockdown)"]
    BFF["BFF Route Handlers (/api/auth/*, /api/translate, /api/tts, /api/dictionary, /api/csp-report)"]
  end

  subgraph GPU_MGR["WebGL2 Context Governance & 3D Engines"]
    ENTITY["EchoLivingEntity.tsx (Single WebGLRenderer, 6 ESSL 3.00 Shaders, raf=0 when dormant)"]
    LIFE_3D["study-space/world/engine.ts (Three.js + CSM + Householder Mirror + N8AO/AgX + Zone Streaming)"]
    ARENA_3D["Speaking Arena Archipelago Engine (Procedural Ocean, Vegetation, Boids, LiveKit)"]
    ODYSSEY["Echo Odyssey & Neural Cosmos (React Three Fiber)"]
  end

  subgraph WORKERS["Isolated Off-Main-Thread Workers & Audio Arbiter"]
    W_DSP["echo-mic-worklet.js + echo-voice-dsp.worker.js (Zero-WASM JS: PBFDAF AEC + Silero VAD v5 + INT8 WakeWord)"]
    W_PHY["/vendor/study-physics/ Worker (Narrow CSP: wasm-unsafe-eval, Rapier3D 0.12.0 SHA-256 Verified)"]
    W_TR["/vendor/listening-translator/ Worker (Narrow CSP: wasm-unsafe-eval, ONNX opus-mt-en-vi)"]
    ARB["audioSessionArbiter.ts (4-Tier Mic Priority: Sentinel > Module Mic > Conversation > Hands-Free)"]
  end

  PROXY --> SHELLS
  WS_TABS --> ENTITY
  S_STUDY --> LIFE_3D
  S_ARENA --> ARENA_3D
  LIFE_3D <--> W_PHY
  WS_TABS -.-> W_TR
  ARB --> W_DSP
  S_STUDY -.->|"Temporarily yields WebGL context"| ENTITY
  S_ARENA -.->|"Unmounts companion widget to avoid GPU/Mic contention"| ENTITY
  ODYSSEY -.->|"Yields WebGL context during 3D planet view"| ENTITY
```

**Verified source entrypoints:**
- Per-request CSP nonce middleware: [`frontend/src/proxy.ts`](../../frontend/src/proxy.ts)
- Companion 3D entity: [`frontend/src/components/features/coach/entity/EchoLivingEntity.tsx`](../../frontend/src/components/features/coach/entity/EchoLivingEntity.tsx)
- Study Space 3D engine: [`frontend/src/components/study-space/world/engine.ts`](../../frontend/src/components/study-space/world/engine.ts)
- Zero-WASM Voice DSP worker & AudioWorklet: [`frontend/public/echo-jarvis/echo-voice-dsp.worker.js`](../../frontend/public/echo-jarvis/echo-voice-dsp.worker.js), [`frontend/public/echo-mic-worklet.js`](../../frontend/public/echo-mic-worklet.js)
- Audio session priority arbiter: [`frontend/src/lib/echo-jarvis/audio/audioSessionArbiter.ts`](../../frontend/src/lib/echo-jarvis/audio/audioSessionArbiter.ts)

---

## 4. Echo JARVIS 3-Plane Voice & 3-Tier LLM Failover Flow

Echo JARVIS divides voice interaction into three deterministic/agentic execution planes — local DSP (`Plane 0`), deterministic zero-LLM navigation/control (`Plane A`), and grounded tool-augmented LLM reasoning (`Plane B`) — backed by a 3-tier resilient LLM failover chain so transient external relay errors never break live voice sessions.

```mermaid
sequenceDiagram
  actor U as Learner
  participant P0 as Plane 0 Browser DSP (echo-mic-worklet + echo-voice-dsp.worker)
  participant WS as EchoVoiceWebSocketHandler (/ws-card-blast/echo-voice)
  participant ASR as GPU FastAPI ASR (faster-whisper-large-v3-turbo + Smart Turn v3.2)
  participant PA as Plane A Fast-Path (EchoVoiceFastPathMatcher / EchoSpeechActAnalyzer)
  participant PB as Plane B Agent (OpenRouterChatServiceImpl + 23 EchoTools + CaMeL)
  participant L1 as Tier 1: OpenRouter Cloud (Circuit Breaker 180s..1800s)
  participant L2 as Tier 2: Optional Secondary LLM
  participant L3 as Tier 3: CPU Qwen3-4B-Instruct (12,288 FP16 KV)
  participant TTS as SpeakingTtsService & jarvis-tts-v2 (Kokoro EN + VieNeu VI)

  U->>P0: Speaks command or question (48kHz -> 16kHz, 8-partition PBFDAF AEC, Silero VAD v5)
  P0->>WS: Binary frame 0x01 (PCM16LE uplink) + debounced input.commit
  WS->>ASR: POST /api/v1/coach/transcribe (7-layer anti-hallucination shield) & /turn-check
  ASR-->>WS: Clean EN/VI transcript + end-of-turn signal
  WS->>PA: Evaluate speech act & 207-case parity intent rules (0 LLM quota)
  alt Plane A deterministic match (direct navigation / workspace control)
    PA-->>WS: Grounded EchoAction (NAVIGATE / workspace control)
    WS->>TTS: Synthesize concise confirmation
    TTS-->>WS: 24kHz PCM16LE audio frames (0x02 downlink)
    WS-->>P0: Execute verified UI action + play audio
  else Plane B conversational / diagnostic / multi-intent turn
    WS->>PB: Parallel EchoLearnerBrain warm + Round-0 grounded EchoTool execution (CaMeL verified)
    PB->>L1: Stream SSE completion (reasoning=none, latency sort)
    alt Tier 1 healthy
      L1-->>PB: Token stream / tool_calls
    else Tier 1 relay HTTP 400 / timeout (1-hop circuit trip)
      PB-.->L2: Try Tier 2 secondary provider (if configured)
      PB->>L3: Failover POST /api/v1/coach/chat/completions (Qwen3-4B CPU, native Qwen3 tool calling)
      L3-->>PB: Streamed commercial-clean tokens / tool_calls
    end
    PB->>TTS: Stream sentence clauses (Clause-0 18-32 chars) to POST /api/v1/tts/stream
    TTS-->>WS: 24kHz PCM16LE (-18 LUFS, 8ms cosine crossfade)
    WS-->>P0: Binary frame 0x02 downlink (Barge-in probe & in-place turn truncation supported)
  end
```

### Shared Deterministic Fast-Path & Tool Governance

- **FE/BE Parity (`207/207` fixtures):** [`shared/echo-jarvis/fast-path-parity-fixtures.json`](../../shared/echo-jarvis/fast-path-parity-fixtures.json) enforces identical classification across [`fastPathCompiler.ts`](../../frontend/src/lib/echo-jarvis/intents/fastPathCompiler.ts) / [`speechActAnalyzer.ts`](../../frontend/src/lib/echo-jarvis/intents/speechActAnalyzer.ts) / [`salienceTracker.ts`](../../frontend/src/lib/echo-jarvis/intents/salienceTracker.ts) and [`EchoVoiceFastPathMatcher.java`](../../backend/src/main/java/com/englishcoach/ai/voice/EchoVoiceFastPathMatcher.java) / [`EchoSpeechActAnalyzer.java`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoSpeechActAnalyzer.java) / [`EchoRouter.java`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoRouter.java). Negations, deferrals, metalinguistic mentions, and conditionals produce zero false actions.
- **23 Allow-Listed Tools & CaMeL Guardrails:** [`EchoToolRegistry`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoToolRegistry.java) validates every tool call against strict JSON Schemas (`additionalProperties: false`, forbidden parameter names rejected at startup), bounded per-turn budgets, [`TurnProvenance`](../../backend/src/main/java/com/englishcoach/ai/echo/camel/TurnProvenance.java), [`CaMeLPolicyEngine`](../../backend/src/main/java/com/englishcoach/ai/echo/camel/CaMeLPolicyEngine.java), and single-use confirmation tokens ([`EchoConfirmations`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoConfirmations.java)).

---

## 5. Service Boundaries (AI, Voice, Pronunciation, Multiplayer & Real-Time)

| Subsystem | Runtime & Location | Protocol & Endpoint | Authentication & Security | Concurrency / Resilience Controls |
|---|---|---|---|---|
| **Core REST API & BFF Auth** | Spring Boot 3.5 (`backend:8080`) + Next.js BFF (`frontend:3000`) | HTTPS `/api/v1/*`, `/api/auth/*` | HttpOnly session cookies, CSRF (`ec.csrf`), HMAC-signed `InternalServiceAuthFilter`, WebAuthn/TOTP Admin MFA | Tomcat `max=128`, HikariCP `max=24`, Nginx rate limits (`auth_actions`, `exams_practice_scopes`, `public_proxy`) |
| **Echo JARVIS Realtime Voice** | Spring Boot WebSocket (`EchoVoiceWebSocketHandler`) | WSS `/ws-card-blast/echo-voice` (JSON + `0x01`/`0x02` binary PCM) | Session cookie + Origin check + `EchoVoiceThrottleService` | Plane-A zero-LLM bypass, 3-tier LLM failover, sliding `TurnWatchdog`, barge-in truncation |
| **GPU Speech & Local LLM** | FastAPI (`englishcoach-ai-whisperx:8000`) | HTTP over private mesh (`/api/v1/coach/*`, `/api/v1/tts/*`, `/api/v1/listening/*`, `/pronunciation/v2/*`, `/api/v1/ocr/*`) | `X-EC-Service-Key` fail-closed (`503` if unset); open probes limited to `/api/v1/health` and `/api/v1/listening/capabilities` | `AiRequestBulkhead` (`24` permits), `SpeakingTtsService` concurrency gate, `echo_local_llm` `MAX_CONCURRENT_REQUESTS=2` |
| **Phoneme MDD V2.2 Engine** | Container (`docker-mdd-service-1:8010`) | Internal Docker HTTP (`docker_default`) | Never exposed to public internet; invoked exclusively by `englishcoach-ai-whisperx` | Dedicated GPU container (`CROTTC-IF` + `MDD-LLM-Llama3.2-1B`); `ShadowingAnalysisReceipts` (`V140`) single-use 30-min proof |
| **Asynchronous Exam Scoring** | Spring Boot (`ExamJobWorker`) + GPU FastAPI (`/exams/*`) | PostgreSQL lease queue (`exams.jobs`) + internal HTTP | `EXAMS_AI_INTERNAL_KEY` + `X-EC-Service-Key` | `4` objective + `2` productive worker slots, `120 s` lease / `30 s` renewal, `90 s` stage timeout |
| **Multiplayer Games & Messenger** | Spring Boot STOMP (`CardBlastPvPService`, `QuizRush`, `EchoLife`, `Messenger`) | WSS `/ws-card-blast` (STOMP) | Authenticated WebSocket session + Origin allowlist + `limit_conn ws_addr 100` | Server-authoritative state, `EchoLifeBulkhead` (`10` DB ops), `GardenContext` (`14` txns), `EchoSentinel` anti-cheat |
| **Speaking Arena Spatial Voice** | LiveKit Cloud WebRTC + `ArenaController` | WebRTC (media) + HTTPS token minting | Short-lived server-minted LiveKit JWT + V125 bound arena invitations | Client media offloaded to LiveKit; backend handles room signaling & access checks only |
| **Echo Anywhere Extension** | Chrome MV3 (`extension/echo-anywhere`) | HTTPS scoped `/api/v1/*` | PKCE pairing + `EchoAnywhereScopeFilter` endpoint allowlist + `APP_ECHO_ANYWHERE_EXTENSION_IDS` | Idle `14 d` / absolute `30 d` session limits, `20` AI reqs / 5 min burst cap |

---

## 6. Verified Design Patterns Catalog

Every pattern below maps directly to maintained production classes in the current codebase:

| Pattern | Production Implementation | Architectural Purpose |
|---|---|---|
| **Selective OSIV Exclusion** | [`OpenEntityManagerInViewConfig`](../../backend/src/main/java/com/englishcoach/common/config/OpenEntityManagerInViewConfig.java) | Disables Spring Boot's global OSIV (`open-in-view=false`) and registers a custom interceptor excluding `27` AI/upload paths so pooled JDBC connections are never held across remote inference calls. |
| **Bulkhead Isolation (Semaphore)** | [`AiRequestBulkhead`](../../backend/src/main/java/com/englishcoach/premium/interceptor/AiRequestBulkhead.java), [`GardenContext`](../../backend/src/main/java/com/englishcoach/garden/application/GardenContext.java), [`EchoLifeBulkhead`](../../backend/src/main/java/com/englishcoach/echolife/EchoLifeBulkhead.java) | Bounds concurrent AI (`24`), Garden (`14`), and Echo Life (`10`) workloads so slow dependencies or traffic bursts return fast `503` instead of starving core learning paths. |
| **Circuit Breaker & Multi-Tier Failover** | [`OpenRouterChatServiceImpl`](../../backend/src/main/java/com/englishcoach/ai/service/OpenRouterChatServiceImpl.java), [`echo_local_llm.py`](../../ai-service/app/services/echo_local_llm.py) | Trips a cooldown circuit breaker (`180 s` base backoff) on OpenRouter relay `HTTP 400`/outages and fails over seamlessly to secondary cloud or local CPU `Qwen3-4B`. |
| **Registry + Command + Capability Guard (CaMeL)** | [`EchoToolRegistry`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoToolRegistry.java), [`EchoTool`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoTool.java), [`CaMeLPolicyEngine`](../../backend/src/main/java/com/englishcoach/ai/echo/camel/CaMeLPolicyEngine.java) | Validates schemas, enforces per-turn tool budgets, checks provenance capabilities across all `23` tools, and requires single-use [`EchoConfirmations`](../../backend/src/main/java/com/englishcoach/ai/echo/EchoConfirmations.java) for state mutations. |
| **Strategy / Plugin Polymorphism** | [`PrestigeMetricEvaluator`](../../backend/src/main/java/com/englishcoach/avatarframe/evaluator/PrestigeMetricEvaluator.java) (`11` evaluators + [`PrestigeEvaluationEngine`](../../backend/src/main/java/com/englishcoach/avatarframe/evaluator/PrestigeEvaluationEngine.java)), [`PaymentProductHandler`](../../backend/src/main/java/com/englishcoach/payment/product/PaymentProductHandler.java) | Adds new avatar-frame prestige metrics and verifiable bank-transfer product settlement handlers without modifying core orchestration loops. |
| **Port / Adapter & Domain Event Decoupling** | [`LearnerDnaSnapshotProvider`](../../backend/src/main/java/com/englishcoach/common/contract/LearnerDnaSnapshotProvider.java), [`LearningPlanSummarySource`](../../backend/src/main/java/com/englishcoach/common/contract/LearningPlanSummarySource.java), [`ExamScoredEvent`](../../backend/src/main/java/com/englishcoach/common/event/ExamScoredEvent.java) | Breaks cross-module cycles (`learningpath <-> ai` and `proficiency <-> leaderboard`) by inverting dependencies onto shared contracts and Spring application events in `com.englishcoach.common`. |
| **Leaf Cache + Post-Commit Invalidation** | [`PremiumEntitlementCache`](../../backend/src/main/java/com/englishcoach/premium/service/PremiumEntitlementCache.java), [`BoundedTtlCache`](../../backend/src/main/java/com/englishcoach/common/cache/BoundedTtlCache.java) | Eliminates circular Spring bean injection between `PremiumSubscriptionService` and `PremiumEntitlementService` while pairing immediate eviction with `TransactionSynchronization.afterCommit()` eviction. |
| **Single-Use Cryptographic Receipt (Anti-Replay)** | [`ShadowingAnalysisReceipts`](../../backend/src/main/java/com/englishcoach/speaking/service/ShadowingAnalysisReceipts.java) | Issues `30`-minute TTL, audio SHA-256 bound receipts (`V133` / `V140`) locked with `FOR UPDATE` and marked consumed atomically when recording shadowing attempts. |
| **Lease-Based Asynchronous Worker** | [`ExamJobWorker`](../../backend/src/main/java/com/englishcoach/exams/job/ExamJobWorker.java) | Claims pending exam grading jobs from PostgreSQL (`exams.jobs`) with `120 s` leases, `30 s` heartbeats, and separate objective (`4`) and productive (`2`) concurrency pools. |
| **Clean / Hexagonal Domain Slice** | `com.englishcoach.garden.{api,application,domain,infra}` ([`EconomySimulator`](../../backend/src/main/java/com/englishcoach/garden/domain/EconomySimulator.java), [`GardenJdbc`](../../backend/src/main/java/com/englishcoach/garden/infra/GardenJdbc.java)) | Keeps deterministic game-economy simulation pure in `domain/`, isolating batched JDBC persistence in `infra/` and transaction/idempotency coordination in `application/`. |
| **Security Filter Chain (Defense-in-Depth)** | [`WebSecurityConfig`](../../backend/src/main/java/com/englishcoach/common/security/WebSecurityConfig.java), [`SessionCookieAuthenticationFilter`](../../backend/src/main/java/com/englishcoach/common/security/SessionCookieAuthenticationFilter.java), [`CookieCsrfProtectionFilter`](../../backend/src/main/java/com/englishcoach/common/security/CookieCsrfProtectionFilter.java), [`InternalServiceAuthFilter`](../../backend/src/main/java/com/englishcoach/common/security/InternalServiceAuthFilter.java), [`EchoAnywhereScopeFilter`](../../backend/src/main/java/com/englishcoach/extension/EchoAnywhereScopeFilter.java) | Enforces HttpOnly cookie authentication, double-submit CSRF, body-bound single-use HMAC signatures for BFF-to-backend auth routes, and extension endpoint allowlisting. |
| **Observed Backpressure Scheduler** | [`SlowJobsSchedulerConfig`](../../backend/src/main/java/com/englishcoach/common/scheduling/SlowJobsSchedulerConfig.java), [`ObservedCallerRunsPolicy`](../../backend/src/main/java/com/englishcoach/common/scheduling/ObservedCallerRunsPolicy.java) | Isolates slow scheduled jobs from request threads and logs saturation events when task queues spill over. |

---

## Related Documentation

- [Backend Layering, Package Ownership & End-to-End Flows](backend-layering.md)
- [Architecture Decision Records (ADRs)](adr.md)
- [Database Schema, ERD & Flyway Governance](../database/schema-and-migrations.md)
- [Developer Setup & Testing Guide](../development/developer-guide.md)
- [Production Deployment & Recovery Runbook](../operations/deployment-and-recovery.md)
- [External Resources & Model Provisioning Manifest](../operations/external-resources.md)
