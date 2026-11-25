package com.englishcoach.kingofenglish;

import java.time.Clock;
import java.util.*;

/** Bounded private history shared across modes; competitive players receive one sequence. */
final class KingRecentContent {
    static final int MAX_USERS=4096, SEMANTICS=192, PHRASES=96, CONCEPTS=96, LEXEMES=96;
    static final long TTL=6*60*60*1000L;
    private static final class History {
        long at;
        final LinkedHashSet<String> semantic=new LinkedHashSet<>(),phrase=new LinkedHashSet<>(),concept=new LinkedHashSet<>(),lexeme=new LinkedHashSet<>();
        final LinkedHashSet<String> answer=new LinkedHashSet<>();
    }
    private final Clock clock;
    private final LinkedHashMap<Long,History> users=new LinkedHashMap<>(128,.75f,true);
    KingRecentContent(Clock clock){this.clock=clock;}
    synchronized void expire(){long now=clock.millis();users.values().removeIf(h->now-h.at>=TTL);}
    private static void remember(LinkedHashSet<String> set,Collection<String> values,int cap){
        for(String value:values)if(value!=null&&!value.isBlank()){set.remove(value);set.add(value);}
        while(set.size()>cap)set.remove(set.iterator().next());
    }
    private static int ageRank(LinkedHashSet<String> set,String value){int rank=0;for(String entry:set){rank++;if(entry.equals(value))return rank;}return 0;}
    private static int recency(KingCorpus.Entry e,List<History> histories){
        int rank=0;for(var h:histories){rank=Math.max(rank,ageRank(h.semantic,e.semantic()));for(String p:e.phrases())rank=Math.max(rank,ageRank(h.phrase,p));for(String c:e.concepts())rank=Math.max(rank,ageRank(h.concept,c));}return rank;
    }
    synchronized List<String> select(KingCorpus corpus,String mode,int difficulty,int count,long seed,Collection<Long> players){
        expire();var histories=new ArrayList<History>();
        for(long id:players)if(id>0){var h=users.computeIfAbsent(id,k->new History());h.at=clock.millis();histories.add(h);}
        while(users.size()>MAX_USERS)users.remove(users.keySet().iterator().next());
        var selected=new ArrayList<String>();var seen=new HashSet<String>();
        var sessionAnswers=new HashSet<String>();
        // Relax weak lexemes, then exact concept/phrase, then history semantics. Match uniqueness never relaxes.
        for(int relaxation=0;relaxation<4&&selected.size()<count;relaxation++){
            var candidates=corpus.candidates(mode,difficulty,seed);
            if(relaxation>=2){var fallback=new ArrayList<KingCorpus.Entry>();candidates.forEachRemaining(fallback::add);fallback.sort(Comparator.comparingInt(e->recency(e,histories)));candidates=fallback.iterator();}
            while(candidates.hasNext()&&selected.size()<count){var e=candidates.next();if(seen.contains(e.semantic()))continue;
                boolean conflict=false;
                for(var h:histories)if((relaxation<3&&h.semantic.contains(e.semantic()))||
                    (relaxation<2&&(!Collections.disjoint(h.phrase,e.phrases())||!Collections.disjoint(h.concept,e.concepts())))||
                    (relaxation<1&&(!Collections.disjoint(h.lexeme,e.lexemes())||h.answer.contains(corpus.answerKey(e))))){conflict=true;break;}
                if(relaxation<1&&sessionAnswers.contains(corpus.answerKey(e)))conflict=true;
                if(!conflict&&seen.add(e.semantic())){selected.add(e.id());sessionAnswers.add(corpus.answerKey(e));}
            }
        }
        if(selected.size()<count)throw new KingService.Rejection("CONTENT_UNAVAILABLE");
        for(String id:selected){var e=corpus.entry(id);for(var h:histories){remember(h.semantic,List.of(e.semantic()),SEMANTICS);remember(h.phrase,e.phrases(),PHRASES);remember(h.concept,e.concepts(),CONCEPTS);remember(h.lexeme,e.lexemes(),LEXEMES);remember(h.answer,List.of(corpus.answerKey(e)),LEXEMES);}}
        return List.copyOf(selected);
    }
    synchronized Map<String,Integer> state(){expire();return Map.of("users",users.size(),"semanticEntries",users.values().stream().mapToInt(h->h.semantic.size()).sum(),"phraseEntries",users.values().stream().mapToInt(h->h.phrase.size()).sum(),"conceptEntries",users.values().stream().mapToInt(h->h.concept.size()).sum());}
    synchronized void clear(){users.clear();}
}
