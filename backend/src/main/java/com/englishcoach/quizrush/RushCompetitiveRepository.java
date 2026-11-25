package com.englishcoach.quizrush;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.util.*;

/** Durable snapshots are private server state. Membership scopes all learner reads. */
@Repository
public class RushCompetitiveRepository {
    private final java.util.concurrent.atomic.AtomicLong sqlWrites=new java.util.concurrent.atomic.AtomicLong(),sqlReads=new java.util.concurrent.atomic.AtomicLong();
    public long sqlWriteCount(){return sqlWrites.get();}
    public long sqlReadCount(){return sqlReads.get();}
    private final JdbcTemplate jdbc; private final ObjectMapper json; private final TransactionTemplate tx;
    public RushCompetitiveRepository(JdbcTemplate jdbc,ObjectMapper json,PlatformTransactionManager manager){this.jdbc=jdbc;this.json=json;tx=new TransactionTemplate(manager);}
    public String encode(RushCompetitiveService.Room room){try{return json.writeValueAsString(room);}catch(Exception e){throw new RushException(503,"ROOM_UNAVAILABLE");}}
    /**
     * One room as it will be written, captured under the room lock (snapshot text and member rows): the write itself reads no
     * live object, so it can run after the lock is released. The database is a network round trip away per statement.
     */
    public record Stored(UUID id,long owner,UUID createRequest,String invitation,String status,String snapshot,Map<Long,Boolean> members) {}
    public Stored stored(RushCompetitiveService.Room room){return capture(room,encode(room));}
    public static Stored capture(RushCompetitiveService.Room room,String snapshot){
        if(snapshot.length()>900000)throw new RushException(503,"ROOM_CAPACITY");
        boolean live=!Set.of("FINISHED","CANCELED").contains(room.race.status);var members=new LinkedHashMap<Long,Boolean>();
        for(var p:room.race.racers)if(!p.bot())members.put(p.userId,live&&!p.phase.equals("DNF"));
        return new Stored(room.id,room.owner,room.createRequest,room.invitation,room.race.status,snapshot,members);
    }
    public void saveRematch(RushCompetitiveService.Room previous,RushCompetitiveService.Room next){writeRematch(stored(previous),stored(next));}
    public void writeRematch(Stored previous,Stored next){tx.executeWithoutResult(t->{insert(previous);insert(next);});}
    public RushCompetitiveService.Room decode(String value){try{return json.readValue(value,RushCompetitiveService.Room.class);}catch(Exception e){throw new RushException(503,"ROOM_UNAVAILABLE");}}
    public void save(RushCompetitiveService.Room room){write(stored(room));}
    public void write(Stored room){tx.executeWithoutResult(t->insert(room));}
    private void insert(Stored room){
        sqlWrites.incrementAndGet();jdbc.update("""
            INSERT INTO public.quiz_rush_rooms(id,owner_user_id,create_request,invitation,status,snapshot)
            VALUES (?,?,?,?,?,?::jsonb) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,
            updated_at=now(),snapshot=EXCLUDED.snapshot WHERE quiz_rush_rooms.owner_user_id=EXCLUDED.owner_user_id
            """,room.id(),room.owner(),room.createRequest(),room.invitation(),room.status(),room.snapshot());
        // Avoid flipping active=false->true on every save (preserves HOT updates and halves member dead tuples)
        if (room.members().isEmpty()) {
            sqlWrites.incrementAndGet();
            jdbc.update("UPDATE public.quiz_rush_members SET active=false WHERE room_id=? AND active=true", room.id());
        } else {
            Long[] presentIds = room.members().keySet().toArray(Long[]::new);
            sqlWrites.incrementAndGet();
            jdbc.update("UPDATE public.quiz_rush_members SET active=false WHERE room_id=? AND active=true AND NOT (user_id = ANY(?))",
                    room.id(), presentIds);
            for (var member : room.members().entrySet()) {
                sqlWrites.incrementAndGet();
                jdbc.update("""
                    INSERT INTO public.quiz_rush_members(room_id,user_id,active) VALUES(?,?,?)
                    ON CONFLICT(room_id,user_id) DO UPDATE SET active=EXCLUDED.active
                    WHERE quiz_rush_members.active IS DISTINCT FROM EXCLUDED.active
                    """, room.id(), member.getKey(), member.getValue());
            }
        }
    }
    public RushCompetitiveService.Room get(long user,UUID id){
        sqlReads.incrementAndGet();var rows=jdbc.queryForList("SELECT r.snapshot::text FROM public.quiz_rush_rooms r JOIN public.quiz_rush_members m ON m.room_id=r.id WHERE m.user_id=? AND r.id=?",String.class,user,id);
        if(rows.isEmpty())throw new RushException(404,"ROOM_NOT_FOUND");return decode(rows.getFirst());
    }
    public RushCompetitiveService.Room byRequest(long user,UUID id){sqlReads.incrementAndGet();var rows=jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_rooms WHERE owner_user_id=? AND create_request=?",String.class,user,id);return rows.isEmpty()?null:decode(rows.getFirst());}
    public List<RushCompetitiveService.Room> history(long user){sqlReads.incrementAndGet();return jdbc.queryForList("SELECT r.snapshot::text FROM public.quiz_rush_rooms r JOIN public.quiz_rush_members m ON m.room_id=r.id WHERE m.user_id=? AND r.status IN ('FINISHED','CANCELED') ORDER BY r.updated_at DESC LIMIT 20",String.class,user).stream().map(this::decode).toList();}
    // Internal bounded recovery, never exposed as an unscoped learner endpoint.
    public List<RushCompetitiveService.Room> recover(){sqlReads.incrementAndGet();return jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_rooms WHERE status NOT IN ('FINISHED','CANCELED') ORDER BY created_at LIMIT 65",String.class).stream().map(this::decode).toList();}
}
