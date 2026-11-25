package com.englishcoach.premium.admin;

import java.time.Instant;
import java.util.List;

/** DTOs of the admin-only manual Premium entitlement API ({@code /api/v1/admin/premium}). */
public final class PremiumAdminDtos {

    private PremiumAdminDtos() {}

    /** {@code months} 1–36, or {@code permanent = true}; {@code reason} required (audit). */
    public record GrantRequest(Integer months, Boolean permanent, String reason) {}

    public record RevokeRequest(String reason) {}

    public record UserSummary(long userId, String displayName, String email, String role, boolean premium,
                              Instant premiumExpiresAt, String premiumSource) {}

    public record EntitlementEvent(long id, String action, String reason, long adminUserId, boolean permanent,
                                   boolean previousPremium, Instant previousExpiresAt, String previousSource,
                                   boolean newPremium, Instant newExpiresAt, String newSource, Instant createdAt) {}

    /**
     * Current entitlement of one user. {@code adminGrantActive} = an ADMIN_GRANT subscription is active (revocable);
     * paid subscriptions are reported but never changed by the admin tools.
     */
    public record UserEntitlement(long userId, String displayName, String email, String role, boolean premium,
                                  Instant premiumExpiresAt, String premiumSource, String planName,
                                  boolean adminGrantActive, Instant adminGrantExpiresAt, boolean paidActive,
                                  List<EntitlementEvent> history) {}
}
