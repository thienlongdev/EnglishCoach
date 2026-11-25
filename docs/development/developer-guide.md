# English Coach — Developer Guide & Local Engineering Workflow

> **Scope:** Complete local setup, repository navigation, feature development recipes, automated verification commands, and troubleshooting guide for onboarding engineers working on **English Coach**.

---

## 1. Prerequisites

| Tool | Required Version | Notes |
|---|---|---|
| **Java (JDK)** | **21+** (Eclipse Temurin recommended) | Enforced by [`backend/pom.xml`](../../backend/pom.xml) (`<java.version>21</java.version>`) |
| **Apache Maven** | **3.9+** | Builds and tests the Spring Boot `3.5.16` backend |
| **Node.js & npm** | **Node 24 LTS** (`>= 20.9.0`), npm `11+` | Matches production `node:24-alpine` in [`frontend/Dockerfile.prod`](../../frontend/Dockerfile.prod) |
| **Python & pytest** | **Python 3.11+**, `pytest 8.3+` | Runs the FastAPI `ai-service` and Python CI hygiene scripts |
| **PostgreSQL / Docker** | **PostgreSQL 17** or Docker Desktop | Used for local persistence and Testcontainers integration suites |

---

## 2. Local Environment Setup & Startup

### 2.1 Local PostgreSQL 17 Database

Start a local PostgreSQL 17 instance using the development Compose file or a standalone container:

```bash
# Option A: Start PostgreSQL via local development Compose
docker compose -f infra/docker/docker-compose.yml up -d postgres

# Option B: Standalone PostgreSQL 17 container
docker run -d --name ec-postgres17 \
  -e POSTGRES_DB=english_coach \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:17
```

Flyway (`V1`–`V140`) executes automatically on backend startup against `jdbc:postgresql://localhost:5432/english_coach`, or can be executed explicitly:

```bash
cd backend
mvn -Pmigrate-exams flyway:migrate
```

### 2.2 Backend (Spring Boot 3.5 / Java 21)

Before starting offline dictionary lookups, provision `backend/src/main/resources/lexical/dictionary_en_vi.db` per [`docs/operations/external-resources.md`](../operations/external-resources.md).

```bash
cd backend
mvn -B test-compile
mvn spring-boot:run
```

- **Local URL:** `http://localhost:8080`
- **OpenAPI / Swagger UI:** Enabled in default (non-`prod`) profile; automatically disabled when `SPRING_PROFILES_ACTIVE=prod`.
- **Key Local Environment Overrides:** `DB_URL`, `DB_USER`, `DB_PASSWORD`, `AI_SERVICE_URL` (default `http://localhost:8000`), `AI_SERVICE_KEY`, `OPENROUTER_API_KEY`, `APP_SECURITY_TEST_FILTER_ENABLED=true` (local testing only; never enable in production).

### 2.3 Frontend (Next.js 16.4.5 / React 19)

```bash
cd frontend
npm ci
```

Create a local `frontend/.env.local` (never committed):

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8080/api/v1
BACKEND_INTERNAL_URL=http://localhost:8080
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=local-dev-nextauth-secret-change-me
# Cloudflare test Turnstile key is allowed in local dev only (rejected by Dockerfile.prod)
NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

Start the development server:

```bash
npm run dev
```

- **Local URL:** `http://localhost:3000`
- **Production-equivalent local build check:** `npm run build` (runs `next build --webpack` with full TypeScript validation).

### 2.4 AI Service (FastAPI / Python 3.11+)

```bash
cd ai-service
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
cp .env.example .env
```

