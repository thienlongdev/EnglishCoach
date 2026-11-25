package com.englishcoach.auth.policy;

import com.englishcoach.auth.entity.Role;

import java.util.Locale;

/**
 * Single source of truth for "who may be an administrator" (owner policy 2026-10-02): exactly ONE account, the official
 * administrator below, may hold {@link Role#ROLE_ADMIN}. Every other account is a learner.
 * <p>Enforced in three layers that all use this e-mail:
 * <ol>
 *   <li>the {@code users} JPA lifecycle guard ({@code User#enforceSingleAdmin}) — any code path that tries to persist
 *       ROLE_ADMIN for another e-mail fails before SQL is sent;</li>
 *   <li>the DB trigger {@code trg_users_single_official_admin} (V68) — rejects the same through raw SQL / JDBC
 *       (the literal there must equal {@link #OFFICIAL_ADMIN_EMAIL}; {@code OfficialAdminPolicyTest} checks it);</li>
 *   <li>request-time authorization keeps reading {@code users.role} from the DB on every request
 *       ({@code CustomJwtAuthenticationConverter}), never the role claim of an old token.</li>
 * </ol>
 * No endpoint can change a role. Comparison is trim + case-insensitive (same as {@code users.email_normalized}).
 */
public final class OfficialAdminPolicy {

    public static final String OFFICIAL_ADMIN_EMAIL = "longntt872006@gmail.com";

    private OfficialAdminPolicy() {}

    /** trim + lower case (Locale.ROOT); null stays null. */
    public static String normalize(String email) {
        return email == null ? null : email.trim().toLowerCase(Locale.ROOT);
    }

    public static boolean isOfficialAdminEmail(String email) {
        return OFFICIAL_ADMIN_EMAIL.equals(normalize(email));
    }

    /** true only for the official e-mail that currently holds ROLE_ADMIN. */
    public static boolean isOfficialAdmin(String email, Role role) {
        return role == Role.ROLE_ADMIN && isOfficialAdminEmail(email);
    }

    /** Whether {@code role} may be stored for {@code email}: ROLE_ADMIN only for the official administrator. */
    public static boolean isRoleAllowed(String email, Role role) {
        return role != Role.ROLE_ADMIN || isOfficialAdminEmail(email);
    }

    /** @throws IllegalStateException when ROLE_ADMIN would be assigned to any other account */
    public static void assertRoleAllowed(String email, Role role) {
        if (!isRoleAllowed(email, role)) {
            throw new IllegalStateException("ROLE_ADMIN is reserved for the official administrator account");
        }
    }
}
