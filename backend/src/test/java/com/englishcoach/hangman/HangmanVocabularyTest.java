package com.englishcoach.hangman;

import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import java.util.*;
import java.time.Instant;
import java.nio.file.*;
import static com.englishcoach.hangman.HangmanRules.*;
import static org.junit.jupiter.api.Assertions.*;

class HangmanVocabularyTest {
    static KingCorpus corpus;static HangmanCatalog catalog;
    @BeforeAll static void load(){corpus=new KingCorpus("REVIEW_PREVIEW");catalog=new HangmanCatalog(new ObjectMapper(),corpus);}
    @AfterAll static void close(){corpus.close();}
    @Test void actualSourceEligibilityAndAudit() throws Exception {
        var words=corpus.vocabulary();assertEquals(10023,words.size());assertEquals(words.size(),words.stream().map(KingCorpus.VocabularyWord::word).distinct().count());
        var counts=new TreeMap<String,Integer>();var categories=new TreeMap<String,Integer>();var selected=new HashSet<String>();
        for(var difficulty:Difficulty.values()){
            var pool=catalog.pool(difficulty);assertTrue(pool.size()>500);counts.put(difficulty.name(),pool.size());
            assertEquals(difficulty==Difficulty.HARD?18:20,catalog.count(difficulty));
            for(var candidate:pool){assertTrue(selected.add(candidate.answer()));assertTrue(candidate.answer().matches("[A-Z]{4,10}"));assertTrue(corpus.wordEligible(candidate.answer().toLowerCase(Locale.ROOT)));assertFalse(HangmanVocabulary.UNSUITABLE.contains(candidate.answer().toLowerCase(Locale.ROOT)));categories.merge(candidate.category(),1,Integer::sum);}
        }
        var record=new TreeMap<String,Object>();record.put("source","approved King core lexical projection; exact CEFR-J source lexeme references");record.put("sourceWords",words.size());record.put("uniqueNormalized",words.size());record.put("ascii4to10",words.stream().filter(w->w.word().matches("[a-z]{4,10}")).count());record.put("unsupportedShape",words.stream().filter(w->!w.word().matches("[a-z]{4,10}")).count());record.put("emptyOrPunctuation",words.stream().filter(w->!w.word().matches("[a-z]+")).count());record.put("exactCefr4to10",words.stream().filter(w->w.word().matches("[a-z]{4,10}")&&!w.cefr().isEmpty()).count());record.put("frequencyMetadata","no per-word frequency in packaged lexicon; not fabricated");record.put("difficultyCounts",counts);record.put("categories",categories);record.put("eligible",selected.size());record.put("rejected",words.size()-selected.size());record.put("rejectedUnsuitableLearnerWords",words.stream().filter(w->!w.cefr().isEmpty()&&HangmanVocabulary.UNSUITABLE.contains(w.word())).map(KingCorpus.VocabularyWord::word).toList());record.put("linguisticPerfection","not claimed; CEFR source/POS ambiguity retained, unprofiled lexicon rejected except verified seeds");
        Files.createDirectories(Path.of("target"));new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(Path.of("target/hangman-v44-vocabulary-audit.json").toFile(),record);
    }
    @Test void difficultyUsesDirectMetadataAndSpellingNotLengthAlone(){
        assertEquals(Difficulty.EASY,HangmanVocabulary.classify(new KingCorpus.VocabularyWord("stone",Set.of("A1"),Set.of("noun"))));
        assertEquals(Difficulty.HARD,HangmanVocabulary.classify(new KingCorpus.VocabularyWord("aback",Set.of("B2"),Set.of("adverb"))));
        assertEquals(Difficulty.MEDIUM,HangmanVocabulary.classify(new KingCorpus.VocabularyWord("experiment",Set.of("A2"),Set.of("noun"))));
        assertNull(HangmanVocabulary.classify(new KingCorpus.VocabularyWord("ablate",Set.of(),Set.of())));
        for(String word:List.of("New York","paris","rape","a-b","café"))assertNull(HangmanVocabulary.classify(new KingCorpus.VocabularyWord(word,Set.of("A1"),Set.of("proper noun"))));
        // borrow's relation metadata must be attached to borrow, not copied to lend.
        assertTrue(corpus.vocabulary().stream().filter(w->w.word().equals("borrow")).findFirst().orElseThrow().cefr().contains("A1"));
    }
    @Test void broadActualPoolsHonorLifetimeUnseenPriority(){
        long began=System.nanoTime();
        for(var difficulty:Difficulty.values()){
            var history=new ArrayList<HangmanWordSelection.Encounter>();var seen=new HashSet<String>();var rng=new Random(817);var pool=catalog.pool(difficulty);
            for(int i=0;i<500;i++){
                var selected=HangmanWordSelection.select(pool,catalog.level(difficulty,1),history,rng);
                assertTrue(seen.add(selected.answer()),"Lifetime unseen priority lost beyond recent window");
                history.addFirst(new HangmanWordSelection.Encounter(selected.answer(),Instant.ofEpochSecond(i)));
            }
            assertEquals(500,seen.size());
        }
        assertTrue((System.nanoTime()-began)/1e9<15,"Bounded in-memory creation selection budget");
    }
    @Test void legacyAndNewBudgetsRemainInvariantAcrossAllTransitions(){
        for(var difficulty:Difficulty.values())for(int initial:List.of(difficulty.balloons,difficulty.balloons+2)){
            String prefilled=difficulty.prefill==2?"AP":difficulty.prefill==1?"A":"";
            var state=new State("APPLE",difficulty,prefilled,"","",initial,Status.ACTIVE,0);
            for(char c='A';c<='Z'&&state.status()==Status.ACTIVE;c++)if(state.answer().indexOf(c)<0){state=HangmanRules.guess(state,String.valueOf(c)).state();assertEquals(initial,state.initialBalloons());}
            assertEquals(Status.LOST,state.status());assertEquals(0,state.remaining());
            state=new State("APPLE",difficulty,prefilled,"Z","",initial-1,Status.ACTIVE,1);
            state=HangmanRules.hint(state,new Random(4)).state();assertEquals(initial,state.initialBalloons());
            for(char c:state.answer().toCharArray())state=HangmanRules.guess(state,String.valueOf(c)).state();
            assertEquals(Status.WON,state.status());assertEquals(initial,state.initialBalloons());
        }
    }
}
