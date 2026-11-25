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
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingContextService {

    private final VocabularyCourseRepository vocabularyCourseRepository;
    private final ReadingMaterialRepository readingMaterialRepository;
    private final DocumentHighlightRepository documentHighlightRepository;
    private final ListeningMaterialRepository listeningMaterialRepository;

    @Transactional(readOnly = true)
    public SpeakingContextDto resolveContext(String sourceTypeStr, Long sourceId, Long userId) {
        if (sourceTypeStr == null || sourceTypeStr.isBlank()) {
            throw new IllegalArgumentException("sourceType parameter is required. Supported values: VOCABULARY, READING, LISTENING.");
        }
        if (sourceId == null) {
            throw new IllegalArgumentException("sourceId parameter is required.");
        }

        String normalizedType = sourceTypeStr.trim().toUpperCase();

        return switch (normalizedType) {
            case "VOCABULARY" -> resolveVocabularyContext(sourceId);
            case "READING" -> resolveReadingContext(sourceId, userId);
            case "LISTENING" -> resolveListeningContext(sourceId, userId);
            default -> throw new IllegalArgumentException("Unsupported sourceType: '" + sourceTypeStr + "'. Supported values: VOCABULARY, READING, LISTENING.");
        };
    }

    private SpeakingContextDto resolveVocabularyContext(Long courseId) {
        VocabularyCourse course = vocabularyCourseRepository.findByIdWithWords(courseId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Vocabulary course not found with id: " + courseId));

        List<String> targetVocabulary = new ArrayList<>();
        List<String> targetPhrases = new ArrayList<>();

        if (course.getWords() != null) {
            for (VocabularyCourseWord w : course.getWords()) {
                if (w.getWord() != null && !w.getWord().isBlank()) {
                    targetVocabulary.add(w.getWord().trim());
                }
                if (w.getContextSentence() != null && !w.getContextSentence().isBlank()) {
                    targetPhrases.add(w.getContextSentence().trim());
                }
            }
        }

        return new SpeakingContextDto(
                "VOCABULARY",
                course.getId(),
                course.getTitle(),
                course.getCefrLevel() != null ? course.getCefrLevel() : "B1",
                course.getDescription(),
                targetVocabulary.stream().distinct().toList(),
                targetPhrases.stream().distinct().toList()
        );
    }

    private SpeakingContextDto resolveReadingContext(Long materialId, Long userId) {
        ReadingMaterial material = readingMaterialRepository.findByIdAndVisibleToUser(materialId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found with id: " + materialId));

        List<DocumentHighlight> highlights = (userId != null)
                ? documentHighlightRepository.findByReadingMaterialIdAndUserId(materialId, userId)
                : List.of();

        List<String> targetVocabulary = new ArrayList<>();
        List<String> targetPhrases = new ArrayList<>();

        if (highlights != null && !highlights.isEmpty()) {
            for (DocumentHighlight dh : highlights) {
                if (dh.getHighlightedText() != null && !dh.getHighlightedText().isBlank()) {
                    String clean = dh.getHighlightedText().trim();
                    if (clean.split("\\s+").length <= 3) {
                        targetVocabulary.add(clean);
                    } else {
                        targetPhrases.add(clean);
                    }
                }
            }
        }

        // If no user highlights exist, extract key sentences and words from contentText
        if (targetPhrases.isEmpty() && material.getContentText() != null && !material.getContentText().isBlank()) {
            String[] sentences = material.getContentText().split("(?<=[.!?])\\s+");
            for (int i = 0; i < Math.min(sentences.length, 3); i++) {
                String s = sentences[i].trim();
                if (!s.isBlank()) {
                    targetPhrases.add(s);
                }
            }
        }

        if (targetVocabulary.isEmpty() && material.getContentText() != null && !material.getContentText().isBlank()) {
            String[] tokens = material.getContentText().split("[\\s.,;:!?\"'()\\[\\]{}]+");
            Set<String> words = Arrays.stream(tokens)
                    .map(String::trim)
                    .map(String::toLowerCase)
                    .filter(w -> w.length() >= 5)
                    .filter(w -> !isCommonStopword(w))
                    .limit(6)
                    .collect(Collectors.toCollection(LinkedHashSet::new));
            targetVocabulary.addAll(words);
        }

        return new SpeakingContextDto(
                "READING",
                material.getId(),
                material.getTitle(),
                material.getDifficultyLevel() != null ? material.getDifficultyLevel() : "INTERMEDIATE",
                "Reading Passage",
                targetVocabulary.stream().distinct().toList(),
                targetPhrases.stream().distinct().toList()
        );
    }

    private SpeakingContextDto resolveListeningContext(Long materialId, Long userId) {
        ListeningMaterial material = listeningMaterialRepository.findByIdAndVisibleToUser(materialId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Listening material not found with id: " + materialId));

        List<String> targetPhrases = new ArrayList<>();
        if (material.getSegments() != null) {
            material.getSegments().stream()
                    .map(TranscriptSegment::getText)
                    .filter(t -> t != null && !t.isBlank())
                    .limit(4)
                    .forEach(targetPhrases::add);
        }

        List<String> targetVocabulary = new ArrayList<>();
        if (material.getTopic() != null && !material.getTopic().isBlank()) {
            targetVocabulary.add(material.getTopic());
        }

        return new SpeakingContextDto(
                "LISTENING",
                material.getId(),
                material.getTitle(),
                material.getCefrLevel() != null ? material.getCefrLevel() : "B1",
                material.getTopic(),
                targetVocabulary,
                targetPhrases
        );
    }

    private boolean isCommonStopword(String word) {
        Set<String> stopwords = Set.of(
                "about", "above", "after", "again", "against", "because", "before", "being",
                "between", "could", "doing", "during", "further", "having", "other", "should",
                "their", "theirs", "there", "these", "through", "under", "until", "where",
                "which", "while", "would", "yours"
        );
        return stopwords.contains(word);
    }
}
