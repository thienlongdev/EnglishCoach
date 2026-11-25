package com.englishcoach.architecture;

import com.englishcoach.ai.service.LearnerDnaAggregatorService;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.contract.LearnerDnaSnapshot;
import com.englishcoach.community.dto.CommunityModerationRecordDto;
import com.englishcoach.community.entity.CommunityModerationRecord;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.ModerationAction;
import com.englishcoach.exams.service.ExamProfileService;
import com.englishcoach.feedback.dto.CreateFeedbackRequest;
import com.englishcoach.feedback.dto.FeedbackUnreadCountDto;
import com.englishcoach.feedback.entity.FeedbackMessage;
import com.englishcoach.feedback.entity.FeedbackThread;
import com.englishcoach.feedback.repository.FeedbackMessageRepository;
import com.englishcoach.feedback.repository.FeedbackThreadRepository;
import com.englishcoach.feedback.service.FeedbackServiceImpl;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.mocktest.dto.MockExamDto;
import com.englishcoach.mocktest.dto.MockExamResultDto;
import com.englishcoach.mocktest.entity.Exam;
import com.englishcoach.mocktest.entity.ExamResult;
import com.englishcoach.premium.service.PremiumEntitlementCache;
import com.englishcoach.reading.service.ReadingService;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.user.repository.UserProfileRepository;
import com.englishcoach.user.service.AvatarStorageService;
import com.englishcoach.user.service.UserProfileService;
import com.englishcoach.vocabulary.dto.VocabularyCourseDto;
import com.englishcoach.vocabulary.entity.VocabularyCourse;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

import java.lang.reflect.Method;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Behavioral regression tests for Wave 3 transaction, cycle-breaking, and DTO parity remediations.
 */
class Wave3RemediationBehaviorTest {

