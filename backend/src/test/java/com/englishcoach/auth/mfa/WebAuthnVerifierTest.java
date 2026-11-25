package com.englishcoach.auth.mfa;

import com.englishcoach.auth.mfa.WebAuthnVerifier.WebAuthnRejectedException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.security.SecureRandom;
import java.util.Set;

import static com.englishcoach.auth.mfa.SoftwareAuthenticator.AT;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.BE;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.BS;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.UP;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.UV;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * WebAuthn ceremonies against an authenticator written from the specification: a genuine response verifies, and a
 * response that is wrong in exactly one respect does not.
 */
class WebAuthnVerifierTest {

    private static final String RP_ID = "englishcoach.io.vn";
    private static final String ORIGIN = "https://englishcoach.io.vn";

    private final WebAuthnVerifier verifier = new WebAuthnVerifier(RP_ID, Set.of(ORIGIN, "https://www.englishcoach.io.vn"));
    private final SoftwareAuthenticator authenticator = new SoftwareAuthenticator();

    private static byte[] challenge() {
        byte[] challenge = new byte[32];
        new SecureRandom().nextBytes(challenge);
        return challenge;
    }

    private MfaStore.WebAuthnCredential enrolled(long counter) {
        byte[] challenge = challenge();
        var registered = verifier.verifyRegistration(
                authenticator.register(challenge, ORIGIN, RP_ID, UP | UV | AT, counter), challenge);
        return new MfaStore.WebAuthnCredential(java.util.UUID.randomUUID(), 1L, registered.credentialId(),
                registered.attestedCredentialData(), registered.signCount(), registered.transports(),
                registered.backupEligible(), registered.backupState(), "Test key", java.time.Instant.now(), null);
    }

    @Test
    @DisplayName("Registration: a genuine response yields the credential id, the public key material and the flags")
    void genuineRegistrationVerifies() {
        byte[] challenge = challenge();
        var registered = verifier.verifyRegistration(
                authenticator.register(challenge, ORIGIN, RP_ID, UP | UV | AT | BE | BS, 0), challenge);
        assertThat(registered.credentialId()).isEqualTo(authenticator.credentialIdBase64());
        assertThat(registered.attestedCredentialData()).hasSizeGreaterThan(90);
        assertThat(registered.signCount()).isZero();
        assertThat(registered.transports()).isEqualTo("internal");
        assertThat(registered.backupEligible()).isTrue();
        assertThat(registered.backupState()).isTrue();
        // the alternate origin of the same site is also this site
        byte[] second = challenge();
        assertThat(verifier.verifyRegistration(authenticator.register(second, "https://www.englishcoach.io.vn", RP_ID,
                UP | UV | AT, 0), second).backupEligible()).isFalse();
    }

