package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenDtos.Ack;
import com.englishcoach.garden.api.GardenDtos.GuideAck;
import com.englishcoach.garden.api.GardenDtos.GuideRequest;
import com.englishcoach.garden.domain.GuideEngine;
import com.englishcoach.garden.api.GardenDtos.OnboardingRequest;
import com.englishcoach.garden.api.GardenDtos.State;
import org.springframework.stereotype.Service;

import com.englishcoach.garden.infra.GardenScope;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;
import java.util.UUID;

/**
 * {@code GET /state}: access check → collect skill lessons (outside the transaction) → load or create the garden →
 * ingest learning and rewards → reconcile Forgotten Pests → materialize the current period's delivery orders (Phase 3A)
 * → fold verified learning into the monument (Phase 3B; a record, never a reward) → credit Echo Contribution for stored
 * facts (Phase 3C; once per fact, capped) → compute every planting and tree
 * on read → record the visit → return the DTO. Repeated reads change no economic
 * state except rewarding newly found learning exactly once (an order, once materialized, is frozen).
 */
@Service
public class GardenStateService {

    /** Upper bound of prefetch exchanges of one state read; a round with nothing left to read ends it earlier. */
    private static final int PREFETCH_ROUNDS = 8;

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LearningIngestService ingest;
    private final GardenViews views;
    private final PestService pests;
    private final FarmEconomyService economy;
    private final MonumentService monument;
    private final CollectionService collection;
    private final LivingService living;
    private final ContributionService contribution;
    private final EstateService estate;
    private final FarmingService farming;
    private final CosmeticService cosmetics;
    private final SocialService social;
    private final AnimalService animals;

    public GardenStateService(GardenContext ctx, GardenAccessService access, GardenSetup setup,
                              LearningIngestService ingest, GardenViews views, PestService pests,
                              FarmEconomyService economy, MonumentService monument, CollectionService collection,
                              LivingService living, ContributionService contribution, EstateService estate,
                              FarmingService farming, CosmeticService cosmetics, SocialService social, AnimalService animals) {
        this.social = social;
        this.animals = animals;
        this.farming = farming;
        this.cosmetics = cosmetics;
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ingest = ingest;
        this.views = views;
        this.pests = pests;
        this.economy = economy;
        this.monument = monument;
        this.collection = collection;
        this.living = living;
        this.contribution = contribution;
        this.estate = estate;
    }

    public State state(long userId) {
        access.require(userId);
        // one bulkhead slot for the whole read: the collection below borrows a connection too
        return ctx.slot(() -> read(userId));
    }

