package com.englishcoach.auth.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.function.Function;

/**
 * Is a new password among the passwords published in known breaches? (ASVS 5.0 V6.2.12; NIST SP 800-63B §3.1.1.2.)
 *
 * Privacy: k-anonymity range query to Have I Been Pwned's Pwned Passwords. Only the first five hexadecimal characters
 * of the password's SHA-1 leave the server; the answer lists every suffix sharing that prefix (padded with decoys,
 * {@code Add-Padding: true}) and the match is made here. The password, its full hash and the account are never sent.
 *
 * Availability: the check is advisory against an outage. If the service does not answer within the timeout the
 * password is accepted (the length, common-password and e-mail rules still apply) and a warning is logged, so a
 * third-party outage never blocks registration or a password reset.
 */
@Component
@Slf4j
public class BreachedPasswordChecker {

    private final boolean enabled;
    private final Function<String, String> rangeLookup;

    @org.springframework.beans.factory.annotation.Autowired
    public BreachedPasswordChecker(
            @Value("${app.security.breached-password-check.enabled:true}") boolean enabled,
            @Value("${app.security.breached-password-check.base-url:https://api.pwnedpasswords.com/range/}") String baseUrl,
            @Value("${app.security.breached-password-check.timeout-ms:2500}") long timeoutMs) {
        this(enabled, httpLookup(baseUrl, Duration.ofMillis(timeoutMs)));
    }

    /** For tests: {@code rangeLookup} maps a 5-character prefix to the service's answer (null = unavailable). */
    public BreachedPasswordChecker(boolean enabled, Function<String, String> rangeLookup) {
        this.enabled = enabled;
        this.rangeLookup = rangeLookup;
    }

    /** True only when the service answered and listed this password at least once. */
    public boolean isBreached(String password) {
        if (!enabled || password == null || password.isEmpty()) return false;
        String sha1 = sha1Hex(password);
        String prefix = sha1.substring(0, 5), suffix = sha1.substring(5);
        String body;
        try {
            body = rangeLookup.apply(prefix);
        } catch (Exception e) {
            body = null;
        }
        if (body == null) {
            log.warn("[Security:Password] Breached-password service unavailable; password accepted on the other rules");
            return false;
        }
        for (String line : body.split("\r?\n")) {
            int colon = line.indexOf(':');
            if (colon != 35 || !line.regionMatches(true, 0, suffix, 0, 35)) continue;
            try {
                return Long.parseLong(line.substring(colon + 1).trim()) > 0; // padding entries carry a count of 0
            } catch (NumberFormatException e) {
                return false;
            }
        }
        return false;
    }

    static String sha1Hex(String password) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(password.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest).toUpperCase(Locale.ROOT);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-1 unavailable", e);
        }
    }

    private static Function<String, String> httpLookup(String baseUrl, Duration timeout) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NEVER).build();
        return prefix -> {
            try {
                HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + prefix)).timeout(timeout)
                        .header("Add-Padding", "true").header("User-Agent", "EnglishCoach-PasswordPolicy").GET().build();
                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200 || response.body().length() > 2_000_000) return null;
                return response.body();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            } catch (Exception e) {
                return null;
            }
        };
    }
}
