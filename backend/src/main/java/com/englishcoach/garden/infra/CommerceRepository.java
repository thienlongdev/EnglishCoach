package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3F cosmetic commerce (V87): the payment side of a cosmetic order, refunds, reconciliation issues and the
 * delivery / take-back of a crop cultivar bought with money. Every statement is scoped by {@code user_id} or by an
 * order id the caller resolved for one player; the tables carry their own forward-only guards.
 */
@Repository
public class CommerceRepository {

    public record Payment(long orderId, long userId, String transferCode, Instant expiresAt, Instant paidAt,
                          String providerTransactionId, Instant createdAt) {}

    public record Refund(long id, long orderId, long userId, String kind, String status, String reason, long amountVnd,
                         Instant requestedAt, Instant decidedAt, Long decidedBy, String bankReference, String note) {}

    public record Issue(long id, String kind, long orderId, long userId, String providerTransactionId, long paidAmountVnd,
                        String status, String resolution, Instant createdAt, Instant resolvedAt, String bankReference, String note) {}

    private static final RowMapper<Payment> PAYMENT = (rs, n) -> new Payment(rs.getLong("order_id"), rs.getLong("user_id"),
            rs.getString("transfer_code"), inst(rs, "expires_at"), inst(rs, "paid_at"), rs.getString("provider_transaction_id"),
            inst(rs, "created_at"));

    private static final RowMapper<Refund> REFUND = (rs, n) -> {
        long by = rs.getLong("decided_by");
        return new Refund(rs.getLong("id"), rs.getLong("order_id"), rs.getLong("user_id"), rs.getString("kind"), rs.getString("status"),
                rs.getString("reason"), rs.getLong("amount_vnd"), inst(rs, "requested_at"), inst(rs, "decided_at"), rs.wasNull() ? null : by,
                rs.getString("bank_reference"), rs.getString("note"));
    };

    private static final RowMapper<Issue> ISSUE = (rs, n) -> new Issue(rs.getLong("id"), rs.getString("kind"), rs.getLong("order_id"),
            rs.getLong("user_id"), rs.getString("provider_transaction_id"), rs.getLong("paid_amount_vnd"), rs.getString("status"),
            rs.getString("resolution"), inst(rs, "created_at"), inst(rs, "resolved_at"), rs.getString("bank_reference"), rs.getString("note"));

    private final JdbcTemplate jdbc;
    private volatile boolean present;

    public CommerceRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    /** Whether the V87 commerce tables exist (a database that stops at V86 has no VND checkout at all). */
    public boolean present() {
        if (!present) {
            present = Boolean.TRUE.equals(jdbc.queryForObject("SELECT to_regclass('public.garden_cosmetic_payment') IS NOT NULL", Boolean.class));
        }
        return present;
    }

    // ----------------------------------------------------------------- prices

