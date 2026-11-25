package com.englishcoach.flashcard.memory;

import com.englishcoach.progress.config.LearningProgressProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Component;

import java.sql.Date;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Writes one append-only row of {@code flashcard_review_log} (V116) per rating stored by FlashcardService#review, inside
 * that method's transaction: the rating and its log row are committed together or not at all. A replayed
 * Idempotency-Key never reaches this (the service returns the stored card first). The log is evidence for weak words,
 * card evolution and the Memory Reef only; it never changes the schedule.
 */
@Component
public class FlashcardReviewLog {

    private final JdbcTemplate jdbc;
    private final ZoneId zone;

    @Autowired
    public FlashcardReviewLog(JdbcTemplate jdbc, @Nullable LearningProgressProperties properties) {
        this.jdbc = jdbc;
        this.zone = properties != null ? properties.getZoneId() : ZoneId.of("Asia/Ho_Chi_Minh");
    }

    public LocalDate today() {
        return LocalDate.now(zone);
    }

    public ZoneId zone() {
        return zone;
    }

    public void record(long userId, long flashcardId, String quality, String statusBefore, String statusAfter) {
        jdbc.update("INSERT INTO public.flashcard_review_log "
                        + "(user_id, flashcard_id, quality, status_before, status_after, review_local_day) VALUES (?, ?, ?, ?, ?, ?)",
                userId, flashcardId, quality, statusBefore, statusAfter, Date.valueOf(today()));
    }
}
