package com.englishcoach.ai.service;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;

/**
 * An account used up its Echo messages (refused before any provider call): a 429 with {@code X-Echo-Limit} naming which
 * allowance ({@code COACH_DAILY} = the free 10 a day, {@code COACH_PREMIUM_DAILY} = Premium's daily allowance,
 * {@code COACH_PREMIUM_MONTHLY} = Premium's monthly allowance), {@code X-Echo-Limit-Value} and the renewal time, so the client
 * tells it apart from the per-minute throttle; the headers survive even when the error body cannot be written in the
 * stream's media type.
 */
public class CoachDailyLimitException extends ResponseStatusException {

    public static final String FREE_DAILY = "COACH_DAILY", PREMIUM_DAILY = "COACH_PREMIUM_DAILY", PREMIUM_MONTHLY = "COACH_PREMIUM_MONTHLY";

    private final int limit;
    private final Instant resetsAt;
    private final String kind;

    public CoachDailyLimitException(int limit, Instant resetsAt) { this(limit, resetsAt, FREE_DAILY); }

    public CoachDailyLimitException(int limit, Instant resetsAt, String kind) {
        super(HttpStatus.TOO_MANY_REQUESTS, kind + "_LIMIT");
        this.limit = limit;
        this.resetsAt = resetsAt;
        this.kind = kind;
    }

    public int limit() { return limit; }

    public Instant resetsAt() { return resetsAt; }

    public String kind() { return kind; }

    @Override
    public HttpHeaders getHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Echo-Limit", kind);
        headers.set("X-Echo-Limit-Value", String.valueOf(limit));
        if (resetsAt != null) headers.set("X-Echo-Resets-At", resetsAt.toString());
        headers.set("Cache-Control", "no-store");
        return headers;
    }
}
