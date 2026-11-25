package com.englishcoach.leaderboard.board;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Batch display lookup for board rows (one query for names/avatars, one for frames): display name
 * and avatar only — never email. READ-ONLY on users / user_profiles / avatar frames.
 * The avatar-frame tables (V51) may be absent in an environment; then every frame is null.
 */
@Repository
@RequiredArgsConstructor
public class LeaderboardDisplayRepository {

    /** Only when the user row itself is missing; otherwise {@link #publicName} gives a per-learner fallback. */
    static final String FALLBACK_NAME = "Người học";
    static final String FALLBACK_PREFIX = "Học viên #";
    private static final java.util.regex.Pattern EMAIL = java.util.regex.Pattern.compile("\\S+@\\S+");

    private final NamedParameterJdbcTemplate jdbc;
    private final LeaderboardProperties boardProps;
    private volatile Boolean framesAvailable;

    public record Frame(String slug, String tier, String renderType, String posterAsset) {}

    /**
     * @param excluded       admin, non-ACTIVE account or listed in app.leaderboard.excluded-user-ids (never ranked)
     * @param excludedReason why (null when not excluded): ADMIN, INACTIVE or EXCLUDED_TEST — precedence in that order
     */
    public record Display(long userId, String displayName, String avatarUrl, Frame frame, boolean excluded,
                          String excludedReason) {
        public Display(long userId, String displayName, String avatarUrl, Frame frame, boolean excluded) {
            this(userId, displayName, avatarUrl, frame, excluded, excluded ? EXCLUDED_TEST : null);
        }
    }

    public static final String ADMIN = "ADMIN";
    public static final String INACTIVE = "INACTIVE";
    public static final String EXCLUDED_TEST = "EXCLUDED_TEST";

    public Map<Long, Display> find(Collection<Long> userIds) {
        Map<Long, Display> out = new HashMap<>();
        if (userIds == null || userIds.isEmpty()) {
            return out;
        }
        Map<Long, Frame> frames = frames(userIds);
        jdbc.query("""
                SELECT u.id, u.name, u.role, u.account_status, p.display_name, p.avatar_storage_key, p.avatar_updated_at
                FROM public.users u
                LEFT JOIN public.user_profiles p ON p.user_id = u.id
                WHERE u.id IN (:ids)
                """, new MapSqlParameterSource("ids", userIds), rs -> {
                    long id = rs.getLong("id");
                    String name = publicName(rs.getString("display_name"), rs.getString("name"), id);
                    String key = rs.getString("avatar_storage_key");
                    Timestamp updated = rs.getTimestamp("avatar_updated_at");
                    String avatarUrl = key == null || key.isBlank() ? null
                            : "/api/v1/users/" + id + "/avatar" + (updated == null ? "" : "?v=" + updated.getTime());
                    String reason = "ROLE_ADMIN".equals(rs.getString("role")) ? ADMIN
                            : !"ACTIVE".equals(rs.getString("account_status")) ? INACTIVE
                            : boardProps.isExcluded(id) ? EXCLUDED_TEST : null;
                    out.put(id, new Display(id, name, avatarUrl, frames.get(id), reason != null, reason));
                });
        return out;
    }

    private Map<Long, Frame> frames(Collection<Long> userIds) {
        Map<Long, Frame> out = new HashMap<>();
        if (!framesAvailable()) {
            return out;
        }
        jdbc.query("""
                SELECT uaf.user_id, f.slug, f.tier, f.render_type, f.poster_asset
                FROM public.user_avatar_frames uaf
                JOIN public.avatar_frames f ON f.id = uaf.frame_id
                WHERE uaf.user_id IN (:ids) AND uaf.is_equipped = TRUE AND f.is_active = TRUE
                  AND (uaf.expires_at IS NULL OR uaf.expires_at > now())
                """, new MapSqlParameterSource("ids", userIds), rs -> {
                    out.put(rs.getLong("user_id"), new Frame(rs.getString("slug"), rs.getString("tier"),
                            rs.getString("render_type"), rs.getString("poster_asset")));
                });
        return out;
    }

    /** V51 is not deployed everywhere: probe once (schema does not change while the app runs). */
    private boolean framesAvailable() {
        Boolean cached = framesAvailable;
        if (cached == null) {
            cached = Boolean.TRUE.equals(jdbc.getJdbcTemplate().queryForObject(
                    "SELECT to_regclass('public.user_avatar_frames') IS NOT NULL AND to_regclass('public.avatar_frames') IS NOT NULL",
                    Boolean.class));
            framesAvailable = cached;
        }
        return cached;
    }

    /**
     * Public name: profile display name, else account name — with every e-mail-like token removed (e.g.
     * "Test User (learner@x.app)" ⇒ "Test User"); nothing left ⇒ "Học viên #id" (distinct per learner, never a
     * repeated placeholder, never an address).
     */
    static String publicName(String displayName, String accountName, long userId) {
        String a = clean(displayName);
        if (a != null) return a;
        String b = clean(accountName);
        if (b != null) return b;
        return FALLBACK_PREFIX + userId;
    }

    private static String clean(String s) {
        if (s == null) return null;
        String t = EMAIL.matcher(s).replaceAll(" ").replace("()", " ").replace("<>", " ").replace("[]", " ");
        t = t.replaceAll("\\s+", " ").trim();
        // strip separators left at the ends ("Learner -", "- Learner")
        t = t.replaceAll("^[\\s\\-–|:,;]+|[\\s\\-–|:,;]+$", "").trim();
        return t.isEmpty() || t.contains("@") ? null : t;
    }
}
