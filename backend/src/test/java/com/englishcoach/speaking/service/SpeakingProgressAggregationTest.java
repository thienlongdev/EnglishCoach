package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingProgressAggregationTest {

    @Mock
    private SpeakingSessionRepository sessionRepository;

    @Mock
    private SpeakingShadowingAttemptRepository attemptRepository;

    @Mock
    private ListeningMaterialRepository materialRepository;

    @Mock
    private SpeakingTurnFeedbackRepository feedbackRepository;

    @Mock
    private SpeakingShadowingService shadowingService;

    @Mock
    private SpeakingShadowingUnitService unitService;

    @Mock
    private UserRepository userRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingQuickCheckRepository quickCheckRepository;

    @InjectMocks
    private SpeakingProgressAggregationService progressAggregationService;

    private User testUser;
    private User otherUser;
    private ListeningMaterial testMaterial;

    @BeforeEach
    void setUp() {
        testUser = User.builder().id(101L).email("learner@englishcoach.com").name("Learner").build();
        otherUser = User.builder().id(999L).email("other@englishcoach.com").name("Other").build();
        testMaterial = ListeningMaterial.builder().id(201L).title("Business Meeting English").build();
        lenient().when(feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(any(), any()))
                .thenReturn(Collections.emptyList());
        lenient().when(speakingTurnRepository.findBySessionIdIn(any()))
                .thenReturn(Collections.emptyList());
    }

    @Test
    @DisplayName("1. Empty history returns valid zero/empty progress summary with no score")
    void testEmptyHistorySummary() {
        when(sessionRepository.findFirstByUserIdAndModeAndStatusOrderByCreatedAtDesc(eq(101L), eq("SHADOWING"), eq("ACTIVE")))
                .thenReturn(Optional.empty());
        when(sessionRepository.findByUserIdAndModeAndCreatedAtAfterOrderByCreatedAtDesc(eq(101L), eq("SHADOWING"), any(LocalDateTime.class)))
                .thenReturn(Collections.emptyList());
        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(Collections.emptyList());
        when(sessionRepository.findByUserIdOrderByCreatedAtDesc(eq(101L), any(PageRequest.class)))
                .thenReturn(Page.empty());

        SpeakingProgressSummaryDto summary = progressAggregationService.getSpeakingProgressSummary(101L);

        assertNotNull(summary);
        assertEquals("SPEAKING_PROGRESS_POLICY_v1", summary.getPolicyVersion());
        assertNull(summary.getActiveSession());
        assertEquals(0L, summary.getPracticeSummary().getSessionsCompleted7d());
        assertEquals(0L, summary.getPracticeSummary().getSessionsCompleted30d());
        assertEquals(0, summary.getPracticeSummary().getPracticeDays7d());
        assertTrue(summary.getRecentSessions().isEmpty());
        assertTrue(summary.getRecurringIssues().isEmpty());
        assertTrue(summary.getRecentImprovements().isEmpty());
    }

    @Test
    @DisplayName("2. Single session does not trigger recurring issue (distinct sessions < 2)")
    void testSingleSessionNoRecurrence() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession session1 = SpeakingSession.builder()
                .id(501L)
                .user(testUser)
                .mode("SHADOWING")
                .status("COMPLETED")
                .sourceId(201L)
                .completedUnitsCount(3)
                .totalUnitsCount(3)
                .createdAt(now.minusDays(1))
                .build();

        SpeakingShadowingAttempt attempt1 = SpeakingShadowingAttempt.builder()
                .id(1001L)
                .user(testUser)
                .session(session1)
                .clientAttemptId("att-01")
                .primaryIssueType("PHONEME_SUBSTITUTION")
                .targetWord("think")
                .retryIndex(0)
                .resolvedThisSession(false)
                .createdAt(now.minusDays(1))
                .build();

        when(sessionRepository.findFirstByUserIdAndModeAndStatusOrderByCreatedAtDesc(eq(101L), eq("SHADOWING"), eq("ACTIVE")))
                .thenReturn(Optional.empty());
        when(sessionRepository.findByUserIdAndModeAndCreatedAtAfterOrderByCreatedAtDesc(eq(101L), eq("SHADOWING"), any(LocalDateTime.class)))
                .thenReturn(List.of(session1));
        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(List.of(attempt1));
        when(sessionRepository.findByUserIdOrderByCreatedAtDesc(eq(101L), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(List.of(session1)));
        when(attemptRepository.findBySessionIdIn(anyList())).thenReturn(List.of(attempt1));
        when(materialRepository.findAllById(anySet())).thenReturn(List.of(testMaterial));

        SpeakingProgressSummaryDto summary = progressAggregationService.getSpeakingProgressSummary(101L);

        assertEquals(1L, summary.getPracticeSummary().getSessionsCompleted30d());
        assertEquals(1, summary.getRecentSessions().size());
        assertTrue(summary.getRecurringIssues().isEmpty(), "Single session occurrence must not trigger recurring issue");
    }

    @Test
    @DisplayName("3. Same issue observed in >= 2 distinct sessions triggers recurring issue")
    void testRecurringIssueAcrossDistinctSessions() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession session1 = SpeakingSession.builder().id(501L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(3)).build();
        SpeakingSession session2 = SpeakingSession.builder().id(502L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(1)).build();

        SpeakingShadowingAttempt att1 = SpeakingShadowingAttempt.builder().id(101L).session(session1).primaryIssueType("PHONEME_SUBSTITUTION").targetWord("think").createdAt(now.minusDays(3)).build();
        SpeakingShadowingAttempt att2 = SpeakingShadowingAttempt.builder().id(102L).session(session2).primaryIssueType("PHONEME_SUBSTITUTION").targetWord("think").resolvedThisSession(true).createdAt(now.minusDays(1)).build();

        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(List.of(att1, att2));

        List<SpeakingRecurringIssueDto> recurring = progressAggregationService.getRecurringIssues(101L);

        assertEquals(1, recurring.size());
        SpeakingRecurringIssueDto issue = recurring.get(0);
        assertTrue(issue.getIssueKey().contains("PHONEME_SUBSTITUTION:think"));
        assertEquals("PRONUNCIATION", issue.getCategory());
        assertEquals("PRACTICING", issue.getStatus());
        assertEquals(2, issue.getDistinctSessionsObserved());
        assertEquals(2, issue.getTotalOccurrences());
        assertEquals(1, issue.getResolvedSessionCount());
    }

    @Test
    @DisplayName("4. Multiple retries in one session do not inflate distinct session count")
    void testMultipleRetriesInOneSessionNoInflation() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession session1 = SpeakingSession.builder().id(501L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(2)).build();

        List<SpeakingShadowingAttempt> attemptsInOneSession = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            attemptsInOneSession.add(SpeakingShadowingAttempt.builder()
                    .id(100L + i)
                    .session(session1)
                    .primaryIssueType("PHONEME_SUBSTITUTION")
                    .targetWord("think")
                    .retryIndex(i)
                    .createdAt(now.minusDays(2))
                    .build());
        }

        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(attemptsInOneSession);

        List<SpeakingRecurringIssueDto> recurring = progressAggregationService.getRecurringIssues(101L);

        assertTrue(recurring.isEmpty(), "5 retries in ONE session must only count as 1 distinct session, below threshold of 2");
    }

    @Test
    @DisplayName("5. VALID_VARIANT is strictly excluded from recurring issue counts")
    void testValidVariantExclusion() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession session1 = SpeakingSession.builder().id(501L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(3)).build();
        SpeakingSession session2 = SpeakingSession.builder().id(502L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(1)).build();

        SpeakingShadowingAttempt att1 = SpeakingShadowingAttempt.builder().id(101L).session(session1).primaryIssueType("VALID_VARIANT").targetWord("water").createdAt(now.minusDays(3)).build();
        SpeakingShadowingAttempt att2 = SpeakingShadowingAttempt.builder().id(102L).session(session2).primaryIssueType("VALID_VARIANT").targetWord("water").createdAt(now.minusDays(1)).build();

        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(List.of(att1, att2));

        List<SpeakingRecurringIssueDto> recurring = progressAggregationService.getRecurringIssues(101L);

        assertTrue(recurring.isEmpty(), "VALID_VARIANT must never be counted as a pronunciation weakness or recurring issue");
    }

    @Test
    @DisplayName("6. NO_SAFE_TARGET and INCONCLUSIVE are excluded from weakness counts")
    void testNoSafeTargetAndInconclusiveExclusion() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession session1 = SpeakingSession.builder().id(501L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(3)).build();
        SpeakingSession session2 = SpeakingSession.builder().id(502L).user(testUser).mode("SHADOWING").status("COMPLETED").createdAt(now.minusDays(1)).build();

        SpeakingShadowingAttempt att1 = SpeakingShadowingAttempt.builder().id(101L).session(session1).primaryIssueType("NO_SAFE_TARGET").createdAt(now.minusDays(3)).build();
        SpeakingShadowingAttempt att2 = SpeakingShadowingAttempt.builder().id(102L).session(session2).primaryIssueType("INCONCLUSIVE").createdAt(now.minusDays(1)).build();

        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any(LocalDateTime.class)))
                .thenReturn(List.of(att1, att2));

        List<SpeakingRecurringIssueDto> recurring = progressAggregationService.getRecurringIssues(101L);
        assertTrue(recurring.isEmpty());
    }

    @Test
    @DisplayName("7. Cross-user session detail access throws 403 Forbidden")
    void testCrossUserSessionDetailAccessDenied() {
        SpeakingSession otherUserSession = SpeakingSession.builder()
                .id(888L)
                .user(otherUser)
                .mode("SHADOWING")
                .status("COMPLETED")
                .build();

        when(sessionRepository.findById(888L)).thenReturn(Optional.of(otherUserSession));

        assertThrows(ResponseStatusException.class, () -> {
            progressAggregationService.getSpeakingSessionDetail(101L, 888L);
        });
    }

    @Test
    @DisplayName("8. Paginated history returns correct page metadata")
    void testPaginatedHistory() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession s1 = SpeakingSession.builder().id(1L).user(testUser).mode("SHADOWING").status("COMPLETED").sourceId(201L).createdAt(now).build();
        SpeakingSession s2 = SpeakingSession.builder().id(2L).user(testUser).mode("SHADOWING").status("COMPLETED").sourceId(201L).createdAt(now.minusDays(1)).build();

        Page<SpeakingSession> page = new PageImpl<>(List.of(s1, s2), PageRequest.of(0, 10), 2);
        when(sessionRepository.findByUserIdOrderByCreatedAtDesc(eq(101L), any(PageRequest.class)))
                .thenReturn(page);
        when(attemptRepository.findBySessionIdIn(anyList())).thenReturn(Collections.emptyList());
        when(materialRepository.findAllById(anySet())).thenReturn(List.of(testMaterial));

        SpeakingSessionHistoryPageDto historyPage = progressAggregationService.getSpeakingSessionHistory(101L, 0, 10);

        assertNotNull(historyPage);
        assertEquals(2, historyPage.getContent().size());
        assertEquals(0, historyPage.getPage());
        assertEquals(2, historyPage.getTotalElements());
        assertFalse(historyPage.isHasNext());
    }
}
