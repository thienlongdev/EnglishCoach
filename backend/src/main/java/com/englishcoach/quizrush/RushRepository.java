package com.englishcoach.quizrush;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.util.*;
import java.time.*;

@Repository
public class RushRepository {
    public static class Race {
        public UUID id,startRequest;public String difficulty,topic,version,status="ACTIVE",startedAt,finishedAt;
        public int checkpoint,incorrect;public List<RushQuestions.Pinned> questions=new ArrayList<>();
        public int courseVersion=1;public double spacing=1100;public List<Double> boundaries=new ArrayList<>();
        /** Version 5: the planned obstacle zones and rising walls (absent in older snapshots). */
        public List<RushTrials.Hazard> hazards=new ArrayList<>();public List<Boolean> rising=new ArrayList<>();
        /** Version 6: wall motion and orbs (absent in older snapshots). */
        public List<RushReforged.Wall> walls=new ArrayList<>();public List<RushReforged.Orb> orbs=new ArrayList<>();
        public Map<String,Integer> mistakes=new HashMap<>();public Set<String> tried=new HashSet<>();
        public Map<String,Receipt> receipts=new LinkedHashMap<>();
    }
    public record Receipt(String command,boolean correct,String explanation) {}
    private final JdbcTemplate jdbc;private final ObjectMapper json;
    public RushRepository(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    public void lock(long user){jdbc.queryForObject("SELECT pg_advisory_xact_lock(?)",Object.class,0x5255534800000000L+user);}
    private Race decode(String raw){try{return json.readValue(raw,Race.class);}catch(Exception e){throw new RushException(503,"RACE_UNAVAILABLE");}}
    public Race get(long user,UUID id){var rows=jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_sessions WHERE user_id=? AND id=?",String.class,user,id);if(rows.isEmpty())throw new RushException(404,"RACE_NOT_FOUND");return decode(rows.getFirst());}
    public Race byRequest(long user,UUID request){var rows=jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_sessions WHERE user_id=? AND start_request=?",String.class,user,request);return rows.isEmpty()?null:decode(rows.getFirst());}
    public Race active(long user){var rows=jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_sessions WHERE user_id=? AND status='ACTIVE'",String.class,user);return rows.isEmpty()?null:decode(rows.getFirst());}
    public void save(long user,Race race){try{
        jdbc.update("""
            INSERT INTO public.quiz_rush_sessions(id,user_id,start_request,status,started_at,finished_at,snapshot)
            VALUES (?,?,?,?,?::timestamptz,?::timestamptz,?::jsonb)
            ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,finished_at=EXCLUDED.finished_at,snapshot=EXCLUDED.snapshot
            WHERE quiz_rush_sessions.user_id=EXCLUDED.user_id
            """,race.id,user,race.startRequest,race.status,race.startedAt,race.finishedAt,json.writeValueAsString(race));
    }catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new RushException(503,"RACE_UNAVAILABLE");}}
    public Set<String> recent(long user){
        var rows=jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 8",String.class,user);
        var ids=new HashSet<String>();for(String row:rows)for(var q:decode(row).questions)ids.add(q.sourceId());return ids;
    }
    public List<Race> history(long user){return jdbc.queryForList("SELECT snapshot::text FROM public.quiz_rush_sessions WHERE user_id=? AND status='FINISHED' ORDER BY finished_at DESC LIMIT 20",String.class,user).stream().map(this::decode).toList();}
}
