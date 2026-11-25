package com.englishcoach.kingofenglish;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class KingCluePolicyTest {
    @Test void obviousSpellingHintsRejected() {
        for(String text:List.of("starts with U", "It begins with b", "first letter is X", "ends with a",
            "last letter is e", "It has eight letters", "an 8-letter word", "third letter is k",
            "letter 4 is n", "It contains 12 characters", "It is spelled with separators", "rhymes with ice"))
            assertEquals("SPELLING_HINT",KingCluePolicy.violation(text),text);
    }
    @Test void conservativeEnglishPolicy() {
        assertEquals("ENGLISH_ONLY",KingCluePolicy.violation("Đây là một vật trong nhà"));
        for(String text:List.of("You keep dry in the rain", "It sends letters to friends", "It has eight legs",
            "Nguyen uses this in Hanoi", "la maison", "day la mot vat", "It contains a letter from my friend"))
            assertNull(KingCluePolicy.violation(text),text);
    }
    @Test void actualEngineRejectsBeforeMutationAndAllowsNaturalClue() {
        var test=new KingExplainTest();test.setup();
        try {
            var pair=test.pair("PRIVATE_ROOM");var author=test.act(1,"ping",pair,"PRIVATE_ROOM",null);
            for(String text:List.of("starts with U","has 8 letters","first letter is B","Đây là một vật trong nhà")) {
                test.time.ms+=1000;var view=author;
                test.rejection(text.startsWith("Đây")?"ENGLISH_ONLY":"SPELLING_HINT",()->test.act(1,"clue",view,"PRIVATE_ROOM",text));
                assertTrue(((List<?>)test.explain(test.act(2,"ping",pair,"PRIVATE_ROOM",null)).get("clues")).isEmpty());
            }
            test.time.ms+=1000;author=test.act(1,"clue",author,"PRIVATE_ROOM","Think about where people use this object.");
            assertEquals(1,((List<?>)test.explain(author).get("clues")).size());
        } finally {test.close();}
    }
}
