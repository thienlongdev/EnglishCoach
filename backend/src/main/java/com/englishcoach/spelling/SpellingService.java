package com.englishcoach.spelling;

import com.englishcoach.common.AvatarLookCode;
import com.englishcoach.sentinel.*;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.security.SecureRandom;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static com.englishcoach.spelling.SpellingRules.*;
import static com.englishcoach.spelling.SpellingProtocol.*;

/** Bounded single-instance rooms on the existing broker. Durable writes never hold a match lock. */
@Service
public class SpellingService {
    private final SpellingCatalog catalog;private final SpellingResults results;private final SpellingEvents events;private final SentinelService sentinel;
    private final Clock clock;
    private final ConcurrentHashMap<UUID,SpellingMatch> rooms=new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long,UUID> active=new ConcurrentHashMap<>();
    private final Map<Long,long[]> entrances=new HashMap<>();
    private final Object admission=new Object();private final SecureRandom random=new SecureRandom();
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"spelling-clock");t.setDaemon(true);return t;});
    private final ThreadPoolExecutor controls=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(128),r->{var t=new Thread(r,"spelling-control");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    private final ThreadPoolExecutor writer=new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(64),r->{var t=new Thread(r,"spelling-results");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    private long previousTick;
    @Autowired public SpellingService(SpellingCatalog catalog,SpellingResults results,SpellingEvents events,SentinelService sentinel){
        this(catalog,results,events,sentinel,Clock.systemUTC());
        timer.scheduleWithFixedDelay(this::safeTick,100,100,TimeUnit.MILLISECONDS);
    }
    SpellingService(SpellingCatalog catalog,SpellingResults results,SpellingEvents events,SentinelService sentinel,Clock clock){
        this.catalog=catalog;this.results=results;this.events=events;this.sentinel=sentinel;this.clock=clock;previousTick=clock.millis();
    }
    @PreDestroy public void close(){timer.shutdownNow();controls.shutdownNow();writer.shutdown();}
    public Map<String,Object> config(){return Map.of("available",catalog.available(),"capacity",CAPACITY,"answerMs",ANSWER_MS,"sprintMs",SPRINT_MS,"counts",catalog.counts(),"voice","us_female","rules",VERSION);}
    public Records records(long user){return results.records(user);}
    public List<Map<String,Object>> leaderboard(String difficulty){return results.leaderboard(difficulty);}
    public void submit(Runnable work){try{controls.execute(work);}catch(RejectedExecutionException e){throw fail(503,"SPELLING_BUSY");}}
    static ResponseStatusException fail(int status,String code){return new ResponseStatusException(HttpStatus.valueOf(status),code);}
    private static void require(boolean ok,String code){if(!ok)throw fail(409,code);}
    private void limit(long user,long now){synchronized(admission){
        entrances.entrySet().removeIf(e->now-e.getValue()[0]>120000);
        if(entrances.size()>4096)throw fail(503,"SPELLING_BUSY");
        var a=entrances.computeIfAbsent(user,k->new long[]{now,0});
        if(now-a[0]>=60000){a[0]=now;a[1]=0;}if(++a[1]>12)throw fail(429,"JOIN_RATE_LIMIT");
    }}
    private String code(){String letters="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";StringBuilder s=new StringBuilder();for(int i=0;i<8;i++)s.append(letters.charAt(random.nextInt(letters.length())));return s.toString();}
    private SpellingMatch room(long user,UUID id){
        var r=id==null?null:rooms.get(id);if(r==null)throw fail(404,"ROOM_NOT_FOUND");
        synchronized(r){if(!r.members.containsKey(user))throw fail(404,"ROOM_NOT_FOUND");}return r;
    }
    public State state(long user,UUID id){var r=room(user,id);synchronized(r){return r.state(r.members.get(user),clock.millis());}}
    public SpellingCatalog.Clip audio(long user,UUID id,UUID turn){
        var r=room(user,id);synchronized(r){r.delivered(r.members.get(user),turn,clock.millis());return r.word.clip();}
    }
    public SpellingCatalog.Clip phrase(String key){var clip=catalog.phrase(key);if(clip==null)throw fail(404,"AUDIO_NOT_FOUND");return clip;}
    public State act(long user,String session,String action,Command c){
        long now=clock.millis();
        if(Set.of("create","quick","join").contains(action))return enter(user,session,action,c,now);
        if(action.equals("rematch"))return rematch(user,session,c,now);
        if(action.equals("sync")){
            var id=active.get(user);var r=id==null?null:rooms.get(id);
            if(r==null)return null;
            synchronized(r){return r.state(r.members.get(user),now);}
        }
        var r=room(user,c.roomId());
        synchronized(r){
            var m=r.members.get(user);
            if(action.equals("rejoin")){
                if(m.integrity!=null&&!r.terminal()&&sentinel.resolve(user,c.sentinel())!=m.integrity){
                    sentinel.voidFromGame(m.integrity,SentinelAttempt.State.VOIDED_RELOAD,"RELOAD","SPELLING_REJOIN_WITHOUT_SECRET");
                    invalidate(r,m,now,"VOIDED_RELOAD");
                }
                String old=m.session;m.session=session;m.online=true;m.seen=now;m.sequence=-1;m.lastMove=now;
                if(!Objects.equals(old,session))events.send(old,new Event("REPLACED",null,null,null));
                r.changed();return r.state(m,now);
            }
            require(Objects.equals(m.session,session),"SESSION_REPLACED");m.seen=now;
            if(action.equals("ping"))return r.state(m,now);
            if(action.equals("move")){
                r.move(m,c.x()==null?m.x:c.x(),c.z()==null?m.z:c.z(),c.yaw()==null?m.yaw:c.yaw(),c.sequence()==null?-1:c.sequence(),Boolean.TRUE.equals(c.value()),now);
                return null;
            }
            if(action.equals("draft")){
                if(!r.terminal()&&m.integrity!=null&&m.integrity.voided())invalidate(r,m,now,m.integrity.state().name());
                if(r.result!=null&&Objects.equals(r.turnId,c.turnId())&&m==r.active)return null;
                r.draft(m,c.turnId(),c.sequence()==null?-1:c.sequence(),c.text(),now,false);after(r,now);return null;
            }
            require(c.requestId()!=null,"REQUEST_ID_REQUIRED");
            if(m.receipts.contains(c.requestId()))return r.state(m,now);
            switch(action){
                case "ready"->{require(r.phase==Phase.LOBBY,"MATCH_STARTED");
                    if(Boolean.TRUE.equals(c.value())){bind(r,m,c.sentinel());m.ready=true;}
                    else {voidAttempt(m,SentinelAttempt.State.VOIDED_ABANDONED,"NOT_READY");m.ready=false;m.integrity=null;}
                    r.changed();}
                case "start"->{require(m.id.equals(r.host),"HOST_ONLY");r.start(now);}
                case "heard"->r.heard(m,c.turnId(),now);
                case "repeat"->r.repeat(m,c.turnId(),now);
                case "answer"->{if(m.integrity!=null&&m.integrity.voided())invalidate(r,m,now,m.integrity.state().name());
                    if(!(r.result!=null&&Objects.equals(r.turnId,c.turnId())&&m==r.active))r.draft(m,c.turnId(),c.sequence()==null?-1:c.sequence(),c.text(),now,true);}
                case "audio-failed"->{r.current(m,c.turnId());
                    // Delivery failure never eliminates or awards a winner. Explicit retry replays the same clip.
                    require(r.phase==Phase.HEAR||r.phase==Phase.SPELL,"ANSWER_WINDOW_CLOSED");
                    r.abort(now,"AUDIO_DELIVERY_FAILED");}
                case "finish"->{require(r.mode!=Mode.MULTIPLAYER&&!r.terminal(),"NOT_AVAILABLE");r.finish(now,m.id,"STOPPED");}
                case "leave"->{
                    if(!r.terminal()&&r.phase!=Phase.LOBBY){voidAttempt(m,SentinelAttempt.State.VOIDED_ABANDONED,"LEFT");invalidate(r,m,now,"VOIDED_ABANDONED");}
                    else if(r.phase==Phase.LOBBY){voidAttempt(m,SentinelAttempt.State.VOIDED_ABANDONED,"LEFT");r.members.remove(user);
                        if(m.id.equals(r.host))r.host=r.members.values().stream().map(x->x.id).findFirst().orElse(null);}
                    active.remove(user,r.roomId);m.online=false;m.session=null;r.changed();return null;}
                default->throw fail(400,"UNKNOWN_COMMAND");
            }
            m.receipt(c.requestId());
            after(r,now);
            return r.state(m,now);
        }
    }
    private void bind(SpellingMatch r,SpellingMatch.Member m,String handle){
        if(r.mode==Mode.PRACTICE){m.integrityState="PRACTICE";return;}
        var a=sentinel.resolve(m.user,handle);
        require(a!=null&&a.activity().equals(SentinelPolicy.ECHO_SPELLING)&&a.state()==SentinelAttempt.State.READY,"SENTINEL_REQUIRED");
        m.integrity=sentinel.bind(m.user,handle,SentinelPolicy.ECHO_SPELLING,r.matchId.toString());
        require(m.integrity!=null,"SENTINEL_REQUIRED");m.integrityState=m.integrity.state().name();
    }
    private State enter(long user,String session,String action,Command c,long now){
        require(c.requestId()!=null,"REQUEST_ID_REQUIRED");require(catalog.available(),"SPELLING_AUDIO_UNAVAILABLE");
        limit(user,now);
        String name=results.name(user);
        synchronized(admission){
            var prior=active.get(user);if(prior!=null){var old=rooms.get(prior);
                if(old!=null)synchronized(old){var m=old.members.get(user);if(m!=null&&m.receipts.contains(c.requestId()))return old.state(m,now);
                    require(old.terminal()&&old.saved,"ALREADY_IN_ROOM");if(m!=null){m.session=null;m.online=false;}}
                active.remove(user);
            }
            SpellingMatch r=null;
            if(action.equals("join")){
                String requested=Objects.toString(c.code(),"").strip().toUpperCase(Locale.ROOT);
                r=rooms.values().stream().filter(x->x.mode==Mode.MULTIPLAYER&&x.code.equals(requested)&&!x.terminal()).findFirst().orElseThrow(()->fail(404,"ROOM_NOT_FOUND"));
            }else{
                require(c.mode()!=null&&c.difficulty()!=null,"MODE_REQUIRED");
                if(action.equals("quick")){
                    require(c.mode()==Mode.MULTIPLAYER,"INVALID_MODE");
                    r=rooms.values().stream().filter(x->x.publicMatch&&x.difficulty==c.difficulty()&&x.phase==Phase.LOBBY&&x.members.size()<x.capacity).findFirst().orElse(null);
                }
                if(r==null){require(rooms.size()<MAX_ROOMS,"SPELLING_BUSY");
                    int capacity=c.mode()==Mode.MULTIPLAYER?Math.max(2,Math.min(CAPACITY,c.capacity()==null?CAPACITY:c.capacity())):1;
                    r=new SpellingMatch(code(),c.mode(),c.difficulty(),capacity,action.equals("quick"),now,catalog::choose);
                    rooms.put(r.roomId,r);
                }
            }
            synchronized(r){
                require(r.members.size()<r.capacity,"ROOM_FULL");
                var m=new SpellingMatch.Member(user,name,"KAI".equals(c.hero())?"KAI":"LYRA",AvatarLookCode.clean(c.look()),session,now,r.members.size());
                if(r.mode!=Mode.MULTIPLAYER){try{bind(r,m,c.sentinel());}catch(RuntimeException e){rooms.remove(r.roomId);throw e;}m.ready=true;}
                r.add(m);active.put(user,r.roomId);m.receipt(c.requestId());
                if(r.mode!=Mode.MULTIPLAYER)r.start(now);
                return r.state(m,now);
            }
        }
    }
    private State rematch(long user,String session,Command c,long now){
        synchronized(admission){var old=room(user,c.roomId());synchronized(old){
            var host=old.members.get(user);require(host.id.equals(old.host)&&Objects.equals(host.session,session),"HOST_ONLY");
            require(old.mode==Mode.MULTIPLAYER&&old.terminal()&&old.saved,"RESULT_NOT_SAVED");
            require(rooms.size()<MAX_ROOMS,"SPELLING_BUSY");
            var r=new SpellingMatch(old.code,old.mode,old.difficulty,old.capacity,old.publicMatch,now,catalog::choose);
            for(var m:old.members.values())if(m.online&&Objects.equals(active.get(m.user),old.roomId)){
                var next=new SpellingMatch.Member(m.user,m.name,m.hero,m.look,m.session,now,r.members.size());r.add(next);active.put(m.user,r.roomId);
            }
            require(r.members.containsKey(user),"ROOM_NOT_FOUND");r.host=host.id;rooms.put(r.roomId,r);
            // The previous immutable result stays in its old room; old sockets must not receive its subsequent snapshots.
            for(var m:old.members.values()){m.online=false;m.session=null;}
            return r.state(r.members.get(user),now);
        }}
    }
    public void disconnected(String session){long now=clock.millis();for(var r:rooms.values())synchronized(r){for(var m:r.members.values())if(Objects.equals(m.session,session)){m.online=false;m.seen=now;r.changed();}}}
    private void voidAttempt(SpellingMatch.Member m,SentinelAttempt.State state,String reason){
        if(m.integrity!=null&&!m.integrity.terminal())sentinel.voidFromGame(m.integrity,state,reason,reason);
        if(m.integrity!=null)m.integrityState=m.integrity.state().name();
    }
    private void invalidate(SpellingMatch r,SpellingMatch.Member m,long now,String reason){
        m.integrityState=reason;
        if(m.eliminated||m.spectator||r.terminal())return;
        m.eliminated=true;r.changed();
        if(r.mode!=Mode.MULTIPLAYER){r.abort(now,reason);return;}
        var alive=r.order.stream().map(r.members::get).filter(Objects::nonNull).filter(x->!x.eliminated).toList();
        if(r.phase!=Phase.LOBBY&&alive.size()<=1)r.finish(now,alive.isEmpty()?null:alive.getFirst().id,"FORFEIT");
        else if(m==r.active)r.next(now);
    }
    private void after(SpellingMatch r,long now){
        if(r.startedAt>0)for(var m:r.members.values())if(m.integrity!=null&&m.integrityState.equals("ACTIVE")){
            // playStarted is called only once, not on later turns (which would reset continuity).
            if(!startedAttempts.contains(m.integrity.id())){sentinel.playStarted(m.integrity,r.matchId.toString());startedAttempts.add(m.integrity.id());}
        }
        for(var m:r.members.values()){
            if(m.integrity!=null&&m.integrity.voided()&&!m.eliminated&&!r.terminal())invalidate(r,m,now,m.integrity.state().name());
        }
        if(r.result!=null&&!scoredTurns.contains(r.turnId)){
            scoredTurns.add(r.turnId);if(r.active.integrity!=null){
                sentinel.action(r.active.integrity);
                if(r.result.correct()&&r.result.at()-r.openedAt<Math.max(120,r.word.word().length()*15L))r.active.implausiblyFast++;
                else r.active.implausiblyFast=0;
                if(r.active.implausiblyFast>=3)
                    sentinel.voidFromGame(r.active.integrity,SentinelAttempt.State.PENDING_REVIEW,"TIMING_REVIEW","SPELLING_REPEATED_FAST_INPUT");
            }
        }
    }
    private final Set<UUID> startedAttempts=ConcurrentHashMap.newKeySet(),scoredTurns=ConcurrentHashMap.newKeySet();
    private void safeTick(){try{tick();}catch(RuntimeException ignored){/* A transient broker failure must not cancel the authoritative clock. */}}
    void tick(){
        long now=clock.millis(),elapsed=now-previousTick;previousTick=now;
        for(var r:rooms.values()){
            synchronized(r){
                for(var m:r.members.values())if(now-m.seen>LEASE_MS){m.online=false;
                    if(r.phase==Phase.LOBBY){m.ready=false;voidAttempt(m,SentinelAttempt.State.VOIDED_ABANDONED,"DISCONNECTED");}
                    else if(!r.terminal()){voidAttempt(m,SentinelAttempt.State.VOIDED_CONTINUITY,"DISCONNECTED");invalidate(r,m,now,"VOIDED_CONTINUITY");}}
                r.tick(now,elapsed);after(r,now);
                if(r.publicMatch&&r.phase==Phase.LOBBY&&r.members.values().stream().filter(m->m.ready&&m.online&&!m.spectator).count()>=2)r.start(now);
                if(r.dirty&&now-r.lastBroadcast>=100){for(var m:r.members.values())if(m.online)events.send(m.session,new Event("STATE",null,null,r.state(m,now)));r.dirty=false;r.lastBroadcast=now;}
                if(r.terminal()&&!r.saved&&!r.saving&&now>=r.saveRetryAt)saveLater(r);
                if(r.terminal()&&r.saved&&now-r.endedAt>5*60000||r.phase==Phase.LOBBY&&(r.members.isEmpty()||now-r.createdAt>15*60000)){
                    for(var m:r.members.values()){active.remove(m.user,r.roomId);if(m.integrity!=null)startedAttempts.remove(m.integrity.id());}
                    if(r.turnId!=null)scoredTurns.remove(r.turnId);rooms.remove(r.roomId,r);
                }
            }
        }
        // Sets are bounded by active room/turn lifetime; old UUID receipts are not an unbounded history.
        if(scoredTurns.size()>MAX_ROOMS*400)scoredTurns.clear();
    }
    private void saveLater(SpellingMatch r){
        r.saving=true;
        try{writer.execute(()->{
            try{
                List<SpellingResults.Seal> seals=new ArrayList<>();List<SentinelAttempt.Change> decisions;
                synchronized(r){
                    for(var m:r.members.values())if(!m.spectator&&r.order.contains(m.user)){
                        if(m.integrity!=null&&!m.integrity.terminal()){
                            var change=r.phase==Phase.ABORTED?sentinel.voidFromGame(m.integrity,SentinelAttempt.State.VOIDED_INTEGRITY_FAILURE,"ABORTED",r.reason):sentinel.complete(m.integrity);
                            if(change!=null)r.persistenceDecisions.add(change);
                        }
                        m.integrityState=m.integrity==null?"PRACTICE":m.integrity.state().name();
                        boolean eligible=r.phase==Phase.FINISHED&&"COMPLETED_VERIFIED".equals(m.integrityState);
                        var review=r.reviews.stream().filter(x->x.player().equals(m.id)).toList();
                        var run=new Run(r.matchId,r.mode.name(),r.difficulty.name(),m.score,m.correct,m.wrong,m.maxStreak,m.highestWpm,
                            SpellingRules.accuracy(m.correct,m.wrong),r.startedAt==0?0:Math.max(0,r.endedAt-r.startedAt),m.id.equals(r.winner),m.integrityState,Instant.ofEpochMilli(r.endedAt).toString(),review);
                        seals.add(new SpellingResults.Seal(m.user,run,m.integrity==null?null:m.integrity.id(),eligible));
                    }
                    decisions=List.copyOf(r.persistenceDecisions);
                }
                for(var d:decisions)sentinel.persist(d);
                Map<Long,List<String>> broken=new HashMap<>();for(var seal:seals)broken.put(seal.user(),results.save(seal));
                synchronized(r){r.newRecords.putAll(broken);r.saved=true;r.saving=false;r.persistenceDecisions.clear();r.changed();}
            }catch(RuntimeException e){synchronized(r){r.saving=false;r.saveRetryAt=clock.millis()+3000;r.changed();}}
        });}catch(RejectedExecutionException e){r.saving=false;}
    }
}
