# External Resources, Models & Runtime Asset Manifest

> **Scope:** Complete provisioning manifest for all runtime datasets, examination media, offline dictionaries, pronunciation artifacts, neural model weights, offline authoring corpora, and environment configuration files intentionally excluded from Git under the source-only repository policy ([ADR-005](../architecture/adr.md#adr-005-strict-source-only-git-repository-policy--external-runtime-provisioning), enforced by [`scripts/ci/repo_hygiene_check.py`](../../scripts/ci/repo_hygiene_check.py)).

---

## 1. Master External Resource Inventory

| # | Resource Path / Store | Verified Size & File Count | Primary Consumer | Deployment Target | License / Governance |
|---|---|---|---|---|---|
| **1** | `backend/src/main/resources/lexical/dictionary_en_vi.db` | `42.16 MiB` (`44,212,224` B, `1` file) | `LocalEnViLexicalProvider` (read-only SQLite) | Baked into `backend` image at `/app/data/dictionary_en_vi.db` | **CC BY-SA 4.0** (Skypedia pinned commit `388adc08...`) |
| **2** | `ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz` | `36.97 MiB` (`38,767,457` B, `1` file) | ECSM Pronunciation Runtime (`ai-service`) | GPU AI service runtime (when `ENABLE_ECSM_RUNTIME=true`) | Internal derived acoustic index |
| **3** | `frontend/public/storage/exams/` | `443.97 MiB` (`766` files) | Exam UI visuals & examiner media (`/storage/exams`) | Frontend build / Nginx static serving | Controlled exam media assets |
| **4** | `frontend/public/{assets/odyssey, speaking/arena, assets/flashcards, vendor/listening-translator}` | `596.07 MiB` total (`734` files across 4 subtrees) | 3D Odyssey/Arena, Flashcard visuals, On-Device ONNX Translator | Frontend static public bundle (`MANIFEST.sha256` pinned) | Permissive / CC0 / CC BY 4.0 / Apache-2.0 (see [`docs/ATTRIBUTION.md`](../ATTRIBUTION.md)) |
| **5** | `backend/storage/` (VPS volume `backend_storage`) | `6.24 GiB` (`6.70 GB`, `1,076` files in local mirror) | User uploads, speaking recordings, community media, listening/exam files | Docker volume `backend_storage:/app/storage` on `<VPS_HOST>` | User-generated & platform runtime media |
| **6** | `english-coach-models/` + `docker-mdd-service:latest` | `4.77 GiB` (`105` files) + `13.1 GB` container image | `docker-mdd-service-1` (`:8010`) phoneme MDD V2.2 scoring | Mounted `:ro` on `<GPU_PRIVATE_MESH_HOST>` | **Binary-only container limitation** (see §3.6) |
| **7** | `audit_artifacts/` & `real_mic_acceptance_pack/` | `1.76 GiB` (`603` files) + `4.14 MiB` (`54` files) | Pronunciation V2.2 runtime checkpoints & calibration QA | Mounted `:ro` into `englishcoach-ai-whisperx` | Internal trained weights & calibration fixtures |
| **8** | HuggingFace Hub Cache (`/root/.cache/huggingface`) | Multi-GB (`11` model repos) | `englishcoach-ai-whisperx` (ASR, TTS, local CPU LLM, turn detection, alignment) | Host cache mounted into `/root/.cache/huggingface` | Commercial-clean (`Apache-2.0` / `MIT` / `BSD-2-Clause` core stack) |
| **9** | `imports/`, `data/exam-bank/`, `content/` | `15.70 GiB` total (`165,846` files) | Offline exam/content authoring & build pipelines only | Local authoring workstation only (never in runtime images) | Mixed offline authoring corpora |
| **10** | `.env.production` & GPU `ai-gpu.env` | Environment files (mode `600`) | VPS Compose stack & GPU `englishcoach-gpu` stack | Outside Git on `<VPS_HOST>` and `<GPU_PRIVATE_MESH_HOST>` | Confidential operational secrets |

---

## 2. Live-Verified SHA-256 Checksum Ledger

The cryptographic digests below were computed directly from the canonical production artifacts:

| Artifact Path | Exact Size (Bytes) | SHA-256 Digest |
|---|---|---|
| `backend/src/main/resources/lexical/dictionary_en_vi.db` | `44,212,224` (`42.16 MiB`) | `2b65bea9577c2a4149caa90940c806f321d1c6cfac503ed8bbd9f93e43a0033a` |
| `ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz` | `38,767,457` (`36.97 MiB`) | `7feb44c632206a60ab94121a822d88b7029a96d6a9ec8cbd4bfcf486047d95c5` |
| `audit_artifacts/models/pron_v2_block3b_canonical_final.pt` | `1,262,159,895` (`1,203.69 MiB`) | `375f872f43b0e2c5fdfb316b0795fd197d9fde901524d833cf873fb460d1f98d` |
| `audit_artifacts/runtime/pronunciation_v2_2_production/PRON_V2_2_RUNTIME_MANIFEST.json` | `2,373` | `de0977c4d4b19c7cdedf6a5b9a7099240655f653481d56e6bcce6c72f2271fb2` |

### Pinned Pronunciation V2.2 Champion Weights (from `PRON_V2_2_RUNTIME_MANIFEST.json`)

| Component | Relative Path under `audit_artifacts/` | SHA-256 Digest |
|---|---|---|
| Alignment Probe | `models/pron_v2_block3b_canonical_final.pt` | `375f872f43b0e2c5fdfb316b0795fd197d9fde901524d833cf873fb460d1f98d` |
| Segmental Champion | `runtime/pronunciation_v2_2_production/pron_v2_2_segmental_champion.pt` | `4d9cf631ea833f6e24c9e5bb88c74f7f1f67c2ca5d041e169a6ad2f2074a70bd` |
| Diagnosis Champion | `runtime/pronunciation_v2_2_production/pron_v2_2_diagnosis_champion.pt` | `4d36539ebd3e632d5f0e5824f70cc5598a0ddb8670c2981f16284024ffc9909c` |
| Prosody Champion | `runtime/pronunciation_v2_2_production/pron_v2_2_prosody_champion.pt` | `768c8d216ff0dd095d9e6a3ed140b0387d62f7160afe5382db4ad6b971a80b1f` |
| Calibration Parameters | `runtime/pronunciation_v2_2_production/CALIBRATION_RESULTS.json` | `3ad570676ba93a9ab4285acb09ead19187d2b342898bbd78402ca1fa6984e202` |

---

## 3. Detailed Provisioning Guides (Categories 1–10)

### 3.1 Offline English-Vietnamese Lexical Dictionary (`dictionary_en_vi.db`)

- **Target Path:** `backend/src/main/resources/lexical/dictionary_en_vi.db` (`42.16 MiB`)
- **Upstream Source:** `https://github.com/skypediacode/english-vietnamese-dictionary`
- **Pinned Upstream Commit:** `388adc0826300912e5b0311c089e0e70494b065f`
- **License:** Creative Commons Attribution-ShareAlike 4.0 International (**CC BY-SA 4.0**). Full lineage is recorded in [`docs/ATTRIBUTION.md`](../ATTRIBUTION.md).
- **Provisioning:** Download the SQLite database from the pinned commit (or internal artifact store), place it at `backend/src/main/resources/lexical/dictionary_en_vi.db`, and verify the SHA-256 digest in §2 before running `docker compose ... build backend` (which copies it to `/app/data/dictionary_en_vi.db` owned by `uid 10001`).

### 3.2 ECSM Pronunciation Reference Index (`hubert_knn_reference_index.npz`)

- **Target Path:** `ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz` (`36.97 MiB`)
- **Provisioning:** Restore from the team's private artifact mirror before enabling `ENABLE_ECSM_RUNTIME=true` on the AI service, and confirm SHA-256 `7feb44c6...`.

### 3.3 Frontend Examination Visuals & Examiner Media (`frontend/public/storage/exams/`)

- **Target Path:** `frontend/public/storage/exams/` (`766` files, `443.97 MiB`)
- **Runtime Path:** Served statically under `/storage/exams/*` by the frontend container behind Nginx.
- **Provisioning:** Sync the verified exam media bundle into `frontend/public/storage/exams/` prior to building `english-coach-frontend:prod`.

### 3.4 Large Static Frontend Media & On-Device Translator Weights

Provision these four asset trees into `frontend/public/` from the project's static media store (or regenerate from build pipelines where noted) prior to frontend builds:

| Subtree | Verified File Count & Size | Notes & Integrity Check |
|---|---|---|
| `frontend/public/assets/odyssey/` | `99` files / `306.64 MiB` | Echo Odyssey 3D planet textures and meshes |
| `frontend/public/speaking/arena/` | `165` files / `156.47 MiB` | Echo Archipelago v7 Zero-WASM 3D models, PBR maps, and skies (`v7-manifest.json`, attributed in [`docs/ATTRIBUTION.md`](../ATTRIBUTION.md)) |
| `frontend/public/assets/flashcards/` | `456` files / `9.74 MiB` | Curated flashcard illustration thumbnails |
| `frontend/public/vendor/listening-translator/` | `14` files / `123.22 MiB` | Pinned Transformers.js `3.8.1` + quantized `Helsinki-NLP/opus-mt-en-vi` ONNX `.bin` weights + `worker-v2.js`. Verify all `13` entries against `frontend/public/vendor/listening-translator/MANIFEST.sha256` (`sha256sum -c MANIFEST.sha256`). |

### 3.5 Backend Persistent Media Storage (`backend/storage/` & `backend_storage`)

- **Local Development Mirror:** `backend/storage/` (`1,076` files, `6.24 GiB` / `6.70 GB`).
- **Production Storage:** Named Docker volume `backend_storage` mounted at `/app/storage` inside `backend` (`EXAMS_LOCAL_STORAGE_DIR=/app/storage/exams`, `COMMUNITY_STORAGE_DIR=/app/storage/community`), plus operator-owned read-only host mounts `${KING_SNAPSHOT_HOST_ROOT:-./king}/packages` and `${KING_SNAPSHOT_HOST_ROOT:-./king}/state`.
- **Provisioning:** Provision `king/packages` and `king/state` read-only on `<VPS_HOST>` prior to backend recreation; synchronize `backend_storage` via encrypted backups (`deploy/ops/ec-backup.sh` and off-host volume snapshots). Never run `docker compose down -v`.

### 3.6 Pronunciation MDD Models (`english-coach-models/`) & Binary-Only `docker-mdd-service` Limitation

- **Host Model Directories (`4.77 GiB` total, `105` files):**
  - `english-coach-models/crottc-if-l2-arctic/` (`53` files, `1.24 GiB`) — mounted `:ro` at `/models/crottc-if-l2-arctic`
  - `english-coach-models/mdd-llm-llama3.2-1b/` (`52` files, `3.53 GiB`) — mounted `:ro` at `/models/mdd-llm-llama3.2-1b`

> [!WARNING]
> **Critical Source-Reproducibility Limitation — Binary-Only `docker-mdd-service` Container:**
> Production phoneme-level pronunciation scoring (`:8010`, container `docker-mdd-service-1`) currently runs from the pre-built Docker image **`docker-mdd-service:latest`** (`sha256:d2baa05478f48bd52f4a23923e49ee361ec823ba553bcb2108ddbe98ad3f7ba5`, `13.1 GB`). Although [`infra/docker/docker-compose.yml`](../../infra/docker/docker-compose.yml) references `build: ../../mdd-service`, **the `mdd-service/` application source directory does not exist in this repository**.
>
> **Mandatory Operational Preservation Requirement:**
> 1. **NEVER** run `docker image prune -a` or delete `docker-mdd-service:latest` on `<GPU_PRIVATE_MESH_HOST>`.
> 2. Maintain an immutable off-host backup tarball (`docker save -o docker-mdd-service-d2baa054.tar docker-mdd-service:latest`) together with its SHA-256 digest and the `english-coach-models/` directory until the `mdd-service` source tree is formally reconstructed or replaced.

### 3.7 GPU Read-Only Pronunciation Artifacts & Acceptance Packs

Mounted read-only (`:ro`) into `englishcoach-ai-whisperx` via [`deploy/ai/docker-compose.gpu.yml`](../../deploy/ai/docker-compose.gpu.yml):

- **`audit_artifacts/`** (`603` files, `1.76 GiB`) -> `/app/audit_artifacts:ro` (houses Pronunciation V2.2 alignment probe and champion checkpoints verified in §2).
- **`real_mic_acceptance_pack/`** (`54` files, `4.14 MiB`) -> `/app/real_mic_acceptance_pack:ro` (real-microphone acoustic regression fixtures).

### 3.8 HuggingFace Hub Model Cache (`/root/.cache/huggingface`)

Mount a persistent HuggingFace cache directory on `<GPU_PRIVATE_MESH_HOST>` (`-v <HOST_HF_CACHE>:/root/.cache/huggingface`) and pre-populate the following `11` repositories (plus the optional Qwen2.5 fallback):

| HuggingFace Repository | Pinned Commit / Version | License | Execution Target & Role |
|---|---|---|---|
| `unsloth/Qwen3-4B-Instruct-2507-GGUF` (`Qwen3-4B-Instruct-2507-Q4_K_M.gguf`) | `a06e946bb6b655725eafa393f4a9745d460374c9` | Apache-2.0 | **CPU (`0 MiB` VRAM)** — Echo Tier-3 local failover LLM (`n_ctx=12288` FP16 KV); fallback: `Qwen/Qwen2.5-1.5B-Instruct-GGUF` @ `91cad51170dc346986eccefdc2dd33a9da36ead9` |
| `hexgrad/Kokoro-82M` | `v1.0` | Apache-2.0 | **CUDA GPU** — English streaming TTS (`jarvis-tts-v2` via `kokoro.model.KModel`) |
| `pnnbao-ump/VieNeu-TTS-v3-Turbo` | `61b85e3d937fbbacb387714180e8182823512523` | Apache-2.0 | **CPU ONNX INT8 (`0 MiB` VRAM)** — Vietnamese & EN-VI code-switching TTS |
| `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX` | `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` | Apache-2.0 | **CPU ONNX** — Audio codec backing `VieNeu-TTS-v3-Turbo` |
| `Systran/faster-whisper-large-v3` | `large-v3` | MIT | **CUDA GPU** — Listening YouTube transcription pipeline |
| `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | `int8_float16` | MIT | **CUDA GPU** — Isolated Echo JARVIS real-time microphone ASR |
| `pipecat-ai/smart-turn-v3` | `v3.2` (ONNX) | BSD-2-Clause | **CPU ONNX (`0 MiB` VRAM)** — Semantic end-of-turn detection |
| `nguyenvulebinh/wav2vec2-base-vi-vlsp2020` | — | Apache-2.0 | Vietnamese acoustic alignment / speech support |
| `facebook/wav2vec2-lv-60-espeak-cv-ft` | — | MIT | Forced alignment / phoneme reference backbone |
| `microsoft/wavlm-large` | — | MIT | Pronunciation V2.2 acoustic backbone |
| `Helsinki-NLP/opus-mt-en-vi` | Quantized ONNX snapshot `30bcd461` | Apache-2.0 / CC BY 4.0 | Offline EN-VI translation (quantized browser files live in `frontend/public/vendor/listening-translator/`) |

Pre-download example using `huggingface_hub`:

```bash
python -c "
from huggingface_hub import hf_hub_download, snapshot_download
hf_hub_download('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', revision='a06e946bb6b655725eafa393f4a9745d460374c9')
snapshot_download('pnnbao-ump/VieNeu-TTS-v3-Turbo', revision='61b85e3d937fbbacb387714180e8182823512523')
snapshot_download('OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX', revision='ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae')
"
```

### 3.9 Offline Exam Corpora & Authoring Inputs

Strictly offline authoring datasets stored outside version control and never packaged into production Docker images:

- `imports/` (`147,914` files, `13.27 GiB`) — upstream vocabulary/media/audio source imports
- `data/exam-bank/` (`17,498` files, `2.10 GiB`) — raw exam package authoring bank
- `content/` (`434` files, `345.49 MiB`) — curated editorial lesson staging sources

### 3.10 Environment Configuration Files

- **Production VPS (`.env.production`):** Copy [`.env.production.example`](../../.env.production.example) to `.env.production` on `<VPS_HOST>` (`chmod 600 .env.production`). Populate Azure PostgreSQL credentials (`DB_URL`, `DB_USER`, `DB_PASSWORD`), independent 32+ char security keys (`AUTH_JWT_SECRET`, `NEXTAUTH_SECRET`, `APP_SECURITY_INTERNAL_SERVICE_KEY`, `APP_SECURITY_MFA_ENCRYPTION_KEY`), real Cloudflare Turnstile keys, `AI_SERVICE_URL=http://<GPU_PRIVATE_MESH_HOST>:8000`, `AI_SERVICE_KEY`, `OPENROUTER_API_KEY`, and SePay live credentials.
- **GPU Host (`ai-gpu.env`):** Store outside the repository (referenced by `EC_AI_ENV_FILE` in [`deploy/ai/docker-compose.gpu.yml`](../../deploy/ai/docker-compose.gpu.yml)) containing `AI_SERVICE_KEY`, `MDD_SERVICE_URL=http://docker-mdd-service-1:8010`, and optional `OPENROUTER_API_KEY`.
- **Local AI Dev (`ai-service/.env`):** Copy [`ai-service/.env.example`](../../ai-service/.env.example) to `ai-service/.env`.

---

## 4. Automated SHA-256 Verification Commands

Verify all pinned external artifacts after provisioning:

**Linux / macOS / Git Bash:**
```bash
sha256sum -c <<'EOF'
2b65bea9577c2a4149caa90940c806f321d1c6cfac503ed8bbd9f93e43a0033a  backend/src/main/resources/lexical/dictionary_en_vi.db
7feb44c632206a60ab94121a822d88b7029a96d6a9ec8cbd4bfcf486047d95c5  ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz
375f872f43b0e2c5fdfb316b0795fd197d9fde901524d833cf873fb460d1f98d  audit_artifacts/models/pron_v2_block3b_canonical_final.pt
de0977c4d4b19c7cdedf6a5b9a7099240655f653481d56e6bcce6c72f2271fb2  audit_artifacts/runtime/pronunciation_v2_2_production/PRON_V2_2_RUNTIME_MANIFEST.json
EOF

(cd frontend/public/vendor/listening-translator && sha256sum -c MANIFEST.sha256)
```

**Windows PowerShell:**
```powershell
$expected = @{
  'backend/src/main/resources/lexical/dictionary_en_vi.db' = '2b65bea9577c2a4149caa90940c806f321d1c6cfac503ed8bbd9f93e43a0033a'
  'ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz' = '7feb44c632206a60ab94121a822d88b7029a96d6a9ec8cbd4bfcf486047d95c5'
  'audit_artifacts/models/pron_v2_block3b_canonical_final.pt' = '375f872f43b0e2c5fdfb316b0795fd197d9fde901524d833cf873fb460d1f98d'
  'audit_artifacts/runtime/pronunciation_v2_2_production/PRON_V2_2_RUNTIME_MANIFEST.json' = 'de0977c4d4b19c7cdedf6a5b9a7099240655f653481d56e6bcce6c72f2271fb2'
}
foreach ($kv in $expected.GetEnumerator()) {
  $actual = (Get-FileHash -LiteralPath $kv.Key -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $kv.Value) { throw "SHA-256 mismatch for $($kv.Key): got $actual" }
  Write-Host "[OK] $($kv.Key)" -ForegroundColor Green
}
```

---

## 5. Third-Party Licensing & Commercial Compliance Notices

| Component / Artifact | License | Compliance Requirement & Operational Notes |
|---|---|---|
| **`pymupdf==1.28.2`** (`ai-service/requirements.gpu-echo.lock.txt`) | **Dual-Licensed: AGPL-3.0 OR Artifex Commercial License** | **Notice:** Network-facing commercial deployments using `pymupdf` must hold an Artifex commercial license, satisfy AGPL-3.0 Corresponding Source disclosure obligations, or migrate server-side PDF extraction to a permissively licensed parser (`pypdf` / `pdfminer.six`). |
| **`org.languagetool:language-en:6.4`** (`backend/pom.xml`) | **LGPL-2.1-or-later** | Used as an unmodified Maven library dependency. Retain LGPL-2.1 copyright/license notices and preserve relinking compliance in distribution artifacts. (Similarly, `num2words==0.5.14` and `soxr==1.1.0` in `ai-service` are unmodified LGPL-2.1 Python packages.) |
| **`dictionary_en_vi.db` & Curated SYSTEM Vocab Decks** | **CC BY-SA 4.0** | Read-only SQLite lexical provider (`LocalEnViLexicalProvider`); derived SYSTEM topic and TOEIC/IELTS vocabulary deck JSONs remain under **CC BY-SA 4.0** with full upstream provenance in [`docs/ATTRIBUTION.md`](../ATTRIBUTION.md). |
| **GPU Speech & Local LLM Stack (`jarvis-tts-v2` + `echo-local-llm-v3`)** | **Apache-2.0 / MIT / BSD-2-Clause** | **Zero in-process GPLv3+ speech libraries:** `espeakng-loader`, `phonemizer`, `phonemizer-fork`, and `libespeak-ng` are excluded from the live GPU container (`ai-service/requirements.gpu-echo.lock.txt`). `nvidia-cublas-cu12` is governed by the NVIDIA CUDA Toolkit EULA. |
| **`docker-mdd-service:latest`** (`sha256:d2baa054...`) | **Internal Binary Image** | Upstream source missing from repo; preserve off-host `docker save` archive and verify underlying model weights (`crottc-if-l2-arctic`, `mdd-llm-llama3.2-1b`) license terms (Llama 3.2 Community License) before any third-party redistribution. |