    private State read(long userId) {
        ctx.warm();
        // Read only, fault-isolated, BEFORE the garden transaction: skill lessons from other modules, verified learning
        // days for the monument (Phase 3B) and the player's public name (Phase 3G). They share one memo of their own, so
        // the profile and the cursors are read once for all three; it ends here and is never seen by the transaction.
        record Pre(java.util.List<LearningIngestService.Activity> lessons, MonumentService.Collected verified, String publicName) {}
        Pre pre = com.englishcoach.garden.infra.GardenScope.within(() -> {
            Instant at = ctx.now();
            // Phase 5: what the three collectors read first, then what they read next, each time in one exchange
            GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> ctx.repo.cursors(userId), () -> monument.row(userId),
                    () -> social.collectName(userId));
            GardenScope.prefetch(2, () -> ingest.collect(userId, at), () -> monument.collect(userId, at));
            return new Pre(ingest.collect(userId, at), monument.collect(userId, at), social.collectName(userId));
        });
        var lessons = pre.lessons();
        var verified = pre.verified();
        String publicName = pre.publicName();
        boolean qa = access.qa(userId);
        // Phase 5: what needs nothing but the user travels with the lock itself
        Runnable[] entry = {() -> ctx.repo.profile(userId), () -> ctx.repo.cursors(userId), () -> ctx.repo.plots(userId),
                () -> ctx.repo.activePlantings(userId), () -> ctx.repo.inventory(userId), () -> ctx.repo.buildingLevels(userId),
                () -> ctx.repo.essence(userId), () -> ctx.repo.countPlantings(userId), () -> ctx.repo.dueCount(userId),
                () -> monument.row(userId),
                () -> cosmetics.stateView(userId)};
        return ctx.read(userId, entry, now -> {
            // Phase 5: every step below reads the database before it decides anything. Each is run as a probe first
            // (GardenJdbc: a probe executes nothing, it only says what it would read next), so the reads of ALL steps
            // travel together, round by round, instead of one network exchange per statement.
            GardenScope.prefetch(PREFETCH_ROUNDS,
                    () -> ingest.ingest(userId, ctx.repo.profile(userId), now, lessons),
                    () -> pests.reconcile(userId, now),
                    () -> economy.materialize(userId, now),
                    () -> monument.reconcile(userId, now, verified),
                    () -> collection.ensureSeeded(userId, now),
                    () -> contribution.reconcile(userId, now),
                    () -> ingest.blessing(userId, now),
                    () -> economy.view(userId, now, false),
                    () -> views.state(userId, now, qa, false, null),
                    () -> monument.view(userId, now, 0),
                    () -> collection.view(userId, now, qa),
                    () -> estate.view(userId, now),
                    () -> farming.view(userId, now),
                    () -> cosmetics.stateView(userId),
                    () -> social.reconcile(userId, now, publicName),
                    () -> animals.view(userId, now, false));
            var profile = setup.ensure(userId, now);
            ingest.ingest(userId, profile, now, lessons);
            pests.reconcile(userId, now);
            economy.materialize(userId, now);
            monument.reconcile(userId, now, verified);
            collection.ensureSeeded(userId, now);
            // Phase 3C: credit stored facts (verified days, graduations, milestones, deliveries) that have no entry yet
            contribution.reconcile(userId, now);
            LocalDate today = ctx.engine().calendar().dayKey(now);
            boolean firstOpenToday = profile.lastVisitAt() == null || !ctx.engine().calendar().dayKey(profile.lastVisitAt()).equals(today);
            boolean blessing = ingest.blessing(userId, now);
            var state = views.state(userId, now, qa, blessing, economy.view(userId, now, blessing));
            state = state.withLiving(living.view(userId, now, qa, state)).withEstate(estate.view(userId, now))
                    .withFarming(farming.view(userId, now)).withCosmetics(cosmetics.stateView(userId))
                    // Phase 3G: the garden's social profile (created once), unread island activity, crops taken from
                    .withSocial(social.reconcile(userId, now, publicName))
                    // Phase 3H: houses, livestock and guardian pets, projected to now (a read stores nothing)
                    .withAnimals(animals.view(userId, now, blessing));
            // the visit is recorded last: nothing of the state depends on it, and it leaves with the other late writes
            if (firstOpenToday) ctx.repo.log(userId, "OPEN", ctx.write(Map.of("day", today.toString())), now);
            ctx.repo.touchVisit(userId, now);
            return state;
        });
    }

    public Ack onboarding(long userId, UUID key, OnboardingRequest request) {
        access.require(userId);
        return ctx.command(userId, key, "ONBOARDING", request, Ack.class, setup.ensurer(userId), (now, op) -> {
            ctx.repo.advanceOnboarding(userId, request.step());
            ctx.repo.log(userId, "ONBOARDING_STEP", ctx.write(Map.of("step", request.step())), now);
            return new Ack(true, ctx.repo.profile(userId).onboardingStep());
        });
    }

    /**
     * The voluntary guide: one decision or one step of the player's own garden. The new record is decided from the
     * stored one under the garden lock ({@link GuideEngine}); only {@code settings.guide} and the floor of the old
     * tutorial step are written, never a coin, an XP point, a crop or a learning fact.
     */
    public GuideAck guide(long userId, UUID key, GuideRequest request) {
        access.require(userId);
        return ctx.command(userId, key, "GUIDE", request, GuideAck.class, setup.ensurer(userId), (now, op) -> {
            var before = views.guide(ctx.repo.profile(userId));
            var outcome = GuideEngine.apply(before, GuideEngine.Action.valueOf(request.action()), request.step());
            var g = outcome.guide();
            var stored = new java.util.LinkedHashMap<String, Object>();
            stored.put("status", g.status() == null ? null : g.status().name());
            stored.put("step", g.step());
            stored.put("version", GuideEngine.VERSION);
            stored.put("updatedAt", now.toString());
            ctx.repo.saveGuide(userId, ctx.write(stored), outcome.onboardingFloor());
            ctx.repo.log(userId, "GUIDE", ctx.write(Map.of("action", request.action(), "step", request.step())), now);
            var profile = ctx.repo.profile(userId);
            return new GuideAck(views.guideView(profile, ctx.repo.countPlantings(userId)), profile.onboardingStep());
        });
    }

    public Ack rewardsSeen(long userId, UUID key) {
        access.require(userId);
        return ctx.command(userId, key, "REWARDS_SEEN", Map.of(), Ack.class, setup.ensurer(userId), (now, op) -> {
            ctx.repo.markRewardsSeen(userId, now);
            ctx.repo.log(userId, "REWARD_BASKET_VIEW", "{}", now);
            return new Ack(true, ctx.repo.profile(userId).onboardingStep());
        });
    }

}
