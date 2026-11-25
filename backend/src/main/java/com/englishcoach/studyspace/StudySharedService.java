package com.englishcoach.studyspace;

import com.englishcoach.speaking.arena.ArenaVoice;
import com.englishcoach.speaking.arena.ArenaUsage;
import com.englishcoach.echolife.EchoLifeBulkhead;
import com.englishcoach.echolife.EchoLifeGameService.EventWindow;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import java.time.*;
import java.sql.Timestamp;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/** Lightweight human study rooms. Only presence and an authoritative timer are shared; media goes to LiveKit. */
@Service
public class StudySharedService {
    private static final Logger log = LoggerFactory.getLogger(StudySharedService.class);

    public record Person(long id,String name,boolean host,boolean online,boolean canSpeak,String voiceIdentity) {}
    public record TimerState(String status,long durationMs,long remainingMs,long deadline) {}
    public record View(UUID id,String name,long self,long host,long serverNow,long expiresAt,long revision,boolean voiceAvailable,TimerState timer,List<Person> people,boolean worldAvailable) {}
    public record Created(View room,String invite) {}
    public record Ticket(String url,String token,String identity,long expiresAt) {}
    private record WorldSession(UUID roomId, long userId) {}

    static final long LIFE=2*60*60*1000L,OFFLINE=25_000,LEAVE=120_000;
    static final long VOICE_COOLDOWN_MS=5_000L,VOICE_WINDOW_MS=10*60_000L;
    static final int MAX_VOICE_TICKETS_PER_WINDOW=20;
    static class Member {final long id;final String name;final StudyWorldPresence world=new StudyWorldPresence();String voiceId=UUID.randomUUID().toString();long seen,lastTicket;boolean canSpeak=true,issued;Member(long id,String name,long now){this.id=id;this.name=name;seen=now;}}
    static class Room {
        final StudyWorldEquipment equipment=new StudyWorldEquipment();
        final StudyWorldCourt court=new StudyWorldCourt();
        StudyWorldEvent event;
        long nextEventAttempt;
        final UUID id=UUID.randomUUID();final String invite=UUID.randomUUID().toString().replace("-","");final String media="ec-study-"+id;
        final long host,expires;final String name;final int capacity;final Map<Long,Member> members=new ConcurrentHashMap<>();final Set<Long> banned=new HashSet<>();
        final ReentrantLock voiceLock=new ReentrantLock();
        long revision=1,duration=25*60_000L,remaining=duration,deadline;String status="idle";boolean voiceReady,voiceRowCreated,closing;
        Room(long host,String name,int capacity,long now){this.host=host;this.name=name;this.capacity=capacity;expires=now+LIFE;}
    }

    private final Map<UUID,Room> rooms=new ConcurrentHashMap<>();
    private final Map<String,UUID> roomsByInvite=new ConcurrentHashMap<>();
    private final Map<Long,UUID> memberships=new ConcurrentHashMap<>();
    private final Map<String,WorldSession> worldSessions=new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long,Long> lastVoiceTicketAt=new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long,Deque<Long>> voiceTicketHistory=new ConcurrentHashMap<>();
    private final Object registryLock=new Object();

    private boolean sharedWorldEnabled;
    private int maxRooms=16;
    private int maxConcurrentPlayers=64;
    private double interestRadiusMeters=90.0;
    private int maxPeersPerFrame=12;

    private final AtomicLong framesAccepted=new AtomicLong();
    private final AtomicLong framesThrottled=new AtomicLong();
    private final AtomicLong worldFullRejects=new AtomicLong();
    private EchoLifeBulkhead echoLifeBulkhead;
    private volatile boolean voiceReceiptDirty = true;
    private volatile long nextSafetyOrphanSweepAt = 0L;
    private static final long ORPHAN_SAFETY_SWEEP_MS = 5L * 60_000L;

