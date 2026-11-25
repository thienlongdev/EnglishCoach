package com.englishcoach.premium.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.ZoneId;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.premium")
public class PremiumProperties {

    private boolean enabled = true;
    private String timeZone = "Asia/Ho_Chi_Minh";
    private int defaultFreeTrialLimit = 5;
    /** Free accounts: AI uses per calendar day, shared by every gated AI feature (owner policy 2026-10-18). */
    private int freeDailyAiLimit = 3;
    /** Free accounts: Echo Coach messages per calendar day (a separate allowance from the shared AI uses). */
    private int freeDailyCoachMessages = 10;
    /** Free accounts: new My Books imports per calendar day. */
    private int freeDailyBookImports = 1;
    /**
     * Premium accounts: Echo messages per calendar day (owner policy 2026-11-20: Premium Echo is limited, never unlimited).
     * The monthly Premium limit is the {@code COACH_CHAT} row's {@code premium_monthly_limit} (500 since V36). Sized from the
     * measured cost per turn (docs/echo-jarvis-7/ECHO_COST_PERFORMANCE_REPORT.md).
     */
    private int premiumDailyCoachMessages = 60;

    public ZoneId getZoneId() {
        try {
            return ZoneId.of(timeZone != null && !timeZone.isBlank() ? timeZone : "Asia/Ho_Chi_Minh");
        } catch (Exception e) {
            return ZoneId.of("Asia/Ho_Chi_Minh");
        }
    }
}
