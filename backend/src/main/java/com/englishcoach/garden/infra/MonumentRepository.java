package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Collection;
import java.util.List;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * The monumental Knowledge Tree's persistence (Phase 3B, V82): lifetime counters, verified learning days, graduation
 * credit and the permanent milestone history. Every statement is scoped by {@code user_id}. The Flashcard review log
 * ({@code learning_activity_events}) is READ ONLY. Counters and day flags only grow: the SQL is monotone and the V82
 * triggers reject anything else.
 */
@Repository
public class MonumentRepository {

    public record MonumentRow(int era, int learningDays, int vocabularyDays, int listeningDays, int speakingDays,
                              int writingDays, int examDays, int graduations, LocalDate reviewDaysThrough,
                              Instant masterySeededAt) {}

    public record DayCounts(int days, int vocabulary, int listening, int speaking, int writing, int exam) {}

    public record DayFlags(boolean vocabulary, boolean listening, boolean speaking, boolean writing, boolean exam,
                           boolean play) {

        public static final DayFlags NONE = new DayFlags(false, false, false, false, false, false);

        public boolean any() {
            return vocabulary || listening || speaking || writing || exam || play;
        }
    }

    public record GraduatedTree(long id, Instant graduatedAt) {}

    public record MilestoneRow(long id, String kind, String code, int tier, Instant reachedAt, Instant seenAt) {}

    private final JdbcTemplate jdbc;

    public MonumentRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- monument row

    public void ensure(long userId, Instant now) {
        // an existing monument needs no insert (the caller holds the garden lock): one write less on every request
        if (row(userId) != null) return;
        GardenScope.evict("monument:" + userId);
        jdbc.update("""
                INSERT INTO public.garden_monument(user_id, created_at, updated_at) VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO NOTHING
                """, userId, ts(now), ts(now));
    }

    /** The monument of a garden, or null before its first reconcile. */
    public MonumentRow row(long userId) {
        // memoized for the transaction (GardenScope); ensure / save / markMasterySeeded evict it
        return GardenScope.get("monument:" + userId, () -> {
            var rows = jdbc.query("SELECT * FROM public.garden_monument WHERE user_id = ?", (rs, n) -> {
                Date through = rs.getDate("review_days_through");
                return new MonumentRow(rs.getInt("era"), rs.getInt("learning_days"), rs.getInt("vocabulary_days"),
                        rs.getInt("listening_days"), rs.getInt("speaking_days"), rs.getInt("writing_days"), rs.getInt("exam_days"),
                        rs.getInt("graduations"), through == null ? null : through.toLocalDate(), inst(rs, "mastery_seeded_at"));
            }, userId);
            return rows.isEmpty() ? null : rows.getFirst();
        });
    }

    /** Stores the recounted totals; every column can only rise (the era is the maximum ever reached). */
    public void save(long userId, DayCounts c, int graduations, int era, LocalDate reviewDaysThrough, Instant now) {
        GardenScope.evict("monument:" + userId);
        jdbc.update("""
                UPDATE public.garden_monument SET era = GREATEST(era, ?), learning_days = GREATEST(learning_days, ?),
                    vocabulary_days = GREATEST(vocabulary_days, ?), listening_days = GREATEST(listening_days, ?),
                    speaking_days = GREATEST(speaking_days, ?), writing_days = GREATEST(writing_days, ?),
                    exam_days = GREATEST(exam_days, ?), graduations = GREATEST(graduations, ?),
                    review_days_through = GREATEST(review_days_through, ?), updated_at = ?
                WHERE user_id = ?
                """, era, c.days(), c.vocabulary(), c.listening(), c.speaking(), c.writing(), c.exam(), graduations,
                reviewDaysThrough == null ? null : Date.valueOf(reviewDaysThrough), ts(now), userId);
    }

    public void markMasterySeeded(long userId, Instant now) {
        GardenScope.evict("monument:" + userId);
        jdbc.update("UPDATE public.garden_monument SET mastery_seeded_at = ? WHERE user_id = ? AND mastery_seeded_at IS NULL",
                ts(now), userId);
    }

