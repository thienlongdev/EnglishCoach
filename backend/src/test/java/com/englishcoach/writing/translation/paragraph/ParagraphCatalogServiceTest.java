package com.englishcoach.writing.translation.paragraph;

import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphPassageRepository;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionRepository;
import com.englishcoach.writing.translation.paragraph.service.ParagraphCatalogService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ParagraphCatalogServiceTest {

    @Mock
    private TranslationParagraphPassageRepository passageRepository;

    @Mock
    private TranslationParagraphSessionRepository sessionRepository;

    private ParagraphCatalogService catalogService;

    @BeforeEach
    void setUp() {
        catalogService = new ParagraphCatalogService(passageRepository, sessionRepository);
        catalogService.setParagraphModeEnabled(false); // default safe disabled
    }

    @Test
    void testCatalog_DerivesRealAggregates_WithoutFakeIeltsBandsOrFakeGenres() {
        // Arrange
        when(passageRepository.countEligiblePassages()).thenReturn(148L);

        List<Object[]> genreCounts = new ArrayList<>();
        genreCounts.add(new Object[]{"GENERAL", 148L});
        when(passageRepository.findEligibleGenreCounts()).thenReturn(genreCounts);

        List<Object[]> topicCounts = new ArrayList<>();
        topicCounts.add(new Object[]{"TECHNOLOGY", 58L});
        topicCounts.add(new Object[]{"GENERAL", 30L});
        topicCounts.add(new Object[]{"SOCIETY", 20L});
        when(passageRepository.findEligibleTopicCounts()).thenReturn(topicCounts);

        // Act
        ParagraphCatalogResponse catalog = catalogService.getCatalog(null);

        // Assert
        assertNotNull(catalog);
        assertFalse(catalog.getEnabled(), "Paragraph mode must be disabled by default");
        assertEquals(148L, catalog.getTotalEligiblePassages());

        // Genre checks: Only GENERAL with count 148
        assertEquals(1, catalog.getAvailableGenres().size());
        ParagraphGenreCountDto genreDto = catalog.getAvailableGenres().get(0);
        assertEquals("GENERAL", genreDto.getGenre());
        assertEquals(148L, genreDto.getCount());
        assertFalse(genreDto.getChallenge());

        // Verify NO fake genres (Academic, News, etc.) are present
        assertTrue(catalog.getAvailableGenres().stream().noneMatch(g -> "ACADEMIC".equals(g.getGenre())));
        assertTrue(catalog.getAvailableGenres().stream().noneMatch(g -> "NEWS".equals(g.getGenre())));

        // Difficulty checks: UNCALIBRATED, never fake IELTS band
        assertNotNull(catalog.getDifficulty());
        assertEquals("UNCALIBRATED", catalog.getDifficulty().getStatus());
        assertFalse(catalog.getDifficulty().getCalibrated());
        assertEquals(148L, catalog.getDifficulty().getCount());

        // Topics check
        assertEquals(3, catalog.getTopics().size());
        assertEquals("TECHNOLOGY", catalog.getTopics().get(0).getTopic());
        assertEquals(58L, catalog.getTopics().get(0).getCount());

        // Unauthenticated -> activeSession is null
        assertNull(catalog.getActiveSession());
    }

    @Test
    void testCatalog_WithAuthenticatedUser_ReturnsActiveSessionSummary() {
        // Arrange
        Long userId = 42L;
        UUID sessionId = UUID.randomUUID();
        when(passageRepository.countEligiblePassages()).thenReturn(148L);

        List<Object[]> genreCounts = new ArrayList<>();
        genreCounts.add(new Object[]{"GENERAL", 148L});
        when(passageRepository.findEligibleGenreCounts()).thenReturn(genreCounts);
        when(passageRepository.findEligibleTopicCounts()).thenReturn(Collections.emptyList());

        TranslationParagraphSessionEntity activeSession = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .currentIndex(2)
                .totalItems(5)
                .filterGenre("GENERAL")
                .filterTopic("TECHNOLOGY")
                .updatedAt(Instant.now())
                .build();
        when(sessionRepository.findFirstByUserIdAndStatusInOrderByUpdatedAtDesc(userId, List.of("ACTIVE", "IN_PROGRESS")))
                .thenReturn(Optional.of(activeSession));

        // Act
        ParagraphCatalogResponse catalog = catalogService.getCatalog(userId);

        // Assert
        assertNotNull(catalog.getActiveSession());
        assertEquals(sessionId, catalog.getActiveSession().getSessionId());
        assertEquals(2, catalog.getActiveSession().getCurrentIndex());
        assertEquals(5, catalog.getActiveSession().getTotalItems());
        assertEquals("GENERAL", catalog.getActiveSession().getFilterGenre());
        assertEquals("TECHNOLOGY", catalog.getActiveSession().getFilterTopic());
    }

    @Test
    void testFeatureFlag_EnablingAffectsCatalogResponse() {
        catalogService.setParagraphModeEnabled(true);
        when(passageRepository.countEligiblePassages()).thenReturn(148L);
        when(passageRepository.findEligibleGenreCounts()).thenReturn(Collections.emptyList());
        when(passageRepository.findEligibleTopicCounts()).thenReturn(Collections.emptyList());

        ParagraphCatalogResponse catalog = catalogService.getCatalog(null);
        assertTrue(catalog.getEnabled());
    }
}