    @Test
    @DisplayName("Registration is refused for another origin, another relying party, another challenge, or without user verification")
    void registrationRefusals() {
        byte[] challenge = challenge();
        // a phishing site: its own origin, the victim site's relying-party id
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge, "https://englishcoach.io.vn.evil.example", RP_ID, UP | UV | AT, 0), challenge));
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge, "http://englishcoach.io.vn", RP_ID, UP | UV | AT, 0), challenge));
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge, ORIGIN, "evil.example", UP | UV | AT, 0), challenge));
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge(), ORIGIN, RP_ID, UP | UV | AT, 0), challenge));
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge, ORIGIN, RP_ID, UP | AT, 0), challenge));        // no user verification
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.register(challenge, ORIGIN, RP_ID, UV | AT, 0), challenge));        // no user presence
        assertRejected(() -> verifier.verifyRegistration("{\"id\":\"x\"}", challenge));
        assertRejected(() -> verifier.verifyRegistration(null, challenge));
        // an assertion is not a registration
        assertRejected(() -> verifier.verifyRegistration(
                authenticator.assertion(challenge, ORIGIN, RP_ID, UP | UV, 1, false), challenge));
    }

    @Test
    @DisplayName("Assertion: a genuine response verifies against the stored public key and reports the new counter")
    void genuineAssertionVerifies() {
        var stored = enrolled(0);
        byte[] challenge = challenge();
        String response = authenticator.assertion(challenge, ORIGIN, RP_ID, UP | UV, 5, false);
        assertThat(verifier.credentialIdOf(response)).isEqualTo(stored.credentialId());
        assertThat(verifier.verifyAssertion(response, challenge, stored).signCount()).isEqualTo(5);
    }

    @Test
    @DisplayName("Assertion is refused: forged signature, another key, origin, relying party, challenge, no user verification")
    void assertionRefusals() {
        var stored = enrolled(0);
        byte[] challenge = challenge();
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(challenge, ORIGIN, RP_ID, UP | UV, 1, true), challenge, stored));
        // another authenticator answering for this credential's public key
        assertRejected(() -> verifier.verifyAssertion(
                new SoftwareAuthenticator().assertion(challenge, ORIGIN, RP_ID, UP | UV, 1, false), challenge, stored));
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(challenge, "https://evil.example", RP_ID, UP | UV, 1, false), challenge, stored));
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(challenge, ORIGIN, "evil.example", UP | UV, 1, false), challenge, stored));
        // a response recorded for an earlier challenge (replay)
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(challenge(), ORIGIN, RP_ID, UP | UV, 1, false), challenge, stored));
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(challenge, ORIGIN, RP_ID, UP, 1, false), challenge, stored));
        // a registration is not an assertion
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.register(challenge, ORIGIN, RP_ID, UP | UV | AT, 1), challenge, stored));
        assertRejected(() -> verifier.credentialIdOf("not json"));
    }

    @Test
    @DisplayName("A signature counter that does not advance (a copied authenticator) is refused; a counter of zero is a passkey")
    void counterRegressionIsRefused() {
        var stored = enrolled(0);
        var used = new MfaStore.WebAuthnCredential(stored.id(), stored.userId(), stored.credentialId(),
                stored.attestedCredentialData(), 10, stored.transports(), false, false, stored.label(),
                stored.createdAt(), null);
        byte[] challenge = challenge();
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge, ORIGIN, RP_ID, UP | UV, 11, false),
                challenge, used).signCount()).isEqualTo(11);
        byte[] second = challenge();
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(second, ORIGIN, RP_ID, UP | UV, 10, false), second, used));
        byte[] third = challenge();
        assertRejected(() -> verifier.verifyAssertion(
                authenticator.assertion(third, ORIGIN, RP_ID, UP | UV, 3, false), third, used));
        // synced passkeys report 0 for ever: accepted while the stored counter is 0 too
        byte[] fourth = challenge();
        assertThat(verifier.verifyAssertion(authenticator.assertion(fourth, ORIGIN, RP_ID, UP | UV, 0, false),
                fourth, stored).signCount()).isZero();
    }

    @Test
    @DisplayName("Relying-party id and origins come from this site's configuration only")
    void relyingPartyFromConfiguration() {
        var properties = new com.englishcoach.common.security.AuthSecurityProperties();
        properties.setBaseUrl("https://englishcoach.io.vn");
        assertThat(WebAuthnVerifier.resolveRpId(properties)).isEqualTo("englishcoach.io.vn");
        properties.setWebauthnRpId("EnglishCoach.io.vn ");
        assertThat(WebAuthnVerifier.resolveRpId(properties)).isEqualTo("englishcoach.io.vn");
        assertThat(WebAuthnVerifier.originsOf("https://englishcoach.io.vn/",
                "https://englishcoach.io.vn, https://www.englishcoach.io.vn, https://evil.example, *, http://localhost:3000"))
                .containsExactlyInAnyOrder("https://englishcoach.io.vn", "https://www.englishcoach.io.vn");
    }

    private static void assertRejected(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call).isInstanceOf(WebAuthnRejectedException.class);
    }
}
