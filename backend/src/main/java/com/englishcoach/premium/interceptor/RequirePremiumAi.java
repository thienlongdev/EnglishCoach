package com.englishcoach.premium.interceptor;

import java.lang.annotation.*;

@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface RequirePremiumAi {

    /**
     * Unique feature key from premium_feature_definitions (e.g. SPEAKING_ROLEPLAY).
     */
    String value();

    /**
     * Optional parameter name to extract client idempotency identifier from request.
     */
    String requestIdParam() default "";

    /**
     * Whether client request identifiers may reuse a quota receipt. Defaults to {@code false} (EC-SEC-2026-002):
     * the interceptor mints a fresh server UUID for every execution (ignoring {@code requestIdParam} and all client
     * idempotency headers) so a client-supplied {@code X-Request-Id}/{@code Idempotency-Key} cannot bypass quotas.
     * Opt in ({@code true}) ONLY when the handler verifies a durable payload-hash receipt.
     */
    boolean reuseClientRequestId() default false;

    /** Handler reserves/settles in its own durable replay transaction. Authentication and bulkhead still apply. */
    boolean serviceManagedReservation() default false;
}
