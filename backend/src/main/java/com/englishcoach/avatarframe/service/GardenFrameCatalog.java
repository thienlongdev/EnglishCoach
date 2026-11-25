package com.englishcoach.avatarframe.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Echo Garden frames of the avatar-frame catalogue (lineage {@code GARDEN}, V87) as the garden's shop needs them,
 * and the ONE place a coin-bought frame becomes owned.
 *
 * <p>The frame module stays the owner of {@code avatar_frames} / {@code user_avatar_frames}: the garden charges Echo
 * Coins through its own ledger and then calls {@link #grantPurchased} in the same transaction; it never writes these
 * tables itself. A frame bought here is an ordinary ownership row (source {@code GARDEN}) — equipping, the single
 * equipped invariant, rendering and the wardrobe are the existing frame code. Earned Garden frames are not granted here:
 * they are METRIC_THRESHOLD frames unlocked by the existing evaluation engine from stored garden facts.</p>
 *
 * <p>Plain JDBC so the purchase joins the garden's transaction and rolls back with it.</p>
 */
@Service
public class GardenFrameCatalog {

    public static final String LINEAGE = "GARDEN";
    public static final String UNLOCK_COIN = "GARDEN_COIN";
    public static final String SOURCE = "GARDEN";

    public record Requirement(String metric, long target) {}

    /** {@code coinPrice}: the Echo Coin price of a GARDEN_COIN frame, 0 for an earned one. */
    public record Frame(long id, String slug, String name, String tier, String asset, String seriesSlug, String seriesName,
                        String unlockType, long coinPrice, List<Requirement> requirements) {
        public boolean coin() {
            return UNLOCK_COIN.equals(unlockType);
        }
    }

    public record Owned(String source, boolean equipped, Instant unlockedAt) {}

    private final JdbcTemplate jdbc;
    private volatile List<Frame> frames;

    public GardenFrameCatalog(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The active Garden frames in catalogue order (seeded by Flyway, changed only by a migration: loaded once). */
    public List<Frame> frames() {
        List<Frame> f = frames;
        if (f == null) {
            synchronized (this) {
                if (frames == null) frames = load();
                f = frames;
            }
        }
        return f;
    }

    private List<Frame> load() {
        Map<Long, List<Requirement>> reqs = new LinkedHashMap<>();
        jdbc.query("""
                SELECT r.frame_id, r.metric_type, r.target_value FROM public.avatar_frame_requirements r
                JOIN public.avatar_frames f ON f.id = r.frame_id JOIN public.avatar_frame_series s ON s.id = f.series_id
                WHERE s.lineage = ? ORDER BY r.id
                """, (RowCallbackHandler) rs -> reqs.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>())
                .add(new Requirement(rs.getString(2), Long.parseLong(rs.getString(3).trim()))), LINEAGE);
        return List.copyOf(jdbc.query("""
                SELECT f.id, f.slug, f.name, f.tier, f.poster_asset, s.slug AS series_slug, s.name AS series_name, f.unlock_type
                FROM public.avatar_frames f JOIN public.avatar_frame_series s ON s.id = f.series_id
                WHERE s.lineage = ? AND f.is_active ORDER BY f.id
                """, (rs, n) -> {
            List<Requirement> own = reqs.getOrDefault(rs.getLong("id"), List.of());
            boolean coin = UNLOCK_COIN.equals(rs.getString("unlock_type"));
            long price = coin ? own.stream().filter(r -> UNLOCK_COIN.equals(r.metric())).mapToLong(Requirement::target).findFirst().orElse(0) : 0;
            return new Frame(rs.getLong("id"), rs.getString("slug"), rs.getString("name"), rs.getString("tier"), rs.getString("poster_asset"),
                    rs.getString("series_slug"), rs.getString("series_name"), rs.getString("unlock_type"), price,
                    own.stream().filter(r -> !UNLOCK_COIN.equals(r.metric())).toList());
        }, LINEAGE));
    }

    public Frame frame(String slug) {
        return frames().stream().filter(f -> f.slug().equals(slug)).findFirst().orElse(null);
    }

    /** slug → this account's real ownership row of a Garden frame (never the administrator's virtual preview). */
    public Map<String, Owned> owned(long userId) {
        Map<String, Owned> out = new LinkedHashMap<>();
        jdbc.query("""
                SELECT f.slug, u.source, u.is_equipped, u.unlocked_at FROM public.user_avatar_frames u
                JOIN public.avatar_frames f ON f.id = u.frame_id JOIN public.avatar_frame_series s ON s.id = f.series_id
                WHERE u.user_id = ? AND s.lineage = ?
                """, (RowCallbackHandler) rs -> out.put(rs.getString(1), new Owned(rs.getString(2), rs.getBoolean(3),
                rs.getTimestamp(4) == null ? null : rs.getTimestamp(4).toInstant())), userId, LINEAGE);
        return out;
    }

    /**
     * Makes a coin-bought Garden frame owned by its buyer. Only a GARDEN_COIN frame can be granted this way — an earned
     * frame is refused, so a purchase can never stand in for its requirement.
     *
     * @return false when the account already owns the frame (the caller then charges nothing: its transaction rolls back)
     */
    public boolean grantPurchased(long userId, String slug, Instant now) {
        Frame frame = frame(slug);
        if (frame == null || !frame.coin() || frame.coinPrice() <= 0) throw new IllegalArgumentException("not a purchasable garden frame: " + slug);
        return jdbc.update("""
                INSERT INTO public.user_avatar_frames(user_id, frame_id, unlocked_at, source, is_equipped, created_at)
                VALUES (?, ?, ?, ?, FALSE, ?) ON CONFLICT (user_id, frame_id) DO NOTHING
                """, userId, frame.id(), Timestamp.from(now), SOURCE, Timestamp.from(now)) == 1;
    }
}
