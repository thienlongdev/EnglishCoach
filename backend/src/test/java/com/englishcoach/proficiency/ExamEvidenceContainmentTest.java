package com.englishcoach.proficiency;

import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exams Recovery Phase 0 / 4.1D containment at the single exam → Proficiency choke point
 * ({@link EvidenceMapper#fromExamArtifact}), shared by the live listener, nightly reconciliation and backfill:
 * evidence is decided from the basis PINNED to the attempt, never from the form as it is today.
 * Docker-free: the Postgres variant lives in {@code ProficiencyEngineIntegrationTest}.
 */
class ExamEvidenceContainmentTest {

    private ProficiencySourceReadRepository sources;
    private RatingConverter converter;
    private ProficiencyService service;
    private EvidenceMapper mapper;
    private ProficiencyIngestService ingest;

    private final UUID formId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        sources = mock(ProficiencySourceReadRepository.class);
        converter = mock(RatingConverter.class);
        service = mock(ProficiencyService.class);
        ProficiencyProperties props = new ProficiencyProperties();
        mapper = new EvidenceMapper(props, sources, converter);
        ingest = new ProficiencyIngestService(props, mapper, service, sources);
        when(converter.interpolate(anyString(), anyDouble())).thenReturn(Optional.of(600));
        when(service.storeEvidence(anyList())).thenAnswer(inv -> inv.getArgument(0));
    }

    private String basisJson(String lifecycle, String mode, Set<SkillType> eligible) {
        ExamFormValidationReport v = new ExamFormValidationReport(formId, ExamFormValidator.VALIDATOR_VERSION, "fp",
                Instant.now(), null, "FULL", null, ExamContentValidationStatus.VALID, true, eligible, eligible, eligible,
                List.of(), List.of());
        try {
            return new ObjectMapper().writeValueAsString(ExamAttemptEvidenceBasis.pin(v, formId, lifecycle,
                    mode == null ? "EXAM_SIMULATION" : mode, EnumSet.allOf(SkillType.class), "h").toMap());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code currentLifecycle} = the form today; {@code pinnedLifecycle} = the form when the attempt was created. */
    private UUID artifact(String mode, String currentLifecycle, String pinnedLifecycle, String status, String basisJson,
                          ProficiencySourceReadRepository.ExamComponent... comps) {
        UUID id = UUID.randomUUID();
        when(sources.examArtifact(id)).thenReturn(Optional.of(new ProficiencySourceReadRepository.ExamArtifact(
                id, 7L, formId, "IELTS", currentLifecycle, status, 1, Instant.now(), mode,
                basisJson == null ? null : "SNAPSHOTTED", basisJson)));
        when(sources.examComponents(id)).thenReturn(List.of(comps));
        return id;
    }

    private UUID artifact(String mode, String lifecycle, String status, ProficiencySourceReadRepository.ExamComponent... comps) {
        return artifact(mode, lifecycle, lifecycle, status, basisJson(lifecycle, mode, EnumSet.allOf(SkillType.class)), comps);
    }

    private static ProficiencySourceReadRepository.ExamComponent comp(String metric, double score, boolean fallback) {
        return new ProficiencySourceReadRepository.ExamComponent(metric, "IELTS_BAND", score, fallback);
    }

    private ExamScoredEvent event(UUID artifactId, String mode, String status) {
        return new ExamScoredEvent(7L, UUID.randomUUID(), UUID.randomUUID(), artifactId, 1, formId, "IELTS", "ACADEMIC",
                "FULL", mode, status, new HashMap<>(), Instant.now());
    }

    @Test
    @DisplayName("8. PRACTICE completed / retried / duplicate submit ⇒ evidence delta 0 (nothing stored or recomputed)")
    void practiceCreatesNoEvidence() {
        UUID done = artifact("PRACTICE", "PUBLISHED", "COMPLETED", comp("LISTENING", 7.0, false), comp("READING", 7.5, false));
        UUID retry = artifact("PRACTICE", "PILOT", "COMPLETED", comp("LISTENING", 8.0, false));

        assertTrue(mapper.fromExamArtifact(done).isEmpty());
        assertTrue(ingest.ingestExam(event(done, "PRACTICE", "COMPLETED")).isEmpty());
        assertTrue(ingest.ingestExam(event(retry, "PRACTICE", "COMPLETED")).isEmpty());
        assertTrue(ingest.ingestExam(event(retry, "PRACTICE", "COMPLETED")).isEmpty(), "duplicate submit");

        verify(service, never()).storeEvidence(anyList());
        verify(service, never()).recompute(anyLong(), any(), any());
    }

    @Test
    @DisplayName("PRACTICE partial (single skill) and REVIEW_REQUIRED ⇒ 0 evidence")
    void practicePartialCreatesNoEvidence() {
        UUID partial = artifact("PRACTICE", "PUBLISHED", "COMPLETED", comp("READING", 6.0, false));
        UUID review = artifact("PRACTICE", "PUBLISHED", "REVIEW_REQUIRED", comp("WRITING", 6.0, false));
        assertTrue(mapper.fromExamArtifact(partial).isEmpty());
        assertTrue(mapper.fromExamArtifact(review).isEmpty());
    }

    @Test
    @DisplayName("Nightly reconciliation / backfill never turns PRACTICE artifacts into evidence")
    void reconciliationSkipsPractice() {
        UUID a = artifact("PRACTICE", "PUBLISHED", "COMPLETED", comp("LISTENING", 7.0, false));
        ProficiencySourceReadRepository.ExamArtifact row = sources.examArtifact(a).orElseThrow();
        when(sources.completedArtifactsSince(null)).thenReturn(List.of(row));
        assertEquals(0, ingest.reconcileT1(null));
        verify(service, never()).storeEvidence(anyList());
    }

    @Test
    @DisplayName("Unknown / null attempt mode fails closed")
    void unknownModeFailsClosed() {
        UUID a = artifact(null, "PUBLISHED", "COMPLETED", comp("LISTENING", 7.0, false));
        assertTrue(mapper.fromExamArtifact(a).isEmpty());
    }

    @Test
    @DisplayName("Content not eligible in the PINNED basis ⇒ no official evidence for that skill")
    void brokenFormBlocked() {
        UUID a = artifact("EXAM_SIMULATION", "PUBLISHED", "PUBLISHED", "COMPLETED",
                basisJson("PUBLISHED", "EXAM_SIMULATION", EnumSet.of(SkillType.READING)),
                comp("LISTENING", 5.0, false), comp("READING", 7.0, false));
        List<EvidenceRow> rows = mapper.fromExamArtifact(a);
        assertEquals(1, rows.size());
        assertEquals(ProficiencySkill.READING, rows.get(0).skill());
    }

    @Test
    @DisplayName("10. Legacy attempt (no pinned basis) or malformed basis ⇒ fail closed, never current validation")
    void legacyAndMalformedFailClosed() {
        UUID legacy = artifact("EXAM_SIMULATION", "PUBLISHED", "PUBLISHED", "COMPLETED", null, comp("LISTENING", 7.0, false));
        assertTrue(mapper.fromExamArtifact(legacy).isEmpty(), "LEGACY_VALIDATION_UNAVAILABLE");
        UUID malformed = artifact("EXAM_SIMULATION", "PUBLISHED", "PUBLISHED", "COMPLETED", "{not json",
                comp("LISTENING", 7.0, false));
        assertTrue(mapper.fromExamArtifact(malformed).isEmpty(), "SNAPSHOT_BASIS_MISMATCH");
    }

    @Test
    @DisplayName("7/19. Form retired / re-published after the attempt ⇒ tier and eligibility from the PINNED lifecycle")
    void pinnedLifecycleWins() {
        UUID retiredSince = artifact("EXAM_SIMULATION", "RETIRED", "PUBLISHED", "COMPLETED",
                basisJson("PUBLISHED", "EXAM_SIMULATION", EnumSet.allOf(SkillType.class)), comp("LISTENING", 7.0, false));
        List<EvidenceRow> rows = mapper.fromExamArtifact(retiredSince);
        assertEquals(1, rows.size(), "retiring v1 later does not erase the attempt's evidence");
        assertEquals(EvidenceTier.T1, rows.get(0).tier());
        UUID pilotThen = artifact("EXAM_SIMULATION", "PUBLISHED", "PILOT", "COMPLETED",
                basisJson("PILOT", "EXAM_SIMULATION", EnumSet.allOf(SkillType.class)), comp("LISTENING", 7.0, false));
        assertEquals(EvidenceTier.T2, mapper.fromExamArtifact(pilotThen).get(0).tier(),
                "a PILOT-time attempt stays T2 after the form is published");
    }

    @Test
    @DisplayName("9. AI fallback-scored component ⇒ no verified proficiency from it")
    void aiFallbackBlocked() {
        UUID a = artifact("EXAM_SIMULATION", "PUBLISHED", "COMPLETED", comp("WRITING", 6.5, true), comp("SPEAKING", 6.0, true));
        assertTrue(mapper.fromExamArtifact(a).isEmpty());
        verify(service, never()).storeEvidence(anyList());
    }

    @Test
    @DisplayName("Control: valid EXAM_SIMULATION pinned on a PUBLISHED, content-valid form still yields T1 evidence")
    void validSimulationStillCounts() {
        UUID a = artifact("EXAM_SIMULATION", "PUBLISHED", "COMPLETED", comp("LISTENING", 7.0, false), comp("FULL_OVERALL", 7.0, false));
        List<EvidenceRow> rows = mapper.fromExamArtifact(a);
        assertEquals(1, rows.size());
        assertEquals(EvidenceTier.T1, rows.get(0).tier());
        assertEquals(1, ingest.ingestExam(event(a, "EXAM_SIMULATION", "COMPLETED")).size());
    }
}
