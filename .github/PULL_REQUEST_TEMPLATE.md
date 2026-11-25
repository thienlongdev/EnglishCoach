## Summary
<!-- Briefly describe what this pull request changes and why. -->

## Type of Change
- [ ] `feat`: New feature
- [ ] `fix`: Bug fix
- [ ] `refactor`: Architectural or code improvement (no behavior change)
- [ ] `perf`: Performance improvement (include before/after measurement)
- [ ] `test`: Test additions or fixes
- [ ] `docs`: Documentation update
- [ ] `build` / `ci` / `chore`: Tooling or maintenance

## Architectural & Hygiene Checklist
- [ ] Preserves Spring Boot feature-sliced layering (no direct `Controller -> Repository` bypasses, no raw JPA `@Entity` responses, no new module cycles).
- [ ] No hardcoded secrets, credentials, private IPs, or `.env` files.
- [ ] No runtime datasets, model weights, dictionary DBs, QA screenshots, or ad-hoc `.cjs` verification scripts added.
- [ ] No internal coding-agent files (`.claude/`, `AGENTS.md`, `CLAUDE.md`, etc.) staged.
- [ ] Database migrations (if any) are strictly additive (`V<next>__*.sql` under `db/migration/exams/`) and backward-compatible.
- [ ] External resource changes (if any) documented in `docs/operations/external-resources.md`.

## Verification Performed
<!-- List the exact commands executed and their real results. Do not claim untested checks as passed. -->
- [ ] `python scripts/ci/repo_hygiene_check.py`
- [ ] Backend: `mvn -B test-compile` + relevant JUnit tests
- [ ] Frontend: `npx tsc --noEmit` + relevant `npm run test:*` suites
- [ ] AI service: relevant `pytest` suites
