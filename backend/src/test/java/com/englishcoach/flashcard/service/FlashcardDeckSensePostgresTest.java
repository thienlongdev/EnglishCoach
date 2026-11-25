package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.FilterType;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Curated SYSTEM topic decks (owner brief 2026-10-30, V106) on PostgreSQL 17 with the real deck files and the real V106
 * file: the seeder puts each word's taught sense on the deck link, creates missing shared rows and fills only empty
 * fields of existing ones (another deck's / a lookup's text is never overwritten), a rerun changes nothing, a
 * metadata-only run renames a legacy deck without touching its words, and a learner's cards of the deck carry the
 * deck's sense (personal cards none).
 */
@DataJpaTest(properties = {
        "spring.flyway.enabled=false",
        "spring.jpa.hibernate.ddl-auto=create",
        "spring.jpa.open-in-view=false"})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ContextConfiguration(classes = FlashcardDeckSensePostgresTest.Jpa.class)
class FlashcardDeckSensePostgresTest {

    @Configuration
    @EntityScan(basePackageClasses = {User.class, DictionaryEntry.class, Flashcard.class})
    @EnableJpaRepositories(basePackageClasses = {UserRepository.class, DictionaryRepository.class, FlashcardRepository.class},
            includeFilters = @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE,
                    classes = {UserRepository.class, DictionaryRepository.class, FlashcardRepository.class, VocabDeckRepository.class}))
    static class Jpa {}

    static final PostgreSQLContainer<?> PG = new PostgreSQLContainer<>("postgres:17");
    static { PG.start(); }

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", PG::getJdbcUrl);
        r.add("spring.datasource.username", PG::getUsername);
        r.add("spring.datasource.password", PG::getPassword);
    }

    private static final long LEARNER = 701L;
    private static final String DECK = "topic-food-cooking";

    @Autowired private FlashcardRepository cards;
    @Autowired private UserRepository users;
    @Autowired private DictionaryRepository dictionary;
    @Autowired private VocabDeckRepository decks;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private EntityManager em;

    private FlashcardService service;
    private final ObjectMapper json = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void setUp() throws Exception {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS public.deck_dictionary_entries (
                    deck_id bigint NOT NULL REFERENCES public.vocab_decks(id) ON DELETE CASCADE,
                    dictionary_entry_id bigint NOT NULL REFERENCES public.dictionary_entries(id) ON DELETE CASCADE,
                    sort_order integer NOT NULL DEFAULT 0,
                    PRIMARY KEY (deck_id, dictionary_entry_id))""");
        if (jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_name = 'deck_dictionary_entries' "
                + "AND column_name = 'meaning_vi'", Long.class) == 0) {
            runMigration("V102__dictionary_entry_owner.sql");
            runMigration("V106__deck_entry_sense.sql");
            runMigration("V126__library_deck_sources.sql");
        }
        jdbc.update("""
                INSERT INTO public.users (id, email, name, role, credential_status, account_status, credential_version, created_at)
                VALUES (?, 'deck-sense@example.test', 'Deck Sense', 'ROLE_USER', 'NONE', 'ACTIVE', 0, now()) ON CONFLICT (id) DO NOTHING""",
                LEARNER);
        service = new FlashcardService(cards, users, dictionary, new AnkiNoteParser(), decks, null, null, jdbc);
    }

    private void runMigration(String file) throws Exception {
        try (var in = getClass().getResourceAsStream("/db/migration/exams/" + file)) {
            assertThat(in).as(file + " on the classpath").isNotNull();
            jdbc.execute(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private VocabDeckSeeder seeder(String slugs, String metadataOnly) {
        VocabDeckSeeder seeder = new VocabDeckSeeder(decks, dictionary, jdbc, new VocabDeckCache());
        ReflectionTestUtils.setField(seeder, "onlySlugs", slugs);
        ReflectionTestUtils.setField(seeder, "metadataOnlySlugs", metadataOnly);
        return seeder;
    }

    @Test
    void releasedLibraryCanBeSeededTwiceWithoutChangingLearnerProgress() throws Exception {
        // Two real sources and different decks; get sense data through the same learner-facing service.
        var loader = seeder("lib-genetics,lib-a1-things-1", "");
        loader.run(new DefaultApplicationArguments());
        var genetics = decks.findBySlug("lib-genetics").orElseThrow();
        var basic = decks.findBySlug("lib-a1-things-1").orElseThrow();
        assertThat(genetics.getTotalWords()).isEqualTo(6);
        assertThat(basic.getTotalWords()).isPositive();
        service.enrollDeck(LEARNER, genetics.getId());
        var page = service.getUserFlashcards(LEARNER, genetics.getId(), null, null, PageRequest.of(0,20));
        assertThat(page.getTotalElements()).isEqualTo(6);
        var ids = page.map(Flashcard::getId).getContent();
        long n = dictionary.count();
        loader.run(new DefaultApplicationArguments());
        em.clear();
        assertThat(dictionary.count()).isEqualTo(n);
        assertThat(service.getUserFlashcards(LEARNER, genetics.getId(), null, null, PageRequest.of(0,20))
            .map(Flashcard::getId).getContent()).containsExactlyInAnyOrderElementsOf(ids);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries WHERE deck_id=? AND source_kind='original' AND definition_en IS NOT NULL AND example_vi IS NOT NULL", Integer.class,genetics.getId())).isEqualTo(6);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries WHERE deck_id=? AND source_kind='wiki'",Integer.class,basic.getId())).isEqualTo(basic.getTotalWords());
    }

    @Test
    void oldDeckGainsItsExactEnglishSenseAndNewBatchDoesNotChangeItsEnrollment() {
        var args=new DefaultApplicationArguments();
        seeder("lib-reading-actions-1","").run(args);
        var oldDeck=decks.findBySlug("lib-reading-actions-1").orElseThrow();
        service.enrollDeck(LEARNER,oldDeck.getId());
        var pg=PageRequest.of(0,50);
        var before=service.getUserFlashcards(LEARNER,oldDeck.getId(),"accord",null,pg).getContent().get(0);
        assertThat(before.getDeckSense().definitionEn()).isEqualTo("To agree or be consistent with something.");
        assertThat(before.getDeckSense().referenceIpa()).isNotBlank();
        assertThat(LibrarySenseSupplement.find("lib-reading-actions-1","accord","other sense")).isNull();
        var loader=seeder("lib-reader-science-01","");
        loader.run(args);
        var fresh=decks.findBySlug("lib-reader-science-01").orElseThrow();
        assertThat(fresh.getTotalWords()).isGreaterThan(15);
        service.enrollDeck(LEARNER,fresh.getId());
        ReflectionTestUtils.setField(service,"readingLibraryVisible",false);
        assertThat(service.getSystemCatalog().decks()).noneMatch(d->d.slug().startsWith("lib-reader-"));
        assertThatThrownBy(()->service.enrollDeck(LEARNER,fresh.getId())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(service.getUserFlashcards(LEARNER,fresh.getId(),null,null,pg).getTotalElements()).isEqualTo(fresh.getTotalWords());
        ReflectionTestUtils.setField(service,"readingLibraryVisible",true);
        assertThat(service.getSystemCatalog().decks()).anyMatch(d->d.slug().equals("lib-reader-science-01"));
        long n=dictionary.count();loader.run(args);
        assertThat(dictionary.count()).isEqualTo(n);
        assertThat(service.getUserFlashcards(LEARNER,oldDeck.getId(),"accord",null,pg).getContent().get(0).getId()).isEqualTo(before.getId());
    }

    private Map<String, Object> link(String word) {
        return jdbc.queryForMap("""
                SELECT l.part_of_speech, l.meaning_vi, l.example, l.example_vi FROM public.deck_dictionary_entries l
                JOIN public.vocab_decks d ON d.id = l.deck_id JOIN public.dictionary_entries e ON e.id = l.dictionary_entry_id
                WHERE d.slug = ? AND e.word = ? AND e.owner_user_id IS NULL""", DECK, word);
    }

    @Test
    void curatedDeckTeachesItsSenseWithoutRewritingSharedRows() throws Exception {
        // an existing shared row (another deck's / a dictionary lookup's text) and a legacy deck carrying "&"
        dictionary.saveAndFlush(DictionaryEntry.builder().word("apple").generalTranslationVi("TEXT OF ANOTHER DECK")
                .ipa("/ˈæpl/").cefr("A1").dataJson("{\"lookup\":true}")
                .meanings(new ArrayList<>(List.of("a round fruit"))).examples(new ArrayList<>(List.of("An apple a day."))).build());
        decks.saveAndFlush(VocabDeck.builder().slug("ielts-business").title("Kinh tế & Doanh nghiệp").category("IELTS_TOPIC").build());
        long legacyLinks = 0;

        seeder(DECK, "ielts-business").run(new DefaultApplicationArguments());
        em.clear();

        VocabDeck deck = decks.findBySlug(DECK).orElseThrow();
        assertThat(deck.isSystem()).isTrue();
        assertThat(deck.getCategory()).isEqualTo("TOPIC");
        assertThat(deck.getTitle()).doesNotContain("&");
        long linked = jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries WHERE deck_id = ?", Long.class, deck.getId());
        assertThat(linked).isGreaterThan(100).isEqualTo(deck.getTotalWords());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries WHERE deck_id = ? AND "
                + "(meaning_vi IS NULL OR example IS NULL OR example_vi IS NULL)", Long.class, deck.getId())).isZero();

        // the sense is on the link; the existing shared row keeps every field it had
        Map<String, Object> apple = link("apple");
        assertThat(apple.get("meaning_vi")).isEqualTo("Quả táo");
        assertThat(apple.get("part_of_speech")).isEqualTo("noun");
        assertThat((String) apple.get("example")).containsIgnoringCase("apple");
        assertThat((String) apple.get("example_vi")).contains("táo");
        DictionaryEntry shared = dictionary.findByWordIgnoreCase("apple").orElseThrow();
        assertThat(shared.getGeneralTranslationVi()).isEqualTo("TEXT OF ANOTHER DECK");
        assertThat(shared.getIpa()).isEqualTo("/ˈæpl/");
        assertThat(shared.getMeanings()).containsExactly("a round fruit");
        assertThat(shared.getExamples()).containsExactly("An apple a day.");

        // a word the shared dictionary did not have: a shared SYSTEM row is created (never a private one)
        DictionaryEntry created = dictionary.findByWordIgnoreCase("mooncake").orElseThrow();
        assertThat(created.getOwnerUserId()).isNull();
        assertThat(created.getGeneralTranslationVi()).isEqualTo("Bánh trung thu");

        // metadata-only: the legacy deck is renamed, its words untouched
        assertThat(decks.findBySlug("ielts-business").orElseThrow().getTitle()).isEqualTo("Kinh tế và Doanh nghiệp");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries l JOIN public.vocab_decks d "
                + "ON d.id = l.deck_id WHERE d.slug = 'ielts-business'", Long.class)).isEqualTo(legacyLinks);

        // a rerun is idempotent
        long entries = dictionary.count();
        seeder(DECK, "").run(new DefaultApplicationArguments());
        em.clear();
        assertThat(dictionary.count()).isEqualTo(entries);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.deck_dictionary_entries WHERE deck_id = ?", Long.class, deck.getId()))
                .isEqualTo(linked);
        assertThat(link("apple").get("meaning_vi")).isEqualTo("Quả táo");

        // the learner's cards of the deck carry the deck's sense; a personal card of the same word does not
        assertThat(service.enrollDeck(LEARNER, deck.getId())).isEqualTo((int) linked);
        service.saveCustomFlashcard(LEARNER, "zorbify", "từ riêng của tôi", null, null, null);
        em.flush();
        em.clear();
        List<Flashcard> due = service.getDueFlashcards(LEARNER, deck.getId(), PageRequest.of(0, 100)).getContent();
        assertThat(due).isNotEmpty().allSatisfy(c -> assertThat(c.getDeckSense()).isNotNull());
        Flashcard deckApple = due.stream().filter(c -> "apple".equals(c.getDictionaryEntry().getWord())).findFirst().orElseThrow();
        assertThat(deckApple.getDeckSense().meaningVi()).isEqualTo("Quả táo");
        assertThat(json.writeValueAsString(deckApple)).contains("\"deckSense\"").contains("Quả táo");
        assertThat(service.review(LEARNER, deckApple.getId(), "good", "rq-deck-sense-1").card().getDeckSense()).isNotNull();
        Flashcard personal = service.getUserFlashcards(LEARNER, null, "zorbify", null, PageRequest.of(0, 50)).getContent().get(0);
        assertThat(personal.getDeck()).isNull();
        assertThat(personal.getDeckSense()).isNull();
        assertThat(personal.getCustomMeaning()).isEqualTo("từ riêng của tôi");
    }

    @Test
    void deckSenseColumnsKeepTheirBounds() {
        VocabDeck deck = decks.saveAndFlush(VocabDeck.builder().slug("bounds-check").title("Bounds").category("TOPIC").build());
        DictionaryEntry entry = dictionary.saveAndFlush(DictionaryEntry.builder().word("boundsword").build());
        assertThatThrownBy(() -> jdbc.update("INSERT INTO public.deck_dictionary_entries (deck_id, dictionary_entry_id, meaning_vi, "
                + "example_vi) VALUES (?, ?, 'nghĩa', 'bản dịch không có câu gốc')", deck.getId(), entry.getId()))
                .hasMessageContaining("ck_deck_dictionary_entries_sense_lengths");
    }
}