    /** item code → the fixed VND price of its enabled SKU ({@code kind}: COSMETIC or SKIN). */
    public Map<String, Long> prices(String kind) {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbc.query("SELECT item_code, price_vnd FROM public.garden_cosmetic_sku WHERE item_kind = ? AND enabled AND price_vnd IS NOT NULL",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getLong(2)), kind);
        return out;
    }

    /** "KIND:CODE" → the id of this player's open order for it. */
    public Map<String, Long> pendingOrders(long userId) {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbc.query("SELECT item_kind, item_code, id FROM public.garden_cosmetic_order WHERE user_id = ? AND status = 'PENDING'",
                (RowCallbackHandler) rs -> out.put(rs.getString(1) + ":" + rs.getString(2), rs.getLong(3)), userId);
        return out;
    }

    // ----------------------------------------------------------------- payments

    public void createPayment(long orderId, long userId, String transferCode, Instant expiresAt, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_cosmetic_payment(order_id, user_id, transfer_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
                """, orderId, userId, transferCode, ts(expiresAt), ts(now));
    }

    public Payment payment(long orderId) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_payment WHERE order_id = ?", PAYMENT, orderId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Payment paymentByCode(String transferCode) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_payment WHERE transfer_code = ?", PAYMENT, transferCode);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public boolean codeExists(String transferCode) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_cosmetic_payment WHERE transfer_code = ?", Integer.class, transferCode);
        return n != null && n > 0;
    }

    /** Records the one provider transaction that paid the order; false when it was already paid (nothing changes). */
    public boolean markPaid(long orderId, String providerTransactionId, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_cosmetic_payment SET paid_at = ?, provider_transaction_id = ? WHERE order_id = ? AND paid_at IS NULL
                """, ts(now), providerTransactionId, orderId) == 1;
    }

    // ----------------------------------------------------------------- "was it used?" (the buyer's refund request)

    /**
     * Whether the delivered item was worn, placed or planted since {@code since}. Read from the garden's own records:
     * the equipped rows and placements that exist now, the append-only event log of equip / place commands, and — for a
     * cultivar — plantings made with it.
     */
    public boolean usedSince(long userId, String kind, String code, Instant since) {
        Integer n;
        if ("SKIN".equals(kind)) {
            n = jdbc.queryForObject("""
                    SELECT (SELECT count(*) FROM public.garden_skin_equipped WHERE user_id = ? AND skin_code = ?)
                         + (SELECT count(*) FROM public.garden_planting WHERE user_id = ? AND skin_code = ? AND planted_at >= ?)
                         + (SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'SKIN_EQUIP'
                                AND created_at >= ? AND payload ->> 'skin' = ?)
                    """, Integer.class, userId, code, userId, code, ts(since), userId, ts(since), code);
        } else {
            n = jdbc.queryForObject("""
                    SELECT (SELECT count(*) FROM public.garden_cosmetic_equipped WHERE user_id = ? AND cosmetic_code = ?)
                         + (SELECT count(*) FROM public.garden_decor_placement WHERE user_id = ? AND cosmetic_code = ?)
                         + (SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type IN ('COSMETIC_EQUIP', 'DECOR_PLACE')
                                AND created_at >= ? AND payload ->> 'code' = ?)
                    """, Integer.class, userId, code, userId, code, userId, ts(since), code);
        }
        return n != null && n > 0;
    }

    // ----------------------------------------------------------------- cultivars bought with money

    public String skinName(String skinCode) {
        var rows = jdbc.queryForList("SELECT name_vi FROM public.garden_skin_def WHERE code = ?", String.class, skinCode);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public boolean ownsSkin(long userId, String skinCode) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = ?", Integer.class, userId, skinCode);
        return n != null && n > 0;
    }

    /** Grants a cultivar delivered by a paid order ({@code opKey} names the order); false when it is already owned. */
    public boolean grantSkin(long userId, String skinCode, UUID opKey, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_skin_owned(user_id, skin_code, source, coins_paid, op_key, acquired_at)
                VALUES (?, ?, 'MONEY', 0, ?, ?) ON CONFLICT (user_id, skin_code) DO NOTHING
                """, userId, skinCode, opKey, ts(now)) == 1;
    }

    /**
     * Takes back the cultivar THIS order delivered (never one the player holds by another path): it is unequipped, crops
     * planted with it fall back to the crop's own look, and the ownership row goes. False when this order granted nothing.
     */
    public boolean revokeSkin(long userId, String skinCode, UUID opKey) {
        Integer mine = jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = ? AND source = 'MONEY' AND op_key = ?
                """, Integer.class, userId, skinCode, opKey);
        if (mine == null || mine == 0) return false;
        jdbc.update("DELETE FROM public.garden_skin_equipped WHERE user_id = ? AND skin_code = ?", userId, skinCode);
        jdbc.update("UPDATE public.garden_planting SET skin_code = NULL WHERE user_id = ? AND skin_code = ?", userId, skinCode);
        return jdbc.update("DELETE FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = ? AND source = 'MONEY' AND op_key = ?",
                userId, skinCode, opKey) == 1;
    }

    // ----------------------------------------------------------------- refunds

    public Refund refund(long id) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_refund WHERE id = ?", REFUND, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Refund refundOfOrder(long orderId) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_refund WHERE order_id = ?", REFUND, orderId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Opens the one refund of an order; 0 when the order already has one. */
    public long openRefund(long orderId, long userId, String kind, String reason, long amountVnd, Instant now) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_cosmetic_refund(order_id, user_id, kind, status, reason, amount_vnd, requested_at)
                VALUES (?, ?, ?, 'REQUESTED', ?, ?, ?) ON CONFLICT (order_id) DO NOTHING RETURNING id
                """, Long.class, orderId, userId, kind, reason, amountVnd, ts(now));
        return ids.isEmpty() ? 0 : ids.getFirst();
    }

    public boolean decideRefund(long id, String status, long adminId, String bankReference, String note, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_cosmetic_refund SET status = ?, decided_at = ?, decided_by = ?, bank_reference = ?, note = ?
                WHERE id = ? AND status = 'REQUESTED'
                """, status, ts(now), adminId, bankReference, note, id) == 1;
    }

    public List<Refund> refunds(String status, int limit) {
        return jdbc.query("SELECT * FROM public.garden_cosmetic_refund WHERE status = ? ORDER BY requested_at, id LIMIT ?", REFUND, status, limit);
    }

    // ----------------------------------------------------------------- reconciliation issues

    public Issue issue(long id) {
        var rows = jdbc.query("SELECT * FROM public.garden_commerce_issue WHERE id = ?", ISSUE, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Issue issueByTransaction(String providerTransactionId) {
        var rows = jdbc.query("SELECT * FROM public.garden_commerce_issue WHERE provider_transaction_id = ?", ISSUE, providerTransactionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Issue openIssueOfOrder(long orderId) {
        var rows = jdbc.query("SELECT * FROM public.garden_commerce_issue WHERE order_id = ? AND status = 'OPEN' ORDER BY id LIMIT 1", ISSUE, orderId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Records a verified transfer that could not be delivered; one row per provider transaction (a replay adds nothing). */
    public long openIssue(String kind, long orderId, long userId, String providerTransactionId, long paidAmountVnd, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_commerce_issue(kind, order_id, user_id, provider_transaction_id, paid_amount_vnd, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider_transaction_id) DO NOTHING
                """, kind, orderId, userId, providerTransactionId, paidAmountVnd, ts(now));
        return issueByTransaction(providerTransactionId).id();
    }

    public boolean resolveIssue(long id, String resolution, long adminId, String bankReference, String note, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_commerce_issue SET status = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ?, bank_reference = ?, note = ?
                WHERE id = ? AND status = 'OPEN'
                """, resolution, adminId, ts(now), bankReference, note, id) == 1;
    }

    public List<Issue> issues(String status, int limit) {
        return jdbc.query("SELECT * FROM public.garden_commerce_issue WHERE status = ? ORDER BY created_at, id LIMIT ?", ISSUE, status, limit);
    }
}
