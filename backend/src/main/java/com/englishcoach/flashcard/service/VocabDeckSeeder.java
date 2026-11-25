package com.englishcoach.flashcard.service;

import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Slf4j
@Component
@ConditionalOnProperty(prefix = "app.vocab-deck-seed", name = "enabled", havingValue = "true", matchIfMissing = false)
@RequiredArgsConstructor
public class VocabDeckSeeder implements ApplicationRunner {

    private final VocabDeckRepository vocabDeckRepository;
    private final DictionaryRepository dictionaryRepository;
    private final JdbcTemplate jdbcTemplate;
    private final VocabDeckCache vocabDeckCache;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.transaction.PlatformTransactionManager bookTransactions;

    /** Optional: only these deck slugs are seeded (comma separated); empty = every deck file, as before. */
    @Value("${app.vocab-deck-seed.slugs:}")
    private String onlySlugs = "";

    /** Optional: decks whose title / description / look are updated without touching their words (comma separated). */
    @Value("${app.vocab-deck-seed.metadata-only-slugs:}")
    private String metadataOnlySlugs = "";

    /**
     * {@code examples_vi} (parallel to {@code examples}) and {@code pos} exist in curated topic decks (V106); {@code source}
     * is provenance kept in the file for licences and corrections, not stored.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record DeckJsonWord(
        String word,
        String ipa,
        String cefr,
        @JsonProperty("general_translation_vi") String generalTranslationVi,
        List<String> meanings,
        List<String> examples,
        @JsonProperty("examples_vi") List<String> examplesVi,
        String pos,
        @JsonProperty("source_kind") String sourceKind
    ) {
        public DeckJsonWord(String word, String ipa, String cefr, String generalTranslationVi, List<String> meanings,
                            List<String> examples) {
            this(word, ipa, cefr, generalTranslationVi, meanings, examples, null, null, null);
        }
    }

    /**
     * {@code curated = true}: a topic deck that teaches ONE sense per word (owner brief 2026-10-30). Its sense, example and
     * translation go on the deck link; the shared dictionary row is only created when missing and only empty fields are
     * filled (never another deck's or a lookup's text overwritten).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record DeckJsonFile(
        String slug,
        String title,
        String description,
        String category,
        String themeColor,
        String icon,
        Integer sortOrder,
        List<DeckJsonWord> words,
        Boolean curated
    ) {
        public DeckJsonFile(String slug, String title, String description, String category, String themeColor, String icon,
                            Integer sortOrder, List<DeckJsonWord> words) {
            this(slug, title, description, category, themeColor, icon, sortOrder, words, null);
        }
    }

    private static Set<String> slugSet(String csv) {
        return csv == null ? Set.of() : Arrays.stream(csv.split(",")).map(String::trim).filter(x -> !x.isEmpty())
            .collect(Collectors.toSet());
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        Set<String> requested = slugSet(onlySlugs);
        if (requested.stream().anyMatch(s -> s.startsWith("bk-"))) {
            if (bookTransactions == null || !slugSet(metadataOnlySlugs).isEmpty()
                || requested.stream().anyMatch(s -> !s.matches("bk-[a-f0-9]{12}(?:-[a-z0-9]+){1,3}"))) {
                throw new IllegalArgumentException("Book import requires an exclusive explicit list of book decks");
            }
            var tx = new org.springframework.transaction.support.TransactionTemplate(bookTransactions);
            tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            for (String slug : requested.stream().sorted().toList()) {
                var resource = new org.springframework.core.io.ClassPathResource("data/decks/" + slug + ".json");
                try (var in = resource.getInputStream()) {
                    var book = objectMapper.readValue(in, DeckJsonFile.class);
                    validateBook(slug, book);
                    tx.executeWithoutResult(status -> {
                        var existing = vocabDeckRepository.findBySlug(slug);
                        if (existing.isEmpty()) {
                            seedDeck(book);
                        } else {
                            int stored = existing.get().getTotalWords();
                            verifyBook(book, stored);
                            if (stored < book.words().size()) seedDeck(book, stored);
                        }
                        verifyBook(book, book.words().size());
                    });
                } catch (Exception e) {
                    throw new IllegalStateException("Book import stopped at " + slug, e);
                }
            }
            if (vocabDeckCache != null) vocabDeckCache.evictAll();
            return;
        }
        try {
            PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
            Resource[] resources = resolver.getResources("classpath:data/decks/*.json");

            if (resources.length == 0) {
                log.info("No system deck JSON files found in classpath:data/decks/*.json");
                return;
            }

            log.info("Found {} system deck JSON files to seed", resources.length);
            Set<String> only = slugSet(onlySlugs);
            Set<String> metadataOnly = slugSet(metadataOnlySlugs);

            for (Resource resource : resources) {
                // A legacy bootstrap or metadata pass must never enable the separate book release.
                if (resource.getFilename() != null && resource.getFilename().startsWith("bk-")) continue;
                try (InputStream is = resource.getInputStream()) {
                    DeckJsonFile deckData = objectMapper.readValue(is, DeckJsonFile.class);
                    if (deckData == null || deckData.slug() == null) continue;
                    if (metadataOnly.contains(deckData.slug())) {
                        seedMetadata(deckData);
                    } else if (only.isEmpty() || only.contains(deckData.slug())) {
                        seedDeck(deckData);
                    }
                } catch (Exception ex) {
                    log.error("Failed to seed deck from resource {}: {}", resource.getFilename(), ex.getMessage(), ex);
                }
            }

            if (vocabDeckCache != null) {
                vocabDeckCache.evictAll();
            }
        } catch (Exception ex) {
            log.error("VocabDeckSeeder initialization error: {}", ex.getMessage(), ex);
        }
    }

    private static void validateBook(String slug, DeckJsonFile book) {
        if (book == null || !slug.equals(book.slug()) || !Boolean.TRUE.equals(book.curated())
            || !"BOOK_COLLECTION".equals(book.category()) || book.title() == null || book.title().isBlank()
            || book.words() == null || book.words().isEmpty()) throw new IllegalArgumentException("Invalid book deck");
        var words = new java.util.HashSet<String>();
        for (var w : book.words()) {
            if (w == null || w.word() == null || w.word().isBlank() || !w.word().equals(w.word().strip().toLowerCase(java.util.Locale.ROOT))
                || !words.add(w.word()) || !"book".equals(w.sourceKind()) || w.pos() == null || w.pos().isBlank()
                || w.generalTranslationVi() == null || w.generalTranslationVi().isBlank()
                || first(w.meanings()) == null || first(w.meanings()).isBlank()
                || first(w.examples()) == null || first(w.examples()).isBlank()
                || first(w.examplesVi()) == null || first(w.examplesVi()).isBlank()) {
                throw new IllegalArgumentException("Invalid or duplicate book sense in " + slug);
            }
        }
    }

    /** A committed deck is its own checkpoint. A collision is an error, never a request to replace data. */
    private void verifyBook(DeckJsonFile book, int expected) {
        VocabDeck deck = vocabDeckRepository.findBySlug(book.slug()).orElseThrow();
        if (!deck.isSystem() || !book.category().equals(deck.getCategory()) || !book.title().equals(deck.getTitle())
            || expected < 1 || expected > book.words().size() || deck.getTotalWords() != expected) throw new IllegalStateException("Book deck metadata differs");
        var links = jdbcTemplate.queryForList("""
            SELECT e.word,l.sort_order,l.part_of_speech,l.meaning_vi,l.definition_en,l.example,l.example_vi,l.source_kind
              FROM public.deck_dictionary_entries l JOIN public.dictionary_entries e ON e.id=l.dictionary_entry_id
             WHERE l.deck_id=? AND e.owner_user_id IS NULL ORDER BY l.sort_order
            """, deck.getId());
        if (links.size()!=expected) throw new IllegalStateException("Book link count differs");
        for(int i=0;i<links.size();i++){
            var l=links.get(i); var w=book.words().get(i);
            if (((Number)l.get("sort_order")).intValue()!=i+1 || !w.word().equals(l.get("word"))
                || !w.pos().equals(l.get("part_of_speech")) || !w.generalTranslationVi().equals(l.get("meaning_vi"))
                || !first(w.meanings()).equals(l.get("definition_en")) || !first(w.examples()).equals(l.get("example"))
                || !first(w.examplesVi()).equals(l.get("example_vi")) || !w.sourceKind().equals(l.get("source_kind"))) {
                throw new IllegalStateException("Book sense differs at position "+(i+1));
            }
        }
    }

