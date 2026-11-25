package com.englishcoach.proficiency;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Nightly 02:00 Asia/Ho_Chi_Minh (§9, §5): (a) T1 reconciliation of the last N days (idempotent);
 * (b) refresh weight_sum / confidence / status + snapshot for users with evidence in the last
 * 365 days. Never writes skill rating, overall_rating, current_cefr or peak_*.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ProficiencyNightlyJob {

    private final ProficiencyProperties props;
    private final ProficiencyIngestService ingest;
    private final ProficiencyService service;
    private final ProficiencyEvidenceRepository evidenceRepository;

    /** Runs on the dedicated single-thread leaderboard scheduler (bean defined in leaderboard.board). */
    @Scheduled(cron = "${app.proficiency.nightly.cron:0 0 2 * * *}", zone = "${app.proficiency.time-zone:Asia/Ho_Chi_Minh}",
            scheduler = "leaderboardTaskScheduler")
    public void scheduled() {
        if (!props.isEnabled() || !props.getNightly().isEnabled()) {
            return;
        }
        try {
            run(Instant.now());
        } catch (Exception ex) {
            log.warn("[Proficiency] Nightly job failed: {}", ex.getMessage(), ex);
        }
    }

    /** Entry point with an explicit clock (tests simulate time passing). */
    public NightlyResult run(Instant now) {
        int reconciled = ingest.reconcileT1(now.minus(Duration.ofDays(props.getNightly().getReconciliationLookbackDays())));
        List<Long> users = evidenceRepository.findUsersWithEvidenceSince(
                now.minus(Duration.ofDays(props.getRating().getWindowDays())));
        int refreshed = 0;
        for (Long userId : users) {
            try {
                service.refreshNightly(userId, now);
                refreshed++;
            } catch (Exception ex) {
                log.warn("[Proficiency] Nightly refresh failed for user {}: {}", userId, ex.getMessage());
            }
        }
        log.info("[Proficiency] Nightly: reconciled {} T1 evidence rows, refreshed {} users", reconciled, refreshed);
        return new NightlyResult(reconciled, refreshed);
    }

    public record NightlyResult(int reconciledEvidence, int refreshedUsers) {}
}
