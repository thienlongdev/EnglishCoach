package com.englishcoach.ai.echo;

import com.englishcoach.ai.dto.EchoPageContextDto;
import com.englishcoach.ai.echo.tools.*;
import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse.*;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.grammar.GrammarService;
import com.englishcoach.leaderboard.board.LeaderboardBoardService;
import com.englishcoach.learningpath.LearningExamPractice;
import com.englishcoach.learningpath.LearningPathService;
import com.englishcoach.listening.dto.ListeningLibraryItemDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.service.ListeningService;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.reading.dto.BilingualReadingCatalogResponse;
import com.englishcoach.reading.dto.BilingualReadingDetailResponse;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.BilingualReadingService;
import com.englishcoach.speaking.dto.SpeakingPronunciationMetricsDto;
import com.englishcoach.speaking.dto.SpeakingRecurringIssueDto;
import com.englishcoach.speaking.profile.SpeakingProfileAnalyticsService;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.*;
import com.englishcoach.speaking.service.SpeakingScenarioService;
import com.englishcoach.speaking.shadowing.ShadowingCatalogPageDto;
import com.englishcoach.speaking.shadowing.ShadowingMaterialCardDto;
import com.englishcoach.speaking.shadowing.SpeakingShadowingCatalogService;
import com.englishcoach.speaking.topic.TopicService;
import com.englishcoach.writing.entity.WritingErrorMemoryEntity;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Workstream B2 verification for all 21 safe-schema EchoTools, including {@link SpeakingProfileTool},
 * {@link ShadowingSearchTool}, {@link DictionaryLookupTool}, upgraded {@link LessonSearchTool} &
 * {@link WorkspaceControlTool}, and bug fixes {@code BUG-03A} & {@code BUG-08}.
 */
class EchoGroundedToolsTest {

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
    void allTwentyOneToolsPassSafeSchemaValidation() {
        GrammarContent grammar = new GrammarContent(mapper);
        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
        EchoConfirmations confirmations = new EchoConfirmations(none(LearningPathService.class));

        List<EchoTool> all21 = List.of(
                new ExamOverviewTool(none(com.englishcoach.exams.repository.ExamProfileRepository.class), none(LearningExamPractice.class), mapper,
                        mock(com.englishcoach.exams.repository.ExamAttemptRepository.class), mock(com.englishcoach.exams.service.ExamResultService.class)),
                new GrammarPracticeTool(of(GrammarContent.class, grammar), mapper),
                new GrammarSearchTool(of(GrammarContent.class, grammar), none(GrammarService.class), mapper),
                new LearnerProfileTool(mock(EchoLearnerBrain.class), mapper),
                new LessonSearchTool(mock(JdbcTemplate.class), none(ListeningService.class), mapper, none(BilingualReadingService.class)),
                new MemoryTool(mock(EchoMemoryService.class), mock(EchoLearnerBrain.class), mapper),
                new OpenPageTool(dests, mapper),
                new PlanChangeTool(none(LearningPathService.class), confirmations, mapper),
                new ProgressTool(none(UnifiedProgressService.class), none(LearningPathService.class), none(LeaderboardBoardService.class), mapper),
                new TodayPlanTool(none(LearningPathService.class), mapper),
                new VocabularyTool(none(FlashcardService.class), mapper),
                new WritingFeedbackTool(mock(WritingErrorMemoryRepository.class), mapper, mock(WritingAssessmentRepository.class), mock(WritingFeedbackIssueRepository.class)),
                new SpeakingScenarioTool(none(SpeakingScenarioService.class), mapper),
                new SpeakingScenarioTool.DrawSpeakingTopicTool(none(TopicService.class), mapper),
                new FlashcardActionTool(none(FlashcardService.class), mapper),
                new FlashcardActionTool.EnrollFlashcardDeckTool(none(FlashcardService.class), none(EchoLearnerBrain.class), mapper),
                new FlashcardActionTool.CreateFlashcardTool(none(FlashcardService.class), none(EchoLearnerBrain.class), mapper),
                new DnaPlanUpdateTool(none(LearningPathService.class), confirmations, mapper),
                new PrepareFlashcardsBatchTool(confirmations, none(ReadingMaterialRepository.class), none(BilingualReadingService.class), mapper),
                new WorkspaceControlTool(mapper),
                new SpeakingProfileTool(none(SpeakingProfileAnalyticsService.class), mapper),
                new ShadowingSearchTool(none(SpeakingShadowingCatalogService.class), none(EchoLearnerBrain.class), mapper),
                new DictionaryLookupTool(none(DictionaryEngine.class), mapper)
        );

        EchoToolRegistry registry = new EchoToolRegistry(all21, mapper, none(PlatformTransactionManager.class));
        assertThat(registry.openAiTools()).hasSize(23);
        assertThat(registry.names()).contains(
                "get_speaking_profile", "search_shadowing_lessons", "lookup_dictionary",
                "prepare_flashcards_batch", "emit_workspace_control");
    }

