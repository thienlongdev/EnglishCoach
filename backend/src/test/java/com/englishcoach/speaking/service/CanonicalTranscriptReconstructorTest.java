package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.speaking.entity.ShadowingTimingQuality;
import com.englishcoach.speaking.entity.ShadowingTimingStrategy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CanonicalTranscriptReconstructorTest {

    private final CanonicalTranscriptReconstructor reconstructor = new CanonicalTranscriptReconstructor();
    private final ListeningMaterial material = ListeningMaterial.builder().id(13L).build();

    @Test
    @DisplayName("Material 13 fixture preserves 'until you woke up' across overlapping source windows")
    void reconstructsMaterial13OpeningExactly() {
        TranscriptSegment first = segment(
                547L,
                0,
                3920,
                "This morning, a machine screamed at you",
                "[{\"word\":\"This\",\"start\":0.0,\"end\":0.56},"
                        + "{\"word\":\"morning,\",\"start\":0.56,\"end\":1.12},"
                        + "{\"word\":\"a\",\"start\":1.12,\"end\":1.68},"
                        + "{\"word\":\"machine\",\"start\":1.68,\"end\":2.24},"
                        + "{\"word\":\"screamed\",\"start\":2.24,\"end\":2.8},"
                        + "{\"word\":\"at\",\"start\":2.8,\"end\":3.36},"
                        + "{\"word\":\"you\",\"start\":3.36,\"end\":3.92}]"
        );
        TranscriptSegment second = segment(
                548L,
                1960,
                5840,
                "until you woke up.",
                "[{\"word\":\"until\",\"start\":1.96,\"end\":2.93},"
                        + "{\"word\":\"you\",\"start\":2.93,\"end\":3.90},"
                        + "{\"word\":\"woke\",\"start\":3.90,\"end\":4.87},"
                        + "{\"word\":\"up.\",\"start\":4.87,\"end\":5.84}]"
        );

        CanonicalTranscriptReconstructor.ReconstructionResult result = reconstructor.reconstruct(List.of(second, first), 6);

        assertThat(result.units()).singleElement().extracting(
                CanonicalTranscriptReconstructor.ReconstructedUnit::displayText
        ).isEqualTo("This morning, a machine screamed at you until you woke up.");
        assertThat(result.inputTokenCount()).isEqualTo(11);
        assertThat(result.removedOverlapTokenCount()).isZero();
        assertThat(result.canonicalTokenCount()).isEqualTo(11);
        assertThat(result.timingQualityCounts())
                .containsEntry(ShadowingTimingDeriver.WordTimingQuality.SYNTHETIC_WORD_TIMING, 2L);
        CanonicalTranscriptReconstructor.ReconstructedUnit unit = result.units().get(0);
        assertThat(unit.endTimeMs() - unit.startTimeMs()).isGreaterThan(1_200);
        assertThat(unit.referenceWpm()).isBetween(40.0, 300.0);
        assertThat(unit.timingStrategy()).isEqualTo(ShadowingTimingStrategy.ROLLING_CAPTION_HOPS);
    }

    @Test
    @DisplayName("Token accounting removes only a proven multi-token suffix-prefix overlap")
    void preservesAllCanonicalTokensExceptDeliberateOverlap() {
        TranscriptSegment first = segment(1L, 0, 2500, "We need to leave now", null);
        TranscriptSegment second = segment(2L, 1500, 4200, "leave now before sunset.", null);

        CanonicalTranscriptReconstructor.ReconstructionResult result = reconstructor.reconstruct(List.of(first, second));

        assertThat(result.canonicalText()).isEqualTo("We need to leave now before sunset.");
        assertThat(result.inputTokenCount()).isEqualTo(9);
        assertThat(result.removedOverlapTokenCount()).isEqualTo(2);
        assertThat(result.canonicalTokenCount()).isEqualTo(7);
        assertThat(result.inputTokenCount() - result.removedOverlapTokenCount())
                .isEqualTo(result.canonicalTokenCount());
    }

    @Test
    @DisplayName("A one-token suffix-prefix identity is ambiguous and must not be deleted")
    void doesNotDeduplicateSingleTokenOverlap() {
        TranscriptSegment first = segment(1L, 0, 1600, "I told you", null);
        TranscriptSegment second = segment(2L, 800, 2600, "you should leave.", null);

        CanonicalTranscriptReconstructor.ReconstructionResult result = reconstructor.reconstruct(List.of(first, second));

        assertThat(result.canonicalText()).isEqualTo("I told you you should leave.");
        assertThat(result.canonicalText()).isNotEqualTo("I told you should leave.");
        assertThat(result.removedOverlapTokenCount()).isZero();
    }

    @Test
    @DisplayName("Natural punctuation handles numbers and honorific abbreviations")
    void respectsNumbersAndAbbreviations() {
        TranscriptSegment source = segment(
                1L,
                0,
                5000,
                "The cost was 50,000 dollars. Dr. Smith agreed!",
                null
        );

        CanonicalTranscriptReconstructor.ReconstructionResult result = reconstructor.reconstruct(List.of(source));

        assertThat(result.units()).extracting(CanonicalTranscriptReconstructor.ReconstructedUnit::displayText)
                .containsExactly("The cost was 50,000 dollars.", "Dr. Smith agreed!");
        assertThat(result.units().get(0).endTimeMs()).isLessThanOrEqualTo(result.units().get(1).startTimeMs());
    }

    @Test
    @DisplayName("Non-uniform acoustic word timings are classified as real but remain lexically irrelevant")
    void classifiesNonUniformTimingAsReal() {
        TranscriptSegment source = segment(
                1L,
                0,
                3000,
                "Real timing sample",
                "[{\"word\":\"Real\",\"start\":0.0,\"end\":0.4},"
                        + "{\"word\":\"timing\",\"start\":0.7,\"end\":1.8},"
                        + "{\"word\":\"sample\",\"start\":2.2,\"end\":3.0}]"
        );

        assertThat(reconstructor.classifyTiming(source))
                .isEqualTo(ShadowingTimingDeriver.WordTimingQuality.REAL_WORD_TIMING);
    }

    @Test
    @DisplayName("Material 13 rolling fragments give Unit 5 and Unit 10 plausible reference windows")
    void repairsMaterial13UnitFiveAndTenTimingWithoutChangingText() {
        List<TranscriptSegment> segments = List.of(
                segment(553L, 11000, 15080, "sleep, you'll set that same machine to", null),
                segment(554L, 12800, 16680, "scream at you again. Now, rewind 50,000", null),
                segment(555L, 15080, 18680, "years. A man wakes up in the morning", null),
                segment(556L, 16680, 20840, "light with no alarm, no schedule, and", null),
                segment(557L, 18680, 22680, "nowhere he has to be. He owns a spear,", null),
                segment(558L, 20840, 24720, "two animal hides, and a fire. And he", null),
                segment(559L, 22680, 26360, "sits up, stretches, and asks himself a", null),
                segment(560L, 24720, 28040, "question you have never once been free", null),
                segment(561L, 26360, 29520, "enough to ask. What should I do today?", null),
                segment(562L, 28040, 31520, "Now, your brain is already fighting", null),
                segment(563L, 29520, 33720, "this. It's telling you no, ancient life", null)
        );

        CanonicalTranscriptReconstructor.ReconstructionResult result = reconstructor.reconstruct(segments, 34);
        CanonicalTranscriptReconstructor.ReconstructedUnit rewind = result.units().stream()
                .filter(unit -> unit.displayText().equals("Now, rewind 50,000 years."))
                .findFirst().orElseThrow();
        CanonicalTranscriptReconstructor.ReconstructedUnit brain = result.units().stream()
                .filter(unit -> unit.displayText().equals("Now, your brain is already fighting this."))
                .findFirst().orElseThrow();

        assertThat(rewind.endTimeMs() - rewind.startTimeMs()).isGreaterThan(1_026);
        assertThat(brain.endTimeMs() - brain.startTimeMs()).isGreaterThan(1_200);
        assertThat(rewind.referenceWpm()).isBetween(40.0, 300.0);
        assertThat(brain.referenceWpm()).isBetween(40.0, 300.0);
        assertThat(result.inputTokenCount() - result.removedOverlapTokenCount())
                .isEqualTo(result.canonicalTokenCount());
        for (int index = 1; index < result.units().size(); index++) {
            assertThat(result.units().get(index).startTimeMs())
                    .isGreaterThanOrEqualTo(result.units().get(index - 1).endTimeMs());
        }
    }

    @Test
    @DisplayName("Valid exact alignment survives next to an approximate source fragment")
    void retainsExactTimingWithinMixedSourceUnit() {
        TranscriptSegment exact = segment(
                1L, 0, 1200, "Real timing",
                "[{\"word\":\"Real\",\"start\":0.0,\"end\":0.3},"
                        + "{\"word\":\"timing\",\"start\":0.55,\"end\":1.2}]"
        );
        TranscriptSegment approximate = segment(2L, 1300, 2600, "continues here.", null);

        CanonicalTranscriptReconstructor.ReconstructedUnit unit = reconstructor
                .reconstruct(List.of(exact, approximate), 3).units().get(0);

        assertThat(unit.displayText()).isEqualTo("Real timing continues here.");
        assertThat(unit.timingQuality()).isEqualTo(ShadowingTimingQuality.APPROXIMATE);
        assertThat(unit.timingStrategy()).isEqualTo(ShadowingTimingStrategy.MIXED_SOURCE_TIMING);
    }

    @Test
    @DisplayName("WPM diagnostics never stretch timing and ignore low-sample utterances")
    void diagnosesWpmWithoutChangingTiming() {
        CanonicalTranscriptReconstructor.ReconstructedUnit anomaly = reconstructor.reconstruct(
                List.of(segment(1L, 0, 100, "Move very quickly now!", null)), 1
        ).units().get(0);
        CanonicalTranscriptReconstructor.ReconstructedUnit shortUtterance = reconstructor.reconstruct(
                List.of(segment(2L, 0, 100, "Go now!", null)), 1
        ).units().get(0);

        assertThat(anomaly.referenceWpm()).isGreaterThan(300.0);
        assertThat(anomaly.wpmAnomaly()).isTrue();
        assertThat(anomaly.endTimeMs()).isEqualTo(175);
        assertThat(shortUtterance.referenceWpm()).isGreaterThan(300.0);
        assertThat(shortUtterance.wpmAnomaly()).isFalse();
    }

    private TranscriptSegment segment(Long id, int start, int end, String text, String wordsJson) {
        return TranscriptSegment.builder()
                .id(id)
                .listeningMaterial(material)
                .startTimeMs(start)
                .endTimeMs(end)
                .text(text)
                .wordsJson(wordsJson)
                .build();
    }
}