    /** Title, description, category, colour, icon and order of an existing deck; its words are left untouched. */
    private void seedMetadata(DeckJsonFile data) {
        vocabDeckRepository.findBySlug(data.slug()).ifPresent(deck -> {
            deck.setTitle(data.title());
            deck.setDescription(data.description());
            if (data.category() != null) deck.setCategory(data.category());
            if (data.themeColor() != null) deck.setThemeColor(data.themeColor());
            if (data.icon() != null) deck.setIcon(data.icon());
            if (data.sortOrder() != null) deck.setSortOrder(data.sortOrder());
            vocabDeckRepository.save(deck);
            log.info("Updated metadata of deck '{}' ({})", deck.getTitle(), deck.getSlug());
        });
    }

    private static String trimmed(String value, int max) {
        if (value == null) return null;
        String t = value.trim();
        if (t.isEmpty()) return null;
        return t.length() > max ? t.substring(0, max) : t;
    }

    private static String first(List<String> values) {
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    private void seedDeck(DeckJsonFile data) {
        seedDeck(data, 0);
    }

    private void seedDeck(DeckJsonFile data, int existingPrefix) {
        if (data == null || data.slug() == null || data.words() == null || data.words().isEmpty()) {
            return;
        }
        final boolean curated = Boolean.TRUE.equals(data.curated());

        VocabDeck deck = vocabDeckRepository.findBySlug(data.slug())
            .orElseGet(() -> VocabDeck.builder()
                .slug(data.slug())
                .title(data.title() != null ? data.title() : data.slug())
                .description(data.description())
                .category(data.category() != null ? data.category() : "IELTS_TOPIC")
                .themeColor(data.themeColor() != null ? data.themeColor() : "emerald")
                .icon(data.icon() != null ? data.icon() : "book")
                .sortOrder(data.sortOrder() != null ? data.sortOrder() : 0)
                .totalWords(data.words().size())
                .isSystem(true)
                .build());

        deck.setTitle(data.title());
        deck.setDescription(data.description());
        deck.setCategory(data.category() != null ? data.category() : "IELTS_TOPIC");
        deck.setThemeColor(data.themeColor() != null ? data.themeColor() : "emerald");
        deck.setIcon(data.icon() != null ? data.icon() : "book");
        deck.setSortOrder(data.sortOrder() != null ? data.sortOrder() : 0);
        deck = vocabDeckRepository.save(deck);
        final Long deckId = deck.getId();

        // Process words in chunks of 500 for optimal Spring JDBC batching
        final int batchSize = 500;
        List<DeckJsonWord> words = data.words().subList(existingPrefix, data.words().size());
        int globalSortOrder = existingPrefix;

        List<Long> allDeckEntryIds = new ArrayList<>();

        for (int i = 0; i < words.size(); i += batchSize) {
            List<DeckJsonWord> chunk = words.subList(i, Math.min(i + batchSize, words.size()));

            // 1. Batch Upsert into dictionary_entries
            List<Object[]> dictUpsertBatch = new ArrayList<>();
            List<String> chunkWords = new ArrayList<>();
            java.util.Map<String, DeckJsonWord> wordMap = new java.util.HashMap<>();

            for (DeckJsonWord w : chunk) {
                if (w.word() == null || w.word().trim().isEmpty()) continue;
                String normWord = w.word().trim().toLowerCase();
                chunkWords.add(normWord);
                wordMap.put(normWord, w);

                String entryType = normWord.contains(" ") ? "PHRASE" : "WORD";
                dictUpsertBatch.add(new Object[]{
                    normWord,
                    w.ipa(),
                    w.cefr(),
                    entryType,
                    w.generalTranslationVi()
                });
            }

            if (dictUpsertBatch.isEmpty()) continue;

            jdbcTemplate.batchUpdate(curated
                // curated: create the shared row when missing; on an existing row fill only empty fields (guarded against no-op dead tuples)
                ? "INSERT INTO public.dictionary_entries (word, ipa, cefr, entry_type, general_translation_vi, updated_at) " +
                  "VALUES (?, ?, ?, ?, ?, NOW()) " +
                  "ON CONFLICT (word) WHERE owner_user_id IS NULL DO UPDATE SET " +
                  "  general_translation_vi = COALESCE(public.dictionary_entries.general_translation_vi, EXCLUDED.general_translation_vi), " +
                  "  ipa = COALESCE(public.dictionary_entries.ipa, EXCLUDED.ipa), " +
                  "  cefr = COALESCE(public.dictionary_entries.cefr, EXCLUDED.cefr) " +
                  "WHERE (public.dictionary_entries.general_translation_vi IS NULL AND EXCLUDED.general_translation_vi IS NOT NULL) " +
                  "   OR (public.dictionary_entries.ipa IS NULL AND EXCLUDED.ipa IS NOT NULL) " +
                  "   OR (public.dictionary_entries.cefr IS NULL AND EXCLUDED.cefr IS NOT NULL)"
                : "INSERT INTO public.dictionary_entries (word, ipa, cefr, entry_type, general_translation_vi, updated_at) " +
                  "VALUES (?, ?, ?, ?, ?, NOW()) " +
                  "ON CONFLICT (word) WHERE owner_user_id IS NULL DO UPDATE SET " +
                  "  general_translation_vi = COALESCE(EXCLUDED.general_translation_vi, public.dictionary_entries.general_translation_vi), " +
                  "  ipa = COALESCE(EXCLUDED.ipa, public.dictionary_entries.ipa), " +
                  "  cefr = COALESCE(EXCLUDED.cefr, public.dictionary_entries.cefr), " +
                  "  updated_at = NOW() " +
                  "WHERE public.dictionary_entries.general_translation_vi IS DISTINCT FROM COALESCE(EXCLUDED.general_translation_vi, public.dictionary_entries.general_translation_vi) " +
                  "   OR public.dictionary_entries.ipa IS DISTINCT FROM COALESCE(EXCLUDED.ipa, public.dictionary_entries.ipa) " +
                  "   OR public.dictionary_entries.cefr IS DISTINCT FROM COALESCE(EXCLUDED.cefr, public.dictionary_entries.cefr)",
                dictUpsertBatch
            );

            // 2. Fetch dictionary entry IDs for this chunk
            String inSql = String.join(",", java.util.Collections.nCopies(chunkWords.size(), "?"));
            java.util.Map<String, Long> wordToIdMap = new java.util.HashMap<>();
            jdbcTemplate.query(
                "SELECT id, LOWER(word) FROM public.dictionary_entries WHERE owner_user_id IS NULL AND LOWER(word) IN (" + inSql + ")",
                chunkWords.toArray(),
                rs -> {
                    wordToIdMap.put(rs.getString(2), rs.getLong(1));
                }
            );

            // 3. Batch Insert associations into deck_dictionary_entries, meanings, examples
            List<Object[]> deckJunctionBatch = new ArrayList<>();
            List<Object[]> meaningsBatch = new ArrayList<>();
            List<Object[]> examplesBatch = new ArrayList<>();

            for (String normWord : chunkWords) {
                Long entryId = wordToIdMap.get(normWord);
                if (entryId == null) continue;

                allDeckEntryIds.add(entryId);
                globalSortOrder++;
                DeckJsonWord w = wordMap.get(normWord);
                if (curated) {
                    String example = w != null ? trimmed(first(w.examples()), 1000) : null;
                    deckJunctionBatch.add(new Object[]{deckId, entryId, globalSortOrder,
                        w != null ? trimmed(w.pos(), 20) : null,
                        w != null ? trimmed(w.generalTranslationVi(), 500) : null,
                        example,
                        example != null && w != null ? trimmed(first(w.examplesVi()), 1000) : null,
                        w != null && w.sourceKind() != null ? trimmed(first(w.meanings()), 500) : null,
                        w == null ? null : w.sourceKind(), w != null && w.sourceKind() != null ? w.cefr() : null});
                    if (w != null) {
                        // the shared row gets the deck's English definition / example only when it has none at all
                        String definition = trimmed(first(w.meanings()), 250);
                        if (definition != null) meaningsBatch.add(new Object[]{entryId, definition, entryId});
                        if (example != null && example.length() <= 250) examplesBatch.add(new Object[]{entryId, example, entryId});
                    }
                    continue;
                }
                deckJunctionBatch.add(new Object[]{deckId, entryId, globalSortOrder});

                if (w != null) {
                    if (w.meanings() != null) {
                        for (String m : w.meanings()) {
                            if (m != null && !m.trim().isEmpty()) {
                                String cleanM = m.trim();
                                if (cleanM.length() > 250) {
                                    cleanM = cleanM.substring(0, 247) + "...";
                                }
                                meaningsBatch.add(new Object[]{entryId, cleanM, entryId, cleanM});
                            }
                        }
                    }
                    if (w.examples() != null) {
                        for (String ex : w.examples()) {
                            if (ex != null && !ex.trim().isEmpty()) {
                                String cleanEx = ex.trim();
                                if (cleanEx.length() > 250) {
                                    cleanEx = cleanEx.substring(0, 247) + "...";
                                }
                                examplesBatch.add(new Object[]{entryId, cleanEx, entryId, cleanEx});
                            }
                        }
                    }
                }
            }

            if (!deckJunctionBatch.isEmpty()) {
                jdbcTemplate.batchUpdate(curated
                    ? "INSERT INTO public.deck_dictionary_entries (deck_id, dictionary_entry_id, sort_order, part_of_speech, meaning_vi, example, example_vi, definition_en, source_kind, reference_level) " +
                      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                      "ON CONFLICT (deck_id, dictionary_entry_id) DO UPDATE SET sort_order = EXCLUDED.sort_order, " +
                      "  part_of_speech = EXCLUDED.part_of_speech, meaning_vi = EXCLUDED.meaning_vi, " +
                      "  example = EXCLUDED.example, example_vi = EXCLUDED.example_vi, definition_en = EXCLUDED.definition_en, " +
                      "  source_kind = EXCLUDED.source_kind, reference_level = EXCLUDED.reference_level " +
                      "WHERE public.deck_dictionary_entries.sort_order IS DISTINCT FROM EXCLUDED.sort_order " +
                      "   OR public.deck_dictionary_entries.part_of_speech IS DISTINCT FROM EXCLUDED.part_of_speech " +
                      "   OR public.deck_dictionary_entries.meaning_vi IS DISTINCT FROM EXCLUDED.meaning_vi " +
                      "   OR public.deck_dictionary_entries.example IS DISTINCT FROM EXCLUDED.example " +
                      "   OR public.deck_dictionary_entries.example_vi IS DISTINCT FROM EXCLUDED.example_vi " +
                      "   OR public.deck_dictionary_entries.definition_en IS DISTINCT FROM EXCLUDED.definition_en " +
                      "   OR public.deck_dictionary_entries.source_kind IS DISTINCT FROM EXCLUDED.source_kind " +
                      "   OR public.deck_dictionary_entries.reference_level IS DISTINCT FROM EXCLUDED.reference_level"
                    : "INSERT INTO public.deck_dictionary_entries (deck_id, dictionary_entry_id, sort_order) " +
                      "VALUES (?, ?, ?) " +
                      "ON CONFLICT (deck_id, dictionary_entry_id) DO UPDATE SET sort_order = EXCLUDED.sort_order " +
                      "WHERE public.deck_dictionary_entries.sort_order IS DISTINCT FROM EXCLUDED.sort_order",
                    deckJunctionBatch
                );
            }

            if (curated) {
                if (!meaningsBatch.isEmpty()) {
                    jdbcTemplate.batchUpdate(
                        "INSERT INTO public.dictionary_meanings (dictionary_entry_id, meaning) " +
                        "SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM public.dictionary_meanings WHERE dictionary_entry_id = ?)",
                        meaningsBatch);
                }
                if (!examplesBatch.isEmpty()) {
                    jdbcTemplate.batchUpdate(
                        "INSERT INTO public.dictionary_examples (dictionary_entry_id, example) " +
                        "SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM public.dictionary_examples WHERE dictionary_entry_id = ?)",
                        examplesBatch);
                }
                continue;
            }

            if (!meaningsBatch.isEmpty()) {
                jdbcTemplate.batchUpdate(
                    "INSERT INTO public.dictionary_meanings (dictionary_entry_id, meaning) " +
                    "SELECT ?, ? WHERE NOT EXISTS (" +
                    "  SELECT 1 FROM public.dictionary_meanings " +
                    "  WHERE dictionary_entry_id = ? AND meaning = ?" +
                    ")",
                    meaningsBatch
                );
            }

            if (!examplesBatch.isEmpty()) {
                jdbcTemplate.batchUpdate(
                    "INSERT INTO public.dictionary_examples (dictionary_entry_id, example) " +
                    "SELECT ?, ? WHERE NOT EXISTS (" +
                    "  SELECT 1 FROM public.dictionary_examples " +
                    "  WHERE dictionary_entry_id = ? AND example = ?" +
                    ")",
                    examplesBatch
                );
            }
        }

        // 4. Prune stale associations in deck_dictionary_entries that are no longer in this deck JSON
        if (existingPrefix == 0 && !allDeckEntryIds.isEmpty()) {
            String inPlaceholders = String.join(",", java.util.Collections.nCopies(allDeckEntryIds.size(), "?"));
            List<Object> pruneParams = new ArrayList<>();
            pruneParams.add(deckId);
            pruneParams.addAll(allDeckEntryIds);
            jdbcTemplate.update(
                "DELETE FROM public.deck_dictionary_entries WHERE deck_id = ? AND dictionary_entry_id NOT IN (" + inPlaceholders + ")",
                pruneParams.toArray()
            );
        }

        // 5. Update total_words to exact counted size in database
        Integer exactCount = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM public.deck_dictionary_entries WHERE deck_id = ?",
            Integer.class,
            deckId
        );
        int finalCount = exactCount != null ? exactCount : data.words().size();
        deck.setTotalWords(finalCount);
        vocabDeckRepository.save(deck);

        log.info("Successfully seeded deck '{}' ({}) with {} words", deck.getTitle(), deck.getSlug(), finalCount);
    }
}
