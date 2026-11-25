package com.englishcoach.leaderboard.board;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Response DTOs of {@code /api/v1/leaderboard/**} (Phase 3). Display name + avatar only — never email. */
public final class LeaderboardDtos {

    private LeaderboardDtos() {}

    public record AvatarFrameDto(String slug, String tier, String renderType, String posterAsset) {}

    public record ActivityItem(int rank, long userId, String displayName, String avatarUrl,
                               AvatarFrameDto avatarFrame, int points) {}

    /** periodEndsAt is exclusive and null for ALL_TIME; updatedAt = last successful refresh (null = never). */
    public record ActivityBoardResponse(String period, String scope, String group, List<ActivityItem> items,
                                        int participants, Instant periodStartsAt, Instant periodEndsAt,
                                        Instant updatedAt) {}

    /** Learner shown in "Chưa ghi điểm kỳ này" (no rank, no points). */
    public record UnrankedItem(long userId, String displayName, String avatarUrl, AvatarFrameDto avatarFrame) {}

    /** nextCursor = last userId of the page, null when there are no more learners. */
    public record UnrankedResponse(String period, String scope, String group, List<UnrankedItem> items, Long nextCursor) {}

    public record SourceBreakdown(String sourceModule, int points) {}

    /**
     * @param rank             null when not ranked in this period/scope/group
     * @param pointsToNextRank points needed to pass the nearest learner ranked above; null at rank 1 or unranked
     * @param nextRank         rank of that nearest learner above (ties make it differ from rank − 1); null with pointsToNextRank
     * @param defaultScope     always GLOBAL ("Bảng chung" is the main board; divisions are secondary filters)
     * @param division         the caller's division (SO_CAP / TRUNG_CAP / CAO_CAP) or null when no level
     * @param divisionCefr     level behind the division; divisionSource VERIFIED / STALE / PROVISIONAL / PLACEMENT
     * @param eligibility      why the caller has (no) rank in this partition: RANKED, NO_POINTS (eligible, 0 points this
     *                         period), PENDING (points recorded, ranking catches up within seconds), OTHER_DIVISION
     *                         (a division chip that is not the caller's), PLACEMENT_REQUIRED (no VALID placement yet),
     *                         EXCLUDED (admin / inactive / excluded account — points are still recorded)
     * @param placementCompleted the caller has a VALID placement attempt
     */
    public record ActivityMeResponse(long userId, String period, String scope, String group, Integer rank, int points,
                                     Integer pointsToNextRank, Integer nextRank, String defaultScope,
                                     String division, String divisionCefr, String divisionSource,
                                     String promotedTo, Instant promotedAt,
                                     List<SourceBreakdown> breakdown,
                                     Instant periodStartsAt, Instant periodEndsAt, Instant updatedAt,
                                     String eligibility, boolean placementCompleted,
                                     /** ADMIN / INACTIVE / EXCLUDED_TEST when eligibility = EXCLUDED, else null. */
                                     String excludedReason) {}

    public record SkillCellDto(String cefr, String status) {}

    /** Learner listed below the ranked Năng lực rows: source PROVISIONAL / STALE / PLACEMENT (no rank). */
    public record OtherLevelItem(long userId, String displayName, String avatarUrl, AvatarFrameDto avatarFrame,
                                 String cefr, String source) {}

    /** "Đang xác thực" (PROVISIONAL + STALE) and "Theo bài xếp lớp" groups; learners without a level as a count only. */
    public record ProficiencyOthersResponse(String board, String division, List<OtherLevelItem> verifying,
                                            List<OtherLevelItem> placement, int undeterminedCount) {}

    /** skills keys: L, R, W, S. */
    public record ProficiencyItem(int rank, long userId, String displayName, String avatarUrl,
                                  AvatarFrameDto avatarFrame, String cefr, int rating, String confidenceLabel,
                                  Map<String, SkillCellDto> skills) {}

    public record ProficiencyBoardResponse(String board, String division, List<ProficiencyItem> items,
                                           Instant updatedAt) {}

    /**
     * @param rank             rank on the visible board, or "where you would be" when hidden; null when not eligible
     * @param ineligibleReason UNDETERMINED / PROVISIONAL / STALE / UNSUPPORTED, EXCLUDED (admin / inactive account);
     *                         null when eligible
     */
    public record ProficiencyMeResponse(long userId, String board, Integer rank, Integer rating, String cefr, String status,
                                        String division, boolean hidden, boolean eligible, String ineligibleReason,
                                        Instant updatedAt) {}
}
