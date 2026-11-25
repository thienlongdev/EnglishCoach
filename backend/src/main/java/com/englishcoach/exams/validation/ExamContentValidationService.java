package com.englishcoach.exams.validation;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.service.ExamEvidenceContentGate;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * Authoritative exam content validation gate (Exams Recovery Phase 2) — the only source of truth for
 * runnability, full-simulation readiness and the content condition of official evidence.
 *
 * <p>Lifecycle: on a cache miss the canonical tree is loaded, its deterministic fingerprint computed and the pure
 * {@link ExamFormValidator} run; the result is cached for {@link #CACHE_TTL} and recorded once per
 * (form, validator version, fingerprint) in {@code exams.form_content_validations} (separate transaction,
 * best effort — never blocks the caller). Any content/binding/media-state change yields a new fingerprint and
 * therefore a new validation. Explicit triggers ({@link #revalidate}: import, publication, admin) bypass the
 * cache. Errors are never cached and yield an UNKNOWN report, which grants nothing (fail closed).
 */
@Slf4j
@Service
public class ExamContentValidationService implements ExamEvidenceContentGate {

    public static final String UNDER_REVIEW_CODE = "FORM_CONTENT_UNDER_REVIEW";
    public static final String UNDER_REVIEW_MESSAGE_VI =
            "Đề này đang được kiểm tra lại nội dung và tạm thời chưa thể làm ở chế độ thi mô phỏng.";

    static final Duration CACHE_TTL = Duration.ofMinutes(5);

    public enum Trigger { LEARNER_READ, IMPORT, PUBLICATION, ADMIN }

    static final int CACHE_MAX_ENTRIES = 512;
    static final long CACHE_MAX_BYTES = 16 * 1024 * 1024;
    private record CacheEntry(ExamFormValidationReport report,
            List<com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness> scopes,
            Instant expiresAt, long bytes) {}

    private final ExamContentValidationRepository repository;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate persistTx;
    private final Clock clock;
    private final Map<UUID, CacheEntry> cache = new LinkedHashMap<>(16, 0.75f, true);
    private final Map<UUID, ExamCatalogStructuralSummary> catalogCache = new LinkedHashMap<>(16, 0.75f, true);
    private final Map<UUID, Instant> catalogVerifiedUntil = new HashMap<>();

    @Autowired
    public ExamContentValidationService(ExamContentValidationRepository repository, ObjectMapper objectMapper,
                                        ObjectProvider<PlatformTransactionManager> transactionManager) {
        this(repository, objectMapper, newPersistTx(transactionManager.getIfAvailable()), Clock.systemUTC());
    }

    ExamContentValidationService(ExamContentValidationRepository repository, ObjectMapper objectMapper,
                                 TransactionTemplate persistTx, Clock clock) {
        this.repository = repository;
        this.objectMapper = objectMapper;
        this.persistTx = persistTx;
        this.clock = clock;
    }

    /** Cached evaluation used by catalog, attempt creation and evidence. Never throws; never null. */
    public synchronized ExamFormValidationReport evaluate(UUID formId) {
        if (formId == null) return ExamFormValidationReport.unknown(null, "FORM_ID_REQUIRED", clock.instant());
        Instant now = clock.instant();
        CacheEntry hit = cache.get(formId);
        if (hit != null && hit.expiresAt().isAfter(now)) {
            return hit.report();
        }
        return compute(formId, Trigger.LEARNER_READ);
    }

    /** Exact cached structural scope summary with live form-facts restrictions. */
    public synchronized List<com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness> practiceScopes(
            UUID formId, com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts facts) {
        ExamFormValidationReport report = evaluate(formId);
        CacheEntry entry = cache.get(formId);
        if (entry == null || !entry.report().equals(report)) return List.of();
        if (facts != null && facts.attemptableLifecycle() && facts.rightsVerified()) return entry.scopes();
        return entry.scopes().stream().map(scope -> {
            // Ambiguous scopes skip the form-facts checks in the canonical evaluator.
            if (scope.reasonCodes().contains("SCOPE_AMBIGUOUS")) return scope;
            Set<String> reasons = new TreeSet<>(scope.reasonCodes());
            if (facts == null || !facts.attemptableLifecycle()) reasons.add("FORM_NOT_ATTEMPTABLE");
            if (facts == null || !facts.rightsVerified()) reasons.add("RIGHTS_OR_PROVENANCE_UNVERIFIED");
            return new com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness(scope.scope(), false,
                    List.copyOf(reasons), com.englishcoach.exams.practice.ExamPracticeReadiness.LearnerState.UNAVAILABLE,
                    scope.audioAssets(), scope.imageAssets());
        }).toList();
    }

    /** Explicit recomputation (import, publication, admin): bypasses and refreshes the cache. */
    public synchronized ExamFormValidationReport revalidate(UUID formId, Trigger trigger) {
        if (formId == null) return ExamFormValidationReport.unknown(null, "FORM_ID_REQUIRED", clock.instant());
        cache.remove(formId);
        catalogCache.remove(formId);
        catalogVerifiedUntil.remove(formId);
        return compute(formId, trigger == null ? Trigger.ADMIN : trigger);
    }

    public synchronized void invalidate(UUID formId) {
        if (formId != null) { cache.remove(formId); catalogCache.remove(formId); catalogVerifiedUntil.remove(formId); }
    }

    public synchronized void invalidateAll() {
        cache.clear();
        catalogCache.clear();
        catalogVerifiedUntil.clear();
    }

    /** Proficiency / profile evidence port: the skill is simulation-grade in the authoritative validation. */
    @Override
    public boolean isSkillContentValid(UUID formId, SkillType skill) {
        return formId != null && evaluate(formId).isOfficialEvidenceEligible(skill);
    }

    /** Structural validation of an import package with the same rules (no persistence, no cache). */
    public ExamFormValidationReport validatePackage(ExamContentPackage pkg) {
        try {
            return ExamFormValidator.validate(ExamContentTree.fromPackage(pkg, objectMapper), objectMapper, clock.instant());
        } catch (RuntimeException ex) {
            return ExamFormValidationReport.unknown(pkg == null || pkg.form() == null ? null : pkg.form().id(),
                    "PACKAGE_TREE_FAILED", clock.instant());
        }
    }

    /** Persisted history (newest first) for admin diagnostics. */
    public List<Map<String, Object>> history(UUID formId, int limit) {
        try {
            return repository.findValidationHistory(formId, limit);
        } catch (RuntimeException ex) {
            log.warn("[ExamsValidation] history unavailable for form {}: {}", formId, ex.getMessage());
            return List.of();
        }
    }

    private ExamFormValidationReport compute(UUID formId, Trigger trigger) {
        Instant now = clock.instant();
        ExamFormValidationReport report;
        ExamContentTree loaded;
        String beforeRevision;
        try {
            var before = repository.catalogInputs(List.of(formId)).get(formId);
            beforeRevision = before == null ? null : before.revision();
            Optional<ExamContentTree> tree = repository.loadTree(formId);
            if (tree.isEmpty()) {
                return ExamFormValidationReport.unknown(formId, "FORM_NOT_FOUND", now);
            }
            loaded = tree.get();
            report = ExamFormValidator.validate(loaded, objectMapper, now);
        } catch (RuntimeException ex) {
            log.warn("[ExamsValidation] validation failed for form {} — failing closed: {}", formId, ex.getMessage());
            return ExamFormValidationReport.unknown(formId, "VALIDATION_ERROR", now);
        }
        remember(formId, report, loaded, now);
        try { rememberCatalog(formId, beforeRevision, repository.catalogInputs(List.of(formId)).get(formId)); }
        catch (RuntimeException ex) {
            catalogCache.remove(formId);
            catalogVerifiedUntil.remove(formId);
        } // full validation remains valid; no reusable summary
        persistQuietly(report, trigger);
        if (report.contentReviewRequired()) {
            log.debug("[ExamsValidation] form {} status {} codes {}", formId, report.status(), report.blockingCodes());
        }
        return report;
    }

    /** Coalesces concurrent misses under the same monitor used by invalidation. Trees live only within this batch. */
    public synchronized void warm(Collection<UUID> formIds) {
        Instant now = clock.instant();
        cache.entrySet().removeIf(e -> !e.getValue().expiresAt().isAfter(now));
        List<UUID> missing = formIds.stream().distinct().filter(id -> !cache.containsKey(id)).toList();
        for (int start = 0; start < missing.size(); start += 32) {
            List<UUID> batch = missing.subList(start, Math.min(start + 32, missing.size()));
            try {
                long began = System.nanoTime();
                var before = repository.catalogInputs(batch);
                long beforeAt = System.nanoTime();
                var trees = repository.loadTrees(batch);
                long loadedAt = System.nanoTime();
                long fingerprintNs = 0, validationNs = 0, scopesNs = 0;
                List<ExamFormValidationReport> reports = new ArrayList<>();
                for (var entry : trees.entrySet()) {
                    long phase = System.nanoTime();
                    String fingerprint = entry.getValue().fingerprint();
                    fingerprintNs += System.nanoTime() - phase;
                    phase = System.nanoTime();
                    var report = ExamFormValidator.validate(entry.getValue(), objectMapper, now, fingerprint);
                    validationNs += System.nanoTime() - phase;
                    phase = System.nanoTime();
                    remember(entry.getKey(), report, entry.getValue(), now);
                    scopesNs += System.nanoTime() - phase;
                    reports.add(report);
                }
                long evaluatedAt = System.nanoTime();
                var after = repository.catalogInputs(batch);
                for (UUID id : batch) rememberCatalog(id, before.containsKey(id) ? before.get(id).revision() : null, after.get(id));
                long verifiedAt = System.nanoTime();
                if (persistTx != null && !reports.isEmpty()) {
                    try { persistTx.executeWithoutResult(status -> repository.insertValidations(reports, Trigger.LEARNER_READ.name(), catalogCache)); }
                    catch (RuntimeException ex) { log.warn("[ExamsValidation] batch audit persistence unavailable"); }
                }
                log.info("[ExamsCatalogBuild] forms={} revisionBeforeMs={} treeMs={} fingerprintMs={} validationMs={} scopeAndSizeMs={} revisionAfterMs={} auditMs={}",
                        batch.size(), millis(beforeAt-began), millis(loadedAt-beforeAt), millis(fingerprintNs),
                        millis(validationNs), millis(scopesNs), millis(verifiedAt-evaluatedAt), millis(System.nanoTime()-verifiedAt));
            } catch (RuntimeException ex) {
                log.warn("[ExamsValidation] catalog batch unavailable; individual evaluation remains fail closed");
            }
        }
    }

    /** Live input digests validate compact summaries across TTLs/restarts. Rights are intentionally absent. */
    public synchronized Map<UUID, ExamCatalogStructuralSummary> catalogSummaries(Collection<UUID> ids) {
        Instant now = clock.instant();
        cache.entrySet().removeIf(e -> !e.getValue().expiresAt().isAfter(now));
        Map<UUID, ExamCatalogStructuralSummary> out = new LinkedHashMap<>();
        List<UUID> verify = new ArrayList<>();
        for (UUID id : ids) {
            var hit = catalogCache.get(id);
            if (hit != null && catalogVerifiedUntil.getOrDefault(id, Instant.MIN).isAfter(now)) out.put(id, hit);
            else verify.add(id);
        }
        if (verify.isEmpty()) return Map.copyOf(out);
        long began = System.nanoTime();
        var inputs = repository.catalogInputs(verify);
        long verifiedAt = System.nanoTime();
        List<UUID> missing = new ArrayList<>();
        for (UUID id : verify) {
            var input = inputs.get(id);
            var hit = catalogCache.get(id);
            if (input == null) { catalogCache.remove(id); catalogVerifiedUntil.remove(id); continue; }
            if (hit != null && hit.matches(id, input.revision())) continue;
            catalogCache.remove(id);
            catalogVerifiedUntil.remove(id);
            cache.remove(id); // changed inputs also invalidate the diagnostic cache immediately
            if (input.persisted() != null) putCatalog(id, input.persisted());
            else missing.add(id);
        }
        warm(missing);
        for (UUID id : verify) {
            var input = inputs.get(id);
            var summary = catalogCache.get(id);
            if (input != null && summary != null && summary.matches(id, input.revision())) {
                catalogVerifiedUntil.put(id, now.plus(CACHE_TTL));
                out.put(id, summary);
            }
        }
        log.info("[ExamsCatalogVerify] forms={} digestAndPersistedReadMs={} rebuildMs={} misses={} compactEntries={} compactEstimatedBytes={} diagnosticEstimatedBytes={}",
                verify.size(), millis(verifiedAt-began), millis(System.nanoTime()-verifiedAt), missing.size(),
                catalogCache.size(), catalogBytes(), cacheBytes());
        return Map.copyOf(out);
    }

    private static long millis(long nanos) { return nanos / 1_000_000; }

    private void rememberCatalog(UUID id, String before, ExamContentValidationRepository.CatalogInput after) {
        var entry = cache.get(id);
        if (entry == null || before == null || after == null || !before.equals(after.revision())) {
            catalogCache.remove(id);
            catalogVerifiedUntil.remove(id);
            return; // concurrent content mutation cannot label old readiness with a new revision
        }
        putCatalog(id, ExamCatalogStructuralSummary.from(before, entry.report(), entry.scopes()));
    }

    private void putCatalog(UUID id, ExamCatalogStructuralSummary summary) {
        if (catalogEstimate(summary) > 64 * 1024) return;
        catalogCache.put(id, summary);
        catalogVerifiedUntil.put(id, clock.instant().plus(CACHE_TTL));
        // At most 512 compact values. Each value contains only skill/mode/scope strings and fixed identities.
        while (catalogCache.size() > CACHE_MAX_ENTRIES || catalogBytes() > 2 * 1024 * 1024) {
            UUID oldest = catalogCache.keySet().iterator().next();
            catalogCache.remove(oldest);
            catalogVerifiedUntil.remove(oldest);
        }
    }

    synchronized int catalogEntries() { return catalogCache.size(); }
    synchronized long catalogBytes() { return catalogCache.values().stream().mapToLong(ExamContentValidationService::catalogEstimate).sum(); }
    private static long catalogEstimate(ExamCatalogStructuralSummary s) {
        return 1024L + java.util.stream.Stream.of(s.practiceSkills(), s.simulationSkills(), s.availableModes(), s.practiceScopeCodes())
                .flatMap(Collection::stream).mapToLong(v -> 64L + 2L * v.length()).sum();
    }

    private void remember(UUID id, ExamFormValidationReport report, ExamContentTree tree, Instant now) {
        if (report.status() == ExamContentValidationStatus.UNKNOWN) return;
        List<com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness> scopes;
        long bytes;
        try {
            scopes = com.englishcoach.exams.practice.ExamPracticeReadiness.evaluate(tree, report,
                    com.englishcoach.exams.release.ExamRunnerCapabilities.CURRENT,
                    new com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts(true, true), objectMapper);
            bytes = estimateEntryBytes(report, scopes);
        } catch (Exception ex) { return; }
        if (bytes > CACHE_MAX_BYTES) return;
        cache.put(id, new CacheEntry(report, List.copyOf(scopes), now.plus(CACHE_TTL), bytes));
        long total = cache.values().stream().mapToLong(CacheEntry::bytes).sum();
        var iterator = cache.entrySet().iterator();
        while (cache.size() > CACHE_MAX_ENTRIES || total > CACHE_MAX_BYTES) {
            var oldest = iterator.next();
            total -= oldest.getValue().bytes();
            iterator.remove();
        }
    }

    synchronized int cacheEntries() { return cache.size(); }
    synchronized long cacheBytes() { return cache.values().stream().mapToLong(CacheEntry::bytes).sum(); }

    private static long estimateEntryBytes(ExamFormValidationReport report,
                                           List<com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness> scopes) {
        long est = 1024L + report.formDiagnostics().size() * 256L;
        for (var sec : report.sections()) {
            est += 256L + sec.diagnostics().size() * 256L;
        }
        for (var sc : scopes) {
            est += 384L + sc.reasonCodes().size() * 64L;
        }
        return est;
    }

    private void persistQuietly(ExamFormValidationReport report, Trigger trigger) {
        if (persistTx == null) return;
        try {
            persistTx.executeWithoutResult(status -> repository.insertValidation(report, trigger.name(), catalogCache.get(report.formId())));
        } catch (RuntimeException ex) {
            // The in-memory result stays authoritative for this request; persistence is an audit record.
            log.warn("[ExamsValidation] could not persist validation of form {}: {}", report.formId(), ex.getMessage());
        }
    }

    private static TransactionTemplate newPersistTx(PlatformTransactionManager tm) {
        if (tm == null) return null;
        TransactionTemplate tx = new TransactionTemplate(tm);
        tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        tx.setReadOnly(false);
        return tx;
    }
}
