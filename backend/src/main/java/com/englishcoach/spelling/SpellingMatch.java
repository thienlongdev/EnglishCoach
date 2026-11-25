package com.englishcoach.spelling;

import java.util.*;
import static com.englishcoach.spelling.SpellingRules.*;
import static com.englishcoach.spelling.SpellingProtocol.*;
import com.englishcoach.sentinel.SentinelAttempt;

/** Pure, single-lock competition authority. No socket, database or inference work occurs here. */
final class SpellingMatch {
    interface Words { SpellingCatalog.Word choose(int tier, Set<String> used); }
    static final class Member {
        final long user; final String id, name, hero, look;
        String session; boolean online = true, ready, eliminated, spectator;
        double x, z, yaw, highestWpm, travelCredit = 1;
        final double homeX, homeZ;
        boolean returning;
        long seen, lastMove, sequence = -1, jumpAt, fetchedAt;
        int score, correct, wrong, streak, maxStreak, implausiblyFast;
        SentinelAttempt integrity;
        String integrityState = "PRACTICE";
        final LinkedHashSet<UUID> receipts = new LinkedHashSet<>();
        Member(long user, String name, String hero, String look, String session, long now, int index) {
            this.user = user; this.id = Long.toString(user); this.name = name; this.hero = hero; this.look = look;
            this.session = session; seen = lastMove = now;
            double angle = (index - 4.5) * .22;
            x = homeX = Math.sin(angle) * 7; z = homeZ = 4 + Math.cos(angle) * 3; yaw = Math.PI;
        }
        boolean receipt(UUID id) {
            if (id == null) throw new IllegalArgumentException("REQUEST_ID_REQUIRED");
            if (receipts.contains(id)) return false;
            receipts.add(id);
            while (receipts.size() > 128) receipts.remove(receipts.iterator().next());
            return true;
        }
    }
    final UUID roomId = UUID.randomUUID();
    UUID matchId = UUID.randomUUID();
    final String code; final Mode mode; final Difficulty difficulty; final int capacity; final boolean publicMatch;
    final long createdAt; final Words words;
    final LinkedHashMap<Long, Member> members = new LinkedHashMap<>();
    final LinkedHashSet<String> used = new LinkedHashSet<>();
    final ArrayList<Review> reviews = new ArrayList<>();
    final Map<Long,List<String>> newRecords = new HashMap<>();
    Phase phase = Phase.LOBBY;
    String host, winner, reason;
    long revision = 1, deadline, startedAt, endedAt, sprintDeadline, lastBroadcast, saveRetryAt;
    boolean dirty = true, saved, saving;
    final List<SentinelAttempt.Change> persistenceDecisions = new ArrayList<>();
    int round = 1, cursor = -1;
    final List<Long> order = new ArrayList<>();
    SpellingCatalog.Word word;
    UUID turnId;
    Member active;
    long openedAt, answerDeadline, audioAvailableAt, draftSequence = -1, lastRepeat;
    int repeats, audioRevision;
    String typed = "";
    Review result;
    SpellingMatch(String code, Mode mode, Difficulty difficulty, int capacity, boolean quick, long now, Words words) {
        this.code=code; this.mode=mode; this.difficulty=difficulty; this.capacity=capacity;
        publicMatch=quick; createdAt=now; this.words=words;
    }
    void changed() { revision++; dirty=true; }
    boolean terminal() { return SpellingRules.terminal(phase); }
    void add(Member m) {
        if (members.size() >= capacity) throw new IllegalArgumentException("ROOM_FULL");
        m.spectator=phase!=Phase.LOBBY; members.put(m.user,m); if(host==null)host=m.id; changed();
    }
    void start(long now) {
        require(phase==Phase.LOBBY,"MATCH_STARTED");
        order.clear();
        for(var m:members.values())if(!m.spectator&&m.online&&m.ready)order.add(m.user);
        require(order.size()>=(mode==Mode.MULTIPLAYER?2:1),"NEED_READY_PLAYERS");
        for(var m:members.values())if(!order.contains(m.user))m.spectator=true;
        phase=Phase.COUNTDOWN;deadline=now+3000;changed();
    }
    void next(long now) {
        if(active!=null&&mode==Mode.MULTIPLAYER)active.returning=true;
        List<Member> alive=order.stream().map(members::get).filter(Objects::nonNull).filter(m->!m.eliminated).toList();
        if (alive.isEmpty() || mode==Mode.MULTIPLAYER&&alive.size()==1) { finish(now,alive.isEmpty()?null:alive.getFirst().id,"COMPLETE"); return; }
        if (mode==Mode.SPRINT&&sprintDeadline>0&&now>=sprintDeadline) { finish(now,alive.getFirst().id,"SPRINT_COMPLETE");return; }
        if (reviews.size()>=400) { finish(now,mode==Mode.MULTIPLAYER?null:alive.getFirst().id,"SESSION_LIMIT");return; }
        do { cursor++; if(cursor>=order.size()){cursor=0;round++;} active=members.get(order.get(cursor)); }
        while(active==null||active.eliminated);
        active.returning=false;
        int tier=SpellingRules.tier(difficulty,mode,active.correct,round);
        word=words.choose(tier,used); used.add(word.word());
        turnId=UUID.randomUUID();typed="";repeats=0;audioRevision=0;draftSequence=-1;openedAt=answerDeadline=0;
        active.fetchedAt=0;result=null;phase=Phase.APPROACH;
        // Travel at the same bounded gait speed as free movement. Everybody sees the same arrival.
        deadline=now+Math.max(1300,(long)(Math.hypot(active.x,active.z+2.8)/3.2*1000)+300);
        changed();
    }
    void tick(long now, long elapsed) {
        for(var m:members.values())if(m.returning){
            double dx=m.homeX-m.x,dz=m.homeZ-m.z,d=Math.hypot(dx,dz),step=Math.min(d,Math.max(0,Math.min(250,elapsed))*.0032);
            if(d>.01){m.x+=dx/d*step;m.z+=dz/d*step;m.yaw=Math.atan2(dx,dz);changed();}else{m.returning=false;m.yaw=Math.PI;changed();}
        }
        if(phase==Phase.FINISHED&&mode==Mode.MULTIPLAYER&&winner!=null){
            var champion=members.values().stream().filter(m->m.id.equals(winner)).findFirst().orElse(null);
            if(champion!=null){double dx=-champion.x,dz=-2.8-champion.z,d=Math.hypot(dx,dz),step=Math.min(d,Math.max(0,Math.min(250,elapsed))*.0032);
                if(d>.01){champion.x+=dx/d*step;champion.z+=dz/d*step;champion.yaw=Math.atan2(dx,dz);changed();}else if(champion.yaw!=0){champion.yaw=0;changed();}}
        }
        if(terminal()||phase==Phase.LOBBY)return;
        if(now-createdAt>=ROOM_MS){finish(now,null,"SESSION_LIMIT");return;}
        if(phase==Phase.COUNTDOWN&&now>=deadline){next(now);return;}
        if(mode==Mode.SPRINT&&sprintDeadline>0&&now>=sprintDeadline){
            if(phase==Phase.SPELL)judge(now,typed,"SPRINT_END");
            finish(now,active==null?null:active.id,"SPRINT_COMPLETE");return;
        }
        if(phase==Phase.APPROACH){
            double dx=-active.x,dz=-2.8-active.z,distance=Math.hypot(dx,dz),step=Math.min(distance,Math.max(0,Math.min(250,elapsed))*.0032);
            if(distance>.001){active.x+=dx/distance*step;active.z+=dz/distance*step;active.yaw=Math.atan2(dx,dz);changed();}
            if(now>=deadline){active.x=0;active.z=-2.8;active.yaw=0;phase=Phase.HEAR;audioAvailableAt=now;deadline=now+AUDIO_GRACE_MS;changed();}
        }else if(phase==Phase.HEAR&&now>=deadline){abort(now,"AUDIO_NOT_CONFIRMED");}
        else if(phase==Phase.SPELL&&answerDeadline>0&&now>=answerDeadline){judge(now,typed,"TIMEOUT");}
        else if(phase==Phase.RESULT&&now>=deadline){next(now);}
    }
    void delivered(Member m,UUID id,long now) {
        require(Objects.equals(turnId,id)&&Set.of(Phase.HEAR,Phase.SPELL,Phase.RESULT,Phase.FINISHED).contains(phase),"TURN_EXPIRED");
        if(m==active&&m.fetchedAt==0)m.fetchedAt=now;
    }
    void heard(Member m,UUID id,long now) {
        current(m,id);require(phase==Phase.HEAR,"NOT_LISTENING");
        require(m.fetchedAt>0 && now-m.fetchedAt>=word.clip().durationMs()-150,"AUDIO_NOT_FINISHED");
        openedAt=now;answerDeadline=mode==Mode.PRACTICE?0:now+ANSWER_MS;
        if(startedAt==0){startedAt=now;if(mode==Mode.SPRINT)sprintDeadline=now+SPRINT_MS;}
        phase=Phase.SPELL;deadline=answerDeadline;changed();
    }
    void draft(Member m,UUID id,long sequence,String text,long now,boolean submit) {
        current(m,id);require(phase==Phase.SPELL,"ANSWER_WINDOW_CLOSED");
        if(answerDeadline>0&&now>=answerDeadline){judge(now,typed,"TIMEOUT");return;}
        if(sprintDeadline>0&&now>=sprintDeadline){finish(now,m.id,"SPRINT_COMPLETE");return;}
        if(sequence<=draftSequence)return;
        typed=normalize(text);draftSequence=sequence;changed();
        if(SpellingRules.accepts(word.word(),typed)||submit)judge(now,typed,"ANSWER");
    }
    void repeat(Member m,UUID id,long now) {
        current(m,id);require(phase==Phase.SPELL,"ANSWER_WINDOW_CLOSED");
        require(repeats<2&&now-lastRepeat>=2000,"REPEAT_LIMIT");
        // A repeat never extends the answer window or makes another synthesis request.
        repeats++;audioRevision++;lastRepeat=now;changed();
    }
    void judge(long now,String submitted,String why) {
        if(phase!=Phase.SPELL)return;
        boolean correct=SpellingRules.accepts(word.word(),submitted);
        double speed=SpellingRules.wpm(submitted.length(),now-openedAt);
        int earned=0;
        if(correct){active.correct++;active.streak++;active.maxStreak=Math.max(active.maxStreak,active.streak);
            earned=SpellingRules.score(word.word().length(),word.tier(),active.streak);active.score+=earned;
            active.highestWpm=Math.max(active.highestWpm,speed);
        }else{active.wrong++;active.streak=0;if(mode==Mode.ENDLESS||mode==Mode.MULTIPLAYER)active.eliminated=true;}
        result=new Review(active.id,word.word(),submitted,correct,correct?"CORRECT":why.equals("TIMEOUT")?"TIMEOUT":"INCORRECT",speed,earned,word.tier(),now);
        reviews.add(result);phase=Phase.RESULT;deadline=now+(mode==Mode.PRACTICE?2500:1800);changed();
        if(!correct&&mode==Mode.ENDLESS)finish(now,null,"INCORRECT");
    }
    void move(Member m,double x,double z,double yaw,long seq,boolean jump,long now) {
        if(!Double.isFinite(x)||!Double.isFinite(z)||!Double.isFinite(yaw)||seq<=m.sequence)return;
        if(m.returning||phase==Phase.FINISHED&&m.id.equals(winner)||m==active&&!terminal()&&phase!=Phase.LOBBY)return;
        // One real-time distance budget; sending more packets cannot increase allowed speed.
        m.travelCredit=Math.min(1.6,m.travelCredit+Math.max(0,now-m.lastMove)*.0036);m.lastMove=now;
        double dx=x-m.x,dz=z-m.z,d=Math.hypot(dx,dz),step=Math.min(d,m.travelCredit);
        if(d>.001){m.x+=dx/d*step;m.z+=dz/d*step;m.travelCredit-=step;}
        m.x=Math.max(-10.5,Math.min(10.5,m.x));m.z=Math.max(1,Math.min(8.2,m.z));
        m.yaw=Math.atan2(Math.sin(yaw),Math.cos(yaw));m.sequence=seq;
        if(jump&&now-m.jumpAt>900)m.jumpAt=now;
        changed();
    }
    void finish(long now,String winner,String reason){if(terminal())return;this.winner=winner;this.reason=reason;endedAt=now;phase=Phase.FINISHED;deadline=0;
        if(mode==Mode.MULTIPLAYER&&winner!=null)for(var m:members.values())m.returning=!m.id.equals(winner)&&m==active;changed();}
    void abort(long now,String reason){if(terminal())return;this.reason=reason;endedAt=now;phase=Phase.ABORTED;deadline=0;changed();}
    void current(Member m,UUID id){require(m==active&&!m.eliminated&&!m.spectator&&Objects.equals(id,turnId),"NOT_YOUR_TURN");}
    static void require(boolean value,String code){if(!value)throw new IllegalArgumentException(code);}
    State state(Member viewer,long now) {
        var players=members.values().stream().map(m->new Player(m.id,m.user,m.name,m.hero,m.look,m.online,m.ready,m.eliminated,m.spectator,m.returning,
            m.x,m.z,m.yaw,m.sequence,now,m.jumpAt,0,m.score,m.correct,m.wrong,m.streak,m.maxStreak,m.highestWpm,m.integrityState)).toList();
        Turn turn=active==null?null:new Turn(turnId,active.id,word.tier(),
            phase==Phase.APPROACH||phase==Phase.COUNTDOWN?null:"/api/v1/spelling/rooms/"+roomId+"/audio/"+turnId,
            word.clip().durationMs(),openedAt,answerDeadline,typed,repeats,audioRevision);
        // Review is useful after the verdict; no future word, source key or hash ever crosses the projection.
        var history=terminal()?List.copyOf(reviews):List.<Review>of();
        return new State(roomId,matchId,code,mode,difficulty,phase,host,viewer.id,revision,now,deadline,round,capacity,publicMatch,
            startedAt,sprintDeadline,winner,reason,players,turn,result,history,saved,newRecords.getOrDefault(viewer.user,List.of()));
    }
}
