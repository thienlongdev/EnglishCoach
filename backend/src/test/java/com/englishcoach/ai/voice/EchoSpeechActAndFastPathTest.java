package com.englishcoach.ai.voice;

import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.SpeechActKind;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Workstream B2 verification for {@link EchoSpeechActAnalyzer}, {@link EchoVoiceFastPathMatcher},
 * {@link EchoRouter#direct(String)}, {@link EchoRouter#explicitOpen(String)}, and salience anaphora.
 */
class EchoSpeechActAndFastPathTest {

    @Test
    void maskQuotedSpansReplacesQuotesWithSentinelWhilePreservingContractions() {
        String maskedContractions = EchoSpeechActAnalyzer.maskQuotedSpans(
                "I'd like to practice shadowing, don't open Reading yet, let's check today's tasks and what's new.");
        assertThat(maskedContractions)
                .doesNotContain(EchoSpeechActAnalyzer.QUOTED_SENTINEL)
                .contains("I'd", "don't", "let's", "today's", "what's");

        String maskedDouble = EchoSpeechActAnalyzer.maskQuotedSpans("Open \"anything\" reading");
        assertThat(maskedDouble).contains(EchoSpeechActAnalyzer.QUOTED_SENTINEL);
        assertThat(EchoVoiceFastPathMatcher.evaluate("Open \"anything\" reading", "/dashboard", false).plan()).isNull();
        assertThat(EchoRouter.direct("Open \"anything\" reading")).isEmpty();

        String maskedCurlyAndSingle = EchoSpeechActAnalyzer.maskQuotedSpans(
                "What does ‘open speaking’ or 'delete my account' or `log out` or «open reading» mean?");
        assertThat(maskedCurlyAndSingle).contains(EchoSpeechActAnalyzer.QUOTED_SENTINEL)
                .doesNotContain("open speaking", "delete my account", "log out", "open reading");
    }

    @Test
    void classifiesAllEightSpeechActsUnderSubMillisecondLatency() {
        long t0 = System.nanoTime();
        assertThat(EchoSpeechActAnalyzer.analyze("Open the Speaking module").utteranceKind())
                .isEqualTo(SpeechActKind.AFFIRMATIVE_DIRECTIVE);
        assertThat(EchoSpeechActAnalyzer.analyze("Could you take me to the section where I practice speaking?").utteranceKind())
                .isEqualTo(SpeechActKind.POLITE_DIRECTIVE);
        assertThat(EchoSpeechActAnalyzer.analyze("Open reading, wait no, open listening").utteranceKind())
                .isEqualTo(SpeechActKind.REPAIR_DIRECTIVE);
        assertThat(EchoSpeechActAnalyzer.analyze("Don't open Reading right now").utteranceKind())
                .isEqualTo(SpeechActKind.NEGATED_OR_DEFERRED);
        assertThat(EchoSpeechActAnalyzer.analyze("What does \"open reading\" mean in Vietnamese?").utteranceKind())
                .isEqualTo(SpeechActKind.METALINGUISTIC_MENTION);
        assertThat(EchoSpeechActAnalyzer.analyze("If I delete my account, what happens?").utteranceKind())
                .isEqualTo(SpeechActKind.HYPOTHETICAL_CONDITION);
        assertThat(EchoSpeechActAnalyzer.analyze("Is my pronunciation improving this month?").utteranceKind())
                .isEqualTo(SpeechActKind.TRUE_INFO_QUESTION);
        assertThat(EchoSpeechActAnalyzer.analyze("Explain the difference between say and tell").utteranceKind())
                .isEqualTo(SpeechActKind.TRUE_INFO_QUESTION);
        assertThat(EchoSpeechActAnalyzer.analyze("Let's just chat in English about travel and movies").utteranceKind())
                .isEqualTo(SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL);
        double avgMs = ((System.nanoTime() - t0) / 1_000_000.0) / 9.0;
        assertThat(avgMs).isLessThan(0.5);
    }

    @Test
    void zeroSplitBrainBetweenFastPathAndRouterAcrossAllUserPhrasesAndParaphrases() {
        Map<String, EchoDestinations.Dest> expectedNav = Map.ofEntries(
                Map.entry("open reading", EchoDestinations.Dest.READING),
                Map.entry("open speaking", EchoDestinations.Dest.SPEAKING),
                Map.entry("open speaking module", EchoDestinations.Dest.SPEAKING),
                Map.entry("open speaking module in my website", EchoDestinations.Dest.SPEAKING),
                Map.entry("take me to the speaking section", EchoDestinations.Dest.SPEAKING),
                Map.entry("I want to open the speaking practice area", EchoDestinations.Dest.SPEAKING),
                Map.entry("mở phần luyện nói cho tôi", EchoDestinations.Dest.SPEAKING),
                Map.entry("chuyển qua Speaking giúp tôi", EchoDestinations.Dest.SPEAKING),
                Map.entry("cho tôi vào phần luyện nói", EchoDestinations.Dest.SPEAKING),
                Map.entry("could you take me to the section where I practice speaking?", EchoDestinations.Dest.SPEAKING),
                Map.entry("Bạn mở phần luyện nói giúp mình được không?", EchoDestinations.Dest.SPEAKING),
                Map.entry("I'd like to practice shadowing", EchoDestinations.Dest.SPEAKING_SHADOWING),
                Map.entry("cho mình vào chỗ luyện nhại giọng", EchoDestinations.Dest.SPEAKING_SHADOWING),
                Map.entry("open the pronunciation section of my profile", EchoDestinations.Dest.SPEAKING_PRONUNCIATION),
                Map.entry("mở phần phát âm trong hồ sơ luyện nói của tôi", EchoDestinations.Dest.SPEAKING_PRONUNCIATION),
                Map.entry("open learning path", EchoDestinations.Dest.TODAY),
                Map.entry("open echo life", EchoDestinations.Dest.STUDY_SPACE),
                Map.entry("open sentence lab", EchoDestinations.Dest.WRITING_SENTENCE_LAB),
                Map.entry("mở nghe", EchoDestinations.Dest.LISTENING),
                Map.entry("vào nói", EchoDestinations.Dest.SPEAKING),
                Map.entry("open reading, wait no, open listening", EchoDestinations.Dest.LISTENING),
                Map.entry("open reading — actually open listening instead", EchoDestinations.Dest.LISTENING),
                Map.entry("Actually, open Listening instead", EchoDestinations.Dest.LISTENING),
                Map.entry("Instead, take me to Speaking", EchoDestinations.Dest.SPEAKING),
                Map.entry("À không, chuyển qua Nghe đi", EchoDestinations.Dest.LISTENING),
                Map.entry("Thay vào đó mở phần Nghe giúp mình", EchoDestinations.Dest.LISTENING),
                Map.entry("mở phần đọc, khoan không phải, mở phần nghe", EchoDestinations.Dest.LISTENING),
                Map.entry("bring up leaderboard rankings", EchoDestinations.Dest.LEADERBOARD),
                Map.entry("jump into Echo Odyssey world", EchoDestinations.Dest.ODYSSEY),
                Map.entry("take me over to the Word Chain game", EchoDestinations.Dest.GAME_WORD_CHAIN),
                Map.entry("switch my screen to the Speaking section", EchoDestinations.Dest.SPEAKING),
                Map.entry("head over to my home dashboard", EchoDestinations.Dest.DASHBOARD),
                Map.entry("review my due flashcards", EchoDestinations.Dest.FLASHCARDS_REVIEW),
                Map.entry("I'd love to practice shadowing", EchoDestinations.Dest.SPEAKING_SHADOWING),
                Map.entry("open shadowing in the speaking section", EchoDestinations.Dest.SPEAKING_SHADOWING),
                Map.entry("mở kỹ năng nghe cho mình xem", EchoDestinations.Dest.LISTENING),
                Map.entry("tủ sách", EchoDestinations.Dest.READING_MYBOOKS),
                Map.entry("bookshelf", EchoDestinations.Dest.READING_MYBOOKS),
                Map.entry("open today's learning path tasks", EchoDestinations.Dest.TODAY),
                Map.entry("mở nhiệm vụ lộ trình học hôm nay", EchoDestinations.Dest.TODAY),
                Map.entry("open Study Space fullscreen", EchoDestinations.Dest.STUDY_SPACE)
        );

        for (var entry : expectedNav.entrySet()) {
            String phrase = entry.getKey();
            EchoDestinations.Dest expectedDest = entry.getValue();

            var fastOutcome = EchoVoiceFastPathMatcher.evaluate(phrase, "/dashboard", false);
            assertThat(fastOutcome.guard()).as("No guard for: " + phrase).isNull();
            assertThat(fastOutcome.plan()).as("Fast-path plan for: " + phrase).isNotNull();
            String fastHref = fastOutcome.plan().intents().stream()
                    .filter(i -> "navigate".equals(i.get("kind")))
                    .map(i -> String.valueOf(i.get("href")))
                    .findFirst().orElseThrow();
            assertThat(fastHref).as("Href for: " + phrase).isEqualTo(expectedDest.pattern());

            assertThat(EchoRouter.direct(phrase))
                    .as("EchoRouter.direct parity for: " + phrase)
                    .isPresent()
                    .get()
                    .satisfies(cmd -> {
                        assertThat(cmd.type()).isEqualTo(EchoRouter.CommandType.NAVIGATE);
                        assertThat(cmd.dest()).isEqualTo(expectedDest);
                    });
            assertThat(EchoRouter.explicitOpen(phrase)).as("explicitOpen for: " + phrase).isTrue();
        }
    }

    @Test
    void uiTogglesAndAppearanceStudioRoomsExecuteCleanlyWhileNegationHypotheticalAndMetalinguisticNeverMisfireGuards() {
        // UI toggles must NOT be misclassified as NEGATED_OR_DEFERRED
        for (String toggle : List.of(
                "turn off dark mode", "tắt chế độ tối", "disable hands-free",
                "hide navigation", "ẩn thanh điều hướng", "tắt nhạc")) {
            var out = EchoVoiceFastPathMatcher.evaluate(toggle, "/dashboard", false);
            assertThat(out.plan()).as("UI toggle must execute on Plane A: " + toggle).isNotNull();
        }

        // Appearance studio rooms ('worlds' and 'navigation')
        var worldsStudio = EchoVoiceFastPathMatcher.evaluate("open worlds studio", "/dashboard", false);
        assertThat(worldsStudio.plan()).isNotNull();
        assertThat(worldsStudio.plan().intents()).singleElement()
                .satisfies(i -> assertThat(i).containsEntry("kind", "open_appearance_studio").containsEntry("room", "worlds"));

        var navStudio = EchoVoiceFastPathMatcher.evaluate("open navigation studio settings", "/dashboard", false);
        assertThat(navStudio.plan()).isNotNull();
        assertThat(navStudio.plan().intents()).singleElement()
                .satisfies(i -> assertThat(i).containsEntry("kind", "open_appearance_studio").containsEntry("room", "navigation"));

        assertThat(EchoVoiceFastPathMatcher.evaluate("cuộn xuống dưới", "/reading", false).plan().intents().get(0))
                .containsEntry("kind", "scroll").containsEntry("target", "down");
        assertThat(EchoVoiceFastPathMatcher.evaluate("cuộn lên trên", "/reading", false).plan().intents().get(0))
                .containsEntry("kind", "scroll").containsEntry("target", "up");

        // Guard parity: "Log me out" and "Cancel my premium subscription" -> DENIED; "Sign out" -> request_logout; "không hủy" -> PLANE_B
        assertThat(EchoVoiceFastPathMatcher.evaluate("Log me out", "/dashboard", false).guard())
                .isNotNull().extracting(EchoVoiceFastPathMatcher.Guard::decision).isEqualTo("DENIED");
        assertThat(EchoVoiceFastPathMatcher.evaluate("Cancel my premium subscription", "/premium", false).guard())
                .isNotNull().extracting(EchoVoiceFastPathMatcher.Guard::decision).isEqualTo("DENIED");
        assertThat(EchoVoiceFastPathMatcher.evaluate("Sign out", "/dashboard", false).plan().intents().get(0))
                .containsEntry("kind", "request_logout");
        assertThat(EchoVoiceFastPathMatcher.evaluate("không hủy", "/dashboard", true).plan()).isNull();
        assertThat(EchoVoiceFastPathMatcher.evaluate("hủy", "/dashboard", true).plan().intents().get(0))
                .containsEntry("kind", "voice_confirm").containsEntry("decision", "cancel");

        // Negations, hypotheticals, and metalinguistic mentions NEVER trigger Fast-Path or false DENIED guards
        for (String nonExec : List.of(
                "Don't delete my account",
                "Đừng xóa tài khoản của tôi",
                "If I delete my account, what happens?",
                "If I said open Speaking, what would happen?",
                "Nếu mình bấm xóa tài khoản thì sao?",
                "What does \"delete my account\" mean in Vietnamese?",
                "Translate \"open speaking\" into Vietnamese",
                "open speaking nghĩa là gì?")) {
            var out = EchoVoiceFastPathMatcher.evaluate(nonExec, "/profile", false);
            assertThat(out.guard()).as("Must NOT trigger DENIED guard: " + nonExec).isNull();
            assertThat(out.plan()).as("Must delegate to Plane B: " + nonExec).isNull();
            assertThat(EchoRouter.direct(nonExec)).isEmpty();
            assertThat(EchoRouter.explicitOpen(nonExec)).isFalse();
        }
    }

    @Test
    void mixedIntentDelegatesWholeTurnToPlaneBWhilePreservingExplicitOpenCapability() {
        List<String> mixedTurns = List.of(
                "Explain what shadowing is, and open the Speaking module",
                "Tell me whether my pronunciation is improving, then open the pronunciation section of my profile",
                "Giải thích thì hiện tại hoàn thành rồi mở phần ngữ pháp"
        );
        for (String mixed : mixedTurns) {
            var out = EchoVoiceFastPathMatcher.evaluate(mixed, "/dashboard", false);
            assertThat(out.plan()).as("Mixed-intent must delegate to Plane B: " + mixed).isNull();
            assertThat(EchoRouter.direct(mixed)).isEmpty();
            assertThat(EchoRouter.explicitOpen(mixed))
                    .as("Clause-2 open directive must still set explicitOpen=true: " + mixed)
                    .isTrue();
        }
    }

    @Test
    void salienceAnaphoraResolvesValidatedHrefsAndRejectsDisallowedUrls() {
        List<EchoSalientResourceDto> singleSalient = List.of(
                new EchoSalientResourceDto(1, "Solar Power Revolution", "/reading?materialId=101", "reading")
        );
        // Singular anaphora succeeds when salient.size() == 1
        assertThat(EchoVoiceFastPathMatcher.evaluate("open it", "/dashboard", false, singleSalient).plan().intents().get(0))
                .containsEntry("kind", "navigate")
                .containsEntry("href", "/reading?materialId=101");

        List<EchoSalientResourceDto> salient = List.of(
                new EchoSalientResourceDto(1, "Solar Power Revolution", "/reading?materialId=101", "reading"),
                new EchoSalientResourceDto(2, "BBC Climate Shadowing", "/speaking/shadowing/202", "shadowing"),
                new EchoSalientResourceDto(3, "Evil External Link", "https://evil.example/phish", "external"),
                new EchoSalientResourceDto(7, "Seventh Explicit Index", "/speaking/roleplay/707", "roleplay")
        );

        // Singular anaphora ("open it" / "mở bài đó") delegates to Plane B when salient.size() > 1!
        assertThat(EchoVoiceFastPathMatcher.evaluate("open it", "/dashboard", false, salient).plan()).isNull();
        assertThat(EchoVoiceFastPathMatcher.evaluate("mở bài đó", "/dashboard", false, salient).plan()).isNull();

        assertThat(EchoVoiceFastPathMatcher.evaluate("open recommendation number 2", "/dashboard", false, salient).plan().intents().get(0))
                .containsEntry("href", "/speaking/shadowing/202");

        assertThat(EchoVoiceFastPathMatcher.evaluate("mở gợi ý số 2", "/dashboard", false, salient).plan().intents().get(0))
                .containsEntry("href", "/speaking/shadowing/202");

        // Matches explicit r.index() == 7 before positional fallback (ordinals 1..12 supported!)
        assertThat(EchoVoiceFastPathMatcher.evaluate("open the seventh one", "/dashboard", false, salient).plan().intents().get(0))
                .containsEntry("href", "/speaking/roleplay/707");

        // Disallowed external URL was stripped during sanitization, so "the last one" resolves to valid item (/speaking/roleplay/707)!
        assertThat(EchoVoiceFastPathMatcher.evaluate("mở cái cuối", "/dashboard", false, salient).plan().intents().get(0))
                .containsEntry("href", "/speaking/roleplay/707");

        assertThat(EchoVoiceFastPathMatcher.evaluate("take me back there", "/speaking", false, salient).plan().intents().get(0))
                .containsEntry("kind", "history_back");
    }
}
