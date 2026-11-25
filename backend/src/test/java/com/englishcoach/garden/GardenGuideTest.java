package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos.GuideAck;
import com.englishcoach.garden.api.GardenDtos.GuideRequest;
import com.englishcoach.garden.api.GardenDtos.GuideView;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.GuideEngine;
import com.englishcoach.garden.domain.GuideEngine.Action;
import com.englishcoach.garden.domain.GuideEngine.Guide;
import com.englishcoach.garden.domain.GuideEngine.Status;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The voluntary Echo guide on real PostgreSQL 17 + the real migrations through V90 (no migration of its own: the record
 * lives in {@code garden_profile.settings}). A genuinely new garden is offered the guide once; any answer, and merely
 * having seen the offer, ends the offer for good; a garden that was played before is never offered it; the record of
 * one account is never seen by another; and no decision or step changes a coin, an XP point, an item or a crop.
 */
class GardenGuideTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static final AtomicLong USERS = new AtomicLong(170_000);

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-13T03:00:00Z"), "90");
        jdbc = env.jdbc;
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    /** An account that opens the garden for the first time (the garden is created by this read). */
    static long newcomer() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", id, "Learner " + id, "private-" + id + "@example.com");
        env.props.getAllowlistUserIds().add(id);
        env.state.state(id);
        return id;
    }

    static GuideView guide(long user) {
        return env.state.state(user).guide();
    }

    static GuideAck act(long user, String action, int step) {
        return env.state.guide(user, key(), new GuideRequest(1, action, step));
    }

    static int onboarding(long user) {
        return jdbc.queryForObject("SELECT onboarding_step FROM public.garden_profile WHERE user_id = ?", Integer.class, user);
    }

    /** Everything of value a garden holds, as one comparable line. */
    static String wealth(long user) {
        return jdbc.queryForObject("""
                SELECT p.coins || '/' || p.total_xp || '/' || p.essence || '/'
                       || (SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = p.user_id) || '/'
                       || (SELECT count(*) FROM public.garden_planting WHERE user_id = p.user_id) || '/'
                       || (SELECT count(*) FROM public.garden_ledger WHERE user_id = p.user_id)
                  FROM public.garden_profile p WHERE p.user_id = ?""", String.class, user);
    }

    // ------------------------------------------------------------------ pure rules

    @Test
    void rulesMoveOnlyForwardAndEveryWayOutEndsTheOldTutorial() {
        Guide none = Guide.NONE;
        assertTrue(GuideEngine.invite(none, 0, 0));
        assertFalse(GuideEngine.invite(none, 1, 0), "a garden past the old first step existed before the guide");
        assertFalse(GuideEngine.invite(none, 0, 1), "a garden that planted is not new");

        var shown = GuideEngine.apply(none, Action.SHOWN, 0);
        assertEquals(Status.INVITED, shown.guide().status());
        assertEquals(0, shown.onboardingFloor(), "seeing the offer decides nothing about the old tutorial");
        assertFalse(GuideEngine.invite(shown.guide(), 0, 0), "the offer is consumed by being shown");
        assertEquals(shown.guide(), GuideEngine.apply(shown.guide(), Action.SHOWN, 0).guide());

        var declined = GuideEngine.apply(shown.guide(), Action.DECLINE, 0);
        assertEquals(Status.DECLINED, declined.guide().status());
        assertEquals(GuideEngine.ONBOARDING_DONE, declined.onboardingFloor());

        var started = GuideEngine.apply(declined.guide(), Action.START, 0);
        assertEquals(Status.STARTED, started.guide().status());
        var three = GuideEngine.apply(started.guide(), Action.PROGRESS, 3).guide();
        assertEquals(3, three.step());
        assertEquals(3, GuideEngine.apply(three, Action.PROGRESS, 1).guide().step(), "progress never goes back");

        var left = GuideEngine.apply(three, Action.EXIT, 0);
        assertEquals(new Guide(Status.EXITED, 3), left.guide());
        assertEquals(GuideEngine.ONBOARDING_DONE, left.onboardingFloor());
        assertEquals(new Guide(Status.STARTED, 3), GuideEngine.apply(left.guide(), Action.START, 0).guide(), "a resume keeps the place");

        var done = GuideEngine.apply(three, Action.COMPLETE, 0).guide();
        assertEquals(new Guide(Status.COMPLETED, GuideEngine.STEPS), done);
        for (Action a : Action.values()) {
            assertEquals(done, GuideEngine.apply(done, a, 2).guide(), a + " never undoes a completed guide");
        }

        // found unfinished on a later visit: an unanswered offer counts as declined, a running guide as left
        assertEquals(Status.DECLINED, GuideEngine.apply(shown.guide(), Action.SETTLE, 0).guide().status());
        assertEquals(Status.EXITED, GuideEngine.apply(three, Action.SETTLE, 0).guide().status());
        assertNull(GuideEngine.apply(none, Action.SETTLE, 0).guide().status(), "a garden that was never asked stays unasked");
        assertEquals(99 > GuideEngine.STEPS ? GuideEngine.STEPS : 99, new Guide(Status.STARTED, 99).step(), "a step is bounded");
    }

    // ------------------------------------------------------------------ persistence

    @Test
    void aNewGardenIsOfferedTheGuideOnceAndSeeingTheOfferConsumesIt() {
        long u = newcomer();
        GuideView first = guide(u);
        assertNull(first.status());
        assertTrue(first.invite(), "a garden nobody played in is offered the guide");
        assertEquals(1, first.version());
        assertTrue(guide(u).invite(), "reading the state again decides nothing");

        String before = wealth(u);
        GuideAck shown = act(u, "SHOWN", 0);
        assertEquals("INVITED", shown.guide().status());
        assertFalse(shown.guide().invite());
        assertEquals(0, shown.onboardingStep());
        assertFalse(guide(u).invite(), "the offer never returns once it was on screen");

        GuideAck settled = act(u, "SETTLE", 0);
        assertEquals("DECLINED", settled.guide().status(), "an offer left unanswered counts as declined on the next visit");
        assertEquals(8, settled.onboardingStep());
        assertEquals(before, wealth(u), "no coin, XP, item, crop or ledger line");
    }

    @Test
    void decliningIsRememberedAndOpensTheGardenFully() {
        long u = newcomer();
        GuideAck ack = act(u, "DECLINE", 0);
        assertEquals("DECLINED", ack.guide().status());
        assertFalse(ack.guide().invite());
        assertEquals(8, ack.onboardingStep(), "a player who declines is past the old tutorial gate");
        assertEquals(8, onboarding(u));
        GuideView later = guide(u);
        assertEquals("DECLINED", later.status());
        assertFalse(later.invite());
    }

    @Test
    void theStarterGuideKeepsItsPlaceThroughLeavingResumingAndFinishing() {
        long u = newcomer();
        String before = wealth(u);
        assertEquals("STARTED", act(u, "START", 0).guide().status());
        assertEquals(1, onboarding(u), "the old tutorial step leaves its first value, as its start button did");
        assertEquals(2, act(u, "PROGRESS", 2).guide().step());
        assertEquals(2, act(u, "PROGRESS", 1).guide().step());
        GuideAck left = act(u, "EXIT", 0);
        assertEquals("EXITED", left.guide().status());
        assertEquals(2, left.guide().step());
        assertEquals(8, left.onboardingStep());
        assertEquals("STARTED", act(u, "START", 0).guide().status());
        assertEquals(2, guide(u).step(), "a resume continues after the last finished milestone");
        GuideAck done = act(u, "COMPLETE", 0);
        assertEquals("COMPLETED", done.guide().status());
        assertEquals(7, done.guide().step());
        assertEquals("COMPLETED", act(u, "START", 0).guide().status(), "a replay does not reopen a completed guide");
        assertEquals("COMPLETED", act(u, "DECLINE", 0).guide().status());
        assertEquals(before, wealth(u), "the whole guide granted and took nothing");
        assertEquals(8, jdbc.queryForObject("SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'GUIDE'", Integer.class, u));
    }

    @Test
    void aGardenThatWasPlayedBeforeTheGuideIsNeverOfferedIt() {
        // past the old tutorial
        long veteran = newcomer();
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", veteran);
        assertFalse(guide(veteran).invite());
        // pressed the old "start" but nothing else
        long midway = newcomer();
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 1 WHERE user_id = ?", midway);
        assertFalse(guide(midway).invite());
        // planted without ever touching the old tutorial card
        long planter = newcomer();
        var s = env.state.state(planter);
        assertTrue(s.guide().invite());
        env.planting.plant(planter, key(), s.plots().getFirst().id(), new PlantRequest("WHEAT"));
        assertFalse(guide(planter).invite(), "a garden with a planting is not a new garden");
        // such a garden is settled without a record: nothing to resume, nothing to offer
        GuideAck ack = act(midway, "SETTLE", 0);
        assertNull(ack.guide().status());
        assertEquals(8, ack.onboardingStep());
    }

    @Test
    void theRecordBelongsToOneAccountOnly() {
        long a = newcomer();
        long b = newcomer();
        act(a, "START", 0);
        act(a, "PROGRESS", 4);
        GuideView other = guide(b);
        assertNull(other.status(), "another account's guide is untouched");
        assertEquals(0, other.step());
        assertTrue(other.invite());
        assertEquals(0, onboarding(b));
        assertEquals("STARTED", guide(a).status());
        assertEquals(4, guide(a).step());
    }

    @Test
    void aRepeatedRequestIsAnsweredOnceAndAGardenWithoutAccessIsRefused() {
        long u = newcomer();
        UUID k = key();
        var request = new GuideRequest(1, "PROGRESS", 3);
        GuideAck first = env.state.guide(u, k, request);
        GuideAck again = env.state.guide(u, k, request);
        assertEquals(first, again);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'GUIDE'", Integer.class, u));
        assertEquals("IDEMPOTENCY_KEY_REUSED",
                assertThrows(GardenException.class, () -> env.state.guide(u, k, new GuideRequest(1, "COMPLETE", 0))).code);
        assertEquals("IDEMPOTENCY_KEY_REQUIRED",
                assertThrows(GardenException.class, () -> env.state.guide(u, null, request)).code);

        long stranger = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", stranger, "Stranger", "s-" + stranger + "@example.com");
        assertEquals("GARDEN_NOT_FOUND",
                assertThrows(GardenException.class, () -> env.state.guide(stranger, key(), request)).code);
    }

    @Test
    void anUnreadableStoredRecordCountsAsNeverAsked() {
        long u = newcomer();
        jdbc.update("UPDATE public.garden_profile SET settings = '{\"guide\": {\"status\": \"SOMETHING_ELSE\", \"step\": 42}}'::jsonb WHERE user_id = ?", u);
        GuideView v = guide(u);
        assertNull(v.status());
        assertEquals(7, v.step(), "a stored step is bounded");
        jdbc.update("UPDATE public.garden_profile SET settings = '{\"guide\": 5, \"other\": true}'::jsonb WHERE user_id = ?", u);
        assertNull(guide(u).status());
        act(u, "DECLINE", 0);
        assertEquals(Boolean.TRUE, jdbc.queryForObject("SELECT (settings->>'other')::boolean FROM public.garden_profile WHERE user_id = ?", Boolean.class, u),
                "other preferences of the garden are kept");
    }
}