    @org.springframework.beans.factory.annotation.Autowired
    void configureSharedWorld(@org.springframework.beans.factory.annotation.Value("${app.echo-life.enabled:true}") boolean life,
                              @org.springframework.beans.factory.annotation.Value("${app.echo-life.shared-world:false}") boolean shared,
                              @org.springframework.beans.factory.annotation.Value("${app.echo-life.max-rooms:16}") int maxRooms,
                              @org.springframework.beans.factory.annotation.Value("${app.echo-life.max-concurrent-players:64}") int maxPlayers,
                              @org.springframework.beans.factory.annotation.Value("${app.echo-life.interest-radius-meters:90}") double interestRadius,
                              @org.springframework.beans.factory.annotation.Value("${app.echo-life.max-peers-per-frame:12}") int maxPeers,
                              ObjectProvider<EchoLifeBulkhead> bulkheadProvider) {
        this.sharedWorldEnabled=life && shared;
        this.maxRooms=Math.max(1, maxRooms);
        this.maxConcurrentPlayers=Math.max(0, maxPlayers);
        this.interestRadiusMeters=Math.max(10.0, interestRadius);
        this.maxPeersPerFrame=Math.max(1, maxPeers);
        this.echoLifeBulkhead=bulkheadProvider.getIfAvailable();
    }

    private final ArenaVoice voice;private final ArenaUsage usage;private final JdbcTemplate jdbc;private final Clock clock;
    @org.springframework.beans.factory.annotation.Autowired
    public StudySharedService(ArenaVoice voice,ArenaUsage usage,JdbcTemplate jdbc){this(voice,usage,jdbc,Clock.systemUTC());}
    StudySharedService(ArenaVoice voice,ArenaUsage usage,JdbcTemplate jdbc,Clock clock){this.voice=voice;this.usage=usage;this.jdbc=jdbc;this.clock=clock;}
    private long now(){return clock.millis();}
    private String name(long user){return jdbc.queryForObject("SELECT coalesce(nullif(name,''),'Learner') FROM public.users WHERE id=?",String.class,user);}
    private static StudySpaceException fail(int status,String code){return new StudySpaceException(status,code);}
    private Room member(long user,UUID id){Room r=rooms.get(id);if(r==null||r.closing||r.expires<=now()||!r.members.containsKey(user))throw fail(404,"ROOM_NOT_FOUND");return r;}
    private void authorize(Room r,long user){if(r.closing||r.expires<=now()||!r.members.containsKey(user))throw fail(404,"ROOM_NOT_FOUND");}
    private void host(Room r,long user){authorize(r,user);if(r.host!=user)throw fail(403,"HOST_REQUIRED");}

    public Created create(long user,String title,int capacity){
        if(title==null||title.isBlank()||title.length()>80||capacity<2||capacity>8)throw fail(400,"INVALID_ROOM");
        if(memberships.containsKey(user))throw fail(409,"ALREADY_IN_ROOM");
        if(rooms.size()>=maxRooms)throw fail(429,"ROOM_LIMIT");
        // Resolve display name outside the registry lock so remote DB RTT never blocks other rooms.
        String displayName=name(user);
        synchronized(registryLock){
            if(memberships.containsKey(user))throw fail(409,"ALREADY_IN_ROOM");
            if(rooms.size()>=maxRooms)throw fail(429,"ROOM_LIMIT");
            long t=now();
            Room r=new Room(user,title.strip(),capacity,t);
            r.members.put(user,new Member(user,displayName,t));
            rooms.put(r.id,r);
            roomsByInvite.put(r.invite,r.id);
            memberships.put(user,r.id);
            return new Created(view(r,user),r.invite);
        }
    }

    public View join(long user,String invite){
        if(invite==null||!invite.matches("[a-f0-9]{32}"))throw fail(404,"ROOM_NOT_FOUND");
        UUID rid=roomsByInvite.get(invite);
        Room r=rid==null?null:rooms.get(rid);
        if(r==null||r.closing||r.expires<=now())throw fail(404,"ROOM_NOT_FOUND");
        // Resolve display name before taking the room lock if the user is not already a member.
        String displayName=r.members.containsKey(user)?null:name(user);
        synchronized(r){
            if(r.closing||r.expires<=now()||r.banned.contains(user))throw fail(404,"ROOM_NOT_FOUND");
            UUID current=memberships.get(user);
            if(current!=null&&!current.equals(r.id))throw fail(409,"ALREADY_IN_ROOM");
            long t=now();
            if(!r.members.containsKey(user)){
                if(r.members.size()>=r.capacity)throw fail(409,"ROOM_FULL");
                if(memberships.putIfAbsent(user,r.id)!=null&&!r.id.equals(memberships.get(user)))throw fail(409,"ALREADY_IN_ROOM");
                r.members.put(user,new Member(user,displayName==null?name(user):displayName,t));
                r.revision++;
            }
            r.members.get(user).seen=t;
            return view(r,user);
        }
    }