    @Test
    @DisplayName("BV-004/005: FeedbackServiceImpl defers STOMP broadcasts until afterCommit when a transaction is active")
    void feedbackBroadcastsRunAfterCommitWhenTxActive() {
        FeedbackThreadRepository threadRepo = mock(FeedbackThreadRepository.class);
        FeedbackMessageRepository msgRepo = mock(FeedbackMessageRepository.class);
        UserRepository userRepo = mock(UserRepository.class);
        SimpMessagingTemplate stomp = mock(SimpMessagingTemplate.class);
        FeedbackServiceImpl service = new FeedbackServiceImpl(threadRepo, msgRepo, userRepo, stomp);

        when(msgRepo.countBySenderUserIdAndCreatedAtAfter(eq(1L), any())).thenReturn(0L);
        when(userRepo.findById(1L)).thenReturn(Optional.of(User.builder().id(1L).name("Alice").email("a@t.io").role(Role.ROLE_USER).build()));
        when(threadRepo.save(any(FeedbackThread.class))).thenReturn(FeedbackThread.builder()
                .id(77L).userId(1L).category("IDEA").subject("Sub").status("OPEN")
                .adminUnread(true).userUnread(false).createdAt(Instant.now()).lastMessageAt(Instant.now()).build());
        when(msgRepo.save(any(FeedbackMessage.class))).thenAnswer(inv -> inv.getArgument(0));
        when(threadRepo.countByAdminUnreadTrue()).thenReturn(3L);

        TransactionSynchronizationManager.initSynchronization();
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            service.createThread(1L, new CreateFeedbackRequest("IDEA", "Sub", "Hello"));

            // Must NOT broadcast before commit!
            verifyNoInteractions(stomp);
            List<TransactionSynchronization> syncs = TransactionSynchronizationManager.getSynchronizations();
            assertThat(syncs).hasSize(1);

            // Simulate commit
            syncs.forEach(TransactionSynchronization::afterCommit);
            verify(stomp, times(1)).convertAndSend(eq("/topic/admin/feedback-badge"), eq(new FeedbackUnreadCountDto(3L)));
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    @DisplayName("BV-001 & BV-009: AdminIdentityService.requireOfficialAdmin is readOnly TX and ReadingService.processAndSaveFile is NOT_SUPPORTED")
    void transactionAnnotationsOnFixedMethods() throws Exception {
        Method requireAdmin = AdminIdentityService.class.getDeclaredMethod("requireOfficialAdmin", Long.class);
        Transactional adminTx = requireAdmin.getAnnotation(Transactional.class);
        assertThat(adminTx).isNotNull();
        assertThat(adminTx.readOnly()).isTrue();

        Method processAndSave = ReadingService.class.getDeclaredMethod(
                "processAndSaveFile", MultipartFile.class, Long.class, String.class);
        Transactional readingTx = processAndSave.getAnnotation(Transactional.class);
        assertThat(readingTx).isNotNull();
        assertThat(readingTx.propagation()).isEqualTo(Propagation.NOT_SUPPORTED);
    }

    @Test
    @DisplayName("BV-050/051: PremiumEntitlementCache invalidates immediately AND afterCommit when TX is active")
    void premiumEntitlementCacheImmediateAndAfterCommitInvalidation() {
        PremiumEntitlementCache cache = new PremiumEntitlementCache();
        AtomicInteger loads = new AtomicInteger();

        assertThat(cache.getOrLoad(99L, id -> { loads.incrementAndGet(); return false; })).isFalse();
        assertThat(cache.getOrLoad(99L, id -> { loads.incrementAndGet(); return true; })).isFalse();
        assertThat(loads.get()).isEqualTo(1);

        TransactionSynchronizationManager.initSynchronization();
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            cache.invalidateImmediateAndAfterCommit(99L);
            // Evicted immediately
            assertThat(cache.getIfPresent(99L)).isNull();

            // Simulate concurrent reader repopulating stale pre-commit value before commit completes
            cache.put(99L, false);
            assertThat(cache.getIfPresent(99L)).isFalse();

            // Commit fires afterCommit() eviction
            TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
            assertThat(cache.getIfPresent(99L)).isNull();
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    @DisplayName("SCC #2: LearnerDnaAggregatorService implements LearnerDnaSnapshotProvider cleanly")
    void learnerDnaSnapshotProviderPortWorks() {
        LearnerDnaAggregatorService aggregator = new LearnerDnaAggregatorService(
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingTurnRepository.class),
                mock(WritingErrorMemoryRepository.class),
                mock(WritingSubmissionRepository.class),
                mock(WritingAssessmentRepository.class),
                mock(ExerciseAttemptRepository.class),
                mock(FlashcardRepository.class),
                mock(ExamProfileService.class),
                new ObjectMapper()
        );
        LearnerDnaSnapshot snapshot = aggregator.getSnapshot(null, false);
        assertThat(snapshot).isNotNull();
        assertThat(snapshot.generatedAt()).isNotBlank();
        assertThat(snapshot.missingPhonemes()).isEmpty();
        assertThat(snapshot.pausingIssues()).isFalse();
        assertThat(snapshot.criticalForgettingCount()).isZero();
    }

    @Test
    @DisplayName("BV-012, BV-019, BV-020, BV-024: New DTOs preserve exact JSON keys without LAZY entity leakage")
    void newDtosPreserveExactJsonKeys() throws Exception {
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());

        Exam exam = Exam.builder().id(10L).title("IELTS Full 1").durationMinutes(120).examDataJson("{}").build();
        ExamResult result = ExamResult.builder()
                .id(20L)
                .user(User.builder().id(99L).email("secret@test.io").password("hash").build())
                .exam(exam)
                .score(85)
                .feedback("Great")
                .completedAt(LocalDateTime.of(2026, 11, 25, 10, 0))
                .build();

        JsonNode examJson = mapper.readTree(mapper.writeValueAsString(MockExamDto.fromEntity(exam)));
        assertThat(Set.of("id", "title", "durationMinutes", "examDataJson"))
                .containsExactlyInAnyOrderElementsOf(() -> examJson.fieldNames());

        JsonNode resultJson = mapper.readTree(mapper.writeValueAsString(MockExamResultDto.fromEntity(result)));
        assertThat(Set.of("id", "exam", "score", "feedback", "completedAt"))
                .containsExactlyInAnyOrderElementsOf(() -> resultJson.fieldNames());
        assertThat(resultJson.has("user")).isFalse();

        VocabularyCourse course = VocabularyCourse.builder()
                .id(5L).title("Academic B2").description("Desc").cefrLevel("B2").build();
        JsonNode courseJson = mapper.readTree(mapper.writeValueAsString(VocabularyCourseDto.fromEntity(course)));
        assertThat(Set.of("id", "title", "description", "cefrLevel"))
                .containsExactlyInAnyOrderElementsOf(() -> courseJson.fieldNames());
        assertThat(courseJson.has("words")).isFalse();

        CommunityPost post = CommunityPost.builder().id(300L).build();
        User admin = User.builder().id(1L).email("admin@test.io").password("hash").build();
        CommunityModerationRecord modRec = CommunityModerationRecord.builder()
                .id(7L).post(post).admin(admin)
                .previousStatus("PENDING").newStatus("PUBLISHED")
                .action(ModerationAction.APPROVE).reason("OK").note("Approved")
                .createdAt(Instant.parse("2026-11-25T10:00:00Z"))
                .build();
        JsonNode modJson = mapper.readTree(mapper.writeValueAsString(CommunityModerationRecordDto.fromEntity(modRec)));
        assertThat(Set.of("id", "postId", "moderatorId", "previousStatus", "newStatus", "action", "reason", "note", "createdAt"))
                .containsExactlyInAnyOrderElementsOf(() -> modJson.fieldNames());
        assertThat(modJson.get("postId").asLong()).isEqualTo(300L);
        assertThat(modJson.get("moderatorId").asLong()).isEqualTo(1L);
        assertThat(modJson.has("admin")).isFalse();
        assertThat(modJson.has("post")).isFalse();
    }

    @Test
    @DisplayName("BV-030: UserProfileService.findPublicDisplayName trims valid names and hides blank/email names")
    void findPublicDisplayNameSanitizesEmailAndBlank() {
        UserRepository users = mock(UserRepository.class);
        UserProfileService service = new UserProfileService(
                users,
                mock(UserProfileRepository.class),
                mock(AuthIdentityRepository.class),
                mock(AvatarStorageService.class)
        );
        when(users.findById(1L)).thenReturn(Optional.of(User.builder().id(1L).name("  Minh  ").build()));
        when(users.findById(2L)).thenReturn(Optional.of(User.builder().id(2L).name("user@secret.io").build()));
        when(users.findById(3L)).thenReturn(Optional.of(User.builder().id(3L).name("   ").build()));

        assertThat(service.findPublicDisplayName(1L)).contains("Minh");
        assertThat(service.findPublicDisplayName(2L)).isEmpty();
        assertThat(service.findPublicDisplayName(3L)).isEmpty();
        assertThat(service.findPublicDisplayName(null)).isEmpty();
    }
}
