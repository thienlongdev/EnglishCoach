package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarContent.TopicMeta;
import com.englishcoach.grammar.GrammarRepository.Profile;
import com.englishcoach.grammar.GrammarRepository.State;
import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Focused recommendation behavior; no database or proficiency validity claim. */
class GrammarGuidanceTest {
    private final GrammarContent content = mock(GrammarContent.class);
    private final GrammarRepository repo = mock(GrammarRepository.class);
    private final GrammarService service = new GrammarService(content, repo, mock(LearningEventService.class), new ObjectMapper());

    private TopicMeta topic(String slug, String role, String level, int order) {
        return new TopicMeta(slug, "examples", "grammar", 1, level, "grammar", true,
                List.of(), order, 4, false, false, slug, role);
    }

    @Test void specialistReferenceIsAccessibleButNeverAnUnsolicitedPathRequirement() {
        var ref = topic("reference", "reference", "C1", 0);
        var core = topic("core", "core", "A1", 1);
        var advanced = topic("advanced", "advanced", "C1", 2);
        when(content.topics()).thenReturn(List.of(ref, core, advanced));
        when(repo.profile(1)).thenReturn(Optional.of(new Profile("C1", "SELF")));
        var next = service.me(1).next();
        assertEquals(List.of("advanced"), next.stream().map(GrammarDtos.Recommendation::slug).toList());
        verify(repo, never()).open(anyLong(), anyString(), anyInt());
    }

    @Test void learnerChosenReferenceStudyStillResumesAndGetsDueReview() {
        var now = Instant.now();
        var ref = topic("reference", "reference", "C1", 0);
        when(content.meta("reference")).thenReturn(Optional.of(ref));
        when(content.topics()).thenReturn(List.of(ref));
        when(repo.states(1)).thenReturn(List.of(new State("reference", now, now, null, 0, 0, null, null, null, null, 0, null, false)));
        assertEquals("CONTINUE", service.me(1).next().getFirst().reason());
        when(repo.states(1)).thenReturn(List.of(new State("reference", now, now, now, 6, 6, 100, 100, now, now.minusSeconds(400000), 1, now.minusSeconds(10), false)));
        assertEquals("REVIEW_DUE", service.me(1).next().getFirst().reason());
    }

    @Test void demonstratedMasteryIsSkippedWithoutRestartingTheLearner() {
        var now = Instant.now();
        var known = topic("known", "core", "A1", 0);
        var next = topic("next", "core", "A2", 1);
        when(content.topics()).thenReturn(List.of(known, next));
        when(content.meta("known")).thenReturn(Optional.of(known));
        when(repo.states(1)).thenReturn(List.of(new State("known", now, now, now, 6, 6, 100, 100, now, now, 1, now.plusSeconds(999999), false)));
        assertEquals(List.of("next"), service.me(1).next().stream().map(GrammarDtos.Recommendation::slug).toList());
    }
}
