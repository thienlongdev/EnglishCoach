package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.AnswerView;
import com.englishcoach.garden.api.GardenDtos.ComponentsView;
import com.englishcoach.garden.api.GardenDtos.HarvestChallenge;
import com.englishcoach.garden.api.GardenDtos.HarvestCompleteRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestLine;
import com.englishcoach.garden.api.GardenDtos.HarvestResult;
import com.englishcoach.garden.api.GardenDtos.HarvestStartRequest;
import com.englishcoach.garden.api.GardenDtos.LevelChange;
import com.englishcoach.garden.api.GardenDtos.QuestionView;
import com.englishcoach.garden.api.GardenDtos.RecallView;
import com.englishcoach.garden.api.GardenDtos.UnlockView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.ChallengeGenerator.Question;
import com.englishcoach.garden.domain.ChallengeGenerator.Word;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.QualityCalculator;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Harvest through three recall questions (GDD 01 §4.7, 03 §8). {@code start} validates that every planting is the
 * caller's and ready, then stores a challenge whose answers never leave the server. {@code complete} grades it and,
 * in ONE transaction, closes the challenge (once, before expiry), closes every planting (conditional
 * {@code harvested_at IS NULL}), adds the produce, records codex forms and grants XP. Answers are written only to
 * the garden — never to the Flashcard scheduler — and garden actions never become learning events.
 *
 * <p>Phase 2: growth includes pest slowdowns; before grading, the review log is ingested and pests are reconciled so a
 * word reviewed a minute ago already counts (clean harvest). A harvest inside a rainbow window uses the rainbow
 * mutation chance and records the RAINBOW codex form. The tier-adjusted crop XP passes through the day's diminishing
 * schedule (codex discoveries keep their full value). Crop pests leave with the harvest.
 */
