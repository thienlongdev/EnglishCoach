package com.englishcoach.writing.service;

import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.CreateSessionRequest;
import com.englishcoach.writing.dto.WritingSessionDto;
import com.englishcoach.writing.dto.WritingSourceContextDto;
import com.englishcoach.writing.enums.WritingSourceType;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.exception.WritingValidationException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingSourceAdapterServiceImpl implements WritingSourceAdapterService {

    private final WritingProperties writingProperties;
    private final WritingCatalogService catalogService;
    private final WritingSessionService sessionService;

    private final FlashcardRepository flashcardRepository;
    private final ReadingMaterialRepository readingMaterialRepository;
    private final ListeningMaterialRepository listeningMaterialRepository;
    private final SpeakingSessionRepository speakingSessionRepository;
    private final SpeakingTurnRepository speakingTurnRepository;

    private void checkEnabled() {
        if (!writingProperties.isEnabled()) {
            throw new WritingDisabledException("Writing module is currently disabled by administrator.");
        }
    }

    private void checkMutationsEnabled() {
        checkEnabled();
        if (!writingProperties.isMutationsEnabled()) {
            throw new WritingDisabledException("Writing mutations are currently paused.");
        }
    }

    @Override
    @Transactional(readOnly = true)
    public WritingSourceContextDto getSourceContext(Long userId, WritingSourceType sourceType, String sourceId) {
        checkEnabled();
        if (sourceType == null) {
            throw new WritingValidationException("sourceType must be specified");
        }

        switch (sourceType) {
            case VOCABULARY -> {
                return buildVocabularyContext(userId, sourceId);
            }
            case READING -> {
                return buildReadingContext(userId, sourceId);
            }
            case LISTENING -> {
                return buildListeningContext(userId, sourceId);
            }
            case SPEAKING -> {
                return buildSpeakingContext(userId, sourceId);
            }
            default -> throw new WritingValidationException("Unsupported source type: " + sourceType);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public List<WritingSourceContextDto> getAvailableSourceContexts(Long userId, WritingSourceType sourceType) {
        checkEnabled();
        if (sourceType == null) {
            List<WritingSourceContextDto> all = new ArrayList<>();
            for (WritingSourceType type : WritingSourceType.values()) {
                all.addAll(getAvailableSourceContexts(userId, type));
            }
            return all;
        }

        List<WritingSourceContextDto> results = new ArrayList<>();
        switch (sourceType) {
            case VOCABULARY -> {
                var due = flashcardRepository.findDueFlashcards(userId, PageRequest.of(0, 5));
                if (due.hasContent()) {
                    List<String> words = due.getContent().stream()
                            .map(f -> f.getDictionaryEntry().getWord())
                            .distinct()
                            .toList();
                    results.add(WritingSourceContextDto.builder()
                            .sourceType(WritingSourceType.VOCABULARY)
                            .sourceId("due")
                            .sourceTitle("Due Vocabulary Application")
                            .sourceExcerpt("Apply your due spaced-repetition vocabulary in writing.")
                            .targetWords(words)
                            .suggestedCategory("Everyday")
                            .suggestedRegister("Neutral")
                            .suggestedPrompt("Write a coherent paragraph naturally incorporating these target vocabulary words: " + String.join(", ", words))
                            .suggestedRequirements(List.of(
                                    "Naturally integrate all target vocabulary words",
                                    "Maintain logical cohesion and consistent tone",
                                    "Verify proper collocation and grammatical form"
                            ))
                            .targetWordCountMin(80)
                            .targetWordCountMax(160)
                            .build());
                }
            }
            case READING -> {
                var materials = readingMaterialRepository.findVisibleToUser(userId).stream().limit(3).toList();
                for (ReadingMaterial m : materials) {
                    results.add(WritingSourceContextDto.builder()
                            .sourceType(WritingSourceType.READING)
                            .sourceId(String.valueOf(m.getId()))
                            .sourceTitle("Reading Synthesis: " + m.getTitle())
                            .sourceExcerpt(truncate(m.getContentText(), 200))
                            .targetWords(Collections.emptyList())
                            .suggestedCategory("Academic")
                            .suggestedRegister("Formal Academic")
                            .suggestedPrompt("Summarize the central thesis of '" + m.getTitle() + "' and evaluate its key argument with your own perspective.")
                            .suggestedRequirements(List.of(
                                    "Summarize the core argument concisely without verbatim copying",
                                    "State a clear position with supporting rationale",
                                    "Use cohesive discourse markers to structure your points"
                            ))
                            .targetWordCountMin(150)
                            .targetWordCountMax(250)
                            .build());
                }
            }
            case LISTENING -> {
                var materials = listeningMaterialRepository.findVisibleByFilters(userId, null, null, null).stream().limit(3).toList();
                for (ListeningMaterial m : materials) {
                    results.add(WritingSourceContextDto.builder()
                            .sourceType(WritingSourceType.LISTENING)
                            .sourceId(String.valueOf(m.getId()))
                            .sourceTitle("Listening Brief: " + m.getTitle())
                            .sourceExcerpt("Topic: " + (m.getTopic() != null ? m.getTopic() : m.getTitle()))
                            .targetWords(Collections.emptyList())
                            .suggestedCategory("Work")
                            .suggestedRegister("Professional Business")
                            .suggestedPrompt("Draft an executive summary memo based on the audio discussion '" + m.getTitle() + "', highlighting key takeaways and action items.")
                            .suggestedRequirements(List.of(
                                    "Summarize the primary discussion points accurately",
                                    "Structure into clear, actionable bullet points or subsections",
                                    "Conclude with concrete next steps"
                            ))
                            .targetWordCountMin(120)
                            .targetWordCountMax(220)
                            .build());
                }
            }
            case SPEAKING -> {
                var sessions = speakingSessionRepository.findByUserIdOrderByCreatedAtDesc(userId);
                for (SpeakingSession s : sessions.stream().limit(3).toList()) {
                    String title = s.getScenario() != null ? s.getScenario().getTitle() : "Spoken Conversation #" + s.getId();
                    results.add(WritingSourceContextDto.builder()
                            .sourceType(WritingSourceType.SPEAKING)
                            .sourceId(String.valueOf(s.getId()))
                            .sourceTitle("Conversation Follow-up: " + title)
                            .sourceExcerpt("Follow up on roleplay/shadowing dialogue (" + s.getMode() + ").")
                            .targetWords(Collections.emptyList())
                            .suggestedCategory("Work")
                            .suggestedRegister("Professional / Courteous")
                            .suggestedPrompt("Draft a professional written follow-up message confirming the outcomes of your recent spoken conversation in '" + title + "'.")
                            .suggestedRequirements(List.of(
                                    "Reference the spoken discussion points accurately",
                                    "Maintain a courteous and accountable business tone",
                                    "Confirm agreements reached and next milestones"
                            ))
                            .targetWordCountMin(100)
                            .targetWordCountMax(200)
                            .build());
                }
            }
        }
        return results;
    }

    @Override
    @Transactional
    public WritingSessionDto createSessionFromSource(Long userId, WritingSourceType sourceType, String sourceId) {
        checkMutationsEnabled();
        WritingSourceContextDto context = getSourceContext(userId, sourceType, sourceId);

        String dynamicTaskId = "src-" + sourceType.name().toLowerCase() + "-" + (sourceId != null ? sourceId : "auto-" + UUID.randomUUID().toString().substring(0, 8));
        Map<String, Object> taskMap = new HashMap<>();
        taskMap.put("id", dynamicTaskId);
        taskMap.put("version", 1);
        taskMap.put("category", context.getSuggestedCategory() != null ? context.getSuggestedCategory() : "Everyday");
        taskMap.put("title", context.getSourceTitle());
        taskMap.put("prompt", context.getSuggestedPrompt());
        taskMap.put("guidance", "Aim for " + context.getTargetWordCountMin() + "-" + context.getTargetWordCountMax() + " words.");
        taskMap.put("audience", "Professional Reader / Instructor");
        taskMap.put("targetRegister", context.getSuggestedRegister() != null ? context.getSuggestedRegister() : "Neutral");
        taskMap.put("targetWordCountMin", context.getTargetWordCountMin());
        taskMap.put("targetWordCountMax", context.getTargetWordCountMax());
        taskMap.put("requirements", context.getSuggestedRequirements());
        taskMap.put("sourceType", sourceType.name());
        taskMap.put("sourceId", sourceId);
        taskMap.put("targetWords", context.getTargetWords());

        catalogService.registerDynamicTask(userId, taskMap);

        CreateSessionRequest req = CreateSessionRequest.builder()
                .taskId(dynamicTaskId)
                .build();

        return sessionService.createSession(userId, req);
    }

    private WritingSourceContextDto buildVocabularyContext(Long userId, String sourceId) {
        List<Flashcard> cards = new ArrayList<>();
        if (sourceId != null && !sourceId.isBlank() && !sourceId.equalsIgnoreCase("due")) {
            try {
                Long cardId = Long.parseLong(sourceId);
                Flashcard card = flashcardRepository.findById(cardId)
                        .orElseThrow(() -> new WritingNotFoundException("Flashcard not found: " + sourceId));
                if (!card.getUser().getId().equals(userId)) {
                    throw new WritingNotFoundException("Flashcard not found: " + sourceId);
                }
                cards.add(card);
            } catch (NumberFormatException e) {
                throw new WritingNotFoundException("Invalid flashcard ID: " + sourceId);
            }
        } else {
            var page = flashcardRepository.findDueFlashcards(userId, PageRequest.of(0, 5));
            if (page.hasContent()) {
                cards.addAll(page.getContent());
            } else {
                var recent = flashcardRepository.findByUserId(userId, PageRequest.of(0, 5));
                if (recent.hasContent()) {
                    cards.addAll(recent.getContent());
                }
            }
        }

        List<String> words = cards.stream()
                .map(c -> c.getDictionaryEntry().getWord())
                .filter(Objects::nonNull)
                .distinct()
                .toList();

        if (words.isEmpty()) {
            words = List.of("demonstrate", "perspective", "implement");
        }

        String wordList = String.join(", ", words);
        return WritingSourceContextDto.builder()
                .sourceType(WritingSourceType.VOCABULARY)
                .sourceId(sourceId != null ? sourceId : "auto")
                .sourceTitle("Vocabulary Production: " + wordList)
                .sourceExcerpt("Target vocabulary items to incorporate in meaningful sentences.")
                .targetWords(words)
                .suggestedCategory("Everyday")
                .suggestedRegister("Neutral")
                .suggestedPrompt("Write a cohesive paragraph or short reflection naturally incorporating the following vocabulary words: " + wordList + ".")
                .suggestedRequirements(List.of(
                        "Incorporate all target words in grammatically appropriate positions",
                        "Ensure collocations sound natural to a native English reader",
                        "Maintain clear sentence transitions and cohesion"
                ))
                .targetWordCountMin(80)
                .targetWordCountMax(180)
                .build();
    }

    private WritingSourceContextDto buildReadingContext(Long userId, String sourceId) {
        ReadingMaterial material;
        if (sourceId == null || sourceId.isBlank()) {
            var visible = readingMaterialRepository.findVisibleToUser(userId);
            if (visible.isEmpty()) {
                throw new WritingNotFoundException("No reading materials available.");
            }
            material = visible.get(0);
        } else {
            Long matId;
            try {
                matId = Long.parseLong(sourceId);
            } catch (NumberFormatException e) {
                throw new WritingNotFoundException("Reading material not found: " + sourceId);
            }
            material = readingMaterialRepository.findByIdAndVisibleToUser(matId, userId)
                    .orElseThrow(() -> new WritingNotFoundException("Reading material not found: " + matId));
        }

        String excerpt = truncate(material.getContentText(), 300);
        return WritingSourceContextDto.builder()
                .sourceType(WritingSourceType.READING)
                .sourceId(String.valueOf(material.getId()))
                .sourceTitle("Reading Reflection: " + material.getTitle())
                .sourceExcerpt(excerpt)
                .targetWords(Collections.emptyList())
                .suggestedCategory("Academic")
                .suggestedRegister("Formal Academic")
                .suggestedPrompt("Read the excerpt from '" + material.getTitle() + "' and write an analytical response. Synthesize the author's primary thesis and present your own reasoned perspective with supporting examples.")
                .suggestedRequirements(List.of(
                        "Summarize the author's argument without verbatim copying",
                        "Formulate an analytical thesis with structured support",
                        "Employ precise academic vocabulary and transitional markers"
                ))
                .targetWordCountMin(150)
                .targetWordCountMax(250)
                .build();
    }

    private WritingSourceContextDto buildListeningContext(Long userId, String sourceId) {
        ListeningMaterial material;
        if (sourceId == null || sourceId.isBlank()) {
            var visible = listeningMaterialRepository.findVisibleByFilters(userId, null, null, null);
            if (visible.isEmpty()) {
                throw new WritingNotFoundException("No listening materials available.");
            }
            material = visible.get(0);
        } else {
            Long matId;
            try {
                matId = Long.parseLong(sourceId);
            } catch (NumberFormatException e) {
                throw new WritingNotFoundException("Listening material not found: " + sourceId);
            }
            material = listeningMaterialRepository.findByIdAndVisibleToUser(matId, userId)
                    .orElseThrow(() -> new WritingNotFoundException("Listening material not found: " + matId));
        }

        String excerpt = "";
        if (material.getSegments() != null && !material.getSegments().isEmpty()) {
            excerpt = material.getSegments().stream()
                    .map(TranscriptSegment::getText)
                    .filter(Objects::nonNull)
                    .limit(2)
                    .collect(Collectors.joining(" "));
        }
        if (excerpt.isBlank()) {
            excerpt = "Topic: " + (material.getTopic() != null ? material.getTopic() : material.getTitle());
        }

        return WritingSourceContextDto.builder()
                .sourceType(WritingSourceType.LISTENING)
                .sourceId(String.valueOf(material.getId()))
                .sourceTitle("Listening Synthesis: " + material.getTitle())
                .sourceExcerpt(truncate(excerpt, 250))
                .targetWords(Collections.emptyList())
                .suggestedCategory("Work")
                .suggestedRegister("Professional Business")
                .suggestedPrompt("Draft an executive summary memo based on the audio discussion in '" + material.getTitle() + "'. Summarize the key arguments presented by the speakers and suggest strategic next steps.")
                .suggestedRequirements(List.of(
                        "Accurately reflect the spoken points and nuances from the audio",
                        "Organize your findings with clear headings or structured paragraphs",
                        "Maintain an objective, accountable professional tone"
                ))
                .targetWordCountMin(120)
                .targetWordCountMax(220)
                .build();
    }

    private WritingSourceContextDto buildSpeakingContext(Long userId, String sourceId) {
        if (sourceId == null || sourceId.isBlank()) {
            var recent = speakingSessionRepository.findByUserIdOrderByCreatedAtDesc(userId);
            if (recent.isEmpty()) {
                throw new WritingNotFoundException("No speaking sessions found for user.");
            }
            sourceId = String.valueOf(recent.get(0).getId());
        }

        Long sessId;
        try {
            sessId = Long.parseLong(sourceId);
        } catch (NumberFormatException e) {
            throw new WritingNotFoundException("Speaking session not found: " + sourceId);
        }

        SpeakingSession session = speakingSessionRepository.findById(sessId)
                .orElseThrow(() -> new WritingNotFoundException("Speaking session not found: " + sessId));

        if (!session.getUser().getId().equals(userId)) {
            throw new WritingNotFoundException("Speaking session not found: " + sessId);
        }

        List<SpeakingTurn> turns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(session.getId());
        String conversationExcerpt = turns.stream()
                .map(t -> t.getSpeaker() + ": " + t.getText())
                .limit(4)
                .collect(Collectors.joining("\n"));

        String scenarioTitle = session.getScenario() != null ? session.getScenario().getTitle() : "Spoken Conversation";

        return WritingSourceContextDto.builder()
                .sourceType(WritingSourceType.SPEAKING)
                .sourceId(String.valueOf(session.getId()))
                .sourceTitle("Speaking Follow-up: " + scenarioTitle)
                .sourceExcerpt(truncate(conversationExcerpt, 300))
                .targetWords(Collections.emptyList())
                .suggestedCategory("Work")
                .suggestedRegister("Professional / Courteous")
                .suggestedPrompt("Follow up on your spoken dialogue from '" + scenarioTitle + "'. Draft a formal confirmation email summarizing the main agreements reached, clarifying responsibilities, and establishing the next meeting date.")
                .suggestedRequirements(List.of(
                        "Align with the decisions made in the spoken dialogue",
                        "Write with professional courtesy and precision",
                        "Include a clear call to action and timeline"
                ))
                .targetWordCountMin(100)
                .targetWordCountMax(200)
                .build();
    }

    private String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max) + "...";
    }
}
