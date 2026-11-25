package com.englishcoach.garden.infra;

import com.englishcoach.garden.domain.CosmeticRules;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3E cosmetics (V86): the catalogue, ownership, the equipped appearance of each slot, decorations standing on the
 * island and the closed direct-purchase orders. Every statement is scoped by {@code user_id}; equipment and placement
 * are additionally protected by composite foreign keys and triggers (only an owned item of the right category can be
 * equipped; a decoration unit stands at most once and only while its owner holds it).
 */
@Repository
public class CosmeticRepository {

    public record Owned(String code, int quantity, Instant acquiredAt) {}

    public record Placement(long id, String code, int unitNo, String region, double gx, double gy) {}

    public record Sku(String skuCode, String itemKind, String itemCode, Long priceVnd, boolean enabled) {}

    public record Order(long id, long userId, String skuCode, String itemKind, String itemCode, long amountVnd, String provider,
                        String providerRef, String status, Instant createdAt, Instant fulfilledAt) {}

    private final JdbcTemplate jdbc;

    public CosmeticRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- catalogue

    /** The Phase 3E rules, or null on a database without the V86 catalogue (the garden then has no cosmetic shop). */
    public static CosmeticRules load(JdbcTemplate jdbc, ObjectMapper json) {
        Boolean present = jdbc.queryForObject("SELECT to_regclass('public.garden_cosmetic_def') IS NOT NULL", Boolean.class);
        if (!Boolean.TRUE.equals(present)) return null;
        List<String> cfg = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'cosmetics'", String.class);
        if (cfg.isEmpty()) return null;
        Map<String, CosmeticRules.CollectionDef> collections = new LinkedHashMap<>();
        jdbc.query("SELECT * FROM public.garden_collection_def ORDER BY sort_order, code", (RowCallbackHandler) rs ->
                collections.put(rs.getString("code"), new CosmeticRules.CollectionDef(rs.getString("code"), rs.getString("name_vi"),
                        rs.getString("description_vi"), rs.getInt("sort_order"))));
        Map<String, CosmeticRules.Item> items = new LinkedHashMap<>();
        jdbc.query("SELECT * FROM public.garden_cosmetic_def WHERE active ORDER BY sort_order, code", (RowCallbackHandler) rs -> {
            var item = new CosmeticRules.Item(rs.getString("code"), rs.getString("category"), rs.getString("family"),
                    rs.getString("collection_code"), rs.getString("name_vi"), rs.getString("description_vi"), rs.getString("art_key"),
                    rs.getString("unlock_kind"), rs.getLong("coin_price"), rs.getInt("requirement"), rs.getInt("max_owned"),
                    rs.getDouble("footprint"), rs.getInt("sort_order"));
            if (!collections.containsKey(item.collection())) throw new IllegalStateException("cosmetic " + item.code() + ": unknown collection");
            items.put(item.code(), item);
        });
        Map<String, String> skinCollections = new LinkedHashMap<>();
        jdbc.query("SELECT code, collection_code FROM public.garden_skin_def WHERE active AND collection_code IS NOT NULL ORDER BY sort_order, code",
                (RowCallbackHandler) rs -> skinCollections.put(rs.getString(1), rs.getString(2)));
        JsonNode c;
        try {
            c = json.readTree(cfg.getFirst());
        } catch (Exception e) {
            throw new IllegalStateException("garden_config.cosmetics is not valid JSON", e);
        }
        List<CosmeticRules.Region> regions = new ArrayList<>();
        for (JsonNode r : c.path("regions")) {
            JsonNode rect = r.path("rect");
            var region = new CosmeticRules.Region(r.path("code").asText(), r.path("nameVi").asText(), rect.path(0).asDouble(),
                    rect.path(1).asDouble(), rect.path(2).asDouble(), rect.path(3).asDouble());
            if (region.code().isBlank() || region.x1() <= region.x0() || region.y1() <= region.y0()) {
                throw new IllegalStateException("invalid cosmetics.regions entry " + region.code());
            }
            regions.add(region);
        }
        int maxPlaced = c.path("maxPlaced").asInt(0);
        double snap = c.path("snap").asDouble(0);
        if (maxPlaced <= 0 || snap <= 0 || regions.isEmpty()) throw new IllegalStateException("invalid garden_config.cosmetics");
        return new CosmeticRules(Collections.unmodifiableMap(collections), Collections.unmodifiableMap(items),
                Collections.unmodifiableMap(skinCollections), maxPlaced, snap, List.copyOf(regions));
    }

    // ----------------------------------------------------------------- ownership

