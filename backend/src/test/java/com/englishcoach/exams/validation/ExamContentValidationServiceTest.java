package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.SkillType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static com.englishcoach.exams.validation.ExamContentFixtures.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/** Exams Phase 2: cache, fingerprint revalidation, persistence and fail-closed behaviour of the validation gate. */
class ExamContentValidationServiceTest {

    private ExamContentValidationRepository repo;
    private AtomicReference<Instant> now;
    private ExamContentValidationService service;
    private final UUID formId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        repo = mock(ExamContentValidationRepository.class);
        now = new AtomicReference<>(Instant.parse("2026-10-03T00:00:00Z"));
        Clock clock = new Clock() {
            @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(java.time.ZoneId zone) { return this; }
            @Override public Instant instant() { return now.get(); }
        };
        service = new ExamContentValidationService(repo, MAPPER, new TransactionTemplate(mock(PlatformTransactionManager.class)), clock);
    }

    @Test
    @DisplayName("Cached for the TTL; recomputed afterwards; persisted once per fingerprint")
    void cacheAndPersist() {
        ExamContentTree tree = toeicLr(null);
        when(repo.loadTree(formId)).thenReturn(Optional.of(tree));
        assertTrue(service.evaluate(formId).fullSimulationEligible());
        service.evaluate(formId);
        verify(repo, times(1)).loadTree(formId);
        verify(repo, times(1)).insertValidation(any(), eq("LEARNER_READ"), isNull());

        now.set(now.get().plus(ExamContentValidationService.CACHE_TTL).plus(Duration.ofSeconds(1)));
        service.evaluate(formId);
        verify(repo, times(2)).loadTree(formId);
    }

    @Test
    @DisplayName("17. Content change ⇒ new fingerprint ⇒ stale validation is replaced on revalidation")
    void contentChangeInvalidates() {
        ExamContentTree good = toeicLr(null);
        ExamContentTree broken = toeicLr(k -> k.listeningAudio = false);
        when(repo.loadTree(formId)).thenReturn(Optional.of(good), Optional.of(broken));

        ExamFormValidationReport first = service.evaluate(formId);
        assertTrue(first.fullSimulationEligible());
        ExamFormValidationReport second = service.revalidate(formId, ExamContentValidationService.Trigger.ADMIN);
        assertNotEquals(first.contentFingerprint(), second.contentFingerprint());
        assertFalse(second.fullSimulationEligible());
        assertSame(second, service.evaluate(formId), "the refreshed result is what the cache now serves");
        verify(repo).insertValidation(argThatFingerprint(second.contentFingerprint()), eq("ADMIN"), isNull());

        service.invalidate(formId);
        when(repo.loadTree(formId)).thenReturn(Optional.of(good));
        assertTrue(service.evaluate(formId).fullSimulationEligible(), "invalidate() forces a fresh evaluation");
    }

    private static ExamFormValidationReport argThatFingerprint(String fingerprint) {
        return org.mockito.ArgumentMatchers.argThat(r -> r != null && fingerprint.equals(r.contentFingerprint()));
    }

    @Test
    @DisplayName("11. Load failure ⇒ UNKNOWN (fail closed), never cached, recovers on the next call")
    void failureFailsClosed() {
        when(repo.loadTree(formId)).thenThrow(new IllegalStateException("db down")).thenThrow(new IllegalStateException("db down"))
                .thenReturn(Optional.of(toeicLr(null)));
        ExamFormValidationReport r = service.evaluate(formId);
        assertEquals(ExamContentValidationStatus.UNKNOWN, r.status());
        assertFalse(r.fullSimulationEligible());
        assertFalse(service.isSkillContentValid(formId, SkillType.READING), "unknown ⇒ no official evidence");
        assertTrue(service.evaluate(formId).fullSimulationEligible(), "failure was not cached");
        verify(repo, never()).insertValidation(argThatStatus(ExamContentValidationStatus.UNKNOWN), any(), any());
    }

    private static ExamFormValidationReport argThatStatus(ExamContentValidationStatus status) {
        return org.mockito.ArgumentMatchers.argThat(r -> r != null && r.status() == status);
    }

    @Test
    @DisplayName("Missing form / null id ⇒ UNKNOWN; evidence gate false")
    void missingForm() {
        when(repo.loadTree(formId)).thenReturn(Optional.empty());
        assertEquals(ExamContentValidationStatus.UNKNOWN, service.evaluate(formId).status());
        assertFalse(service.isSkillContentValid(formId, SkillType.LISTENING));
        assertFalse(service.isSkillContentValid(null, SkillType.LISTENING));
        assertEquals(ExamContentValidationStatus.UNKNOWN, service.evaluate(null).status());
    }

    @Test
    @DisplayName("Persistence failure never breaks or downgrades the in-memory authoritative result")
    void persistenceFailureIsQuiet() {
        when(repo.loadTree(formId)).thenReturn(Optional.of(toeicLr(null)));
        when(repo.insertValidation(any(), any(), any())).thenThrow(new IllegalStateException("read-only"));
        assertTrue(service.evaluate(formId).fullSimulationEligible());
    }

    @Test
    @DisplayName("Evidence gate: only simulation-grade skills are official-evidence eligible")
    void evidenceGate() {
        when(repo.loadTree(formId)).thenReturn(Optional.of(toeicLr(k -> k.part4Audio = false)));
        assertFalse(service.isSkillContentValid(formId, SkillType.LISTENING), "practice-only Listening is not evidence");
        assertTrue(service.isSkillContentValid(formId, SkillType.READING));
    }

    @Test
    void compactCacheEvictsReplacesAndClearsWithoutRetainingTrees() {
        var report = ExamFormValidator.validate(toeicLr(null), MAPPER, now.get());
        var base = ExamCatalogStructuralSummary.from("a".repeat(64), report, java.util.List.of());
        when(repo.catalogInputs(any())).thenAnswer(call -> {
            java.util.Collection<UUID> ids = call.getArgument(0);
            var inputs = new java.util.LinkedHashMap<UUID, ExamContentValidationRepository.CatalogInput>();
            for (UUID id : ids) {
                var summary = new ExamCatalogStructuralSummary(id, base.inputRevision(), base.contentFingerprint(),
                        base.validatorVersion(), base.readinessVersion(), base.practiceSkills(), base.simulationSkills(),
                        base.fullSimulationEligible(), base.contentReviewRequired(), base.availableModes(),
                        base.validationStatus(), base.practiceScopeCodes());
                inputs.put(id, new ExamContentValidationRepository.CatalogInput(summary.inputRevision(), summary));
            }
            return inputs;
        });
        var ids = java.util.stream.IntStream.range(0, 600).mapToObj(i -> UUID.randomUUID()).toList();
        for (int start = 0; start < 600; start += 100)
            assertEquals(100, service.catalogSummaries(ids.subList(start, start + 100)).size());
        assertEquals(512, service.catalogEntries());
        assertTrue(service.catalogBytes() <= 2 * 1024 * 1024);
        verify(repo, never()).loadTrees(any());
        verify(repo, never()).insertValidations(any(), any(), any());
        clearInvocations(repo);
        service.catalogSummaries(java.util.List.of(ids.getFirst())); // evicted LRU value is fetched again
        verify(repo).catalogInputs(java.util.List.of(ids.getFirst()));
        assertEquals(512, service.catalogEntries());
        service.invalidate(ids.getFirst());
        assertEquals(511, service.catalogEntries());
        service.catalogSummaries(java.util.List.of(ids.getFirst()));
        assertEquals(512, service.catalogEntries());
        service.invalidateAll();
        assertEquals(0, service.catalogEntries());
        assertEquals(0, service.catalogBytes());
        assertEquals(0, service.cacheEntries());
    }
}
