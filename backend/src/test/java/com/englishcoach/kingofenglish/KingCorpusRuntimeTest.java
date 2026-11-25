package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Clean Surefire JVM uses classpath artifacts only, with no Spring DB or raw-corpus adapter. */
class KingCorpusRuntimeTest {
    @Test void artifactProvidersAndSecrecy(){
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            assertTrue(corpus.count("REORDER")>=2000);assertTrue(corpus.count("REFLEX")>=3000);assertTrue(corpus.count("EXPLAIN")>=800);assertEquals(150,corpus.count("CONQUEST"));
            var bank=new KingBank(corpus);
            for(String mode:List.of("REORDER","REFLEX"))for(var e:corpus.entries(mode)){
                var item=bank.get(e.id());assertFalse(item.canonical().isBlank(),e.id());
                if(mode.equals("REORDER")){
                    assertTrue(KingBank.correct(item,null,java.util.stream.IntStream.range(0,item.tokens().size()).boxed().toList()),e.id());
                    for(String alternative:item.accepted())assertTrue(KingBank.correct(item,null,order(item,alternative,new ArrayList<>(),new HashSet<>())),e.id());
                }
                if(item.family().equals("PART_OF_SPEECH")){
                    var content=corpus.get(e.id()).path("content");assertEquals(content.path("occurrenceText").asText().toLowerCase(Locale.ROOT),item.context().substring(content.path("occurrenceStart").asInt(),content.path("occurrenceEnd").asInt()).toLowerCase(Locale.ROOT));
                }
                var view=bank.presentation(e.id(),12,false);assertFalse(view.containsKey("answer"));assertFalse(view.containsKey("accepted"));
            }
            for(var e:corpus.entries("EXPLAIN")){var item=corpus.explain(e.id());assertEquals(3,item.progressiveClues().size());for(String clue:item.progressiveClues())assertFalse(KingExplainBank.leaks(item,clue),e.id());}
            for(var e:corpus.entries("CONQUEST")){var board=corpus.board(e.id());assertEquals(25,board.letters().size());for(var c:board.echoCandidates()){assertTrue(corpus.wordEligible(c.word()));KingConquestRules.path(board.letters(),c.word(),c.path());}}
            assertTrue(corpus.cacheState().get("peak")<=KingCorpus.CACHE_CAP);
        }
    }
    @Test void startupIndexingLeavesCacheColdAndIdleExpiryEvictsEntries(){
        var clock=new KingServiceTest.Time();
        try(var corpus=new KingCorpus("REVIEW_PREVIEW",clock)){
            assertEquals(0,corpus.cacheState().get("entries"));
            assertEquals(0,corpus.cacheState().get("peak"));
            assertEquals(KingCorpus.CACHE_CAP,corpus.cacheState().get("cap"));
            String firstId=corpus.entries("REFLEX").getFirst().id();
            assertNotNull(corpus.get(firstId));
            assertEquals(1,corpus.cacheState().get("entries"));
            clock.ms+=KingCorpus.CACHE_TTL;
            corpus.expireCache();
            assertEquals(0,corpus.cacheState().get("entries"));
            assertNotNull(corpus.get(firstId));
            corpus.clearCache();
            assertEquals(0,corpus.cacheState().get("entries"));
        }
    }
    private static List<Integer> order(KingBank.Item item,String rest,List<Integer> prefix,Set<Integer> used){
        rest=KingBank.normalize(rest);
        if(rest.isBlank())return prefix.size()==item.tokens().size()?List.copyOf(prefix):null;
        for(int n=0;n<item.tokens().size();n++)if(!used.contains(n)){
            String token=KingBank.normalize(item.tokens().get(n));if(!rest.equals(token)&&!rest.startsWith(token+" "))continue;
            used.add(n);prefix.add(n);var result=order(item,rest.substring(token.length()).strip(),prefix,used);if(result!=null)return result;used.remove(n);prefix.removeLast();
        }
        return null;
    }
    @Test void deterministicHistoryIsolationAndDiversity(){
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            var a=new KingRecentContent(Clock.systemUTC());var b=new KingRecentContent(Clock.systemUTC());
            var first=a.select(corpus,"REFLEX",0,100,42,List.of(1L,2L));
            assertEquals(first,b.select(corpus,"REFLEX",0,100,42,List.of(1L,2L)));
            var next=a.select(corpus,"REFLEX",0,100,42,List.of(1L));assertTrue(Collections.disjoint(first,next));
            assertEquals(first,a.select(corpus,"REFLEX",0,100,42,List.of(3L)));
            assertEquals(13,first.stream().map(corpus::entry).map(KingCorpus.Entry::family).distinct().count());
            assertEquals(100,first.stream().map(corpus::entry).map(KingCorpus.Entry::semantic).distinct().count());
            assertTrue(a.state().get("semanticEntries")<=3*192);
        }
    }
    @Test void productionFailsClosed(){try(var corpus=new KingCorpus("PRODUCTION")){assertFalse(corpus.enabled());assertEquals(0,corpus.count("REFLEX"));}assertThrows(IllegalArgumentException.class,()->KingCorpus.resolve("ENGINEERING",true,true));}
    @Test void userLruTtlAndBoundedFallback(){
        var clock=new KingServiceTest.Time();
        try(var corpus=new KingCorpus("REVIEW_PREVIEW",clock)){
            var history=new KingRecentContent(clock);
            for(long user=1;user<=4097;user++)history.select(corpus,"CONQUEST",0,1,user,List.of(user));
            assertEquals(4096,history.state().get("users"));
            var a=history.select(corpus,"CONQUEST",0,150,7,List.of(5000L));
            var b=history.select(corpus,"CONQUEST",0,150,7,List.of(5000L));
            assertEquals(150,new HashSet<>(a).size());assertEquals(150,new HashSet<>(b).size());
            assertTrue(history.state().get("semanticEntries")<=4096*192);
            clock.ms+=KingRecentContent.TTL;assertEquals(0,history.state().get("users"));
        }
    }
    @Test void phraseConceptWeakLexemeAndGrammarCooldownAcrossModes(){
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            var recent=new KingRecentContent(java.time.Clock.systemUTC());
            var first=recent.select(corpus,"REFLEX",0,100,47,List.of(1L,2L));
            var phrases=new HashSet<String>();var concepts=new HashSet<String>();var lexemes=new HashSet<String>();
            // Inspect the bounded retained suffixes, exactly as the history caps specify.
            for(String id:first){var e=corpus.entry(id);phrases.addAll(e.phrases());concepts.addAll(e.concepts());lexemes.addAll(e.lexemes());}
            var reorder=recent.select(corpus,"REORDER",0,20,49,List.of(2L));
            assertTrue(reorder.stream().map(corpus::entry).map(KingCorpus.Entry::family).distinct().count()>8);
            for(String id:reorder)assertTrue(Collections.disjoint(phrases,corpus.entry(id).phrases()));
            var explain=recent.select(corpus,"EXPLAIN",0,6,49,List.of(2L));
            for(String id:explain)assertTrue(Collections.disjoint(concepts,corpus.entry(id).concepts()));
            var reflexPhrases=corpus.entries("REFLEX").stream().flatMap(e->e.phrases().stream()).collect(java.util.stream.Collectors.toSet());
            assertTrue(corpus.entries("REORDER").stream().anyMatch(e->!Collections.disjoint(e.phrases(),reflexPhrases)));
            var explainConcepts=corpus.entries("EXPLAIN").stream().flatMap(e->e.concepts().stream()).collect(java.util.stream.Collectors.toSet());
            assertTrue(corpus.entries("REFLEX").stream().anyMatch(e->!Collections.disjoint(e.concepts(),explainConcepts)));
            var limited=recent.select(corpus,"REORDER",2,10,71,List.of(3L));
            assertTrue(limited.stream().map(corpus::entry).allMatch(e->e.difficulty()<=2));
            KingRecentContent weakHistory=null;
            var priorLexemes=new HashSet<String>();
            for(int seed=0;seed<100&&priorLexemes.isEmpty();seed++){
                weakHistory=new KingRecentContent(java.time.Clock.systemUTC());
                var prior=weakHistory.select(corpus,"REFLEX",0,1,seed,List.of(7L));
                priorLexemes.addAll(corpus.entry(prior.getFirst()).lexemes());
            }
            assertFalse(priorLexemes.isEmpty());
            var subsequent=weakHistory.select(corpus,"REFLEX",0,20,13,List.of(7L));
            for(String id:subsequent)assertTrue(Collections.disjoint(priorLexemes,corpus.entry(id).lexemes()),id);
        }
    }
    @Test void sourceVersionSchemaChecksumAndShareAlikeMismatchFailClosed()throws Exception{
        var mapper=new com.fasterxml.jackson.databind.ObjectMapper();
        for(String mutation:List.of("sourceLock","schema","checksum","license")){
            com.fasterxml.jackson.databind.node.ObjectNode manifest;
            try(var in=KingCorpus.class.getResourceAsStream("/data/king/corpus/manifest.json")){manifest=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.readTree(in);}
            switch(mutation){case "sourceLock"->manifest.put("sourceLockSha256","0".repeat(64));case "schema"->manifest.put("schemaVersion",999);case "checksum"->((com.fasterxml.jackson.databind.node.ObjectNode)manifest.path("shards").get(0)).put("sha256","0".repeat(64));case "license"->((com.fasterxml.jackson.databind.node.ObjectNode)manifest.path("shards").get(1)).put("shareAlike",false);}
            byte[] changed=mapper.writeValueAsBytes(manifest);
            assertThrows(IllegalStateException.class,()->new KingCorpus("REVIEW_PREVIEW",java.time.Clock.systemUTC(),false,name->name.equals("manifest.json")?new java.io.ByteArrayInputStream(changed):KingCorpus.class.getResourceAsStream("/data/king/corpus/"+name)),mutation);
        }
    }
}
