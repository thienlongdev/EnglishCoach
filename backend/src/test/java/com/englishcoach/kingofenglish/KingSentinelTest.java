package com.englishcoach.kingofenglish;

import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Echo Sentinel on ranked Soán ngôi (owner directive 2026-11-14, 10 §BX): a ranked row needs a verified attempt; leaving,
 * reloading, a second tab, a forged or replayed handle, a late word after the void and a race with completion never
 * produce ranking credit; the same account gets the same rules on every new attempt.
 */
class KingSentinelTest {
    static final class RecordingStore extends SentinelStore {
        final List<SentinelAttempt.Change> written = Collections.synchronizedList(new ArrayList<>());
        RecordingStore() { super(null); }
        @Override public void write(SentinelAttempt.Change c) { written.add(c); }
        @Override public void writeLater(SentinelAttempt.Change c) { if (c != null) written.add(c); }
    }
    KingServiceTest.Time time; KingService game; SentinelService sentinel; RecordingStore store;
    final List<List<KingConquestResults.Row>> recorded = new CopyOnWriteArrayList<>();
    @SuppressWarnings("unchecked")
    @BeforeEach void setup() {
        time = new KingServiceTest.Time(); store = new RecordingStore(); sentinel = new SentinelService(store, time);
        game = new KingService(new KingBank(), new KingExplainBank(), new KingConquestBank(), KingConquestTest.localLexicon(), mock(SimpMessagingTemplate.class), time, true);
        var results = mock(KingConquestResults.class);
        doAnswer(call -> { recorded.add(call.getArgument(0)); ((java.util.function.Consumer<Boolean>) call.getArgument(1)).accept(true); return null; })
            .when(results).submit(any(), any());
        game.setResults(results); game.setSentinel(sentinel);
    }
    @AfterEach void close() { game.close(); sentinel.close(); }

    String handle(long user) {
        var b = sentinel.begin(user, SentinelPolicy.KING_CONQUEST, true, SentinelPolicy.POLICY_VERSION);
        return b.id() + "." + b.token();
    }
    Map<String, Object> act(long user, String action, Map<String, Object> s, String flow, String word, List<Integer> path, String handle) {
        return act(user, "s" + user, action, s, flow, word, path, handle);
    }
    Map<String, Object> act(long user, String session, String action, Map<String, Object> s, String flow, String word, List<Integer> path, String handle) {
        return game.act(user, "p" + user, session, new KingService.Command(action, s == null ? null : (String) s.get("roomCode"), "CONQUEST", flow, 10, 0, "KING",
            s == null ? null : (String) s.get("matchId"), s == null ? null : (Integer) s.get("round"), s == null ? null : (Long) s.get("inputRevision"),
            UUID.randomUUID().toString(), word, path, 5, handle));
    }
    KingService.Room room(Map<String, Object> s) throws Exception {
        var f = KingService.class.getDeclaredField("rooms"); f.setAccessible(true);
        @SuppressWarnings("unchecked") var rooms = (Map<String, KingService.Room>) f.get(game);
        return rooms.get((String) s.get("roomCode"));
    }
    @SuppressWarnings("unchecked") static String integrity(Map<String, Object> s) { var i = (Map<String, Object>) s.get("integrity"); return i == null ? null : (String) i.get("state"); }
    /** Plays every Echo candidate word the board offers, with the page reporting every 5 s and human-like irregular gaps. */
    Map<String, Object> play(long user, Map<String, Object> s, String h, int words) throws Exception {
        var r = room(s); var id = UUID.fromString(h.substring(0, 36)); var token = h.substring(37); var rnd = new Random(user);
        int played = 0;
        for (var c : r.conquest.candidates) {
            if (played >= words) break;
            if (r.conquest.used.contains(c.word())) continue;
            time.ms += 700 + rnd.nextInt(2600);
            sentinel.heartbeat(user, id, token, true);
            s = act(user, "move", s, (String) s.get("flow"), c.word(), c.path(), null);
            played++;
        }
        return s;
    }
    void finishByClock(long user, String h) {
        var id = UUID.fromString(h.substring(0, 36)); var token = h.substring(37);
        while (true) {
            time.ms += 4_000;
            try { sentinel.heartbeat(user, id, token, true); } catch (SentinelService.Refusal ignored) { }
            game.tick();
            if (sentinel.status(user, id, token).state().equals("ACTIVE") && time.ms < 10_000_000) continue;
            break;
        }
    }
    void rejection(String code, org.junit.jupiter.api.function.Executable e) { assertEquals(code, assertThrows(KingService.Rejection.class, e).code); }

