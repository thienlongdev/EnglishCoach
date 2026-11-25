package com.englishcoach.speaking.arena;

import static com.englishcoach.speaking.arena.ArenaProtocol.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;
import java.nio.file.Path;
import java.time.*;
import java.util.*;

class ArenaServiceTest {
    @TempDir Path dir;
    ArenaService service; ArenaUsage usage; FakeVoice voice; MutableClock clock; ArenaEvents events;
    static class MutableClock extends Clock {
        long now=1_800_000_000_000L;
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId z){return this;}
        public Instant instant(){return Instant.ofEpochMilli(now);}
    }
    static class FakeVoice implements ArenaVoice {
        int removes, closes; boolean failCreate, failToken, failRemove, failClose, removeExisted = true;
        Runnable onRemove, onToken;
        public boolean available(){return true;}
        public String url(){return "wss://example.livekit.cloud";}
        public String token(String room,String identity,boolean publish){
            if(onToken!=null)onToken.run();
            if(failToken)throw ArenaService.fail(503,"VOICE_UNAVAILABLE");
            return publish?"PUBLISH":"LISTEN";
        }
        public void create(String room,int n){if(failCreate)throw ArenaService.fail(503,"VOICE_UNAVAILABLE");}
        public boolean remove(String room,String identity){
            if(onRemove!=null)onRemove.run();
            if(failRemove)throw ArenaService.fail(503,"VOICE_UNAVAILABLE");
            removes++;
            return removeExisted;
        }
        public void close(String room){if(failClose)throw ArenaService.fail(503,"VOICE_UNAVAILABLE");closes++;}
    }
    @BeforeEach void setup(){voice=new FakeVoice();clock=new MutableClock();events=mock(ArenaEvents.class);usage=new ArenaUsage(dir.toString(),1000,8,new ObjectMapper());service=new ArenaService(voice,events,usage,clock);}
    @AfterEach void cleanup(){service.close();usage.close();}
    Command command(UUID room,UUID target,Boolean value){return new Command(UUID.randomUUID(),room,null,null,null,null,target,null,null,null,null,value,null,null,null,null);}
    State create(long user){return service.act(user,"u"+user,"s"+user,"create",new Command(UUID.randomUUID(),null,null,Mode.DUEL,"Person "+user,"LYRA",null,null,null,null,null,null,null,null,null,null));}
    State join(long user,State room){return service.act(user,"u"+user,"s"+user,"join",new Command(UUID.randomUUID(),null,room.code(),null,"Person "+user,"KAI",null,null,null,null,null,null,null,null,null,null));}
    void error(String code,Runnable action){assertEquals(code,assertThrows(ResponseStatusException.class,action::run).getReason());}
    Command joinBy(String code,long user){return new Command(UUID.randomUUID(),null,code,null,"Person "+user,"KAI",null,null,null,null,null,null,null,null,null,null);}
    @Test void aReservedRoomAdmitsOnlyTheTwoInvited(){String code=service.reserve("FREE",1,2);error("ROOM_NOT_FOUND",()->service.act(3,"u3","s3","join",joinBy(code,3)));State a=service.act(2,"u2","s2","join",joinBy(code,2));State b=service.act(1,"u1","s1","join",joinBy(code,1));assertEquals(a.roomId(),b.roomId());assertEquals(a.self(),b.host());assertEquals(2,b.players().size());}
    @Test void aReservationNobodyUsedLapses(){String code=service.reserve("FREE",1,2);clock.now+=11*60_000;service.tick();error("ROOM_NOT_FOUND",()->service.act(1,"u1","s1","join",joinBy(code,1)));}
    @Test void anInviterInAPrivateRoomInvitesToThatRoom(){State a=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,"Person 1","LYRA",null,null,null,null,null,null,null,null,null,null));assertEquals(a.code(),service.reserve("DUEL",1,2));State b=service.act(2,"u2","s2","join",joinBy(a.code(),2));assertEquals(a.roomId(),b.roomId());}
    @Test void privateRoomAndHostAuthority(){State a=create(1);State b=join(2,a);error("ROOM_NOT_FOUND",()->service.get(3,a.roomId()));error("HOST_ONLY",()->service.act(2,"u2","s2","free",command(a.roomId(),null,null)));State free=service.act(1,"u1","s1","free",command(a.roomId(),null,null));assertEquals(Phase.FREE,free.phase());assertTrue(free.players().stream().allMatch(Player::canSpeak));assertNotEquals(a.self(),b.self());}
    @Test void providerFailureDoesNotPublishChangedAuthorityOrBan(){State a=create(1);State b=join(2,a);voice.failRemove=true;error("VOICE_UNAVAILABLE",()->service.act(1,"u1","s1","free",command(a.roomId(),null,null)));assertEquals(Phase.LOBBY,service.get(1,a.roomId()).phase());error("VOICE_UNAVAILABLE",()->service.act(1,"u1","s1","kick",command(a.roomId(),b.self(),null)));assertEquals(2,service.get(1,a.roomId()).players().size());}
    @Test void rejoinReplacesSocketAndMediaIdentity(){State a=create(1);String old=a.players().getFirst().voiceIdentity();State replaced=service.act(1,"u1","replacement","rejoin",command(a.roomId(),null,null));assertNotEquals(old,replaced.players().getFirst().voiceIdentity());error("SESSION_REPLACED",()->service.act(1,"u1","s1","ping",command(a.roomId(),null,null)));service.disconnected("s1");assertTrue(service.get(1,a.roomId()).players().getFirst().online());assertEquals(a.roomId(),service.act(1,"u1","replacement","sync",command(null,null,null)).roomId());}
    @Test void voiceRequiresLiveSocketAndChargesBeforeTicket(){State a=create(1);assertEquals("LISTEN",service.ticket(1,a.roomId()).token());assertEquals(5L,usage.status(clock.now).get("reservedMinutes"));assertEquals(0L,usage.status(clock.now).get("usedMinutes"));error("VOICE_RATE_LIMIT",()->service.ticket(1,a.roomId()));service.disconnected("s1");error("CONNECTION_REQUIRED",()->service.ticket(1,a.roomId()));}
    @Test void aChangeOfWhoMaySpeakOrLeavingEndsTheLeaseAtItsRealLength(){
        State a=create(1);service.ticket(1,a.roomId());clock.now+=2*60_000;
        service.act(1,"u1","s1","free",command(a.roomId(),null,null));
        assertEquals(0,usage.status(clock.now).get("openConnections"),"the old grant ended with the change");
        assertEquals(2L,usage.status(clock.now).get("usedMinutes"),"two minutes, not ninety");
        service.ticket(1,a.roomId());clock.now+=30_000;
        service.act(1,"u1","s1","leave",command(a.roomId(),null,null));
        assertEquals(3L,usage.status(clock.now).get("usedMinutes"));assertEquals(0,usage.status(clock.now).get("openConnections"));
    }
    @Test void failedReservationNeverIssuesToken(){var tight=new ArenaUsage(dir.resolve("tight").toString(),4,8,new ObjectMapper());var small=new ArenaService(voice,events,tight,clock);State a=small.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.DUEL,"Person 1","LYRA",null,null,null,null,null,null,null,null,null,null));error("VOICE_QUOTA_EXHAUSTED",()->small.ticket(1,a.roomId()));small.close();tight.close();}
    @Test void independentMotionBatchesAtFourAndEightSeats(){
        State room=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,
            "Person 1","LYRA",null,null,null,null,null,null,null,null,null,null));
        for(int count:new int[]{4,8}){
            while(room.players().size()<count){
                join(room.players().size()+1,room);
                room=service.get(1,room.roomId());
            }
            service.tick();
            clock.now+=100;
            for(Player player:room.players()){
                long uid=player.userId();
                double x=player.x()+(uid%2==0?.25:-.25);
                var input=new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,uid%2==0,x,player.z(),0.,(long)count);
                service.act(uid,"u"+uid,"s"+uid,"move",input);
            }
            clearInvocations(events);
            service.tick();
            var packets=org.mockito.ArgumentCaptor.forClass(Event.class);
            verify(events,times(count)).send(anyString(),anyString(),packets.capture());
            for(var event:packets.getAllValues()){
                assertEquals("MOTION",event.type());
                assertEquals(count,event.motion().players().size());
                for(Player player:room.players()){
                    var pose=event.motion().players().stream().filter(m->m.id().equals(player.id())).findFirst().orElseThrow();
                    assertEquals(count,pose.sequence());
                    assertEquals(player.x()+(player.userId()%2==0?.25:-.25),pose.x(),1e-6);
                    assertEquals(player.userId()%2==0,pose.jumpAt()>0);
                }
            }
            clock.now+=100;
            service.act(1,"u1","s1","move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,0.,0.,0.,1L));
            assertEquals(count,service.get(1,room.roomId()).players().getFirst().sequence());
        }
    }
    @Test void bunchedLegitimateSprintKeepsItsDistanceAndLongTermSpeedStaysBounded(){
        State room=create(1);double x=-2;
        for(int seq=1;seq<=40;seq++){
            clock.now+=seq%2==1?165:65;x+=.335;
            service.act(1,"u1","s1","move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,x,2.,0.,(long)seq));
            assertEquals(x,service.get(1,room.roomId()).players().getFirst().x(),.00001);
        }
        double start=x;
        for(int seq=41;seq<=81;seq++){
            clock.now+=100;
            service.act(1,"u1","s1","move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,50.,2.,0.,(long)seq));
        }
        assertTrue(service.get(1,room.roomId()).players().getFirst().x()-start<=3.6+4.1*3.6+.001);
    }
    @Test void seatIsRoomOwnedAndStandingReleasesItsSupport(){
        State room=create(1);join(2,room);
        error("NO_FREE_SEAT",()->service.act(1,"u1","s1","sit",command(room.roomId(),null,null)));
        long[] seq={0};
        walkTo(1,room.roomId(),-4.5,9.5,seq);
        walkTo(1,room.roomId(),-8.6,11.1,seq);
        walkTo(2,room.roomId(),-4.5,9.5,seq);
        walkTo(2,room.roomId(),-8.6,11.1,seq);
        // (a) Sit claims specific seat within widened 2.20 m reach (~1.86 m > legacy 1.60 m) and blocks 2nd player with NO_FREE_SEAT
        Player seated=service.act(1,"u1","s1","sit",itemCommand(room.roomId(),"bench-sw-0",null)).players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertEquals("bench-sw-0",seated.seat());
        assertEquals(.5275,seated.supportY(),.001);
        error("NO_FREE_SEAT",()->service.act(2,"u2","s2","sit",itemCommand(room.roomId(),"bench-sw-0",null)));

        // (b) Stand places player +0.82 m in front of seat on terrain floor (supportY < seat.y() - 0.30, never on bench!)
        Player standing=service.act(1,"u1","s1","stand",command(room.roomId(),null,null)).players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertNull(standing.seat());
        assertTrue(standing.supportY()<seated.supportY()-.30,"stand must step onto terrain floor, not stay on +0.53 m bench");
        assertTrue(ArenaGeometry.dryWalkable(standing.x(),standing.z()));

        // (c) STOMP disconnected() frees m.seat immediately so Player 2 can claim bench-sw-0 without waiting 35s lease
        clock.now+=1000;
        Player reseated=service.act(1,"u1","s1","sit",itemCommand(room.roomId(),"bench-sw-0",null)).players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertEquals("bench-sw-0",reseated.seat());
        service.disconnected("s1");
        Player afterDisc=service.get(2,room.roomId()).players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertNull(afterDisc.seat(),"disconnected() must clear m.seat immediately");
        assertTrue(afterDisc.supportY()<reseated.supportY()-.30,"disconnected() must step off bench onto clear floor");
        Player p2Claimed=service.act(2,"u2","s2","sit",itemCommand(room.roomId(),"bench-sw-0",null)).players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        assertEquals("bench-sw-0",p2Claimed.seat());
    }
    @Test void movementClampedAndNonFiniteRejected(){State a=create(1);Command move=new Command(null,a.roomId(),null,null,null,null,null,null,null,null,null,null,999.0,999.0,0.0,1L);service.act(1,"u1","s1","move",move);Player p=service.get(1,a.roomId()).players().getFirst();assertTrue(Math.hypot(p.x()+2,p.z()-2)<=3.751);clock.now+=200;error("POSITION_INVALID",()->service.act(1,"u1","s1","move",new Command(null,a.roomId(),null,null,null,null,null,null,null,null,null,null,Double.NaN,0.0,0.0,2L)));}
    @Test void receiptRetryDoesNotRepeatRevocation(){State a=create(1);Command free=command(a.roomId(),null,null);service.act(1,"u1","s1","free",free);int before=voice.removes;service.act(1,"u1","s1","free",free);assertEquals(before,voice.removes);}
    @Test void shutdownClosesProviderRooms(){create(1);service.close();assertEquals(1,voice.closes);assertTrue(usage.orphanRooms().isEmpty());assertFalse(service.available());}
    @Test void rejoinResetsMovementSequenceWithoutReplacingItsOwnSocket(){
        State a=create(1);
        service.act(1,"u1","s1","move",new Command(null,a.roomId(),null,null,null,null,null,null,null,null,null,null,-1.5,2.0,0.0,900L));
        service.act(1,"u1","s1","rejoin",command(a.roomId(),null,null));
        verifyNoInteractions(events);
        clock.now+=200;
        service.act(1,"u1","s1","move",new Command(null,a.roomId(),null,null,null,null,null,null,null,null,null,null,-1.0,2.0,0.0,1L));
        assertEquals(-1.0,service.get(1,a.roomId()).players().getFirst().x(),.001);
    }
    @Test void groupInvitationsStayBoundToHostRoomAndCapacity(){
        State a=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,"Host","LYRA",null,null,null,null,null,null,null,null,null,null,null,"Garden club","Travel",3));
        assertEquals(3,a.capacity());assertEquals("Garden club",a.title());
        assertEquals(a.code(),service.boundRoom(a.roomId(),1,2,"FREE",true));
        join(2,a);error("HOST_ONLY",()->service.boundRoom(a.roomId(),2,3,"FREE",false));join(3,a);
        error("ROOM_FULL",()->join(4,a));error("ROOM_FULL",()->service.boundRoom(a.roomId(),1,4,"FREE",true));
        var gesture=service.act(1,"u1","s1","wave",command(a.roomId(),null,null));
        assertEquals("WAVE",service.get(3,a.roomId()).players().getFirst().gesture());
        error("ACTION_RATE_LIMIT",()->service.act(1,"u1","s1","wave",command(a.roomId(),null,null)));
    }
    @Test void socialRoomsAdmitLateJoinersDuringFreeConversation(){
        for(Mode mode:List.of(Mode.FREE,Mode.GUIDED)) {
            State a=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,mode,"Host","LYRA",null,null,null,null,null,null,null,null,null,null));
            service.act(1,"u1","s1","free",command(a.roomId(),null,null));
            State b=join(2,a);assertEquals(Phase.FREE,b.phase());assertTrue(b.players().stream().allMatch(Player::canSpeak));
            service.act(2,"u2","s2","leave",command(a.roomId(),null,null));service.act(1,"u1","s1","leave",command(a.roomId(),null,null));
        }
    }
    @Test void inspectedObjectsHaveOneHolderAndReturnOnDisconnect() {
        State room=create(1);join(2,room);
        var item=new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"artifact-atlas",null);
        error("OUT_OF_RANGE",()->service.act(1,"u1","s1","take-item",item));
        for (int i=1;i<=24;i++) {
            clock.now+=500;
            for(int u=1;u<=2;u++)service.act(u,"u"+u,"s"+u,"move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,-6.,10.8,0.,(long)i));
        }
        var taken=service.act(1,"u1","s1","take-item",item);
        assertEquals("artifact-atlas",taken.players().getFirst().artifact());
        error("ITEM_IN_USE",()->service.act(2,"u2","s2","take-item",item));
        service.disconnected("s1");
        assertEquals("artifact-atlas",service.act(2,"u2","s2","take-item",item).players().getLast().artifact());
    }
    Command itemCommand(UUID room,String item,String place){return new Command(UUID.randomUUID(),room,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,item,null,place);}
    void walkFarTo(long uid,UUID room,double x,double z,long[] seq){
        for(int i=0;i<500;i++){
            Player cur=service.get(uid,room).players().stream().filter(p->p.userId()==uid).findFirst().orElseThrow();
            double dx=x-cur.x(),dz=z-cur.z(),d=Math.hypot(dx,dz);
            if(d<.05)return;
            double k=Math.min(d,.42)/d;clock.now+=120;seq[0]++;
            service.act(uid,"u"+uid,"s"+uid,"move",new Command(null,room,null,null,null,null,null,null,null,null,null,false,cur.x()+dx*k,cur.z()+dz*k,0.,seq[0]));
        }
    }
    void walkTo(long uid,UUID room,double x,double z,long[] seq){walkFarTo(uid,room,x,z,seq);}
    @Test void aHeldObjectIsCarriedToAnotherTableAndRestsWhereTheServerPutsIt(){
        State room=create(1);long[] seq={0};
        walkTo(1,room.roomId(),-6.4,10.9,seq);
        service.act(1,"u1","s1","take-item",itemCommand(room.roomId(),"artifact-atlas",null));
        error("HANDS_FULL",()->service.act(1,"u1","s1","take-item",itemCommand(room.roomId(),"artifact-compass",null)));
        // Carried across the plaza: walking no longer drops it.
        walkTo(1,room.roomId(),7.1,11.0,seq);
        assertEquals("artifact-atlas",service.get(1,room.roomId()).players().getFirst().artifact());
        error("PLACE_ON_TABLE",()->service.act(1,"u1","s1","put-item",itemCommand(room.roomId(),"artifact-atlas","bench-sw")));
        State placed=service.act(1,"u1","s1","put-item",itemCommand(room.roomId(),"artifact-atlas","table-1"));
        assertNull(placed.players().getFirst().artifact());
        var atlas=placed.items().stream().filter(i->i.id().equals("artifact-atlas")).findFirst().orElseThrow();
        var compass=placed.items().stream().filter(i->i.id().equals("artifact-compass")).findFirst().orElseThrow();
        assertEquals("table-1",atlas.table());
        assertTrue(Math.hypot(atlas.x()-8,atlas.z()-12)<.4,"on the table");
        assertTrue(Math.hypot(atlas.x()-compass.x(),atlas.z()-compass.z())>=.3,"never on top of the compass");
        // From there it is taken again where it now rests, not where the layout first put it.
        State again=service.act(1,"u1","s1","take-item",itemCommand(room.roomId(),"artifact-atlas",null));
        assertEquals("artifact-atlas",again.players().getFirst().artifact());
    }
    @Test void multiplayerRowboatAuthorityPassengerSyncDisembarkAndRecovery(){
        State room=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,"Rower","LYRA",null,null,null,null,null,null,null,null,null,null));
        join(2,room);join(3,room);
        // Walk along the clear south promenade (0, 36) -> (18, 52) -> beacon-harbor-sw (16.0, 64.6) -> dock-harbor-main (25.2, 84.2)
        long seq=0;
        for(double[] wp:new double[][]{{0,36},{18,52},{16.0,64.6}}){
            for(int step=0;step<110;step++){
                clock.now+=120;seq++;
                for(int u=1;u<=3;u++){
                    final long uid=u;
                    Player cur=service.get(uid,room.roomId()).players().stream().filter(p->p.userId()==uid).findFirst().orElseThrow();
                    double dx=wp[0]-cur.x(), dz=wp[1]-cur.z(), dist=Math.hypot(dx,dz);
                    double stepLen=Math.min(dist,0.41);
                    service.act(uid,"u"+uid,"s"+uid,"move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,dist>1e-4?cur.x()+dx/dist*stepLen:cur.x(),dist>1e-4?cur.z()+dz/dist*stepLen:cur.z(),0.29,seq));
                }
            }
        }
        State toggled=service.act(3,"u3","s3","beacon",new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"beacon-harbor-sw",null));
        assertFalse(toggled.beacons().contains("beacon-harbor-sw"));

        for(double[] wp:new double[][]{{19.737,65.947},{25.2,84.2}}){
            for(int step=0;step<65;step++){
                clock.now+=120;seq++;
                for(int u=1;u<=3;u++){
                    final long uid=u;
                    Player cur=service.get(uid,room.roomId()).players().stream().filter(p->p.userId()==uid).findFirst().orElseThrow();
                    double dx=wp[0]-cur.x(), dz=wp[1]-cur.z(), dist=Math.hypot(dx,dz);
                    double stepLen=Math.min(dist,0.41);
                    service.act(uid,"u"+uid,"s"+uid,"move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,dist>1e-4?cur.x()+dx/dist*stepLen:cur.x(),dist>1e-4?cur.z()+dz/dist*stepLen:cur.z(),0.29,seq));
                }
            }
        }

        // Player 1 boards boat-harbor-1 as ROWER; Player 2 boards same boat as PASSENGER; Player 3 rejected
        java.util.function.Function<String,Command> itemCmd=item->new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,item,null);
        State s1=service.act(1,"u1","s1","board",itemCmd.apply("boat-harbor-1"));
        Player p1=s1.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertEquals("boat-harbor-1",p1.boat());assertEquals("ROWER",p1.boatRole());

        State s2=service.act(2,"u2","s2","board",itemCmd.apply("boat-harbor-1"));
        Player p2=s2.players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        assertEquals("boat-harbor-1",p2.boat());assertEquals("PASSENGER",p2.boatRole());

        error("NO_FREE_SEAT",()->service.act(3,"u3","s3","board",itemCmd.apply("boat-harbor-1")));

        // Row out into open water toward Coral Lagoon; both rower and passenger move together
        BoatState b0=s2.boats().stream().filter(b->b.id().equals("boat-harbor-1")).findFirst().orElseThrow();
        double bx=b0.x(), bz=b0.z();
        for(int rStep=1;rStep<=18;rStep++){
            clock.now+=100;
            bx+=0.14;bz+=0.48;
            service.act(1,"u1","s1","row",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,null,bx,bz,0.29,(long)rStep,null,null,null,null,null,rStep*0.6));
        }
        State midSea=service.get(1,room.roomId());
        Player mp1=midSea.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        Player mp2=midSea.players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        assertTrue(Math.hypot(mp1.x()-mp2.x(),mp1.z()-mp2.z())<1.5,"rower and passenger stay together on moving boat");
        error("NO_LANDING_NEARBY",()->service.act(1,"u1","s1","disembark",command(room.roomId(),null,null)));

        // Rower disconnects in open water: passenger is promoted to ROWER and boat is not locked
        service.disconnected("s1");
        State afterDisc=service.get(2,room.roomId());
        Player promoted=afterDisc.players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        assertEquals("ROWER",promoted.boatRole());

        // Promoted rower rows back alongside dock-harbor-main and disembarks safely onto dry pier
        for(int rStep=20;rStep<=45;rStep++){
            clock.now+=100;
            bx+=(b0.x()-bx)*.24;bz+=(b0.z()-bz)*.24;
            service.act(2,"u2","s2","row",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,null,bx,bz,0.29,(long)rStep,null,null,null,null,null,rStep*0.5));
        }
        State landed=service.act(2,"u2","s2","disembark",command(room.roomId(),null,null));
        Player lp2=landed.players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        assertNull(lp2.boat());
        assertTrue(ArenaGeometry.dryWalkable(lp2.x(),lp2.z()));

        // Empty boat returns to home mooring after BOAT_RETURN_MS
        clock.now+=46_000;
        service.tick();
        BoatState homeBoat=service.get(2,room.roomId()).boats().stream().filter(b->b.id().equals("boat-harbor-1")).findFirst().orElseThrow();
        assertEquals(b0.x(),homeBoat.x(),.01);
        assertEquals(b0.z(),homeBoat.z(),.01);
    }

    @Test void archipelagoV7ExtendedBoundsSwimmingDiveClimbVesselsAndFishingGestures(){
        // 1. Verify ArenaChannelGuard allowlists climb-dock, cast, reel, catch, and shake
        for(String action:List.of("climb-dock","cast","reel","catch","shake")){
            var h=org.springframework.messaging.simp.stomp.StompHeaderAccessor.create(org.springframework.messaging.simp.stomp.StompCommand.SEND);
            h.setDestination("/app/speaking-arena/"+action);
            h.setUser(()->"user");
            assertNotNull(ArenaChannelGuard.validate(org.springframework.messaging.support.MessageBuilder.createMessage(new byte[16],h.getMessageHeaders())));
        }

        State room=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,"Explorer","LYRA",null,null,null,null,null,null,null,null,null,null));
        long[] seq={0};

        // 2. Walk across the eastern arched bridge past the old 180 m limit onto Island B (tropical_beach, x > 190 m!)
        var eastBridge=ArenaGeometry.LAYOUT.bridges().getFirst();
        walkTo(1,room.roomId(),28.0,2.0,seq);
        walkTo(1,room.roomId(),eastBridge.ax(),eastBridge.az(),seq);
        walkTo(1,room.roomId(),eastBridge.bx(),eastBridge.bz(),seq);
        walkTo(1,room.roomId(),195.0,85.0,seq);
        Player onBeachIsland=service.get(1,room.roomId()).players().getFirst();
        assertTrue(onBeachIsland.x()>194.0,"Server allows movement well past legacy 180 m clamp up to 540 m: "+onBeachIsland.x());

        // 3. Walk to dock-beach, board sampan-beach-1, test both rowing and low-power motor modes
        var dockBeach=ArenaGeometry.LAYOUT.docks().stream().filter(d->d.id().equals("dock-beach")).findFirst().orElseThrow();
        walkTo(1,room.roomId(),168.0,32.0,seq);
        walkTo(1,room.roomId(),dockBeach.ax(),dockBeach.az(),seq);
        walkTo(1,room.roomId(),dockBeach.ax()+(dockBeach.bx()-dockBeach.ax())*0.84,dockBeach.az()+(dockBeach.bz()-dockBeach.az())*0.84,seq);
        State onSampan=service.act(1,"u1","s1","board",itemCommand(room.roomId(),"sampan-beach-1",null));
        assertEquals("sampan-beach-1",onSampan.players().getFirst().boat());
        service.act(1,"u1","s1","engine",new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,true,null,null,null,null));
        clock.now+=120;
        service.act(1,"u1","s1","row",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,null,0.0,0.0,0.0,1L,null,null,null,null,null,null,null,0.5,0.0));
        assertTrue(service.get(1,room.roomId()).boats().stream().filter(b->b.id().equals("sampan-beach-1")).findFirst().orElseThrow().engine());
        service.act(1,"u1","s1","engine",new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,false,null,null,null,null));
        service.act(1,"u1","s1","disembark",command(room.roomId(),null,null));

        // 4. Fishing gesture progression (cast -> reel -> catch) + shake after swimming
        assertEquals("CAST",service.act(1,"u1","s1","cast",command(room.roomId(),null,null)).players().getFirst().gesture());
        assertEquals("REEL",service.act(1,"u1","s1","reel",command(room.roomId(),null,null)).players().getFirst().gesture());
        assertEquals("CATCH",service.act(1,"u1","s1","catch",command(room.roomId(),null,null)).players().getFirst().gesture());
        clock.now+=3000;
        assertEquals("SHAKE",service.act(1,"u1","s1","shake",command(room.roomId(),null,null)).players().getFirst().gesture());

        // 5. Walk off tip of dock-beach into swimmable water -> test buoyant supportY, clamped diveDepth, and climb-dock!
        double dx=dockBeach.bx()-dockBeach.ax(), dz=dockBeach.bz()-dockBeach.az(), len=Math.hypot(dx,dz);
        double swimX=dockBeach.bx()+dx/len*(dockBeach.width()/2+1.2), swimZ=dockBeach.bz()+dz/len*(dockBeach.width()/2+1.2);
        walkTo(1,room.roomId(),swimX,swimZ,seq);
        clock.now+=120;seq[0]++;
        service.act(1,"u1","s1","move",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,false,swimX,swimZ,0.0,seq[0],null,null,null,null,null,25.0));
        Player swimmer=service.get(1,room.roomId()).players().getFirst();
        assertEquals(ArenaGeometry.SWIM_SUPPORT_Y,swimmer.supportY(),1e-5,"Buoyant swim supportY");
        assertTrue(swimmer.diveDepth()>0.0 && swimmer.diveDepth()<=18.0,"diveDepth clamped to valid water column <= 18 m");

        State climbed=service.act(1,"u1","s1","climb-dock",command(room.roomId(),null,null));
        Player backOnPier=climbed.players().getFirst();
        assertTrue(ArenaGeometry.dryWalkable(backOnPier.x(),backOnPier.z()));
        assertEquals(0.0,backOnPier.diveDepth(),1e-6);
    }

    @Test void jumpOverboardAnywhereDocklessIsletBeachLandingAndGroundSitting(){
        // 1. ArenaChannelGuard allowlists jump-overboard
        var h=org.springframework.messaging.simp.stomp.StompHeaderAccessor.create(org.springframework.messaging.simp.stomp.StompCommand.SEND);
        h.setDestination("/app/speaking-arena/jump-overboard");
        h.setUser(()->"user");
        assertNotNull(ArenaChannelGuard.validate(org.springframework.messaging.support.MessageBuilder.createMessage(new byte[16],h.getMessageHeaders())));

        State room=service.act(1,"u1","s1","create",new Command(UUID.randomUUID(),null,null,Mode.FREE,"Sailor","LYRA",null,null,null,null,null,null,null,null,null,null));
        join(2,room);
        long[] seq={0};

        // 2. Ground sit (__ground__) on dry plaza/beach sand & clean stand-in-place
        State gSit=service.act(1,"u1","s1","sit",itemCommand(room.roomId(),"__ground__",null));
        Player gp1=gSit.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertEquals("__ground__",gp1.seat());
        double gx0=gp1.x(), gz0=gp1.z();
        State gStand=service.act(1,"u1","s1","stand",command(room.roomId(),null,null));
        Player gp1Up=gStand.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertNull(gp1Up.seat());
        assertEquals(gx0,gp1Up.x(),1e-6);
        assertEquals(gz0,gp1Up.z(),1e-6);

        // 3. Walk both players to dock-harbor-main and board boat-harbor-1 (P1 = ROWER, P2 = PASSENGER)
        for(double[] wp:new double[][]{{0,36},{18,52},{19.737,65.947},{25.2,84.2}}){
            walkTo(1,room.roomId(),wp[0],wp[1],seq);
            walkTo(2,room.roomId(),wp[0],wp[1],seq);
        }
        service.act(1,"u1","s1","board",itemCommand(room.roomId(),"boat-harbor-1",null));
        service.act(2,"u2","s2","board",itemCommand(room.roomId(),"boat-harbor-1",null));

        // 4. Row into open sea: disembark refuses (NO_LANDING_NEARBY), but jump-overboard succeeds for ROWER and promotes PASSENGER -> ROWER!
        BoatState bStart=service.get(1,room.roomId()).boats().stream().filter(b->b.id().equals("boat-harbor-1")).findFirst().orElseThrow();
        double bx=bStart.x(), bz=bStart.z();
        long rSeq=0;
        for(int i=0;i<22;i++){
            clock.now+=120;rSeq++;
            bx+=0.42;bz+=0.32;
            service.act(1,"u1","s1","row",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,null,bx,bz,0.92,rSeq,null,null,null,null,null,i*0.5));
        }
        error("NO_LANDING_NEARBY",()->service.act(1,"u1","s1","disembark",command(room.roomId(),null,null)));

        State afterJump=service.act(1,"u1","s1","jump-overboard",new Command(UUID.randomUUID(),room.roomId(),null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1.0));
        Player jumper=afterJump.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        Player promoted=afterJump.players().stream().filter(p->p.userId()==2).findFirst().orElseThrow();
        BoatState midBoat=afterJump.boats().stream().filter(b->b.id().equals("boat-harbor-1")).findFirst().orElseThrow();
        assertNull(jumper.boat(),"jumper leaves boat cleanly in open sea");
        assertTrue(ArenaGeometry.swimmable(jumper.x(),jumper.z()),"jumper lands in swimmable water");
        assertTrue(ArenaGeometry.hullGap(midBoat.x(),midBoat.z(),midBoat.yaw(),jumper.x(),jumper.z(),ArenaGeometry.HULL)>=0.55,"jumper clears hull >= 0.55 m");
        assertEquals("ROWER",promoted.boatRole(),"passenger promoted to ROWER when rower jumps overboard");

        // Swimmer re-boards the drifting boat from open water
        clock.now+=500;
        State reboarded=service.act(1,"u1","s1","board",itemCommand(room.roomId(),"boat-harbor-1",null));
        assertEquals("PASSENGER",reboarded.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow().boatRole());

        // 5. Row to dockless sandy islet_coral_east (142, 232, beach bearing 0.17 rad) and disembark directly onto the beach!
        var islet=ArenaGeometry.LAYOUT.islands().stream().filter(i->"islet_coral_east".equals(i.id())).findFirst().orElseThrow();
        double beachAng=0.17;
        double sr=ArenaGeometry.shoreRadius(islet,beachAng);
        double targetBx=islet.x()+Math.cos(beachAng)*(sr+2.25);
        double targetBz=islet.z()+Math.sin(beachAng)*(sr+2.25);
        double bowInYaw=Math.atan2(-Math.cos(beachAng),-Math.sin(beachAng));
        for(int step=0;step<420;step++){
            BoatState curB=service.get(2,room.roomId()).boats().stream().filter(b->b.id().equals("boat-harbor-1")).findFirst().orElseThrow();
            double dx=targetBx-curB.x(), dz=targetBz-curB.z(), dist=Math.hypot(dx,dz);
            if(dist<0.15)break;
            double stepLen=Math.min(dist,0.58);
            clock.now+=120;rSeq++;
            service.act(2,"u2","s2","row",new Command(null,room.roomId(),null,null,null,null,null,null,null,null,null,null,curB.x()+dx/dist*stepLen,curB.z()+dz/dist*stepLen,bowInYaw,rSeq,null,null,null,null,null,step*0.4));
        }
        State onIslet=service.act(1,"u1","s1","disembark",command(room.roomId(),null,null));
        Player isletExplorer=onIslet.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow();
        assertNull(isletExplorer.boat());
        assertTrue(ArenaGeometry.dryWalkable(isletExplorer.x(),isletExplorer.z()),"disembarked onto dry sandy beach of dockless islet_coral_east");
        // Re-board from dockless islet beach so player is never stranded
        State backAboard=service.act(1,"u1","s1","board",itemCommand(room.roomId(),"boat-harbor-1",null));
        assertEquals("boat-harbor-1",backAboard.players().stream().filter(p->p.userId()==1).findFirst().orElseThrow().boat());
    }

    @Test void rejoinAndSelfMuteCannotBypassCooldownOrAvoidBillingOnClientDisconnect404(){
        voice.removeExisted=false;
        State room=create(1);
        UUID selfId=room.self();

        // A member who never requested a voice ticket burns 0 minutes on mute/rejoin
        service.act(1,"u1","s1","rejoin",command(room.roomId(),null,null));
        assertEquals(0L,usage.status(clock.now).get("usedMinutes"),"no ticket issued means zero minutes charged");

        // First ticket succeeds and holds a 5-min lease
        service.ticket(1,room.roomId());
        assertEquals(5L,usage.status(clock.now).get("openMinutes"));

        // Rejoin within 5s after client WebRTC disconnect (LiveKit 404) must still settle conservatively (>=1m) AND must NOT reset cooldown
        clock.now+=500;
        service.act(1,"u1","s1","rejoin",command(room.roomId(),null,null));
        assertEquals(1L,usage.status(clock.now).get("usedMinutes"),"issued lease with 404 disconnect must still bill conservatively");
        assertEquals(0,usage.status(clock.now).get("openConnections"));
        error("VOICE_RATE_LIMIT",()->service.ticket(1,room.roomId()));

        // Host self-mute within 5s must also NOT reset cooldown
        clock.now+=500;
        service.act(1,"u1","s1","mute",command(room.roomId(),selfId,true));
        error("VOICE_RATE_LIMIT",()->service.ticket(1,room.roomId()));

        // Rolling 20-ticket / 10-minute per-user cap blocks the 21st ticket even when respecting 5s spacing
        for(int i=1;i<ArenaService.MAX_VOICE_TICKETS_PER_WINDOW;i++){
            clock.now+=5_000;
            service.ticket(1,room.roomId());
            clock.now+=100;
            service.act(1,"u1","s1","rejoin",command(room.roomId(),null,null));
        }
        assertEquals(20L,usage.status(clock.now).get("usedMinutes"),"all 20 issued leases conservatively billed even when LiveKit returns 404");
        clock.now+=5_000;
        error("VOICE_RATE_LIMIT",()->service.ticket(1,room.roomId()));

        // Once the 10-minute rolling window elapses, legitimate voice ticket succeeds again
        clock.now+=ArenaService.VOICE_WINDOW_MS;
        service.act(1,"u1","s1","ping",command(room.roomId(),null,null));
        assertNotNull(service.ticket(1,room.roomId()));
    }

    @Test void ticketDoesNotHoldRoomLockAcrossTokenAndRollsBackLeaseOnFailure() throws Exception {
        State room=create(1);
        var enteredToken=new java.util.concurrent.CountDownLatch(1);
        var releaseToken=new java.util.concurrent.CountDownLatch(1);
        voice.onToken=()->{
            enteredToken.countDown();
            try{assertTrue(releaseToken.await(3,java.util.concurrent.TimeUnit.SECONDS));}catch(InterruptedException e){Thread.currentThread().interrupt();}
        };
        voice.failToken=true;

        var future=java.util.concurrent.CompletableFuture.runAsync(()->error("VOICE_UNAVAILABLE",()->service.ticket(1,room.roomId())));
        assertTrue(enteredToken.await(3,java.util.concurrent.TimeUnit.SECONDS),"ticket entered voice.token()");

        // While ticket() is blocked inside voice.token(), ping/get must NOT block on synchronized(r)
        var pingDone=new java.util.concurrent.CountDownLatch(1);
        var pinger=new Thread(()->{
            service.act(1,"u1","s1","ping",command(room.roomId(),null,null));
            assertNotNull(service.get(1,room.roomId()));
            pingDone.countDown();
        });
        pinger.start();
        assertTrue(pingDone.await(1,java.util.concurrent.TimeUnit.SECONDS),"ping/get must not block while ticket() runs voice.token()");

        releaseToken.countDown();
        future.get(3,java.util.concurrent.TimeUnit.SECONDS);
        assertEquals(0,usage.status(clock.now).get("openConnections"),"failed voice.token() must roll back freshly opened lease");
        assertEquals(0L,usage.status(clock.now).get("usedMinutes"));
    }

    @Test void enterCleansUsageRoomWhenProviderCreateAndCloseBothFail(){
        voice.failCreate=true;
        voice.failClose=true;
        // 50 failed room creates during an outage must NEVER accumulate >48 entries in usage.json or brick restart
        for(int i=0;i<50;i++){
            long uid=100+i;
            error("VOICE_UNAVAILABLE",()->create(uid));
        }
        assertTrue(usage.orphanRooms().isEmpty(),"failed voice.create() must clean up usage.register() even if voice.close() also throws");

        // Messenger-reserved room whose first join hits voice.create() failure must also clean up usage.json
        String reservedCode=service.reserve("FREE",901,902);
        error("VOICE_UNAVAILABLE",()->service.act(901,"u901","s901","join",joinBy(reservedCode,901)));
        assertTrue(usage.orphanRooms().isEmpty(),"failed reserved-room create must not leak into usage.json");

        // Fresh ArenaUsage load on same directory succeeds cleanly
        usage.close();
        try(var reloaded=new ArenaUsage(dir.toString(),1000,8,new ObjectMapper())){
            assertTrue(reloaded.orphanRooms().isEmpty());
        }
    }

    @Test void transitionAndMuteDoNotBroadcastIntermediateStateBeforeCommit(){
        State a=create(1);
        State b=join(2,a);
        service.tick();
        clearInvocations(events);

        // During transition(FREE), while voice.remove() is in flight, tick() must NOT observe dirty=true with old LOBBY phase
        voice.onRemove=()->{
            service.tick();
            verifyNoInteractions(events);
            assertEquals(Phase.LOBBY,service.get(1,a.roomId()).phase());
        };
        State afterFree=service.act(1,"u1","s1","free",command(a.roomId(),null,null));
        assertEquals(Phase.FREE,afterFree.phase());

        // Flush final post-commit STATE
        service.tick();
        clearInvocations(events);

        // Same atomic guarantee for mute
        voice.onRemove=()->{
            service.tick();
            verifyNoInteractions(events);
            assertFalse(service.get(1,a.roomId()).players().stream().filter(p->p.id().equals(b.self())).findFirst().orElseThrow().moderated());
        };
        State afterMute=service.act(1,"u1","s1","mute",command(a.roomId(),b.self(),true));
        assertTrue(afterMute.players().stream().filter(p->p.id().equals(b.self())).findFirst().orElseThrow().moderated());
    }

    @Test void rejoinAbortsAndMarksOfflineIfNewSessionDisconnectsMidRotate(){
        State room=create(1);
        long[] seq={0};
        walkTo(1,room.roomId(),-4.5,9.5,seq);
        walkTo(1,room.roomId(),-8.6,11.1,seq);
        service.act(1,"u1","s1","sit",itemCommand(room.roomId(),"bench-sw-0",null));

        // Simulate new socket "s2" disconnecting while rejoin's rotate() is blocked in LiveKit HTTP
        voice.onRemove=()->service.disconnected("s2");
        error("CONNECTION_REQUIRED",()->service.act(1,"u1","s2","rejoin",command(room.roomId(),null,null)));

        Player p1=service.get(1,room.roomId()).players().getFirst();
        assertFalse(p1.online(),"rejoin must leave member offline when new session disconnected mid-rotate");
        assertNull(p1.seat(),"seat must be released immediately on mid-rotate disconnect");
    }
}
