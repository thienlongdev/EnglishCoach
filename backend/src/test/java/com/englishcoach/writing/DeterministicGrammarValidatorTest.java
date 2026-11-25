package com.englishcoach.writing;

import com.englishcoach.writing.dto.FeedbackIssueDto;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.service.DeterministicGrammarValidator;
import com.englishcoach.writing.service.LanguageToolGrammarService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("Deterministic Grammar Validator & Hybrid GEC Reconciliation Tests")
class DeterministicGrammarValidatorTest {

    static {
        System.setProperty("jdk.xml.totalEntitySizeLimit", "0");
    }

    private LanguageToolGrammarService languageToolGrammarService;
    private DeterministicGrammarValidator validator;

    @BeforeEach
    void setUp() {
        languageToolGrammarService = new LanguageToolGrammarService();
        languageToolGrammarService.init();
        validator = new DeterministicGrammarValidator(languageToolGrammarService);
    }

    @Test
    @DisplayName("Class: Correct sentence with zero grammatical errors")
    void testCorrectSentence() {
        String sentence = "The comprehensive analysis yielded reliable conclusions.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), true);

        assertTrue(result.isGrammaticallyCorrect(), "Correct sentence must be deemed grammatically correct");
        assertFalse(result.hasConfirmedGrammarError(), "Must not detect any confirmed grammar errors");
    }

    @Test
    void testLinguisticAnalysis() throws Exception {
        var lt = languageToolGrammarService.getLanguageTool();
        var sent = lt.getAnalyzedSentence("He gave the children many books.");
        for (var tokenReadings : sent.getTokensWithoutWhitespace()) {
            System.out.println("TOKEN: " + tokenReadings.getToken() + " [pos=" + tokenReadings.getStartPos() + ".." + tokenReadings.getEndPos() + "]");
            for (var reading : tokenReadings.getReadings()) {
                System.out.println("  lemma=" + reading.getLemma() + ", pos=" + reading.getPOSTag());
            }
        }
        var linguisticService = new com.englishcoach.writing.service.LinguisticAnalysisService(languageToolGrammarService);
        var sawSent = lt.getAnalyzedSentence("I saw a bird.");
        for (var tr : sawSent.getTokensWithoutWhitespace()) {
            if (tr.getToken().equals("saw")) {
                for (var r : tr.getReadings()) {
                    System.out.println("SAW READING: lemma=" + r.getLemma() + ", pos=" + r.getPOSTag());
                }
            }
        }
        assertEquals("go", linguisticService.toBaseVerb("went"));
        assertEquals("see", linguisticService.toBaseVerb("saw"));
        assertEquals("give", linguisticService.toBaseVerb("gave"));
        assertEquals("work", linguisticService.toBaseVerb("worked"));
        assertEquals("play", linguisticService.toBaseVerb("played"));

        assertEquals("went", linguisticService.toPastTenseVerb("go"));
        assertEquals("saw", linguisticService.toPastTenseVerb("see"));
        assertEquals("worked", linguisticService.toPastTenseVerb("work"));
        assertEquals("played", linguisticService.toPastTenseVerb("play"));

        assertEquals("goes", linguisticService.toThirdPersonSingularVerb("go"));
        assertEquals("sees", linguisticService.toThirdPersonSingularVerb("see"));
        assertEquals("works", linguisticService.toThirdPersonSingularVerb("work"));

        assertEquals("going", linguisticService.toPresentParticiple("go"));
        assertEquals("eating", linguisticService.toPresentParticiple("eat"));
        assertEquals("playing", linguisticService.toPresentParticiple("play"));

        assertEquals("children", linguisticService.toPluralNoun("child"));
        assertEquals("people", linguisticService.toPluralNoun("person"));
        assertEquals("books", linguisticService.toPluralNoun("book"));

        assertEquals("child", linguisticService.toSingularNoun("children"));
        assertEquals("person", linguisticService.toSingularNoun("people"));
        assertEquals("book", linguisticService.toSingularNoun("books"));
    }

