package com.englishcoach.wordchain;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.security.SecureRandom;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.IntSupplier;
import java.util.random.RandomGenerator;
import static com.englishcoach.wordchain.WordChainRules.*;

/** Single-instance authoritative rooms. All transitions and snapshots share one lock; result writes run outside it. */
@Service
public class WordChainService {
    public record Command(String action, String roomCode, String mode, String difficulty,
                          String word, String messageId, Long revision, String level) {}
    static final class Player {
        final long id; final String name; final String avatarUrl; final String principal;
        final Set<String> used = new HashSet<>();
        final LinkedHashSet<String> messages = new LinkedHashSet<>();
        int rejected; long responseMs; boolean ready; boolean rematch; long disconnected;
        String session;
        long rateStart; int rateCount;
        Player(long id, String name, String avatarUrl, String principal, String session) {
            this.id=id; this.name=name; this.avatarUrl=avatarUrl; this.principal=principal; this.session=session;
        }
    }
    static final class Room {
        final String code; final String mode; final String difficulty; final String level;
        UUID match = UUID.randomUUID();
        final LinkedHashMap<Long, Player> players = new LinkedHashMap<>();
        final Map<String, WordChainLexicon.Word> metadata = new HashMap<>();
        final List<Map<String,Object>> moves = new ArrayList<>();
        String status="WAITING", required, current, reason, startLetter;
        Long turn, winner; long revision, turnRevision, deadline, turnAt, botAt, touched, endedAt;
        boolean saved, saving;
        Room(String code,String mode,String difficulty,String level,long now) {
            this.code=code;this.mode=mode;this.difficulty=difficulty;this.level=level;this.touched=now;
        }
    }
    private final WordChainLexicon lexicon;
    private final WordChainResults results;
    private final SimpMessagingTemplate messaging;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.beans.factory.ObjectProvider<com.englishcoach.leaderboard.board.LeaderboardDisplayRepository> display;
    private final Map<String,Room> rooms = new HashMap<>();
    private volatile int roomCount;
    private final Map<Long,String> membership = new HashMap<>();
    private final Clock clock;
    private final Executor saver;
    private final RandomGenerator random = new SplittableRandom(new SecureRandom().nextLong());
    private static final SecureRandom LETTERS = new SecureRandom();
    /** Every new match starts on an independent, uniformly random letter a–z (server authority). Tests pin it. */
    IntSupplier startLetter = () -> 'a' + LETTERS.nextInt(26);
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t=new Thread(r,"word-chain-deadlines");t.setDaemon(true);return t;
    });
    private final ExecutorService resultWriter = Executors.newSingleThreadExecutor(r -> {
        Thread t=new Thread(r,"word-chain-results");t.setDaemon(true);return t;
    });
    @org.springframework.beans.factory.annotation.Autowired
    public WordChainService(WordChainLexicon lexicon, WordChainResults results, SimpMessagingTemplate messaging) {
        this(lexicon,results,messaging,Clock.systemUTC(),null);
    }
    WordChainService(WordChainLexicon lexicon, WordChainResults results, SimpMessagingTemplate messaging, Clock clock, Executor saver) {
        this.lexicon=lexicon;this.results=results;this.messaging=messaging;this.clock=clock;
        this.saver=saver==null?resultWriter:saver;
    }
    @PostConstruct public void init() {
        timer.scheduleWithFixedDelay(() -> { try { tick(); } catch(Exception ignored) { /* next tick retries */ } },1,1,TimeUnit.SECONDS);
    }
    @PreDestroy public void close() { timer.shutdownNow(); resultWriter.shutdown(); }
    public List<Map<String,Object>> history(long user) { return results.history(user); }
    public String result(long user, UUID match) { return results.result(user, match); }
    /** Public profile name + avatar only (never an e-mail, never client-supplied), read before the room lock. */
    public Map<String,Object> actWithProfile(long user, String principal, String session, Command c) {
        String name = "Học viên #" + user;
        String avatar = null;
        if (c != null && c.action() != null && Set.of("create", "quick", "start", "join").contains(c.action())) {
            try {
                var repository = display == null ? null : display.getIfAvailable();
                var shown = repository == null ? null : repository.find(List.of(user)).get(user);
                if (shown != null) { name = shown.displayName(); avatar = shown.avatarUrl(); }
            } catch (Exception unavailable) { /* the numbered fallback name is used */ }
        }
        return act(user, name, avatar, principal, session, c);
    }
    public Map<String,Object> act(long user,String name,String principal,String session,Command c) {
        return act(user,name,null,principal,session,c);
    }
    public synchronized Map<String,Object> act(long user,String name,String avatarUrl,String principal,String session,Command c) {
        if(c==null || c.action()==null) throw new Rejection("INVALID_ACTION");
        long now=clock.millis();
        Room r;
        if(Set.of("create","quick","start").contains(c.action())) {
            String existing=membership.get(user);
            if(existing!=null && rooms.containsKey(existing)) {
                Room ex = rooms.get(existing);
                if(ex != null && ex.status.equals("FINISHED")) {
                    membership.remove(user);
                } else if(ex != null) {
                    return attach(ex,user,session);
                }
            }
            if(rooms.size()>=2000) throw new Rejection("SERVER_BUSY");
            if(!lexicon.available()) throw new Rejection("DICTIONARY_UNAVAILABLE");
            String mode = c.action().equals("quick") ? "QUICK" : c.action().equals("create") ? "PRIVATE" : c.mode();
            if(!Set.of("SOLO","BOT","PRIVATE","QUICK").contains(Objects.toString(mode,""))) throw new Rejection("INVALID_MODE");
            if(c.action().equals("start") && !Set.of("SOLO","BOT").contains(mode)) throw new Rejection("INVALID_MODE");
            if(mode.equals("QUICK")) {
                r=rooms.values().stream().filter(x->x.mode.equals("QUICK") && x.status.equals("WAITING") && x.players.size()==1)
                        .min(Comparator.comparingLong(x->x.touched)).orElse(null);
                if(r!=null) { add(r,user,name,avatarUrl,principal,session); broadcast(r);return snapshot(r,user); }
            }
            String code; do {code=UUID.randomUUID().toString().replace("-","").substring(0,8).toUpperCase(Locale.ROOT);}while(rooms.containsKey(code));
            String level=mode.equals("BOT") && WordChainBot.LEVELS.contains(Objects.toString(c.level(),"")) ? c.level() : "MEDIUM";
            r=new Room(code,mode,"RELAXED".equals(c.difficulty())?"RELAXED":"STANDARD",level,now);
            add(r,user,name,avatarUrl,principal,session);rooms.put(code,r);roomCount=rooms.size();
            if(mode.equals("BOT")) r.players.put(0L,new Player(0,"Echo",null,null,null));
            if(mode.equals("SOLO") || mode.equals("BOT")) start(r);
            broadcast(r);return snapshot(r,user);
        }
        String code=Objects.toString(c.roomCode(),"").strip().toUpperCase(Locale.ROOT);
        if(!code.matches("[A-F0-9]{8}")) throw new Rejection("INVALID_ROOM");
        r=rooms.get(code); if(r==null) throw new Rejection("ROOM_NOT_FOUND");
        if(c.action().equals("join")) {
            if(r.players.containsKey(user) && Objects.equals(membership.get(user),code)) return attach(r,user,session);
            if(membership.containsKey(user)) {
                String existing = membership.get(user);
                Room ex = rooms.get(existing);
                if (ex == null || ex.status.equals("FINISHED")) {
                    membership.remove(user);
                    // Retain the complete result snapshot for failed-save retries.
                } else {
                    throw new Rejection("ALREADY_IN_ROOM");
                }
            }
            if(!r.mode.equals("PRIVATE") || !r.status.equals("WAITING") || r.players.size()!=1) throw new Rejection("ROOM_FULL");
            add(r,user,name,avatarUrl,principal,session);broadcast(r);return snapshot(r,user);
        }
        Player p=r.players.get(user);if(p==null || !Objects.equals(membership.get(user),code)) throw new Rejection("NOT_A_MEMBER");
        if(c.action().equals("rejoin")) return attach(r,user,session);
        expire(r,now);
        if(c.action().equals("ping")) return snapshot(r,user);
        if(!Objects.equals(p.session,session)) throw new Rejection("STALE_SESSION");
        if(now-p.rateStart>=1000){p.rateStart=now;p.rateCount=0;}
        if(++p.rateCount>8) throw new Rejection("RATE_LIMITED");
        r.touched=now;
        switch(c.action()) {
            case "ready" -> {
                if(!r.status.equals("WAITING")) throw new Rejection("NOT_WAITING");
                p.ready=true;r.revision++;
                if(r.players.size()==2 && r.players.values().stream().allMatch(x->x.ready)) start(r);
            }
            case "submit" -> {
                if(c.messageId()==null || !c.messageId().matches("[a-zA-Z0-9-]{1,64}")) throw new Rejection("INVALID_MESSAGE");
                if(p.messages.contains(c.messageId())) return snapshot(r,user);
                if(!r.status.equals("ACTIVE")) throw new Rejection("NOT_ACTIVE");
                if(!Objects.equals(r.turn,user)) throw new Rejection("NOT_YOUR_TURN");
                // A word belongs to the turn it was typed in. Presence changes (a rival reconnecting) never void it.
                if(c.revision()==null || c.revision()<r.turnRevision) throw new Rejection("STALE_TURN");
                p.messages.add(c.messageId()); if(p.messages.size()>256) p.messages.remove(p.messages.iterator().next());
                try { var word=validate(c.word(),r.required,p.used,r.metadata,lexicon); accept(r,p,word,now); }
                catch(Rejection e) { p.rejected++; throw e; }
            }
            case "give-up" -> { if(r.status.equals("ACTIVE")) finish(r,"GIVE_UP",other(r,user)); }
            case "leave" -> {
                if(r.status.equals("ACTIVE")) finish(r,"FORFEIT",other(r,user));
                membership.remove(user);
                p.session=null;p.disconnected=now;
                if(r.status.equals("WAITING")) { r.players.remove(user);r.revision++; }
                if(r.players.isEmpty()) { rooms.remove(code); roomCount=rooms.size(); }
            }
            case "rematch" -> {
                if(!r.status.equals("FINISHED")) throw new Rejection("NOT_FINISHED");
                if(!r.saved) throw new Rejection("RESULT_SAVING");
                if(r.players.values().stream().anyMatch(x->x.id!=0 && !Objects.equals(membership.get(x.id),code))) throw new Rejection("OPPONENT_LEFT");
                p.rematch=true;r.revision++;
                if(r.players.values().stream().allMatch(x->x.id==0 || x.rematch)) start(r);
            }
            default -> throw new Rejection("INVALID_ACTION");
        }
        broadcast(r);return snapshot(r,user);
    }
    private void add(Room r,long user,String name,String avatarUrl,String principal,String session) {
        r.players.put(user,new Player(user,name,avatarUrl,principal,session));membership.put(user,r.code);r.revision++;
    }
    private Map<String,Object> attach(Room r,long user,String session) {
        Player p=r.players.get(user);if(p==null) throw new Rejection("NOT_A_MEMBER");
        expire(r,clock.millis());p.session=session;p.disconnected=0;r.touched=clock.millis();r.revision++;broadcast(r);return snapshot(r,user);
    }
    private void start(Room r) {
        int letter=startLetter.getAsInt();
        if(letter<'a' || letter>'z') throw new Rejection("SERVER_UNAVAILABLE");
        r.match=UUID.randomUUID();r.moves.clear();r.metadata.clear();
        r.players.values().forEach(p->{p.used.clear();p.messages.clear();p.rejected=0;p.responseMs=0;p.rematch=false;p.ready=false;});
        r.current=null;r.required=String.valueOf((char)letter);r.startLetter=r.required;
        r.status="ACTIVE";r.reason=null;r.winner=null;r.saved=false;r.saving=false;r.endedAt=0;
        r.turn=r.players.keySet().iterator().next();r.revision++;nextDeadline(r,clock.millis());
    }
    private void nextDeadline(Room r,long now) {
        boolean relaxed=r.difficulty.equals("RELAXED");
        r.turnAt=now;r.turnRevision=r.revision;r.deadline=now+(relaxed?45000:30000);
        // Echo answers after its pacing delay plus a little human-like variation (never near the deadline).
        r.botAt=now+(relaxed?6000:2000)+random.nextInt(1200);
    }
    private void accept(Room r,Player p,WordChainLexicon.Word word,long now) {
        p.used.add(word.normalizedWord());p.responseMs+=Math.max(0,now-r.turnAt);
        r.metadata.put(word.normalizedWord(),word);r.current=word.normalizedWord();r.required=last(r.current);
        r.moves.add(Map.of("moveId",r.moves.size()+1,"playerId",p.id,"word",word,"acceptedAt",now));r.revision++;
        if(r.moves.size()>=200) { finish(r,"CHAIN_LIMIT",scoreWinner(r));return; }
        r.turn=r.mode.equals("SOLO")?p.id:other(r,p.id);nextDeadline(r,now);
    }
    private Long other(Room r,long user) { return r.players.keySet().stream().filter(id->id!=user).findFirst().orElse(null); }
    private Long scoreWinner(Room r) {
        var list=new ArrayList<>(r.players.values());
        if(list.size()<2 || list.get(0).used.size()==list.get(1).used.size()) return null;
        return list.get(0).used.size()>list.get(1).used.size()?list.get(0).id:list.get(1).id;
    }
    private void finish(Room r,String reason,Long winner) {
        if(r.status.equals("FINISHED")) return;
        r.status="FINISHED";r.reason=reason;r.winner=winner;r.endedAt=clock.millis();r.revision++;persist(r);
    }
    /** Results are captured under the lock and written by one background writer: no database round trip holds the rooms. */
    private void persist(Room r) {
        if(r.saved || r.saving) return;
        r.saving=true;
        UUID match=r.match;String mode=r.mode;Instant at=Instant.ofEpochMilli(r.endedAt);
        Map<Long,Map<String,Object>> payload=new HashMap<>();
        r.players.values().stream().filter(p->p.id!=0).forEach(p->{var s=snapshot(r,p.id);s.put("resultSaved",true);payload.put(p.id,s);});
        try {
            saver.execute(() -> {
                boolean ok;
                try { results.save(match,mode,payload,at); ok=true; } catch(Exception e) { ok=false; }
                synchronized(WordChainService.this) {
                    if(!match.equals(r.match)) return;
                    r.saving=false;
                    if(ok) { r.saved=true;r.revision++;broadcast(r); }
                }
            });
        } catch(RejectedExecutionException e) { r.saving=false; }
    }
    private void expire(Room r,long now) {
        if(!r.status.equals("ACTIVE")) return;
        var disconnected=r.players.values().stream().filter(p->p.id!=0 && p.disconnected>0)
                .min(Comparator.comparingLong(p->p.disconnected)).orElse(null);
        if(disconnected!=null && now>=disconnected.disconnected+15000 && disconnected.disconnected+15000<r.deadline) {
            finish(r,"DISCONNECT",other(r,disconnected.id));return;
        }
        if(now>=r.deadline) finish(r,"TIMEOUT",other(r,r.turn));
    }
    void tick() {
        if (roomCount == 0) return;
        tickLocked();
    }
    private synchronized void tickLocked() {
        if (rooms.isEmpty()) return;
        long now=clock.millis();
        for(Room r:new ArrayList<>(rooms.values())) {
            long before=r.revision;
            try {
                expire(r,now);
                if(r.status.equals("ACTIVE") && Objects.equals(r.turn,0L) && now>=r.botAt) {
                    Player bot=r.players.get(0L);
                    var chosen=WordChainBot.choose(lexicon,r.required.charAt(0),bot.used,r.level,random);
                    if(chosen==null) finish(r,"BOT_NO_WORD",other(r,0));else accept(r,bot,chosen,now);
                }
                if(r.status.equals("FINISHED") && !r.saved) persist(r);
            } catch(RuntimeException e) {
                // One room's failure never stalls the others; a bot that cannot answer forfeits instead of "thinking" forever.
                if(r.status.equals("ACTIVE") && Objects.equals(r.turn,0L)) finish(r,"BOT_NO_WORD",other(r,0));
            }
            if(before!=r.revision) broadcast(r);
            if((r.status.equals("FINISHED") && now-r.endedAt>1800000) ||
                    (r.status.equals("WAITING") && now-r.touched>300000)) {
                rooms.remove(r.code);roomCount=rooms.size();r.players.keySet().forEach(id->membership.remove(id,r.code));
            }
        }
    }
    public synchronized void disconnect(String session) {
        for(Room r:rooms.values()) for(Player p:r.players.values()) if(Objects.equals(p.session,session) && session!=null) {
            p.disconnected=clock.millis();r.revision++;broadcast(r);
        }
    }
    private void broadcast(Room r) {
        r.players.values().stream().filter(p->p.id!=0 && p.principal!=null && Objects.equals(membership.get(p.id),r.code))
                .forEach(p->messaging.convertAndSendToUser(p.principal,"/queue/word-chain",Map.of("type","STATE","state",snapshot(r,p.id))));
    }
    private Map<String,Object> snapshot(Room r,long viewer) {
        Map<String,Object> s=new LinkedHashMap<>();Player own=r.players.get(viewer);
        s.put("roomCode",r.code);s.put("matchId",r.match.toString());s.put("mode",r.mode);s.put("difficulty",r.difficulty);
        s.put("botLevel",r.mode.equals("BOT")?r.level:null);
        s.put("status",r.status);s.put("revision",r.revision);s.put("youId",viewer);s.put("turnPlayerId",r.turn);
        s.put("currentWord",r.current==null?null:r.metadata.get(r.current));s.put("requiredLetter",r.required);s.put("startLetter",r.startLetter);
        s.put("serverTimestamp",clock.millis());s.put("deadline",r.deadline);s.put("turnStartedAt",r.turnAt);
        s.put("turnSeconds",r.difficulty.equals("RELAXED")?45:30);s.put("winnerId",r.winner);s.put("endReason",r.reason);
        s.put("resultSaved",r.saved);s.put("chainLength",r.moves.size());s.put("acceptedCount",own==null?0:own.used.size());
        s.put("rejectedCount",own==null?0:own.rejected);s.put("averageResponseMs",own==null || own.used.isEmpty()?null:own.responseMs/own.used.size());
        s.put("moves",List.copyOf(r.moves));
        s.put("players",r.players.values().stream().map(p->{
            Map<String,Object> v=new LinkedHashMap<>();
            v.put("id",p.id);v.put("name",p.name);v.put("avatarUrl",p.avatarUrl);v.put("bot",p.id==0);v.put("score",p.used.size()*10);
            v.put("words",p.used.size());v.put("ready",p.ready);v.put("rematch",p.rematch);v.put("connected",p.disconnected==0);
            return v;
        }).toList());
        return s;
    }
}
