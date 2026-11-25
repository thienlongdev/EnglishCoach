package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.*;
import java.nio.ByteBuffer;
import java.time.*;
import java.util.*;

/**
 * What voice has cost this month, in the unit the provider bills: minutes one participant is connected. No audio and no personal data.
 *
 * A connection holds a short lease, renewed while the provider still shows it connected, and is charged what it really lasted when it ends;
 * the rest of the lease goes back. The provider's own participant list decides how long it lasted, never the client. Whatever cannot be proven
 * is charged, never refunded: `minutes` also holds the whole-room reservations of the earlier releases, which nobody can now tell apart from use.
 */
@Component
public final class ArenaUsage implements AutoCloseable {
    /** One open connection. All times are milliseconds on the application clock. */
    public static class Lease {
        public String room, identity;
        /** The token was issued. */
        public long opened;
        /** Admission counts this far ahead. */
        public long paidUntil;
        /** The provider showed it connected: when it joined, and when last seen. Zero until then. */
        public long joined, seen;
    }
    public static class Ledger {
        /** Settled minutes per UTC month. */
        public Map<String,Long> minutes = new TreeMap<>();
        public Set<String> rooms = new TreeSet<>();
        public Map<String,Lease> leases = new TreeMap<>();
    }
    /** One block of a lease. Long enough that renewals are rare, short enough that a lost connection holds little back. */
    static final long BLOCK_MS = 5 * 60_000;
    /** Renewed when this little of it is left: two sweeps' worth. */
    static final long RENEW_MS = 90_000;
    /** A token nobody used: it expired 120 s after it was issued, and the provider never saw anyone with it. */
    static final long UNUSED_MS = 150_000;
    static final int MAX_ROOMS = 48;
    private static final int MAX_LEASES = 128;
    private final Path directory;
    private final long monthlyLimit;
    private final int concurrentLimit;
    private final ObjectMapper json;
    private Ledger ledger;
    private boolean recovered;
    private FileChannel lockChannel;
    private FileLock lock;

