package com.englishcoach.common.security;

import java.util.concurrent.atomic.AtomicReference;

/**
 * A tiny, dependency-free hook through which security-relevant moments reach the alerting service
 * ({@code SecurityAlertService}): request filters that are not Spring beans, the payment reconciliation and the audit
 * writer call {@link #signal}. Without a registered listener (unit tests, hand-built contexts) a signal does nothing.
 * A signal carries a kind and a short reason category only — never a token, an address, an e-mail or user content.
 */
public final class SecuritySignals {

    public interface Listener {
        void onSignal(String kind, String reason);
    }

    private static final AtomicReference<Listener> LISTENER = new AtomicReference<>();

    private SecuritySignals() {
    }

    public static void register(Listener listener) {
        LISTENER.set(listener);
    }

    public static void signal(String kind, String reason) {
        Listener listener = LISTENER.get();
        if (listener == null) return;
        try {
            listener.onSignal(kind, reason);
        } catch (RuntimeException ignored) {
            // alerting never breaks the request that raised the signal
        }
    }
}
