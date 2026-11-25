package com.englishcoach;

import com.englishcoach.flashcard.controller.FlashcardController;
import com.englishcoach.flashcard.service.AnkiNoteParser;
import com.englishcoach.flashcard.service.FlashcardService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ApplicationFullStartupTest {

    @Autowired
    private ApplicationContext applicationContext;

    @Autowired
    private FlashcardService flashcardService;

    @Autowired
    private AnkiNoteParser ankiNoteParser;

    @Autowired
    private FlashcardController flashcardController;

    @Test
    @DisplayName("Full Spring Boot ApplicationContext starts and creates FlashcardService and FlashcardController beans")
    void testFullApplicationContextLoadsFlashcardBeans() {
        assertThat(applicationContext).isNotNull();
        assertThat(flashcardService).isNotNull();
        assertThat(ankiNoteParser).isNotNull();
        assertThat(flashcardController).isNotNull();

        assertThat(applicationContext.containsBean("flashcardService")).isTrue();
        assertThat(applicationContext.containsBean("ankiNoteParser")).isTrue();
        assertThat(applicationContext.containsBean("flashcardController")).isTrue();
    }
}
