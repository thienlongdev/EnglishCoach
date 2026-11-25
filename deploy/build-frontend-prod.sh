#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# ENGLISH COACH - CANONICAL PRODUCTION FRONTEND BUILD & VERIFICATION
# ==============================================================================
# Enforces a two-barrier security model for production frontend builds:
# 1. Build-time Docker guard (unconditional failure if Turnstile site key is missing or is a test key)
# 2. Post-build static artifact scan (fails if any test key appears in /app/.next/static)
# 3. Build only; deployment requires an explicit target

SITE_KEY="${SITE_KEY:-}"
DEPLOY="${DEPLOY:-false}"
if [ "$DEPLOY" = "true" ]; then
    echo "Build wrapper is build-only; transfer/load to an explicit target and use canonical Compose recreation." >&2
    exit 1
fi
SITE_KEY="${SITE_KEY:-${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}}"

echo "================================================================================"
echo "ENGLISH COACH - CANONICAL PRODUCTION FRONTEND BUILD & VERIFICATION"
echo "================================================================================"

# Site key comes only from the explicit public-key environment.
if [ -z "$SITE_KEY" ]; then
    echo "FATAL: Production NEXT_PUBLIC_TURNSTILE_SITE_KEY is required but could not be resolved." >&2
    exit 1
fi

# Validate that SITE_KEY is NOT a test key
if echo "$SITE_KEY" | grep -qE '^([123]x0000000000|0000000000)'; then
    echo "FATAL: The provided Turnstile site key is a Cloudflare test key! Production builds require a real site key." >&2
    exit 1
fi

echo "✓ Production Turnstile site key validated (length: ${#SITE_KEY}, format: valid)"

# 2. Build production Docker image using Dockerfile.prod
echo ""
echo "--- STEP 1: Building production Docker image (Dockerfile.prod) ---"
docker build \
    -f frontend/Dockerfile.prod \
    --build-arg NEXT_PUBLIC_API_URL=/api/v1 \
    --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY="$SITE_KEY" \
    -t english-coach-frontend:prod \
    ./frontend

echo "✓ Docker image built successfully: english-coach-frontend:prod"

# 3. Post-Build Artifact Scan (Barrier 2)
echo ""
echo "--- STEP 2: Post-build static artifact scan ---"
SCAN_OUTPUT=$(docker run --rm english-coach-frontend:prod sh -c "
if grep -rnE '[123]x0000000000' /app/.next/static; then
    echo 'FATAL: Test Turnstile key detected in /app/.next/static!' >&2
    exit 1
fi
echo 'SCAN_PASSED'
")

if ! echo "$SCAN_OUTPUT" | grep -q "SCAN_PASSED"; then
    echo "FATAL [Post-Build Gate]: Cloudflare test site key found in built static artifacts! Deployment aborted." >&2
    exit 1
fi

echo "✓ Post-build static artifact scan PASSED: Zero test Turnstile keys in bundle"

echo "Build complete. Package and transfer explicitly; verify image IDs before canonical Compose recreation."
