package com.englishcoach.garden;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.api.GardenController;
import com.englishcoach.garden.api.GardenExceptionHandler;
import com.englishcoach.garden.application.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.*;

import javax.sql.DataSource;
import java.nio.file.*;
import java.time.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Opt-in localhost UI fixture. Synthetic balances and clock; actual controller, services and disposable PG17. */
@EnabledIfSystemProperty(named = "garden.browser", matches = "true")
class GardenBrowserFixtureTest {
    private static GardenTestEnv env;
    /** Phase 3F (target 87): checkout with a stand-in gateway — references and a labelled test account only, no provider. */
    private static CosmeticCheckoutService fixtureCheckout;
    private static CosmeticService fixtureCosmetics;
    private static final java.util.concurrent.atomic.AtomicInteger FIXTURE_TX = new java.util.concurrent.atomic.AtomicInteger();

    static final class FixtureGateway implements com.englishcoach.garden.application.CosmeticPaymentGateway {
        final java.util.concurrent.atomic.AtomicInteger seq = new java.util.concurrent.atomic.AtomicInteger();
        @Override public String provider() { return "SEPAY"; }
        @Override public String createPayment(long userId, String skuCode, long amountVnd) { return "ECFIX" + String.format("%05d", seq.incrementAndGet()); }
        @Override public Instructions instructions(String reference, long amountVnd) {
            String svg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 220'><rect width='220' height='220' fill='white'/>"
                    + "<rect x='16' y='16' width='188' height='188' fill='none' stroke='black' stroke-width='6' stroke-dasharray='14 8'/>"
                    + "<text x='110' y='104' font-size='17' text-anchor='middle'>QR FIXTURE</text><text x='110' y='132' font-size='15' text-anchor='middle'>" + reference + "</text></svg>";
            return new Instructions("NGAN HANG THU NGHIEM", "0000 FIXTURE", "TAI KHOAN THU NGHIEM", svg);
        }
    }

