package com.englishcoach.garden.infra;

import com.englishcoach.garden.domain.SocialEngine;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Phase 3G SQL of the social islands (V88: {@code garden_social_profile}, {@code garden_visit}, {@code garden_theft}).
 * Discovery and search read the garden's own tables only; the account tables are touched in exactly two places, both
 * read-only: the public name of ONE user ({@link #publicName}) and the {@code ACTIVE} account join of the listings.
 * Nothing here returns an e-mail address, a login identifier or an account id to a caller that maps it to a client.
 */
@Repository
public class SocialRepository {

    /** Handle alphabet: no I, O, 0, 1 (unambiguous when read aloud or typed). */
    private static final char[] ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();
    public static final String HANDLE_PATTERN = "^[A-HJ-NP-Z2-9]{8}$";

    public record Profile(long userId, String handle, String visibility, Instant visibilityChangedAt, String displayName,
                          Instant lastActiveAt, Instant activitySeenAt, Instant createdAt) {

        public boolean open() {
            return "PUBLIC".equals(visibility);
        }
    }

    /** A discoverable island with the progression facts its card shows (all stored garden facts). */
    public record Island(long userId, String handle, String displayName, Instant lastActiveAt, long totalXp, int beds, int era,
                         int forestTrees, Instant visitedAt) {}

    public record Take(long id, long victimId, long thiefId, long plantingId, String cropCode, int portions, int unitPortions,
                       Instant createdAt) {}

    /** One line of the activity record as the reader sees it: the other party by public name and (if open) handle. */
    public record Activity(long id, boolean mine, String otherName, String otherHandle, boolean otherOpen, String cropCode,
                           int portions, int unitPortions, Instant createdAt) {}

    public record Reaction(String visitorName, String visitorHandle, boolean visitorOpen, String code, Instant at) {}

    public record VisitRow(Instant lastVisitAt, int visits, String reactionCode, Instant reactionAt) {}

    private final GardenJdbc jdbc;
    private final SecureRandom random = new SecureRandom();

    public SocialRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- identity (read-only on the account tables)

    /**
     * The product's existing public name of one user: profile display name, else account name, with e-mail-like text
     * removed; null when nothing is left (the caller then names the island by its handle).
     */
    public String publicName(long userId) {
        var rows = jdbc.query("""
                SELECT p.display_name, u.name FROM public.users u
                LEFT JOIN public.user_profiles p ON p.user_id = u.id WHERE u.id = ?
                """, (rs, n) -> {
            String a = SocialEngine.cleanName(rs.getString(1));
            return a != null ? a : SocialEngine.cleanName(rs.getString(2));
        }, userId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    // ----------------------------------------------------------------- social profile

    private static final RowMapper<Profile> PROFILE = (rs, n) -> new Profile(rs.getLong("user_id"), rs.getString("handle"),
            rs.getString("visibility"), inst(rs, "visibility_changed_at"), rs.getString("display_name"),
            inst(rs, "last_active_at"), inst(rs, "activity_seen_at"), inst(rs, "created_at"));

    public Profile profile(long userId) {
        var rows = jdbc.query("SELECT * FROM public.garden_social_profile WHERE user_id = ?", PROFILE, userId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The profile behind a handle whose account is ACTIVE, whatever its visibility (the caller decides what to show). */
    public Profile byHandle(String handle) {
        var rows = jdbc.query("""
                SELECT sp.* FROM public.garden_social_profile sp
                JOIN public.users u ON u.id = sp.user_id AND u.account_status = 'ACTIVE'
                WHERE sp.handle = ?
                """, PROFILE, handle);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * Creates the caller's social profile once (PUBLIC, a fresh random handle) and returns it. {@code name} null = the
     * island is named by its handle. A handle collision simply draws again.
     */
    public Profile ensure(long userId, String name, Instant now) {
        return ensure(userId, name, now, "PUBLIC");
    }

    /**
     * Phase 3H: {@code visibility} is what the island starts with. From V89 on a new island starts PRIVATE and its owner
     * is asked once ({@code visibility_chosen_at} stays NULL until then), so nobody is listed before they decided.
     */
    public Profile ensure(long userId, String name, Instant now, String visibility) {
        Profile existing = profile(userId);
        if (existing != null) return existing;
        for (int attempt = 0; attempt < 8; attempt++) {
            String handle = newHandle();
            String display = name != null ? name : "Người chơi " + handle;
            // any conflict inserts nothing (never an error inside the caller's transaction): the row exists afterwards
            // unless another garden already drew this handle, and then the loop draws again
            jdbc.update("""
                    INSERT INTO public.garden_social_profile(user_id, handle, visibility, visibility_changed_at, display_name,
                        name_key, last_active_at, activity_seen_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
                    """, userId, handle, visibility, ts(now), display, SocialEngine.nameKey(display), ts(now), ts(now), ts(now));
            Profile created = profile(userId);
            if (created != null) return created;
        }
        throw new IllegalStateException("no free garden handle");
    }

    /** Refreshes the public-name snapshot and the activity time of the caller's own profile. */
    public void touch(long userId, String name, Instant now) {
        if (name == null) {
            jdbc.updateLater("UPDATE public.garden_social_profile SET last_active_at = ? WHERE user_id = ?", ts(now), userId);
        } else {
            jdbc.updateLater("UPDATE public.garden_social_profile SET display_name = ?, name_key = ?, last_active_at = ? WHERE user_id = ?",
                    name, SocialEngine.nameKey(name), ts(now), userId);
        }
    }

    /** @return false when the island already has this visibility (nothing changes, the change time is kept). */
    public boolean setVisibility(long userId, String visibility, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_social_profile SET visibility = ?, visibility_changed_at = ?
                WHERE user_id = ? AND visibility <> ?
                """, visibility, ts(now), userId, visibility) == 1;
    }

    /** Phase 3H (V89 schema only): whether the owner has decided who may find the island. */
    public boolean visibilityChosen(long userId) {
        Boolean chosen = jdbc.queryForObject(
                "SELECT COALESCE(bool_or(visibility_chosen_at IS NOT NULL), FALSE) FROM public.garden_social_profile WHERE user_id = ?",
                Boolean.class, userId);
        return Boolean.TRUE.equals(chosen);
    }

    /** Phase 3H (V89 schema only): records the owner's first decision; later changes keep that time. */
    public void markVisibilityChosen(long userId, Instant now) {
        jdbc.update("UPDATE public.garden_social_profile SET visibility_chosen_at = COALESCE(visibility_chosen_at, ?) WHERE user_id = ?",
                ts(now), userId);
    }

    public void markSeen(long userId, Instant now) {
        jdbc.update("UPDATE public.garden_social_profile SET activity_seen_at = GREATEST(activity_seen_at, ?) WHERE user_id = ?",
                ts(now), userId);
    }

    private String newHandle() {
        char[] out = new char[8];
        for (int i = 0; i < out.length; i++) out[i] = ALPHABET[random.nextInt(ALPHABET.length)];
        return new String(out);
    }

    // ----------------------------------------------------------------- discovery

    /**
     * The card facts of an island, in one statement per page (correlated lookups on the owner's indexed rows; no
     * per-island round trip). {@code allow}: the garden allowlist while the garden is not open to everyone, else null.
     */
    private static final String ISLAND_SELECT = """
            SELECT sp.user_id, sp.handle, sp.display_name, sp.last_active_at, gp.total_xp,
                   (SELECT count(*) FROM public.garden_plot pl WHERE pl.user_id = sp.user_id AND pl.kind = 'CROP') AS beds,
                   COALESCE((SELECT m.era FROM public.garden_monument m WHERE m.user_id = sp.user_id), 0) AS era,
                   (SELECT count(*) FROM public.garden_knowledge_tree t WHERE t.user_id = sp.user_id AND t.status = 'GRADUATED') AS forest,
                   v.last_visit_at AS visited_at
            FROM public.garden_social_profile sp
            JOIN public.garden_profile gp ON gp.user_id = sp.user_id
            JOIN public.users u ON u.id = sp.user_id AND u.account_status = 'ACTIVE'
            LEFT JOIN public.garden_visit v ON v.host_id = sp.user_id AND v.visitor_id = ?
            WHERE sp.visibility = 'PUBLIC' AND sp.user_id <> ?
              AND (?::bigint[] IS NULL OR sp.user_id = ANY(?::bigint[]))
            """;

    private static final RowMapper<Island> ISLAND = (rs, n) -> new Island(rs.getLong("user_id"), rs.getString("handle"),
            rs.getString("display_name"), inst(rs, "last_active_at"), rs.getLong("total_xp"), rs.getInt("beds"), rs.getInt("era"),
            rs.getInt("forest"), inst(rs, "visited_at"));

    /** Open islands, most recently active first; the cursor is the last row's (activity time, handle). */
    public List<Island> discover(long me, Collection<Long> allow, Instant beforeAt, String beforeHandle, int limit) {
        boolean first = beforeAt == null || beforeHandle == null;
        String sql = ISLAND_SELECT + (first ? "" : " AND (sp.last_active_at, sp.handle) < (?, ?)")
                + " ORDER BY sp.last_active_at DESC, sp.handle DESC LIMIT ?";
        return jdbc.query(sql, ps -> {
            int i = bindScope(ps, me, allow);
            if (!first) {
                ps.setTimestamp(i++, ts(beforeAt));
                ps.setString(i++, beforeHandle);
            }
            ps.setInt(i, limit);
        }, ISLAND);
    }

    /** Open islands whose folded public name starts with {@code key}, or the one island with this exact handle. */
    public List<Island> search(long me, Collection<Long> allow, String key, String handle, int limit) {
        String sql = ISLAND_SELECT + " AND (sp.name_key LIKE ? ESCAPE '\\' OR sp.handle = ?) ORDER BY sp.name_key, sp.handle LIMIT ?";
        String prefix = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        return jdbc.query(sql, ps -> {
            int i = bindScope(ps, me, allow);
            ps.setString(i++, prefix);
            ps.setString(i++, handle == null ? "" : handle);
            ps.setInt(i, limit);
        }, ISLAND);
    }

    /** Islands the caller visited that are still open, last visit first. */
    public List<Island> visited(long me, Collection<Long> allow, int limit) {
        String sql = ISLAND_SELECT + " AND v.last_visit_at IS NOT NULL ORDER BY v.last_visit_at DESC, sp.handle LIMIT ?";
        return jdbc.query(sql, ps -> ps.setInt(bindScope(ps, me, allow), limit), ISLAND);
    }

    /** One open island by owner (the card facts of the island being visited). */
    public Island island(long me, long hostId) {
        String sql = ISLAND_SELECT + " AND sp.user_id = ?";
        var rows = jdbc.query(sql, ps -> ps.setLong(bindScope(ps, me, null), hostId), ISLAND);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static int bindScope(java.sql.PreparedStatement ps, long me, Collection<Long> allow) throws SQLException {
        ps.setLong(1, me);
        ps.setLong(2, me);
        java.sql.Array ids = allow == null || allow.isEmpty() ? null : ps.getConnection().createArrayOf("bigint", allow.toArray());
        ps.setArray(3, ids);
        ps.setArray(4, ids);
        return 5;
    }

    // ----------------------------------------------------------------- visits and reactions

    public void recordVisit(long visitorId, long hostId, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_visit(visitor_id, host_id, first_visit_at, last_visit_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (visitor_id, host_id) DO UPDATE SET last_visit_at = EXCLUDED.last_visit_at,
                    visits = public.garden_visit.visits + 1
                """, visitorId, hostId, ts(now), ts(now));
    }

    public VisitRow visit(long visitorId, long hostId) {
        var rows = jdbc.query("SELECT last_visit_at, visits, reaction_code, reaction_at FROM public.garden_visit WHERE visitor_id = ? AND host_id = ?",
                (rs, n) -> new VisitRow(inst(rs, "last_visit_at"), rs.getInt("visits"), rs.getString("reaction_code"), inst(rs, "reaction_at")),
                visitorId, hostId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One reaction per visitor and island per cooldown: false = the visitor never came, or reacted too recently. */
    public boolean react(long visitorId, long hostId, String code, Instant now, Instant notAfter) {
        return jdbc.update("""
                UPDATE public.garden_visit SET reaction_code = ?, reaction_at = ?
                WHERE visitor_id = ? AND host_id = ? AND (reaction_at IS NULL OR reaction_at <= ?)
                """, code, ts(now), visitorId, hostId, ts(notAfter)) == 1;
    }

    public List<Reaction> reactions(long hostId, int limit) {
        return jdbc.query("""
                SELECT sp.display_name, sp.handle, sp.visibility, v.reaction_code, v.reaction_at
                FROM public.garden_visit v JOIN public.garden_social_profile sp ON sp.user_id = v.visitor_id
                WHERE v.host_id = ? AND v.reaction_at IS NOT NULL ORDER BY v.reaction_at DESC LIMIT ?
                """, (rs, n) -> new Reaction(rs.getString(1), rs.getString(2), "PUBLIC".equals(rs.getString(3)), rs.getString(4),
                inst(rs, "reaction_at")), hostId, limit);
    }

    // ----------------------------------------------------------------- takes

    private static final RowMapper<Take> TAKE = (rs, n) -> new Take(rs.getLong("id"), rs.getLong("victim_id"), rs.getLong("thief_id"),
            rs.getLong("planting_id"), rs.getString("crop_code"), rs.getInt("portions"), rs.getInt("unit_portions"), inst(rs, "created_at"));

    /** Portions already taken from one planting (0 = untouched). */
    public int takenPortions(long plantingId) {
        var rows = jdbc.queryForList("SELECT portions FROM public.garden_theft WHERE planting_id = ?", Integer.class, plantingId);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    /** Portions taken from each of these plantings (absent = untouched). */
    public Map<Long, Integer> takenPortions(Collection<Long> plantingIds) {
        Map<Long, Integer> out = new HashMap<>();
        if (plantingIds.isEmpty()) return out;
        jdbc.query("SELECT planting_id, portions FROM public.garden_theft WHERE planting_id = ANY(?)",
                ps -> ps.setArray(1, ps.getConnection().createArrayOf("bigint", plantingIds.toArray())),
                (RowCallbackHandler) rs -> out.put(rs.getLong(1), rs.getInt(2)));
        return out;
    }

    /** Portions taken from the owner's crops that are still unharvested (what the owner's beds show). */
    public Map<Long, Integer> takenFromActive(long ownerId) {
        Map<Long, Integer> out = new HashMap<>();
        jdbc.query("""
                SELECT t.planting_id, t.portions FROM public.garden_theft t
                JOIN public.garden_planting p ON p.id = t.planting_id AND p.user_id = t.victim_id
                WHERE t.victim_id = ? AND p.harvested_at IS NULL
                """, (RowCallbackHandler) rs -> out.put(rs.getLong(1), rs.getInt(2)), ownerId);
        return out;
    }

    /**
     * Records a take once. The unique planting key makes "a crop is taken from at most once" a database fact: a second
     * take of the same crop inserts nothing and returns null.
     */
    public Long insertTake(long victimId, long thiefId, long plantingId, String crop, int portions, int unitPortions, UUID opKey,
                           Instant now) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_theft(victim_id, thief_id, planting_id, crop_code, portions, unit_portions, op_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (planting_id) DO NOTHING RETURNING id
                """, Long.class, victimId, thiefId, plantingId, crop, portions, unitPortions, opKey, ts(now));
        return ids.isEmpty() ? null : ids.getFirst();
    }

    /** When this player took, over all islands, since an instant (oldest first). */
    public List<Instant> takesBy(long thiefId, Instant since) {
        return jdbc.query("SELECT created_at FROM public.garden_theft WHERE thief_id = ? AND created_at > ? ORDER BY created_at",
                (rs, n) -> inst(rs, "created_at"), thiefId, ts(since));
    }

    /** When this island was taken from since an instant (oldest first). */
    public List<Instant> takesOn(long victimId, Instant since) {
        return jdbc.query("SELECT created_at FROM public.garden_theft WHERE victim_id = ? AND created_at > ? ORDER BY created_at",
                (rs, n) -> inst(rs, "created_at"), victimId, ts(since));
    }

    public List<Instant> pairTakes(long thiefId, long victimId, Instant since) {
        return jdbc.query("SELECT created_at FROM public.garden_theft WHERE thief_id = ? AND victim_id = ? AND created_at > ? ORDER BY created_at",
                (rs, n) -> inst(rs, "created_at"), thiefId, victimId, ts(since));
    }

    public Take take(long id) {
        var rows = jdbc.query("SELECT * FROM public.garden_theft WHERE id = ?", TAKE, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The reader's own activity record, newest first (keyset on the id): what was taken from their island and what
     * they took. The other party is always a real garden: its public name, and its handle while it is open.
     */
    public List<Activity> activity(long userId, Long beforeId, int limit) {
        return jdbc.query("""
                SELECT t.id, (t.thief_id = ?) AS mine, sp.display_name, sp.handle, sp.visibility, t.crop_code, t.portions,
                       t.unit_portions, t.created_at
                FROM public.garden_theft t
                JOIN public.garden_social_profile sp ON sp.user_id = CASE WHEN t.thief_id = ? THEN t.victim_id ELSE t.thief_id END
                WHERE (t.victim_id = ? OR t.thief_id = ?) AND (?::bigint IS NULL OR t.id < ?)
                ORDER BY t.id DESC LIMIT ?
                """, (rs, n) -> new Activity(rs.getLong(1), rs.getBoolean(2), rs.getString(3), rs.getString(4),
                "PUBLIC".equals(rs.getString(5)), rs.getString(6), rs.getInt(7), rs.getInt(8), inst(rs, "created_at")),
                userId, userId, userId, userId, beforeId, beforeId, limit);
    }

    /** Takes from the owner's island and reactions left on it since the owner last opened the activity record. */
    public int unread(long ownerId, Instant seenAt) {
        Integer n = jdbc.queryForObject("""
                SELECT (SELECT count(*) FROM public.garden_theft WHERE victim_id = ? AND created_at > ?)
                     + (SELECT count(*) FROM public.garden_visit WHERE host_id = ? AND reaction_at > ?)
                """, Integer.class, ownerId, ts(seenAt), ownerId, ts(seenAt));
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- helpers

    static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    static Instant inst(ResultSet rs, String col) throws SQLException {
        Timestamp t = rs.getTimestamp(col);
        return t == null ? null : t.toInstant();
    }

    /** Fragment rows of an inventory (item code {@code SHARE:<crop>}). */
    public List<GardenRepository.Item> shares(long userId) {
        List<GardenRepository.Item> out = new ArrayList<>();
        jdbc.query("SELECT item_code, tier, qty FROM public.garden_inventory WHERE user_id = ? AND item_code LIKE 'SHARE:%' AND qty > 0 ORDER BY item_code, tier",
                (RowCallbackHandler) rs -> out.add(new GardenRepository.Item(rs.getString(1), rs.getString(2), rs.getInt(3))), userId);
        return out;
    }
}
