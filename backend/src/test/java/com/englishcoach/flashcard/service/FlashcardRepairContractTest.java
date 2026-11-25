package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.progress.service.LearningEventService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Flashcards repair contracts (2026-10-18): every rating persists with its event exactly once (a retried click never
 * applies twice), foreign cards answer 404, unknown ratings 400; every save path normalises its fields at one boundary
 * (no 500 for words the learner already has in several decks, no IPA shown as an example, no placeholder meanings) and
 * keeps the learner's own meaning; Anki notes that start with a note number map to the right fields.
 */
class FlashcardRepairContractTest {

    private static final long USER = 101L;
    private static final long OTHER = 202L;

    private FlashcardRepository cards;
    private UserRepository users;
    private DictionaryRepository dictionary;
    private LearningEventService events;
    private FlashcardService service;
    private User learner;

    @BeforeEach
    void setUp() {
        cards = mock(FlashcardRepository.class);
        users = mock(UserRepository.class);
        dictionary = mock(DictionaryRepository.class);
        events = mock(LearningEventService.class);
        service = new FlashcardService(cards, users, dictionary, new AnkiNoteParser(), null, events);
        learner = User.builder().id(USER).email("learner@test.example").build();
        when(users.findById(USER)).thenReturn(Optional.of(learner));
        when(cards.saveAndFlush(any(Flashcard.class))).thenAnswer(i -> i.getArgument(0));
        when(cards.save(any(Flashcard.class))).thenAnswer(i -> {
            Flashcard f = i.getArgument(0);
            if (f.getId() == null) f.setId(900L);
            return f;
        });
        when(dictionary.save(any(DictionaryEntry.class))).thenAnswer(i -> {
            DictionaryEntry e = i.getArgument(0);
            if (e.getId() == null) e.setId(700L);
            return e;
        });
    }

    private Flashcard due(long id, String status) {
        return Flashcard.builder().id(id).user(learner).status(status).reviewCount(2)
                .dictionaryEntry(DictionaryEntry.builder().id(id).word("w" + id).build())
                .nextReviewDate(LocalDateTime.now().minusHours(1)).build();
    }

    @Test
    @DisplayName("Khó / Tốt / Dễ each save the schedule and one review event, inside one transaction")
    void eachRatingPersistsWithOneEvent() {
        Flashcard hard = due(1, "LEARNED"), good = due(2, "LEARNED"), easy = due(3, "NEW");
        when(cards.findOwnedForUpdate(1L, USER)).thenReturn(Optional.of(hard));
        when(cards.findOwnedForUpdate(2L, USER)).thenReturn(Optional.of(good));
        when(cards.findOwnedForUpdate(3L, USER)).thenReturn(Optional.of(easy));

        var h = service.review(USER, 1L, "hard", "click-hard-0001");
        var g = service.review(USER, 2L, "good", "click-good-0001");
        var e = service.review(USER, 3L, "easy", "click-easy-0001");

        assertThat(h.card().getStatus()).isEqualTo("LEARNED");
        assertThat(h.card().getNextReviewDate()).isBeforeOrEqualTo(LocalDateTime.now());
        assertThat(g.card().getNextReviewDate()).isAfter(LocalDateTime.now().plusDays(2).plusHours(23));
        assertThat(e.card().getStatus()).isEqualTo("MASTERED");
        assertThat(e.card().getNextReviewDate()).isAfter(LocalDateTime.now().plusDays(6));
        assertThat(List.of(h, g, e)).allSatisfy(o -> {
            assertThat(o.replayed()).isFalse();
            assertThat(o.card().getReviewCount()).isEqualTo(3);
        });
        verify(cards, times(3)).saveAndFlush(any());
        verify(events).recordOccurrenceSafely(eq(USER), eq("FLASHCARD_REVIEWED"), eq("1:3"), any());
        verify(events).recordOccurrenceSafely(eq(USER), eq("FLASHCARD_REVIEWED"), eq("2:3"), any());
        verify(events).recordOccurrenceSafely(eq(USER), eq("FLASHCARD_REVIEWED"), eq("3:3"), any());
    }

