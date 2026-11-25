package com.englishcoach.community.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.service.AvatarFrameService;
import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.community.dto.AuthorSummaryDto;
import com.englishcoach.community.entity.AuthorType;
import com.englishcoach.community.repository.CommunityFollowRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.proficiency.ProficiencyLevelQueryService;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.user.entity.UserProfile;
import com.englishcoach.user.repository.UserProfileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Date;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityAuthorEnrichmentService {

    private static final ZoneId STREAK_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final String STREAK_TZ = "Asia/Ho_Chi_Minh";

    private static final String BATCH_ACTIVE_DATES_SQL = """
            SELECT DISTINCT user_id, act_date FROM (
                SELECT s.user_id, (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM speaking_turns t
                JOIN speaking_sessions s ON t.session_id = s.id
                WHERE s.user_id IN (:userIds)
                  AND t.speaker = 'LEARNER'
                  AND (t.is_mocked IS NULL OR t.is_mocked = false)
                UNION ALL
                SELECT a.user_id, (a.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM speaking_shadowing_attempts a
                WHERE a.user_id IN (:userIds)
                  AND (a.is_mocked IS NULL OR a.is_mocked = false)
                UNION ALL
                SELECT q.user_id, (q.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM exams.speaking_quick_checks q
                WHERE q.user_id IN (:userIds)
                  AND (q.is_mocked IS NULL OR q.is_mocked = false)
                UNION ALL
                SELECT w.user_id, (w.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM writing_submissions w
                WHERE w.user_id IN (:userIds)
                UNION ALL
                SELECT t.user_id, (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM public.translation_attempts t
                WHERE t.user_id IN (:userIds)
                UNION ALL
                SELECT p.user_id, (p.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM public.translation_paragraph_attempts p
                WHERE p.user_id IN (:userIds)
                UNION ALL
                SELECT l.user_id, (l.ended_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM listening_sessions l
                WHERE l.user_id IN (:userIds)
                  AND l.ended_at IS NOT NULL
                UNION ALL
                SELECT r.user_id, (r.last_read_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM user_reading_progress r
                WHERE r.user_id IN (:userIds)
                  AND r.scroll_percentage >= 80
                  AND r.last_read_at IS NOT NULL
                UNION ALL
                SELECT e.user_id, (e.occurred_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM public.learning_activity_events e
                WHERE e.user_id IN (:userIds)
                  AND e.activity_type IN ('FLASHCARD_REVIEWED', 'WORD_CHAIN_PLAYED')
                UNION ALL
                SELECT a.user_id, (COALESCE(s.sealed_at, s.started_at, s.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM exams.attempt_sections s
                JOIN exams.attempts a ON s.attempt_id = a.id
                WHERE a.user_id IN (:userIds)
                  AND s.state = 'COMPLETED'
                UNION ALL
                SELECT a.user_id, (COALESCE(a.submitted_at, a.started_at, a.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM exams.attempts a
                WHERE a.user_id IN (:userIds)
                  AND a.status = 'SUBMITTED'
                  AND NOT EXISTS (
                      SELECT 1 FROM exams.attempt_sections s WHERE s.attempt_id = a.id AND s.state = 'COMPLETED'
                  )
            ) active_days
            """;

    private final UserProfileRepository userProfileRepository;
    private final AvatarFrameService avatarFrameService;
    private final PremiumEntitlementService premiumEntitlementService;
    private final UnifiedProgressService unifiedProgressService;
    private final ProficiencyLevelQueryService proficiencyLevelQueryService;
    private final CommunityFollowRepository followRepository;

    @Autowired(required = false)
    private NamedParameterJdbcTemplate namedJdbc;

    // Non-viewer-scoped public display streaks only (NEVER cache viewer-scoped isFollowing / reactions / saves).
    private final BoundedTtlCache<Long, Integer> authorStreakCache =
            new BoundedTtlCache<>(1_024, Duration.ofMinutes(2).toMillis());

    public AuthorSummaryDto officialAuthorSummary() {
        return AuthorSummaryDto.builder()
                .id(null)
                .name("EnglishCoach")
                .authorType(AuthorType.OFFICIAL)
                .avatarUrl("/assets/Whale.svg")
                .frame(null)
                .isOfficial(true)
                .isPremium(true)
                .streakDays(null)
                .cefrLevel("C2")
                .isFollowing(false)
                .build();
    }

    public AuthorSummaryDto fallbackAuthorSummary() {
        return AuthorSummaryDto.builder()
                .id(0L)
                .name("Học viên")
                .authorType(AuthorType.USER)
                .avatarUrl(null)
                .frame(null)
                .isOfficial(false)
                .isPremium(false)
                .streakDays(0)
                .cefrLevel(null)
                .isFollowing(false)
                .build();
    }

    public AuthorSummaryDto enrichAuthor(User user, AuthorType authorType, Long currentUserId) {
        if (authorType == AuthorType.OFFICIAL) {
            return officialAuthorSummary();
        }
        if (user == null || user.getId() == null) {
            return fallbackAuthorSummary();
        }
        Map<Long, AuthorSummaryDto> batch = enrichAuthorsBatch(Map.of(user.getId(), user), currentUserId);
        return batch.getOrDefault(user.getId(), fallbackAuthorSummary());
    }

    /**
     * Batch-enriches a set of non-official author IDs in 4-5 total queries instead of 5N per-post queries.
     * Never selects or exposes {@code email}, {@code account_status}, or {@code role}; never caches viewer-scoped
     * {@code isFollowing}; bypasses {@code PrestigeEvaluationEngine.computeProgress} for feed avatars.
     */
    public Map<Long, AuthorSummaryDto> enrichAuthorsBatch(Set<Long> authorIds, Long currentUserId) {
        if (authorIds == null || authorIds.isEmpty()) {
            return Map.of();
        }
        Set<Long> cleanIds = new LinkedHashSet<>();
        for (Long id : authorIds) {
            if (id != null) {
                cleanIds.add(id);
            }
        }
        if (cleanIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, String> fallbackNames = loadSafeUserNamesBatch(cleanIds);
        return enrichInternal(cleanIds, fallbackNames, currentUserId);
    }

    /**
     * Batch-enriches pre-fetched author entities (preserving {@link User#getName()} display fallback without extra
     * {@code users} lookups and without reading sensitive columns).
     */
    public Map<Long, AuthorSummaryDto> enrichAuthorsBatch(Map<Long, User> authorsById, Long currentUserId) {
        if (authorsById == null || authorsById.isEmpty()) {
            return Map.of();
        }
        Set<Long> cleanIds = new LinkedHashSet<>();
        Map<Long, String> fallbackNames = new HashMap<>(authorsById.size());
        for (Map.Entry<Long, User> entry : authorsById.entrySet()) {
            Long id = entry.getKey();
            if (id != null) {
                cleanIds.add(id);
                User u = entry.getValue();
                if (u != null && u.getName() != null && !u.getName().isBlank()) {
                    fallbackNames.put(id, u.getName());
                }
            }
        }
        if (cleanIds.isEmpty()) {
            return Map.of();
        }
        return enrichInternal(cleanIds, fallbackNames, currentUserId);
    }

    private Map<Long, AuthorSummaryDto> enrichInternal(
            Set<Long> authorIds,
            Map<Long, String> fallbackNames,
            Long currentUserId
    ) {
        // 1. Batch profiles (display_name & avatar_storage_key only)
        Map<Long, UserProfile> profilesById = new HashMap<>(authorIds.size());
        Iterable<UserProfile> profiles = userProfileRepository.findAllById(authorIds);
        if (profiles != null) {
            for (UserProfile p : profiles) {
                if (p != null && p.getUserId() != null) {
                    profilesById.put(p.getUserId(), p);
                }
            }
        }

        // 2. Batch equipped avatar frames (bypasses PrestigeEvaluationEngine.computeProgress)
        Map<Long, AvatarFrameDto> framesById = Collections.emptyMap();
        try {
            Map<Long, AvatarFrameDto> loaded = avatarFrameService.getEquippedFramesBatch(authorIds);
            if (loaded != null) {
                framesById = loaded;
            }
        } catch (Exception e) {
            log.debug("Could not batch-fetch equipped frames: {}", e.getMessage());
        }

        // 3. Batch active premium status
        Set<Long> premiumUserIds = loadActivePremiumUserIdsBatch(authorIds);

        // 4. Batch CEFR levels
        Map<Long, String> cefrById = loadCefrLevelsBatch(authorIds);

        // 5. Batch streaks (short TTL cache + single batched query for misses)
        Map<Long, Integer> streaksById = loadStreaksBatch(authorIds);

        // 6. Live viewer-scoped isFollowing (NEVER cached)
        Set<Long> followedIds = loadFollowedAuthorIdsBatch(currentUserId, authorIds);

        Map<Long, AuthorSummaryDto> result = new LinkedHashMap<>(authorIds.size());
        for (Long userId : authorIds) {
            UserProfile profile = profilesById.get(userId);
            String displayName = (profile != null && profile.getDisplayName() != null && !profile.getDisplayName().isBlank())
                    ? profile.getDisplayName()
                    : fallbackNames.getOrDefault(userId, "Học viên");

            String avatarUrl = (profile != null && profile.getAvatarStorageKey() != null && !profile.getAvatarStorageKey().isBlank())
                    ? "/api/v1/users/" + userId + "/avatar"
                    : null;

            Boolean isFollowing = null;
            if (currentUserId != null && !currentUserId.equals(userId)) {
                isFollowing = followedIds.contains(userId);
            }

            result.put(userId, AuthorSummaryDto.builder()
                    .id(userId)
                    .name(displayName)
                    .authorType(AuthorType.USER)
                    .avatarUrl(avatarUrl)
                    .frame(framesById.get(userId))
                    .isOfficial(false)
                    .isPremium(premiumUserIds.contains(userId))
                    .streakDays(streaksById.getOrDefault(userId, 0))
                    .cefrLevel(cefrById.get(userId))
                    .isFollowing(isFollowing)
                    .build());
        }
        return result;
    }

    private Map<Long, String> loadSafeUserNamesBatch(Set<Long> authorIds) {
        if (namedJdbc == null || authorIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, String> names = new HashMap<>(authorIds.size());
        try {
            // Strictly select ONLY id and name — NEVER email, password, account_status, or role.
            namedJdbc.query(
                    "SELECT id, name FROM public.users WHERE id IN (:ids)",
                    new MapSqlParameterSource("ids", authorIds),
                    rs -> {
                        long id = rs.getLong("id");
                        String name = rs.getString("name");
                        if (name != null && !name.isBlank()) {
                            names.put(id, name);
                        }
                    }
            );
        } catch (Exception e) {
            log.debug("Could not batch-fetch user display names: {}", e.getMessage());
        }
        return names;
    }

    private Set<Long> loadActivePremiumUserIdsBatch(Set<Long> authorIds) {
        Set<Long> premiumIds = new HashSet<>();
        if (namedJdbc != null) {
            try {
                MapSqlParameterSource params = new MapSqlParameterSource()
                        .addValue("userIds", authorIds)
                        .addValue("now", Timestamp.from(Instant.now()));
                namedJdbc.query(
                        """
                        SELECT DISTINCT user_id
                        FROM public.premium_subscriptions
                        WHERE user_id IN (:userIds)
                          AND status = 'ACTIVE'
                          AND starts_at <= :now
                          AND expires_at > :now
                        """,
                        params,
                        rs -> {
                            premiumIds.add(rs.getLong("user_id"));
                        }
                );
                return premiumIds;
            } catch (Exception e) {
                log.debug("Batch premium query failed, falling back per-user: {}", e.getMessage());
            }
        }
        for (Long userId : authorIds) {
            try {
                if (premiumEntitlementService.isUserPremium(userId)) {
                    premiumIds.add(userId);
                }
            } catch (Exception e) {
                log.debug("Could not check premium for user {}: {}", userId, e.getMessage());
            }
        }
        return premiumIds;
    }

    private Map<Long, String> loadCefrLevelsBatch(Set<Long> authorIds) {
        Map<Long, String> cefrMap = new HashMap<>();
        if (namedJdbc != null) {
            try {
                namedJdbc.query(
                        """
                        SELECT user_id, current_cefr
                        FROM public.user_proficiency
                        WHERE user_id IN (:userIds)
                          AND overall_status <> 'UNDETERMINED'
                          AND current_cefr IS NOT NULL
                        """,
                        new MapSqlParameterSource("userIds", authorIds),
                        rs -> {
                            String cefr = rs.getString("current_cefr");
                            if (cefr != null && !cefr.isBlank()) {
                                cefrMap.put(rs.getLong("user_id"), cefr);
                            }
                        }
                );
                return cefrMap;
            } catch (Exception e) {
                log.debug("Batch CEFR query failed, falling back per-user: {}", e.getMessage());
            }
        }
        for (Long userId : authorIds) {
            try {
                proficiencyLevelQueryService.currentLevel(userId)
                        .map(Enum::name)
                        .ifPresent(level -> cefrMap.put(userId, level));
            } catch (Exception e) {
                log.debug("Could not fetch CEFR level for user {}: {}", userId, e.getMessage());
            }
        }
        return cefrMap;
    }

    private Map<Long, Integer> loadStreaksBatch(Set<Long> authorIds) {
        Map<Long, Integer> streaks = new HashMap<>(authorIds.size());
        List<Long> missing = new ArrayList<>();
        for (Long userId : authorIds) {
            Integer cached = authorStreakCache.getIfPresent(userId);
            if (cached != null) {
                streaks.put(userId, cached);
            } else {
                missing.add(userId);
            }
        }
        if (missing.isEmpty()) {
            return streaks;
        }
        if (namedJdbc != null) {
            try {
                Map<Long, Set<LocalDate>> datesByUser = new HashMap<>();
                MapSqlParameterSource params = new MapSqlParameterSource()
                        .addValue("userIds", missing)
                        .addValue("timeZone", STREAK_TZ);
                namedJdbc.query(BATCH_ACTIVE_DATES_SQL, params, rs -> {
                    long uid = rs.getLong("user_id");
                    Date sqlDate = rs.getDate("act_date");
                    if (sqlDate != null) {
                        datesByUser.computeIfAbsent(uid, k -> new HashSet<>()).add(sqlDate.toLocalDate());
                    }
                });
                LocalDate today = LocalDate.now(STREAK_ZONE);
                for (Long uid : missing) {
                    int streak = computeCurrentStreak(datesByUser.get(uid), today);
                    authorStreakCache.put(uid, streak);
                    streaks.put(uid, streak);
                }
                return streaks;
            } catch (Exception e) {
                log.debug("Batch streak query failed, falling back to UnifiedProgressService: {}", e.getMessage());
            }
        }
        for (Long uid : missing) {
            int streakDays = 0;
            try {
                UnifiedStreakDto streak = unifiedProgressService.getStreak(uid);
                if (streak != null) {
                    streakDays = streak.currentStreakDays();
                }
            } catch (Exception e) {
                log.debug("Could not fetch streak for user {}: {}", uid, e.getMessage());
            }
            authorStreakCache.put(uid, streakDays);
            streaks.put(uid, streakDays);
        }
        return streaks;
    }

    private static int computeCurrentStreak(Set<LocalDate> activeDates, LocalDate today) {
        if (activeDates == null || activeDates.isEmpty()) {
            return 0;
        }
        LocalDate cursor;
        if (activeDates.contains(today)) {
            cursor = today;
        } else if (activeDates.contains(today.minusDays(1))) {
            cursor = today.minusDays(1);
        } else {
            return 0;
        }
        int streak = 0;
        while (activeDates.contains(cursor)) {
            streak++;
            cursor = cursor.minusDays(1);
        }
        return streak;
    }

    private Set<Long> loadFollowedAuthorIdsBatch(Long currentUserId, Set<Long> authorIds) {
        if (currentUserId == null || authorIds.isEmpty()) {
            return Set.of();
        }
        List<Long> candidates = new ArrayList<>();
        for (Long uid : authorIds) {
            if (!currentUserId.equals(uid)) {
                candidates.add(uid);
            }
        }
        if (candidates.isEmpty()) {
            return Set.of();
        }
        Set<Long> followed = new HashSet<>();
        if (namedJdbc != null) {
            try {
                MapSqlParameterSource params = new MapSqlParameterSource()
                        .addValue("followerId", currentUserId)
                        .addValue("followingIds", candidates);
                namedJdbc.query(
                        """
                        SELECT following_user_id
                        FROM public.community_follows
                        WHERE follower_user_id = :followerId
                          AND following_user_id IN (:followingIds)
                        """,
                        params,
                        rs -> {
                            followed.add(rs.getLong("following_user_id"));
                        }
                );
                return followed;
            } catch (Exception e) {
                log.debug("Batch follow query failed, falling back per-user: {}", e.getMessage());
            }
        }
        for (Long uid : candidates) {
            if (followRepository.existsByFollowerIdAndFollowingId(currentUserId, uid)) {
                followed.add(uid);
            }
        }
        return followed;
    }
}
