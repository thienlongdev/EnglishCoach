package com.englishcoach.auth.mfa;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Time-based one-time passwords as authenticator apps implement them (RFC 6238 over RFC 4226): HMAC-SHA1, six
 * digits, 30-second steps. A code is accepted for the current step and one step either side (clock drift), and only
 * for a step later than the last one this account used, so a code observed once cannot be used again.
 */
public final class TotpCodes {

    public static final int DIGITS = 6;
    public static final int STEP_SECONDS = 30;
    public static final int DRIFT_STEPS = 1;
    private static final int SECRET_BYTES = 20;
    private static final String BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private static final SecureRandom RANDOM = new SecureRandom();

    private TotpCodes() {
    }

    public static byte[] newSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return secret;
    }

    public static long stepAt(long epochSeconds) {
        return Math.floorDiv(epochSeconds, STEP_SECONDS);
    }

    public static String codeAt(byte[] secret, long step) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret, "HmacSHA1"));
            byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(step).array());
            int offset = hash[hash.length - 1] & 0x0f;
            int binary = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16)
                    | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
            return String.format(Locale.ROOT, "%0" + DIGITS + "d", binary % 1_000_000);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA1 unavailable", e);
        }
    }

    /**
     * The step the presented code belongs to, or -1 when it matches no step of the window or only a step that was
     * already used. Every candidate is compared (constant time each) whatever the outcome.
     */
    public static long matchingStep(byte[] secret, String presented, long epochSeconds, long lastUsedStep) {
        if (presented == null) return -1;
        String code = presented.replace(" ", "").trim();
        if (code.length() != DIGITS || !code.chars().allMatch(c -> c >= '0' && c <= '9')) return -1;
        long current = stepAt(epochSeconds);
        long matched = -1;
        for (long step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
            boolean equal = MessageDigest.isEqual(codeAt(secret, step).getBytes(StandardCharsets.US_ASCII),
                    code.getBytes(StandardCharsets.US_ASCII));
            if (equal && step > lastUsedStep) matched = step;
        }
        return matched;
    }

    public static String base32(byte[] data) {
        StringBuilder out = new StringBuilder();
        int buffer = 0;
        int bits = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) {
                out.append(BASE32.charAt((buffer >> (bits - 5)) & 0x1f));
                bits -= 5;
            }
        }
        if (bits > 0) out.append(BASE32.charAt((buffer << (5 - bits)) & 0x1f));
        return out.toString();
    }

    /** The provisioning address an authenticator app reads (typed by hand as the secret, or scanned). */
    public static String provisioningUri(String issuer, String account, byte[] secret) {
        String label = urlEncode(issuer + ":" + account);
        return "otpauth://totp/" + label + "?secret=" + base32(secret) + "&issuer=" + urlEncode(issuer)
                + "&algorithm=SHA1&digits=" + DIGITS + "&period=" + STEP_SECONDS;
    }

    private static String urlEncode(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
