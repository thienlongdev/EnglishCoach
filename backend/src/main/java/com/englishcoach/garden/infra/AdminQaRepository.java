package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Persistence of the official administrator's QA access (Phase 4, V90). Every row written here says {@code ADMIN_QA}
 * as its source — never a purchase, a payment or an achievement — and every statement is scoped by the caller's own
 * {@code user_id}. Nothing here touches coins, the payment tables, learning records or another garden.
 */
@Repository
public class AdminQaRepository {

    public static final String SOURCE = "ADMIN_QA";

    private final JdbcTemplate jdbc;
    private volatile Boolean ready;

    public AdminQaRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    private static Timestamp ts(Instant i) {
        return Timestamp.from(i);
    }

    /** Whether the schema can record a QA source (V90). Checked once: a schema only changes with a restart. */
    public boolean ready() {
        Boolean r = ready;
        if (r == null) {
            Integer n = jdbc.queryForObject("""
                    SELECT count(*) FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'garden_animal' AND column_name = 'source'
                    """, Integer.class);
            ready = r = n != null && n > 0;
        }
        return r;
    }

    // ------------------------------------------------------------------ cosmetics

    /** Skin codes the garden holds only through QA. */
    public List<String> qaSkins(long userId) {
        return jdbc.queryForList("SELECT skin_code FROM public.garden_skin_owned WHERE user_id = ? AND source = 'ADMIN_QA' ORDER BY skin_code",
                String.class, userId);
    }

