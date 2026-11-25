package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Voice is charged what the provider shows it lasted: bounded leases, settled once, whatever goes wrong on the way. */
class ArenaUsageTest {
    @TempDir Path dir;
    static final String ROOM = "ec-speaking-00000000-0000-0000-0000-000000000001", OTHER = "ec-speaking-00000000-0000-0000-0000-000000000002";
    static final long T0 = Instant.parse("2026-11-02T00:00:00Z").toEpochMilli(), MIN = 60_000;
    ArenaUsage usage(long limit){return new ArenaUsage(dir.toString(),limit,8,new ObjectMapper());}
    ArenaUsage usage(){return usage(100);}
    static long used(ArenaUsage u,long at){return (long)u.status(at).get("usedMinutes");}
    static long open(ArenaUsage u,long at){return (long)u.status(at).get("openMinutes");}
    static Map<String,Long> here(long joined,String... ids){Map<String,Long> m=new HashMap<>();for(String i:ids)m.put(i,joined);return m;}

    @Test void aOneMinuteSessionCostsOneMinuteNotNinety(){try(var u=usage()){
        u.open(ROOM,"a",T0);assertEquals(5,open(u,T0),"one short block is held");
        u.reconcile(ROOM,here(T0+2000,"a"),T0+30_000);
        u.reconcile(ROOM,here(T0+2000,"a"),T0+55_000);
        u.reconcile(ROOM,Map.of(),T0+60_000);
        assertEquals(1,used(u,T0+MIN));assertEquals(0,open(u,T0+MIN));
    }}
    @Test void aTenMinuteSessionRenewsAndCostsTen(){try(var u=usage()){
        u.open(ROOM,"a",T0);
        for(long t=30_000;t<10*MIN;t+=30_000)assertTrue(u.reconcile(ROOM,here(T0,"a"),T0+t).isEmpty());
        assertTrue(open(u,T0+9*MIN)>=10,"the lease kept ahead of the talk");
        u.settle(ROOM,"a",T0+10*MIN);
        assertEquals(10,used(u,T0+10*MIN));assertEquals(0,open(u,T0+10*MIN));
    }}
    @Test void aDisconnectBeforeTheLeaseEndsGivesTheRestBack(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);
        u.reconcile(ROOM,Map.of(),T0+60_000);
        assertEquals(1,used(u,T0+MIN));assertEquals(0,open(u,T0+MIN),"four minutes went back");
    }}
    @Test void aTokenNobodyUsedCostsNothing(){try(var u=usage()){
        u.open(ROOM,"a",T0);
        u.reconcile(ROOM,Map.of(),T0+30_000);assertEquals(5,open(u,T0),"it may still connect");
        u.reconcile(ROOM,Map.of(),T0+ArenaUsage.UNUSED_MS);
        assertEquals(0,used(u,T0+3*MIN));assertEquals(0,open(u,T0+3*MIN));
    }}
    @Test void reconnectingOnTheSameGrantKeepsOneLease(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);
        u.open(ROOM,"a",T0+40_000);u.open(ROOM,"a",T0+45_000);
        assertEquals(5,open(u,T0+50_000),"a new token is not a second connection");
        u.settle(ROOM,"a",T0+2*MIN);assertEquals(2,used(u,T0+2*MIN));
    }}
    @Test void aReconnectOnANewIdentityIsANewConnection(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);u.settle(ROOM,"a",T0+MIN);
        u.open(ROOM,"b",T0+MIN);u.reconcile(ROOM,here(T0+MIN,"b"),T0+90_000);u.settle(ROOM,"b",T0+2*MIN);
        assertEquals(2,used(u,T0+2*MIN));
    }}
    @Test void everyParticipantIsChargedForThemselves(){try(var u=usage()){
        for(String id:List.of("a","b","c"))u.open(ROOM,id,T0);
        assertEquals(15,open(u,T0));
        u.reconcile(ROOM,here(T0,"a","b","c"),T0+30_000);
        u.reconcile(ROOM,here(T0,"a","b"),T0+60_000);
        u.reconcile(ROOM,here(T0,"a"),T0+2*MIN);
        u.reconcile(ROOM,Map.of(),T0+3*MIN);
        assertEquals(1+2+3,used(u,T0+3*MIN));
    }}
    @Test void concurrentRoomsDoNotTouchEachOther(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.open(OTHER,"a",T0);
        u.reconcile(ROOM,here(T0,"a"),T0+30_000);u.reconcile(OTHER,here(T0,"a"),T0+30_000);
        u.reconcile(ROOM,Map.of(),T0+MIN);
        assertEquals(1,used(u,T0+MIN));assertEquals(5,open(u,T0+MIN),"the other room still talks");
        assertEquals(Set.of(OTHER),u.leasedRooms());
    }}
    @Test void endingTwiceChargesOnce(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);
        u.settle(ROOM,"a",T0+MIN);u.settle(ROOM,"a",T0+MIN);u.settle(ROOM,"a",T0+9*MIN);u.closeRoom(ROOM,T0+9*MIN);u.reconcile(ROOM,Map.of(),T0+9*MIN);
        assertEquals(1,used(u,T0+9*MIN));
    }}
    @Test void aRestartChargesTheUpperBoundOnceAndNothingForALapsedToken(){
        try(var u=usage()){u.register(ROOM);u.open(ROOM,"seen",T0);u.reconcile(ROOM,here(T0,"seen"),T0+30_000);u.open(ROOM,"never",T0);u.open(OTHER,"fresh",T0+9*MIN);}
        try(var u=usage()){
            assertTrue(u.orphanRooms().contains(ROOM),"the room is still to be closed");
            u.recover(T0+10*MIN);
            assertEquals(5+5,used(u,T0+10*MIN),"the one seen and the one that might still have connected, to the end of their leases; the lapsed token nothing");
            assertEquals(0,open(u,T0+10*MIN));
            u.recover(T0+11*MIN);assertEquals(10,used(u,T0+11*MIN));
        }
        try(var u=usage()){u.recover(T0+12*MIN);assertEquals(10,used(u,T0+12*MIN),"settled once, for good");}
    }
    @Test void anUnreachableProviderNeverUndercounts(){try(var u=usage()){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);
        for(long t=60_000;t<20*MIN;t+=30_000)assertTrue(u.reconcile(ROOM,null,T0+t).isEmpty());
        assertTrue(open(u,T0+20*MIN)>=20,"still held while nobody can say it ended");
        u.reconcile(ROOM,Map.of(),T0+20*MIN);assertEquals(20,used(u,T0+20*MIN));
    }}
    @Test void aLeaseThatCrossesAMonthIsSplitExactly(){
        long end=Instant.parse("2026-11-30T23:59:00Z").toEpochMilli();
        try(var u=usage()){
            u.open(ROOM,"a",end);
            u.reconcile(ROOM,here(end,"a"),end+30_000);
            u.settle(ROOM,"a",end+3*MIN);
            assertEquals(1,used(u,end),"its last minute of November");
            assertEquals(2,used(u,end+3*MIN),"two minutes of December");
        }
    }
    @Test void aNewMonthStartsFromItsOwnBudget(){try(var u=usage(10)){
        u.open(ROOM,"a",T0);u.reconcile(ROOM,here(T0,"a"),T0+30_000);u.settle(ROOM,"a",T0+10*MIN);
        assertEquals(10,used(u,T0+10*MIN));
        assertEquals("VOICE_QUOTA_EXHAUSTED",assertThrows(ResponseStatusException.class,()->u.open(ROOM,"b",T0+11*MIN)).getReason());
        long next=Instant.parse("2026-12-01T00:00:00Z").toEpochMilli();
        u.open(ROOM,"c",next);assertEquals(0,used(u,next));assertEquals(5,open(u,next));
    }}
    @Test void anExhaustedMonthRefusesNewOnesAndEndsTheOnesItCannotRenew(){try(var u=usage(12)){
        u.open(ROOM,"a",T0);u.open(ROOM,"b",T0);
        assertEquals("VOICE_QUOTA_EXHAUSTED",assertThrows(ResponseStatusException.class,()->u.open(ROOM,"c",T0)).getReason(),"10 held, 12 allowed, a block does not fit");
        var both=here(T0,"a","b");
        assertTrue(u.reconcile(ROOM,both,T0+60_000).isEmpty());
        var revoke=u.reconcile(ROOM,both,T0+4*MIN);
        assertEquals(List.of("a","b"),revoke,"no block left for either: both are told to end while their leases still cover them");
        u.settle(ROOM,"a",T0+4*MIN);u.settle(ROOM,"b",T0+4*MIN);
        assertEquals(8,used(u,T0+4*MIN));
    }}
    @Test void theOldReservationsStayChargedAndOldLedgersStillRead()throws Exception{
        Files.writeString(dir.resolve("usage.json"),"{\"minutes\":{\"2026-11\":94},\"rooms\":[]}");
        try(var u=usage()){
            assertEquals(94,used(u,T0),"nobody can tell how much of it was really used: nothing is refunded");
            u.open(ROOM,"a",T0);
            assertEquals("VOICE_QUOTA_EXHAUSTED",assertThrows(ResponseStatusException.class,()->u.open(ROOM,"b",T0)).getReason(),"94 + 5 held, a second block would pass 100");
        }
    }
    @Test void concurrentProcessAndCorruptLedgerFailClosed()throws Exception{
        try(var first=usage();var second=usage()){first.orphanRooms();assertThrows(ResponseStatusException.class,second::orphanRooms);}
        Files.writeString(dir.resolve("usage.json"),"broken");
        try(var u=usage()){assertThrows(ResponseStatusException.class,u::orphanRooms);}
    }
    @Test void registerCapsAtMaxRoomsAndSurvivesReload(){
        try(var u=usage()){
            for(int i=0;i<ArenaUsage.MAX_ROOMS;i++)u.register("ec-speaking-"+UUID.randomUUID());
            assertEquals(ArenaUsage.MAX_ROOMS,u.orphanRooms().size());
            assertEquals("ARENA_FULL",assertThrows(ResponseStatusException.class,()->u.register("ec-speaking-"+UUID.randomUUID())).getReason());
        }
        try(var reloaded=usage()){
            assertEquals(ArenaUsage.MAX_ROOMS,reloaded.orphanRooms().size(),"48-room cap ensures restart load() never bricks");
        }
    }
    @Test void settleNeverJoinedDropsAtZeroMinutesAndRollbackPreservesOlderLease(){try(var u=usage()){
        u.open(ROOM,"never",T0);
        u.settle(ROOM,"never",T0+1_000,true);
        assertEquals(0,used(u,T0+1_000),"404 + seen==0 must release lease at 0 minutes");
        assertEquals(0,open(u,T0+1_000));

        // If provider DID see the participant, neverJoined flag cannot suppress charging
        u.open(ROOM,"seen",T0);
        u.reconcile(ROOM,here(T0,"seen"),T0+30_000);
        u.settle(ROOM,"seen",T0+60_000,true);
        assertEquals(1,used(u,T0+60_000));

        // Rollback removes only freshly opened unseen lease with matching openedAt timestamp
        u.open(ROOM,"fresh",T0+120_000);
        u.rollback(ROOM,"fresh",T0+120_000);
        assertEquals(0,open(u,T0+120_000));
        u.open(ROOM,"existing",T0+120_000);
        u.rollback(ROOM,"existing",T0+125_000);
        assertEquals(5,open(u,T0+125_000),"mismatched openedAt must not delete an older active lease");
    }}
}
