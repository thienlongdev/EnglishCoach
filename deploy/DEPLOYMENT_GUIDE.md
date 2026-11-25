# English Coach — Production Deployment Guide

Production build, container topology, verification gates, and rollback procedures are maintained centrally in [`docs/operations/deployment-and-recovery.md`](../docs/operations/deployment-and-recovery.md).

## Canonical Local Build Entrypoints

```powershell
# 1. Backend production image
docker compose --env-file .env.production.example -f docker-compose.prod.yml build backend

# 2. Frontend production image (requires real Turnstile site key; rejects test keys)
.\deploy\build-frontend-prod.ps1 -SiteKey $env:NEXT_PUBLIC_TURNSTILE_SITE_KEY
```

## Security & Operational Rules

- Supply all target hostnames, credentials, and environment secrets at invocation time via environment variables or `.env.production` (mode `600`); never commit production IPs or secrets to Git.
- Always capture and verify pre-deployment production image exports, Compose configurations, and database backups before replacing running containers.
- Provision all external runtime data, models, and media according to [`docs/operations/external-resources.md`](../docs/operations/external-resources.md).
