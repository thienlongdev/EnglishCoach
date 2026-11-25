package com.englishcoach.common.security;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * Purpose-bound keys derived from the application's signing secret: one secret in the environment, a different key
 * for every use, so a value made for one purpose (a CSRF token, an internal-call signature, an encrypted factor)
 * can never be replayed as another. The derivation is HMAC-SHA256(secret, label); the frontend's server code derives
 * the internal-call key the same way ({@code frontend/src/lib/server/internal-auth.ts}).
 */
public final class DerivedKeys {

    /** Signs the per-session CSRF token of cookie-authenticated requests. */
    public static final String CSRF = "ec-csrf-v1";
    /** Signs the server-to-server calls the frontend makes to the token-issuing endpoints. */
    public static final String INTERNAL_SERVICE = "ec-internal-service-v1";
    /** Encrypts second-factor secrets at rest. */
    public static final String MFA_ENCRYPTION = "ec-mfa-encryption-v1";
    /** Signs short-lived second-factor challenges and step-up proofs. */
    public static final String MFA_CHALLENGE = "ec-mfa-challenge-v1";

    private DerivedKeys() {
    }

    public static byte[] derive(String secret, String label) {
        return hmac((secret == null ? "" : secret).getBytes(StandardCharsets.UTF_8),
                label.getBytes(StandardCharsets.UTF_8));
    }

    public static byte[] hmac(byte[] key, byte[] message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(message);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    public static String hmacHex(byte[] key, String message) {
        return HexFormat.of().formatHex(hmac(key, message.getBytes(StandardCharsets.UTF_8)));
    }

    /** Constant-time comparison of two texts (neither may be null to be equal). */
    public static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