    /** Units (item code, one row per unit) the garden holds only through QA. */
    public int qaUnits(long userId) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND source = 'ADMIN_QA' AND reversed_at IS NULL
                """, Integer.class, userId);
        return n == null ? 0 : n;
    }

    /**
     * Grants every unit of every catalogue item the garden does not hold yet as a QA unit: one history row per unit
     * ({@code ADMIN_QA}, no coins, no order) and the ownership raised to the catalogue's maximum. Set-based (two
     * statements whatever the size of the catalogue); units the account bought or earned keep their own history rows.
     *
     * @return the number of QA units granted
     */
    public int grantUnits(long userId, UUID opKey, Instant now) {
        int units = jdbc.update("""
                INSERT INTO public.garden_cosmetic_acquisition(user_id, cosmetic_code, unit_no, source, coins_paid, order_id, op_key, created_at)
                SELECT ?, d.code, n, 'ADMIN_QA', 0, NULL, ?, ?
                FROM public.garden_cosmetic_def d JOIN generate_series(1, 9) AS n ON n <= d.max_owned
                WHERE d.active AND NOT EXISTS (SELECT 1 FROM public.garden_cosmetic_acquisition a
                      WHERE a.user_id = ? AND a.cosmetic_code = d.code AND a.unit_no = n AND a.reversed_at IS NULL)
                """, userId, opKey, ts(now), userId);
        jdbc.update("""
                INSERT INTO public.garden_cosmetic_owned(user_id, cosmetic_code, quantity, acquired_at, updated_at)
                SELECT ?, d.code, d.max_owned, ?, ? FROM public.garden_cosmetic_def d WHERE d.active
                ON CONFLICT (user_id, cosmetic_code) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = EXCLUDED.updated_at
                WHERE public.garden_cosmetic_owned.quantity < EXCLUDED.quantity
                """, userId, ts(now), ts(now));
        return units;
    }

    /** Grants every active cultivar the garden does not hold yet as a QA cultivar; returns how many. */
    public int grantSkins(long userId, UUID opKey, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_skin_owned(user_id, skin_code, source, coins_paid, op_key, acquired_at)
                SELECT ?, d.code, 'ADMIN_QA', 0, ?, ? FROM public.garden_skin_def d WHERE d.active
                ON CONFLICT (user_id, skin_code) DO NOTHING
                """, userId, opKey, ts(now));
    }

    /**
     * Takes every QA cultivar back: it is unequipped, crops planted with it fall back to the crop's own look, and the
     * QA ownership row goes. A cultivar the player holds by another path is never touched (its row has another source).
     */
    public int revokeSkins(long userId) {
        jdbc.update("""
                DELETE FROM public.garden_skin_equipped e USING public.garden_skin_owned o
                WHERE e.user_id = ? AND o.user_id = e.user_id AND o.skin_code = e.skin_code AND o.source = 'ADMIN_QA'
                """, userId);
        jdbc.update("""
                UPDATE public.garden_planting p SET skin_code = NULL FROM public.garden_skin_owned o
                WHERE p.user_id = ? AND o.user_id = p.user_id AND o.skin_code = p.skin_code AND o.source = 'ADMIN_QA'
                """, userId);
        return jdbc.update("DELETE FROM public.garden_skin_owned WHERE user_id = ? AND source = 'ADMIN_QA'", userId);
    }

    /**
     * Takes every QA unit back. The history rows stay, marked reversed (like a refunded purchase). An item of which no
     * other unit is held leaves the island (equipment and decorations) and its ownership row goes; an item the player
     * also holds by another path keeps exactly those units, and its decorations return to storage.
     *
     * @return the number of units taken back
     */
    public int revokeUnits(long userId, Instant now) {
        List<String> codes = jdbc.queryForList("""
                UPDATE public.garden_cosmetic_acquisition SET reversed_at = ?
                WHERE user_id = ? AND source = 'ADMIN_QA' AND reversed_at IS NULL RETURNING cosmetic_code
                """, String.class, ts(now), userId);
        if (codes.isEmpty()) return 0;
        String[] affected = codes.stream().distinct().toArray(String[]::new);
        // set-based from here: the decorations of every affected item return to storage; an item with no unit left
        // leaves the island and the collection; an item the account also holds by another path keeps exactly those units
        String noUnitLeft = """
                 AND NOT EXISTS (SELECT 1 FROM public.garden_cosmetic_acquisition a
                     WHERE a.user_id = t.user_id AND a.cosmetic_code = t.cosmetic_code AND a.reversed_at IS NULL)""";
        jdbc.update("DELETE FROM public.garden_decor_placement t WHERE t.user_id = ? AND t.cosmetic_code = ANY(?)", userId, affected);
        jdbc.update("DELETE FROM public.garden_cosmetic_equipped t WHERE t.user_id = ? AND t.cosmetic_code = ANY(?)" + noUnitLeft, userId, affected);
        jdbc.update("DELETE FROM public.garden_cosmetic_owned t WHERE t.user_id = ? AND t.cosmetic_code = ANY(?)" + noUnitLeft, userId, affected);
        jdbc.update("""
                UPDATE public.garden_cosmetic_owned o SET quantity = l.units, updated_at = ?
                FROM (SELECT cosmetic_code, count(*) AS units FROM public.garden_cosmetic_acquisition
                      WHERE user_id = ? AND reversed_at IS NULL AND cosmetic_code = ANY(?) GROUP BY cosmetic_code) l
                WHERE o.user_id = ? AND o.cosmetic_code = l.cosmetic_code
                """, ts(now), userId, affected, userId);
        return codes.size();
    }

    // ------------------------------------------------------------------ animals

    /** @return false when the garden already has this house (nothing changes). */
    public boolean buildHouse(long userId, String code, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_animal_house(user_id, code, built_at, watered_until, source) VALUES (?, ?, ?, ?, 'ADMIN_QA')
                ON CONFLICT (user_id, code) DO NOTHING
                """, userId, code, ts(now), ts(now)) == 1;
    }

    /** @return false when the place is taken (nothing changes). */
    public boolean insertLivestock(long userId, String species, String houseCode, int place, Instant now, UUID opKey) {
        return jdbc.update("""
                INSERT INTO public.garden_animal(user_id, species, kind, house_code, place, acquired_at, progress_at, fed_until, op_key, source)
                VALUES (?, ?, 'LIVESTOCK', ?, ?, ?, ?, ?, ?, 'ADMIN_QA') ON CONFLICT DO NOTHING
                """, userId, species, houseCode, place, ts(now), ts(now), ts(now), opKey) == 1;
    }

    /** @return false when the garden already has a guardian of this species (nothing changes). */
    public boolean insertGuardian(long userId, String species, Instant now, UUID opKey) {
        return jdbc.update("""
                INSERT INTO public.garden_animal(user_id, species, kind, acquired_at, progress_at, fed_until, op_key, source)
                VALUES (?, ?, 'GUARDIAN', ?, ?, ?, ?, 'ADMIN_QA') ON CONFLICT DO NOTHING
                """, userId, species, ts(now), ts(now), ts(now), opKey) == 1;
    }

    /** QA time control: a guardian dog's last watch moves back, so its cooldown and shield can be seen ending. */
    public void shiftGuard(long userId, long seconds) {
        jdbc.update("""
                UPDATE public.garden_animal SET guard_at = guard_at - (? * interval '1 second')
                WHERE user_id = ? AND kind = 'GUARDIAN' AND guard_at IS NOT NULL
                """, seconds, userId);
    }
}
