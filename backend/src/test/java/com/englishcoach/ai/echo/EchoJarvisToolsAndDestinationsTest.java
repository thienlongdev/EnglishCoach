package com.englishcoach.ai.echo;

import com.englishcoach.ai.echo.tools.*;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.flashcard.dto.VocabDeckSummaryResponse;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.grammar.GrammarService;
import com.englishcoach.leaderboard.board.LeaderboardBoardService;
import com.englishcoach.learningpath.LearningExamPractice;
import com.englishcoach.learningpath.LearningPathDtos;
import com.englishcoach.learningpath.LearningPathService;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.service.ListeningService;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.dto.SpeakingScenarioSummaryDto;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import com.englishcoach.speaking.service.SpeakingScenarioService;
import com.englishcoach.speaking.topic.TopicDtos;
import com.englishcoach.speaking.topic.TopicService;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.PlatformTransactionManager;

import java.time.Instant;
import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class EchoJarvisToolsAndDestinationsTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static <T> ObjectProvider<T> none(Class<T> type) {
        return new StaticListableBeanFactory().getBeanProvider(type);
    }

    private static <T> ObjectProvider<T> of(Class<T> type, T bean) {
        StaticListableBeanFactory f = new StaticListableBeanFactory();
        f.addBean("bean", bean);
        return f.getBeanProvider(type);
    }

    @Test
    void allSixtySixDestinationsAndParameterisedRoutesMatchHrefAllowAndEnforceVisibility() {
        GrammarContent grammar = new GrammarContent(mapper);
        ReadingMaterialRepository readingRepo = mock(ReadingMaterialRepository.class);
        ListeningMaterialRepository listeningRepo = mock(ListeningMaterialRepository.class);
        SpeakingScenarioRepository scenarioRepo = mock(SpeakingScenarioRepository.class);
        FlashcardService flashcardService = mock(FlashcardService.class);

        ListeningMaterial audioLesson = new ListeningMaterial();
        audioLesson.setTitle("BBC 6 Minute English");
        audioLesson.setSourceType("YOUTUBE");
        when(listeningRepo.findByIdAndVisibleToUser(12L, 42L)).thenReturn(Optional.of(audioLesson));

        ListeningMaterial docLesson = new ListeningMaterial();
        docLesson.setTitle("Imported Document");
        docLesson.setSourceType("DOCUMENT");
        when(listeningRepo.findByIdAndVisibleToUser(13L, 42L)).thenReturn(Optional.of(docLesson));

        SpeakingScenario scenario = SpeakingScenario.builder().id(7L).title("Hotel Check-in").isSystem(true).build();
        when(scenarioRepo.findByIdAndAccessible(7L, 42L)).thenReturn(Optional.of(scenario));
        when(scenarioRepo.findByIdAndAccessible(7L, 99L)).thenReturn(Optional.empty());

        VocabDeckSummaryResponse deck = VocabDeckSummaryResponse.builder().id(55L).title("IELTS Band 7.0").totalWords(120).build();
        when(flashcardService.getDecks(42L)).thenReturn(List.of(deck));

        EchoDestinations dests = new EchoDestinations(
                of(GrammarContent.class, grammar),
                of(ReadingMaterialRepository.class, readingRepo),
                of(ListeningMaterialRepository.class, listeningRepo),
                of(SpeakingScenarioRepository.class, scenarioRepo),
                of(FlashcardService.class, flashcardService));

        for (EchoDestinations.Dest d : EchoDestinations.Dest.values()) {
            if (!d.parameterised()) {
                assertThat(d.pattern()).as(d.name()).matches(EchoDestinations.HREF_ALLOW);
            }
        }

        // Parameterised Grammar story, lab, detective
        assertThat(dests.resolve(42L, EchoDestinations.Dest.GRAMMAR_STORY, "archive-handover", null, null, null, true).href())
                .isEqualTo("/grammar/stories/archive-handover").matches(EchoDestinations.HREF_ALLOW);
        assertThat(dests.resolve(42L, EchoDestinations.Dest.GRAMMAR_LAB_ITEM, "after-school-ball", null, null, null, true).href())
                .isEqualTo("/grammar/lab/after-school-ball").matches(EchoDestinations.HREF_ALLOW);
        assertThat(dests.resolve(42L, EchoDestinations.Dest.GRAMMAR_DETECTIVE_CASE, "ecg26-d001-red-stamp", null, null, null, true).href())
                .isEqualTo("/grammar/detective/ecg26-d001-red-stamp").matches(EchoDestinations.HREF_ALLOW);
        assertThat(dests.resolve(42L, EchoDestinations.Dest.GRAMMAR_STORY, "nonexistent-story", null, null, null, true).ok())
                .isFalse();

        // Parameterised Speaking Roleplay, Shadowing & Flashcard Deck
        assertThat(dests.resolve(42L, EchoDestinations.Dest.SPEAKING_ROLEPLAY, null, 7L, null, null, false).href())
                .isEqualTo("/speaking/roleplay/7").matches(EchoDestinations.HREF_ALLOW);
        assertThat(dests.resolve(99L, EchoDestinations.Dest.SPEAKING_ROLEPLAY, null, 7L, null, null, false).ok())
                .isFalse();
        assertThat(dests.resolve(42L, EchoDestinations.Dest.SPEAKING_SHADOWING_LESSON, null, 12L, null, null, false).href())
                .isEqualTo("/speaking/shadowing/12").matches(EchoDestinations.HREF_ALLOW);
        assertThat(dests.resolve(42L, EchoDestinations.Dest.SPEAKING_SHADOWING_LESSON, null, 13L, null, null, false).ok())
                .isFalse(); // DOCUMENT source excluded from shadowing
        assertThat(dests.resolve(42L, EchoDestinations.Dest.FLASHCARDS_DECK, null, 55L, null, null, false).href())
                .isEqualTo("/flashcards?deck=55").matches(EchoDestinations.HREF_ALLOW);

        // Router direct mappings for new destinations (including Wave B Speaking Profile / Pronunciation / History)
        assertThat(EchoRouter.direct("Hi Echo, open Speaking Arena")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.SPEAKING_ARENA);
        assertThat(EchoRouter.direct("Open Speaking Profile")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.SPEAKING_PROFILE);
        assertThat(EchoRouter.direct("Mở hồ sơ luyện nói")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.SPEAKING_PROFILE);
        assertThat(EchoRouter.direct("Mở phân tích phát âm")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.SPEAKING_PRONUNCIATION);
        assertThat(EchoRouter.direct("Open speaking history")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.SPEAKING_HISTORY);
        assertThat(EchoRouter.direct("Mở tủ sách của mình")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.READING_MYBOOKS);
        assertThat(EchoRouter.direct("Open Grammar Lab")).get()
                .extracting(EchoRouter.Command::dest).isEqualTo(EchoDestinations.Dest.GRAMMAR_LAB);
    }

    @Test
    void allEighteenToolsPassSafeSchemaAndExecuteStrictlyForPrincipal() throws Exception {
        GrammarContent grammar = new GrammarContent(mapper);
        EchoDestinations dests = new EchoDestinations(none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
        LearningPathService lp = mock(LearningPathService.class);
        EchoConfirmations confirmations = new EchoConfirmations(of(LearningPathService.class, lp));
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        SpeakingScenarioService scenarioSvc = mock(SpeakingScenarioService.class);
        TopicService topicSvc = mock(TopicService.class);
        FlashcardService flashcardSvc = mock(FlashcardService.class);

        List<EchoTool> allTools = List.of(
                new ExamOverviewTool(none(com.englishcoach.exams.repository.ExamProfileRepository.class), none(LearningExamPractice.class), mapper, mock(ExamAttemptRepository.class), mock(ExamResultService.class)),
                new GrammarPracticeTool(of(GrammarContent.class, grammar), mapper),
                new GrammarSearchTool(of(GrammarContent.class, grammar), none(GrammarService.class), mapper),
                new LearnerProfileTool(mock(EchoLearnerBrain.class), mapper),
                new LessonSearchTool(jdbc, none(ListeningService.class), mapper),
                new MemoryTool(mock(EchoMemoryService.class), mock(EchoLearnerBrain.class), mapper),
                new OpenPageTool(dests, mapper),
                new PlanChangeTool(of(LearningPathService.class, lp), confirmations, mapper),
                new ProgressTool(none(UnifiedProgressService.class), of(LearningPathService.class, lp), none(LeaderboardBoardService.class), mapper),
                new TodayPlanTool(of(LearningPathService.class, lp), mapper),
                new VocabularyTool(of(FlashcardService.class, flashcardSvc), mapper),
                new WritingFeedbackTool(mock(WritingErrorMemoryRepository.class), mapper, mock(WritingAssessmentRepository.class), mock(WritingFeedbackIssueRepository.class)),
                new SpeakingScenarioTool(of(SpeakingScenarioService.class, scenarioSvc), mapper),
                new SpeakingScenarioTool.DrawSpeakingTopicTool(of(TopicService.class, topicSvc), mapper),
                new FlashcardActionTool(of(FlashcardService.class, flashcardSvc), mapper),
                new FlashcardActionTool.EnrollFlashcardDeckTool(of(FlashcardService.class, flashcardSvc), none(EchoLearnerBrain.class), mapper),
                new FlashcardActionTool.CreateFlashcardTool(of(FlashcardService.class, flashcardSvc), none(EchoLearnerBrain.class), mapper),
                new DnaPlanUpdateTool(of(LearningPathService.class, lp), confirmations, mapper)
        );

        EchoToolRegistry registry = new EchoToolRegistry(allTools, mapper, none(PlatformTransactionManager.class));
        assertThat(registry.names()).hasSize(18);

        // 1. LessonSearchTool C2 + mode=continue
        when(jdbc.query(contains("user_reading_progress"), any(RowMapper.class), eq(42L), eq(42L), eq("C2")))
                .thenReturn(List.of());
        EchoTurn turn = new EchoTurn(42L, false, true, "open my recent C2 reading", null, null);
        String contRes = registry.execute(turn, "search_lessons", "{\"module\":\"reading\",\"level\":\"C2\",\"mode\":\"continue\"}");
        assertThat(contRes).contains("\"mode\":\"continue\"");

        // 2. GrammarSearchTool lab & detective search
        String labRes = registry.execute(turn, "search_grammar_topics", "{\"query\":\"ball play\",\"kind\":\"lab\"}");
        assertThat(labRes).contains("after-school-ball", "grammar_lab_item");

        // 3. SpeakingScenarioTool + DrawSpeakingTopicTool (incl. ADR-2 §3.3.4 Round-0 auto-navigate on explicit open)
        when(scenarioSvc.getScenarios(eq(42L), any(), any())).thenReturn(List.of(
                new SpeakingScenarioSummaryDto(7L, "Airport Check-in", "Check in luggage", "B1", "TRAVEL", "Passenger", "Agent", 5, false, null)));
        EchoTurn openSpeakTurn = new EchoTurn(42L, false, true, "Open Speaking and prepare a suitable practice scenario.", null, null);
        String scenRes = registry.execute(openSpeakTurn, "search_speaking_scenarios", "{\"query\":\"airport\",\"level\":\"B1\"}");
        assertThat(scenRes).contains("Airport Check-in", "\"autoOpened\":true", "/speaking/roleplay/7");
        assertThat(openSpeakTurn.actions()).singleElement().satisfies(a -> {
            assertThat(a.href()).isEqualTo("/speaking/roleplay/7");
            assertThat(a.auto()).isTrue();
        });
        EchoTurn browseSpeakTurn = new EchoTurn(42L, false, true, "Find a speaking scenario for B1", null, null);
        String browseRes = registry.execute(browseSpeakTurn, "search_speaking_scenarios", "{\"query\":\"airport\",\"level\":\"B1\"}");
        assertThat(browseRes).contains("Airport Check-in").doesNotContain("\"autoOpened\":true");
        assertThat(browseSpeakTurn.actions()).isEmpty();
        verify(scenarioSvc, times(2)).getScenarios(eq(42L), any(), isNull());

        when(topicSvc.draw(eq(42L), any())).thenReturn(new TopicDtos.DrawResponse(
                "DRAWN", 101L,
                new TopicDtos.ItemView("Q-1", "QUICK", "travel", "Du lịch", "Travel", "B1", "INTERMEDIATE",
                        "Memorable Trips", List.of("Where did you travel last year?"), List.of(), null, null, null, null),
                20, 19));
        EchoTurn turn2 = new EchoTurn(42L, false, true, "draw a quick speaking topic", null, null);
        String drawRes = registry.execute(turn2, "draw_speaking_topic", "{\"style\":\"QUICK\",\"band\":\"INTERMEDIATE\"}");
        assertThat(drawRes).contains("Where did you travel last year?");

        // 4. FlashcardActionTool (search, enroll, create)
        VocabDeckSummaryResponse deck = VocabDeckSummaryResponse.builder()
                .id(88L).title("Oxford 3000 Core").category("OXFORD").totalWords(500).isEnrolled(false).build();
        when(flashcardSvc.getDecks(42L)).thenReturn(List.of(deck));
        when(flashcardSvc.enrollDeck(42L, 88L)).thenReturn(500);

        DictionaryEntry dictEntry = new DictionaryEntry();
        dictEntry.setWord("resilient");
        Flashcard createdCard = new Flashcard();
        createdCard.setDictionaryEntry(dictEntry);
        when(flashcardSvc.saveCustomFlashcard(eq(42L), eq("resilient"), anyString(), any(), any(), any(), any()))
                .thenReturn(new FlashcardService.SavedCard(createdCard, true));

        EchoTurn enrollTurn = new EchoTurn(42L, false, true, "Enroll me in the Oxford 3000 deck", null, null);
        EchoTurn saveCardTurn = new EchoTurn(42L, false, true, "Create a flashcard for resilient", null, null);
        assertThat(registry.execute(turn2, "search_flashcard_decks", "{\"query\":\"oxford\"}")).contains("Oxford 3000 Core");
        assertThat(registry.execute(enrollTurn, "enroll_flashcard_deck", "{\"deck_id\":88}")).contains("\"enrolled\":true");
        assertThat(registry.execute(saveCardTurn, "create_flashcard", "{\"front\":\"resilient\",\"back\":\"kiên cường\",\"cefr\":\"B2\"}"))
                .contains("\"created\":true", "resilient");
        // CaMeL indirect prompt-injection guard: unquoted neutral turn ("Summarize this passage") CANNOT mutate flashcards or enroll decks!
        EchoTurn neutralTurn = new EchoTurn(42L, false, true, "Summarize this passage for me", null, null);
        assertThat(registry.execute(neutralTurn, "enroll_flashcard_deck", "{\"deck_id\":88}")).contains("\"enrolled\":false", "not_authorized_by_learner");
        assertThat(registry.execute(neutralTurn, "create_flashcard", "{\"front\":\"resilient\",\"back\":\"kiên cường\"}"))
                .contains("\"saved\":false", "not_authorized_by_learner");

        // 5. DnaPlanUpdateTool + EchoConfirmations DnaProposalCommit apply & cancel
        when(lp.propose(42L)).thenReturn(new LearningPathDtos.ProposalView(
                303L, 1, Instant.now(), Instant.now().plusSeconds(600),
                List.of(new LearningPathDtos.ChangeView("SPEAKING", "UP", "pronunciation_focus")),
                new LearningPathDtos.DnaFacts(5, List.of("/θ/"), List.of("TENSE"), 2, true)));
        when(lp.apply(42L, 303L)).thenReturn(LearningPathDtos.TodayView.none());

        EchoTurn turn3 = new EchoTurn(42L, true, false, "Đề xuất cập nhật lộ trình bằng Learner DNA", null, null);
        JsonNode dnaJson = mapper.readTree(registry.execute(turn3, "prepare_dna_plan_update", "{}"));
        assertThat(dnaJson.path("prepared").asBoolean()).isTrue();
        assertThat(turn3.cards()).singleElement().satisfies(c -> assertThat(c.type()).isEqualTo("confirm"));
        String dnaToken = turn3.cards().get(0).token();

        // Foreign user cannot apply -> 404
        assertThatThrownBy(() -> confirmations.decide(99L, dnaToken, true)).hasMessageContaining("404");
        // Owner confirms -> calls LearningPathService.apply(42L, 303L) once
        assertThat(confirmations.decide(42L, dnaToken, true).status()).isEqualTo("APPLIED");
        verify(lp).apply(42L, 303L);
        // Replay fails -> 404
        assertThatThrownBy(() -> confirmations.decide(42L, dnaToken, true)).hasMessageContaining("404");

        // Cancel path calls LearningPathService.cancel(42L, 304L)
        String cancelToken = confirmations.issue(42L, new EchoConfirmations.DnaProposalCommit(304L));
        assertThat(confirmations.decide(42L, cancelToken, false).status()).isEqualTo("CANCELLED");
        verify(lp).cancel(42L, 304L);
    }
}
