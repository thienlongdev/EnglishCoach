package com.englishcoach.speaking.arena;

import org.springframework.stereotype.Component;
import java.util.*;
import java.util.concurrent.*;

/**
 * Keeps voice leases true to what the provider shows: one list request per room that has a lease, on its own thread and never under a room lock.
 * Nothing runs while nobody is connected. Everything here is server to server: a client that says nothing, lies or vanishes changes nothing.
 */
@Component
public class ArenaVoiceSettlement implements AutoCloseable {
    static final long EVERY_MS = 30_000, BUDGET_MS = 12_000;
    private final ArenaVoice voice;
    private final ArenaUsage usage;
    private final java.util.function.LongSupplier clock;
    private final Runnable recoverRooms;
    private final ScheduledExecutorService timer;

    @org.springframework.beans.factory.annotation.Autowired
    public ArenaVoiceSettlement(ArenaVoice voice,ArenaUsage usage,ArenaService arena){
        this(voice,usage,System::currentTimeMillis,arena::recover);
        // First pass soon after start: rooms from before a restart are closed and charged without waiting for the next person to come in.
        timer.scheduleWithFixedDelay(this::safeSweep,10_000,EVERY_MS,TimeUnit.MILLISECONDS);
    }
    ArenaVoiceSettlement(ArenaVoice voice,ArenaUsage usage,java.util.function.LongSupplier clock,Runnable recoverRooms){
        this.voice=voice;this.usage=usage;this.clock=clock;this.recoverRooms=recoverRooms;
        this.timer=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"voice-settlement");t.setDaemon(true);return t;});
    }
    private void safeSweep(){try{sweep();}catch(RuntimeException ignored){/* The ledger or the provider is away: the next sweep tries again. */}}
    void sweep(){
        if(!usage.configured())return;
        long now=clock.getAsLong(),deadline=System.currentTimeMillis()+BUDGET_MS;
        usage.recover(now);
        if(voice.available())recoverRooms.run();
        for(String room:usage.leasedRooms()){
            if(System.currentTimeMillis()>deadline)return; // A slow provider costs one sweep's time at most; the rest come next time, their leases still cover them.
            Map<String,Long> present;
            try{present=voice.participants(room);}catch(RuntimeException e){present=null;}
            Set<String> beforeLeases=present!=null?usage.leasedIdentities(room):Set.of();
            List<String> revoke=usage.reconcile(room,present,clock.getAsLong());
            if(present!=null){
                Set<String> afterLeases=usage.leasedIdentities(room);
                for(String id:beforeLeases){
                    if(!afterLeases.contains(id))voice.evictIdentity(room,id);
                }
                Set<String> active=new HashSet<>(present.keySet());
                active.addAll(afterLeases);
                voice.reconcileRoom(room,active);
            }
            for(String identity:revoke){
                try{
                    boolean existed=voice.remove(room,identity);
                    usage.settle(room,identity,clock.getAsLong(),!existed);
                }catch(RuntimeException ignored){/* Still connected, still charged: tried again next time. */}
            }
        }
    }
    @jakarta.annotation.PreDestroy public void close(){timer.shutdownNow();}
}
