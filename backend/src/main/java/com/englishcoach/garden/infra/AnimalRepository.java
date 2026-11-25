package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Phase 3H persistence of animal houses, livestock and guardian pets (V89). Every statement is scoped by the owner's
 * user id: there is no lookup of an animal by id alone, so another player's animal is simply not found. Rows are only
 * inserted and updated — the schema refuses a delete.
 */
@Repository
public class AnimalRepository {

    public record House(String code, Instant builtAt, Instant wateredUntil) {}

    public record Animal(long id, String species, String kind, String houseCode, Integer place, Instant acquiredAt,
                         Instant progressAt, long growthSeconds, long productSeconds, Instant fedUntil, Instant guardAt) {

        public boolean guardian() {
            return "GUARDIAN".equals(kind);
        }
    }

    private static final RowMapper<Animal> ANIMAL = (rs, n) -> new Animal(rs.getLong("id"), rs.getString("species"),
            rs.getString("kind"), rs.getString("house_code"), (Integer) rs.getObject("place", Integer.class),
            rs.getTimestamp("acquired_at").toInstant(), rs.getTimestamp("progress_at").toInstant(), rs.getLong("growth_seconds"),
            rs.getLong("product_seconds"), rs.getTimestamp("fed_until").toInstant(),
            rs.getTimestamp("guard_at") == null ? null : rs.getTimestamp("guard_at").toInstant());

    private final GardenJdbc jdbc;

    public AnimalRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    // ------------------------------------------------------------------ houses

    public List<House> houses(long userId) {
        return jdbc.query("SELECT code, built_at, watered_until FROM public.garden_animal_house WHERE user_id = ? ORDER BY built_at, code",
                (rs, n) -> new House(rs.getString(1), rs.getTimestamp(2).toInstant(), rs.getTimestamp(3).toInstant()), userId);
    }

    /** @return false when the garden already has this house (nothing changes). */
    public boolean buildHouse(long userId, String code, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_animal_house(user_id, code, built_at, watered_until) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, code) DO NOTHING
                """, userId, code, ts(now), ts(now)) == 1;
    }

    public void setWatered(long userId, String code, Instant until) {
        jdbc.update("UPDATE public.garden_animal_house SET watered_until = ? WHERE user_id = ? AND code = ?", ts(until), userId, code);
    }

    // ------------------------------------------------------------------ animals

    public List<Animal> animals(long userId) {
        return jdbc.query("SELECT * FROM public.garden_animal WHERE user_id = ? ORDER BY id", ANIMAL, userId);
    }

    /** One guardian of a garden, or null. */
    public Animal guardian(long userId, String species) {
        List<Animal> rows = jdbc.query("SELECT * FROM public.garden_animal WHERE user_id = ? AND kind = 'GUARDIAN' AND species = ?",
                ANIMAL, userId, species);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** @return the new animal's id, or null when the place is taken (the caller holds the garden lock, so it never is). */
    public Long insertLivestock(long userId, String species, String houseCode, int place, Instant now, UUID opKey) {
        List<Long> ids = jdbc.queryForList("""
                INSERT INTO public.garden_animal(user_id, species, kind, house_code, place, acquired_at, progress_at, fed_until, op_key)
                VALUES (?, ?, 'LIVESTOCK', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id
                """, Long.class, userId, species, houseCode, place, ts(now), ts(now), ts(now), opKey);
        return ids.isEmpty() ? null : ids.getFirst();
    }

    /** @return the new guardian's id, or null when the garden already has one of this species. */
    public Long insertGuardian(long userId, String species, Instant now, UUID opKey) {
        List<Long> ids = jdbc.queryForList("""
                INSERT INTO public.garden_animal(user_id, species, kind, acquired_at, progress_at, fed_until, op_key)
                VALUES (?, ?, 'GUARDIAN', ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id
                """, Long.class, userId, species, ts(now), ts(now), ts(now), opKey);
        return ids.isEmpty() ? null : ids.getFirst();
    }

    public void saveProgress(long userId, long id, Instant progressAt, long growthSeconds, long productSeconds) {
        jdbc.updateLater("""
                UPDATE public.garden_animal SET progress_at = ?, growth_seconds = ?, product_seconds = ?
                WHERE user_id = ? AND id = ?
                """, ts(progressAt), growthSeconds, productSeconds, userId, id);
    }

    public void setFed(long userId, long id, Instant until) {
        jdbc.update("UPDATE public.garden_animal SET fed_until = ? WHERE user_id = ? AND id = ?", ts(until), userId, id);
    }

    /**
     * The dog turns a visitor away: conditional on the cooldown the caller just checked, so two visitors racing each
     * other cannot both be turned away by the same watch.
     *
     * @return false when another transaction already used this watch
     */
    public boolean markGuard(long userId, long id, Instant now, Instant notAfter) {
        return jdbc.update("""
                UPDATE public.garden_animal SET guard_at = ?
                WHERE user_id = ? AND id = ? AND kind = 'GUARDIAN' AND (guard_at IS NULL OR guard_at <= ?)
                """, ts(now), userId, id, ts(notAfter)) == 1;
    }
}
