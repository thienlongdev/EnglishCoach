package com.englishcoach.common.ai;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URL;
import java.util.Locale;

/**
 * The credential this backend presents to the internal AI service on the GPU PC (security release 2026-11-16, SEC-01).
 * <p>
 * Every route of that service except its liveness / readiness probes requires the header {@value #HEADER} carrying the
 * shared secret {@code AI_SERVICE_KEY}; without it the service answers 401. The header is attached only to requests whose
 * origin (scheme, host, port) is exactly the configured {@code ai.base-url}, so the secret never travels to another host
 * (OmniVoice, OpenRouter, YouTube). It is set when the connection is prepared ({@link AiServiceRequestFactory}), not by a
 * RestTemplate interceptor, which would buffer every audio / document upload in memory.
 * <p>
 * The value lives in static state because several AI clients build their RestTemplate in a field initializer, before any
 * injection; this bean fills it once at start-up. Never printed.
 */
@Slf4j
@Component
public class AiServiceAuth {

    public static final String HEADER = "X-EC-Service-Key";
    static final int MIN_LENGTH = 32;

    private static volatile String key;
    private static volatile String origin;

    public AiServiceAuth(@Value("${ai.service-key:}") String serviceKey,
                         @Value("${ai.base-url:http://localhost:8000}") String baseUrl,
                         Environment environment) {
        configure(serviceKey, baseUrl);
        boolean production = false;
        for (String profile : environment.getActiveProfiles()) {
            if ("prod".equalsIgnoreCase(profile) || "production".equalsIgnoreCase(profile)) production = true;
        }
        if (key == null) {
            // Fail closed on the AI side: the service refuses unauthenticated calls. Learning outside AI keeps working.
            if (production) {
                log.error("[Security] AI_SERVICE_KEY is not configured: the internal AI service refuses every call from this backend (401).");
            } else {
                log.warn("[Security] AI_SERVICE_KEY is not configured: AI calls are sent without the service credential.");
            }
        } else if (production && key.length() < MIN_LENGTH) {
            throw new IllegalStateException("[Security:Fatal] Production startup failed closed: AI_SERVICE_KEY must be at least "
                    + MIN_LENGTH + " characters.");
        }
    }

    static void configure(String serviceKey, String baseUrl) {
        String k = serviceKey == null ? "" : serviceKey.trim();
        key = k.isEmpty() ? null : k;
        origin = originOf(baseUrl);
    }

    /** The secret for a request to {@code url}, or null when the url is not the AI service (or no key is configured). */
    static String credentialFor(URL url) {
        String k = key;
        String o = origin;
        if (k == null || o == null || url == null) return null;
        String target;
        try {
            target = originOf(url.toURI().toString());
        } catch (Exception e) {
            return null;
        }
        return o.equals(target) ? k : null;
    }

    static String originOf(String base) {
        if (base == null || base.isBlank()) return null;
        try {
            URI u = URI.create(base.trim());
            if (u.getScheme() == null || u.getHost() == null) return null;
            String scheme = u.getScheme().toLowerCase(Locale.ROOT);
            int port = u.getPort() != -1 ? u.getPort() : ("https".equals(scheme) ? 443 : 80);
            return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + ":" + port;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