    @Test
    void speakingProfileToolComputesRealChronologicalTrendAndNeverFabricatesInsufficientData() throws Exception {
        SpeakingProfileAnalyticsService svc = mock(SpeakingProfileAnalyticsService.class);
        SpeakingProfileTool tool = new SpeakingProfileTool(of(SpeakingProfileAnalyticsService.class, svc), mapper);

        // 1. READY learner with real improving trend (71.5 -> 79.0 = +7.5 IMPROVING)
        when(svc.getOverview(42L)).thenReturn(SpeakingProfileOverviewDto.builder()
                .policyVersion("v2.2")
                .dataSufficiency(SpeakingDataSufficiencyDto.builder()
                        .hasAnyPractice(true).strengthsStatus("READY").focusStatus("READY").trendStatus("READY").build())
                .recentWindow(SpeakingWindowActivityDto.builder()
                        .practiceDays7d(4).practiceDays30d(11).currentStreakDays(3).sessionsCompleted30d(9)
                        .averagePronunciationScore30d(76.4).averageContentMatchScore30d(88.2).build())
                .scoreTrend(List.of(
                        SpeakingScoreTrendPointDto.builder().sessionId(1L).pronunciationScore(71.5).attemptCount(6).build(),
                        SpeakingScoreTrendPointDto.builder().sessionId(2L).pronunciationScore(79.0).attemptCount(8).build()))
                .build());

        SpeakingPronunciationMetricsDto metrics = SpeakingPronunciationMetricsDto.builder()
                .averagePronunciationScore(76.4)
                .averagePhonemeScore(78.2)
                .averageStressScore(74.0)
                .averageFluencyScore(80.5)
                .lexicalStressMatchedWords(41L)
                .lexicalStressAssessedWords(50L)
                .scoredAttemptsCount(24L)
                .build();
        when(svc.getPronunciation(42L)).thenReturn(SpeakingProfilePronunciationDto.builder()
                .sufficiencyStatus("READY")
                .metrics(metrics)
                .recurringIssues(List.of(SpeakingRecurringIssueDto.builder()
                        .title("Dental fricative /θ/").category("PRONUNCIATION").targetPhone("/θ/").targetWord("think")
                        .status("IMPROVING").distinctSessionsObserved(3).build()))
                .strongPatterns(List.of(SpeakingStrongPhonemePatternDto.builder()
                        .phone("r").ipaDisplay("/ɹ/").acceptableRate(0.94).averageQualityScore(89.2).observationsCount(30).build()))
                .build());

        EchoTurn readyTurn = new EchoTurn(42L, false, true, "Is my pronunciation improving?", null, null);
        JsonNode readyJson = mapper.readTree(tool.run(readyTurn, mapper.readTree("{\"section\":\"both\"}")));
        assertThat(readyJson.path("sufficiencyStatus").asText()).isEqualTo("READY");
        assertThat(readyJson.path("lexicalStressMatchedWords").asLong()).isEqualTo(41L);
        assertThat(readyJson.path("lexicalStressAssessedWords").asLong()).isEqualTo(50L);
        assertThat(readyJson.path("scoreTrend").path("direction").asText()).isEqualTo("IMPROVING");
        assertThat(readyJson.path("scoreTrend").path("delta").asDouble()).isEqualTo(7.5);
        assertThat(readyTurn.cards()).singleElement().satisfies(c -> assertThat(c.type()).isEqualTo("stats"));
        assertThat(readyTurn.provenance().isResourceHrefAuthorized("/speaking?view=profile&sub=pronunciation")).isTrue();

        // 2. INSUFFICIENT_DATA learner -> zero fabricated numbers or trend direction
        when(svc.getOverview(99L)).thenReturn(SpeakingProfileOverviewDto.builder()
                .dataSufficiency(SpeakingDataSufficiencyDto.builder()
                        .hasAnyPractice(false).strengthsStatus("INSUFFICIENT_DATA").focusStatus("INSUFFICIENT_DATA").trendStatus("INSUFFICIENT_DATA").build())
                .scoreTrend(List.of())
                .build());
        when(svc.getPronunciation(99L)).thenReturn(SpeakingProfilePronunciationDto.builder()
                .sufficiencyStatus("INSUFFICIENT_DATA")
                .build());

        EchoTurn emptyTurn = new EchoTurn(99L, false, true, "Is my pronunciation improving?", null, null);
        JsonNode emptyJson = mapper.readTree(tool.run(emptyTurn, mapper.readTree("{\"section\":\"both\"}")));
        assertThat(emptyJson.path("sufficiencyStatus").asText()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(emptyJson.path("scoreTrend").path("status").asText()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(emptyJson.path("scoreTrend").has("direction")).isFalse();
        assertThat(emptyJson.path("scoreTrend").path("note").asText()).contains("Insufficient scored sessions");
    }

    @Test
    void shadowingSearchAndDictionaryLookupAndUpgradedLessonAndWorkspaceToolsOperateGrounded() throws Exception {
        // 1. ShadowingSearchTool: defaults to verified CEFR B1, widens once if specific query misses, and auto-opens on open directive
        SpeakingShadowingCatalogService shadowSvc = mock(SpeakingShadowingCatalogService.class);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        when(brain.snapshot(42L, false, false)).thenReturn(new EchoLearnerBrain.Snapshot("{}", "B1", "VERIFIED"));
        when(shadowSvc.getCatalog(42L, 0, 5, "B1", null, "ALL", "quantum"))
                .thenReturn(new ShadowingCatalogPageDto(List.of(), 0, 5, 0, 0, false, false));
        when(shadowSvc.getCatalog(42L, 0, 5, "B1", null, "ALL", null))
                .thenReturn(new ShadowingCatalogPageDto(List.of(
                        new ShadowingMaterialCardDto(312L, "BBC Daily Commute", "Daily Life", "BBC", null, null, 180, "B1", "uk", true, "YOUTUBE")),
                        0, 5, 1, 1, false, false));

        ShadowingSearchTool shadowTool = new ShadowingSearchTool(
                of(SpeakingShadowingCatalogService.class, shadowSvc), of(EchoLearnerBrain.class, brain), mapper);
        EchoTurn openShadowTurn = new EchoTurn(42L, false, true, "Find and open a suitable shadowing exercise for my level", null, null);
        JsonNode shadowOut = mapper.readTree(shadowTool.run(openShadowTurn, mapper.readTree("{\"query\":\"quantum\"}")));
        assertThat(shadowOut.path("widenedSearch").asBoolean()).isTrue();
        assertThat(shadowOut.path("opened").asBoolean()).isTrue();
        assertThat(openShadowTurn.actions()).singleElement().satisfies(a -> {
            assertThat(a.href()).isEqualTo("/speaking/shadowing/312");
            assertThat(a.auto()).isTrue();
        });

        // 2. DictionaryLookupTool: 0 LLM calls, authoritative IPA + EN/VI senses + collocations + idioms
        DictionaryEngine dictEngine = mock(DictionaryEngine.class);
        when(dictEngine.lookup("resilient", "en-en")).thenReturn(CanonicalDictionaryResponse.builder()
                .headword("resilient").entryType("WORD").cefr("B2").generalTranslationVi("kiên cường, bền bỉ")
                .pronunciations(List.of(PronunciationDto.builder().ipa("/rɪˈzɪliənt/").region("US").build()))
                .partsOfSpeech(List.of(PartOfSpeechGroupDto.builder().partOfSpeech("adjective")
                        .senses(List.of(SenseDto.builder().definitionEn("able to recover quickly after difficulty")
                                .translationVi("có khả năng phục hồi nhanh").examples(List.of("Children are remarkably resilient.")).build()))
                        .build()))
                .vietnameseSenses(List.of(VietnameseSenseGroupDto.builder().partOfSpeech("tính từ").meanings(List.of("kiên cường", "đàn hồi")).build()))
                .collocations(List.of(CollocationDto.builder().phrase("highly resilient").translationVi("rất kiên cường").build()))
                .idioms(List.of(IdiomDto.builder().phrase("bounce back resilient").shortMeaning("recover fast").build()))
                .build());

        DictionaryLookupTool dictTool = new DictionaryLookupTool(of(DictionaryEngine.class, dictEngine), mapper);
        EchoTurn dictTurn = new EchoTurn(42L, false, true, "What does resilient mean?", null, null);
        JsonNode dictJson = mapper.readTree(dictTool.run(dictTurn, mapper.readTree("{\"word\":\"resilient\"}")));
        assertThat(dictJson.path("found").asBoolean()).isTrue();
        assertThat(dictJson.path("cefr").asText()).isEqualTo("B2");
        assertThat(dictJson.path("pronunciations").get(0).path("ipa").asText()).isEqualTo("/rɪˈzɪliənt/");
        assertThat(dictJson.path("senses").get(0).path("definitionEn").asText()).contains("recover quickly");
        assertThat(dictJson.path("vietnameseSenses")).isNotEmpty();
        assertThat(dictJson.path("collocations")).isNotEmpty();
        assertThat(dictJson.path("idioms")).isNotEmpty();

        // 3. LessonSearchTool: bilingual catalog + personal & shared listening deduplication
        ListeningService listeningSvc = mock(ListeningService.class);
        when(listeningSvc.getPersonalMaterials("B1", "travel", null, 42L)).thenReturn(List.of(
                ListeningMaterialSummaryDto.builder().id(10L).title("My Airport Audio").cefrLevel("B1").topic("Travel").durationSeconds(120).build()));
        when(listeningSvc.getSharedLibrary()).thenReturn(List.of(
                ListeningLibraryItemDto.builder().id(10L).title("Duplicate ID").level("B1").topic("Travel").durationSeconds(120).build(),
                ListeningLibraryItemDto.builder().id(20L).title("Shared Train Journey").level("B1").topic("Travel").durationSeconds(240).build()));

        BilingualReadingService biSvc = mock(BilingualReadingService.class);
        when(biSvc.catalog(null)).thenReturn(new BilingualReadingCatalogResponse("rev1", 2, 1, 1, List.of(
                new BilingualReadingCatalogResponse.Card(5L, "STORY", "The Lantern Shop", "Tiệm Đèn Lồng", "B1", 420, 4),
                new BilingualReadingCatalogResponse.Card(6L, "ARTICLE", "River Bridges", "Những Cây Cầu", "B1", 310, 3))));

        LessonSearchTool lessonTool = new LessonSearchTool(
                mock(JdbcTemplate.class), of(ListeningService.class, listeningSvc), mapper, of(BilingualReadingService.class, biSvc));
        EchoTurn searchTurn = new EchoTurn(42L, true, false, "Tìm bài đọc song ngữ B1", null, null);
        JsonNode biJson = mapper.readTree(lessonTool.run(searchTurn, mapper.readTree("{\"module\":\"bilingual\",\"level\":\"B1\"}")));
        assertThat(biJson.path("lessons")).hasSize(2);
        assertThat(biJson.path("lessons").get(0).path("title").asText()).isEqualTo("Tiệm Đèn Lồng");
        // All bilingual card rows stay clickable in EchoCards while multi-item shared hub href is NOT single-item authorized
        assertThat(searchTurn.cards().get(0).items().get(0).href()).isEqualTo("/reading?section=bilingual");
        assertThat(searchTurn.cards().get(0).items().get(1).href()).isEqualTo("/reading?section=bilingual");
        assertThat(searchTurn.provenance().isResourceHrefAuthorized("/reading?section=bilingual")).isFalse();

        JsonNode listJson = mapper.readTree(lessonTool.run(searchTurn, mapper.readTree("{\"module\":\"listening\",\"level\":\"B1\",\"topic\":\"travel\"}")));
        assertThat(listJson.path("lessons")).hasSize(2);

        // 4. WorkspaceControlTool new controls + world_display strictly restricted to {odyssey, cosmos}
        WorkspaceControlTool wsTool = new WorkspaceControlTool(mapper);
        EchoTurn uiTurn = new EchoTurn(42L, false, true, "Brighten background, switch to vertical navigation, and scroll down", null, null);
        assertThat(wsTool.run(uiTurn, mapper.readTree("{\"control\":\"adjust_bg_brightness\",\"delta\":1}"))).contains("\"dispatched\":true");
        assertThat(wsTool.run(uiTurn, mapper.readTree("{\"control\":\"nav_layout\",\"mode\":\"vertical\"}"))).contains("\"dispatched\":true");
        assertThat(wsTool.run(uiTurn, mapper.readTree("{\"control\":\"scroll\",\"mode\":\"down\"}"))).contains("\"dispatched\":true");
        assertThat(wsTool.run(uiTurn, mapper.readTree("{\"control\":\"open_appearance_studio\",\"room\":\"worlds\"}"))).contains("\"dispatched\":true");
        assertThat(wsTool.run(uiTurn, mapper.readTree("{\"control\":\"world_display\",\"target\":\"studyspace\",\"mode\":\"fullscreen\"}")))
                .contains("\"dispatched\":false", "invalid_control_parameters");
        assertThat(uiTurn.actions()).hasSize(4);
    }

    @Test
    void fixesBug03aBilingualAndShadowingPageContextAndBug08SuggestionRoutes() throws Exception {
        // Jakarta @Valid check on SHADOWING_LESSON & BILINGUAL_READING
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            Validator validator = factory.getValidator();
            assertThat(validator.validate(new EchoPageContextDto("SHADOWING_LESSON", null, 12L, null, null, "speaking", null))).isEmpty();
            assertThat(validator.validate(new EchoPageContextDto("BILINGUAL_READING", null, 5L, null, null, "reading", null))).isEmpty();
        }

        // BUG-03A: BilingualReadingService.detail() resolves passageExcerpt and grounds PrepareFlashcardsBatchTool
        BilingualReadingService biSvc = mock(BilingualReadingService.class);
        when(biSvc.detail(5L)).thenReturn(new BilingualReadingDetailResponse(
                5L, "ARTICLE", "Urban Gardens", "Vườn Đô Thị", "B1", 180, 3,
                List.of(
                        new BilingualReadingDetailResponse.Segment(0, "Rooftop agriculture transforms concrete skylines into sustainable ecosystems.", "Nông nghiệp sân thượng biến đường chân trời bê tông thành hệ sinh thái bền vững.", null),
                        new BilingualReadingDetailResponse.Segment(1, "Neighbours cultivate herbs together.", "Hàng xóm cùng nhau trồng thảo mộc.", null))));

        ListeningMaterialRepository listeningRepo = mock(ListeningMaterialRepository.class);
        ListeningMaterial audioMat = new ListeningMaterial();
        audioMat.setTitle("TED Shadowing Clip");
        audioMat.setCefrLevel("B2");
        audioMat.setSourceType("YOUTUBE");
        audioMat.setAccent("us");
        when(listeningRepo.findByIdAndVisibleToUser(12L, 42L)).thenReturn(Optional.of(audioMat));

        ListeningMaterial docMat = new ListeningMaterial();
        docMat.setTitle("Uploaded PDF");
        docMat.setSourceType("DOCUMENT");
        when(listeningRepo.findByIdAndVisibleToUser(13L, 42L)).thenReturn(Optional.of(docMat));

        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), of(ListeningMaterialRepository.class, listeningRepo));
        EchoPageContextResolver resolver = new EchoPageContextResolver(
                mapper, none(GrammarContent.class), none(ReadingMaterialRepository.class),
                of(ListeningMaterialRepository.class, listeningRepo), null, none(PlatformTransactionManager.class),
                dests, of(BilingualReadingService.class, biSvc));

