package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.*;
import org.junit.jupiter.api.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class RushQuestionsTest {
    static KingCorpus corpus;static RushQuestions adapter;
    @BeforeAll static void open(){corpus=new KingCorpus("REVIEW_PREVIEW");adapter=new RushQuestions(corpus);}
    @AfterAll static void close(){corpus.close();}
    @Test void realSourceIdsOptionsVersionsAndExactDifficultyBands(){
        for(String difficulty:List.of("EASY","MEDIUM","HARD")){
            var request=new RushDtos.Start(UUID.randomUUID(),difficulty,"MIXED",20);var selected=adapter.select(request,Set.of(),72);
            assertEquals(20,selected.size());assertEquals(20,selected.stream().map(RushQuestions.Pinned::sourceId).distinct().count());
            for(var q:selected){var item=corpus.challenge(q.sourceId());assertTrue(adapter.admitted(item));assertEquals(difficulty,RushQuestions.classify(item));
                assertTrue(q.options().size()>=2&&q.options().size()<=4);assertEquals(q.options().size(),q.options().stream().map(o->KingBank.normalize(o.label())).distinct().count());
                assertEquals(1,q.options().stream().filter(o->KingBank.correct(item,o.label(),null)).count());assertEquals(item.fingerprint(),q.fingerprint());assertEquals(item.sourceRef(),q.sourceRefs());}
            assertTrue(selected.stream().map(RushQuestions.Pinned::family).distinct().count()>=2);
        }
    }
    @Test void deterministicSequenceAndAnswerPositionsRecentExclusion(){
        var request=new RushDtos.Start(UUID.randomUUID(),"EASY","MIXED",20);var first=adapter.select(request,Set.of(),42);assertEquals(first,adapter.select(request,Set.of(),42));
        var ids=new HashSet<String>();first.forEach(q->ids.add(q.sourceId()));var next=adapter.select(request,ids,43);assertTrue(next.stream().noneMatch(q->ids.contains(q.sourceId())));
        assertTrue(first.stream().map(q->q.options().stream().map(RushDtos.Option::id).toList().indexOf(q.answerId())).distinct().count()>1);
    }
    @Test void noEngineeringFallbackAndUnsupportedRelations(){
        try(var engineering=new KingCorpus("ENGINEERING")){assertFalse(new RushQuestions(engineering).available());assertThrows(RushException.class,()->new RushQuestions(engineering).select(new RushDtos.Start(UUID.randomUUID(),"EASY","MIXED",3),Set.of(),1));}
        assertEquals("WORD_RELATIONS",RushQuestions.topic("SYNONYM"));assertEquals("WORD_RELATIONS",RushQuestions.topic("WORD_FAMILY"));assertEquals("UNSUPPORTED",RushQuestions.topic("LETTER_SCRAMBLE"));
    }
    @Test void topicFilterAndHonestSparseFailure(){
        var rows=adapter.select(new RushDtos.Start(UUID.randomUUID(),"EASY","SPELLING",8),Set.of(),4);assertTrue(rows.stream().allMatch(q->Set.of("SPELLING_CHOICE","SPELLING_CORRECTION","MISSING_LETTER").contains(q.family())));
        assertThrows(RushException.class,()->adapter.select(new RushDtos.Start(UUID.randomUUID(),"HARD","GRAMMAR",20),Set.of(),4));
    }
    @Test void actualAdapterCounts(){
        var counts=new TreeMap<String,Integer>();int eligible=0;
        for(var e:corpus.entries("REFLEX")){var item=corpus.challenge(e.id());if(RushQuestions.eligible(item)){eligible++;counts.merge(item.family()+":"+RushQuestions.classify(item),1,Integer::sum);}}
        assertTrue(eligible>100);System.out.println("RUSH_ACTUAL_ELIGIBLE="+eligible+" "+counts);
    }
    @Test void vocabularyUsesExistingMeaningChoicesAndMixedIncludesThem(){
        var config=adapter.config();System.out.println("RUSH_QUALIFIED_CATEGORIES="+config);
        for(String difficulty:List.of("EASY","MEDIUM","HARD")){
            assertTrue(config.topics().get(difficulty).contains("VOCABULARY"),"Expected VOCABULARY in "+difficulty);
            var rows=adapter.select(new RushDtos.Start(UUID.randomUUID(),difficulty,"VOCABULARY",3),Set.of(),814);
            assertEquals(3,rows.size());
            for(var q:rows){
                var original=corpus.challenge(q.sourceId());
                assertTrue(RushQuestions.matchesTopic(q.family(),"VOCABULARY"));
                assertEquals(original.meaning(),q.explanation());assertEquals(original.sourceRef(),q.sourceRefs());
                var allowed=new HashSet<String>(original.options());allowed.addAll(adapter.alternativeChoices(q.sourceId()));assertTrue(allowed.containsAll(q.options().stream().map(RushDtos.Option::label).toList()));
                assertEquals(1,q.options().stream().filter(o->KingBank.correct(original,o.label(),null)).count());
            }
            assertTrue(adapter.select(new RushDtos.Start(UUID.randomUUID(),difficulty,"MIXED",8),Set.of(),814).stream().anyMatch(q->RushQuestions.matchesTopic(q.family(),"VOCABULARY")));
        }
        for(String topic:List.of("PHRASAL_VERBS","IDIOMS_EXPRESSIONS")){
            assertTrue(config.topics().get("EASY").contains(topic),"Expected "+topic+" in EASY");
            assertTrue(config.topics().get("MEDIUM").contains(topic),"Expected "+topic+" in MEDIUM");
            var rowsEasy=adapter.select(new RushDtos.Start(UUID.randomUUID(),"EASY",topic,3),Set.of(),815);
            assertEquals(3,rowsEasy.size());
            assertTrue(rowsEasy.stream().allMatch(q->RushQuestions.matchesTopic(q.family(),topic)));
        }
    }
}
