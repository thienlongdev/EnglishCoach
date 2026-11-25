package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.entity.DocumentHighlight;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.DocumentHighlightRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.dto.SpeakingContextDto;
import com.englishcoach.vocabulary.entity.VocabularyCourse;
import com.englishcoach.vocabulary.entity.VocabularyCourseWord;
import com.englishcoach.vocabulary.repository.VocabularyCourseRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingContextServiceTest {

    @Mock
    private VocabularyCourseRepository vocabularyCourseRepository;

    @Mock
    private ReadingMaterialRepository readingMaterialRepository;

    @Mock
    private DocumentHighlightRepository documentHighlightRepository;

    @Mock
    private ListeningMaterialRepository listeningMaterialRepository;

    @InjectMocks
    private SpeakingContextService speakingContextService;

    @Test
    @DisplayName("resolveContext for VOCABULARY should extract words and context sentences without trusting client")
    void testResolveVocabularyContext() {
        VocabularyCourse course = VocabularyCourse.builder()
                .id(105L)
                .title("Travel & Airport Basics")
                .description("Airport conversations and travel phrases")
                .cefrLevel("B1")
                .build();

        VocabularyCourseWord w1 = VocabularyCourseWord.builder()
                .id(1L)
                .course(course)
                .word("reservation")
                .contextSentence("I would like to confirm my reservation.")
                .build();

        VocabularyCourseWord w2 = VocabularyCourseWord.builder()
                .id(2L)
                .course(course)
                .word("boarding pass")
                .contextSentence("Please show your boarding pass at the gate.")
                .build();

        course.setWords(List.of(w1, w2));

        when(vocabularyCourseRepository.findByIdWithWords(105L)).thenReturn(Optional.of(course));

        SpeakingContextDto context = speakingContextService.resolveContext("VOCABULARY", 105L, 1L);

        assertThat(context).isNotNull();
        assertThat(context.sourceType()).isEqualTo("VOCABULARY");
        assertThat(context.sourceId()).isEqualTo(105L);
        assertThat(context.sourceTitle()).isEqualTo("Travel & Airport Basics");
        assertThat(context.cefrLevel()).isEqualTo("B1");
        assertThat(context.targetVocabulary()).containsExactly("reservation", "boarding pass");
        assertThat(context.targetPhrases()).containsExactly(
                "I would like to confirm my reservation.",
                "Please show your boarding pass at the gate."
        );

        verify(vocabularyCourseRepository, times(1)).findByIdWithWords(105L);
    }

    @Test
    @DisplayName("resolveContext for READING should extract highlighted words and material info")
    void testResolveReadingContext() {
        ReadingMaterial reading = ReadingMaterial.builder()
                .id(201L)
                .title("Artificial Intelligence in Daily Life")
                .difficultyLevel("B2")
                .contentText("Artificial intelligence is transforming modern society rapidly.")
                .build();

        DocumentHighlight h1 = DocumentHighlight.builder()
                .id(1L)
                .readingMaterial(reading)
                .highlightedText("transforming")
                .build();

        when(readingMaterialRepository.findByIdAndVisibleToUser(201L, 1L)).thenReturn(Optional.of(reading));
        when(documentHighlightRepository.findByReadingMaterialIdAndUserId(201L, 1L)).thenReturn(List.of(h1));

        SpeakingContextDto context = speakingContextService.resolveContext("READING", 201L, 1L);

        assertThat(context).isNotNull();
        assertThat(context.sourceType()).isEqualTo("READING");
        assertThat(context.sourceId()).isEqualTo(201L);
        assertThat(context.sourceTitle()).isEqualTo("Artificial Intelligence in Daily Life");
        assertThat(context.cefrLevel()).isEqualTo("B2");
        assertThat(context.targetVocabulary()).contains("transforming");

        verify(readingMaterialRepository, times(1)).findByIdAndVisibleToUser(201L, 1L);
    }

    @Test
    @DisplayName("resolveContext should throw 404 ResponseStatusException when course not found")
    void testResolveContextNotFound() {
        when(vocabularyCourseRepository.findByIdWithWords(999L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> speakingContextService.resolveContext("VOCABULARY", 999L, 1L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404 NOT_FOUND");
    }

    @Test
    @DisplayName("resolveContext should throw 400 IllegalArgumentException for invalid sourceType or null parameters")
    void testResolveContextInvalidType() {
        assertThatThrownBy(() -> speakingContextService.resolveContext("UNKNOWN_TYPE", 1L, 1L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported sourceType");

        assertThatThrownBy(() -> speakingContextService.resolveContext(null, 1L, 1L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceType parameter is required");

        assertThatThrownBy(() -> speakingContextService.resolveContext("VOCABULARY", null, 1L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceId parameter is required");
    }
}
