package com.englishcoach.common;

import java.util.regex.Pattern;

/**
 * What a player wears, as a room relays it to the other players: garment ids, palette hexes and compact avatar descriptors,
 * nothing else. The server only checks the shape and passes the string on; it never reads a URL, a file or a model out of
 * it, and the game never looks at it. The browser that draws it holds the real allow-list of garments and falls back to the
 * character's own clothes for anything it does not know.
 *
 * <p>Supports two wire formats:
 * <ul>
 *   <li><b>V1</b> (&le; 96 chars, Arena / Quiz Rush / Spelling):
 *       {@code top.bottom.shoes.acc1+acc2.topHex.bottomHex.shoesHex.hairHex.accHex}</li>
 *   <li><b>V2</b> (&le; 256 chars, Echo Life Character Creator &amp; shared world):
 *       {@code v2:<hero l|k>:<hairId>:<skinHex6>:<irisHex6>:<bodyHex12>:<faceHex16..40>:<outfitToken1..140>}</li>
 * </ul>
 */
public final class AvatarLookCode {
    public static final int MAX_V1_LENGTH = 96;
    public static final int MAX_V2_LENGTH = 256;
    private static final Pattern V1_SHAPE = Pattern.compile(
            "[a-z]{1,16}(\\.[a-z]{1,16}){2}\\.(-|[a-z]{1,16}(\\+[a-z]{1,16}){0,3})(\\.[0-9a-f]{6}){5}");
    private static final Pattern V2_SHAPE = Pattern.compile(
            "^v2:[lk]:[a-z0-9_]{1,24}:[0-9a-f]{6}:[0-9a-f]{6}:[0-9a-f]{12}:[0-9a-f]{16,40}:[a-z0-9_.-]{1,140}$");

    private AvatarLookCode() {}

    /** The code as it may be relayed (V1 or V2), or empty. */
    public static String clean(String value) {
        if (value == null || value.isEmpty() || value.contains("..")) return "";
        if (value.startsWith("v2:")) {
            return value.length() <= MAX_V2_LENGTH && V2_SHAPE.matcher(value).matches() ? value : "";
        }
        return value.length() <= MAX_V1_LENGTH && V1_SHAPE.matcher(value).matches() ? value : "";
    }

    /** True when {@code value} is a valid V2 Echo Life avatar look code. */
    public static boolean isV2(String value) {
        return value != null && value.startsWith("v2:") && !clean(value).isEmpty();
    }
}