@Service
public class HarvestService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final GardenViews views;
    private final LearningIngestService ingest;
    private final PestService pests;
    private final com.englishcoach.garden.infra.PestRepository pestRepo;
    private final CollectionService collection;
    private final com.englishcoach.garden.infra.FarmingRepository farmingRepo;
    private final HarvestShares shares;

    public HarvestService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                          GardenViews views, LearningIngestService ingest, PestService pests,
                          com.englishcoach.garden.infra.PestRepository pestRepo, CollectionService collection,
                          com.englishcoach.garden.infra.FarmingRepository farmingRepo, HarvestShares shares) {
        this.farmingRepo = farmingRepo;
        this.shares = shares;
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.views = views;
        this.ingest = ingest;
        this.pests = pests;
        this.pestRepo = pestRepo;
        this.collection = collection;
    }

    public HarvestChallenge start(long userId, UUID key, HarvestStartRequest request) {
        access.require(userId);
        List<Long> ids = new ArrayList<>(new LinkedHashSet<>(request.plantingIds()));
        return ctx.command(userId, key, "HARVEST_START", ids, HarvestChallenge.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var repo = ctx.repo;
            // Phase 5: every crop of the basket and the words of the quiz in two exchanges (they were one per statement)
            List<Runnable> first = new ArrayList<>();
            for (long id : ids) first.add(() -> views.facts(userId, repo.activePlanting(userId, id), now));
            first.add(() -> repo.recallGroups(userId, e.rules().challenge().recentDays()));
            GardenScope.prefetch(2, first.toArray(Runnable[]::new));
            for (long id : ids) {
                var p = repo.activePlanting(userId, id);
                var snap = e.growth().evaluate(views.facts(userId, p, now), now);
                if (!snap.ready()) throw GardenException.conflict("NOT_READY", Map.of("plantingId", id));
            }
            UUID challengeId = UUID.randomUUID();
            List<List<Word>> groups = new ArrayList<>(repo.recallGroups(userId, e.rules().challenge().recentDays()));
            List<Word> pool = repo.starterVocabulary(challengeId.toString(), 40);
            List<Word> distractors = new ArrayList<>();
            groups.forEach(distractors::addAll);
            distractors.addAll(pool);
            groups.add(pool);
            List<Question> questions = e.challenges().generate(groups, distractors, challengeId.toString());
            Instant expires = now.plusSeconds(e.rules().challenge().expirySeconds());
            repo.insertChallenge(userId, challengeId, ids, ctx.write(questions), now, expires);
            List<QuestionView> views = new ArrayList<>();
            for (int i = 0; i < questions.size(); i++) {
                Question q = questions.get(i);
                views.add(new QuestionView(i, q.direction().name(), q.prompt(), q.ipa(), q.options()));
            }
            return new HarvestChallenge(challengeId, expires, ids, views);
        });
    }

    public HarvestResult complete(long userId, UUID key, HarvestCompleteRequest request) {
        access.require(userId);
        return ctx.command(userId, key, "HARVEST_COMPLETE", request, HarvestResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var repo = ctx.repo;
            var ch = repo.challenge(userId, request.challengeId());
            if (ch.completedAt() != null) throw GardenException.conflict("CHALLENGE_DONE");
            if (!now.isBefore(ch.expiresAt())) throw GardenException.conflict("CHALLENGE_EXPIRED");
            List<Question> questions = read(ch.questions());
            // a word reviewed moments ago must already make this harvest clean
            ingest.ingest(userId, repo.profile(userId), now);
            pests.refresh(userId, now);
            var pestsByPlanting = views.pestsOf(userId, ch.targetIds());
            boolean rainbow = e.weather().at(now) == com.englishcoach.garden.domain.WeatherCalendar.Weather.RAINBOW;
            var day = e.calendar().dayKey(now);
            double rawXpToday = repo.daily(userId, day).harvestXpRaw();
            // Phase 3C: the cottage keeps ripe crops fresh longer; the damage stage of a pest decides the pest score
            double freshBonus = ctx.perks(userId).freshBonus();
            var estate = ctx.estate();
            double rawXpAdded = 0;
            // Phase 3D: the soil decides the care part, a spray softens an unresolved pest, a closed harvest pays a small
            // coin bonus (once per planting, capped per Vietnam day)
            var farming = ctx.farming();
            int bonusPaidToday = farming == null ? 0 : farmingRepo.harvestBonusPaid(userId, day);
            int bonusAdded = 0;

            // grade (skip ⇒ recall 0)
            List<AnswerView> answers = new ArrayList<>();
            int correct = 0;
            for (int i = 0; i < questions.size(); i++) {
                Integer chosen = request.answers() != null && i < request.answers().size() ? request.answers().get(i) : null;
                boolean ok = !request.skip() && chosen != null && chosen == questions.get(i).answer();
                if (ok) correct++;
                answers.add(new AnswerView(i, request.skip() ? null : chosen, questions.get(i).answer(), ok));
            }
            var recall = new RecallView(correct, questions.size(), request.skip(), answers);

            List<HarvestLine> lines = new ArrayList<>();
            long xp = 0;
            boolean moonlit = e.calendar().moonlit(now);
            // Phase 5: every crop of the basket is READ before the first one is closed (two exchanges for all of them,
            // where each crop used to cost four in the middle of the writes). Nothing below changes what these reads
            // return for another crop of the basket, and the conditional close of each planting still decides alone.
            record Ripe(com.englishcoach.garden.infra.GardenRepository.Planting planting, GardenViews.Growing growing,
                        com.englishcoach.garden.domain.GrowthCalculator.Snapshot snap, int takenPortions) {}
            List<Runnable> basket = new ArrayList<>();
            for (long pid : ch.targetIds()) {
                basket.add(() -> views.growing(userId, repo.activePlanting(userId, pid), now));
                basket.add(() -> shares.taken(pid));
            }
            GardenScope.prefetch(2, basket.toArray(Runnable[]::new));
            Map<Long, Ripe> ripe = new LinkedHashMap<>();
            for (long pid : ch.targetIds()) {
                var planting = repo.activePlanting(userId, pid);
                var facts = views.growing(userId, planting, now);
                var ready = e.growth().evaluate(facts.facts(), now);
                if (!ready.ready()) throw GardenException.conflict("NOT_READY", Map.of("plantingId", pid));
                ripe.put(pid, new Ripe(planting, facts, ready, shares.taken(pid)));
            }
            for (long pid : ch.targetIds()) {
                var p = ripe.get(pid).planting();
                CropDef crop = e.rules().crop(p.cropCode());
                var growing = ripe.get(pid).growing();
                var snap = ripe.get(pid).snap();
                int pestScore = estate.harvestPestScore(pestsByPlanting.getOrDefault(pid, List.of()), now, e.rules().quality().pestClean());
                if (farming != null) {
                    pestScore = farming.sprayedPestScore(pestScore, growing.treatments(), now, e.rules().quality().pestClean());
                }
                boolean clean = pestScore >= e.rules().quality().pestClean();
                boolean tended = p.waterCount() > 0 || p.fertilizerCode() != null;
                int carePoints = tended ? e.rules().quality().cared() : 0;
                com.englishcoach.garden.domain.FarmingEngine.Care care = null;
                if (farming != null && growing.soil() != null) {
                    // growth model 2: any supply counts as tending; the soil the crop RIPENED with scales the points
                    tended = tended || !growing.treatments().isEmpty();
                    care = farming.care(tended, growing.soil().at(snap.readyAt()),
                            farming.everApplied(growing.treatments(), com.englishcoach.garden.domain.FarmingRules.Effect.TONIC, now));
                    carePoints = care.points();
                }
                var q = e.quality().score(new QualityCalculator.Input(correct, request.skip(), clean,
                        e.quality().seasonFit(crop, p.plantedAt(), now), tended,
                        e.quality().fresh(p.baseSeconds(), snap.readyAt(), now, freshBonus)), pestScore, carePoints);
                // a crop that spent most of its growth thirsty or waterlogged is capped at a lower tier (never destroyed)
                if (care != null) q = farming.capped(q, care);
                int bonus = farming == null ? 0 : farming.grantedBonus(farming.harvestBonus(crop), bonusPaidToday + bonusAdded);
                boolean mutated = e.quality().mutated(pid, rainbow);
                Map<String, Object> flags = new LinkedHashMap<>();
                flags.put("mutated", mutated);
                flags.put("moonlit", moonlit);
                flags.put("rainbow", rainbow);
                flags.put("pestClean", clean);
                flags.put("recallCorrect", correct);
                flags.put("skipped", request.skip());
                if (farming != null) flags.put("bonusCoins", bonus);
                if (care != null) {
                    flags.put("stressShare", Math.round(care.stressShare() * 1000) / 1000.0);
                    flags.put("soilCapped", care.tierCap() != null);
                }
                if (!repo.markHarvested(userId, pid, now, q.tier().code(), q.total(), ctx.write(flags))) {
                    throw GardenException.conflict("ALREADY_HARVESTED");
                }
                // Phase 3G: a visitor may have taken a little from this crop. The planting was closed exactly once just
                // above and takes are serialised against this transaction (both hold this garden's lock), so the unit
                // is split exactly once: the taker already holds their portions, the harvest pays the rest.
                int takenPortions = ripe.get(pid).takenPortions();
                int sharePortions = 0;
                if (takenPortions > 0) {
                    sharePortions = shares.creditRemainder(userId, crop.code(), q.tier().code(), takenPortions, pid, op, now);
                } else {
                    ledger.addItem(userId, "CROP:" + crop.code(), q.tier().code(), 1, "HARVEST", "PLANTING", String.valueOf(pid), op, now);
                }
                // the planting was closed exactly once just above, so its bonus is paid exactly once
                ledger.addCoins(userId, bonus, "HARVEST_BONUS", "PLANTING", String.valueOf(pid), op, now);
                bonusAdded += bonus;
                pestRepo.clearForPlanting(userId, pid, now);
                int raw = e.quality().harvestXp(crop, q.tier());
                int lineXp = e.rewards().harvestXpGain(rawXpToday + rawXpAdded, raw);
                rawXpAdded += raw;
                List<String> forms = new ArrayList<>(List.of(q.tier().code()));
                if (moonlit) forms.add("MOONLIT");
                if (rainbow) forms.add("RAINBOW");
                if (mutated) forms.add("MUTATED");
                List<String> newForms = new ArrayList<>();
                for (String f : forms) {
                    if (repo.recordCodexForm(userId, crop.code(), f, now)) {
                        newForms.add(f);
                        lineXp += e.rules().quality().newFormXp();
                    }
                }
                xp += lineXp;
                // Phase 3B: this planting was closed exactly once above, so the harvest counts for mastery exactly once
                collection.onHarvest(userId, crop, q.tier(), now);
                repo.log(userId, "HARVEST", ctx.write(Map.of("plantingId", pid, "crop", crop.code(), "tier", q.tier().code(),
                        "score", q.total(), "recallCorrect", correct, "skipped", request.skip())), now);
                lines.add(new HarvestLine(pid, p.plotId(), crop.code(), q.tier().code(), q.total(),
                        new ComponentsView(q.recall(), q.pest(), q.season(), q.care(), q.fresh()), mutated, moonlit, lineXp,
                        newForms, rainbow, bonus, sharePortions, sharePortions > 0 ? shares.unit() : 0));
            }
            if (rawXpAdded > 0) repo.addDailyCounters(userId, day, 0, 0, rawXpAdded, 0);
            if (bonusAdded > 0) farmingRepo.addHarvestBonus(userId, day, bonusAdded);
            if (!repo.completeChallenge(userId, ch.id(), now, ctx.write(recall))) throw GardenException.conflict("CHALLENGE_EXPIRED");
            var step = ledger.addXp(userId, xp, "HARVEST", "CHALLENGE", ch.id().toString(), op, now);
            List<UnlockView> unlocked = new ArrayList<>();
            for (int l = step.levelBefore() + 1; l <= step.levelAfter(); l++) {
                e.levels().unlocksAt(l).forEach(c -> unlocked.add(new UnlockView(c.unlockLevel(), c.code(), c.nameVi())));
            }
            return new HarvestResult(ch.id(), recall, lines, xp, new LevelChange(step.levelBefore(), step.levelAfter(), unlocked),
                    bonusAdded, repo.profile(userId).coins());
        });
    }

    private List<Question> read(String json) {
        try {
            return ctx.json.readValue(json, new TypeReference<List<Question>>() {});
        } catch (Exception e) {
            throw new IllegalStateException("stored challenge unreadable", e);
        }
    }
}
