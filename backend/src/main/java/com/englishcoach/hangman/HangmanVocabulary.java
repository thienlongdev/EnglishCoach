package com.englishcoach.hangman;

import com.englishcoach.kingofenglish.KingCorpus;
import java.util.*;
import static com.englishcoach.hangman.HangmanRules.Difficulty;

/** Deterministic learner eligibility. Missing CEFR/frequency is never invented. */
final class HangmanVocabulary {
    // Content suitability policy, not a second word bank. Seeds use the same gate.
    static final Set<String> UNSUITABLE=Set.of("fuck","fucking","shit","shitty","bitch","bastard","cunt","cock","dick","penis","vagina","porn","porno","rape","rapist","nigger","nigga","faggot","slut","whore","suicide");
    static boolean shape(String word){return word!=null&&word.matches("[a-z]{4,10}")&&word.chars().distinct().count()>2;}
    static Difficulty classify(KingCorpus.VocabularyWord word){
        if(!shape(word.word())||UNSUITABLE.contains(word.word())||word.cefr().isEmpty())return null;
        if(word.partsOfSpeech().isEmpty()||word.partsOfSpeech().stream().anyMatch(p->p.toLowerCase(Locale.ROOT).contains("proper")||p.toLowerCase(Locale.ROOT).contains("abbrev")))return null;
        String cefr=word.cefr().stream().sorted().findFirst().orElseThrow();
        long distinct=word.word().chars().distinct().count();
        long rare=word.word().chars().filter(c->"jqxz".indexOf(c)>=0).count();
        if(cefr.equals("A1")||cefr.equals("A2"))return word.word().length()>8||distinct>7||rare>1?Difficulty.MEDIUM:Difficulty.EASY;
        if(cefr.equals("B1"))return rare>1&&distinct>=7?Difficulty.HARD:Difficulty.MEDIUM;
        return Difficulty.HARD;
    }
    private HangmanVocabulary(){}
}
