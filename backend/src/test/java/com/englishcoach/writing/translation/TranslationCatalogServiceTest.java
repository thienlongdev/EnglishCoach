package com.englishcoach.writing.translation;

import com.englishcoach.writing.translation.dto.TranslationCatalogResponse;
import com.englishcoach.writing.translation.dto.TranslationCollectionDto;
import com.englishcoach.writing.translation.dto.TranslationDifficultyDto;
import com.englishcoach.writing.translation.entity.TranslationExerciseEntity;
import com.englishcoach.writing.translation.entity.TranslationExerciseUnitEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionEntity;
import com.englishcoach.writing.translation.repository.TranslationExerciseRepository;
import com.englishcoach.writing.translation.repository.TranslationExerciseUnitRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionRepository;
import com.englishcoach.writing.translation.service.TranslationCatalogService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TranslationCatalogServiceTest {

    @Mock
    private TranslationExerciseRepository exerciseRepository;

    @Mock
    private TranslationSessionRepository sessionRepository;

    @Mock
    private TranslationExerciseUnitRepository unitRepository;

    private TranslationCatalogService catalogService;

    @BeforeEach
    void setUp() {
        catalogService = new TranslationCatalogService(exerciseRepository, sessionRepository, unitRepository);
    }

    @Test
    void testGetCatalog_MapsFoundationToCoBanAndCoreToNangCao_PreservingInternalCodes() {
        UUID foundationExId = UUID.randomUUID();
        UUID coreExId = UUID.randomUUID();

        List<Object[]> eligibleRows = new ArrayList<>();
        eligibleRows.add(new Object[]{foundationExId, "EDUCATION", "FOUNDATION", 2L, 20L});
        eligibleRows.add(new Object[]{coreExId, "TECHNOLOGY", "CORE", 3L, 30L});
        when(exerciseRepository.findEligibleTopicPools()).thenReturn(eligibleRows);

        TranslationCatalogResponse catalog = catalogService.getCatalog(null);

        assertNotNull(catalog);
        assertEquals(2, catalog.getDifficulties().size());

        TranslationDifficultyDto foundationDiff = catalog.getDifficulties().get(0);
        assertEquals("FOUNDATION", foundationDiff.getCode());
        assertEquals("Cơ bản", foundationDiff.getDisplayName());
        assertEquals(20L, foundationDiff.getCount());

        TranslationDifficultyDto coreDiff = catalog.getDifficulties().get(1);
        assertEquals("CORE", coreDiff.getCode());
        assertEquals("Nâng cao", coreDiff.getDisplayName());
        assertEquals(30L, coreDiff.getCount());

        assertEquals(2, catalog.getCollections().size());
        TranslationCollectionDto foundationCol = catalog.getCollections().get(0);
        assertEquals("FOUNDATION", foundationCol.getDifficultyBucket());
        assertEquals("Cơ bản", foundationCol.getDifficultyDisplayName());

        TranslationCollectionDto coreCol = catalog.getCollections().get(1);
        assertEquals("CORE", coreCol.getDifficultyBucket());
        assertEquals("Nâng cao", coreCol.getDifficultyDisplayName());

        assertTrue(catalog.getDifficulties().stream().noneMatch(d -> "Cốt lõi".equals(d.getDisplayName())));
        assertTrue(catalog.getCollections().stream().noneMatch(c -> "Cốt lõi".equals(c.getDifficultyDisplayName())));
    }

    @Test
    void testGetCatalog_ActiveSessionPreservesCoreDifficultyBucketCode() {
        Long userId = 7L;
        UUID sessionId = UUID.randomUUID();
        UUID exerciseId = UUID.randomUUID();

        List<Object[]> eligibleRows = new ArrayList<>();
        eligibleRows.add(new Object[]{exerciseId, "TECHNOLOGY", "CORE", 1L, 10L});
        when(exerciseRepository.findEligibleTopicPools()).thenReturn(eligibleRows);

        TranslationSessionEntity session = TranslationSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .exerciseId(exerciseId)
                .status("ACTIVE")
                .currentOrdinal((short) 3)
                .sessionRevision(2L)
                .updatedAt(Instant.now())
                .build();
        when(sessionRepository.findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE"))
                .thenReturn(Optional.of(session));

        TranslationExerciseEntity exercise = TranslationExerciseEntity.builder()
                .id(exerciseId)
                .mode("SENTENCE")
                .topicCode("TECHNOLOGY")
                .difficultyBucket("CORE")
                .build();
        when(exerciseRepository.findById(exerciseId)).thenReturn(Optional.of(exercise));
        when(unitRepository.findByExerciseIdOrderByOrdinalAsc(exerciseId))
                .thenReturn(List.of(
                        TranslationExerciseUnitEntity.builder().ordinal((short) 1).build(),
                        TranslationExerciseUnitEntity.builder().ordinal((short) 2).build(),
                        TranslationExerciseUnitEntity.builder().ordinal((short) 3).build()
                ));

        TranslationCatalogResponse catalog = catalogService.getCatalog(userId);

        assertNotNull(catalog.getActiveSession());
        assertEquals(sessionId, catalog.getActiveSession().getSessionId());
        assertEquals("CORE", catalog.getActiveSession().getDifficultyBucket());
    }
}