    public View current(long user){UUID id=memberships.get(user);if(id==null)return null;Room r=member(user,id);synchronized(r){return view(r,user);}}
    public View heartbeat(long user,UUID id){Room r=member(user,id);synchronized(r){authorize(r,user);r.members.get(user).seen=now();return view(r,user);}}
    public String invite(long user,UUID id){Room r=member(user,id);host(r,user);return r.invite;}
    private View view(Room r,long self){
        authorize(r,self);
        long t=now();
        if(r.status.equals("running")&&r.deadline<=t){r.status="finished";r.remaining=0;r.deadline=0;r.revision++;}
        return new View(r.id,r.name,self,r.host,t,r.expires,r.revision,voice.available()&&usage.configured(),
                new TimerState(r.status,r.duration,r.remaining,r.deadline),
                r.members.values().stream().map(m->new Person(m.id,m.name,m.id==r.host,t-m.seen<OFFLINE,m.canSpeak,m.voiceId)).toList(),
                sharedWorldEnabled);
    }

    StudyWorldEvent.View inviteToEvent(long user,UUID roomId,String eventId,java.util.function.Supplier<Optional<EventWindow>> calendar) {
        if(!sharedWorldEnabled)throw fail(404,"WORLD_UNAVAILABLE");
        Room room=member(user,roomId);
        synchronized(room){
            authorize(room,user);
            long now=now();
            var self=room.members.get(user);
            if(room.event!=null && !room.event.advance(room.members,now))room.event=null;
            if(room.event!=null){
                if(room.event.organizer==user && room.event.event.id().equals(eventId))return room.event.view(self,room.members,now);
                throw fail(409,"EVENT_IN_PROGRESS");
            }
            if(self.world.pose==null || now-self.world.seen>=StudyWorldPresence.EXPIRE_MS)throw fail(409,"EVENT_PRESENCE_REQUIRED");
            if(now<room.nextEventAttempt)throw fail(429,"EVENT_WAIT");
            room.nextEventAttempt=now+2000;
        }
        // Checking the organizer's saved V3 calendar must not stall other learners' pose updates.
        EventWindow event=calendar.get().orElseThrow(()->fail(409,"EVENT_NOT_ATTENDED"));
        synchronized(room){
            authorize(room,user);
            long now=now();
            var self=room.members.get(user);
            if(room.event!=null)throw fail(409,"EVENT_IN_PROGRESS");
            var p=self.world.pose;
            if(p==null || now-self.world.seen>=StudyWorldPresence.EXPIRE_MS || !event.zone().equals(p.zone()) || Math.abs(p.y())>1.2)
                throw fail(409,"EVENT_PRESENCE_REQUIRED");
            room.event=new StudyWorldEvent(user,event,p,now,room.expires);
            return room.event.view(self,room.members,now);
        }
    }

    StudyWorldPresence.Frame worldFrame(long user, String socket, StudyWorldPresence.Input input) {
        if (!sharedWorldEnabled || socket == null || input == null || input.room() == null) return null;
        Room room = rooms.get(input.room());
        if (room == null) return null;
        // Enforce server-wide concurrent shared-world player cap before allocating session state.
        if (maxConcurrentPlayers > 0 && !worldSessions.containsKey(socket) && worldSessions.size() >= maxConcurrentPlayers) {
            worldFullRejects.incrementAndGet();
            return new StudyWorldPresence.Frame(room.id, input.seq(), List.of(), List.of(), "WORLD_FULL", null, null);
        }
        synchronized (room) {
            long time = now();
            Member self = room.members.get(user);
            if (room.closing || room.expires <= time || self == null || time - self.seen >= OFFLINE) return null;
            String previousSocket = self.world.socket;
            if (!self.world.accept(socket, input, time)) {
                framesThrottled.incrementAndGet();
                return null;
            }
            framesAccepted.incrementAndGet();
            // Active authenticated STOMP traffic keeps room presence alive seamlessly across relaxed background heartbeats.
            self.seen = time;
            if (previousSocket != null && !previousSocket.equals(socket)) {
                worldSessions.remove(previousSocket);
            }
            worldSessions.put(socket, new WorldSession(room.id, user));

            room.equipment.expire(room.members, time);
            room.court.advance(room.members, time);
            String actionResult = room.equipment.update(user, self.world.pose, input.intent(), time);
            if (input.court() != null) {
                room.court.act(user, self.world.pose, input.court(), time);
            }
            if (room.event != null) {
                boolean alive = room.event.advance(room.members, time);
                if (alive && input.event() != null) {
                    alive = room.event.act(self, input.event(), time) && room.event.advance(room.members, time);
                }
                if (!alive) room.event = null;
            }

            List<StudyWorldPresence.Peer> peers = collectNearbyPeers(room, self, time);
            return new StudyWorldPresence.Frame(
                    room.id,
                    input.seq(),
                    peers,
                    room.equipment.visible(self.world.pose),
                    actionResult,
                    room.court.view(self.world.pose, time),
                    room.event == null ? null : room.event.view(self, room.members, time));
        }
    }

