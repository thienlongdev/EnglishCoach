# Contributing to English Coach

Thank you for contributing to **English Coach**. This repository is maintained under strict architectural, security, and repository-hygiene standards so that engineers and automated tooling can collaborate safely without accumulating technical debt.

---

## 1. Branching & Commit Conventions

- Branch from `main` using descriptive branch names (`feat/<scope>`, `fix/<scope>`, `refactor/<scope>`, `docs/<scope>`).
- Keep commits focused and atomic using [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat:` — new user-facing capability
  - `fix:` — bug fix
  - `refactor:` — internal code restructuring without behavior change
  - `perf:` — measured performance improvement
  - `test:` — new or updated automated tests
  - `docs:` — documentation updates
  - `build:` / `ci:` / `chore:` — build system, CI pipelines, or maintenance
- Do not commit directly to `main` once branch protection is enabled; open a Pull Request and wait for all required CI checks to pass.

---

## 2. Architectural Standards

### Backend (Spring Boot Feature-Sliced Layered Monolith)
Each feature module lives under `com.englishcoach.<domain>` with clear internal layering:
- `controller/` — HTTP/WebSocket entrypoints, `@Valid` binding, security principal extraction, DTO mapping. **Never inject repositories directly or expose raw JPA `@Entity` objects from new controllers.**
- `service/` — business logic, policy checks, and `@Transactional` boundaries. Never hold database connections across external AI/GPU HTTP calls (`OpenEntityManagerInViewConfig` excludes AI paths). Never annotate `static` methods with `@Transactional`.
- `repository/` — Spring Data JPA or Spring JDBC persistence. Never depend upward on `service/`.
- `entity/` — persistence models. Never depend on `dto/`.
- `dto/` — explicit immutable request/response contracts (prefer Java 21 `record`).

Cross-module rules enforced automatically by `ArchitectureLayeringGuardTest`:
- `proficiency` must never depend on `leaderboard` (shared events belong in `com.englishcoach.common.event`).
- `learningpath` must never depend on `ai` (shared contracts belong in `com.englishcoach.common.contract`).
- Circular Spring bean injection is prohibited.

Specialized intentional architectures (`garden/` DDD slices and `exams/` Spring JDBC + async `ExamJobWorker`) are documented in [`docs/architecture/backend-layering.md`](docs/architecture/backend-layering.md) and must preserve their documented boundaries.

### Frontend (Next.js 16 App Router)
- Preserve exact semver dependency pinning in `frontend/package.json` (`no ^`, `no ~`, `no latest`, enforced by `npm run test:security`).
- Respect per-request CSP nonce rules (`0` `'wasm-unsafe-eval'` on main HTML pages).
- Treat provenance-verified assets (`frontend/public/echo-life/**`) and hash-pinned modules (`BookReader.tsx`, `SelectionTools.tsx`, `lib/echo-life/v3/**`, pinned Listening modules) as guarded contracts; run their contract tests before modifying adjacent code.

### Database Migrations (Flyway)
- All migrations live under `backend/src/main/resources/db/migration/exams/` using sequential `V<N>__<snake_case_description>.sql` naming (next free version after baseline: `V141`).
- Never edit an already-applied Flyway migration file.
- Ensure every new migration is backward-compatible with the currently running production release whenever practical.

---

## 3. Permanent Repository Hygiene Policy

To prevent repository bloat and unmaintained clutter from re-entering version control:

1. **No Secrets or Private Infrastructure Data:** Never commit `.env*` secrets, API keys, private keys, database dumps, or private server IP addresses. Use `.env.production.example` and `ai-service/.env.example` templates only.
2. **No Runtime Datasets or Model Weights in Git:** Never commit exam corpora, audio/video collections, SQLite dictionary databases, PyTorch/ONNX/GGUF checkpoints, or calibration caches. Document external assets in [`docs/operations/external-resources.md`](docs/operations/external-resources.md).
3. **No Uncontrolled Verification Scripts or QA Media:** Do not add ad-hoc `verify-*.cjs`, `probe-*.mjs`, `debug-*.py`, `capture-*.cjs`, screenshots, screen recordings, or raw JSON diagnostic dumps to the repository root, `docs/`, or `frontend/scripts/`. Add new assertions directly to the maintained JUnit 5 (`backend/src/test`), `npm run test:*` (`frontend/scripts`), or `pytest` (`ai-service/app/tests`) suites.
4. **No Internal Coding-Agent Workspaces:** Keep local AI assistant state, session transcripts, private prompts, and workspace-specific agent instruction directories outside tracked Git history. Temporary scratch outputs must stay in ignored local directories outside maintained source trees and be cleaned after task completion.
5. **Automated Enforcement:** Run `python scripts/ci/repo_hygiene_check.py` locally before pushing. CI runs the same guardrail on every push and pull request.

---

## 4. Pre-PR Verification Checklist

Before opening a Pull Request, run the relevant verification suites:

```bash
# Repository hygiene & secret/link scan
python scripts/ci/repo_hygiene_check.py

# Backend compile & architecture guardrails
cd backend && mvn -B test-compile && mvn test -Dtest=ArchitectureLayeringGuardTest,Wave3RemediationBehaviorTest

# Frontend typecheck & contract suites
cd frontend && npx tsc --noEmit && npm run test:security && npm run test:echo-jarvis && npm run test:wave-b-ux

# AI service unit tests
cd ai-service && pytest app/tests/test_security_hardening.py app/tests/test_echo_local_llm.py -q
```