    // ----------------------------------------------------------------- verified learning days

    /**
     * Vietnam days since {@code since} on which at least {@code minCards} DIFFERENT cards were reviewed (Flashcard
     * review log, one row per review: {@code source_ref = cardId:reviewCount}), oldest first, at most {@code limit}.
     * Bounded by the (user_id, occurred_at) index from the watermark day.
     */
    public List<LocalDate> reviewDays(long userId, Instant since, ZoneId zone, int minCards, int limit) {
        return jdbc.query("""
                SELECT (occurred_at AT TIME ZONE ?)::date AS d FROM public.learning_activity_events
                WHERE user_id = ? AND activity_type = 'FLASHCARD_REVIEWED' AND occurred_at >= ?
                GROUP BY 1 HAVING count(DISTINCT split_part(source_ref, ':', 1)) >= ?
                ORDER BY 1 LIMIT ?
                """, (rs, n) -> rs.getDate(1).toLocalDate(), zone.getId(), userId, ts(since), minCards, limit);
    }

    /** Different cards reviewed since an instant (today's progress toward a verified vocabulary day). */
    public int cardsReviewedSince(long userId, Instant since) {
        Integer n = jdbc.queryForObject("""
                SELECT count(DISTINCT split_part(source_ref, ':', 1)) FROM public.learning_activity_events
                WHERE user_id = ? AND activity_type = 'FLASHCARD_REVIEWED' AND occurred_at >= ?
                """, Integer.class, userId, ts(since));
        return n == null ? 0 : n;
    }