    /** Spatial interest management: same public zone within interestRadiusMeters, nearest-first bounded by maxPeersPerFrame. */
    private List<StudyWorldPresence.Peer> collectNearbyPeers(Room room, Member self, long time) {
        StudyWorldPresence.Pose myPose = self.world.pose;
        if (myPose == null || room.members.size() <= 1) return List.of();
        double maxDistSq = interestRadiusMeters * interestRadiusMeters;
        String myZone = myPose.zone();
        List<StudyWorldPresence.Peer> peers = null;
        for (Member other : room.members.values()) {
            if (other.id == self.id || time - other.seen >= OFFLINE) continue;
            var presence = other.world;
            if (presence.pose == null || time - presence.seen >= StudyWorldPresence.EXPIRE_MS) continue;
            if (!myZone.equals(presence.pose.zone())) continue;
            if (myPose.distanceSq(presence.pose) > maxDistSq) continue;
            if (peers == null) peers = new ArrayList<>(Math.min(room.members.size(), maxPeersPerFrame));
            String emote = time - presence.emoteAt < StudyWorldPresence.EMOTE_TTL_MS ? presence.emote : null;
            String quickChat = time - presence.quickChatAt < StudyWorldPresence.QUICK_CHAT_TTL_MS ? presence.quickChat : null;
            peers.add(new StudyWorldPresence.Peer(
                    other.id,
                    other.name,
                    presence.pose,
                    emote,
                    emote == null ? 0L : presence.emoteAt,
                    presence.look,
                    quickChat,
                    quickChat == null ? null : presence.quickChatAt));
        }
        if (peers == null) return List.of();
        if (peers.size() > maxPeersPerFrame) {
            peers.sort(Comparator.comparingDouble(p -> myPose.distanceSq(p.pose())));
            return new ArrayList<>(peers.subList(0, maxPeersPerFrame));
        }
        return peers;
    }

    void disconnectWorld(String socket) {
        if (!sharedWorldEnabled || socket == null) return;
        // O(1) fast path: non-Echo-Life WebSocket disconnects acquire zero room locks.
        WorldSession binding = worldSessions.remove(socket);
        if (binding == null) return;
        Room room = rooms.get(binding.roomId());
        if (room == null) return;
        synchronized (room) {
            Member member = room.members.get(binding.userId());
            if (member != null && socket.equals(member.world.socket)) {
                member.world.clear();
                long time = now();
                room.equipment.expire(room.members, time);
                room.court.advance(room.members, time);
                if (room.event != null && !room.event.advance(room.members, time)) room.event = null;
            }
        }
    }

    int activeWorldPlayerCount() { return worldSessions.size(); }
    int activeRoomCount() { return rooms.size(); }

