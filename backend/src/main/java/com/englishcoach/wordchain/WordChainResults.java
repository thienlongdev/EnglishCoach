package com.englishcoach.wordchain;

import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.time.Instant;
import java.util.*;

@Service
public class WordChainResults {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final LearningEventService learning;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.progress.service.UnifiedProgressService progress;
    public WordChainResults(JdbcTemplate jdbc, ObjectMapper json, PlatformTransactionManager manager,
                            LearningEventService learning) {
        this.jdbc = jdbc; this.json = json; this.tx = new TransactionTemplate(manager); this.learning = learning;
    }
    public void save(UUID id, String mode, Map<Long, Map<String, Object>> results, Instant at) {
        tx.executeWithoutResult(status -> results.forEach((user, result) -> {
            try {
                jdbc.update("""
                    INSERT INTO public.word_chain_results(match_id,user_id,mode,accepted_count,finished_at,result)
                    VALUES (?,?,?,?,?,?::jsonb) ON CONFLICT (match_id,user_id) DO NOTHING
                    """, id, user, mode, result.get("acceptedCount"), java.sql.Timestamp.from(at), json.writeValueAsString(result));
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new IllegalStateException("Result serialization failed", e);
            }
        }));
        results.forEach((user, result) -> {
            if (((Number) result.get("acceptedCount")).intValue() > 0) {
                learning.recordEventSafely(user, "WORD_CHAIN_PLAYED", id.toString(), at);
                if (progress != null) progress.invalidateCache(user);
            }
        });
    }
    public List<Map<String, Object>> history(long user) {
        return jdbc.query("""
            SELECT match_id,mode,accepted_count,finished_at FROM public.word_chain_results
            WHERE user_id=? ORDER BY finished_at DESC LIMIT 20
            """, (rs, row) -> Map.of("matchId", rs.getString(1), "mode", rs.getString(2),
                "acceptedCount", rs.getInt(3), "finishedAt", rs.getTimestamp(4).toInstant().toString()), user);
    }
    public String result(long user, UUID match) {
        var rows = jdbc.queryForList("SELECT result::text FROM public.word_chain_results WHERE user_id=? AND match_id=?", String.class, user, match);
        if (rows.isEmpty()) throw new WordChainRules.Rejection("RESULT_NOT_FOUND");
        return rows.getFirst();
    }
}