    /**
     * Records a verified day or raises new family flags on it; true when something new was stored (a repeated
     * reconcile of the same facts changes nothing).
     */
    public boolean recordDay(long userId, LocalDate day, DayFlags f, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_monument_day AS d
                    (user_id, day_key, vocabulary, listening, speaking, writing, exam, play, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, day_key) DO UPDATE SET vocabulary = d.vocabulary OR EXCLUDED.vocabulary,
                    listening = d.listening OR EXCLUDED.listening, speaking = d.speaking OR EXCLUDED.speaking,
                    writing = d.writing OR EXCLUDED.writing, exam = d.exam OR EXCLUDED.exam, play = d.play OR EXCLUDED.play
                WHERE (EXCLUDED.vocabulary AND NOT d.vocabulary) OR (EXCLUDED.listening AND NOT d.listening)
                   OR (EXCLUDED.speaking AND NOT d.speaking) OR (EXCLUDED.writing AND NOT d.writing)
                   OR (EXCLUDED.exam AND NOT d.exam) OR (EXCLUDED.play AND NOT d.play)
                """, userId, Date.valueOf(day), f.vocabulary(), f.listening(), f.speaking(), f.writing(), f.exam(), f.play(),
                ts(now)) == 1;
    }

    public DayCounts counts(long userId) {
        return jdbc.queryForObject("""
                SELECT count(*), count(*) FILTER (WHERE vocabulary), count(*) FILTER (WHERE listening),
                       count(*) FILTER (WHERE speaking), count(*) FILTER (WHERE writing), count(*) FILTER (WHERE exam)
                FROM public.garden_monument_day WHERE user_id = ?
                """, (rs, n) -> new DayCounts(rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5), rs.getInt(6)),
                userId);
    }

    public DayFlags day(long userId, LocalDate day) {
        var rows = jdbc.query("""
                SELECT vocabulary, listening, speaking, writing, exam, play FROM public.garden_monument_day
                WHERE user_id = ? AND day_key = ?
                """, (rs, n) -> new DayFlags(rs.getBoolean(1), rs.getBoolean(2), rs.getBoolean(3), rs.getBoolean(4),
                rs.getBoolean(5), rs.getBoolean(6)), userId, Date.valueOf(day));
        return rows.isEmpty() ? DayFlags.NONE : rows.getFirst();
    }

    // ----------------------------------------------------------------- graduation credit

    /** Graduated trees not examined yet, oldest first (each is examined exactly once). */
    public List<GraduatedTree> unexaminedGraduations(long userId, int limit) {
        return jdbc.query("""
                SELECT t.id, t.graduated_at FROM public.garden_knowledge_tree t
                WHERE t.user_id = ? AND t.status = 'GRADUATED'
                  AND NOT EXISTS (SELECT 1 FROM public.garden_monument_credit c WHERE c.user_id = t.user_id AND c.tree_id = t.id)
                ORDER BY t.graduated_at, t.id LIMIT ?
                """, (rs, n) -> new GraduatedTree(rs.getLong(1), inst(rs, "graduated_at")), userId, limit);
    }

    /** Which of these cards already counted for the monument through an earlier tree. */
    public List<Long> creditedWords(long userId, Collection<Long> flashcardIds) {
        if (flashcardIds.isEmpty()) return List.of();
        return jdbc.query("SELECT flashcard_id FROM public.garden_monument_word WHERE user_id = ? AND flashcard_id = ANY(?)",
                ps -> {
                    ps.setLong(1, userId);
                    ps.setArray(2, ps.getConnection().createArrayOf("bigint", flashcardIds.toArray()));
                }, (rs, n) -> rs.getLong(1));
    }

    /** False when the tree was examined before (concurrent reconcile): the caller adds nothing. */
    public boolean recordCredit(long userId, long treeId, Instant graduatedAt, int newWords, boolean credited, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_monument_credit(user_id, tree_id, graduated_at, new_words, credited, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, tree_id) DO NOTHING
                """, userId, treeId, ts(graduatedAt), newWords, credited, ts(now)) == 1;
    }

    public void recordWord(long userId, long flashcardId, long treeId, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_monument_word(user_id, flashcard_id, tree_id, credited_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, flashcard_id) DO NOTHING
                """, userId, flashcardId, treeId, ts(now));
    }

    public int creditedGraduations(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_monument_credit WHERE user_id = ? AND credited",
                Integer.class, userId);
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- milestones

    /** Stores a milestone once; true when it is new. {@code seen}: recorded without a celebration (seeded history). */
    public boolean recordMilestone(long userId, String kind, String code, int tier, Instant now, boolean seen) {
        return jdbc.update("""
                INSERT INTO public.garden_milestone(user_id, kind, code, tier, reached_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, kind, code, tier) DO NOTHING
                """, userId, kind, code, tier, ts(now), seen ? ts(now) : null) == 1;
    }

    private static MilestoneRow milestone(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new MilestoneRow(rs.getLong("id"), rs.getString("kind"), rs.getString("code"), rs.getInt("tier"),
                inst(rs, "reached_at"), inst(rs, "seen_at"));
    }

    public List<MilestoneRow> unseenMilestones(long userId, int limit) {
        return jdbc.query("SELECT * FROM public.garden_milestone WHERE user_id = ? AND seen_at IS NULL ORDER BY id LIMIT ?",
                (rs, n) -> milestone(rs), userId, limit);
    }

    /** Newest first; {@code beforeId} pages backwards (keyset on id). */
    public List<MilestoneRow> milestones(long userId, Long beforeId, int limit) {
        if (beforeId == null) {
            return jdbc.query("SELECT * FROM public.garden_milestone WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                    (rs, n) -> milestone(rs), userId, limit);
        }
        return jdbc.query("SELECT * FROM public.garden_milestone WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> milestone(rs), userId, beforeId, limit);
    }

    /** Marks the player's own unseen milestones as seen (foreign or unknown ids match nothing). */
    public int markSeen(long userId, Collection<Long> ids, Instant now) {
        if (ids.isEmpty()) return 0;
        return jdbc.update("UPDATE public.garden_milestone SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL AND id = ANY(?)",
                ps -> {
                    ps.setTimestamp(1, ts(now));
                    ps.setLong(2, userId);
                    ps.setArray(3, ps.getConnection().createArrayOf("bigint", ids.toArray()));
                });
    }
}