    @Test void verifiedSoloMatchIsRankedWithItsAttempt() throws Exception {
        var h = handle(674);
        var s = act(674, "start", null, "SOLO", null, null, h);
        assertEquals("ACTIVE", integrity(s));
        s = play(674, s, h, 6);
        finishByClock(674, h);
        assertEquals(1, recorded.size());
        var row = recorded.getFirst().getFirst();
        assertEquals(674, row.user()); assertNotNull(row.verified()); assertEquals(SentinelAttempt.State.COMPLETED_VERIFIED, row.verified().to());
        assertEquals(h.substring(0, 36), row.attempt().toString());
    }

    @Test void leavingTheTabVoidsTheAttemptAndALateWordScoresNothing() throws Exception {
        var h = handle(2); var id = UUID.fromString(h.substring(0, 36)); var token = h.substring(37);
        var s = act(2, "start", null, "SOLO", null, null, h);
        s = play(2, s, h, 3); int before = (Integer) s.get("score");
        var st = sentinel.violation(2, id, token, "HIDDEN");
        assertEquals("VOIDED_FOCUS_LOSS", st.state()); assertFalse(st.ranked());
        var r = room(s);
        assertEquals("FINISHED", r.status); assertEquals("VOIDED", r.reason);
        var c = r.conquest.candidates.stream().filter(x -> !r.conquest.used.contains(x.word())).findFirst().orElseThrow();
        final var snap = s;
        rejection("ATTEMPT_VOIDED", () -> act(2, "move", snap, "SOLO", c.word(), c.path(), null));
        assertEquals(before, r.players.get(2L).score, "no point after the void");
        // Returning to the page does not revive it: heartbeats answer the terminal state, a new report changes nothing.
        assertEquals("VOIDED_FOCUS_LOSS", sentinel.heartbeat(2, id, token, true).state());
        assertEquals("VOIDED_FOCUS_LOSS", sentinel.violation(2, id, token, "BLUR").state());
        time.ms += 200_000; game.tick();
        assertTrue(recorded.isEmpty(), "a voided attempt is never ranked");
        // Starting again needs a new attempt, from the beginning.
        var again = act(2, "start", null, "SOLO", null, null, handle(2));
        assertEquals("PLAYING", again.get("status")); assertEquals(0, again.get("score")); assertEquals("ACTIVE", integrity(again));
        rejection("SENTINEL_INVALID", () -> act(2, "start", null, "SOLO", null, null, h));
    }

    @Test void reloadOrSecondTabCannotResumeTheRankedAttempt() throws Exception {
        var h = handle(3);
        var s = act(3, "start", null, "SOLO", null, null, h);
        s = play(3, s, h, 2);
        // Same page, new socket (a network blip): the page still holds the secret and keeps playing.
        s = act(3, "s3b", "rejoin", s, "SOLO", null, null, h);
        assertEquals("ACTIVE", integrity(s)); assertEquals("PLAYING", s.get("status"));
        // A reloaded page (or another tab) has no secret: the ranked attempt ends.
        s = act(3, "s3c", "rejoin", s, "SOLO", null, null, null);
        assertEquals("VOIDED_RELOAD", integrity(s)); assertEquals("FINISHED", s.get("status"));
        time.ms += 200_000; game.tick();
        assertTrue(recorded.isEmpty());
    }