    @Test
    @DisplayName("Class: Subject-Verb Agreement violation")
    void testSubjectVerbAgreement() {
        String sentence = "She don't like apples.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect(), "SVA violation must not be grammatically correct");
        assertTrue(result.hasConfirmedGrammarError(), "Must detect confirmed grammar error");
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && i.getPatternCode().contains("AUXILIARY") || i.getPatternCode().contains("AGREEMENT")
        ));
    }

    @Test
    @DisplayName("Class: Past tense with explicit past-time marker")
    void testPastTimeMarkerWithPresentVerb() {
        String sentence = "Yesterday I go to the library.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect());
        assertTrue(result.hasConfirmedGrammarError());
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && i.getPatternCode().equals("PAST_TENSE_REGULAR_IRREGULAR")
        ));
    }

    @Test
    @DisplayName("Class: Modal with bare infinitive (prohibiting 'to')")
    void testModalWithToViolation() {
        String sentence = "You must to submit the report on time.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect());
        assertTrue(result.hasConfirmedGrammarError());
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && i.getPatternCode().contains("MODAL")
        ));
    }

    @Test
    @DisplayName("Class: Auxiliary + past participle mismatch (e.g. have went)")
    void testHavePastParticipleMismatch() {
        String sentence = "They have went to the station.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect());
        assertTrue(result.hasConfirmedGrammarError());
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && i.getPatternCode().contains("PAST_PARTICIPLE")
        ));
    }

    @Test
    @DisplayName("Class: Preposition collocation (e.g. depend of)")
    void testPrepositionCollocationViolation() {
        String sentence = "Success depend of continuous practice.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect());
        assertTrue(result.hasConfirmedGrammarError());
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && i.getPatternCode().contains("PREPOSITION")
        ));
    }

    @Test
    @DisplayName("Class: Pronoun capitalization (lowercase 'i')")
    void testLowercasePronounI() {
        String sentence = "When i arrived, the room was empty.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getPatternCode().contains("CAPITALIZATION")
        ));
    }

    @Test
    @DisplayName("Class: Article and determiner agreement (a apple)")
    void testArticleDeterminerAgreement() {
        String sentence = "He ate a apple this morning.";
        var result = validator.validateAndFilterIssues(sentence, Collections.emptyList(), null);

        assertFalse(result.isGrammaticallyCorrect());
        assertTrue(result.hasConfirmedGrammarError());
        assertTrue(result.getValidatedIssues().stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && (i.getPatternCode().contains("ARTICLE") || i.getTitle().contains("a"))
        ));
    }

    @Test
    @DisplayName("Class: Reconcile AI hallucination - drop false SVA on invariant past verb")
    void testDropFalseSvaOnInvariantPastVerb() {
        String sentence = "Yesterday I saw the sunset.";

        // AI falsely hallucinates a subject-verb agreement error on "saw"
        FeedbackIssueDto falseAiSva = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .category("Grammar")
                .patternCode("SUBJECT_VERB_AGREEMENT")
                .title("Subject-Verb Agreement")
                .explanation("Verb does not agree with subject")
                .sourceQuote("saw")
                .startOffset(12)
                .endOffset(15)
                .replacement("sees")
                .build();

        var result = validator.validateAndFilterIssues(sentence, List.of(falseAiSva), false);

        assertTrue(result.isGrammaticallyCorrect(), "Sentence is valid; false AI claim must be dropped");
        assertFalse(result.hasConfirmedGrammarError(), "False AI SVA error must not survive");
        assertEquals(1, result.getDroppedCount(), "Must record 1 dropped AI issue");
    }

    @Test
    @DisplayName("Class: Reclassify stylistic advice into IMPROVEMENT rather than red ERROR")
    void testReclassifyStylisticAdvice() {
        String sentence = "I think that this approach is fine.";

        FeedbackIssueDto stylisticAiIssue = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .category("Grammar")
                .patternCode("NATURALNESS")
                .title("More natural phrasing")
                .explanation("Consider using a more natural and concise expression here")
                .sourceQuote("I think that")
                .startOffset(0)
                .endOffset(12)
                .replacement("In my view")
                .build();

        var result = validator.validateAndFilterIssues(sentence, List.of(stylisticAiIssue), true);

        assertTrue(result.isGrammaticallyCorrect(), "Stylistic advice must not mark sentence as incorrect");
        assertFalse(result.hasConfirmedGrammarError(), "Stylistic advice must not be a confirmed grammar error");
        assertEquals(1, result.getReclassifiedCount(), "Stylistic advice must be reclassified to IMPROVEMENT");
        assertEquals(IssueKind.IMPROVEMENT, result.getValidatedIssues().get(0).getKind());
    }

    @Test
    @DisplayName("Class: No false past-tense transformations on historical essay nouns (graph, access, while, trend, lower)")
    void testNoFalsePastTenseOnHistoricalReportNouns() {
        String essay = "The line graph shows the percentage of households with internet access in three European countries between 2005 and 2020. " +
                "While Greece showed a lower initial figure, the overall trend grew consistently.";
        var result = validator.validateAndFilterIssues(essay, Collections.emptyList(), null);

        for (var issue : result.getValidatedIssues()) {
            String quote = issue.getSourceQuote() != null ? issue.getSourceQuote().toLowerCase() : "";
            String rep = issue.getReplacement() != null ? issue.getReplacement().toLowerCase() : "";
            assertNotEquals("graphed", rep, "Must not convert 'graph' to 'graphed'");
            assertNotEquals("whiled", rep, "Must not convert 'while' to 'whiled'");
            assertNotEquals("accessed", rep, "Must not convert 'access' to 'accessed'");
            assertNotEquals("lowered", rep, "Must not convert 'lower' to 'lowered'");
            assertNotEquals("trended", rep, "Must not convert 'trend' to 'trended'");
            assertNotEquals("showed", rep, "Must not convert 'show' or 'shows' to 'showed'");
        }
    }
}