    @Configuration
    @EnableAutoConfiguration(exclude = {
            org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,
            org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({GardenController.class, com.englishcoach.garden.api.GardenRewardController.class,
            com.englishcoach.garden.api.GardenSocialController.class, com.englishcoach.garden.api.GardenAnimalController.class,
            com.englishcoach.garden.api.GardenAdminQaController.class,
            GardenExceptionHandler.class, FixtureClock.class})
    static class Fixture {
        /**
         * Phase 4: the fixture player that plays the official administrator ({@code -Dgarden.fixture.admin=9001}; none by
         * default). It carries the administrator role, as the real account does; every other fixture player is an
         * ordinary learner and is refused by the same URL rule production has.
         */
        static final long ADMIN = Long.getLong("garden.fixture.admin", -1L);

        @Bean com.englishcoach.garden.application.GardenAdminQaService adminQa(CosmeticService cosmetics) {
            return new com.englishcoach.garden.application.GardenAdminQaService(env.ctx, env.access, env.setup, env.ledgerService, env.ingest,
                    new com.englishcoach.garden.infra.AdminQaRepository(env.jdbc), env.animalRepo, cosmetics, env.animals, id -> id == ADMIN);
        }
        @Bean DataSource dataSource() { return env.ds; }
        @Bean SocialService social() { return env.social; }
        @Bean com.englishcoach.garden.application.AnimalService animals() { return env.animals; }
        @Bean GardenAccessService access() { return new GardenAccessService(env.props); }
        @Bean GardenStateService state() { return env.state; }
        @Bean PlantingService planting() { return env.planting; }
        @Bean HarvestService harvest() { return env.harvest; }
        @Bean SellService sell() { return env.sell; }
        @Bean KnowledgeService knowledge() { return env.knowledge; }
        @Bean PestService pests() { return env.pests; }
        @Bean FarmEconomyService economy() { return env.economy; }
        @Bean CollectionService collection() { return env.collection; }
        @Bean MonumentService monument() { return env.monument; }
        @Bean EstateService estate() { return env.estate; }
        @Bean ContributionService contribution() { return env.contribution; }
        @Bean com.englishcoach.garden.application.FarmingService farming() { return env.farming; }
        @Bean CosmeticService cosmetics() { return fixtureCosmetics != null ? fixtureCosmetics : env.cosmetics; }
        @Bean CosmeticCheckoutService cosmeticCheckout() { return fixtureCheckout != null ? fixtureCheckout : env.checkout; }
        @Bean com.englishcoach.garden.application.EchoRewardService echoRewards() { return env.echoRewards; }
        @Bean LoginThrottleService throttle() {
            var t = mock(LoginThrottleService.class);
            when(t.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
            when(t.countRequest(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
            return t;
        }
        @Bean JwtDecoder decoder() {
            return token -> {
                // 9001 and 9002 are the players of the earlier journeys; 9003-9005 exist for the guide's journey
                if (!token.matches("garden-fixture-900[1-5]")) throw new JwtException("Local fixture only");
                return new Jwt(token, Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "fixture-only"),
                        Map.of("sub", token.substring(token.length() - 4)));
            };
        }
        @Bean CustomJwtAuthenticationConverter converter() {
            var c = mock(CustomJwtAuthenticationConverter.class);
            when(c.convert(any(Jwt.class))).thenAnswer(inv -> {
                Jwt jwt = inv.getArgument(0);
                long id = Long.parseLong(jwt.getSubject());
                List<org.springframework.security.core.GrantedAuthority> roles = id == ADMIN
                        ? List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_ADMIN")) : List.of();
                var u = new UserDetailsImpl(id, "garden-fixture@example.test", "", roles);
                return new UsernamePasswordAuthenticationToken(u, null, u.getAuthorities());
            });
            return c;
        }
        @Bean SecurityFilterChain security(HttpSecurity http, CustomJwtAuthenticationConverter c) throws Exception {
            // the administrator URL rule of WebSecurityConfig, so an ordinary fixture player is refused where production refuses
            return http.csrf(x -> x.disable()).authorizeHttpRequests(x -> x.requestMatchers("/api/v1/admin/**").hasRole("ADMIN")
                            .anyRequest().authenticated())
                    .oauth2ResourceServer(x -> x.jwt(j -> j.jwtAuthenticationConverter(c))).build();
        }
    }

    @RestController
    static class FixtureClock {
        @PostMapping("/fixture/garden/advance") Map<String, Object> advance(@RequestBody Map<String, Long> request) {
            long seconds = request.getOrDefault("seconds", 0L);
            assertTrue(seconds >= 0 && seconds <= 86400);
            env.clock.advance(Duration.ofSeconds(seconds));
            return Map.of("serverNow", env.clock.instant());
        }
        /**
         * Phase 3B: simulated study days for the synthetic learner. Each day advances the disposable clock by one day and
         * writes what the real modules record: five Flashcard review-log rows on different cards, optionally a finished
         * dictation session (every {@code dictationEvery}-th day) and a READY writing assessment (every
         * {@code writingEvery}-th day). Only this disposable database is touched.
         */
        @PostMapping("/fixture/garden/study") Map<String, Object> study(@RequestBody Map<String, Long> request) {
            long days = request.getOrDefault("days", 1L), dictationEvery = request.getOrDefault("dictationEvery", 0L),
                    writingEvery = request.getOrDefault("writingEvery", 0L);
            assertTrue(days >= 1 && days <= 400);
            Long done = env.jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = 9001", Long.class);
            long n = done == null ? 0 : done;
            for (long d = 1; d <= days; d++) {
                env.clock.advance(Duration.ofDays(1));
                Instant at = env.clock.instant().minusSeconds(600);
                for (int card = 1; card <= 5; card++) {
                    env.jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) "
                            + "VALUES (9001, 'FLASHCARD_REVIEWED', ?, ?)", card + ":" + (++n), java.sql.Timestamp.from(at.plusSeconds(card)));
                }
                if (dictationEvery > 0 && d % dictationEvery == 0) {
                    LocalDateTime local = LocalDateTime.ofInstant(at, ZoneId.systemDefault());
                    Long session = env.jdbc.queryForObject("INSERT INTO public.listening_sessions(user_id, started_at, ended_at) "
                            + "VALUES (9001, ?, ?) RETURNING id", Long.class, java.sql.Timestamp.valueOf(local.minusMinutes(10)), java.sql.Timestamp.valueOf(local));
                    for (int i = 0; i < 3; i++) env.jdbc.update("INSERT INTO public.exercise_attempts(listening_session_id, accuracy_percentage) VALUES (?, 90)", session);
                }
                if (writingEvery > 0 && d % writingEvery == 0) {
                    Long sub = env.jdbc.queryForObject("INSERT INTO public.writing_submissions(user_id, session_id, word_count) "
                            + "VALUES (9001, ?, 120) RETURNING id", Long.class, "fixture-" + n);
                    env.jdbc.update("INSERT INTO public.writing_assessments(submission_id, status, completed_at) VALUES (?, 'READY', ?)",
                            sub, java.sql.Timestamp.from(at));
                }
            }
            return Map.of("serverNow", env.clock.instant(), "days", days);
        }

        // ---------------------------------------------------------------- Phase 3D fixtures (disposable database only)

        /**
         * Moves the disposable clock forward to a staged situation of the GLOBAL deterministic weather timeline: the start
         * of {@code hours} without rain (kind DRY) or of {@code hours} of continuous rain (kind RAIN). The weather itself
         * is never altered: the server computes it exactly as in production.
         */
        @PostMapping("/fixture/garden/weather") Map<String, Object> weather(@RequestBody Map<String, Object> request) {
            String kind = String.valueOf(request.getOrDefault("kind", "DRY"));
            int hours = ((Number) request.getOrDefault("hours", 12)).intValue();
            assertTrue(hours >= 1 && hours <= 48 && (kind.equals("DRY") || kind.equals("RAIN")));
            var timeline = env.ctx.engine().weather();
            for (int tries = 0; tries < 8000; tries++) {
                boolean match = true;
                for (int h = 0; h <= hours && match; h++) {
                    boolean rain = timeline.at(env.clock.instant().plus(Duration.ofHours(h)))
                            == com.englishcoach.garden.domain.WeatherCalendar.Weather.RAIN;
                    match = kind.equals("RAIN") == rain;
                }
                if (match) return Map.of("serverNow", env.clock.instant(), "kind", kind, "hours", hours);
                env.clock.advance(Duration.ofHours(1));
            }
            throw new IllegalStateException("no such weather spell");
        }

        // ---------------------------------------------------------------- Phase 3C fixtures (disposable database only)

        /** Synthetic coins through the ledger (balances stay reconciled). */
        @PostMapping("/fixture/garden/coins") Map<String, Object> coins(@RequestBody Map<String, Long> request) {
            long coins = request.getOrDefault("coins", 0L);
            assertTrue(coins > 0 && coins <= 20_000_000);
            env.ctx.read(9001, now -> {
                new LedgerService(env.ctx).addCoins(9001, coins, "BROWSER_FIXTURE", "FIXTURE", "synthetic", UUID.randomUUID(), now);
                return null;
            });
            return Map.of("coins", env.jdbc.queryForObject("SELECT coins FROM garden_profile WHERE user_id = 9001", Long.class));
        }

        /** Farm facts a land gate reads: delivered orders and closed harvests (real play fills orders and harvests). */
        @PostMapping("/fixture/garden/farm-facts") Map<String, Object> farmFacts(@RequestBody Map<String, Long> request) {
            long orders = request.getOrDefault("orders", 0L), harvests = request.getOrDefault("harvests", 0L);
            assertTrue(orders >= 0 && orders <= 200 && harvests >= 0 && harvests <= 5000);
            for (long i = 0; i < orders; i++) {
                env.jdbc.update("""
                        INSERT INTO public.garden_order(user_id, slot, kind, period_key, lines, base_coins, bonus, created_at, expires_at, status,
                            filled_at, paid_coins, blessing, delivered, fill_op)
                        VALUES (9001, 1, 'DAILY', ?, '[{"cropCode":"WHEAT","qty":1,"minTier":"NORMAL"}]'::jsonb, 1, '{}'::jsonb,
                            now() - interval '2 hours', now() + interval '2 hours', 'FILLED', now() - interval '1 hour', 1, false,
                            '[{"cropCode":"WHEAT","tier":"NORMAL","qty":1}]'::jsonb, ?) ON CONFLICT DO NOTHING""", "fx-" + i, UUID.randomUUID());
            }
            if (harvests > 0) {
                env.jdbc.update("""
                        INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                        VALUES (9001, 'WHEAT', ?, 0, 1, 2, now(), now())
                        ON CONFLICT (user_id, crop_code) DO UPDATE SET harvests = GREATEST(garden_crop_mastery.harvests, EXCLUDED.harvests)""", harvests);
            }
            return Map.of("orders", orders, "harvests", harvests);
        }

        /** One of the synthetic learner's cards, overdue by {@code hoursAgo} hours in the Flashcard scheduler's own columns. */
        @PostMapping("/fixture/garden/overdue") Map<String, Object> overdue(@RequestBody Map<String, Object> request) {
            long hours = ((Number) request.getOrDefault("hoursAgo", 30)).longValue();
            String word = String.valueOf(request.getOrDefault("word", "harvest"));
            assertTrue(hours >= 0 && hours <= 2000 && word.matches("[a-z]{2,20}"));
            Long entry = env.jdbc.queryForObject("""
                    INSERT INTO public.dictionary_entries(word, ipa, cefr, general_translation_vi) VALUES (?, ?, 'A2', ?)
                    ON CONFLICT (word) DO UPDATE SET cefr = EXCLUDED.cefr RETURNING id""", Long.class, word, "/" + word + "/",
                    String.valueOf(request.getOrDefault("meaning", "nghĩa của " + word)));
            Long card = env.jdbc.queryForObject("""
                    INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                    VALUES (9001, ?, 'LEARNED', LOCALTIMESTAMP - make_interval(hours => ?), 1) RETURNING id""", Long.class, entry, (int) hours);
            return Map.of("flashcardId", card, "word", word);
        }

        /**
         * What the real Flashcard review endpoint does for the garden's purposes: one review-log row at the disposable
         * clock's time and a due date in the future. The browser harness routes the UI's PUT /flashcards/{id}/review here.
         */
        @PostMapping("/fixture/garden/review") Map<String, Object> review(@RequestBody Map<String, Long> request) {
            long card = request.getOrDefault("flashcardId", 0L);
            Integer owned = env.jdbc.queryForObject("SELECT count(*) FROM public.flashcards WHERE id = ? AND user_id = 9001", Integer.class, card);
            assertEquals(1, owned);
            Integer n = env.jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = 9001 AND source_ref LIKE ?",
                    Integer.class, card + ":%");
            env.jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (9001, 'FLASHCARD_REVIEWED', ?, ?)",
                    card + ":fx" + ((n == null ? 0 : n) + 1), java.sql.Timestamp.from(env.clock.instant()));
            env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days', review_count = review_count + 1 WHERE id = ?", card);
            return Map.of("reviewed", card);
        }

        /** The reward counter's kill switch (default off; production keeps the application.yml default). */
        @PostMapping("/fixture/garden/rewards") Map<String, Object> rewards(@RequestBody Map<String, Boolean> request) {
            env.props.setRewardsEnabled(Boolean.TRUE.equals(request.get("enabled")));
            return Map.of("rewardsEnabled", env.props.isRewardsEnabled());
        }

        /** Phase 3B: graduated five-card trees with five NEW words each (real play needs the 14-day cycle and the challenge). */
        @PostMapping("/fixture/garden/graduate") Map<String, Object> graduate(@RequestBody Map<String, Long> request) {
            long count = request.getOrDefault("count", 1L);
            assertTrue(count >= 1 && count <= 40);
            Long base = env.jdbc.queryForObject("SELECT coalesce(max(flashcard_id), 5000) FROM public.garden_knowledge_card WHERE user_id = 9001", Long.class);
            long card = base == null ? 5000 : base;
            java.sql.Timestamp at = java.sql.Timestamp.from(env.clock.instant());
            String[] species = {"SPRING", "SUMMER", "AUTUMN", "WINTER"};
            for (long i = 0; i < count; i++) {
                Long tree = env.jdbc.queryForObject("""
                        INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, status, peak_stage, essence_since, graduated_at)
                        VALUES (9001, 1, ?, ?, 'GRADUATED', 4, ?, ?) RETURNING id
                        """, Long.class, species[(int) (i % 4)], java.sql.Timestamp.from(env.clock.instant().minus(Duration.ofDays(15))), at, at);
                for (int pos = 1; pos <= 5; pos++) {
                    env.jdbc.update("INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi, released_at) "
                            + "VALUES (?, 9001, ?, ?, ?, ?, ?)", tree, pos, ++card, "word" + card, "nghĩa " + card, at);
                }
            }
            return Map.of("graduated", count);
        }

        /** Phase 3F: what the payment module does after ITS checks — one verified transfer for an order's reference. */
        @PostMapping("/fixture/garden/pay") Map<String, Object> pay(@RequestBody Map<String, Long> request) {
            var payment = env.commerce.payment(request.get("orderId"));
            var settled = fixtureCheckout.settle("SEPAY", "fixture-tx-" + FIXTURE_TX.incrementAndGet(), payment.transferCode(), request.get("amountVnd"));
            return Map.of("delivered", settled.delivered(), "outcome", settled.outcome());
        }

        /** Phase 3F: the owner's budget configuration (switch + three numbers each) and verified learning days for the synthetic learner. */
        @PostMapping("/fixture/garden/rewards-open") Map<String, Object> rewardsOpen(@RequestBody Map<String, Long> request) {
            env.props.setPremiumRewardEnabled(true);
            env.props.setPremiumRewardMonthlyCap(50);
            env.props.setPremiumRewardUnitCostVnd(14_000);
            env.props.setPremiumRewardMonthlyBudgetVnd(700_000);
            env.props.setAiVoucherEnabled(true);
            env.props.setAiVoucherMonthlyCreditCap(500);
            env.props.setAiVoucherUnitCostVnd(500);
            env.props.setAiVoucherMonthlyBudgetVnd(250_000);
            long days = request.getOrDefault("learningDays", 0L);
            java.time.LocalDate today = java.time.LocalDate.ofInstant(env.clock.instant(), java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
            for (long i = 0; i < days; i++) {
                env.jdbc.update("INSERT INTO public.garden_monument_day(user_id, day_key, vocabulary, recorded_at) VALUES (9001, ?, TRUE, now()) "
                        + "ON CONFLICT (user_id, day_key) DO UPDATE SET vocabulary = TRUE", java.sql.Date.valueOf(today.minusDays(i)));
            }
            return Map.of("learningDays", days);
        }

        // ---------------------------------------------------------------- Phase 3G fixtures (disposable database only)

        /**
         * Phase 3G (target 88): two more REAL fixture players with their own gardens, reached only through the actual
         * services. 9002 "Minh Anh" is an established open island with a ripe tomato and a growing corn; 9003 is a garden
         * that just joined (protected). Then 9002 takes a little from the browser player's ripe tomato through the real
         * command, so the browser player finds a real activity line and a real notice. Nothing is written by hand except
         * the two join dates that put 9001 and 9002 past the introductory protection.
         */
        @PostMapping("/fixture/garden/social-stage") Map<String, Object> socialStage() {
            assertNotNull(env.ctx.social(), "the social islands need -Dgarden.fixture.target=88");
            env.jdbc.update("UPDATE public.users SET name = 'Bạn Thử Nghiệm' WHERE id = 9001");
            env.jdbc.update("UPDATE public.users SET name = 'Minh Anh' WHERE id = 9002");
            env.jdbc.update("INSERT INTO public.users(id, name) VALUES (9003, 'Lan Mới Đến') ON CONFLICT (id) DO NOTHING");
            var first = env.state.state(9001);
            var host = env.state.state(9002);
            env.ctx.read(9002, now -> {
                new LedgerService(env.ctx).addXp(9002, 30000, "BROWSER_FIXTURE", "FIXTURE", "synthetic", UUID.randomUUID(), now);
                return null;
            });
            var plant = new com.englishcoach.garden.api.GardenDtos.PlantRequest("TOMATO");
            long mine = env.planting.plant(9001, UUID.randomUUID(), first.plots().get(5).id(), plant).plot().planting().id();
            long ripe = env.planting.plant(9002, UUID.randomUUID(), host.plots().get(0).id(), plant).plot().planting().id();
            for (int i = 0; i < 400; i++) {
                boolean a = env.state.state(9001).plots().get(5).planting().ready();
                boolean b = env.state.state(9002).plots().get(0).planting().ready();
                if (a && b) break;
                env.clock.advance(Duration.ofMinutes(30));
            }
            env.clock.advance(Duration.ofMinutes(45));
            long growing = env.planting.plant(9002, UUID.randomUUID(), host.plots().get(1).id(),
                    new com.englishcoach.garden.api.GardenDtos.PlantRequest("CORN")).plot().planting().id();
            java.sql.Timestamp joined = java.sql.Timestamp.from(env.clock.instant().minus(Duration.ofDays(30)));
            env.jdbc.update("UPDATE public.garden_social_profile SET created_at = ?, visibility_changed_at = ? WHERE user_id IN (9001, 9002)", joined, joined);
            env.state.state(9003);
            var mineHandle = env.socialRepo.profile(9001).handle();
            var receipt = env.social.take(9002, UUID.randomUUID(), mineHandle, mine);
            return Map.of("me", mineHandle, "host", env.socialRepo.profile(9002).handle(), "fresh", env.socialRepo.profile(9003).handle(),
                    "takenPlanting", mine, "hostRipe", ripe, "hostGrowing", growing, "takeId", receipt.takeId(), "takenAt", env.clock.instant());
        }

        // ---------------------------------------------------------------- Phase 3H fixtures (disposable database only)

        /**
         * Phase 3H (target 89), called after the browser player has opened their island: fixture player 9002 "Minh Anh"
         * becomes a real neighbour with a real farm, played through the actual commands — an open island, a coop with two
         * chickens, a sheep barn with one sheep, a guardian dog and a cat, four cared-for days, and a ripe tomato. Then
         * 9002 takes a little from the browser player's ripe tomato and the browser player's harvest pays the other nine
         * portions (both real commands). By hand only: synthetic supplies through the ledger and the two join dates that
         * put both islands past the introductory protection.
         */
        @PostMapping("/fixture/garden/animal-stage") Map<String, Object> animalStage() {
            assertNotNull(env.ctx.animals(), "the animals need -Dgarden.fixture.target=89");
            env.jdbc.update("UPDATE public.users SET name = 'Bạn Thử Nghiệm' WHERE id = 9001");
            env.jdbc.update("UPDATE public.users SET name = 'Minh Anh' WHERE id = 9002");
            var first = env.state.state(9001);
            var host = env.state.state(9002);
            assertEquals("PUBLIC", first.social().visibility(), "the browser player opens their island first");
            var ledger = new LedgerService(env.ctx);
            env.ctx.read(9002, now -> {
                UUID key = UUID.randomUUID();
                ledger.addXp(9002, env.ctx.engine().levels().totalXpForLevel(14), "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                ledger.addCoins(9002, 200000, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                ledger.addItem(9002, "CROP:WHEAT", "NORMAL", 200, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                ledger.addItem(9002, "WELL_WATER", "NA", 12, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                return null;
            });
            env.ctx.read(9001, now -> {
                ledger.addItem(9001, "WELL_WATER", "NA", 4, "BROWSER_FIXTURE", "FIXTURE", "synthetic", UUID.randomUUID(), now);
                return null;
            });
            env.social.setVisibility(9002, UUID.randomUUID(), "PUBLIC");
            var a = env.animals;
            a.buildHouse(9002, UUID.randomUUID(), "COOP");
            a.buildHouse(9002, UUID.randomUUID(), "SHEEP_BARN");
            for (String species : List.of("CHICKEN", "CHICKEN", "SHEEP", "DOG", "CAT")) a.buy(9002, UUID.randomUUID(), species);
            a.mill(9002, UUID.randomUUID(), new com.englishcoach.garden.api.GardenDtos.FeedMillRequest("WHEAT", "NORMAL", 150));
            var plant = new com.englishcoach.garden.api.GardenDtos.PlantRequest("TOMATO");
            long mine = env.planting.plant(9001, UUID.randomUUID(), first.plots().get(5).id(), plant).plot().planting().id();
            long ripe = env.planting.plant(9002, UUID.randomUUID(), host.plots().get(0).id(), plant).plot().planting().id();
            // four days of ordinary care: refill a trough when it runs low, feed whoever can eat
            for (int day = 0; day < 4; day++) {
                for (var h : env.state.state(9002).animals().houses()) {
                    if (!h.built()) continue;
                    if (h.canRefill()) a.water(9002, UUID.randomUUID(), h.code());
                    if (h.feedNeeded() > 0) a.feedHouse(9002, UUID.randomUUID(), h.code());
                }
                env.clock.advance(Duration.ofHours(24));
            }
            for (var h : env.state.state(9002).animals().houses()) {
                if (h.built() && h.canRefill()) a.water(9002, UUID.randomUUID(), h.code());
                if (h.built() && h.feedNeeded() > 0) a.feedHouse(9002, UUID.randomUUID(), h.code());
            }
            a.feedGuardian(9002, UUID.randomUUID(), "DOG");
            a.feedGuardian(9002, UUID.randomUUID(), "CAT");
            java.sql.Timestamp joined = java.sql.Timestamp.from(env.clock.instant().minus(Duration.ofDays(30)));
            env.jdbc.update("UPDATE public.garden_social_profile SET created_at = ?, visibility_changed_at = ? WHERE user_id IN (9001, 9002)", joined, joined);
            var mineHandle = env.socialRepo.profile(9001).handle();
            var receipt = env.social.take(9002, UUID.randomUUID(), mineHandle, mine);
            var challenge = env.harvest.start(9001, UUID.randomUUID(), new com.englishcoach.garden.api.GardenDtos.HarvestStartRequest(List.of(mine)));
            var harvested = env.harvest.complete(9001, UUID.randomUUID(),
                    new com.englishcoach.garden.api.GardenDtos.HarvestCompleteRequest(challenge.challengeId(), List.of(0, 0, 0), false));
            return Map.of("me", mineHandle, "host", env.socialRepo.profile(9002).handle(), "hostRipe", ripe, "takeId", receipt.takeId(),
                    "ownerPortions", harvested.harvests().getFirst().sharePortions(), "ownerTier", harvested.harvests().getFirst().tier());
        }

        /** Phase 3H: the neighbour comes back and feeds their guardians (the real command): a hungry dog does not guard. */
        @PostMapping("/fixture/garden/neighbour-care") Map<String, Object> neighbourCare() {
            env.animals.feedGuardian(9002, UUID.randomUUID(), "DOG");
            env.animals.feedGuardian(9002, UUID.randomUUID(), "CAT");
            return Map.of("dog", env.state.state(9002).animals().guardians().stream().filter(g -> g.species().equals("DOG")).findFirst().orElseThrow().status());
        }

        /** Phase 3H: every animal row and every animal ledger line of the fixture players (ownership and once-only checks). */
        @GetMapping("/fixture/garden/animal-facts") Map<String, Object> animalFacts() {
            return Map.of(
                    "animals", env.jdbc.queryForList("SELECT user_id, species, kind, house_code, place FROM public.garden_animal ORDER BY user_id, id"),
                    "houses", env.jdbc.queryForList("SELECT user_id, code FROM public.garden_animal_house ORDER BY user_id, code"),
                    "ledger", env.jdbc.queryForList("SELECT user_id, asset, reason, sum(delta) AS total FROM public.garden_ledger "
                            + "WHERE reason IN ('ANIMAL_HOUSE','ANIMAL_BUY','ANIMAL_FEED','ANIMAL_WATER','ANIMAL_COLLECT','FEED_MILL','PRODUCT_SELL','MANURE_COMPOST') "
                            + "GROUP BY user_id, asset, reason ORDER BY user_id, asset, reason"),
                    "takes", env.jdbc.queryForList("SELECT victim_id, thief_id, portions FROM public.garden_theft ORDER BY id"),
                    "negative", env.jdbc.queryForObject("SELECT count(*) FROM public.garden_inventory WHERE qty < 0", Long.class));
        }

        /** Phase 3G: what the garden handed to the notification centre for the browser player (recorded, not sent). */
        @GetMapping("/fixture/garden/notices") List<GardenTestEnv.Notice> notices() {
            return env.notices.stream().filter(n -> n.ownerId() == 9001).toList();
        }

        /** Phase 3H: every recorded notice (the guardian dog's notice goes to the visited island's owner). */
        @GetMapping("/fixture/garden/notices-all") List<GardenTestEnv.Notice> allNotices() {
            return List.copyOf(env.notices);
        }

        /** Phase 3G: fragments and produce of any fixture player, and every recorded take (conservation check). */
        @GetMapping("/fixture/garden/social-facts") Map<String, Object> socialFacts() {
            return Map.of(
                    "shares", env.jdbc.queryForList("SELECT user_id, item_code, tier, qty FROM public.garden_inventory WHERE item_code LIKE 'SHARE:%' AND qty > 0 ORDER BY user_id, item_code"),
                    "takes", env.jdbc.queryForList("SELECT victim_id, thief_id, planting_id, crop_code, portions, unit_portions FROM public.garden_theft ORDER BY id"));
        }

        /**
         * The guide's journey: a fixture player whose garden existed BEFORE the guide and stopped somewhere in the old
         * tutorial (its stored step is set directly; only this disposable database is touched).
         */
        @PostMapping("/fixture/garden/legacy") Map<String, Object> legacy(@RequestBody Map<String, Long> request) {
            long user = request.getOrDefault("user", 0L), step = request.getOrDefault("step", 0L);
            assertTrue(user >= 9003 && user <= 9005 && step >= 0 && step <= 8);
            env.state.state(user);
            env.jdbc.update("UPDATE public.garden_profile SET onboarding_step = ? WHERE user_id = ?", (int) step, user);
            return Map.of("user", user, "onboardingStep", step);
        }

        /** Everything of value every fixture garden holds (the guide must change none of it by itself). */
        @GetMapping("/fixture/garden/wealth") List<Map<String, Object>> wealth() {
            return env.jdbc.queryForList("""
                    SELECT p.user_id, p.coins, p.total_xp, p.essence, p.onboarding_step, p.settings->'guide'->>'status' AS guide_status,
                           (p.settings->'guide'->>'step')::int AS guide_step,
                           (SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory i WHERE i.user_id = p.user_id) AS items,
                           (SELECT count(*) FROM public.garden_planting g WHERE g.user_id = p.user_id) AS plantings,
                           (SELECT count(*) FROM public.garden_ledger l WHERE l.user_id = p.user_id) AS ledger_lines,
                           (SELECT count(*) FROM public.garden_pest x WHERE x.user_id = p.user_id) AS pests
                      FROM public.garden_profile p ORDER BY p.user_id""");
        }

        @GetMapping("/fixture/garden/integrity") Map<String, Object> integrity() {
            return Map.of("ledgerBalanceMismatches", env.jdbc.queryForObject("""
                    SELECT count(*) FROM garden_profile p WHERE p.user_id=9001 AND (
                      p.coins <> (SELECT coalesce(sum(delta),0) FROM garden_ledger WHERE user_id=p.user_id AND asset='COIN')
                      OR p.total_xp <> (SELECT coalesce(sum(delta),0) FROM garden_ledger WHERE user_id=p.user_id AND asset='XP'))
                    """, Long.class));
        }
    }

    @Test void serve() throws Exception {
        // -Dgarden.fixture.target=85 serves the Phase 3D rules, 86 adds the Phase 3E cosmetic catalogue; the default (84)
        // keeps the Phase 3C acceptance fixture
        String target = System.getProperty("garden.fixture.target", "84");
        try (var fixture = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z"), target)) {
            env = fixture;
            // GardenTestEnv already migrated to the target; nothing is left to apply
            assertEquals(0, Flyway.configure().dataSource(env.ds).schemas("exams").defaultSchema("exams")
                    .locations("classpath:db/migration/exams").target(target).load().migrate().migrationsExecuted);
            // the Writing module's completion records, as the WRITING learning source reads them (disposable DB only)
            env.jdbc.execute("""
                    CREATE TABLE public.writing_submissions(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id),
                        session_id VARCHAR(64), word_count INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE public.writing_assessments(id BIGSERIAL PRIMARY KEY, submission_id BIGINT NOT NULL
                        REFERENCES public.writing_submissions(id), status VARCHAR(20) NOT NULL, completed_at TIMESTAMPTZ);
                    """);
            // Phase 3G: the two other fixture players are real garden players too (the browser still signs in as 9001 only)
            env.props.setAllowlistUserIds(Integer.parseInt(target) >= 90 ? List.of(9001L, 9002L, 9003L, 9004L, 9005L)
                    : Integer.parseInt(target) >= 88 ? List.of(9001L, 9002L, 9003L) : List.of(9001L));
            fixtureCheckout = null;
            fixtureCosmetics = null;
            if (Integer.parseInt(target) >= 87) {
                env.props.setCosmeticCheckoutEnabled(true);
                fixtureCheckout = new CosmeticCheckoutService(env.ctx, env.access, env.setup, env.props, env.cosmeticRepo, env.commerce, env.rewardRepo,
                        env.collection, java.util.Optional.of(new FixtureGateway()), GardenTestEnv::requireAdmin);
                fixtureCosmetics = new CosmeticService(env.ctx, env.access, env.setup, env.ledgerService, env.cosmeticRepo, env.collection,
                        new com.englishcoach.garden.infra.MonumentRepository(env.jdbc), new com.englishcoach.garden.infra.EstateRepository(env.jdbc),
                        new com.englishcoach.garden.infra.KnowledgeRepository(env.jdbc), env.props, fixtureCheckout, env.commerce);
            }
            env.jdbc.update("INSERT INTO public.users VALUES (9001),(9002)");
            // the guide's journey: three more learners who never opened the garden
            if (Integer.parseInt(target) >= 90) {
                env.jdbc.update("INSERT INTO public.users(id, name) VALUES (9003, 'Lan Mới Đến'), (9004, 'Người Chơi Cũ'), (9005, 'Bạn Mới') ON CONFLICT (id) DO NOTHING");
            }
            env.state.state(9001);
            env.ctx.read(9001, now -> {
                var ledger = new LedgerService(env.ctx);
                UUID key = UUID.randomUUID();
                ledger.addXp(9001, 30000, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                ledger.addCoins(9001, 120000, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                for (String code : env.jdbc.queryForList("SELECT code FROM garden_crop_def WHERE code <> 'QA_SPROUT'", String.class)) {
                    ledger.addItem(9001, "CROP:" + code, "NORMAL", 80, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                    ledger.addItem(9001, "CROP:" + code, "GOOD", 80, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                }
                ledger.addItem(9001, "WATER", "NA", 5, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                ledger.addItem(9001, "FERTILIZER", "NA", 2, "BROWSER_FIXTURE", "FIXTURE", "synthetic", key, now);
                return null;
            });
            try (var app = new SpringApplicationBuilder(Fixture.class).properties(Map.of(
                    "server.address", "127.0.0.1", "server.port", "8991", "spring.flyway.enabled", "false",
                    "logging.level.root", "WARN")).run("--spring.config.location=optional:classpath:/garden-fixture-empty.properties")) {
                System.out.println("GARDEN_BROWSER_READY localhost:8991; disposable PG17; synthetic balances; clock advance only in fixture");
                long until = System.nanoTime() + Duration.ofMinutes(45).toNanos();
                while (System.nanoTime() < until && !Files.exists(Path.of("target/garden-phase4-stop"))) Thread.sleep(1000);
                assertNotNull(app.getBean(GardenController.class));
            }
        } finally { env = null; }
    }
}