    @Test void forgedReplayedOrForeignHandlesAreRefused() {
        var h = handle(4);
        rejection("SENTINEL_INVALID", () -> act(5, "start", null, "SOLO", null, null, h));                 // another account's attempt
        rejection("SENTINEL_INVALID", () -> act(4, "start", null, "SOLO", null, null, h.substring(0, 37) + "forged"));
        rejection("SENTINEL_INVALID", () -> act(4, "start", null, "SOLO", null, null, UUID.randomUUID() + ".x"));
        var started = act(4, "start", null, "SOLO", null, null, h);
        act(4, "leave", started, "SOLO", null, null, null);
        rejection("SENTINEL_INVALID", () -> act(4, "start", null, "SOLO", null, null, h));                 // used once
        assertThrows(SentinelService.Refusal.class, () -> sentinel.begin(4, SentinelPolicy.KING_CONQUEST, false, 1), "rules must be acknowledged");
        assertThrows(SentinelService.Refusal.class, () -> sentinel.begin(4, SentinelPolicy.KING_CONQUEST, true, 0), "old rules text");
        assertThrows(SentinelService.Refusal.class, () -> sentinel.begin(4, "ECHO_QUIZ_RUSH", true, 1), "not a strict activity");
        var foreign = assertThrows(SentinelService.Refusal.class, () -> sentinel.violation(5, UUID.fromString(h.substring(0, 36)), h.substring(37), "HIDDEN"));
        assertEquals(404, foreign.status, "another learner cannot void (or read) someone's attempt");
    }

    @Test void unrankedPlayWithoutAnAttemptStillWorksButIsNeverRanked() throws Exception {
        var s = act(6, "start", null, "SOLO", null, null, null);
        assertNull(s.get("integrity"));
        var r = room(s); var c = r.conquest.candidates.getFirst();
        s = act(6, "move", s, "SOLO", c.word(), c.path(), null);
        assertTrue((Integer) s.get("score") > 0, "practice still plays");
        time.ms += 200_000; game.tick();
        assertTrue(recorded.isEmpty(), "no attempt, no ranking");
    }

    @Test void silentPageMeansContinuityUnverifiedNotCheating() throws Exception {
        var h = handle(7);
        var s = act(7, "start", null, "SOLO", null, null, h);
        var r = room(s); var c = r.conquest.candidates.getFirst();
        s = act(7, "move", s, "SOLO", c.word(), c.path(), null);
        time.ms += SentinelPolicy.CONTINUITY_GRACE_MS + 1_000; sentinel.sweep();
        assertEquals("VOIDED_CONTINUITY", sentinel.status(7, UUID.fromString(h.substring(0, 36)), h.substring(37)).state());
        time.ms += 200_000; game.tick();
        assertTrue(recorded.isEmpty());
    }

    @Test void completionBeforeALateReportStaysVerifiedAndAReportBeforeCompletionWins() throws Exception {
        var h = handle(8); var id = UUID.fromString(h.substring(0, 36)); var token = h.substring(37);
        var s = act(8, "start", null, "SOLO", null, null, h);
        s = play(8, s, h, 2);
        finishByClock(8, h);
        assertEquals(1, recorded.size());
        assertEquals("COMPLETED_VERIFIED", sentinel.violation(8, id, token, "PAGEHIDE").state(), "a report after the end cannot void a completed attempt");
        // Concurrent: completion and a void racing on the same attempt end in exactly one terminal state.
        for (int n = 0; n < 50; n++) {
            time.ms += 7_000;
            var hh = handle(9); var aid = UUID.fromString(hh.substring(0, 36)); var tok = hh.substring(37);
            var st = act(9, "start", null, "SOLO", null, null, hh);
            sentinel.heartbeat(9, aid, tok, true);
            var a = room(st).players.get(9L).sentinel;
            var pool = Executors.newFixedThreadPool(2); var go = new CountDownLatch(1);
            var f1 = pool.submit(() -> { go.await(); return sentinel.complete(a); });
            var f2 = pool.submit(() -> { go.await(); return sentinel.violation(9, aid, tok, "HIDDEN"); });
            go.countDown();
            var completed = f1.get(); var voided = f2.get(); pool.shutdown();
            var fin = a.state();
            assertTrue(fin == SentinelAttempt.State.COMPLETED_VERIFIED || fin == SentinelAttempt.State.VOIDED_FOCUS_LOSS);
            if (fin == SentinelAttempt.State.VOIDED_FOCUS_LOSS) assertNull(completed, "a voided attempt never completes");
            else assertEquals("COMPLETED_VERIFIED", voided.state());
            act(9, "leave", st, "SOLO", null, null, null);
        }
    }