    public ArenaUsage(@Value("${SPEAKING_ARENA_USAGE_DIR:storage/speaking-arena}") String directory,
                      @Value("${SPEAKING_ARENA_MONTHLY_MINUTES:0}") long monthlyLimit,
                      @Value("${SPEAKING_ARENA_MAX_PARTICIPANTS:16}") int concurrentLimit,
                      ObjectMapper json) {
        this.directory=Path.of(directory).toAbsolutePath().normalize();
        this.monthlyLimit=Math.max(0,monthlyLimit);
        this.concurrentLimit=Math.max(2,Math.min(64,concurrentLimit));this.json=json;
    }
    public boolean configured(){return monthlyLimit>0;}
    public int concurrentLimit(){return concurrentLimit;}
    private static String key(String room,String identity){return room+"|"+identity;}
    private static String month(long at){return YearMonth.from(Instant.ofEpochMilli(at).atZone(ZoneOffset.UTC)).toString();}
    private void load(){
        if(ledger!=null)return;
        try {
            Files.createDirectories(directory);
            lockChannel=FileChannel.open(directory.resolve("usage.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);
            lock=lockChannel.tryLock();if(lock==null)throw new IllegalStateException();
            Path file=directory.resolve("usage.json");
            ledger=Files.exists(file)?json.readValue(Files.readAllBytes(file),Ledger.class):new Ledger();
            if(ledger.leases==null)ledger.leases=new TreeMap<>();
            if(ledger.minutes==null||ledger.rooms==null||ledger.rooms.size()>MAX_ROOMS||ledger.minutes.size()>240||ledger.leases.size()>MAX_LEASES
                    ||ledger.minutes.entrySet().stream().anyMatch(e->!e.getKey().matches("\\d{4}-\\d{2}")||e.getValue()==null||e.getValue()<0)
                    ||ledger.rooms.stream().anyMatch(r->!r.matches("ec-speaking-[0-9a-f-]{36}"))
                    ||ledger.leases.values().stream().anyMatch(l->l==null||l.room==null||l.identity==null||l.opened<=0||l.paidUntil<l.opened))throw new IllegalStateException();
        } catch(Exception e){ledger=null;release();throw ArenaService.fail(503,"USAGE_UNAVAILABLE");}
    }
    private void save(){
        try {
            byte[] bytes=json.writeValueAsBytes(ledger);Path temp=directory.resolve("usage.next");
            try(FileChannel file=FileChannel.open(temp,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE)){
                ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);
            }
            Files.move(temp,directory.resolve("usage.json"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        }catch(Exception e){throw ArenaService.fail(503,"USAGE_UNAVAILABLE");}
    }
    public synchronized Set<String> orphanRooms(){load();return Set.copyOf(ledger.rooms);}
    public synchronized void register(String room){
        load();
        if(room==null||!room.matches("ec-speaking-[0-9a-f-]{36}"))throw ArenaService.fail(400,"ROOM_INVALID");
        if(!ledger.rooms.contains(room)&&ledger.rooms.size()>=MAX_ROOMS)throw ArenaService.fail(429,"ARENA_FULL");
        if(ledger.rooms.add(room))save();
    }
    /** The provider room is gone: whatever was connected in it stopped now. */
    public synchronized void closeRoom(String room,long now){
        load();boolean changed=ledger.rooms.remove(room);
        for(Lease l:List.copyOf(ledger.leases.values()))if(l.room.equals(room)){end(l,now);changed=true;}
        if(changed)save();
    }

    /** Whole minutes this stretch takes out of each month it touches, the way a provider rounds a connection: up. */
    private static Map<String,Long> split(long from,long to){
        Map<String,Long> out=new TreeMap<>();
        if(to<=from)return out;
        long at=from;
        while(at<to){
            YearMonth m=YearMonth.from(Instant.ofEpochMilli(at).atZone(ZoneOffset.UTC));
            long boundary=m.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),until=Math.min(to,boundary);
            out.merge(m.toString(),(until-at+59_999)/60_000,Long::sum);
            at=until;
        }
        return out;
    }
    private static long start(Lease l){return l.joined>0?l.joined:l.opened;}
    /** The whole of what a lease still holds back in each month, as if nothing had been used of it yet. */
    private Map<String,Long> held(){
        Map<String,Long> out=new TreeMap<>();
        for(Lease l:ledger.leases.values())split(start(l),l.paidUntil).forEach((m,v)->out.merge(m,v,Long::sum));
        return out;
    }
    /** Would this much more still fit under the limit in every month it touches? */
    private boolean fits(long from,long to){
        Map<String,Long> open=held();
        for(var e:split(from,to).entrySet())
            if(ledger.minutes.getOrDefault(e.getKey(),0L)+open.getOrDefault(e.getKey(),0L)+e.getValue()>monthlyLimit)return false;
        return true;
    }
    /** Charges a connection up to `to` and forgets it. Ending one twice costs nothing the second time: it is no longer there. */
    private void charge(Lease l,long to){
        split(start(l),to).forEach((m,v)->ledger.minutes.merge(m,v,Long::sum));
        ledger.leases.remove(key(l.room,l.identity));
    }
    /** Ended now: what the provider saw is charged up to now, a token it never saw costs nothing once it has lapsed, a fresh one could still be in use. */
    private void end(Lease l,long now){
        if(l.seen==0&&now-l.opened>=UNUSED_MS){ledger.leases.remove(key(l.room,l.identity));return;}
        charge(l,now);
    }

    /**
     * Before a token is issued, and refused if the month has no room for one more block. The same identity asking again (a reconnect with the
     * same grant) keeps its lease: a new token is not a second connection.
     */
    public synchronized void open(String room,String identity,long now){
        if(!configured())throw ArenaService.fail(503,"VOICE_BUDGET_UNCONFIGURED");
        load();recoverOnce(now);
        String k=key(room,identity);
        if(ledger.leases.containsKey(k))return;
        if(ledger.leases.size()>=MAX_LEASES)throw ArenaService.fail(429,"VOICE_PROVIDER_LIMIT");
        if(!fits(now,now+BLOCK_MS))throw ArenaService.fail(429,"VOICE_QUOTA_EXHAUSTED");
        Lease l=new Lease();l.room=room;l.identity=identity;l.opened=now;l.paidUntil=now+BLOCK_MS;
        ledger.leases.put(k,l);
        save(); // an uncertain write keeps the reservation in memory; never issue on persistence failure
    }
    /** Revoked, left, removed. Safe to call any number of times. */
    public synchronized void settle(String room,String identity,long now){
        settle(room,identity,now,false);
    }
    /**
     * Revoked, left, removed. When the provider explicitly reports not-found ({@code neverJoined == true}) and the provider
     * never observed this identity connected ({@code l.seen == 0}), the lease is released at 0 minutes instead of rounding up to 1 minute.
     */
    public synchronized void settle(String room,String identity,long now,boolean neverJoined){
        load();Lease l=ledger.leases.get(key(room,identity));
        if(l==null)return;
        if(neverJoined&&l.seen==0){ledger.leases.remove(key(l.room,l.identity));save();return;}
        end(l,now);save();
    }
    /** Releases a freshly opened lease whose token was never issued (e.g., provider failed after open). */
    public synchronized void rollback(String room,String identity,long openedAt){
        load();String k=key(room,identity);Lease l=ledger.leases.get(k);
        if(l==null||l.seen>0||l.opened!=openedAt)return;
        ledger.leases.remove(k);save();
    }
    /** The rooms the provider has to be asked about. */
    public synchronized Set<String> leasedRooms(){
        load();Set<String> out=new TreeSet<>();
        for(Lease l:ledger.leases.values())out.add(l.room);
        return out;
    }
    /** Identities currently holding open leases in the given room. */
    public synchronized Set<String> leasedIdentities(String room){
        load();Set<String> out=new HashSet<>();
        for(Lease l:ledger.leases.values())if(l.room.equals(room))out.add(l.identity);
        return out;
    }
    /**
     * One look at the provider's list for this room (`present`: identity → when it joined; null when the provider could not be asked). Keeps the
     * connections it shows, renews the ones about to run out, closes the ones it no longer shows. Returns the identities the month has no more
     * room for: their connection has to be ended, by the caller, before the lease runs out.
     */
    public synchronized List<String> reconcile(String room,Map<String,Long> present,long now){
        load();
        List<String> revoke=new ArrayList<>();boolean changed=false;
        for(Lease l:List.copyOf(ledger.leases.values())){
            if(!l.room.equals(room))continue;
            boolean known=present!=null,here=known&&present.containsKey(l.identity);
            if(here){
                long joined=Math.max(l.opened,Math.min(now,Optional.ofNullable(present.get(l.identity)).orElse(now)));
                if(l.joined==0||joined<l.joined)l.joined=joined;
                l.seen=now;changed=true;
            }
            if(known&&!here){
                // Left between the last look and this one: charged up to this one. Never seen: nothing yet, nothing at all once the token has lapsed.
                if(l.seen>0){charge(l,now);changed=true;}
                else if(now-l.opened>=UNUSED_MS){ledger.leases.remove(key(l.room,l.identity));changed=true;}
                continue;
            }
            // Connected, or the provider cannot say: assumed connected, since being wrong that way never undercounts.
            if(l.paidUntil-now<=RENEW_MS){
                long next=l.paidUntil+BLOCK_MS;
                if(fits(l.paidUntil,next)){l.paidUntil=next;changed=true;}
                else revoke.add(l.identity);
            }
        }
        if(changed)save();
        return revoke;
    }
    /**
     * After a restart nothing is left of the rooms these leases belonged to, and their connections last until the provider room is closed. A lease
     * the provider had seen is charged to its end, the upper bound of what it can have cost; a token never seen and already lapsed costs nothing.
     */
    private void recoverOnce(long now){
        if(recovered)return;
        recovered=true;
        if(ledger.leases.isEmpty())return;
        for(Lease l:List.copyOf(ledger.leases.values())){
            if(l.seen==0&&now-l.opened>=UNUSED_MS)ledger.leases.remove(key(l.room,l.identity));
            else charge(l,l.paidUntil);
        }
        save();
    }
    public synchronized void recover(long now){load();recoverOnce(now);}
    public synchronized Map<String,Object> status(long now){
        if(!configured())return Map.of("configured",false,"monthlyLimit",monthlyLimit,"reservedMinutes",0);
        load();String m=month(now);
        long used=ledger.minutes.getOrDefault(m,0L),open=held().getOrDefault(m,0L);
        return Map.of("configured",true,"month",m,"monthlyLimit",monthlyLimit,"usedMinutes",used,"openMinutes",open,"reservedMinutes",used+open,"openConnections",ledger.leases.size(),"measurement","settled-connection-minutes");
    }
    private void release(){try{if(lock!=null)lock.release();}catch(Exception ignored){}try{if(lockChannel!=null)lockChannel.close();}catch(Exception ignored){}}
    @jakarta.annotation.PreDestroy public synchronized void close(){release();ledger=null;recovered=false;}
}
