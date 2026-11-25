package com.englishcoach.sentinel;

import java.util.*;

/**
 * Echo Sentinel integrity policy registry: every scored or ranked activity of the product is classified here, with the
 * reason, so a new activity cannot reach a ranking without a decision. {@link Mode#STRICT_FOCUS} activities run as
 * server-owned attempts ({@link SentinelService}); the others keep their own server-side rules (listed in {@code guard}).
 */
public final class SentinelPolicy {
    private SentinelPolicy() {}

    public enum Mode {
        /** Ranked result: acknowledged strict-focus attempt, server state machine, verified completion before ranking. */
        STRICT_FOCUS,
        /** Counts toward a public ranking through server-computed, capped, idempotent ledger rules; not a timed contest. */
        SERVER_LEDGER,
        /** Official evidence from a server-timed attempt (deadline / snapshot / evidence-basis rules); focus lockdown pending owner rollout. */
        SERVER_TIMED_EVIDENCE,
        /** Practice or casual play: no ranking, no lockdown. */
        PRACTICE
    }

    public record Activity(String key, Mode mode, boolean integrated, String scope, String guard) {}

    /** Current version of the rules the learner acknowledges; a change of wording or rule bumps it. */
    public static final int POLICY_VERSION = 1;
    /** How often the page reports that the attempt is still on screen. */
    public static final long HEARTBEAT_MS = 5_000;
    /** Longest gap without a report that still counts as continuous (network blips, a slow device). Disclosed to the learner. */
    public static final long CONTINUITY_GRACE_MS = 20_000;
    /** The page treats a lost window focus as leaving only if it does not come back within this time (native focus blips). */
    public static final long BLUR_GRACE_MS = 1_500;
    /** An acknowledged attempt must be bound to a match within this time. */
    public static final long READY_TTL_MS = 120_000;
    /** Live attempts kept in memory after they ended (the page still asks for their state). */
    public static final long KEEP_ENDED_MS = 30 * 60_000;
    /** At most this many attempts a learner may open per minute (each needs a new acknowledgement anyway). */
    public static final int BEGIN_PER_MINUTE = 10;
    /** Live attempts kept in memory at most (≈ 1 KB each); beyond it new attempts answer 503 SENTINEL_BUSY. */
    public static final int MAX_LIVE_ATTEMPTS = 20_000;

    public static final String KING_CONQUEST = "KING_CONQUEST";
    public static final String EXAM_SIMULATION = "EXAM_SIMULATION";
    public static final String CARD_BLAST_SOLO = "CARD_BLAST_SOLO";
    public static final String CARD_BLAST_PVP = "CARD_BLAST_PVP";
    public static final String ECHO_SPELLING = "ECHO_SPELLING";

    private static final List<Activity> ACTIVITIES = List.of(
        new Activity(ECHO_SPELLING, Mode.STRICT_FOCUS, true,
            "Echo Spelling Multiplayer, Solo Endless and Sprint personal records",
            "server-selected private words, audio-confirmed deadlines, idempotent result ledger; records only from COMPLETED_VERIFIED attempts"),
        new Activity("ECHO_SPELLING_PRACTICE", Mode.PRACTICE, true,
            "Echo Spelling untimed practice", "server-judged answers and private history, no competitive records or ranking"),
        new Activity(KING_CONQUEST, Mode.STRICT_FOCUS, true,
            "Soán ngôi (King Of English · Crown Conquest), STANDARD matches on 4×4–7×7 boards in every flow (Tự luyện, Đấu Echo, 1v1, phòng riêng)",
            "Top 5 / personal best only from a COMPLETED_VERIFIED attempt (DB trigger), server-validated board / path / dictionary / score"),
        new Activity("KING_REFLEX_EXPLAIN_REORDER", Mode.PRACTICE, false,
            "King Of English Phản xạ, Giải nghĩa, Xâu chuỗi and the four-round championship", "no ranking or progress is written"),
        new Activity(CARD_BLAST_PVP, Mode.STRICT_FOCUS, true,
            "Card Blast 1v1 against a person (Elo, Activity Points)",
            "both players acknowledge before Ready; a void forfeits the match (the loss counts); Elo only when every non-forfeiting player completed verified"),
        new Activity(CARD_BLAST_SOLO, Mode.STRICT_FOCUS, true,
            "Card Blast solo runs (Activity Points top-3)", "a run counts only with a COMPLETED_VERIFIED attempt bound to its server-issued run id"),
        new Activity("CARD_BLAST_PVP_BOT", Mode.PRACTICE, false, "Card Blast 1v1 against Echo bots", "never ranked (existing rule)"),
        new Activity("ECHO_QUIZ_RUSH", Mode.PRACTICE, false,
            "Echo Quiz Rush Solo / Bots / Quick / private rooms", "server physics and answers; no public ranking"),
        new Activity("WORD_CHAIN", Mode.PRACTICE, false, "Nối từ", "server word verdicts; results history only"),
        new Activity("HANGMAN", Mode.PRACTICE, false, "Đoán từ", "server answers; personal progression only"),
        new Activity("ACTIVITY_POINTS", Mode.SERVER_LEDGER, false,
            "Thi đua board (flashcards, dictation, shadowing, role-play, writing, exams)", "append-only score_events, one event per source row, daily caps, placement + eligibility filters"),
        new Activity(EXAM_SIMULATION, Mode.STRICT_FOCUS, true,
            "IELTS / TOEIC simulations (mock tests): Proficiency evidence, Năng lực board, profile evidence, Activity Points",
            "one attempt per exam attempt (V120 unique index); evidence and points only with COMPLETED_VERIFIED for attempts created after activation"),
        new Activity("EXAM_PRACTICE", Mode.PRACTICE, false, "Exam part practice", "never official evidence, never ranked"),
        new Activity("LEARNING_MODULES", Mode.PRACTICE, false,
            "Reading, Listening, Dictation, Speaking, Writing, Translation, Flashcards, Learning Path", "server-recorded completion; no contest ranking"));

    private static final Map<String, Activity> BY_KEY;
    static {
        var m = new LinkedHashMap<String, Activity>();
        for (var a : ACTIVITIES) m.put(a.key(), a);
        BY_KEY = Collections.unmodifiableMap(m);
    }

    public static List<Activity> activities() { return ACTIVITIES; }
    public static Optional<Activity> find(String key) { return Optional.ofNullable(BY_KEY.get(key)); }
    /** Only integrated strict-focus activities may open an attempt. */
    public static boolean strict(String key) {
        var a = BY_KEY.get(key);
        return a != null && a.mode() == Mode.STRICT_FOCUS && a.integrated();
    }
}