    @Test void duelVoidEndsOnlyTheLeaverAndTheOtherPlayerIsRanked() throws Exception {
        var ha = handle(10); var hb = handle(11);
        act(10, "quick", null, "QUICK_MATCH", null, null, ha);
        var s = act(11, "quick", null, "QUICK_MATCH", null, null, hb);
        assertEquals("PLAYING", s.get("status"));
        sentinel.violation(10, UUID.fromString(ha.substring(0, 36)), ha.substring(37), "HIDDEN");
        var r = room(s); assertEquals("PLAYING", r.status, "the honest opponent plays on");
        var c = r.conquest.candidates.getFirst();
        final var snap = s;
        rejection("ATTEMPT_VOIDED", () -> act(10, "move", snap, "QUICK_MATCH", c.word(), c.path(), null));
        s = act(11, "move", s, "QUICK_MATCH", c.word(), c.path(), null);
        finishByClock(11, hb);
        assertEquals(1, recorded.size()); assertEquals(1, recorded.getFirst().size());
        assertEquals(11, recorded.getFirst().getFirst().user());
    }

    @Test void explicitExitAbandonsAndANewAttemptSupersedesTheOld() throws Exception {
        var h = handle(12);
        var s = act(12, "start", null, "SOLO", null, null, h);
        var a = room(s).players.get(12L).sentinel;
        act(12, "leave", s, "SOLO", null, null, null);
        assertEquals(SentinelAttempt.State.VOIDED_ABANDONED, a.state());
        var h2 = handle(12); var s2 = act(12, "start", null, "SOLO", null, null, h2);
        var a2 = room(s2).players.get(12L).sentinel;
        handle(12); // opening another attempt (e.g. in another tab) ends the running one
        assertEquals(SentinelAttempt.State.VOIDED_ABANDONED, a2.state());
        assertEquals("FINISHED", room(s2).status);
    }

    @Test void rematchNeedsItsOwnFreshAttempt() throws Exception {
        var h = handle(13);
        var s = act(13, "start", null, "SOLO", null, null, h);
        s = play(13, s, h, 2); finishByClock(13, h);
        s = act(13, "ping", s, "SOLO", null, null, null);
        assertEquals(1, recorded.size());
        final var done = s;
        rejection("SENTINEL_INVALID", () -> act(13, "rematch", done, "SOLO", null, null, h));
        var h2 = handle(13);
        s = act(13, "rematch", s, "SOLO", null, null, h2);
        assertEquals("PLAYING", s.get("status")); assertEquals("ACTIVE", integrity(s));
        assertEquals(h2.substring(0, 36), ((Map<?, ?>) s.get("integrity")).get("attemptId"));
    }

    @Test void mechanicalTimingWaitsForReviewInsteadOfRanking() throws Exception {
        var h = handle(14); var id = UUID.fromString(h.substring(0, 36)); var token = h.substring(37);
        var s = act(14, "start", null, "SOLO", null, null, h);
        var a = room(s).players.get(14L).sentinel;
        // 40 accepted actions exactly 1 s apart: near-metronomic input.
        for (int n = 0; n < 40; n++) { time.ms += 1_000; sentinel.heartbeat(14, id, token, true); sentinel.action(a); }
        var change = sentinel.complete(a);
        assertEquals(SentinelAttempt.State.PENDING_REVIEW, change.to());
        assertEquals(true, ((Map<?, ?>) a.evidence().get("timing")).get("mechanical"));
    }
}
