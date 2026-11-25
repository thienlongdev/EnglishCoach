package com.englishcoach.flashcard.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** Pure rules of Echo Memory Tides 2.0: word forms, evolution, weak words, reef, Studio and Fusion validation. */
class EchoMemoryTidesLogicTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private static final LocalDate D = LocalDate.of(2026, 11, 1);

    @Test
    void wordFormsMatchRegularInflectionsAndPhrasesOnly() {
        assertTrue(WordForms.uses("She carried the heavy boxes upstairs.", "carry"));
        assertTrue(WordForms.uses("They were planning a trip.", "plan"));
        assertTrue(WordForms.uses("He is making progress.", "make"));
        assertTrue(WordForms.uses("Please pick it up later.", "pick up"));
        assertFalse(WordForms.uses("The carriage arrived.", "carry"));
        assertFalse(WordForms.uses("She went home.", "go"), "irregular forms are never guessed");
        assertEquals("studies", WordForms.matchedForm("Maria studies at night.", "study"));
        assertFalse(WordForms.contentWord("the"));
        assertTrue(WordForms.contentWord("resilient"));
    }

    @Test
    void oneEasyOrOneSessionNeverMakesAPearl() {
        assertNull(MemoryEvolution.pearlDay(List.of(D)));
        assertNull(MemoryEvolution.pearlDay(List.of(D, D, D)), "many ratings on one day count once");
        assertNull(MemoryEvolution.pearlDay(List.of(D, D.plusDays(1), D.plusDays(2))), "three days but no 14-day span");
        assertEquals(D.plusDays(14), MemoryEvolution.pearlDay(List.of(D, D.plusDays(5), D.plusDays(14))));
        assertEquals(D.plusDays(20), MemoryEvolution.pearlDay(List.of(D.plusDays(20), D, D.plusDays(3))));
    }

    @Test
    void tierPrecedenceAndPractice() {
        assertEquals(MemoryEvolution.Tier.PEARL, MemoryEvolution.tier(true, true, true));
        assertEquals(MemoryEvolution.Tier.PRISM, MemoryEvolution.tier(false, true, true));
        assertEquals(MemoryEvolution.Tier.SILVER, MemoryEvolution.tier(false, false, true));
        assertEquals(MemoryEvolution.Tier.RAW, MemoryEvolution.tier(false, false, false));
        assertTrue(MemoryEvolution.practised(false, "LEARNED", 0));
        assertTrue(MemoryEvolution.practised(false, "NEW", 2));
        assertFalse(MemoryEvolution.practised(false, "NEW", 0));
    }

    @Test
    void weakNeedsHardOnDistinctDaysAndNotLatestEasy() {
        LocalDate today = D.plusDays(10);
        assertFalse(MemoryEvolution.weak(Set.of(D.plusDays(9)), "hard", today), "one day (one session) is not weak");
        assertTrue(MemoryEvolution.weak(Set.of(D.plusDays(2), D.plusDays(9)), "hard", today));
        assertFalse(MemoryEvolution.weak(Set.of(D.plusDays(2), D.plusDays(9)), "easy", today), "found easy since");
        assertFalse(MemoryEvolution.weak(Set.of(D.minusDays(60), D.minusDays(50)), "hard", today), "outside the window");
    }

    @Test
    void reefMilestonesAreDerivedAndStable() {
        List<LocalDate> days = List.of(D.plusDays(2), D, D.plusDays(1));
        var first = MemoryEvolution.milestones(days, 120, Map.of(100, D.plusDays(2)), List.of(D.plusDays(1)), List.of());
        var again = MemoryEvolution.milestones(List.of(D, D.plusDays(1), D.plusDays(2)), 120, Map.of(100, D.plusDays(2)), List.of(D.plusDays(1)), List.of());
        assertEquals(first, again, "the same data gives the same reef");
        var tide1 = first.stream().filter(m -> m.key().equals("TIDE_DAYS_1")).findFirst().orElseThrow();
        assertEquals(D, tide1.reachedOn());
        assertFalse(first.stream().filter(m -> m.key().equals("TIDE_DAYS_7")).findFirst().orElseThrow().reached());
        assertEquals(D.plusDays(2), first.stream().filter(m -> m.key().equals("REVIEWS_100")).findFirst().orElseThrow().reachedOn());
        assertFalse(first.stream().filter(m -> m.key().equals("FUSIONS_1")).findFirst().orElseThrow().reached());
    }

    @Test
    void studioKeepsOnlyDraftsGroundedInThePassage() {
        String passage = "The city struggled to cope with the flood. Volunteers handed out blankets. Officials promised to look into the delays.";
        String ai = """
                {"cards":[
                 {"term":"cope with","kind":"PHRASAL_VERB","partOfSpeech":"phrasal verb","sourceSentence":"The city struggled to cope with the flood.","meaningVi":"đối phó với","definitionEn":"deal with","sentenceVi":"Thành phố chật vật đối phó với lũ."},
                 {"term":"look into","kind":"PHRASAL_VERB","partOfSpeech":"phrasal verb","sourceSentence":"Officials promise to examine the delays.","meaningVi":"điều tra","definitionEn":"investigate","sentenceVi":"x"},
                 {"term":"evacuate","kind":"WORD","partOfSpeech":"verb","sourceSentence":"They evacuated.","meaningVi":"sơ tán"},
                 {"term":"Cope With","kind":"WORD","partOfSpeech":"verb","sourceSentence":"The city struggled to cope with the flood.","meaningVi":"dup"},
                 {"term":"blanket","kind":"WORD","partOfSpeech":"noun","sourceSentence":"Volunteers handed out blankets.","meaningVi":""},
                 {"term":"struggle","kind":"WORD","partOfSpeech":"pronunciation /x/","sourceSentence":"The city struggled to cope with the flood.","meaningVi":"vật lộn"}
                ]}""";
        CardStudio.Parsed parsed = CardStudio.parse(mapper, ai, passage, Set.of("struggle"), 10);
        assertEquals(List.of("cope with", "look into"), parsed.drafts().stream().map(CardStudio.Draft::term).toList());
        CardStudio.Draft lookInto = parsed.drafts().get(1);
        assertEquals("Officials promised to look into the delays.", lookInto.sourceSentence(), "the real sentence, not the AI's copy");
        assertNull(lookInto.sentenceVi(), "a translation of a different sentence is dropped");
        assertEquals(4, parsed.dropped());
        assertThrows(IllegalStateException.class, () -> CardStudio.parse(mapper, "not json", passage, Set.of(), 5));
    }

    @Test
    void fusionAcceptanceIsStrictAndDeterministicallyChecked() {
        String ok = """
                {"usesFirst":true,"usesSecond":true,"grammatical":true,"meaningCorrect":true,"natural":"YES","verdict":"ACCEPTED","feedbackVi":"Tốt.","suggestionEn":null}""";
        assertTrue(MemoryAi.parseFusion(mapper, ok, "The volunteers coped with the sudden flood.", "cope", "flood").accepted());
        var missing = MemoryAi.parseFusion(mapper, ok, "The volunteers coped with the storm.", "cope", "flood");
        assertFalse(missing.accepted());
        assertEquals("NEEDS_WORK", missing.verdict(), "an AI 'accepted' without the word is overruled");
        String unsure = ok.replace("\"verdict\":\"ACCEPTED\"", "\"verdict\":\"UNCERTAIN\"");
        var u = MemoryAi.parseFusion(mapper, unsure, "The volunteers coped with the flood.", "cope", "flood");
        assertFalse(u.accepted());
        assertEquals("UNCERTAIN", u.verdict());
        String unnatural = ok.replace("\"natural\":\"YES\"", "\"natural\":\"NO\"");
        assertFalse(MemoryAi.parseFusion(mapper, unnatural, "Flood the cope with.", "cope", "flood").accepted());
        assertThrows(IllegalStateException.class, () -> MemoryAi.parseFusion(mapper, "{\"verdict\":\"MAYBE\"}", "x", "a", "b"));
    }

    @Test
    void realAiReportNeverCarriesAKeyShapedValue() {
        String leaked = "{\"error\":\"401 for sk-or-v1-0123456789abcdef0123 with Authorization: Bearer abcDEF123456789xyz\"}";
        String clean = EchoMemoryTidesRealAiTest.redact(leaked);
        assertFalse(clean.contains("sk-or-v1-0123"), clean);
        assertFalse(clean.contains("abcDEF123456789xyz"), clean);
        assertTrue(clean.contains("[redacted]"));
    }

    @Test
    void forgeAnswerIsBoundedAndNeverEmpty() {
        var f = MemoryAi.parseForge(mapper, "{\"title\":\"Mẹo nhớ\",\"paragraphs\":[\"a\",\"b\"],\"prompts\":[{\"q\":\"Q\",\"a\":\"A\"},{\"q\":\"\"}]}");
        assertEquals(2, f.paragraphs().size());
        assertEquals(1, f.prompts().size());
        assertThrows(IllegalStateException.class, () -> MemoryAi.parseForge(mapper, "{\"title\":\"x\",\"paragraphs\":[]}"));
    }
}
