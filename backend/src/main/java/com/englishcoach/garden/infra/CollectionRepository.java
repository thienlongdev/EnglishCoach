package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Crop mastery, the codex and crop skins (Phase 3B, V82). Every statement is scoped by {@code user_id}; ownership and
 * the equipped skin are additionally protected by composite foreign keys (a skin can only be equipped or planted by a
 * player who owns it, and only on its own crop).
 */
@Repository
public class CollectionRepository {

    public record MasteryRow(String cropCode, int harvests, int bestTier, int seasons, int tier, Instant firstAt,
                             Instant lastAt) {}

    public record HarvestFact(String cropCode, String tier, Instant harvestedAt) {}

    public record Form(String form, Instant firstAt) {}

    public record Owned(String skinCode, String source, long coinsPaid, Instant acquiredAt) {}

    private final GardenJdbc jdbc;

    public CollectionRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- mastery

    public Map<String, MasteryRow> mastery(long userId) {
        Map<String, MasteryRow> out = new LinkedHashMap<>();
        jdbc.query("SELECT * FROM public.garden_crop_mastery WHERE user_id = ?", (RowCallbackHandler) rs -> out.put(
                rs.getString("crop_code"), new MasteryRow(rs.getString("crop_code"), rs.getInt("harvests"), rs.getInt("best_tier"),
                        rs.getInt("seasons"), rs.getInt("tier"), inst(rs, "first_at"), inst(rs, "last_at"))), userId);
        return out;
    }

    public MasteryRow masteryOf(long userId, String cropCode) {
        return mastery(userId).get(cropCode);
    }

    /** One more harvest of a crop: the count rises by one, the best tier and the season set only ever grow. */
    public void addHarvest(long userId, String cropCode, int tierRank, int seasonBit, Instant now) {
        jdbc.updateLater("""
                INSERT INTO public.garden_crop_mastery AS m (user_id, crop_code, harvests, best_tier, seasons, first_at, last_at)
                VALUES (?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT (user_id, crop_code) DO UPDATE SET harvests = m.harvests + 1,
                    best_tier = GREATEST(m.best_tier, EXCLUDED.best_tier), seasons = m.seasons | EXCLUDED.seasons,
                    last_at = GREATEST(m.last_at, EXCLUDED.last_at)
                """, userId, cropCode, tierRank, seasonBit, ts(now), ts(now));
    }

    /** Seeds a crop's counters from the garden's own harvest history (once per garden, before any increment). */
    public void seed(long userId, String cropCode, int harvests, int bestTier, int seasons, Instant firstAt, Instant lastAt) {
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, first_at, last_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, crop_code) DO NOTHING
                """, userId, cropCode, harvests, bestTier, seasons, ts(firstAt), ts(lastAt));
    }

    public void raiseTier(long userId, String cropCode, int tier) {
        jdbc.updateLater("UPDATE public.garden_crop_mastery SET tier = GREATEST(tier, ?) WHERE user_id = ? AND crop_code = ?",
                tier, userId, cropCode);
    }

    /** Every harvest this garden ever closed (crop, quality tier, instant): the history the mastery seed is built from. */
    public List<HarvestFact> harvestHistory(long userId) {
        return jdbc.query("""
                SELECT crop_code, harvest_tier, harvested_at FROM public.garden_planting
                WHERE user_id = ? AND harvested_at IS NOT NULL ORDER BY harvested_at, id
                """, (rs, n) -> new HarvestFact(rs.getString(1), rs.getString(2), inst(rs, "harvested_at")), userId);
    }

    // ----------------------------------------------------------------- codex

    public Map<String, List<Form>> codex(long userId) {
        Map<String, List<Form>> out = new LinkedHashMap<>();
        jdbc.query("SELECT crop_code, form, first_at FROM public.garden_codex WHERE user_id = ? ORDER BY crop_code, first_at, form",
                (RowCallbackHandler) rs -> out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>())
                        .add(new Form(rs.getString(2), inst(rs, "first_at"))), userId);
        return out;
    }

    public int codexForms(long userId, String cropCode) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_codex WHERE user_id = ? AND crop_code = ?",
                Integer.class, userId, cropCode);
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- skins

    public Map<String, Owned> owned(long userId) {
        Map<String, Owned> out = new LinkedHashMap<>();
        jdbc.query("SELECT skin_code, source, coins_paid, acquired_at FROM public.garden_skin_owned WHERE user_id = ?",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), new Owned(rs.getString(1), rs.getString(2), rs.getLong(3),
                        inst(rs, "acquired_at"))), userId);
        return out;
    }

    public boolean owns(long userId, String skinCode) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = ?",
                Integer.class, userId, skinCode);
        return n != null && n > 0;
    }

    /** Grants a skin once (0 rows ⇒ already owned: the caller charges nothing). */
    public boolean grant(long userId, String skinCode, String source, long coinsPaid, UUID opKey, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_skin_owned(user_id, skin_code, source, coins_paid, op_key, acquired_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, skin_code) DO NOTHING
                """, userId, skinCode, source, coinsPaid, opKey, ts(now)) == 1;
    }

    /** crop code → equipped skin code. */
    public Map<String, String> equipped(long userId) {
        Map<String, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT crop_code, skin_code FROM public.garden_skin_equipped WHERE user_id = ?",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getString(2)), userId);
        return out;
    }

    public String equippedFor(long userId, String cropCode) {
        var rows = jdbc.queryForList("SELECT skin_code FROM public.garden_skin_equipped WHERE user_id = ? AND crop_code = ?",
                String.class, userId, cropCode);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public void equip(long userId, String cropCode, String skinCode, Instant now) {
        jdbc.update("""
                INSERT INTO public.garden_skin_equipped(user_id, crop_code, skin_code, equipped_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, crop_code) DO UPDATE SET skin_code = EXCLUDED.skin_code, equipped_at = EXCLUDED.equipped_at
                """, userId, cropCode, skinCode, ts(now));
    }

    public void unequip(long userId, String cropCode) {
        jdbc.update("DELETE FROM public.garden_skin_equipped WHERE user_id = ? AND crop_code = ?", userId, cropCode);
    }
}
