package com.englishcoach.reading;

import com.englishcoach.dictionary.service.DictionaryService;
import com.englishcoach.reading.controller.ReadingController;
import com.englishcoach.reading.repository.ReadingContextualExplanationRepository;
import com.englishcoach.reading.repository.ReadingContextualVocabularyHistoryRepository;
import com.englishcoach.reading.service.ReadingContextualService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ReadingContextStartupTest {

    @Autowired
    private ApplicationContext applicationContext;

    @Autowired
    private ReadingController readingController;

    @Autowired
    private ReadingContextualService contextualService;

    @Autowired
    private ReadingContextualExplanationRepository explanationRepository;

    @Autowired
    private ReadingContextualVocabularyHistoryRepository historyRepository;

    @Autowired
    private DictionaryService dictionaryService;

    @Test
    @DisplayName("ApplicationContext boots and initializes all Reading contextual beans and repositories")
    void testReadingContextStartup() {
        assertThat(applicationContext).isNotNull();
        assertThat(readingController).isNotNull();
        assertThat(contextualService).isNotNull();
        assertThat(explanationRepository).isNotNull();
        assertThat(historyRepository).isNotNull();
        assertThat(dictionaryService).isNotNull();

        assertThat(applicationContext.containsBean("readingController")).isTrue();
        assertThat(applicationContext.containsBean("readingContextualService")).isTrue();
        assertThat(applicationContext.containsBean("readingContextualExplanationRepository")).isTrue();
        assertThat(applicationContext.containsBean("readingContextualVocabularyHistoryRepository")).isTrue();
        assertThat(applicationContext.containsBean("dictionaryService")).isTrue();
    }
}