Set `AI_SERVICE_KEY` (matching the backend's `AI_SERVICE_KEY`) and optional `OPENROUTER_API_KEY` in `ai-service/.env`, then start Uvicorn:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

- **Note:** `ENABLE_ECSM_RUNTIME` defaults to `false` to avoid consuming unnecessary GPU VRAM during ordinary development. For full commercial-clean GPU inference (Kokoro-82M, VieNeu-TTS-v3-Turbo, `faster-whisper-large-v3-turbo`, and local CPU `Qwen3-4B`), see [`ai-service/requirements.gpu-echo.lock.txt`](../../ai-service/requirements.gpu-echo.lock.txt) and [`docs/operations/external-resources.md`](../operations/external-resources.md).

### 2.5 Echo Anywhere Browser Extension (Chrome / Edge MV3)

```bash
cd extension/echo-anywhere
node build.mjs
```

Load the generated unpacked directory `extension/echo-anywhere/dist/unpacked/` via `chrome://extensions` or `edge://extensions` with **Developer mode** enabled. The development extension ID (`kfepndgiddgljieglnilcaadlcgmdghj`) is pinned by `dev-key.public.json` and allowed by default in `application.yml` (`app.echo-anywhere.extension-ids`).

---

## 3. Feature Locator Map

| Domain | Backend Package (`com.englishcoach.*`) | Frontend Paths (`frontend/src/`) | AI Service Routes (`ai-service/app/api/routes/`) | Primary Verification Suites |
|---|---|---|---|---|
| **Exams (IELTS / TOEIC)** | `exams` | `app/exams/`, `components/features/exams/` | `exams.py` | `npm run test:exams-contracts`, `ExamPhase5ImportArchitectureTest` |
| **Speaking, Shadowing & Profile** | `speaking` (`shadowing`, `profile`, `arena`, `topic`) | `app/speaking/`, `components/features/speaking/` | `speaking.py`, `pronunciation_v2.py`, `ecsm.py`, `tts.py` | `npm run test:wave-b-ux`, `npm run test:speaking-arena`, `npm run test:shadowing-audio` |
| **Echo JARVIS Voice & AI Coach** | `ai` (`echo`, `voice`, `service`), `echocoach`, `coach` | `lib/echo-jarvis/`, `components/features/coach/`, `public/echo-jarvis/` | `coach.py`, `tts.py` | `npm run test:echo-jarvis`, `test_echo_local_llm.py`, `test_echo_jarvis_voice.py` |
| **Reading, My Books & Dictionary** | `reading`, `dictionary` | `app/reading/`, `components/features/reading/` | `reading.py`, `dictionary.py`, `ocr.py` | `npm run test:my-books`, `npm run test:reading-glass`, `npm run test:dictionary` |
| **Listening & On-Device Translator** | `listening` | `app/listening/`, `public/vendor/listening-translator/` | `listening.py` | `npm run test:listening-glass`, `npm run test:listening-translator`, `test_listening_pipeline_law.py` |
| **Writing & Translation Studio** | `writing` (`translation`) | `app/writing/`, `components/features/writing/` | `writing.py` | `npm run test:writing-glass`, `npm run test:wave-b-ux` |
| **Flashcards, Decks & Card Blast PvP** | `flashcard` (`memory`, `pvp`), `vocabulary` | `app/flashcards/`, `app/games/` | — | `npm run test:flashcard-study`, `npm run test:memory-tides`, `npm run test:games` |
| **Games, Sentinel & Cosmos** | `quizrush`, `kingofenglish`, `hangman`, `wordchain`, `spelling`, `sentinel`, `cosmos` | `app/games/`, `app/cosmos/` | — | `npm run test:king-of-english`, `npm run test:echo-sentinel`, `npm run test:cosmos` |
| **3D Worlds (Study Space / Echo Life / Odyssey)** | `studyspace`, `echolife`, `garden`, `learningpath`, `background`, `wallpaper` | `app/study-space/`, `components/study-space/`, `public/vendor/study-physics/` | — | `npm run test:study-space`, `npm run test:connected-worlds`, `npm run test:odyssey-planet` |
| **Auth, Premium, SePay & Community** | `auth`, `premium`, `payment`, `user`, `community`, `messenger`, `notification`, `feedback` | `app/login/`, `app/premium/`, `app/community/`, `app/api/auth/` | — | `npm run test:security`, `npm run test:bff-csrf`, `npm run test:premium-glass`, `npm run test:community` |

---

## 4. Step-by-Step Engineering Recipes

### 4.1 Adding a New Backend Module

1. Create `backend/src/main/java/com/englishcoach/<domain>/{controller,dto,entity,repository,service}/` following the conventions in [`docs/architecture/backend-layering.md`](../architecture/backend-layering.md).
2. Add a forward-only Flyway migration under `backend/src/main/resources/db/migration/exams/V141__<description>.sql` starting with `SET LOCAL lock_timeout = '5s';`.
3. Keep all controller inputs/outputs as immutable Java 21 DTO `record`s; never inject a repository into a controller or return a JPA `@Entity`.
4. Register the new controller in `ArchitectureLayeringGuardTest.REMEDIATED_CONTROLLERS` and add unit tests under `backend/src/test/java/com/englishcoach/<domain>/`.

### 4.2 Adding a New Frontend Feature

1. Create App Router pages under `frontend/src/app/<route>/` and modular feature components under `frontend/src/components/features/<feature>/`.
2. Route authenticated browser API requests through the same-origin `/api/v1/*` client so HttpOnly cookies and `ec.csrf` tokens attach automatically.
3. If adding an npm package to [`frontend/package.json`](../../frontend/package.json), pin an **exact semver version** (no `^`, `~`, or `latest`), update `package-lock.json` via `npm install --save-exact`, and run `npm run test:security`.
4. Respect main-page CSP rules: never introduce `eval`, `new Function`, inline event handlers, or unapproved third-party origins without coordinating [`deploy/nginx/default.conf`](../../deploy/nginx/default.conf) and [`frontend/src/proxy.ts`](../../frontend/src/proxy.ts).

### 4.3 Adding a New REST API Endpoint

1. Define validated request/response DTO records (`@Valid`, explicit field length/range bounds).
2. Verify security access in [`WebSecurityConfig`](../../backend/src/main/java/com/englishcoach/common/security/WebSecurityConfig.java) (authenticated by default; explicit `@AuthenticationPrincipal UserDetailsImpl` ownership check on every user-owned resource).
3. If the endpoint calls an external LLM or GPU worker:
   - Annotate with `@RequirePremiumAi("<FEATURE_KEY>")` when quota-gated.
   - Add the path pattern to [`OpenEntityManagerInViewConfig.CONNECTION_FREE_PATHS`](../../backend/src/main/java/com/englishcoach/common/config/OpenEntityManagerInViewConfig.java) and confirm zero lazy JPA loading outside `@Transactional`.
   - If the endpoint streams SSE or audio, verify buffering rules in [`deploy/nginx/default.conf`](../../deploy/nginx/default.conf).
4. Add a contract test in `backend/src/test/` and (when consumed by the UI) a corresponding script assertion in `frontend/scripts/`.

---

## 5. Verification & Test Suites

Run the targeted suites below before opening any Pull Request (mirrors `.github/workflows` CI checks):

```bash
# 1. Repository hygiene, secret scanning & Markdown link validation
python scripts/ci/repo_hygiene_check.py

# 2. Backend compilation & architectural guardrails
cd backend
mvn -B test-compile
mvn test -Dtest=ArchitectureLayeringGuardTest,Wave3RemediationBehaviorTest

# 3. Frontend TypeScript check & core regression suites
cd ../frontend
npx tsc --noEmit
npm run test:security
npm run test:security-regressions
npm run test:echo-jarvis
npm run test:wave-b-ux
npm run test:my-books
npm run test:exams-contracts
npm run test:study-space

# 4. AI Service unit tests (run from ai-service/ so pytest.ini pythonpath=. applies)
cd ../ai-service
pytest app/tests/test_security_hardening.py \
       app/tests/test_echo_local_llm.py \
       app/tests/test_echo_jarvis_voice.py \
       app/tests/test_listening_pipeline_law.py \
       app/tests/test_ipa_hardening.py -q

# 5. Echo Life 3D asset provenance verification
cd ..
node docs/echo-life/aaa-evolution/scripts/verify-asset-provenance.cjs --strict
```

To run the complete frontend contract matrix, execute `npm test` inside `frontend/`.

---

## 6. Common Pitfalls & Troubleshooting

| Symptom / Error | Root Cause | Resolution |
|---|---|---|
| **`test:my-books` or `test:security` fails on `pdfjs-dist`** | `pdfjs-dist` (`6.3.289`) was moved to `dependencies` or imported statically at top-level. | Keep `pdfjs-dist` pinned to exact `6.3.289` in `frontend/package.json` **`devDependencies`** only and load it exclusively via dynamic `import("pdfjs-dist")` in `frontend/src/components/features/reading/books/engine/pdf.ts`. It is bundled into client build output at build time and excluded from the production Node runtime container (`npm ci --omit=dev`). |
| **`test:security` fails on dependency version or lockfile** | Range specifiers (`^`, `~`, `latest`) in `frontend/package.json`, lockfile drift, or an accidental `frontend/pnpm-lock.yaml`. | Pin exact versions, regenerate `frontend/package-lock.json` with `npm install`, and remove any `pnpm-lock.yaml`. |
| **`ModuleNotFoundError: No module named 'app'` in `pytest`** | Running `pytest` from the repo root instead of `ai-service/`. | Always run `pytest` from inside `ai-service/` so [`ai-service/pytest.ini`](../../ai-service/pytest.ini) (`pythonpath = .`, `testpaths = app/tests`) takes effect. |
| **Lombok / Java compilation errors in IDE** | IDE not using JDK 21 or annotation processing disabled. | Select JDK 21 in project SDK settings and enable annotation processing for Lombok (configured in `backend/pom.xml` via `maven-compiler-plugin`). |
| **`Dockerfile.prod` aborts with Turnstile Build Guard** | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is blank or uses a Cloudflare test key (`1x0000000000...`, `2x...`, `3x...`). | Test keys are permitted only in `npm run dev`. Production image builds require a real Cloudflare Turnstile site key passed via `deploy/build-frontend-prod.ps1`. |
| **Dictionary lookup or pronunciation returns unavailable locally** | Excluded external runtime assets (`dictionary_en_vi.db`, `hubert_knn_reference_index.npz`, or HuggingFace weights) are not provisioned. | Follow [`docs/operations/external-resources.md`](../operations/external-resources.md) to provision and SHA-256 verify required local runtime assets. |
| **Testcontainers tests fail to start PostgreSQL** | Docker daemon not running or socket unavailable. | Start Docker Desktop and verify `docker ps` succeeds before running Testcontainers-backed JUnit tests. |
