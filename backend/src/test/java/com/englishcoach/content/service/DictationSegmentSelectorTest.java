package com.englishcoach.content.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class DictationSegmentSelectorTest {

    @Test
    @DisplayName("Closest to target: selects segment whose duration is closest to target 20s")
    void testClosestToTarget() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(101L, 0.0, 10.0, "This is the first segment with enough words for dictation."), // 10s (dist 10)
                new DictationSegmentSelector.Cue(102L, 10.0, 25.0, "This is the second segment with many words describing nature and wildlife."), // 15s (dist 5)
                new DictationSegmentSelector.Cue(103L, 25.0, 44.0, "This is the third segment with plenty of words and duration nineteen seconds."), // 19s (dist 1)
                new DictationSegmentSelector.Cue(104L, 44.0, 68.0, "This is the fourth segment with twenty four seconds duration and many words.") // 24s (dist 4)
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 42L);

        assertThat(result).isPresent();
        DictationSegmentSelector.DictationSegment seg = result.get();
        assertThat(seg.segmentId()).isEqualTo(103L);
        assertThat(seg.durationSeconds()).isEqualTo(19);
    }

    @Test
    @DisplayName("Bounds: standard window enforces min 8s and max 25s")
    void testBoundsEnforced() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(201L, 0.0, 5.0, "Short segment with seven words in it."), // 5s (< 8s)
                new DictationSegmentSelector.Cue(202L, 5.0, 17.0, "Valid segment within the standard duration boundaries for practice."), // 12s (in [8, 25])
                new DictationSegmentSelector.Cue(203L, 17.0, 47.0, "Very long segment that exceeds twenty five seconds duration limit completely.") // 30s (> 25s)
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 1L);

        assertThat(result).isPresent();
        assertThat(result.get().segmentId()).isEqualTo(202L);
        assertThat(result.get().durationSeconds()).isEqualTo(12);
    }

    @Test
    @DisplayName("Sound tags: skips segments containing only sound tags or bracketed noise")
    void testSoundTags() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(301L, 0.0, 18.0, "[Music] [Applause] ♪♫"), // sound tags only
                new DictationSegmentSelector.Cue(302L, 18.0, 36.0, "[Music] Welcome everyone to our lecture about environmental conservation and science.") // 18s, valid words
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 1L);

        assertThat(result).isPresent();
        assertThat(result.get().segmentId()).isEqualTo(302L);
        assertThat(result.get().durationSeconds()).isEqualTo(18);
    }

    @Test
    @DisplayName("Min words: skips segments with fewer than 6 words even if duration is within bounds")
    void testMinWords() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(401L, 0.0, 20.0, "Too few words here."), // 4 words
                new DictationSegmentSelector.Cue(402L, 20.0, 35.0, "This segment has enough words to be eligible for dictation exercise.") // 11 words, 15s
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 1L);

        assertThat(result).isPresent();
        assertThat(result.get().segmentId()).isEqualTo(402L);
    }

    @Test
    @DisplayName("Determinism: same seed returns exact same choice for equidistant candidates")
    void testDeterminism() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(501L, 0.0, 19.0, "First segment duration nineteen seconds with enough words for practice."), // 19s (dist 1)
                new DictationSegmentSelector.Cue(502L, 19.0, 40.0, "Second segment duration twenty one seconds with enough words for practice.") // 21s (dist 1)
        );

        Optional<DictationSegmentSelector.DictationSegment> r1 = DictationSegmentSelector.selectSegment(cues, 12345L);
        Optional<DictationSegmentSelector.DictationSegment> r2 = DictationSegmentSelector.selectSegment(cues, 12345L);

        assertThat(r1).isPresent();
        assertThat(r2).isPresent();
        assertThat(r1.get().segmentId()).isEqualTo(r2.get().segmentId());
        assertThat(r1.get().startSeconds()).isEqualTo(r2.get().startSeconds());
    }

    @Test
    @DisplayName("Relaxed path: relaxes duration bounds when no segment is within 8-25s")
    void testRelaxedPath() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(601L, 0.0, 5.0, "Short segment one with enough words."), // 5s (dist 15)
                new DictationSegmentSelector.Cue(602L, 5.0, 12.0, "Short segment two with enough words."), // 7s (dist 13)
                new DictationSegmentSelector.Cue(603L, 12.0, 16.0, "Short segment three with enough words.") // 4s (dist 16)
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 10L);

        assertThat(result).isPresent();
        // 7s is closest to 20s among relaxed candidates
        assertThat(result.get().segmentId()).isEqualTo(602L);
        assertThat(result.get().durationSeconds()).isEqualTo(7);
    }

    @Test
    @DisplayName("Payload structure: DictationSegment has segmentId and timing, no transcript text")
    void testPayloadHasNoTranscriptText() {
        List<DictationSegmentSelector.Cue> cues = List.of(
                new DictationSegmentSelector.Cue(701L, 0.0, 20.0, "Secret transcript sentence that must not leak into segment record.")
        );

        Optional<DictationSegmentSelector.DictationSegment> result = DictationSegmentSelector.selectSegment(cues, 1L);

        assertThat(result).isPresent();
        DictationSegmentSelector.DictationSegment seg = result.get();
        assertThat(seg.segmentId()).isEqualTo(701L);
        assertThat(seg.startSeconds()).isEqualTo(0);
        assertThat(seg.endSeconds()).isEqualTo(20);
        assertThat(seg.durationSeconds()).isEqualTo(20);
        // Ensure class has no transcript or text getters/fields
        assertThat(seg.getClass().getDeclaredFields())
                .extracting("name")
                .doesNotContain("text", "transcript", "sentenceText");
    }
}
