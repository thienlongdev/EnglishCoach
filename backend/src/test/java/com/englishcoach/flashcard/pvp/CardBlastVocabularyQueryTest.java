package com.englishcoach.flashcard.pvp;

import com.englishcoach.flashcard.repository.FlashcardRepository;
import org.junit.jupiter.api.Test;
import org.springframework.data.jpa.repository.Query;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class CardBlastVocabularyQueryTest {
    @Test void bulkQueriesPreserveMembershipTranslationsAndPersonalOwnership() throws Exception {
        try (var db = new PostgreSQLContainer<>("postgres:17")) {
            db.start();
            var jdbc = new NamedParameterJdbcTemplate(new DriverManagerDataSource(db.getJdbcUrl(), db.getUsername(), db.getPassword()));
            var sql = jdbc.getJdbcTemplate();
            sql.execute("CREATE TABLE dictionary_entries(id bigint PRIMARY KEY, word text, ipa text, general_translation_vi text)");
            sql.execute("CREATE TABLE dictionary_meanings(dictionary_entry_id bigint, meaning text)");
            sql.execute("CREATE TABLE deck_dictionary_entries(deck_id bigint, dictionary_entry_id bigint)");
            sql.execute("CREATE TABLE flashcards(id bigint PRIMARY KEY, user_id bigint, deck_id bigint, dictionary_entry_id bigint, state int)");
            sql.execute("INSERT INTO dictionary_entries SELECT n, 'word'||n, 'ipa'||n, 'vi'||n FROM generate_series(1,3001) n");
            sql.execute("INSERT INTO deck_dictionary_entries SELECT 42, n FROM generate_series(1,3000) n");
            sql.execute("INSERT INTO dictionary_meanings SELECT n, 'meaning'||n FROM generate_series(1,3001) n");
            sql.execute("INSERT INTO dictionary_meanings VALUES(1,'alternative')");
            sql.execute("INSERT INTO flashcards SELECT n, 1, NULL, n, 0 FROM generate_series(1,65) n");
            sql.execute("INSERT INTO flashcards VALUES(66,2,NULL,3001,0),(67,1,42,3001,0),(68,1,NULL,3001,1)");
            String deck = FlashcardRepository.class.getMethod("findPvPWordsByDeckId", Long.class).getAnnotation(Query.class).value();
            long started = System.nanoTime();
            var rows = jdbc.queryForList(deck, Map.of("deckId", 42));
            System.out.println("CARD_BLAST_3000_WORD_BULK_QUERY_MS=" + (System.nanoTime()-started)/1_000_000.0);
            assertEquals(3001, rows.size());
            assertTrue(rows.stream().noneMatch(r -> ((Number)r.get("id")).longValue() == 3001));
            assertEquals(2, rows.stream().filter(r -> ((Number)r.get("id")).longValue() == 1).count());
            assertEquals("vi1", rows.get(0).get("vietnamese"));
            assertTrue(jdbc.queryForList(deck, Map.of("deckId", 99)).isEmpty());
            String personal = FlashcardRepository.class.getMethod("findPvPPersonalWords", Long.class).getAnnotation(Query.class).value();
            var own = jdbc.queryForList(personal, Map.of("userId", 1));
            assertEquals(60, own.size());
            assertTrue(own.stream().allMatch(r -> ((Number)r.get("id")).longValue() >= 6 && ((Number)r.get("id")).longValue() <= 65));
            var other = jdbc.queryForList(personal, Map.of("userId", 2));
            assertEquals(1, other.size()); assertEquals(3001L, ((Number)other.get(0).get("id")).longValue());
        }
    }
}
