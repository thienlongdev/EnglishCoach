package com.englishcoach.quizrush;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import java.util.*;

/**
 * Owner-scoped exposure read: the source ids of the account's last 60 Solo journeys and last 24 races it took part in,
 * newest first. Only ids leave the database (JSON paths), never question text or other racers' data. Bounded: at most
 * 84 snapshots × 20 questions.
 */
@Component
public class RushExposureStore implements RushExposure {
    private final JdbcTemplate jdbc;
    public RushExposureStore(JdbcTemplate jdbc){this.jdbc=jdbc;}
    @Override public Set<String> recent(long user){
        var rows=jdbc.queryForList("""
            SELECT source, at FROM (
              SELECT q.value->>'sourceId' AS source, s.started_at AS at, q.ordinality AS position
              FROM (SELECT snapshot, started_at FROM public.quiz_rush_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 60) s
              CROSS JOIN LATERAL jsonb_array_elements(s.snapshot->'questions') WITH ORDINALITY q
              UNION ALL
              SELECT q.value->>'sourceId', r.created_at, q.ordinality
              FROM (SELECT r.snapshot, r.created_at FROM public.quiz_rush_rooms r JOIN public.quiz_rush_members m ON m.room_id=r.id
                    WHERE m.user_id=? ORDER BY r.created_at DESC LIMIT 24) r
              CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'race'->'questions') WITH ORDINALITY q
            ) recent WHERE source IS NOT NULL ORDER BY at DESC, position
            """,user,user);
        var result=new LinkedHashSet<String>();for(var row:rows)result.add(String.valueOf(row.get("source")));
        return result;
    }
}
