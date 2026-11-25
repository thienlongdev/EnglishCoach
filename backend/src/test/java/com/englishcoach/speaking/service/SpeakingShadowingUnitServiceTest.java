package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.speaking.config.SpeakingShadowingSchemaRepair;
import com.englishcoach.speaking.dto.ShadowingSegmentProgressDto;
import com.englishcoach.speaking.dto.SpeakingShadowingUnitDto;
import com.englishcoach.speaking.entity.ShadowingTimingQuality;
import com.englishcoach.speaking.entity.ShadowingTimingStrategy;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingShadowingUnitServiceTest {

    @Mock private SpeakingShadowingUnitRepository unitRepository;
    @Mock private ListeningMaterialRepository materialRepository;
    @Mock private TranscriptSegmentRepository segmentRepository;
    @Mock private SpeakingShadowingAttemptRepository attemptRepository;
    @Mock private SpeakingShadowingSchemaRepair schemaRepair;
    @Spy private CanonicalTranscriptReconstructor reconstructor = new CanonicalTranscriptReconstructor();
    @InjectMocks private SpeakingShadowingUnitService unitService;

    private ListeningMaterial sampleMaterial;

    @BeforeEach
    void setUp() {
        sampleMaterial = ListeningMaterial.builder()
                .id(10L)
                .title("Sample Shadowing Lesson")
                .durationSeconds(10)
                .build();
    }

    @Test
    @DisplayName("Returns current generation and unit-keyed progress without locking or writing")
    void returnsExistingCurrentGeneration() {
        SpeakingShadowingUnit existing = unit(100L, 3, 1, "Pre-existing current unit.");
        when(materialRepository.findByIdAndVisibleToUser(eq(10L), any())).thenReturn(Optional.of(sampleMaterial));
        when(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(10L, 3))
                .thenReturn(List.of(existing));
        when(attemptRepository.getUnitProgressByMaterial(1L, 10L, 3))
                .thenReturn(List.of(new ShadowingSegmentProgressDto(100L, 2L, 95.0)));

        List<SpeakingShadowingUnitDto> result = unitService.getOrGenerateUnits(10L, 1L);

        assertThat(result).singleElement().satisfies(dto -> {
            assertThat(dto.id()).isEqualTo(100L);
            assertThat(dto.generationVersion()).isEqualTo(3);
            assertThat(dto.attemptCount()).isEqualTo(2L);
        });
        verify(materialRepository, never()).findByIdForShadowingGeneration(anyLong());
        verify(unitRepository, never()).saveAllAndFlush(anyList());
    }

    @Test
    @DisplayName("Lazy generation keeps prior positive sequences and remaps exact attempts")
    void lazilyGeneratesAndRemapsExactAttempts() {
        TranscriptSegment segment = TranscriptSegment.builder()
                .id(50L).listeningMaterial(sampleMaterial).startTimeMs(500).endTimeMs(3500)
                .text("Canonical practice sentence.").build();
        SpeakingShadowingUnit prior = unit(99L, 2, 1, "Canonical practice sentence.");

        when(materialRepository.findByIdAndVisibleToUser(eq(10L), any())).thenReturn(Optional.of(sampleMaterial));
        when(materialRepository.findByIdForShadowingGeneration(10L)).thenReturn(Optional.of(sampleMaterial));
        when(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(10L, 3))
                .thenReturn(List.of(), List.of());
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(10L)).thenReturn(List.of(segment));
        when(unitRepository.findByMaterialIdOrderBySequenceNumberAsc(10L)).thenReturn(List.of(prior));
        when(unitRepository.saveAllAndFlush(anyList())).thenAnswer(invocation -> {
            List<SpeakingShadowingUnit> saved = invocation.getArgument(0);
            saved.get(0).setId(200L);
            return saved;
        });
        when(attemptRepository.remapUnitAttempts(eq(prior), any(SpeakingShadowingUnit.class))).thenReturn(1);

        List<SpeakingShadowingUnitDto> result = unitService.getOrGenerateUnits(10L, null);

        assertThat(result).singleElement().satisfies(dto -> {
            assertThat(dto.displayText()).isEqualTo("Canonical practice sentence.");
            assertThat(dto.generationVersion()).isEqualTo(3);
            assertThat(dto.sequenceNumber()).isEqualTo(1);
            assertThat(dto.timingQuality()).isEqualTo(ShadowingTimingQuality.APPROXIMATE);
        });
        assertThat(prior.getSequenceNumber()).isEqualTo(1);
        verify(attemptRepository).remapUnitAttempts(eq(prior), any(SpeakingShadowingUnit.class));
    }

    @Test
    @DisplayName("A same-material waiter rechecks after the lock and performs zero duplicate writes")
    void rechecksAfterMaterialLock() {
        SpeakingShadowingUnit generatedByFirstRequest = unit(200L, 3, 1, "Already generated.");
        when(materialRepository.findByIdAndVisibleToUser(eq(10L), any())).thenReturn(Optional.of(sampleMaterial));
        when(materialRepository.findByIdForShadowingGeneration(10L)).thenReturn(Optional.of(sampleMaterial));
        when(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(10L, 3))
                .thenReturn(List.of(), List.of(generatedByFirstRequest));

        List<SpeakingShadowingUnitDto> result = unitService.getOrGenerateUnits(10L, null);

        assertThat(result).singleElement().extracting(SpeakingShadowingUnitDto::id).isEqualTo(200L);
        verify(unitRepository, never()).saveAllAndFlush(anyList());
        verify(segmentRepository, never()).findByListeningMaterialIdOrderByStartTimeMsAsc(anyLong());
    }

    @Test
    @DisplayName("Only exact sequence and text matches remap attempts")
    void leavesAmbiguousAttemptsHistorical() {
        TranscriptSegment segment = TranscriptSegment.builder()
                .id(50L).listeningMaterial(sampleMaterial).startTimeMs(0).endTimeMs(2000)
                .text("New canonical text.").build();
        SpeakingShadowingUnit prior = unit(99L, 2, 1, "Different historical text.");
        when(materialRepository.findByIdAndVisibleToUser(eq(10L), any())).thenReturn(Optional.of(sampleMaterial));
        when(materialRepository.findByIdForShadowingGeneration(10L)).thenReturn(Optional.of(sampleMaterial));
        when(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(10L, 3))
                .thenReturn(List.of(), List.of());
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(10L)).thenReturn(List.of(segment));
        when(unitRepository.findByMaterialIdOrderBySequenceNumberAsc(10L)).thenReturn(List.of(prior));
        when(unitRepository.saveAllAndFlush(anyList())).thenAnswer(invocation -> invocation.getArgument(0));

        unitService.getOrGenerateUnits(10L, null);

        verify(attemptRepository, never()).remapUnitAttempts(any(), any());
    }

    private SpeakingShadowingUnit unit(Long id, int generation, int sequence, String text) {
        return SpeakingShadowingUnit.builder()
                .id(id).material(sampleMaterial).sequenceNumber(sequence)
                .startTimeMs(0).endTimeMs(3000).displayText(text)
                .generationVersion(generation)
                .timingQuality(ShadowingTimingQuality.APPROXIMATE)
                .timingStrategy(ShadowingTimingStrategy.DISCRETE_CAPTION_WINDOWS)
                .build();
    }
}