        EchoPageContextDto biPage = new EchoPageContextDto("BILINGUAL_READING", null, 5L, null, null, "/reading?section=bilingual", "sustainable ecosystems");
        String biResolved = resolver.resolve(42L, biPage, true, true);
        assertThat(biResolved).contains("\"available\":true", "Vườn Đô Thị", "sustainable ecosystems");

        EchoPageContextDto shadowPage = new EchoPageContextDto("SHADOWING_LESSON", null, 12L, null, null, "/speaking/shadowing/12", null);
        assertThat(resolver.resolve(42L, shadowPage, true, false)).contains("\"available\":true", "TED Shadowing Clip", "\"accent\":\"us\"");

        EchoPageContextDto docShadowPage = new EchoPageContextDto("SHADOWING_LESSON", null, 13L, null, null, "/speaking/shadowing/13", null);
        assertThat(resolver.resolve(42L, docShadowPage, true, false)).contains("\"available\":false");

        EchoConfirmations confirmations = new EchoConfirmations(none(LearningPathService.class));
        PrepareFlashcardsBatchTool prepBatch = new PrepareFlashcardsBatchTool(
                confirmations, none(ReadingMaterialRepository.class), of(BilingualReadingService.class, biSvc), mapper);
        EchoTurn biCardTurn = new EchoTurn(42L, true, false, "Tạo thẻ từ vựng từ bài đọc này", biPage, null);
        String prepOut = prepBatch.run(biCardTurn, mapper.readTree(
                "{\"cards\":[{\"front\":\"sustainable\",\"back\":\"bền vững\",\"cefr\":\"B2\"},{\"front\":\"ungroundedxyz\",\"back\":\"ảo\"}]}"));
        assertThat(prepOut).contains("\"prepared\":true", "\"count\":1");

