package com.englishcoach.auth.entity;

import com.englishcoach.auth.policy.OfficialAdminPolicy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Single official administrator (owner policy 2026-10-02): policy normalisation, the JPA lifecycle guard on
 * {@link User} (covers registration, Google provisioning and any future role-changing code) and the V68 DB trigger
 * literal staying equal to the Java constant.
 */
class SingleOfficialAdminPolicyTest {

    static User user(String email, Role role) {
        return User.builder().email(email).name("x").role(role).build();
    }

    @Test
    @DisplayName("Only the official e-mail (trim + case-insensitive) may hold ROLE_ADMIN")
    void policy() {
        assertTrue(OfficialAdminPolicy.isOfficialAdminEmail("longntt872006@gmail.com"));
        assertTrue(OfficialAdminPolicy.isOfficialAdminEmail("  LongNTT872006@Gmail.COM "));
        assertFalse(OfficialAdminPolicy.isOfficialAdminEmail("longntt872006@gmail.com.evil"));
        assertFalse(OfficialAdminPolicy.isOfficialAdminEmail("x.longntt872006@gmail.com"));
        assertFalse(OfficialAdminPolicy.isOfficialAdminEmail(null));
        assertTrue(OfficialAdminPolicy.isRoleAllowed("anyone@example.com", Role.ROLE_USER));
        assertFalse(OfficialAdminPolicy.isRoleAllowed("anyone@example.com", Role.ROLE_ADMIN));
        assertTrue(OfficialAdminPolicy.isOfficialAdmin("LONGNTT872006@gmail.com", Role.ROLE_ADMIN));
        assertFalse(OfficialAdminPolicy.isOfficialAdmin("longntt872006@gmail.com", Role.ROLE_USER),
                "the official e-mail is an admin only while its row holds ROLE_ADMIN");
    }

    @Test
    @DisplayName("JPA guard: persisting / updating ROLE_ADMIN for another account fails; learners and the official admin pass")
    void entityGuard() {
        assertThrows(IllegalStateException.class, () -> user("ngu@gmail.com", Role.ROLE_ADMIN).enforceSingleAdmin());
        assertThrows(IllegalStateException.class, () -> user("admin@englishcoach.com", Role.ROLE_ADMIN).enforceSingleAdmin());
        assertDoesNotThrow(() -> user("learner@example.com", Role.ROLE_USER).enforceSingleAdmin());
        assertDoesNotThrow(() -> user("longntt872006@gmail.com", Role.ROLE_ADMIN).enforceSingleAdmin());
        User official = user("longntt872006@gmail.com", Role.ROLE_ADMIN);
        official.setEmail("someone-else@gmail.com");
        assertThrows(IllegalStateException.class, official::enforceSingleAdmin, "the admin row cannot be re-pointed to another e-mail");
        User learner = user("learner@example.com", Role.ROLE_USER);
        learner.setRole(Role.ROLE_ADMIN);
        assertThrows(IllegalStateException.class, learner::enforceSingleAdmin, "promotion of another account is rejected");
    }

    @Test
    @DisplayName("Registration and Google provisioning still create ROLE_USER only")
    void provisioningCreatesLearners() throws Exception {
        String reg = Files.readString(Path.of("src/main/java/com/englishcoach/auth/service/RegistrationService.java"));
        String google = Files.readString(Path.of("src/main/java/com/englishcoach/auth/service/GoogleIdentityService.java"));
        assertTrue(reg.contains(".role(Role.ROLE_USER)") && !reg.contains("ROLE_ADMIN"));
        assertTrue(google.contains(".role(Role.ROLE_USER)") && !google.contains("ROLE_ADMIN"));
    }

    @Test
    @DisplayName("V68 trigger / demotion use exactly the Java constant (no second admin e-mail anywhere)")
    void migrationLiteralMatchesPolicy() throws Exception {
        String sql = Files.readString(Path.of("src/main/resources/db/migration/exams/V68__single_official_admin.sql"));
        Matcher m = Pattern.compile("'([^'\\s]+@[^'\\s]+)'").matcher(sql);
        int n = 0;
        while (m.find()) {
            assertEquals(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL, m.group(1));
            n++;
        }
        assertTrue(n >= 5, "demotion, sessions, promotion and trigger all reference the official e-mail");
        assertTrue(sql.contains("BEFORE INSERT OR UPDATE OF role, email ON public.users"));
        assertFalse(sql.matches("(?is).*\\bDELETE\\s+FROM\\b.*"), "V68 deletes nothing");
    }
}