    @Test
    @DisplayName("A retried click (same Idempotency-Key) returns the stored card: no second transition, no second event")
    void retriedClickIsNotAppliedTwice() {
        Flashcard card = due(5, "LEARNED");
        when(cards.findOwnedForUpdate(5L, USER)).thenReturn(Optional.of(card));

        var first = service.review(USER, 5L, "good", "retry-key-12345");
        LocalDateTime scheduled = first.card().getNextReviewDate();
        var retry = service.review(USER, 5L, "good", "retry-key-12345");

        assertThat(retry.replayed()).isTrue();
        assertThat(retry.card().getReviewCount()).isEqualTo(3);
        assertThat(retry.card().getNextReviewDate()).isEqualTo(scheduled);
        verify(cards, times(1)).saveAndFlush(any());
        verify(events, times(1)).recordOccurrenceSafely(anyLong(), anyString(), anyString(), any());

        // a new click (new key) is a new review
        var next = service.review(USER, 5L, "hard", "retry-key-67890");
        assertThat(next.replayed()).isFalse();
        assertThat(next.card().getReviewCount()).isEqualTo(4);
    }

    @Test
    @DisplayName("Another learner's card answers 404 and is never touched; an unknown rating or key answers 400")
    void isolationAndValidation() {
        when(cards.findOwnedForUpdate(7L, OTHER)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.review(OTHER, 7L, "good", null))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        assertThatThrownBy(() -> service.review(USER, 7L, "maybe", null))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("400");
        assertThatThrownBy(() -> service.review(USER, 7L, "good", "bad key!"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("400");
        verify(cards, never()).saveAndFlush(any());
        verifyNoInteractions(events);
    }

    @Test
    @DisplayName("Saving a word the learner holds in two decks returns the personal card (was a 500) and keeps their meaning")
    void duplicateCardsNoLongerFail() {
        DictionaryEntry entry = DictionaryEntry.builder().id(40L).word("visit").meanings(new ArrayList<>(List.of("thăm"))).build();
        when(dictionary.findByWordIgnoreCase("visit")).thenReturn(Optional.of(entry));
        VocabDeck deck = VocabDeck.builder().id(3L).build();
        Flashcard inDeck = Flashcard.builder().id(10L).user(learner).deck(deck).dictionaryEntry(entry).status("NEW").build();
        Flashcard personal = Flashcard.builder().id(11L).user(learner).dictionaryEntry(entry).status("NEW").build();
        Flashcard otherDeck = Flashcard.builder().id(12L).user(learner).deck(deck).dictionaryEntry(entry).status("NEW").build();
        when(cards.findByUserIdAndDictionaryEntryIdOrderByIdAsc(USER, 40L)).thenReturn(List.of(inDeck, personal, otherDeck));

        var saved = service.saveCustomFlashcard(USER, "visit", "ghé thăm (trong bài đọc)", "We visit our grandparents.", null, null);

        assertThat(saved.created()).isFalse();
        assertThat(saved.card().getId()).isEqualTo(11L);
        assertThat(saved.card().getCustomMeaning()).isEqualTo("ghé thăm (trong bài đọc)");
        assertThat(saved.card().getCustomExample()).isEqualTo("We visit our grandparents.");

        // a second save never overwrites what the learner wrote first, and creates nothing
        var again = service.saveCustomFlashcard(USER, "visit", "khác", "Other.", null, null);
        assertThat(again.card().getCustomMeaning()).isEqualTo("ghé thăm (trong bài đọc)");
        verify(dictionary, never()).save(any());
    }

    @Test
    @DisplayName("A new word: the card is created (201) with the learner's text; a transcription in the example becomes the IPA")
    void newWordNormalisedAtTheBoundary() {
        when(dictionary.findByWordIgnoreCase("scarf")).thenReturn(Optional.empty());
        when(cards.findByUserIdAndDictionaryEntryIdOrderByIdAsc(eq(USER), anyLong())).thenReturn(List.of());

        var saved = service.saveCustomFlashcard(USER, " scarf ", "khăn quàng", "[skɑːf]", null, "b1");

        assertThat(saved.created()).isTrue();
        ArgumentCaptor<DictionaryEntry> entry = ArgumentCaptor.forClass(DictionaryEntry.class);
        verify(dictionary).save(entry.capture());
        assertThat(entry.getValue().getWord()).isEqualTo("scarf");
        assertThat(entry.getValue().getIpa()).isEqualTo("[skɑːf]");
        assertThat(entry.getValue().getCefr()).isEqualTo("B1");
        assertThat(entry.getValue().getExamples()).isEmpty();
        assertThat(entry.getValue().getMeanings()).isEmpty();
        assertThat(entry.getValue().getOwnerUserId()).isEqualTo(USER);
        assertThat(saved.card().getCustomMeaning()).isEqualTo("khăn quàng");
        assertThat(saved.card().getCustomExample()).isNull();
        assertThat(saved.card().getStatus()).isEqualTo("NEW");
    }

    @Test
    @DisplayName("Filler texts are not stored as meanings; empty, oversized or unreadable fields answer 400, never 500")
    void validationAnswers400() {
        when(dictionary.findByWordIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(cards.findByUserIdAndDictionaryEntryIdOrderByIdAsc(eq(USER), anyLong())).thenReturn(List.of());
        var saved = service.saveCustomFlashcard(USER, "ephemeral", "No definition", "Imported custom flashcard", null, null);
        assertThat(saved.card().getCustomMeaning()).isNull();
        assertThat(saved.card().getCustomExample()).isNull();

        for (String[] bad : new String[][] {
                {"   ", "x", null}, {"w".repeat(256), "x", null}, {"word", "m".repeat(2001), null}, {"word", "m", "e".repeat(1001)}}) {
            assertThatThrownBy(() -> service.saveCustomFlashcard(USER, bad[0], bad[1], bad[2], null, null))
                    .isInstanceOf(ResponseStatusException.class).hasMessageContaining("400");
        }
    }

    @Test
    @DisplayName("Saving a word whose card the learner deleted restores that card instead of adding another")
    void deletedCardIsRestored() {
        DictionaryEntry entry = DictionaryEntry.builder().id(41L).word("brisk").build();
        when(dictionary.findByWordIgnoreCase("brisk")).thenReturn(Optional.of(entry));
        Flashcard deleted = Flashcard.builder().id(20L).user(learner).dictionaryEntry(entry).status("LEARNED").state(1).build();
        when(cards.findByUserIdAndDictionaryEntryIdOrderByIdAsc(USER, 41L)).thenReturn(List.of(deleted));

        var saved = service.saveCustomFlashcard(USER, "brisk", "nhanh nhẹn", null, null, null);
        assertThat(saved.created()).isTrue();
        assertThat(saved.card().getState()).isZero();
        assertThat(saved.card().getId()).isEqualTo(20L);
    }

    @Test
    @DisplayName("Dictionary words stored in two spellings resolve to the exact spelling (the old finder threw)")
    void dictionaryCaseDuplicatesResolve() {
        DictionaryRepository repo = mock(DictionaryRepository.class, CALLS_REAL_METHODS);
        DictionaryEntry upper = DictionaryEntry.builder().id(1L).word("May").build();
        DictionaryEntry lower = DictionaryEntry.builder().id(2L).word("may").build();
        doReturn(List.of(upper, lower)).when(repo).findAllByWordIgnoreCaseAndOwnerUserIdIsNullOrderByIdAsc(anyString());
        assertThat(repo.findByWordIgnoreCase("may")).contains(lower);
        assertThat(repo.findByWordIgnoreCase("MAY")).contains(upper);
        doReturn(List.of()).when(repo).findAllByWordIgnoreCaseAndOwnerUserIdIsNullOrderByIdAsc(anyString());
        assertThat(repo.findByWordIgnoreCase("none")).isEmpty();
    }

    @Test
    @DisplayName("Anki notes 'number · word · transcription · meaning' map to word / IPA / meaning, never IPA as example")
    void ankiNumberedNotesMapCorrectly() {
        AnkiNoteParser parser = new AnkiNoteParser();
        char sep = AnkiNoteParser.ANKI_FIELD_SEPARATOR;

        var three = parser.parseNote(1L, "2_29" + sep + "scarf" + sep + "[skɑːf]", Map.of());
        assertThat(three.word()).isEqualTo("scarf");
        assertThat(three.ipa()).isEqualTo("[skɑːf]");
        assertThat(three.example()).isEqualTo("Imported from Anki Deck");

        var four = parser.parseNote(1L, "17" + sep + "scarf" + sep + "/skɑːf/" + sep + "khăn quàng" + sep + "A warm scarf.", Map.of());
        assertThat(four.word()).isEqualTo("scarf");
        assertThat(four.ipa()).isEqualTo("/skɑːf/");
        assertThat(four.meaning()).isEqualTo("khăn quàng");
        assertThat(four.example()).isEqualTo("A warm scarf.");

        // an ordinary two-field note is unchanged
        var plain = parser.parseNote(1L, "resilience" + sep + "sự kiên cường", Map.of());
        assertThat(plain.word()).isEqualTo("resilience");
        assertThat(plain.meaning()).isEqualTo("sự kiên cường");
        assertThat(AnkiNoteParser.looksLikeIdentifier("2_29")).isTrue();
        assertThat(AnkiNoteParser.looksLikeIdentifier("covid-19")).isFalse();
        assertThat(AnkiNoteParser.looksLikeIpa("[skɑːf]")).isTrue();
        assertThat(AnkiNoteParser.looksLikeIpa("[1] see page 2")).isFalse();
    }
}
