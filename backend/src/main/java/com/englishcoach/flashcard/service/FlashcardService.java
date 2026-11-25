package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.englishcoach.flashcard.dto.VocabDeckSummaryResponse;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

import com.englishcoach.progress.service.LearningEventService;
import lombok.extern.slf4j.Slf4j;

import java.time.Instant;

@Slf4j
@Service
public class FlashcardService {
    // Release withdrawal hides new catalogue entries and refuses new enrolment without touching existing cards.
    @org.springframework.beans.factory.annotation.Value("${app.vocab.reading.visible:true}")
    private boolean readingLibraryVisible = true;
    @org.springframework.beans.factory.annotation.Value("${app.vocab.books.visible:true}")
    private boolean bookCollectionsVisible = true;

    private static final com.fasterxml.jackson.databind.ObjectMapper DEFAULT_OBJECT_MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private boolean visibleDeck(VocabDeck deck) {
        return deck != null && visibleDeck(deck.isSystem(), deck.getSlug());
    }

    private boolean visibleDeck(VocabDeckCache.SystemDeckEntry deck) {
        return deck != null && visibleDeck(deck.isSystem(), deck.slug());
    }

    private boolean visibleDeck(boolean isSystem, String slug) {
        String safeSlug = slug != null ? slug : "";
        return isSystem && (readingLibraryVisible || !safeSlug.startsWith("lib-reader-"))
            && (bookCollectionsVisible || !safeSlug.startsWith("bk-"));
    }
    private final FlashcardRepository flashcardRepository;
    private final UserRepository userRepository;
    private final DictionaryRepository dictionaryRepository;
    private final AnkiNoteParser ankiNoteParser;
    private final VocabDeckRepository vocabDeckRepository;
    private final LearningEventService learningEventService;
    private final VocabDeckCache vocabDeckCache;
    private final org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;
    private final com.englishcoach.flashcard.repository.CardBlastRunRepository cardBlastRunRepository;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.fasterxml.jackson.databind.ObjectMapper objectMapper;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    /** Append-only rating evidence of Echo Memory Tides (V116); absent in slim unit tests. Never changes the schedule. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.flashcard.memory.FlashcardReviewLog reviewLog;

    /** Started solo Card Blast runs; a plain instance is created on first use when no bean is wired (slim tests). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private CardBlastRunRegistry cardBlastRunRegistry;

    @org.springframework.beans.factory.annotation.Autowired
    public FlashcardService(FlashcardRepository flashcardRepository,
                            UserRepository userRepository,
                            DictionaryRepository dictionaryRepository,
                            AnkiNoteParser ankiNoteParser,
                            VocabDeckRepository vocabDeckRepository,
                            @org.springframework.lang.Nullable
                            LearningEventService learningEventService,
                            @org.springframework.lang.Nullable
                            VocabDeckCache vocabDeckCache,
                            @org.springframework.lang.Nullable
                            org.springframework.jdbc.core.JdbcTemplate jdbcTemplate,
                            @org.springframework.lang.Nullable
                            com.englishcoach.flashcard.repository.CardBlastRunRepository cardBlastRunRepository) {
        this.flashcardRepository = flashcardRepository;
        this.userRepository = userRepository;
        this.dictionaryRepository = dictionaryRepository;
        this.ankiNoteParser = ankiNoteParser;
        this.vocabDeckRepository = vocabDeckRepository;
        this.learningEventService = learningEventService;
        this.vocabDeckCache = vocabDeckCache != null ? vocabDeckCache : new VocabDeckCache();
        this.jdbcTemplate = jdbcTemplate;
        this.cardBlastRunRepository = cardBlastRunRepository;
    }

    public FlashcardService(FlashcardRepository flashcardRepository,
                            UserRepository userRepository,
                            DictionaryRepository dictionaryRepository,
                            AnkiNoteParser ankiNoteParser,
                            VocabDeckRepository vocabDeckRepository,
                            @org.springframework.lang.Nullable
                            LearningEventService learningEventService,
                            @org.springframework.lang.Nullable
                            VocabDeckCache vocabDeckCache,
                            @org.springframework.lang.Nullable
                            org.springframework.jdbc.core.JdbcTemplate jdbcTemplate) {
        this(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser, vocabDeckRepository, learningEventService, vocabDeckCache, jdbcTemplate, null);
    }

    public FlashcardService(FlashcardRepository flashcardRepository,
                            UserRepository userRepository,
                            DictionaryRepository dictionaryRepository,
                            AnkiNoteParser ankiNoteParser,
                            VocabDeckRepository vocabDeckRepository,
                            LearningEventService learningEventService) {
        this(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser, vocabDeckRepository, learningEventService, null, null);
    }

    public FlashcardService(FlashcardRepository flashcardRepository,
                            UserRepository userRepository,
                            DictionaryRepository dictionaryRepository,
                            AnkiNoteParser ankiNoteParser,
                            VocabDeckRepository vocabDeckRepository) {
        this(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser, vocabDeckRepository, null, null, null);
    }

    public FlashcardService(FlashcardRepository flashcardRepository,
                            UserRepository userRepository,
                            DictionaryRepository dictionaryRepository,
                            AnkiNoteParser ankiNoteParser) {
        this(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser, null, null, null, null);
    }


    private static org.springframework.web.server.ResponseStatusException badRequest(String reason) {
        return new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, reason);
    }

    private static org.springframework.web.server.ResponseStatusException cardNotFound() {
        return new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, "Flashcard not found");
    }

    /** Adds the dictionary word {@code word} to the learner's cards (an existing card of that word is returned). */
    @Transactional
    public Flashcard addFlashcard(Long userId, String word) {
        User user = userRepository.findById(userId).orElseThrow(FlashcardService::cardNotFound);
        String clean = word != null ? word.trim() : "";
        if (clean.isEmpty() || clean.length() > MAX_FRONT_LENGTH) throw badRequest("Từ không hợp lệ.");
        DictionaryEntry entry = dictionaryRepository.findByWordIgnoreCase(clean)
                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "Không tìm thấy từ này trong từ điển."));
        lockWord(clean);
        Flashcard card = existingCard(user.getId(), entry.getId());
        if (card == null) {
            card = saveNewFlashcard(Flashcard.builder()
                    .user(user)
                    .dictionaryEntry(entry)
                    .reviewCount(0)
                    .status("NEW")
                    .nextReviewDate(LocalDateTime.now())
                    .build());
        } else if (card.getState() != 0) {
            card.setState(0);
            card = flashcardRepository.save(card);
        }
        evictAfterCommit(userId);
        return card;
    }

    /**
     * The caller's own card. A card that does not exist and a card of another learner answer alike: 404, so the
     * answer says nothing about other learners' cards (and a refusal is not reported as a server error).
     */
    private Flashcard ownCard(Long userId, Long flashcardId) {
        if (userId == null || flashcardId == null) throw cardNotFound();
        Flashcard card = flashcardRepository.findById(flashcardId).orElseThrow(FlashcardService::cardNotFound);
        if (card.getUser() == null || !userId.equals(card.getUser().getId())) throw cardNotFound();
        return card;
    }

    /** The three ratings of the study screen (and their historical aliases). Anything else is refused (400). */
    enum Rating {
        HARD, GOOD, EASY;

        static Rating parse(String quality) {
            String q = quality != null ? quality.trim().toLowerCase(java.util.Locale.ROOT) : "";
            return switch (q) {
                case "hard", "again", "kho", "khó", "1", "2" -> HARD;
                case "good", "tot", "tốt", "3" -> GOOD;
                case "easy", "de", "dễ", "4" -> EASY;
                default -> throw badRequest("Mức đánh giá không hợp lệ. Hãy chọn Khó, Tốt hoặc Dễ.");
            };
        }

        String wire() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /** Result of a rating: the card as stored, and whether this was a retry of a rating already applied. */
    public record ReviewOutcome(Flashcard card, boolean replayed) {}

    private static final java.util.regex.Pattern REQUEST_ID = java.util.regex.Pattern.compile("[A-Za-z0-9_-]{8,64}");

    @Transactional
    public Flashcard reviewFlashcard(Long userId, Long flashcardId, String quality) {
        return review(userId, flashcardId, quality, null).card();
    }

    /**
     * Applies one rating in one transaction: the card row is locked, the schedule moves, and the review event
     * ({@code FLASHCARD_REVIEWED}, the evidence of streaks, the garden and Lộ trình học) is written in the same
     * transaction, so a rating is either fully saved or not at all. {@code requestId} identifies the learner's click: a
     * retry with the id of the rating last applied to this card returns the stored card without moving it again.
     */
    @Transactional
    public ReviewOutcome review(Long userId, Long flashcardId, String quality, String requestId) {
        Rating rating = Rating.parse(quality);
        String rid = requestId == null || requestId.isBlank() ? null : requestId.trim();
        if (rid != null && !REQUEST_ID.matcher(rid).matches()) throw badRequest("Mã yêu cầu không hợp lệ.");
        if (userId == null || flashcardId == null) throw cardNotFound();
        Flashcard card = flashcardRepository.findOwnedForUpdate(flashcardId, userId).orElseThrow(FlashcardService::cardNotFound);
        if (rid != null && rid.equals(card.getLastReviewRequestId())) {
            return new ReviewOutcome(withDeckSense(card), true);
        }

        String currentStatus = card.getStatus();
        LocalDateTime now = LocalDateTime.now();
        card.setReviewCount(card.getReviewCount() + 1);
        switch (rating) {
            // Khó: due again at once (stays in today's reviews).
            case HARD -> {
                card.setNextReviewDate(now.minusSeconds(1));
                card.setStatus("LEARNED");
            }
            case GOOD -> {
                card.setNextReviewDate(now.plusDays(3));
                if (!"MASTERED".equals(currentStatus)) card.setStatus("LEARNED");
            }
            case EASY -> {
                card.setNextReviewDate(now.plusDays(7));
                card.setStatus("MASTERED");
            }
        }
        card.setLastReviewRequestId(rid);
        Flashcard saved = flashcardRepository.saveAndFlush(card);
        // Echo Memory Tides (V116): the rating's evidence row, in this same transaction (absent in slim unit tests)
        if (reviewLog != null) reviewLog.record(userId, saved.getId(), rating.wire(), currentStatus, saved.getStatus());

        if (learningEventService != null) {
            // every review leaves a row, also after "reset" restarted the counter (the reference would collide)
            String sourceRef = saved.getId() + ":" + saved.getReviewCount();
            learningEventService.recordOccurrenceSafely(userId, "FLASHCARD_REVIEWED", sourceRef, Instant.now());
        }
        // AFTER_COMMIT listeners (leaderboard): they hear of the rating only once it is stored
        if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent(userId, saved.getId(), saved.getReviewCount(), rating.wire(), currentStatus, saved.getStatus(), saved.getDictionaryEntry() != null ? saved.getDictionaryEntry().getId() : null, saved.getDictionaryEntry() != null ? saved.getDictionaryEntry().getCefr() : null, saved.getDeck() != null ? saved.getDeck().getId() : null, Instant.now()));
        evictAfterCommit(userId);
        return new ReviewOutcome(withDeckSense(saved), false);
    }

    @Transactional
    public Flashcard submitReview(Long userId, Long flashcardId, String quality) {
        return reviewFlashcard(userId, flashcardId, quality);
    }

    /** Drops the learner's cached deck summaries once the change is committed (immediately outside a transaction). */
    private void evictAfterCommit(Long userId) {
        if (vocabDeckCache == null) return;
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) {
            org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                    new org.springframework.transaction.support.TransactionSynchronization() {
                        @Override
                        public void afterCommit() {
                            vocabDeckCache.evict(userId);
                        }
                    });
        } else {
            vocabDeckCache.evict(userId);
        }
    }

    /**
     * Serialises saves of one word (case-insensitive) until the transaction ends: a double click, two tabs or two
     * learners saving the same new word never create a second dictionary row or a second card. Outside a transaction
     * (no lock would be held) and without JDBC (unit tests) it does nothing.
     */
    private void lockWord(String word) {
        if (jdbcTemplate == null || word == null
                || !org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return;
        }
        jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                rs -> null, "flashcard-word:" + word.trim().toLowerCase(java.util.Locale.ROOT));
    }

    /**
     * The learner's card for an entry: an active personal card first, else any active card, else a deleted one (to be
     * restored). More than one can exist (decks sharing a word); none is ever merged or deleted here.
     */
    private Flashcard existingCard(Long userId, Long entryId) {
        List<Flashcard> cards = flashcardRepository.findByUserIdAndDictionaryEntryIdOrderByIdAsc(userId, entryId);
        if (cards == null || cards.isEmpty()) return null;
        return cards.stream().filter(c -> c.getState() == 0 && c.getDeck() == null).findFirst()
                .or(() -> cards.stream().filter(c -> c.getState() == 0).findFirst())
                .orElse(cards.get(0));
    }

    @Transactional
    public Flashcard resetFlashcard(Long userId, Long flashcardId) {
        Flashcard card = ownCard(userId, flashcardId);

        card.setStatus("LEARNED");
        card.setNextReviewDate(LocalDateTime.now());
        card.setReviewCount(0);

        Flashcard saved = flashcardRepository.save(card);
        evictAfterCommit(userId);
        return withDeckSense(saved);
    }

    @Transactional
    public Flashcard addCustomFlashcard(Long userId, String front, String back, String example) {
        return addCustomFlashcard(userId, front, back, example, null, null);
    }

    @Transactional
    public Flashcard addCustomFlashcard(Long userId, String front, String back, String example, String ipa, String cefr) {
        return saveCustomFlashcard(userId, front, back, example, ipa, cefr).card();
    }

    /** The saved card, and whether this call created (or restored) it rather than finding it already there. */
    public record SavedCard(Flashcard card, boolean created) {}

    static final int MAX_FRONT_LENGTH = 255;
    static final int MAX_MEANING_LENGTH = 2000;
    static final int MAX_EXAMPLE_LENGTH = 1000;
    private static final java.util.regex.Pattern CEFR = java.util.regex.Pattern.compile("(?i)^(A1|A2|B1|B2|C1|C2)$");
    /** Filler some callers used to send instead of leaving a field empty; never learner content. */
    private static final Set<String> PLACEHOLDERS = Set.of("no definition", "imported custom flashcard",
            "custom example", "imported from anki deck", "reading example");

    /** A phonetic transcription written as /…/ or […] (what imports and popups sometimes put in the example field). */
    static boolean looksLikeIpa(String s) {
        return AnkiNoteParser.looksLikeIpa(s);
    }

    private String learnerText(String raw) {
        if (raw == null) return null;
        String clean = ankiNoteParser.sanitizeText(raw);
        if (clean.isBlank() || PLACEHOLDERS.contains(clean.toLowerCase(java.util.Locale.ROOT))) return null;
        return clean;
    }

    /**
     * The one save path of every "Lưu Flashcard" button (Flashcards, Reading, My Books, dictionary popups, dashboard,
     * translation, community, Anki import). Fields are validated at this boundary (400 with a readable reason, never a
     * 500), a transcription sent as the example becomes the IPA, and the learner's own meaning and example are kept on
     * the card. A word the learner already has returns that card ({@code created=false}); nothing is duplicated.
     */
    @Transactional
    public SavedCard saveCustomFlashcard(Long userId, String front, String back, String example, String ipa, String cefr) {
        return saveCustomFlashcard(userId, front, back, example, ipa, cefr, null);
    }

    /**
     * The contextual sense of a card approved in Echo AI Card Studio (V117): English definition, part of speech and the
     * Vietnamese translation of the example. All optional; the card then shows only this sense.
     */
    public record ContextSense(String definition, String partOfSpeech, String exampleVi) {}

    private static final java.util.Set<String> SENSE_POS = java.util.Set.of("noun", "verb", "adjective", "adverb", "preposition",
            "conjunction", "pronoun", "determiner", "phrasal verb", "idiom", "collocation", "phrase");

    @Transactional
    public SavedCard saveCustomFlashcard(Long userId, String front, String back, String example, String ipa, String cefr, ContextSense sense) {
        User user = userRepository.findById(userId).orElseThrow(FlashcardService::cardNotFound);

        String word = ankiNoteParser.sanitizeText(front);
        if (word.isBlank()) throw badRequest("Hãy nhập từ hoặc cụm từ tiếng Anh.");
        if (word.length() > MAX_FRONT_LENGTH) throw badRequest("Từ hoặc cụm từ quá dài (tối đa 255 ký tự).");

        String meaning = learnerText(back);
        if (meaning != null && meaning.length() > MAX_MEANING_LENGTH) throw badRequest("Nghĩa quá dài (tối đa 2.000 ký tự).");
        String exampleText = learnerText(example);
        String ipaText = learnerText(ipa);
        if (exampleText != null && looksLikeIpa(exampleText)) {
            if (ipaText == null) ipaText = exampleText;
            exampleText = null;
        }
        if (exampleText != null && exampleText.length() > MAX_EXAMPLE_LENGTH) throw badRequest("Ví dụ quá dài (tối đa 1.000 ký tự).");
        String finalIpa = ipaText != null ? AnkiNoteParser.boundString(ipaText, 255) : null;
        String finalCefr = cefr != null && CEFR.matcher(cefr.trim()).matches() ? cefr.trim().toUpperCase(java.util.Locale.ROOT) : null;
        String finalMeaning = meaning;
        String finalExample = exampleText;
        // the contextual sense (V117) belongs to the meaning it was approved with: it is kept only together with that meaning,
        // and its translation only together with its example
        String senseDefinition = sense == null || finalMeaning == null ? null : learnerText(sense.definition());
        if (senseDefinition != null && senseDefinition.length() > 500) throw badRequest("Định nghĩa quá dài (tối đa 500 ký tự).");
        String sensePos = sense == null || finalMeaning == null || sense.partOfSpeech() == null ? null
                : sense.partOfSpeech().trim().toLowerCase(java.util.Locale.ROOT);
        if (sensePos != null && !SENSE_POS.contains(sensePos)) sensePos = null;
        String senseExampleVi = sense == null || finalMeaning == null || finalExample == null ? null : learnerText(sense.exampleVi());
        if (senseExampleVi != null && senseExampleVi.length() > 1000) throw badRequest("Bản dịch ví dụ quá dài (tối đa 1.000 ký tự).");

        lockWord(word);
        // The shared dictionary is SYSTEM data: a save never writes to it (no new row, no IPA / CEFR filled in). A
        // word it does not know gets the learner's own private entry (V102); the learner's meaning and example live
        // only on the card.
        DictionaryEntry own = dictionaryRepository.findPrivateEntry(user.getId(), word).orElse(null);
        Flashcard existing = own != null ? existingCard(user.getId(), own.getId()) : null;
        DictionaryEntry entry = existing != null ? own
                : dictionaryRepository.findByWordIgnoreCase(word).orElse(own);
        if (entry == null) {
            entry = dictionaryRepository.save(DictionaryEntry.builder()
                    .word(word)
                    .ownerUserId(user.getId())
                    .ipa(finalIpa)
                    .cefr(finalCefr)
                    .meanings(new ArrayList<>())
                    .examples(new ArrayList<>())
                    .build());
        }
        if (existing == null) existing = existingCard(user.getId(), entry.getId());
        if (existing != null) {
            boolean restored = existing.getState() != 0;
            boolean changed = restored;
            if (restored) existing.setState(0);
            // fill what is missing; an earlier text of the learner is never overwritten
            boolean meaningFilled = false;
            if (finalMeaning != null && existing.getCustomMeaning() == null) {
                existing.setCustomMeaning(finalMeaning);
                changed = true;
                meaningFilled = true;
            }
            boolean exampleFilled = false;
            if (finalExample != null && existing.getCustomExample() == null) {
                existing.setCustomExample(finalExample);
                changed = true;
                exampleFilled = true;
            }
            // a contextual sense only arrives with the meaning it describes (never added under an older meaning)
            if (meaningFilled && existing.getCustomDefinition() == null && existing.getCustomPartOfSpeech() == null) {
                if (senseDefinition != null) { existing.setCustomDefinition(senseDefinition); changed = true; }
                if (sensePos != null) { existing.setCustomPartOfSpeech(sensePos); changed = true; }
                if (exampleFilled && senseExampleVi != null) { existing.setCustomExampleVi(senseExampleVi); changed = true; }
            }
            Flashcard card = changed ? flashcardRepository.save(existing) : existing;
            evictAfterCommit(userId);
            return new SavedCard(card, restored);
        }

        Flashcard saved = saveNewFlashcard(Flashcard.builder()
                .user(user)
                .dictionaryEntry(entry)
                .reviewCount(0)
                .status("NEW")
                .nextReviewDate(LocalDateTime.now())
                .customMeaning(finalMeaning)
                .customExample(finalExample)
                .customDefinition(senseDefinition)
                .customPartOfSpeech(sensePos)
                .customExampleVi(senseExampleVi)
                .build());
        evictAfterCommit(userId);
        return new SavedCard(saved, true);
    }

    private Flashcard saveNewFlashcard(Flashcard flashcard) {
        LocalDateTime now = LocalDateTime.now();
        flashcard.setCreatedAt(now);
        flashcard.setUpdatedAt(now);
        return flashcardRepository.save(flashcard);
    }

    @Transactional
    public void deleteFlashcard(Long userId, Long flashcardId) {
        Flashcard card = ownCard(userId, flashcardId);
        card.setState(1);
        flashcardRepository.save(card);
        evictAfterCommit(userId);
    }

    @Transactional(readOnly = true, timeout = 15)
    public com.englishcoach.flashcard.dto.FlashcardCatalogResponse getSystemCatalog() {
        // Independent link aggregate: never hydrate dictionary meanings, examples or words.
        Map<Long, Long> counts = new HashMap<>();
        for (Object[] row : flashcardRepository.countDeckDictionaryEntriesGrouped()) {
            counts.put(((Number) row[0]).longValue(), ((Number) row[1]).longValue());
        }
        var decks = vocabDeckRepository.findByIsSystemTrueOrderBySortOrderAsc().stream()
            .filter(this::visibleDeck)
            .sorted(java.util.Comparator.comparingInt(VocabDeck::getSortOrder).thenComparing(VocabDeck::getId))
            .map(d -> new com.englishcoach.flashcard.dto.FlashcardCatalogResponse.Deck(
                d.getId(), d.getSlug(), d.getTitle(), d.getDescription(), d.getCategory(),
                d.getThemeColor(), d.getIcon(), counts.getOrDefault(d.getId(), 0L) > 0
                    ? Math.toIntExact(counts.get(d.getId())) : d.getTotalWords(), true, d.getSortOrder()))
            .toList();
        try {
            // Hash the actual metadata/counts: even link-only changes invalidate the revision.
            com.fasterxml.jackson.databind.ObjectMapper mapper = objectMapper != null ? objectMapper : DEFAULT_OBJECT_MAPPER;
            byte[] metadata = mapper.writeValueAsBytes(decks);
            String revision = java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(metadata));
            return new com.englishcoach.flashcard.dto.FlashcardCatalogResponse(revision, decks.size(),
                decks.stream().mapToLong(d -> d.totalWords()).sum(), decks);
        } catch (java.io.IOException | java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("Cannot encode SYSTEM deck catalog", e);
        }
    }

    @Transactional(readOnly = true, timeout = 15)
    public List<com.englishcoach.flashcard.dto.FlashcardCatalogResponse.Progress> getDeckProgress(Long userId) {
        Map<Long,List<String>> ratings=new HashMap<>();
        for(Object[] row:flashcardRepository.latestRatingsByDeck(userId)){
            Long deckId=row[0]==null?null:((Number)row[0]).longValue();
            ratings.computeIfAbsent(deckId,k->new ArrayList<>()).add((String)row[1]);
        }
        return flashcardRepository.getDeckStatsByUserId(userId).stream().map(p ->
            new com.englishcoach.flashcard.dto.FlashcardCatalogResponse.Progress(p.getDeckId(),
                p.getTotalCards(), p.getMasteredCards(), p.getReviewedCards(), p.getLearningCards(), p.getDueCards(), ratings.getOrDefault(p.getDeckId(),List.of())))
            .toList();
    }

    private VocabDeckCache.SystemDeckCatalog loadSystemDeckCatalogSnapshot() {
        Map<Long, Long> ddeCounts = new HashMap<>();
        try {
            List<Object[]> ddeList = flashcardRepository.countDeckDictionaryEntriesGrouped();
            if (ddeList != null) {
                for (Object[] row : ddeList) {
                    if (row != null && row.length >= 2 && row[0] != null && row[1] != null) {
                        ddeCounts.put(((Number) row[0]).longValue(), ((Number) row[1]).longValue());
                    }
                }
            }
        } catch (Exception ex) {
            log.warn("Failed to query deck_dictionary_entries grouped counts: {}", ex.getMessage());
        }

        List<VocabDeck> systemDecks = vocabDeckRepository.findByIsSystemTrueOrderBySortOrderAsc();
        if (systemDecks == null || systemDecks.isEmpty()) {
            return new VocabDeckCache.SystemDeckCatalog(List.of());
        }

        List<VocabDeckCache.SystemDeckEntry> entries = new ArrayList<>(systemDecks.size());
        for (VocabDeck deck : systemDecks) {
            if (deck == null || !deck.isSystem()) {
                continue;
            }
            Long ddeCount = ddeCounts.get(deck.getId());
            int totalWords = (ddeCount != null && ddeCount > 0) ? ddeCount.intValue() : deck.getTotalWords();
            entries.add(new VocabDeckCache.SystemDeckEntry(
                    deck.getId(),
                    deck.getSlug(),
                    deck.getTitle(),
                    deck.getDescription(),
                    deck.getCategory(),
                    deck.getThemeColor(),
                    deck.getIcon(),
                    totalWords,
                    true,
                    deck.getSortOrder()
            ));
        }
        return new VocabDeckCache.SystemDeckCatalog(entries);
    }

    private VocabDeckCache.UserProgressOverlay loadUserDeckProgressOverlay(Long userId) {
        List<FlashcardRepository.DeckStatsProjection> statsList = flashcardRepository.getDeckStatsByUserId(userId);
        if (statsList == null || statsList.isEmpty()) {
            return VocabDeckCache.UserProgressOverlay.EMPTY;
        }
        VocabDeckCache.UserDeckProgress personal = VocabDeckCache.UserDeckProgress.EMPTY;
        Map<Long, VocabDeckCache.UserDeckProgress> byDeckId = new HashMap<>();
        for (FlashcardRepository.DeckStatsProjection p : statsList) {
            if (p == null) {
                continue;
            }
            VocabDeckCache.UserDeckProgress progress = new VocabDeckCache.UserDeckProgress(
                    p.getTotalCards() != null ? p.getTotalCards() : 0L,
                    p.getMasteredCards() != null ? p.getMasteredCards() : 0L,
                    p.getReviewedCards() != null ? p.getReviewedCards() : 0L,
                    p.getLearningCards() != null ? p.getLearningCards() : 0L,
                    p.getDueCards() != null ? p.getDueCards() : 0L
            );
            if (p.getDeckId() == null) {
                personal = progress;
            } else {
                byDeckId.put(p.getDeckId(), progress);
            }
        }
        return new VocabDeckCache.UserProgressOverlay(personal, byDeckId);
    }

    public List<VocabDeckSummaryResponse> getDecks(Long userId) {
        VocabDeckCache.SystemDeckCatalog catalog = vocabDeckCache != null
                ? vocabDeckCache.getOrLoadSystemCatalog(this::loadSystemDeckCatalogSnapshot)
                : loadSystemDeckCatalogSnapshot();
        VocabDeckCache.UserProgressOverlay overlay = vocabDeckCache != null
                ? vocabDeckCache.getOrLoadUserProgress(userId, this::loadUserDeckProgressOverlay)
                : loadUserDeckProgressOverlay(userId);

        List<VocabDeckCache.SystemDeckEntry> systemEntries = catalog != null ? catalog.decks() : List.of();
        VocabDeckCache.UserDeckProgress personal = overlay != null ? overlay.personal() : VocabDeckCache.UserDeckProgress.EMPTY;
        Map<Long, VocabDeckCache.UserDeckProgress> byDeckId = overlay != null ? overlay.byDeckId() : Map.of();

        List<VocabDeckSummaryResponse> results = new ArrayList<>(systemEntries.size() + 1);

        // 1. Personal Deck ("Bộ từ của bản thân" - always first)
        long personalTotal = personal.totalCards();
        long personalMastered = personal.masteredCount();
        long personalReviewed = personal.reviewedCount();
        long personalLearning = personal.learningCount();
        long personalDue = personal.dueCount();
        int personalProgress = personalTotal > 0 ? (int) Math.round(((double) personalMastered / personalTotal) * 100.0) : 0;

        results.add(VocabDeckSummaryResponse.builder()
            .id(null)
            .slug("personal")
            .title("Bộ từ của bản thân")
            .description("Tự thêm và ôn tập từ vựng của riêng bạn.")
            .category("PERSONAL")
            .themeColor("emerald")
            .icon("edit")
            .totalWords((int) personalTotal)
            .isSystem(false)
            .sortOrder(0)
            .masteredCount(personalMastered)
            .reviewedCount(personalReviewed)
            .learningCount(personalLearning)
            .dueCount(personalDue)
            .progressPercentage(personalProgress)
            .isEnrolled(true)
            .build());

        // 2. System Decks — apply visibility flags at read time and compose fresh DTOs without mutating shared catalog
        for (VocabDeckCache.SystemDeckEntry deck : systemEntries) {
            if (!visibleDeck(deck)) {
                continue;
            }
            VocabDeckCache.UserDeckProgress p = byDeckId.get(deck.id());
            int totalWords = deck.totalWords();

            long mastered = p != null ? p.masteredCount() : 0L;
            long reviewed = p != null ? p.reviewedCount() : 0L;
            long learning = p != null ? p.learningCount() : 0L;
            long due = p != null ? p.dueCount() : 0L;

            // Never let card count exceed total words
            if (totalWords > 0) {
                mastered = Math.min(mastered, (long) totalWords);
                reviewed = Math.min(reviewed, (long) totalWords);
                learning = Math.min(learning, (long) totalWords);
                due = Math.min(due, (long) totalWords);
            }

            int progress = totalWords > 0 ? (int) Math.round(((double) mastered / totalWords) * 100.0) : 0;
            boolean enrolled = p != null && p.totalCards() > 0;

            results.add(VocabDeckSummaryResponse.builder()
                .id(deck.id())
                .slug(deck.slug())
                .title(deck.title())
                .description(deck.description())
                .category(deck.category())
                .themeColor(deck.themeColor())
                .icon(deck.icon())
                .totalWords(totalWords)
                .isSystem(deck.isSystem())
                .sortOrder(deck.sortOrder())
                .masteredCount(mastered)
                .reviewedCount(reviewed)
                .learningCount(learning)
                .dueCount(due)
                .progressPercentage(progress)
                .isEnrolled(enrolled)
                .build());
        }

        return results;
    }

    @Transactional
    public int enrollDeck(Long userId, Long deckId) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new RuntimeException("User not found"));
        VocabDeck deck = vocabDeckRepository.findById(deckId)
                .filter(this::visibleDeck)
            .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,"Deck not found"));

        int insertedCount;
        if (jdbcTemplate != null) {
            insertedCount = jdbcTemplate.update(
                "INSERT INTO public.flashcards (user_id, deck_id, dictionary_entry_id, review_count, status, is_system, state, next_review_date, created_at, updated_at) " +
                "SELECT ?, ?, dde.dictionary_entry_id, 0, 'NEW', true, 0, NOW(), NOW(), NOW() " +
                "FROM public.deck_dictionary_entries dde " +
                "WHERE dde.deck_id = ? " +
                "  AND NOT EXISTS ( " +
                "      SELECT 1 FROM public.flashcards f " +
                "      WHERE f.user_id = ? AND f.deck_id = ? AND f.dictionary_entry_id = dde.dictionary_entry_id " +
                "  )",
                userId, deckId, deckId, userId, deckId
            );
        } else {
            List<Long> entryIds = flashcardRepository.findDictionaryEntryIdsByDeckId(deckId);
            if (entryIds.isEmpty()) {
                return 0;
            }

            List<Flashcard> existingCards = flashcardRepository.findByUserIdAndDeckId(userId, deckId);
            Set<Long> existingEntryIds = existingCards.stream()
                    .map(c -> c.getDictionaryEntry().getId())
                    .collect(Collectors.toSet());

            List<Flashcard> newCards = new ArrayList<>();
            LocalDateTime now = LocalDateTime.now();

            for (Long entryId : entryIds) {
                if (!existingEntryIds.contains(entryId)) {
                    DictionaryEntry entry = dictionaryRepository.findById(entryId).orElse(null);
                    if (entry != null) {
                        newCards.add(Flashcard.builder()
                                .user(user)
                                .deck(deck)
                                .dictionaryEntry(entry)
                                .reviewCount(0)
                                .status("NEW")
                                .isSystem(true)
                                .state(0)
                                .nextReviewDate(now)
                                .createdAt(now)
                                .updatedAt(now)
                                .build());
                    }
                }
            }

            if (!newCards.isEmpty()) {
                flashcardRepository.saveAll(newCards);
            }
            insertedCount = newCards.size();
        }

        evictAfterCommit(userId);

        return insertedCount;
    }

    public static final int DEFAULT_DAILY_REVIEW_LIMIT = 20;

    public long getDueCount(Long userId, Integer dailyReviewLimit) {
        int limit = (dailyReviewLimit != null && dailyReviewLimit > 0) ? dailyReviewLimit : DEFAULT_DAILY_REVIEW_LIMIT;
        long actualDue = flashcardRepository.countDueByUserId(userId);
        return Math.min((long) limit, actualDue);
    }

    public long countActualDue(Long userId) {
        return flashcardRepository.countDueByUserId(userId);
    }

    /** The learning day's zone (Asia/Ho_Chi_Minh unless configured). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.progress.config.LearningProgressProperties learningProgressProperties;

    /**
     * Start of the learner's local day as the JVM-local timestamp the card columns use ({@code updated_at} is written
     * with {@code LocalDateTime.now()}).
     */
    public static LocalDateTime learningDayStart(java.time.ZoneId zone) {
        java.time.ZoneId z = zone != null ? zone : java.time.ZoneId.of("Asia/Ho_Chi_Minh");
        return java.time.LocalDate.now(z).atStartOfDay(z).withZoneSameInstant(java.time.ZoneId.systemDefault()).toLocalDateTime();
    }

    private LocalDateTime learningDayStart() {
        return learningDayStart(learningProgressProperties != null ? learningProgressProperties.getZoneId() : null);
    }

    /** Review-due cards (studied earlier, due day reached, not reviewed today); NEW cards are not reviews. */
    public long countReviewDue(Long userId) {
        return flashcardRepository.countReviewDueByUserId(userId, learningDayStart());
    }

    public Page<Flashcard> getReviewDueFlashcards(Long userId, Pageable pageable) {
        return withDeckSenses(flashcardRepository.findReviewDueFlashcards(userId, learningDayStart(), pageable));
    }

    public com.englishcoach.flashcard.dto.FlashcardStatsResponse getStats(Long userId) {
        FlashcardRepository.FlashcardStatsProjection projection = flashcardRepository.getStatsByUserId(userId);
        if (projection == null) {
            return new com.englishcoach.flashcard.dto.FlashcardStatsResponse(0L, 0L, 0L, 0L);
        }
        long rawDue = projection.getDueCards() != null ? projection.getDueCards() : 0L;
        long cappedDue = Math.min((long) DEFAULT_DAILY_REVIEW_LIMIT, rawDue);
        return new com.englishcoach.flashcard.dto.FlashcardStatsResponse(
            projection.getTotalCards() != null ? projection.getTotalCards() : 0L,
            cappedDue,
            projection.getLearningCards() != null ? projection.getLearningCards() : 0L,
            projection.getMasteredCards() != null ? projection.getMasteredCards() : 0L
        );
    }

    public com.englishcoach.flashcard.dto.FlashcardStatsResponse getStats(Long userId, Long deckId) {
        if (deckId == null) {
            return getStats(userId);
        }
        FlashcardRepository.FlashcardStatsProjection projection = flashcardRepository.getStatsByUserIdAndDeckId(userId, deckId);
        if (projection == null) {
            return new com.englishcoach.flashcard.dto.FlashcardStatsResponse(0L, 0L, 0L, 0L);
        }
        long rawDue = projection.getDueCards() != null ? projection.getDueCards() : 0L;
        long cappedDue = Math.min((long) DEFAULT_DAILY_REVIEW_LIMIT, rawDue);
        return new com.englishcoach.flashcard.dto.FlashcardStatsResponse(
            projection.getTotalCards() != null ? projection.getTotalCards() : 0L,
            cappedDue,
            projection.getLearningCards() != null ? projection.getLearningCards() : 0L,
            projection.getMasteredCards() != null ? projection.getMasteredCards() : 0L
        );
    }

    public Page<Flashcard> getUserFlashcards(Long userId, Long deckId, String search, String status, Pageable pageable) {
        if (status != null && Set.of("hard","good","easy").contains(status)) {
            var ids=flashcardRepository.idsByLatestRating(userId,deckId,status,search==null?"":search.strip(),pageable);
            var cards=ids.isEmpty()?List.<Flashcard>of():flashcardRepository.loadRatedPage(userId,ids.getContent());
            return withDeckSenses(new org.springframework.data.domain.PageImpl<>(cards,pageable,ids.getTotalElements()));
        }
        return withDeckSenses(findUserFlashcards(userId, deckId, search, status, pageable));
    }

    private Page<Flashcard> findUserFlashcards(Long userId, Long deckId, String search, String status, Pageable pageable) {
        if (deckId == null) {
            return findUserFlashcards(userId, search, status, pageable);
        }
        boolean hasSearch = search != null && !search.trim().isEmpty();
        String trimmedSearch = hasSearch ? search.trim() : null;
        String normalizedStatus = status != null ? status.trim().toLowerCase() : null;

        if ("due".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findDueFlashcardsAndWordByDeckId(userId, deckId, trimmedSearch, pageable)
                    : flashcardRepository.findDueFlashcardsByDeckId(userId, deckId, pageable);
        } else if ("learning".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findByUserIdAndDeckIdAndStatusInAndWord(userId, deckId, List.of("LEARNED", "NEW"), trimmedSearch, pageable)
                    : flashcardRepository.findByUserIdAndDeckIdAndStatusIn(userId, deckId, List.of("LEARNED", "NEW"), pageable);
        } else if ("mastered".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findByUserIdAndDeckIdAndStatusAndWord(userId, deckId, "MASTERED", trimmedSearch, pageable)
                    : flashcardRepository.findByUserIdAndDeckIdAndStatus(userId, deckId, "MASTERED", pageable);
        }

        return hasSearch
                ? flashcardRepository.findByUserIdAndDeckIdAndFrontContainingIgnoreCase(userId, deckId, trimmedSearch, pageable)
                : flashcardRepository.findByUserIdAndDeckId(userId, deckId, pageable);
    }

    public Page<Flashcard> getUserFlashcards(Long userId, String search, String status, Pageable pageable) {
        return withDeckSenses(findUserFlashcards(userId, search, status, pageable));
    }

    private Page<Flashcard> findUserFlashcards(Long userId, String search, String status, Pageable pageable) {
        boolean hasSearch = search != null && !search.trim().isEmpty();
        String trimmedSearch = hasSearch ? search.trim() : null;
        String normalizedStatus = status != null ? status.trim().toLowerCase() : null;

        if ("due".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findDueFlashcardsAndWord(userId, trimmedSearch, pageable)
                    : flashcardRepository.findDueFlashcards(userId, pageable);
        } else if ("learning".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findByUserIdAndStatusInAndWord(userId, List.of("LEARNED", "NEW"), trimmedSearch, pageable)
                    : flashcardRepository.findByUserIdAndStatusIn(userId, List.of("LEARNED", "NEW"), pageable);
        } else if ("mastered".equals(normalizedStatus)) {
            return hasSearch
                    ? flashcardRepository.findByUserIdAndStatusAndWord(userId, "MASTERED", trimmedSearch, pageable)
                    : flashcardRepository.findByUserIdAndStatus(userId, "MASTERED", pageable);
        }

        return hasSearch
                ? flashcardRepository.findByUserIdAndFrontContainingIgnoreCase(userId, trimmedSearch, pageable)
                : flashcardRepository.findByUserId(userId, pageable);
    }

    public Page<Flashcard> getUserFlashcards(Long userId, String search, Pageable pageable) {
        return getUserFlashcards(userId, search, null, pageable);
    }

    public Page<Flashcard> getDueFlashcards(Long userId, Long deckId, Pageable pageable) {
        if (deckId == null) {
            return getDueFlashcards(userId, pageable);
        }
        return withDeckSenses(flashcardRepository.findDueFlashcardsByDeckId(userId, deckId, pageable));
    }

    public Page<Flashcard> getDueFlashcards(Long userId, Pageable pageable) {
        return withDeckSenses(flashcardRepository.findDueFlashcards(userId, pageable));
    }

    /**
     * Attaches the sense each card's deck teaches (V106 curated topic decks) with ONE query for the whole page: the
     * deck link holds the meaning, example and translation of that sense. Cards without a deck, or of a deck without
     * curated senses, are left as they are.
     */
    private Page<Flashcard> withDeckSenses(Page<Flashcard> page) {
        if (page != null) attachDeckSenses(page.getContent());
        return page;
    }

    private Flashcard withDeckSense(Flashcard card) {
        if (card != null) attachDeckSenses(List.of(card));
        return card;
    }

    private void attachDeckSenses(List<Flashcard> cards) {
        if (jdbcTemplate == null || cards == null || cards.isEmpty()) return;
        List<Object> params = new ArrayList<>();
        Map<String, List<Flashcard>> byLink = new HashMap<>();
        for (Flashcard card : cards) {
            if (card == null || card.getDeck() == null || card.getDictionaryEntry() == null) continue;
            Long deckId = card.getDeck().getId();
            Long entryId = card.getDictionaryEntry().getId();
            if (deckId == null || entryId == null) continue;
            String key = deckId + ":" + entryId;
            if (!byLink.containsKey(key)) {
                params.add(deckId);
                params.add(entryId);
            }
            byLink.computeIfAbsent(key, k -> new ArrayList<>()).add(card);
        }
        if (byLink.isEmpty()) return;
        String tuples = String.join(",", Collections.nCopies(byLink.size(), "(?,?)"));
        jdbcTemplate.query(
            "SELECT l.deck_id,l.dictionary_entry_id,l.part_of_speech,l.meaning_vi,l.example,l.example_vi,l.definition_en,l.source_kind,l.reference_level,d.slug,e.word " +
            "FROM public.deck_dictionary_entries l JOIN public.vocab_decks d ON d.id=l.deck_id JOIN public.dictionary_entries e ON e.id=l.dictionary_entry_id " +
            "WHERE l.meaning_vi IS NOT NULL AND (l.deck_id,l.dictionary_entry_id) IN (" + tuples + ")",
            rs -> {
                var extra=LibrarySenseSupplement.find(rs.getString("slug"),rs.getString("word"),rs.getString("meaning_vi"));
                String definition=rs.getString("definition_en");
                com.englishcoach.flashcard.dto.DeckSense sense = new com.englishcoach.flashcard.dto.DeckSense(
                    rs.getString("part_of_speech"), rs.getString("meaning_vi"), rs.getString("example"), rs.getString("example_vi"),
                    definition!=null || extra==null ? definition : extra.definition(), rs.getString("source_kind"), rs.getString("reference_level"), extra==null ? null : extra.ipa());
                List<Flashcard> linked = byLink.get(rs.getLong("deck_id") + ":" + rs.getLong("dictionary_entry_id"));
                if (linked != null) linked.forEach(c -> c.setDeckSense(sense));
            },
            params.toArray());
    }

    public record ApkgImportResult(
            int importedCount,
            int skippedCount,
            int totalNotes,
            List<String> skipReasons
    ) {}

    /** Largest compressed .apkg archive accepted before extraction. */
    static final long APKG_MAX_ARCHIVE_BYTES = 128L * 1024 * 1024;
    /** Largest collection database (decompressed) an import reads; note text alone never comes close. */
    static final long APKG_MAX_COLLECTION_BYTES = 128L * 1024 * 1024;
    /** Entries of the archive that are looked at while searching for the collection (media files are entries too). */
    static final int APKG_MAX_ZIP_ENTRIES = 100_000;
    /** Notes one import reads; the rest of a larger collection is left out and reported as skipped. */
    static final int APKG_MAX_NOTES = 20_000;
    /** Longest an import may keep working (each note costs database round trips); the rest is reported as skipped. */
    static final long APKG_MAX_IMPORT_MILLIS = 10 * 60 * 1000L;
    private static final byte[] SQLITE_MAGIC_HEADER = "SQLite format 3\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    // The bounds in force (fields so a test can use small ones).
    long apkgMaxArchiveBytes = APKG_MAX_ARCHIVE_BYTES;
    long apkgMaxCollectionBytes = APKG_MAX_COLLECTION_BYTES;
    int apkgMaxZipEntries = APKG_MAX_ZIP_ENTRIES;
    int apkgMaxNotes = APKG_MAX_NOTES;
    long apkgMaxImportMillis = APKG_MAX_IMPORT_MILLIS;
    /** Imports that may run at once on this server (each holds a temporary database file and a long transaction). */
    private static final java.util.concurrent.Semaphore APKG_IMPORT_SLOTS = new java.util.concurrent.Semaphore(2);
    private static final java.util.Set<Long> APKG_IMPORTING_USERS = java.util.concurrent.ConcurrentHashMap.newKeySet();

    private static org.springframework.web.server.ResponseStatusException apkgRejected(
            org.springframework.http.HttpStatus status, String reason) {
        return new org.springframework.web.server.ResponseStatusException(status, reason);
    }

    /**
     * Imports an Anki package for one learner. One import per learner and two on the server at a time; the archive is
     * read within fixed bounds (see the constants above) so a crafted file cannot fill the disk or hold the server.
     */
    public ApkgImportResult importApkgDetails(Long userId, org.springframework.web.multipart.MultipartFile apkgFile) {
        if (apkgFile == null || apkgFile.isEmpty()) {
            throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST, "The .apkg file is empty");
        }
        if (!APKG_IMPORTING_USERS.add(userId)) {
            throw apkgRejected(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,
                    "An import of yours is still running. Wait for it to finish.");
        }
        try {
            if (!APKG_IMPORT_SLOTS.tryAcquire()) {
                throw apkgRejected(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                        "The server is importing other decks right now. Try again in a minute.");
            }
            try {
                return importApkgBounded(userId, apkgFile);
            } finally {
                APKG_IMPORT_SLOTS.release();
            }
        } finally {
            APKG_IMPORTING_USERS.remove(userId);
        }
    }

    private ApkgImportResult importApkgBounded(Long userId, org.springframework.web.multipart.MultipartFile apkgFile) {
        int importedCount = 0;
        int skippedCount = 0;
        int totalNotes = 0;
        List<String> skipReasons = new java.util.ArrayList<>();
        java.io.File tempDbFile = null;

        try {
            tempDbFile = extractCollectionDatabase(apkgFile);
            log.info("Extracted Anki collection database to {} ({} bytes)",
                    tempDbFile.getAbsolutePath(), tempDbFile.length());

            if (tempDbFile.length() < SQLITE_MAGIC_HEADER.length) {
                throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "Extracted collection database is empty or invalid");
            }
            verifySqliteMagicHeader(tempDbFile.toPath());

            String jdbcUrl = "jdbc:sqlite:" + tempDbFile.getAbsolutePath();
            org.sqlite.SQLiteConfig sqliteConfig = new org.sqlite.SQLiteConfig();
            sqliteConfig.setReadOnly(true);
            sqliteConfig.setBusyTimeout(5_000);
            try (java.sql.Connection conn = java.sql.DriverManager.getConnection(jdbcUrl, sqliteConfig.toProperties())) {
                try (java.sql.Statement pragmaStmt = conn.createStatement()) {
                    pragmaStmt.setQueryTimeout(5);
                    pragmaStmt.execute("PRAGMA query_only = ON");
                    pragmaStmt.execute("PRAGMA trusted_schema = OFF");
                    pragmaStmt.execute("PRAGMA cell_size_check = ON");
                }

                // EC-SEC-2026-012: Verify 'col' and 'notes' are genuine base tables (never VIEWs or VIRTUAL TABLEs)
                boolean notesIsTable = false;
                boolean colIsTable = false;
                try (java.sql.Statement schemaStmt = conn.createStatement()) {
                    schemaStmt.setQueryTimeout(5);
                    try (java.sql.ResultSet schemaRs = schemaStmt.executeQuery(
                            "SELECT name, type, sql FROM sqlite_master WHERE name IN ('col', 'notes')")) {
                        while (schemaRs.next()) {
                            String name = schemaRs.getString("name");
                            String type = schemaRs.getString("type");
                            String ddl = schemaRs.getString("sql");
                            if (!"table".equalsIgnoreCase(type)) {
                                throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                                        "Invalid .apkg database schema: '" + name + "' must be a table");
                            }
                            if (ddl != null && ddl.matches("(?is)^\\s*CREATE\\s+VIRTUAL\\s+TABLE\\b.*")) {
                                throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                                        "Invalid .apkg database schema: virtual tables are not allowed");
                            }
                            if ("notes".equals(name)) {
                                notesIsTable = true;
                            } else if ("col".equals(name)) {
                                colIsTable = true;
                            }
                        }
                    }
                }
                if (!notesIsTable) {
                    throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                            "Invalid .apkg database schema: missing 'notes' table");
                }

                // 1. Load models from col table
                Map<Long, AnkiNoteParser.ModelFieldMapping> modelMappings = Collections.emptyMap();
                if (colIsTable) {
                    try (java.sql.Statement colStmt = conn.createStatement()) {
                        colStmt.setQueryTimeout(5);
                        try (java.sql.ResultSet colRs = colStmt.executeQuery("SELECT models FROM col LIMIT 1")) {
                            if (colRs.next()) {
                                String modelsJson = colRs.getString("models");
                                modelMappings = ankiNoteParser.parseModels(modelsJson);
                                log.info("Loaded {} Anki note models from collection", modelMappings.size());
                            }
                        }
                    } catch (Exception e) {
                        log.warn("Could not load Anki models from col table: {}", e.getMessage());
                    }
                }

                // 2. Iterate notes table (bounded query limit + query timeout)
                try (java.sql.Statement notesStmt = conn.createStatement()) {
                    notesStmt.setQueryTimeout(5);
                    try (java.sql.ResultSet rs = notesStmt.executeQuery(
                            "SELECT id, mid, flds FROM notes LIMIT " + (apkgMaxNotes + 1L))) {

                        long deadline = System.currentTimeMillis() + apkgMaxImportMillis;
                        while (rs.next()) {
                            if (System.currentTimeMillis() > deadline) {
                                skippedCount++;
                                if (skipReasons.size() < 50) {
                                    skipReasons.add("The import stopped at its time limit; import the rest as a smaller package");
                                }
                                break;
                            }
                            if (totalNotes >= apkgMaxNotes) {
                                skippedCount++;
                                if (skipReasons.size() < 50) {
                                    skipReasons.add("Only the first " + apkgMaxNotes + " notes of a collection are imported");
                                }
                                break;
                            }
                            totalNotes++;
                            long noteId = rs.getLong("id");
                            long mid = rs.getLong("mid");
                            String fields = rs.getString("flds");

                            AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(mid, fields, modelMappings);
                            if (!parsed.valid()) {
                                skippedCount++;
                                String reason = "Note " + noteId + ": " + parsed.skipReason();
                                log.warn("Skipping Anki note: {}", reason);
                                if (skipReasons.size() < 50) {
                                    skipReasons.add(reason);
                                }
                                continue;
                            }

                            try {
                                addCustomFlashcard(userId, parsed.word(), parsed.meaning(), parsed.example(),
                                        parsed.ipa(), parsed.cefr());
                                importedCount++;
                            } catch (Exception ex) {
                                skippedCount++;
                                String reason = "Note " + noteId + " (" + parsed.word() + "): " + ex.getMessage();
                                log.warn("Failed to persist flashcard for note: {}", reason, ex);
                                if (skipReasons.size() < 50) {
                                    skipReasons.add(reason);
                                }
                            }
                        }
                    }
                }
            }

            log.info("Anki import complete for user {}: {} imported, {} skipped out of {} total notes",
                    userId, importedCount, skippedCount, totalNotes);
        } catch (org.springframework.web.server.ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            log.error("Import failed: ", e);
            throw new RuntimeException("Failed to extract apkg file: " + e.getMessage(), e);
        } finally {
            if (tempDbFile != null) {
                try {
                    java.nio.file.Files.deleteIfExists(tempDbFile.toPath());
                } catch (java.io.IOException ignored) {
                }
            }
        }

        evictAfterCommit(userId);

        return new ApkgImportResult(importedCount, skippedCount, totalNotes, skipReasons);
    }

    public int importApkg(Long userId, org.springframework.web.multipart.MultipartFile apkgFile) {
        return importApkgDetails(userId, apkgFile).importedCount();
    }

    private static void verifySqliteMagicHeader(java.nio.file.Path dbPath) throws java.io.IOException {
        byte[] header = new byte[SQLITE_MAGIC_HEADER.length];
        try (java.io.InputStream in = java.nio.file.Files.newInputStream(dbPath)) {
            int read = in.readNBytes(header, 0, header.length);
            if (read != SQLITE_MAGIC_HEADER.length || !java.util.Arrays.equals(header, SQLITE_MAGIC_HEADER)) {
                throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "Invalid .apkg collection database: not a SQLite 3 database");
            }
        }
    }

    /**
     * EC-SEC-2026-012: Stages the uploaded .apkg archive to a temp file (bounded compressed size) and opens it
     * via {@link java.util.zip.ZipFile} random access on the central directory, eliminating
     * {@code ZipInputStream.closeEntry()} deflate-skip CPU bombs and {@code deleteOnExit()} native leaks.
     */
    private java.io.File extractCollectionDatabase(org.springframework.web.multipart.MultipartFile apkgFile)
            throws java.io.IOException {
        java.nio.file.Path tempApkgPath = java.nio.file.Files.createTempFile("anki_pkg_", ".apkg");
        try {
            try (java.io.InputStream in = apkgFile.getInputStream();
                 java.io.OutputStream out = java.nio.file.Files.newOutputStream(tempApkgPath)) {
                byte[] buffer = new byte[64 * 1024];
                long written = 0L;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    written += read;
                    if (written > apkgMaxArchiveBytes) {
                        throw apkgRejected(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,
                                "The .apkg archive is too large to import");
                    }
                    out.write(buffer, 0, read);
                }
            }

            java.util.zip.ZipEntry selectedEntry = null;
            try (java.util.zip.ZipFile zipFile = new java.util.zip.ZipFile(tempApkgPath.toFile())) {
                if (zipFile.size() > apkgMaxZipEntries) {
                    throw apkgRejected(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,
                            "The .apkg archive has too many files");
                }
                int entries = 0;
                java.util.Enumeration<? extends java.util.zip.ZipEntry> enumeration = zipFile.entries();
                while (enumeration.hasMoreElements()) {
                    if (++entries > apkgMaxZipEntries) {
                        throw apkgRejected(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,
                                "The .apkg archive has too many files");
                    }
                    java.util.zip.ZipEntry entry = enumeration.nextElement();
                    if (entry.isDirectory()) {
                        continue;
                    }
                    String entryName = entry.getName();
                    if (entryName.endsWith("collection.anki21")) {
                        selectedEntry = entry;
                        break;
                    } else if (entryName.endsWith("collection.anki2") && selectedEntry == null) {
                        selectedEntry = entry;
                    }
                }

                if (selectedEntry == null) {
                    throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                            "Invalid .apkg format: missing collection.anki2 or collection.anki21");
                }
                if (selectedEntry.getSize() > apkgMaxCollectionBytes) {
                    throw apkgRejected(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,
                            "The collection inside the .apkg file is too large to import");
                }

                java.io.File tempDbFile;
                try (java.io.InputStream entryStream = zipFile.getInputStream(selectedEntry)) {
                    tempDbFile = writeZipEntryToTempFile(entryStream);
                }
                log.info("Using Anki collection entry: {}", selectedEntry.getName());
                return tempDbFile;
            } catch (java.util.zip.ZipException ze) {
                throw apkgRejected(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "Invalid .apkg archive format");
            }
        } finally {
            try {
                java.nio.file.Files.deleteIfExists(tempApkgPath);
            } catch (java.io.IOException ignored) {
            }
        }
    }

    private java.io.File writeZipEntryToTempFile(java.io.InputStream entryStream) throws java.io.IOException {
        java.nio.file.Path tempDbPath = java.nio.file.Files.createTempFile("anki_", ".db");
        boolean complete = false;
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(tempDbPath.toFile())) {
            // The declared size of a zip entry is the archive's own claim: count what is actually written.
            byte[] buffer = new byte[64 * 1024];
            long written = 0;
            int read;
            while ((read = entryStream.read(buffer)) != -1) {
                written += read;
                if (written > apkgMaxCollectionBytes) {
                    throw apkgRejected(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,
                            "The collection inside the .apkg file is too large to import");
                }
                fos.write(buffer, 0, read);
            }
            fos.flush();
            fos.getFD().sync();
            complete = true;
        } finally {
            if (!complete) {
                try {
                    java.nio.file.Files.deleteIfExists(tempDbPath);
                } catch (java.io.IOException ignored) {
                }
            }
        }
        return tempDbPath.toFile();
    }

    /** Most weak words one run may flag (a run shows at most the 100 cards the client loads). */
    static final int CARD_BLAST_MAX_WEAK_WORDS = 200;
    /** No single cleared word is worth more than this in the game, whatever the streak. */
    static final int CARD_BLAST_MAX_SCORE_PER_WORD = 250;

    /**
     * Starts a solo Card Blast run and returns its id. Only a run started here can later be recorded
     * ({@link #recordCardBlastRun}); empty when the learner started another run a moment ago.
     */
    public java.util.Optional<String> startCardBlastRun(Long userId, Long deckId) {
        return startCardBlastRun(userId, deckId, null);
    }

    /**
     * Echo Sentinel (10 §BX): {@code sentinel} is the acknowledged strict attempt ("id.secret") of this run; the run is
     * issued either way, but it counts toward Activity Points only if that attempt ends COMPLETED_VERIFIED.
     */
    public java.util.Optional<String> startCardBlastRun(Long userId, Long deckId, String sentinelHandle) {
        Long boundDeckId = null;
        if (deckId != null && vocabDeckRepository != null && vocabDeckRepository.existsById(deckId)) {
            boundDeckId = deckId;
        }
        var run = cardBlastRuns().issue(userId, boundDeckId).map(CardBlastRunRegistry.IssuedRun::runId);
        if (run.isPresent() && sentinel != null && sentinelHandle != null) {
            var attempt = sentinel.bind(userId, sentinelHandle, com.englishcoach.sentinel.SentinelPolicy.CARD_BLAST_SOLO, run.get());
            if (attempt != null) sentinel.playStarted(attempt, run.get());
        }
        return run;
    }
    private com.englishcoach.sentinel.SentinelService sentinel;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSentinel(com.englishcoach.sentinel.SentinelService sentinel) { this.sentinel = sentinel; }

    private CardBlastRunRegistry cardBlastRuns() {
        if (cardBlastRunRegistry == null) {
            cardBlastRunRegistry = new CardBlastRunRegistry();
        }
        return cardBlastRunRegistry;
    }

    /**
     * Records the end of a solo run. The run counts (history row, Activity Points, garden reward source) only when it
     * was started by {@link #startCardBlastRun} for this learner and has not been recorded before; the numbers that
     * count are bounded by the time since the start, never taken from the client as they are. A result without such a
     * run (an old tab, a replay, a fabricated call) still marks the learner's own weak words and nothing else.
     *
     * @return true when the run was counted
     */
    @Transactional
    public boolean recordCardBlastRun(Long userId, com.englishcoach.flashcard.dto.CardBlastFinishRunRequest request) {
        if (request == null) {
            throw badRequest("Dữ liệu kết quả không hợp lệ.");
        }
        if ((request.score() != null && request.score() < 0)
                || (request.hits() != null && request.hits() < 0)
                || (request.totalAttempts() != null && request.totalAttempts() < 0)
                || (request.accuracy() != null && (request.accuracy().isNaN() || request.accuracy().isInfinite()
                        || request.accuracy() < 0.0 || request.accuracy() > 100.0))) {
            throw badRequest("Thông số kết quả không hợp lệ.");
        }
        if (request.hits() != null && request.totalAttempts() != null && request.hits() > request.totalAttempts()) {
            throw badRequest("Số từ đúng không thể vượt quá tổng số lượt thử.");
        }
        var registry = cardBlastRuns();
        var finish = registry.reserve(userId, request.runId()).orElse(null);
        boolean synchronizedTx = org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive();
        if (finish != null && synchronizedTx) {
            org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                    new org.springframework.transaction.support.TransactionSynchronization() {
                        @Override public void afterCompletion(int status) {
                            registry.release(finish, status == STATUS_COMMITTED);
                        }
                    });
        }
        boolean success = false;
        try {
            boolean counted = persistCardBlastRun(userId, request, finish);
            success = true;
            return counted;
        } finally {
            if (finish != null && !synchronizedTx) registry.release(finish, success);
        }
    }

    private boolean persistCardBlastRun(Long userId, com.englishcoach.flashcard.dto.CardBlastFinishRunRequest request,
                                        CardBlastRunRegistry.Finish finish) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new RuntimeException("User not found"));

        List<Long> requestedWeakWordIds = request.weakWordIds() != null ? request.weakWordIds() : Collections.emptyList();
        List<Long> weakWordIds = requestedWeakWordIds.stream()
                .filter(java.util.Objects::nonNull)
                .distinct()
                .limit(CARD_BLAST_MAX_WEAK_WORDS)
                .toList();

        boolean counted = false;
        VocabDeck deck = null;
        if (finish != null && sentinel != null) {
            if (finish.decision == null) {
                finish.decision = sentinel.complete(sentinel.findLive(userId,
                        com.englishcoach.sentinel.SentinelPolicy.CARD_BLAST_SOLO, request.runId()));
            }
            if (finish.decision != null) sentinel.persist(finish.decision);
        }
        boolean verified = sentinel == null || (finish != null && finish.decision != null
                && finish.decision.to() == com.englishcoach.sentinel.SentinelAttempt.State.COMPLETED_VERIFIED);
        if (finish != null && cardBlastRunRepository != null && verified) {
            CardBlastRunRegistry.IssuedRun started = finish.run;
            if (started.deckId() != null) {
                deck = vocabDeckRepository.findById(started.deckId()).orElse(null);
            }

            int plausibleWords = finish.wordLimit;
            int reportedAttempts = request.totalAttempts() != null ? request.totalAttempts() : 0;
            int reportedHits = request.hits() != null ? request.hits() : 0;
            int hits = Math.min(reportedHits, plausibleWords);
            int missed = Math.max(0, reportedAttempts - reportedHits);
            int maxPlausibleAttempts = (int) Math.min(Integer.MAX_VALUE, (long) plausibleWords * 4L);
            int attempts = Math.max(hits, Math.min(hits + missed, maxPlausibleAttempts));
            double accuracy = attempts > 0
                    ? Math.min(100.0, Math.max(0.0, Math.round(1000.0 * hits / attempts) / 10.0))
                    : 0.0;
            long scoreCeiling = (long) hits * CARD_BLAST_MAX_SCORE_PER_WORD;
            int score = (int) Math.min(request.score() != null ? request.score() : 0, scoreCeiling);

            com.englishcoach.flashcard.entity.CardBlastRun run = com.englishcoach.flashcard.entity.CardBlastRun.builder()
                    .issuedRunId(started.runId())
                    .user(user)
                    .deck(deck)
                    .score(score)
                    .accuracy(accuracy)
                    .weakWordsCount(weakWordIds.size())
                    .build();
            cardBlastRunRepository.save(run);
            counted = true;
            if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent(userId, run.getId(), deck != null ? deck.getId() : null, score, accuracy, weakWordIds.size(), hits, attempts, Instant.now()));
        } else if (finish == null) {
            log.info("Card Blast result of user {} not counted: no open run for it", userId);
        }

        // Flag weakWordIds in user flashcards to prioritize them in future due queues (R6: single bulk UPDATE)
        if (!weakWordIds.isEmpty()) {
            LocalDateTime now = LocalDateTime.now();
            flashcardRepository.prioritizeWeakFlashcards(userId, weakWordIds, now.minusSeconds(10), now);
        }

        // Record unified learning activity event for a counted run
        if (counted && learningEventService != null && !learningEventService.recordEventSafely(
                userId, "CARD_BLAST_PLAYED", "card_blast:" + request.runId(), Instant.now())) {
            throw new IllegalStateException("Could not record Card Blast activity");
        }

        evictAfterCommit(userId);
        return counted;
    }
}

