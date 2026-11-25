package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.*;
import org.junit.jupiter.api.*;
import java.util.*;

/** TEMPORARY audit probe (removed before release). */
class RushProbeV6Test {
    @Test void probe(){
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            var adapter=new RushQuestions(corpus);
            var fillers=new TreeMap<String,Map<String,Integer>>();
            for(var e:corpus.entries("REFLEX")){var i=corpus.challenge(e.id());if(!adapter.qualified(i))continue;
                for(var o:i.options())if(!KingBank.correct(i,o,null))fillers.computeIfAbsent(i.family(),k->new HashMap<>()).merge(o,1,Integer::sum);}
            fillers.forEach((k,v)->{var top=v.entrySet().stream().sorted((a,b)->b.getValue()-a.getValue()).limit(6).toList();System.out.println("FILL "+k+" distinct="+v.size()+" top="+top);});
            var derivedCount=new TreeMap<String,Integer>();
            for(var e:corpus.entries("REFLEX"))if(!adapter.derivedChoices(e.id()).isEmpty())derivedCount.merge(e.family(),1,Integer::sum);
            System.out.println("DERIVED "+derivedCount);var alt=new TreeMap<String,Integer>();int m=0;for(var e:corpus.entries("REFLEX")){var a=adapter.alternativeChoices(e.id());if(a.isEmpty())continue;alt.merge(e.family(),1,Integer::sum);var i=corpus.challenge(e.id());if(m++%400==0)System.out.println("ALT "+i.family()+" | "+i.context()+" | A="+(i.expression()==null?i.canonical():i.expression())+" | alt="+a);}System.out.println("ALTCOUNT "+alt);
            int n=0;for(var e:corpus.entries("REFLEX")){var d=adapter.derivedChoices(e.id());if(d.isEmpty())continue;var i=corpus.challenge(e.id());
                if(n++%250==0)System.out.println("D "+i.family()+" | "+i.prompt()+" | ctx="+i.context()+" | A="+i.canonical()+" | R="+i.relationSet()+" | wrong="+d);}
            for(String diff:List.of("EASY","MEDIUM","HARD")){var r=adapter.select(new RushDtos.Start(UUID.randomUUID(),diff,"MIXED",20),Set.of(),7);
                System.out.println("RUN "+diff+" "+r.stream().map(q->q.family()+":"+q.options().stream().map(RushDtos.Option::label).toList()).toList());}
            System.out.println("CONFIG "+adapter.config().topics()+" "+adapter.config().eligible());
        }
    }
}
