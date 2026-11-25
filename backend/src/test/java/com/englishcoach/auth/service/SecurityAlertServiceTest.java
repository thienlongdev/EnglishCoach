package com.englishcoach.auth.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Alerts reach the owner once per kind and window, bursts only above their threshold, never with sensitive text. */
class SecurityAlertServiceTest {

    /** Runs tasks on the calling thread so the test sees deliveries at once. */
    static final class Direct extends AbstractExecutorService {
        public void execute(Runnable r) { r.run(); }
        public void shutdown() { }
        public List<Runnable> shutdownNow() { return List.of(); }
        public boolean isShutdown() { return false; }
        public boolean isTerminated() { return false; }
        public boolean awaitTermination(long t, TimeUnit u) { return true; }
    }

    static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-10-14T08:00:00Z");
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }

    private final List<String[]> sent = new ArrayList<>();
    private final MutableClock clock = new MutableClock();
    private final SecurityAlertService alerts = new SecurityAlertService("owner@example.test",
            (to, subject, text) -> sent.add(new String[]{to, subject, text}), clock, new Direct());

    @Test
    @DisplayName("An immediate event is mailed once per ten minutes, with no sensitive content")
    void immediateEventsAreDeduplicated() {
        alerts.onSignal("MFA_FACTOR_REMOVED", "TOTP");
        alerts.onSignal("MFA_FACTOR_REMOVED", "TOTP");
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[0]).isEqualTo("owner@example.test");
        assertThat(sent.get(0)[1]).contains("MFA_FACTOR_REMOVED");
        clock.now = clock.now.plus(Duration.ofMinutes(11));
        alerts.onSignal("MFA_FACTOR_REMOVED", "WEBAUTHN <script>@x");
        assertThat(sent).hasSize(2);
        assertThat(sent.get(1)[2]).doesNotContain("<script>").doesNotContain("@x");
    }

    @Test
    @DisplayName("A burst alerts only at its threshold inside the window; isolated refusals stay silent")
    void burstsNeedTheirThreshold() {
        for (int i = 0; i < 24; i++) alerts.onSignal("CSRF_REJECTED", "origin");
        assertThat(sent).isEmpty();
        alerts.onSignal("CSRF_REJECTED", "origin");
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[2]).contains("25");
        alerts.onSignal("SOMETHING_ELSE", "x");
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("A flood of distinct alert kinds is capped per day")
    void dailyCap() {
        for (int i = 0; i < 100; i++) {
            clock.now = clock.now.plus(Duration.ofMinutes(11));
            alerts.onSignal("PAYMENT_UNMATCHED", "NO_ORDER");
        }
        assertThat(sent.size()).isLessThanOrEqualTo(SecurityAlertService.DAILY_CAP);
    }

    @Test
    @DisplayName("Audit events map onto alert kinds; ordinary events do not alert")
    void auditMapping() {
        assertThat(SecurityAlertService.kindOfAudit("MFA_VERIFY", "FAILURE", "LOCKED")).isEqualTo("MFA_LOCKED");
        assertThat(SecurityAlertService.kindOfAudit("MFA_EMERGENCY_RESET", "SUCCESS", null)).isEqualTo("MFA_EMERGENCY_RESET");
        assertThat(SecurityAlertService.kindOfAudit("LOGIN_SUCCESS", "SUCCESS", null)).isNull();
        assertThat(SecurityAlertService.kindOfAudit("MFA_VERIFY", "FAILURE", "INVALID_CODE")).isNull();
    }
}
