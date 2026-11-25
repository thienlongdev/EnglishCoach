package com.englishcoach.proficiency;

import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import java.util.function.Supplier;

/**
 * Proficiency listens to the SAME Phase 1 domain events as Activity (Hardening #1: no new
 * publishEvent anywhere). Only dictation, roleplay and exam events produce evidence; shadowing,
 * Card Blast, PvP, flashcard and writing events are deliberately not handled (Hardening #11).
 * AFTER_COMMIT (immediately for non-transactional publishers), own executor, errors only logged.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ProficiencyEventListener {

    private final ProficiencyIngestService ingest;

    @Async(ProficiencyAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(DictationAttemptSubmittedEvent event) {
        safely("DictationAttemptSubmitted", () -> ingest.ingestDictation(event));
    }

    @Async(ProficiencyAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(RoleplayTurnRecordedEvent event) {
        safely("RoleplayTurnRecorded", () -> ingest.ingestRoleplay(event));
    }

    @Async(ProficiencyAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(ExamScoredEvent event) {
        safely("ExamScored", () -> ingest.ingestExam(event));
    }

    private void safely(String name, Supplier<?> action) {
        try {
            action.get();
        } catch (Throwable ex) {
            log.warn("[Proficiency] Non-fatal: failed to process {} event: {}", name, ex.getMessage(), ex);
        }
    }
}
