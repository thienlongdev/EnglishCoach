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
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * An Anki package is an archive a learner uploads: the import must stay within fixed bounds whatever the archive
 * claims about itself. The fixtures are small; the bounds are lowered for the test instead of building a real bomb.
 */
class ApkgImportBoundsTest {

    private static final Long USER = 42L;

    private FlashcardService service;
    private FlashcardRepository flashcards;
    private DictionaryRepository dictionary;

    @BeforeEach
    void setUp() {
        flashcards = mock(FlashcardRepository.class);
        dictionary = mock(DictionaryRepository.class);
        UserRepository users = mock(UserRepository.class);
        when(users.findById(USER)).thenReturn(Optional.of(User.builder().id(USER).email("a@example.com").build()));
        when(dictionary.findByWordIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(dictionary.save(any(DictionaryEntry.class))).thenAnswer(call -> {
            DictionaryEntry entry = call.getArgument(0);
            entry.setId(1L);
            return entry;
        });
        when(flashcards.findByUserIdAndDictionaryEntryIdOrderByIdAsc(anyLong(), anyLong())).thenReturn(java.util.List.of());
        when(flashcards.save(any(Flashcard.class))).thenAnswer(call -> call.getArgument(0));
        service = new FlashcardService(flashcards, users, dictionary, new AnkiNoteParser());
    }

    private static MockMultipartFile apkg(ZipWriter writer) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            writer.write(zip);
        }
        return new MockMultipartFile("file", "deck.apkg", "application/octet-stream", bytes.toByteArray());
    }

    private interface ZipWriter {
        void write(ZipOutputStream zip) throws Exception;
    }

    private static void entry(ZipOutputStream zip, String name, byte[] content) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content);
        zip.closeEntry();
    }

    private static byte[] collectionWithNotes(int notes) throws Exception {
        File db = File.createTempFile("bounds_", ".db");
        try {
            try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + db.getAbsolutePath());
                 Statement statement = connection.createStatement()) {
                statement.execute("CREATE TABLE col (models TEXT)");
                statement.execute("INSERT INTO col (models) VALUES ('{}')");
                statement.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT)");
                for (int i = 1; i <= notes; i++) {
                    statement.execute("INSERT INTO notes (id, mid, flds) VALUES (" + i + ", 100, 'word" + i
                            + AnkiNoteParser.ANKI_FIELD_SEPARATOR + "meaning " + i + "')");
                }
            }
            return Files.readAllBytes(db.toPath());
        } finally {
            db.delete();
        }
    }

    private static HttpStatus statusOf(Throwable thrown) {
        return HttpStatus.valueOf(((ResponseStatusException) thrown).getStatusCode().value());
    }

    @Test
    @DisplayName("A collection that expands beyond the bound is refused (a tiny archive, megabytes of zeros inside)")
    void expandingCollectionIsRefused() throws Exception {
        service.apkgMaxCollectionBytes = 1024 * 1024;
        MockMultipartFile bomb = apkg(zip -> entry(zip, "collection.anki21", new byte[8 * 1024 * 1024]));
        assertThat(bomb.getSize()).as("the archive itself is small").isLessThan(64 * 1024);

        assertThatThrownBy(() -> service.importApkgDetails(USER, bomb))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(thrown -> assertThat(statusOf(thrown)).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));
    }

    @Test
    @DisplayName("An archive with more entries than the bound is refused before the collection is reached")
    void tooManyEntriesIsRefused() throws Exception {
        service.apkgMaxZipEntries = 10;
        MockMultipartFile crowded = apkg(zip -> {
            for (int i = 0; i < 50; i++) entry(zip, String.valueOf(i), new byte[]{1});
            entry(zip, "collection.anki21", collectionWithNotes(1));
        });

        assertThatThrownBy(() -> service.importApkgDetails(USER, crowded))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(thrown -> assertThat(statusOf(thrown)).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));
    }

    @Test
    @DisplayName("An archive without a collection and an empty upload are refused as bad requests")
    void notAnAnkiPackage() throws Exception {
        MockMultipartFile noCollection = apkg(zip -> entry(zip, "media", "{}".getBytes()));
        assertThatThrownBy(() -> service.importApkgDetails(USER, noCollection))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(thrown -> assertThat(statusOf(thrown)).isEqualTo(HttpStatus.BAD_REQUEST));

        MockMultipartFile empty = new MockMultipartFile("file", "deck.apkg", "application/octet-stream", new byte[0]);
        assertThatThrownBy(() -> service.importApkgDetails(USER, empty))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(thrown -> assertThat(statusOf(thrown)).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    @DisplayName("An entry named with a path is only ever written to the import's own temporary file")
    void pathInEntryNameIsNotFollowed() throws Exception {
        File escaped = new File(System.getProperty("java.io.tmpdir"), "../apkg-escape-collection.anki2").getCanonicalFile();
        escaped.delete();
        MockMultipartFile sly = apkg(zip -> entry(zip, "../apkg-escape-collection.anki2", collectionWithNotes(1)));

        service.importApkgDetails(USER, sly);

        assertThat(escaped).doesNotExist();
    }

    @Test
    @DisplayName("Only the first notes up to the bound are imported; the rest is reported, not processed")
    void noteCountIsBounded() throws Exception {
        service.apkgMaxNotes = 2;
        MockMultipartFile large = apkg(zip -> entry(zip, "collection.anki21", collectionWithNotes(5)));

        FlashcardService.ApkgImportResult result = service.importApkgDetails(USER, large);

        assertThat(result.totalNotes()).isEqualTo(2);
        assertThat(result.importedCount()).isLessThanOrEqualTo(2);
        assertThat(result.skipReasons()).anyMatch(reason -> reason.contains("first 2 notes"));
    }

    @Test
    @DisplayName("A legitimate package within the bounds still imports")
    void ordinaryPackageStillImports() throws Exception {
        MockMultipartFile ordinary = apkg(zip -> {
            entry(zip, "media", "{}".getBytes());
            entry(zip, "collection.anki21", collectionWithNotes(3));
        });

        FlashcardService.ApkgImportResult result = service.importApkgDetails(USER, ordinary);

        assertThat(result.totalNotes()).isEqualTo(3);
        assertThat(result.importedCount()).isEqualTo(3);
    }
}
