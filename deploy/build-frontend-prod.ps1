<#
.SYNOPSIS
Canonical authoritative production frontend build and verification script for English Coach.

.DESCRIPTION
Enforces a two-barrier security model for production frontend builds:
1. Build-time Docker guard (unconditional failure if Turnstile site key is missing or is a test key)
2. Post-build static artifact scan (fails if any test key appears in /app/.next/static)
3. Build only; deployment requires explicit-target helpers
#>

param(
    [string]$SiteKey = "",
    [switch]$Deploy = $false,
    [string]$VpsHost = "",
    [string]$VpsUser = "",
    [string]$SshKeyPath = ""
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "ENGLISH COACH - CANONICAL PRODUCTION FRONTEND BUILD & VERIFICATION" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan

# Fail before building or contacting a host when legacy deployment is requested.
if ($Deploy) { throw "Build wrapper is build-only. Use an explicit deployment target and canonical Compose recreation." }
# Build-only use accepts the explicit public key or the process environment; no host default.
if (-not $SiteKey) { $SiteKey = $env:NEXT_PUBLIC_TURNSTILE_SITE_KEY }

if (-not $SiteKey) {
    Write-Error "FATAL: Production NEXT_PUBLIC_TURNSTILE_SITE_KEY is required but could not be resolved."
    exit 1
}

# Validate that SiteKey is NOT a test key
if ($SiteKey -match '^([123]x0000000000|0000000000)' -or $SiteKey.Contains("0000000000")) {
    Write-Error "FATAL: The provided Turnstile site key is a Cloudflare test key! Production builds require a real site key."
    exit 1
}

Write-Host "[OK] Production Turnstile site key validated (length: $($SiteKey.Length), format: valid)" -ForegroundColor Green

# 2. Build production Docker image using Dockerfile.prod
Write-Host "`n--- STEP 1: Building production Docker image (Dockerfile.prod) ---" -ForegroundColor Cyan
$buildArgs = @(
    "build",
    "-f", "frontend/Dockerfile.prod",
    "--build-arg", "NEXT_PUBLIC_API_URL=/api/v1",
    "--build-arg", "NEXT_PUBLIC_TURNSTILE_SITE_KEY=$SiteKey",
    "--build-arg", "NEXT_PUBLIC_TRANSLATION_PARAGRAPH_ENABLED=true",
    "-t", "english-coach-frontend:prod",
    "./frontend"
)
docker @buildArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "FATAL: Docker build failed."
    exit 1
}
Write-Host "[OK] Docker image built successfully: english-coach-frontend:prod" -ForegroundColor Green

# 3. Post-Build Artifact Scan (Barrier 2)
Write-Host "`n--- STEP 2: Post-build static artifact scan ---" -ForegroundColor Cyan
$scanCmd = "if grep -rnE '[123]x0000000000' /app/.next/static; then exit 1; else echo SCAN_PASSED; fi"
$scanOutput = docker run --rm english-coach-frontend:prod sh -c $scanCmd

if ($LASTEXITCODE -ne 0 -or ($scanOutput -notmatch "SCAN_PASSED")) {
    Write-Error "FATAL [Post-Build Gate]: Cloudflare test site key found in built static artifacts! Deployment aborted."
    exit 1
}
Write-Host "[OK] Post-build static artifact scan PASSED: Zero test Turnstile keys in bundle" -ForegroundColor Green

Write-Host "`nBuild complete. Package and transfer explicitly; verify image IDs before canonical Compose recreation." -ForegroundColor Yellow
