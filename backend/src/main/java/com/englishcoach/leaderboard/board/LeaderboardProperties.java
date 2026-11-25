package com.englishcoach.leaderboard.board;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

/**
 * Board-wide leaderboard settings ({@code app.leaderboard.*}; Activity scoring and refresh have their own
 * property classes). {@code excluded-user-ids} (env {@code APP_LEADERBOARD_EXCLUDED_USER_IDS}, comma list)
 * removes accounts (test / QA) from both boards, the unranked list and the home widget; copied into
 * {@code leaderboard_refresh_state.excluded_user_ids} by every refresh and filtered in one batch predicate.
 * Admins and non-ACTIVE accounts are excluded independently of this list.
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.leaderboard")
public class LeaderboardProperties {

    private List<Long> excludedUserIds = new ArrayList<>();

    /**
     * Thi đua eligibility (hotfix 2026-10-02): only learners with a VALID "Bài xếp lớp nhanh" attempt are ranked and
     * listed ({@code app.leaderboard.require-placement}, env {@code APP_LEADERBOARD_REQUIRE_PLACEMENT}, default true).
     * Copied into {@code leaderboard_refresh_state.require_placement} by every refresh. Points are still recorded
     * for everyone; they count as soon as the placement is done.
     */
    private boolean requirePlacement = true;

    /** Anti-sandbagging for placement-based divisions ({@code app.leaderboard.division.*}, Stage 3.3). */
    private Division division = new Division();

    @Data
    public static class Division {
        private boolean promotionEnabled = true;
        /** Look-back window of Activity points (days). */
        private int promotionWindowDays = 14;
        /** Share of the window's points that must come from content ≥ minSteps CEFR steps above the division level. */
        private double promotionMinShare = 0.6;
        private int promotionMinSteps = 2;
    }

    /** PostgreSQL array literal of the configured ids, e.g. {@code {12,34}} (ids are numbers only). */
    public String excludedUserIdsArrayLiteral() {
        StringBuilder sb = new StringBuilder("{");
        for (Long id : excludedUserIds) {
            if (id == null) continue;
            if (sb.length() > 1) sb.append(',');
            sb.append(id.longValue());
        }
        return sb.append('}').toString();
    }

    public boolean isExcluded(long userId) {
        return excludedUserIds.contains(userId);
    }
}
