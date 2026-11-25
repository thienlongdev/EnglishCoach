package com.englishcoach.garden;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.CosmeticBuyRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticCheckoutRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticEquipRequest;
import com.englishcoach.garden.api.GardenDtos.VoucherBuyRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.CosmeticCheckoutService;
import com.englishcoach.garden.application.CosmeticPaymentGateway;
import com.englishcoach.garden.application.CosmeticService;
import com.englishcoach.garden.application.GardenAccessService;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Phase 3F on real PostgreSQL 17 with V87 applied: the Premium 7-day reward (price, length, rolling cap, cooldown,
 * learning days, budget, concurrency), the AI voucher wallet (packs, rolling cap, expiry, one voucher per logical
 * request, release, races), the twenty Echo Garden frames (seed, purchase, earned gates, isolation), the fixed VND
 * catalogue (89 priced, 26 earned excluded) and the cosmetic order path (window, exact-once delivery, every
 * non-deliverable transfer recorded, refunds, administrator reconciliation). Each test uses its own user ids.
 *
 * No payment provider, merchant account or network is involved: {@link FakeGateway} only hands out references, and a
 * "verified transfer" is a direct call of {@code settle} — exactly what the payment module does after its own checks
 * (those are covered by the payment module's tests).
 */
class GardenPhase3FPersistenceTest {

    static final Instant START = Instant.parse("2026-10-12T03:00:00Z"); // 10:00 Vietnam
    static final ZoneId VN = ZoneId.of("Asia/Ho_Chi_Minh");
    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static CosmeticCheckoutService pay;
    static CosmeticService shop;
    static final AtomicLong USERS = new AtomicLong(95_000);
    static final AtomicInteger TX = new AtomicInteger();

    /** A provider stand-in: it only hands out references and shows a fixed test account. No network, no merchant. */
    static final class FakeGateway implements CosmeticPaymentGateway {
        final AtomicInteger seq = new AtomicInteger();
        volatile boolean available = true;

        @Override public String provider() { return "SEPAY"; }

        @Override public String createPayment(long userId, String skuCode, long amountVnd) {
            return "ECTEST" + String.format("%04d", seq.incrementAndGet());
        }

        @Override public boolean available() { return available; }

        @Override public Instructions instructions(String reference, long amountVnd) {
            return new Instructions("TESTBANK", "000111222", "TEST ACCOUNT", "https://qr.example.test/" + reference + "/" + amountVnd);
        }
    }

    static final FakeGateway GATEWAY = new FakeGateway();

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(START, "87");
        jdbc = env.jdbc;
        ledger = env.ledgerService;
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", GardenTestEnv.ADMIN);
        env.props.setCosmeticCheckoutEnabled(true);
        openRewards(env.props);
        pay = new CosmeticCheckoutService(env.ctx, env.access, env.setup, env.props, env.cosmeticRepo, env.commerce, env.rewardRepo,
                env.collection, Optional.of(GATEWAY), GardenTestEnv::requireAdmin);
        shop = new CosmeticService(env.ctx, env.access, env.setup, ledger, env.cosmeticRepo, env.collection, new MonumentRepository(jdbc),
                new EstateRepository(jdbc), new KnowledgeRepository(jdbc), env.props, pay, env.commerce);
    }

    /** What the owner has to configure before a cost-bearing reward opens: the switch and all three budget numbers. */
    static void openRewards(GardenProperties p) {
        p.setPremiumRewardEnabled(true);
        p.setPremiumRewardMonthlyCap(1_000);
        p.setPremiumRewardUnitCostVnd(14_000);
        p.setPremiumRewardMonthlyBudgetVnd(100_000_000);
        p.setAiVoucherEnabled(true);
        p.setAiVoucherMonthlyCreditCap(100_000);
        p.setAiVoucherUnitCostVnd(500);
        p.setAiVoucherMonthlyBudgetVnd(100_000_000);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static long farmer(long coins) {
        long u = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", u);
        env.props.getAllowlistUserIds().add(u);
        env.state.state(u);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        // exactly `coins` Echo Coins, moved through the ledger so balances reconcile (a new garden starts with a few)
        long have = coins(u);
        if (coins > have) ledger.addCoins(u, coins - have, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        if (coins < have) ledger.takeCoins(u, have - coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        return u;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static String tx() {
        return "sepay-tx-" + TX.incrementAndGet();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    static void assertCoinsReconcile(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile with the ledger");
    }

    /** {@code days} verified learning days ending today (Vietnam), written as the monument's reconcile writes them. */
    static void studied(long user, int days) {
        LocalDate today = LocalDate.ofInstant(env.clock.now, VN);
        for (int i = 0; i < days; i++) {
            jdbc.update("""
                    INSERT INTO public.garden_monument_day(user_id, day_key, vocabulary, recorded_at) VALUES (?, ?, TRUE, now())
                    ON CONFLICT (user_id, day_key) DO UPDATE SET vocabulary = TRUE""", user, java.sql.Date.valueOf(today.minusDays(i)));
        }
    }

    static void grown(long user, String crop) {
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                VALUES (?, ?, 5, 2, 1, 1, now(), now()) ON CONFLICT (user_id, crop_code) DO NOTHING""", user, crop);
    }

    static <T> List<Object> race(int n, java.util.function.IntFunction<Callable<T>> calls) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<T>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Callable<T> call = calls.apply(i);
            futures.add(pool.submit(() -> {
                go.await();
                return call.call();
            }));
        }
        go.countDown();
        List<Object> out = new ArrayList<>();
        for (var f : futures) {
            try {
                out.add(f.get());
            } catch (java.util.concurrent.ExecutionException ex) {
                out.add(ex.getCause());
            }
        }
        pool.shutdown();
        return out;
    }

    static long successes(List<Object> results) {
        return results.stream().filter(r -> !(r instanceof Throwable)).count();
    }

    // ================================================================== A. Premium 7 days

    @Test
    void premiumRewardIsARealWeekForOneMillionCoinsAndFollowsEveryRule() {
        long u = farmer(4_500_000);
        var closed = new GardenProperties();
        // 1. cost-bearing and closed until the owner configures the switch AND every budget number
        assertFalse(closed.premiumRewardOpen());
        closed.setPremiumRewardEnabled(true);
        assertFalse(closed.premiumRewardOpen(), "the switch alone opens nothing: no budget means closed, never unlimited");
        env.props.setPremiumRewardEnabled(false);
        try {
            studied(u, 15);
            assertEquals("CLOSED", env.echoRewards.view(u).premium().status());
            assertEquals("REWARD_CLOSED", rejected(() -> env.echoRewards.redeemPremium(u, key())).code);
        } finally {
            env.props.setPremiumRewardEnabled(true);
        }
        assertEquals(4_500_000, coins(u));

        // 2. fifteen learning days among the last thirty Vietnam dates — a game-only day or a visit is not one
        long lazy = farmer(2_000_000);
        studied(lazy, 14);
        jdbc.update("INSERT INTO public.garden_monument_day(user_id, day_key, play, recorded_at) VALUES (?, ?, TRUE, now())", lazy,
                java.sql.Date.valueOf(LocalDate.ofInstant(env.clock.now, VN).minusDays(20)));
        var need = rejected(() -> env.echoRewards.redeemPremium(lazy, key()));
        assertEquals("REWARD_LEARNING_DAYS", need.code);
        assertEquals(14, env.echoRewards.view(lazy).premium().learningDays());
        assertEquals(2_000_000, coins(lazy), "a refused redemption debits nothing");

        // 3. the redemption: exactly 1,000,000 coins, exactly 168 hours, one real subscription row, never a payment
        var view = env.echoRewards.view(u).premium();
        assertEquals("AVAILABLE", view.status());
        assertEquals(1_000_000, view.coinsCost());
        assertEquals(168, view.hours());
        assertEquals(3, view.maxPerWindow());
        assertEquals(90, view.cooldownDays());
        UUID first = key();
        var receipt = env.echoRewards.redeemPremium(u, first);
        assertEquals(1_000_000, receipt.coinsPaid());
        assertEquals(3_500_000, coins(u));
        assertEquals(Duration.ofHours(168), Duration.between(receipt.startsAt(), receipt.expiresAt()));
        assertEquals(1, count("""
                SELECT count(*) FROM public.premium_subscriptions s JOIN public.premium_plans p ON p.id = s.plan_id
                WHERE s.user_id = ? AND s.status = 'ACTIVE' AND s.source = 'GARDEN_REWARD' AND p.code = 'GARDEN_REWARD_7D' AND NOT p.active
                  AND s.expires_at = s.starts_at + INTERVAL '168 hours'""", u));
        assertTrue(env.promo.hasActiveOrUpcomingEntitlement(u, env.clock.now));
        assertEquals(1, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'PREMIUM_REWARD' AND delta = -1000000", u));
        // a replayed request returns the same receipt: no second debit, no second week
        assertEquals(receipt.rewardId(), env.echoRewards.redeemPremium(u, first).rewardId());
        assertEquals(3_500_000, coins(u));
        assertEquals(1, count("SELECT count(*) FROM public.premium_subscriptions WHERE user_id = ?", u));
        // no overlapping reward while the week runs
        assertEquals("PREMIUM_ACTIVE", rejected(() -> env.echoRewards.redeemPremium(u, key())).code);
        assertNotNull(env.echoRewards.view(u).premium().activeUntil());
        // the reward record is append-only
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_premium_reward SET coins_spent = 1 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_premium_reward WHERE user_id = ?", u));

        // 4. it ends by its own timestamps; then ninety full days of cooldown counted from the END of the reward
        env.clock.advance(Duration.ofHours(168).plusSeconds(1));
        assertFalse(env.promo.hasActiveOrUpcomingEntitlement(u, env.clock.now), "expired by its timestamps, nothing to revoke");
        studied(u, 15);
        assertEquals("REWARD_COOLDOWN", rejected(() -> env.echoRewards.redeemPremium(u, key())).code);
        env.clock.advance(Duration.ofDays(90).minusSeconds(60));
        studied(u, 15);
        assertEquals("COOLDOWN", env.echoRewards.view(u).premium().status());
        env.clock.advance(Duration.ofSeconds(120));
        studied(u, 15);
        assertEquals("AVAILABLE", env.echoRewards.view(u).premium().status());
        env.echoRewards.redeemPremium(u, key());   // second, day ~97
        env.clock.advance(Duration.ofDays(97).plusSeconds(120));
        studied(u, 15);
        env.echoRewards.redeemPremium(u, key());   // third, day ~194
        assertEquals(1_500_000, coins(u));
        // 5. a fourth inside the rolling 365 days is refused even after its cooldown
        env.clock.advance(Duration.ofDays(97).plusSeconds(120));   // day ~291
        studied(u, 15);
        var limit = rejected(() -> env.echoRewards.redeemPremium(u, key()));
        assertEquals("REWARD_WINDOW_LIMIT", limit.code);
        assertEquals(3, env.echoRewards.view(u).premium().redeemedInWindow());
        assertEquals(1_500_000, coins(u));
        // ... and allowed again once the first redemption has left the window
        env.clock.advance(Duration.ofDays(75));   // day ~366 after the first
        studied(u, 15);
        assertEquals("AVAILABLE", env.echoRewards.view(u).premium().status());
        assertEquals(2, env.echoRewards.view(u).premium().redeemedInWindow());
        assertCoinsReconcile(u);
    }

    @Test
    void aPaidPremiumIsNeverTouchedAndBlocksTheReward() {
        long u = farmer(1_200_000);
        studied(u, 20);
        Instant now = env.clock.now;
        jdbc.update("""
                INSERT INTO public.premium_subscriptions(user_id, plan_id, starts_at, expires_at, status, source)
                SELECT ?, id, ?, ?, 'ACTIVE', 'SEPAY:tx-paid' FROM public.premium_plans WHERE code = 'PLAN_1_MONTH'""",
                u, java.sql.Timestamp.from(now.minusSeconds(3600)), java.sql.Timestamp.from(now.plus(Duration.ofDays(20))));
        assertEquals("PREMIUM_ACTIVE", env.echoRewards.view(u).premium().status());
        assertEquals("PREMIUM_ACTIVE", rejected(() -> env.echoRewards.redeemPremium(u, key())).code);
        assertEquals(1_200_000, coins(u));
        assertEquals(1, count("SELECT count(*) FROM public.premium_subscriptions WHERE user_id = ? AND source = 'SEPAY:tx-paid' AND status = 'ACTIVE'", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_premium_reward WHERE user_id = ?", u));
    }

    @Test
    void racingRedemptionsGrantOneWeekAndDebitOnce() throws Exception {
        long u = farmer(3_000_000);
        studied(u, 15);
        var results = race(6, i -> () -> env.echoRewards.redeemPremium(u, key()));
        assertEquals(1, successes(results), "one redemption; the others find the active week");
        assertEquals(2_000_000, coins(u));
        assertEquals(1, count("SELECT count(*) FROM public.premium_subscriptions WHERE user_id = ?", u));
        assertCoinsReconcile(u);
    }

    @Test
    void theGlobalBudgetStopsIssuanceWithoutTakingCoins() {
        long a = farmer(1_000_000);
        long b = farmer(1_000_000);
        studied(a, 15);
        studied(b, 15);
        String period = LocalDate.ofInstant(env.clock.now, VN).toString().substring(0, 7);
        int issued = env.rewardRepo.issued("PREMIUM_7D", period);
        env.props.setPremiumRewardMonthlyCap(issued + 1);
        try {
            env.echoRewards.redeemPremium(a, key());
            assertEquals("BUDGET_EXHAUSTED", env.echoRewards.view(b).premium().status());
            assertEquals("REWARD_BUDGET_EXHAUSTED", rejected(() -> env.echoRewards.redeemPremium(b, key())).code);
            assertEquals(1_000_000, coins(b), "no budget: no coins taken, no week granted");
            assertEquals(0, count("SELECT count(*) FROM public.premium_subscriptions WHERE user_id = ?", b));
            assertEquals(issued + 1, env.rewardRepo.issued("PREMIUM_7D", period));
            // the cost budget is a second, independent ceiling
            env.props.setPremiumRewardMonthlyCap(1_000);
            env.props.setPremiumRewardMonthlyBudgetVnd((issued + 1) * 14_000L);
            assertEquals("REWARD_BUDGET_EXHAUSTED", rejected(() -> env.echoRewards.redeemPremium(b, key())).code);
            assertEquals(1_000_000, coins(b));
        } finally {
            openRewards(env.props);
        }
    }

    // ================================================================== B. AI vouchers

    @Test
    void voucherPacksFollowThePriceTheRollingCapAndTheExpiry() {
        long u = farmer(600_000);
        env.props.setAiVoucherEnabled(false);
        try {
            assertEquals("REWARD_CLOSED", rejected(() -> env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"))).code);
        } finally {
            env.props.setAiVoucherEnabled(true);
        }
        var closed = new GardenProperties();
        closed.setAiVoucherEnabled(true);
        assertFalse(closed.aiVoucherOpen(), "the switch alone opens nothing: no budget means closed");

        UUID k = key();
        var one = env.echoRewards.buyVouchers(u, k, new VoucherBuyRequest("ONE"));
        assertEquals(25_000, one.coinsPaid());
        assertEquals(1, one.credits());
        assertEquals(one.coins(), env.echoRewards.buyVouchers(u, k, new VoucherBuyRequest("ONE")).coins(), "a replay buys nothing more");
        var five = env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("FIVE"));
        assertEquals(100_000, five.coinsPaid());
        assertEquals(475_000, coins(u));
        var wallet = env.echoRewards.view(u).vouchers();
        assertEquals(6, wallet.balance());
        assertEquals(6, wallet.boughtInWindow());
        assertEquals(env.clock.now.plus(Duration.ofDays(90)), wallet.nextExpiry(), "a voucher lives ninety days");
        assertEquals(404, rejected(() -> env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("TEN"))).status);
        // the cap counts CREDITS in a rolling thirty days, not purchases
        assertEquals("VOUCHER_CAP", rejected(() -> env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("FIVE"))).code);
        for (int i = 0; i < 4; i++) env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"));
        assertEquals(10, env.echoRewards.view(u).vouchers().balance());
        assertEquals("VOUCHER_CAP", rejected(() -> env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"))).code);
        assertEquals("CAP_REACHED", env.echoRewards.view(u).vouchers().status());
        assertEquals(375_000, coins(u));
        // thirty days later the cap has rolled; ninety days after issue the credits are gone
        env.clock.advance(Duration.ofDays(30).plusSeconds(1));
        env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"));
        assertEquals(11, env.vouchers.balance(u));
        env.clock.advance(Duration.ofDays(60));
        assertEquals(1, env.vouchers.balance(u), "the ten older credits expired; the newest still lives");
        env.clock.advance(Duration.ofDays(31));
        assertEquals(0, env.vouchers.balance(u));
        assertNull(env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "after-expiry"), "an expired voucher pays for nothing");
        assertCoinsReconcile(u);
    }

    @Test
    void oneLogicalRequestUsesOneVoucherAndAFailureGivesItBack() {
        long u = farmer(200_000);
        long other = farmer(0);
        env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"));
        env.clock.advance(Duration.ofDays(1));
        env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("FIVE"));
        assertEquals(6, env.vouchers.balance(u));

        // features without a bounded, request-scoped completion are not payable; another account has no voucher
        assertNull(env.vouchers.reserve(u, "LISTENING_YOUTUBE_IMPORT", "r-x"));
        assertNull(env.vouchers.reserve(u, "EXAM_AI_SCORING", "r-x"));
        assertNull(env.vouchers.reserve(other, "WRITING_AI_FEEDBACK", "r-x"));
        assertEquals(6, env.vouchers.balance(u));

        // success: the credit comes from the grant that expires first and is spent once
        Long use = env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "req-1");
        assertNotNull(use);
        assertEquals(5, env.vouchers.balance(u), "held while the AI request runs");
        assertEquals(0, jdbc.queryForObject("SELECT remaining FROM public.ai_voucher_grant WHERE user_id = ? ORDER BY expires_at LIMIT 1", Integer.class, u),
                "the earliest-expiring grant pays first");
        env.vouchers.consume(use);
        env.vouchers.consume(use);
        assertEquals(5, env.vouchers.balance(u));
        // the client lost the response and retries the SAME request: its own row, no second credit ...
        assertEquals(use, env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "req-1"));
        assertEquals(use, env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "req-1"));
        assertEquals(5, env.vouchers.balance(u));
        // ... but a fixed request id is not an unlimited pass: beyond the bounded retries it is a new operation
        Long again = env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "req-1");
        assertNotEquals(use, again);
        assertEquals(4, env.vouchers.balance(u));
        env.vouchers.consume(again);

        // failure: the AI produced nothing, the voucher goes back; the retry of that request takes it again
        Long failed = env.vouchers.reserve(u, "SPEAKING_ROLEPLAY", "turn-7");
        assertEquals(3, env.vouchers.balance(u));
        env.vouchers.release(failed);
        env.vouchers.release(failed);
        assertEquals(4, env.vouchers.balance(u), "released exactly once");
        assertEquals(failed, env.vouchers.reserve(u, "SPEAKING_ROLEPLAY", "turn-7"));
        assertEquals(3, env.vouchers.balance(u));
        env.vouchers.consume(failed);
        // a request that crashed without reporting back does not keep the voucher for ever
        Long crashed = env.vouchers.reserve(u, "SPEAKING_QUICK_CHECK", "crash-1");
        assertEquals(2, env.vouchers.balance(u));
        env.clock.advance(Duration.ofMinutes(31));
        assertNotNull(env.vouchers.reserve(u, "SPEAKING_QUICK_CHECK", "after-crash"));
        assertEquals("RELEASED", jdbc.queryForObject("SELECT status FROM public.ai_voucher_use WHERE id = ?", String.class, crashed));
        assertEquals(2, env.vouchers.balance(u), "the stale hold went back, the new request took one");

        // the spending kill switch
        env.voucherProps.setSpendingEnabled(false);
        try {
            assertNull(env.vouchers.reserve(u, "WRITING_AI_FEEDBACK", "off-1"));
        } finally {
            env.voucherProps.setSpendingEnabled(true);
        }
        // the grant can never hold more than it was issued with, nor less than nothing
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.ai_voucher_grant SET remaining = credits + 1 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.ai_voucher_grant SET remaining = -1 WHERE user_id = ?", u));
    }

    @Test
    void twoTabsCannotSpendTheSameLastVoucher() throws Exception {
        long u = farmer(50_000);
        env.echoRewards.buyVouchers(u, key(), new VoucherBuyRequest("ONE"));
        var results = race(6, i -> () -> env.vouchers.reserve(u, "TRANSLATION_AI_GRADING", "tab-" + i));
        assertEquals(1, results.stream().filter(r -> r instanceof Long).count(), "one request holds the last voucher");
        assertEquals(0, env.vouchers.balance(u));
        assertEquals(0, jdbc.queryForObject("SELECT sum(remaining) FROM public.ai_voucher_grant WHERE user_id = ?", Integer.class, u));
    }

    // ================================================================== C. profile frames

    @Test
    void v87SeedsTwentyGardenFramesWithoutTouchingTheExistingCatalogue() {
        assertEquals(20, env.frameCatalog.frames().size());
        assertEquals(4, count("SELECT count(*) FROM public.avatar_frame_series WHERE lineage = 'GARDEN'"));
        assertEquals(4, count("""
                SELECT count(*) FROM (SELECT series_id FROM public.avatar_frames f JOIN public.avatar_frame_series s ON s.id = f.series_id
                WHERE s.lineage = 'GARDEN' GROUP BY series_id HAVING count(*) = 5) x"""), "four collections of five");
        assertEquals(10, env.frameCatalog.frames().stream().filter(f -> f.coin()).count());
        assertTrue(env.frameCatalog.frames().stream().filter(f -> f.coin()).allMatch(f -> f.coinPrice() > 0 && f.requirements().isEmpty()));
        assertTrue(env.frameCatalog.frames().stream().filter(f -> !f.coin()).allMatch(f -> f.coinPrice() == 0 && !f.requirements().isEmpty()),
                "an earned frame has requirements and no price");
        assertEquals(20, env.frameCatalog.frames().stream().map(f -> f.asset()).distinct().count(), "twenty different artworks");
        assertTrue(env.frameCatalog.frames().stream().allMatch(f -> f.asset().equals("/assets/frames/garden/" + f.slug() + ".webp")));
        // the frame seeded before V87 (explicit id, sequence never moved) is untouched and no id collided
        assertEquals("season_spring", jdbc.queryForObject("SELECT slug FROM public.avatar_frames WHERE id = 23", String.class));
        assertEquals(1, count("SELECT count(*) FROM public.avatar_frame_requirements WHERE frame_id = 23 AND metric_type = 'VOCAB_MASTERED'"));
        assertEquals(21, count("SELECT count(*) FROM public.avatar_frames"));
        assertTrue(env.frameCatalog.frames().stream().allMatch(f -> f.id() > 23));
        // nothing about avatars: V87 creates no avatar table and no column on an existing table
        assertEquals(0, count("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%avatar%' AND table_name NOT LIKE '%avatar_frame%'"));
    }

    @Test
    void aCoinFrameIsBoughtOnceAndAnEarnedFrameCanOnlyBeEarned() throws Exception {
        long u = farmer(200_000);
        long other = farmer(500_000);
        var before = env.echoRewards.view(u).frames();
        assertTrue(before.open());
        assertEquals(20, before.total());
        assertEquals(0, before.owned());
        UUID k = key();
        var receipt = env.echoRewards.buyFrame(u, k, "garden_spring_blossom");
        assertEquals(60_000, receipt.coinsPaid());
        assertEquals(140_000, coins(u));
        assertEquals(receipt.coins(), env.echoRewards.buyFrame(u, k, "garden_spring_blossom").coins(), "a replay charges nothing");
        assertEquals("FRAME_OWNED", rejected(() -> env.echoRewards.buyFrame(u, key(), "garden_spring_blossom")).code);
        assertEquals(140_000, coins(u));
        // a real ownership row of the frame module: source GARDEN, not equipped, nothing equipped for the player
        assertEquals(1, count("""
                SELECT count(*) FROM public.user_avatar_frames x JOIN public.avatar_frames f ON f.id = x.frame_id
                WHERE x.user_id = ? AND f.slug = 'garden_spring_blossom' AND x.source = 'GARDEN' AND NOT x.is_equipped""", u));
        var mine = env.echoRewards.view(u).frames().frames().stream().filter(f -> f.slug().equals("garden_spring_blossom")).findFirst().orElseThrow();
        assertEquals("OWNED", mine.status());
        // not enough coins: nothing is granted
        assertEquals("INSUFFICIENT_FUNDS", rejected(() -> env.echoRewards.buyFrame(u, key(), "garden_starlight_guardian")).code);
        assertEquals(1, count("SELECT count(*) FROM public.user_avatar_frames WHERE user_id = ?", u));
        // an earned frame has no price and cannot be bought, whatever the balance; an unknown frame is a 404
        assertEquals("FRAME_NOT_FOR_SALE", rejected(() -> env.echoRewards.buyFrame(other, key(), "garden_cloud_dragon")).code);
        assertThrows(IllegalArgumentException.class, () -> env.frameCatalog.grantPurchased(other, "garden_cloud_dragon", env.clock.now));
        assertEquals(404, rejected(() -> env.echoRewards.buyFrame(other, key(), "season_spring")).status);
        assertEquals(500_000, coins(other));
        // another account sees and owns nothing of this purchase
        assertEquals(0, env.echoRewards.view(other).frames().owned());
        assertEquals(0, count("SELECT count(*) FROM public.user_avatar_frames WHERE user_id = ?", other));
        // two tabs: one purchase, one debit
        var results = race(5, i -> () -> env.echoRewards.buyFrame(other, key(), "garden_tet_blossom"));
        assertEquals(1, successes(results));
        assertEquals(410_000, coins(other));
        assertCoinsReconcile(u);
        assertCoinsReconcile(other);
        // the purchase record is append-only
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_frame_purchase WHERE user_id = ?", u));
    }

    @Test
    void earnedFramesFollowStoredGardenFactsAndCannotBeSpoofed() {
        long u = farmer(0);
        long outsider = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", outsider);
        var whale = new AvatarFrameRequirement();
        whale.setMetricType("GARDEN_LEARNING_DAYS");
        whale.setOperator("GTE");
        whale.setTargetValue("21");
        assertFalse(env.frameFacts.evaluate(u, whale).eligible());
        jdbc.update("INSERT INTO public.garden_monument(user_id, era, learning_days, created_at, updated_at) VALUES (?, 1, 20, now(), now()) ON CONFLICT (user_id) DO UPDATE SET era = 1, learning_days = 20", u);
        var almost = env.frameFacts.evaluate(u, whale);
        assertFalse(almost.eligible());
        assertEquals(20.0, almost.currentValue());
        jdbc.update("UPDATE public.garden_monument SET learning_days = 21, era = 3 WHERE user_id = ?", u);
        assertTrue(env.frameFacts.evaluate(u, whale).eligible());
        var view = env.echoRewards.view(u).frames().frames();
        assertEquals("AVAILABLE", view.stream().filter(f -> f.slug().equals("garden_echo_whale")).findFirst().orElseThrow().status());
        assertEquals("AVAILABLE", view.stream().filter(f -> f.slug().equals("garden_knowledge_tree")).findFirst().orElseThrow().status());
        assertEquals("LOCKED", view.stream().filter(f -> f.slug().equals("garden_floating_island")).findFirst().orElseThrow().status(),
                "era 4 AND 2,000 harvests: one of two is not enough");
        // the price requirement of a coin frame never makes it "eligible": the frame engine can never grant it for free
        var price = new AvatarFrameRequirement();
        price.setMetricType("GARDEN_COIN");
        price.setOperator("GTE");
        price.setTargetValue("60000");
        assertTrue(env.frameFacts.supports("GARDEN_COIN"));
        assertFalse(env.frameFacts.evaluate(u, price).eligible());
        // a learner without garden access has no garden facts and is not offered the lineage
        assertEquals(0, env.frameFacts.value(outsider, "GARDEN_LEARNING_DAYS"));
        assertFalse(env.frameFacts.offered(outsider, "GARDEN"));
        assertTrue(env.frameFacts.offered(outsider, "ACHIEVEMENT"), "other lineages are unaffected");
        assertTrue(env.frameFacts.offered(u, "GARDEN"));
        assertFalse(env.frameFacts.evaluate(null, whale).eligible());
    }

    // ================================================================== D. the VND catalogue

    @Test
    void v87PricesExactlyTheEightyNineCoinItemsWithTheOwnersTable() {
        assertEquals(89, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE enabled AND price_vnd IS NOT NULL"));
        assertEquals(59, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE item_kind = 'COSMETIC'"));
        assertEquals(30, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE item_kind = 'SKIN'"));
        // the 26 earned items have no SKU at all
        assertEquals(26, count("SELECT count(*) FROM public.garden_cosmetic_def WHERE unlock_kind <> 'COIN'")
                + count("SELECT count(*) FROM public.garden_skin_def WHERE unlock_kind <> 'COIN' AND collection_code IS NOT NULL"));
        assertEquals(0, count("""
                SELECT count(*) FROM public.garden_cosmetic_sku k WHERE (k.item_kind = 'COSMETIC' AND EXISTS (
                    SELECT 1 FROM public.garden_cosmetic_def d WHERE d.code = k.item_code AND d.unlock_kind <> 'COIN'))
                 OR (k.item_kind = 'SKIN' AND EXISTS (SELECT 1 FROM public.garden_skin_def s WHERE s.code = k.item_code AND (s.unlock_kind <> 'COIN' OR s.collection_code IS NULL)))"""));
        // the owner's fixed table, by category and by the two exact product codes
        String byCategory = """
                SELECT count(*) FROM public.garden_cosmetic_sku k JOIN public.garden_cosmetic_def d ON d.code = k.item_code
                WHERE k.item_kind = 'COSMETIC' AND d.category = ANY (string_to_array(?, ',')) AND k.price_vnd <> ?
                  AND d.code NOT IN ('DECOR_STATUE_DRAGON', 'DECOR_STATUE_PHOENIX')""";
        assertEquals(0, count(byCategory, "DECOR", 19_000));
        assertEquals(0, count(byCategory, "FENCE,PATH,BED", 29_000));
        assertEquals(0, count(byCategory, "TREE,SHRUB,FLOWER", 39_000));
        assertEquals(0, count(byCategory, "MONUMENT", 79_000));
        assertEquals(0, count(byCategory, "HOUSE", 149_000));
        assertEquals(2, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE item_code IN ('DECOR_STATUE_DRAGON', 'DECOR_STATUE_PHOENIX') AND price_vnd = 99000"));
        assertEquals(30, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE item_kind = 'SKIN' AND price_vnd = 39000"));
        assertEquals(5, count("SELECT count(*) FROM public.garden_cosmetic_sku WHERE price_vnd = 149000"));
        // Echo Coin prices are exactly what V86 seeded
        assertEquals(140_000, jdbc.queryForObject("SELECT coin_price FROM public.garden_cosmetic_def WHERE code = 'DECOR_STATUE_DRAGON'", Integer.class));
        assertEquals(6_000, jdbc.queryForObject("SELECT coin_price FROM public.garden_skin_def WHERE code = 'WHEAT_BLOSSOM'", Integer.class));
        // a SKU cannot be enabled without a price
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_sku SET price_vnd = NULL WHERE sku_code = 'VND_PATH_COBBLE'"));
        // the shop shows the VND price only where money can buy: a coin item the player does not own yet
        long u = farmer(10_000);
        var view = shop.shop(u);
        assertTrue(view.checkoutEnabled());
        assertEquals(149_000L, view.items().stream().filter(i -> i.code().equals("HOUSE_FROST")).findFirst().orElseThrow().priceVnd());
        assertEquals(99_000L, view.items().stream().filter(i -> i.code().equals("DECOR_STATUE_PHOENIX")).findFirst().orElseThrow().priceVnd());
        assertNull(view.items().stream().filter(i -> i.code().equals("DECOR_STATUE_WHALE")).findFirst().orElseThrow().priceVnd(), "earned: never for sale");
        assertNull(view.skins().stream().filter(s -> s.code().equals("WHEAT_BLOSSOM")).findFirst().orElseThrow().priceVnd(), "the crop was never grown");
        assertNull(view.skins().stream().filter(s -> s.code().equals("WHEAT_SUNFIRE")).findFirst().orElseThrow().priceVnd(), "earned cultivar");
        shop.buy(u, key(), new CosmeticBuyRequest("PATH_COBBLE"));
        assertNull(shop.shop(u).items().stream().filter(i -> i.code().equals("PATH_COBBLE")).findFirst().orElseThrow().priceVnd(), "owned: not sold again");
        assertEquals(89, view.items().stream().filter(i -> i.priceVnd() != null).count()
                + view.skins().stream().filter(s -> "COIN".equals(s.unlockKind())).count(), "59 items priced now + 30 coin cultivars priced once grown");
    }

    @Test
    void checkoutStaysClosedUnlessTheSwitchAndAVerifyingGatewayAreBothThere() {
        long u = farmer(0);
        assertTrue(pay.open());
        // production default wiring: the switch is off
        var off = new GardenProperties();
        off.setEnabled(true);
        off.setAllowlistUserIds(env.props.getAllowlistUserIds());
        var closed = new CosmeticCheckoutService(env.ctx, new GardenAccessService(off), env.setup, off, env.cosmeticRepo, env.commerce,
                env.rewardRepo, env.collection, Optional.of(GATEWAY), GardenTestEnv::requireAdmin);
        assertFalse(closed.open());
        assertEquals("CHECKOUT_DISABLED", rejected(() -> closed.start(u, key(), new CosmeticCheckoutRequest("HOUSE_FROST"))).code);
        // the switch without a gateway, or with a gateway that cannot verify payments, opens nothing
        assertFalse(env.checkout.open(), "no gateway bean");
        assertEquals("CHECKOUT_DISABLED", rejected(() -> env.checkout.start(u, key(), new CosmeticCheckoutRequest("HOUSE_FROST"))).code);
        GATEWAY.available = false;
        try {
            assertFalse(pay.open());
            assertEquals("CHECKOUT_DISABLED", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("HOUSE_FROST"))).code);
            assertFalse(shop.shop(u).checkoutEnabled());
        } finally {
            GATEWAY.available = true;
        }
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_order WHERE user_id = ?", u));
    }

    // ================================================================== E. orders, verified transfers, issues

    @Test
    void aVerifiedTransferDeliversExactlyOnceAndEverythingElseBecomesAnIssue() throws Exception {
        long u = farmer(0);
        long other = farmer(0);
        // only what is sold: an earned item, an owned item and an unknown code are refused before any order exists
        assertEquals("CHECKOUT_UNAVAILABLE", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("DECOR_STATUE_WHALE"))).code);
        assertEquals(404, rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("NOT_A_THING"))).status);
        assertEquals("COSMETIC_LOCKED", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("WHEAT_BLOSSOM", "SKIN"))).code);
        assertEquals("CHECKOUT_UNAVAILABLE", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("WHEAT_SUNFIRE", "SKIN"))).code);

        var order = pay.start(u, key(), new CosmeticCheckoutRequest("HOUSE_SUNGOLD"));
        assertEquals("PENDING", order.status());
        assertEquals(149_000, order.amountVnd());
        assertEquals("Trang Viên Nắng Hạ", order.productName());
        assertEquals(Duration.ofMinutes(15), Duration.between(order.createdAt(), order.expiresAt()), "a fifteen-minute window");
        assertEquals("000111222", order.accountNumber(), "bank details come from the gateway's configuration");
        assertTrue(order.qrImageUrl().endsWith(order.transferCode() + "/149000"));
        assertEquals(order.orderId(), pay.start(u, key(), new CosmeticCheckoutRequest("HOUSE_SUNGOLD")).orderId(), "one open order per player and item");
        var second = pay.start(other, key(), new CosmeticCheckoutRequest("HOUSE_SUNGOLD"));
        assertNotEquals(order.transferCode(), second.transferCode(), "every order has its own reference");
        assertEquals(order.orderId(), shop.shop(u).items().stream().filter(i -> i.code().equals("HOUSE_SUNGOLD")).findFirst().orElseThrow().pendingOrderId());
        // looking at the order (scanning the QR, polling, a client claim) grants nothing; another player cannot see it
        assertEquals("PENDING", pay.order(u, order.orderId()).status());
        assertEquals(404, rejected(() -> pay.order(other, order.orderId())).status);
        assertEquals(0, env.cosmeticRepo.quantity(u, "HOUSE_SUNGOLD"));
        assertTrue(pay.ownsTransferCode(order.transferCode()));
        assertFalse(pay.ownsTransferCode("ECFORGED99"), "an unknown reference belongs to no order");

        // wrong amount: nothing delivered, the order stays payable, the transfer is recorded for the administrator
        var wrong = pay.settle("SEPAY", tx(), order.transferCode(), 100_000);
        assertFalse(wrong.delivered());
        assertEquals("AMOUNT_MISMATCH", wrong.outcome());
        assertEquals(0, env.cosmeticRepo.quantity(u, "HOUSE_SUNGOLD"));
        assertEquals("PENDING", pay.order(u, order.orderId()).status());
        assertEquals("AMOUNT_MISMATCH", pay.order(u, order.orderId()).review());

        // the exact, verified transfer: delivered once, to the order's own player
        String paid = tx();
        var done = pay.settle("SEPAY", paid, order.transferCode(), 149_000);
        assertTrue(done.delivered());
        assertTrue(done.deliveredNow());
        assertEquals(u, done.userId());
        assertEquals(1, env.cosmeticRepo.quantity(u, "HOUSE_SUNGOLD"));
        assertEquals(0, env.cosmeticRepo.quantity(other, "HOUSE_SUNGOLD"), "nobody else");
        var after = pay.order(u, order.orderId());
        assertEquals("FULFILLED", after.status());
        assertNotNull(after.paidAt());
        assertNull(after.qrImageUrl(), "a paid order shows no payment instructions");
        // the provider repeats the same transaction: nothing changes
        var replay = pay.settle("SEPAY", paid, order.transferCode(), 149_000);
        assertTrue(replay.delivered());
        assertFalse(replay.deliveredNow());
        assertEquals(1, env.cosmeticRepo.quantity(u, "HOUSE_SUNGOLD"));
        assertEquals(1, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND source = 'MONEY'", u));
        // a second, different transaction for the same order is a duplicate payment: recorded, never a second item
        String dup = tx();
        assertEquals("DUPLICATE_PAYMENT", pay.settle("SEPAY", dup, order.transferCode(), 149_000).outcome());
        assertEquals("DUPLICATE_PAYMENT", pay.settle("SEPAY", dup, order.transferCode(), 149_000).outcome(), "its replay adds no second issue");
        assertEquals(1, count("SELECT count(*) FROM public.garden_commerce_issue WHERE provider_transaction_id = ?", dup));
        assertEquals("COSMETIC_OWNED", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("HOUSE_SUNGOLD"))).code);

        // racing confirmations of one order with different transactions: one delivery
        var results = race(4, i -> () -> pay.settle("SEPAY", "race-" + second.orderId() + "-" + i, second.transferCode(), 149_000));
        assertEquals(1, results.stream().filter(r -> r instanceof CosmeticCheckoutService.Settled s && s.deliveredNow()).count());
        assertEquals(1, env.cosmeticRepo.quantity(other, "HOUSE_SUNGOLD"));
        assertEquals(3, count("SELECT count(*) FROM public.garden_commerce_issue WHERE order_id = ? AND kind = 'DUPLICATE_PAYMENT'", second.orderId()));

        // a cancelled order grants nothing and cannot be paid afterwards
        var cancelled = pay.start(u, key(), new CosmeticCheckoutRequest("PATH_JADE"));
        assertEquals("CANCELLED", pay.cancel(u, key(), cancelled.orderId()).status());
        assertEquals("ORDER_CLOSED", pay.settle("SEPAY", tx(), cancelled.transferCode(), 29_000).outcome());
        assertEquals(0, env.cosmeticRepo.quantity(u, "PATH_JADE"));

        // bought with Echo Coins while the transfer was on its way: no duplicate ownership, the money is flagged
        ledger.addCoins(u, 5_000, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        var pending = pay.start(u, key(), new CosmeticCheckoutRequest("PATH_COBBLE"));
        shop.buy(u, key(), new CosmeticBuyRequest("PATH_COBBLE"));
        var owned = pay.settle("SEPAY", tx(), pending.transferCode(), 29_000);
        assertFalse(owned.delivered());
        assertEquals("ALREADY_OWNED", owned.outcome());
        assertEquals(1, env.cosmeticRepo.quantity(u, "PATH_COBBLE"));
        assertEquals("CANCELLED", pay.order(u, pending.orderId()).status());
        assertEquals(1, count("SELECT count(*) FROM public.garden_commerce_issue WHERE order_id = ? AND status = 'OPEN'", pending.orderId()));

        // the database never lets an order go backwards, change its player or its amount, or disappear
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_order SET status = 'PENDING' WHERE id = ?", order.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_order SET status = 'FULFILLED', fulfilled_at = now() WHERE id = ?", cancelled.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_order SET user_id = ? WHERE id = ?", other, order.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_order SET amount_vnd = 1 WHERE id = ?", order.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_cosmetic_order WHERE id = ?", order.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_payment SET provider_transaction_id = 'x' WHERE order_id = ?", order.orderId()));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_commerce_issue WHERE order_id = ?", order.orderId()));
        // Echo Coins were never part of a paid order
        assertEquals(0, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND ref_id = 'HOUSE_SUNGOLD'", u));
    }

    @Test
    void aLatePaymentIsNeverDeliveredAutomaticallyAndOnlyTheAdministratorReconcilesIt() {
        long u = farmer(0);
        var order = pay.start(u, key(), new CosmeticCheckoutRequest("FENCE_FROST"));
        // inside the window plus the short webhook grace a transfer still counts; after it, it does not
        env.clock.advance(Duration.ofMinutes(15).plusSeconds(121));
        var late = pay.settle("SEPAY", "late-1", order.transferCode(), 29_000);
        assertFalse(late.delivered());
        assertEquals("LATE_PAYMENT", late.outcome());
        assertEquals(0, env.cosmeticRepo.quantity(u, "FENCE_FROST"), "expiry is decided by the server, not by the countdown on screen");
        var view = pay.order(u, order.orderId());
        assertEquals("EXPIRED", view.status());
        assertEquals("LATE_PAYMENT", view.review(), "the buyer sees that the transfer arrived and is being reconciled");
        // an expired order is replaced by a new one with a new reference
        var fresh = pay.start(u, key(), new CosmeticCheckoutRequest("FENCE_FROST"));
        assertNotEquals(order.orderId(), fresh.orderId());
        assertNotEquals(order.transferCode(), fresh.transferCode());
        pay.cancel(u, key(), fresh.orderId());

        long issue = jdbc.queryForObject("SELECT id FROM public.garden_commerce_issue WHERE provider_transaction_id = 'late-1'", Long.class);
        // only the official administrator
        assertEquals(403, rejected(() -> pay.queue(u)).status);
        assertEquals(403, rejected(() -> pay.resolveIssue(u, issue, "DELIVERED", null, null)).status);
        var queue = pay.queue(GardenTestEnv.ADMIN);
        assertTrue(queue.issues().stream().anyMatch(i -> i.id() == issue && i.kind().equals("LATE_PAYMENT") && i.paidAmountVnd() == 29_000));
        // the money is there and exact, the item is still not owned: deliver it
        pay.resolveIssue(GardenTestEnv.ADMIN, issue, "DELIVERED", null, "chuyển khoản trễ 3 phút");
        assertEquals(1, env.cosmeticRepo.quantity(u, "FENCE_FROST"));
        assertEquals("FULFILLED", pay.order(u, order.orderId()).status());
        assertEquals("ISSUE_RESOLVED", rejected(() -> pay.resolveIssue(GardenTestEnv.ADMIN, issue, "DELIVERED", null, null)).code);
        assertEquals(1, env.cosmeticRepo.quantity(u, "FENCE_FROST"));

        // a wrong-amount transfer can only be sent back by hand, and that needs the bank reference
        var order2 = pay.start(u, key(), new CosmeticCheckoutRequest("BED_FROST"));
        pay.settle("SEPAY", "short-1", order2.transferCode(), 20_000);
        long issue2 = jdbc.queryForObject("SELECT id FROM public.garden_commerce_issue WHERE provider_transaction_id = 'short-1'", Long.class);
        assertEquals("ISSUE_NOT_DELIVERABLE", rejected(() -> pay.resolveIssue(GardenTestEnv.ADMIN, issue2, "DELIVERED", null, null)).code);
        assertEquals("BANK_REFERENCE_REQUIRED", rejected(() -> pay.resolveIssue(GardenTestEnv.ADMIN, issue2, "REFUNDED_MANUALLY", " ", null)).code);
        pay.resolveIssue(GardenTestEnv.ADMIN, issue2, "REFUNDED_MANUALLY", "FT26285123456", "hoàn 20.000đ");
        assertEquals(0, env.cosmeticRepo.quantity(u, "BED_FROST"));
        assertEquals(0, count("SELECT count(*) FROM public.garden_commerce_issue WHERE status = 'OPEN' AND user_id = ?", u));
    }

    @Test
    void aCultivarIsDeliveredAndTakenBackLikeAnyOtherPaidItem() {
        long u = farmer(0);
        grown(u, "WHEAT");
        assertEquals(39_000L, shop.shop(u).skins().stream().filter(s -> s.code().equals("WHEAT_BLOSSOM")).findFirst().orElseThrow().priceVnd());
        var order = pay.start(u, key(), new CosmeticCheckoutRequest("WHEAT_BLOSSOM", "SKIN"));
        assertEquals(39_000, order.amountVnd());
        assertEquals("SKIN", order.kind());
        assertTrue(pay.settle("SEPAY", tx(), order.transferCode(), 39_000).delivered());
        assertEquals("MONEY", jdbc.queryForObject("SELECT source FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = 'WHEAT_BLOSSOM'", String.class, u));
        assertEquals("COSMETIC_OWNED", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("WHEAT_BLOSSOM", "SKIN"))).code);
        // unused, inside seven days: the buyer may ask; the administrator completes it after the manual bank transfer
        assertTrue(pay.order(u, order.orderId()).refundable());
        assertEquals("REQUESTED", pay.requestRefund(u, key(), order.orderId(), "Mua nhầm giống cây").refundStatus());
        assertEquals("REFUND_EXISTS", rejected(() -> pay.requestRefund(u, key(), order.orderId(), "Mua nhầm lần nữa")).code);
        long refund = jdbc.queryForObject("SELECT id FROM public.garden_cosmetic_refund WHERE order_id = ?", Long.class, order.orderId());
        assertEquals(403, rejected(() -> pay.completeRefund(u, refund, "FT1", null)).status);
        assertEquals("BANK_REFERENCE_REQUIRED", rejected(() -> pay.completeRefund(GardenTestEnv.ADMIN, refund, "", null)).code);
        pay.completeRefund(GardenTestEnv.ADMIN, refund, "FT26285000001", null);
        assertEquals(0, count("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = 'WHEAT_BLOSSOM'", u));
        var after = pay.order(u, order.orderId());
        assertEquals("REFUNDED", after.status());
        assertEquals("COMPLETED", after.refundStatus());
        assertEquals("REFUND_DECIDED", rejected(() -> pay.completeRefund(GardenTestEnv.ADMIN, refund, "FT26285000001", null)).code);
        // a replay of the paying transaction after the refund delivers nothing again
        String paidTx = jdbc.queryForObject("SELECT provider_transaction_id FROM public.garden_cosmetic_payment WHERE order_id = ?", String.class, order.orderId());
        assertFalse(pay.settle("SEPAY", paidTx, order.transferCode(), 39_000).deliveredNow());
        assertEquals(0, count("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = 'WHEAT_BLOSSOM'", u));
        // a cultivar earned another way is never taken by a refund of a different order
        assertFalse(env.commerce.revokeSkin(u, "WHEAT_BLOSSOM", UUID.randomUUID()));
    }

    @Test
    void refundsNeedAnUnusedItemInsideTheWindowAndTakeBackExactlyWhatTheOrderDelivered() {
        long u = farmer(10_000);
        // used: equipping (or placing) the item ends the buyer's right to ask
        var house = pay.start(u, key(), new CosmeticCheckoutRequest("HOUSE_BLOSSOM"));
        pay.settle("SEPAY", tx(), house.transferCode(), 149_000);
        shop.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_BLOSSOM"));
        assertFalse(pay.order(u, house.orderId()).refundable());
        assertEquals("REFUND_ITEM_USED", rejected(() -> pay.requestRefund(u, key(), house.orderId(), "Đổi ý sau khi dùng")).code);
        shop.equip(u, key(), new CosmeticEquipRequest("HOUSE", null));
        assertEquals("REFUND_ITEM_USED", rejected(() -> pay.requestRefund(u, key(), house.orderId(), "Đã gỡ ra rồi")).code);
        // ... but a charge-back or an unauthorized payment is the administrator's call, used or not: the item goes
        shop.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_BLOSSOM"));
        pay.openRefund(GardenTestEnv.ADMIN, house.orderId(), "CHARGEBACK", "Ngân hàng tra soát giao dịch", "FT26285000002");
        assertEquals(0, env.cosmeticRepo.quantity(u, "HOUSE_BLOSSOM"));
        assertFalse(env.state.state(u).cosmetics().equipped().containsKey("HOUSE"));
        assertEquals(1, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND reversed_at IS NOT NULL", u), "history stays, marked");
        assertEquals("REFUNDED", pay.order(u, house.orderId()).status());
        assertEquals("REFUND_NOT_PAID", rejected(() -> pay.openRefund(GardenTestEnv.ADMIN, house.orderId(), "DEFECT", "lần hai", "FT3")).code);

        // the window: seven days after the payment
        var tree = pay.start(u, key(), new CosmeticCheckoutRequest("TREE_SAKURA"));
        pay.settle("SEPAY", tx(), tree.transferCode(), 39_000);
        assertEquals(Duration.ofDays(7), Duration.between(pay.order(u, tree.orderId()).paidAt(), pay.order(u, tree.orderId()).refundDeadline()));
        env.clock.advance(Duration.ofDays(7).plusSeconds(1));
        assertEquals("REFUND_WINDOW_OVER", rejected(() -> pay.requestRefund(u, key(), tree.orderId(), "Quá hạn bảy ngày")).code);
        assertEquals("REFUND_NOT_PAID", rejected(() -> pay.requestRefund(u, key(), house.orderId(), "Đơn đã hoàn rồi")).code);
        // a rejected request leaves the item with the buyer
        var path = pay.start(u, key(), new CosmeticCheckoutRequest("PATH_PETAL"));
        pay.settle("SEPAY", tx(), path.transferCode(), 29_000);
        pay.requestRefund(u, key(), path.orderId(), "Không thích màu");
        long refund = jdbc.queryForObject("SELECT id FROM public.garden_cosmetic_refund WHERE order_id = ?", Long.class, path.orderId());
        assertEquals("NOTE_REQUIRED", rejected(() -> pay.rejectRefund(GardenTestEnv.ADMIN, refund, null)).code);
        pay.rejectRefund(GardenTestEnv.ADMIN, refund, "Đã dùng trên tài khoản khác");
        assertEquals(1, env.cosmeticRepo.quantity(u, "PATH_PETAL"));
        assertEquals("REJECTED", pay.order(u, path.orderId()).refundStatus());
        assertEquals("FULFILLED", pay.order(u, path.orderId()).status());

        // a decoration: money buys the first unit; further units are for Echo Coins; a refund takes ONE unit back
        var lantern = pay.start(u, key(), new CosmeticCheckoutRequest("DECOR_LANTERN_STONE"));
        assertEquals(19_000, lantern.amountVnd());
        pay.settle("SEPAY", tx(), lantern.transferCode(), 19_000);
        assertEquals("COSMETIC_OWNED", rejected(() -> pay.start(u, key(), new CosmeticCheckoutRequest("DECOR_LANTERN_STONE"))).code);
        shop.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        assertEquals(2, env.cosmeticRepo.quantity(u, "DECOR_LANTERN_STONE"));
        pay.openRefund(GardenTestEnv.ADMIN, lantern.orderId(), "DUPLICATE_CHARGE", "Khách bị trừ hai lần", "FT26285000003");
        assertEquals(1, env.cosmeticRepo.quantity(u, "DECOR_LANTERN_STONE"), "the coin-bought unit stays");
        shop.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        assertEquals(2, env.cosmeticRepo.quantity(u, "DECOR_LANTERN_STONE"), "and the next unit can still be bought");
        assertEquals(2, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND cosmetic_code = 'DECOR_LANTERN_STONE' AND reversed_at IS NULL", u));
        // refund records only move forward
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_refund SET status = 'REQUESTED', decided_at = NULL WHERE id = ?", refund));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_cosmetic_refund WHERE id = ?", refund));
        assertCoinsReconcile(u);
    }

    // ================================================================== F. upgrade

    @Test
    void aGardenFromBeforeV87KeepsEverythingAndGainsTheNewShelves() {
        try (var old = new GardenTestEnv(START, "86")) {
            long u = USERS.incrementAndGet();
            old.jdbc.update("INSERT INTO public.users(id) VALUES (?)", u);
            old.props.getAllowlistUserIds().add(u);
            old.state.state(u);
            long starter = old.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u);
            new LedgerService(old.ctx).addCoins(u, 9_000 - starter, "TEST_FIXTURE", "TEST", "fixture", null, old.clock.now);
            old.cosmetics.buy(u, key(), new CosmeticBuyRequest("PATH_COBBLE"));
            old.jdbc.update("INSERT INTO public.user_avatar_frames(user_id, frame_id, source, is_equipped) VALUES (?, 23, 'SEASONAL', TRUE)", u);
            // the new code on the old schema: the old shop works, every Phase 3F surface is simply closed
            assertFalse(old.cosmetics.shop(u).checkoutEnabled());
            assertNull(old.cosmetics.shop(u).items().getFirst().priceVnd());
            assertEquals("REWARDS_CLOSED", rejected(() -> old.echoRewards.view(u)).code);
            assertEquals("CHECKOUT_DISABLED", rejected(() -> old.checkout.start(u, key(), new CosmeticCheckoutRequest("PATH_JADE"))).code);
            assertEquals(404, rejected(() -> old.checkout.order(u, 1)).status);

            var upgraded = new GardenTestEnv(old, START, "87");
            upgraded.props.getAllowlistUserIds().add(u);
            assertEquals(6_000, upgraded.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u));
            assertEquals(1, upgraded.cosmeticRepo.quantity(u, "PATH_COBBLE"));
            assertEquals(1, upgraded.jdbc.queryForObject("SELECT count(*) FROM public.user_avatar_frames WHERE user_id = ? AND frame_id = 23 AND is_equipped", Integer.class, u));
            var rewards = upgraded.echoRewards.view(u);
            assertEquals(20, rewards.frames().total());
            assertEquals("CLOSED", rewards.premium().status(), "cost-bearing rewards are closed until the owner configures them");
            assertEquals("CLOSED", rewards.vouchers().status());
            assertEquals(0, rewards.vouchers().balance());
        }
    }
}
