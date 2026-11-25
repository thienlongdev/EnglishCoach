package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeGameDtos.Owned;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;

/** The game rows (V130). Every statement carries {@code user_id}: another learner's game, claims or purchases are never touched. */
@Repository
public class EchoLifeGameRepository {

    private static final int LOCK_GAME = 0x454d; // "EM"

    /** The row as stored. */
    record Row(int saveVersion, long revision, JsonNode doc, int credits, Map<String, Integer> skills, LocalDate earnedDay,
               int earnedCredits, int earnedXp, Instant updatedAt, JsonNode workshop, long workshopRevision) {
    }

    /** Batched single-round-trip snapshot of the learner's game row, unique claims, and active owned instances. */
    record Snapshot(Row row, List<String> claimed, List<Owned> owned) {}
    record ClaimsAndOwned(List<String> claimed, List<Owned> owned) {}
    record Saved(long revision, Instant updatedAt) {}

    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {};
    private static final TypeReference<List<Owned>> OWNED_LIST = new TypeReference<>() {};

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public EchoLifeGameRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** One learner's game writes, claims and purchases happen one at a time (transaction-scoped advisory lock). */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_GAME, (int) (userId ^ (userId >>> 32)));
    }

    public Optional<Row> find(long userId) {
        return jdbc.query("""
                SELECT save_version, revision, doc, credits, skills, earned_day, earned_credits, earned_xp, updated_at, workshop, workshop_revision
                FROM public.echo_life_games WHERE user_id = ?""", (rs, n) -> mapRow(rs), userId).stream().findFirst();
    }

    /** Locks an existing learner game row directly (steady-state narrative saves avoid separate advisory lock + ensure). */
    public Optional<Row> findForUpdate(long userId) {
        return jdbc.query("""
                SELECT save_version, revision, doc, credits, skills, earned_day, earned_credits, earned_xp, updated_at, workshop, workshop_revision
                FROM public.echo_life_games WHERE user_id = ? FOR UPDATE""", (rs, n) -> mapRow(rs), userId).stream().findFirst();
    }

    /** Single round-trip read of game row + claims + owned items. */
    public Snapshot loadSnapshot(long userId) {
        return jdbc.query("""
                SELECT g.save_version, g.revision, g.doc, g.credits, g.skills, g.earned_day, g.earned_credits, g.earned_xp, g.updated_at, g.workshop, g.workshop_revision,
                       (SELECT coalesce(jsonb_agg(c.claim_key ORDER BY c.claimed_at, c.claim_key), '[]'::jsonb)
                          FROM public.echo_life_claims c WHERE c.user_id = ?) AS claimed_json,
                       (SELECT coalesce(jsonb_agg(jsonb_build_object(
                               'instanceId', o.instance_id, 'storeId', o.store_id, 'sku', o.sku, 'itemType', o.item_type, 'price', o.price
                             ) ORDER BY o.created_at, o.instance_id), '[]'::jsonb)
                          FROM public.echo_life_owned o WHERE o.user_id = ? AND o.status = 'OWNED') AS owned_json
                FROM (SELECT 1) AS _one
                LEFT JOIN public.echo_life_games g ON g.user_id = ?""",
                (rs, n) -> {
                    Row row = rs.getObject(1) == null ? null : mapRow(rs);
                    return new Snapshot(row, parseList(rs.getString(12), STRING_LIST), parseList(rs.getString(13), OWNED_LIST));
                }, userId, userId, userId).get(0);
    }

    /** Single round-trip read of claims + owned items (post-lock consistent snapshot). */
    public ClaimsAndOwned loadClaimsAndOwned(long userId) {
        return jdbc.query("""
                SELECT (SELECT coalesce(jsonb_agg(c.claim_key ORDER BY c.claimed_at, c.claim_key), '[]'::jsonb)
                          FROM public.echo_life_claims c WHERE c.user_id = ?) AS claimed_json,
                       (SELECT coalesce(jsonb_agg(jsonb_build_object(
                               'instanceId', o.instance_id, 'storeId', o.store_id, 'sku', o.sku, 'itemType', o.item_type, 'price', o.price
                             ) ORDER BY o.created_at, o.instance_id), '[]'::jsonb)
                          FROM public.echo_life_owned o WHERE o.user_id = ? AND o.status = 'OWNED') AS owned_json""",
                (rs, n) -> new ClaimsAndOwned(parseList(rs.getString(1), STRING_LIST), parseList(rs.getString(2), OWNED_LIST)),
                userId, userId).get(0);
    }

    private Row mapRow(ResultSet rs) throws SQLException {
        return new Row(
                rs.getInt(1),
                rs.getLong(2),
                rs.getString(3) == null ? null : parse(rs.getString(3)),
                rs.getInt(4),
                skills(rs.getString(5)),
                rs.getObject(6, LocalDate.class),
                rs.getInt(7),
                rs.getInt(8),
                rs.getTimestamp(9).toInstant(),
                rs.getString(10) == null ? null : parse(rs.getString(10)),
                rs.getLong(11));
    }

    /** Creates the learner's row with the starting balance (idempotent). */
    public void ensure(long userId, int startingCredits) {
        jdbc.update("INSERT INTO public.echo_life_games (user_id, credits) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING", userId, startingCredits);
    }

    public Optional<Saved> writeDocReturning(long userId, int saveVersion, JsonNode doc, long expectedRevision) {
        return jdbc.query("""
                UPDATE public.echo_life_games SET doc = ?::jsonb, save_version = ?, revision = revision + 1, updated_at = now()
                WHERE user_id = ? AND revision = ? RETURNING revision, updated_at""",
                (rs, n) -> new Saved(rs.getLong(1), rs.getTimestamp(2).toInstant()),
                text(doc), saveVersion, userId, expectedRevision).stream().findFirst();
    }

    public long writeDoc(long userId, int saveVersion, JsonNode doc, long expectedRevision) {
        return writeDocReturning(userId, saveVersion, doc, expectedRevision).map(Saved::revision).orElse(-1L);
    }

    public boolean remember(long userId, String requestId, JsonNode action) {
        if (jdbc.update("INSERT INTO public.echo_life_operations(user_id,request_id,operation) VALUES(?,?,?::jsonb) ON CONFLICT DO NOTHING",
                userId,requestId,text(action)) == 1) return true;
        Boolean same=jdbc.queryForObject("SELECT operation=?::jsonb FROM public.echo_life_operations WHERE user_id=? AND request_id=?",
                Boolean.class,text(action),userId,requestId);
        if (!Boolean.TRUE.equals(same)) throw new EchoLifeException(409,"REQUEST_ID_REUSED");
        return false;
    }

    public void forget(long userId,String requestId) {
        jdbc.update("DELETE FROM public.echo_life_operations WHERE user_id=? AND request_id=?",userId,requestId);
    }

    public long writeWorkshop(long userId,JsonNode projection) {
        return jdbc.queryForObject(
                "UPDATE public.echo_life_games SET workshop=?::jsonb, workshop_revision=workshop_revision+1, updated_at=now() WHERE user_id=? RETURNING workshop_revision",
                Long.class, text(projection), userId);
    }

    /** Single-statement atomic update of workshop projection + economy counters (saves 1 RTT per workshop/purchase/sale). */
    public long writeWorkshopAndEconomy(long userId, JsonNode projection, int credits, Map<String, Integer> skills, LocalDate day,
                                        int earnedCredits, int earnedXp, int addEarned, int addSpent) {
        return jdbc.queryForObject("""
                UPDATE public.echo_life_games
                   SET workshop = ?::jsonb, workshop_revision = workshop_revision + 1,
                       credits = ?, skills = ?::jsonb, earned_day = ?, earned_credits = ?, earned_xp = ?,
                       lifetime_earned = lifetime_earned + ?, lifetime_spent = lifetime_spent + ?, updated_at = now()
                 WHERE user_id = ?
                 RETURNING workshop_revision""",
                Long.class, text(projection), credits, text(json.valueToTree(skills)), day, earnedCredits, earnedXp,
                addEarned, addSpent, userId);
    }

    public void writeEconomy(long userId, int credits, Map<String, Integer> skills, LocalDate day, int earnedCredits, int earnedXp,
                             int addEarned, int addSpent) {
        jdbc.update("""
                UPDATE public.echo_life_games SET credits = ?, skills = ?::jsonb, earned_day = ?, earned_credits = ?, earned_xp = ?,
                  lifetime_earned = lifetime_earned + ?, lifetime_spent = lifetime_spent + ?, updated_at = now()
                WHERE user_id = ?""", credits, text(json.valueToTree(skills)), day, earnedCredits, earnedXp, addEarned, addSpent, userId);
    }

    public List<String> claimed(long userId) {
        return jdbc.query("SELECT claim_key FROM public.echo_life_claims WHERE user_id = ? ORDER BY claimed_at, claim_key",
                (rs, n) -> rs.getString(1), userId);
    }

    /** Records a unique reward; false when the learner already had it (the primary key refuses a second grant). */
    public boolean claim(long userId, String key, int credits, int xp) {
        return jdbc.update("""
                INSERT INTO public.echo_life_claims (user_id, claim_key, credits, xp) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, claim_key) DO NOTHING""", userId, key, credits, xp) == 1;
    }

    public List<Owned> owned(long userId) {
        return jdbc.query("""
                SELECT instance_id, store_id, sku, item_type, price FROM public.echo_life_owned
                WHERE user_id = ? AND status = 'OWNED' ORDER BY created_at, instance_id""",
                (rs, n) -> new Owned(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getInt(5)), userId);
    }

    public Optional<Owned> byRequest(long userId, String requestId) {
        return jdbc.query("""
                SELECT instance_id, store_id, sku, item_type, price FROM public.echo_life_owned WHERE user_id = ? AND request_id = ?""",
                (rs, n) -> new Owned(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getInt(5)), userId, requestId)
                .stream().findFirst();
    }

    public void buy(long userId, String instanceId, String storeId, String sku, String itemType, int price, String requestId) {
        jdbc.update("""
                INSERT INTO public.echo_life_owned (instance_id, user_id, store_id, sku, item_type, price, request_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)""", instanceId, userId, storeId, sku, itemType, price, requestId);
    }

    /** Owner of an instance id (any learner), for the 403 / 404 distinction. */
    public Optional<Long> ownerOf(String instanceId) {
        return jdbc.query("SELECT user_id FROM public.echo_life_owned WHERE instance_id = ? AND status = 'OWNED'",
                (rs, n) -> rs.getLong(1), instanceId).stream().findFirst();
    }

    public boolean sell(long userId, String instanceId, int refund) {
        return jdbc.update("""
                UPDATE public.echo_life_owned SET status = 'SOLD', refund = ?, sold_at = now()
                WHERE instance_id = ? AND user_id = ? AND status = 'OWNED'""", refund, instanceId, userId) == 1;
    }

    private <T> List<T> parseList(String raw, TypeReference<List<T>> type) {
        if (raw == null || raw.isBlank() || "[]".equals(raw)) return new ArrayList<>();
        try {
            return new ArrayList<>(json.readValue(raw, type));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("echo_life aggregate is not a JSON array", e);
        }
    }

    private Map<String, Integer> skills(String raw) {
        try {
            return raw == null ? new HashMap<>() : new HashMap<>(json.readValue(raw, new TypeReference<Map<String, Integer>>() {
            }));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("echo_life_games.skills is not a skill map", e);
        }
    }

    private JsonNode parse(String raw) {
        try {
            return json.readTree(raw);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("echo_life_games.doc is not JSON", e);
        }
    }

    private String text(JsonNode node) {
        try {
            return json.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
