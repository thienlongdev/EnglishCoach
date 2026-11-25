# Production Deployment, Verification & Recovery Runbook

> **Scope:** Authoritative production container specifications, Nginx edge security rules, pre-deployment backup protocol, canonical build/transfer procedures, live canary verification gates, and immediate rollback procedures for **English Coach** (`https://englishcoach.io.vn`).
>
> **Placeholder Convention:** Operational target identifiers are sanitized as `<VPS_HOST>`, `<VPS_USER>`, `<REMOTE_DIR>`, `<GPU_PRIVATE_MESH_HOST>`, and `<AZURE_POSTGRES_HOST>`. Supply real values strictly at invocation time via environment variables or off-repo configuration files.

---

## 1. Production Container & Infrastructure Specification

### 1.1 Production VPS Stack (`docker-compose.prod.yml`)

Deployed on `<VPS_HOST>` using [`docker-compose.prod.yml`](../../docker-compose.prod.yml) alongside an off-repo `.env.production` (permissions `chmod 600`):

| Service | Image | Limits (RAM / PIDs) | Runtime Hardening | Volumes & Ports | Healthcheck |
|---|---|---|---|---|---|
| **`backend`** | `english-coach-backend:prod` (`eclipse-temurin:21-jre`) | `832M` / `1024` | `-Xms192m -Xmx416m -XX:NewRatio=3 -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:ReservedCodeCacheSize=96m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=64m -Xss512k`, `MALLOC_ARENA_MAX=2`, `cap_drop: [ALL]`, non-root `uid 10001`, `no-new-privileges:true` | `backend_storage:/app/storage`, `${KING_SNAPSHOT_HOST_ROOT}/packages:ro`, `${KING_SNAPSHOT_HOST_ROOT}/state:ro`; internal `:8080` | Bash `/dev/tcp/127.0.0.1/8080` HTTP `200` on `/api/v1/exams/capabilities` (`30s` interval, `180s` start period) |
| **`frontend`** | `english-coach-frontend:prod` (`node:24-alpine`) | `256M` / `256` | `NODE_OPTIONS=--max-old-space-size=192`, `cap_drop: [ALL]`, `USER node`, `npm`/`corepack`/`yarn` stripped from runtime image; receives only NextAuth, OAuth, Turnstile public key & `APP_SECURITY_INTERNAL_SERVICE_KEY` | Internal `:3000` (stateless; `.next/cache` writable by `node`) | `wget -q --spider http://localhost:3000/api/health` (`30s` interval) |
| **`nginx`** | `nginx:alpine` | `160M` / `64` | `read_only: true`, tmpfs (`/var/cache/nginx:8m`, `/var/run:1m`, `/tmp:4m`), `cap_drop: [ALL]` + `NET_BIND_SERVICE` | Public `80`, `443`; `:ro` Nginx/Cloudflare/Certbot configs; `nginx_spool:/var/spool/nginx` | `wget -q --spider http://localhost/` (`15s` interval) |

### 1.2 Nginx Edge Security, CSP & Streaming Policy (`deploy/nginx/default.conf`)

Key invariants enforced by [`deploy/nginx/default.conf`](../../deploy/nginx/default.conf):

- **TLS & Origin Trust:** TLS 1.2 / 1.3 forward-secret AEAD suites, `4k` `ssl_buffer_size`, HSTS (`max-age=2592000`), verified Cloudflare peer IP rewriting (`cloudflare-realip.conf`), and query/referer-free access logs (`ec_access`) to prevent leaking one-time tokens.
- **Dual-Layer CSP:** Main HTML responses enforce strict origin allowlists without `'wasm-unsafe-eval'` or `'unsafe-eval'`, paired with per-request script nonces (`'strict-dynamic'`) in [`frontend/src/proxy.ts`](../../frontend/src/proxy.ts). Only two isolated worker prefixes override CSP (`add_header_inherit off`) with `'wasm-unsafe-eval'`:
  - `/vendor/listening-translator/` (`connect-src 'self'`)
  - `/vendor/study-physics/` (`connect-src 'none'`)
