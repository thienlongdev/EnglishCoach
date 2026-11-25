package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.AnswerView;
import com.englishcoach.garden.api.GardenDtos.CandidateView;
import com.englishcoach.garden.api.GardenDtos.CandidatesView;
import com.englishcoach.garden.api.GardenDtos.DeckView;
import com.englishcoach.garden.api.GardenDtos.EssenceResult;
import com.englishcoach.garden.api.GardenDtos.EssenceView;
import com.englishcoach.garden.api.GardenDtos.ForestPage;
import com.englishcoach.garden.api.GardenDtos.ForestTreeView;
import com.englishcoach.garden.api.GardenDtos.GraduationChallenge;
import com.englishcoach.garden.api.GardenDtos.GraduationCompleteRequest;
import com.englishcoach.garden.api.GardenDtos.GraduationResult;
import com.englishcoach.garden.api.GardenDtos.GraduationView;
import com.englishcoach.garden.api.GardenDtos.KnowledgePlantRequest;
import com.englishcoach.garden.api.GardenDtos.KnowledgeResult;
import com.englishcoach.garden.api.GardenDtos.KnowledgeView;
import com.englishcoach.garden.api.GardenDtos.LevelChange;
import com.englishcoach.garden.api.GardenDtos.NextStageView;
import com.englishcoach.garden.api.GardenDtos.QuestionView;
import com.englishcoach.garden.api.GardenDtos.RecallView;
import com.englishcoach.garden.api.GardenDtos.SlotView;
import com.englishcoach.garden.api.GardenDtos.TreeCardView;
import com.englishcoach.garden.api.GardenDtos.TreeView;
import com.englishcoach.garden.api.GardenDtos.UnlockView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.ChallengeGenerator.Question;
import com.englishcoach.garden.domain.ChallengeGenerator.Word;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.KnowledgeEvaluator.CardFacts;
import com.englishcoach.garden.domain.KnowledgeEvaluator.Evaluation;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.KnowledgeRepository.Candidate;
import com.englishcoach.garden.infra.KnowledgeRepository.TreeCardRow;
import com.englishcoach.garden.infra.KnowledgeRepository.TreeRow;
import com.englishcoach.garden.infra.PestRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Knowledge Trees and the Memory Forest (Phase 2, Layer B). A tree binds five of the player's OWN flashcards; its
 * stage is evidence of genuine reviews of those cards after planting (KnowledgeEvaluator), its essence accrues from
 * server time, and graduation is a five-word recall challenge whose answers stay on the server. Answers never touch
 * the Flashcard scheduler; the Flashcard module is only read.
 */
@Service
public class KnowledgeService {

    public static final int FOREST_PAGE = 20;
    private static final int FOREST_RECENT = 12;

    /** One evaluated active tree (facts + evaluation), shared by views, pests and graduation. */
    public record TreeEval(TreeRow row, List<TreeCardRow> cards, Evaluation ev, Map<Long, KnowledgeRepository.LiveCard> live,
                           Map<Long, KnowledgeRepository.ReviewEvidence> evidence, double essenceAccrued, Instant essenceFullAt,
                           List<Long> pestIds) {}

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final KnowledgeRepository repo;
    private final PestRepository pests;
    private final PestService pestService;
    private final LearningIngestService ingest;

