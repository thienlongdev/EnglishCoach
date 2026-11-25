package com.englishcoach.auth.service;

import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.Set;

@Service
public class PasswordPolicyService {

    /** Breached-password check (k-anonymity); null in unit tests that build the policy by hand. */
    private final BreachedPasswordChecker breachedPasswords;

    public PasswordPolicyService() {
        this.breachedPasswords = null;
    }

    @org.springframework.beans.factory.annotation.Autowired
    public PasswordPolicyService(BreachedPasswordChecker breachedPasswords) {
        this.breachedPasswords = breachedPasswords;
    }

    public static final int MIN_CODEPOINTS = 15;
    public static final int MAX_UTF8_BYTES = 72;

    private static final Set<String> COMMON_PASSWORDS = Set.of(
            "password1234567", "englishcoachapp1", "123456789012345", "qwertyuiopasdfg",
            "welcome12345678", "dev_test_password", "oauth2_placeholder_pwd",
            "password123", "password123!", "englishcoach", "englishcoach123",
            "1234567890", "qwertyuiop", "admin12345", "welcome123", "dev_test", "oauth2"
    );

    private static final Set<String> PLACEHOLDERS = Set.of(
            "dev_test", "oauth2", "placeholder", "testuser"
    );

    public void validatePassword(String password, String email, String name) {
        if (password == null) {
            throw new IllegalArgumentException("Password must not be null");
        }

        int codePointCount = password.codePointCount(0, password.length());
        if (codePointCount < MIN_CODEPOINTS) {
            throw new IllegalArgumentException("Password must be at least " + MIN_CODEPOINTS + " characters long");
        }

        byte[] utf8Bytes = password.getBytes(StandardCharsets.UTF_8);
        if (utf8Bytes.length > MAX_UTF8_BYTES) {
            throw new IllegalArgumentException("Password must not exceed " + MAX_UTF8_BYTES + " UTF-8 bytes");
        }

        String lowerPass = password.toLowerCase();

        for (String placeholder : PLACEHOLDERS) {
            if (lowerPass.equals(placeholder)) {
                throw new IllegalArgumentException("Password cannot be a known system placeholder");
            }
        }

        if (COMMON_PASSWORDS.contains(lowerPass)) {
            throw new IllegalArgumentException("Password is too common or easily guessable");
        }

        if (email != null && !email.isBlank()) {
            String emailLocalPart = email.split("@")[0].toLowerCase();
            if (emailLocalPart.length() >= 4 && lowerPass.contains(emailLocalPart)) {
                throw new IllegalArgumentException("Password must not contain your email username");
            }
        }

        // Last, so that the cheap local rules answer first and only a candidate password is looked up.
        if (breachedPasswords != null && breachedPasswords.isBreached(password)) {
            throw new IllegalArgumentException("Mật khẩu này đã xuất hiện trong các vụ lộ dữ liệu công khai. Hãy chọn mật khẩu khác. (This password appears in known data breaches.)");
        }
    }
}
