# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in **English Coach** (`https://englishcoach.io.vn` or this repository), please report it responsibly rather than disclosing it publicly in an issue or pull request.

- **Preferred Channel:** Open a private [GitHub Security Advisory](https://github.com/thienlongdev/EnglishCoach/security/advisories/new) on this repository.
- **What to Include:** Affected endpoint/component, clear reproduction steps, potential impact, and any suggested mitigation.
- **Response Expectations:** Reports are triaged on a best-effort basis with acknowledgment targeted within 72 hours. Do not run destructive tests, automated credential stuffing, payment abuse, or denial-of-service probes against the live production deployment.

---

## Security Architecture Summary

English Coach implements defense-in-depth across edge, application, AI, and client layers:

- **Authentication & Session Isolation:** HttpOnly cookies managed via Next.js BFF route handlers (`InternalServiceAuthFilter` HMAC-signed container-internal calls); raw auth token-issuing routes are blocked (`404`) at the public Nginx edge; CSRF protection (`ec.csrf`) and single-flight refresh.
- **Administrative Access Control:** Single official administrator identity with mandatory WebAuthn/TOTP step-up MFA (`403 STEP_UP_REQUIRED`) and encrypted MFA seed storage separated from JWT signing keys.
- **Browser Extension Scoping:** Echo Anywhere Chrome MV3 extension uses PKCE pairing and is restricted by `EchoAnywhereScopeFilter` to an explicit endpoint allowlist.
- **Edge & Client Hardening:** Per-request cryptographic CSP nonces (`src/proxy.ts`), zero `'wasm-unsafe-eval'` on main HTML routes, narrow-CSP isolated Web Workers (`/vendor/study-physics/`, `/vendor/listening-translator/`), exact semver dependency pinning (`npm run test:security`), and Cloudflare Turnstile anti-bot checks.
- **AI Tool & Voice Safety:** CaMeL capability predicates across all `23` Echo JARVIS tools, single-use confirmation tokens (`EchoConfirmations`), prompt-injection stripping on untrusted selections, and service-key authentication (`X-EC-Service-Key`) on private AI inference endpoints.
- **Integrity & Anti-Cheat:** Single-use HMAC/SHA-256 `ShadowingAnalysisReceipts` (`V140`), server-authoritative game netcode, Echo Sentinel exam/ranked lockdown, atomic AI quota metering (`V137`), and SePay HMAC-SHA256 webhook verification.

---

## Repository Security Hygiene

- No production credentials, API keys, private keys, or database dumps are stored in this repository.
- Automated secret and hygiene scanning (`scripts/ci/repo_hygiene_check.py`) runs in GitHub Actions CI on every push and pull request.
- Third-party dependency and asset licensing provenance is tracked in [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) and [`docs/operations/external-resources.md`](docs/operations/external-resources.md).
