package com.englishcoach.premium.admin;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Manual Premium entitlement by the official administrator (owner policy 2026-10-02). A grant is a normal
 * {@code premium_subscriptions} row with {@code source = ADMIN_GRANT} on the inactive plan {@code ADMIN_GRANT} (V68) —
 * never a payment order / transaction, never a change to billing history. Revoke cancels only ADMIN_GRANT rows, so a
 * paid subscription is never touched. Every grant / revoke writes one append-only
 * {@code premium_admin_entitlement_events} row (admin, target, action, reason, previous and new entitlement).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PremiumAdminService {

    public static final String SOURCE = "ADMIN_GRANT";
    public static final String PLAN_CODE = "ADMIN_GRANT";
    public static final int MAX_MONTHS = 36;
    /** "Permanent" grants end here (premium_subscriptions.expires_at is NOT NULL). */
    public static final Instant PERMANENT_UNTIL = Instant.parse("2099-12-31T16:59:59Z");
    static final int MAX_REASON = 500;

    private final AdminIdentityService adminIdentity;
    private final UserRepository userRepository;
    private final PremiumSubscriptionRepository subscriptionRepository;
    private final PremiumPlanRepository planRepository;
    private final PremiumProperties premiumProperties;
    private final NamedParameterJdbcTemplate jdbc;

    @Autowired(required = false)
    private ObjectProvider<PremiumEntitlementService> entitlementService;

    private void invalidateEntitlementCache(long userId) {
        if (entitlementService == null) return;
        Runnable evict = () -> {
            PremiumEntitlementService svc = entitlementService.getIfAvailable();
            if (svc != null) svc.invalidatePremiumCache(userId);
        };
        evict.run();
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { evict.run(); }
            });
        }
    }

    @Transactional(readOnly = true)
    public List<PremiumAdminDtos.UserSummary> search(long adminUserId, String query, Instant now) {
        adminIdentity.requireOfficialAdmin(adminUserId);
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) return List.of();
        String escaped = q.toLowerCase(Locale.ROOT).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        Long id = null;
        try {
            id = Long.parseLong(q);
        } catch (NumberFormatException ignored) {
            // text query
        }
        MapSqlParameterSource p = new MapSqlParameterSource("like", "%" + escaped + "%").addValue("id", id == null ? -1L : id);
        List<Long> ids = jdbc.queryForList("""
                SELECT u.id FROM public.users u LEFT JOIN public.user_profiles pr ON pr.user_id = u.id
                WHERE u.id = :id OR lower(u.email) LIKE :like OR lower(u.name) LIKE :like OR lower(pr.display_name) LIKE :like
                ORDER BY (u.id = :id) DESC, u.id LIMIT 20
                """, p, Long.class);
        List<PremiumAdminDtos.UserSummary> out = new ArrayList<>();
        for (Long uid : ids) {
            userRepository.findById(uid).ifPresent(u -> {
                Optional<PremiumSubscription> active = subscriptionRepository.findFirstActiveSubscription(u.getId(), now);
                out.add(new PremiumAdminDtos.UserSummary(u.getId(), u.getName(), u.getEmail(), u.getRole().name(),
                        active.isPresent(), active.map(PremiumSubscription::getExpiresAt).orElse(null),
                        active.map(PremiumSubscription::getSource).orElse(null)));
            });
        }
        return out;
    }

    @Transactional(readOnly = true)
    public PremiumAdminDtos.UserEntitlement view(long adminUserId, long targetUserId, Instant now) {
        adminIdentity.requireOfficialAdmin(adminUserId);
        return entitlement(requireUser(targetUserId), now);
    }

    @Transactional
    public PremiumAdminDtos.UserEntitlement grant(long adminUserId, long targetUserId, PremiumAdminDtos.GrantRequest req,
                                                  Instant now) {
        adminIdentity.requireOfficialAdmin(adminUserId);
        String reason = reason(req == null ? null : req.reason());
        boolean permanent = req != null && Boolean.TRUE.equals(req.permanent());
        Integer months = req == null ? null : req.months();
        if (!permanent && (months == null || months < 1 || months > MAX_MONTHS)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "months must be 1-" + MAX_MONTHS + " or permanent = true");
        }
        User target = requireUser(targetUserId);
        lockUser(target.getId());
        PremiumPlan plan = planRepository.findByCode(PLAN_CODE)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "ADMIN_GRANT plan missing"));
        Optional<PremiumSubscription> before = subscriptionRepository.findFirstActiveSubscription(target.getId(), now);
        Instant expires = permanent ? PERMANENT_UNTIL
                : ZonedDateTime.ofInstant(now, premiumProperties.getZoneId()).plusMonths(months).toInstant();
        PremiumSubscription sub = subscriptionRepository.saveAndFlush(PremiumSubscription.builder()
                .user(target).plan(plan).startsAt(now).expiresAt(expires).status("ACTIVE").source(SOURCE).build());
        Optional<PremiumSubscription> after = subscriptionRepository.findFirstActiveSubscription(target.getId(), now);
        audit(target.getId(), adminUserId, "GRANT", reason, List.of(sub.getId()), permanent, before, after);
        invalidateEntitlementCache(target.getId());
        log.info("[PremiumAdmin] admin {} granted Premium to user {} until {} (subscription {})",
                adminUserId, target.getId(), expires, sub.getId());
        return entitlement(target, now);
    }

    @Transactional
    public PremiumAdminDtos.UserEntitlement revoke(long adminUserId, long targetUserId, PremiumAdminDtos.RevokeRequest req,
                                                   Instant now) {
        adminIdentity.requireOfficialAdmin(adminUserId);
        String reason = reason(req == null ? null : req.reason());
        User target = requireUser(targetUserId);
        lockUser(target.getId());
        Optional<PremiumSubscription> before = subscriptionRepository.findFirstActiveSubscription(target.getId(), now);
        List<PremiumSubscription> grants = activeAdminGrants(target.getId(), now);
        if (grants.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "No active admin-granted Premium to revoke");
        }
        List<Long> ids = new ArrayList<>();
        for (PremiumSubscription s : grants) {
            s.setStatus("CANCELLED");
            ids.add(s.getId());
        }
        subscriptionRepository.saveAllAndFlush(grants);
        Optional<PremiumSubscription> after = subscriptionRepository.findFirstActiveSubscription(target.getId(), now);
        audit(target.getId(), adminUserId, "REVOKE", reason, ids, false, before, after);
        invalidateEntitlementCache(target.getId());
        log.info("[PremiumAdmin] admin {} revoked admin-granted Premium of user {} (subscriptions {})", adminUserId, target.getId(), ids);
        return entitlement(target, now);
    }

    // ---------------------------------------------------------------------------------------------

    private List<PremiumSubscription> activeAdminGrants(long userId, Instant now) {
        return subscriptionRepository.findActiveSubscriptions(userId, now).stream()
                .filter(s -> SOURCE.equals(s.getSource())).toList();
    }

    private PremiumAdminDtos.UserEntitlement entitlement(User u, Instant now) {
        List<PremiumSubscription> active = subscriptionRepository.findActiveSubscriptions(u.getId(), now);
        PremiumSubscription top = active.isEmpty() ? null : active.get(0);
        PremiumSubscription grant = active.stream().filter(s -> SOURCE.equals(s.getSource())).findFirst().orElse(null);
        boolean paid = active.stream().anyMatch(s -> !SOURCE.equals(s.getSource()));
        return new PremiumAdminDtos.UserEntitlement(u.getId(), u.getName(), u.getEmail(), u.getRole().name(),
                top != null, top == null ? null : top.getExpiresAt(), top == null ? null : top.getSource(),
                top == null || top.getPlan() == null ? null : top.getPlan().getName(),
                grant != null, grant == null ? null : grant.getExpiresAt(), paid, history(u.getId()));
    }

    private List<PremiumAdminDtos.EntitlementEvent> history(long userId) {
        return jdbc.query("""
                SELECT id, action, reason, admin_user_id, permanent, previous_premium, previous_expires_at, previous_source,
                       new_premium, new_expires_at, new_source, created_at
                FROM public.premium_admin_entitlement_events WHERE target_user_id = :u ORDER BY created_at DESC, id DESC LIMIT 50
                """, new MapSqlParameterSource("u", userId), (rs, i) -> new PremiumAdminDtos.EntitlementEvent(
                rs.getLong("id"), rs.getString("action"), rs.getString("reason"), rs.getLong("admin_user_id"),
                rs.getBoolean("permanent"), rs.getBoolean("previous_premium"), instant(rs.getTimestamp("previous_expires_at")),
                rs.getString("previous_source"), rs.getBoolean("new_premium"), instant(rs.getTimestamp("new_expires_at")),
                rs.getString("new_source"), instant(rs.getTimestamp("created_at"))));
    }

    private void audit(long targetId, long adminId, String action, String reason, List<Long> subscriptionIds, boolean permanent,
                       Optional<PremiumSubscription> before, Optional<PremiumSubscription> after) {
        String ids = "{" + String.join(",", subscriptionIds.stream().map(String::valueOf).toList()) + "}";
        jdbc.update("""
                INSERT INTO public.premium_admin_entitlement_events (target_user_id, admin_user_id, action, reason, subscription_ids,
                    permanent, previous_premium, previous_expires_at, previous_source, new_premium, new_expires_at, new_source)
                VALUES (:t, :a, :action, :reason, CAST(:ids AS BIGINT[]), :perm, :pp, :pe, :ps, :np, :ne, :ns)
                """, new MapSqlParameterSource()
                .addValue("t", targetId).addValue("a", adminId).addValue("action", action).addValue("reason", reason)
                .addValue("ids", ids).addValue("perm", permanent)
                .addValue("pp", before.isPresent())
                .addValue("pe", before.map(s -> Timestamp.from(s.getExpiresAt())).orElse(null))
                .addValue("ps", before.map(PremiumSubscription::getSource).orElse(null))
                .addValue("np", after.isPresent())
                .addValue("ne", after.map(s -> Timestamp.from(s.getExpiresAt())).orElse(null))
                .addValue("ns", after.map(PremiumSubscription::getSource).orElse(null)));
    }

    /** Serialises concurrent grant / revoke for one target (row lock on the user, released at commit). */
    private void lockUser(long userId) {
        jdbc.queryForList("SELECT id FROM public.users WHERE id = :u FOR UPDATE", new MapSqlParameterSource("u", userId), Long.class);
    }

    private User requireUser(long userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
    }

    private static String reason(String raw) {
        String r = raw == null ? "" : raw.trim();
        if (r.isEmpty() || r.length() > MAX_REASON) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "reason is required (1-" + MAX_REASON + " characters)");
        }
        return r;
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