    public View timer(long user,UUID id,String action,Integer minutes,long revision){Room r=member(user,id);synchronized(r){
        host(r,user);if(r.revision!=revision)throw fail(409,"STALE_REVISION");
        switch(action==null?"":action){
            case "configure" -> {if(minutes==null||minutes<5||minutes>180||r.status.equals("running"))throw fail(400,"INVALID_TIMER");r.duration=minutes*60_000L;r.remaining=r.duration;r.status="idle";r.deadline=0;}
            case "start" -> {if(!r.status.equals("running")){if(r.remaining<=0)r.remaining=r.duration;r.deadline=now()+r.remaining;r.status="running";}}
            case "pause" -> {if(r.status.equals("running")){r.remaining=Math.max(0,r.deadline-now());r.deadline=0;r.status="paused";}}
            case "reset" -> {r.remaining=r.duration;r.deadline=0;r.status="idle";}
            default -> throw fail(400,"INVALID_ACTION");
        }r.revision++;return view(r,user);
    }}
    private void checkVoiceRateLimit(long user,Member m,long now){
        Long last=lastVoiceTicketAt.get(user);
        long anchor=Math.max(m.lastTicket,last==null?0L:last);
        if(anchor!=0L&&now-anchor<VOICE_COOLDOWN_MS)throw fail(429,"VOICE_RETRY_LATER");
        Deque<Long> history=voiceTicketHistory.get(user);
        if(history!=null){
            synchronized(history){
                pruneVoiceWindow(history,now);
                if(history.size()>=MAX_VOICE_TICKETS_PER_WINDOW)throw fail(429,"VOICE_RETRY_LATER");
            }
        }
    }
    private void recordVoiceTicket(long user,long now){
        lastVoiceTicketAt.put(user,now);
        Deque<Long> history=voiceTicketHistory.computeIfAbsent(user,k->new ArrayDeque<>());
        synchronized(history){
            pruneVoiceWindow(history,now);
            history.addLast(now);
        }
        if(lastVoiceTicketAt.size()>4096)lastVoiceTicketAt.entrySet().removeIf(e->now-e.getValue()>VOICE_WINDOW_MS);
        if(voiceTicketHistory.size()>4096)voiceTicketHistory.entrySet().removeIf(e->{
            synchronized(e.getValue()){pruneVoiceWindow(e.getValue(),now);return e.getValue().isEmpty();}
        });
    }
    private static void pruneVoiceWindow(Deque<Long> history,long now){
        while(!history.isEmpty()&&now-history.peekFirst()>=VOICE_WINDOW_MS)history.pollFirst();
    }
    public void leave(long user,UUID id){
        Room r=member(user,id);
        r.voiceLock.lock();
        try {
            boolean isHost;
            synchronized(r){authorize(r,user);isHost=user==r.host;}
            if(isHost){closeRoom(r);return;}
            revokeOutsideLock(r,user);
            synchronized(r){
                if(r.members.containsKey(user)){detachMemberLocked(r,user);r.revision++;}
            }
        } finally {
            r.voiceLock.unlock();
        }
    }
    private void clearMemberWorld(Member m){
        if(m.world.socket!=null)worldSessions.remove(m.world.socket);
        m.world.clear();
    }
    /** Revokes a member's LiveKit identity outside {@code synchronized (r)} (caller must hold {@code r.voiceLock}). */
    private void revokeOutsideLock(Room r,long user){
        String media,oldId;
        synchronized(r){
            Member m=r.members.get(user);
            if(m==null||!m.issued)return;
            media=r.media;oldId=m.voiceId;
        }
        voice.remove(media,oldId);
        // Never suppress billing on 404: a client may disconnect WebRTC before leaveVoice arrives.
        usage.settle(media,oldId,now());
        synchronized(r){
            Member m=r.members.get(user);
            if(m!=null&&Objects.equals(m.voiceId,oldId)){
                m.issued=false;
                m.voiceId=UUID.randomUUID().toString();
            }
        }
    }
    private void detachMemberLocked(Room r,long user){
        Member m=r.members.get(user);
        if(m!=null){
            clearMemberWorld(m);
            r.members.remove(user);
            memberships.remove(user,r.id);
            long t=now();
            r.equipment.expire(r.members,t);
            r.court.advance(r.members,t);
            if(r.event!=null && !r.event.advance(r.members,t))r.event=null;
        }
    }
    public View moderate(long user,UUID id,long participant,String action){
        Room r=member(user,id);
        r.voiceLock.lock();
        try {
            if(!"remove".equals(action)&&!"mute".equals(action)&&!"unmute".equals(action))throw fail(400,"INVALID_ACTION");
            synchronized(r){
                host(r,user);
                Member m=r.members.get(participant);
                if(m==null||participant==r.host)throw fail(404,"MEMBER_NOT_FOUND");
            }
            if("remove".equals(action)||"mute".equals(action))revokeOutsideLock(r,participant);
            synchronized(r){
                host(r,user);
                Member m=r.members.get(participant);
                if(m==null||participant==r.host)throw fail(404,"MEMBER_NOT_FOUND");
                if("remove".equals(action)){r.banned.add(participant);detachMemberLocked(r,participant);}
                else if("mute".equals(action)){m.canSpeak=false;}
                else{m.canSpeak=true;}
                r.revision++;
                return view(r,user);
            }
        } finally {
            r.voiceLock.unlock();
        }
    }
    public Ticket ticket(long user,UUID id){
        Room r=member(user,id);
        r.voiceLock.lock();
        try {
            String media;
            boolean needCreate;
            long host,expires;
            int capacity;
            synchronized(r){
                authorize(r,user);
                long t=now();
                Member m=r.members.get(user);
                if(t-m.seen>=OFFLINE)throw fail(409,"CONNECTION_REQUIRED");
                if(!voice.available()||!usage.configured())throw fail(503,"VOICE_UNAVAILABLE");
                checkVoiceRateLimit(user,m,t);
                media=r.media;
                needCreate=!r.voiceReady;
                host=r.host;
                expires=r.expires;
                capacity=r.capacity;
                if(needCreate){
                    r.voiceRowCreated=true;
                    voiceReceiptDirty=true;
                }
            }
            if(needCreate){
                jdbc.update("INSERT INTO public.study_shared_voice_rooms (id,user_id,media_name,expires_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",r.id,host,media,Timestamp.from(Instant.ofEpochMilli(expires)));
                voice.create(media,capacity);
                synchronized(r){r.voiceReady=true;}
            }
            String identity;
            boolean canSpeak;
            long openAt;
            synchronized(r){
                authorize(r,user);
                openAt=now();
                Member m=r.members.get(user);
                if(openAt-m.seen>=OFFLINE)throw fail(409,"CONNECTION_REQUIRED");
                checkVoiceRateLimit(user,m,openAt);
                identity=m.voiceId;
                canSpeak=m.canSpeak;
            }
            usage.open(media,identity,openAt);
            String token;
            try {
                token=voice.token(media,identity,canSpeak);
            } catch(RuntimeException e){
                try{usage.rollback(media,identity,openAt);}catch(RuntimeException ignored){}
                throw e;
            }
            boolean stillValid;
            synchronized(r){
                Member m=r.members.get(user);
                stillValid=!r.closing&&r.expires>now()&&m!=null&&now()-m.seen<OFFLINE&&Objects.equals(m.voiceId,identity);
                if(stillValid){m.lastTicket=openAt;m.issued=true;}
            }
            if(!stillValid){
                voice.evictIdentity(media,identity);
                try{usage.rollback(media,identity,openAt);}catch(RuntimeException ignored){}
                throw fail(409,"CONNECTION_REQUIRED");
            }
            recordVoiceTicket(user,openAt);
            return new Ticket(voice.url(),token,identity,openAt+120_000);
        } finally {
            r.voiceLock.unlock();
        }
    }
    public void leaveVoice(long user,UUID id){
        Room r=member(user,id);
        r.voiceLock.lock();
        try {
            synchronized(r){authorize(r,user);}
            revokeOutsideLock(r,user);
            synchronized(r){authorize(r,user);r.revision++;}
        } finally {
            r.voiceLock.unlock();
        }
    }
    private void closeRoom(Room r){
        boolean ready,rowCreated;
        String media;
        synchronized(r){
            r.closing=true;
            ready=r.voiceReady;
            rowCreated=r.voiceRowCreated;
            media=r.media;
        }
        if(ready||rowCreated){
            if(ready||jdbc.queryForObject("SELECT count(*) FROM public.study_shared_voice_rooms WHERE id=?",Integer.class,r.id)>0)voice.close(media);
            usage.closeRoom(media,now());
            jdbc.update("DELETE FROM public.study_shared_voice_rooms WHERE id=?",r.id);
        } else {
            usage.closeRoom(media,now());
        }
        synchronized(r){
            for(Member m:r.members.values())clearMemberWorld(m);
            r.members.keySet().forEach(u->memberships.remove(u,r.id));
            roomsByInvite.remove(r.invite,r.id);
            rooms.remove(r.id);
        }
    }

