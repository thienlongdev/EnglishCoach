package com.englishcoach.flashcard.service;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class FlashcardCatalogTest {
    @Test void catalogUsesOnlyMetadataAndIndependentCountsWithChangingRevision() throws Exception {
        var cards = mock(FlashcardRepository.class);
        var decks = mock(VocabDeckRepository.class);
        var dictionary = mock(DictionaryRepository.class);
        var service = new FlashcardService(cards, mock(UserRepository.class), dictionary, new AnkiNoteParser(), decks, null);
        when(decks.findByIsSystemTrueOrderBySortOrderAsc()).thenReturn(List.of(
            VocabDeck.builder().id(1L).slug("one").title("One").description("Desc").category("OXFORD").totalWords(200).build(),
            VocabDeck.builder().id(2L).slug("two").title("Two").category("OXFORD").totalWords(50).build()));
        when(cards.countDeckDictionaryEntriesGrouped()).thenReturn(List.<Object[]>of(new Object[]{1L, 100L}));
        var catalog = service.getSystemCatalog();
        assertThat(catalog.totalDecks()).isEqualTo(2);
        assertThat(catalog.totalWords()).isEqualTo(150);
        assertThat(catalog.decks().get(0).totalWords()).isEqualTo(100);
        assertThat(service.getSystemCatalog().catalogRevision()).isEqualTo(catalog.catalogRevision());
        String json = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(catalog);
        assertThat(json).doesNotContain("mastered", "userId", "meanings", "examples", "dictionaryEntry", "dueCount");
        verifyNoInteractions(dictionary);
        verify(cards, never()).getDeckStatsByUserId(anyLong());
        when(cards.countDeckDictionaryEntriesGrouped()).thenReturn(List.<Object[]>of(new Object[]{1L, 101L}));
        assertThat(service.getSystemCatalog().catalogRevision()).isNotEqualTo(catalog.catalogRevision());
        when(decks.findByIsSystemTrueOrderBySortOrderAsc()).thenReturn(List.of());
        assertThat(service.getSystemCatalog().totalDecks()).isZero();
        when(cards.countDeckDictionaryEntriesGrouped()).thenThrow(new IllegalStateException("query failed"));
        assertThatThrownBy(service::getSystemCatalog).isInstanceOf(IllegalStateException.class); // failure is never authoritative empty
    }

    @Test void overlayQueriesOnlyAuthenticatedUsersAggregate() {
        var cards = mock(FlashcardRepository.class);
        var decks = mock(VocabDeckRepository.class);
        var service = new FlashcardService(cards, mock(UserRepository.class), mock(DictionaryRepository.class), new AnkiNoteParser(), decks, null);
        var p = mock(FlashcardRepository.DeckStatsProjection.class);
        when(p.getTotalCards()).thenReturn(12L); when(p.getMasteredCards()).thenReturn(3L);
        when(p.getReviewedCards()).thenReturn(3L); when(p.getLearningCards()).thenReturn(9L); when(p.getDueCards()).thenReturn(9L);
        when(cards.getDeckStatsByUserId(101L)).thenReturn(List.of(p));
        assertThat(service.getDeckProgress(101L).get(0).totalCards()).isEqualTo(12);
        assertThat(service.getDeckProgress(102L)).isEmpty();
        verifyNoInteractions(decks); verify(cards, never()).countDeckDictionaryEntriesGrouped();
    }
}
