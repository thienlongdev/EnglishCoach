package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.ContributionEntryView;
import com.englishcoach.garden.api.GardenDtos.ContributionPage;
import com.englishcoach.garden.api.GardenDtos.ContributionView;
import com.englishcoach.garden.api.GardenDtos.RedemptionView;
import com.englishcoach.garden.api.GardenDtos.RequirementView;
import com.englishcoach.garden.api.GardenDtos.RewardReceipt;
import com.englishcoach.garden.api.GardenDtos.RewardShopView;
import com.englishcoach.garden.api.GardenDtos.RewardView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.domain.EstateRules;
import com.englishcoach.garden.infra.CollectionRepository;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.EstateRepository.Entry;
import com.englishcoach.garden.infra.EstateRepository.Fact;
import com.englishcoach.garden.infra.EstateRepository.RewardDef;
import com.englishcoach.garden.infra.MonumentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Echo Contribution and Echo Rewards (Phase 3C, blueprint §8.2).
 *
 * <ul>
 *   <li><b>Contribution</b> is derived on {@code GET /state}, inside the owner's advisory-lock transaction, ONLY from
 *   facts the garden already stored: verified learning days (the monument's day table), graduated trees the monument
 *   credited, delivered weekly orders, permanent milestones and completed regions / buildings. There is no endpoint
 *   that earns points and the client supplies nothing. Each fact is one row of an append-only table with a unique
 *   (player, source, reference): replaying a read, a second device or an old fact can never credit twice. Repeatable
 *   sources are cut by day / week / month caps evaluated on the Vietnam day the fact happened.</li>
 *   <li><b>Rewards</b>: the catalogue is configuration. A redemption needs the reward counter to be open (kill switch),
 *   the reward to be enabled AND to have a real delivery mechanism, the player's eligibility, the per-player limit, the
 *   global stock and the balance — all checked and applied in ONE transaction with an idempotency receipt, a
 *   redemption row and a negative ledger entry. The only delivery that exists is the in-garden cultivar; Premium, AI
 *   quota and avatar frames have none, so those rewards can never be redeemed from here.</li>
 * </ul>
 * Contribution is a record, not a currency: it buys nothing in the farm and is never converted to or from coins.
 */
@Service
public class ContributionService {

    /** Delivery mechanisms that exist in this code base. Anything else fails closed. */
    static final Set<String> DELIVERIES = Set.of("GARDEN_SKIN");

    private static final List<String> MILESTONE_KINDS = List.of("ERA", "BRANCH", "MEMORY", "RING", "MASTERY");

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final GardenProperties properties;
    private final EstateRepository repo;
    private final CollectionRepository skins;
    private final MonumentRepository monument;
    private final CollectionService collection;

    public ContributionService(GardenContext ctx, GardenAccessService access, GardenSetup setup, GardenProperties properties,
                               EstateRepository repo, CollectionRepository skins, MonumentRepository monument,
                               CollectionService collection) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.properties = properties;
        this.repo = repo;
        this.skins = skins;
        this.monument = monument;
        this.collection = collection;
    }

    // ------------------------------------------------------------------ earning (state read only)

    /**
     * Credits every stored fact that has no entry yet (bounded per read). Run after the monument and the mastery were
     * reconciled, inside the caller's locked transaction. Repeating it with the same facts changes nothing.
     */
    public void reconcile(long userId, Instant now) {
        var rules = ctx.estate().rules();
        int limit = rules.contribution().scanLimit();
        var calendar = ctx.engine().calendar();
        // Phase 5: every "is there something to credit" question in one exchange (on an ordinary read there is nothing)
        List<Runnable> questions = new ArrayList<>(List.of(() -> repo.ensureAccount(userId, now), () -> repo.uncreditedDays(userId, limit),
                () -> repo.uncreditedBreadthDays(userId, limit), () -> repo.uncreditedGraduations(userId, limit),
                () -> repo.uncreditedWeeklyOrders(userId, limit), () -> repo.uncreditedMilestones(userId, MILESTONE_KINDS, limit),
                () -> ctx.repo.plots(userId), () -> ctx.repo.buildingLevels(userId)));
        for (EstateRules.Region r : rules.land().regions()) {
            questions.add(() -> {
                Set<Integer> mine = ctx.repo.plots(userId).stream().map(p -> p.slot()).collect(Collectors.toSet());
                if (r.plots().stream().allMatch(p -> mine.contains(p.slot()))) repo.hasEntry(userId, "LAND_REGION", r.code());
            });
        }
        for (EstateRules.Building b : rules.buildings().values()) {
            questions.add(() -> {
                if (ctx.repo.buildingLevels(userId).getOrDefault(b.code(), 0) >= b.maxLevel() && b.maxLevel() > 0) {
                    repo.hasEntry(userId, "BUILDING_MAX", b.code());
                }
            });
        }
        GardenScope.prefetch(2, questions.toArray(Runnable[]::new));
        repo.ensureAccount(userId, now);
        for (Fact f : repo.uncreditedDays(userId, limit)) credit(userId, "LEARNING_DAY", f, LocalDate.parse(f.ref()), now);
        for (Fact f : repo.uncreditedBreadthDays(userId, limit)) credit(userId, "BREADTH_DAY", f, LocalDate.parse(f.ref()), now);
        for (Fact f : repo.uncreditedGraduations(userId, limit)) credit(userId, "GRADUATION", f, calendar.dayKey(f.at()), now);
        for (Fact f : repo.uncreditedWeeklyOrders(userId, limit)) credit(userId, "WEEKLY_ORDER", f, calendar.dayKey(f.at()), now);
        for (var byKind : repo.uncreditedMilestones(userId, MILESTONE_KINDS, limit).entrySet()) {
            for (Fact f : byKind.getValue()) credit(userId, byKind.getKey(), f, calendar.dayKey(f.at()), now);
        }
        // farm achievements: a region whose every bed is open, a building at its top level (one-time each)
        Set<Integer> owned = ctx.repo.plots(userId).stream().map(p -> p.slot()).collect(Collectors.toSet());
        for (EstateRules.Region r : rules.land().regions()) {
            if (r.plots().stream().allMatch(p -> owned.contains(p.slot())) && !repo.hasEntry(userId, "LAND_REGION", r.code())) {
                credit(userId, "LAND_REGION", new Fact(r.code(), 1, now), calendar.dayKey(now), now);
            }
        }
        Map<String, Integer> levels = ctx.repo.buildingLevels(userId);
        for (EstateRules.Building b : rules.buildings().values()) {
            if (levels.getOrDefault(b.code(), 0) >= b.maxLevel() && b.maxLevel() > 0 && !repo.hasEntry(userId, "BUILDING_MAX", b.code())) {
                credit(userId, "BUILDING_MAX", new Fact(b.code(), 1, now), calendar.dayKey(now), now);
            }
        }
    }

    private void credit(long userId, String source, Fact fact, LocalDate day, Instant now) {
        var engine = ctx.estate();
        var src = engine.rules().contribution().sources().get(source);
        if (src == null) return;
        int nominal = engine.nominal(source, fact.tier());
        int granted = nominal;
        if (src.capped() && nominal > 0) {
            LocalDate week = day.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
            LocalDate month = day.withDayOfMonth(1);
            granted = engine.granted(source, nominal, repo.cappedPoints(userId, day, day.plusDays(1)),
                    repo.cappedPoints(userId, week, week.plusDays(7)), repo.cappedPoints(userId, month, month.plusMonths(1)));
        }
        if (repo.insertEntry(userId, source, fact.ref(), granted, nominal, src.capped(), day, now) != null) {
            repo.addEarned(userId, granted, now);
        }
    }

    // ------------------------------------------------------------------ views

    public ContributionView view(long userId, Instant now) {
        var c = ctx.estate().rules().contribution();
        LocalDate day = ctx.engine().calendar().dayKey(now);
        LocalDate week = day.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        LocalDate month = day.withDayOfMonth(1);
        GardenScope.prefetch(() -> repo.account(userId), () -> repo.entries(userId, null, c.historyLimit() * 2),
                () -> repo.cappedPoints(userId, day, day.plusDays(1)), () -> repo.cappedPoints(userId, week, week.plusDays(7)),
                () -> repo.cappedPoints(userId, month, month.plusMonths(1)));
        var account = repo.account(userId);
        // facts worth nothing by design (a first mastery tier) stay in the table but are not listed
        List<ContributionEntryView> recent = repo.entries(userId, null, c.historyLimit() * 2).stream()
                .filter(e -> e.nominal() != 0).limit(c.historyLimit()).map(ContributionService::entry).toList();
        return new ContributionView(account.balance(), account.earned(), account.spent(),
                repo.cappedPoints(userId, day, day.plusDays(1)), c.dayCap(),
                repo.cappedPoints(userId, week, week.plusDays(7)), c.weekCap(),
                repo.cappedPoints(userId, month, month.plusMonths(1)), c.monthCap(), recent);
    }

    private static ContributionEntryView entry(Entry e) {
        return new ContributionEntryView(e.id(), e.source(), e.sourceRef(), e.points(), e.nominal(), e.day(), e.createdAt());
    }

    /** True when a reward could ever be delivered by this code base: enabled in the catalogue with a known mechanism. */
    static boolean deliverable(RewardDef def) {
        return def.enabled() && DELIVERIES.contains(def.delivery());
    }

    private String skinCodeOf(RewardDef def) {
        try {
            JsonNode n = ctx.json.readTree(def.payload()).get("skinCode");
            return n == null || n.isNull() ? null : n.asText();
        } catch (Exception e) {
            return null;
        }
    }

    private List<RequirementView> requirements(RewardDef def, int balance, int learningDays, int gardenDays) {
        List<RequirementView> out = new ArrayList<>();
        out.add(new RequirementView("CONTRIBUTION", balance, def.cost(), balance >= def.cost()));
        if (def.minLearningDays() > 0) {
            out.add(new RequirementView("LEARNING_DAYS", learningDays, def.minLearningDays(), learningDays >= def.minLearningDays()));
        }
        if (def.minGardenDays() > 0) {
            out.add(new RequirementView("GARDEN_DAYS", gardenDays, def.minGardenDays(), gardenDays >= def.minGardenDays()));
        }
        return out;
    }

    public RewardShopView shop(long userId, Instant now) {
        boolean open = properties.isRewardsEnabled();
        GardenScope.prefetch(() -> repo.account(userId), () -> monument.row(userId), () -> ctx.repo.profile(userId),
                () -> repo.redeemedBy(userId), repo::issued, repo::rewards,
                () -> repo.redemptions(userId, ctx.estate().rules().contribution().historyLimit()));
        var account = repo.account(userId);
        var row = monument.row(userId);
        int learningDays = row == null ? 0 : row.learningDays();
        int gardenDays = (int) Duration.between(ctx.repo.profile(userId).createdAt(), now).toDays();
        Map<String, Integer> mine = repo.redeemedBy(userId);
        Map<String, Integer> issued = repo.issued();
        Map<String, String> names = new LinkedHashMap<>();
        List<RewardView> rewards = new ArrayList<>();
        for (RewardDef def : repo.rewards()) {
            names.put(def.code(), def.nameVi());
            int redeemed = mine.getOrDefault(def.code(), 0);
            if (!deliverable(def)) {
                // planned only: no price is shown for something that cannot be redeemed
                rewards.add(new RewardView(def.code(), def.kind(), def.nameVi(), def.descriptionVi(), null, "UNAVAILABLE",
                        List.of(), redeemed, def.perUserLimit()));
                continue;
            }
            List<RequirementView> reqs = requirements(def, account.balance(), learningDays, gardenDays);
            String skin = "GARDEN_SKIN".equals(def.delivery()) ? skinCodeOf(def) : null;
            String status;
            if (redeemed >= def.perUserLimit() || (skin != null && skins.owns(userId, skin))) status = "OWNED";
            else if (!open) status = "CLOSED";
            else if (def.globalLimit() != null && issued.getOrDefault(def.code(), 0) >= def.globalLimit()) status = "SOLD_OUT";
            else status = reqs.stream().allMatch(RequirementView::met) ? "OPEN" : "LOCKED";
            rewards.add(new RewardView(def.code(), def.kind(), def.nameVi(), def.descriptionVi(), def.cost(), status, reqs,
                    redeemed, def.perUserLimit()));
        }
        List<RedemptionView> history = repo.redemptions(userId, ctx.estate().rules().contribution().historyLimit()).stream()
                .map(r -> new RedemptionView(r.id(), r.rewardCode(), names.getOrDefault(r.rewardCode(), r.rewardCode()), r.cost(),
                        r.status(), r.createdAt())).toList();
        return new RewardShopView(open, rewards, history);
    }

    // ------------------------------------------------------------------ queries / commands

    public ContributionPage history(long userId, Long before) {
        access.require(userId);
        int limit = 20;
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            var rows = repo.entries(userId, before, limit + 1);
            boolean more = rows.size() > limit;
            var page = more ? rows.subList(0, limit) : rows;
            return new ContributionPage(page.stream().map(ContributionService::entry).toList(), more ? page.getLast().id() : null);
        });
    }

    /**
     * "Đổi quà": one redemption, atomic and idempotent. Order of the checks: counter open → catalogue entry deliverable →
     * eligibility → per-player limit → not already delivered → global stock → balance; then the delivery, the
     * redemption row and the ledger entry. Any failure rolls the whole transaction back (nothing is half-redeemed).
     */
    public RewardReceipt redeem(long userId, UUID key, String rewardCode) {
        access.require(userId);
        boolean qa = access.qa(userId);
        return ctx.command(userId, key, "REWARD_REDEEM", Map.of("rewardCode", rewardCode), RewardReceipt.class, setup.ensurer(userId), (now, op) -> {
            if (!properties.isRewardsEnabled()) throw GardenException.conflict("REWARDS_CLOSED");
            RewardDef def = repo.reward(rewardCode);
            if (def == null) throw new GardenException(404, "REWARD_NOT_FOUND");
            if (!deliverable(def)) throw GardenException.conflict("REWARD_UNAVAILABLE");
            repo.ensureAccount(userId, now);
            var row = monument.row(userId);
            int learningDays = row == null ? 0 : row.learningDays();
            int gardenDays = (int) Duration.between(ctx.repo.profile(userId).createdAt(), now).toDays();
            if (learningDays < def.minLearningDays()) {
                throw GardenException.conflict("REWARD_LOCKED", Map.of("reason", "LEARNING_DAYS", "need", def.minLearningDays()));
            }
            if (gardenDays < def.minGardenDays()) {
                throw GardenException.conflict("REWARD_LOCKED", Map.of("reason", "GARDEN_DAYS", "need", def.minGardenDays()));
            }
            if (repo.redeemedBy(userId, def.code()) >= def.perUserLimit()) throw GardenException.conflict("REWARD_LIMIT");
            // the only delivery that exists: an in-garden cultivar (art only)
            String skinCode = skinCodeOf(def);
            var skin = skinCode == null ? null : ctx.living().rules().skin(skinCode);
            if (skin == null || !"REWARD".equals(skin.unlockKind())) throw GardenException.conflict("REWARD_UNAVAILABLE");
            if (skins.owns(userId, skin.code())) throw GardenException.conflict("REWARD_OWNED");
            if (def.globalLimit() != null && !repo.takeGlobal(def.code(), def.globalLimit())) {
                throw GardenException.conflict("REWARD_SOLD_OUT");
            }
            int balance = repo.account(userId).balance();
            if (!repo.spend(userId, def.cost(), now)) {
                throw GardenException.conflict("INSUFFICIENT_CONTRIBUTION", Map.of("missing", def.cost() - balance));
            }
            if (!skins.grant(userId, skin.code(), "REWARD", 0, op, now)) throw GardenException.conflict("REWARD_OWNED");
            long id = repo.insertRedemption(userId, def.code(), def.cost(), def.delivery(), skin.code(), op, now);
            repo.insertEntry(userId, "REDEEM", "redemption:" + id, -def.cost(), -def.cost(), false, ctx.engine().calendar().dayKey(now), now);
            monument.recordMilestone(userId, "SKIN", skin.code(), 1, now, true);
            ctx.repo.log(userId, "REWARD_REDEEM", ctx.write(Map.of("reward", def.code(), "redemptionId", id, "cost", def.cost(),
                    "delivery", def.delivery(), "ref", skin.code())), now);
            return new RewardReceipt(id, def.code(), def.cost(), repo.account(userId).balance(), def.delivery(), skin.code(),
                    view(userId, now), shop(userId, now), collection.view(userId, now, qa));
        });
    }
}
