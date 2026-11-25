package com.englishcoach.auth.mfa;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class TotpCodesTest {

    /** The SHA-1 key of RFC 6238 Appendix B. */
    private static final byte[] RFC_KEY = "12345678901234567890".getBytes(StandardCharsets.US_ASCII);

    @Test
    @DisplayName("RFC 6238 Appendix B test vectors (last six digits of the published eight)")
    void rfc6238Vectors() {
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(59L))).isEqualTo("287082");
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(1111111109L))).isEqualTo("081804");
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(1111111111L))).isEqualTo("050471");
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(1234567890L))).isEqualTo("005924");
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(2000000000L))).isEqualTo("279037");
        assertThat(TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(20000000000L))).isEqualTo("353130");
    }

    @Test
    @DisplayName("A code is accepted one step either side of now, never further, and never for a step already used")
    void windowAndReplay() {
        long now = 1_800_000_015L;
        long step = TotpCodes.stepAt(now);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step), now, 0)).isEqualTo(step);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step - 1), now, 0)).isEqualTo(step - 1);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step + 1), now, 0)).isEqualTo(step + 1);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step - 2), now, 0)).isEqualTo(-1);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step + 2), now, 0)).isEqualTo(-1);
        // replay: the step was used, and so is every earlier one
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step), now, step)).isEqualTo(-1);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step - 1), now, step)).isEqualTo(-1);
        assertThat(TotpCodes.matchingStep(RFC_KEY, TotpCodes.codeAt(RFC_KEY, step + 1), now, step)).isEqualTo(step + 1);
    }

    @Test
    @DisplayName("Anything that is not six digits never matches; spaces as typed from an app are tolerated")
    void inputShape() {
        long now = 1_800_000_015L;
        String code = TotpCodes.codeAt(RFC_KEY, TotpCodes.stepAt(now));
        assertThat(TotpCodes.matchingStep(RFC_KEY, code.substring(0, 3) + " " + code.substring(3), now, 0)).isPositive();
        for (String bad : new String[]{null, "", "12345", "1234567", "abcdef", code + "0", "-" + code.substring(1), "١٢٣٤٥٦"}) {
            assertThat(TotpCodes.matchingStep(RFC_KEY, bad, now, 0)).as(String.valueOf(bad)).isEqualTo(-1);
        }
        byte[] otherKey = TotpCodes.newSecret();
        assertThat(TotpCodes.matchingStep(otherKey, code, now, 0)).isEqualTo(-1);
    }

    @Test
    @DisplayName("Secrets are 160 random bits; the provisioning address is what authenticator apps read")
    void secretAndProvisioning() {
        assertThat(TotpCodes.newSecret()).hasSize(20).isNotEqualTo(TotpCodes.newSecret());
        assertThat(TotpCodes.base32(RFC_KEY)).isEqualTo("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assertThat(TotpCodes.provisioningUri("English Coach", "admin@example.test", RFC_KEY))
                .isEqualTo("otpauth://totp/English%20Coach%3Aadmin%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
                        + "&issuer=English%20Coach&algorithm=SHA1&digits=6&period=30");
    }
}
