package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.SprayResult;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.PestPlanner.CropHost;
import com.englishcoach.garden.domain.PestPlanner.OverdueCard;
import com.englishcoach.garden.domain.PestPlanner.Spawn;
import com.englishcoach.garden.infra.GardenRepository.Planting;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.PestRepository;
import com.englishcoach.garden.infra.PestRepository.PestRow;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Forgotten Pests (Phase 2, Layer C). {@link #reconcile} runs inside the caller's locked transaction on every state read
 * and before harvest / graduation, AFTER the review log was ingested:
 * <ol>
 *   <li>active pests whose host is gone (harvested crop, graduated / released tree) are cleared HOST_GONE; pests whose
 *   card no longer exists are cleared CARD_GONE;</li>
 *   <li>an active pest whose card was genuinely reviewed after the pest appeared is CURED there and then (Phase 4):
 *   {@code reviewed_at} = that first review, the pest is cleared {@code SPRAYED} and the capped reward is granted once.
 *   The review is the whole cure: no second action is needed, and a reload can never bring the cured pest back;</li>
 *   <li>new pests are planned from at most {@code scanLimit} overdue cards (bounded query) by {@code PestPlanner} and
 *   inserted with ON CONFLICT DO NOTHING (one active pest per card / per planting, even under concurrency). A crop a
 *   pest was cured on stays clean until it is harvested, and no crop receives a new pest during the protection period
 *   after a cure (Phase 4) — otherwise the next overdue word took the cured pest's place in the very next read and the
 *   player saw a pest that "never leaves".</li>
 * </ol>
 * Nothing accumulates while the player is away: a pest only appears at the moment of a visit.
 */
@Service
public class PestService {

    /** A pest sent away by its genuine review inside one reconcile, with the reward that was actually granted. */
    public record Cure(long pestId, int xp, boolean rewarded) {}

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final PestRepository pests;
    private final KnowledgeRepository knowledge;
    private final LearningIngestService ingest;
    private final com.englishcoach.garden.infra.FarmingRepository farmingRepo;
    private final GuardianWatch guardians;

    public PestService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                       PestRepository pests, KnowledgeRepository knowledge, LearningIngestService ingest,
                       com.englishcoach.garden.infra.FarmingRepository farmingRepo, GuardianWatch guardians) {
        this.farmingRepo = farmingRepo;
        this.guardians = guardians;
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.pests = pests;
        this.knowledge = knowledge;
        this.ingest = ingest;
    }

    /** Full reconcile (state read only): refresh existing pests, then spawn new ones the player will see. */
    public List<Cure> reconcile(long userId, Instant now) {
        return reconcile(userId, now, true);
    }

    /**
     * Refresh only (commands: harvest, graduation, essence, spray): clears / cures existing pests but never spawns,
     * so no pest can appear unseen in the middle of an action and change its outcome.
     */
    public List<Cure> refresh(long userId, Instant now) {
        return reconcile(userId, now, false);
    }

    private List<Cure> reconcile(long userId, Instant now, boolean spawn) {
        var e = ctx.engine();
        var rules = e.rules().pests();
        // Phase 5: the facts a reconcile starts from, in one exchange
        if (spawn) {
            GardenScope.prefetch(() -> pests.active(userId), () -> ctx.repo.activePlantings(userId), () -> knowledge.activeTrees(userId),
                    () -> ctx.repo.profile(userId), () -> pests.overdue(userId, rules.graceHours(), rules.scanLimit()),
                    () -> guardians.pestRelief(userId, now, rules.maxCropPests()));
        } else {
            GardenScope.prefetch(() -> pests.active(userId), () -> ctx.repo.activePlantings(userId), () -> knowledge.activeTrees(userId));
        }
        List<PestRow> active = pests.active(userId);
        List<Cure> cured = new ArrayList<>();
        // a command with no pest to look after has nothing to refresh
        if (active.isEmpty() && !spawn) return cured;

        // 1 + 2: hosts, cards, review evidence
        Map<Long, Planting> plantings = new HashMap<>();
        for (Planting p : ctx.repo.activePlantings(userId)) plantings.put(p.id(), p);
        var trees = knowledge.activeTrees(userId);
        Set<Long> activeTrees = new HashSet<>();
        trees.forEach(t -> activeTrees.add(t.id()));
        Set<Long> present = new HashSet<>();
        Map<Long, Instant> firstReview = Map.of();
        // Phase 5: everything that depends only on those facts (cards of the pests, hosts of the crops), in one exchange
        List<Runnable> next = new ArrayList<>();
        if (!active.isEmpty()) {
            next.add(() -> knowledge.liveCards(userId, active.stream().map(PestRow::flashcardId).toList(), rules.graceHours()));
            next.add(() -> pests.firstReviews(userId, active.stream().filter(p -> p.reviewedAt() == null).toList()));
        }
        if (spawn) {
            if (!trees.isEmpty()) next.add(() -> knowledge.cards(userId, trees.stream().map(KnowledgeRepository.TreeRow::id).toList()));
            if (ctx.farming() != null && !plantings.isEmpty()) next.add(() -> farmingRepo.treatments(userId, plantings.keySet()));
            next.add(() -> pests.curedPlantings(userId, plantings.keySet()));
        }
        GardenScope.prefetch(next.toArray(Runnable[]::new));
        if (!active.isEmpty()) {
            knowledge.liveCards(userId, active.stream().map(PestRow::flashcardId).toList(), rules.graceHours())
                    .keySet().forEach(present::add);
            firstReview = pests.firstReviews(userId, active.stream().filter(p -> p.reviewedAt() == null).toList());
        }
        Set<Long> cardsWithPest = new HashSet<>();
        Set<Long> plantingsWithPest = new HashSet<>();
        int cropPests = 0;
        for (PestRow p : active) {
            boolean hostGone = "CROP".equals(p.host()) ? !plantings.containsKey(p.plantingId()) : !activeTrees.contains(p.treeId());
            if (hostGone) {
                pests.clear(userId, p.id(), now, "HOST_GONE", false);
                continue;
            }
            if (!present.contains(p.flashcardId())) {
                pests.clear(userId, p.id(), now, "CARD_GONE", false);
                continue;
            }
            Instant reviewed = p.reviewedAt();
            if (reviewed == null) {
                reviewed = firstReview.get(p.id());
                if (reviewed != null) pests.markReviewed(userId, p.id(), reviewed);
            }
            if (reviewed != null) {
                // the genuine review IS the cure: the pest leaves now (exactly once; the conditional clear decides)
                Cure c = cure(userId, p, now);
                if (c != null) cured.add(c);
                continue;
            }
            cardsWithPest.add(p.flashcardId());
            if (p.plantingId() != null) {
                plantingsWithPest.add(p.plantingId());
                cropPests++;
            }
        }

        // 3: spawn (state reads only, players past the tutorial)
        var profile = spawn ? ctx.repo.profile(userId) : null;
        if (profile == null || profile.onboardingStep() < GardenViews.ONBOARDING_DONE) return cured;
        var overdueRows = pests.overdue(userId, rules.graceHours(), rules.scanLimit());
        if (overdueRows.isEmpty()) return cured;
        Map<Long, Long> treeOfCard = new HashMap<>();
        if (!trees.isEmpty()) {
            knowledge.cards(userId, trees.stream().map(KnowledgeRepository.TreeRow::id).toList())
                    .forEach(c -> treeOfCard.put(c.flashcardId(), c.treeId()));
        }
        List<OverdueCard> overdue = overdueRows.stream()
                .map(r -> new OverdueCard(r.flashcardId(), r.word(), treeOfCard.get(r.flashcardId()))).toList();
        List<CropHost> hosts = plantings.values().stream()
                .map(p -> new CropHost(p.id(), p.plantedAt(), p.tutorial(), false)).toList();
        // Phase 3D: a crop under an insect net is not a host for a NEW pest while the net lasts. The overdue card stays
        // overdue (it may settle on another crop, now or later): the net protects a crop, it never touches a word.
        var farming = ctx.farming();
        if (farming != null && !hosts.isEmpty()) {
            var nets = farmingRepo.treatments(userId, plantings.keySet());
            hosts = hosts.stream().filter(h -> !farming.active(nets.getOrDefault(h.plantingId(), List.of()),
                    com.englishcoach.garden.domain.FarmingRules.Effect.PEST_NET, now)).toList();
        }
        // Phase 3H: a fed farm cat keeps crop places free of NEW pests (never all of them). It touches no word: the
        // overdue card stays overdue, tree pests and every existing pest are unaffected, the review cure is unchanged.
        int kept = guardians.pestRelief(userId, now, rules.maxCropPests());
        // Phase 4: a crop that was cured stays clean until it is harvested, and after a cure no crop receives a new pest
        // for the protection period. Without both, the read that followed a cure handed the same bed to the next overdue
        // word: an identical caterpillar on the same crop. Tree pests are unaffected (a tree pest is its own word, which
        // the review has just rescheduled). The overdue words themselves stay overdue: nothing is forgiven.
        Map<Long, Instant> curedCrops = pests.curedPlantings(userId, plantings.keySet());
        plantingsWithPest.addAll(curedCrops.keySet());
        Instant lastCure = curedCrops.values().stream().max(Instant::compareTo).orElse(null);
        boolean quiet = lastCure != null && now.isBefore(lastCure.plus(Duration.ofMinutes(rules.protectMinutes())));
        int taken = quiet ? Math.max(rules.maxCropPests(), cropPests + kept) : cropPests + kept;
        for (Spawn s : e.pests().plan(overdue, cardsWithPest, hosts, plantingsWithPest, taken, now)) {
            Long id = pests.insert(userId, s.flashcardId(), s.word(), s.host(), s.plantingId(), s.treeId(), now);
            if (id != null) {
                ctx.repo.log(userId, "PEST_SPAWN", ctx.write(Map.of("pestId", id, "host", s.host().name(),
                        "card", s.flashcardId())), now);
            }
        }
        return cured;
    }

    /**
     * Sends one reviewed pest away: cleared {@code SPRAYED} exactly once (conditional update under the owner lock), the
     * reward granted with it at most {@code cureDailyCap} times per garden day. Null when it had already been cleared.
     */
    private Cure cure(long userId, PestRow p, Instant now) {
        var rules = ctx.engine().rules().pests();
        var day = ctx.engine().calendar().dayKey(now);
        boolean reward = ctx.repo.daily(userId, day).pestCures() < rules.cureDailyCap();
        if (!pests.clear(userId, p.id(), now, "SPRAYED", reward)) return null;
        int xp = 0;
        if (reward) {
            ctx.repo.addDailyCounters(userId, day, 0, 0, 0, 1);
            ledger.addXp(userId, rules.cureXp(), "PEST_CURE", "PEST", String.valueOf(p.id()), null, now);
            xp = rules.cureXp();
        }
        ctx.repo.log(userId, "PEST_CURE", ctx.write(Map.of("pestId", p.id(), "xp", xp)), now);
        return new Cure(p.id(), xp, reward);
    }

    /**
     * "Xua sâu" / the garden's rescue review: confirms that a pest has left. The cure itself is the genuine review of
     * the pest's word after it appeared, applied by {@link #refresh} in this same transaction; the result reports the
     * reward that cure granted. 409 PEST_NEEDS_REVIEW while the review log holds no such review (no currency bypass);
     * 409 PEST_GONE when the pest had already left before this request (an earlier read or command cured it).
     */
    public SprayResult spray(long userId, UUID key, long pestId) {
        access.require(userId);
        return ctx.command(userId, key, "PEST_SPRAY", Map.of("pestId", pestId), SprayResult.class, setup.ensurer(userId), (now, op) -> {
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            Cure mine = refresh(userId, now).stream().filter(c -> c.pestId() == pestId).findFirst().orElse(null);
            if (mine != null) return new SprayResult(pestId, mine.xp(), mine.rewarded(), ctx.repo.profile(userId).totalXp());
            PestRow p = pests.pest(userId, pestId);
            if (p.clearedAt() != null) throw GardenException.conflict("PEST_GONE");
            throw GardenException.conflict("PEST_NEEDS_REVIEW", Map.of("flashcardId", p.flashcardId()));
        });
    }
}
