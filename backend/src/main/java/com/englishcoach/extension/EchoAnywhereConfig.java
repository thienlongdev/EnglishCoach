package com.englishcoach.extension;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Echo Anywhere (browser extension) settings. Only the extensions listed in {@code app.echo-anywhere.extension-ids}
 * may pair with an account: the development build (stable id from its manifest key) and, once published, the Chrome
 * Web Store and Microsoft Edge Add-ons ids. An empty list closes pairing entirely.
 */
@Component
public class EchoAnywhereConfig {

    /** Session kind of an extension sign-in; the scope filter keys on it. */
    public static final String AUTH_METHOD = "ECHO_ANYWHERE";

    /** The usage-ledger key of Echo Anywhere's paid AI (Premium only, monthly fair use). */
    public static final String AI_FEATURE = "ECHO_ANYWHERE_AI";

    private static final Pattern EXTENSION_ID = Pattern.compile("^[a-p]{32}$");

    private final List<String> extensionIds;
    private final int sessionIdleDays;
    private final int sessionAbsoluteDays;
    private final int aiPerFiveMinutes;

    public EchoAnywhereConfig(
            @Value("${app.echo-anywhere.extension-ids:}") String ids,
            @Value("${app.echo-anywhere.session-idle-days:14}") int sessionIdleDays,
            @Value("${app.echo-anywhere.session-absolute-days:30}") int sessionAbsoluteDays,
            @Value("${app.echo-anywhere.ai-per-five-minutes:20}") int aiPerFiveMinutes) {
        this.extensionIds = parseIds(ids);
        this.sessionIdleDays = Math.max(1, Math.min(30, sessionIdleDays));
        this.sessionAbsoluteDays = Math.max(1, Math.min(90, sessionAbsoluteDays));
        this.aiPerFiveMinutes = Math.max(1, Math.min(120, aiPerFiveMinutes));
    }

    public static List<String> parseIds(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        return Arrays.stream(raw.split(","))
                .map(s -> s.trim().toLowerCase(Locale.ROOT))
                .filter(s -> EXTENSION_ID.matcher(s).matches())
                .distinct()
                .toList();
    }

    public boolean isAllowed(String extensionId) {
        return extensionId != null && extensionIds.contains(extensionId.trim().toLowerCase(Locale.ROOT));
    }

    public List<String> extensionIds() {
        return extensionIds;
    }

    /** The CORS origins of the allowed extensions (their service worker calls the API with an Authorization header). */
    public List<String> extensionOrigins() {
        return extensionIds.stream().map(id -> "chrome-extension://" + id).toList();
    }

    public int sessionIdleDays() {
        return sessionIdleDays;
    }

    public int sessionAbsoluteDays() {
        return sessionAbsoluteDays;
    }

    public int aiPerFiveMinutes() {
        return aiPerFiveMinutes;
    }
}
