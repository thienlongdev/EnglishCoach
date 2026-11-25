package com.englishcoach.wallpaper;

import com.englishcoach.wallpaper.WallpaperLibraryDtos.Background;
import com.englishcoach.wallpaper.WallpaperLibraryDtos.Entry;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** "Video YouTube của tôi" rows. Every statement is scoped by {@code user_id}: another learner's row is never read or written. */
@Repository
public class WallpaperLibraryRepository {

    private static final String COLUMNS = "id, video_id, background_kind, background_url, background_file_name, created_at, updated_at";
    private static final int LOCK_SPACE = 0x5770; // "Wp"

    private final JdbcTemplate jdbc;

    public WallpaperLibraryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Serialises the writes of one learner (transaction-scoped advisory lock), so the per-learner limit holds. */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_SPACE, (int) (userId ^ (userId >>> 32)));
    }

    public List<Entry> list(long userId, int limit) {
        return jdbc.query("SELECT " + COLUMNS + " FROM public.wallpaper_youtube_videos WHERE user_id = ? "
                + "ORDER BY created_at DESC, id LIMIT ?", this::row, userId, limit);
    }

    public Optional<Entry> find(long userId, UUID id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM public.wallpaper_youtube_videos WHERE id = ? AND user_id = ?",
                this::row, id, userId).stream().findFirst();
    }

    public Optional<Entry> findByVideo(long userId, String videoId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM public.wallpaper_youtube_videos WHERE user_id = ? AND video_id = ?",
                this::row, userId, videoId).stream().findFirst();
    }

    public int count(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.wallpaper_youtube_videos WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    public Optional<Instant> oldestCreatedAt(long userId) {
        Timestamp t = jdbc.queryForObject("SELECT min(created_at) FROM public.wallpaper_youtube_videos WHERE user_id = ?", Timestamp.class, userId);
        return Optional.ofNullable(t).map(Timestamp::toInstant);
    }

    /** Inserts unless the learner already saved that video; returns the stored row either way. */
    public Entry insert(long userId, String videoId, Instant createdAt) {
        jdbc.update("""
                INSERT INTO public.wallpaper_youtube_videos (id, user_id, video_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, video_id) DO NOTHING""",
                UUID.randomUUID(), userId, videoId, Timestamp.from(createdAt), Timestamp.from(createdAt));
        return findByVideo(userId, videoId).orElseThrow();
    }

    /** Sets (or clears, with kind null) the background source of the learner's own entry; false when they own no such entry. */
    public boolean setBackground(long userId, UUID id, String kind, String url, String fileName) {
        return jdbc.update("""
                UPDATE public.wallpaper_youtube_videos
                SET background_kind = ?, background_url = ?, background_file_name = ?, updated_at = now()
                WHERE id = ? AND user_id = ?""", kind, url, fileName, id, userId) == 1;
    }

    public boolean delete(long userId, UUID id) {
        return jdbc.update("DELETE FROM public.wallpaper_youtube_videos WHERE id = ? AND user_id = ?", id, userId) == 1;
    }

    private Entry row(ResultSet rs, int n) throws SQLException {
        String kind = rs.getString("background_kind");
        Background background = kind == null ? null
                : new Background(kind, rs.getString("background_url"), rs.getString("background_file_name"));
        return new Entry(rs.getObject("id", UUID.class), rs.getString("video_id"), background,
                rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant());
    }
}
