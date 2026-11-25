# GPU AI Service Deployment (`englishcoach-ai-whisperx`)

This directory contains the Docker build definitions, Compose specification, and health verification script for the private GPU AI service (`englishcoach-ai-whisperx`, port `8000`) and its sibling pronunciation container (`docker-mdd-service-1`, port `8010`).

## Health Verification

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/ai/verify-ai-service.ps1
```

Always run `verify-ai-service.ps1` after a host reboot, Docker Desktop restart, or image update. `GET /api/v1/listening/capabilities` verifies that `faster-whisper-large-v3` and WhisperX alignment are loaded in GPU memory (`ready: true`), and `GET /api/v1/health` + `:8010/health` confirm both services are online.

## Runtime Configuration & Authentication

- **Environment File:** Set `EC_AI_ENV_FILE` to your local secrets file outside the repository (see [`docs/operations/external-resources.md`](../../docs/operations/external-resources.md)).
- **Service Auth:** Protected routes require `X-EC-Service-Key` matching `AI_SERVICE_KEY` (fail-closed `503` when unset). Only `GET /api/v1/health` and `GET /api/v1/listening/capabilities` are open probes.
- **Commercial-Clean Speech & Local LLM Stack:** See `ai-service/requirements.gpu-echo.lock.txt` and `deploy/ai/Dockerfile.gpu-echo` (`Kokoro-82M` EN CUDA TTS, `VieNeu-TTS-v3-Turbo` VI CPU ONNX INT8 TTS, `faster-whisper-large-v3-turbo` ASR, `Qwen3-4B-Instruct` CPU GGUF Tier-3 LLM failover).
- **Start / Rollback (No Build):**
  ```bash
  docker compose -f deploy/ai/docker-compose.gpu.yml up -d --no-build
  ```
- **Model & Mount Provisioning:** Required host directories (`audit_artifacts/`, `real_mic_acceptance_pack/`, `english-coach-models/`, and the HuggingFace Hub cache) are documented in [`docs/operations/external-resources.md`](../../docs/operations/external-resources.md).
