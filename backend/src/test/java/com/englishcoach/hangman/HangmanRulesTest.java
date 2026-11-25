package com.englishcoach.hangman;

import org.junit.jupiter.api.Test;
import java.util.random.RandomGenerator;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class HangmanRulesTest {
    private final RandomGenerator fixed = new RandomGenerator() {
        public long nextLong(){return 0;} public long nextLong(long bound){return 0;} public long nextLong(long origin,long bound){return origin;}
        public int nextInt(){return 0;} public int nextInt(int bound){return 0;} public int nextInt(int origin,int bound){return origin;}
        public double nextDouble(){return 0;} public float nextFloat(){return 0;} public boolean nextBoolean(){return false;} public void nextBytes(byte[] bytes){}
    };
    @Test void difficultyPrefillsAndBalloonCounts(){
        assertEquals(2,HangmanRules.start("APPLE",HangmanRules.Difficulty.EASY,fixed).prefilled().length());
        assertEquals(1,HangmanRules.start("GARDEN",HangmanRules.Difficulty.MEDIUM,fixed).prefilled().length());
        assertEquals(0,HangmanRules.start("GARDEN",HangmanRules.Difficulty.HARD,fixed).prefilled().length());
        assertEquals(8,HangmanRules.start("APPLE",HangmanRules.Difficulty.EASY,fixed).remaining());
        assertEquals(7,HangmanRules.start("GARDEN",HangmanRules.Difficulty.MEDIUM,fixed).remaining());
        assertEquals(6,HangmanRules.start("GARDEN",HangmanRules.Difficulty.HARD,fixed).remaining());
    }
    @Test void repeatedLettersRevealAllAndWrongGuessPopsOnce(){
        var state=new HangmanRules.State("APPLE",HangmanRules.Difficulty.EASY,"PE","","",10,HangmanRules.Status.ACTIVE,0);
        var correct=HangmanRules.guess(state,"L").state();assertEquals(java.util.Arrays.asList(null,"P","P","L","E"),correct.pattern());assertEquals(10,correct.remaining());
        var wrong=HangmanRules.guess(correct,"Z").state();assertEquals(9,wrong.remaining());assertEquals(2,wrong.guessed().length());
        assertSame(wrong,HangmanRules.guess(wrong,"Z").state());
    }
    @Test void lastWrongGuessLosesAndHintDoesNotPop(){
        var state=new HangmanRules.State("GARDEN",HangmanRules.Difficulty.HARD,"","ABCDEFG","",1,HangmanRules.Status.ACTIVE,7);
        var lost=HangmanRules.guess(state,"Z").state();assertEquals(HangmanRules.Status.LOST,lost.status());assertEquals(0,lost.remaining());
        var hinted=HangmanRules.hint(new HangmanRules.State("GARDEN",HangmanRules.Difficulty.HARD,"","","",8,HangmanRules.Status.ACTIVE,0),fixed).state();assertEquals(8,hinted.remaining());assertEquals(1,hinted.hinted().length());
    }
}
