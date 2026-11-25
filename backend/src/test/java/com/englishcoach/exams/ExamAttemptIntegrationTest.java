package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.service.ExamTimingService;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * STEP-100: ExamAttemptIntegrationTest
 * Tests attempt lifecycle transitions, ownership enforcement, session takeover, and timing.
 */
@ExtendWith(MockitoExtension.class)
public class ExamAttemptIntegrationTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @Mock
    private ExamRightsService rightsService;

    @Mock
    private ExamManifestService manifestService;

    @Mock
    private ExamTimingService timingService;

    @Mock
    private PremiumEntitlementService entitlementService;

    @Mock
    private PremiumUsageService usageService;

    private ExamAttemptService attemptService;

    @BeforeEach
    void setUp() {
        // Exams Phase 2: unknown validation refuses every start, so these lifecycle tests run on validated content.
        com.englishcoach.exams.validation.ExamContentValidationService validation =
                mock(com.englishcoach.exams.validation.ExamContentValidationService.class);
        lenient().when(validation.evaluate(any())).thenAnswer(inv ->
                com.englishcoach.exams.validation.ExamContentFixtures.validReport(inv.getArgument(0)));
        attemptService = new ExamAttemptService(
                attemptRepository,
                contentRepository,
                rightsService,
                timingService,
                manifestService,
                entitlementService,
                usageService,
                validation
        );
    }

    private AttemptRecord createTestAttempt(UUID attemptId, Long userId, ExamAttemptStatus status) {
        return new AttemptRecord(
                attemptId,
                userId,
                UUID.randomUUID(),
                ExamFamily.IELTS,
                "ACADEMIC",
                "FULL",
                ExamAttemptMode.EXAM_SIMULATION,
                null,
                null,
                status,
                1L,
                1L,
                "token_hash",
                Instant.now().plusSeconds(60),
                "pinned_manifest_hash",
                null,
                Instant.now(),
                Instant.now(),
                Instant.now().plusSeconds(3600),
                null,
                null,
                List.of(),
                Instant.now(),
                Instant.now()
        );
    }

    @Test
    @DisplayName("Attempt Ownership: User cannot access another learner's attempt")
    void testForeignAttemptAccessDenied() {
        UUID attemptId = UUID.randomUUID();
        Long ownerId = 1L;
        Long attackerId = 2L;

        AttemptRecord attempt = createTestAttempt(attemptId, ownerId, ExamAttemptStatus.IN_PROGRESS);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                attemptService.getAttemptState(attackerId, attemptId)
        );
        assertTrue(ex.getMessage().contains("Access denied") || ex.getMessage().contains("access denied"));
    }

    @Test
    @DisplayName("State Transition: Illegal transition from SUBMITTED to READY throws exception")
    void testIllegalStateTransitionThrows() {
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        AttemptRecord attempt = createTestAttempt(attemptId, userId, ExamAttemptStatus.SUBMITTED);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                attemptService.markReady(userId, attemptId)
        );
        assertTrue(ex.getMessage().contains("cannot transition to READY"));
    }

    @Test
    @DisplayName("Session Takeover: Takeover increments writer epoch and revokes old writer")
    void testSessionTakeoverIncrementsEpoch() {
        UUID attemptId = UUID.randomUUID();
        Long userId = 1L;

        AttemptRecord attempt = createTestAttempt(attemptId, userId, ExamAttemptStatus.IN_PROGRESS);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of());
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of());

        AttemptStateDto state = attemptService.takeoverSession(userId, attemptId);
        assertNotNull(state);
        verify(attemptRepository).updateWriterSession(eq(attemptId), eq(2L), any(), any(), eq(1L));
    }

    private FormVersionRecord createPublishedForm(UUID formId) {
        return new FormVersionRecord(
                formId,
                "IELTS-AC-2026",
                1,
                "IELTS Academic Full Test",
                ExamFamily.IELTS,
                "ACADEMIC",
                "FULL",
                UUID.randomUUID(),
                UUID.randomUUID(),
                UUID.randomUUID(),
                LifecycleState.PUBLISHED,
                UUID.randomUUID(),
                10L,
                "form_hash",
                Instant.now(),
                null,
                Instant.now()
        );
    }

    private List<SectionRecord> create4Sections(UUID formId) {
        return List.of(
                new SectionRecord(UUID.randomUUID(), formId, SkillType.LISTENING, 1, "SEC-L", UUID.randomUUID(), 1800, Map.of()),
                new SectionRecord(UUID.randomUUID(), formId, SkillType.READING, 2, "SEC-R", UUID.randomUUID(), 3600, Map.of()),
                new SectionRecord(UUID.randomUUID(), formId, SkillType.WRITING, 3, "SEC-W", UUID.randomUUID(), 3600, Map.of()),
                new SectionRecord(UUID.randomUUID(), formId, SkillType.SPEAKING, 4, "SEC-S", UUID.randomUUID(), 900, Map.of())
        );
    }

    @Test
    @DisplayName("Option A: Objective skills (Listening & Reading) are always free and do not check/reserve EXAM_AI_SCORING")
    void testCreateAttemptObjectiveOnlyDoesNotRequirePremium() {
        UUID formId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        Long userId = 100L;

        FormVersionRecord form = createPublishedForm(formId);
        List<SectionRecord> sections = create4Sections(formId);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        when(rightsService.verifyFormRights(formId)).thenReturn(true);
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(sections);
        when(manifestService.serializeFormSnapshot(form)).thenReturn(
                new ExamManifestService.FormSnapshotResult(Map.of("version", "v4.0"), "v4.0", "snapshot_hash")
        );
        when(attemptRepository.insertAttempt(any())).thenReturn(attemptId);

        AttemptRecord createdAttempt = createTestAttempt(attemptId, userId, ExamAttemptStatus.CREATED);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(createdAttempt));
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of());
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of());

        CreateAttemptRequest req = new CreateAttemptRequest(
                formId,
                ExamAttemptMode.EXAM_SIMULATION,
                null,
                null,
                "mutation-123",
                List.of("LISTENING", "READING")
        );

        AttemptStateDto result = attemptService.createAttempt(userId, req);

        assertNotNull(result);
        assertEquals(attemptId, result.attemptId());
        // Verify entitlementService and usageService were never called for reservation or quota checks
        verifyNoInteractions(entitlementService);
        verifyNoInteractions(usageService);
        verify(attemptRepository).insertAttempt(any());
    }

    @Test
    @DisplayName("Option B: Productive skills (Writing/Speaking) throw PremiumRequiredException when free quota exhausted")
    void testCreateAttemptProductiveSkillsGatedWhenQuotaExhausted() {
        UUID formId = UUID.randomUUID();
        Long userId = 100L;

        FormVersionRecord form = createPublishedForm(formId);
        List<SectionRecord> sections = create4Sections(formId);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        when(rightsService.verifyFormRights(formId)).thenReturn(true);
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(sections);
        when(entitlementService.isUserPremium(userId)).thenReturn(false);
        when(usageService.reserveUsage(eq(userId), eq("EXAM_AI_SCORING"), any(), eq(false)))
                .thenThrow(new PremiumRequiredException("EXAM_AI_SCORING"));

        CreateAttemptRequest req = new CreateAttemptRequest(
                formId,
                ExamAttemptMode.EXAM_SIMULATION,
                null,
                null,
                "mutation-456",
                List.of("LISTENING", "READING", "WRITING", "SPEAKING")
        );

        PremiumRequiredException ex = assertThrows(PremiumRequiredException.class, () ->
                attemptService.createAttempt(userId, req)
        );

        assertEquals("EXAM_AI_SCORING", ex.getFeatureKey());
        // Attempt must NEVER be inserted into the database
        verify(attemptRepository, never()).insertAttempt(any());
        verify(manifestService, never()).serializeFormSnapshot(any());
    }

    @Test
    @DisplayName("Option B: Productive skills succeed and reserve EXAM_AI_SCORING when user is eligible")
    void testCreateAttemptProductiveSkillsAllowedWhenEligible() {
        UUID formId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        Long userId = 100L;

        FormVersionRecord form = createPublishedForm(formId);
        List<SectionRecord> sections = create4Sections(formId);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        when(rightsService.verifyFormRights(formId)).thenReturn(true);
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(sections);
        when(entitlementService.isUserPremium(userId)).thenReturn(true);
        when(usageService.reserveUsage(eq(userId), eq("EXAM_AI_SCORING"), any(), eq(true))).thenReturn(888L);
        when(manifestService.serializeFormSnapshot(form)).thenReturn(
                new ExamManifestService.FormSnapshotResult(Map.of("version", "v4.0"), "v4.0", "snapshot_hash")
        );
        when(attemptRepository.insertAttempt(any())).thenReturn(attemptId);

        AttemptRecord createdAttempt = createTestAttempt(attemptId, userId, ExamAttemptStatus.CREATED);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(createdAttempt));
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of());
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of());

        CreateAttemptRequest req = new CreateAttemptRequest(
                formId,
                ExamAttemptMode.EXAM_SIMULATION,
                null,
                null,
                "mutation-789",
                List.of("LISTENING", "READING", "WRITING", "SPEAKING"), true
        );

        AttemptStateDto result = attemptService.createAttempt(userId, req);

        assertNotNull(result);
        assertEquals(attemptId, result.attemptId());
        verify(usageService).reserveUsage(eq(userId), eq("EXAM_AI_SCORING"), any(), eq(true));
        verify(attemptRepository).insertAttempt(argThat(attempt -> {
            Map<String, Object> meta = attempt.clientSessionMeta();
            return meta != null && Long.valueOf(888L).equals(meta.get("reservationId"));
        }));
    }
}
