package com.englishcoach.quizrush;

import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.simp.*;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.security.SecureRandom;
import static com.englishcoach.quizrush.RushCompetition.*;

/** Single-instance room authority with one bounded ticker, private projections and durable receipts. */
@Service
public class RushCompetitiveService {
    public record Setup(String difficulty,String topic,int checkpoints,String botLevel) {}
    /** `invitation`: a private room's 32-hex invitation or its 6-character room code. `hero`: LYRA / KAI (anything else = LYRA). */
    public record Command(UUID roomId,UUID matchId,UUID requestId,Setup setup,String invitation,
                          Boolean ready,String targetId,String skill,Input input,UUID questionId,UUID optionId,String hero,String look) {
        public Command(UUID roomId,UUID matchId,UUID requestId,Setup setup,String invitation,Boolean ready,String targetId,String skill,Input input,UUID questionId,UUID optionId,String hero){
            this(roomId,matchId,requestId,setup,invitation,ready,targetId,skill,input,questionId,optionId,hero,null);}
        public Command(UUID roomId,UUID matchId,UUID requestId,Setup setup,String invitation,Boolean ready,String targetId,String skill,Input input,UUID questionId,UUID optionId){
            this(roomId,matchId,requestId,setup,invitation,ready,targetId,skill,input,questionId,optionId,null);}
    }
    /** Cosmetic hero allow-list: the browser can name only one of the two models it ships; nothing else is stored or shown. */
    static String hero(String value){return "KAI".equals(value)?"KAI":"LYRA";}
    /**
     * Short private-room codes: 6 characters from an alphabet without look-alikes (no 0/O, 1/I/L), drawn with SecureRandom
     * and unique among open rooms. A code is only another way to name the room's invitation: it resolves through the same
     * join (authenticated, rate-limited, 15-minute window, WAITING only) and stops working when the room closes or starts.
     */
    static final String CODE_ALPHABET="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    static String normalizeCode(String value){if(value==null)return "";var b=new StringBuilder();for(char ch:value.toUpperCase(Locale.ROOT).toCharArray())if(ch>='A'&&ch<='Z'||ch>='0'&&ch<='9')b.append(ch);return b.toString();}
    private String newCode(){for(int attempt=0;attempt<64;attempt++){var b=new StringBuilder();for(int i=0;i<6;i++)b.append(CODE_ALPHABET.charAt(random.nextInt(CODE_ALPHABET.length())));String code=b.toString();
        if(rooms.values().stream().noneMatch(r->!terminal(r)&&code.equals(r.code)))return code;}throw new RushException(503,"ROOM_CAPACITY");}
    public record Receipt(String command,boolean correct) {}
    public static class Room {
        public UUID id,createRequest,successor;public long owner,createdAt,updatedAt,savedAt;
        public String invitation,mode="PRIVATE",recovery="",code="";public Setup setup;
        public Race race=new Race();public Map<String,Receipt> receipts=new LinkedHashMap<>();
        public Set<Long> rematch=new HashSet<>();
        public Room(){}
    }
    private record Binding(String principal,String session,UUID roomId) {}
    private static class Rate {long at;int count;}
    private final RushQuestions questions;private final RushCompetitiveRepository repo;private final SimpMessagingTemplate messages;private final Clock clock;private final RushExposure recent;
    private final SecureRandom random=new SecureRandom();private final Map<UUID,Room> rooms=new LinkedHashMap<>();
    private final Map<Long,UUID> membership=new HashMap<>();private final Map<Long,Binding> sockets=new HashMap<>();
    private final LinkedHashMap<Long,Rate> rates=new LinkedHashMap<>(),joins=new LinkedHashMap<>(),inputRates=new LinkedHashMap<>();
    private ScheduledExecutorService ticker;private volatile boolean loaded;private volatile int roomCount;private long lastNano,broadcastAt,tickIndex,firstNano,scheduledTicks;
    /*
     * Persistence never runs under the room lock. The production database is a network round trip away per statement (~0.1 s;
     * one room write is 4–8 statements), and this one lock serves every tick and every command of every room: a write held
     * inside it froze all races for 0.5–0.9 s (no snapshots, no input, a capped tick that lost race time — the stalls and
     * backward snaps players saw). Under the lock a room is only captured (`Stored`); commands write it after the lock and
     * before their acknowledgement, ticks hand it to `store` (coalesced per room). Reads of rooms not in memory happen
     * before the lock (`Prefetch`).
     */
    private record Write(long seq,RushCompetitiveRepository.Stored first,RushCompetitiveRepository.Stored second) {}
    /** `exposure`: the question sources the creating account (a rematch: the room owner) met recently, read before the lock. */
    private record Prefetch(UUID roomId,Room room,boolean missing,boolean priorRead,Room prior,Set<String> exposure,Race prepared) {}
    private final Executor store;
    private final Map<UUID,Object> gates=new ConcurrentHashMap<>();private final Map<UUID,Long> written=new ConcurrentHashMap<>();private final Map<UUID,Write> waiting=new ConcurrentHashMap<>();
    private final Map<UUID,String> lastStored=new HashMap<>();private final Map<UUID,Long> failedSeq=new HashMap<>();
    private long serial;private List<Write> pending,tickOut;private Prefetch prefetched;
    public long ticks,totalTickNanos,maxTickNanos,snapshots,persistenceWrites;
    /*
     * What a racer waits for, not only what a tick computes: the ticker's lateness against its fixed 50 ms schedule, the
     * time a tick and a command (movement input apart) wait for the room lock, and the broadcast time. The tick duration
     * alone hid a 600 ms wait for the lock behind a 0.3 ms simulation (Codex audit 2026-10-25).
     */
    private long maxTickLateNanos,maxTickWaitNanos,totalTickWaitNanos,maxInputWaitNanos,maxCommandWaitNanos,maxPublishNanos;
    /** Longest time each kind of command held the room lock (what everyone else waited for). */
    private final Map<String,Long> maxHoldNanos=new TreeMap<>();
    @Autowired public RushCompetitiveService(RushQuestions questions,RushCompetitiveRepository repo,SimpMessagingTemplate messages,RushExposure recent){this(questions,repo,messages,Clock.systemUTC(),recent,storePool());}
    RushCompetitiveService(RushQuestions questions,RushCompetitiveRepository repo,SimpMessagingTemplate messages,Clock clock){this(questions,repo,messages,clock,user->Set.of());}
    RushCompetitiveService(RushQuestions questions,RushCompetitiveRepository repo,SimpMessagingTemplate messages,Clock clock,RushExposure recent){this(questions,repo,messages,clock,recent,Runnable::run);}
    RushCompetitiveService(RushQuestions questions,RushCompetitiveRepository repo,SimpMessagingTemplate messages,Clock clock,RushExposure recent,Executor store){this.questions=questions;this.repo=repo;this.messages=messages;this.clock=clock;this.recent=recent==null?user->Set.of():recent;this.store=store;}
    private static Executor storePool(){var pool=new ThreadPoolExecutor(3,3,30,TimeUnit.SECONDS,new LinkedBlockingQueue<>(),r->{var t=new Thread(r,"quiz-rush-store");t.setDaemon(true);return t;});pool.allowCoreThreadTimeOut(true);return pool;}
    /**
     * One 20 Hz ticker at a fixed rate (not a fixed delay, which drifted by each tick's own duration and spaced the 10 Hz
     * snapshots 100–150 ms apart): every second tick broadcasts, so clients receive an even snapshot cadence.
     */
    @PostConstruct public void startTicker(){lastNano=firstNano=System.nanoTime();ticker=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"quiz-rush-tick");t.setDaemon(true);return t;});ticker.scheduleAtFixedRate(()->{try{if(!loaded||roomCount==0){scheduledTicks++;return;}long n=System.nanoTime();maxTickLateNanos=Math.max(maxTickLateNanos,n-(firstNano+(++scheduledTicks)*50_000_000L));double dt=(n-lastNano)/1e9;lastNano=n;tick(Math.min(.25,dt));}catch(Exception ignored){/* Fail closed per room; no payload/secret logs. */}},50,50,TimeUnit.MILLISECONDS);}
    @PreDestroy public synchronized void close(){if(ticker!=null)ticker.shutdownNow();for(var room:rooms.values())if(!terminal(room))try{repo.save(room);}catch(Exception ignored){}sockets.clear();membership.clear();rooms.clear();roomCount=0;}
    private long now(){return clock.millis();}
    /** Rooms left open by a previous process: read once, before the lock (a database read), installed under it. */
    private void ensureLoaded(){if(loaded)return;var existing=repo.recover();synchronized(this){load(existing);}}
    private void load(List<Room> existing){if(loaded)return;require(existing.size()<=64,"ROOM_CAPACITY");for(var r:existing){r.recovery="SERVER_RECOVERED";r.savedAt=now();r.updatedAt=now();for(var p:r.race.racers){p.horizontal=0;p.forward=0;p.target=null;p.sprint=false;p.inputAt=-100;if(!p.bot()){p.connected=false;p.seenAt=r.race.elapsed;membership.put(p.userId,r.id);}}rooms.put(r.id,r);}
        // Private rooms saved before room codes existed get one (rooms still open for joining only).
        for(var r:existing)if(r.mode.equals("PRIVATE")&&(r.code==null||r.code.isEmpty())&&r.race.status.equals("WAITING"))r.code=newCode();roomCount=rooms.size();loaded=true;}
    private static boolean terminal(Room r){return Set.of("FINISHED","CANCELED").contains(r.race.status);}
    private void limit(LinkedHashMap<Long,Rate> map,long user,int count,long window){long n=now();var rate=map.computeIfAbsent(user,k->new Rate());if(n-rate.at>=window){rate.at=n;rate.count=0;}if(++rate.count>count)throw new RushException(429,"RATE_LIMITED");while(map.size()>2048)map.remove(map.keySet().iterator().next());}
    private void valid(Setup s){require(s!=null&&Set.of("EASY","MEDIUM","HARD").contains(s.difficulty())&&Set.of("MIXED","VOCABULARY","WORD_RELATIONS","SPELLING","GRAMMAR","WORD_USE","PHRASAL_VERBS","IDIOMS_EXPRESSIONS").contains(s.topic())&&Set.of(3,8,12,20).contains(s.checkpoints())&&(s.botLevel()==null||Set.of("EASY","MEDIUM","HARD").contains(s.botLevel())),"INVALID_SETUP");require(questions.available(),"CONTENT_UNAVAILABLE");}
    /** Capture the room for writing (under the lock); the write happens after the lock (see `store`). */
    private void save(Room room){var w=capture(room);if(pending!=null)pending.add(w);else if(tickOut!=null)tickOut.add(w);else later(w);}
    private Write capture(Room room){var s=RushCompetitiveRepository.capture(room,repo.encode(room));room.savedAt=now();persistenceWrites++;lastStored.put(room.id,s.snapshot());return new Write(++serial,s,null);}
    /** Background write of a tick's capture; only the newest capture of a room still waiting is written. */
    private void later(Write w){UUID id=w.first().id();if(waiting.put(id,w)==null)store.execute(()->{var next=waiting.remove(id);if(next!=null)try{persist(next);}catch(RuntimeException ignored){/* marked unavailable; the tick retries */}});}
    /** Write outside the room lock. Captures of one room are written in order; an older one never overwrites a newer one. */
    private void persist(Write w){
        var ids=new ArrayList<UUID>();ids.add(w.first().id());if(w.second()!=null)ids.add(w.second().id());ids.sort(null);
        try{guarded(ids,0,w);}catch(RuntimeException e){failed(w);throw e;}stored(w);
    }
    private void guarded(List<UUID> ids,int i,Write w){
        if(i<ids.size()){synchronized(gates.computeIfAbsent(ids.get(i),k->new Object())){guarded(ids,i+1,w);}return;}
        var a=w.first();var b=w.second();boolean first=w.seq()>written.getOrDefault(a.id(),0L),second=b!=null&&w.seq()>written.getOrDefault(b.id(),0L);
        if(first&&second)repo.writeRematch(a,b);else if(first)repo.write(a);else if(second)repo.write(b);
        if(first)written.put(a.id(),w.seq());if(second)written.put(b.id(),w.seq());
    }
    private static List<RushCompetitiveRepository.Stored> parts(Write w){return w.second()==null?List.of(w.first()):List.of(w.first(),w.second());}
    private synchronized void stored(Write w){for(var s:parts(w)){Long failed=failedSeq.get(s.id());if(failed!=null&&w.seq()>failed){failedSeq.remove(s.id());var r=rooms.get(s.id());if(r!=null&&r.recovery.equals("PERSISTENCE_UNAVAILABLE")){r.recovery="";r.race.revision++;}}}}
    private synchronized void failed(Write w){for(var s:parts(w)){failedSeq.merge(s.id(),w.seq(),Math::max);var r=rooms.get(s.id());if(r!=null&&!r.recovery.equals("PERSISTENCE_UNAVAILABLE")){r.recovery="PERSISTENCE_UNAVAILABLE";r.updatedAt=now();r.race.revision++;}}}
    private synchronized boolean cached(UUID id){return rooms.containsKey(id);}
    /** What a rematch of a room in memory would be planned from: owner, setup and the sources of its race (a copy). */
    private record RematchBasis(long owner,Setup setup,Set<String> sources) {}
    private synchronized RematchBasis rematchBasis(UUID id){var r=id==null?null:rooms.get(id);if(r==null)return null;var sources=new HashSet<String>();r.race.questions.forEach(q->sources.add(q.sourceId()));return new RematchBasis(r.owner,r.setup,sources);}
    /**
     * Work a command may need, done before the lock: database reads (a room not in memory, a create request seen before,
     * the recent question exposure a new race is chosen against — the creator's; a rematch: the room owner's) and the
     * new race itself (question selection and course plan). Both used to run inside the lock: an exposure read held every
     * room's ticks and input for its round trip, and the first race of a process took ~2 s to select and plan (the
     * fixture measured a tick waiting 1.96 s behind one Echo Bots creation).
     */
    private Prefetch prefetch(long user,String action,Command c){
        if(c==null)return null;boolean create=Set.of("create","bots","quick").contains(action)&&c.requestId()!=null;
        Room prior=create?repo.byRequest(user,c.requestId()):null,room=null;boolean missing=false;UUID id=c.roomId();
        if(id!=null&&!create&&!"join".equals(action)&&!cached(id))try{room=repo.get(user,id);}catch(RushException e){missing=true;}
        Set<String> exposure=null;Race prepared=null;
        if(create&&prior==null){valid(c.setup());exposure=recent.recent(user);prepared=newRace(c.requestId(),c.setup(),exposure);}
        else if("rematch".equals(action)&&c.requestId()!=null){var basis=rematchBasis(id);if(basis!=null){exposure=recent.recent(basis.owner());var seen=new HashSet<>(exposure);seen.addAll(basis.sources());prepared=newRace(c.requestId(),basis.setup(),seen);}}
        return new Prefetch(id,room,missing,create,prior,exposure,prepared);
    }
    /** A new version 7 race for a setup, avoiding `seen` question sources (pure CPU; no shared state). */
    private Race newRace(UUID request,Setup s,Set<String> seen){
        var r=new Race(RushQuestions.escalate(questions.select(new RushDtos.Start(request,s.difficulty(),s.topic(),s.checkpoints()),seen,random.nextLong())),random.nextLong(),s.difficulty(),HARDCORE);r.contentVersion=questions.version();return r;
    }
    /** The rematch race prepared before the lock for this room, if still current. */
    private Race prepared(UUID roomId){var pre=prefetched;return pre!=null&&pre.prepared()!=null&&Objects.equals(pre.roomId(),roomId)&&pre.prepared().contentVersion.equals(questions.version())?pre.prepared():null;}
    /** Exposure for a new race: the prefetched read (never a database round trip under the lock from `act`). */
    private Set<String> exposure(long user){var pre=prefetched;return pre!=null&&pre.exposure()!=null?pre.exposure():recent.recent(user);}
    private Racer racer(Room r,long user){return r.race.racers.stream().filter(p->Objects.equals(p.userId,user)).findFirst().orElseThrow(()->new RushException(404,"ROOM_NOT_FOUND"));}
    private Room room(long user,UUID id){if(id==null)id=membership.get(user);if(id==null)throw new RushException(404,"ROOM_NOT_FOUND");var r=rooms.get(id);
        if(r==null){var pre=prefetched;if(pre!=null&&id.equals(pre.roomId())){if(pre.missing())throw new RushException(404,"ROOM_NOT_FOUND");r=pre.room();}else r=repo.get(user,id);cache(r);}racer(r,user);return r;}
    private void bind(Room r,long user,String principal,String socket){var p=racer(r,user);sockets.put(user,new Binding(principal,socket,r.id));if(!p.terminal()){p.connected=true;p.seenAt=r.race.elapsed;p.inputAt=-100;p.horizontal=0;p.forward=0;p.target=null;p.sprint=false;}r.updatedAt=now();}
    private void bound(long user,String session){var b=sockets.get(user);require(b!=null&&b.session.equals(session),"SESSION_REPLACED");}
    private void forget(Room r){rooms.remove(r.id);roomCount=rooms.size();lastStored.remove(r.id);failedSeq.remove(r.id);written.remove(r.id);gates.remove(r.id);for(var p:r.race.racers)if(!p.bot()&&!membership.containsKey(p.userId)){var binding=sockets.get(p.userId);if(binding!=null&&binding.roomId.equals(r.id))sockets.remove(p.userId,binding);}}
    private void trimCache(){while(rooms.size()>=80){var old=rooms.values().stream().filter(RushCompetitiveService::terminal).findFirst().orElse(null);require(old!=null,"ROOM_CAPACITY");forget(old);}}
    private void cache(Room r){trimCache();rooms.put(r.id,r);roomCount=rooms.size();}
    private void availableSlot(){require(rooms.values().stream().filter(r->!terminal(r)).count()<64,"ROOM_CAPACITY");}
    private Room create(long user,Command c,String mode){
        require(c.requestId()!=null,"REQUEST_REQUIRED");valid(c.setup());var prior=prefetched!=null&&prefetched.priorRead()?prefetched.prior():repo.byRequest(user,c.requestId());
        if(prior!=null){require(prior.mode.equals(mode)&&prior.setup.equals(c.setup()),"REQUEST_REUSED");if(!rooms.containsKey(prior.id))cache(prior);return rooms.get(prior.id);}
        require(!membership.containsKey(user),"ALREADY_IN_ROOM");availableSlot();trimCache();var r=new Room();r.id=UUID.randomUUID();r.createRequest=c.requestId();r.owner=user;r.createdAt=r.updatedAt=r.savedAt=now();r.mode=mode;r.setup=c.setup();
        byte[] bytes=new byte[16];random.nextBytes(bytes);r.invitation=HexFormat.of().formatHex(bytes);if(mode.equals("PRIVATE"))r.code=newCode();
        var pre=prefetched;var ready=pre!=null&&pre.priorRead()&&pre.prepared()!=null&&pre.prepared().contentVersion.equals(questions.version())?pre.prepared():null;
        r.race=ready!=null?ready:newRace(c.requestId(),r.setup,exposure(user));
        var player=new Racer("p1",user,"Explorer 1",null);player.ready=mode.equals("QUICK")||mode.equals("BOTS");player.hero=hero(c.hero());player.look=com.englishcoach.common.AvatarLookCode.clean(c.look());r.race.racers.add(player);
        if(mode.equals("BOTS")){for(int i=2;i<=5;i++){var bot=new Racer("p"+i,null,"Echo "+(i-1),Objects.toString(r.setup.botLevel(),"MEDIUM"));bot.ready=true;bot.hero=i%2==0?"KAI":"LYRA";r.race.racers.add(bot);}start(r.race);}
        if(mode.equals("QUICK"))r.race.status="QUEUED";
        save(r);rooms.put(r.id,r);roomCount=rooms.size();membership.put(user,r.id);return r;
    }
    private void join(Room r,long user,String hero){join(r,user,hero,null);}
    private void join(Room r,long user,String hero,String look){require(Set.of("WAITING","QUEUED").contains(r.race.status),"MATCH_STARTED");require(r.race.racers.size()<5,"ROOM_FULL");require(!membership.containsKey(user),"ALREADY_IN_ROOM");
        int slot=1;while(true){String candidate="p"+slot;if(r.race.racers.stream().noneMatch(p->p.id.equals(candidate)))break;slot++;}
        var p=new Racer("p"+slot,user,"Explorer "+slot,null);p.ready=r.mode.equals("QUICK");p.hero=hero(hero);p.look=com.englishcoach.common.AvatarLookCode.clean(look);r.race.racers.add(p);membership.put(user,r.id);r.race.revision++;r.updatedAt=now();}
    public Map<String,Object> act(long user,String principal,String session,String action,Command c){
        ensureLoaded();var pre=prefetch(user,action,c);List<Write> out;Map<String,Object> result;long asked=System.nanoTime();
        synchronized(this){long waited=System.nanoTime()-asked;if("input".equals(action))maxInputWaitNanos=Math.max(maxInputWaitNanos,waited);else maxCommandWaitNanos=Math.max(maxCommandWaitNanos,waited);
            pending=new ArrayList<>();prefetched=pre;long held=System.nanoTime();try{result=actLocked(user,principal,session,action,c);}finally{out=pending;pending=null;prefetched=null;if(RushCompetitiveChannelGuard.ACTIONS.contains(action))maxHoldNanos.merge(action,System.nanoTime()-held,Math::max);}}
        // The acknowledgement follows the write (a command is durable when its answer arrives), but no other room waits for it.
        for(var w:out)try{persist(w);}catch(RuntimeException e){throw new RushException(503,"ROOM_UNAVAILABLE");}
        return result;
    }
    private Map<String,Object> actLocked(long user,String principal,String session,String action,Command c){
        // Movement leases have their own budget (a held key, a change of keys and a jump each send one at once); every
        // other command keeps the original 24 a second.
        if("input".equals(action))limit(inputRates,user,40,1000);else limit(rates,user,24,1000);require(c!=null,"INVALID_COMMAND");
        Room r;
        if(Set.of("create","bots","quick").contains(action)){
            if(membership.containsKey(user)){r=room(user,null);require(r.mode.equals(action.equals("create")?"PRIVATE":action.equals("bots")?"BOTS":"QUICK")&&r.setup.equals(c.setup()),"ALREADY_IN_ROOM");bind(r,user,principal,session);return view(r,user);}
            if(action.equals("quick")){
                valid(c.setup());r=rooms.values().stream().filter(v->v.mode.equals("QUICK")&&v.setup.equals(c.setup())&&v.race.status.equals("QUEUED")&&v.race.racers.size()<5&&now()-v.createdAt<90000).findFirst().orElse(null);
                if(r!=null){String before=repo.encode(r);try{join(r,user,c.hero(),c.look());if(r.race.racers.size()==5)start(r.race);save(r);}catch(RuntimeException e){rollback(r,before);throw e;}}
                else r=create(user,c,"QUICK");
            }else r=create(user,c,action.equals("bots")?"BOTS":"PRIVATE");
            bind(r,user,principal,session);publish(r);return view(r,user);
        }
        if(action.equals("join")){
            limit(joins,user,8,60000);String invitation=c.invitation()==null?"":c.invitation().trim();
            boolean link=invitation.matches("[a-f0-9]{32}");String code=link?"":normalizeCode(invitation);
            require(link||code.length()==6&&code.chars().allMatch(ch->CODE_ALPHABET.indexOf(ch)>=0),"ROOM_NOT_FOUND");
            // A code names only a room still open for joining; an unknown, closed or started room is the same 404 as a wrong link.
            r=rooms.values().stream().filter(v->v.mode.equals("PRIVATE")&&(link?v.invitation.equals(invitation):code.equals(v.code))&&now()-v.createdAt<900000&&!terminal(v)).findFirst().orElseThrow(()->new RushException(404,"ROOM_NOT_FOUND"));
            if(!membership.containsKey(user)){String before=repo.encode(r);try{join(r,user,c.hero(),c.look());save(r);}catch(RuntimeException e){rollback(r,before);throw e;}}
            else require(membership.get(user).equals(r.id),"ALREADY_IN_ROOM");bind(r,user,principal,session);publish(r);return view(r,user);
        }
        r=room(user,c.roomId());var p=racer(r,user);
        if(action.equals("rejoin")){require(!membership.containsKey(user)||membership.get(user).equals(r.id),"ALREADY_IN_ROOM");
            // Before the race the hero may still change (a reload after a new choice); a running race keeps its models.
            if(c.hero()!=null&&Set.of("WAITING","QUEUED").contains(r.race.status)&&(!hero(c.hero()).equals(p.hero)||(c.look()!=null&&!com.englishcoach.common.AvatarLookCode.clean(c.look()).equals(p.look)))){p.hero=hero(c.hero());if(c.look()!=null)p.look=com.englishcoach.common.AvatarLookCode.clean(c.look());r.race.revision++;save(r);}
            bind(r,user,principal,session);publish(r);return view(r,user);}
        // Leased input/ping already in flight may arrive after an acknowledged leave.
        // They cannot affect a departed racer or replace the account's new room/socket.
        if(Set.of("input","ping").contains(action)&&(terminal(r)||p.terminal())&&!Objects.equals(membership.get(user),r.id))return null;
        bound(user,session);
        if(action.equals("ping")){if(!p.terminal()){p.seenAt=r.race.elapsed;p.connected=true;}return view(r,user);}
        require(!r.recovery.equals("PERSISTENCE_UNAVAILABLE"),"ROOM_UNAVAILABLE");
        if(action.equals("input")){require(Objects.equals(c.matchId(),r.race.matchId),"MATCH_CHANGED");input(r.race,p,c.input());return null;}
        require(c.requestId()!=null,"REQUEST_REQUIRED");String key=user+":"+c.requestId();String command=commandHash(action+":"+c.matchId()+":"+c.ready()+":"+c.targetId()+":"+c.skill()+":"+c.questionId()+":"+c.optionId());
        var receipt=r.receipts.get(key);if(receipt!=null){require(receipt.command.equals(command),"REQUEST_REUSED");if(action.equals("leave")){sockets.remove(user);return Map.of("left",true);}return view(r.successor==null?r:room(user,r.successor),user);}
        require(Objects.equals(c.matchId(),r.race.matchId),"MATCH_CHANGED");require(action.equals("leave")||r.receipts.keySet().stream().filter(k->k.startsWith(user+":")).count()<512,"COMMAND_LIMIT");
        if(Set.of("answer","dash","rush","skill").contains(action))require(questions.available()&&r.race.contentVersion.equals(questions.version()),"CONTENT_CHANGED");
        if(action.equals("leave")&&!membership.containsKey(user)&&p.terminal()){sockets.remove(user);return Map.of("left",true);}
        String before=repo.encode(r);Room parent=null;Long kicked=null;boolean correct=false;
        try{
            switch(action){
                case "ready"->{require(r.race.status.equals("WAITING"),"MATCH_STARTED");p.ready=Boolean.TRUE.equals(c.ready());}
                case "start"->{require(r.owner==user&&r.mode.equals("PRIVATE"),"HOST_ONLY");start(r.race);}
                case "kick"->{require(r.owner==user&&r.race.status.equals("WAITING"),"HOST_ONLY");var victim=target(r,c.targetId());require(victim!=p&&!victim.bot(),"INVALID_TARGET");r.race.racers.remove(victim);membership.remove(victim.userId);kicked=victim.userId;}
                case "answer"->correct=answer(r.race,p,c.questionId(),c.optionId());
                case "dash","rush"->boost(r.race,p,action);
                case "skill"->skill(r.race,p,target(r,c.targetId()),c.skill());
                case "leave"->{if(Set.of("WAITING","QUEUED").contains(r.race.status)){if(r.owner==user){r.race.status="CANCELED";r.race.reason="HOST_LEFT";}else r.race.racers.remove(p);}else forfeit(r.race,p);membership.remove(user);}
                case "rematch"->{require(r.race.status.equals("FINISHED")&&r.race.racers.stream().noneMatch(v->v.phase.equals("DNF")),"REMATCH_UNAVAILABLE");r.rematch.add(user);boolean all=true;for(var v:r.race.racers)if(!v.bot()&&!r.rematch.contains(v.userId))all=false;if(all){availableSlot();
                    var next=prepared(r.id);if(next==null){var seen=new HashSet<String>(exposure(r.owner));r.race.questions.forEach(q->seen.add(q.sourceId()));next=newRace(c.requestId(),r.setup,seen);}
                    var successor=new Room();successor.id=UUID.randomUUID();successor.owner=r.owner;successor.createRequest=c.requestId();successor.invitation=UUID.randomUUID().toString().replace("-","");successor.mode=r.mode;successor.setup=r.setup;successor.createdAt=successor.updatedAt=successor.savedAt=now();successor.race=next;
                    for(var old:r.race.racers){require(old.bot()||!membership.containsKey(old.userId)||membership.get(old.userId).equals(r.id),"ALREADY_IN_ROOM");var v=new Racer(old.id,old.userId,old.name,old.botLevel);v.hero=old.hero;v.look=old.look;v.ready=old.bot()||sockets.containsKey(old.userId);v.connected=v.ready;next.racers.add(v);}start(next);parent=r;parent.successor=successor.id;parent.receipts.put(key,new Receipt(command,false));r=successor;}}
                default->throw new RushException(400,"INVALID_ACTION");
            }
            r.updatedAt=now();r.race.revision++;r.receipts.put(key,new Receipt(command,correct));
            // A rematch writes the finished room and its successor together (one transaction, ordered room gates), after the
            // lock and before the acknowledgement, like every other command; it used to write both inside the lock.
            if(parent==null)save(r);else{var a=capture(parent);var b=capture(r);cache(r);for(var v:r.race.racers)if(!v.bot())membership.put(v.userId,r.id);pending.add(new Write(b.seq(),a.first(),b.first()));}
        }catch(RuntimeException ex){if(parent!=null){rooms.remove(r.id);roomCount=rooms.size();rollback(parent,before);}else rollback(r,before);throw ex;}
        if(kicked!=null){var b=sockets.remove(kicked);if(b!=null){var h=SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);h.setSessionId(b.session);h.setLeaveMutable(true);messages.convertAndSendToUser(b.principal,"/queue/quiz-rush",Map.of("type","REMOVED","code","HOST_REMOVED"),h.getMessageHeaders());}}
        if(action.equals("leave"))sockets.remove(user);releaseTerminal(r);publish(r);return action.equals("leave")?Map.of("left",true):view(r,user);
    }
    private static String commandHash(String value){try{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
    private Racer target(Room r,String id){return r.race.racers.stream().filter(p->p.id.equals(id)).findFirst().orElseThrow(()->new RushException(404,"INVALID_TARGET"));}
    private void rollback(Room r,String before){var previous=repo.decode(before);rooms.put(r.id,previous);roomCount=rooms.size();membership.entrySet().removeIf(e->e.getValue().equals(r.id));if(!terminal(previous))for(var p:previous.race.racers)if(!p.bot()&&!p.phase.equals("DNF"))membership.put(p.userId,r.id);}
    private void releaseTerminal(Room r){if(terminal(r))membership.entrySet().removeIf(e->e.getValue().equals(r.id));}
    public synchronized void disconnect(String session){for(var e:sockets.entrySet())if(e.getValue().session.equals(session)){var id=membership.get(e.getKey());var r=rooms.get(id);if(r!=null){var p=racer(r,e.getKey());p.connected=false;p.horizontal=0;p.forward=0;p.target=null;p.sprint=false;p.seenAt=r.race.elapsed;r.race.revision++;}}}
    public void tick(double dt){if(!loaded||roomCount==0)return;List<Write> out;long asked=System.nanoTime();synchronized(this){if(!loaded||rooms.isEmpty())return;long waited=System.nanoTime()-asked;maxTickWaitNanos=Math.max(maxTickWaitNanos,waited);totalTickWaitNanos+=waited;
        tickOut=new ArrayList<>();try{tickLocked(dt);}finally{out=tickOut;tickOut=null;}}for(var w:out)later(w);}
    private void tickLocked(double dt){
        if(!loaded)return;long begun=System.nanoTime();long n=now();boolean broadcast=++tickIndex%2==0||n-broadcastAt>=150;if(broadcast)broadcastAt=n;
        for(var r:new ArrayList<>(rooms.values())){
            // A finished room whose last write failed is written again every second and stays in memory until it is stored.
            if(terminal(r)){if(failedSeq.containsKey(r.id)){if(n-r.updatedAt>=1000){save(r);r.updatedAt=n;}}else if(n-r.updatedAt>120000){forget(r);}continue;}
            try{
                // The race waits while its state is not stored; a write that succeeds clears the flag (`stored`).
                if(r.recovery.equals("PERSISTENCE_UNAVAILABLE")){if(n-r.updatedAt>=1000){save(r);r.updatedAt=n;}if(broadcast)publish(r);continue;}
                if(!questions.available()||!r.race.contentVersion.equals(questions.version())){r.race.status="CANCELED";r.race.reason="CONTENT_CHANGED";}
                else if(r.race.status.equals("QUEUED")){if(n-r.createdAt>=90000){r.race.status="CANCELED";r.race.reason="QUEUE_EXPIRED";}else if(n-r.createdAt>=10000&&r.race.racers.size()>=2&&r.race.racers.stream().allMatch(p->p.connected)){for(var p:r.race.racers)p.ready=true;start(r.race);}}
                else if(r.race.status.equals("WAITING")&&n-r.createdAt>=900000){r.race.status="CANCELED";r.race.reason="ROOM_EXPIRED";}
                else advance(r.race,dt);
                if(terminal(r)||n-r.savedAt>=5000){save(r);r.updatedAt=n;}
                // Sealed results must reach every participant even between periodic snapshot ticks.
                releaseTerminal(r);if(broadcast||terminal(r))publish(r);
            }catch(Exception ex){var last=lastStored.get(r.id);if(last!=null){rollback(r,last);r=rooms.get(r.id);}r.recovery="PERSISTENCE_UNAVAILABLE";r.updatedAt=n;failedSeq.merge(r.id,serial,Math::max);if(broadcast)publish(r);}
        }long duration=System.nanoTime()-begun;ticks++;totalTickNanos+=duration;maxTickNanos=Math.max(maxTickNanos,duration);
    }
    public Map<String,Object> get(long user,UUID id){ensureLoaded();var pre=id!=null&&!cached(id)?prefetch(user,"get",new Command(id,null,null,null,null,null,null,null,null,null,null)):null;synchronized(this){prefetched=pre;try{return view(room(user,id),user);}finally{prefetched=null;}}}
    /** Finished rooms only, decoded from the database: no live state, so no room lock (the read is a network round trip). */
    public List<Map<String,Object>> history(long user){return repo.history(user).stream().map(r->view(r,user)).toList();}
    public synchronized Map<String,Object> metrics(){var m=new LinkedHashMap<String,Object>();m.put("rooms",rooms.size());m.put("liveHumans",membership.size());m.put("liveRacers",rooms.values().stream().filter(r->!terminal(r)).mapToInt(r->r.race.racers.size()).sum());
        m.put("ticks",ticks);m.put("meanTickMicros",ticks==0?0:totalTickNanos/ticks/1000.0);m.put("maxTickMicros",maxTickNanos/1000.0);m.put("maxTickLateMicros",maxTickLateNanos/1000.0);
        m.put("maxTickLockWaitMicros",maxTickWaitNanos/1000.0);m.put("meanTickLockWaitMicros",ticks==0?0:totalTickWaitNanos/ticks/1000.0);m.put("maxInputLockWaitMicros",maxInputWaitNanos/1000.0);m.put("maxCommandLockWaitMicros",maxCommandWaitNanos/1000.0);
        m.put("maxPublishMicros",maxPublishNanos/1000.0);var hold=new TreeMap<String,Double>();maxHoldNanos.forEach((k,v)->hold.put(k,v/1000.0));m.put("maxCommandHoldMicros",hold);m.put("snapshots",snapshots);m.put("persistenceWrites",persistenceWrites);m.put("sqlWrites",repo.sqlWriteCount());m.put("sqlReads",repo.sqlReadCount());return m;}
    private void publish(Room r){long begun=System.nanoTime();try{publishRoom(r);}finally{maxPublishNanos=Math.max(maxPublishNanos,System.nanoTime()-begun);}}
    private void publishRoom(Room r){for(var p:r.race.racers){if(p.bot()||!terminal(r)&&!Objects.equals(membership.get(p.userId),r.id)||membership.containsKey(p.userId)&&!membership.get(p.userId).equals(r.id))continue;var binding=sockets.get(p.userId);if(binding==null)continue;var view=view(r,p.userId,!active(r.race));var h=SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);h.setSessionId(binding.session);h.setLeaveMutable(true);messages.convertAndSendToUser(binding.principal,"/queue/quiz-rush",Map.of("type","STATE","state",view),h.getMessageHeaders());snapshots++;}}
    public Map<String,Object> view(Room room,long user){return view(room,user,true);}
    /**
     * Private projection. The course plan (obstacles, rising walls) travels with command answers and outside the
     * running phases; the 10 Hz race broadcasts omit it (clients keep the plan they received for the match).
     */
    public Map<String,Object> view(Room room,long user,boolean course){
        var r=room.race;var own=racer(room,user);var result=new LinkedHashMap<String,Object>();
        result.put("roomId",room.id);result.put("matchId",r.matchId);result.put("mode",room.mode);result.put("status",r.status);result.put("reason",r.reason);result.put("revision",r.revision);result.put("serverNow",now());result.put("elapsed",r.elapsed);result.put("total",r.questions.size());result.put("courseVersion",r.courseVersion);result.put("spacing",r.spacing);result.put("boundaries",RushCompetition.skybound(r)?r.boundaries:List.of());if(course){result.put("hazards",RushCompetition.trials(r)?r.hazards:List.of());result.put("rising",RushCompetition.trials(r)?r.rising:List.of());result.put("walls",RushCompetition.reforged(r)?r.walls:List.of());result.put("orbs",RushCompetition.reforged(r)?r.orbs:List.of());}result.put("setup",room.setup);result.put("recovery",room.recovery);result.put("invitation",room.mode.equals("PRIVATE")?room.invitation:"");result.put("code",room.mode.equals("PRIVATE")&&room.code!=null?room.code:"");result.put("host",room.owner==user);result.put("you",own.id);result.put("rematchVotes",room.rematch.size());
        var players=new ArrayList<Map<String,Object>>();for(var p:r.racers){var v=new LinkedHashMap<String,Object>();v.put("id",p.id);v.put("name",p.name);v.put("bot",p.bot());v.put("ready",p.ready);v.put("connected",p.connected);v.put("phase",p.phase);v.put("x",p.x);v.put("y",p.y);v.put("vx",p.vx);v.put("speed",p.speed);v.put("checkpoint",p.checkpoint);v.put("effect",p.effect);v.put("effectRemaining",Math.max(0,p.effectUntil-r.elapsed));v.put("rank",p.rank);v.put("finishAt",p.finishAt);v.put("skillSerial",p.skillSerial);v.put("lastSkill",p.lastSkill);v.put("streak",p.streak);v.put("z",p.z);v.put("vz",p.vz);v.put("guard",p.guard);v.put("vy",p.vy);
v.put("shield",p.shield);v.put("boosted",p.speedUntil>r.elapsed);v.put("hero",p.hero==null?"LYRA":p.hero);if(!p.bot())v.put("look",p.look==null?"":p.look);players.add(v);}result.put("players",players);
        var personal=new LinkedHashMap<String,Object>();personal.put("stamina",own.stamina);personal.put("energy",own.energy);personal.put("dashCooldown",own.dashCooldown);personal.put("dashTime",own.dash);personal.put("rushTime",own.rush);personal.put("charges",own.charges);personal.put("lastSeq",own.lastSeq);personal.put("selected",own.selected);personal.put("openGate",own.openGate);personal.put("rejected",own.rejected);personal.put("phaseTime",own.phaseTime);personal.put("recoilFrom",own.recoilFrom);personal.put("mistakes",own.mistakes);personal.put("cooldowns",own.cooldowns);personal.put("bestStreak",own.bestStreak);
        personal.put("vz",own.vz);personal.put("jumpSeq",own.jumpSeq);personal.put("dodgeSeq",own.dodgeSeq);personal.put("dodgeTime",own.dodge);personal.put("dodgeDir",own.dodgeDir);personal.put("dodgeCooldown",own.dodgeCooldown);
        personal.put("guard",own.guard);personal.put("kvx",own.kvx);personal.put("kvy",own.kvy);personal.put("riseCheckpoint",own.riseCheckpoint);personal.put("riseStart",own.riseStart);personal.put("dropStart",own.dropStart);personal.put("dropFrom",own.dropFrom);personal.put("hold",own.hold);
        personal.put("jumps",own.jumps);personal.put("dodges",own.dodges);personal.put("knocks",own.knocks);personal.put("falls",own.falls);
        personal.put("vy",own.vy);personal.put("floorY",own.floorY);personal.put("lastSlide",own.lastSlide);personal.put("orbs",own.orbs);personal.put("orbSerial",own.orbSerial);personal.put("lastOrb",own.lastOrb);
        personal.put("speedLeft",Math.max(0,own.speedUntil-r.elapsed));personal.put("shield",own.shield);personal.put("shieldLeft",Math.max(0,own.shieldUntil-r.elapsed));personal.put("shieldBlocks",own.shieldBlocks);personal.put("dashX",own.dashX);personal.put("dashY",own.dashY);personal.put("fallX",own.fallX);personal.put("fallY",own.fallY);
        // A complete start for the browser's replay (own racer only): the race time the latest input was applied from (the
        // browser measures its input lead with it), a jump accepted but not applied yet, and the last landing.
        personal.put("inputAt",own.inputAt);personal.put("jumpAt",own.jumpAt);personal.put("landAt",own.landAt);result.put("personal",personal);
        if(!terminal(room)&&own.checkpoint<r.questions.size()){var q=r.questions.get(own.checkpoint);result.put("question",new RushDtos.Question(q.id(),q.family(),q.prompt(),q.context(),order(r,own,own.checkpoint).stream().map(i->q.options().get(i)).toList()));}else result.put("question",null);
        result.put("review",terminal(room)?r.questions.stream().limit(own.checkpoint).map(q->new RushDtos.Review(q.family(),q.prompt(),q.context(),q.answer(),q.explanation(),(int)own.tried.stream().filter(k->k.startsWith(q.id()+":")).count(),q.sourceRefs())).toList():List.of());
        return result;
    }
}
