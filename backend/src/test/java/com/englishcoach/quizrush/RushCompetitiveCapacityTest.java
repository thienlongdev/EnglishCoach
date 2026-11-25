package com.englishcoach.quizrush;
import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Capacity CPU/projection measurement; mocked persistence and messaging are explicitly reported. */
class RushCompetitiveCapacityTest {
    @Test void bounded64Rooms320RacersAndMeasuredTickCost()throws Exception{
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));when(repo.decode(anyString())).thenAnswer(i->json.readValue((String)i.getArgument(0),RushCompetitiveService.Room.class));
            var time=new RushCompetitivePersistenceTest.Time();var service=new RushCompetitiveService(new RushQuestions(corpus),repo,mock(SimpMessagingTemplate.class),time);var states=new ArrayList<Map<String,Object>>();
            var setup=new RushCompetitiveService.Setup("EASY","MIXED",3,"MEDIUM");
            for(int user=1;user<=64;user++)states.add(service.act(user,"fixture"+user,"socket"+user,"bots",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),setup,null,null,null,null,null,null,null)));
            assertEquals(64,service.metrics().get("rooms"));assertThrows(RushException.class,()->service.act(65,"fixture65","socket65","bots",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),setup,null,null,null,null,null,null,null)));
            var times=new ArrayList<Double>();long heapBefore=Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();int threads=java.lang.management.ManagementFactory.getThreadMXBean().getThreadCount();
            for(int i=0;i<240;i++){if(i%20==0)for(int user=1;user<=64;user++)RushCompetitivePersistenceTest.act(service,user,"ping",states.get(user-1));time.ms+=50;long began=System.nanoTime();service.tick(.05);times.add((System.nanoTime()-began)/1e6);}
            times.sort(Double::compare);var report=new LinkedHashMap<String,Object>();report.put("environment","Local JVM, actual REVIEW_PREVIEW corpus; 64 bot rooms / 320 racers; persistence and messaging mocked. Not production sizing or actual 320 sockets.");report.put("samples",times.size());report.put("meanTickMs",times.stream().mapToDouble(Double::doubleValue).average().orElse(0));report.put("p95TickMs",times.get((int)(times.size()*.95)));report.put("worstTickMs",times.getLast());report.put("heapBefore",heapBefore);report.put("heapAfter",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory());report.put("jvmThreads",threads);report.put("projectionBytes",json.writeValueAsBytes(service.get(1,(UUID)states.getFirst().get("roomId"))).length);report.put("metrics",service.metrics());
            var out=Path.of(System.getProperty("basedir"),"..",System.getProperty("rush.evidence.dir","docs/echo-quiz-rush/evidence/phase3-owner-review"),"capacity.json");Files.createDirectories(out.getParent());Files.writeString(out,json.writerWithDefaultPrettyPrinter().writeValueAsString(report));service.close();
        }
    }
}