    @Scheduled(fixedDelay=5000,initialDelay=15000)
    public void sweep(){
        if(rooms.isEmpty())return;
        long t=now();
        for(Room r:rooms.values()){
            r.voiceLock.lock();
            try {
                boolean shouldClose;
                List<Long> toRevoke=null;
                synchronized(r){
                    Member hostMember=r.members.get(r.host);
                    shouldClose=r.closing||r.expires<=t||hostMember==null||t-hostMember.seen>=LEAVE;
                    if(!shouldClose){
                        for(Member m:r.members.values()){
                            if(m.world.socket!=null && (t-m.seen>=OFFLINE || t-m.world.seen>=StudyWorldPresence.EXPIRE_MS)){
                                clearMemberWorld(m);
                            }
                            if(t-m.seen>=OFFLINE && m.issued){
                                if(toRevoke==null)toRevoke=new ArrayList<>();
                                toRevoke.add(m.id);
                            }
                        }
                        r.equipment.expire(r.members,t);
                        r.court.advance(r.members,t);
                        if(r.event!=null && !r.event.advance(r.members,t))r.event=null;
                    }
                }
                if(shouldClose){closeRoom(r);continue;}
                if(toRevoke!=null){
                    for(long uid:toRevoke)revokeOutsideLock(r,uid);
                }
                synchronized(r){
                    long nowAfter=now();
                    for(Member m:new ArrayList<>(r.members.values())){
                        if(m.id!=r.host&&nowAfter-m.seen>=LEAVE&&!m.issued)detachMemberLocked(r,m.id);
                    }
                }
            } catch(RuntimeException ignored){/* Retry provider revocation; membership remains fail-closed. */}
            finally { r.voiceLock.unlock(); }
        }
    }

