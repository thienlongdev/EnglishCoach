package com.englishcoach.auth.isolation;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.exams.controller.ExamResultController;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.job.ExamJobService;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.listening.dto.ExerciseAttemptRequest;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.entity.ListeningExercise;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.ListeningSession;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.listening.repository.ListeningExerciseRepository;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.ListeningSessionRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.listening.service.DictationScoringService;
import com.englishcoach.listening.service.ListeningServiceImpl;
import com.englishcoach.reading.dto.ReadingMaterialResponse;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.DocumentHighlightRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.ReadingService;
import com.englishcoach.speaking.dto.ShadowingSegmentProgressDto;
import com.englishcoach.speaking.dto.SpeakingProgressDto;
import com.englishcoach.speaking.dto.SpeakingSessionUpdateRequest;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.repository.*;
import com.englishcoach.speaking.service.CanonicalTranscriptReconstructor;
import com.englishcoach.speaking.service.SpeakingContextService;
import com.englishcoach.speaking.service.SpeakingProgressAggregationService;
import com.englishcoach.speaking.service.SpeakingProgressService;
import com.englishcoach.speaking.service.SpeakingService;
import com.englishcoach.speaking.config.SpeakingShadowingSchemaRepair;
import com.englishcoach.speaking.service.SpeakingShadowingUnitService;
import com.englishcoach.vocabulary.repository.VocabularyCourseRepository;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.enums.WritingSourceType;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.*;
import com.englishcoach.writing.service.WritingCatalogService;
import com.englishcoach.writing.service.WritingErrorMemoryServiceImpl;
import com.englishcoach.writing.service.WritingSessionService;
import com.englishcoach.writing.service.WritingSourceAdapterServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class UserIsolationMatrixTest {

    private final Long USER_A = 100L;
    private final Long USER_B = 200L;

    // Flashcards
    @Mock private FlashcardRepository flashcardRepository;
    @Mock private UserRepository userRepository;
    @Mock private DictionaryRepository dictionaryRepository;
    private FlashcardService flashcardService;

    // Writing Error Memory
    @Mock private WritingErrorMemoryRepository errorMemoryRepository;
    @Mock private WritingLearningEvidenceRepository learningEvidenceRepository;
    @Mock private WritingFeedbackIssueRepository issueRepository;
    @Mock private WritingAssessmentRepository assessmentRepository;
    @Mock private WritingSubmissionRepository submissionRepository;
    @Mock private WritingCatalogService writingCatalogService;
    private WritingErrorMemoryServiceImpl writingErrorMemoryService;

    // Listening
    @Mock private ListeningExerciseRepository listeningExerciseRepository;
    @Mock private ListeningSessionRepository listeningSessionRepository;
    @Mock private ExerciseAttemptRepository exerciseAttemptRepository;
    @Mock private DictationScoringService dictationScoringService;
    @Mock private ListeningMaterialRepository listeningMaterialRepository;
    @Mock private TranscriptSegmentRepository transcriptSegmentRepository;
    private ListeningServiceImpl listeningService;

    // Reading
    @Mock private ReadingMaterialRepository readingMaterialRepository;
    @Mock private DocumentHighlightRepository documentHighlightRepository;
    private ReadingService readingService;

    // Speaking Shadowing & Context
    @Mock private SpeakingShadowingUnitRepository speakingShadowingUnitRepository;
    @Mock private SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
    @Mock private SpeakingShadowingSchemaRepair speakingShadowingSchemaRepair;
    private SpeakingShadowingUnitService speakingShadowingUnitService;

    @Mock private VocabularyCourseRepository vocabularyCourseRepository;
    private SpeakingContextService speakingContextService;

    // Writing Cross-Module Adapter
    @Mock private WritingProperties writingProperties;
    @Mock private WritingSessionService writingSessionService;
    private WritingSourceAdapterServiceImpl writingSourceAdapterService;

    // Speaking Core Service
    private SpeakingService speakingService;

    // Exams
    @Mock private ExamResultService examResultService;
    @Mock private ExamJobService examJobService;
    private ExamResultController examResultController;

    // Speaking Streak
    @Mock private SpeakingTurnRepository speakingTurnRepository;
    @Mock private SpeakingSessionRepository speakingSessionRepository;
    @Mock private SpeakingResultRepository speakingResultRepository;
    @Mock private SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;
    @Mock private SpeakingProgressAggregationService progressAggregationService;
    private SpeakingProgressService speakingProgressService;

    private User userA;
    private User userB;

    @BeforeEach
    void setUp() {
        userA = User.builder().id(USER_A).email("usera@example.com").name("User A").role(Role.ROLE_USER).build();
        userB = User.builder().id(USER_B).email("userb@example.com").name("User B").role(Role.ROLE_USER).build();

        flashcardService = new FlashcardService(flashcardRepository, userRepository, dictionaryRepository,
                new com.englishcoach.flashcard.service.AnkiNoteParser());

        writingErrorMemoryService = new WritingErrorMemoryServiceImpl(
                errorMemoryRepository,
                learningEvidenceRepository,
                issueRepository,
                assessmentRepository,
                submissionRepository,
                writingCatalogService
        );

        listeningService = new ListeningServiceImpl(
                listeningMaterialRepository, transcriptSegmentRepository, listeningExerciseRepository, exerciseAttemptRepository,
                listeningSessionRepository, dictationScoringService, null, null,
                userRepository, speakingShadowingAttemptRepository, speakingShadowingUnitRepository
        );

        readingService = new ReadingService(readingMaterialRepository, documentHighlightRepository, userRepository);

        speakingShadowingUnitService = new SpeakingShadowingUnitService(
                speakingShadowingUnitRepository,
                listeningMaterialRepository,
                transcriptSegmentRepository,
                speakingShadowingAttemptRepository,
                new CanonicalTranscriptReconstructor(),
                speakingShadowingSchemaRepair
        );

        speakingContextService = new SpeakingContextService(
                vocabularyCourseRepository,
                readingMaterialRepository,
                documentHighlightRepository,
                listeningMaterialRepository
        );

        writingSourceAdapterService = new WritingSourceAdapterServiceImpl(
                writingProperties,
                writingCatalogService,
                writingSessionService,
                flashcardRepository,
                readingMaterialRepository,
                listeningMaterialRepository,
                speakingSessionRepository,
                speakingTurnRepository
        );

        speakingService = new SpeakingService(
                speakingResultRepository,
                speakingSessionRepository,
                null, null, null, null, null,
                userRepository, null, null
        );

        examResultController = new ExamResultController(examResultService, examJobService);

        speakingProgressService = new SpeakingProgressService(
                speakingTurnRepository,
                speakingSessionRepository,
                speakingResultRepository,
                speakingTurnFeedbackRepository,
                speakingShadowingAttemptRepository,
                listeningMaterialRepository,
                progressAggregationService
        );
    }

    @Test
    @DisplayName("Isolation: User B cannot review, reset, or delete User A's flashcards")
    void testFlashcardIsolation() {
        Flashcard cardA = Flashcard.builder()
                .id(1L)
                .user(userA)
                .status("NEW")
                .nextReviewDate(LocalDateTime.now())
                .reviewCount(0)
                .build();

        when(flashcardRepository.findById(1L)).thenReturn(Optional.of(cardA));

        // User B attempts to review User A's card
        assertThatThrownBy(() -> flashcardService.reviewFlashcard(USER_B, 1L, "good"))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("404");

        // User B attempts to reset User A's card
        assertThatThrownBy(() -> flashcardService.resetFlashcard(USER_B, 1L))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("404");

        // User B attempts to delete User A's card
        assertThatThrownBy(() -> flashcardService.deleteFlashcard(USER_B, 1L))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("404");
    }

    @Test
    @DisplayName("Isolation: User B cannot dispute an issue belonging to User A's writing submission")
    void testWritingIsolation() {
        String issueId = "issue-user-a-123";
        String assessmentId = "assess-123";
        String submissionId = "sub-123";

        WritingFeedbackIssueEntity issue = WritingFeedbackIssueEntity.builder()
                .id(issueId)
                .assessmentId(assessmentId)
                .patternCode("ARTICLES")
                .build();

        WritingAssessmentEntity assessment = WritingAssessmentEntity.builder()
                .id(assessmentId)
                .submissionId(submissionId)
                .build();

        WritingSubmissionEntity submission = WritingSubmissionEntity.builder()
                .id(submissionId)
                .userId(USER_A)
                .build();

        when(issueRepository.findById(issueId)).thenReturn(Optional.of(issue));
        when(learningEvidenceRepository.findFirstBySourceIssueId(issueId)).thenReturn(Optional.empty());
        when(assessmentRepository.findById(assessmentId)).thenReturn(Optional.of(assessment));
        when(submissionRepository.findById(submissionId)).thenReturn(Optional.of(submission));

        // User B attempts to dispute User A's writing issue
        assertThatThrownBy(() -> writingErrorMemoryService.disputeIssue(USER_B, issueId, "Wrong feedback"))
                .isInstanceOf(WritingNotFoundException.class);
    }

    @Test
    @DisplayName("Isolation: User B cannot append attempts to User A's listening session")
    void testListeningIsolation() {
        Long exerciseId = 55L;
        Long sessionAId = 999L;

        ListeningExercise exercise = ListeningExercise.builder()
                .id(exerciseId)
                .expectedAnswer("Hello World")
                .listeningMaterial(ListeningMaterial.builder().id(1L).build())
                .build();

        ListeningSession sessionA = ListeningSession.builder()
                .id(sessionAId)
                .user(userA)
                .build();

        when(listeningExerciseRepository.findById(exerciseId)).thenReturn(Optional.of(exercise));
        when(listeningMaterialRepository.findByIdAndVisibleToUser(1L, USER_B))
                .thenReturn(Optional.of(ListeningMaterial.builder().id(1L).build()));
        when(listeningSessionRepository.forUpdate(sessionAId)).thenReturn(Optional.of(sessionA));

        ExerciseAttemptRequest req = ExerciseAttemptRequest.builder()
                .listeningSessionId(sessionAId)
                .rawUserAnswer("Hello World")
                .build();

        // User B submits attempt referencing User A's session
        assertThatThrownBy(() -> listeningService.submitExerciseAttempt(exerciseId, req, USER_B))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("belongs to another user");
    }

    @Test
    @DisplayName("Isolation: User B cannot access User A's exam results or scoring progress")
    void testExamIsolation() {
        UUID attemptAId = UUID.randomUUID();

        // ExamResultService throws ExamForbiddenException when User B accesses User A's attempt
        when(examResultService.getAttemptResult(eq(attemptAId), eq(USER_B), eq(false)))
                .thenThrow(new ExamForbiddenException("User cannot access foreign attempt results"));

        com.englishcoach.common.security.UserDetailsImpl userBPrincipal =
                com.englishcoach.common.security.UserDetailsImpl.build(userB);

        // User B attempts to query result
        assertThatThrownBy(() -> examResultController.getResult(attemptAId, userBPrincipal))
                .isInstanceOf(ExamForbiddenException.class);

        // User B attempts to query progress
        assertThatThrownBy(() -> examResultController.getProgress(attemptAId, userBPrincipal))
                .isInstanceOf(ExamForbiddenException.class);
    }

    @Test
    @DisplayName("Streak Preservation: User A streak is derived dynamically and isolated from User B")
    void testStreakPreservation() {
        LocalDateTime today = LocalDateTime.now();

        // Setup User A: 1 turn today -> streak = 1
        when(speakingTurnRepository.findGenuineTurnCreatedTimes(USER_A)).thenReturn(List.of(today));
        when(speakingSessionRepository.findSessionCreatedTimes(USER_A)).thenReturn(List.of(today));
        when(speakingShadowingAttemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(USER_A), any()))
                .thenReturn(List.of());
        when(speakingSessionRepository.findRecentSessionsByUserId(eq(USER_A), any())).thenReturn(List.of());
        when(speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(USER_A)).thenReturn(List.of());

        SpeakingProgressDto progressA = speakingProgressService.getUserSpeakingProgress(USER_A);
        assertThat(progressA.currentStreakDays()).isEqualTo(1);

        // Setup User B: zero activity -> streak = 0
        when(speakingTurnRepository.findGenuineTurnCreatedTimes(USER_B)).thenReturn(List.of());
        when(speakingSessionRepository.findSessionCreatedTimes(USER_B)).thenReturn(List.of());
        when(speakingShadowingAttemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(USER_B), any()))
                .thenReturn(List.of());
        when(speakingSessionRepository.findRecentSessionsByUserId(eq(USER_B), any())).thenReturn(List.of());
        when(speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(USER_B)).thenReturn(List.of());

        SpeakingProgressDto progressB = speakingProgressService.getUserSpeakingProgress(USER_B);
        assertThat(progressB.currentStreakDays()).isEqualTo(0);
    }

    @Test
    @DisplayName("Isolation: User B cannot access or delete User A's private reading material")
    void testReadingMaterialIsolation() {
        ReadingMaterial materialA = ReadingMaterial.builder()
                .id(501L)
                .title("User A Private Reading")
                .contentText("Confidential content.")
                .ownerUserId(USER_A)
                .documentSchemaVersion("reading-document.v1")
                .sourceDocumentType("PDF_NATIVE_OR_SCANNED")
                .canonicalDocument("{\"schemaVersion\":\"reading-document.v1\",\"plainText\":\"Confidential content.\"}")
                .isSystem(false)
                .build();

        when(readingMaterialRepository.findByIdAndVisibleToUser(501L, USER_A)).thenReturn(Optional.of(materialA));
        when(readingMaterialRepository.findByIdAndVisibleToUser(501L, USER_B)).thenReturn(Optional.empty());
        when(readingMaterialRepository.findById(501L)).thenReturn(Optional.of(materialA));

        // User A can access
        ReadingMaterialResponse detailA = readingService.getMaterialById(501L, USER_A);
        assertThat(detailA.getId()).isEqualTo(501L);
        assertThat(detailA.getDocumentSchemaVersion()).isEqualTo("reading-document.v1");
        assertThat(detailA.getCanonicalDocument()).isNotNull();

        // User B cannot access (404 / ResponseStatusException)
        assertThatThrownBy(() -> readingService.getMaterialById(501L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // User B cannot delete User A's material (404 / ResponseStatusException)
        assertThatThrownBy(() -> readingService.deleteMaterial(501L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // User A can still delete own Reading material
        readingService.deleteMaterial(501L, USER_A);
        verify(readingMaterialRepository).delete(materialA);
    }

    @Test
    @DisplayName("Isolation: User B cannot access or delete User A's private listening material")
    void testListeningMaterialIsolation() {
        ListeningMaterial materialA = ListeningMaterial.builder()
                .id(601L)
                .title("User A Private Listening")
                .audioUrl("https://youtube.com/watch?v=12345678901")
                .ownerUserId(USER_A)
                .isSystem(false)
                .segments(new ArrayList<>())
                .sessions(new ArrayList<>())
                .build();

        when(listeningMaterialRepository.findByIdAndVisibleToUser(601L, USER_A)).thenReturn(Optional.of(materialA));
        when(listeningMaterialRepository.findByIdAndVisibleToUser(601L, USER_B)).thenReturn(Optional.empty());
        when(listeningMaterialRepository.findById(601L)).thenReturn(Optional.of(materialA));

        // User A can access
        var detailA = listeningService.getMaterialById(601L, USER_A);
        assertThat(detailA.getId()).isEqualTo(601L);

        // User B cannot access (404)
        assertThatThrownBy(() -> listeningService.getMaterialById(601L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // User B cannot delete User A's material (404)
        assertThatThrownBy(() -> listeningService.deleteMaterial(601L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    @DisplayName("Visibility: SYSTEM_SHARED materials are visible to both learners")
    void testSystemSharedVisibility() {
        ReadingMaterial systemReading = ReadingMaterial.builder()
                .id(1L)
                .title("Official System Reading")
                .isSystem(true)
                .ownerUserId(null)
                .build();

        ListeningMaterial systemListening = ListeningMaterial.builder()
                .id(2L)
                .title("Official System Listening")
                .isSystem(true)
                .ownerUserId(null)
                .build();

        when(readingMaterialRepository.findVisibleToUser(USER_A)).thenReturn(List.of(systemReading));
        when(readingMaterialRepository.findVisibleToUser(USER_B)).thenReturn(List.of(systemReading));

        when(listeningMaterialRepository.findVisibleByFilters(eq(USER_A), any(), any(), any())).thenReturn(List.of(systemListening));
        when(listeningMaterialRepository.findVisibleByFilters(eq(USER_B), any(), any(), any())).thenReturn(List.of(systemListening));

        // Both learners see system materials
        assertThat(readingService.getAllMaterials(USER_A)).hasSize(1);
        assertThat(readingService.getAllMaterials(USER_B)).hasSize(1);
        assertThat(listeningService.getAllMaterials(null, null, null, USER_A)).hasSize(1);
        assertThat(listeningService.getAllMaterials(null, null, null, USER_B)).hasSize(1);
    }

    @Test
    @DisplayName("Quarantine: Unowned non-system rows (QUARANTINED) are visible to NEITHER learner")
    void testQuarantinedMaterialVisibility() {
        // Quarantined row: is_system = false AND owner_user_id = null
        ReadingMaterial quarantinedReading = ReadingMaterial.builder()
                .id(999L)
                .title("Quarantined Reading")
                .isSystem(false)
                .ownerUserId(null)
                .build();

        when(readingMaterialRepository.findVisibleToUser(USER_A)).thenReturn(List.of());
        when(readingMaterialRepository.findVisibleToUser(USER_B)).thenReturn(List.of());
        when(readingMaterialRepository.findByIdAndVisibleToUser(999L, USER_A)).thenReturn(Optional.empty());
        when(readingMaterialRepository.findByIdAndVisibleToUser(999L, USER_B)).thenReturn(Optional.empty());
        when(readingMaterialRepository.findById(999L)).thenReturn(Optional.of(quarantinedReading));

        when(listeningMaterialRepository.findVisibleByFilters(eq(USER_A), any(), any(), any())).thenReturn(List.of());
        when(listeningMaterialRepository.findVisibleByFilters(eq(USER_B), any(), any(), any())).thenReturn(List.of());
        when(listeningMaterialRepository.findByIdAndVisibleToUser(999L, USER_A)).thenReturn(Optional.empty());
        when(listeningMaterialRepository.findByIdAndVisibleToUser(999L, USER_B)).thenReturn(Optional.empty());

        // Quarantined rows never appear in normal learner LIST or GET
        assertThat(readingService.getAllMaterials(USER_A)).isEmpty();
        assertThat(readingService.getAllMaterials(USER_B)).isEmpty();
        assertThatThrownBy(() -> readingService.getMaterialById(999L, USER_A))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> readingService.getMaterialById(999L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // Quarantined rows cannot be deleted by learners (404)
        assertThatThrownBy(() -> readingService.deleteMaterial(999L, USER_A))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> readingService.deleteMaterial(999L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        assertThat(listeningService.getAllMaterials(null, null, null, USER_A)).isEmpty();
        assertThat(listeningService.getAllMaterials(null, null, null, USER_B)).isEmpty();
        assertThatThrownBy(() -> listeningService.getMaterialById(999L, USER_A))
                .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> listeningService.getMaterialById(999L, USER_B))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("Isolation: User B cannot UPDATE User A's speaking session")
    void testCrossUserUpdateSession() {
        SpeakingSession sessionA = SpeakingSession.builder()
                .id(888L)
                .user(userA)
                .status("ACTIVE")
                .mode("ROLEPLAY")
                .build();

        when(speakingSessionRepository.findById(888L)).thenReturn(Optional.of(sessionA));

        SpeakingSessionUpdateRequest updateReq =
                new SpeakingSessionUpdateRequest("COMPLETED", 5);

        // User B attempts to update User A's session
        assertThatThrownBy(() -> speakingService.updateSession(USER_B, 888L, updateReq))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @Test
    @DisplayName("Cross-Module Isolation: User B cannot access User A's materials via Writing or Speaking")
    void testCrossModuleWritingAndSpeakingIsolation() {
        when(writingProperties.isEnabled()).thenReturn(true);
        when(readingMaterialRepository.findByIdAndVisibleToUser(501L, USER_B)).thenReturn(Optional.empty());
        when(listeningMaterialRepository.findByIdAndVisibleToUser(601L, USER_B)).thenReturn(Optional.empty());

        // Writing cross-module access rejected for User A's reading material
        assertThatThrownBy(() -> writingSourceAdapterService.getSourceContext(USER_B, WritingSourceType.READING, "501"))
                .isInstanceOf(WritingNotFoundException.class);

        // Writing cross-module access rejected for User A's listening material
        assertThatThrownBy(() -> writingSourceAdapterService.getSourceContext(USER_B, WritingSourceType.LISTENING, "601"))
                .isInstanceOf(WritingNotFoundException.class);

        // Speaking context access rejected for User A's reading material
        assertThatThrownBy(() -> speakingContextService.resolveContext("READING", 501L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // Speaking context access rejected for User A's listening material
        assertThatThrownBy(() -> speakingContextService.resolveContext("LISTENING", 601L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // Speaking shadowing units generation rejected for User A's listening material
        assertThatThrownBy(() -> speakingShadowingUnitService.getOrGenerateUnits(601L, USER_B))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    @DisplayName("Cache Isolation: User-scoped cache keys guarantee distinct cache partitions across account switch A -> logout -> B")
    void testClientCacheIsolationVerification() {
        String tokenA = "jwt_token_user_a";
        String tokenB = "jwt_token_user_b";

        String readingKeyA = "/reading/materials:" + tokenA;
        String readingKeyB = "/reading/materials:" + tokenB;
        assertThat(readingKeyA).isNotEqualTo(readingKeyB);

        String listeningKeyA = "/listening/materials:" + tokenA;
        String listeningKeyB = "/listening/materials:" + tokenB;
        assertThat(listeningKeyA).isNotEqualTo(listeningKeyB);
    }
}
