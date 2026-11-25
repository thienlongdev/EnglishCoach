package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * Data isolation of "Lưu Flashcard" (V102) on PostgreSQL 17 with the real Hibernate mapping and the real V102 file:
 * a learner's meaning / example for a word the shared dictionary does not know stays on that learner's card and in a
 * private entry; no shared read path (dictionary resolution, word / phrase finders, Vietnamese-word pages) and no other
 * learner's card ever shows it; shared entries are never written by a save; proven historical rows become private,
 * ambiguous ones are left untouched for review.
 */
@DataJpaTest(properties = {
        "spring.flyway.enabled=false",
        "spring.jpa.hibernate.ddl-auto=create",
        "spring.jpa.open-in-view=false"})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ContextConfiguration(classes = FlashcardDictionaryIsolationPostgresTest.Jpa.class)
class FlashcardDictionaryIsolationPostgresTest {

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

    private static final long A = 501L, B = 502L;
    private static final String SECRET_MEANING = "SECRET-A-MEANING nghĩa riêng", SECRET_EXAMPLE = "SECRET-A-EXAMPLE sentence";

    @Autowired private FlashcardRepository cards;
    @Autowired private UserRepository users;
    @Autowired private DictionaryRepository dictionary;
    @Autowired private VocabDeckRepository decks;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private EntityManager em;

    private FlashcardService service;
    private DictionaryEngine engine;
    private final ObjectMapper json = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void setUp() throws Exception {
        jdbc.execute("CREATE TABLE IF NOT EXISTS public.deck_dictionary_entries (deck_id bigint, dictionary_entry_id bigint, sort_order int)");
        // production shape: the entry's insert time is timestamptz, the card's created_at a plain timestamp (UTC wall time)
        jdbc.execute("ALTER TABLE public.dictionary_entries ALTER COLUMN updated_at TYPE timestamptz");
        for (long id : new long[] {A, B}) {
            jdbc.update("""
                    INSERT INTO public.users (id, email, name, role, credential_status, account_status, credential_version, created_at)
                    VALUES (?, ?, ?, 'ROLE_USER', 'NONE', 'ACTIVE', 0, now()) ON CONFLICT (id) DO NOTHING""",
                    id, "learner" + id + "@example.test", "Learner " + id);
        }
        runV102();
        // a SYSTEM word: shared, with its own dictionary text and no IPA / CEFR yet
        dictionary.saveAndFlush(DictionaryEntry.builder().word("harbor")
                .meanings(new ArrayList<>(List.of("bến cảng"))).examples(new ArrayList<>(List.of("The ship left the harbor."))).build());
        service = new FlashcardService(cards, users, dictionary, new AnkiNoteParser(), decks);
        engine = new DictionaryEngine(dictionary, mock(OxfordProvider.class), mock(CambridgeProvider.class),
                mock(WiktionaryProvider.class), mock(DictionaryApiDevProvider.class), mock(DatamuseProvider.class),
                mock(GoogleGtxTranslationProvider.class), mock(LocalEnViLexicalProvider.class), mock(PhraseProvider.class),
                mock(KaikkiLocalLexicalStore.class), json);
    }

