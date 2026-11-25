package com.englishcoach.hangman;

import org.junit.jupiter.api.Test;
import java.util.*;
import static com.englishcoach.hangman.HangmanRules.Difficulty.*;
import static org.junit.jupiter.api.Assertions.*;

class HangmanWordSelectionTest {
    private HangmanCatalog.Level word(String answer, String category) {
        return new HangmanCatalog.Level(EASY, 1, answer, category, "fixture", "king-core.lexicon:"+answer.toLowerCase(Locale.ROOT));
    }
    private static List<HangmanWordSelection.Encounter> history(String... words){var out=new ArrayList<HangmanWordSelection.Encounter>();for(int i=0;i<words.length;i++)out.add(new HangmanWordSelection.Encounter(words[i],java.time.Instant.ofEpochSecond(10000-i)));return out;}
    private final Random random = new Random(3);

    @Test void neverRepeatsImmediateAnswerEvenAfterPoolCycles() {
        HangmanCatalog.Level apple=word("APPLE","FOOD"), bread=word("BREAD","FOOD");
        var pool=List.of(apple,bread);
        List<HangmanWordSelection.Encounter> recent=new ArrayList<>();
        for(int i=0;i<50;i++) {
            var next=HangmanWordSelection.select(pool,apple,recent,random);
            if(!recent.isEmpty()) assertNotEquals(recent.getFirst().answer(),next.answer());
            recent.addFirst(new HangmanWordSelection.Encounter(next.answer(),java.time.Instant.now()));
            if(recent.size()>12) recent.removeLast();
        }
    }

    @Test void prefersFreshCategoryThenFreshDifficultyWithOriginalSlotAndProvenance() {
        HangmanCatalog.Level apple=word("APPLE","FOOD"), bread=word("BREAD","FOOD"), river=word("RIVER","NATURE");
        var slot=new HangmanCatalog.Level(EASY,7,"APPLE","FOOD","fixture","king-core.lexicon:apple");
        var next=HangmanWordSelection.select(List.of(apple,bread,river),slot,history("APPLE"),random);
        assertTrue(Set.of("BREAD","RIVER").contains(next.answer())); assertEquals(7,next.levelNumber());
        next=HangmanWordSelection.select(List.of(apple,bread,river),slot,history("APPLE","BREAD"),random);
        assertEquals("RIVER",next.answer()); assertEquals("NATURE",next.category());
        assertEquals("king-core.lexicon:river",next.sourceRef()); assertEquals("fixture",next.answerVersion());
    }

    @Test void exhaustionIsExplicitAndOtherDifficultyCannotSupplyAnAnswer() {
        HangmanCatalog.Level apple=word("APPLE","FOOD");
        var hard=new HangmanCatalog.Level(HARD,1,"ECLIPSE","NATURE","fixture","king-core.lexicon:eclipse");
        var error=assertThrows(HangmanException.class,()->HangmanWordSelection.select(List.of(apple,hard),apple,history("APPLE"),random));
        assertEquals("WORD_POOL_EXHAUSTED",error.code); assertEquals(409,error.status);
    }

    @Test void exhaustedRecentWindowReleasesOldestConstraintBeforeCategory() {
        HangmanCatalog.Level apple=word("APPLE","FOOD"),bread=word("BREAD","FOOD"),river=word("RIVER","NATURE");
        assertEquals("RIVER",HangmanWordSelection.select(List.of(apple,bread,river),apple,history("APPLE","BREAD","RIVER"),random).answer());
    }
    @Test void randomSelectionSpansTheWholeEligibleBucketWithoutBias(){
        var pool=new ArrayList<HangmanCatalog.Level>();
        for(int i=0;i<200;i++)pool.add(word("WA"+(char)('A'+i/26)+(char)('A'+i%26),"FOOD"));
        var counts=new HashMap<String,Integer>();var rng=new Random(818);
        for(int i=0;i<10000;i++)counts.merge(HangmanWordSelection.select(pool,pool.getFirst(),List.of(),rng).answer(),1,Integer::sum);
        assertEquals(200,counts.size());double chiSquare=counts.values().stream().mapToDouble(n->(n-50.0)*(n-50.0)/50.0).sum();
        assertTrue(chiSquare<300,"Uniform within-bucket sampling failed: "+chiSquare);
    }
    @Test void exhaustedLargePoolRandomizesOnlyTheLeastRecentBand(){
        var pool=new ArrayList<HangmanCatalog.Level>();var history=new ArrayList<HangmanWordSelection.Encounter>();
        for(int i=0;i<100;i++){String answer="WA"+(char)('A'+i/26)+(char)('A'+i%26);pool.add(word(answer,"FOOD"));history.add(new HangmanWordSelection.Encounter(answer,java.time.Instant.ofEpochSecond(100-i)));}
        var selected=new HashSet<String>();
        for(int i=0;i<1000;i++){String answer=HangmanWordSelection.select(pool,pool.getFirst(),history,random).answer();assertTrue(history.subList(90,100).stream().anyMatch(e->e.answer().equals(answer)));selected.add(answer);}
        assertEquals(10,selected.size(),"Exhaustion must remain randomized rather than a fixed sequence");
    }
    @Test void retryExcludesAnOldRevealedRoundAfterOtherTracksAndPoolExhaustion(){
        var apple=word("APPLE","FOOD");var bread=word("BREAD","FOOD");var river=word("RIVER","NATURE");
        var encounters=new ArrayList<HangmanWordSelection.Encounter>();
        for(int i=0;i<40;i++)encounters.add(new HangmanWordSelection.Encounter("OTHER"+i,java.time.Instant.ofEpochSecond(1000-i)));
        encounters.addAll(history("BREAD","RIVER","APPLE").stream().map(e->new HangmanWordSelection.Encounter(e.answer(),e.lastSeen().minusSeconds(10000))).toList());
        for(int i=0;i<100;i++)assertNotEquals("APPLE",HangmanWordSelection.select(List.of(apple,bread,river),apple,encounters,random,"APPLE").answer());
    }
}
