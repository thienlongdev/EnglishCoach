package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenDtos.GuideView;
import com.englishcoach.garden.domain.GuideEngine;
import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.BoostView;
import com.englishcoach.garden.api.GardenDtos.CropView;
import com.englishcoach.garden.api.GardenDtos.GoalView;
import com.englishcoach.garden.api.GardenDtos.InventoryView;
import com.englishcoach.garden.api.GardenDtos.LearningView;
import com.englishcoach.garden.api.GardenDtos.PestView;
import com.englishcoach.garden.api.GardenDtos.PlantingView;
import com.englishcoach.garden.api.GardenDtos.PlotView;
import com.englishcoach.garden.api.GardenDtos.ProduceView;
import com.englishcoach.garden.api.GardenDtos.ProfileView;
import com.englishcoach.garden.api.GardenDtos.RewardsView;
import com.englishcoach.garden.api.GardenDtos.SeedView;
import com.englishcoach.garden.api.GardenDtos.SourceView;
import com.englishcoach.garden.api.GardenDtos.State;
import com.englishcoach.garden.api.GardenDtos.TierView;
import com.englishcoach.garden.api.GardenDtos.TodayView;
import com.englishcoach.garden.api.GardenDtos.UnlockView;
import com.englishcoach.garden.api.GardenDtos.WeatherView;
import com.englishcoach.garden.api.GardenDtos.WorldView;
import com.englishcoach.garden.api.GardenDtos.ProtectionView;
import com.englishcoach.garden.api.GardenDtos.SoilView;
import com.englishcoach.garden.domain.FarmingEngine.Treatment;
import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.GardenEngine;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;
import com.englishcoach.garden.domain.SoilModel;
import com.englishcoach.garden.infra.FarmingRepository;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GrowthCalculator.PlantingFacts;
import com.englishcoach.garden.domain.PestPlanner;
import com.englishcoach.garden.domain.QualityCalculator;
import com.englishcoach.garden.domain.WeatherCalendar;
import com.englishcoach.garden.infra.GardenRepository.Item;
import com.englishcoach.garden.infra.GardenRepository.Planting;
import com.englishcoach.garden.infra.GardenRepository.Plot;
import com.englishcoach.garden.infra.GardenRepository.Profile;
import com.englishcoach.garden.infra.PestRepository;
import com.englishcoach.garden.infra.PestRepository.PestRow;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Builds the authoritative views from stored facts + compute-on-read growth. Writes only derived state (a tree's raised
 * peak, see KnowledgeService#evaluateActive). Growth facts of a planting always include its pests' slowdowns.
 */
@Component
public class GardenViews {

    public static final int ONBOARDING_DONE = 8;

    private final GardenContext ctx;
    private final PestRepository pests;
    private final KnowledgeService knowledge;
    private final FarmingRepository farmingRepo;

    public GardenViews(GardenContext ctx, PestRepository pests, KnowledgeService knowledge, FarmingRepository farmingRepo) {
        this.ctx = ctx;
        this.pests = pests;
        this.knowledge = knowledge;
        this.farmingRepo = farmingRepo;
    }

    /**
     * Everything growth and harvest need to know about one planting: its growth facts (pest and soil slowdowns
     * included), its soil timeline (Phase 3D, growth model 2 only; null otherwise) and the supplies applied to it.
     */
    public record Growing(PlantingFacts facts, SoilModel.Timeline soil, List<Treatment> treatments) {}

    // ------------------------------------------------------------------ growth facts

    /**
     * Growth facts of the given plantings, with the slowdowns of every pest that sat on each of them. Phase 3D: a pest
     * spray cuts its window out of the pest damage, and a planting of growth model 2 adds the slowdowns of its soil
     * (thirst, waterlogging). The soil timeline runs to the estimate horizon using only the weather the forecast
     * reveals at {@code now}; the past always uses the real weather.
     */
    public Map<Long, Growing> growing(long userId, Collection<Planting> plantings, Instant now) {
        var e = ctx.engine();
        var farming = ctx.farming();
        List<Long> ids = plantings.stream().map(Planting::id).toList();
        List<Long> soilIds = farming == null ? List.of() : plantings.stream().filter(Planting::soil).map(Planting::id).toList();
        // Phase 5: what growth needs of these plantings, in one exchange
        GardenScope.prefetch(() -> pests.forPlantings(userId, ids),
                () -> { if (farming != null && !ids.isEmpty()) farmingRepo.treatments(userId, ids); },
                () -> { if (!soilIds.isEmpty()) farmingRepo.waterTimes(userId, soilIds); });
        Map<Long, List<PestPlanner.PestFacts>> byPlanting = PestPlanner.byPlanting(
                pests.forPlantings(userId, ids).stream().map(PestRow::facts).toList());
        // Phase 3C: staged damage (warning -> leaf damage -> wilting), softened once the crop was cared for
        Map<Long, List<Instant>> care = byPlanting.isEmpty() ? Map.of() : ctx.repo.careTimes(userId, byPlanting.keySet());
        Map<Long, List<Treatment>> treatments = farming == null || ids.isEmpty() ? Map.of() : farmingRepo.treatments(userId, ids);
        Map<Long, List<Instant>> waters = soilIds.isEmpty() ? Map.of() : farmingRepo.waterTimes(userId, soilIds);
        Map<Long, Growing> out = new HashMap<>();
        for (Planting p : plantings) {
            CropDef crop = e.rules().crop(p.cropCode());
            List<Treatment> applied = treatments.getOrDefault(p.id(), List.of());
            List<Slowdown> slow = ctx.estate().slowdowns(byPlanting.getOrDefault(p.id(), List.of()), care.getOrDefault(p.id(), List.of()));
            if (farming != null && !applied.isEmpty()) slow = farming.suppress(slow, applied);
            SoilModel.Timeline soil = null;
            if (farming != null && p.soil()) {
                Instant until = now.plus(Duration.ofDays(e.rules().growth().estimateHorizonDays()));
                soil = farming.soil().timeline(p.plantedAt(), farming.rules().thirstOf(crop.code()),
                        farming.soilEvents(waters.getOrDefault(p.id(), List.of()), applied), until, e.weather().revealedUntil(now));
                if (!soil.slowdowns().isEmpty()) {
                    slow = new ArrayList<>(slow);
                    slow.addAll(soil.slowdowns());
                }
            }
            out.put(p.id(), new Growing(new PlantingFacts(p.plantedAt(), p.baseSeconds(), p.boostFraction(), crop.season(), slow),
                    soil, applied));
        }
        return out;
    }

    public Growing growing(long userId, Planting p, Instant now) {
        return growing(userId, List.of(p), now).get(p.id());
    }

    public PlantingFacts facts(long userId, Planting p, Instant now) {
        return growing(userId, p, now).facts();
    }

    /** Every pest (incl. cleared) of these plantings, grouped (harvest quality). */
    public Map<Long, List<PestPlanner.PestFacts>> pestsOf(long userId, Collection<Long> plantingIds) {
        return PestPlanner.byPlanting(pests.forPlantings(userId, plantingIds).stream().map(PestRow::facts).toList());
    }

    // ------------------------------------------------------------------ state

    public State state(long userId, Instant now, boolean qa, boolean blessing,
                       com.englishcoach.garden.api.GardenDtos.EconomyView economy) {
        var e = ctx.engine();
        var repo = ctx.repo;
        // Phase 5: every independent fact of the state in one exchange (each is read for real, below, where it is used)
        GardenScope.prefetch(() -> repo.profile(userId), () -> repo.essence(userId), () -> repo.daily(userId, e.calendar().dayKey(now)),
                () -> repo.activePlantings(userId), () -> pests.active(userId), () -> ctx.perks(userId), () -> repo.plots(userId),
                () -> repo.inventory(userId), () -> repo.countPlantings(userId), () -> knowledge.evaluateActive(userId, now),
                () -> knowledge.view(userId, now, 1, List.of()), () -> growing(userId, repo.activePlantings(userId), now),
                () -> repo.ledgerSince(userId, REWARD_REASONS, rewardsSince(repo.profile(userId))),
                () -> repo.learningEventsIngestedSince(userId, rewardsSince(repo.profile(userId))),
                () -> repo.lessonsIngestedSince(userId, rewardsSince(repo.profile(userId))),
                () -> pestViews(userId, pests.active(userId), Map.of(), now));
        Profile profile = repo.profile(userId);
        var lp = e.levels().progress(profile.totalXp());
        UnlockView next = e.levels().nextUnlock(lp.level())
                .map(c -> new UnlockView(c.unlockLevel(), c.code(), c.nameVi())).orElse(null);
        int essence = repo.essence(userId);
        var profileView = new ProfileView(lp.level(), lp.xpIntoLevel(), lp.xpToNext(), profile.totalXp(), profile.coins(), next, essence);

        var today = repo.daily(userId, e.calendar().dayKey(now));
        var rw = e.rules().rewards();
        var goal = new GoalView(today.goalDoneAt() != null, round2(today.effectiveUnits()), rw.goalUnits(), today.reviews(),
                rw.goalDueMinReviews(), today.goalDoneAt(), rw.goalMixUnits(), rw.goalMixSkills(), today.skillCount());
        var todayView = new TodayView(today.day(), goal, blessing, e.rules().blessingSellMultiplier());

        List<Planting> activeList = repo.activePlantings(userId);
        Map<Long, Growing> facts = growing(userId, activeList, now);
        List<PestRow> activePests = pests.active(userId);
        Map<Long, PestRow> pestOfPlanting = new HashMap<>();
        activePests.forEach(p -> {
            if (p.plantingId() != null) pestOfPlanting.put(p.plantingId(), p);
        });
        var perks = ctx.perks(userId);
        Map<Long, Planting> active = activeList.stream().collect(Collectors.toMap(Planting::plotId, p -> p));
        List<Plot> plotRows = repo.plots(userId);
        List<PlotView> plots = plotRows.stream().map(p -> {
            Planting pl = active.get(p.id());
            return new PlotView(p.id(), p.slot(), p.gridX(), p.gridY(), p.unlockedAt() != null,
                    pl == null ? null : planting(pl, facts.get(pl.id()), pestOfPlanting.get(pl.id()), now, perks.freshBonus()));
        }).toList();

        List<Item> items = repo.inventory(userId);
        int water = 0, fert = 0, premium = 0;
        List<SeedView> seeds = new ArrayList<>();
        List<ProduceView> produce = new ArrayList<>();
        // Phase 3H: harvest portions with the value selling them pays now (proportional share of the unit, rounded down)
        List<com.englishcoach.garden.api.GardenDtos.ShareStockView> shares = new ArrayList<>();
        int unitPortions = ctx.social() == null ? 0 : ctx.social().rules().portionsPerUnit();
        for (Item it : items) {
            switch (it.code()) {
                case "WATER" -> water = it.qty();
                case "FERTILIZER" -> fert = it.qty();
                case "FERTILIZER_PREMIUM" -> premium = it.qty();
                default -> {
                    if (it.code().startsWith("SEED:")) seeds.add(new SeedView(it.code().substring(5), it.qty()));
                    else if (it.code().startsWith("CROP:")) {
                        String code = it.code().substring(5);
                        CropDef crop = e.rules().crops().get(code);
                        if (crop == null) continue;
                        long unit = e.quality().unitSellPrice(crop, e.rules().quality().tier(it.tier()), blessing);
                        produce.add(new ProduceView(code, it.tier(), it.qty(), unit));
                    } else if (it.code().startsWith("SHARE:") && unitPortions > 0 && it.qty() > 0) {
                        String code = it.code().substring(6);
                        CropDef crop = e.rules().crops().get(code);
                        if (crop == null) continue;
                        long unit = e.quality().unitSellPrice(crop, e.rules().quality().tier(it.tier()), blessing);
                        shares.add(new com.englishcoach.garden.api.GardenDtos.ShareStockView(code, crop.nameVi(), it.tier(), it.qty(),
                                unitPortions, unit, com.englishcoach.garden.domain.AnimalEngine.portionValue(unit, it.qty(), unitPortions)));
                    }
                }
            }
        }
        var inventory = new InventoryView(water, fert, premium, seeds, produce, shares);

        boolean noPlantingYet = repo.countPlantings(userId) == 0;
        List<CropView> crops = e.rules().crops().values().stream()
                .filter(c -> !c.qaOnly() || qa)
                .sorted(Comparator.comparingInt(CropDef::sortOrder))
                .map(c -> crop(e, c, lp.level(), now, noPlantingYet)).toList();
        List<BoostView> boosts = e.rules().boosts().values().stream()
                .map(b -> new BoostView(b.code(), b.nameVi(), b.group(), b.fraction(), b.perPlantingLimit()))
                .sorted(Comparator.comparing(BoostView::code).reversed()).toList();
        List<TierView> tiers = e.rules().quality().tiers().stream()
                .map(t -> new TierView(t.code(), t.minScore(), t.sellMultiplier())).toList();

        Instant since = rewardsSince(profile);
        var sums = repo.ledgerSince(userId, REWARD_REASONS, since);
        long rWater = sums.getOrDefault("WATER", 0L);
        long rXp = sums.getOrDefault("XP", 0L);
        long rFert = sums.getOrDefault("FERTILIZER", 0L);
        int reviews = repo.learningEventsIngestedSince(userId, since);
        int lessons = (int) repo.lessonsIngestedSince(userId, since);
        var rewards = new RewardsView(rWater > 0 || rXp > 0 || rFert > 0, reviews, rWater, rXp, rFert, lessons);

        double[] th = e.rules().growth().stageThresholds();
        var evals = knowledge.evaluateActive(userId, now);
        var knowledgeView = knowledge.view(userId, now, lp.level(), evals);
        Map<Long, Integer> slotOfPlanting = new HashMap<>();
        plotRows.forEach(p -> {
            Planting pl = active.get(p.id());
            if (pl != null) slotOfPlanting.put(pl.id(), p.slot());
        });
        return new State(now, profileView, todayView, world(now, perks.forecastExtra()), plots, inventory, crops, boosts,
                tiers, rewards, profile.onboardingStep(), List.of(th[0], th[1]), knowledgeView,
                pestViews(userId, activePests, slotOfPlanting, now), learning(today), economy, null, null, null, null, null, null,
                guideView(profile, noPlantingYet ? 0 : 1));
    }

    /** The voluntary guide's record of a garden ({@code settings.guide}); anything unreadable counts as never asked. */
    public GuideEngine.Guide guide(Profile profile) {
        if (profile == null || profile.settings() == null) return GuideEngine.Guide.NONE;
        try {
            var node = ctx.json.readTree(profile.settings()).path("guide");
            if (!node.isObject()) return GuideEngine.Guide.NONE;
            String raw = node.path("status").asText("");
            GuideEngine.Status status = null;
            for (GuideEngine.Status st : GuideEngine.Status.values()) if (st.name().equals(raw)) status = st;
            return new GuideEngine.Guide(status, node.path("step").asInt(0));
        } catch (Exception e) {
            return GuideEngine.Guide.NONE;
        }
    }

    public GuideView guideView(Profile profile, long plantings) {
        var g = guide(profile);
        return new GuideView(g.status() == null ? null : g.status().name(), g.step(), GuideEngine.VERSION,
                GuideEngine.invite(g, profile.onboardingStep(), plantings));
    }

    private static final List<String> REWARD_REASONS = List.of("LEARNING", "GOAL", "SKILL", "GAME");

    /** The rewards basket counts what learning brought since the player last looked at it. */
    private static Instant rewardsSince(Profile profile) {
        return profile.lastRewardSeenAt() != null ? profile.lastRewardSeenAt() : profile.createdAt();
    }

    public WorldView world(Instant now) {
        return world(now, 0);
    }

    /** {@code forecastExtra}: weather windows the cottage almanac reveals beyond the base forecast (Phase 3C). */
    public WorldView world(Instant now, int forecastExtra) {
        var e = ctx.engine();
        var theme = e.calendar().theme(now);
        Instant ends = e.calendar().themeEndsAt(now);
        var nextTheme = e.calendar().theme(ends);
        List<WeatherView> forecast = e.weather().forecast(now, forecastExtra).stream().map(this::weather).toList();
        return new WorldView(theme.name(), ends, nextTheme.name(), forecast.getFirst(), forecast,
                e.rules().weather().rainbowMutation());
    }

    private WeatherView weather(WeatherCalendar.Window w) {
        double factor = w.weather() == WeatherCalendar.Weather.RAIN ? ctx.engine().rules().weather().rainSpeed() : 1.0;
        return new WeatherView(w.weather().name(), w.start(), w.end(), w.season().name(), factor);
    }

    private LearningView learning(com.englishcoach.garden.infra.GardenRepository.Daily today) {
        var l = ctx.engine().rules().learning();
        var skill = l.categories().get("SKILL");
        var game = l.categories().get("GAME");
        var p = ctx.engine().rules().pests();
        var schedule = ctx.engine().rules().rewards().harvestXpDiminishing();
        double fullUntil = schedule.isEmpty() ? Double.MAX_VALUE : schedule.getFirst()[0];
        List<SourceView> sources = l.sources().values().stream()
                .sorted(Comparator.comparing((com.englishcoach.garden.domain.GardenRules.SourceRule s) -> !s.enabled())
                        .thenComparing(com.englishcoach.garden.domain.GardenRules.SourceRule::code))
                .map(s -> new SourceView(s.code(), s.category(), s.enabled())).toList();
        return new LearningView(today.skillCount(), skill.dailyCap(), skill.xp(), skill.fertilizerFirst(), today.gameCount(),
                game.dailyCap(), game.xp(), today.pestCures(), p.cureDailyCap(), sources, round2(today.harvestXpRaw()), fullUntil);
    }

    private List<PestView> pestViews(long userId, List<PestRow> active, Map<Long, Integer> slotOfPlanting, Instant now) {
        if (active.isEmpty()) return List.of();
        List<Long> hosts = active.stream().filter(p -> p.plantingId() != null).map(PestRow::plantingId).toList();
        // Phase 5: the word of each pest and the care its crop received, in one exchange
        GardenScope.prefetch(
                () -> pests.cardInfo(userId, active.stream().map(PestRow::flashcardId).toList(), ctx.engine().rules().pests().graceHours()),
                () -> { if (!hosts.isEmpty()) ctx.repo.careTimes(userId, hosts); },
                () -> { if (ctx.farming() != null && !hosts.isEmpty()) farmingRepo.treatments(userId, hosts); });
        var info = new HashMap<Long, PestRepository.CardInfo>();
        pests.cardInfo(userId, active.stream().map(PestRow::flashcardId).toList(), ctx.engine().rules().pests().graceHours())
                .forEach(c -> info.put(c.flashcardId(), c));
        var estate = ctx.estate();
        Map<Long, List<Instant>> care = hosts.isEmpty() ? Map.of() : ctx.repo.careTimes(userId, hosts);
        var farming = ctx.farming();
        Map<Long, List<Treatment>> sprays = farming == null || hosts.isEmpty() ? Map.of() : farmingRepo.treatments(userId, hosts);
        return active.stream().map(p -> {
            var c = info.get(p.flashcardId());
            boolean crop = "CROP".equals(p.host());
            List<Instant> cared = crop ? care.getOrDefault(p.plantingId(), List.of()) : List.of();
            List<Slowdown> windows = crop ? estate.slowdowns(List.of(p.facts()), cared) : List.of();
            // Phase 3D: a spray suspends the damage (the pest and its overdue word stay)
            if (crop && farming != null) windows = farming.suppress(windows, sprays.getOrDefault(p.plantingId(), List.of()));
            boolean slowing = windows.stream().anyMatch(s -> !now.isBefore(s.start()) && now.isBefore(s.end()));
            // a tree pest only marks the word that needs care: it has no damage stages
            int stage = p.reviewedAt() != null ? 0 : crop ? estate.stage(p.facts(), now).ordinal() : 1;
            boolean tended = crop && cared.stream().anyMatch(t -> !t.isBefore(p.spawnedAt()));
            return new PestView(p.id(), p.flashcardId(), p.word(), c == null ? null : c.meaningVi(), c == null ? null : c.ipa(),
                    p.host(), p.plantingId(), p.plantingId() == null ? null : slotOfPlanting.get(p.plantingId()), p.treeId(),
                    p.spawnedAt(), p.reviewedAt() != null, p.reviewedAt(), slowing, stage,
                    crop ? estate.nextStageAt(p.facts(), now) : null, crop ? estate.effectEndsAt(p.facts()) : null, tended);
        }).toList();
    }

    public PlotView plot(long userId, long plotId, Instant now) {
        GardenScope.prefetch(() -> ctx.repo.plot(userId, plotId), () -> ctx.repo.activePlantings(userId), () -> pests.active(userId),
                () -> ctx.perks(userId));
        Plot p = ctx.repo.plot(userId, plotId);
        Planting active = ctx.repo.activePlantings(userId).stream().filter(x -> x.plotId() == plotId).findFirst().orElse(null);
        PestRow pest = active == null ? null
                : pests.active(userId).stream().filter(x -> active.id() == (x.plantingId() == null ? -1 : x.plantingId()))
                .findFirst().orElse(null);
        return new PlotView(p.id(), p.slot(), p.gridX(), p.gridY(), p.unlockedAt() != null,
                active == null ? null : planting(active, growing(userId, active, now), pest, now, ctx.perks(userId).freshBonus()));
    }

    public PlantingView planting(Planting p, Growing growing, PestRow pest, Instant now, double freshBonus) {
        var e = ctx.engine();
        CropDef crop = e.rules().crop(p.cropCode());
        var snap = e.growth().evaluate(growing.facts(), now);
        double remaining = snap.ready() || snap.readyAt() == null ? 0
                : Math.max(0, Duration.between(now, snap.readyAt()).toMillis() / 1000.0);
        var fit = e.quality().seasonFit(crop, p.plantedAt(), now);
        Instant freshUntil = snap.ready() ? snap.readyAt().plus(QualityCalculator.freshWindow(e.rules(), p.baseSeconds(), freshBonus)) : null;
        Integer pestStage = pest == null ? null : pest.reviewedAt() != null ? 0 : ctx.estate().stage(pest.facts(), now).ordinal();
        int waterLimit = e.rules().boosts().containsKey("WATER") ? e.rules().boosts().get("WATER").perPlantingLimit() : 0;
        return new PlantingView(p.id(), crop.code(), crop.nameVi(), p.plantedAt(), snap.stage(), round4(snap.fraction()),
                snap.ready(), snap.readyAt(), snap.requiredSeconds(), remaining, snap.speedNow(), p.waterCount(), waterLimit,
                p.fertilizerCode(), p.boostFraction(), e.rules().growth().maxBoost(), fit.name(), p.tutorial(), freshUntil,
                pest == null ? null : pest.id(), p.skinCode(), skinArt(p.skinCode()), pestStage,
                soilView(crop, growing, snap, now), protections(growing, now));
    }

    /**
     * The soil of a planting of growth model 2. A growing crop shows the soil now; a ripe crop shows the soil it ripened
     * with (it no longer needs water, and nothing that happens afterwards can lower its quality).
     */
    private SoilView soilView(CropDef crop, Growing growing, com.englishcoach.garden.domain.GrowthCalculator.Snapshot snap, Instant now) {
        var farming = ctx.farming();
        if (farming == null || growing.soil() == null) return null;
        Instant at = snap.ready() ? snap.readyAt() : now;
        SoilModel.Condition c = growing.soil().at(at);
        boolean toned = farming.everApplied(growing.treatments(), Effect.TONIC, now);
        var care = farming.care(true, c, toned);
        boolean slowing = !snap.ready() && c.status() != SoilModel.Status.OK && growing.soil().slowdowns().stream()
                .anyMatch(s -> !now.isBefore(s.start()) && now.isBefore(s.end()));
        return new SoilView(round2(c.moisture()), c.status().name(), slowing, round4(care.stressShare()), care.factor(),
                snap.ready() ? null : c.nextChangeAt(), snap.ready() || c.nextStatus() == null ? null : c.nextStatus().name(),
                farming.rules().thirstOf(crop.code()), toned, care.tierCap());
    }

    /** Supplies still working on a planting (timed ones before their end, mulch until harvest); instant ones never. */
    private List<ProtectionView> protections(Growing growing, Instant now) {
        var farming = ctx.farming();
        if (farming == null || growing.treatments().isEmpty()) return List.of();
        List<ProtectionView> out = new ArrayList<>();
        for (Treatment t : growing.treatments()) {
            var item = farming.rules().item(t.itemCode());
            if (item == null || item.effect() == Effect.MOISTURE || !t.activeAt(now)) continue;
            out.add(new ProtectionView(t.itemCode(), item.effect().name(), t.appliedAt(), t.expiresAt()));
        }
        return out;
    }

    /** Art key of a planting's skin (Phase 3B); a skin no longer in the catalogue falls back to the base crop art. */
    private String skinArt(String skinCode) {
        if (skinCode == null) return null;
        var def = ctx.living().rules().skin(skinCode);
        return def == null ? null : def.artKey();
    }

    private CropView crop(GardenEngine e, CropDef c, int level, Instant now, boolean noPlantingYet) {
        boolean unlocked = c.qaOnly() || c.unlockLevel() <= level;
        int base = noPlantingYet && c.code().equals(e.rules().growth().tutorialCrop()) ? e.rules().growth().tutorialSeconds() : c.baseSeconds();
        var snap = e.growth().evaluate(new PlantingFacts(now, base, 0, c.season()), now);
        long grow = snap.readyAt() == null ? -1 : Duration.between(now, snap.readyAt()).toSeconds();
        var fit = e.quality().seasonFit(c, now, now);
        var farming = ctx.farming();
        return new CropView(c.code(), c.nameVi(), c.rarity().name(), c.baseSeconds(), seedCoinPrice(e, c), c.sellPrice(),
                c.season().name(), c.unlockLevel(), c.harvestXp(), unlocked, c.purchasable(), fit.name(), grow, c.qaOnly(),
                c.seedEssence(), farming == null ? 1.0 : farming.rules().thirstOf(c.code()),
                farming == null ? 0 : farming.harvestBonus(c));
    }

    public static long seedCoinPrice(GardenEngine e, CropDef c) {
        return Math.round(c.seedPrice() * e.rules().coinScale());
    }

    private static double round2(double v) {
        return Math.round(v * 100) / 100.0;
    }

    private static double round4(double v) {
        return Math.round(v * 10000) / 10000.0;
    }
}
