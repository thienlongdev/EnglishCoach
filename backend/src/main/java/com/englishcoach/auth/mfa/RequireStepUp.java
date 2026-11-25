package com.englishcoach.auth.mfa;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * A sensitive administrator action: the session must have proven a second factor within the configured freshness
 * window ({@code app.security.admin-step-up-minutes}), not merely once since sign-in. Enforced by
 * {@link StepUpInterceptor} before the handler runs; the answer is 403 {@code STEP_UP_REQUIRED}, after which the
 * administrator confirms the factor and the client repeats the request.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireStepUp {
}
