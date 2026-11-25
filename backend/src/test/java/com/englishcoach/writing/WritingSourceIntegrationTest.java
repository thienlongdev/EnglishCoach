package com.englishcoach.writing;

import com.englishcoach.auth.entity.User;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.CreateSessionRequest;
import com.englishcoach.writing.dto.WritingSessionDto;
import com.englishcoach.writing.dto.WritingSourceContextDto;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.enums.WritingSourceType;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.service.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WritingSourceIntegrationTest {

    @Mock
    private WritingProperties writingProperties;

    @Mock
    private WritingCatalogService catalogService;

    @Mock
    private WritingSessionService sessionService;

    @Mock
    private FlashcardRepository flashcardRepository;

    @Mock
    private ReadingMaterialRepository readingMaterialRepository;

    @Mock
    private ListeningMaterialRepository listeningMaterialRepository;

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    private WritingSourceAdapterServiceImpl adapterService;

    @BeforeEach
    void setUp() {
        adapterService = new WritingSourceAdapterServiceImpl(
                writingProperties,
                catalogService,
                sessionService,
                flashcardRepository,
                readingMaterialRepository,
                listeningMaterialRepository,
                speakingSessionRepository,
                speakingTurnRepository
        );

        lenient().when(writingProperties.isEnabled()).thenReturn(true);
        lenient().when(writingProperties.isMutationsEnabled()).thenReturn(true);
    }

    @Test
    void testVocabularySourceContext_Success() {
        Long userId = 10L;
        Long cardId = 101L;

        User user = new User();
        user.setId(userId);

        DictionaryEntry entry = new DictionaryEntry();
        entry.setWord("articulate");

        Flashcard card = Flashcard.builder()
                .id(cardId)
                .user(user)
                .dictionaryEntry(entry)
                .build();

        when(flashcardRepository.findById(cardId)).thenReturn(Optional.of(card));

        WritingSourceContextDto context = adapterService.getSourceContext(
                userId, WritingSourceType.VOCABULARY, String.valueOf(cardId)
        );

        assertNotNull(context);
        assertEquals(WritingSourceType.VOCABULARY, context.getSourceType());
        assertTrue(context.getTargetWords().contains("articulate"));
        assertTrue(context.getSuggestedPrompt().contains("articulate"));
    }

    @Test
    void testVocabularySourceContext_ForeignOwnerThrows404() {
        Long ownerId = 10L;
        Long foreignUserId = 99L;
        Long cardId = 101L;

        User user = new User();
        user.setId(ownerId);

        Flashcard card = Flashcard.builder()
                .id(cardId)
                .user(user)
                .build();

        when(flashcardRepository.findById(cardId)).thenReturn(Optional.of(card));

        assertThrows(WritingNotFoundException.class, () -> {
            adapterService.getSourceContext(foreignUserId, WritingSourceType.VOCABULARY, String.valueOf(cardId));
        });
    }

    @Test
    void testReadingSourceContext_Success() {
        Long userId = 10L;
        Long matId = 201L;

        ReadingMaterial material = ReadingMaterial.builder()
                .id(matId)
                .title("The Economics of Clean Energy")
                .contentText("Clean energy transition accelerates global industrial transformation...")
                .build();

        when(readingMaterialRepository.findByIdAndVisibleToUser(matId, userId)).thenReturn(Optional.of(material));

        WritingSourceContextDto context = adapterService.getSourceContext(
                userId, WritingSourceType.READING, String.valueOf(matId)
        );

        assertNotNull(context);
        assertEquals(WritingSourceType.READING, context.getSourceType());
        assertEquals(String.valueOf(matId), context.getSourceId());
        assertTrue(context.getSourceTitle().contains("The Economics of Clean Energy"));
    }

    @Test
    void testListeningSourceContext_Success() {
        Long userId = 10L;
        Long matId = 301L;

        TranscriptSegment segment = TranscriptSegment.builder()
                .text("In today's quarterly meeting, we need to address supply chain delays.")
                .build();

        ListeningMaterial material = ListeningMaterial.builder()
                .id(matId)
                .title("Quarterly Operations Briefing")
                .topic("Operations")
                .segments(List.of(segment))
                .build();

        when(listeningMaterialRepository.findByIdAndVisibleToUser(matId, userId)).thenReturn(Optional.of(material));

        WritingSourceContextDto context = adapterService.getSourceContext(
                userId, WritingSourceType.LISTENING, String.valueOf(matId)
        );

        assertNotNull(context);
        assertEquals(WritingSourceType.LISTENING, context.getSourceType());
        assertTrue(context.getSourceExcerpt().contains("supply chain delays"));
    }

    @Test
    void testSpeakingSourceContext_Success() {
        Long userId = 10L;
        Long sessId = 401L;

        User user = new User();
        user.setId(userId);

        SpeakingScenario scenario = SpeakingScenario.builder()
                .id(1L)
                .title("Contract Negotiation")
                .build();

        SpeakingSession session = SpeakingSession.builder()
                .id(sessId)
                .user(user)
                .scenario(scenario)
                .mode("ROLEPLAY")
                .status("COMPLETED")
                .build();

        SpeakingTurn turn = SpeakingTurn.builder()
                .speaker("LEARNER")
                .text("We agree to the revised payment milestones provided delivery is on time.")
                .build();

        when(speakingSessionRepository.findById(sessId)).thenReturn(Optional.of(session));
        when(speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessId)).thenReturn(List.of(turn));

        WritingSourceContextDto context = adapterService.getSourceContext(
                userId, WritingSourceType.SPEAKING, String.valueOf(sessId)
        );

        assertNotNull(context);
        assertEquals(WritingSourceType.SPEAKING, context.getSourceType());
        assertTrue(context.getSourceTitle().contains("Contract Negotiation"));
        assertTrue(context.getSourceExcerpt().contains("revised payment milestones"));
    }

    @Test
    void testSpeakingSourceContext_ForeignOwnerThrows404() {
        Long ownerId = 10L;
        Long foreignUserId = 99L;
        Long sessId = 401L;

        User user = new User();
        user.setId(ownerId);

        SpeakingSession session = SpeakingSession.builder()
                .id(sessId)
                .user(user)
                .build();

        when(speakingSessionRepository.findById(sessId)).thenReturn(Optional.of(session));

        assertThrows(WritingNotFoundException.class, () -> {
            adapterService.getSourceContext(foreignUserId, WritingSourceType.SPEAKING, String.valueOf(sessId));
        });
    }

    @Test
    void testCreateSessionFromSource_Success() {
        Long userId = 10L;
        Long matId = 201L;

        ReadingMaterial material = ReadingMaterial.builder()
                .id(matId)
                .title("Urban Planning Insights")
                .contentText("Cities require sustainable transit networks to thrive.")
                .build();

        when(readingMaterialRepository.findByIdAndVisibleToUser(matId, userId)).thenReturn(Optional.of(material));

        WritingSessionDto expectedDto = WritingSessionDto.builder()
                .id("sess-dyn-1")
                .userId(userId)
                .taskId("src-reading-201")
                .stage(WritingSessionStage.UNDERSTANDING)
                .build();

        when(sessionService.createSession(eq(userId), any(CreateSessionRequest.class))).thenReturn(expectedDto);

        WritingSessionDto created = adapterService.createSessionFromSource(
                userId, WritingSourceType.READING, String.valueOf(matId)
        );

        assertNotNull(created);
        assertEquals("sess-dyn-1", created.getId());
        verify(catalogService).registerDynamicTask(eq(userId), anyMap());
        verify(sessionService).createSession(eq(userId), any(CreateSessionRequest.class));
    }

    @Test
    void testDisabledWritingThrows() {
        when(writingProperties.isEnabled()).thenReturn(false);

        assertThrows(WritingDisabledException.class, () -> {
            adapterService.getSourceContext(10L, WritingSourceType.READING, "201");
        });
    }

    @Test
    void testSourceModulesIndependence_NoMutationsOnSourceRepositories() {
        Long userId = 10L;
        Long cardId = 101L;

        User user = new User();
        user.setId(userId);

        DictionaryEntry entry = new DictionaryEntry();
        entry.setWord("eloquent");

        Flashcard card = Flashcard.builder()
                .id(cardId)
                .user(user)
                .dictionaryEntry(entry)
                .reviewCount(5)
                .status("LEARNING")
                .state(2)
                .nextReviewDate(java.time.LocalDateTime.now().plusDays(3))
                .build();

        when(flashcardRepository.findById(cardId)).thenReturn(Optional.of(card));

        WritingSessionDto expectedDto = WritingSessionDto.builder()
                .id("sess-vocab-1")
                .userId(userId)
                .taskId("src-vocabulary-101")
                .stage(WritingSessionStage.UNDERSTANDING)
                .build();

        when(sessionService.createSession(eq(userId), any(CreateSessionRequest.class))).thenReturn(expectedDto);

        // Execute handoff
        WritingSessionDto created = adapterService.createSessionFromSource(userId, WritingSourceType.VOCABULARY, String.valueOf(cardId));
        assertNotNull(created);

        // 1. Verify ZERO mutations on FlashcardRepository
        verify(flashcardRepository, never()).save(any());
        verify(flashcardRepository, never()).delete(any());

        // 2. Verify Flashcard entity review state, status, state, scheduling are completely untouched
        assertEquals(5, card.getReviewCount());
        assertEquals("LEARNING", card.getStatus());
        assertEquals(2, card.getState());
        assertNotNull(card.getNextReviewDate());

        // 3. Verify other source repositories are untouched
        verify(readingMaterialRepository, never()).save(any());
        verify(listeningMaterialRepository, never()).save(any());
        verify(speakingSessionRepository, never()).save(any());
        verify(speakingTurnRepository, never()).save(any());
    }

    @Test
    void testSourceDeletionAfterSessionFrozen_HistoricalWritingRemainsInterpretable() {
        Long userId = 10L;
        Long matId = 301L;

        ListeningMaterial material = ListeningMaterial.builder()
                .id(matId)
                .title("Tech Architecture Discussion")
                .topic("Microservices")
                .segments(List.of(TranscriptSegment.builder().text("We are decoupling our backend services.").build()))
                .build();

        when(listeningMaterialRepository.findByIdAndVisibleToUser(matId, userId)).thenReturn(Optional.of(material));

        // When session is created from source, catalog registers the dynamic task scoped to the owner
        doAnswer(invocation -> {
            Map<String, Object> taskMap = invocation.getArgument(1);
            assertEquals("Listening Synthesis: Tech Architecture Discussion", taskMap.get("title"));
            assertEquals("LISTENING", taskMap.get("sourceType"));
            assertEquals("301", taskMap.get("sourceId"));
            return null;
        }).when(catalogService).registerDynamicTask(eq(userId), anyMap());

        WritingSessionDto createdDto = WritingSessionDto.builder()
                .id("sess-frozen-1")
                .userId(userId)
                .taskId("src-listening-301")
                .taskSnapshot(Map.of(
                        "id", "src-listening-301",
                        "title", "Listening Synthesis: Tech Architecture Discussion",
                        "sourceType", "LISTENING",
                        "sourceId", "301",
                        "prompt", "Draft an executive summary memo based on the audio discussion..."
                ))
                .stage(WritingSessionStage.DRAFTING)
                .build();

        when(sessionService.createSession(eq(userId), any(CreateSessionRequest.class))).thenReturn(createdDto);

        WritingSessionDto result = adapterService.createSessionFromSource(userId, WritingSourceType.LISTENING, String.valueOf(matId));
        assertNotNull(result);

        // Historical session remains self-contained and interpretable because taskSnapshot is frozen!
        assertNotNull(result.getTaskSnapshot());
        assertEquals("Listening Synthesis: Tech Architecture Discussion", result.getTaskSnapshot().get("title"));
        assertEquals("LISTENING", result.getTaskSnapshot().get("sourceType"));
        assertEquals("301", result.getTaskSnapshot().get("sourceId"));
    }

    @Test
    void testSpeakingIntegrityNoAcousticMutation() {
        Long userId = 10L;
        Long sessId = 501L;

        User user = new User();
        user.setId(userId);

        SpeakingScenario scenario = SpeakingScenario.builder().id(2L).title("Job Interview").build();
        SpeakingSession session = SpeakingSession.builder()
                .id(sessId)
                .user(user)
                .scenario(scenario)
                .mode("ROLEPLAY")
                .status("COMPLETED")
                .build();

        SpeakingTurn turn = SpeakingTurn.builder()
                .speaker("LEARNER")
                .text("I have five years of experience leading engineering teams.")
                .build();

        when(speakingSessionRepository.findById(sessId)).thenReturn(Optional.of(session));
        when(speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessId)).thenReturn(List.of(turn));

        WritingSourceContextDto ctx = adapterService.getSourceContext(userId, WritingSourceType.SPEAKING, String.valueOf(sessId));
        assertNotNull(ctx);
        assertTrue(ctx.getSourceTitle().contains("Job Interview"));

        // Verify Speaking session state, status, scenario, acoustic data are never mutated
        assertEquals("COMPLETED", session.getStatus());
        assertEquals("ROLEPLAY", session.getMode());
        verify(speakingSessionRepository, never()).save(any());
        verify(speakingTurnRepository, never()).save(any());
    }
}
