package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.ActivityEntryView;
import com.englishcoach.garden.api.GardenDtos.ActivityPage;
import com.englishcoach.garden.api.GardenDtos.DiscoverPage;
import com.englishcoach.garden.api.GardenDtos.IslandCardView;
import com.englishcoach.garden.api.GardenDtos.IslandForestTreeView;
import com.englishcoach.garden.api.GardenDtos.IslandMonumentView;
import com.englishcoach.garden.api.GardenDtos.IslandProtectionView;
import com.englishcoach.garden.api.GardenDtos.IslandTreeView;
import com.englishcoach.garden.api.GardenDtos.IslandView;
import com.englishcoach.garden.api.GardenDtos.PlotView;
import com.englishcoach.garden.api.GardenDtos.ReactionEntryView;
import com.englishcoach.garden.api.GardenDtos.ReactionReceipt;
import com.englishcoach.garden.api.GardenDtos.ShareView;
import com.englishcoach.garden.api.GardenDtos.SocialAck;
import com.englishcoach.garden.api.GardenDtos.SocialBadgeView;
import com.englishcoach.garden.api.GardenDtos.SocialMeView;
import com.englishcoach.garden.api.GardenDtos.SocialRulesView;
import com.englishcoach.garden.api.GardenDtos.StandingView;
import com.englishcoach.garden.api.GardenDtos.TakeReceipt;
import com.englishcoach.garden.api.GardenDtos.TakeView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.LivingRules.Family;
import com.englishcoach.garden.domain.SocialEngine;
import com.englishcoach.garden.domain.SocialEngine.Crop;
import com.englishcoach.garden.domain.SocialEngine.Guard;
import com.englishcoach.garden.domain.SocialEngine.Reason;
import com.englishcoach.garden.domain.SocialEngine.Taker;
import com.englishcoach.garden.domain.SocialEngine.Verdict;
import com.englishcoach.garden.infra.GardenRepository.Planting;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import com.englishcoach.garden.infra.SocialRepository;
import com.englishcoach.garden.infra.SocialRepository.Island;
import com.englishcoach.garden.infra.SocialRepository.Profile;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Phase 3G social islands: discovery of real garden players, read-only visits, the limited "take a little" of a ripe
 * crop and the island activity record.
 *
 * <p><b>Who is listed.</b> Only gardens that exist, whose owner currently has garden access (the same flag and
 * allowlist as gameplay), whose account is ACTIVE and whose own social profile says PUBLIC. A player is known to others
 * by a public name and a random handle; no account id, e-mail or login ever leaves this service.
 *
 * <p><b>What a visitor may do.</b> Read the island picture ({@link #visit}) and take a little from a ripe crop
 * ({@link #take}). Every other garden command acts on the caller's own garden by construction (the user id comes from
 * the principal), so there is no path by which a visitor plants, waters, harvests, sells, equips or collects for the
 * owner.
 *
 * <p><b>The take.</b> One transaction under BOTH gardens' locks ({@link GardenContext#pairCommand}), so it is serialised
 * against the owner's harvest and against every other visitor: validate → record ({@code garden_theft}, one row per
 * planting, database-enforced) → credit the taker's fragments through the ledger → tell the owner. A refused attempt
 * writes nothing and earns nothing. The owner's harvest later pays exactly the rest ({@link HarvestShares}).
 */
@Service
public class SocialService {

    private static final DateTimeFormatter NOTICE_TIME = DateTimeFormatter.ofPattern("HH:mm 'ngày' dd/MM/yyyy", Locale.ROOT);
    public static final String ACTIVITY_ROUTE = "/games/echo-garden?social=activity";

    /** The idempotent payload of a take (a record keeps its JSON field order stable across restarts). */
    record TakeOp(String handle, long plantingId) {}

    record ReactOp(String handle, String code) {}

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final GardenViews views;
    private final SocialRepository repo;
    private final KnowledgeRepository knowledge;
    private final MonumentRepository monument;
    private final CosmeticService cosmetics;
    private final HarvestShares shares;
    private final GardenProperties properties;
    private final SocialNotifier notifier;
    private final GuardianWatch guardians;
    private final AnimalService animals;

    public SocialService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger, GardenViews views,
                         SocialRepository repo, KnowledgeRepository knowledge, MonumentRepository monument,
                         CosmeticService cosmetics, HarvestShares shares, GardenProperties properties, SocialNotifier notifier,
                         GuardianWatch guardians, AnimalService animals) {
        this.guardians = guardians;
        this.animals = animals;
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.views = views;
        this.repo = repo;
        this.knowledge = knowledge;
        this.monument = monument;
        this.cosmetics = cosmetics;
        this.shares = shares;
        this.properties = properties;
        this.notifier = notifier;
    }

    private SocialEngine engine() {
        SocialEngine e = ctx.social();
        if (e == null) throw GardenException.conflict("SOCIAL_CLOSED");
        return e;
    }

    /** The garden allowlist while the garden is not open to everyone (null = every user with a garden). */
    private Collection<Long> scope() {
        var allow = properties.getAllowlistUserIds();
        return allow == null || allow.isEmpty() ? null : allow;
    }

    // ------------------------------------------------------------------ the owner's own state

    /**
     * Read before the garden transaction (like the other read-only sources of {@code GET /state}); a failure never
     * breaks the garden — the stored name is simply kept.
     */
    public String collectName(long userId) {
        if (ctx.social() == null) return null;
        try {
            return repo.publicName(userId);
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    /**
     * Part of {@code GET /state}, inside its transaction: makes sure the garden has its social profile, refreshes the
     * public-name snapshot and the activity time, and returns what the owner's own screen needs.
     */
    public SocialBadgeView reconcile(long userId, Instant now, String name) {
        SocialEngine e = ctx.social();
        if (e == null) return null;
        GardenScope.prefetch(() -> repo.profile(userId), () -> repo.takenFromActive(userId),
                () -> { if (choiceAsked()) repo.visibilityChosen(userId); },
                () -> { Profile mine = repo.profile(userId); if (mine != null) repo.unread(userId, mine.activitySeenAt()); });
        Profile p = repo.ensure(userId, name, now, startVisibility());
        // read first, write last: the activity time is the only thing this read changes, and nothing above depends on it
        var badge = new SocialBadgeView(p.visibility(), repo.unread(userId, p.activitySeenAt()), repo.takenFromActive(userId),
                e.rules().portionsPerUnit(), !choiceAsked() || repo.visibilityChosen(userId));
        repo.touch(userId, name, now);
        return badge;
    }

    /**
     * Phase 3H: from V89 on an island starts closed and its owner is asked once who may find it; on an older database
     * an island starts open, as Phase 3G created it.
     */
    private boolean choiceAsked() {
        return ctx.socialDefaultVisibility() != null;
    }

    private String startVisibility() {
        return choiceAsked() ? ctx.socialDefaultVisibility() : "PUBLIC";
    }

    private Profile ensureProfile(long userId, Instant now) {
        Profile p = repo.profile(userId);
        return p != null ? p : repo.ensure(userId, collectName(userId), now, startVisibility());
    }

    public SocialMeView me(long userId) {
        access.require(userId);
        SocialEngine e = engine();
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            return meView(e, ensureProfile(userId, now), now);
        });
    }

    private SocialMeView meView(SocialEngine e, Profile p, Instant now) {
        var r = e.rules();
        var t = r.theft();
        var crops = ctx.engine().rules().crops();
        List<ShareView> held = repo.shares(p.userId()).stream().map(i -> {
            String code = i.code().substring(HarvestShares.item("").length());
            CropDef crop = crops.get(code);
            return new ShareView(code, crop == null ? code : crop.nameVi(), i.tier(), i.qty(), r.portionsPerUnit());
        }).toList();
        return new SocialMeView(p.handle(), p.displayName(), p.visibility(), p.visibilityChangedAt(), standing(e, p, now),
                ownProtection(e, p, now), held, repo.unread(p.userId(), p.activitySeenAt()),
                new SocialRulesView(r.portionsPerUnit(), t.fractionBp(), t.windowHours(), t.thiefCap(), t.pairCap(), t.victimCap(),
                        t.shieldHours(), t.introHours(), t.reopenHours(), t.ripeGraceMinutes()), r.reactions());
    }

    public SocialMeView setVisibility(long userId, UUID key, String visibility) {
        access.require(userId);
        SocialEngine e = engine();
        return ctx.command(userId, key, "SOCIAL_VISIBILITY", visibility, SocialMeView.class, setup.ensurer(userId), (now, op) -> {
            ensureProfile(userId, now);
            if (repo.setVisibility(userId, visibility, now)) {
                ctx.repo.log(userId, "SOCIAL_VISIBILITY", ctx.write(Map.of("visibility", visibility)), now);
            }
            // Phase 3H: the owner has decided (also when they keep the island as it is)
            if (choiceAsked()) repo.markVisibilityChosen(userId, now);
            return meView(e, repo.profile(userId), now);
        });
    }

    // ------------------------------------------------------------------ discovery

    /**
     * {@code query} null / blank: open islands, most recently active first, one keyset page. Otherwise one bounded
     * page of islands whose public name starts with the query, plus the island with exactly that handle.
     */
    public DiscoverPage discover(long userId, String cursor, String query) {
        access.require(userId);
        SocialEngine e = engine();
        var d = e.rules().discovery();
        String q = query == null ? "" : query.trim();
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            ensureProfile(userId, now);
            if (!q.isEmpty()) {
                String key = SocialEngine.nameKey(q);
                String handle = handleOf(q);
                if (key.length() < d.minQuery() && handle == null) throw new GardenException(400, "SEARCH_TOO_SHORT", Map.of("min", d.minQuery()));
                // a query too short to be a name still finds an island by its exact handle
                String prefix = key.length() >= d.minQuery() ? key : "\u0001";
                return new DiscoverPage(cards(repo.search(userId, scope(), prefix, handle, d.searchLimit())), null, true);
            }
            Instant at = null;
            String handle = null;
            if (cursor != null && !cursor.isBlank()) {
                int dot = cursor.indexOf('.');
                handle = dot > 0 ? handleOf(cursor.substring(dot + 1)) : null;
                try {
                    long micros = dot > 0 ? Long.parseLong(cursor.substring(0, dot)) : -1;
                    at = micros < 0 ? null : Instant.ofEpochSecond(micros / 1_000_000, (micros % 1_000_000) * 1_000);
                } catch (NumberFormatException bad) {
                    at = null;
                }
                if (at == null || handle == null) throw new GardenException(400, "INVALID_COMMAND");
            }
            List<Island> rows = repo.discover(userId, scope(), at, handle, d.pageSize() + 1);
            boolean more = rows.size() > d.pageSize();
            List<Island> page = more ? rows.subList(0, d.pageSize()) : rows;
            String next = null;
            if (more) {
                Island last = page.getLast();
                Instant a = last.lastActiveAt();
                next = (a.getEpochSecond() * 1_000_000 + a.getNano() / 1_000) + "." + last.handle();
            }
            return new DiscoverPage(cards(page), next, false);
        });
    }

    /** Islands the caller visited that are still open, last visit first (bounded). */
    public DiscoverPage visited(long userId) {
        access.require(userId);
        SocialEngine e = engine();
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            ensureProfile(userId, now);
            return new DiscoverPage(cards(repo.visited(userId, scope(), e.rules().visitHistoryLimit())), null, false);
        });
    }

    private List<IslandCardView> cards(List<Island> islands) {
        return islands.stream().map(this::card).toList();
    }

    private IslandCardView card(Island i) {
        return new IslandCardView(i.handle(), i.displayName(), ctx.engine().levels().level(i.totalXp()), i.beds(), i.era(),
                i.forestTrees(), i.visitedAt());
    }

    /** A handle as typed ("ab12cd34", "EG-AB12CD34"), or null when the text is not one. */
    static String handleOf(String text) {
        if (text == null) return null;
        String h = text.trim().toUpperCase(Locale.ROOT);
        if (h.startsWith("EG-")) h = h.substring(3);
        return h.matches(SocialRepository.HANDLE_PATTERN) ? h : null;
    }

    // ------------------------------------------------------------------ visit

    /**
     * The open island behind a handle for this caller. Everything that is not visitable looks the same from outside:
     * 404, whether the handle is unknown, the island is closed, its owner lost access or the account is not active.
     */
    private Profile host(long userId, String handle) {
        String h = handleOf(handle);
        Profile host = h == null ? null : repo.byHandle(h);
        if (host == null || !access.allowed(host.userId())) throw new GardenException(404, "ISLAND_NOT_FOUND");
        if (host.userId() == userId) throw GardenException.conflict("OWN_ISLAND");
        if (!host.open()) throw new GardenException(404, "ISLAND_NOT_FOUND");
        return host;
    }

    public IslandView visit(long userId, String handle) {
        access.require(userId);
        SocialEngine e = engine();
        long hostId = host(userId, handle).userId();
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            Profile me = ensureProfile(userId, now);
            Profile host = host(userId, handle);
            if (host.userId() != hostId) throw new GardenException(404, "ISLAND_NOT_FOUND");
            repo.recordVisit(userId, hostId, now);
            return island(e, me, host, now);
        });
    }

    private IslandView island(SocialEngine e, Profile me, Profile host, Instant now) {
        var g = ctx.engine();
        long hostId = host.userId();
        List<Planting> active = ctx.repo.activePlantings(hostId);
        Map<Long, GardenViews.Growing> growing = views.growing(hostId, active, now);
        Map<Long, Planting> byPlot = active.stream().collect(Collectors.toMap(Planting::plotId, p -> p));
        double fresh = ctx.perks(hostId).freshBonus();
        Map<Long, Integer> taken = repo.takenPortions(active.stream().map(Planting::id).toList());
        Taker taker = taker(e, me, now);
        SocialEngine.Island facts = islandFacts(e, host, me.userId(), now);
        // Phase 3H: what the island's guardian pets add right now (the dog's watch, the goose's longer head start)
        Guard guard = guardians.guard(hostId, now);

        List<PlotView> plots = new ArrayList<>();
        List<TakeView> takes = new ArrayList<>();
        for (var plot : ctx.repo.plots(hostId)) {
            Planting p = byPlot.get(plot.id());
            // pest = null: a Forgotten Pest names one of the owner's flashcards — never shown to a visitor
            plots.add(new PlotView(plot.id(), plot.slot(), plot.gridX(), plot.gridY(), plot.unlockedAt() != null,
                    p == null ? null : views.planting(p, growing.get(p.id()), null, now, fresh)));
            if (p == null) continue;
            var snap = g.growth().evaluate(growing.get(p.id()).facts(), now);
            Verdict v = e.verdict(taker, facts, new Crop(p.cropCode(), p.tutorial(), snap.ready(), snap.readyAt(),
                    taken.getOrDefault(p.id(), 0)), now, guard);
            takes.add(new TakeView(p.id(), plot.slot(), v.ok(), v.ok() ? null : v.reason().name(), v.portions(), v.availableAt()));
        }

        var row = monument.row(hostId);
        var counters = MonumentService.counters(row);
        var me3b = ctx.living().monument();
        Map<String, Integer> ornaments = new LinkedHashMap<>();
        for (Family f : Family.values()) ornaments.put(f.name().toLowerCase(Locale.ROOT), me3b.branchTier(counters.days(f)));
        ornaments.put("memory", me3b.memoryTier(counters.graduations()));

        // the grove shows each tree's best stage reached; its words, health and learning evidence stay with the owner
        List<IslandTreeView> grove = knowledge.activeTrees(hostId).stream()
                .map(t -> new IslandTreeView(t.id(), t.slot(), t.species(), Math.max(1, t.peakStage()))).toList();
        List<IslandForestTreeView> forest = knowledge.forest(hostId, null, 12).stream()
                .map(t -> new IslandForestTreeView(t.id(), t.species())).toList();

        var visit = repo.visit(me.userId(), hostId);
        Instant reactionNext = visit == null || visit.reactionAt() == null ? null
                : visit.reactionAt().plus(Duration.ofHours(e.rules().reactionCooldownHours()));
        boolean reacted = reactionNext != null && now.isBefore(reactionNext);
        Island summary = repo.island(me.userId(), hostId);
        IslandCardView owner = summary != null ? card(summary)
                : new IslandCardView(host.handle(), host.displayName(), 1, plots.size(), row == null ? 0 : row.era(), forest.size(), now);
        Verdict standing = e.standing(taker, now);
        Verdict protection = e.protection(facts, now, guard);
        return new IslandView(now, owner, plots, List.of(g.rules().growth().stageThresholds()[0], g.rules().growth().stageThresholds()[1]),
                ctx.repo.buildingLevels(hostId), cosmetics.stateView(hostId), new IslandMonumentView(row == null ? 0 : row.era(), ornaments),
                grove, forest, takes, standingView(e, standing, taker), protectionView(protection), e.rules().portionsPerUnit(),
                reacted ? visit.reactionCode() : null, reacted ? reactionNext : null, animals.island(hostId, now));
    }

    // ------------------------------------------------------------------ take a little

    private Taker taker(SocialEngine e, Profile p, Instant now) {
        List<Instant> mine = repo.takesBy(p.userId(), now.minus(e.rules().theft().window()));
        return new Taker(p.open(), p.createdAt(), p.visibilityChangedAt(), mine.size(), mine.isEmpty() ? null : mine.getFirst());
    }

    private SocialEngine.Island islandFacts(SocialEngine e, Profile host, long takerId, Instant now) {
        var t = e.rules().theft();
        Instant windowStart = now.minus(t.window());
        Instant since = now.minus(Duration.ofHours(Math.max(t.windowHours(), t.shieldHours())));
        List<Instant> on = repo.takesOn(host.userId(), since);
        List<Instant> inWindow = on.stream().filter(i -> i.isAfter(windowStart)).toList();
        List<Instant> pair = repo.pairTakes(takerId, host.userId(), windowStart);
        return new SocialEngine.Island(host.createdAt(), inWindow.size(), inWindow.isEmpty() ? null : inWindow.getFirst(),
                on.isEmpty() ? null : on.getLast(), pair.size(), pair.isEmpty() ? null : pair.getFirst());
    }

    private StandingView standing(SocialEngine e, Profile p, Instant now) {
        Taker taker = taker(e, p, now);
        return standingView(e, e.standing(taker, now), taker);
    }

    private static StandingView standingView(SocialEngine e, Verdict v, Taker taker) {
        int cap = e.rules().theft().thiefCap();
        return new StandingView(v.ok(), v.ok() ? null : v.reason().name(), v.availableAt(), taker.takesInWindow(),
                Math.max(0, cap - taker.takesInWindow()));
    }

    private static IslandProtectionView protectionView(Verdict v) {
        return new IslandProtectionView(!v.ok(), v.ok() ? null : v.reason().name(), v.availableAt());
    }

    /** The reader's own island: closed by its owner, or protected by a rule right now. */
    private IslandProtectionView ownProtection(SocialEngine e, Profile p, Instant now) {
        if (!p.open()) return new IslandProtectionView(true, "PRIVATE", null);
        // no taker in particular: the pair limit is not part of an island's own protection
        return protectionView(e.protection(islandFacts(e, p, -1L, now), now, guardians.guard(p.userId(), now)));
    }

    /**
     * Take a little from one ripe crop of an open island. Serialised against both gardens; idempotent per key; a refusal
     * (409 with the first rule in the way) changes nothing.
     */
    public TakeReceipt take(long userId, UUID key, String handle, long plantingId) {
        access.require(userId);
        SocialEngine e = engine();
        Profile target = host(userId, handle);
        long hostId = target.userId();
        return ctx.pairCommand(userId, hostId, key, "SOCIAL_TAKE", new TakeOp(target.handle(), plantingId), TakeReceipt.class,
                setup.ensurer(userId), (now, op) -> {
                    var g = ctx.engine();
                    Profile me = ensureProfile(userId, now);
                    // read again under both locks: the island may have been closed a moment ago
                    Profile host = host(userId, target.handle());
                    if (host.userId() != hostId) throw new GardenException(404, "ISLAND_NOT_FOUND");
                    Planting p = ctx.repo.activePlanting(hostId, plantingId);
                    var snap = g.growth().evaluate(views.facts(hostId, p, now), now);
                    Taker taker = taker(e, me, now);
                    SocialEngine.Island facts = islandFacts(e, host, userId, now);
                    Verdict v = e.verdict(taker, facts, new Crop(p.cropCode(), p.tutorial(), snap.ready(), snap.readyAt(),
                            repo.takenPortions(plantingId)), now, guardians.guard(hostId, now));
                    if (!v.ok()) throw refusal(v);
                    int unit = e.rules().portionsPerUnit();
                    // Phase 3H: a fed guardian dog turns away one take that would otherwise succeed, once per cooldown,
                    // and then watches the island for a while. Nothing leaves the island and the visitor loses nothing
                    // (no limit is used up); the owner is told that the dog stepped in, never by whom.
                    Instant guardedUntil = guardians.turnAway(hostId, now);
                    if (guardedUntil != null) {
                        CropDef kept = g.rules().crop(p.cropCode());
                        ctx.repo.log(userId, "SOCIAL_TAKE_GUARDED", ctx.write(Map.of("crop", kept.code())), now);
                        ctx.repo.log(hostId, "GUARDIAN_DOG_WATCH", ctx.write(Map.of("crop", kept.code())), now);
                        notifier.taken(hostId, "GARDEN_GUARD:" + hostId + ":" + now.getEpochSecond(), guardTitle(),
                                guardBody(kept.nameVi(), now, guardedUntil, g.rules().zone()), ACTIVITY_ROUTE);
                        return new TakeReceipt(0, host.handle(), host.displayName(), plantingId, kept.code(), kept.nameVi(), 0, unit,
                                null, 0, 0, standingView(e, e.standing(taker, now), taker),
                                new IslandProtectionView(true, Reason.ISLAND_GUARDED.name(), guardedUntil), true);
                    }
                    Long takeId = repo.insertTake(hostId, userId, plantingId, p.cropCode(), v.portions(), unit, op, now);
                    if (takeId == null) throw refusal(new Verdict(Reason.CROP_TAKEN, 0, null));

                    CropDef crop = g.rules().crop(p.cropCode());
                    // the taker answered no recall question: their fragments carry the lowest quality
                    String tier = g.rules().quality().tiers().stream().min(Comparator.comparingInt(QualityTier::minScore))
                            .orElseThrow().code();
                    ledger.addItem(userId, HarvestShares.item(crop.code()), tier, v.portions(), "TAKE", "THEFT", String.valueOf(takeId), op, now);
                    int merged = shares.merge(userId, crop.code(), tier, op, now);
                    ctx.repo.log(userId, "SOCIAL_TAKE", ctx.write(Map.of("takeId", takeId, "crop", crop.code(), "portions", v.portions())), now);
                    ctx.repo.log(hostId, "SOCIAL_TAKEN_FROM", ctx.write(Map.of("takeId", takeId, "crop", crop.code(), "portions", v.portions())), now);
                    notifier.taken(hostId, "GARDEN_TAKE:" + takeId, noticeTitle(), noticeBody(me, crop.nameVi(), v.portions(), unit,
                            now, g.rules().zone()), ACTIVITY_ROUTE);

                    Taker after = taker(e, me, now);
                    return new TakeReceipt(takeId, host.handle(), host.displayName(), plantingId, crop.code(), crop.nameVi(),
                            v.portions(), unit, tier, ctx.repo.itemQty(userId, HarvestShares.item(crop.code()), tier), merged,
                            standingView(e, e.standing(after, now), after),
                            protectionView(e.protection(islandFacts(e, host, userId, now), now, guardians.guard(hostId, now))), false);
                });
    }

    private static GardenException refusal(Verdict v) {
        return GardenException.conflict(v.reason().name(),
                v.availableAt() == null ? Map.of() : Map.of("availableAt", v.availableAt().toString()));
    }

    static String guardTitle() {
        return "Chó canh vườn vừa giữ nông sản cho bạn";
    }

    /** The owner learns that the dog stepped in and for how long it keeps watch — never who the visitor was. */
    static String guardBody(String cropName, Instant at, Instant until, ZoneId zone) {
        return "Một vị khách định lấy một ít " + cropName + " chín trên đảo của bạn lúc " + NOTICE_TIME.format(at.atZone(zone))
                + " (giờ Việt Nam). Chó canh vườn đã sủa báo động nên không có gì bị lấy. Đảo được canh gác đến "
                + NOTICE_TIME.format(until.atZone(zone)) + ".";
    }

    static String noticeTitle() {
        return "Có người vừa lấy một ít nông sản trên đảo của bạn";
    }

    /**
     * Built only from the take that was just recorded: the taker's real public name and island handle, the crop, the
     * exact amount and the server time of the take (Vietnam time, like the rest of the garden's calendar).
     */
    static String noticeBody(Profile taker, String cropName, int portions, int unit, Instant at, ZoneId zone) {
        return "Người chơi " + taker.displayName() + " (đảo EG-" + taker.handle() + ") đã lấy " + portions + " phần " + cropName
                + " chín từ đảo của bạn lúc " + NOTICE_TIME.format(at.atZone(zone)) + " (giờ Việt Nam). " + unit
                + " phần là một nông sản: khi thu hoạch, bạn vẫn nhận đủ " + (unit - portions) + " phần còn lại của cây này.";
    }

    // ------------------------------------------------------------------ a friendly reaction

    /** One preset reaction per visitor and island per cooldown; the visitor must have visited the island. */
    public ReactionReceipt react(long userId, UUID key, String handle, String code) {
        access.require(userId);
        SocialEngine e = engine();
        if (!e.rules().reactions().contains(code)) throw new GardenException(400, "INVALID_COMMAND");
        Profile target = host(userId, handle);
        return ctx.command(userId, key, "SOCIAL_REACT", new ReactOp(target.handle(), code), ReactionReceipt.class,
                setup.ensurer(userId), (now, op) -> {
                    ensureProfile(userId, now);
                    Profile host = host(userId, target.handle());
                    var visit = repo.visit(userId, host.userId());
                    if (visit == null) throw GardenException.conflict("VISIT_FIRST");
                    Duration cooldown = Duration.ofHours(e.rules().reactionCooldownHours());
                    if (!repo.react(userId, host.userId(), code, now, now.minus(cooldown))) {
                        throw GardenException.conflict("REACTION_COOLDOWN", visit.reactionAt() == null ? Map.of()
                                : Map.of("availableAt", visit.reactionAt().plus(cooldown).toString()));
                    }
                    return new ReactionReceipt(code, now, now.plus(cooldown));
                });
    }

    // ------------------------------------------------------------------ activity record

    /**
     * The caller's own record, newest first: what was taken from their island (by whom) and what they took. Owner-only
     * by construction — the reader is the principal, there is no user parameter.
     */
    public ActivityPage activity(long userId, Long before) {
        access.require(userId);
        SocialEngine e = engine();
        int size = e.rules().activityPageSize();
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            Profile me = ensureProfile(userId, now);
            var crops = ctx.engine().rules().crops();
            var rows = repo.activity(userId, before, size + 1);
            boolean more = rows.size() > size;
            var page = more ? rows.subList(0, size) : rows;
            List<ActivityEntryView> entries = page.stream().map(a -> {
                CropDef crop = crops.get(a.cropCode());
                return new ActivityEntryView(a.id(), a.mine() ? "I_TOOK" : "TAKEN_FROM_ME", a.otherName(),
                        a.otherOpen() ? a.otherHandle() : null, a.cropCode(), crop == null ? a.cropCode() : crop.nameVi(),
                        a.portions(), a.unitPortions(), a.createdAt(), !a.mine() && a.createdAt().isAfter(me.activitySeenAt()));
            }).toList();
            List<ReactionEntryView> reactions = before != null ? List.of()
                    : repo.reactions(userId, e.rules().reactionLimit()).stream().map(r -> new ReactionEntryView(r.visitorName(),
                    r.visitorOpen() ? r.visitorHandle() : null, r.code(), r.at(), r.at().isAfter(me.activitySeenAt()))).toList();
            return new ActivityPage(entries, more ? page.getLast().id() : null, reactions,
                    repo.unread(userId, me.activitySeenAt()), me.activitySeenAt());
        });
    }

    public SocialAck activitySeen(long userId, UUID key) {
        access.require(userId);
        engine();
        return ctx.command(userId, key, "SOCIAL_SEEN", Map.of(), SocialAck.class, setup.ensurer(userId), (now, op) -> {
            ensureProfile(userId, now);
            repo.markSeen(userId, now);
            return new SocialAck(true, 0);
        });
    }
}
