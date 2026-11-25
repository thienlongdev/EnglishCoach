package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.dashboard.controller.DashboardController;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.controller.FlashcardController;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.springframework.http.ResponseEntity;

import java.time.LocalDateTime;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class FlashcardDueReviewTest {

    @Mock
    private FlashcardRepository flashcardRepository;
    @Mock
    private UserRepository userRepository;
    @Mock
    private DictionaryRepository dictionaryRepository;

    private FlashcardService flashcardService;
    private User testUser;
    private final Long USER_ID = 101L;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        AnkiNoteParser ankiNoteParser = new AnkiNoteParser();
        flashcardService = new FlashcardService(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser);

        testUser = User.builder().id(USER_ID).email("learner@test.com").build();
        when(userRepository.findById(USER_ID)).thenReturn(Optional.of(testUser));
    }

    @Test
    @DisplayName("Rating 'hard' or 'Khó' sets nextReviewDate <= now() so card immediately remains due today")
    void testRatingHardKeepsCardDueToday() {
        DictionaryEntry entry = DictionaryEntry.builder().id(1L).word("ubiquitous").build();
        Flashcard card = Flashcard.builder()
                .id(10L)
                .user(testUser)
                .dictionaryEntry(entry)
                .status("MASTERED")
                .reviewCount(5)
                .nextReviewDate(LocalDateTime.now().minusDays(1))
                .build();

        when(flashcardRepository.findOwnedForUpdate(10L, USER_ID)).thenReturn(Optional.of(card));
        when(flashcardRepository.saveAndFlush(any(Flashcard.class))).thenAnswer(invocation -> invocation.getArgument(0));

        LocalDateTime beforeReview = LocalDateTime.now();

        // 1. Test "hard"
        Flashcard reviewedHard = flashcardService.reviewFlashcard(USER_ID, 10L, "hard");
        assertThat(reviewedHard.getReviewCount()).isEqualTo(6);
        assertThat(reviewedHard.getStatus()).isEqualTo("LEARNED");
        assertThat(reviewedHard.getNextReviewDate()).isBeforeOrEqualTo(LocalDateTime.now());
        assertThat(reviewedHard.getNextReviewDate()).isBeforeOrEqualTo(beforeReview.plusSeconds(1));

        // 2. Test Vietnamese "Khó"
        Flashcard reviewedKho = flashcardService.reviewFlashcard(USER_ID, 10L, "Khó");
        assertThat(reviewedKho.getStatus()).isEqualTo("LEARNED");
        assertThat(reviewedKho.getNextReviewDate()).isBeforeOrEqualTo(LocalDateTime.now());

        // 3. Test numeric grade "1"
        Flashcard reviewedGrade1 = flashcardService.reviewFlashcard(USER_ID, 10L, "1");
        assertThat(reviewedGrade1.getStatus()).isEqualTo("LEARNED");
        assertThat(reviewedGrade1.getNextReviewDate()).isBeforeOrEqualTo(LocalDateTime.now());
    }

    @Test
    @DisplayName("Rating 'good' and 'easy' correctly push next review date into the future")
    void testRatingGoodAndEasyPushDates() {
        DictionaryEntry entry = DictionaryEntry.builder().id(2L).word("resilience").build();
        Flashcard card = Flashcard.builder()
                .id(20L)
                .user(testUser)
                .dictionaryEntry(entry)
                .status("LEARNED")
                .reviewCount(1)
                .nextReviewDate(LocalDateTime.now().minusHours(2))
                .build();

        when(flashcardRepository.findOwnedForUpdate(20L, USER_ID)).thenReturn(Optional.of(card));
        when(flashcardRepository.saveAndFlush(any(Flashcard.class))).thenAnswer(invocation -> invocation.getArgument(0));

        // "good" -> +3 days
        Flashcard reviewedGood = flashcardService.reviewFlashcard(USER_ID, 20L, "good");
        assertThat(reviewedGood.getNextReviewDate()).isAfter(LocalDateTime.now().plusDays(2));

        // "easy" -> +7 days and MASTERED
        Flashcard reviewedEasy = flashcardService.reviewFlashcard(USER_ID, 20L, "easy");
        assertThat(reviewedEasy.getStatus()).isEqualTo("MASTERED");
        assertThat(reviewedEasy.getNextReviewDate()).isAfter(LocalDateTime.now().plusDays(6));
    }

    @Test
    @DisplayName("getDueCount applies dailyReviewLimit cap sanity correctly")
    void testDailyReviewLimitCapSanity() {
        // When actual due count is 35 (> default 20), capped count is 20
        when(flashcardRepository.countDueByUserId(USER_ID)).thenReturn(35L);
        long cappedDue = flashcardService.getDueCount(USER_ID, null);
        assertThat(cappedDue).isEqualTo(20L);
        assertThat(flashcardService.countActualDue(USER_ID)).isEqualTo(35L);

        // When actual due count is 8 (< default 20), capped count is 8
        when(flashcardRepository.countDueByUserId(USER_ID)).thenReturn(8L);
        long lowDue = flashcardService.getDueCount(USER_ID, 20);
        assertThat(lowDue).isEqualTo(8L);

        // Custom daily limit: limit = 10, actual = 15 -> capped = 10
        when(flashcardRepository.countDueByUserId(USER_ID)).thenReturn(15L);
        long customLimitDue = flashcardService.getDueCount(USER_ID, 10);
        assertThat(customLimitDue).isEqualTo(10L);
    }

    @Test
    @DisplayName("FlashcardController /due-count endpoint returns capped and actual count")
    void testFlashcardControllerDueCount() {
        when(flashcardRepository.countDueByUserId(USER_ID)).thenReturn(42L);

        FlashcardController controller = new FlashcardController(flashcardService);
        UserDetailsImpl userDetails = new UserDetailsImpl(USER_ID, "learner@test.com", "pass", Collections.emptyList());

        ResponseEntity<Map<String, Object>> response = controller.getDueCount(userDetails, 20);
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("dueCount")).isEqualTo(20L);
        assertThat(response.getBody().get("actualDueCount")).isEqualTo(42L);
        assertThat(response.getBody().get("dailyReviewLimit")).isEqualTo(20);
    }

    @Test
    @DisplayName("DashboardController /stats endpoint returns dueCount with limit cap")
    void testDashboardControllerStats() {
        when(flashcardRepository.countDueByUserId(USER_ID)).thenReturn(14L);

        DashboardController controller = new DashboardController(flashcardService);
        UserDetailsImpl userDetails = new UserDetailsImpl(USER_ID, "learner@test.com", "pass", Collections.emptyList());

        ResponseEntity<Map<String, Object>> response = controller.getDashboardStats(userDetails, 20);
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("dueCount")).isEqualTo(14L);
        assertThat(response.getBody().get("actualDueCount")).isEqualTo(14L);
    }
}
