package com.englishcoach.flashcard;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.controller.FlashcardController;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.service.AnkiNoteParser;
import com.englishcoach.flashcard.service.FlashcardService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit.jupiter.SpringExtension;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(SpringExtension.class)
@ContextConfiguration(classes = {
        FlashcardController.class,
        FlashcardService.class,
        AnkiNoteParser.class
})
class FlashcardContextStartupTest {

    @MockBean
    private FlashcardRepository flashcardRepository;

    @MockBean
    private UserRepository userRepository;

    @MockBean
    private DictionaryRepository dictionaryRepository;

    @MockBean
    private com.englishcoach.flashcard.repository.VocabDeckRepository vocabDeckRepository;


    @Autowired
    private FlashcardService flashcardService;

    @Autowired
    private AnkiNoteParser ankiNoteParser;

    @Autowired
    private FlashcardController flashcardController;

    @Test
    @DisplayName("Spring ApplicationContext unambiguously instantiates FlashcardService and FlashcardController via constructor injection")
    void testContextCreatesFlashcardBeansSuccessfully() {
        assertThat(flashcardService).isNotNull();
        assertThat(ankiNoteParser).isNotNull();
        assertThat(flashcardController).isNotNull();
    }
}
