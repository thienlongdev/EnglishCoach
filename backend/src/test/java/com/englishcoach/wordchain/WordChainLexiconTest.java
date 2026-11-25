package com.englishcoach.wordchain;

import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import com.englishcoach.kingofenglish.KingCorpus;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.ObjectProvider;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Real bundled EN–VI dictionary + the bundled approved King lexicon (REVIEW_PREVIEW), as production reads them. */
class WordChainLexiconTest {
    static WordChainLexicon lex;
    static KingCorpus king;
    @BeforeAll @SuppressWarnings("unchecked") static void load() {
        var local=new LocalEnViLexicalProvider();local.init();assertTrue(local.isAvailable());
        king=new KingCorpus("REVIEW_PREVIEW");
        ObjectProvider<KingCorpus> provider=mock(ObjectProvider.class);when(provider.getIfAvailable()).thenReturn(king);
        lex=new WordChainLexicon(local,provider);lex.init();
    }
    @AfterAll static void close(){king.close();}
    static WordChainLexicon.Word word(String w){var v=lex.check(w);assertNotNull(v.word(),w+" → "+v.rejection());return v.word();}
    static String rejection(String w){var v=lex.check(w);assertNull(v.word(),w+" was accepted: "+v.word());return v.rejection();}

    @Test void primarySenseFollowsTheEntryNotASharedRareDefinition() {
        var rear=word("rear");
        assertEquals("noun",rear.partOfSpeech());assertTrue(rear.meaningVi().startsWith("Bộ phận đằng sau"),rear.meaningVi());
        assertTrue(rear.senses().stream().anyMatch(s->s.pos().equals("verb")),"other senses stay inspectable");
        assertEquals("Cây",word("tree").meaningVi());
        assertTrue(word("echo").meaningVi().startsWith("Tiếng dội"));
        assertTrue(word("effect").meaningVi().startsWith("Kết quả"));
        var abandon=word("abandon");
        assertEquals("verb",abandon.partOfSpeech(),"the CEFR-J part of speech leads");assertFalse(abandon.meaningVi().contains("nhiếp ảnh"),abandon.meaningVi());
        assertTrue(abandon.senses().stream().anyMatch(s->s.meaning().contains("nhiếp ảnh")),"field senses stay among the other senses");
        assertEquals("verb",word("tackle").partOfSpeech());
        assertFalse(word("holy").meaningVi().startsWith("Holy Writ"),word("holy").meaningVi());
        for(String w:List.of("bob","gab","rear","tree","run","energy","yes","zoo","quiz","x-ray","bike","exam")) {
            var x=word(w);assertFalse(x.meaningVi().isBlank(),w);
            assertFalse(x.meaningVi().toLowerCase(Locale.ROOT).contains("viết tắt"),w+": "+x.meaningVi());
            assertTrue(WordChainLexicon.POS.containsValue(x.partOfSpeech()),w);
            assertTrue(x.senses().stream().allMatch(s->WordChainLexicon.POS.containsValue(s.pos())),w);
        }
        assertEquals("verb",word("gab").senses().getLast().pos(),"gab keeps its verb sense (nói lém) among the senses");
        assertNotNull(word("hello").ipa());
    }
    @Test void abbreviationsAcronymsAndProperNamesAreRefused() {
        for(String w:List.of("rac","nato","usa","dna","vip","faq","tv","cd","ppd","bfn","op","ad","pe","om","gg","hon"))
            assertEquals("ABBREVIATION",rejection(w),w);
        assertEquals("UNKNOWN_WORD",rejection("zzzznotaword"));
        // Ordinary short words are never refused for their length.
        for(String w:List.of("ox","ax","eye","ego","owl","ink","sky","gym","bob","gab","axe","yak","zip"))
            if(lex.check(w).rejection()!=null) assertNotEquals("ABBREVIATION",lex.check(w).rejection(),w);
        for(String w:List.of("owl","ink","sky","gym","zip")) word(w);
        assertEquals("noun",word("sky").partOfSpeech(),"long part-of-speech codes are mapped too");
    }
    @Test void everyStartingLetterHasPlayableWordsAndEchoAnswersAtEveryLevel() {
        var rng=new SplittableRandom(7);
        for(char c='a';c<='z';c++) {
            final char letter=c;
            long humanWords=lex.botWords().getOrDefault(c,List.of()).stream().limit(4000).filter(w->lex.check(w.word()).word()!=null).limit(3).count();
            assertTrue(humanWords>=3,"letter "+c+" has playable words");
            for(String level:List.of("EASY","MEDIUM","HARD")) {
                var chosen=WordChainBot.choose(lex,c,Set.of(),level,rng);
                assertNotNull(chosen,"Echo "+level+" answers "+c);assertEquals(letter,chosen.normalizedWord().charAt(0));
                assertNull(lex.check(chosen.normalizedWord()).rejection(),"Echo's word passes the human verdict");
            }
        }
    }
    @Test void echoLevelsDrawFromTheirBands() {
        var rng=new SplittableRandom(11);int easyCommon=0,hardAdvanced=0;
        for(char c:"abcdefghlmprstw".toCharArray()) for(int i=0;i<4;i++) {
            var easy=WordChainBot.choose(lex,c,Set.of(),"EASY",rng);if(easy.cefr()!=null && Set.of("A1","A2").contains(easy.cefr()))easyCommon++;
            var hard=WordChainBot.choose(lex,c,Set.of(),"HARD",rng);if(hard.cefr()==null || !Set.of("A1","A2").contains(hard.cefr()))hardAdvanced++;
            assertFalse(WordChainLexicon.UNSUITABLE.contains(easy.normalizedWord()));
        }
        assertTrue(easyCommon>=55,"EASY picks A1–A2: "+easyCommon+"/60");
        assertTrue(hardAdvanced>=55,"HARD avoids A1–A2: "+hardAdvanced+"/60");
    }
}