    public KnowledgeService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                            KnowledgeRepository repo, PestRepository pests, PestService pestService,
                            LearningIngestService ingest) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.repo = repo;
        this.pests = pests;
        this.pestService = pestService;
        this.ingest = ingest;
    }

    public static String species(Season theme) {
        return switch (theme) {
            case LU_HANH -> "SPRING";
            case CONG_SO -> "SUMMER";
            case HOC_THUAT -> "AUTUMN";
            case THANH_NGU -> "WINTER";
            case ALL -> "SUMMER";
        };
    }

    // ------------------------------------------------------------------ evaluation

    /**
     * Evaluates every active tree at {@code now}. A higher stage than the stored peak is persisted (peak never lowers)
     * and the essence of the previous stage is banked at that moment, so accrual is exact per stage.
     */
    public List<TreeEval> evaluateActive(long userId, Instant now) {
        var e = ctx.engine();
        var k = e.knowledge();
        List<TreeRow> trees = repo.activeTrees(userId);
        if (trees.isEmpty()) return List.of();
        List<TreeCardRow> cards = repo.cards(userId, trees.stream().map(TreeRow::id).toList());
        Set<Long> ids = new HashSet<>();
        cards.forEach(c -> ids.add(c.flashcardId()));
        // Phase 5: the live cards, the pests and the review evidence of EVERY tree in one exchange (it was one per tree)
        List<Runnable> treeFacts = new ArrayList<>();
        treeFacts.add(() -> repo.liveCards(userId, ids, e.rules().pests().graceHours()));
        treeFacts.add(() -> pests.active(userId));
        for (TreeRow t : trees) {
            treeFacts.add(() -> repo.reviewEvidence(userId,
                    cards.stream().filter(c -> c.treeId() == t.id()).map(TreeCardRow::flashcardId).toList(), t.plantedAt(), e.rules().zone()));
        }
        GardenScope.prefetch(treeFacts.toArray(Runnable[]::new));
        var live = repo.liveCards(userId, ids, e.rules().pests().graceHours());
        Map<Long, List<Long>> pestsByTree = new HashMap<>();
        pests.active(userId).forEach(p -> {
            if (p.treeId() != null) pestsByTree.computeIfAbsent(p.treeId(), x -> new ArrayList<>()).add(p.id());
        });
        List<TreeEval> out = new ArrayList<>();
        for (TreeRow t : trees) {
            List<TreeCardRow> own = cards.stream().filter(c -> c.treeId() == t.id()).toList();
            var evidence = repo.reviewEvidence(userId, own.stream().map(TreeCardRow::flashcardId).toList(), t.plantedAt(), e.rules().zone());
            List<CardFacts> facts = own.stream().map(c -> {
                var l = live.get(c.flashcardId());
                var ev = evidence.get(c.flashcardId());
                return new CardFacts(c.flashcardId(), c.word(), c.meaningVi(), l != null, l == null ? null : l.status(),
                        l != null && l.overdue(), ev == null ? 0 : ev.days(), ev == null ? null : ev.lastAt());
            }).toList();
            List<Long> treePests = pestsByTree.getOrDefault(t.id(), List.of());
            Evaluation ev = k.evaluate(t.plantedAt(), t.peakStage(), facts, now, !treePests.isEmpty(), t.retryAt());
            TreeRow row = t;
            if (ev.stage() > t.peakStage()) {
                double banked = k.essenceAccrued(t.essenceBanked(), t.essenceSince(), t.peakStage(), now);
                repo.raisePeak(userId, t.id(), ev.stage(), banked, now);
                ctx.repo.log(userId, "TREE_STAGE", ctx.write(Map.of("treeId", t.id(), "stage", ev.stage())), now);
                row = new TreeRow(t.id(), t.slot(), t.species(), t.plantedAt(), t.status(), ev.stage(), banked, now,
                        t.attempts(), t.retryAt(), t.graduatedAt());
            }
            double accrued = k.essenceAccrued(row.essenceBanked(), row.essenceSince(), row.peakStage(), now);
            out.add(new TreeEval(row, own, ev, live, evidence, accrued,
                    k.essenceFullAt(row.essenceBanked(), row.essenceSince(), row.peakStage(), now), treePests));
        }
        return out;
    }

    public KnowledgeView view(long userId, Instant now, int level, List<TreeEval> evals) {
        var rules = ctx.engine().rules().knowledge();
        var k = ctx.engine().knowledge();
        LocalDate today = ctx.engine().calendar().dayKey(now);
        Map<Integer, TreeEval> bySlot = new HashMap<>();
        evals.forEach(t -> bySlot.put(t.row().slot(), t));
        List<SlotView> slots = new ArrayList<>();
        for (int i = 0; i < rules.slotLevels().size(); i++) {
            int slot = i + 1;
            int unlock = rules.slotLevels().get(i);
            TreeEval t = bySlot.get(slot);
            slots.add(new SlotView(slot, unlock, level >= unlock, t == null ? null : tree(t, now, today)));
        }
        GardenScope.prefetch(() -> repo.forest(userId, null, FOREST_RECENT), () -> repo.forestCount(userId), () -> repo.forestSpecies(userId));
        List<ForestTreeView> recent = forestViews(userId, repo.forest(userId, null, FOREST_RECENT));
        return new KnowledgeView(slots, repo.forestCount(userId), repo.forestSpecies(userId), recent);
    }

    private TreeView tree(TreeEval t, Instant now, LocalDate today) {
        var k = ctx.engine().knowledge();
        var g = ctx.engine().rules().knowledge().graduation();
        var ev = t.ev();
        List<TreeCardView> cards = new ArrayList<>();
        for (var r : ev.cards()) {
            var f = r.facts();
            var live = t.live().get(f.flashcardId());
            boolean reviewedToday = f.lastReviewAt() != null && ctx.engine().calendar().dayKey(f.lastReviewAt()).equals(today);
            cards.add(new TreeCardView(f.flashcardId(), f.word(), f.meaningVi(), f.present(), f.status(),
                    live != null && live.due(), f.overdue(), f.reviewDays(), r.evidence(), r.needsAttention(),
                    r.qualifies(), reviewedToday));
        }
        int stage = t.row().peakStage();
        boolean claimable = ev.health() == com.englishcoach.garden.domain.KnowledgeEvaluator.Health.HEALTHY
                && t.pestIds().isEmpty() && Math.floor(t.essenceAccrued() + 1e-9) >= 1;
        var essence = new EssenceView((int) Math.floor(t.essenceAccrued() + 1e-9), round2(t.essenceAccrued()),
                k.essencePerDay(stage), k.essenceStore(stage), t.essenceFullAt(), claimable);
        var grad = new GraduationView(ev.graduationEligible(), ev.blockers(), ev.ageReachedAt(), t.row().retryAt(),
                t.row().attempts(), g.questions(), g.pass());
        var next = ev.next() == null ? null : new NextStageView(ev.next().stage(), ev.next().evidenceMissing(),
                ev.next().reachableAt(), ev.next().cardsBelowMinimum());
        return new TreeView(t.row().id(), t.row().slot(), t.row().species(), t.row().plantedAt(), ev.ageDays(), stage,
                ev.evidence(), ev.maxEvidence(), ev.health().name(), ev.attention(), cards, essence, grad, next, t.pestIds());
    }

    private List<ForestTreeView> forestViews(long userId, List<TreeRow> trees) {
        if (trees.isEmpty()) return List.of();
        var cards = repo.cards(userId, trees.stream().map(TreeRow::id).toList());
        return trees.stream().map(t -> new ForestTreeView(t.id(), t.species(), t.plantedAt(), t.graduatedAt(),
                cards.stream().filter(c -> c.treeId() == t.id()).map(TreeCardRow::word).toList())).toList();
    }

    // ------------------------------------------------------------------ queries

    public CandidatesView candidates(long userId, Long deckId, String search) {
        access.require(userId);
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            var rules = ctx.engine().rules();
            int limit = rules.knowledge().candidateLimit();
            var decks = repo.decks(userId).stream().map(d -> new DeckView(d.deckId(), d.title(), d.cards())).toList();
            var cards = repo.candidates(userId, deckId, search, rules.pests().graceHours(), limit).stream()
                    .map(c -> new CandidateView(c.flashcardId(), c.word(), c.meaningVi(), c.ipa(), c.status(), c.deckId(),
                            c.deckTitle(), c.overdue(), c.bound())).toList();
            return new CandidatesView(decks, cards, limit);
        });
    }

    public ForestPage forest(long userId, Long before) {
        access.require(userId);
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            var rows = repo.forest(userId, before, FOREST_PAGE + 1);
            boolean more = rows.size() > FOREST_PAGE;
            var page = more ? rows.subList(0, FOREST_PAGE) : rows;
            return new ForestPage(forestViews(userId, page), repo.forestCount(userId), more ? page.getLast().id() : null);
        });
    }

    // ------------------------------------------------------------------ commands

    public KnowledgeResult plant(long userId, UUID key, KnowledgePlantRequest request) {
        access.require(userId);
        List<Long> ids = new ArrayList<>(request.flashcardIds());
        Map<String, Object> fingerprint = Map.of("slot", request.slot(), "cards", ids);
        return ctx.command(userId, key, "TREE_PLANT", fingerprint, KnowledgeResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var rules = e.rules().knowledge();
            if (ids.size() != rules.cards() || new LinkedHashSet<>(ids).size() != ids.size()) {
                throw new GardenException(400, "TREE_NEEDS_FIVE_CARDS", Map.of("cards", rules.cards()));
            }
            int slot = request.slot();
            if (slot < 1 || slot > rules.slotLevels().size()) throw new GardenException(400, "INVALID_COMMAND");
            int level = e.levels().level(ctx.repo.profile(userId).totalXp());
            int need = rules.slotLevels().get(slot - 1);
            if (level < need) throw GardenException.conflict("SLOT_LOCKED", Map.of("level", need));
            if (repo.slotOccupied(userId, slot)) throw GardenException.conflict("SLOT_OCCUPIED");
            List<Candidate> owned = repo.ownedCards(userId, ids, e.rules().pests().graceHours());
            // a card id that is not the player's (or archived) is indistinguishable from a missing one: 404
            if (owned.size() != ids.size()) throw new GardenException(404, "CARD_NOT_FOUND");
            if (owned.stream().anyMatch(c -> c.word() == null || c.word().isBlank()
                    || c.meaningVi() == null || c.meaningVi().isBlank())) {
                throw GardenException.conflict("CARD_NO_MEANING");
            }
            List<Long> bound = repo.boundCards(userId, ids);
            if (!bound.isEmpty()) throw GardenException.conflict("CARD_BOUND", Map.of("flashcardIds", bound));
            String species = species(e.calendar().theme(now));
            long treeId = repo.insertTree(userId, slot, species, now);
            Map<Long, Candidate> byId = new HashMap<>();
            owned.forEach(c -> byId.put(c.flashcardId(), c));
            for (int i = 0; i < ids.size(); i++) {
                Candidate c = byId.get(ids.get(i));
                repo.insertCard(userId, treeId, i + 1, c.flashcardId(), trim(c.word(), 255), trim(c.meaningVi(), 255));
            }
            ctx.repo.log(userId, "TREE_PLANT", ctx.write(Map.of("treeId", treeId, "slot", slot, "species", species)), now);
            int lvl = e.levels().level(ctx.repo.profile(userId).totalXp());
            return new KnowledgeResult(view(userId, now, lvl, evaluateActive(userId, now)), ctx.repo.essence(userId), treeId);
        });
    }

    /** Collects a tree's essence: only while every word is cared for (healthy, no pest); fractions carry over. */
    public EssenceResult claimEssence(long userId, UUID key, long treeId) {
        access.require(userId);
        return ctx.command(userId, key, "TREE_ESSENCE", Map.of("treeId", treeId), EssenceResult.class, setup.ensurer(userId), (now, op) -> {
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            pestService.refresh(userId, now);
            repo.activeTree(userId, treeId);
            TreeEval t = evaluateActive(userId, now).stream().filter(x -> x.row().id() == treeId).findFirst()
                    .orElseThrow(() -> GardenException.conflict("TREE_NOT_ACTIVE"));
            if (t.ev().health() != com.englishcoach.garden.domain.KnowledgeEvaluator.Health.HEALTHY || !t.pestIds().isEmpty()) {
                throw GardenException.conflict("TREE_NEEDS_CARE", Map.of("attention", t.ev().attention()));
            }
            int amount = (int) Math.floor(t.essenceAccrued() + 1e-9);
            if (amount < 1) throw GardenException.conflict("ESSENCE_NOT_READY");
            repo.claimEssence(userId, treeId, t.essenceAccrued() - amount, now);
            ledger.addEssence(userId, amount, "ESSENCE", "TREE", String.valueOf(treeId), op, now);
            ctx.repo.log(userId, "ESSENCE_CLAIM", ctx.write(Map.of("treeId", treeId, "amount", amount)), now);
            int level = ctx.engine().levels().level(ctx.repo.profile(userId).totalXp());
            return new EssenceResult(treeId, amount, ctx.repo.essence(userId), view(userId, now, level, evaluateActive(userId, now)));
        });
    }

    /** "Nhổ cây": frees the spot and the five words (no refund, nothing else is lost). */
    public KnowledgeResult release(long userId, UUID key, long treeId) {
        access.require(userId);
        return ctx.command(userId, key, "TREE_RELEASE", Map.of("treeId", treeId), KnowledgeResult.class, setup.ensurer(userId), (now, op) -> {
            repo.activeTree(userId, treeId);
            if (!repo.release(userId, treeId, now)) throw GardenException.conflict("TREE_NOT_ACTIVE");
            repo.releaseCards(userId, treeId, now);
            pests.clearForTree(userId, treeId, now);
            ctx.repo.log(userId, "TREE_RELEASE", ctx.write(Map.of("treeId", treeId)), now);
            int level = ctx.engine().levels().level(ctx.repo.profile(userId).totalXp());
            return new KnowledgeResult(view(userId, now, level, evaluateActive(userId, now)), ctx.repo.essence(userId), treeId);
        });
    }

    public GraduationChallenge graduationStart(long userId, UUID key, long treeId) {
        access.require(userId);
        return ctx.command(userId, key, "GRADUATION_START", Map.of("treeId", treeId), GraduationChallenge.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var g = e.rules().knowledge().graduation();
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            pestService.refresh(userId, now);
            repo.activeTree(userId, treeId);
            TreeEval t = evaluateActive(userId, now).stream().filter(x -> x.row().id() == treeId).findFirst()
                    .orElseThrow(() -> GardenException.conflict("TREE_NOT_ACTIVE"));
            if (!t.ev().graduationEligible()) {
                throw GardenException.conflict("GRADUATION_NOT_READY", Map.of("blockers", t.ev().blockers()));
            }
            UUID challengeId = UUID.randomUUID();
            List<Word> words = t.cards().stream().map(c -> new Word(c.flashcardId(), c.word(), c.meaningVi(), null)).toList();
            List<Word> distractors = new ArrayList<>();
            ctx.repo.recallGroups(userId, e.rules().challenge().recentDays()).forEach(distractors::addAll);
            distractors.addAll(ctx.repo.starterVocabulary(challengeId.toString(), 40));
            List<Question> questions = e.challenges().generateFor(words, distractors, challengeId.toString(), g.reverseQuestions());
            if (questions.size() != words.size()) throw GardenException.conflict("CHALLENGE_UNAVAILABLE");
            Instant expires = now.plusSeconds(e.rules().challenge().expirySeconds());
            ctx.repo.insertChallenge(userId, challengeId, "GRADUATION", List.of(treeId), ctx.write(questions), now, expires);
            List<QuestionView> views = new ArrayList<>();
            for (int i = 0; i < questions.size(); i++) {
                Question q = questions.get(i);
                views.add(new QuestionView(i, q.direction().name(), q.prompt(), q.ipa(), q.options()));
            }
            return new GraduationChallenge(challengeId, expires, treeId, views, g.pass());
        });
    }

    public GraduationResult graduationComplete(long userId, UUID key, GraduationCompleteRequest request) {
        access.require(userId);
        return ctx.command(userId, key, "GRADUATION_COMPLETE", request, GraduationResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var g = e.rules().knowledge().graduation();
            var ch = ctx.repo.challenge(userId, request.challengeId(), "GRADUATION");
            if (ch.completedAt() != null) throw GardenException.conflict("CHALLENGE_DONE");
            if (!now.isBefore(ch.expiresAt())) throw GardenException.conflict("CHALLENGE_EXPIRED");
            long treeId = ch.targetIds().getFirst();
            repo.activeTree(userId, treeId);
            List<Question> questions = read(ch.questions());
            List<AnswerView> answers = new ArrayList<>();
            int correct = 0;
            for (int i = 0; i < questions.size(); i++) {
                Integer chosen = request.answers() != null && i < request.answers().size() ? request.answers().get(i) : null;
                boolean ok = chosen != null && chosen == questions.get(i).answer();
                if (ok) correct++;
                answers.add(new AnswerView(i, chosen, questions.get(i).answer(), ok));
            }
            var recall = new RecallView(correct, questions.size(), false, answers);
            boolean passed = correct >= g.pass();
            if (!ctx.repo.completeChallenge(userId, ch.id(), now, ctx.write(recall))) throw GardenException.conflict("CHALLENGE_EXPIRED");
            long xp = 0;
            int essence = 0;
            Map<String, Integer> items = Map.of();
            Instant retryAt = null;
            int current = e.levels().level(ctx.repo.profile(userId).totalXp());
            var level = new LedgerService.LevelStep(0, 0, current, current);
            if (passed) {
                if (!repo.graduate(userId, treeId, now)) throw GardenException.conflict("TREE_NOT_ACTIVE");
                repo.releaseCards(userId, treeId, now);
                pests.clearForTree(userId, treeId, now);
                String ref = String.valueOf(treeId);
                level = ledger.addXp(userId, g.xp(), "GRADUATION", "TREE", ref, op, now);
                ledger.addEssence(userId, g.essence(), "GRADUATION", "TREE", ref, op, now);
                for (var item : g.items().entrySet()) {
                    ledger.addItem(userId, item.getKey(), "NA", item.getValue(), "GRADUATION", "TREE", ref, op, now);
                }
                xp = g.xp();
                essence = g.essence();
                items = g.items();
                ctx.repo.log(userId, "TREE_GRADUATED", ctx.write(Map.of("treeId", treeId, "correct", correct)), now);
            } else {
                retryAt = now.plusSeconds(g.retryMinutes() * 60L);
                repo.recordFailedGraduation(userId, treeId, retryAt);
                ctx.repo.log(userId, "GRADUATION_FAILED", ctx.write(Map.of("treeId", treeId, "correct", correct)), now);
            }
            List<UnlockView> unlocked = new ArrayList<>();
            for (int l = level.levelBefore() + 1; l <= level.levelAfter(); l++) {
                e.levels().unlocksAt(l).forEach(c -> unlocked.add(new UnlockView(c.unlockLevel(), c.code(), c.nameVi())));
            }
            int lvl = e.levels().level(ctx.repo.profile(userId).totalXp());
            return new GraduationResult(ch.id(), treeId, passed, recall, g.pass(), xp, essence, items,
                    new LevelChange(level.levelBefore(), level.levelAfter(), unlocked), retryAt,
                    view(userId, now, lvl, evaluateActive(userId, now)));
        });
    }

    private List<Question> read(String json) {
        try {
            return ctx.json.readValue(json, new TypeReference<List<Question>>() {});
        } catch (Exception ex) {
            throw new IllegalStateException("stored challenge unreadable", ex);
        }
    }

    private static String trim(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static double round2(double v) {
        return Math.round(v * 100) / 100.0;
    }
}
