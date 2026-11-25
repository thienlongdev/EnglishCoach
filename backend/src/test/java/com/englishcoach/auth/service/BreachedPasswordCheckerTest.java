package com.englishcoach.auth.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** ASVS 5.0 V6.2.12: new passwords are refused when they appear in published breaches; only a hash prefix leaves. */
class BreachedPasswordCheckerTest {

    private static final String BREACHED = "correct horse battery staple";

    @Test
    @DisplayName("Only the first five hex characters of the SHA-1 are sent; a listed suffix with a count is refused")
    void kAnonymityLookup() {
        String sha1 = BreachedPasswordChecker.sha1Hex(BREACHED);
        List<String> asked = new ArrayList<>();
        BreachedPasswordChecker checker = new BreachedPasswordChecker(true, prefix -> {
            asked.add(prefix);
            return "0000000000000000000000000000000000A:0\r\n" + sha1.substring(5).toLowerCase() + ":3721\r\n";
        });
        assertThat(checker.isBreached(BREACHED)).isTrue();
        assertThat(asked).containsExactly(sha1.substring(0, 5));
        assertThat(asked.get(0)).hasSize(5).doesNotContain(BREACHED);
    }

    @Test
    @DisplayName("Padding entries (count 0) and other suffixes do not refuse a password")
    void paddingAndOtherSuffixes() {
        String sha1 = BreachedPasswordChecker.sha1Hex(BREACHED);
        assertThat(new BreachedPasswordChecker(true, p -> sha1.substring(5) + ":0\n").isBreached(BREACHED)).isFalse();
        assertThat(new BreachedPasswordChecker(true, p -> "F".repeat(35) + ":99\n").isBreached(BREACHED)).isFalse();
    }

    @Test
    @DisplayName("An outage or a malformed answer never blocks the user; a disabled check asks nothing")
    void failsOpenOnOutage() {
        assertThat(new BreachedPasswordChecker(true, p -> null).isBreached(BREACHED)).isFalse();
        assertThat(new BreachedPasswordChecker(true, p -> { throw new IllegalStateException("down"); }).isBreached(BREACHED)).isFalse();
        List<String> asked = new ArrayList<>();
        assertThat(new BreachedPasswordChecker(false, p -> { asked.add(p); return ""; }).isBreached(BREACHED)).isFalse();
        assertThat(asked).isEmpty();
    }

    @Test
    @DisplayName("The password policy refuses a breached password on registration, reset and change alike")
    void policyUsesTheCheck() {
        String sha1 = BreachedPasswordChecker.sha1Hex(BREACHED);
        PasswordPolicyService policy = new PasswordPolicyService(
                new BreachedPasswordChecker(true, p -> sha1.substring(5) + ":12\n"));
        assertThatThrownBy(() -> policy.validatePassword(BREACHED, "learner@example.test", "L"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("breach");
        policy.validatePassword("a fresh and unlisted passphrase 42", "learner@example.test", "L");
    }
}