    @Scheduled(fixedDelay=60000,initialDelay=60000)
    public void reportMetrics(){
        long accepted=framesAccepted.getAndSet(0);
        long throttled=framesThrottled.getAndSet(0);
        long full=worldFullRejects.getAndSet(0);
        int activeRooms=rooms.size();
        int activePlayers=worldSessions.size();
        EchoLifeBulkhead.Stats dbStats=echoLifeBulkhead==null?null:echoLifeBulkhead.stats();
        if(activeRooms==0 && activePlayers==0 && accepted==0 && throttled==0 && full==0
                && (dbStats==null || (dbStats.inFlight()==0 && dbStats.rejected()==0)))return;
        log.info("[EchoLife Health] rooms={}/{} worldPlayers={}/{} frames60s={} throttled60s={} worldFull60s={} dbInFlight={}/{} dbRejectedTotal={}",
                activeRooms, maxRooms, activePlayers, maxConcurrentPlayers, accepted, throttled, full,
                dbStats==null?0:dbStats.inFlight(), dbStats==null?0:dbStats.maxConcurrent(), dbStats==null?0:dbStats.rejected());
    }

    @Scheduled(fixedDelay=120000,initialDelay=20000)
    void scheduledOrphanCleanup(){
        if(!voice.available())return;
        long t=now();
        boolean hasActiveVoiceRoom=false;
        if(!rooms.isEmpty()){
            for(Room r:rooms.values()){
                if(r.voiceRowCreated||r.voiceReady){hasActiveVoiceRoom=true;break;}
            }
        }
        if(!hasActiveVoiceRoom && !voiceReceiptDirty && t<nextSafetyOrphanSweepAt)return;
        orphanCleanup();
    }

    public void orphanCleanup(){
        if(!voice.available())return;
        long t=now();
        var orphan=jdbc.query("SELECT id,media_name FROM public.study_shared_voice_rooms ORDER BY expires_at LIMIT 24",(r,n)->Map.entry(r.getObject(1,UUID.class),r.getString(2)));
        boolean remainingOrphans=false;
        for(var receipt:orphan)if(!rooms.containsKey(receipt.getKey()))try{voice.close(receipt.getValue());usage.closeRoom(receipt.getValue(),now());jdbc.update("DELETE FROM public.study_shared_voice_rooms WHERE id=?",receipt.getKey());}catch(RuntimeException ignored){remainingOrphans=true;/* Durable receipt retries after a provider outage. */}
        voiceReceiptDirty=remainingOrphans;
        nextSafetyOrphanSweepAt=t+ORPHAN_SAFETY_SWEEP_MS;
    }
    @jakarta.annotation.PreDestroy public void shutdown(){for(Room r:rooms.values()){r.voiceLock.lock();try{closeRoom(r);}catch(RuntimeException ignored){/* Receipt survives shutdown. */}finally{r.voiceLock.unlock();}}}
}
