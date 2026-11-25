package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import java.util.*;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RushOwnerAcceptanceTest {
    static KingCorpus corpus;static RushQuestions adapter;
    @BeforeAll static void open(){corpus=new KingCorpus("REVIEW_PREVIEW");adapter=new RushQuestions(corpus);}
    @AfterAll static void close(){corpus.close();}
    static KingBank.Item altered(KingBank.Item i,List<String> options,String answer,String expression,String context){
        return new KingBank.Item(i.id(),i.mode(),i.family(),i.prompt(),i.tokens(),options,answer,i.accepted(),i.meaning(),i.difficulty(),i.cefr(),i.cefrBasis(),i.sourceKind(),i.sourceRef(),i.version(),i.status(),i.humanReview(),i.fingerprint(),expression,context,i.relationSet(),i.missingIndex());
    }
    @Test void reportedEnvelopeHasTwoDistinctSourceLabelsAndOneLiteralKey(){
        var i=corpus.challenge("kc-reflex-ac35769e42bae21e73c33ae3");
        assertEquals(List.of("evnelope","envelope"),i.options());assertTrue(adapter.qualified(i));
        assertFalse(RushQuestions.eligible(altered(i,List.of("envelope","envelope"),"envelope",null,null)));
        for(String variant:List.of("ENVELOPE","ｅｎｖｅｌｏｐｅ","enve\u200blope","envelope\u00a0","envelope\n"))
            assertFalse(RushQuestions.eligible(altered(i,List.of("envelope",variant),"envelope",null,null)),variant);
        assertFalse(RushQuestions.eligible(altered(i,List.of("evnelope","envelpoe"),"envelope",null,null)));
    }
    @Test void reportedMobileMeaningHasSourcePinnedAnswerAndContradictoryProjectionFails(){
        var i=corpus.challenge("kc-reflex-b5e6858c6594c5c5d7e37277");assertTrue(adapter.qualified(i));
        assertEquals("star in the east",i.canonical());assertTrue(i.options().contains(i.canonical()));
        assertFalse(adapter.qualified(altered(i,i.options(),i.canonical(),"out of joint",i.context())));
        assertFalse(adapter.qualified(altered(i,i.options(),i.canonical(),i.expression(),"An unrelated meaning.")));
        assertFalse(RushQuestions.eligible(altered(i,List.of("across the board","out of joint"),i.canonical(),i.expression(),i.context())));
    }
    @Test void recognizedMorphologicalSpellingAlternativeFailsClosed(){
        var i=corpus.challenge("kc-reflex-ac35769e42bae21e73c33ae3");var mock=mock(KingCorpus.class);when(mock.get(i.id())).thenReturn(corpus.get(i.id()));when(mock.wordEligible("envelop")).thenReturn(true);
        assertFalse(new RushQuestions(mock).qualified(altered(i,List.of("envelop","envelope"),i.canonical(),null,null)));
    }
    @Test void grammarProofOccurrenceAndEquivalentMeaningDistractorsFailClosed(){
        var grammar=corpus.entries("REFLEX").stream().filter(e->e.family().equals("GRAMMAR_TRAP")).map(e->corpus.challenge(e.id())).filter(adapter::qualified).findFirst().orElseThrow();
        assertFalse(adapter.qualified(altered(grammar,List.of(grammar.canonical(),"unsupported variant"),grammar.canonical(),grammar.expression(),grammar.context())));
        var pos=corpus.entries("REFLEX").stream().filter(e->e.family().equals("PART_OF_SPEECH")).map(e->corpus.challenge(e.id())).filter(adapter::qualified).findFirst().orElseThrow();
        assertFalse(adapter.qualified(altered(pos,pos.options(),pos.canonical(),pos.expression(),"x")));
        var phrase=corpus.challenge("kc-reflex-b5e6858c6594c5c5d7e37277");
        var distractor=corpus.entries("REFLEX").stream().filter(e->e.family().equals("FIXED_EXPRESSION")).filter(e->"across the board".equals(corpus.challenge(e.id()).expression())).findFirst().orElseThrow();
        var other=corpus.challenge(distractor.id());var fake=mock(KingCorpus.class);when(fake.get(phrase.id())).thenReturn(corpus.get(phrase.id()));when(fake.entries("REFLEX")).thenReturn(List.of(distractor));
        var equivalent=new KingBank.Item(other.id(),other.mode(),other.family(),other.prompt(),other.tokens(),other.options(),other.canonical(),other.accepted(),phrase.meaning(),other.difficulty(),other.cefr(),other.cefrBasis(),other.sourceKind(),other.sourceRef(),other.version(),other.status(),other.humanReview(),other.fingerprint(),other.expression(),phrase.context(),other.relationSet(),other.missingIndex());
        when(fake.challenge(distractor.id())).thenReturn(equivalent);assertFalse(new RushQuestions(fake).qualified(phrase));
    }
    @Test void allSettingsShufflesAndSnapshotRoundTripsPreservePreciseVisibleAnswer()throws Exception{
        var json=new ObjectMapper();
        for(String d:List.of("EASY","MEDIUM","HARD"))for(String topic:adapter.config().topics().get(d))for(int n:List.of(3,8,12,20))for(int seed=0;seed<4;seed++){
            var course=adapter.select(new RushDtos.Start(UUID.randomUUID(),d,topic,n),Set.of(),seed);
            var race=new RushCompetition.Race(course,seed);
            for(int p=1;p<=5;p++)race.racers.add(new RushCompetition.Racer("p"+p,(long)p,"Racer "+p,null));
            for(int k=0;k<n;k++)for(var p:race.racers){var q=course.get(k);assertTrue(adapter.admitted(corpus.challenge(q.sourceId())));
                var order=RushCompetition.order(race,p,k);assertEquals(q.options().size(),new HashSet<>(order).size());
                assertEquals(q.options().size(),order.stream().map(x->RushQuestions.visibleKey(q.options().get(x).label())).distinct().count());
                assertEquals(1,q.options().stream().filter(o->o.id().equals(q.answerId())&&KingBank.correct(corpus.challenge(q.sourceId()),o.label(),null)).count());
            }
            var recovered=json.readValue(json.writeValueAsBytes(race),RushCompetition.Race.class);
            assertEquals(race.questions,recovered.questions);for(int k=0;k<n;k++)for(int p=0;p<5;p++)assertEquals(RushCompetition.order(race,race.racers.get(p),k),RushCompetition.order(recovered,recovered.racers.get(p),k));
        }
    }
    @Test void actualBeforeAfterPoolCounts()throws Exception{
        var before=new TreeMap<String,Integer>();var after=new TreeMap<String,Integer>();var excluded=new ArrayList<String>();
        for(var e:corpus.entries("REFLEX")){var i=corpus.challenge(e.id());if(RushQuestions.eligible(i))before.merge(i.family()+":"+RushQuestions.classify(i),1,Integer::sum);if(adapter.qualified(i))after.merge(i.family()+":"+RushQuestions.classify(i),1,Integer::sum);else if(RushQuestions.eligible(i))excluded.add(i.id());}
        assertEquals(7,after.keySet().stream().map(k->k.split(":")[0]).distinct().count());
        var report=Map.of("channel",corpus.channel(),"version",adapter.version(),"baselineReported",13685,"structurallyEligible",before,"sourceQualified",after,"excludedSourceIds",excluded);
        Files.writeString(Path.of("target/rush-owner-pool-counts.json"),new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsString(report));
        System.out.println("RUSH_OWNER_POOL "+new ObjectMapper().writeValueAsString(report));
    }
    @Test void approvedLocalPackageRetainsEnoughValidCourses()throws Exception{
        Path root=Path.of("").toAbsolutePath();if(!Files.exists(root.resolve("backend/pom.xml")))root=root.getParent();
        Path store=Files.createTempDirectory("rush-approved-local-");String id="king-corpus-2026-10-05-v3";
        var base=List.of("python","-X","utf8",root.resolve("backend/scripts/king/corpus/snapshot.py").toString(),"--store",store.toString());
        var commands=new ArrayList<List<String>>();commands.add(List.of("validate","--package",root.resolve("docs/king-of-english/corpus/production-review/packages/"+id).toString(),"--id",id,"--version","3","--validator-version","king-snapshot-3"));
        run(base,commands.getFirst());var json=new ObjectMapper();String hash=json.readTree(Files.readAllBytes(store.resolve("state.json"))).path("snapshots").path(id).path("fingerprint").asText();
        run(base,List.of("approve","--id",id,"--fingerprint",hash,"--target","LOCAL_TEST","--reviewer","EXPLICIT LOCAL OWNER TEST FIXTURE","--acknowledge-review"));
        run(base,List.of("activate","--id",id,"--fingerprint",hash,"--target","LOCAL_TEST"));
        var env=new org.springframework.mock.env.MockEnvironment();env.setActiveProfiles("king-local-test");
        try(var approved=new KingCorpus(env,"PRODUCTION",false,store.toString())){
            var a=new RushQuestions(approved);var counts=new TreeMap<String,Integer>();var before=new TreeMap<String,Integer>();
            for(var e:approved.entries("REFLEX")){var i=approved.challenge(e.id());if(RushQuestions.eligible(i))before.merge(i.family()+":"+RushQuestions.classify(i),1,Integer::sum);if(a.qualified(i))counts.merge(i.family()+":"+RushQuestions.classify(i),1,Integer::sum);}
            for(String d:List.of("EASY","MEDIUM","HARD"))for(String t:a.config().topics().get(d))for(int n:List.of(3,8,12,20))assertEquals(n,a.select(new RushDtos.Start(UUID.randomUUID(),d,t,n),Set.of(),19).size());
            Files.writeString(Path.of("target/rush-owner-approved-pool.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(Map.of("channel",approved.channel(),"target","LOCAL_TEST","package",id,"fingerprint",hash,"before",before,"after",counts)));
        }
    }
    static void run(List<String> base,List<String> arguments)throws Exception{
        var command=new ArrayList<>(base);command.addAll(arguments);var p=new ProcessBuilder(command).redirectErrorStream(true).start();String output=new String(p.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);assertEquals(0,p.waitFor(),output);
    }
    @Test @SuppressWarnings("unchecked") void sealedResultsBroadcastBetweenPeriodicTicksToEveryRacer()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var messages=mock(org.springframework.messaging.simp.SimpMessagingTemplate.class);var time=new RushCompetitivePersistenceTest.Time();var service=new RushCompetitiveService(questions,repo,messages,time);
        var view=RushCompetitivePersistenceTest.act(service,1,"create",null);service.act(2,"fixture2","socket2","join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,(String)view.get("invitation"),null,null,null,null,null,null));
        var field=RushCompetitiveService.class.getDeclaredField("rooms");field.setAccessible(true);var room=((Map<UUID,RushCompetitiveService.Room>)field.get(service)).get(view.get("roomId"));
        room.race.status="RUNNING";for(var p:room.race.racers){p.phase="FINISHED";p.checkpoint=room.race.questions.size();p.rank=1;p.finishAt=1;}
        var broadcast=RushCompetitiveService.class.getDeclaredField("broadcastAt");broadcast.setAccessible(true);broadcast.setLong(service,time.ms);
        clearInvocations(messages);service.tick(.01);assertEquals("FINISHED",service.get(1,room.id).get("status"));
        for(String principal:List.of("fixture1","fixture2"))verify(messages).convertAndSendToUser(eq(principal),eq("/queue/quiz-rush"),argThat((Object payload)->((Map<?,?>)((Map<?,?>)payload).get("state")).get("status").equals("FINISHED")),anyMap());
        clearInvocations(messages);service.tick(.01);verifyNoInteractions(messages);service.close();
    }
    @Test @SuppressWarnings("unchecked") void departedTrafficCannotDeactivateOrMutateTheNextRace()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var service=new RushCompetitiveService(questions,repo,mock(org.springframework.messaging.simp.SimpMessagingTemplate.class),new RushCompetitivePersistenceTest.Time());
        var old=RushCompetitivePersistenceTest.act(service,1,"create",null);var field=RushCompetitiveService.class.getDeclaredField("rooms");field.setAccessible(true);var rooms=(Map<UUID,RushCompetitiveService.Room>)field.get(service);var previous=rooms.get(old.get("roomId"));previous.race.status="RUNNING";previous.race.racers.getFirst().phase="RUNNING";
        var command=new RushCompetitiveService.Command(previous.id,previous.race.matchId,UUID.randomUUID(),null,null,null,null,null,null,null,null);
        service.act(1,"fixture1","socket1","leave",command);
        assertNull(service.act(1,"fixture1","socket1","input",command));assertNull(service.act(1,"fixture1","socket1","ping",command));
        var next=RushCompetitivePersistenceTest.act(service,1,"create",null);var current=rooms.get(next.get("roomId"));current.race.status="RUNNING";current.race.racers.getFirst().phase="RUNNING";
        assertNull(service.act(1,"fixture1","old-socket","input",command));assertNull(service.act(1,"fixture1","old-socket","ping",command));
        assertTrue((Boolean)((Map<?,?>)((List<?>)service.get(1,current.id).get("players")).getFirst()).get("connected"));
        var active=new RushCompetitiveService.Command(current.id,current.race.matchId,UUID.randomUUID(),null,null,null,null,null,null,null,null);
        assertEquals("SESSION_REPLACED",assertThrows(RushException.class,()->service.act(1,"fixture1","old-socket","ping",active)).getMessage());
        current.race.status="WAITING";service.act(1,"fixture1","socket1","leave",active);assertEquals("CANCELED",current.race.status);
        assertNull(service.act(1,"fixture1","socket1","input",active));assertNull(service.act(1,"fixture1","socket1","ping",active));service.close();
    }
    @Test void insufficientValidSourceCourseFailsWithoutFabricatingFillers(){
        var empty=mock(KingCorpus.class);when(empty.artifactBacked()).thenReturn(true);when(empty.enabled()).thenReturn(true);when(empty.entries("REFLEX")).thenReturn(List.of());
        var e=assertThrows(RushException.class,()->new RushQuestions(empty).select(new RushDtos.Start(UUID.randomUUID(),"EASY","MIXED",3),Set.of(),1));assertEquals("INSUFFICIENT_QUESTIONS",e.getMessage());
    }
}