    private void runV102() throws Exception {
        try (var in = getClass().getResourceAsStream("/db/migration/exams/V102__dictionary_entry_owner.sql")) {
            assertThat(in).as("V102 on the classpath").isNotNull();
            jdbc.execute(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private void flushClear() {
        em.flush();
        em.clear();
    }

    @Test
    void unknownWordStaysPrivateToItsLearner() throws Exception {
        var savedA = service.saveCustomFlashcard(A, "Zorbify", SECRET_MEANING, SECRET_EXAMPLE, "/ˈzɔːbɪfaɪ/", "b2");
        flushClear();

        // 1-2: persisted privately on A's card, in an entry owned by A that holds none of A's text
        Flashcard cardA = cards.findById(savedA.card().getId()).orElseThrow();
        assertThat(savedA.created()).isTrue();
        assertThat(cardA.getCustomMeaning()).isEqualTo(SECRET_MEANING);
        assertThat(cardA.getCustomExample()).isEqualTo(SECRET_EXAMPLE);
        DictionaryEntry privateA = cardA.getDictionaryEntry();
        assertThat(privateA.getOwnerUserId()).isEqualTo(A);
        assertThat(privateA.getMeanings()).isEmpty();
        assertThat(privateA.getExamples()).isEmpty();
        assertThat(json.writeValueAsString(cardA)).doesNotContain("ownerUserId");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.dictionary_meanings WHERE meaning LIKE '%SECRET%'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.dictionary_examples WHERE example LIKE '%SECRET%'", Long.class)).isZero();

        // 3: no shared read path knows the word
        assertThat(dictionary.findByWordIgnoreCase("zorbify")).isEmpty();
        assertThat(dictionary.findByWordStartingWithIgnoreCase("zorb")).isEmpty();
        assertThat(dictionary.findByWordContainingIgnoreCase("orbif")).isEmpty();
        assertThat(dictionary.findByWordEndingWithIgnoreCase("bify")).isEmpty();
        assertThat(dictionary.findPrivateEntry(B, "zorbify")).isEmpty();
        assertThat(engine.resolveLexicalExistence("zorbify").getStatus()).isEqualTo(DictionaryEngine.LexicalExistenceStatus.NOT_FOUND);

        // B saves the same word: B's own private entry, nothing of A's text on B's card or entry
        var savedB = service.saveCustomFlashcard(B, "zorbify", null, null, null, null);
        flushClear();
        Flashcard cardB = cards.findById(savedB.card().getId()).orElseThrow();
        assertThat(cardB.getDictionaryEntry().getId()).isNotEqualTo(privateA.getId());
        assertThat(cardB.getDictionaryEntry().getOwnerUserId()).isEqualTo(B);
        String everythingBSees = json.writeValueAsString(service.getUserFlashcards(B, null, PageRequest.of(0, 50)).getContent());
        assertThat(everythingBSees).contains("zorbify").doesNotContain("SECRET").doesNotContain("ˈzɔːbɪfaɪ");

        // A saving again: the same card, no second card or entry
        var againA = service.saveCustomFlashcard(A, "zorbify", "other text", null, null, null);
        assertThat(againA.created()).isFalse();
        assertThat(againA.card().getId()).isEqualTo(cardA.getId());
        assertThat(againA.card().getCustomMeaning()).isEqualTo(SECRET_MEANING);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.dictionary_entries WHERE lower(word) = 'zorbify'", Long.class)).isEqualTo(2L);

        // 6: B cannot act on A's card
        Long aCard = cardA.getId();
        assertThatThrownBy(() -> service.review(B, aCard, "good", null)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        assertThatThrownBy(() -> service.deleteFlashcard(B, aCard)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
    }

    @Test
    void knownSystemWordIsNeverWrittenBySave() throws Exception {
        var saved = service.saveCustomFlashcard(A, "harbor", "MY-HARBOR-NOTE", "MY-HARBOR-EXAMPLE", "/hack/", "C2");
        flushClear();

        // 4: ordinary save still works and links the SYSTEM entry, whose text, IPA and CEFR are unchanged
        Flashcard card = cards.findById(saved.card().getId()).orElseThrow();
        DictionaryEntry shared = card.getDictionaryEntry();
        assertThat(shared.getOwnerUserId()).isNull();
        assertThat(shared.getMeanings()).containsExactly("bến cảng");
        assertThat(shared.getIpa()).isNull();
        assertThat(shared.getCefr()).isNull();
        assertThat(card.getCustomMeaning()).isEqualTo("MY-HARBOR-NOTE");

        var lookup = engine.resolveLexicalExistence("harbor");
        assertThat(lookup.getStatus()).isEqualTo(DictionaryEngine.LexicalExistenceStatus.EXISTS);
        assertThat(json.writeValueAsString(lookup.getPreResolvedEntry())).contains("bến cảng").doesNotContain("MY-HARBOR").doesNotContain("/hack/");

        var savedB = service.saveCustomFlashcard(B, "harbor", null, null, null, null);
        assertThat(savedB.card().getDictionaryEntry().getId()).isEqualTo(shared.getId());
        assertThat(json.writeValueAsString(savedB.card())).doesNotContain("MY-HARBOR");
    }

    @Test
    void provenHistoricalRowsBecomePrivateAmbiguousOnesAreLeftForReview() throws Exception {
        // legacy shape of the leak: a shared row holding A's text, inserted with A's card in one transaction
        Long proven = jdbc.queryForObject("INSERT INTO public.dictionary_entries (word, updated_at) VALUES ('quorple', now()) RETURNING id", Long.class);
        jdbc.update("INSERT INTO public.dictionary_meanings (dictionary_entry_id, meaning) VALUES (?, 'LEGACY-SECRET')", proven);
        jdbc.update("""
                INSERT INTO public.flashcards (user_id, dictionary_entry_id, status, is_system, state, review_count, created_at, updated_at)
                VALUES (?, ?, 'NEW', false, 0, 0, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')""", A, proven);
        // ambiguous: two learners' cards, no time match
        Long ambiguous = jdbc.queryForObject("INSERT INTO public.dictionary_entries (word, updated_at) VALUES ('blivet', now() - interval '30 days') RETURNING id", Long.class);
        jdbc.update("INSERT INTO public.dictionary_meanings (dictionary_entry_id, meaning) VALUES (?, 'unknown origin')", ambiguous);
        for (long u : new long[] {A, B}) {
            jdbc.update("""
                    INSERT INTO public.flashcards (user_id, dictionary_entry_id, status, is_system, state, review_count, created_at)
                    VALUES (?, ?, 'NEW', false, 0, 0, now() AT TIME ZONE 'UTC')""", u, ambiguous);
        }

        runV102();
        flushClear();

        // 5: the proven row is A's private entry, gone from every shared path; A's card keeps its text
        assertThat(jdbc.queryForObject("SELECT owner_user_id FROM public.dictionary_entries WHERE id = ?", Long.class, proven)).isEqualTo(A);
        assertThat(dictionary.findByWordIgnoreCase("quorple")).isEmpty();
        assertThat(engine.resolveLexicalExistence("quorple").getStatus()).isEqualTo(DictionaryEngine.LexicalExistenceStatus.NOT_FOUND);
        assertThat(dictionary.findPrivateEntry(A, "quorple").orElseThrow().getMeanings()).containsExactly("LEGACY-SECRET");
        // ambiguous provenance is never guessed: left shared, unchanged
        assertThat(jdbc.queryForObject("SELECT owner_user_id FROM public.dictionary_entries WHERE id = ?", Long.class, ambiguous)).isNull();
        assertThat(dictionary.findByWordIgnoreCase("blivet")).isPresent();
    }
}
