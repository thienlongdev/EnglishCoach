package com.englishcoach.proficiency;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * One-off T1 backfill from historical COMPLETED exam results (first per formId + skill), guarded by
 * {@code app.proficiency.backfill.enabled} (default false). Idempotent. No T3 backfill. Runs before the
 * Activity backfill runner ({@code @Order(200)}).
 */
@Slf4j
@Component
@Order(100)
@RequiredArgsConstructor
public class ProficiencyBackfillRunner implements ApplicationRunner {

    private final ProficiencyProperties props;
    private final ProficiencyIngestService ingest;

    @Override
    public void run(ApplicationArguments args) {
        if (!props.isEnabled() || !props.getBackfill().isEnabled()) {
            return;
        }
        try {
            int inserted = ingest.reconcileT1(null);
            log.info("[Proficiency] Backfill finished: {} T1 evidence rows inserted", inserted);
        } catch (Exception ex) {
            log.warn("[Proficiency] Backfill failed (non-fatal): {}", ex.getMessage(), ex);
        }
    }
}
