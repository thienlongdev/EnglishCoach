package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.*;
import org.junit.jupiter.api.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Repeated runs keep meeting new English: with the account's exposure fed back (newest first, as RushExposureStore
 * reads it), consecutive journeys over the real King source never repeat a source while the pool lasts, and no family
 * takes more than 40 % of a course.
 */
class RushVarietyTest {
    static KingCorpus corpus;static RushQuestions adapter;
    @BeforeAll static void open(){corpus=new KingCorpus("REVIEW_PREVIEW");adapter=new RushQuestions(corpus);}
    @AfterAll static void close(){corpus.close();}

    @Test void consecutiveJourneysDoNotRepeatSourcesAndSpreadFamilies(){
        for(String d:List.of("EASY","MEDIUM","HARD")){
            var history=new ArrayList<List<RushQuestions.Pinned>>();var families=new TreeMap<String,Integer>();int repeats=0,total=0;
            for(int run=0;run<15;run++){
                var exposure=new LinkedHashSet<String>();for(int i=history.size()-1;i>=0;i--)for(var q:history.get(i))exposure.add(q.sourceId());
                var course=adapter.select(new RushDtos.Start(UUID.randomUUID(),d,"MIXED",12),exposure,1000+run);
                for(var q:course){if(exposure.contains(q.sourceId()))repeats++;total++;families.merge(q.family(),1,Integer::sum);}
                var perFamily=new HashMap<String,Integer>();for(var q:course)perFamily.merge(q.family(),1,Integer::sum);
                if(perFamily.size()>=3)assertTrue(perFamily.values().stream().allMatch(c->c<=Math.ceil(12*.4)),d+" family cap "+perFamily);
                assertEquals(12,course.stream().map(RushQuestions.Pinned::sourceId).distinct().count());
                history.add(course);
            }
            System.out.printf("Variety %s: %d repeats in %d gates over 15 journeys; families %s%n",d,repeats,total,families);
            assertEquals(0,repeats,d+": no source repeats across 15 consecutive 12-gate journeys");
        }
    }
}