- **Internal Auth Route Lockdown:** Six token-issuing routes (`/api/v1/auth/login`, `/refresh`, `/session/refresh`, `/session/exchange`, `/google/exchange`, `/google/link`) unconditionally return `404` at the public edge and are reachable only over the internal Docker network with `InternalServiceAuthFilter` signatures.
- **Header Scrubbing & Fail-Closed Caching:** Every backend proxy location strips `X-Test-User ""`. API `Cache-Control` fails closed to `no-store, no-cache, must-revalidate, proxy-revalidate` unless upstream emits an explicit `private, max-age=...` or `private, no-store` header.
- **Streaming & Rate Limits:**
  - Unbuffered SSE: `location = /api/v1/ai/chat/stream` (`proxy_buffering off`, `proxy_read_timeout 300s`).
  - Unbuffered WebSockets: `location /ws-card-blast` (`limit_conn ws_addr 100`, `3600s` read/send timeouts, covers STOMP and `/ws-card-blast/echo-voice`).
  - Unbuffered media: `/api/v1/community/media/` and `/api/v1/(?:exams/media|listening/audio|speaking/audio|tts)/`.
  - Streamed Anki `.apkg` upload: `/api/v1/flashcards/upload-apkg` (`client_max_body_size 500m`, `limit_conn apkg_site 2`, `limit_conn apkg_addr 1`).
  - Standard API limits: `client_max_body_size 40m`, `large_body_site` (`16` concurrent `>= 8 MB` uploads), `exams_practice_scopes` (`30r/m`), `auth_actions` (`3r/s`), `public_proxy` (`10r/s`).

### 1.3 Private GPU Inference Stack (`deploy/ai/docker-compose.gpu.yml`)

Deployed on `<GPU_PRIVATE_MESH_HOST>` (Windows RTX 5070 host, never publicly exposed) under Compose project **`englishcoach-gpu`**:

- **`englishcoach-ai-whisperx`** (port `8000`, reachable by `<VPS_HOST>` over private encrypted mesh + `X-EC-Service-Key`): runs FastAPI Uvicorn with CUDA `faster-whisper-large-v3` + WhisperX, isolated `faster-whisper-large-v3-turbo` (`int8_float16`), `Kokoro-82M` EN TTS, EasyOCR, plus `0 MiB`-VRAM CPU `Qwen3-4B-Instruct` (`12,288` FP16 KV), `VieNeu-TTS-v3-Turbo` ONNX INT8 VI TTS, and `Smart Turn v3.2`.
- **`docker-mdd-service-1`** (port `8010`, internal `docker_default` network): phoneme-level MDD V2.2 diagnosis (`CROTTC-IF` + `MDD-LLM-Llama3.2-1B`). See [`docs/operations/external-resources.md`](external-resources.md) for its mandatory binary-image preservation requirement.

---

## 2. Pre-Deployment Backup Protocol

Complete all four backup steps **before** replacing any running production container or executing new Flyway migrations:

1. **Snapshot Running Container Digests & Rollback Tags (VPS & GPU Host):**
   ```bash
   # On <VPS_HOST>
   docker inspect --format '{{.Name}} | {{.Image}} | {{.Config.Image}}' \
     $(docker compose --env-file .env.production -f docker-compose.prod.yml ps -q)

   RELEASE_STAMP=$(date -u +%Y%m%d)
   docker tag english-coach-backend:prod  english-coach-backend:rollback-${RELEASE_STAMP}
   docker tag english-coach-frontend:prod english-coach-frontend:rollback-${RELEASE_STAMP}
   ```
   ```powershell
   # On <GPU_PRIVATE_MESH_HOST>
   docker image inspect englishcoach-ai-whisperx:<current-tag> --format '{{.Id}}'
   docker tag englishcoach-ai-whisperx:<current-tag> englishcoach-ai-whisperx:rollback-<YYYYMMDD>
   ```
2. **Verify Nightly & Pre-Release Encrypted Database Backup:**
   - Nightly backups run via [`deploy/ops/ec-backup.sh`](../../deploy/ops/ec-backup.sh): `pg_dump -Fc --no-owner --no-acl` over `sslmode=verify-full`, validated end-to-end with `pg_restore -f /dev/null`, encrypted with CMS AES-256-GCM / RSA-OAEP, hash-chained, and pulled off-host (`deploy/ops/pull-offhost.ps1`).
   - Before any release containing new Flyway migrations (`V141+`), trigger an explicit pre-release run of `ec-backup.sh` and confirm exit code `0` and non-zero plain dump byte count in `$EC_STATE/last-backup`.
