package com.englishcoach.kingofenglish;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import java.time.Clock;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import com.englishcoach.sentinel.SentinelAttempt;
import com.englishcoach.sentinel.SentinelPolicy;
import com.englishcoach.sentinel.SentinelService;
import java.util.*;
import java.util.concurrent.*;
import static com.englishcoach.kingofenglish.KingConfig.*;

/** Single-instance authority. One lock serializes room membership, receipts, ticks and snapshots. */
@Service
public class KingService {
    public static class Rejection extends RuntimeException {
        public final String code; public Rejection(String code){super(code);this.code=code;}
    }
    /** {@code sentinel}: the Echo Sentinel attempt handle "id.secret" of a ranked Soán ngôi launch, kept in the page's memory only. */
    public record Command(String action,String roomCode,String mode,String flow,Integer length,Integer difficulty,
        String bot,String matchId,Integer round,Long revision,String messageId,String answer,List<Integer> order,Integer size,String sentinel) {
        public Command(String action,String roomCode,String mode,String flow,Integer length,Integer difficulty,
            String bot,String matchId,Integer round,Long revision,String messageId,String answer,List<Integer> order){
            this(action,roomCode,mode,flow,length,difficulty,bot,matchId,round,revision,messageId,answer,order,null,null);
        }
        public Command(String action,String roomCode,String mode,String flow,Integer length,Integer difficulty,
            String bot,String matchId,Integer round,Long revision,String messageId,String answer,List<Integer> order,Integer size){
            this(action,roomCode,mode,flow,length,difficulty,bot,matchId,round,revision,messageId,answer,order,size,null);
        }
    }
    static final class Player {
        final long id;final String principal;
        /** Echo Sentinel attempt of this player's ranked Soán ngôi match; null = unranked play. */
        SentinelAttempt sentinel;
        String session;long disconnected,lockUntil,revision,shownAt,botAt,responseMs,rateAt;
        int score,wrong,skipped,completed,rateCount;
        boolean ready,rematch,done,revisiting;
        final ArrayDeque<Integer> queue=new ArrayDeque<>(),deferred=new ArrayDeque<>();
        final List<Integer> correct=new ArrayList<>(),missed=new ArrayList<>();
        // The learner's own last submission per slot (bounded by the slot count) and the slot they resolved last.
        final Map<Integer,String> submitted=new HashMap<>();
        int lastSlot=-1;
        Player(long id,String principal,String session){this.id=id;this.principal=principal;this.session=session;}
    }
    static final class Room {
        final String code,flow,bot,variant;
        String mode;
        final int length,difficulty;
        /** Soán ngôi board size (4–7); 5 for every other mode and for the championship. */
        final int size;
        final LinkedHashMap<Long,Player> players=new LinkedHashMap<>();
        final LinkedHashSet<String> receipts=new LinkedHashSet<>();
        List<String> ids=List.of();
        KingExplainEngine.State explain;
        KingConquestEngine.State conquest;
        UUID match=UUID.randomUUID();
        String status="WAITING",reason;Long winner;
        String contentChannel="ENGINEERING";
        int round; int championshipRound=-1; boolean championshipTransitioned;
        /** Soán ngôi: this match's result rows were handed to the writer / confirmed stored. */
        boolean recorded,resultSaved;
        /** Last ping of a member on the result screen (keeps a finished room for replay / rematch). */
        long keptAt;
        final Map<Long,Integer> championshipTotals=new HashMap<>();
        final List<Map<String,Object>> championshipRounds=new ArrayList<>();
        long revision,seed,created,deadline,started,resolvedAt,ended;
        Room(String code,String mode,String flow,String bot,int length,int difficulty,long now){this(code,mode,flow,bot,length,difficulty,CONQUEST_DEFAULT_SIZE,now);}
        Room(String code,String mode,String flow,String bot,int length,int difficulty,int size,long now){
            this.code=code;this.size=size;this.variant="CHAMPIONSHIP".equals(mode)?"CHAMPIONSHIP":"STANDARD";
            this.mode="CHAMPIONSHIP".equals(mode)?"REFLEX":mode;this.flow=flow;this.bot=bot;this.length=length;this.difficulty=difficulty;created=now;
            this.championshipRound=this.variant.equals("CHAMPIONSHIP")?0:-1;
        }
    }
    public record BotDecision(long delay,boolean correct) {}
    private final KingConquestEngine conquestEngine;private final KingExplainEngine explainEngine;private final KingRoundEngine engine;private final KingPresentationMapper mapper;private final KingBank bank;private final SimpMessagingTemplate messages;private final Clock clock;private final boolean engineering;
    private final Map<String,Room> rooms=new LinkedHashMap<>();private final Map<Long,String> membership=new HashMap<>();
    private KingCorpus corpus;
    private final KingRecentContent recent;
    private String contentChannel;
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"king-deadlines");t.setDaemon(true);return t;});
    @Autowired public KingService(KingBank bank,KingExplainBank explainBank,KingConquestBank conquestBank,LocalGameLexicon lexicon,
        SimpMessagingTemplate messages,Environment environment,KingCorpus corpus){
        this(bank,explainBank,conquestBank,lexicon,messages,Clock.systemUTC(),corpus.enabled());
        this.corpus=corpus;this.contentChannel=corpus.channel();
    }
    KingService(KingBank bank,SimpMessagingTemplate messages,Environment environment,boolean engineering){
        this(bank,new KingExplainBank(),new KingConquestBank(),null,messages,Clock.systemUTC(),engineering && Arrays.stream(environment.getActiveProfiles()).noneMatch(p->Set.of("prod","production").contains(p)));
    }
    KingService(KingBank bank,SimpMessagingTemplate messages,Clock clock,boolean engineering){
        this(bank,new KingExplainBank(),new KingConquestBank(),null,messages,clock,engineering);
    }
    KingService(KingBank bank,KingExplainBank explainBank,KingConquestBank conquestBank,LocalGameLexicon lexicon,SimpMessagingTemplate messages,Clock clock,boolean engineering){
        this.bank=bank;this.engine=new KingRoundEngine(bank);this.explainEngine=new KingExplainEngine(explainBank);
        this.conquestEngine=new KingConquestEngine(conquestBank,lexicon);this.mapper=new KingPresentationMapper(bank,clock,explainEngine,conquestEngine);
        this.messages=messages;this.clock=clock;this.engineering=engineering;
        this.recent=new KingRecentContent(clock);
        this.contentChannel=engineering?"ENGINEERING":"PRODUCTION";
    }
    KingService(KingCorpus corpus,SimpMessagingTemplate messages,Clock clock){
        this(new KingBank(corpus),new KingExplainBank(corpus),new KingConquestBank(corpus),null,messages,clock,corpus.enabled());
        this.corpus=corpus;this.contentChannel=corpus.channel();
    }
    private final ExecutorService boardMaker=Executors.newSingleThreadExecutor(r->{var t=new Thread(r,"king-boards");t.setDaemon(true);t.setPriority(Thread.MIN_PRIORITY);return t;});
    /** Seconds after start-up before the word list and the first boards are made: start-up is the VPS's busiest minute. */
    private static final long BOARD_MAKER_DELAY_S=45;
    @PostConstruct public void init(){
        timer.scheduleWithFixedDelay(()->{try{tick();}catch(Exception ignored){/* bounded next tick */}},100,100,TimeUnit.MILLISECONDS);
        timer.schedule(()->conquestEngine.startBoardMaker(boardMaker),BOARD_MAKER_DELAY_S,TimeUnit.SECONDS);
    }
    @PreDestroy public synchronized void close(){timer.shutdownNow();boardMaker.shutdownNow();rooms.clear();membership.clear();recent.clear();}
    /** Nobody else is waiting on this room: its only clock is the match's own, and a dropped connection costs nothing. */
    private static boolean alone(Room r){return r.flow.equals("SOLO")||r.flow.equals("ECHO");}
    /** A learner's unattended run gives way to a new launch once it is past the grace a duel would give it. Until then, and by rejoin, it stays theirs. */
    private void retireUnattended(Room old,long user,long now){
        if(old==null||old.status.equals("FINISHED")||!alone(old))return;
        var mine=old.players.get(user);
        if(mine==null||mine.disconnected==0||now-mine.disconnected<DISCONNECT_GRACE)return;
        boolean intermission=old.status.equals("INTERMISSION");
        engine.finish(old,"DISCONNECT",other(old,user),now);
        if(intermission)finishChampionshipIntermission(old);
        maybeEnterChampionship(old,now);
        membership.remove(user,old.code);
    }

    public static BotDecision botDecision(String profile,long seed,int slot,int difficulty,int tokens){return KingRoundEngine.botDecision(profile,seed,slot,difficulty,tokens);}
    public synchronized Map<String,Object> act(long user,String principal,String session,Command c){
        if(!engineering||corpus!=null&&!corpus.enabled())throw new Rejection("CONTENT_NOT_APPROVED");
        if(user<=0||principal==null||session==null)throw new Rejection("AUTH_REQUIRED");
        if(c==null||c.action()==null)throw new Rejection("INVALID_ACTION");
        long now=clock.millis();tickAt(now);
        String action=c.action();Room r;
        if(Set.of("start","create","quick").contains(action)){
            retireUnattended(rooms.get(membership.get(user)),user,now);
            String existing=membership.get(user);Room old=rooms.get(existing);
            String requestedMode=c.mode();if(!Set.of("REORDER","REFLEX","EXPLAIN","CONQUEST","CHAMPIONSHIP").contains(Objects.toString(requestedMode,"")))throw new Rejection("INVALID_MODE");
            String mode="CHAMPIONSHIP".equals(requestedMode)?"REFLEX":requestedMode;
            if(corpus!=null&&corpus.artifactBacked()&&(requestedMode.equals("CHAMPIONSHIP")?
                List.of("REFLEX","EXPLAIN","REORDER","CONQUEST").stream().anyMatch(x->corpus.count(x)==0):corpus.count(mode)==0))throw new Rejection("CONTENT_UNAVAILABLE");
            String flow=action.equals("create")?"PRIVATE_ROOM":action.equals("quick")?"QUICK_MATCH":c.flow();
            if(!Set.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM").contains(Objects.toString(flow,""))||
                action.equals("start")&&!Set.of("SOLO","ECHO").contains(flow))throw new Rejection("INVALID_FLOW");
            int difficulty=c.difficulty()==null?0:c.difficulty();if(difficulty<0||difficulty>5)throw new Rejection("INVALID_DIFFICULTY");
            int length=c.length()==null?REORDER_ROUNDS:c.length();if(length<3||length>20)throw new Rejection("INVALID_LENGTH");
            String bot=c.bot()==null?"MEDIUM":c.bot();KingRoundEngine.botDecision(bot,1,0,1,1);
            // Soán ngôi only: the championship and every other mode play the 5×5 board.
            int size=requestedMode.equals("CONQUEST")&&c.size()!=null?c.size():CONQUEST_DEFAULT_SIZE;conquestMs(size);
            // Ranked Soán ngôi: a handle that is present must be usable (checked before any room is touched). Only the page that
            // holds the running attempt of this learner may present it again; anything else is a fresh, unused attempt or refused.
            if(requestedMode.equals("CONQUEST")&&c.sentinel()!=null){
                var running=old==null||old.status.equals("FINISHED")||old.players.get(user)==null?null:old.players.get(user).sentinel;
                if(running==null||sentinel==null||sentinel.resolve(user,c.sentinel())!=running)claim(user,c);
            }
            if(old!=null&&!old.status.equals("FINISHED")){
                boolean sameVariant=old.variant.equals(requestedMode.equals("CHAMPIONSHIP")?"CHAMPIONSHIP":"STANDARD");
                if(!sameVariant||!old.flow.equals(flow)||old.difficulty!=difficulty||old.size!=size||(!old.variant.equals("CHAMPIONSHIP")&&!old.mode.equals(mode)))throw new Rejection("ALREADY_IN_ROOM");
                return attach(old,user,session,c);
            }
            membership.remove(user);
            if(mode.equals("REORDER")||mode.equals("REFLEX"))bank.sequence(mode,difficulty,1,1);
            if((mode.equals("CONQUEST")||requestedMode.equals("CHAMPIONSHIP"))&&!conquestEngine.available())throw new Rejection("LEXICON_UNAVAILABLE");
            if(flow.equals("QUICK_MATCH")){
                r=rooms.values().stream().filter(x->x.flow.equals(flow)&&x.mode.equals(mode)&&x.variant.equals(requestedMode.equals("CHAMPIONSHIP")?"CHAMPIONSHIP":"STANDARD")&&x.difficulty==difficulty&&x.size==size&&
                    x.status.equals("WAITING")&&x.players.size()==1&&x.players.values().stream().allMatch(p->p.disconnected==0))
                    .findFirst().orElse(null);
                if(r!=null){
                    add(r,user,principal,session);bindSentinel(r,user,c);
                    // A compatible pair is already a complete quick-match lobby. Start
                    // immediately so a second player is never left waiting for a
                    // separate Ready click or a missed realtime event.
                    start(r,now);
                    broadcast(r);
                    return mapper.snapshot(r,user);
                }
            }
            if(rooms.size()>=ROOM_CAP)throw new Rejection("SERVER_BUSY");
            String code;do{code=UUID.randomUUID().toString().substring(0,8).toUpperCase(Locale.ROOT);}while(rooms.containsKey(code));
            r=new Room(code,requestedMode,flow,bot,length,difficulty,size,now);r.contentChannel=contentChannel;add(r,user,principal,session);rooms.put(code,r);
            bindSentinel(r,user,c);
            if(flow.equals("ECHO"))r.players.put(0L,new Player(0,null,null));
            if(flow.equals("SOLO")||flow.equals("ECHO"))start(r,now);
            broadcast(r);return mapper.snapshot(r,user);
        }
        String code=Objects.toString(c.roomCode(),"").strip().toUpperCase(Locale.ROOT);
        // Empty rejoin recovers authenticated existing membership; never repeats CREATE.
        if(action.equals("rejoin")&&code.isBlank())code=membership.get(user);
        r=rooms.get(code);if(r==null)throw new Rejection("ROOM_NOT_FOUND");
        if(action.equals("join")){
            if(r.players.containsKey(user)&&Objects.equals(membership.get(user),r.code))return attach(r,user,session,c);
            Room old=rooms.get(membership.get(user));
            if(old!=null&&!old.status.equals("FINISHED"))throw new Rejection("ALREADY_IN_ROOM");
            if(!r.flow.equals("PRIVATE_ROOM")||!r.status.equals("WAITING")||r.players.size()!=1)throw new Rejection("ROOM_FULL");
            if(strict(r))claim(user,c);
            add(r,user,principal,session);bindSentinel(r,user,c);broadcast(r);return mapper.snapshot(r,user);
        }
        Player p=r.players.get(user);
        if(p==null||!Objects.equals(membership.get(user),r.code))throw new Rejection("NOT_A_MEMBER");
        if(action.equals("rejoin"))return attach(r,user,session,c);
        if(!Objects.equals(p.session,session))throw new Rejection("STALE_SESSION");
        if(action.equals("ping")){if(r.status.equals("FINISHED")&&r.started>0)r.keptAt=now;return mapper.snapshot(r,user);}
        if(now-p.rateAt>=1000){p.rateAt=now;p.rateCount=0;}if(++p.rateCount>8)throw new Rejection("RATE_LIMITED");
        switch(action){
            case "ready","continue" -> {
                if(action.equals("continue")){
                    if(!r.match.toString().equals(c.matchId()))throw new Rejection("STALE_MATCH");
                    if(c.messageId()==null||!c.messageId().matches("[A-Za-z0-9-]{1,64}"))throw new Rejection("INVALID_RECEIPT");
                    if(r.receipts.contains(p.id+":"+c.messageId()))break;
                    if(!Objects.equals(c.revision(),p.revision))throw new Rejection("STALE_ROUND");
                    if(!r.status.equals("INTERMISSION"))throw new Rejection("NOT_INTERMISSION");
                    KingCommandRules.receipt(r,p,c);
                }
                if(r.status.equals("INTERMISSION")){
                    p.ready=true;
                    if(r.players.values().stream().filter(x->x.id!=0).allMatch(x->x.ready&&x.disconnected==0))advanceChampionship(r,now);
                    break;
                }
                // Quick-match pairs start as soon as the second member is attached.
                // Keep Ready idempotent so older clients and bookmarked lobbies can
                // safely send their queued click after the transition.
                if(!r.status.equals("WAITING")){
                    if(r.flow.equals("QUICK_MATCH")&&r.status.equals("PLAYING")) break;
                    throw new Rejection("NOT_WAITING");
                }
                p.ready=true;
                if(r.players.size()==2&&r.players.values().stream().allMatch(x->x.ready&&x.disconnected==0))start(r,now);
            }
            case "answer","skip","next","clue","move" -> {
                // A voided ranked attempt scores nothing more, whatever arrives after the void (a late word, a forged command).
                if(p.sentinel!=null&&p.sentinel.voided())throw new Rejection("ATTEMPT_VOIDED");
                int accepted=p.completed;
                if(r.mode.equals("EXPLAIN"))explainEngine.command(r,p,c,now);else if(r.mode.equals("CONQUEST"))conquestEngine.command(r,p,c,now);else {if(!Set.of("answer","skip","next").contains(c.action()))throw new Rejection("INVALID_ACTION");engine.answer(r,p,c,now);}
                if(p.sentinel!=null&&p.completed>accepted)sentinel.action(p.sentinel);
            }
            case "leave" -> {
                boolean intermission=r.status.equals("INTERMISSION");
                if(p.sentinel!=null&&!r.status.equals("FINISHED"))sentinel.voidFromGame(p.sentinel,SentinelAttempt.State.VOIDED_ABANDONED,"EXIT","LEAVE");
                if(!r.status.equals("FINISHED"))engine.finish(r,"FORFEIT",other(r,user),now);
                // A pending rematch vote cannot be answered by someone who left: the other player is shown that, never a wait.
                else r.players.values().forEach(x->x.rematch=false);
                if(intermission)finishChampionshipIntermission(r);
                membership.remove(user,r.code);p.session=null;p.disconnected=now;
            }
            case "rematch" -> {
                if(!r.status.equals("FINISHED"))throw new Rejection("NOT_FINISHED");
                if(!r.match.toString().equals(c.matchId()))throw new Rejection("STALE_MATCH");
                String rematchCode=r.code;
                if(r.players.values().stream().anyMatch(x->x.id!=0&&(x.disconnected>0||!Objects.equals(membership.get(x.id),rematchCode))))
                    throw new Rejection("OPPONENT_LEFT");
                // A ranked rematch is a new attempt: its own acknowledgement and secret, never the previous one.
                if(strict(r)&&c.sentinel()!=null){claim(user,c);p.sentinel=null;bindSentinel(r,user,c);}
                p.rematch=true;
                if(r.players.values().stream().allMatch(x->x.id==0||x.rematch)){
                    if(r.variant.equals("CHAMPIONSHIP")){r.championshipRound=0;r.mode="REFLEX";r.championshipRounds.clear();r.championshipTotals.clear();}
                    start(r,now);
                }
            }
            default -> throw new Rejection("INVALID_ACTION");
        }
        maybeEnterChampionship(r,now);
        r.revision++;broadcast(r);return mapper.snapshot(r,user);
    }
    private void add(Room r,long user,String principal,String session){r.players.put(user,new Player(user,principal,session));membership.put(user,r.code);r.revision++;}
    private Map<String,Object> attach(Room r,long user,String session,Command c){
        var p=r.players.get(user);if(p==null)throw new Rejection("NOT_A_MEMBER");
        // The attempt's secret lives only in the page that opened it: attaching without it means a reload, a closed and
        // reopened tab or a second tab. The ranked attempt ends (the contest cannot be resumed for points).
        if(sentinel!=null&&p.sentinel!=null&&!p.sentinel.terminal()&&!r.status.equals("FINISHED")
            &&sentinel.resolve(user,c==null?null:c.sentinel())!=p.sentinel){
            sentinel.voidFromGame(p.sentinel,SentinelAttempt.State.VOIDED_RELOAD,"REATTACH","SECRET_ABSENT");
            applyVoid(r,clock.millis());
        }
        // tickAt has already resolved an expired disconnect; attach cannot reset a finished match.
        p.session=session;p.disconnected=0;r.revision++;broadcast(r);return mapper.snapshot(r,user);
    }
    // Echo Sentinel (strict-focus ranked Soán ngôi, 10 §BX)
    private SentinelService sentinel;
    @Autowired(required=false) void setSentinel(SentinelService sentinel){this.sentinel=sentinel;sentinel.onVoid(this::sentinelVoided);}
    /** Ranked rooms: Soán ngôi STANDARD (the championship's Conquest round is not ranked). */
    static boolean strict(Room r){return r.mode.equals("CONQUEST")&&r.variant.equals("STANDARD");}
    /** A handle that is present must name a fresh attempt of this learner; absent = unranked play (old clients, practice). */
    private void claim(long user,Command c){
        if(c==null||c.sentinel()==null)return;
        if(sentinel==null)throw new Rejection("SENTINEL_UNAVAILABLE");
        var a=sentinel.resolve(user,c.sentinel());
        if(a==null||!a.activity().equals(SentinelPolicy.KING_CONQUEST)||a.state()!=SentinelAttempt.State.READY)throw new Rejection("SENTINEL_INVALID");
    }
    private void bindSentinel(Room r,long user,Command c){
        if(sentinel==null||c==null||c.sentinel()==null||!strict(r))return;
        var p=r.players.get(user);if(p==null)return;
        var a=sentinel.bind(user,c.sentinel(),SentinelPolicy.KING_CONQUEST,r.code);
        if(a==null)throw new Rejection("SENTINEL_INVALID");
        p.sentinel=a;
        if(r.status.equals("PLAYING"))sentinel.playStarted(a,r.match.toString());
    }
    /** A void decided by the page (or the sweeper): Solo and Echo matches end; in a duel the other player plays on. */
    private void sentinelVoided(SentinelAttempt a){
        synchronized(this){
            for(var r:rooms.values())for(var p:r.players.values())if(p.sentinel==a){applyVoid(r,clock.millis());r.revision++;broadcast(r);return;}
        }
    }
    private void applyVoid(Room r,long now){
        if(alone(r)&&(r.status.equals("PLAYING")||r.status.equals("WAITING")))KingRoundEngine.finish(r,"VOIDED",null,now);
    }

    private void start(Room r,long now){
        boolean championshipRound=r.variant.equals("CHAMPIONSHIP")&&r.championshipRound>0;
        if(!championshipRound){r.match=UUID.randomUUID();r.seed=r.match.getMostSignificantBits();r.receipts.clear();r.recorded=false;r.resultSaved=false;}
        r.round=0;
        int slots=r.mode.equals("CONQUEST")?1:r.mode.equals("EXPLAIN")?EXPLAIN_ROUNDS:r.mode.equals("REFLEX")?REFLEX_SLOTS:(engine.versus(r)?REORDER_ROUNDS+(r.variant.equals("CHAMPIONSHIP")?0:SUDDEN_MAX):r.length);
        r.ids=corpus!=null&&corpus.artifactBacked()?recent.select(corpus,r.mode,r.difficulty,slots,r.seed,r.players.keySet()):Set.of("EXPLAIN","CONQUEST").contains(r.mode)?List.of():bank.sequence(r.mode,r.difficulty,slots,r.seed);
        r.status="PLAYING";r.reason=null;r.winner=null;if(!championshipRound)r.started=now;r.ended=0;r.resolvedAt=0;r.championshipTransitioned=false;r.revision++;
        for(var p:r.players.values()){
            p.score=p.wrong=p.skipped=p.completed=0;p.responseMs=0;p.lockUntil=0;
            if(championshipRound)p.revision++;else p.revision=0;
            p.ready=false;p.rematch=false;p.done=false;p.revisiting=false;p.queue.clear();p.deferred.clear();p.correct.clear();p.missed.clear();
            p.submitted.clear();p.lastSlot=-1;
            for(int x=0;x<r.ids.size();x++)p.queue.add(x);
            p.shownAt=now;if(Set.of("REORDER","REFLEX").contains(r.mode))engine.planBot(r,p,now);
        }
        r.deadline=now+(r.mode.equals("REFLEX")?REFLEX_MS:REORDER_MS);
        r.explain=null;r.conquest=null;
        if(r.mode.equals("EXPLAIN"))explainEngine.start(r,now);else if(r.mode.equals("CONQUEST"))conquestEngine.start(r,now);
        // Ranked play counts from the match clock; an attempt of an earlier match never carries over (its match is over).
        if(sentinel!=null&&strict(r))for(var p:r.players.values()){
            if(p.sentinel!=null&&p.sentinel.state()==SentinelAttempt.State.ACTIVE)sentinel.playStarted(p.sentinel,r.match.toString());
            else p.sentinel=null;
        }
    }

    private static final List<String> CHAMPIONSHIP_MODES=List.of("REFLEX","EXPLAIN","REORDER","CONQUEST");
    /** What a Soán ngôi round of the championship counts as 100 for. A par, not a ceiling: more points count for more. */
    private static final int CONQUEST_PAR=75;
    private int championshipMax(String mode,Room r){
        return switch(mode){case "REFLEX"->r.ids.size();case "EXPLAIN"->r.ids.size()*3;case "REORDER"->Math.min(r.ids.size(),r.flow.equals("SOLO")?r.length:REORDER_ROUNDS)*(r.flow.equals("SOLO")?10:1);case "CONQUEST"->CONQUEST_PAR;default->100;};
    }
    private void maybeEnterChampionship(Room r,long now){
        if(!r.variant.equals("CHAMPIONSHIP")||r.started==0||!r.status.equals("FINISHED")||r.championshipTransitioned)return;
        r.championshipTransitioned=true;
        var max=championshipMax(r.mode,r);
        var roundScores=new LinkedHashMap<String,Object>();roundScores.put("mode",r.mode);roundScores.put("rawMax",max);
        var playerScores=new LinkedHashMap<String,Object>();
        for(var p:r.players.values()){
            int raw=p.score,scaled=max==0?0:Math.max(0,(int)Math.round(raw*100.0/max)),normalized=r.mode.equals("CONQUEST")?scaled:Math.min(100,scaled);
            int total=r.championshipTotals.merge(p.id,normalized,Integer::sum);
            playerScores.put(Long.toString(p.id),Map.of("raw",raw,"normalized",normalized,"total",total));
        }
        roundScores.put("players",playerScores);roundScores.put("reason",r.reason);r.championshipRounds.add(roundScores);
        boolean forfeited=Set.of("FORFEIT","DISCONNECT").contains(r.reason);
        if(forfeited){
            // Preserve earned points, explicitly mark remaining rounds unplayed.
            for(int n=r.championshipRound+1;n<4;n++){
                var zero=new LinkedHashMap<String,Object>();for(var p:r.players.values())zero.put(Long.toString(p.id),Map.of("raw",0,"normalized",0,"total",r.championshipTotals.getOrDefault(p.id,0)));
                r.championshipRounds.add(Map.of("mode",CHAMPIONSHIP_MODES.get(n),"rawMax",0,"players",zero,"reason","UNPLAYED"));
            }
        }
        if(r.championshipRound>=CHAMPIONSHIP_MODES.size()-1||forfeited){
            r.players.forEach((id,p)->p.score=r.championshipTotals.getOrDefault(id,0));
            if(!forfeited){r.winner=KingRoundEngine.scoreWinner(r);r.reason="CHAMPIONSHIP_COMPLETE";}
            r.ended=now;return;
        }
        r.status="INTERMISSION";r.deadline=now+15_000;r.reason="ROUND_COMPLETE";r.resolvedAt=now;
        r.players.values().forEach(p->{p.ready=false;p.revision++;});r.revision++;
    }
    private void advanceChampionship(Room r,long now){
        if(!r.variant.equals("CHAMPIONSHIP")||!r.status.equals("INTERMISSION"))return;
        r.championshipRound++;r.mode=CHAMPIONSHIP_MODES.get(r.championshipRound);r.status="PLAYING";r.resolvedAt=0;r.championshipTransitioned=false;start(r,now);
    }
    private void finishChampionshipIntermission(Room r){
        if(!r.variant.equals("CHAMPIONSHIP"))return;
        for(int n=r.championshipRound+1;n<4;n++){
            var zero=new LinkedHashMap<String,Object>();for(var p:r.players.values())zero.put(Long.toString(p.id),Map.of("raw",0,"normalized",0,"total",r.championshipTotals.getOrDefault(p.id,0)));
            r.championshipRounds.add(Map.of("mode",CHAMPIONSHIP_MODES.get(n),"rawMax",0,"players",zero,"reason","UNPLAYED"));
        }
        r.players.forEach((id,p)->p.score=r.championshipTotals.getOrDefault(id,0));r.championshipTransitioned=true;
    }





    private Long other(Room r,long user){return r.players.keySet().stream().filter(x->x!=user).findFirst().orElse(null);}



    public synchronized void tick(){tickAt(clock.millis());}
    private void tickAt(long now){
        if(corpus!=null)corpus.expireCache();
        if(corpus!=null&&!corpus.enabled())return;
        recent.expire();
        for(var r:new ArrayList<>(rooms.values())){
            long before=r.revision;
            if(r.status.equals("INTERMISSION")){
                var gone=alone(r)?null:r.players.values().stream().filter(p->p.id!=0&&p.disconnected>0&&now-p.disconnected>=DISCONNECT_GRACE).findFirst().orElse(null);
                if(gone!=null){engine.finish(r,"DISCONNECT",other(r,gone.id),now);finishChampionshipIntermission(r);}
                else if(now>=r.deadline)advanceChampionship(r,now);
            } else if(r.status.equals("PLAYING")){
                var gone=alone(r)?null:r.players.values().stream().filter(p->p.id!=0&&p.disconnected>0&&now-p.disconnected>=DISCONNECT_GRACE).findFirst().orElse(null);
                if(gone!=null)engine.finish(r,"DISCONNECT",other(r,gone.id),now);
                else if(r.mode.equals("EXPLAIN"))explainEngine.tick(r,now);else if(r.mode.equals("CONQUEST"))conquestEngine.tick(r,now);else engine.tick(r,now);
                maybeEnterChampionship(r,now);
            }
            if(r.status.equals("WAITING")&&now-r.created>=WAIT_TTL){engine.finish(r,"WAIT_EXPIRED",null,now);}
            if(r.status.equals("WAITING")){
                var gone=r.players.values().stream().filter(p->p.disconnected>0&&now-p.disconnected>=DISCONNECT_GRACE).findFirst().orElse(null);
                if(gone!=null)engine.finish(r,"DISCONNECT",other(r,gone.id),now);
            }
            if(before!=r.revision)broadcast(r);
            // A finished room lives FINISH_TTL after the result, or after the last ping of a member still on its result
            // screen (Luyện lại / Tái đấu stay possible), never beyond FINISH_KEEP_TTL.
            if(r.status.equals("FINISHED")&&(now-r.ended>=FINISH_KEEP_TTL||now-Math.max(r.ended,r.keptAt)>=FINISH_TTL)){
                rooms.remove(r.code);r.players.keySet().forEach(id->membership.remove(id,r.code));
            }
        }
    }
    public synchronized void disconnect(String session){
        if(session==null)return;
        for(var r:rooms.values())for(var p:r.players.values())if(Objects.equals(p.session,session)){
            p.disconnected=clock.millis();r.revision++;broadcast(r);
        }
    }
    private KingConquestResults results;
    @Autowired(required=false) void setResults(KingConquestResults results){this.results=results;}
    /**
     * A Soán ngôi match that ended by time or by the word cap is recorded once per human player from the server's own state.
     * Forfeits, disconnects and championship rounds are not ranked. The write happens on the results writer, never here.
     */
    private void record(Room r){
        if(results==null||r.recorded||!r.status.equals("FINISHED")||!r.mode.equals("CONQUEST")||!r.variant.equals("STANDARD")||r.conquest==null
            ||!Set.of("TIMEOUT","WORD_LIMIT").contains(Objects.toString(r.reason,"")))return;
        r.recorded=true;
        UUID match=r.match;var at=java.time.Instant.ofEpochMilli(r.ended);boolean versus=r.players.size()>1;
        var rows=new ArrayList<KingConquestResults.Row>();
        for(var p:r.players.values()){
            if(p.id==0)continue;
            SentinelAttempt.Change verified=null;
            if(sentinel!=null){
                // Ranked only through a verified attempt (the V119 trigger enforces the same in the database). No attempt, a
                // void, unverifiable continuity or a timing review: the match stays unranked for that player.
                var change=sentinel.complete(p.sentinel);
                if(change==null)continue;
                if(change.to()!=SentinelAttempt.State.COMPLETED_VERIFIED){sentinel.persistLater(change);continue;}
                verified=change;
            }
            rows.add(new KingConquestResults.Row(match,p.id,r.conquest.size,r.flow,p.score,
                (int)r.conquest.history.stream().filter(x->x.playerId()==p.id).count(),KingConquestEngine.territory(r,p.id),
                r.conquest.owners[r.conquest.throne]==p.id,versus?(Boolean)Objects.equals(r.winner,p.id):null,at,verified));
        }
        if(rows.isEmpty())return;
        results.submit(rows,ok->{synchronized(KingService.this){if(ok&&match.equals(r.match)){r.resultSaved=true;r.revision++;broadcast(r);}}});
    }
    public Map<String,Object> conquestBoard(long user,int size,String category){
        if(results==null)throw new Rejection("SERVER_UNAVAILABLE");
        return results.board(user,size,category);
    }
    private void broadcast(Room r){
        record(r);
        for(var p:r.players.values())if(p.id!=0&&p.principal!=null&&Objects.equals(membership.get(p.id),r.code))
            messages.convertAndSendToUser(p.principal,"/queue/king-of-english",Map.of("type","STATE","state",mapper.snapshot(r,p.id)));
    }
    public synchronized Map<String,Object> result(long user,String match){
        tickAt(clock.millis());
        return rooms.values().stream().filter(r->r.match.toString().equals(match)&&r.status.equals("FINISHED")&&r.players.containsKey(user))
            .findFirst().map(r->mapper.snapshot(r,user)).orElseThrow(()->new Rejection("RESULT_NOT_FOUND"));
    }
    public synchronized List<Map<String,Object>> history(long user){
        tickAt(clock.millis());return rooms.values().stream().filter(r->r.status.equals("FINISHED")&&r.players.containsKey(user))
            .sorted(Comparator.comparingLong((Room r)->r.ended).reversed()).limit(20).map(r->mapper.snapshot(r,user)).toList();
    }

    public synchronized Map<String,Integer> memoryState(){
        var state=new LinkedHashMap<String,Integer>();
        state.put("rooms",rooms.size());state.put("memberships",membership.size());state.put("receipts",rooms.values().stream().mapToInt(r->r.receipts.size()).sum());
        state.put("maxReceipt",rooms.values().stream().mapToInt(r->r.receipts.size()).max().orElse(0));
        state.put("challengeIds",rooms.values().stream().mapToInt(r->r.ids.size()).sum());state.put("botTasks",0);
        state.put("conquestBoards",(int)rooms.values().stream().filter(r->r.conquest!=null).count());
        state.put("usedWords",rooms.values().stream().filter(r->r.conquest!=null).mapToInt(r->r.conquest.used.size()).sum());
        state.put("explainClues",rooms.values().stream().filter(r->r.explain!=null).mapToInt(r->r.explain.clues.size()).sum());
        state.put("explainGuessCounters",rooms.values().stream().filter(r->r.explain!=null).mapToInt(r->r.explain.attempts.size()).sum());
        recent.state().forEach((key,value)->state.put("recent"+key,value));
        return state;
    }
    public Map<String,Object> publicConfig(){
        boolean enabled=engineering&&(corpus==null||corpus.enabled());
        var out=new LinkedHashMap<String,Object>(KingConfig.publicConfig());out.put("contentChannel",contentChannel);out.put("playEnabled",enabled);
        var modeAvailability=new LinkedHashMap<String,Boolean>();
        for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))modeAvailability.put(mode,enabled&&(corpus==null||!corpus.artifactBacked()||corpus.count(mode)>0));
        out.put("modeAvailability",modeAvailability);
        if(corpus!=null)out.put("snapshot",corpus.snapshotStatus());
        if(corpus!=null&&corpus.artifactBacked()){out.put("providerCounts",corpus.counts());out.put("attribution",corpus.attribution());}return out;
    }
}
