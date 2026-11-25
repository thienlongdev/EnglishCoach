package com.englishcoach.auth.mfa;

import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.DerivedKeys;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * Encryption at rest of a second-factor secret (the TOTP seed): AES-256-GCM with a random 96-bit nonce per
 * encryption and the owning account bound in as associated data, so a ciphertext copied to another account's row
 * does not decrypt. A database copy alone therefore does not yield the seed.
 *
 * Keys are versioned (column {@code auth_mfa_totp.key_version}):
 * <ul>
 *   <li>1 — derived from the token-signing secret ({@link DerivedKeys#MFA_ENCRYPTION}); the first V3 build. Kept for
 *       decryption only, so a seed enrolled under it is still readable.</li>
 *   <li>2 — the dedicated key {@code APP_SECURITY_MFA_ENCRYPTION_KEY}, independent of every other secret: rotating
 *       {@code AUTH_JWT_SECRET} no longer strands the seed, and the token-signing secret no longer opens it.</li>
 * </ul>
 * New seeds are written under the newest configured version; a seed under an older version is re-encrypted the
 * next time a code from it is accepted ({@link AdminMfaService}). Production refuses to start without the dedicated
 * key ({@link AuthSecurityProperties#validateProductionSecurity()}).
 */
@Component
public class MfaSecretCipher {

    public static final short DERIVED_KEY_VERSION = 1;
    public static final short DEDICATED_KEY_VERSION = 2;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final byte[] derivedKey;
    private final byte[] dedicatedKey;
    private final SecureRandom random = new SecureRandom();

    public MfaSecretCipher(AuthSecurityProperties properties) {
        this.derivedKey = DerivedKeys.derive(properties.getJwtSecret(), DerivedKeys.MFA_ENCRYPTION);
        String dedicated = properties.getMfaEncryptionKey();
        this.dedicatedKey = dedicated == null || dedicated.isBlank() ? null
                // the configured value is high-entropy text; HMAC with a fixed label maps it to exactly 256 bits
                : DerivedKeys.derive(dedicated.trim(), "ec-mfa-encryption-v2");
    }

    /** Key version new ciphertexts are written under. */
    public short currentVersion() {
        return dedicatedKey != null ? DEDICATED_KEY_VERSION : DERIVED_KEY_VERSION;
    }

    public byte[] encrypt(byte[] secret, long userId) {
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key(currentVersion()), "AES"),
                    new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(userId));
            byte[] ciphertext = cipher.doFinal(secret);
            byte[] out = Arrays.copyOf(nonce, NONCE_BYTES + ciphertext.length);
            System.arraycopy(ciphertext, 0, out, NONCE_BYTES, ciphertext.length);
            return out;
        } catch (Exception e) {
            throw new IllegalStateException("Second-factor secret could not be encrypted", e);
        }
    }

    /** @throws IllegalStateException when the stored value does not decrypt for this account under that version */
    public byte[] decrypt(byte[] stored, short keyVersion, long userId) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key(keyVersion), "AES"),
                    new GCMParameterSpec(TAG_BITS, stored, 0, NONCE_BYTES));
            cipher.updateAAD(aad(userId));
            return cipher.doFinal(stored, NONCE_BYTES, stored.length - NONCE_BYTES);
        } catch (Exception e) {
            throw new IllegalStateException("Second-factor secret could not be decrypted", e);
        }
    }

    private byte[] key(short version) {
        if (version == DERIVED_KEY_VERSION) return derivedKey;
        if (version == DEDICATED_KEY_VERSION && dedicatedKey != null) return dedicatedKey;
        throw new IllegalStateException("No key configured for second-factor key version " + version);
    }

    private static byte[] aad(long userId) {
        return ("totp:" + userId).getBytes(StandardCharsets.UTF_8);
    }
}