3. **Preserve Persistent Volumes & Read-Only Mounts:**
   - Never run `docker compose down -v`. Confirm `backend_storage` (`/app/storage`) and host-owned `king/packages` & `king/state` mounts remain intact.
4. **Archive Off-Repo Configuration:** Ensure `.env.production` (mode `600`) and GPU host `ai-gpu.env` are backed up in the operator's encrypted vault outside Git.

---

## 3. Canonical Build, Transfer & Verification Workflow

### Step 1 — Pre-Build Source & Contract Gates

Run locally from the repository root before building Docker images:

```bash
python scripts/ci/repo_hygiene_check.py
(cd backend && mvn -B test-compile && mvn test -Dtest=ArchitectureLayeringGuardTest,Wave3RemediationBehaviorTest)
(cd frontend && npx tsc --noEmit && npm run test:security && npm run test:echo-jarvis && npm run test:wave-b-ux)
(cd ai-service && pytest app/tests/test_security_hardening.py app/tests/test_echo_local_llm.py app/tests/test_echo_jarvis_voice.py -q)
node docs/echo-life/aaa-evolution/scripts/verify-asset-provenance.cjs --strict
```

### Step 2 — Build Immutable Production Images

```powershell
# 1. Backend production image
docker compose --env-file .env.production.example -f docker-compose.prod.yml build backend

# 2. Frontend production image (enforces Turnstile Barrier 1 build guard + Barrier 2 chunk scan)
.\deploy\build-frontend-prod.ps1 -SiteKey $env:NEXT_PUBLIC_TURNSTILE_SITE_KEY

# 3. GPU AI delta image (when ai-service changes)
docker build -f deploy/ai/Dockerfile.gpu-echo -t englishcoach-ai-whisperx:<release-tag> ai-service
```

### Step 3 — Transfer & Recreate VPS Services (Explicit-Target Helpers)

[`deploy/deploy-backend-prod.ps1`](../../deploy/deploy-backend-prod.ps1) and [`deploy/deploy-frontend-prod.ps1`](../../deploy/deploy-frontend-prod.ps1) export the built image to a `.tar`, transfer it via `scp`, verify SHA-256 and loaded image digest on `<VPS_HOST>` before touching the running container, recreate the service under `nohup` with `--no-build --no-deps --force-recreate`, and poll container image identity plus healthcheck status:

```powershell
# Deploy backend
.\deploy\deploy-backend-prod.ps1 `
  -VpsHost <VPS_HOST> `
  -VpsUser <VPS_USER> `
  -RemoteProjectDirectory <REMOTE_DIR> `
  -SshKeyPath <PATH_TO_SSH_KEY>

# Deploy frontend
.\deploy\deploy-frontend-prod.ps1 `
  -VpsHost <VPS_HOST> `
  -VpsUser <VPS_USER> `
  -RemoteProjectDirectory <REMOTE_DIR> `
  -SshKeyPath <PATH_TO_SSH_KEY>
```

> **Nginx Discipline:** Do not recreate `nginx` unless `deploy/nginx/*.conf` changed. If updated, validate configuration syntax (`nginx -t`) before reloading.

### Step 4 — Deploy & Verify GPU AI Service

Update the image tag in [`deploy/ai/docker-compose.gpu.yml`](../../deploy/ai/docker-compose.gpu.yml) (keeping `name: englishcoach-gpu`), start without rebuilding, and run all 11 checks in [`deploy/ai/verify-ai-service.ps1`](../../deploy/ai/verify-ai-service.ps1):

```powershell
docker compose -p englishcoach-gpu -f deploy/ai/docker-compose.gpu.yml up -d --no-build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/ai/verify-ai-service.ps1
```

### Step 5 — Live Production Canary Checklist

A deployment is complete **only** after every canary passes against `https://englishcoach.io.vn`:

