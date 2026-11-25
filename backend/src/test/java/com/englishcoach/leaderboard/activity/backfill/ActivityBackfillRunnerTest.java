package com.englishcoach.leaderboard.activity.backfill;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.ActivityScoringService;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.mockito.Mockito;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;

/** Stage 4 Activity backfill runner: chronological replay through the live handlers, start-at clamp, no publishEvent. */
class ActivityBackfillRunnerTest {

    @Test
    @DisplayName("Events of all modules are replayed in occurred_at order through the scoring handlers; from is clamped to start-at")
    void chronologicalReplay() {
        ActivityBackfillProperties props = new ActivityBackfillProperties();
        props.setEnabled(true);
        props.setFrom("2026-08-01T00:00:00+07:00");
        ActivityScoringProperties scoring = new ActivityScoringProperties();
        scoring.setStartAt("2026-09-01T00:00:00+07:00");
        ActivityBackfillSourceRepository source = Mockito.mock(ActivityBackfillSourceRepository.class);
        ActivityScoringService service = Mockito.mock(ActivityScoringService.class);
        Instant startAt = Instant.parse("2026-08-31T17:00:00Z");
        Instant t1 = Instant.parse("2026-09-02T01:00:00Z");
        Instant t2 = Instant.parse("2026-09-03T01:00:00Z");
        CardBlastRunFinishedEvent late = new CardBlastRunFinishedEvent(1L, 10L, 1L, 400, 90.0, 0, t2);
        DictationAttemptSubmittedEvent early = new DictationAttemptSubmittedEvent(1L, 20L, 5L, 7L, 3L, "B1", 80.0, true, t1);
        Mockito.when(source.cardBlastRuns(startAt)).thenReturn(List.of(late));
        Mockito.when(source.dictationAttempts(startAt)).thenReturn(List.of(early));
        Mockito.when(service.onCardBlastRunFinished(any())).thenReturn(List.of());
        Mockito.when(service.onDictationAttemptSubmitted(any())).thenReturn(List.of());

        ActivityBackfillRunner.Summary s = new ActivityBackfillRunner(props, scoring, source, service).runOnce();

        assertEquals(2, s.events());
        assertEquals(0, s.failures());
        InOrder order = Mockito.inOrder(service);
        order.verify(service).onDictationAttemptSubmitted(early);
        order.verify(service).onCardBlastRunFinished(late);
        Mockito.verify(source).flashcards(startAt); // from 2026-08-01 clamped to start-at
    }

    @Test
    @DisplayName("Disabled ⇒ nothing is read; the runner never publishes events")
    void disabledAndNoPublish() throws Exception {
        ActivityBackfillSourceRepository source = Mockito.mock(ActivityBackfillSourceRepository.class);
        new ActivityBackfillRunner(new ActivityBackfillProperties(), new ActivityScoringProperties(), source,
                Mockito.mock(ActivityScoringService.class)).run(null);
        Mockito.verifyNoInteractions(source);
        for (String f : List.of("ActivityBackfillRunner.java", "ActivityBackfillSourceRepository.java")) {
            String src = Files.readString(Path.of("src/main/java/com/englishcoach/leaderboard/activity/backfill/" + f));
            assertFalse(src.contains("publishEvent("), f);
            assertFalse(src.toLowerCase().matches("(?s).*(insert into|update public|delete from).*"), "source reader is read-only: " + f);
        }
    }
}
