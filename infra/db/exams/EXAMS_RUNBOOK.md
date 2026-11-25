# English Coach Exams — Operational Runbook

## 1. Architecture Overview
The Exams module is an isolated assessment engine operating within the existing English Coach application ecosystem:
- **Database Schema**: Dedicated `exams` PostgreSQL schema alongside existing `public` tables. Managed via explicit migrations `V1__content.sql`, `V2__runtime.sql`, `V3__scoring_profile.sql`, `V4__integrity_operations.sql`.
- **Backend Service**: Spring Boot (`com.englishcoach.exams`), featuring deterministic objective scorers and a scheduled durable worker with `FOR UPDATE SKIP LOCKED`.
- **AI Evaluation**: FastAPI (`ai-service`) with 4 independent rubrics/judges: IELTS Writing, IELTS Speaking, TOEIC Writing, TOEIC Speaking.
- **Frontend Architecture**: Next.js App Router under `/exams` with quiet `ApplicationFrame` removing distractions during active attempts.

---

## 2. Database Migrations & Integrity
- All assessment tables reside strictly inside the `exams` schema.
- **Data Safety Rule**: The `public` schema and legacy tables `public.exams` and `public.exam_results` are completely preserved and never dropped or altered automatically.
- Database triggers enforce cross-row integrity:
  - Prevention of universal English scores or IELTS + TOEIC score merging.
  - Absence of four-skill Overall scores for TOEIC.
  - Frozen answers upon submission.
  - Immutable scoring artifacts and rescore histories.

---

## 3. Storage Configuration & Private Audio
- Private object storage is abstracted via `ExamObjectStorage` with `S3ExamObjectStorage` (production) and `LocalExamObjectStorage` (local dev).
- Chunk uploads are verified with client-computed SHA-256 digests and sealed before submission.
- Storage buckets must remain private. Media access requires signed, time-limited playback grants.

---

## 4. Operational Maintenance & Workers
- **Worker Execution**: Background worker periodically polls `exams.jobs` for pending scoring stages using atomic leases.
- **Heartbeat & Leases**: Each worker claims a leased token valid for 5 minutes. If a worker crashes, the lease expires and the job becomes available for retry.
- **Review Adjudication**: Cases flagged as `REVIEW_REQUIRED` appear in the internal admin console `/admin/exams` for human reviewer decision.

---

## 5. Rollback & Disaster Recovery
- If an emergency rollback is required:
  1. Set `app.exams.enabled: false` in `application.yml` or environment variables to immediately disable new attempt creation.
  2. Active attempts and historical score records remain safely persisted and accessible in read-only mode.
  3. Never run destructive drop commands against the database.