    public Map<String, Owned> owned(long userId) {
        Map<String, Owned> out = new LinkedHashMap<>();
        jdbc.query("SELECT cosmetic_code, quantity, acquired_at FROM public.garden_cosmetic_owned WHERE user_id = ?",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), new Owned(rs.getString(1), rs.getInt(2), inst(rs, "acquired_at"))), userId);
        return out;
    }

    public int quantity(long userId, String code) {
        var rows = jdbc.queryForList("SELECT quantity FROM public.garden_cosmetic_owned WHERE user_id = ? AND cosmetic_code = ?",
                Integer.class, userId, code);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    /**
     * Grants unit {@code unitNo} of an item (the next one after the units already held) and writes its history row.
     * False when the ownership did not move from {@code unitNo - 1} to {@code unitNo} — a concurrent or repeated
     * acquisition; the caller then charges nothing (its transaction rolls back).
     */
    public boolean grantUnit(long userId, String code, int unitNo, String source, long coinsPaid, Long orderId, UUID opKey, Instant now) {
        int moved = unitNo == 1
                ? jdbc.update("""
                        INSERT INTO public.garden_cosmetic_owned(user_id, cosmetic_code, quantity, acquired_at, updated_at)
                        VALUES (?, ?, 1, ?, ?) ON CONFLICT (user_id, cosmetic_code) DO NOTHING
                        """, userId, code, ts(now), ts(now))
                : jdbc.update("""
                        UPDATE public.garden_cosmetic_owned SET quantity = ?, updated_at = ?
                        WHERE user_id = ? AND cosmetic_code = ? AND quantity = ?
                        """, unitNo, ts(now), userId, code, unitNo - 1);
        if (moved != 1) return false;
        // the history row takes the lowest unit number no live row holds: normally the unit just granted, and after a
        // refunded unit (its row is reversed, the higher ones stay) the number that refund freed
        jdbc.update("""
                INSERT INTO public.garden_cosmetic_acquisition(user_id, cosmetic_code, unit_no, source, coins_paid, order_id, op_key, created_at)
                VALUES (?, ?, (SELECT min(n) FROM generate_series(1, 9) AS n WHERE NOT EXISTS (
                        SELECT 1 FROM public.garden_cosmetic_acquisition a
                        WHERE a.user_id = ? AND a.cosmetic_code = ? AND a.unit_no = n AND a.reversed_at IS NULL)), ?, ?, ?, ?, ?)
                """, userId, code, userId, code, source, coinsPaid, orderId, opKey, ts(now));
        return true;
    }

    /** Takes back a permanent item delivered by a direct purchase that was refunded (its history row is kept, marked). */
    public boolean revokeOrderGrant(long userId, String code, long orderId, Instant now) {
        int marked = jdbc.update("""
                UPDATE public.garden_cosmetic_acquisition SET reversed_at = ?
                WHERE user_id = ? AND cosmetic_code = ? AND order_id = ? AND reversed_at IS NULL
                """, ts(now), userId, code, orderId);
        if (marked != 1) return false;
        int qty = quantity(userId, code);
        if (qty > 1) {
            // a decoration of which further units were bought with coins: only the one unit this order paid for goes
            // (the highest-numbered one leaves the island if it stands); the others stay owned
            jdbc.update("DELETE FROM public.garden_decor_placement WHERE user_id = ? AND cosmetic_code = ? AND unit_no = ?", userId, code, qty);
            return jdbc.update("UPDATE public.garden_cosmetic_owned SET quantity = quantity - 1, updated_at = ? WHERE user_id = ? AND cosmetic_code = ? AND quantity = ?",
                    ts(now), userId, code, qty) == 1;
        }
        jdbc.update("DELETE FROM public.garden_decor_placement WHERE user_id = ? AND cosmetic_code = ?", userId, code);
        jdbc.update("DELETE FROM public.garden_cosmetic_equipped WHERE user_id = ? AND cosmetic_code = ?", userId, code);
        return jdbc.update("DELETE FROM public.garden_cosmetic_owned WHERE user_id = ? AND cosmetic_code = ?", userId, code) == 1;
    }

    // ----------------------------------------------------------------- equipment

    /** slot → equipped item code. */
    public Map<String, String> equipped(long userId) {
        Map<String, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT slot, cosmetic_code FROM public.garden_cosmetic_equipped WHERE user_id = ?",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getString(2)), userId);
        return out;
    }

    public void equip(long userId, String slot, String code, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_cosmetic_equipped(user_id, slot, cosmetic_code, equipped_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, slot) DO UPDATE SET cosmetic_code = EXCLUDED.cosmetic_code, equipped_at = EXCLUDED.equipped_at
                """, userId, slot, code, ts(now));
    }

    public void unequip(long userId, String slot) {
        jdbc.update("DELETE FROM public.garden_cosmetic_equipped WHERE user_id = ? AND slot = ?", userId, slot);
    }

    // ----------------------------------------------------------------- decorations

    public List<Placement> placements(long userId) {
        return jdbc.query("""
                SELECT id, cosmetic_code, unit_no, region_code, gx, gy FROM public.garden_decor_placement
                WHERE user_id = ? ORDER BY id
                """, (rs, n) -> new Placement(rs.getLong(1), rs.getString(2), rs.getInt(3), rs.getString(4), rs.getDouble(5), rs.getDouble(6)), userId);
    }

    public long place(long userId, String code, int unitNo, String region, double gx, double gy, Instant now) {
        Long id = jdbc.queryForObject("""
                INSERT INTO public.garden_decor_placement(user_id, cosmetic_code, unit_no, region_code, gx, gy, placed_at, moved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, userId, code, unitNo, region, gx, gy, ts(now), ts(now));
        return id == null ? 0 : id;
    }

    public boolean move(long userId, long id, String region, double gx, double gy, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_decor_placement SET region_code = ?, gx = ?, gy = ?, moved_at = ? WHERE user_id = ? AND id = ?
                """, region, gx, gy, ts(now), userId, id) == 1;
    }

    /** Puts a decoration back into storage (the ownership stays). */
    public boolean store(long userId, long id) {
        return jdbc.update("DELETE FROM public.garden_decor_placement WHERE user_id = ? AND id = ?", userId, id) == 1;
    }

    // ----------------------------------------------------------------- direct purchase (closed boundary)

    public Sku skuOf(String itemKind, String itemCode) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_sku WHERE item_kind = ? AND item_code = ?", (rs, n) -> {
            long price = rs.getLong("price_vnd");
            return new Sku(rs.getString("sku_code"), rs.getString("item_kind"), rs.getString("item_code"), rs.wasNull() ? null : price,
                    rs.getBoolean("enabled"));
        }, itemKind, itemCode);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public long createOrder(long userId, Sku sku, String provider, String providerRef, Instant now) {
        Long id = jdbc.queryForObject("""
                INSERT INTO public.garden_cosmetic_order(user_id, sku_code, item_kind, item_code, amount_vnd, provider, provider_ref, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?) RETURNING id
                """, Long.class, userId, sku.skuCode(), sku.itemKind(), sku.itemCode(), sku.priceVnd(), provider, providerRef, ts(now));
        return id == null ? 0 : id;
    }

    public Order orderByRef(String provider, String providerRef) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_order WHERE provider = ? AND provider_ref = ?", (rs, n) ->
                new Order(rs.getLong("id"), rs.getLong("user_id"), rs.getString("sku_code"), rs.getString("item_kind"),
                        rs.getString("item_code"), rs.getLong("amount_vnd"), rs.getString("provider"), rs.getString("provider_ref"),
                        rs.getString("status"), inst(rs, "created_at"), inst(rs, "fulfilled_at")), provider, providerRef);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static final org.springframework.jdbc.core.RowMapper<Order> ORDER = (rs, n) ->
            new Order(rs.getLong("id"), rs.getLong("user_id"), rs.getString("sku_code"), rs.getString("item_kind"),
                    rs.getString("item_code"), rs.getLong("amount_vnd"), rs.getString("provider"), rs.getString("provider_ref"),
                    rs.getString("status"), inst(rs, "created_at"), inst(rs, "fulfilled_at"));

    public Order orderById(long id) {
        var rows = jdbc.query("SELECT * FROM public.garden_cosmetic_order WHERE id = ?", ORDER, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** This player's orders, newest first. */
    public List<Order> ordersOf(long userId, int limit) {
        return jdbc.query("SELECT * FROM public.garden_cosmetic_order WHERE user_id = ? ORDER BY id DESC LIMIT ?", ORDER, userId, limit);
    }

    public Order openOrder(long userId, String skuCode) {
        var rows = jdbc.query("SELECT provider, provider_ref FROM public.garden_cosmetic_order WHERE user_id = ? AND sku_code = ? AND status = 'PENDING'",
                (rs, n) -> orderByRef(rs.getString(1), rs.getString(2)), userId, skuCode);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Moves an order from one status to the next; false when it was not in {@code from} (a replay). */
    public boolean advanceOrder(long orderId, String from, String to, Instant now) {
        boolean fulfil = "FULFILLED".equals(to);
        return jdbc.update("""
                UPDATE public.garden_cosmetic_order SET status = ?, fulfilled_at = CASE WHEN ? THEN ?::timestamptz ELSE fulfilled_at END,
                    closed_at = CASE WHEN ? THEN closed_at ELSE ?::timestamptz END
                WHERE id = ? AND status = ?
                """, to, fulfil, ts(now), fulfil, ts(now), orderId, from) == 1;
    }
}
