package com.englishcoach.flashcard.memory;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.englishcoach.flashcard.service.AnkiNoteParser;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.reading.service.ContextTranslationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.FilterType;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Echo Memory Tides 2.0 on PostgreSQL 17 with the real V116 file: a rating writes exactly one append-only log row in its
 * transaction (a replayed Idempotency-Key none), the schedule is unchanged, tiers / overview / weak words come only from
 * the principal's own evidence, a Fusion is stored only when the strict check accepts it (once per pair), Studio marks
 * words the learner already owns and never saves anything, and another learner's card is 404 everywhere.
 */
@DataJpaTest(properties = {
        "spring.flyway.enabled=false",
        "spring.jpa.hibernate.ddl-auto=create",
        "spring.jpa.open-in-view=false"})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ContextConfiguration(classes = EchoMemoryTidesPostgresTest.Jpa.class)
class EchoMemoryTidesPostgresTest {

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

    private static final long A = 811L, B = 812L;

    @Autowired private FlashcardRepository cards;
    @Autowired private UserRepository users;
    @Autowired private DictionaryRepository dictionary;
    @Autowired private VocabDeckRepository decks;
    @Autowired private JdbcTemplate jdbc;

    private FlashcardService flashcards;
    private FlashcardMemoryService memory;
    private final AtomicReference<String> aiAnswer = new AtomicReference<>("{}");
    private final AtomicInteger aiCalls = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS public.deck_dictionary_entries (
                    deck_id bigint NOT NULL REFERENCES public.vocab_decks(id) ON DELETE CASCADE,
                    dictionary_entry_id bigint NOT NULL REFERENCES public.dictionary_entries(id) ON DELETE CASCADE,
                    sort_order integer NOT NULL DEFAULT 0,
                    PRIMARY KEY (deck_id, dictionary_entry_id))""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS public.premium_feature_definitions (
                    id BIGSERIAL PRIMARY KEY, feature_key VARCHAR(64) NOT NULL UNIQUE, display_name VARCHAR(128) NOT NULL,
                    description VARCHAR(512) NOT NULL, premium_required BOOLEAN NOT NULL DEFAULT true,
                    free_trial_limit INT NOT NULL DEFAULT 5, premium_monthly_limit INT NOT NULL DEFAULT 300,
                    enabled BOOLEAN NOT NULL DEFAULT true, sort_order INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""");
        if (jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_name = 'deck_dictionary_entries' "
                + "AND column_name = 'meaning_vi'", Long.class) == 0) {
            run("V102__dictionary_entry_owner.sql");
            run("V106__deck_entry_sense.sql");
            run("V126__library_deck_sources.sql");
        }
        if (jdbc.queryForObject("SELECT count(*) FROM information_schema.tables WHERE table_name = 'flashcard_review_log'", Long.class) == 0) {
            run("V116__echo_memory_tides.sql");
        }
        if (jdbc.queryForObject("SELECT count(*) FROM pg_constraint WHERE conname = 'chk_flashcards_custom_definition_len'", Long.class) == 0) {
            run("V117__flashcard_contextual_sense.sql");
        }
        for (long id : new long[]{A, B}) {
            jdbc.update("""
                    INSERT INTO public.users (id, email, name, role, credential_status, account_status, credential_version, created_at)
                    VALUES (?, ?, 'Tides', 'ROLE_USER', 'NONE', 'ACTIVE', 0, now()) ON CONFLICT (id) DO NOTHING""", id, "tides" + id + "@example.test");
        }
        FlashcardReviewLog log = new FlashcardReviewLog(jdbc, null);
        flashcards = new FlashcardService(cards, users, dictionary, new AnkiNoteParser(), decks, null, null, jdbc);
        ReflectionTestUtils.setField(flashcards, "reviewLog", log);
        ContextTranslationService stub = new ContextTranslationService(new ObjectMapper()) {
            @Override
            public String completeJson(String system, String user, int tokenLimit) {
                aiCalls.incrementAndGet();
                return aiAnswer.get();
            }
        };
        memory = new FlashcardMemoryService(jdbc, new ObjectMapper().findAndRegisterModules(), stub, log);
    }

    private void run(String file) throws Exception {
        try (var in = getClass().getResourceAsStream("/db/migration/exams/" + file)) {
            assertThat(in).as(file).isNotNull();
            jdbc.execute(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private long save(long user, String word, String meaning, String example) {
        return flashcards.saveCustomFlashcard(user, word, meaning, example, null, null).card().getId();
    }

    @Test
    void contextualSenseIsStoredWithItsMeaningAndNeverOverwritesOrJoinsAnOlderMeaning() {
        var sense = new com.englishcoach.flashcard.service.FlashcardService.ContextSense(
                "to try hard to do something difficult", "Verb", "Bọn trẻ đã chật vật để đưa ra quyết định.");
        var created = flashcards.saveCustomFlashcard(A, "tidestruggle", "chật vật", "The children struggled to make a decision.", null, null, sense);
        assertThat(created.created()).isTrue();
        var stored = jdbc.queryForMap("SELECT custom_definition, custom_part_of_speech, custom_example_vi, status, review_count FROM public.flashcards WHERE id = ?",
                created.card().getId());
        assertThat(stored.get("custom_definition")).isEqualTo("to try hard to do something difficult");
        assertThat(stored.get("custom_part_of_speech")).isEqualTo("verb"); // allow-listed, lower case
        assertThat(stored.get("custom_example_vi")).isEqualTo("Bọn trẻ đã chật vật để đưa ra quyết định.");

        // saving the same word again with another sense: nothing of the first sense is overwritten
        var again = flashcards.saveCustomFlashcard(A, "tidestruggle", "cuộc đấu tranh", "Marx wrote about the class struggle.", null, null,
                new com.englishcoach.flashcard.service.FlashcardService.ContextSense("a hard fight", "noun", "Marx viết về đấu tranh giai cấp."));
        assertThat(again.created()).isFalse();
        assertThat(jdbc.queryForObject("SELECT custom_definition FROM public.flashcards WHERE id = ?", String.class, created.card().getId()))
                .isEqualTo("to try hard to do something difficult");

        // an existing card that already has the learner's meaning never receives a sense it was not approved with
        long older = save(A, "tidepredates", "nghĩa cũ của người học", null);
        flashcards.saveCustomFlashcard(A, "tidepredates", "nghĩa mới", "A new example.", null, null,
                new com.englishcoach.flashcard.service.FlashcardService.ContextSense("another sense", "noun", "Một ví dụ."));
        var o = jdbc.queryForMap("SELECT custom_meaning, custom_definition, custom_part_of_speech, custom_example_vi FROM public.flashcards WHERE id = ?", older);
        assertThat(o.get("custom_meaning")).isEqualTo("nghĩa cũ của người học");
        assertThat(o.get("custom_definition")).isNull();
        assertThat(o.get("custom_part_of_speech")).isNull();
        assertThat(o.get("custom_example_vi")).isNull();

        // an unknown part of speech is dropped, an over-long definition refused with a readable reason (never a 500)
        var odd = flashcards.saveCustomFlashcard(A, "tideodd", "lạ", null, null, null,
                new com.englishcoach.flashcard.service.FlashcardService.ContextSense(null, "pronunciation /x/", "bị bỏ vì không có ví dụ"));
        var od = jdbc.queryForMap("SELECT custom_part_of_speech, custom_example_vi FROM public.flashcards WHERE id = ?", odd.card().getId());
        assertThat(od.get("custom_part_of_speech")).isNull();
        assertThat(od.get("custom_example_vi")).isNull();
        assertThatThrownBy(() -> flashcards.saveCustomFlashcard(A, "tidelong", "dài", null, null, null,
                new com.englishcoach.flashcard.service.FlashcardService.ContextSense("x".repeat(501), null, null)))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("500");
        assertThatThrownBy(() -> inSavepoint("UPDATE public.flashcards SET custom_definition = repeat('y', 501) WHERE id = ?", created.card().getId()))
                .hasMessageContaining("chk_flashcards_custom_definition_len");
    }

    @Test
    void reviewLogsOncePerStoredRatingAndIsAppendOnly() {
        long card = save(A, "tidewordone", "từ một", null);
        flashcards.review(A, card, "hard", "rq-tides-0001");
        flashcards.review(A, card, "hard", "rq-tides-0001"); // replayed key: no second rating, no second row
        flashcards.review(A, card, "good", "rq-tides-0002");
        List<String> rows = jdbc.queryForList("SELECT quality FROM public.flashcard_review_log WHERE flashcard_id = ? ORDER BY id", String.class, card);
        assertThat(rows).containsExactly("hard", "good");
        assertThat(cards.findById(card).orElseThrow().getStatus()).isEqualTo("LEARNED");
        assertThatThrownBy(() -> inSavepoint("UPDATE public.flashcard_review_log SET quality = 'easy' WHERE flashcard_id = ?", card))
                .hasMessageContaining("append-only");
        assertThatThrownBy(() -> inSavepoint("DELETE FROM public.flashcard_review_log WHERE flashcard_id = ?", card))
                .hasMessageContaining("append-only");
        assertThatThrownBy(() -> inSavepoint("INSERT INTO public.flashcard_review_log (user_id, flashcard_id, quality, status_after, review_local_day) "
                + "VALUES (?, ?, 'again', 'LEARNED', current_date)", A, card)).hasMessageContaining("chk_flashcard_review_log_quality");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.premium_feature_definitions WHERE feature_key LIKE 'FLASHCARD_%'", Long.class)).isEqualTo(3);
    }

    @Test
    void latestDifficultyScopesByLearnerSearchAndMostRecentRating() {
        long a=save(A,"difficultyalpha","đầu tiên",null), b=save(B,"difficultybeta","thứ hai",null);
        flashcards.review(A,a,"hard","rq-qual-alpha-one");
        flashcards.review(B,b,"hard","rq-qual-beta-one");
        var page=org.springframework.data.domain.PageRequest.of(0,10);
        assertThat(flashcards.getUserFlashcards(A,null,"alpha","hard",page).getContent()).extracting(c->c.getId()).containsExactly(a);
        assertThat(flashcards.getUserFlashcards(A,null,"beta","hard",page)).isEmpty();
        flashcards.review(A,a,"good","rq-qual-alpha-two");
        assertThat(flashcards.getUserFlashcards(A,null,"alpha","hard",page)).isEmpty();
        assertThat(flashcards.getUserFlashcards(A,null,"alpha","good",page)).hasSize(1);
        assertThat(flashcards.getDeckProgress(A)).filteredOn(p->p.deckId()==null).singleElement()
            .satisfies(p->assertThat(p.latestRatings()).containsExactly("good"));
        assertThat(flashcards.getDeckProgress(B)).filteredOn(p->p.deckId()==null).singleElement()
            .satisfies(p->assertThat(p.latestRatings()).containsExactly("hard"));
    }

    @Test
    void evolutionWeakWordsAndReefComeOnlyFromOwnEvidence() {
        long pearl = save(A, "tidepearl", "ngọc trai", null);
        long weak = save(A, "tideweak", "từ khó", null);
        long other = save(B, "tideforeign", "của người khác", null);
        LocalDate today = LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
        insertLog(A, pearl, "good", today.minusDays(20));
        insertLog(A, pearl, "easy", today.minusDays(10));
        insertLog(A, pearl, "good", today.minusDays(2));
        insertLog(A, weak, "hard", today.minusDays(6));
        insertLog(A, weak, "hard", today.minusDays(1));
        insertLog(B, other, "hard", today.minusDays(3));
        insertLog(B, other, "hard", today.minusDays(1));

        var tiers = memory.tiers(A, List.of(pearl, weak, other));
        assertThat(tiers).extracting(FlashcardMemoryService.CardTier::flashcardId).containsExactlyInAnyOrder(pearl, weak);
        assertThat(tiers.stream().filter(t -> t.flashcardId() == pearl).findFirst().orElseThrow().tier()).isEqualTo("PEARL");
        assertThat(tiers.stream().filter(t -> t.flashcardId() == weak).findFirst().orElseThrow().tier()).isEqualTo("SILVER");

        var overview = memory.overview(A);
        assertThat(overview.weak()).extracting(FlashcardMemoryService.VaultCard::flashcardId).containsExactly(weak);
        assertThat(overview.vault()).extracting(FlashcardMemoryService.VaultCard::word).doesNotContain("tideforeign");
        assertThat(overview.tiers().pearl()).isEqualTo(1);
        assertThat(overview.reef().loggedReviews()).isEqualTo(5);
        assertThat(overview.reef().pearls()).isEqualTo(1);
        var first = overview.reef().milestones().stream().filter(m -> m.key().equals("PEARLS_1")).findFirst().orElseThrow();
        assertThat(first.reachedOn()).isEqualTo(today.minusDays(2));
        assertThat(memory.overview(A).reef()).isEqualTo(overview.reef()); // stable across reloads
        assertThat(memory.overview(B).vault()).extracting(FlashcardMemoryService.VaultCard::word).containsExactly("tideforeign");
    }

    /** A statement expected to fail, isolated so the test transaction stays usable. */
    private void inSavepoint(String sql, Object... args) {
        jdbc.execute("SAVEPOINT tides_expect");
        try {
            jdbc.update(sql, args);
        } finally {
            jdbc.execute("ROLLBACK TO SAVEPOINT tides_expect");
        }
    }

    private void insertLog(long user, long card, String quality, LocalDate day) {
        jdbc.update("INSERT INTO public.flashcard_review_log (user_id, flashcard_id, quality, status_after, review_local_day, reviewed_at) "
                + "VALUES (?, ?, ?, 'LEARNED', ?, ?::date + time '12:00')", user, card, quality, Date.valueOf(day), Date.valueOf(day));
    }

    @Test
    void fusionIsStoredOnlyWhenAcceptedAndOncePerPair() {
        long flood = save(A, "tideflood", "lũ", "The volunteers had to tidecope with the tideflood.");
        long cope = save(A, "tidecope", "đối phó", "It is hard to tidecope with stress.");
        long foreign = save(B, "tidestranger", "lạ", null);
        flashcards.review(A, flood, "good", "rq-tides-0101");
        flashcards.review(A, cope, "good", "rq-tides-0102");

        var candidates = memory.fusionCandidates(A, 6);
        assertThat(candidates).anySatisfy(c -> assertThat(List.of(c.firstWord(), c.secondWord())).containsExactlyInAnyOrder("tideflood", "tidecope"));

        String accepted = "{\"usesFirst\":true,\"usesSecond\":true,\"grammatical\":true,\"meaningCorrect\":true,\"natural\":\"YES\",\"verdict\":\"ACCEPTED\",\"feedbackVi\":\"Câu tự nhiên.\",\"suggestionEn\":null}";
        aiAnswer.set(accepted.replace("ACCEPTED", "NEEDS_WORK"));
        var needsWork = memory.checkFusion(A, flood, cope, "We tidecope with every tideflood together.");
        assertThat(needsWork.accepted()).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flashcard_fusions WHERE user_id = ?", Long.class, A)).isZero();

        aiAnswer.set(accepted);
        assertThat(memory.checkFusion(A, flood, cope, "We tidecope with every tideflood together.").newlyLinked()).isTrue();
        assertThat(memory.checkFusion(A, cope, flood, "Towns tidecope with a tideflood.").newlyLinked()).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flashcard_fusions WHERE user_id = ?", Long.class, A)).isEqualTo(1);
        assertThat(memory.tiers(A, List.of(flood)).get(0).tier()).isEqualTo("PRISM");
        assertThat(memory.fusionCandidates(A, 6)).noneSatisfy(c -> assertThat(List.of(c.firstWord(), c.secondWord()))
                .containsExactlyInAnyOrder("tideflood", "tidecope"));

        int before = aiCalls.get();
        assertThatThrownBy(() -> memory.checkFusion(A, flood, cope, "Only tideflood here."))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("cả hai từ");
        assertThatThrownBy(() -> memory.checkFusion(A, flood, foreign, "tideflood tidestranger"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        long unrated = save(A, "tidenew", "mới", null);
        assertThatThrownBy(() -> memory.checkFusion(A, flood, unrated, "The tidenew tideflood came."))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("đã học");
        assertThat(aiCalls.get()).isEqualTo(before);
        assertThatThrownBy(() -> memory.forge(A, foreign, "MNEMONIC", null)).hasMessageContaining("404");
    }

    @Test
    void tierCountsAreOnePerActiveCardAndDeletedHistoryIsNotCounted() {
        long a = save(A, "tidealpha", "một", null);
        long b = save(A, "tidebeta", "hai", null);
        long gone = save(A, "tidegone", "đã xoá", null);
        long fresh = save(A, "tidefresh", "chưa học", null);
        LocalDate today = LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
        insertLog(A, a, "good", today.minusDays(1));
        insertLog(A, gone, "good", today.minusDays(3));
        // an accepted Fusion on a card that has no logged rating and a NEW status (pre-existing data): it is a Prism, once
        jdbc.update("INSERT INTO public.flashcard_fusions (user_id, card_low_id, card_high_id, word_low, word_high, relation, sentence) "
                + "VALUES (?, ?, ?, 'x', 'y', 'USED_TOGETHER', 'x y')", A, Math.min(b, fresh), Math.max(b, fresh));
        jdbc.update("UPDATE public.flashcards SET state = 1 WHERE id = ?", gone);
        long legacy = save(A, "tidelegacy", "trước V116", null);
        jdbc.update("UPDATE public.flashcards SET status = 'LEARNED', review_count = 4 WHERE id = ?", legacy); // progress from before the log

        var o = memory.overview(A);
        assertThat(o.practisedBeforeLog()).isEqualTo(1); // reported, kept as Silver, no review day invented
        assertThat(o.tiers().silver()).isEqualTo(2);
        assertThat(o.tiers().total()).isEqualTo(o.tiers().raw() + o.tiers().silver() + o.tiers().prism() + o.tiers().pearl());
        assertThat(o.tiers().prism()).isEqualTo(2);
        assertThat(o.reef().loggedReviews()).isEqualTo(1); // the deleted card's rating is not counted
        assertThat(o.reef().firstLoggedDay()).isEqualTo(today.minusDays(1));
    }

    @Test
    void studioMarksOwnedWordsUsesSharedDictionaryAndSavesNothing() {
        dictionary.saveAndFlush(DictionaryEntry.builder().word("tidecurrent").ipa("/ˈkʌrənt/").cefr("B1").generalTranslationVi("dòng chảy").build());
        save(A, "tidedrift", "trôi dạt", null);
        long cardsBefore = cards.count();
        aiAnswer.set("""
                {"cards":[
                 {"term":"tidedrift","kind":"WORD","partOfSpeech":"verb","sourceSentence":"Boats tidedrift on the tidecurrent.","meaningVi":"trôi"},
                 {"term":"tidecurrent","kind":"WORD","partOfSpeech":"noun","sourceSentence":"Boats tidedrift on the tidecurrent.","meaningVi":"dòng nước"},
                 {"term":"invented","kind":"WORD","partOfSpeech":"verb","sourceSentence":"Nothing.","meaningVi":"bịa"}]}""");
        var result = memory.studio(A, "Boats tidedrift on the tidecurrent. The sea is calm today.", "B1", 5, List.of(), null);
        assertThat(result.cards()).extracting(FlashcardMemoryService.StudioCard::term).containsExactly("tidedrift", "tidecurrent");
        assertThat(result.cards().get(0).alreadySaved()).isTrue();
        assertThat(result.cards().get(1).alreadySaved()).isFalse();
        assertThat(result.cards().get(1).ipa()).isEqualTo("/ˈkʌrənt/");
        assertThat(result.cards().get(1).cefr()).isEqualTo("B1");
        assertThat(result.cards().get(0).ipa()).isNull(); // a learner-private entry is never a source
        assertThat(cards.count()).isEqualTo(cardsBefore);
        assertThat(memory.studio(B, "Boats tidedrift on the tidecurrent. The sea is calm today.", "B1", 5, List.of(), null)
                .cards().get(0).alreadySaved()).isFalse();
        assertThatThrownBy(() -> memory.studio(A, "Xin chào các bạn, hôm nay trời đẹp quá đi thôi.", "B1", 5, List.of(), null))
                .hasMessageContaining("tiếng Anh");
    }
}
