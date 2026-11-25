package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.springframework.mock.web.MockMultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class AnkiApkgImportTest {

    @Mock
    private FlashcardRepository flashcardRepository;
    @Mock
    private UserRepository userRepository;
    @Mock
    private DictionaryRepository dictionaryRepository;

    private AnkiNoteParser ankiNoteParser;
    private FlashcardService flashcardService;

    private User testUser;
    private final Long USER_ID = 42L;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        ankiNoteParser = new AnkiNoteParser();
        flashcardService = new FlashcardService(flashcardRepository, userRepository, dictionaryRepository, ankiNoteParser);

        testUser = User.builder().id(USER_ID).email("test@example.com").build();
        when(userRepository.findById(USER_ID)).thenReturn(Optional.of(testUser));
    }

    @Test
    @DisplayName("AnkiNoteParser strips >255-character <style> CSS blocks and extracts clean word")
    void testParserStripsLargeStyleBlock() {
        String largeCss = "body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 18px; "
                + "color: #333333; background-color: #ffffff; text-align: center; margin: 0 auto; "
                + "padding: 24px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); "
                + "line-height: 1.6; display: flex; flex-direction: column; align-items: center; "
                + "justify-content: center; min-height: 200px; width: 80%; max-width: 600px; } "
                + ".card { background: #fafafa; border: 1px solid #e0e0e0; }";
        assertThat(largeCss.length()).isGreaterThan(255);

        String rawField0 = "<style>" + largeCss + "</style><div class=\"card\"><span>ephemeral</span></div>";
        String rawField1 = "lasting for a very short time";
        String rawFlds = rawField0 + AnkiNoteParser.ANKI_FIELD_SEPARATOR + rawField1;

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1L, rawFlds, Collections.emptyMap());

        assertThat(parsed.valid()).isTrue();
        assertThat(parsed.word()).isEqualTo("ephemeral");
        assertThat(parsed.word().length()).isLessThanOrEqualTo(255);
        assertThat(parsed.meaning()).isEqualTo("lasting for a very short time");
    }

    @Test
    @DisplayName("AnkiNoteParser decodes HTML entities and removes script/comments")
    void testParserSanitizesHtmlEntitiesAndScripts() {
        String rawField0 = "<script>console.log('malicious');</script><!-- comment -->"
                + "<strong>&quot;ubiquitous&quot;&nbsp;&amp;&nbsp;pervasive</strong>";
        String rawField1 = "present, appearing, or found everywhere";
        String rawFlds = rawField0 + AnkiNoteParser.ANKI_FIELD_SEPARATOR + rawField1;

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1L, rawFlds, Collections.emptyMap());

        assertThat(parsed.valid()).isTrue();
        assertThat(parsed.word()).isEqualTo("\"ubiquitous\" & pervasive");
        assertThat(parsed.meaning()).isEqualTo("present, appearing, or found everywhere");
    }

    @Test
    @DisplayName("AnkiNoteParser extracts cloze target and preserves sentence context")
    void testParserHandlesClozeNote() {
        String rawField0 = "In thermodynamics, {{c1::entropy::disorder}} is a measure of molecular disorder.";
        String rawField1 = "Extra explanation regarding the second law of thermodynamics.";
        String rawFlds = rawField0 + AnkiNoteParser.ANKI_FIELD_SEPARATOR + rawField1;

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1L, rawFlds, Collections.emptyMap());

        assertThat(parsed.valid()).isTrue();
        assertThat(parsed.word()).isEqualTo("entropy");
        assertThat(parsed.example()).isEqualTo("In thermodynamics, entropy is a measure of molecular disorder.");
    }

    @Test
    @DisplayName("AnkiNoteParser correctly maps custom note models with multiple fields")
    void testParserWithCustomModel() {
        String longSentence = "The comprehensive empirical assessment demonstrated a significant paradigm shift "
                + "in cognitive linguistics and artificial intelligence language modeling paradigms across institutions.";
        assertThat(longSentence.length()).isLessThan(255);

        String modelsJson = "{\"1234\": {\"id\": 1234, \"name\": \"VocabModel\", \"flds\": ["
                + "{\"name\": \"Sentence\", \"ord\": 0},"
                + "{\"name\": \"Word\", \"ord\": 1},"
                + "{\"name\": \"IPA\", \"ord\": 2},"
                + "{\"name\": \"Meaning\", \"ord\": 3},"
                + "{\"name\": \"Level\", \"ord\": 4}"
                + "]}}";

        Map<Long, AnkiNoteParser.ModelFieldMapping> models = ankiNoteParser.parseModels(modelsJson);
        assertThat(models).containsKey(1234L);

        String rawFlds = longSentence
                + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "paradigm"
                + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "/ˈpær.ə.daɪm/"
                + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "a typical example or pattern of something"
                + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "C1";

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1234L, rawFlds, models);

        assertThat(parsed.valid()).isTrue();
        assertThat(parsed.word()).isEqualTo("paradigm");
        assertThat(parsed.ipa()).isEqualTo("/ˈpær.ə.daɪm/");
        assertThat(parsed.cefr()).isEqualTo("C1");
        assertThat(parsed.meaning()).isEqualTo("a typical example or pattern of something");
        assertThat(parsed.example()).isEqualTo(longSentence);
    }

    @Test
    @DisplayName("AnkiNoteParser marks unresolvable >255-char notes as invalid with clear reason")
    void testParserMarksUnresolvableOversizedNotesInvalid() {
        String hugeText = "A".repeat(300);
        String rawFlds = hugeText + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "B".repeat(300);

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1L, rawFlds, Collections.emptyMap());

        assertThat(parsed.valid()).isFalse();
        assertThat(parsed.skipReason()).contains("exceeds 255 characters");
    }

    @Test
    @DisplayName("AnkiNoteParser bounds meanings and examples longer than 255 characters to avoid DB overflow")
    void testParserBoundsLongMeanings() {
        String longMeaning = "M".repeat(350);
        String rawFlds = "word" + AnkiNoteParser.ANKI_FIELD_SEPARATOR + longMeaning;

        AnkiNoteParser.ParsedAnkiNote parsed = ankiNoteParser.parseNote(1L, rawFlds, Collections.emptyMap());

        assertThat(parsed.valid()).isTrue();
        assertThat(parsed.word()).isEqualTo("word");
        assertThat(parsed.meaning().length()).isLessThanOrEqualTo(255);
        assertThat(parsed.meaning()).endsWith("...");
    }

    @Test
    @DisplayName("addCustomFlashcard validates oversized word and rejects before DB execution")
    void testAddCustomFlashcardRejectsOversizedWord() {
        String oversizedWord = "W".repeat(260);

        assertThatThrownBy(() -> flashcardService.addCustomFlashcard(USER_ID, oversizedWord, "meaning", "example"))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("400")
                .hasMessageContaining("tối đa 255 ký tự");

        verify(dictionaryRepository, never()).save(any());
    }

    @Test
    @DisplayName("importApkgDetails processes APKG with >255-char HTML, Cloze, and malformed notes safely")
    void testFullApkgImportFlow(@TempDir Path tempDir) throws Exception {
        // Build SQLite database inside tempDir
        File dbFile = tempDir.resolve("collection.anki21").toFile();
        String jdbcUrl = "jdbc:sqlite:" + dbFile.getAbsolutePath();

        try (Connection conn = DriverManager.getConnection(jdbcUrl);
             Statement stmt = conn.createStatement()) {
            stmt.execute("CREATE TABLE col (id integer primary key, models text);");
            stmt.execute("CREATE TABLE notes (id integer primary key, mid integer, flds text);");

            // Models with custom fields
            String modelsJson = "{\"100\": {\"id\": 100, \"name\": \"Model\", \"flds\": ["
                    + "{\"name\": \"Front\", \"ord\": 0},"
                    + "{\"name\": \"Back\", \"ord\": 1}"
                    + "]}}";
            stmt.execute("INSERT INTO col (id, models) VALUES (1, '" + modelsJson.replace("'", "''") + "');");

            // Note 1: > 255 char CSS block in front + word "serendipity"
            String cssBlock = "body { " + "margin: 0; padding: 20px; font-size: 16px; color: #111; ".repeat(10) + "} ";
            assertThat(cssBlock.length()).isGreaterThan(255);
            String note1Flds = "<style>" + cssBlock + "</style><div>serendipity</div>"
                    + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "the occurrence of events by chance in a beneficial way";

            // Note 2: Cloze note
            String note2Flds = "The phenomenon of {{c1::lucidity::clarity}} was observed."
                    + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "clarity of expression";

            // Note 3: Malformed note with 400 chars of unstructured text
            String note3Flds = "Z".repeat(400) + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "W".repeat(400);

            stmt.execute("INSERT INTO notes (id, mid, flds) VALUES (1, 100, '" + note1Flds.replace("'", "''") + "');");
            stmt.execute("INSERT INTO notes (id, mid, flds) VALUES (2, 100, '" + note2Flds.replace("'", "''") + "');");
            stmt.execute("INSERT INTO notes (id, mid, flds) VALUES (3, 100, '" + note3Flds.replace("'", "''") + "');");
        }

        // Package into .apkg zip
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            ZipEntry entry = new ZipEntry("collection.anki21");
            zos.putNextEntry(entry);
            byte[] dbBytes = java.nio.file.Files.readAllBytes(dbFile.toPath());
            zos.write(dbBytes);
            zos.closeEntry();
        }

        MockMultipartFile apkgMultipartFile = new MockMultipartFile(
                "file",
                "test-deck.apkg",
                "application/octet-stream",
                baos.toByteArray()
        );

        // Mock DB behavior for dictionary entry & flashcard creation
        when(dictionaryRepository.findByWordIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(dictionaryRepository.save(any(DictionaryEntry.class))).thenAnswer(invocation -> {
            DictionaryEntry entry = invocation.getArgument(0);
            entry.setId(1001L);
            return entry;
        });

        when(flashcardRepository.findByUserIdAndDictionaryEntryIdOrderByIdAsc(anyLong(), anyLong())).thenReturn(java.util.List.of());
        when(flashcardRepository.save(any(Flashcard.class))).thenAnswer(invocation -> {
            Flashcard card = invocation.getArgument(0);
            card.setId(2001L);
            return card;
        });

        // Run import
        FlashcardService.ApkgImportResult result = flashcardService.importApkgDetails(USER_ID, apkgMultipartFile);

        assertThat(result.totalNotes()).isEqualTo(3);
        assertThat(result.importedCount()).isEqualTo(2); // Notes 1 and 2 succeed
        assertThat(result.skippedCount()).isEqualTo(1);  // Note 3 is safely skipped
        assertThat(result.skipReasons()).hasSize(1);
        assertThat(result.skipReasons().get(0)).contains("exceeds 255 characters");

        // Verify dictionary saves: "serendipity" and "lucidity" were captured cleanly without CSS/HTML
        ArgumentCaptor<DictionaryEntry> entryCaptor = ArgumentCaptor.forClass(DictionaryEntry.class);
        verify(dictionaryRepository, times(2)).save(entryCaptor.capture());

        List<DictionaryEntry> savedEntries = entryCaptor.getAllValues();
        List<String> savedWords = savedEntries.stream().map(DictionaryEntry::getWord).toList();
        assertThat(savedWords).containsExactlyInAnyOrder("serendipity", "lucidity");

        // Verify all saved words strictly <= 255 chars
        for (DictionaryEntry de : savedEntries) {
            assertThat(de.getWord().length()).isLessThanOrEqualTo(255);
            assertThat(de.getWord()).doesNotContain("<style>");
            assertThat(de.getWord()).doesNotContain("body");
        }

        // Test controller endpoint response contract
        com.englishcoach.flashcard.controller.FlashcardController controller =
                new com.englishcoach.flashcard.controller.FlashcardController(flashcardService);
        com.englishcoach.common.security.UserDetailsImpl userDetails =
                new com.englishcoach.common.security.UserDetailsImpl(USER_ID, "test@example.com", "pass", Collections.emptyList());

        org.springframework.http.ResponseEntity<Map<String, Object>> response =
                controller.uploadApkg(userDetails, apkgMultipartFile);

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().get("importedCount")).isEqualTo(2);
        assertThat(response.getBody().get("skippedCount")).isEqualTo(1);
        assertThat(response.getBody().get("totalNotes")).isEqualTo(3);
    }

    @Test
    @DisplayName("FlashcardService.getStats returns aggregate counts from repository projection")
    void testGetStatsReturnsAggregates() {
        FlashcardRepository.FlashcardStatsProjection projection = mock(FlashcardRepository.FlashcardStatsProjection.class);
        when(projection.getTotalCards()).thenReturn(100L);
        when(projection.getDueCards()).thenReturn(15L);
        when(projection.getLearningCards()).thenReturn(55L);
        when(projection.getMasteredCards()).thenReturn(30L);

        when(flashcardRepository.getStatsByUserId(USER_ID)).thenReturn(projection);

        com.englishcoach.flashcard.dto.FlashcardStatsResponse stats = flashcardService.getStats(USER_ID);

        assertThat(stats.totalCards()).isEqualTo(100L);
        assertThat(stats.dueCards()).isEqualTo(15L);
        assertThat(stats.learningCards()).isEqualTo(55L);
        assertThat(stats.masteredCards()).isEqualTo(30L);

        // Verify controller endpoint
        com.englishcoach.flashcard.controller.FlashcardController controller =
                new com.englishcoach.flashcard.controller.FlashcardController(flashcardService);
        com.englishcoach.common.security.UserDetailsImpl userDetails =
                new com.englishcoach.common.security.UserDetailsImpl(USER_ID, "test@example.com", "pass", Collections.emptyList());

        org.springframework.http.ResponseEntity<com.englishcoach.flashcard.dto.FlashcardStatsResponse> response =
                controller.getFlashcardStats(userDetails);

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().totalCards()).isEqualTo(100L);
    }

    @Test
    @DisplayName("FlashcardService.getUserFlashcards routes status filters to dedicated repository queries")
    void testGetUserFlashcardsRoutesFilters() {
        org.springframework.data.domain.Pageable pageable = org.springframework.data.domain.PageRequest.of(0, 50);

        // Due
        flashcardService.getUserFlashcards(USER_ID, null, "due", pageable);
        verify(flashcardRepository).findDueFlashcards(USER_ID, pageable);

        // Learning
        flashcardService.getUserFlashcards(USER_ID, null, "learning", pageable);
        verify(flashcardRepository).findByUserIdAndStatusIn(USER_ID, List.of("LEARNED", "NEW"), pageable);

        // Mastered
        flashcardService.getUserFlashcards(USER_ID, null, "mastered", pageable);
        verify(flashcardRepository).findByUserIdAndStatus(USER_ID, "MASTERED", pageable);

        // All / null
        flashcardService.getUserFlashcards(USER_ID, null, "all", pageable);
        verify(flashcardRepository).findByUserId(USER_ID, pageable);

        // Search + Mastered
        flashcardService.getUserFlashcards(USER_ID, "apple", "mastered", pageable);
        verify(flashcardRepository).findByUserIdAndStatusAndWord(USER_ID, "MASTERED", "apple", pageable);
    }

    @Test
    @DisplayName("Card Blast finish run records run and prioritizes weak words in due queue")
    void testRecordCardBlastRunAndPrioritizeWeakWords() {
        com.englishcoach.flashcard.repository.CardBlastRunRepository cardBlastRunRepo =
                mock(com.englishcoach.flashcard.repository.CardBlastRunRepository.class);
        com.englishcoach.flashcard.repository.VocabDeckRepository deckRepo =
                mock(com.englishcoach.flashcard.repository.VocabDeckRepository.class);

        FlashcardService blastService = new FlashcardService(
                flashcardRepository,
                userRepository,
                dictionaryRepository,
                ankiNoteParser,
                deckRepo,
                null,
                null,
                null,
                cardBlastRunRepo
        );

        com.englishcoach.flashcard.dto.CardBlastFinishRunRequest request =
                new com.englishcoach.flashcard.dto.CardBlastFinishRunRequest(null, 420, 85.5, List.of(101L));

        blastService.recordCardBlastRun(USER_ID, request);

        // A result without a server-issued run is not stored as a run (CardBlastSoloRunTest covers the counted path)
        verify(cardBlastRunRepo, never()).save(any(com.englishcoach.flashcard.entity.CardBlastRun.class));

        // Verify weak words are prioritized via targeted bulk UPDATE (never unpaged findByUserId + saveAll)
        @SuppressWarnings("unchecked")
        ArgumentCaptor<java.util.Collection<Long>> weakIdsCaptor = ArgumentCaptor.forClass(java.util.Collection.class);
        ArgumentCaptor<java.time.LocalDateTime> dueAtCaptor = ArgumentCaptor.forClass(java.time.LocalDateTime.class);
        ArgumentCaptor<java.time.LocalDateTime> nowCaptor = ArgumentCaptor.forClass(java.time.LocalDateTime.class);
        verify(flashcardRepository).prioritizeWeakFlashcards(eq(USER_ID), weakIdsCaptor.capture(), dueAtCaptor.capture(), nowCaptor.capture());
        assertThat(weakIdsCaptor.getValue()).containsExactly(101L);
        assertThat(dueAtCaptor.getValue()).isBeforeOrEqualTo(nowCaptor.getValue());
        verify(flashcardRepository, never()).findByUserId(anyLong(), any());
        verify(flashcardRepository, never()).saveAll(any());

        // Test controller endpoint
        com.englishcoach.flashcard.controller.FlashcardController controller =
                new com.englishcoach.flashcard.controller.FlashcardController(blastService);
        com.englishcoach.common.security.UserDetailsImpl userDetails =
                new com.englishcoach.common.security.UserDetailsImpl(USER_ID, "test@example.com", "pass", List.of());

        org.springframework.http.ResponseEntity<java.util.Map<String, String>> response =
                controller.finishCardBlastRun(userDetails, request);

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).containsEntry("message", "Run recorded successfully");
    }
}

