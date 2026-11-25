package com.englishcoach.ai.echo;

import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Per-turn accounting (V128 {@code echo_ai_turns}): route, model, provider calls, tool calls, tokens, provider-reported
 * cost (USD) and latency. No text of any kind. Also the source of the daily STRONG-route budget (counted from local
 * midnight Asia/Ho_Chi_Minh, like every other daily allowance). A failed write never breaks a turn.
 */
@Service
@Slf4j
public class EchoUsageLedger {
    private static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    public record Usage(int providerCalls, int toolCalls, int promptTokens, int completionTokens, int cachedTokens, double costUsd) {
        public static Usage none() { return new Usage(0, 0, 0, 0, 0, 0); }
        public Usage plus(int prompt, int completion, int cached, double cost) {
            return new Usage(providerCalls + 1, toolCalls, promptTokens + prompt, completionTokens + completion, cachedTokens + cached, costUsd + cost);
        }
        public Usage withTools(int tools) { return new Usage(providerCalls, tools, promptTokens, completionTokens, cachedTokens, costUsd); }
    }

    private final JdbcTemplate jdbc;

    public EchoUsageLedger(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void record(long userId, boolean voice, EchoRouter.Route route, String intent, String model, Usage usage, long latencyMs, String outcome) {
        try {
            jdbc.update("""
                    INSERT INTO public.echo_ai_turns(user_id, channel, route, intent, model, provider_calls, tool_calls, prompt_tokens,
                                                     completion_tokens, cached_tokens, cost_usd, latency_ms, outcome)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    userId, voice ? "VOICE" : "TEXT", route.name(), intent == null ? "UNKNOWN" : intent.substring(0, Math.min(32, intent.length())),
                    model == null ? null : model.substring(0, Math.min(96, model.length())),
                    Math.min(10, usage.providerCalls()), Math.min(20, usage.toolCalls()), usage.promptTokens(), usage.completionTokens(),
                    usage.cachedTokens(), BigDecimal.valueOf(Math.max(0, usage.costUsd())).setScale(8, RoundingMode.HALF_UP),
                    (int) Math.min(Integer.MAX_VALUE, Math.max(0, latencyMs)), outcome);
        } catch (RuntimeException e) {
            log.warn("Echo usage row not written ({})", e.getClass().getSimpleName());
        }
    }

    /** STRONG-route answered turns of this learner since the first day of the local month (failed turns never consume budget). */
    public int strongThisMonth(long userId) {
        try {
            Timestamp since = Timestamp.from(LocalDate.now(ZONE).withDayOfMonth(1).atStartOfDay(ZONE).toInstant());
            Integer n = jdbc.queryForObject("SELECT count(*) FROM public.echo_ai_turns WHERE user_id = ? AND route = 'STRONG' AND outcome = 'ANSWERED' AND created_at >= ?",
                    Integer.class, userId, since);
            return n == null ? 0 : n;
        } catch (RuntimeException e) {
            return Integer.MAX_VALUE;
        }
    }

    /** STRONG-route answered turns of this learner since local midnight (failed turns never consume budget). */
    public int strongToday(long userId) {
        try {
            Timestamp since = Timestamp.from(LocalDate.now(ZONE).atStartOfDay(ZONE).toInstant());
            Integer n = jdbc.queryForObject("SELECT count(*) FROM public.echo_ai_turns WHERE user_id = ? AND route = 'STRONG' AND outcome = 'ANSWERED' AND created_at >= ?",
                    Integer.class, userId, since);
            return n == null ? 0 : n;
        } catch (RuntimeException e) {
            return Integer.MAX_VALUE; // unknown budget: stay on the fast tier
        }
    }
}
