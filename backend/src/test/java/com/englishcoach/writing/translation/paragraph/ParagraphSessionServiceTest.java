package com.englishcoach.writing.translation.paragraph;

import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.*;
import com.englishcoach.writing.translation.paragraph.repository.*;
import com.englishcoach.writing.translation.paragraph.service.ParagraphSessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ParagraphSessionServiceTest {

    @Mock
    private TranslationParagraphSessionRepository sessionRepository;

    @Mock
    private TranslationParagraphSessionItemRepository itemRepository;

    @Mock
    private TranslationParagraphPassageRepository passageRepository;

    private ParagraphSessionService sessionService;

    @BeforeEach
    void setUp() {
        sessionService = new ParagraphSessionService(sessionRepository, itemRepository, passageRepository);
    }

    @Test
    void testStartSession_IdempotentOnDuplicateClientMutationId() {
        Long userId = 100L;
        String mutationId = "client-mut-abc-123";
        UUID existingSessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity existingSession = TranslationParagraphSessionEntity.builder()
                .id(existingSessionId)
                .userId(userId)
                .clientMutationId(mutationId)
                .status("ACTIVE")
                .currentIndex(0)
                .sessionRevision(1L)
                .totalItems(5)
                .build();

        TranslationParagraphPassageEntity mockPassage = TranslationParagraphPassageEntity.builder()
                .id(UUID.randomUUID())
                .sourceVi("Bài viết mẫu.")
                .referenceEn("Sample passage.")
                .topic("GENERAL")
                .genre("GENERAL")
                .build();
        TranslationParagraphSessionItemEntity mockItem = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .ordinal(0)
                .passage(mockPassage)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();

        when(sessionRepository.findByUserIdAndClientMutationId(userId, mutationId))
                .thenReturn(Optional.of(existingSession));
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(existingSessionId))
                .thenReturn(List.of(mockItem));

        ParagraphStartRequest request = ParagraphStartRequest.builder()
                .clientMutationId(mutationId)
                .build();

        ParagraphSessionResponse response = sessionService.startSession(userId, request);

        assertNotNull(response);
        assertEquals(existingSessionId, response.getSessionId());
        verify(sessionRepository, never()).save(any());
        verify(passageRepository, never()).findEligiblePassages(any(), any(), any());
    }

    @Test
    void testStartSession_CreatesNewSession_WithEligiblePassages() {
        Long userId = 100L;
        String mutationId = "new-mut-456";

        when(sessionRepository.findByUserIdAndClientMutationId(userId, mutationId)).thenReturn(Optional.empty());
        when(sessionRepository.findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE")).thenReturn(Optional.empty());
        when(passageRepository.countEligiblePassagesByFilter("GENERAL", "TECHNOLOGY")).thenReturn(2570L);

        UUID passageId1 = UUID.randomUUID();
        TranslationParagraphPassageEntity passage1 = TranslationParagraphPassageEntity.builder()
                .id(passageId1)
                .sourceVi("Đoạn văn tiếng Việt.")
                .referenceEn("English paragraph reference.")
                .genre("GENERAL")
                .topic("TECHNOLOGY")
                .difficultyStatus("UNCALIBRATED")
                .attributionText("Wikipedia")
                .licenseCode("CC_BY_SA_4_0")
                .contentVersion(1)
                .build();

        when(passageRepository.findEligiblePassages(eq("GENERAL"), eq("TECHNOLOGY"), any(Pageable.class)))
                .thenReturn(List.of(passage1));

        UUID savedSessionId = UUID.randomUUID();
        when(sessionRepository.save(any(TranslationParagraphSessionEntity.class))).thenAnswer(invocation -> {
            TranslationParagraphSessionEntity entity = invocation.getArgument(0);
            if (entity.getId() == null) {
                entity.setId(savedSessionId);
            }
            return entity;
        });

        UUID savedItemId = UUID.randomUUID();
        TranslationParagraphSessionItemEntity item = TranslationParagraphSessionItemEntity.builder()
                .id(savedItemId)
                .ordinal(0)
                .passage(passage1)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.save(any(TranslationParagraphSessionItemEntity.class))).thenReturn(item);
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(savedSessionId)).thenReturn(List.of(item));

        ParagraphStartRequest request = ParagraphStartRequest.builder()
                .clientMutationId(mutationId)
                .genre("GENERAL")
                .topic("TECHNOLOGY")
                .limit(5)
                .build();

        ParagraphSessionResponse response = sessionService.startSession(userId, request);

        assertNotNull(response);
        assertEquals(savedSessionId, response.getSessionId());
        assertEquals("ACTIVE", response.getStatus());
        assertEquals(2570, response.getTotalItems());
        assertEquals(1, response.getItems().size());
        assertEquals(0L, response.getItems().get(0).getDraftRevision());
        assertEquals("NOT_STARTED", response.getItems().get(0).getProgressState());
        // Verify ONLY 1 session item row was created upfront (lazy materialization)
        verify(itemRepository, times(1)).save(any(TranslationParagraphSessionItemEntity.class));
    }

    @Test
    void testSaveDraft_StrictCas_SuccessOnMatchingRevision() {
        Long userId = 100L;
        UUID sessionId = UUID.randomUUID();
        int ordinal = 0;

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .sessionRevision(1L)
                .totalItems(5)
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));

        TranslationParagraphSessionItemEntity item = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(ordinal)
                .draftText("Previous draft")
                .draftRevision(2L)
                .progressState("IN_PROGRESS")
                .build();
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, ordinal)).thenReturn(Optional.of(item));

        ParagraphDraftRequest request = ParagraphDraftRequest.builder()
                .ordinal(ordinal)
                .draftText("Updated draft content")
                .expectedRevision(2L) // Matches current revision 2
                .clientMutationId("mut-draft-001")
                .build();

        ParagraphDraftResponse response = sessionService.saveDraft(userId, sessionId, request);

        assertNotNull(response);
        assertEquals(3L, response.getDraftRevision()); // Incremented to 3
        assertEquals("IN_PROGRESS", response.getProgressState());
        assertEquals("Updated draft content", item.getDraftText());
        verify(itemRepository).save(item);
        verify(sessionRepository).save(session);
    }

    @Test
    void testSaveDraft_StrictCas_ThrowsConflict409_OnRevisionMismatch() {
        Long userId = 100L;
        UUID sessionId = UUID.randomUUID();
        int ordinal = 0;

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .totalItems(5)
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));

        TranslationParagraphSessionItemEntity item = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(ordinal)
                .draftText("Already updated text in newer tab")
                .draftRevision(5L) // Current revision is 5
                .progressState("IN_PROGRESS")
                .build();
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, ordinal)).thenReturn(Optional.of(item));

        ParagraphDraftRequest request = ParagraphDraftRequest.builder()
                .ordinal(ordinal)
                .draftText("Stale draft from older tab")
                .expectedRevision(3L) // Stale revision!
                .clientMutationId("mut-stale")
                .build();

        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () ->
                sessionService.saveDraft(userId, sessionId, request)
        );

        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        assertTrue(ex.getReason().contains("Draft revision conflict"));
        // Ensure draft was NOT overwritten
        assertEquals("Already updated text in newer tab", item.getDraftText());
        assertEquals(5L, item.getDraftRevision());
        verify(itemRepository, never()).save(any());
    }

    @Test
    void testNavigateSession_UpdatesCurrentIndex_DoesNotGradeOrCallAi() {
        Long userId = 100L;
        UUID sessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .currentIndex(0)
                .totalItems(55812)
                .sessionRevision(1L)
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));
        when(sessionRepository.save(session)).thenReturn(session);

        TranslationParagraphPassageEntity mockPassage = TranslationParagraphPassageEntity.builder()
                .id(UUID.randomUUID())
                .sourceVi("Bài viết mẫu.")
                .referenceEn("Sample passage.")
                .topic("GENERAL")
                .genre("GENERAL")
                .build();

        TranslationParagraphSessionItemEntity item3 = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(3)
                .passage(mockPassage)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, 3)).thenReturn(Optional.of(item3));
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(sessionId)).thenReturn(List.of(item3));

        ParagraphSessionResponse response = sessionService.navigateSession(userId, sessionId, 3);

        assertNotNull(response);
        assertEquals(3, session.getCurrentIndex());
        assertEquals(2L, session.getSessionRevision());
        verify(sessionRepository).save(session);
    }

    @Test
    void testCrossUserAccess_Blocked() {
        Long authorizedUser = 100L;
        Long attackerUser = 999L;
        UUID sessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(authorizedUser)
                .status("ACTIVE")
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));

        assertThrows(AccessDeniedException.class, () ->
                sessionService.getSession(attackerUser, sessionId)
        );

        ParagraphDraftRequest draftRequest = ParagraphDraftRequest.builder()
                .ordinal(0)
                .draftText("hack")
                .expectedRevision(0L)
                .clientMutationId("mut-evil")
                .build();
        assertThrows(AccessDeniedException.class, () ->
                sessionService.saveDraft(attackerUser, sessionId, draftRequest)
        );

        assertThrows(AccessDeniedException.class, () ->
                sessionService.navigateSession(attackerUser, sessionId, 1)
        );
    }

    @Test
    void testStartSession_ResumesActiveSession_AndUpgradesTotalItemsIfOld() {
        Long userId = 100L;
        String mutationId = "new-mut-resume";
        UUID activeSessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity activeSession = TranslationParagraphSessionEntity.builder()
                .id(activeSessionId)
                .userId(userId)
                .status("ACTIVE")
                .filterTopic("TECHNOLOGY")
                .filterGenre("GENERAL")
                .totalItems(5) // Old 5-item session
                .currentIndex(1)
                .build();

        TranslationParagraphPassageEntity mockPassage = TranslationParagraphPassageEntity.builder()
                .id(UUID.randomUUID())
                .sourceVi("Bài viết công nghệ.")
                .referenceEn("Tech passage.")
                .topic("TECHNOLOGY")
                .genre("GENERAL")
                .build();

        TranslationParagraphSessionItemEntity item1 = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(activeSession)
                .ordinal(1)
                .passage(mockPassage)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();

        when(sessionRepository.findByUserIdAndClientMutationId(userId, mutationId)).thenReturn(Optional.empty());
        when(sessionRepository.findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE")).thenReturn(Optional.of(activeSession));
        when(passageRepository.countEligiblePassagesByFilter("GENERAL", "TECHNOLOGY")).thenReturn(2570L);
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(activeSessionId)).thenReturn(List.of(item1));

        ParagraphStartRequest request = ParagraphStartRequest.builder()
                .clientMutationId(mutationId)
                .topic("TECHNOLOGY")
                .genre("GENERAL")
                .build();

        ParagraphSessionResponse response = sessionService.startSession(userId, request);

        assertNotNull(response);
        assertEquals(activeSessionId, response.getSessionId());
        // Transparent upgrade from 5 to 2570
        assertEquals(2570, activeSession.getTotalItems());
        verify(sessionRepository).saveAndFlush(activeSession);
    }

    @Test
    void testStartSession_CreatesNewSession_WhenFilterDiffers() {
        Long userId = 100L;
        String mutationId = "new-mut-diff";
        UUID activeSessionId = UUID.randomUUID();

        // Existing active session is TECHNOLOGY
        TranslationParagraphSessionEntity activeSession = TranslationParagraphSessionEntity.builder()
                .id(activeSessionId)
                .userId(userId)
                .status("ACTIVE")
                .filterTopic("TECHNOLOGY")
                .filterGenre("GENERAL")
                .totalItems(5)
                .currentIndex(1)
                .build();

        when(sessionRepository.findByUserIdAndClientMutationId(userId, mutationId)).thenReturn(Optional.empty());
        when(sessionRepository.findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE")).thenReturn(Optional.of(activeSession));

        when(passageRepository.countEligiblePassagesByFilter("GENERAL", "SOCIETY")).thenReturn(3394L);

        // User requests SOCIETY -> must NOT resume active session!
        UUID newPassageId = UUID.randomUUID();
        TranslationParagraphPassageEntity societyPassage = TranslationParagraphPassageEntity.builder()
                .id(newPassageId)
                .sourceVi("Đoạn văn xã hội.")
                .referenceEn("Society paragraph.")
                .genre("GENERAL")
                .topic("SOCIETY")
                .contentVersion(1)
                .build();

        when(passageRepository.findEligiblePassages(eq("GENERAL"), eq("SOCIETY"), any(Pageable.class)))
                .thenReturn(List.of(societyPassage));

        UUID newSessionId = UUID.randomUUID();
        when(sessionRepository.save(any(TranslationParagraphSessionEntity.class))).thenAnswer(invocation -> {
            TranslationParagraphSessionEntity entity = invocation.getArgument(0);
            entity.setId(newSessionId);
            return entity;
        });

        TranslationParagraphSessionItemEntity item = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .ordinal(0)
                .passage(societyPassage)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.save(any(TranslationParagraphSessionItemEntity.class))).thenReturn(item);
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(newSessionId)).thenReturn(List.of(item));

        ParagraphStartRequest request = ParagraphStartRequest.builder()
                .clientMutationId(mutationId)
                .topic("SOCIETY")
                .genre("GENERAL")
                .limit(5)
                .build();

        ParagraphSessionResponse response = sessionService.startSession(userId, request);

        assertNotNull(response);
        assertEquals(newSessionId, response.getSessionId());
        assertEquals("SOCIETY", response.getFilterTopic());
        assertEquals(3394, response.getTotalItems());
        verify(passageRepository).findEligiblePassages(eq("GENERAL"), eq("SOCIETY"), any(Pageable.class));
    }

    @Test
    void testLazyNavigation_MaterializesOnDemand() {
        Long userId = 100L;
        UUID sessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .currentIndex(0)
                .totalItems(55812)
                .sessionRevision(1L)
                .filterGenre("GENERAL")
                .filterTopic("GENERAL")
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));
        when(sessionRepository.save(session)).thenReturn(session);

        // Ordinal 1 is NOT yet in itemRepository
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, 1)).thenReturn(Optional.empty());

        UUID passageId1 = UUID.randomUUID();
        TranslationParagraphPassageEntity passage1 = TranslationParagraphPassageEntity.builder()
                .id(passageId1)
                .sourceVi("Đoạn văn thứ hai.")
                .referenceEn("Second paragraph.")
                .genre("GENERAL")
                .topic("GENERAL")
                .contentVersion(1)
                .build();
        when(passageRepository.findEligiblePassages(eq("GENERAL"), eq("GENERAL"), any(Pageable.class)))
                .thenReturn(List.of(passage1));

        TranslationParagraphSessionItemEntity item1 = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(1)
                .passage(passage1)
                .contentVersion(1)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.save(any(TranslationParagraphSessionItemEntity.class))).thenReturn(item1);
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(sessionId)).thenReturn(List.of(item1));

        ParagraphSessionResponse response = sessionService.navigateSession(userId, sessionId, 1);

        assertNotNull(response);
        assertEquals(1, session.getCurrentIndex());
        assertEquals(55812, response.getTotalItems());
        // Verify passage was fetched at offset 1 and saved into itemRepository
        verify(passageRepository).findEligiblePassages(eq("GENERAL"), eq("GENERAL"), any(Pageable.class));
        verify(itemRepository).save(any(TranslationParagraphSessionItemEntity.class));
    }

    @Test
    void testSkipItem_MarksSkippedAndAdvances() {
        Long userId = 100L;
        UUID sessionId = UUID.randomUUID();

        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .currentIndex(0)
                .totalItems(4905)
                .sessionRevision(1L)
                .filterGenre("GENERAL")
                .filterTopic("CULTURE")
                .build();
        when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));
        when(sessionRepository.save(session)).thenReturn(session);

        TranslationParagraphPassageEntity passage0 = TranslationParagraphPassageEntity.builder()
                .id(UUID.randomUUID())
                .sourceVi("Đoạn văn văn hóa.")
                .referenceEn("Culture passage.")
                .genre("GENERAL")
                .topic("CULTURE")
                .build();

        TranslationParagraphSessionItemEntity item0 = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(0)
                .passage(passage0)
                .contentVersion(1)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, 0)).thenReturn(Optional.of(item0));

        // Ordinal 1 for pre-materialization
        TranslationParagraphPassageEntity passage1 = TranslationParagraphPassageEntity.builder()
                .id(UUID.randomUUID())
                .sourceVi("Đoạn văn văn hóa 2.")
                .referenceEn("Culture passage 2.")
                .genre("GENERAL")
                .topic("CULTURE")
                .build();
        TranslationParagraphSessionItemEntity item1 = TranslationParagraphSessionItemEntity.builder()
                .id(UUID.randomUUID())
                .session(session)
                .ordinal(1)
                .passage(passage1)
                .contentVersion(1)
                .progressState("NOT_STARTED")
                .build();
        when(itemRepository.findBySessionIdAndOrdinal(sessionId, 1)).thenReturn(Optional.of(item1));
        when(itemRepository.findBySessionIdOrderByOrdinalAsc(sessionId)).thenReturn(List.of(item0, item1));

        ParagraphSessionResponse response = sessionService.skipItem(userId, sessionId, 0);

        assertNotNull(response);
        assertEquals("SKIPPED", item0.getProgressState());
        assertEquals(1, session.getCurrentIndex()); // Advanced from 0 to 1
        verify(itemRepository).save(item0);
    }
}
