package com.englishcoach.reading.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.reading.dto.ContextualExplainRequest;
import com.englishcoach.reading.dto.ContextualVocabularyResponse;
import com.englishcoach.reading.dto.ContextualVocabularyResponse.CollocationItem;
import com.englishcoach.reading.dto.ContextualVocabularyResponse.SynonymItem;
import com.englishcoach.reading.dto.ParagraphExtractRequest;
import com.englishcoach.reading.entity.ReadingContextualExplanation;
import com.englishcoach.reading.entity.ReadingContextualVocabularyHistory;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingContextualExplanationRepository;
import com.englishcoach.reading.repository.ReadingContextualVocabularyHistoryRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.*;

@Slf4j
@Service
public class ReadingContextualService {

    /**
     * v2 (2026-10-16): explanations come from {@link ContextTranslationService} (strong contextual model, sentence +
     * bounded passage context). v1 rows were produced by the weak Llama path and are never served again.
     */
    public static final String DEFAULT_EXPLANATION_VERSION = "v2";

    private final ReadingContextualExplanationRepository explanationRepo;
    private final ReadingContextualVocabularyHistoryRepository historyRepo;
    private final ReadingMaterialRepository readingMaterialRepo;
    private final UserRepository userRepo;
    private final DictionaryRepository dictionaryRepo;
    private final ObjectMapper objectMapper;

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    private <T> T inTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    private <T> T inReadTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        TransactionTemplate tpl = new TransactionTemplate(transactionManager);
        tpl.setReadOnly(true);
        return tpl.execute(s -> work.get());
    }

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    private RestTemplate restTemplate;

    public ReadingContextualService(
            ReadingContextualExplanationRepository explanationRepo,
            ReadingContextualVocabularyHistoryRepository historyRepo,
            ReadingMaterialRepository readingMaterialRepo,
            UserRepository userRepo,
            DictionaryRepository dictionaryRepo,
            ObjectMapper objectMapper
    ) {
        this.explanationRepo = explanationRepo;
        this.historyRepo = historyRepo;
        this.readingMaterialRepo = readingMaterialRepo;
        this.userRepo = userRepo;
        this.dictionaryRepo = dictionaryRepo;
        this.objectMapper = objectMapper;
        this.restTemplate = createDefaultRestTemplate();
    }

    @Autowired(required = false)
    public void setJdbcTemplate(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    private ContextTranslationService contextTranslator;

    @Autowired(required = false)
    public void setContextTranslationService(ContextTranslationService contextTranslator) {
        this.contextTranslator = contextTranslator;
    }

    private ContextTranslationService translator() {
        if (contextTranslator == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, ContextTranslationService.UNAVAILABLE);
        }
        return contextTranslator;
    }

    /** Readable material for this learner: SYSTEM content or their own (AGENTS §21); anything else is 404. */
    private ReadingMaterial visibleMaterial(Long materialId, Long userId) {
        if (materialId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found");
        }
        return readingMaterialRepo.findByIdAndVisibleToUser(materialId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found"));
    }

    /** A bounded window of the material's own text around the sentence (server-side; never sent by the client). */
    static String passageContext(ReadingMaterial material, String sentence) {
        String content = material.getContentText();
        if (content == null || content.isBlank() || sentence == null || sentence.isBlank()) return null;
        String probe = sentence.strip();
        if (probe.length() > 80) probe = probe.substring(0, 80);
        int at = content.indexOf(probe);
        if (at < 0) at = content.toLowerCase(Locale.ROOT).indexOf(probe.toLowerCase(Locale.ROOT));
        if (at < 0) return null;
        int from = Math.max(0, at - 700);
        int to = Math.min(content.length(), at + sentence.length() + 700);
        return content.substring(from, to).replaceAll("\\s+", " ").strip();
    }

    private static String explanationText(ContextTranslationService.Result r) {
        StringBuilder out = new StringBuilder();
        if (r.explanation() != null) out.append(r.explanation());
        if (r.literalMeaning() != null) out.append(out.isEmpty() ? "" : "\n").append("Nghĩa đen: ").append(r.literalMeaning());
        if (r.sentenceTranslation() != null) out.append(out.isEmpty() ? "" : "\n").append("Cả câu: ").append(r.sentenceTranslation());
        if (r.ambiguityNote() != null) out.append(out.isEmpty() ? "" : "\n").append("Lưu ý: ").append(r.ambiguityNote());
        return out.isEmpty() ? null : out.toString();
    }

    private static final String[] EXPRESSION_LABELS = {
            "IDIOM", "Thành ngữ", "PHRASAL_VERB", "Cụm động từ", "COLLOCATION", "Cụm từ cố định", "FIGURATIVE", "Nghĩa bóng"};

    private static String posLabel(ContextTranslationService.Result r) {
        for (int i = 0; i < EXPRESSION_LABELS.length; i += 2) {
            if (EXPRESSION_LABELS[i].equals(r.expressionType())) return EXPRESSION_LABELS[i + 1];
        }
        return r.partOfSpeech();
    }

    // ───────── My Books (local books): selected-text adapter, no material, no persistence ─────────

    private static final int BOOK_CACHE_SIZE = 600;
    private static final long BOOK_CACHE_TTL_MS = 12L * 60 * 60 * 1000;
    private record CachedBookAnswer(ContextTranslationService.Result result, long at) {}
    private final Map<String, CachedBookAnswer> bookCache = Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, CachedBookAnswer> eldest) {
            return size() > BOOK_CACHE_SIZE;
        }
    });
    private record Bucket(long minute, int count) {}
    private final Map<Long, Bucket> bookBuckets = new HashMap<>();

    private synchronized void admitBookRequest(Long userId) {
        long minute = System.currentTimeMillis() / 60_000;
        bookBuckets.entrySet().removeIf(e -> e.getValue().minute() != minute);
        Bucket bucket = bookBuckets.getOrDefault(userId, new Bucket(minute, 0));
        if (bucket.count() >= 20 || (bookBuckets.size() >= 10_000 && !bookBuckets.containsKey(userId))) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Bạn đang giải nghĩa quá nhanh. Vui lòng đợi một chút rồi thử lại.");
        }
        bookBuckets.put(userId, new Bucket(minute, bucket.count() + 1));
    }

    /**
     * My Books "Giải nghĩa": the selection must occur in its sentence (so the endpoint cannot be used as a free-form
     * prompt). Answers are cached in memory only (bounded, 12 h), keyed by prompt version, model, selection, sentence,
     * context and title; nothing about the book is stored.
     */
    public ContextTranslationService.Result explainBookSelection(Long userId, com.englishcoach.reading.dto.BookSelectionExplainRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        String text = request.text().replaceAll("\\s+", " ").strip();
        String sentence = request.sentence().replaceAll("\\s+", " ").strip();
        if (text.isEmpty() || sentence.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Selected text is required");
        }
        String probe = text.length() > 120 ? text.substring(0, 120) : text;
        if (!sentence.toLowerCase(Locale.ROOT).contains(probe.toLowerCase(Locale.ROOT))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Đoạn đã chọn phải nằm trong câu được gửi kèm.");
        }
        String context = request.context() == null ? null : request.context().replaceAll("\\s+", " ").strip();
        ContextTranslationService translator = translator();
        String key = computeHash(String.join("\u0001", ContextTranslationService.PROMPT_VERSION, translator.modelId(),
                normalizeText(text), normalizeSentence(sentence), context == null ? "" : normalizeSentence(context),
                request.bookTitle() == null ? "" : request.bookTitle().strip()));
        CachedBookAnswer cached = bookCache.get(key);
        if (cached != null && System.currentTimeMillis() - cached.at() < BOOK_CACHE_TTL_MS) {
            return cached.result();
        }
        admitBookRequest(userId);
        ContextTranslationService.Result result = translator.translate(new ContextTranslationService.Request(
                text, sentence, context, request.bookTitle(), request.bookAuthor()));
        bookCache.put(key, new CachedBookAnswer(result, System.currentTimeMillis()));
        return result;
    }

    private static RestTemplate createDefaultRestTemplate() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(10000);
        factory.setReadTimeout(30000);
        return new RestTemplate(factory);
    }

    public void setRestTemplate(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    private record ExplainPhase1(
            Long userId,
            Long materialId,
            String materialTitle,
            String passageContext,
            String rawText,
            String rawSentence,
            String normalizedText,
            String contextHash,
            ReadingContextualExplanation cachedExplanation,
            String dictIpa,
            String dictCefr
    ) {}

    private record BatchExtractPhase1(
            Long userId,
            Long materialId,
            String materialTitle,
            String passage
    ) {}

    /**
     * Mode A: Single word or phrase contextual explanation.
     * Layer 2 Backend Shared Cache -> Layer 3 Python AI Service via AI_SERVICE_URL.
     * Runs Phase 1 DB validation/cache lookup in a short read TX, executes the AI provider HTTP call
     * completely outside any transaction, and persists + builds the response DTO in a short Phase 2 TX.
     */
    public ContextualVocabularyResponse explainAndSave(Long userId, ContextualExplainRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }

        // Phase 1 (short read TX): verify user + visibleMaterial + EC-SEC-2026-029 grounding + L2 cache + narrow dictionary lookup
        ExplainPhase1 phase1 = inReadTx(() -> {
            User user = userRepo.findById(userId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

            ReadingMaterial material = visibleMaterial(request.readingMaterialId(), user.getId());

            String rawText = request.text() != null ? request.text().trim() : "";
            String rawSentence = request.sentence() != null ? request.sentence().trim() : "";
            if (rawText.isEmpty() || rawText.length() > 200 || rawSentence.isEmpty() || rawSentence.length() > 1500) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Selected text or sentence length is invalid");
            }
            String normalizedText = normalizeText(rawText);
            String normalizedSentence = normalizeSentence(rawSentence);
            // EC-SEC-2026-029: Grounding check — sentence must appear verbatim (whitespace/case-normalized) inside the
            // reading material and contain the selected text so callers cannot poison shared cache entries.
            String normalizedMaterial = normalizeSentence(material.getContentText());
            if (normalizedMaterial.isEmpty() || !normalizedMaterial.contains(normalizedSentence)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Sentence context does not belong to this reading material");
            }
            if (!normalizedSentence.contains(normalizedText)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Selected text must appear inside the sentence context");
            }
            String contextHash = computeHash(normalizedSentence);

            // 1. Check Shared Contextual Explanation Cache (Layer 2)
            Optional<ReadingContextualExplanation> cachedExplanation = explanationRepo
                    .findByReadingMaterialIdAndNormalizedTextAndContextHashAndExplanationVersion(
                            material.getId(), normalizedText, contextHash, DEFAULT_EXPLANATION_VERSION);

            if (cachedExplanation.isPresent()) {
                ReadingContextualExplanation cached = cachedExplanation.get();
                log.info("[CACHE_HIT] Reusing shared explanation id={} for word='{}' in reading={}",
                        cached.getId(), normalizedText, material.getId());
                return new ExplainPhase1(user.getId(), material.getId(), material.getTitle(), null,
                        rawText, rawSentence, normalizedText, contextHash, cached, null, null);
            }

            // 2. Cache Miss -> Narrow shared dictionary lookup (IPA/CEFR only) + copy passage window & title
            log.info("[CACHE_MISS] Contextual translation for reading={}", material.getId());
            Optional<DictionaryEntry> dictEntry = dictionaryRepo.findByWordIgnoreCase(normalizedText);
            String dictIpa = dictEntry.map(DictionaryEntry::getIpa).orElse(null);
            String dictCefr = dictEntry.map(DictionaryEntry::getCefr).orElse(null);
            String ctxWindow = passageContext(material, rawSentence);
            return new ExplainPhase1(user.getId(), material.getId(), material.getTitle(), ctxWindow,
                    rawText, rawSentence, normalizedText, contextHash, null, dictIpa, dictCefr);
        });

        if (phase1.cachedExplanation() != null) {
            // Short commit TX for cache hit: attach to user history and build DTO inside TX
            return inTx(() -> {
                visibleMaterial(phase1.materialId(), phase1.userId());
                ReadingContextualVocabularyHistory history = attachToUserHistory(
                        phase1.userId(), phase1.materialId(), phase1.cachedExplanation());
                return mapToResponse(history);
            });
        }

        // External AI HTTP call completely OUTSIDE any DB transaction
        // Always pass server-owned material title (never caller-supplied request.passageTitle()) to ai-service
        ContextTranslationService.Result analysis = translator().translate(new ContextTranslationService.Request(
                phase1.rawText(), phase1.rawSentence(), phase1.passageContext(),
                phase1.materialTitle(), null));

        // Phase 2 (short commit TX): re-verify visibility, upsert shared explanation + user history, build response DTO inside TX
        return inTx(() -> {
            visibleMaterial(phase1.materialId(), phase1.userId());

            ReadingContextualExplanation newExplanation = ReadingContextualExplanation.builder()
                    .readingMaterialId(phase1.materialId())
                    .selectedText(phase1.rawText())
                    .normalizedText(phase1.normalizedText())
                    .lemma(analysis.lemma() != null ? analysis.lemma() : phase1.normalizedText())
                    .pos(posLabel(analysis))
                    .ipa(phase1.dictIpa())
                    .cefr(analysis.cefr() != null ? analysis.cefr() : phase1.dictCefr())
                    .frequency(null)
                    .meaningInContext(analysis.meaningInContext())
                    .nativeExplanation(explanationText(analysis))
                    .sourceSentence(phase1.rawSentence())
                    .contextHash(phase1.contextHash())
                    .collocationsJson("[]")
                    .synonymsJson("[]")
                    .grammarNote(null)
                    .explanationVersion(DEFAULT_EXPLANATION_VERSION)
                    .build();

            ReadingContextualExplanation explanation = saveOrGetSharedExplanation(newExplanation);
            log.info("[SHARED_CACHE_SAVED] Persisted shared explanation id={} for word='{}'",
                    explanation.getId(), phase1.normalizedText());

            ReadingContextualVocabularyHistory history = attachToUserHistory(phase1.userId(), phase1.materialId(), explanation);
            return mapToResponse(history);
        });
    }

    /**
     * Mode B: Paragraph contextual vocabulary extraction in ONE batch AI call.
     * Each returned item becomes an individual reusable entry in the shared cache.
     * Runs Phase 1 validation in a short read TX, executes the AI batch HTTP call outside any TX,
     * and persists + builds response DTOs in a short Phase 2 TX.
     */
    public List<ContextualVocabularyResponse> extractAndSaveBatch(Long userId, ParagraphExtractRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }

        // Phase 1 (short read TX): validate user, visibleMaterial, passage bounds & EC-SEC-2026-029 grounding
        BatchExtractPhase1 phase1 = inReadTx(() -> {
            User user = userRepo.findById(userId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

            ReadingMaterial material = visibleMaterial(request.readingMaterialId(), user.getId());

            String passage = request.passage() != null ? request.passage().trim() : "";
            if (passage.isEmpty() || passage.length() > 8000) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Passage length is invalid");
            }
            // Safe bounding
            if (passage.length() > 3500) {
                passage = passage.substring(0, 3500);
            }

            // EC-SEC-2026-029: Grounding check — passage must appear inside the reading material so callers cannot
            // inject arbitrary text into the AI prompt or poison shared cache entries.
            String normalizedMaterial = normalizeSentence(material.getContentText());
            String normalizedPassage = normalizeSentence(passage);
            if (normalizedMaterial.isEmpty() || normalizedPassage.isEmpty() || !normalizedMaterial.contains(normalizedPassage)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Passage does not belong to this reading material");
            }

            return new BatchExtractPhase1(user.getId(), material.getId(), material.getTitle(), passage);
        });

        // External AI HTTP call completely OUTSIDE any DB transaction — always pass server-owned material title
        List<BatchExtractedItem> extractedItems = callAiBatchExtraction(
                phase1.passage(), phase1.materialTitle(), request.maxItems());

        // Phase 2 (short commit TX): re-verify visibility, upsert shared explanations + user history, build DTOs inside TX
        return inTx(() -> {
            visibleMaterial(phase1.materialId(), phase1.userId());

            List<ContextualVocabularyResponse> responses = new ArrayList<>();
            String passage = phase1.passage();
            String passageLower = passage.toLowerCase();

            for (BatchExtractedItem item : extractedItems) {
                String itemText = item.text != null ? item.text.trim() : "";
                if (itemText.isEmpty()) continue;

                // Grounding check: verify term actually exists in passage
                if (!passageLower.contains(itemText.toLowerCase())) {
                    log.info("[UNGROUNDED_REJECTED] Item '{}' rejected: not in passage", itemText);
                    continue;
                }

                String containingSentence = findSentenceContaining(passage, itemText);
                String normalizedText = normalizeText(itemText);
                String contextHash = computeHash(normalizeSentence(containingSentence));

                // Check if already in Shared Cache
                Optional<ReadingContextualExplanation> cached = explanationRepo
                        .findByReadingMaterialIdAndNormalizedTextAndContextHashAndExplanationVersion(
                                phase1.materialId(), normalizedText, contextHash, DEFAULT_EXPLANATION_VERSION);

                ReadingContextualExplanation explanation;
                if (cached.isPresent()) {
                    explanation = cached.get();
                    log.info("[BATCH_CACHE_HIT] Reusing shared explanation id={} for extracted word='{}'",
                            explanation.getId(), normalizedText);
                } else {
                    // Pre-check dictionary for IPA/lemma
                    Optional<DictionaryEntry> dictEntry = dictionaryRepo.findByWordIgnoreCase(normalizedText);
                    String ipa = dictEntry.map(DictionaryEntry::getIpa).orElse(null);
                    String cefr = item.cefr != null ? item.cefr : dictEntry.map(DictionaryEntry::getCefr).orElse("B2");

                    ReadingContextualExplanation newExplanation = ReadingContextualExplanation.builder()
                            .readingMaterialId(phase1.materialId())
                            .selectedText(itemText)
                            .normalizedText(normalizedText)
                            .lemma(item.lemma != null ? item.lemma : normalizedText)
                            .pos(item.pos != null ? item.pos : "Từ vựng")
                            .ipa(ipa)
                            .cefr(cefr)
                            .frequency("common")
                            .meaningInContext(item.meaningInContext != null ? item.meaningInContext : itemText)
                            .nativeExplanation(item.shortExplanation)
                            .sourceSentence(containingSentence)
                            .contextHash(contextHash)
                            .collocationsJson("[]")
                            .synonymsJson("[]")
                            .explanationVersion(DEFAULT_EXPLANATION_VERSION)
                            .build();

                    explanation = saveOrGetSharedExplanation(newExplanation);
                    log.info("[BATCH_CACHE_SAVED] Persisted shared explanation id={} for extracted word='{}'",
                            explanation.getId(), normalizedText);
                }

                // Attach to user history
                ReadingContextualVocabularyHistory history = attachToUserHistory(phase1.userId(), phase1.materialId(), explanation);
                responses.add(mapToResponse(history));
            }

            return responses;
        });
    }

    /**
     * Retrieve all saved vocabulary notes for current user in this Reading material.
     */
    @Transactional(readOnly = true)
    public List<ContextualVocabularyResponse> getHistory(Long userId, Long readingMaterialId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        List<ReadingContextualVocabularyHistory> historyList = historyRepo
                .findByUserIdAndReadingMaterialIdOrderByCreatedAtDesc(userId, readingMaterialId);

        return historyList.stream()
                .map(this::mapToResponse)
                .toList();
    }

    /**
     * Delete a saved note from the user's personal history.
     * Deletes ONLY the history association row. The shared explanation cache row is preserved!
     */
    @Transactional
    public void deleteEntry(Long userId, Long historyId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        ReadingContextualVocabularyHistory history = historyRepo.findByIdAndUserId(historyId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Vocabulary history entry not found"));

        historyRepo.delete(history);
        log.info("[HISTORY_DELETED] Removed vocabulary history id={} for user={}. Shared explanation id={} remains cached.",
                historyId, userId, history.getExplanation().getId());
    }

    // --- Private Helper Methods ---

    /**
     * Atomically upserts a shared contextual explanation cache entry using PostgreSQL ON CONFLICT.
     * This avoids unique constraint violation exceptions inside transactions and prevents rollback-only failures.
     */
    private ReadingContextualExplanation saveOrGetSharedExplanation(ReadingContextualExplanation exp) {
        if (jdbcTemplate != null) {
            String sql = """
                INSERT INTO public.reading_contextual_explanations (
                    reading_material_id, selected_text, normalized_text, lemma, pos, ipa, cefr, frequency,
                    meaning_in_context, native_explanation, source_sentence, context_hash,
                    collocations_json, synonyms_json, grammar_note, explanation_version, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ON CONFLICT (reading_material_id, normalized_text, context_hash, explanation_version)
                DO UPDATE SET updated_at = CURRENT_TIMESTAMP
                RETURNING id
            """;
            Long id = jdbcTemplate.queryForObject(sql, Long.class,
                    exp.getReadingMaterialId(),
                    exp.getSelectedText(),
                    exp.getNormalizedText(),
                    exp.getLemma(),
                    exp.getPos(),
                    exp.getIpa(),
                    exp.getCefr(),
                    exp.getFrequency(),
                    exp.getMeaningInContext(),
                    exp.getNativeExplanation(),
                    exp.getSourceSentence(),
                    exp.getContextHash(),
                    exp.getCollocationsJson(),
                    exp.getSynonymsJson(),
                    exp.getGrammarNote(),
                    exp.getExplanationVersion()
            );
            return explanationRepo.findById(id)
                    .orElseThrow(() -> new IllegalStateException("Failed to load saved explanation id=" + id));
        }

        // Fallback for mock test environments where JdbcTemplate is not injected
        try {
            return explanationRepo.save(exp);
        } catch (DataIntegrityViolationException dive) {
            return explanationRepo
                    .findByReadingMaterialIdAndNormalizedTextAndContextHashAndExplanationVersion(
                            exp.getReadingMaterialId(), exp.getNormalizedText(), exp.getContextHash(), exp.getExplanationVersion())
                    .orElseThrow(() -> dive);
        }
    }

    /**
     * Atomically links an explanation to the user's reading history using PostgreSQL ON CONFLICT.
     */
    private ReadingContextualVocabularyHistory attachToUserHistory(Long userId, Long materialId, ReadingContextualExplanation explanation) {
        if (jdbcTemplate != null) {
            String sql = """
                INSERT INTO public.reading_contextual_vocabulary_history (
                    user_id, reading_material_id, contextual_explanation_id, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ON CONFLICT (user_id, reading_material_id, contextual_explanation_id)
                DO UPDATE SET updated_at = CURRENT_TIMESTAMP
                RETURNING id
            """;
            Long historyId = jdbcTemplate.queryForObject(sql, Long.class, userId, materialId, explanation.getId());
            return historyRepo.findById(historyId)
                    .orElseThrow(() -> new IllegalStateException("Failed to load user history id=" + historyId));
        }

        // Fallback for mock test environments
        Optional<ReadingContextualVocabularyHistory> existingHistory = historyRepo
                .findByUserIdAndReadingMaterialIdAndExplanationId(userId, materialId, explanation.getId());

        if (existingHistory.isPresent()) {
            ReadingContextualVocabularyHistory history = existingHistory.get();
            history.setUpdatedAt(Instant.now());
            return historyRepo.save(history);
        }

        ReadingContextualVocabularyHistory newHistory = ReadingContextualVocabularyHistory.builder()
                .userId(userId)
                .readingMaterialId(materialId)
                .explanation(explanation)
                .build();

        try {
            return historyRepo.save(newHistory);
        } catch (DataIntegrityViolationException dive) {
            return historyRepo
                    .findByUserIdAndReadingMaterialIdAndExplanationId(userId, materialId, explanation.getId())
                    .orElseThrow(() -> dive);
        }
    }

    /**
     * Call Python AI Service endpoint POST /api/v1/reading/extract-contextual-vocabulary
     */
    private List<BatchExtractedItem> callAiBatchExtraction(String passage, String passageTitle, Integer maxItems) {
        String url = aiBaseUrl.replaceAll("/+$", "") + "/api/v1/reading/extract-contextual-vocabulary";

        Map<String, Object> payload = new HashMap<>();
        payload.put("passage", passage);
        if (passageTitle != null) {
            payload.put("passageTitle", passageTitle);
        }
        payload.put("maxItems", maxItems != null ? maxItems : 10);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(payload, headers);

        List<BatchExtractedItem> items = new ArrayList<>();
        try {
            ResponseEntity<JsonNode> responseEntity = restTemplate.postForEntity(url, entity, JsonNode.class);
            if (responseEntity.getStatusCode().is2xxSuccessful() && responseEntity.getBody() != null) {
                JsonNode itemsNode = responseEntity.getBody().path("items");
                if (itemsNode.isArray()) {
                    for (JsonNode node : itemsNode) {
                        items.add(new BatchExtractedItem(
                                node.path("text").asText("").trim(),
                                node.path("lemma").asText("").trim(),
                                node.path("pos").asText("").trim(),
                                node.path("cefr").asText("B2").trim(),
                                node.path("meaningInContext").asText("").trim(),
                                node.path("shortExplanation").asText("").trim()
                        ));
                    }
                }
            }
        } catch (Exception e) {
            log.warn("AI Service batch extraction failed: {}. Falling back to heuristic extraction.", e.getMessage());
        }

        if (items.isEmpty()) {
            // Heuristic extraction for testing/offline
            String[] tokens = passage.split("\\s+");
            Set<String> seen = new HashSet<>();
            for (String token : tokens) {
                String clean = token.replaceAll("[^a-zA-Z]", "");
                if (clean.length() >= 5 && seen.add(clean.toLowerCase()) && items.size() < 4) {
                    items.add(new BatchExtractedItem(
                            clean,
                            clean.toLowerCase(),
                            "Từ vựng",
                            "B2",
                            "Ý nghĩa của '" + clean + "' trong đoạn văn",
                            "Từ vựng trích xuất từ đoạn đọc."
                    ));
                }
            }
        }

        return items;
    }

    public static String findSentenceContaining(String passage, String targetText) {
        if (passage == null || targetText == null || targetText.isBlank()) {
            return passage != null ? passage : "";
        }
        int idx = passage.toLowerCase().indexOf(targetText.toLowerCase());
        if (idx == -1) {
            return passage.trim();
        }

        // Scan backward for start
        int start = 0;
        for (int i = idx - 1; i >= 0; i--) {
            char c = passage.charAt(i);
            if (c == '\n' || c == '.' || c == '!' || c == '?') {
                start = i + 1;
                break;
            }
        }

        // Scan forward for end
        int end = passage.length();
        for (int i = idx + targetText.length(); i < passage.length(); i++) {
            char c = passage.charAt(i);
            if (c == '\n' || c == '.' || c == '!' || c == '?') {
                end = i + 1;
                break;
            }
        }

        String result = passage.substring(start, end).trim();
        return result.isEmpty() ? passage.trim() : result;
    }

    public static String normalizeText(String text) {
        if (text == null) return "";
        return text.trim().toLowerCase().replaceAll("\\s+", " ");
    }

    public static String normalizeSentence(String sentence) {
        if (sentence == null) return "";
        return sentence.trim().replaceAll("\\s+", " ").toLowerCase();
    }

    public static String computeHash(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return String.valueOf(input.hashCode());
        }
    }

    private ContextualVocabularyResponse mapToResponse(ReadingContextualVocabularyHistory history) {
        ReadingContextualExplanation exp = history.getExplanation();

        List<CollocationItem> collocations = new ArrayList<>();
        if (exp.getCollocationsJson() != null && !exp.getCollocationsJson().isBlank()) {
            try {
                collocations = objectMapper.readValue(exp.getCollocationsJson(), new TypeReference<>() {});
            } catch (Exception ignored) {}
        }

        List<SynonymItem> synonyms = new ArrayList<>();
        if (exp.getSynonymsJson() != null && !exp.getSynonymsJson().isBlank()) {
            try {
                synonyms = objectMapper.readValue(exp.getSynonymsJson(), new TypeReference<>() {});
            } catch (Exception ignored) {}
        }

        LocalDateTime createdLdt = LocalDateTime.ofInstant(history.getCreatedAt(), ZoneId.systemDefault());
        LocalDateTime updatedLdt = LocalDateTime.ofInstant(history.getUpdatedAt(), ZoneId.systemDefault());

        return ContextualVocabularyResponse.builder()
                .id(history.getId())
                .text(exp.getSelectedText())
                .lemma(exp.getLemma())
                .pos(exp.getPos())
                .ipa(exp.getIpa())
                .cefr(exp.getCefr())
                .frequency(exp.getFrequency())
                .meaningInContext(exp.getMeaningInContext())
                .nativeExplanation(exp.getNativeExplanation())
                .sentence(exp.getSourceSentence())
                .collocations(collocations)
                .synonyms(synonyms)
                .grammarNote(exp.getGrammarNote())
                .readingMaterialId(history.getReadingMaterialId())
                .createdAt(createdLdt)
                .updatedAt(updatedLdt)
                .build();
    }

    private record BatchExtractedItem(
            String text,
            String lemma,
            String pos,
            String cefr,
            String meaningInContext,
            String shortExplanation
    ) {}
}
