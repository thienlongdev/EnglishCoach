package com.englishcoach.wallpaper;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validation of everything a learner may store in the wallpaper library. Pure functions: the server never opens,
 * fetches or resolves a stored link (no request leaves the backend because of this feature).
 */
public final class WallpaperLibraryRules {

    /** Saved videos per learner. */
    public static final int MAX_ENTRIES = 50;
    /** Ids per import call (the former device list held at most 12). */
    public static final int MAX_IMPORT = 12;
    static final int MAX_URL = 2048;
    static final int MAX_FILE_NAME = 160;

    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
    private static final Set<String> YOUTUBE_HOSTS = Set.of("youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com", "ytimg.com");

    private WallpaperLibraryRules() {}

    public static boolean isVideoId(String id) {
        return id != null && !"videoseries".equals(id) && VIDEO_ID.matcher(id).matches();
    }

    /**
     * A learner's direct video link: absolute HTTPS, a public-looking host name, no credentials, no whitespace or control
     * characters, ≤ 2048 characters. A YouTube / Google video host is refused: a YouTube page is not a video file, and
     * YouTube's streams may not be taken out of its player. Returns the normalised URL, or empty when refused.
     */
    public static Optional<String> normalizeVideoLink(String raw) {
        if (raw == null) return Optional.empty();
        String value = raw.trim();
        if (value.isEmpty() || value.length() > MAX_URL) return Optional.empty();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 0x20 || c == 0x7f || Character.isWhitespace(c)) return Optional.empty();
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            return Optional.empty();
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null) return Optional.empty();
        // A video file has a path; a bare site address is not one.
        if (uri.getRawPath() == null || uri.getRawPath().length() < 2 || !uri.getRawPath().startsWith("/")) return Optional.empty();
        String host = uri.getHost();
        if (host == null) return Optional.empty();
        host = host.toLowerCase(Locale.ROOT);
        if (!host.contains(".") || host.startsWith("[") || host.endsWith(".")) return Optional.empty();
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
            return Optional.empty();
        }
        if (IPV4.matcher(host).matches()) return Optional.empty(); // a bare address is never a public media host here
        for (String yt : YOUTUBE_HOSTS) {
            if (host.equals(yt) || host.endsWith("." + yt)) return Optional.empty();
        }
        String normalized = uri.normalize().toString();
        if (!normalized.regionMatches(true, 0, "https://", 0, 8) || normalized.length() > MAX_URL) return Optional.empty();
        return Optional.of("https://" + normalized.substring(8));
    }

    /** A file's display name: control characters removed, trimmed, ≤ 160 characters; empty when nothing is left. */
    public static Optional<String> cleanFileName(String raw) {
        if (raw == null) return Optional.empty();
        StringBuilder out = new StringBuilder();
        raw.codePoints()
                .filter(cp -> !Character.isISOControl(cp) && cp != '/' && cp != '\\' && Character.getType(cp) != Character.FORMAT)
                .forEach(out::appendCodePoint);
        String name = out.toString().strip();
        if (name.isEmpty()) return Optional.empty();
        if (name.codePointCount(0, name.length()) > MAX_FILE_NAME) {
            name = name.substring(0, name.offsetByCodePoints(0, MAX_FILE_NAME)).strip();
        }
        return Optional.of(name);
    }
}