        // BUG-08: WRITING_SENTENCE_LAB canonicalized to /writing?w=sentence-lab, legacy view=sentence-lab + bare /learning-path allowed,
        // and EchoSuggestionService writing-review points to /writing?w=sentence-lab&lab=mistakes
        assertThat(EchoDestinations.Dest.WRITING_SENTENCE_LAB.pattern()).isEqualTo("/writing?w=sentence-lab");
        assertThat(EchoDestinations.isAllowedHref("/writing?w=sentence-lab")).isTrue();
        assertThat(EchoDestinations.isAllowedHref("/writing?view=sentence-lab")).isTrue();
        assertThat(EchoDestinations.isAllowedHref("/learning-path")).isTrue();

        WritingErrorMemoryRepository writingErrors = mock(WritingErrorMemoryRepository.class);
        WritingErrorMemoryEntity err = new WritingErrorMemoryEntity();
        err.setHasSufficientEvidence(true);
        err.setDueForPractice(true);
        when(writingErrors.findTop3ByUserIdAndIsMutedFalseOrderByLastSeenAtDesc(42L)).thenReturn(List.of(err));

        EchoSuggestionService suggestionSvc = new EchoSuggestionService(
                none(FlashcardService.class), none(GrammarService.class), none(LearningPathService.class),
                dests, writingErrors);
        var suggestions = suggestionSvc.suggestions(42L, true);
        assertThat(suggestions).anySatisfy(s -> {
            assertThat(s.key()).isEqualTo("writing-review");
            assertThat(s.href()).isEqualTo("/writing?w=sentence-lab&lab=mistakes");
        });
    }
}
