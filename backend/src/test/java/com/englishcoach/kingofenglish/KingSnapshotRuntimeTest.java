package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import java.nio.file.*;
import java.time.Clock;
import java.util.*;
import static com.englishcoach.kingofenglish.KingRealtimeTest.*;
import static org.junit.jupiter.api.Assertions.*;

class KingSnapshotRuntimeTest {
    @TempDir static Path store;
    static final String ID="king-corpus-2026-10-05-v3";
    static final ObjectMapper JSON=new ObjectMapper();
    static Path root;
    @BeforeAll static void prepare()throws Exception {
        root=Path.of("").toAbsolutePath();if(!Files.exists(root.resolve("backend/pom.xml")))root=root.getParent();
        cli("validate","--package",root.resolve("docs/king-of-english/corpus/production-review/packages/"+ID).toString(),"--id",ID,"--version","3","--validator-version","king-snapshot-3");
        var state=JSON.readTree(Files.readAllBytes(store.resolve("state.json")));String hash=state.path("snapshots").path(ID).path("fingerprint").asText();
        cli("approve","--id",ID,"--fingerprint",hash,"--target","LOCAL_TEST","--reviewer","EXPLICIT LOCAL OWNER TEST FIXTURE","--acknowledge-review");
        cli("activate","--id",ID,"--fingerprint",hash,"--target","LOCAL_TEST");
    }
    static void cli(String... args)throws Exception {
        var command=new ArrayList<>(List.of("python","-X","utf8",root.resolve("backend/scripts/king/corpus/snapshot.py").toString(),"--store",store.toString()));command.addAll(List.of(args));
        var p=new ProcessBuilder(command).redirectErrorStream(true).start();String output=new String(p.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);assertEquals(0,p.waitFor(),output);
    }
    static KingCorpus active(){return new KingCorpus("PRODUCTION",KingSnapshot.read(store.toString(),false,true));}
    @Test void repairedGroupsAcceptEveryProvenAlternative()throws Exception {
        var proof=JSON.readTree(Files.readAllBytes(root.resolve("docs/king-of-english/corpus/production-review/packages/"+ID+"/corpus-repairs.json")));
        int checked=0;
        try(var corpus=active()){
            var bank=new KingBank(corpus);
            for(var group:proof.path("decisions"))for(var item:group.path("oldItems")){
                String id=item.path("id").asText();assertNotNull(corpus.entry(id));
                for(var answer:group.path("newAccepted")){
                    if(group.path("mode").asText().equals("EXPLAIN")){
                        var target=corpus.explain(id);assertTrue(KingExplainBank.correct(target,answer.asText()),id+" "+answer);
                        assertTrue(KingExplainBank.leaks(target,answer.asText()),"All accepted alternatives remain forbidden in human clues");
                    }else assertTrue(KingBank.correct(bank.get(id),answer.asText(),List.of()),id+" "+answer);
                }
                checked++;
            }
            assertEquals(25,checked);
        }
    }
    @Test void unknownVersionWrongTargetAndPackageTamperingFailClosed()throws Exception {
        byte[] original=Files.readAllBytes(store.resolve(ID+".json"));
        byte[] ledger=Files.readAllBytes(store.resolve("state.json"));
        for(String mutation:List.of("future-validator","wrong-target","lexicon-count","package-binding","shard")){
            Path copy=Files.createTempDirectory("king-final-mutation-");
            try{
                var definition=(ObjectNode)JSON.readTree(original);var state=(ObjectNode)JSON.readTree(ledger);
                var record=(ObjectNode)state.path("snapshots").path(ID);var approval=(ObjectNode)record.path("approval");
                switch(mutation){
                    case "future-validator"->definition.put("validatorVersion","king-snapshot-999");
                    case "wrong-target"->((ObjectNode)state.path("active")).put("target","PRODUCTION");
                    case "lexicon-count"->((ObjectNode)definition.path("report").path("counts").path("LEXICON")).put("valid",1);
                    case "package-binding"->approval.put("validatorVersion","king-snapshot-1");
                    case "shard"->{
                        Path artifacts=copy.resolve("package");Files.createDirectory(artifacts);
                        var fields=definition.path("artifacts").fieldNames();
                        while(fields.hasNext()){String name=fields.next();Path dest=artifacts.resolve(name);Files.createDirectories(dest.getParent());Files.copy(Path.of(record.path("package").asText()).resolve(name),dest);}
                        Files.writeString(artifacts.resolve("king-core.sqlite.gz"),"tampered");record.put("package",artifacts.toString());
                    }
                }
                byte[] bytes=JSON.writeValueAsBytes(definition);String hash=KingSnapshot.sha(bytes);
                record.put("fingerprint",hash);approval.put("fingerprint",hash);((ObjectNode)state.path("active")).put("fingerprint",hash);
                Files.write(copy.resolve(ID+".json"),bytes);Files.write(copy.resolve("state.json"),JSON.writeValueAsBytes(state));
                assertThrows(IllegalStateException.class,()->KingSnapshot.read(copy.toString(),false,true),mutation);
            }finally{
                try(var paths=Files.walk(copy)){for(Path p:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}
            }
        }
    }
    @Test void portableProductionFixtureLoadsAndDeactivationFailsClosed()throws Exception {
        Path host=Files.createTempDirectory("king-portable-production-fixture-");
        try {
            Path ledger=host.resolve("state"),artifacts=host.resolve("packages").resolve(ID);Files.createDirectories(ledger);Files.createDirectories(artifacts);
            byte[] bytes=Files.readAllBytes(store.resolve(ID+".json"));var definition=JSON.readTree(bytes);
            var state=(ObjectNode)JSON.readTree(Files.readAllBytes(store.resolve("state.json")));var record=(ObjectNode)state.path("snapshots").path(ID);
            Path source=Path.of(record.path("package").asText());var names=definition.path("artifacts").fieldNames();
            while(names.hasNext()){String name=names.next();Path dest=artifacts.resolve(name);Files.createDirectories(dest.getParent());Files.copy(source.resolve(name),dest);}
            record.put("package","../packages/"+ID);
            // Synthetic production-scope fixture only; this never approves the candidate/operator ledger.
            var approval=(ObjectNode)record.path("approval");approval.put("target","PRODUCTION");approval.put("kind","HUMAN_PACKAGE_REVIEW");approval.put("reviewer","SYNTHETIC PRODUCTION SCOPE TEST FIXTURE");
            ((ObjectNode)state.path("active")).put("target","PRODUCTION").put("status","PRODUCTION_ACTIVE");
            Files.write(ledger.resolve(ID+".json"),bytes);Files.write(ledger.resolve("state.json"),JSON.writeValueAsBytes(state));
            try(var corpus=new KingCorpus("PRODUCTION",KingSnapshot.read(ledger.toString(),true,false))){
                assertTrue(corpus.enabled());assertEquals("PRODUCTION_ACTIVE",corpus.snapshotStatus().get("activationStatus"));assertEquals(26583,corpus.count("REFLEX"));
                state.putNull("active");Files.write(ledger.resolve("state.json"),JSON.writeValueAsBytes(state));assertFalse(corpus.enabled());
            }
        }finally{try(var paths=Files.walk(host)){for(Path p:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}}
    }
    @Test void exactApprovalAndLocalProductionIsolation()throws Exception {
        assertThrows(IllegalStateException.class,()->KingSnapshot.read(store.toString(),true,true));
        assertThrows(IllegalStateException.class,()->KingSnapshot.read(store.toString(),false,false));
        Path copy=Files.createTempDirectory("king-ledger-test-");
        try {
            byte[] original=Files.readAllBytes(store.resolve("state.json"));Files.copy(store.resolve(ID+".json"),copy.resolve(ID+".json"));
            for(String change:List.of("approval","fingerprint","status")){
                var state=(ObjectNode)JSON.readTree(original);var record=(ObjectNode)state.path("snapshots").path(ID);
                switch(change){case "approval"->record.putNull("approval");case "fingerprint"->((ObjectNode)record.path("approval")).put("fingerprint","0".repeat(64));case "status"->record.put("reviewStatus","AUTO_VALIDATED");}
                Files.write(copy.resolve("state.json"),JSON.writeValueAsBytes(state));assertThrows(IllegalStateException.class,()->KingSnapshot.read(copy.toString(),false,true));
            }
            Files.write(copy.resolve("state.json"),original);Files.writeString(copy.resolve(ID+".json"),"{}");
            assertThrows(IllegalStateException.class,()->KingSnapshot.read(copy.toString(),false,true));
            var state=(ObjectNode)JSON.readTree(original);state.putNull("active");Files.write(copy.resolve("state.json"),JSON.writeValueAsBytes(state));assertNull(KingSnapshot.read(copy.toString(),false,true));
        } finally {Files.deleteIfExists(copy.resolve("state.json"));Files.deleteIfExists(copy.resolve(ID+".json"));Files.delete(copy);}
    }
    @Test void allValidIdsReachableBoundedHistoryAndPerformance()throws Exception {
        System.gc();long heapBefore=Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();long t=System.nanoTime();
        long metaStart=System.nanoTime();var snapshot=KingSnapshot.read(store.toString(),false,true);double metaMs=(System.nanoTime()-metaStart)/1e6;
        try(var corpus=new KingCorpus("PRODUCTION",snapshot)){
            double loadMs=(System.nanoTime()-t)/1e6;
            assertFalse(corpus.preview());assertTrue(corpus.artifactBacked());assertTrue(corpus.enabled());assertEquals("LOCAL_TEST_ACTIVE",corpus.snapshotStatus().get("activationStatus"));
            assertEquals(26583,corpus.count("REFLEX"));assertEquals(2425,corpus.count("EXPLAIN"));assertEquals(2093,corpus.count("REORDER"));assertEquals(150,corpus.count("CONQUEST"));
            assertEquals(150,corpus.sequence("CONQUEST",1,150,17).size(),"Boards do not have a learner difficulty band");
            for(String mode:List.of("REFLEX","EXPLAIN","REORDER","CONQUEST")){
                var ids=corpus.sequence(mode,0,corpus.count(mode),17);assertEquals(corpus.count(mode),new HashSet<>(ids).size());
                assertEquals(new HashSet<>(corpus.entries(mode).stream().map(KingCorpus.Entry::id).toList()),new HashSet<>(ids));
            }
            var history=new KingRecentContent(Clock.systemUTC());var a=history.select(corpus,"REFLEX",0,13,42,List.of(1L,2L));var b=history.select(corpus,"REFLEX",0,13,42,List.of(1L));assertTrue(Collections.disjoint(a,b));
            var seen=new HashSet<String>();long[] samples=new long[500];
            for(int n=0;n<samples.length;n++){long start=System.nanoTime();seen.addAll(history.select(corpus,"REFLEX",0,13,n,List.of(3L)));samples[n]=System.nanoTime()-start;}
            assertTrue(seen.size()>3000,"Corpus must not collapse to tiny repeated subset: "+seen.size());
            Arrays.sort(samples);long boardStart=System.nanoTime();history.select(corpus,"CONQUEST",0,1,19,List.of(3L));double boardMs=(System.nanoTime()-boardStart)/1e6;
            var boards=history.select(corpus,"CONQUEST",0,150,1,List.of(4L));assertEquals(150,new HashSet<>(history.select(corpus,"CONQUEST",0,150,1,List.of(4L))).size());
            System.gc();long heap=Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();
            var report=new LinkedHashMap<String,Object>(Map.of("snapshotMetadataMs",metaMs,"snapshotAndCorpusLoadMs",loadMs,"selectorMedianMs",samples[250]/1e6,"selectorP95Ms",samples[475]/1e6,"boardSelectionMs",boardMs,"heapDeltaBytes",heap-heapBefore,"distinctReflexItemsIn500Matches",seen.size(),"cache",corpus.cacheState()));
            for(int n=0;n<500;n++){long start=System.nanoTime();corpus.challenge(corpus.entries("REFLEX").get(n).id());samples[n]=System.nanoTime()-start;}
            Arrays.sort(samples);report.put("perRoundLookupMedianMs",samples[250]/1e6);report.put("perRoundLookupP95Ms",samples[475]/1e6);
            long boardAt=System.nanoTime();corpus.board(boards.getFirst());report.put("boardLookupMs",(System.nanoTime()-boardAt)/1e6);
            Path output=root.resolve("backend/target/king-snapshot-performance.json");Files.write(output,JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(report));System.out.println("KING_SNAPSHOT_PERFORMANCE "+JSON.writeValueAsString(report));
        }
    }
    @Test void quarantineAndDeactivationRestrictRuntimeSelection()throws Exception {
        Path copy=Files.createTempDirectory("king-quarantine-fixture-");
        try {
            var definition=(ObjectNode)JSON.readTree(Files.readAllBytes(store.resolve(ID+".json")));
            var ids=(com.fasterxml.jackson.databind.node.ArrayNode)definition.path("eligibleIds").path("REFLEX");String excluded=ids.remove(0).asText();
            var counts=(ObjectNode)definition.path("report").path("counts").path("REFLEX");counts.put("valid",counts.path("valid").asInt()-1);counts.put("quarantined",1);
            byte[] bytes=JSON.writeValueAsBytes(definition);Files.write(copy.resolve(ID+".json"),bytes);String hash=KingSnapshot.sha(bytes);
            var state=(ObjectNode)JSON.readTree(Files.readAllBytes(store.resolve("state.json")));var record=(ObjectNode)state.path("snapshots").path(ID);
            record.put("fingerprint",hash);((ObjectNode)record.path("approval")).put("fingerprint",hash);((ObjectNode)state.path("active")).put("fingerprint",hash);Files.write(copy.resolve("state.json"),JSON.writeValueAsBytes(state));
            // Explicit test-only local approval fixture. No production metadata or artifacts are modified.
            try(var corpus=new KingCorpus("PRODUCTION",KingSnapshot.read(copy.toString(),false,true))){
                var service=new KingService(corpus,new org.springframework.messaging.simp.SimpMessagingTemplate((m,t)->true),Clock.systemUTC());
                try {
                assertNull(corpus.entry(excluded));assertThrows(IllegalArgumentException.class,()->corpus.get(excluded));
                assertEquals(26582,corpus.sequence("REFLEX",0,30000,2).size());
                state.putNull("active");Files.write(copy.resolve("state.json"),JSON.writeValueAsBytes(state));assertFalse(corpus.enabled());assertEquals(false,service.publicConfig().get("playEnabled"));
                assertThrows(KingService.Rejection.class,()->corpus.sequence("REFLEX",0,1,2));
                assertThrows(KingService.Rejection.class,()->service.act(1,"p","s",new KingService.Command("start",null,"REFLEX","SOLO",10,0,"MEDIUM",null,null,null,null,null,null)));
                } finally {service.close();}
            }
        }finally{Files.deleteIfExists(copy.resolve("state.json"));Files.deleteIfExists(copy.resolve(ID+".json"));Files.delete(copy);}
    }
    @Test void allSixteenApprovedSnapshotFlowsUseRealBroker()throws Exception {
        try(var app=(ServletWebServerApplicationContext)new SpringApplicationBuilder(Fixture.class).profiles("king-local-test").properties(
            "spring.config.location=optional:classpath:king-fixture-empty.properties","server.port=0","king.content-channel=PRODUCTION","king.snapshot-store="+store,
            "spring.main.banner-mode=off","logging.level.root=WARN").run()){
            assertFalse(app.containsBean("dataSource"));int port=app.getWebServer().getPort();var corpus=app.getBean(KingCorpus.class);var config=app.getBean(KingService.class).publicConfig();
            assertEquals(true,config.get("playEnabled"));assertEquals("LOCAL_TEST_ACTIVE",((Map<?,?>)config.get("snapshot")).get("activationStatus"));
            var response=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/api/v1/king-of-english/config"))
                .timeout(java.time.Duration.ofSeconds(10)).header("Authorization","Bearer king-fixture-1").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(200,response.statusCode());var capabilities=JSON.readTree(response.body());assertTrue(capabilities.path("playEnabled").asBoolean());
            for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))assertTrue(capabilities.path("modeAvailability").path(mode).asBoolean());
            Files.write(root.resolve("backend/target/king-snapshot-capabilities.json"),response.body());
            for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                try(var a=new Peer(port,1);var b=new Peer(port,2)){
                    boolean human=Set.of("QUICK_MATCH","PRIVATE_ROOM").contains(flow);
                    var s=state(a.command(flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",Map.of("mode",mode,"flow",flow,"contentChannel","ENGINEERING")));
                    String code=(String)s.get("roomCode");
                    if(human){state(b.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode",mode):Map.of("roomCode",code)));state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));}
                    s=state(a.command("ping",Map.of("roomCode",code)));assertEquals("PRODUCTION",s.get("contentChannel"));assertEquals("PLAYING",s.get("status"));
                    String payload=JSON.writeValueAsString(s);assertFalse(payload.contains("acceptedAliases"));assertFalse(payload.contains("semanticLinks"));assertFalse(payload.contains("echoCandidates"));
                    if(Set.of("REORDER","REFLEX").contains(mode)){
                        var challenge=(Map<?,?>)s.get("challenge");assertNotNull(corpus.entry((String)challenge.get("id")));assertFalse(challenge.containsKey("answer"));
                        if(human)assertEquals(challenge,state(b.command("ping",Map.of("roomCode",code))).get("challenge"));
                        var item=app.getBean(KingBank.class).get((String)challenge.get("id"));
                        var answer=new HashMap<String,Object>(scope(s));answer.put("answer",item.canonical());
                        if(mode.equals("REORDER")){
                            var remaining=new ArrayList<Integer>();for(int i=0;i<item.tokens().size();i++)remaining.add(i);
                            var order=new ArrayList<Integer>();String canonical=KingBank.normalize(item.canonical());
                            while(!remaining.isEmpty()){
                                final String suffix=canonical;
                                int i=remaining.stream().filter(j->suffix.equals(KingBank.normalize(item.tokens().get(j)))||suffix.startsWith(KingBank.normalize(item.tokens().get(j))+" ")).findFirst().orElseThrow();
                                String token=KingBank.normalize(item.tokens().get(i));order.add(i);remaining.remove(Integer.valueOf(i));canonical=canonical.substring(token.length()).stripLeading();
                            }
                            answer.put("order",order);
                        }else if(!item.tokens().isEmpty())answer= new HashMap<>(truth(app.getBean(KingBank.class),s));
                        var accepted=state(a.command("answer",answer));assertTrue(((Number)accepted.get("score")).intValue()>0);
                    }
                    if(mode.equals("EXPLAIN")){
                        var field=KingService.class.getDeclaredField("rooms");field.setAccessible(true);
                        var room=(KingService.Room)((Map<?,?>)field.get(app.getBean(KingService.class))).get(code);
                        var target=app.getBean(KingExplainBank.class).get(room.ids.get(room.round));
                        Map<String,Object> guess=s;Peer guesser=a;
                        if(human){
                            var clue=new HashMap<String,Object>(scope(s));clue.put("answer","Think about its purpose.");state(a.command("clue",clue));
                            guess=state(b.command("ping",Map.of("roomCode",code)));guesser=b;
                            assertFalse(((Map<?,?>)guess.get("explain")).containsKey("target"));
                        }
                        var answer=new HashMap<String,Object>(scope(guess));answer.put("answer",target.target());
                        assertTrue(((Number)state(guesser.command("answer",answer)).get("score")).intValue()>0);
                    }
                    if(mode.equals("CONQUEST")){
                        var board=(Map<?,?>)s.get("conquest");assertNotNull(board);
                        if(human)assertEquals(board.get("boardId"),((Map<?,?>)state(b.command("ping",Map.of("roomCode",code))).get("conquest")).get("boardId"));
                        var item=app.getBean(KingConquestBank.class).get((String)board.get("boardId"));var candidate=item.echoCandidates().getFirst();
                        var move=new HashMap<String,Object>(scope(s));move.put("answer",candidate.word());move.put("order",candidate.path());
                        var accepted=state(a.command("move",move));assertTrue(((Number)accepted.get("score")).intValue()>0);
                    }
                    state(a.command("leave",Map.of("roomCode",code)));if(human)state(b.command("leave",Map.of("roomCode",code)));
                }
            }
        }
    }
}
