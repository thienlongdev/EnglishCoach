package com.englishcoach.sentinel;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * Durable record of attempts (V119). A state write never moves a terminal row (SQL guard + trigger), so writes that
 * arrive out of order cannot regress an attempt. Event rows are append-only. Writes off the request path go through ONE
 * background writer (bounded queue); never called under a game's room lock.
 */
public class SentinelStore {
    private static final Logger log = LoggerFactory.getLogger(SentinelStore.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2048), r -> {
        var t = new Thread(r, "sentinel-writer"); t.setDaemon(true); return t;
    });

    public SentinelStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** Writes the attempt's current state and the change's event now (caller's thread). */
    public void write(SentinelAttempt.Change change) {
        var a = change.attempt();
        jdbc.update("""
            INSERT INTO public.sentinel_attempts(id,user_id,activity,policy,policy_version,state,subject_ref,acknowledged_at,created_at,
              activated_at,ended_at,end_detail,evidence)
            VALUES (?,?,?,'STRICT_FOCUS',?,?,?,?,?,?,?,?,CAST(? AS jsonb))
            ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,
              subject_ref=COALESCE(EXCLUDED.subject_ref,sentinel_attempts.subject_ref),
              activated_at=COALESCE(sentinel_attempts.activated_at,EXCLUDED.activated_at),
              ended_at=COALESCE(sentinel_attempts.ended_at,EXCLUDED.ended_at),
              end_detail=COALESCE(sentinel_attempts.end_detail,EXCLUDED.end_detail),
              evidence=sentinel_attempts.evidence || EXCLUDED.evidence
            WHERE sentinel_attempts.state IN ('READY','ACTIVE') AND sentinel_attempts.state<>EXCLUDED.state
              AND NOT (sentinel_attempts.state='ACTIVE' AND EXCLUDED.state='READY')
            """, a.id, a.user, a.activity, SentinelPolicy.POLICY_VERSION, change.to().name(), a.subject(),
            ts(a.acknowledgedAt), ts(a.createdAt), ts(a.activatedAt()), ts(a.endedAt()), clip(a.detail(), 48), json(a.evidence()));
        jdbc.update("INSERT INTO public.sentinel_attempt_events(attempt_id,at,kind,detail) VALUES (?,?,?,CAST(? AS jsonb))",
            a.id, ts(change.at()), clip(change.kind(), 40),
            json(Map.of("from", change.from() == null ? "NEW" : change.from().name(), "to", change.to().name(), "detail", Objects.toString(change.detail(), ""))));
    }

    /** Queued write; a full queue or a failure is logged (the in-memory decision stands; a ranked row needs the durable state). */
    public void writeLater(SentinelAttempt.Change change) {
        if (change == null) return;
        try {
            writer.execute(() -> {
                try { write(change); } catch (Exception e) { log.warn("Echo Sentinel write failed for attempt {}: {}", change.attempt().id, e.getClass().getSimpleName()); }
            });
        } catch (RejectedExecutionException e) {
            log.warn("Echo Sentinel writer queue full; attempt {} {} kept in memory only", change.attempt().id, change.to());
        }
    }

    public record Stored(java.util.UUID id, String state, String detail) {}
    /** The newest stored attempt of this learner bound to this subject. */
    public Stored stateOf(long user, String activity, String subject) {
        var rows = jdbc.query("SELECT id,state,end_detail FROM public.sentinel_attempts WHERE user_id=? AND activity=? AND subject_ref=? ORDER BY created_at DESC LIMIT 1",
            (rs, i) -> new Stored(rs.getObject(1, java.util.UUID.class), rs.getString(2), rs.getString(3)), user, activity, subject);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static Timestamp ts(Instant i) { return i == null ? null : Timestamp.from(i); }
    private static String clip(String s, int n) { return s == null ? null : s.length() <= n ? s : s.substring(0, n); }
    private static String json(Object o) {
        try { return JSON.writeValueAsString(o); } catch (Exception e) { return "{}"; }
    }
    public void close() { writer.shutdown(); }
}
