package com.englishcoach.flashcard.memory;

import com.englishcoach.reading.service.ContextTranslationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.Collectors;

/**
 * Echo Memory Tides 2.0 (owner brief 2026-11-12): card evolution, Memory Reef, weak words, Card Fusion, Memory Forge and
 * Echo AI Card Studio. Every read is scoped to the principal's own active cards ({@code user_id = ?} and {@code state = 0});
 * SYSTEM decks and shared dictionary rows are only read. The only writes are {@code flashcard_fusions} rows for a Fusion
 * sentence the AI check accepted. The review schedule (FlashcardService#review) is never touched here, and no Studio
 * draft is ever saved here: the learner saves approved cards through the existing POST /flashcards boundary.
 */
@Slf4j
@Service
public class FlashcardMemoryService {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ContextTranslationService ai;
    private final FlashcardReviewLog reviewLog;

    public FlashcardMemoryService(JdbcTemplate jdbc, ObjectMapper mapper, ContextTranslationService ai, FlashcardReviewLog reviewLog) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.ai = ai;
        this.reviewLog = reviewLog;
    }

    // ───────────────────────────── evidence ─────────────────────────────

    /** Per active card: its logged ratings grouped by (quality, local day), and the latest rating. */
    private static final class CardLog {
        int total;
        final Set<LocalDate> recallDays = new TreeSet<>();
        final Set<LocalDate> hardDays = new TreeSet<>();
        Timestamp lastAt;
        String latest;
    }

    private Map<Long, CardLog> logs(long userId, Collection<Long> onlyIds) {
        Map<Long, CardLog> out = new HashMap<>();
        String filter = onlyIds == null ? "" : " AND l.flashcard_id IN (" + placeholders(onlyIds.size()) + ")";
        List<Object> args = new ArrayList<>();
        args.add(userId);
        args.add(userId);
        if (onlyIds != null) args.addAll(onlyIds);
        jdbc.query("SELECT l.flashcard_id, l.quality, l.review_local_day, count(*) AS c, max(l.reviewed_at) AS last_at "
                        + "FROM public.flashcard_review_log l JOIN public.flashcards f ON f.id = l.flashcard_id AND f.user_id = ? AND f.state = 0 "
                        + "WHERE l.user_id = ?" + filter + " GROUP BY l.flashcard_id, l.quality, l.review_local_day LIMIT 60000",
                rs -> {
                    CardLog c = out.computeIfAbsent(rs.getLong(1), k -> new CardLog());
                    String q = rs.getString(2);
                    LocalDate day = rs.getDate(3).toLocalDate();
                    c.total += rs.getInt(4);
                    if ("hard".equals(q)) c.hardDays.add(day); else c.recallDays.add(day);
                    Timestamp at = rs.getTimestamp(5);
                    if (c.lastAt == null || at.after(c.lastAt)) { c.lastAt = at; c.latest = q; }
                }, args.toArray());
        return out;
    }

    private Set<Long> fusedCards(long userId, Collection<Long> onlyIds) {
        Set<Long> out = new HashSet<>();
        if (onlyIds != null && onlyIds.isEmpty()) return out;
        String filter = onlyIds == null ? "" : " AND (card_low_id IN (" + placeholders(onlyIds.size()) + ") OR card_high_id IN (" + placeholders(onlyIds.size()) + "))";
        List<Object> args = new ArrayList<>();
        args.add(userId);
        if (onlyIds != null) { args.addAll(onlyIds); args.addAll(onlyIds); }
        jdbc.query("SELECT card_low_id, card_high_id FROM public.flashcard_fusions WHERE user_id = ?" + filter,
                rs -> { out.add(rs.getLong(1)); out.add(rs.getLong(2)); }, args.toArray());
        return out;
    }

    public record CardTier(long flashcardId, String tier, int loggedReviews, int recallDays, LocalDate pearlOn, boolean weak) {}

    /** Evolution tiers of up to 100 of the learner's own cards (a foreign or deleted id is simply absent). */
    @Transactional(readOnly = true, timeout = 15)
    public List<CardTier> tiers(long userId, List<Long> ids) {
        List<Long> clean = ids == null ? List.of() : ids.stream().filter(java.util.Objects::nonNull).distinct().limit(100).toList();
        if (clean.isEmpty()) return List.of();
        Map<Long, CardLog> logs = logs(userId, clean);
        Set<Long> fused = fusedCards(userId, clean);
        LocalDate today = reviewLog.today();
        List<CardTier> out = new ArrayList<>();
        jdbc.query("SELECT id, status, review_count FROM public.flashcards WHERE user_id = ? AND state = 0 AND id IN (" + placeholders(clean.size()) + ")",
                rs -> {
                    long id = rs.getLong(1);
                    CardLog c = logs.get(id);
                    LocalDate pearl = c == null ? null : MemoryEvolution.pearlDay(c.recallDays);
                    MemoryEvolution.Tier tier = MemoryEvolution.tier(pearl != null, fused.contains(id),
                            MemoryEvolution.practised(c != null, rs.getString(2), rs.getInt(3)));
                    out.add(new CardTier(id, tier.name(), c == null ? 0 : c.total, c == null ? 0 : c.recallDays.size(), pearl,
                            c != null && MemoryEvolution.weak(c.hardDays, c.latest, today)));
                }, concat(userId, clean));
        return out;
    }

    // ───────────────────────────── overview (vault, reef, weak words, synapse) ─────────────────────────────

    public record VaultCard(long flashcardId, String word, String meaning, String status, String tier, int loggedReviews,
                            int recallDays, int hardDays, LocalDate pearlOn) {}

    public record Fusion(long id, long firstCardId, long secondCardId, String firstWord, String secondWord, String sentence,
                         String feedbackVi, java.time.Instant createdAt) {}

    public record TierCounts(long raw, long silver, long prism, long pearl, long total) {}

    public record Reef(int reviewDays, int loggedReviews, int pearls, int fusions, List<MemoryEvolution.Milestone> milestones,
                       LocalDate firstLoggedDay) {}

    /** {@code practisedBeforeLog}: active cards with stored progress (status / review count) but no logged rating — progress from
     *  before V116, kept as it is and never turned into invented review days. */
    public record Overview(TierCounts tiers, Reef reef, List<VaultCard> vault, List<VaultCard> weak, List<Fusion> synapses,
                           LocalDate today, long practisedBeforeLog) {}

    @Transactional(readOnly = true, timeout = 20)
    public Overview overview(long userId) {
        LocalDate today = reviewLog.today();
        Map<Long, CardLog> logs = logs(userId, null);
        List<Fusion> fusions = fusions(userId);
        Set<Long> fused = new HashSet<>();
        fusions.forEach(f -> { fused.add(f.firstCardId()); fused.add(f.secondCardId()); });

        Map<Long, LocalDate> pearlOn = new HashMap<>();
        TreeSet<LocalDate> allDays = new TreeSet<>();
        int total = 0;
        for (var e : logs.entrySet()) {
            CardLog c = e.getValue();
            total += c.total;
            allDays.addAll(c.recallDays);
            allDays.addAll(c.hardDays);
            LocalDate p = MemoryEvolution.pearlDay(c.recallDays);
            if (p != null) pearlOn.put(e.getKey(), p);
        }

        Map<Integer, LocalDate> reach = new HashMap<>();
        if (total >= MemoryEvolution.REVIEW_TARGETS[0]) {
            // the same rows as `total`: ratings of the learner's ACTIVE cards only (a deleted card's history is not counted twice)
            jdbc.query("SELECT rn, review_local_day FROM (SELECT row_number() OVER (ORDER BY l.reviewed_at, l.id) AS rn, l.review_local_day "
                            + "FROM public.flashcard_review_log l JOIN public.flashcards f ON f.id = l.flashcard_id AND f.user_id = ? AND f.state = 0 "
                            + "WHERE l.user_id = ?) x WHERE rn IN (100, 1000)",
                    rs -> { reach.put(rs.getInt(1), rs.getDate(2).toLocalDate()); }, userId, userId);
        }

        // one tier per active card (Pearl > Prism > Silver > Raw): a fused card that was never rated is a Prism, not Raw
        long[] tally = new long[4];
        long[] beforeLog = {0};
        jdbc.query("SELECT f.id, f.status, f.review_count FROM public.flashcards f WHERE f.user_id = ? AND f.state = 0",
                rs -> {
                    long id = rs.getLong(1);
                    MemoryEvolution.Tier t = MemoryEvolution.tier(pearlOn.containsKey(id), fused.contains(id),
                            MemoryEvolution.practised(logs.containsKey(id), rs.getString(2), rs.getInt(3)));
                    tally[t.ordinal()]++;
                    if (!logs.containsKey(id) && MemoryEvolution.practised(false, rs.getString(2), rs.getInt(3))) beforeLog[0]++;
                }, userId);
        long[] counts = {tally[0] + tally[1] + tally[2] + tally[3]};
        long raw = tally[MemoryEvolution.Tier.RAW.ordinal()], silver = tally[MemoryEvolution.Tier.SILVER.ordinal()];
        long prisms = tally[MemoryEvolution.Tier.PRISM.ordinal()], pearls = tally[MemoryEvolution.Tier.PEARL.ordinal()];

        // weak words: Khó on ≥ 2 different days inside the window, latest rating not Dễ
        List<Long> weakIds = logs.entrySet().stream()
                .filter(e -> MemoryEvolution.weak(e.getValue().hardDays, e.getValue().latest, today))
                .sorted(Comparator.comparingInt((Map.Entry<Long, CardLog> e) -> -e.getValue().hardDays.size())
                        .thenComparing(e -> e.getValue().lastAt, Comparator.nullsLast(Comparator.reverseOrder())))
                .limit(12).map(Map.Entry::getKey).toList();

        // vault: cards with logged evidence or a fusion, best first
        Comparator<Long> best = Comparator.comparingInt((Long id) -> -rank(pearlOn.containsKey(id), fused.contains(id)))
                .thenComparing(id -> logs.get(id) == null ? null : logs.get(id).lastAt, Comparator.nullsLast(Comparator.reverseOrder()));
        Set<Long> evidence = new LinkedHashSet<>(logs.keySet());
        evidence.addAll(fused);
        List<Long> vaultIds = evidence.stream().sorted(best).limit(48).toList();

        Set<Long> detailIds = new LinkedHashSet<>(vaultIds);
        detailIds.addAll(weakIds);
        Map<Long, String[]> details = details(userId, detailIds);

        java.util.function.Function<Long, VaultCard> toCard = id -> {
            String[] d = details.get(id);
            if (d == null) return null;
            CardLog c = logs.get(id);
            MemoryEvolution.Tier tier = MemoryEvolution.tier(pearlOn.containsKey(id), fused.contains(id),
                    MemoryEvolution.practised(c != null, d[2], Integer.parseInt(d[3])));
            return new VaultCard(id, d[0], d[1], d[2], tier.name(), c == null ? 0 : c.total, c == null ? 0 : c.recallDays.size(),
                    c == null ? 0 : (int) c.hardDays.stream().filter(x -> !x.isBefore(today.minusDays(MemoryEvolution.WEAK_WINDOW_DAYS))).count(),
                    pearlOn.get(id));
        };
        List<VaultCard> vault = vaultIds.stream().map(toCard).filter(java.util.Objects::nonNull).toList();
        List<VaultCard> weak = weakIds.stream().map(toCard).filter(java.util.Objects::nonNull).toList();

        List<LocalDate> pearlDays = new ArrayList<>(pearlOn.values());
        List<LocalDate> fusionDays = fusions.stream().map(f -> LocalDate.ofInstant(f.createdAt(), reviewLog.zone())).toList();
        List<MemoryEvolution.Milestone> milestones = MemoryEvolution.milestones(allDays, total, reach, pearlDays, fusionDays);
        Reef reef = new Reef(allDays.size(), total, pearlDays.size(), fusions.size(), milestones, allDays.isEmpty() ? null : allDays.first());
        return new Overview(new TierCounts(raw, silver, prisms, pearls, counts[0]), reef, vault, weak,
                fusions.stream().limit(40).toList(), today, beforeLog[0]);
    }

    private static int rank(boolean pearl, boolean fused) {
        return pearl ? 3 : fused ? 2 : 1;
    }

    /** word, meaning (learner's own → deck sense → dictionary), status, review count — own active cards only. */
    private Map<Long, String[]> details(long userId, Collection<Long> ids) {
        Map<Long, String[]> out = new HashMap<>();
        if (ids.isEmpty()) return out;
        jdbc.query("SELECT f.id, d.word, COALESCE(NULLIF(f.custom_meaning, ''), dde.meaning_vi, d.general_translation_vi, "
                        + "(SELECT m.meaning FROM public.dictionary_meanings m WHERE m.dictionary_entry_id = d.id LIMIT 1)), f.status, f.review_count "
                        + "FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                        + "LEFT JOIN public.deck_dictionary_entries dde ON dde.deck_id = f.deck_id AND dde.dictionary_entry_id = d.id "
                        + "WHERE f.user_id = ? AND f.state = 0 AND f.id IN (" + placeholders(ids.size()) + ")",
                rs -> {
                    String meaning = rs.getString(3);
                    out.put(rs.getLong(1), new String[]{rs.getString(2), meaning == null ? null : clip(meaning, 160),
                            rs.getString(4), String.valueOf(rs.getInt(5))});
                }, concat(userId, ids));
        return out;
    }

    private List<Fusion> fusions(long userId) {
        return jdbc.query("SELECT x.id, x.card_low_id, x.card_high_id, x.word_low, x.word_high, x.sentence, x.feedback_vi, x.created_at "
                        + "FROM public.flashcard_fusions x "
                        + "JOIN public.flashcards a ON a.id = x.card_low_id AND a.user_id = x.user_id AND a.state = 0 "
                        + "JOIN public.flashcards b ON b.id = x.card_high_id AND b.user_id = x.user_id AND b.state = 0 "
                        + "WHERE x.user_id = ? ORDER BY x.created_at DESC LIMIT 400",
                (rs, n) -> new Fusion(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getString(4), rs.getString(5),
                        rs.getString(6), rs.getString(7), rs.getTimestamp(8).toInstant()), userId);
    }

    // ───────────────────────────── Card Fusion ─────────────────────────────

    public record FusionCandidate(long firstCardId, String firstWord, long secondCardId, String secondWord, String relation,
                                  String reference) {}

    /**
     * Pairs of the learner's learned words with a REAL linguistic link: both words occur in one stored example sentence of
     * one of the two cards (dictionary example, deck-sense example or the learner's own). That sentence is the attested
     * evidence (shown only after the learner's attempt). Pairs already fused are skipped. No AI, no network.
     */
    @Transactional(readOnly = true, timeout = 15)
    public List<FusionCandidate> fusionCandidates(long userId, int limit) {
        record Learned(long id, long entryId, String word, List<String> examples) {}
        List<Learned> learned = new ArrayList<>();
        jdbc.query("SELECT f.id, d.id, d.word, f.custom_example, dde.example FROM public.flashcards f "
                        + "JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                        + "LEFT JOIN public.deck_dictionary_entries dde ON dde.deck_id = f.deck_id AND dde.dictionary_entry_id = d.id "
                        + "WHERE f.user_id = ? AND f.state = 0 AND f.status IN ('LEARNED', 'MASTERED') "
                        + "ORDER BY f.updated_at DESC NULLS LAST, f.id DESC LIMIT 400",
                rs -> {
                    List<String> ex = new ArrayList<>();
                    if (rs.getString(4) != null) ex.add(rs.getString(4));
                    if (rs.getString(5) != null) ex.add(rs.getString(5));
                    learned.add(new Learned(rs.getLong(1), rs.getLong(2), rs.getString(3), ex));
                }, userId);
        if (learned.size() < 2) return List.of();
        Map<Long, List<String>> dictExamples = new HashMap<>();
        List<Long> entryIds = learned.stream().map(Learned::entryId).distinct().toList();
        jdbc.query("SELECT dictionary_entry_id, example FROM public.dictionary_examples WHERE dictionary_entry_id IN ("
                        + placeholders(entryIds.size()) + ")",
                rs -> {
                    List<String> list = dictExamples.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>());
                    String e = rs.getString(2);
                    if (e != null && e.length() <= 300 && list.size() < 6) list.add(e);
                }, entryIds.toArray());

        // inflected form → card (single content words only)
        Map<String, Learned> byForm = new HashMap<>();
        for (Learned l : learned) {
            if (!WordForms.contentWord(l.word())) continue;
            for (String form : WordForms.forms(l.word())) byForm.putIfAbsent(form, l);
        }
        Set<String> done = new HashSet<>();
        jdbc.query("SELECT card_low_id, card_high_id FROM public.flashcard_fusions WHERE user_id = ?",
                rs -> { done.add(rs.getLong(1) + ":" + rs.getLong(2)); }, userId);

        Map<String, FusionCandidate> pairs = new LinkedHashMap<>();
        for (Learned a : learned) {
            if (!WordForms.contentWord(a.word())) continue;
            List<String> sentences = new ArrayList<>(a.examples());
            sentences.addAll(dictExamples.getOrDefault(a.entryId(), List.of()));
            for (String s : sentences) {
                if (s == null || !WordForms.uses(s, a.word())) continue;
                for (String token : new LinkedHashSet<>(WordForms.tokens(s))) {
                    Learned b = byForm.get(token);
                    if (b == null || b.id() == a.id() || b.word().equalsIgnoreCase(a.word())) continue;
                    long low = Math.min(a.id(), b.id()), high = Math.max(a.id(), b.id());
                    String key = low + ":" + high;
                    if (done.contains(key) || pairs.containsKey(key)) continue;
                    pairs.put(key, new FusionCandidate(a.id(), a.word(), b.id(), b.word(), "SHARED_EXAMPLE", clip(WordForms.normalize(s), 300)));
                }
            }
        }
        List<FusionCandidate> all = new ArrayList<>(pairs.values());
        Collections.shuffle(all, ThreadLocalRandom.current());
        return all.stream().limit(Math.max(1, Math.min(limit, 12))).toList();
    }

    public record FusionResult(String verdict, boolean accepted, boolean newlyLinked, String feedbackVi, String suggestionEn,
                               String reference) {}

    /** Checks the learner's sentence with the AI and records the pair only when the strict check accepted it. */
    // no transaction: a pooled connection is never held across the AI call (each statement commits on its own)
    public FusionResult checkFusion(long userId, long firstCardId, long secondCardId, String rawSentence) {
        if (firstCardId == secondCardId) throw bad("Hãy chọn hai từ khác nhau.");
        String sentence = WordForms.normalize(rawSentence);
        if (sentence.length() < 6 || sentence.length() > 400) throw bad("Câu cần dài từ 6 đến 400 ký tự.");
        Map<Long, String> words = new HashMap<>();
        jdbc.query("SELECT f.id, d.word FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                        + "WHERE f.user_id = ? AND f.state = 0 AND f.id IN (?, ?)",
                rs -> { words.put(rs.getLong(1), rs.getString(2)); }, userId, firstCardId, secondCardId);
        String first = words.get(firstCardId), second = words.get(secondCardId);
        if (first == null || second == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy thẻ.");
        // Fusion links two words the learner has LEARNED (the candidate rule), checked here too, not only in the UI
        Integer learned = jdbc.queryForObject("SELECT count(*) FROM public.flashcards WHERE user_id = ? AND state = 0 AND id IN (?, ?) "
                + "AND status IN ('LEARNED', 'MASTERED')", Integer.class, userId, firstCardId, secondCardId);
        if (learned == null || learned < 2) throw bad("Hãy chọn hai từ bạn đã học.");
        // a sentence without both words is told at once (the request is refused before any AI call is completed)
        if (!WordForms.uses(sentence, first) || !WordForms.uses(sentence, second)) {
            throw bad("Câu của bạn cần dùng cả hai từ “" + first + "” và “" + second + "”.");
        }
        String user;
        try {
            user = mapper.writeValueAsString(Map.of("first", first, "second", second, "sentence", sentence));
        } catch (Exception e) {
            throw new IllegalStateException("serialisation");
        }
        MemoryAi.FusionVerdict verdict;
        try {
            verdict = MemoryAi.parseFusion(mapper, ai.completeJson(MemoryAi.FUSION_SYSTEM, user, 700), sentence, first, second);
        } catch (IllegalStateException ex) {
            log.warn("[CARD_FUSION] unusable AI answer: {}", ex.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Echo chưa kiểm tra được câu này. Hãy thử lại sau ít phút.");
        }
        boolean newly = false;
        if (verdict.accepted()) {
            long low = Math.min(firstCardId, secondCardId), high = Math.max(firstCardId, secondCardId);
            newly = jdbc.update("INSERT INTO public.flashcard_fusions (user_id, card_low_id, card_high_id, word_low, word_high, relation, sentence, feedback_vi) "
                            + "VALUES (?, ?, ?, ?, ?, 'USED_TOGETHER', ?, ?) ON CONFLICT (user_id, card_low_id, card_high_id) DO NOTHING",
                    userId, low, high, clip(words.get(low), 255), clip(words.get(high), 255), sentence,
                    verdict.feedbackVi() == null ? null : clip(verdict.feedbackVi(), 1200)) > 0;
        }
        return new FusionResult(verdict.verdict(), verdict.accepted(), newly, verdict.feedbackVi(), verdict.suggestionEn(), null);
    }

    // ───────────────────────────── Memory Forge ─────────────────────────────

    public record ForgeResult(long flashcardId, String word, String storedMeaning, String mode, String title,
                              List<String> paragraphs, List<MemoryAi.Prompt> prompts, boolean aiGenerated) {}

    // no transaction around the AI call (see checkFusion)
    public ForgeResult forge(long userId, long flashcardId, String rawMode, String rawInterest) {
        String mode = rawMode == null ? "" : rawMode.trim().toUpperCase(Locale.ROOT);
        if (!MemoryAi.FORGE_MODES.contains(mode)) throw bad("Cách ghi nhớ không hợp lệ.");
        String interest = rawInterest == null ? null : clip(WordForms.normalize(rawInterest), 120);
        List<String[]> rows = jdbc.query("SELECT d.word, COALESCE(NULLIF(f.custom_meaning, ''), dde.meaning_vi, d.general_translation_vi, "
                        + "(SELECT m.meaning FROM public.dictionary_meanings m WHERE m.dictionary_entry_id = d.id LIMIT 1)), "
                        + "COALESCE(NULLIF(f.custom_example, ''), dde.example, (SELECT e.example FROM public.dictionary_examples e WHERE e.dictionary_entry_id = d.id LIMIT 1)), "
                        + "dde.part_of_speech "
                        + "FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                        + "LEFT JOIN public.deck_dictionary_entries dde ON dde.deck_id = f.deck_id AND dde.dictionary_entry_id = d.id "
                        + "WHERE f.id = ? AND f.user_id = ? AND f.state = 0",
                (rs, n) -> new String[]{rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)}, flashcardId, userId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy thẻ.");
        String[] r = rows.get(0);
        String meaning = r[1] == null ? null : clip(WordForms.normalize(r[1]), 400);
        if (meaning == null || meaning.isBlank()) {
            throw bad("Thẻ này chưa có nghĩa đã lưu, Echo không thể gợi ý cách nhớ khác. Hãy thêm nghĩa trong Thư viện thẻ.");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("mode", mode);
        payload.put("word", r[0]);
        payload.put("storedMeaning", meaning);
        if (r[2] != null) payload.put("example", clip(WordForms.normalize(r[2]), 400));
        if (r[3] != null) payload.put("partOfSpeech", r[3]);
        if (interest != null && !interest.isBlank()) payload.put("interest", interest);
        MemoryAi.Forge forge;
        try {
            forge = MemoryAi.parseForge(mapper, ai.completeJson(MemoryAi.FORGE_SYSTEM, mapper.writeValueAsString(payload), 900));
        } catch (IllegalStateException ex) {
            log.warn("[MEMORY_FORGE] unusable AI answer: {}", ex.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Echo chưa tạo được gợi ý. Hãy thử lại sau ít phút.");
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("serialisation");
        }
        return new ForgeResult(flashcardId, r[0], meaning, mode, forge.title(), forge.paragraphs(), forge.prompts(), true);
    }

    // ───────────────────────────── Echo AI Card Studio ─────────────────────────────

    public record StudioCard(String draftId, String term, String kind, String partOfSpeech, String sourceSentence,
                             String meaningVi, String definitionEn, String sentenceVi, String ipa, String cefr,
                             String dictionaryMeaningVi, boolean alreadySaved) {}

    public record StudioResult(List<StudioCard> cards, int dropped) {}

    // no transaction around the AI call (see checkFusion)
    public StudioResult studio(long userId, String rawText, String rawLevel, Integer rawCount, List<String> rawExclude, String rawOnly) {
        String text = WordForms.normalize(rawText);
        if (text.length() < CardStudio.MIN_TEXT) throw bad("Hãy dán một đoạn tiếng Anh dài hơn (tối thiểu " + CardStudio.MIN_TEXT + " ký tự).");
        if (text.length() > CardStudio.MAX_TEXT) throw bad("Đoạn văn quá dài. Tối đa " + CardStudio.MAX_TEXT + " ký tự mỗi lần.");
        long letters = text.chars().filter(Character::isLetter).count();
        long latin = text.chars().filter(ch -> (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')).count();
        // English uses almost no accented letters; Vietnamese (or any other script) uses many
        if (letters < 10 || (letters - latin) > letters * 0.04) throw bad("Echo AI Card Studio cần một đoạn văn tiếng Anh.");
        String level = rawLevel == null ? "ANY" : rawLevel.trim().toUpperCase(Locale.ROOT);
        if (!CardStudio.LEVELS.contains(level)) level = "ANY";
        String only = rawOnly == null || rawOnly.isBlank() ? null : clip(WordForms.normalize(rawOnly), 80);
        if (only != null && !WordForms.uses(text, only)) throw bad("Từ cần tạo lại không có trong đoạn văn.");
        int count = only != null ? 1 : Math.max(CardStudio.MIN_COUNT, Math.min(CardStudio.MAX_COUNT, rawCount == null ? 8 : rawCount));
        List<String> exclude = rawExclude == null ? List.of() : rawExclude.stream()
                .filter(s -> s != null && !s.isBlank()).map(s -> clip(WordForms.normalize(s), 80)).distinct().limit(60).toList();
        if (only != null) exclude = exclude.stream().filter(e -> !e.equalsIgnoreCase(only)).toList();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("passage", text);
        payload.put("learnerLevel", level.equals("ANY") ? "intermediate (B1-B2)" : level);
        payload.put("count", count);
        if (!exclude.isEmpty()) payload.put("exclude", exclude);
        if (only != null) payload.put("only", only);
        CardStudio.Parsed parsed;
        try {
            String answer = ai.completeJson(CardStudio.SYSTEM, mapper.writeValueAsString(payload), Math.min(4000, 400 + count * 260));
            parsed = CardStudio.parse(mapper, answer, text, new HashSet<>(exclude), count);
        } catch (IllegalStateException ex) {
            log.warn("[CARD_STUDIO] unusable AI answer: {}", ex.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Echo chưa phân tích được đoạn văn. Hãy thử lại sau ít phút.");
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("serialisation");
        }
        if (only != null) {
            parsed = new CardStudio.Parsed(parsed.drafts().stream().filter(d -> d.term().equalsIgnoreCase(only)).limit(1).toList(), parsed.dropped());
        }
        List<String> terms = parsed.drafts().stream().map(d -> d.term().toLowerCase(Locale.ROOT)).distinct().toList();
        Map<String, String[]> dict = new HashMap<>();
        Set<String> owned = new HashSet<>();
        if (!terms.isEmpty()) {
            // shared dictionary only (owner_user_id IS NULL): IPA / CEFR / meaning come from here or stay empty
            jdbc.query("SELECT lower(word), ipa, cefr, general_translation_vi FROM public.dictionary_entries "
                            + "WHERE owner_user_id IS NULL AND lower(word) IN (" + placeholders(terms.size()) + ") ORDER BY id",
                    rs -> { dict.putIfAbsent(rs.getString(1), new String[]{rs.getString(2), rs.getString(3), rs.getString(4)}); },
                    terms.toArray());
            jdbc.query("SELECT DISTINCT lower(d.word) FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                            + "WHERE f.user_id = ? AND f.state = 0 AND lower(d.word) IN (" + placeholders(terms.size()) + ")",
                    rs -> { owned.add(rs.getString(1)); }, concat(userId, terms));
        }
        List<StudioCard> cards = new ArrayList<>();
        int i = 0;
        for (CardStudio.Draft d : parsed.drafts()) {
            String key = d.term().toLowerCase(Locale.ROOT);
            String[] row = dict.get(key);
            String ipa = row == null ? null : trimOrNull(row[0], 80);
            String cefr = row == null || row[1] == null ? null : row[1].trim().toUpperCase(Locale.ROOT);
            if (cefr != null && !cefr.matches("A1|A2|B1|B2|C1|C2")) cefr = null;
            cards.add(new StudioCard("d" + (++i) + "-" + Integer.toHexString(key.hashCode()), d.term(), d.kind(), d.partOfSpeech(),
                    d.sourceSentence(), d.meaningVi(), d.definitionEn(), d.sentenceVi(), ipa, cefr,
                    row == null ? null : trimOrNull(row[2], 300), owned.contains(key)));
        }
        return new StudioResult(cards, parsed.dropped());
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private static String placeholders(int n) {
        return Collections.nCopies(Math.max(1, n), "?").stream().collect(Collectors.joining(", "));
    }

    private static Object[] concat(Object first, Collection<?> rest) {
        List<Object> all = new ArrayList<>(rest.size() + 1);
        all.add(first);
        all.addAll(rest);
        return all.toArray();
    }

    private static String clip(String s, int max) {
        if (s == null) return null;
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static String trimOrNull(String s, int max) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : clip(t, max);
    }

    ZoneId zone() {
        return reviewLog.zone();
    }
}