- [ ] **Container & Digest Truth:** Running `backend` and `frontend` image IDs match the built digests; all services report `healthy`.
- [ ] **HTTPS & Asset Availability:** Core routes (`/`, `/login`, `/register`, `/speaking`, `/reading`, `/listening`, `/writing`, `/flashcards`, `/exams`, `/study-space`) return `200`; `/_next/static/*` chunks return `200` with `immutable` caching.
- [ ] **Turnstile & CSP Integrity:** Zero Cloudflare test keys (`[123]x0000000000`) in live JS bundles; zero `'wasm-unsafe-eval'` on main HTML `Content-Security-Policy` headers; isolated workers under `/vendor/listening-translator/` and `/vendor/study-physics/` serve narrow worker CSP.
- [ ] **Auth & Edge Boundary:** Unauthenticated calls to protected `/api/v1/*` return `401`; public probes to `/api/v1/auth/login` and `/api/v1/auth/refresh` return Nginx `404`; WebSocket `/ws-card-blast/echo-voice` rejects unauthenticated (`401`) and cross-origin (`403`) handshakes.
- [ ] **GPU Mesh & Voice/AI Readiness:** `verify-ai-service.ps1` passes `11/11` checks (`ready: true`, `docker-mdd-service-1` `running unless-stopped`, zero obsolete `docker-ai-service-*` containers); VPS-to-GPU health/inference succeeds over private mesh.
- [ ] **Zero Startup Errors:** Inspect `docker logs --since 5m` on `backend`, `frontend`, `nginx`, and `englishcoach-ai-whisperx` to confirm zero uncaught exceptions or Hikari/VRAM errors.

---

## 4. Backward-Compatible Database Rollback Discipline

1. **Paired Auth/Contract Rollback:** Because production enforces `InternalServiceAuthFilter` with no unsigned grace window, whenever internal BFF headers or API contracts change, roll back **`backend` and `frontend` together**.
2. **Forward-Safe Migrations (No Destructive Down-Scripts):** All Flyway migrations (`V141+`) must follow expand-and-contract rules (additive columns, nullable or defaulted fields, non-blocking index updates). When an application regression occurs, roll back the container images while leaving the additive schema in place.
3. **Point-in-Time / Encrypted Dump Recovery:** Reserve PostgreSQL restore (`pg_restore` from decrypted `ec-backup.sh` custom dump or Azure PostgreSQL PITR) strictly for accidental data corruption — never for routine application rollback.

---

## 5. Immediate Rollback Triggers & Execution

### Automatic Rollback Triggers

Execute rollback immediately if any of the following occurs after cutover:

- Any production container fails healthcheck, enters crash-loop, or triggers cgroup OOM kills.
- Any Cloudflare test Turnstile key appears in served JS chunks, or CSP/auth boundaries fail canary checks.
- Sustained `5xx` error burst, HikariCP pool exhaustion (`503 SERVICE_BUSY`), or SePay webhook reconciliation failures.
- GPU host VRAM OOM, `verify-ai-service.ps1` failure, or broken Echo Voice / MDD V2.2 inference.

### Rollback Commands

**VPS Backend / Frontend Rollback (on `<VPS_HOST>`):**

```bash
cd <REMOTE_DIR>

# Re-tag verified pre-deploy rollback images to :prod
docker tag english-coach-backend:rollback-<YYYYMMDD>  english-coach-backend:prod
docker tag english-coach-frontend:rollback-<YYYYMMDD> english-coach-frontend:prod

# Recreate containers without rebuilding (preserves backend_storage volume)
docker compose --env-file .env.production -f docker-compose.prod.yml \
  up -d --no-build --no-deps --force-recreate backend frontend

# Confirm health and image digests
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

**Private GPU AI Rollback (on `<GPU_PRIVATE_MESH_HOST>`):**

```powershell
# Re-point deploy/ai/docker-compose.gpu.yml image to englishcoach-ai-whisperx:rollback-<YYYYMMDD>
docker compose -p englishcoach-gpu -f deploy/ai/docker-compose.gpu.yml up -d --no-build --force-recreate ai-service
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/ai/verify-ai-service.ps1
```

Re-run the Step 5 live canary checklist immediately after rollback to confirm service restoration.
