package com.englishcoach.garden;

import com.englishcoach.garden.application.CollectionService;
import com.englishcoach.garden.application.ContributionService;
import com.englishcoach.garden.application.CosmeticCheckoutService;
import com.englishcoach.garden.application.CosmeticService;
import com.englishcoach.garden.application.EstateService;
import com.englishcoach.garden.application.FarmEconomyService;
import com.englishcoach.garden.application.FarmingService;
import com.englishcoach.garden.application.GardenAccessService;
import com.englishcoach.garden.application.GardenContext;
import com.englishcoach.garden.application.GardenSetup;
import com.englishcoach.garden.application.GardenStateService;
import com.englishcoach.garden.application.GardenViews;
import com.englishcoach.garden.application.HarvestService;
import com.englishcoach.garden.application.KnowledgeService;
import com.englishcoach.garden.application.LearningIngestService;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.application.LivingService;
import com.englishcoach.garden.application.MonumentService;
import com.englishcoach.garden.application.PestService;
import com.englishcoach.garden.application.PlantingService;
import com.englishcoach.garden.application.SellService;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.infra.CollectionRepository;
import com.englishcoach.garden.infra.CosmeticRepository;
import com.englishcoach.garden.infra.EconomyRepository;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.FarmingRepository;
import com.englishcoach.garden.infra.GardenRepository;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.LearningSourceRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import com.englishcoach.garden.infra.PestRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.PostgreSQLContainer;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Real PostgreSQL 17 + the real migrations after V76 (Garden V77 / V78 / V80 / V82 / V83 / V84 and Echo Quiz Rush V79 / V81,
 * which share the single Flyway stream; baseline at V76, canonical location) and every Garden
 * service wired exactly like Spring wires them. The pre-V77 fixture creates only the columns Garden reads from other
 * modules (users, review log, dictionary, flashcards + decks, and the Phase 2 learning-source tables).
 */
final class GardenTestEnv implements AutoCloseable {

    static final class MutableClock extends Clock {
        volatile Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration d) {
            now = now.plus(d);
        }

        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    /** Set before construction: the pool then reaches PostgreSQL through a {@link WireProxy} that counts round trips. */
    static volatile boolean throughWire;
    final WireProxy wire;
    final PostgreSQLContainer<?> postgres;
    final HikariDataSource ds;
    final JdbcTemplate jdbc;
    final MutableClock clock;
    final GardenProperties props;
    final GardenContext ctx;
    final GardenStateService state;
    final PlantingService planting;
    final HarvestService harvest;
    final SellService sell;
    final KnowledgeService knowledge;
    final PestService pests;
    final LearningIngestService ingest;
    final FarmEconomyService economy;
    final MonumentService monument;
    final CollectionService collection;
    final ContributionService contribution;
    final EstateService estate;
    final FarmingService farming;
    final FarmingRepository farmingRepo;
    final CosmeticService cosmetics;
    final CosmeticCheckoutService checkout;
    final CosmeticRepository cosmeticRepo;
    final com.englishcoach.garden.infra.CommerceRepository commerce;
    final com.englishcoach.garden.infra.RewardRepository rewardRepo;
    final com.englishcoach.premium.voucher.AiVoucherProperties voucherProps;
    final com.englishcoach.premium.voucher.AiVoucherService vouchers;
    final com.englishcoach.premium.promo.PromoPremiumService promo;
    final com.englishcoach.avatarframe.service.GardenFrameCatalog frameCatalog;
    final com.englishcoach.garden.application.GardenFrameFacts frameFacts;
    final com.englishcoach.garden.application.EchoRewardService echoRewards;
    final LedgerService ledgerService;
    /** A take notice as the garden handed it to the notification centre (Phase 3G). */
    record Notice(long ownerId, String dedupeKey, String title, String body, String actionUrl) {}
    final java.util.List<Notice> notices = new java.util.concurrent.CopyOnWriteArrayList<>();
    final com.englishcoach.garden.infra.SocialRepository socialRepo;
    final com.englishcoach.garden.application.HarvestShares shares;
    final com.englishcoach.garden.application.SocialService social;
    final com.englishcoach.garden.infra.AnimalRepository animalRepo;
    final com.englishcoach.garden.application.GuardianWatch guardians;
    final com.englishcoach.garden.application.AnimalService animals;
    /** Phase 4: the official administrator's QA access; only {@link #ADMIN} passes its identity check. */
    final com.englishcoach.garden.application.GardenAdminQaService adminQa;
    /** The one id the test wiring accepts as the official administrator. */
    static final long ADMIN = 999_999L;
    final GardenAccessService access;
    final GardenSetup setup;
    final ObjectMapper json;

