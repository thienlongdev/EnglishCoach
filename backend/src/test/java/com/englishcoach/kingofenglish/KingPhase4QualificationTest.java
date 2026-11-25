package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

/** Isolated local measurements, not production capacity or human skill evidence. */
class KingPhase4QualificationTest {
    @org.junit.jupiter.api.io.TempDir Path evidenceDir;
    void evidence(String name,Object data)throws Exception {
        Path dir=evidenceDir;
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(dir.resolve(name).toFile(),data);
    }
    static Map<String,Object> percentiles(List<Long> samples) {
        var sorted=samples.stream().sorted().toList();
        return Map.of("samples",sorted.size(),"p50Ms",sorted.get((sorted.size()-1)/2)/1e6,
            "p95Ms",sorted.get((int)((sorted.size()-1)*.95))/1e6,"p99Ms",sorted.get((int)((sorted.size()-1)*.99))/1e6,"maxMs",sorted.getLast()/1e6);
    }
    @Test void exactSQLiteEligibilityIsolatedAndConcurrent()throws Exception {
        var lexicon=KingConquestTest.localLexicon();var boards=new KingConquestBank();
        var words=boards.all().stream().flatMap(b->b.echoCandidates().stream()).map(KingConquestBank.Candidate::word).distinct().toList();
        var isolated=new ArrayList<Long>();
        for(int n=0;n<100;n++)lexicon.lookupConquest(words.get(n%words.size()));
        for(int n=0;n<1000;n++){long start=System.nanoTime();assertTrue(lexicon.lookupConquest(words.get(n%words.size())).isPresent());isolated.add(System.nanoTime()-start);}
        var concurrent=Collections.synchronizedList(new ArrayList<Long>());var pool=Executors.newFixedThreadPool(8);
        try {
            var jobs=new ArrayList<Callable<Void>>();
            for(int thread=0;thread<8;thread++){final int offset=thread; jobs.add(()->{for(int n=0;n<250;n++){long start=System.nanoTime();assertTrue(lexicon.lookupConquest(words.get((n+offset)%words.size())).isPresent());concurrent.add(System.nanoTime()-start);}return null;});}
            for(var future:pool.invokeAll(jobs))future.get(30,TimeUnit.SECONDS);
        }finally{pool.shutdownNow();}
        evidence("sqlite-profile.json",Map.of("isolated",percentiles(isolated),"concurrent8Threads",percentiles(concurrent),
            "method","Actual Java LocalGameLexicon.lookupConquest -> canonical read-only SQLite, 100 warm-up calls, shared 3000-entry eligibility LRU/15-minute TTL; cold keys execute SQLite and subsequent hits reuse eligibility. Includes synchronized queue waiting.","productionCapacityClaim",false));
    }
    KingService.Command command(String action,Map<String,Object> s,String mode,String text,List<Integer> order){
        return new KingService.Command(action,s==null?null:(String)s.get("roomCode"),mode,"PRIVATE_ROOM",20,0,"MEDIUM",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),text,order);
    }
    @Test void mixed100And500RoomsLatencyPayloadCleanup()throws Exception {
        var cpu=(com.sun.management.OperatingSystemMXBean)java.lang.management.ManagementFactory.getOperatingSystemMXBean();
        long cpuStart=cpu.getProcessCpuTime(),wallStart=System.nanoTime();
        var time=new KingServiceTest.Time();var boards=new KingConquestBank();
        var service=new KingService(new KingBank(),new KingExplainBank(),boards,KingConquestTest.localLexicon(),new SimpMessagingTemplate((m,t)->true),time,true);
        var create=new ArrayList<Long>();var move=new ArrayList<Long>();var ping=Collections.synchronizedList(new ArrayList<Long>());var states=new ArrayList<Map<String,Object>>();
        var payloads=new TreeMap<String,Integer>();var report=new LinkedHashMap<String,Object>();
        try {
            for(int n=0;n<500;n++){
                String mode=List.of("REORDER","REFLEX","EXPLAIN","CONQUEST").get(n%4);long host=n*2L+1,guest=host+1,start=System.nanoTime();
                var s=service.act(host,"p"+host,"s"+host,command("create",null,mode,null,null));
                service.act(guest,"p"+guest,"s"+guest,command("join",s,mode,null,null));
                service.act(host,"p"+host,"s"+host,command("ready",s,mode,null,null));service.act(guest,"p"+guest,"s"+guest,command("ready",s,mode,null,null));
                create.add(System.nanoTime()-start);s=service.act(host,"p"+host,"s"+host,command("ping",s,mode,null,null));
                if(mode.equals("CONQUEST")){
                    var view=(Map<?,?>)s.get("conquest");var b=boards.get((String)view.get("boardId"));var c=b.echoCandidates().getFirst();
                    start=System.nanoTime();s=service.act(host,"p"+host,"s"+host,command("move",s,mode,c.word(),c.path()));move.add(System.nanoTime()-start);
                }else if(mode.equals("EXPLAIN"))s=service.act(host,"p"+host,"s"+host,command("clue",s,mode,"Think about where people use this object.",null));
                states.add(s);payloads.merge(mode,new ObjectMapper().writeValueAsBytes(s).length,Math::max);
                if(n==99)report.put("rooms100",service.memoryState());
            }
            report.put("rooms500",service.memoryState());var pool=Executors.newFixedThreadPool(8);
            try {
                var jobs=new ArrayList<Callable<Void>>();
                for(int thread=0;thread<8;thread++){final int offset=thread;jobs.add(()->{for(int n=0;n<125;n++){
                    int index=(n*8+offset)%500;long user=index*2L+1,start=System.nanoTime();var s=states.get(index);
                    service.act(user,"p"+user,"s"+user,command("ping",s,(String)s.get("mode"),null,null));ping.add(System.nanoTime()-start);
                }return null;});}
                for(var f:pool.invokeAll(jobs))f.get(60,TimeUnit.SECONDS);
            }finally{pool.shutdownNow();}
            time.ms+=KingConfig.CONQUEST_MS+1;service.tick(); // Conquest finishes, other modes retain bounded next rounds.
            for(int n=0;n<500;n++){long user=n*2L+1;var s=states.get(n);service.act(user,"p"+user,"s"+user,command("leave",s,(String)s.get("mode"),null,null));}
            report.put("afterFinish",service.memoryState());time.ms+=KingConfig.FINISH_TTL+1;long start=System.nanoTime();service.tick();report.put("cleanupMs",(System.nanoTime()-start)/1e6);
            assertTrue(service.memoryState().values().stream().allMatch(x->x==0));report.put("afterCleanup",service.memoryState());
            report.put("createJoinReady",percentiles(create));report.put("moveProcessing",percentiles(move));report.put("concurrentPing",percentiles(ping));report.put("activePayloadBytes",payloads);
            report.put("modeMix","125 two-human rooms per mode, 1000 memberships, actual move/clue acceptance then eight concurrent ping callers. Single JVM coordinator lock; non-retaining transport.");
            report.put("queueExecutor","Eight fixed test workers; bounded finite submission; production ticker ownership unchanged. Production saturation/CPU qualification UNVERIFIED.");
            report.put("processCpuMs",(cpu.getProcessCpuTime()-cpuStart)/1e6);
            report.put("wallMs",(System.nanoTime()-wallStart)/1e6);
            report.put("productionCapacityClaim",false);evidence("mixed-load.json",report);
        }finally{service.close();}
    }
    @Test void seededActualEngineEchoBalance()throws Exception {
        var bank=new KingBank();var explain=new KingExplainBank();var boards=new KingConquestBank();var lexicon=KingConquestTest.localLexicon();
        var output=new TreeMap<String,Object>();
        for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST")){
            var profiles=new LinkedHashMap<String,Object>();
            for(String profile:List.of("EASY","MEDIUM","HARD","KING")){
                int playerWins=0,echoWins=0,draws=0;long gap=0,wrong=0,completed=0,skip=0;double wordPercent=0,territoryPercent=0,thronePercent=0;
                var solves=new ArrayList<Long>();var familyErrors=new TreeMap<String,Integer>();var familyReached=new TreeMap<String,Integer>();var stages=new TreeMap<String,Integer>();
                var difficultyReached=new TreeMap<String,Integer>();var difficultySolved=new TreeMap<String,Integer>();
                var resolvedRoundsByDifficulty=new TreeMap<String,Integer>();var humanSolvedRoundsByDifficulty=new TreeMap<String,Integer>();
                var familyTimes=new TreeMap<String,List<Long>>();var humanScores=new ArrayList<Integer>();
                int revisits=0,sudden=0,timeouts=0;long finalScores=0,territoryCount=0,acceptedWords=0;
                for(int seed=0;seed<80;seed++){
                    var rng=new Random(7000L+seed);var r=new KingService.Room("SIM",mode,"ECHO",profile,10,0,100_000);r.seed=seed+120;
                    var human=new KingService.Player(1,"simulation","test");var bot=new KingService.Player(0,null,null);r.players.put(1L,human);r.players.put(0L,bot);
                    r.status="PLAYING";r.started=100_000;r.deadline=r.started+(mode.equals("REFLEX")?KingConfig.REFLEX_MS:KingConfig.REORDER_MS);
                    var rounds=new KingRoundEngine(bank);var meaning=new KingExplainEngine(explain);var conquest=new KingConquestEngine(boards,lexicon);
                    if(mode.equals("EXPLAIN"))meaning.start(r,r.started);
                    else if(mode.equals("CONQUEST"))conquest.start(r,r.started);
                    else {r.ids=bank.sequence(mode,0,mode.equals("REFLEX")?13:13,r.seed);for(var p:r.players.values()){for(int n=0;n<r.ids.size();n++)p.queue.add(n);p.shownAt=r.started;rounds.planBot(r,p,r.started);}}
                    long nextHuman=r.started+6000+rng.nextInt(12000);int previousRound=-1;
                    for(long now=r.started+250;r.status.equals("PLAYING")&&now<r.started+600_000;now+=250){
                        if(mode.equals("EXPLAIN"))meaning.tick(r,now);else if(mode.equals("CONQUEST"))conquest.tick(r,now);else rounds.tick(r,now);
                        if(!r.status.equals("PLAYING")||r.resolvedAt>0||human.done)continue;
                        if(previousRound!=r.round&&mode.equals("REORDER")){previousRound=r.round;nextHuman=now+3500+rng.nextInt(4500)+bank.get(r.ids.get(r.round)).difficulty()*700L;}
                        if(previousRound!=r.round&&mode.equals("EXPLAIN")){previousRound=r.round;nextHuman=now+6000+rng.nextInt(12000);}
                        if(now<nextHuman||now<human.lockUntil)continue;
                        if(mode.equals("CONQUEST")){
                            var b=boards.get(r.conquest.boardId);var options=b.echoCandidates().stream().filter(c->!r.conquest.used.contains(c.word())).toList();
                            if(!options.isEmpty()){var c=options.get(rng.nextInt(options.size()));conquest.command(r,human,cmd(r,human,"move",c.word(),c.path()),now);}
                            nextHuman=now+3500+rng.nextInt(3500);
                        }else if(mode.equals("EXPLAIN")){
                            var i=explain.get(r.ids.get(r.round));boolean correct=rng.nextDouble()<.82;
                            if(correct)stages.merge(String.valueOf(r.explain.clueIndex),1,Integer::sum);
                            meaning.command(r,human,cmd(r,human,"answer",correct?i.target():"unknown answer",null),now);
                            nextHuman=now+6000+rng.nextInt(12000);if(correct)solves.add(now-r.explain.roundStarted);
                        }else {
                            int slot=mode.equals("REORDER")?r.round:human.queue.peek();var item=bank.get(r.ids.get(slot));boolean correct=rng.nextDouble()<(.91-item.difficulty()*.055);
                            String action=mode.equals("REFLEX")&&!human.revisiting&&rng.nextDouble()<.1?"skip":"answer";
                            var order=correct?java.util.stream.IntStream.range(0,item.tokens().size()).boxed().toList():List.of(-1);
                            long shownAt=human.shownAt;if(human.revisiting)revisits++;
                            rounds.answer(r,human,cmd(r,human,action,correct?item.canonical():"wrong answer",order),now);
                            familyReached.merge(item.family(),1,Integer::sum);if(!correct&&action.equals("answer"))familyErrors.merge(item.family(),1,Integer::sum);
                            difficultyReached.merge(String.valueOf(item.difficulty()),1,Integer::sum);
                            familyTimes.computeIfAbsent(item.family(),x->new ArrayList<>()).add((now-shownAt)*1_000_000);
                            if(correct&&action.equals("answer"))difficultySolved.merge(String.valueOf(item.difficulty()),1,Integer::sum);
                            if(correct&&action.equals("answer"))solves.add(now-shownAt);nextHuman=now+2500+rng.nextInt(3000)+item.difficulty()*500L;
                        }
                    }
                    assertEquals("FINISHED",r.status,mode+"/"+profile);
                    humanScores.add(human.score);if(mode.equals("REORDER")&&r.round>KingConfig.REORDER_ROUNDS)sudden++;
                    if(mode.equals("REORDER"))for(int slot=0;slot<Math.min(human.completed,r.ids.size());slot++){
                        String difficulty=String.valueOf(bank.get(r.ids.get(slot)).difficulty());resolvedRoundsByDifficulty.merge(difficulty,1,Integer::sum);
                        if(human.correct.contains(slot))humanSolvedRoundsByDifficulty.merge(difficulty,1,Integer::sum);
                    }
                    if("TIMEOUT".equals(r.reason))timeouts++;
                    if(Objects.equals(r.winner,1L))playerWins++;else if(Objects.equals(r.winner,0L))echoWins++;else draws++;
                    gap+=human.score-bot.score;wrong+=human.wrong;completed+=human.completed;skip+=human.skipped;
                    if(r.conquest!=null){finalScores+=human.score+bot.score;territoryCount+=KingConquestEngine.territory(r,1);acceptedWords+=r.conquest.used.size();int total=human.score+bot.score;if(total>0){int words=r.conquest.wordPoints.values().stream().mapToInt(Integer::intValue).sum();int territories=(int)Arrays.stream(r.conquest.owners).filter(x->x!=-1).count()*KingConfig.CONQUEST_TERRITORY_POINT;int throne=r.conquest.owners[12]!=-1?KingConfig.CONQUEST_THRONE_BONUS:0;
                        wordPercent+=100.0*words/total;territoryPercent+=100.0*territories/total;thronePercent+=100.0*throne/total;}}
                }
                var result=new LinkedHashMap<String,Object>();result.put("matches",80);result.put("playerWins",playerWins);result.put("echoWins",echoWins);result.put("draws",draws);result.put("meanPlayerMinusEchoScore",gap/80.0);
                result.put("meanCompleted",completed/80.0);result.put("meanWrong",wrong/80.0);result.put("meanSkips",skip/80.0);result.put("familyReached",familyReached);result.put("familyErrors",familyErrors);result.put("clueStageSolves",stages);
                result.put("humanScores",humanScores);result.put("revisitAttempts",revisits);result.put("suddenDeathMatches",sudden);result.put("terminalTimeoutMatches",timeouts);
                result.put("attemptsByDifficulty",difficultyReached);result.put("successfulAttemptsByDifficulty",difficultySolved);
                result.put("resolvedRoundsByDifficulty",resolvedRoundsByDifficulty);result.put("humanSolvedRoundsByDifficulty",humanSolvedRoundsByDifficulty);
                var timing=new TreeMap<String,Object>();familyTimes.forEach((k,v)->timing.put(k,percentiles(v)));result.put("responseMsByFamily",timing);
                if(mode.equals("CONQUEST")){result.put("meanFinalScorePerPlayer",finalScores/160.0);result.put("meanHumanTerritory",territoryCount/80.0);result.put("meanAcceptedWordsTotal",acceptedWords/80.0);}
                if(!solves.isEmpty())result.put("learnerSolveMs",percentiles(solves.stream().map(x->x*1_000_000).toList()));
                if(mode.equals("CONQUEST"))result.put("meanScoreCompositionPercent",Map.of("word",wordPercent/80,"territory",territoryPercent/80,"throne",thronePercent/80));profiles.put(profile,result);
            }output.put(mode,profiles);
        }
        output.put("method","80 seeded simulations per mode/profile, actual mode engine/tick/answer/move and canonical lookup. Explicit synthetic learner reaction/accuracy/skip model; not measured learner behavior or calibrated difficulty. Echo pool <=32 bounds Conquest model; full-board stress evaluated separately.");
        evidence("balance.json",output);
    }
    KingService.Command cmd(KingService.Room r,KingService.Player p,String action,String answer,List<Integer> order){
        int slot=r.mode.equals("CONQUEST")?0:r.mode.equals("REFLEX")?p.queue.peek():r.round;
        return new KingService.Command(action,r.code,r.mode,r.flow,10,0,r.bot,r.match.toString(),slot,r.mode.equals("CONQUEST")?r.revision:p.revision,UUID.randomUUID().toString(),answer,order);
    }
}
