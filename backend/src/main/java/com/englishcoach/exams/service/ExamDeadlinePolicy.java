package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord;
import com.englishcoach.exams.model.ExamTypes.ExamAttemptMode;

import java.time.Duration;
import java.time.Instant;

/**
 * Exams Phase 9C — the ONE server-authoritative write window of a timed EXAM_SIMULATION attempt.
 *
 * <p>Only server state is consulted: {@code attempts.scheduled_end_at} (hard end of the attempt, computed at start) and the
 * ACTIVE section's {@code attempt_sections.deadline_at}, compared with the server clock. A client timer, a client clock,
 * a {@code remainingSeconds} value or a request timestamp is never an input. A short fixed {@link #WRITE_GRACE} absorbs
 * requests that were in flight when the deadline passed (network latency, the client's final flush); after it, answer
 * writes are refused and a late submit finalizes the attempt with the answers saved before the closure.
 *
 * <p>PRACTICE is never governed by this policy: a scoped practice is untimed (Phase 6, no deadline at all) and legacy
 * whole-skill practice keeps its informational section timer.
 */
public final class ExamDeadlinePolicy {

    private ExamDeadlinePolicy() {}

    public static final String VERSION = "exam-deadline-policy-v1";
    /** In-flight allowance after a deadline; a server constant, never negotiated by the client. */
    public static final Duration WRITE_GRACE = Duration.ofSeconds(10);

    public static final String ATTEMPT_DEADLINE_PASSED = "ATTEMPT_DEADLINE_PASSED";
    public static final String SECTION_DEADLINE_PASSED = "SECTION_DEADLINE_PASSED";
    public static final String ATTEMPT_NOT_WRITABLE = "ATTEMPT_NOT_WRITABLE";

    /** True only for a timed simulation (the only mode whose deadlines are enforced on writes). */
    public static boolean enforced(AttemptRecord attempt) {
        return attempt != null && attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION;
    }

    /** The attempt's hard end (+ grace) has passed: no answer write is accepted any more. */
    public static boolean attemptClosed(AttemptRecord attempt, Instant now) {
        return enforced(attempt) && attempt.scheduledEndAt() != null && now.isAfter(attempt.scheduledEndAt().plus(WRITE_GRACE));
    }

    /** The section's deadline (+ grace) has passed: answers for it are no longer accepted. */
    public static boolean sectionClosed(AttemptRecord attempt, AttemptSectionRecord section, Instant now) {
        return enforced(attempt) && section != null && section.deadlineAt() != null
                && now.isAfter(section.deadlineAt().plus(WRITE_GRACE));
    }

    /**
     * Deadline of the next section opened at {@code now}: its official duration, but never past the attempt's hard end
     * (a learner who returns late does not get the elapsed time back). Non-simulation attempts are unchanged.
     */
    public static Instant capNextDeadline(AttemptRecord attempt, Instant proposed) {
        if (!enforced(attempt) || attempt.scheduledEndAt() == null || proposed == null) return proposed;
        return proposed.isAfter(attempt.scheduledEndAt()) ? attempt.scheduledEndAt() : proposed;
    }
}
