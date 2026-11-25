package com.englishcoach.dictionary.service;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CollocationsResponse;
import com.englishcoach.dictionary.dto.PhrasesResponse;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Central deterministic Dictionary Engine V2.
 * Coordinates L1 in-memory cache, L2 persistent database cache, and provider chains.
 * ZERO LLM calls in normal lookup.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DictionaryEngine {

    private static final Pattern STYLE_BLOCK_PATTERN = Pattern.compile("<style[^>]*>.*?</style>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern SCRIPT_BLOCK_PATTERN = Pattern.compile("<script[^>]*>.*?</script>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern MW_CSS_PATTERN = Pattern.compile("\\.?mw-parser-output[^{]*\\{[^}]*\\}", Pattern.CASE_INSENSITIVE);
    private static final Pattern GENERAL_CSS_BLOCK = Pattern.compile("\\.[a-zA-Z0-9_-]+\\s*\\{[^}]*\\}");
    private static final Pattern HTML_TAGS_PATTERN = Pattern.compile("<[^>]+>");
    private static final Pattern MW_PARSER_CLASS = Pattern.compile("\\.?mw-parser-output[\\w-]*", Pattern.CASE_INSENSITIVE);

    private final DictionaryRepository dictionaryRepository;
    private final OxfordProvider oxfordProvider;
    private final CambridgeProvider cambridgeProvider;
    private final WiktionaryProvider wiktionaryProvider;
    private final DictionaryApiDevProvider dictionaryApiDevProvider;
    private final DatamuseProvider datamuseProvider;
    private final GoogleGtxTranslationProvider googleGtxTranslationProvider;
    private final LocalEnViLexicalProvider localEnViLexicalProvider;
    private final PhraseProvider phraseProvider;
    private final KaikkiLocalLexicalStore kaikkiLocalLexicalStore;
    private final ObjectMapper objectMapper;

    /**
     * Revision of the payload this engine builds (owner brief 2026-10-24). Revision 1 (stored as null) assigned GTX
     * terms to English senses by position and Datamuse synonyms to the first sense; such a payload is never served as
     * it is (its sense-level text is dropped and the entry is rebuilt). Bump it whenever stored payloads must be rebuilt.
     */
    public static final int LEXICON_REVISION = 2;
    static final String VIETNAMESE_SOURCE = "Từ điển Anh–Việt Skypedia / MinhQND (CC BY-SA 4.0)";
    /** How long a click waits for a cold build before it is answered from the local dictionary alone. */
    private static final long LOOKUP_WAIT_MS = 4500;
    /** Longest wait when the local dictionary does not know the word either (provider timeouts bound the build). */
    private static final long LOOKUP_WAIT_MAX_MS = 12000;
    /** Budget of the parallel enrichment calls (general meaning, Datamuse, phrases) of one cold build. */
    private static final long ENRICH_WAIT_MS = 2000;
    /** A local-only answer stands in while providers are slow or do not know the word: tried again after this. */
    private static final long LOCAL_ONLY_TTL_NANOS = TimeUnit.MINUTES.toNanos(10);
    private static final long NO_EXPIRY = Long.MAX_VALUE;
    private static final int MAX_VI_MEANINGS_PER_GROUP = 12;
    private static final Pattern LEADING_PUNCTUATION = Pattern.compile("^[\\s;,.:]+");

    // L1 process memory cache (normalized query -> entry); a process start empties it, so a release never serves an
    // entry of the previous build
    private record L1Entry(CanonicalDictionaryResponse value, long expiresAtNanos) {}
    private final Map<String, L1Entry> l1Cache = new ConcurrentHashMap<>(2048);
    private static final int MAX_L1_SIZE = 3000;
    /** One build per word at a time: a second click on the same word waits for the first build. */
    private final Map<String, CompletableFuture<CanonicalDictionaryResponse>> inFlight = new ConcurrentHashMap<>();
    /**
     * Collocation / phrase answers per word (the "Cụm từ liên quan" tab). They come from Datamuse and the local phrase
     * stores, which do not change between requests: one build per word every few hours instead of 3–7 s per request.
     * Only non-empty answers are kept (an empty one may be a provider outage); a process start empties it.
     */
    private record UsageEntry(Object value, long expiresAtNanos) {}
    private final Map<String, UsageEntry> usageCache = new ConcurrentHashMap<>(1024);
    private static final int MAX_USAGE_SIZE = 2000;
    private static final long USAGE_TTL_NANOS = TimeUnit.HOURS.toNanos(6);
    private final ExecutorService buildPool = boundedPool("dict-build", 8, 32);
    private final ExecutorService enrichPool = boundedPool("dict-enrich", 24, 96);

    /** Store reads / writes run in their own short transactions (never across provider calls). Absent in unit tests. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.transaction.PlatformTransactionManager transactionManager;

    private static ExecutorService boundedPool(String name, int threads, int queue) {
        java.util.concurrent.atomic.AtomicInteger n = new java.util.concurrent.atomic.AtomicInteger();
        ThreadPoolExecutor pool = new ThreadPoolExecutor(threads, threads, 60, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(queue), r -> {
                    Thread t = new Thread(r, name + "-" + n.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                }, new ThreadPoolExecutor.AbortPolicy());
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    @jakarta.annotation.PreDestroy
    void shutdownPools() {
        buildPool.shutdownNow();
        enrichPool.shutdownNow();
    }

    private <T> T inTransaction(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new org.springframework.transaction.support.TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    @jakarta.annotation.PostConstruct
    public void seedLocalLexicalStore() {
        try {
            // Which seed words already have a shared entry: ONE read for all of them (performance release 2026-11-16,
            // PERF-16) instead of one remote round trip per word at every start.
            java.util.Collection<CanonicalDictionaryResponse> core = kaikkiLocalLexicalStore.getAllCoreEntries();
            java.util.Set<String> wanted = new java.util.HashSet<>();
            for (CanonicalDictionaryResponse entry : core) {
                if (entry.getNormalizedQuery() != null) wanted.add(entry.getNormalizedQuery().toLowerCase(java.util.Locale.ROOT));
            }
            java.util.Set<String> present = wanted.isEmpty() ? java.util.Set.of()
                    : new java.util.HashSet<>(dictionaryRepository.findSharedWordsAmong(wanted));
            for (CanonicalDictionaryResponse entry : core) {
                String word = entry.getNormalizedQuery();
                if (word != null && !present.contains(word.toLowerCase(java.util.Locale.ROOT))
                        && dictionaryRepository.findByWordIgnoreCase(word).isEmpty()) {
                    saveL2(entry);
                    log.info("[LOCAL_LEXICAL_SEED] Seeded '{}' into L2 persistent database", word);
                }
            }
        } catch (Exception e) {
            log.warn("Failed to auto-seed local lexical store: {}", e.getMessage());
        }
    }

    public enum LexicalExistenceStatus {
        EXISTS,
        VARIANT_OF_EXISTING,
        NOT_FOUND
    }

    public static class LexicalExistenceResult {
        private final LexicalExistenceStatus status;
        private final String canonicalWord;
        private final String note;
        private final CanonicalDictionaryResponse preResolvedEntry;
        /** The entry was read from the L2 store (it may carry text of an older build revision). */
        private final boolean fromStore;

        public LexicalExistenceResult(LexicalExistenceStatus status, String canonicalWord, String note, CanonicalDictionaryResponse preResolvedEntry) {
            this(status, canonicalWord, note, preResolvedEntry, false);
        }

        private LexicalExistenceResult(LexicalExistenceStatus status, String canonicalWord, String note,
                                       CanonicalDictionaryResponse preResolvedEntry, boolean fromStore) {
            this.status = status;
            this.canonicalWord = canonicalWord;
            this.note = note;
            this.preResolvedEntry = preResolvedEntry;
            this.fromStore = fromStore;
        }

        public static LexicalExistenceResult exists(String canonicalWord, CanonicalDictionaryResponse entry) {
            return new LexicalExistenceResult(LexicalExistenceStatus.EXISTS, canonicalWord, null, entry);
        }

        static LexicalExistenceResult storedEntry(String canonicalWord, CanonicalDictionaryResponse entry) {
            return new LexicalExistenceResult(LexicalExistenceStatus.EXISTS, canonicalWord, null, entry, true);
        }

        public static LexicalExistenceResult variantOf(String canonicalWord, String note, CanonicalDictionaryResponse entry) {
            return new LexicalExistenceResult(LexicalExistenceStatus.VARIANT_OF_EXISTING, canonicalWord, note, entry);
        }

        static LexicalExistenceResult variantOf(String canonicalWord, String note, LexicalExistenceResult base) {
            return new LexicalExistenceResult(LexicalExistenceStatus.VARIANT_OF_EXISTING, canonicalWord, note,
                    base.getPreResolvedEntry(), base.isFromStore());
        }

        public boolean isFromStore() { return fromStore; }

        public static LexicalExistenceResult notFound() {
            return new LexicalExistenceResult(LexicalExistenceStatus.NOT_FOUND, null, null, null);
        }

        public LexicalExistenceStatus getStatus() { return status; }
        public String getCanonicalWord() { return canonicalWord; }
        public String getNote() { return note; }
        public CanonicalDictionaryResponse getPreResolvedEntry() { return preResolvedEntry; }
    }

    /**
     * Resolves whether a query has trusted lexical existence.
     * Evaluates local store, indexed database, base lemmas, and authoritative providers.
     * ZERO AI calls.
     */
    public LexicalExistenceResult resolveLexicalExistence(String normalizedQuery) {
        if (normalizedQuery == null || normalizedQuery.isBlank()) {
            return LexicalExistenceResult.notFound();
        }

        String clean = normalizedQuery.trim().toLowerCase().replaceAll("\\s+", " ");

        // 1. Direct Multi-Word Phrase Check (Curated/lexical store for multi-word units)
        Optional<CanonicalDictionaryResponse> directEntry = phraseProvider.resolveMultiWordEntry(clean);
        if (directEntry.isPresent() && hasMeaningfulLexicalContent(directEntry.get())) {
            return LexicalExistenceResult.exists(clean, directEntry.get());
        }

        // 2. Local Kaikki / Wiktextract Offline Lexical Store
        Optional<CanonicalDictionaryResponse> localKaikkiOpt = kaikkiLocalLexicalStore.getEntry(clean);
        if (localKaikkiOpt.isPresent() && hasMeaningfulLexicalContent(localKaikkiOpt.get())) {
            return LexicalExistenceResult.exists(clean, localKaikkiOpt.get());
        }

        // 3. L2 Persistent Database Cache (only if has trusted source evidence and meaningful lexical content)
        CanonicalDictionaryResponse stored = inTransaction(() -> readStoredEntry(clean));
        if (stored != null) {
            return LexicalExistenceResult.storedEntry(clean, stored);
        }

        // 4. Lemma Resolution (e.g., "took" -> "take", "screamed" -> "scream")
        Optional<KaikkiLocalLexicalStore.LemmaInfo> lemmaOpt = kaikkiLocalLexicalStore.resolveLemma(clean);
        if (lemmaOpt.isPresent()) {
            KaikkiLocalLexicalStore.LemmaInfo lemmaInfo = lemmaOpt.get();
            String baseLemma = lemmaInfo.getLemma() != null ? lemmaInfo.getLemma().toLowerCase().trim() : null;
            if (baseLemma != null && !baseLemma.equals(clean)) {
                // Base lemma must itself have trusted lexical existence
                LexicalExistenceResult baseExistence = resolveLexicalExistence(baseLemma);
                if (baseExistence.getStatus() != LexicalExistenceStatus.NOT_FOUND) {
                    return LexicalExistenceResult.variantOf(baseLemma, lemmaInfo.getNote(), baseExistence);
                }
            }
        }

        // 5. Authoritative Provider Chain (Oxford, Wiktionary, DictionaryApiDev)
        if (oxfordProvider.isAvailable()) {
            Optional<CanonicalDictionaryResponse> oxfordOpt = oxfordProvider.lookup(clean, "en-en");
            if (oxfordOpt.isPresent() && hasMeaningfulLexicalContent(oxfordOpt.get())) {
                return LexicalExistenceResult.exists(clean, oxfordOpt.get());
            }
        }

        Optional<CanonicalDictionaryResponse> wikOpt = wiktionaryProvider.lookup(clean, "en-en");
        if (wikOpt.isPresent() && hasMeaningfulLexicalContent(wikOpt.get())) {
            return LexicalExistenceResult.exists(clean, wikOpt.get());
        }

        Optional<CanonicalDictionaryResponse> devOpt = dictionaryApiDevProvider.lookup(clean, "en-en");
        if (devOpt.isPresent() && hasMeaningfulLexicalContent(devOpt.get())) {
            return LexicalExistenceResult.exists(clean, devOpt.get());
        }

        // 6. Deterministic Alternate Spelling Candidates
        List<String> altCandidates = getAlternateSpellingCandidates(clean);
        for (String alt : altCandidates) {
            if (alt.isBlank() || alt.equals(clean)) continue;

            Optional<CanonicalDictionaryResponse> altDirect = phraseProvider.resolveMultiWordEntry(alt);
            if (altDirect.isPresent() && hasMeaningfulLexicalContent(altDirect.get())) {
                return LexicalExistenceResult.variantOf(alt, "Biến thể chính tả của '" + alt + "'", altDirect.get());
            }
            Optional<CanonicalDictionaryResponse> altKaikki = kaikkiLocalLexicalStore.getEntry(alt);
            if (altKaikki.isPresent() && hasMeaningfulLexicalContent(altKaikki.get())) {
                return LexicalExistenceResult.variantOf(alt, "Biến thể chính tả của '" + alt + "'", altKaikki.get());
            }
            Optional<CanonicalDictionaryResponse> altWik = wiktionaryProvider.lookup(alt, "en-en");
            if (altWik.isPresent() && hasMeaningfulLexicalContent(altWik.get())) {
                return LexicalExistenceResult.variantOf(alt, "Biến thể chính tả của '" + alt + "'", altWik.get());
            }
            Optional<CanonicalDictionaryResponse> altDev = dictionaryApiDevProvider.lookup(alt, "en-en");
            if (altDev.isPresent() && hasMeaningfulLexicalContent(altDev.get())) {
                return LexicalExistenceResult.variantOf(alt, "Biến thể chính tả của '" + alt + "'", altDev.get());
            }
        }

        return LexicalExistenceResult.notFound();
    }

    private List<String> getAlternateSpellingCandidates(String normalizedQuery) {
        List<String> altCandidates = new ArrayList<>();
        String apostropheNormalized = normalizedQuery.replace('’', '\'').replace('‘', '\'');
        if (!apostropheNormalized.equals(normalizedQuery)) {
            altCandidates.add(apostropheNormalized);
        }
        if (normalizedQuery.contains(" ")) {
            altCandidates.add(normalizedQuery.replace(' ', '-'));
        } else if (normalizedQuery.contains("-")) {
            altCandidates.add(normalizedQuery.replace('-', ' '));
        }
        return altCandidates;
    }

    /**
     * One dictionary lookup (owner brief 2026-10-24). L1 → a stored payload of the current revision (one indexed read,
     * no provider call) → a build: lexical existence, then the local EN–VI dictionary plus the remote enrichment calls
     * in parallel under one deadline. A click waits at most {@link #LOOKUP_WAIT_MS} for a cold build; past it the local
     * dictionary answers and the build goes on to fill both caches. The mode no longer changes the payload: every
     * entry carries its Vietnamese layer.
     */
    public CanonicalDictionaryResponse lookup(String rawQuery, String mode) {
        if (rawQuery == null || rawQuery.isBlank()) {
            throw new IllegalArgumentException("Search query must not be empty");
        }

        String normalizedQuery = normalizeQuery(rawQuery);
        String cacheKey = normalizedQuery;

        // 1. L1 Process Memory Cache (Instant, < 1ms)
        CanonicalDictionaryResponse l1Hit = readL1(cacheKey);
        if (l1Hit != null) {
            log.debug("[L1_CACHE_HIT] Fast return for '{}'", normalizedQuery);
            return l1Hit;
        }

        CompletableFuture<CanonicalDictionaryResponse> build = inFlight.get(cacheKey);
        if (build == null) {
            CompletableFuture<CanonicalDictionaryResponse> mine = new CompletableFuture<>();
            build = inFlight.putIfAbsent(cacheKey, mine);
            if (build == null) {
                build = mine;
                try {
                    buildPool.execute(() -> runBuild(mine, rawQuery, normalizedQuery, cacheKey));
                } catch (RejectedExecutionException busy) {
                    runBuild(mine, rawQuery, normalizedQuery, cacheKey); // saturated: build on the request thread
                }
            }
        }
        try {
            return build.get(LOOKUP_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException slow) {
            // providers are slow: the local dictionary answers now; the build goes on and fills both caches
            CanonicalDictionaryResponse local = localOnlyEntry(normalizedQuery);
            if (local != null) {
                putL1IfAbsentOrExpired(cacheKey, local, LOCAL_ONLY_TTL_NANOS);
                return local;
            }
            try {
                return build.get(LOOKUP_WAIT_MAX_MS - LOOKUP_WAIT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException stillSlow) {
                return null;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            } catch (ExecutionException e) {
                throw unwrap(e);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return localOnlyEntry(normalizedQuery);
        } catch (ExecutionException e) {
            throw unwrap(e);
        }
    }

    /** NFC, trimmed, lower case (locale independent), single spaces: one cache key per word however it was typed. */
    static String normalizeQuery(String rawQuery) {
        return java.text.Normalizer.normalize(rawQuery.trim(), java.text.Normalizer.Form.NFC)
                .toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
    }

    private static RuntimeException unwrap(ExecutionException e) {
        Throwable cause = e.getCause();
        return cause instanceof RuntimeException re ? re : new IllegalStateException(cause);
    }

    private void runBuild(CompletableFuture<CanonicalDictionaryResponse> target, String rawQuery,
                          String normalizedQuery, String cacheKey) {
        try {
            target.complete(buildEntry(rawQuery, normalizedQuery, cacheKey));
        } catch (Throwable t) {
            target.completeExceptionally(t);
        } finally {
            inFlight.remove(cacheKey, target);
        }
    }

    private CanonicalDictionaryResponse buildEntry(String rawQuery, String normalizedQuery, String cacheKey) {
        // 2. A stored payload of the current revision is served as it is: one read, no provider call
        CanonicalDictionaryResponse current = readCurrentStored(normalizedQuery);
        if (current != null) {
            putL1(cacheKey, current, NO_EXPIRY);
            return current;
        }

        // 3. Trusted Lexical Existence Gate
        LexicalExistenceResult existence = resolveLexicalExistence(normalizedQuery);
        if (existence.getStatus() == LexicalExistenceStatus.NOT_FOUND) {
            CanonicalDictionaryResponse local = localOnlyEntry(normalizedQuery);
            if (local != null) {
                log.info("[LEXICAL_EXISTENCE_GATE] '{}' answered from the local EN-VI dictionary only", normalizedQuery);
                putL1(cacheKey, local, LOCAL_ONLY_TTL_NANOS);
                return local;
            }
            log.info("[LEXICAL_EXISTENCE_GATE] Query '{}' has no trusted lexical evidence - returning NOT_FOUND", normalizedQuery);
            return null;
        }

        // 3. Resolve entry from trusted source
        CanonicalDictionaryResponse response = null;
        if (existence.getPreResolvedEntry() != null) {
            response = cloneResponse(existence.getPreResolvedEntry());
        } else if (existence.getCanonicalWord() != null) {
            LexicalExistenceResult resolved = resolveLexicalExistence(existence.getCanonicalWord());
            if (resolved.getPreResolvedEntry() != null) {
                response = cloneResponse(resolved.getPreResolvedEntry());
            }
        }

        if (response == null) {
            return null;
        }

        // If variant of existing (inflection or spelling variant), set query details
        if (existence.getStatus() == LexicalExistenceStatus.VARIANT_OF_EXISTING) {
            response.setQuery(rawQuery.trim());
            response.setSearchedForm(rawQuery.trim());
            if (existence.getNote() != null) {
                response.setInflectionNote(existence.getNote());
            }
        }

        // A stored payload of the current revision (a variant reaching its base entry) needs no further work
        if (existence.isFromStore() && isCurrentRevision(response)) {
            putL1(cacheKey, response, NO_EXPIRY);
            return response;
        }
        if (existence.isFromStore()) {
            retireUnalignedText(response);
        }

        // 4. Post-Provider Enrichment (Vietnamese, Collocations, Phrasal verbs, Idioms, WordNet)
        String lookupWord = existence.getCanonicalWord() != null ? existence.getCanonicalWord() : normalizedQuery;
        enrich(response, normalizedQuery, lookupWord);

        // Set entry type & hygiene using source metadata
        sanitizeResponse(response, normalizedQuery);
        if (response.getEntryType() == null || response.getEntryType().isBlank()) {
            response.setEntryType(classifyEntry(response));
        }
        response.setLexiconRevision(LEXICON_REVISION);

        // 5. Persist to L2 Database Cache (only if exact base entry, not arbitrary inflections)
        if (existence.getStatus() == LexicalExistenceStatus.EXISTS) {
            saveL2(response);
        }

        // 6. Cache in L1 Memory Cache
        putL1(cacheKey, response, NO_EXPIRY);

        return response;
    }

    static boolean isCurrentRevision(CanonicalDictionaryResponse response) {
        return response != null && response.getLexiconRevision() != null
                && response.getLexiconRevision() >= LEXICON_REVISION;
    }

    /** Sources whose sense-level Vietnamese text belongs to that very sense (curated, aligned entries). */
    private static boolean hasAlignedSenseText(CanonicalDictionaryResponse response) {
        String source = response.getSource();
        return source != null && (source.contains("Kaikki") || source.contains("Wiktextract") || source.contains("Direct"));
    }

    /**
     * A payload of an older revision: its sense-level Vietnamese text came from GTX terms assigned by position and its
     * first sense held Datamuse's word-level synonyms. Both are dropped from the senses (the synonyms move to the
     * word); English senses, examples, IPA, collocations and phrases are kept. Multi-word entries never got GTX text.
     */
    private void retireUnalignedText(CanonicalDictionaryResponse response) {
        if (isCurrentRevision(response) || hasAlignedSenseText(response)
                || GoogleGtxTranslationProvider.isMultiWordUnit(response) || response.getPartsOfSpeech() == null) {
            return;
        }
        boolean first = true;
        for (CanonicalDictionaryResponse.PartOfSpeechGroupDto group : response.getPartsOfSpeech()) {
            if (group.getSenses() == null) continue;
            for (CanonicalDictionaryResponse.SenseDto sense : group.getSenses()) {
                sense.setTranslationVi(null);
                if (first) {
                    if (response.getSynonyms() == null && sense.getSynonyms() != null) response.setSynonyms(sense.getSynonyms());
                    if (response.getAntonyms() == null && sense.getAntonyms() != null) response.setAntonyms(sense.getAntonyms());
                    sense.setSynonyms(null);
                    sense.setAntonyms(null);
                    first = false;
                }
            }
        }
    }

    /**
     * The Vietnamese layer (local dictionary, on this thread) and the remote enrichment calls (general meaning,
     * collocations, phrases, word-level synonyms / antonyms / related words) in parallel under one deadline. A call
     * that misses the deadline is left out; nothing waits for it. Only what the payload lacks is fetched.
     */
    private void enrich(CanonicalDictionaryResponse response, String normalizedQuery, String lookupWord) {
        boolean multiWord = GoogleGtxTranslationProvider.isMultiWordUnit(response);
        boolean needGeneral = !multiWord && isBlank(response.getGeneralTranslationVi());
        boolean needPhrases = isEmpty(response.getPhrasalVerbs()) && isEmpty(response.getIdioms()) && isEmpty(response.getExpressions());

        CompletableFuture<String> general = needGeneral
                ? async(() -> googleGtxTranslationProvider.translateWordGeneral(normalizedQuery)) : done();
        CompletableFuture<List<CanonicalDictionaryResponse.CollocationDto>> collocations = isEmpty(response.getCollocations())
                ? async(() -> datamuseProvider.getCollocations(lookupWord)) : done();
        CompletableFuture<PhrasesResponse> phrases = needPhrases
                ? async(() -> phraseProvider.getPhrasesForWord(lookupWord)) : done();
        CompletableFuture<List<String>> synonyms = response.getSynonyms() == null
                ? async(() -> datamuseProvider.getSynonyms(lookupWord)) : done();
        CompletableFuture<List<String>> antonyms = response.getAntonyms() == null
                ? async(() -> datamuseProvider.getAntonyms(lookupWord)) : done();
        CompletableFuture<List<String>> related = isEmpty(response.getRelatedWords())
                ? async(() -> datamuseProvider.getRelatedWords(lookupWord)) : done();

        enrichVietnamese(response, normalizedQuery);

        try {
            CompletableFuture.allOf(general, collocations, phrases, synonyms, antonyms, related)
                    .get(ENRICH_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException | ExecutionException ignored) {
            // whatever finished in time is used below
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        String generalVi = resultOf(general);
        if (needGeneral && !isBlank(generalVi)) {
            response.setGeneralTranslationVi(generalVi);
        }
        if (!multiWord && isBlank(response.getGeneralTranslationVi())) {
            response.setGeneralTranslationVi(localGeneralMeaning(response)); // the dictionary's own first meaning
        }
        List<CanonicalDictionaryResponse.CollocationDto> collocationList = resultOf(collocations);
        if (collocationList != null && !collocationList.isEmpty()) response.setCollocations(collocationList);
        PhrasesResponse phraseSet = resultOf(phrases);
        if (phraseSet != null) {
            if (!isEmpty(phraseSet.getPhrasalVerbs())) response.setPhrasalVerbs(phraseSet.getPhrasalVerbs());
            if (!isEmpty(phraseSet.getIdioms())) response.setIdioms(phraseSet.getIdioms());
            if (!isEmpty(phraseSet.getExpressions())) response.setExpressions(phraseSet.getExpressions());
        }
        List<String> synonymList = resultOf(synonyms);
        if (synonymList != null) response.setSynonyms(distinctWords(synonymList, response.getHeadword(), 10));
        List<String> antonymList = resultOf(antonyms);
        if (antonymList != null) response.setAntonyms(distinctWords(antonymList, response.getHeadword(), 8));
        List<String> relatedList = resultOf(related);
        if (relatedList != null && !relatedList.isEmpty()) response.setRelatedWords(relatedList);
    }

    private <T> CompletableFuture<T> async(Supplier<T> task) {
        try {
            return CompletableFuture.supplyAsync(task, enrichPool);
        } catch (RejectedExecutionException busy) {
            return done(); // saturated: this piece is left out of this build
        }
    }

    private static <T> CompletableFuture<T> done() {
        return CompletableFuture.completedFuture(null);
    }

    private static <T> T resultOf(CompletableFuture<T> future) {
        try {
            return future.getNow(null);
        } catch (Exception failed) {
            return null;
        }
    }

    private static List<String> distinctWords(List<String> words, String headword, int max) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String w : words) {
            if (w == null) continue;
            String clean = w.trim().toLowerCase(Locale.ROOT);
            if (!clean.isEmpty() && (headword == null || !clean.equalsIgnoreCase(headword.trim()))) out.add(clean);
            if (out.size() >= max) break;
        }
        return new ArrayList<>(out);
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static boolean isEmpty(Collection<?> c) {
        return c == null || c.isEmpty();
    }

    // ---------- L1 ----------

    private CanonicalDictionaryResponse readL1(String key) {
        L1Entry entry = l1Cache.get(key);
        if (entry == null) return null;
        boolean expired = entry.expiresAtNanos() != NO_EXPIRY && System.nanoTime() - entry.expiresAtNanos() > 0;
        if (expired || !isCurrentRevision(entry.value()) || !hasPresentableContent(entry.value())) {
            l1Cache.remove(key, entry);
            return null;
        }
        return entry.value();
    }

    private void putL1(String key, CanonicalDictionaryResponse value, long ttlNanos) {
        if (l1Cache.size() >= MAX_L1_SIZE) {
            long now = System.nanoTime();
            l1Cache.entrySet().removeIf(e -> e.getValue().expiresAtNanos() != NO_EXPIRY && now - e.getValue().expiresAtNanos() > 0);
            // Incremental 15% eviction instead of clear() cliff that causes a thundering herd on Azure PG
            if (l1Cache.size() >= MAX_L1_SIZE) {
                int toEvict = Math.max(1, MAX_L1_SIZE / 7);
                var it = l1Cache.keySet().iterator();
                while (it.hasNext() && toEvict-- > 0) {
                    it.next();
                    it.remove();
                }
            }
        }
        l1Cache.put(key, new L1Entry(value, ttlNanos == NO_EXPIRY ? NO_EXPIRY : System.nanoTime() + ttlNanos));
    }

    /** Never replaces a live entry: a full build that finished first wins over a local stand-in. */
    private void putL1IfAbsentOrExpired(String key, CanonicalDictionaryResponse value, long ttlNanos) {
        L1Entry fresh = new L1Entry(value, System.nanoTime() + ttlNanos);
        l1Cache.compute(key, (k, old) -> old == null || readL1Expired(old) ? fresh : old);
    }

    private static boolean readL1Expired(L1Entry entry) {
        return entry.expiresAtNanos() != NO_EXPIRY && System.nanoTime() - entry.expiresAtNanos() > 0;
    }

    // ---------- L2 reads ----------

    /** A stored shared payload of the current revision, else null. One read of the payload column only. */
    private CanonicalDictionaryResponse readCurrentStored(String normalizedQuery) {
        try {
            String json = dictionaryRepository.findSharedPayload(normalizedQuery);
            if (json == null || json.isBlank()) return null;
            CanonicalDictionaryResponse response = objectMapper.readValue(json, CanonicalDictionaryResponse.class);
            return isCurrentRevision(response) && canPersistLexicalEntry(response) ? response : null;
        } catch (Exception e) {
            log.debug("Stored payload of '{}' unreadable: {}", normalizedQuery, e.getMessage());
            return null;
        }
    }

    /** The stored shared entry of a word as a payload (its own, or built from the legacy columns), else null. */
    private CanonicalDictionaryResponse readStoredEntry(String clean) {
        Optional<DictionaryEntry> dbEntryOpt = dictionaryRepository.findByWordIgnoreCase(clean);
        if (dbEntryOpt.isEmpty()) return null;
        DictionaryEntry dbEntry = dbEntryOpt.get();
        if (dbEntry.getDataJson() != null && !dbEntry.getDataJson().isBlank()) {
            try {
                CanonicalDictionaryResponse response = objectMapper.readValue(
                        dbEntry.getDataJson(), CanonicalDictionaryResponse.class);
                if (canPersistLexicalEntry(response)) {
                    if (GoogleGtxTranslationProvider.isMultiWordUnit(response)) {
                        sanitizeMultiWordCachedVi(response);
                    }
                    return response;
                }
                log.warn("[L2_STALE_INVALID_CACHE] Ignoring invalid cached shell for '{}'", clean);
            } catch (Exception e) {
                log.warn("Failed to deserialize dataJson for word '{}': {}", clean, e.getMessage());
            }
        } else if (dbEntry.getMeanings() != null && !dbEntry.getMeanings().isEmpty()) {
            CanonicalDictionaryResponse migrated = buildFromLegacy(dbEntry, clean);
            if (canPersistLexicalEntry(migrated)) {
                if (GoogleGtxTranslationProvider.isMultiWordUnit(migrated)) {
                    sanitizeMultiWordCachedVi(migrated);
                }
                return migrated;
            }
        }
        return null;
    }

    // ---------- local EN-VI dictionary ----------

    private Optional<LocalEnViLexicalProvider.EnViEntry> localEntry(CanonicalDictionaryResponse response, String normalizedQuery) {
        String headword = response != null && response.getHeadword() != null ? response.getHeadword() : normalizedQuery;
        Optional<LocalEnViLexicalProvider.EnViEntry> hit = localEnViLexicalProvider.lookupEntry(headword);
        if (hit.isEmpty() && !headword.equalsIgnoreCase(normalizedQuery)) {
            hit = localEnViLexicalProvider.lookupEntry(normalizedQuery);
        }
        return hit;
    }

    /** The dictionary's senses grouped by part of speech, in its own order; cleaned, de-duplicated, bounded. */
    static List<CanonicalDictionaryResponse.VietnameseSenseGroupDto> groupLocalSenses(List<LocalEnViLexicalProvider.EnViDefinition> definitions) {
        Map<String, LinkedHashSet<String>> groups = new LinkedHashMap<>();
        for (LocalEnViLexicalProvider.EnViDefinition d : definitions) {
            if (d.getDefinition() == null) continue;
            String meaning = LEADING_PUNCTUATION.matcher(java.text.Normalizer.normalize(d.getDefinition().trim(),
                    java.text.Normalizer.Form.NFC)).replaceFirst("").trim();
            if (meaning.isEmpty()) continue;
            LinkedHashSet<String> list = groups.computeIfAbsent(localPartOfSpeech(d.getPos()), k -> new LinkedHashSet<>());
            if (list.size() < MAX_VI_MEANINGS_PER_GROUP) list.add(meaning);
        }
        List<CanonicalDictionaryResponse.VietnameseSenseGroupDto> out = new ArrayList<>();
        groups.forEach((pos, meanings) -> out.add(CanonicalDictionaryResponse.VietnameseSenseGroupDto.builder()
                .partOfSpeech(pos)
                .meanings(new ArrayList<>(meanings))
                .build()));
        return out;
    }

    /** The dataset's part-of-speech codes as the labels the other providers use. */
    static String localPartOfSpeech(String code) {
        if (code == null) return "other";
        return switch (code.trim()) {
            case "N", "noun" -> "noun";
            case "V", "verb" -> "verb";
            case "A", "adj" -> "adjective";
            case "D", "adv" -> "adverb";
            case "P", "pron" -> "pronoun";
            case "C" -> "conjunction";
            case "E" -> "preposition";
            case "M" -> "numeral";
            case "O" -> "interjection";
            case "idiom" -> "idiom";
            case "name" -> "proper noun";
            default -> "other";
        };
    }

    /** The first meaning of the group matching the entry's first English part of speech, else of the first group. */
    private static String localGeneralMeaning(CanonicalDictionaryResponse response) {
        List<CanonicalDictionaryResponse.VietnameseSenseGroupDto> groups = response.getVietnameseSenses();
        if (groups == null || groups.isEmpty()) return null;
        String firstPos = response.getPartsOfSpeech() != null && !response.getPartsOfSpeech().isEmpty()
                && response.getPartsOfSpeech().get(0).getPartOfSpeech() != null
                ? response.getPartsOfSpeech().get(0).getPartOfSpeech().toLowerCase(Locale.ROOT) : "";
        CanonicalDictionaryResponse.VietnameseSenseGroupDto chosen = groups.stream()
                .filter(g -> !firstPos.isEmpty() && firstPos.contains(g.getPartOfSpeech()))
                .findFirst().orElse(groups.get(0));
        if (chosen.getMeanings() == null || chosen.getMeanings().isEmpty()) return null;
        String meaning = chosen.getMeanings().get(0);
        return meaning.endsWith(".") ? meaning.substring(0, meaning.length() - 1).trim() : meaning;
    }

    /**
     * An entry built from the local dictionary alone: when the English providers do not know the word, or are too slow
     * for this click. Its senses are the dictionary's Vietnamese senses (no English definition is invented). Never
     * stored in L2; kept in L1 for {@link #LOCAL_ONLY_TTL_NANOS} only.
     */
    CanonicalDictionaryResponse localOnlyEntry(String normalizedQuery) {
        Optional<LocalEnViLexicalProvider.EnViEntry> hit = localEnViLexicalProvider.lookupEntry(normalizedQuery);
        if (hit.isEmpty()) return null;
        List<CanonicalDictionaryResponse.VietnameseSenseGroupDto> groups = groupLocalSenses(hit.get().getDefinitions());
        if (groups.isEmpty()) return null;
        List<CanonicalDictionaryResponse.PartOfSpeechGroupDto> parts = new ArrayList<>();
        int id = 1;
        for (CanonicalDictionaryResponse.VietnameseSenseGroupDto g : groups) {
            List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();
            for (String meaning : g.getMeanings()) {
                senses.add(CanonicalDictionaryResponse.SenseDto.builder().id(String.valueOf(id++)).translationVi(meaning).build());
            }
            parts.add(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder().partOfSpeech(g.getPartOfSpeech()).senses(senses).build());
        }
        String word = hit.get().getWord();
        CanonicalDictionaryResponse response = CanonicalDictionaryResponse.builder()
                .query(normalizedQuery)
                .normalizedQuery(normalizedQuery)
                .headword(word)
                .entryType(word.contains(" ") ? "EXPRESSION" : "WORD")
                .source(VIETNAMESE_SOURCE)
                .partsOfSpeech(parts)
                .vietnameseSenses(groups)
                .vietnameseSource(VIETNAMESE_SOURCE)
                .pronunciations(localPronunciation(hit.get().getIpa()))
                .lexiconRevision(LEXICON_REVISION)
                .build();
        response.setGeneralTranslationVi(localGeneralMeaning(response));
        return response;
    }

    private static List<CanonicalDictionaryResponse.PronunciationDto> localPronunciation(String ipa) {
        List<CanonicalDictionaryResponse.PronunciationDto> prons = new ArrayList<>();
        if (ipa != null && !ipa.isBlank()) {
            String clean = ipa.trim();
            if (!clean.startsWith("/") && !clean.startsWith("[")) clean = "/" + clean + "/";
            prons.add(CanonicalDictionaryResponse.PronunciationDto.builder().ipa(clean).region("General").build());
        }
        return prons;
    }

    /** Content a learner can be shown: an English definition, or (local-only entries) a Vietnamese sense. */
    static boolean hasPresentableContent(CanonicalDictionaryResponse resp) {
        if (hasMeaningfulLexicalContent(resp)) return true;
        if (resp == null || resp.getPartsOfSpeech() == null) return false;
        return resp.getPartsOfSpeech().stream().filter(g -> g.getSenses() != null).flatMap(g -> g.getSenses().stream())
                .anyMatch(s -> s.getTranslationVi() != null && !s.getTranslationVi().isBlank());
    }

    public CollocationsResponse getCollocations(String word) {
        if (word == null || word.isBlank()) {
            return CollocationsResponse.builder().word("").groups(Collections.emptyList()).build();
        }
        String clean = word.trim().toLowerCase().replaceAll("\\s+", " ");
        return cachedUsage("c:" + clean, () -> {
            LexicalExistenceResult existence = resolveLexicalExistence(clean);
            if (existence.getStatus() == LexicalExistenceStatus.NOT_FOUND) {
                log.debug("[USAGE_GATE_BLOCKED] Collocations skipped for unverified lexical query '{}'", clean);
                return CollocationsResponse.builder().word(word).groups(Collections.emptyList()).build();
            }
            String targetWord = existence.getCanonicalWord() != null ? existence.getCanonicalWord() : clean;
            return datamuseProvider.getCollocationsGrouped(targetWord);
        }, r -> r != null && r.getGroups() != null && r.getGroups().stream().anyMatch(g -> g.getItems() != null && !g.getItems().isEmpty()));
    }

    @SuppressWarnings("unchecked")
    private <T> T cachedUsage(String key, Supplier<T> build, java.util.function.Predicate<T> worthKeeping) {
        UsageEntry hit = usageCache.get(key);
        if (hit != null && System.nanoTime() - hit.expiresAtNanos() < 0) return (T) hit.value();
        T value = build.get();
        if (worthKeeping.test(value)) {
            if (usageCache.size() > MAX_USAGE_SIZE) usageCache.clear();
            usageCache.put(key, new UsageEntry(value, System.nanoTime() + USAGE_TTL_NANOS));
        }
        return value;
    }

    public PhrasesResponse getPhrases(String word) {
        if (word == null || word.isBlank()) {
            return PhrasesResponse.builder()
                    .word("")
                    .phrasalVerbs(Collections.emptyList())
                    .idioms(Collections.emptyList())
                    .expressions(Collections.emptyList())
                    .build();
        }
        String clean = word.trim().toLowerCase().replaceAll("\\s+", " ");
        return cachedUsage("p:" + clean, () -> {
            LexicalExistenceResult existence = resolveLexicalExistence(clean);
            if (existence.getStatus() == LexicalExistenceStatus.NOT_FOUND) {
                log.debug("[USAGE_GATE_BLOCKED] Phrases skipped for unverified lexical query '{}'", clean);
                return PhrasesResponse.builder()
                        .word(word)
                        .phrasalVerbs(Collections.emptyList())
                        .idioms(Collections.emptyList())
                        .expressions(Collections.emptyList())
                        .build();
            }
            String targetWord = existence.getCanonicalWord() != null ? existence.getCanonicalWord() : clean;
            return phraseProvider.getPhrasesForWord(targetWord);
        }, r -> r != null && (!isEmpty(r.getPhrasalVerbs()) || !isEmpty(r.getIdioms()) || !isEmpty(r.getExpressions())));
    }

    private void ensureRelatedUsageLoaded(CanonicalDictionaryResponse response, String normalizedQuery) {
        if (normalizedQuery == null || normalizedQuery.contains(" ")) return;

        boolean missingCollocations = response.getCollocations() == null || response.getCollocations().isEmpty();
        boolean missingPhrases = (response.getPhrasalVerbs() == null || response.getPhrasalVerbs().isEmpty())
                && (response.getIdioms() == null || response.getIdioms().isEmpty());

        boolean updated = false;
        if (missingCollocations) {
            List<CanonicalDictionaryResponse.CollocationDto> collocations = datamuseProvider.getCollocations(normalizedQuery);
            if (!collocations.isEmpty()) {
                response.setCollocations(collocations);
                updated = true;
            }
        }

        if (missingPhrases) {
            PhrasesResponse phrases = phraseProvider.getPhrasesForWord(normalizedQuery);
            if (phrases.getPhrasalVerbs() != null && !phrases.getPhrasalVerbs().isEmpty()) {
                response.setPhrasalVerbs(phrases.getPhrasalVerbs());
                updated = true;
            }
            if (phrases.getIdioms() != null && !phrases.getIdioms().isEmpty()) {
                response.setIdioms(phrases.getIdioms());
                updated = true;
            }
            if (phrases.getExpressions() != null && !phrases.getExpressions().isEmpty()) {
                response.setExpressions(phrases.getExpressions());
                updated = true;
            }
        }

        if (updated) {
            saveL2(response);
        }
    }

    private void saveL2(CanonicalDictionaryResponse response) {
        if (!canPersistLexicalEntry(response)) {
            log.debug("[L2_SKIP_SAVE] Not saving response failing lexical trust rules for '{}'", response != null ? response.getNormalizedQuery() : "null");
            return;
        }
        inTransaction(() -> {
            writeL2(response);
            return null;
        });
    }

    private void writeL2(CanonicalDictionaryResponse response) {
        try {
            String word = response.getNormalizedQuery();
            String dataJson = objectMapper.writeValueAsString(response);

            // Backward compatibility lists for legacy consumers (Flashcards, etc.)
            List<String> meanings = new ArrayList<>();
            List<String> examples = new ArrayList<>();
            List<String> synonyms = new ArrayList<>();
            List<String> collocations = new ArrayList<>();

            if (response.getPartsOfSpeech() != null) {
                for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : response.getPartsOfSpeech()) {
                    if (posGroup.getSenses() != null) {
                        for (CanonicalDictionaryResponse.SenseDto sense : posGroup.getSenses()) {
                            // English definitions only: Flashcard faces read these as definitions, and a Vietnamese
                            // sense text between them was shown as one (owner brief 2026-10-24)
                            if (sense.getDefinitionEn() != null) meanings.add(sense.getDefinitionEn());
                            if (sense.getExamples() != null) examples.addAll(sense.getExamples());
                            if (sense.getSynonyms() != null) synonyms.addAll(sense.getSynonyms());
                        }
                    }
                }
            }

            if (response.getCollocations() != null) {
                for (CanonicalDictionaryResponse.CollocationDto c : response.getCollocations()) {
                    collocations.add(c.getPhrase());
                }
            }

            String ipa = null;
            if (response.getPronunciations() != null && !response.getPronunciations().isEmpty()) {
                ipa = response.getPronunciations().get(0).getIpa();
            }

            if (response.getSynonyms() != null) synonyms.addAll(response.getSynonyms());

            Optional<DictionaryEntry> existingOpt = dictionaryRepository.findByWordIgnoreCase(word);
            DictionaryEntry entry;
            if (existingOpt.isPresent()) {
                entry = existingOpt.get();
                boolean enginePayload = entry.getDataJson() != null && !entry.getDataJson().isBlank();
                if (!enginePayload && !dictionaryRepository.isInSystemDeck(entry.getId())) {
                    // a payload-less shared row outside the SYSTEM decks may hold a learner's text from before V102:
                    // never rewritten here (owner decision: those rows await a provenance review)
                    log.debug("[L2_SKIP_SAVE] Leaving unreviewed shared row of '{}' unchanged", word);
                    return;
                }
                entry.setDataJson(dataJson);
                entry.setEntryType(response.getEntryType());
                entry.setGeneralTranslationVi(response.getGeneralTranslationVi());
                entry.setUpdatedAt(LocalDateTime.now());
                if (ipa != null) entry.setIpa(ipa);
                if (!meanings.isEmpty()) entry.setMeanings(meanings.subList(0, Math.min(meanings.size(), 10)));
                if (!examples.isEmpty()) entry.setExamples(examples.subList(0, Math.min(examples.size(), 5)));
                if (!synonyms.isEmpty()) entry.setSynonyms(synonyms.subList(0, Math.min(synonyms.size(), 8)));
                if (!collocations.isEmpty()) entry.setCollocations(collocations.subList(0, Math.min(collocations.size(), 8)));
            } else {
                entry = DictionaryEntry.builder()
                        .word(word)
                        .ipa(ipa)
                        .cefr(response.getCefr() != null ? response.getCefr() : "B2")
                        .entryType(response.getEntryType())
                        .dataJson(dataJson)
                        .generalTranslationVi(response.getGeneralTranslationVi())
                        .updatedAt(LocalDateTime.now())
                        .meanings(meanings.subList(0, Math.min(meanings.size(), 10)))
                        .examples(examples.subList(0, Math.min(examples.size(), 5)))
                        .synonyms(synonyms.subList(0, Math.min(synonyms.size(), 8)))
                        .collocations(collocations.subList(0, Math.min(collocations.size(), 8)))
                        .build();
            }

            dictionaryRepository.save(entry);
        } catch (Exception e) {
            log.warn("Failed to persist L2 dictionary entry for '{}': {}", response.getNormalizedQuery(), e.getMessage());
        }
    }

    private CanonicalDictionaryResponse buildFromLegacy(DictionaryEntry dbEntry, String normalizedQuery) {
        // plain copies: the entity's lazy collections must not outlive the store transaction (the payload is
        // enriched, serialized and stored on other threads)
        List<String> rowExamples = dbEntry.getExamples() != null ? new ArrayList<>(dbEntry.getExamples()) : new ArrayList<>();
        List<String> rowSynonyms = dbEntry.getSynonyms() != null ? new ArrayList<>(dbEntry.getSynonyms()) : new ArrayList<>();
        List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();
        if (dbEntry.getMeanings() != null) {
            int counter = 1;
            for (String m : dbEntry.getMeanings()) {
                senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                        .id(String.valueOf(counter++))
                        .definitionEn(m)
                        .examples(new ArrayList<>(rowExamples))
                        .build());
            }
        }

        List<CanonicalDictionaryResponse.PronunciationDto> prons = new ArrayList<>();
        if (dbEntry.getIpa() != null && !dbEntry.getIpa().isBlank()) {
            prons.add(CanonicalDictionaryResponse.PronunciationDto.builder()
                    .ipa(dbEntry.getIpa())
                    .region("General")
                    .build());
        }

        List<CanonicalDictionaryResponse.CollocationDto> colls = new ArrayList<>();
        if (dbEntry.getCollocations() != null) {
            for (String c : new ArrayList<>(dbEntry.getCollocations())) {
                colls.add(CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase(c)
                        .pattern("collocation")
                        .build());
            }
        }

        return CanonicalDictionaryResponse.builder()
                .query(dbEntry.getWord())
                .normalizedQuery(normalizedQuery)
                .entryType("WORD")
                .headword(dbEntry.getWord())
                .cefr(dbEntry.getCefr())
                .source("English Coach Lexical Cache")
                .pronunciations(prons)
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("general")
                        .senses(senses)
                        .build()))
                .collocations(colls)
                // the row's synonyms are the word's, never one sense's
                .synonyms(rowSynonyms.isEmpty() ? null : rowSynonyms)
                .build();
    }

    private CanonicalDictionaryResponse cloneResponse(CanonicalDictionaryResponse src) {
        try {
            String json = objectMapper.writeValueAsString(src);
            return objectMapper.readValue(json, CanonicalDictionaryResponse.class);
        } catch (Exception e) {
            return src;
        }
    }

    public static String cleanParserArtifacts(String text) {
        if (text == null || text.isBlank()) return text;
        // one Unicode form: provider text arrived decomposed (combining tone marks), which breaks comparison / de-duplication
        String s = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFC);
        if (s.contains("mw-parser-output") || s.contains("<style") || s.contains("<script") || s.contains("{font-") || s.contains("<")) {
            s = STYLE_BLOCK_PATTERN.matcher(s).replaceAll(" ");
            s = SCRIPT_BLOCK_PATTERN.matcher(s).replaceAll(" ");
            s = MW_CSS_PATTERN.matcher(s).replaceAll(" ");
            s = GENERAL_CSS_BLOCK.matcher(s).replaceAll(" ");
            s = HTML_TAGS_PATTERN.matcher(s).replaceAll(" ");
            s = MW_PARSER_CLASS.matcher(s).replaceAll(" ");
        }
        // Normalize obvious spacing around punctuation
        // e.g. "pick up ." -> "pick up.", "surface ,including" -> "surface, including", "activity ) on" -> "activity) on"
        s = s.replaceAll("\\s+([.,;:!?])", "$1");
        s = s.replaceAll("([,;:])([^\\s\\d])", "$1 $2");
        s = s.replaceAll("\\s+\\)", ")");
        s = s.replaceAll("\\(\\s+", "(");
        return s.replaceAll("\\s+", " ").trim();
    }

    public static boolean canPersistLexicalEntry(CanonicalDictionaryResponse resp) {
        if (resp == null) return false;
        String headword = resp.getHeadword();
        if (headword == null || headword.isBlank()) return false;

        if (!hasMeaningfulLexicalContent(resp)) {
            return false;
        }

        String source = resp.getSource();
        if (source != null && (source.equalsIgnoreCase("Google GTX") || source.equalsIgnoreCase("Generic Translation"))) {
            return false;
        }

        return true;
    }

    public static boolean hasMeaningfulLexicalContent(CanonicalDictionaryResponse resp) {
        if (resp == null || resp.getPartsOfSpeech() == null || resp.getPartsOfSpeech().isEmpty()) {
            return false;
        }
        for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : resp.getPartsOfSpeech()) {
            if (posGroup.getSenses() != null && !posGroup.getSenses().isEmpty()) {
                for (CanonicalDictionaryResponse.SenseDto sense : posGroup.getSenses()) {
                    if (sense.getDefinitionEn() != null && !sense.getDefinitionEn().isBlank()) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private boolean hasValidSenses(CanonicalDictionaryResponse resp) {
        return hasMeaningfulLexicalContent(resp);
    }

    public String classifyEntry(CanonicalDictionaryResponse response) {
        if (response == null) return "WORD";
        String word = response.getNormalizedQuery() != null ? response.getNormalizedQuery() : response.getHeadword();
        String sourceEntryType = response.getEntryType();
        List<String> posList = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        List<String> definitions = new ArrayList<>();
        if (response.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : response.getPartsOfSpeech()) {
                if (posGroup.getPartOfSpeech() != null) posList.add(posGroup.getPartOfSpeech());
                if (posGroup.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto s : posGroup.getSenses()) {
                        if (s.getDefinitionEn() != null) definitions.add(s.getDefinitionEn());
                        if (s.getLabels() != null) labels.addAll(s.getLabels());
                    }
                }
            }
        }
        return phraseProvider.classifyLexicalEntry(word, sourceEntryType, posList, labels, definitions);
    }

    private void sanitizeResponse(CanonicalDictionaryResponse resp, String normalizedQuery) {
        if (resp == null) return;
        // Fix entryType using source metadata
        String correctType = classifyEntry(resp);
        if (correctType != null && !correctType.isBlank()) {
            resp.setEntryType(correctType);
        }

        if (resp.getGeneralTranslationVi() != null) {
            resp.setGeneralTranslationVi(cleanParserArtifacts(resp.getGeneralTranslationVi()));
        }

        if (resp.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pos : resp.getPartsOfSpeech()) {
                if (pos.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto sense : pos.getSenses()) {
                        if (sense.getDefinitionEn() != null) {
                            sense.setDefinitionEn(cleanParserArtifacts(sense.getDefinitionEn()));
                        }
                        if (sense.getTranslationVi() != null) {
                            sense.setTranslationVi(cleanParserArtifacts(sense.getTranslationVi()));
                        }
                        if (sense.getExamples() != null && !sense.getExamples().isEmpty()) {
                            List<String> cleanEx = new ArrayList<>();
                            for (String ex : sense.getExamples()) {
                                cleanEx.add(cleanParserArtifacts(ex));
                            }
                            sense.setExamples(cleanEx);
                        }
                    }
                }
            }
        }
    }

    private void enrichVietnamese(CanonicalDictionaryResponse response, String normalizedQuery) {
        if (response == null) return;

        boolean isMultiWord = GoogleGtxTranslationProvider.isMultiWordUnit(response);

        // SINGLE WORD (owner brief 2026-10-24): the local EN-VI dictionary is the trusted Vietnamese baseline. Its senses
        // are listed per part of speech on the entry (vietnameseSenses), never attached to an English sense they were
        // not written for; the general meaning is set by enrich (GTX dt=t, else this dictionary's first meaning).
        if (!isMultiWord) {
            Optional<LocalEnViLexicalProvider.EnViEntry> local = localEntry(response, normalizedQuery);
            if (local.isPresent()) {
                List<CanonicalDictionaryResponse.VietnameseSenseGroupDto> groups = groupLocalSenses(local.get().getDefinitions());
                if (!groups.isEmpty()) {
                    response.setVietnameseSenses(groups);
                    response.setVietnameseSource(VIETNAMESE_SOURCE);
                }
                if (response.getPronunciations() == null || response.getPronunciations().isEmpty()) {
                    response.setPronunciations(localPronunciation(local.get().getIpa()));
                }
            }
            return;
        }

        // MULTI-WORD: Replace generic GTX translation fallback with LocalEnViLexicalProvider
        // GTX is NEVER called for multi-word lexical entries.
        // Priority:
        // 1. Existing trusted source-backed sense-level Vietnamese translation
        // 2. LocalEnViLexicalProvider exact lexical entry
        // 3. No Vietnamese meaning (leave null / omit)

        // Check if senses already have source-backed translations
        boolean hasSourceBackedSenseVi = false;
        int totalSenses = 0;
        CanonicalDictionaryResponse.SenseDto singleSense = null;

        if (response.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : response.getPartsOfSpeech()) {
                if (posGroup.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto s : posGroup.getSenses()) {
                        totalSenses++;
                        singleSense = s;
                        if (s.getTranslationVi() != null && !s.getTranslationVi().isBlank()) {
                            hasSourceBackedSenseVi = true;
                        }
                    }
                }
            }
        }

        // Query local SQLite dictionary for exact lexical match
        String targetWord = response.getHeadword() != null ? response.getHeadword() : normalizedQuery;
        Optional<LocalEnViLexicalProvider.EnViLexicalResult> localViOpt = localEnViLexicalProvider.lookup(targetWord);
        if (localViOpt.isEmpty() && !targetWord.equals(normalizedQuery)) {
            localViOpt = localEnViLexicalProvider.lookup(normalizedQuery);
        }

        if (localViOpt.isPresent() && !localViOpt.get().getDefinitions().isEmpty()) {
            List<LocalEnViLexicalProvider.EnViDefinition> defs = localViOpt.get().getDefinitions();

            LinkedHashSet<String> distinctDefs = new LinkedHashSet<>();
            for (LocalEnViLexicalProvider.EnViDefinition d : defs) {
                if (d.getDefinition() != null && !d.getDefinition().isBlank()) {
                    distinctDefs.add(d.getDefinition());
                }
            }

            if (!distinctDefs.isEmpty()) {
                String combinedLexicalVi = String.join("; ", distinctDefs);

                // Entry-level translation
                if (response.getGeneralTranslationVi() == null || response.getGeneralTranslationVi().isBlank()) {
                    response.setGeneralTranslationVi(combinedLexicalVi);
                }

                // Sense mapping safety:
                // Only assign Vietnamese text to a specific English sense when alignment is unambiguous
                // (e.g. exactly 1 English sense in the entry)
                if (!hasSourceBackedSenseVi && totalSenses == 1 && singleSense != null) {
                    singleSense.setTranslationVi(combinedLexicalVi);
                }
                // For multiple senses: do NOT force false per-sense alignment; preserve definitions at entry-level.
            }
        } else {
            // Local EN-VI lexical data not found:
            // Keep English lexical content and show NO fake Vietnamese meaning.
            // DO NOT fall back to generic literal phrase translation.
            if (!hasSourceBackedSenseVi && response.getSource() != null && response.getSource().contains("Cache")) {
                // Discard any stale literal VI from old cache
                response.setGeneralTranslationVi(null);
            }
        }
    }

    private void sanitizeMultiWordCachedVi(CanonicalDictionaryResponse response) {
        if (response == null || !GoogleGtxTranslationProvider.isMultiWordUnit(response)) return;

        boolean hasSourceBackedVi = response.getSource() != null &&
                (response.getSource().contains("Kaikki") || response.getSource().contains("Direct") || response.getSource().contains("Wiktextract"));

        if (!hasSourceBackedVi) {
            String targetWord = response.getHeadword() != null ? response.getHeadword() : response.getNormalizedQuery();
            Optional<LocalEnViLexicalProvider.EnViLexicalResult> localViOpt = localEnViLexicalProvider.lookup(targetWord);
            if (localViOpt.isEmpty() && !targetWord.equals(response.getNormalizedQuery())) {
                localViOpt = localEnViLexicalProvider.lookup(response.getNormalizedQuery());
            }

            if (localViOpt.isPresent() && !localViOpt.get().getDefinitions().isEmpty()) {
                LinkedHashSet<String> distinctDefs = new LinkedHashSet<>();
                for (LocalEnViLexicalProvider.EnViDefinition d : localViOpt.get().getDefinitions()) {
                    if (d.getDefinition() != null && !d.getDefinition().isBlank()) {
                        distinctDefs.add(d.getDefinition());
                    }
                }
                String combined = String.join("; ", distinctDefs);
                response.setGeneralTranslationVi(combined);

                int totalSenses = 0;
                CanonicalDictionaryResponse.SenseDto singleSense = null;
                if (response.getPartsOfSpeech() != null) {
                    for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : response.getPartsOfSpeech()) {
                        if (posGroup.getSenses() != null) {
                            for (CanonicalDictionaryResponse.SenseDto s : posGroup.getSenses()) {
                                totalSenses++;
                                singleSense = s;
                            }
                        }
                    }
                }
                if (totalSenses == 1 && singleSense != null) {
                    singleSense.setTranslationVi(combined);
                }
            } else {
                // Discard stale literal VI from cache
                response.setGeneralTranslationVi(null);
                if (response.getPartsOfSpeech() != null) {
                    for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : response.getPartsOfSpeech()) {
                        if (posGroup.getSenses() != null) {
                            for (CanonicalDictionaryResponse.SenseDto s : posGroup.getSenses()) {
                                s.setTranslationVi(null);
                            }
                        }
                    }
                }
            }
        }
    }
}