    /**
     * The Phase 1-3C qualification database: the V84 schema WITHOUT the V85 rules, so every earlier Garden test keeps
     * asserting the rules it was written for (the backend runs the Phase 3C behaviour on it).
     */
    GardenTestEnv(Instant start) {
        this(start, "84");
    }

    /**
     * {@code target}: the last migration applied ("84" = Phase 3C rules on the new schema, "85" = Phase 3D rules,
     * "86" = Phase 3E cosmetics on top of them).
     */
    GardenTestEnv(Instant start, String target) {
        this(null, start, target);
    }

    /**
     * {@code base} null: a fresh database. Otherwise the SAME database as {@code base}, migrated further to
     * {@code target} with freshly loaded rules — what a release upgrade does to a garden that already has plantings.
     */
    GardenTestEnv(GardenTestEnv base, Instant start, String target) {
        boolean fresh = base == null;
        if (fresh) {
            // pg_stat_statements is preloaded so a measurement test can count the statements of one request
            // (GardenStatementBudgetTest); it changes nothing for the other tests
            postgres = new PostgreSQLContainer<>("postgres:17").withCommand("postgres", "-c", "fsync=off",
                    "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all");
            postgres.start();
            HikariConfig hc = new HikariConfig();
            String url = postgres.getJdbcUrl();
            if (throughWire) {
                try {
                    wire = new WireProxy(postgres.getHost(), postgres.getMappedPort(5432));
                } catch (java.io.IOException e) {
                    throw new IllegalStateException(e);
                }
                url = url.replace(postgres.getHost() + ":" + postgres.getMappedPort(5432), "127.0.0.1:" + wire.port());
            } else {
                wire = null;
            }
            hc.setJdbcUrl(url);
            hc.setUsername(postgres.getUsername());
            hc.setPassword(postgres.getPassword());
            hc.setMaximumPoolSize(12);
            ds = new HikariDataSource(hc);
        } else {
            postgres = base.postgres;
            ds = base.ds;
            wire = base.wire;
        }
        jdbc = new JdbcTemplate(ds);
        if (fresh) jdbc.execute("""
                CREATE TABLE public.users(id BIGINT PRIMARY KEY, name VARCHAR(255), email VARCHAR(255),
                    account_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE');
                CREATE TABLE public.user_profiles(user_id BIGINT PRIMARY KEY REFERENCES public.users(id), display_name VARCHAR(100));
                CREATE TABLE public.learning_activity_events(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id),
                    activity_type VARCHAR(64) NOT NULL, source_ref VARCHAR(128) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
                    UNIQUE(user_id, activity_type, source_ref));
                CREATE TABLE public.dictionary_entries(id BIGSERIAL PRIMARY KEY, word VARCHAR(255) UNIQUE NOT NULL, ipa VARCHAR(255),
                    cefr VARCHAR(8), general_translation_vi TEXT, owner_user_id BIGINT);
                CREATE TABLE public.vocab_decks(id BIGSERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL);
                CREATE TABLE public.flashcards(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id),
                    dictionary_entry_id BIGINT NOT NULL REFERENCES public.dictionary_entries(id), status VARCHAR(20) NOT NULL DEFAULT 'NEW',
                    state INTEGER NOT NULL DEFAULT 0, next_review_date TIMESTAMP, review_count INTEGER NOT NULL DEFAULT 0,
                    deck_id BIGINT REFERENCES public.vocab_decks(id), updated_at TIMESTAMP DEFAULT LOCALTIMESTAMP);
                CREATE TABLE public.listening_sessions(id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES public.users(id),
                    started_at TIMESTAMP, ended_at TIMESTAMP);
                CREATE TABLE public.exercise_attempts(id BIGSERIAL PRIMARY KEY, listening_session_id BIGINT NOT NULL
                    REFERENCES public.listening_sessions(id), accuracy_percentage DOUBLE PRECISION);
                CREATE TABLE public.card_blast_runs(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id),
                    score INTEGER NOT NULL DEFAULT 0, accuracy DOUBLE PRECISION NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
                CREATE SCHEMA exams; CREATE TABLE exams.test_baseline(id INT);
                """);
        // Phase 3F (V87) extends modules that exist before V77: the columns and the named constraints it touches, as the
        // real migrations (V36, V37, V51, V55) created them, with frames seeded by explicit id like those migrations did.
        if (fresh) jdbc.execute("""
                CREATE TABLE public.premium_plans(id BIGSERIAL PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(128) NOT NULL,
                    duration_months INT NOT NULL CHECK (duration_months > 0), price_vnd BIGINT NOT NULL CHECK (price_vnd >= 0),
                    display_order INT NOT NULL DEFAULT 0, badge VARCHAR(64), active BOOLEAN NOT NULL DEFAULT true,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
                INSERT INTO public.premium_plans(code, name, duration_months, price_vnd, display_order) VALUES ('PLAN_1_MONTH', 'Gói 1 Tháng', 1, 59000, 1);
                CREATE TABLE public.premium_subscriptions(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
                    plan_id BIGINT NOT NULL REFERENCES public.premium_plans(id) ON DELETE RESTRICT, starts_at TIMESTAMPTZ NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', source VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT chk_premium_subscriptions_status CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
                    CONSTRAINT chk_premium_subscriptions_dates CHECK (expires_at > starts_at));
                CREATE TABLE public.payment_transactions(id BIGSERIAL PRIMARY KEY, provider_transaction_id VARCHAR(128) NOT NULL UNIQUE);
                CREATE TABLE public.avatar_frame_series(id BIGSERIAL PRIMARY KEY, slug VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL,
                    lineage VARCHAR(32) NOT NULL, description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT ck_avatar_frame_series_lineage CHECK (lineage IN ('ACHIEVEMENT', 'RANKED', 'STANDARD', 'LEGACY', 'SEASONAL', 'EVENT', 'PREMIUM')));
                CREATE TABLE public.avatar_frames(id BIGSERIAL PRIMARY KEY, series_id BIGINT NOT NULL REFERENCES public.avatar_frame_series(id) ON DELETE RESTRICT,
                    slug VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL, tier VARCHAR(16) NOT NULL, render_type VARCHAR(32) NOT NULL,
                    poster_asset VARCHAR(255) NOT NULL, preview_asset VARCHAR(255) NOT NULL, manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    unlock_type VARCHAR(32) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT ck_avatar_frames_tier CHECK (tier IN ('D', 'C', 'B', 'A', 'S', 'SS', 'SSS')),
                    CONSTRAINT ck_avatar_frames_render_type CHECK (render_type IN ('STATIC_SVG', 'CSS_ANIMATED')),
                    CONSTRAINT ck_avatar_frames_unlock_type CHECK (unlock_type IN ('METRIC_THRESHOLD', 'RANK_REWARD', 'PREMIUM_SUBSCRIPTION', 'EVENT_PARTICIPATION', 'ADMIN_GRANT', 'LEGACY_DATE')));
                CREATE TABLE public.avatar_frame_requirements(id BIGSERIAL PRIMARY KEY, frame_id BIGINT NOT NULL REFERENCES public.avatar_frames(id) ON DELETE CASCADE,
                    metric_type VARCHAR(64) NOT NULL, operator VARCHAR(16) NOT NULL, target_value VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT ck_avatar_frame_req_operator CHECK (operator IN ('GTE', 'LTE', 'EQUALS')));
                CREATE TABLE public.user_avatar_frames(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
                    frame_id BIGINT NOT NULL REFERENCES public.avatar_frames(id) ON DELETE RESTRICT, unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    expires_at TIMESTAMPTZ, source VARCHAR(32) NOT NULL, is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT uq_user_avatar_frames_user_frame UNIQUE (user_id, frame_id),
                    CONSTRAINT ck_user_avatar_frames_source CHECK (source IN ('ACHIEVEMENT', 'RANK', 'EVENT', 'SEASONAL', 'PREMIUM', 'ADMIN_GRANT', 'LEGACY')));
                CREATE UNIQUE INDEX idx_user_avatar_frames_single_equipped ON public.user_avatar_frames(user_id) WHERE is_equipped = TRUE;
                INSERT INTO public.avatar_frame_series(id, slug, name, lineage) VALUES (8, 'seasons', 'Four Seasons', 'SEASONAL');
                INSERT INTO public.avatar_frames(id, series_id, slug, name, tier, render_type, poster_asset, preview_asset, unlock_type)
                    VALUES (23, 8, 'season_spring', 'Xuân Sinh Mệnh', 'S', 'CSS_ANIMATED', '/assets/frames/season_spring.svg', '/assets/frames/season_spring.svg', 'METRIC_THRESHOLD');
                INSERT INTO public.avatar_frame_requirements(frame_id, metric_type, operator, target_value) VALUES (23, 'VOCAB_MASTERED', 'GTE', '300');
                """);
        String[][] words = {{"agree", "Đồng ý, tán thành"}, {"arrive", "Đến, tới nơi"}, {"boat", "Tàu thuyền"},
                {"breakfast", "Bữa ăn sáng"}, {"camera", "Máy ảnh"}, {"river", "Dòng sông"}, {"window", "Cửa sổ"},
                {"teacher", "Giáo viên"}, {"garden", "Khu vườn"}, {"market", "Chợ"}, {"bridge", "Cây cầu"}, {"cloud", "Đám mây"}};
        if (fresh) for (String[] w : words) jdbc.update("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A1', ?)", w[0], w[1]);
        var flyway = Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams")
                .locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("76").target(target).load();
        int from = fresh ? 76 : Integer.parseInt(flyway.info().current().getVersion().toString());
        assertEquals(Integer.parseInt(target) - from, flyway.migrate().migrationsExecuted,
                "V77 + V78 + V79 (Echo Quiz Rush) + V80 + V81 (Echo Quiz Rush) + V82 + V83 + V84 (+ V85, + V86)");
        assertEquals(target, flyway.info().current().getVersion().toString());
        assertEquals(0, flyway.migrate().migrationsExecuted, "re-running is a no-op");

        json = JsonMapper.builder().findAndAddModules().build();
        clock = new MutableClock(start);
        props = new GardenProperties();
        props.setEnabled(true);
        var repo = new GardenRepository(jdbc);
        ctx = new GardenContext(repo, new DataSourceTransactionManager(ds), json, clock);
        access = new GardenAccessService(props);
        var ledger = new LedgerService(ctx);
        setup = new GardenSetup(ctx, ledger);
        ingest = new LearningIngestService(ctx, ledger, new LearningSourceRepository(jdbc));
        var pestRepo = new PestRepository(jdbc);
        var knowledgeRepo = new KnowledgeRepository(jdbc);
        farmingRepo = new FarmingRepository(jdbc);
        // Phase 3H: guardian pets are read by the pest planner and the take; neutral below V89
        animalRepo = new com.englishcoach.garden.infra.AnimalRepository(jdbc);
        guardians = new com.englishcoach.garden.application.GuardianWatch(ctx, animalRepo);
        pests = new PestService(ctx, access, setup, ledger, pestRepo, knowledgeRepo, ingest, farmingRepo, guardians);
        knowledge = new KnowledgeService(ctx, access, setup, ledger, knowledgeRepo, pestRepo, pests, ingest);
        var views = new GardenViews(ctx, pestRepo, knowledge, farmingRepo);
        economy = new FarmEconomyService(ctx, access, setup, ledger, ingest, views, new EconomyRepository(jdbc));
        var monumentRepo = new MonumentRepository(jdbc);
        monument = new MonumentService(ctx, access, setup, monumentRepo, knowledgeRepo, new LearningSourceRepository(jdbc));
        var collectionRepo = new CollectionRepository(jdbc);
        collection = new CollectionService(ctx, access, setup, ledger, collectionRepo, monumentRepo);
        var estateRepo = new EstateRepository(jdbc);
        contribution = new ContributionService(ctx, access, setup, props, estateRepo, collectionRepo, monumentRepo, collection);
        estate = new EstateService(ctx, access, setup, ledger, ingest, views, estateRepo, new EconomyRepository(jdbc), monumentRepo,
                collection, contribution, economy);
        farming = new FarmingService(ctx, access, setup, ledger, views, farmingRepo, pestRepo, collectionRepo);
        // Phase 3E: no payment gateway is wired, exactly like production (direct purchase stays closed)
        cosmeticRepo = new CosmeticRepository(jdbc);
        commerce = new com.englishcoach.garden.infra.CommerceRepository(jdbc);
        rewardRepo = new com.englishcoach.garden.infra.RewardRepository(jdbc, json);
        ledgerService = ledger;
        checkout = new CosmeticCheckoutService(ctx, access, setup, props, cosmeticRepo, commerce, rewardRepo, collection,
                java.util.Optional.empty(), GardenTestEnv::requireAdmin);
        cosmetics = new CosmeticService(ctx, access, setup, ledger, cosmeticRepo, collection, monumentRepo, estateRepo, knowledgeRepo, props,
                checkout, commerce);
        // Phase 3F: the owning modules' services on the same database and clock (their tables exist from V87 on)
        voucherProps = new com.englishcoach.premium.voucher.AiVoucherProperties();
        vouchers = new com.englishcoach.premium.voucher.AiVoucherService(jdbc, new DataSourceTransactionManager(ds), voucherProps, clock);
        promo = new com.englishcoach.premium.promo.PromoPremiumService(jdbc);
        frameCatalog = new com.englishcoach.avatarframe.service.GardenFrameCatalog(jdbc);
        frameFacts = new com.englishcoach.garden.application.GardenFrameFacts(access, props, monumentRepo, estateRepo, knowledgeRepo);
        echoRewards = new com.englishcoach.garden.application.EchoRewardService(ctx, access, setup, ledger, props, rewardRepo, promo, vouchers,
                frameCatalog, frameFacts);
        animals = new com.englishcoach.garden.application.AnimalService(ctx, access, setup, ledger, ingest, animalRepo, new EconomyRepository(jdbc));
        adminQa = new com.englishcoach.garden.application.GardenAdminQaService(ctx, access, setup, ledger, ingest,
                new com.englishcoach.garden.infra.AdminQaRepository(jdbc), animalRepo, cosmetics, animals, id -> id == ADMIN);
        // Phase 3G: the social islands on the same database and clock; notices are recorded instead of sent
        socialRepo = new com.englishcoach.garden.infra.SocialRepository(jdbc);
        shares = new com.englishcoach.garden.application.HarvestShares(ctx, ledger, socialRepo);
        social = new com.englishcoach.garden.application.SocialService(ctx, access, setup, ledger, views, socialRepo, knowledgeRepo,
                monumentRepo, cosmetics, shares, props,
                (ownerId, dedupeKey, title, body, actionUrl) -> notices.add(new Notice(ownerId, dedupeKey, title, body, actionUrl)),
                guardians, animals);
        state = new GardenStateService(ctx, access, setup, ingest, views, pests, economy, monument, collection,
                new LivingService(ctx, monument, collection), contribution, estate, farming, cosmetics, social, animals);
        planting = new PlantingService(ctx, access, setup, ledger, views, collection);
        harvest = new HarvestService(ctx, access, setup, ledger, views, ingest, pests, pestRepo, collection, farmingRepo, shares);
        sell = new SellService(ctx, access, setup, ledger, ingest);
    }

    static void requireAdmin(long userId) {
        if (userId != ADMIN) throw new com.englishcoach.garden.api.GardenException(403, "ADMIN_REQUIRED");
    }

    @Override
    public void close() {
        ds.close();
        if (wire != null) wire.close();
        postgres.stop();
    }
}
