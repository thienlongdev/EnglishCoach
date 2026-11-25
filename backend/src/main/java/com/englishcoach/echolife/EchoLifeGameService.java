package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeEconomy.Item;
import com.englishcoach.echolife.EchoLifeEconomy.Reward;
import com.englishcoach.echolife.EchoLifeGameDtos.*;
import com.englishcoach.echolife.EchoLifeGameRepository.Row;
import com.englishcoach.echolife.EchoLifeGameRepository.Snapshot;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Echo Life — the learner's game (V130): the narrative save and the AUTHORITATIVE economy.
 *
 * <p>The story, the residents' relationships and memory, the tutorial and exploration are the vendored V3 game document the
 * learner's client keeps ({@code doc}); the server bounds it, binds it to the learner (the V3 owner must be {@code u<id>})
 * and refuses any owned object the learner did not get from the starter set or buy here (403). The economy never comes from
 * that document: credits and skill XP change only by
 * <ul>
 *   <li>unique rewards — a mission, side arc, story-choice option, landmark or keepsake — granted from the server's own table
 *       ({@link EchoLifeEconomy}, generated from V3's rules) once per learner (primary key), missions only after their
 *       prerequisites;</li>
 *   <li>repeatable earnings (shifts, minigames, events, deliveries) — what a report adds beyond its unique rewards — capped
 *       per report and per Asia/Ho_Chi_Minh day, as V3's own anti-exploit guard;</li>
 *   <li>purchases and sales at catalogue prices (skill discount from the server's XP), with server-made instance ids and an
 *       idempotent request id.</li>
 * </ul>
 * No AI, no real money, no premium currency. Every statement is scoped to the principal.
 */
@Service
public class EchoLifeGameService {

    static final int SAVE_VERSION = 1;
    static final int MAX_DOC_BYTES = 480 * 1024;
    static final int MAX_LIFE_META_BYTES = 32 * 1024;
    static final int MAX_PLACES = 40, MAX_OWNED_IN_DOC = 240;
    private static final int MAX_DONE_ENTRIES = 256;
    private static final int MAX_ATTENDED_EVENTS = 512;
    private static final int MAX_SPEND_ITEMS = 50;
    private static final int MAX_BISTRO_ITEMS = 8;
    private static final int MAX_LIFE_META_DEPTH = 6;
    private static final int MAX_LIFE_META_NODES = 1500;
    private static final long MAX_CLOCK_MINUTE = 525_600_000L;
    private static final int MAX_SALE_ITEMS_PER_SERVER_HOUR = 20;
    private static final long SALE_COOLDOWN_WINDOW_MS = 3_600_000L;
    private static final int MAX_TRACKED_SALE_USERS = 4096;
    static final ZoneId DAY_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final Pattern SERVER_ID = Pattern.compile("^ec_[0-9a-f]{20}$");
    private static final Pattern PLACE_KEY = Pattern.compile("^[a-z]{2,16}$");
    private static final Set<String> TOP = Set.of("v", "save", "places");
    private static final Set<String> LIFE_META_KEYS = Set.of(
            "v", "buffs", "tiers", "lastComfort",
            "traits", "desiredLife", "urges", "needs", "emotions", "subSkills",
            "karma", "phoneMessages", "schedule", "cityConfig", "starterFurniture",
            "districtRep", "moodlets", "values", "favorites", "updatedAt");
    private static final Set<String> FORBIDDEN_META_KEYS = Set.of(
            "credits", "cash", "wallet", "ownedObjects", "claimed", "owner", "userId",
            "skills", "xp", "totalXp", "playerLevel", "prototype", "constructor", "__proto__");
    private static final Set<String> STARTER_IDS = Set.of("obj_starter_sofa","obj_starter_stove","obj_starter_fridge","obj_starter_bed","obj_starter_wardrobe","obj_starter_bike");
    private static final SecureRandom RANDOM = new SecureRandom();
    private final java.util.concurrent.ConcurrentHashMap<Long, long[]> saleQuotaByUser = new java.util.concurrent.ConcurrentHashMap<>();

    private final EchoLifeGameRepository games;
    private final EchoLifeEconomy economy;
    private final ObjectMapper json;
    public record EventWindow(String id,String zone,String title,long durationMs) {}

    /**
     * Deliberately non-transactional: performs the single DB read and releases the PostgreSQL connection
     * BEFORE borrowing a GraalJS context from {@link EchoLifeWorkshop}.
     */
    public Optional<EventWindow> attendedEvent(long learner,String eventId) {
        if(eventId==null || !eventId.matches("evt_[a-z0-9_]{1,60}"))return Optional.empty();
        var row=games.find(learner).orElse(null);
        if(row==null || row.doc()==null || !row.doc().path("save").isTextual())return Optional.empty();
        try {
            var parsed=json.readTree(row.doc().get("save").textValue());
            if(!(parsed instanceof com.fasterxml.jackson.databind.node.ObjectNode saved)
                    || !owner(learner).equals(saved.path("owner").asText())
                    || !saved.path("clock").isNumber()
                    || !Double.isFinite(saved.path("clock").asDouble())
                    || saved.path("clock").asLong() < 0
                    || saved.path("clock").asLong() > MAX_CLOCK_MINUTE) {
                return Optional.empty();
            }
            // Validate/sanitize save.done (must be an array of strings when present) before entering GraalJS.
            JsonNode doneNode = saved.get("done");
            var cleanDone = json.createArrayNode();
            if (doneNode != null && !doneNode.isNull()) {
                if (!doneNode.isArray() || doneNode.size() > MAX_DONE_ENTRIES) {
                    return Optional.empty();
                }
                for (JsonNode entry : doneNode) {
                    if (entry == null || !entry.isTextual()) {
                        return Optional.empty();
                    }
                    cleanDone.add(entry.asText());
                }
            }
            saved.set("done", cleanDone);

            JsonNode worldV3 = saved.get("worldV3");
            if (!(worldV3 instanceof com.fasterxml.jackson.databind.node.ObjectNode worldObj)) {
                return Optional.empty();
            }
            JsonNode attendedNode = worldObj.get("eventsAttended");
            if (attendedNode == null || !attendedNode.isArray() || attendedNode.size() > MAX_ATTENDED_EVENTS) {
                return Optional.empty();
            }
            var cleanAttended = json.createArrayNode();
            for (JsonNode item : attendedNode) {
                if (item != null && item.isTextual()) {
                    cleanAttended.add(item.asText());
                }
            }
            worldObj.set("eventsAttended", cleanAttended);

            var input=json.createObjectNode().put("eventId",eventId);
            input.set("save",saved);
            var result=EchoLifeWorkshop.attendedEvent(json,input);
            return result == null || result.isNull()?Optional.empty():Optional.of(json.treeToValue(result,EventWindow.class));
        } catch(JsonProcessingException e) {
            return Optional.empty();
        }
    }

    public EchoLifeGameService(EchoLifeGameRepository games, EchoLifeEconomy economy, ObjectMapper json) {
        this.games = games;
        this.economy = economy;
        this.json = json;
    }

    static String owner(long userId) {
        return "u" + userId;
    }

    // ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public Game get(long userId) {
        Snapshot snap = games.loadSnapshot(userId);
        if (snap.row() == null) return new Game(SAVE_VERSION, 0, null, fresh(), null);
        return game(snap.row(), snap.claimed(), snap.owned(), today());
    }

    private Game game(Row r, List<String> claimed, List<Owned> owned, LocalDate today) {
        return new Game(SAVE_VERSION, r.doc() == null ? 0 : r.revision(), r.doc(), wallet(r, claimed, owned, today), r.doc() == null ? null : r.updatedAt());
    }

    private Wallet fresh() {
        return new Wallet(economy.startingCredits, allSkills(Map.of()), 1, List.of(), List.of(), 0, 0);
    }

    private Wallet wallet(Row r, List<String> claimed, List<Owned> owned, LocalDate today) {
        boolean same = today.equals(r.earnedDay());
        Map<String, Integer> skills = allSkills(r.skills());
        int total = skills.values().stream().mapToInt(Integer::intValue).sum();
        return new Wallet(r.credits(), skills, EchoLifeEconomy.playerLevel(total), claimed, owned,
                same ? r.earnedCredits() : 0, same ? r.earnedXp() : 0, r.workshop(), r.workshopRevision());
    }

    private Snapshot lockAndEnsure(long userId) {
        games.lockOwner(userId);
        Snapshot snap = games.loadSnapshot(userId);
        if (snap.row() == null) {
            games.ensure(userId, economy.startingCredits);
            snap = games.loadSnapshot(userId);
        }
        return snap;
    }

    private Map<String, Integer> allSkills(Map<String, Integer> stored) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (String s : economy.skills) out.put(s, Math.max(0, stored.getOrDefault(s, 0)));
        return out;
    }

    static LocalDate today() {
        return LocalDate.now(DAY_ZONE);
    }

    // ── Narrative save ──────────────────────────────────────────────────────────────────────────────────────

    /**
     * Replaces the narrative document when {@code revision} matches (0 / null: no document yet). Stale → 409 with the current
     * game; malformed → 400; foreign owner or an object the learner never got → 403.
     */
    @Transactional
    public Game save(long userId, SaveGameRequest request) {
        long base = request.revision() == null ? 0 : request.revision();
        // Fast-fail shape/size/ownership checks before touching database locks.
        JsonNode objects = prevalidateDoc(userId, request.doc());

        // Steady-state path: lock existing row directly (1 RTT), then read claims+owned (1 RTT), then UPDATE RETURNING (1 RTT).
        Row row = games.findForUpdate(userId).orElse(null);
        List<String> claimed;
        List<Owned> owned;
        if (row != null) {
            var co = games.loadClaimsAndOwned(userId);
            claimed = co.claimed();
            owned = co.owned();
        } else {
            Snapshot snap = lockAndEnsure(userId);
            row = snap.row();
            claimed = snap.claimed();
            owned = snap.owned();
        }
        validateOwnedObjects(userId, objects, owned);
        validateMonotonicClock(row.doc(), request.doc());
        LocalDate today = today();
        long current = row.doc() == null ? 0 : row.revision();
        if (current != base) throw new EchoLifeException(409, "STALE_REVISION", null, game(row, claimed, owned, today));
        var saved = games.writeDocReturning(userId, SAVE_VERSION, request.doc(), row.revision());
        if (saved.isEmpty()) {
            Snapshot freshSnap = games.loadSnapshot(userId);
            throw new EchoLifeException(409, "STALE_REVISION", null, game(freshSnap.row(), freshSnap.claimed(), freshSnap.owned(), today));
        }
        Row updated = new Row(SAVE_VERSION, saved.get().revision(), request.doc(), row.credits(), row.skills(),
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), saved.get().updatedAt(), row.workshop(), row.workshopRevision());
        return game(updated, claimed, owned, today);
    }

    void validate(long userId, JsonNode doc) {
        JsonNode objects = prevalidateDoc(userId, doc);
        validateOwnedObjects(userId, objects, games.owned(userId));
    }

    private JsonNode prevalidateDoc(long userId, JsonNode doc) {
        if (doc == null || !doc.isObject()) throw invalid();
        if (doc.toString().getBytes(StandardCharsets.UTF_8).length > MAX_DOC_BYTES) throw new EchoLifeException(413, "GAME_TOO_LARGE");
        doc.fieldNames().forEachRemaining(k -> { if (!TOP.contains(k)) throw invalid(); });
        if (!doc.path("v").isInt() || doc.get("v").asInt() != SAVE_VERSION) throw invalid();
        if (!doc.path("save").isTextual()) throw invalid();
        JsonNode places = doc.path("places");
        if (!places.isObject() || places.size() > MAX_PLACES) throw invalid();
        places.fields().forEachRemaining(e -> {
            JsonNode p = e.getValue();
            if (!PLACE_KEY.matcher(e.getKey()).matches() || !p.isObject() || p.size() != 2) throw invalid();
            for (String k : List.of("x", "z")) {
                if (!p.path(k).isNumber() || !Double.isFinite(p.get(k).asDouble()) || Math.abs(p.get(k).asDouble()) > EchoLifeService.MAX_XZ) throw invalid();
            }
        });
        JsonNode save;
        try {
            save = json.readTree(doc.get("save").asText());
        } catch (JsonProcessingException e) {
            throw invalid();
        }
        if (save == null || !save.isObject() || save.path("version").asInt() != 4) throw invalid();
        // V3's own rule, bound to the server principal: the document belongs to this learner and to nobody else.
        if (!owner(userId).equals(save.path("owner").asText())) throw new EchoLifeException(403, "OWNERSHIP_VIOLATION");
        JsonNode doneNode = save.get("done");
        if (doneNode != null && !doneNode.isNull()) {
            if (!doneNode.isArray() || doneNode.size() > MAX_DONE_ENTRIES) throw invalid();
            for (JsonNode entry : doneNode) {
                if (entry == null || !entry.isTextual()) throw invalid();
            }
        }
        JsonNode clockNode = save.get("clock");
        if (clockNode != null && !clockNode.isNull()) {
            if (!clockNode.isNumber() || !Double.isFinite(clockNode.asDouble())
                    || clockNode.asLong() < 0 || clockNode.asLong() > MAX_CLOCK_MINUTE) {
                throw invalid();
            }
        }
        JsonNode objects = save.path("progression").path("ownedObjects");
        if (!objects.isMissingNode() && (!objects.isArray() || objects.size() > MAX_OWNED_IN_DOC)) throw invalid();
        JsonNode worldV3 = save.get("worldV3");
        if (worldV3 != null && !worldV3.isNull()) {
            if (!worldV3.isObject()) throw invalid();
            JsonNode lifeMeta = worldV3.get("lifeMeta");
            if (lifeMeta != null && !lifeMeta.isNull()) {
                validateLifeMeta(lifeMeta);
            }
            JsonNode npcSim = worldV3.get("npcSim");
            if (npcSim != null && !npcSim.isNull()) {
                validateNpcSimRep(npcSim);
            }
        }
        return objects;
    }

    /**
     * Validates {@code save.worldV3.lifeMeta} (<= 32 KB): allows Wave 11 lifestyle/personality metadata
     * (traits, desiredLife, urges, 8 needs, 12 emotions, subSkills, karma, phoneMessages, schedule, cityConfig,
     * starterFurniture, buffs, tiers, districtRep) while forbidding unknown keys, script/URI injection, and any
     * attempt to smuggle credits/XP/ownedObjects. Economy authority ALWAYS remains exclusively in the ledger tables.
     */
    private void validateLifeMeta(JsonNode lifeMeta) {
        if (!lifeMeta.isObject()) throw invalid();
        if (lifeMeta.toString().getBytes(StandardCharsets.UTF_8).length > MAX_LIFE_META_BYTES) throw invalid();
        int[] nodes = {0};
        lifeMeta.fields().forEachRemaining(e -> {
            String key = e.getKey();
            JsonNode value = e.getValue();
            if (!LIFE_META_KEYS.contains(key) || FORBIDDEN_META_KEYS.contains(key)) throw invalid();
            switch (key) {
                case "v" -> {
                    if (!value.isInt() || value.asInt() < 1 || value.asInt() > 2) throw invalid();
                }
                case "lastComfort" -> {
                    if (!value.isNumber() || !Double.isFinite(value.asDouble())
                            || value.asDouble() < 0 || value.asDouble() > 100) throw invalid();
                }
                case "updatedAt" -> {
                    if (!value.isNumber() || !Double.isFinite(value.asDouble())
                            || value.asDouble() < 0 || value.asDouble() > EchoLifeService.MAX_AT) throw invalid();
                }
                case "districtRep" -> validateDistrictRepMap(value);
                case "karma" -> {
                    if (value.isNumber()) {
                        if (!Double.isFinite(value.asDouble()) || value.asDouble() < -1000 || value.asDouble() > 1000) {
                            throw invalid();
                        }
                    } else if (value.isObject()) {
                        validateMetaValue(value, 1, nodes);
                    } else {
                        throw invalid();
                    }
                }
                default -> validateMetaValue(value, 1, nodes);
            }
        });
    }

    private void validateNpcSimRep(JsonNode npcSim) {
        if (!npcSim.isObject()) throw invalid();
        JsonNode rep = npcSim.get("rep");
        if (rep != null && !rep.isNull()) {
            validateDistrictRepMap(rep);
        }
    }

    private void validateDistrictRepMap(JsonNode rep) {
        if (!rep.isObject() || rep.size() > EchoLifeEconomy.DISTRICTS.size()) throw invalid();
        rep.fields().forEachRemaining(e -> {
            if (!EchoLifeEconomy.DISTRICTS.contains(e.getKey())) throw invalid();
            JsonNode v = e.getValue();
            if (!v.isNumber() || !Double.isFinite(v.asDouble()) || v.asDouble() < 0 || v.asDouble() > 100) {
                throw invalid();
            }
        });
    }

    private void validateMetaValue(JsonNode node, int depth, int[] nodes) {
        if (depth > MAX_LIFE_META_DEPTH || ++nodes[0] > MAX_LIFE_META_NODES) throw invalid();
        if (node == null || node.isNull() || node.isBoolean()) return;
        if (node.isNumber()) {
            if (!Double.isFinite(node.asDouble())) throw invalid();
            return;
        }
        if (node.isTextual()) {
            String s = node.asText();
            if (s.length() > 512) throw invalid();
            String lower = s.toLowerCase(Locale.ROOT);
            if (lower.contains("<script") || lower.contains("javascript:") || lower.contains("data:")) throw invalid();
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c < 0x20 && c != '\n' && c != '\r' && c != '\t') throw invalid();
            }
            return;
        }
        if (node.isArray()) {
            if (node.size() > 128) throw invalid();
            for (JsonNode child : node) validateMetaValue(child, depth + 1, nodes);
            return;
        }
        if (node.isObject()) {
            if (node.size() > 64) throw invalid();
            node.fields().forEachRemaining(e -> {
                String k = e.getKey();
                if (k == null || k.isEmpty() || k.length() > 64 || FORBIDDEN_META_KEYS.contains(k)) throw invalid();
                validateMetaValue(e.getValue(), depth + 1, nodes);
            });
            return;
        }
        throw invalid();
    }

    private void validateMonotonicClock(JsonNode previousDoc, JsonNode nextDoc) {
        Long prevClock = extractClock(previousDoc);
        Long nextClock = extractClock(nextDoc);
        if (prevClock != null && nextClock != null && nextClock < prevClock) {
            throw invalid();
        }
    }

    private Long extractClock(JsonNode doc) {
        if (doc == null || !doc.path("save").isTextual()) return null;
        try {
            JsonNode clock = json.readTree(doc.get("save").asText()).get("clock");
            if (clock == null || !clock.isNumber() || !Double.isFinite(clock.asDouble())) return null;
            return clock.asLong();
        } catch (JsonProcessingException ex) {
            return null;
        }
    }

    private boolean consumeMarketSaleQuota(long userId, int itemCount) {
        if (itemCount <= 0) return true;
        long now = System.currentTimeMillis();
        if (saleQuotaByUser.size() > MAX_TRACKED_SALE_USERS) {
            saleQuotaByUser.entrySet().removeIf(e -> now - e.getValue()[0] > SALE_COOLDOWN_WINDOW_MS);
        }
        boolean[] allowed = { false };
        saleQuotaByUser.compute(userId, (uid, state) -> {
            long start = (state == null || now - state[0] >= SALE_COOLDOWN_WINDOW_MS) ? now : state[0];
            long used = (state == null || now - state[0] >= SALE_COOLDOWN_WINDOW_MS) ? 0L : state[1];
            if (used + itemCount > MAX_SALE_ITEMS_PER_SERVER_HOUR) {
                return new long[] { start, used };
            }
            allowed[0] = true;
            return new long[] { start, used + itemCount };
        });
        return allowed[0];
    }

    private void validateOwnedObjects(long userId, JsonNode objects, List<Owned> ownedList) {
        if (objects == null || objects.isMissingNode()) return;
        Set<String> bought = null;
        for (JsonNode o : objects) {
            String id = o.path("instanceId").asText("");
            if (!owner(userId).equals(o.path("ownerAccountId").asText())) throw new EchoLifeException(403, "OWNERSHIP_VIOLATION");
            if (STARTER_IDS.contains(id)) continue;
            if (bought == null) {
                bought = new HashSet<>(ownedList.size() * 2 + 1);
                for (Owned item : ownedList) bought.add(item.instanceId());
            }
            if (!(SERVER_ID.matcher(id).matches() && bought.contains(id))) throw new EchoLifeException(403, "OWNERSHIP_VIOLATION");
        }
    }

    // ── Rewards ─────────────────────────────────────────────────────────────────────────────────────────────

    @Transactional
    public ClaimResult claim(long userId, ClaimRequest request) {
        Snapshot snap = lockAndEnsure(userId);
        Row row = snap.row();
        List<String> claimedList = new ArrayList<>(snap.claimed());
        List<Owned> ownedList = snap.owned();
        LocalDate today = today();
        // Capture persisted doc & business skill BEFORE checkout overwrites row.doc() so a checkout request
        // can never self-grant a standing discount inside the same unpersisted payload.
        JsonNode persistedDoc = row.doc();
        int preBusinessLevel = economy.skillLevel(allSkills(row.skills()).getOrDefault("business", 0));
        boolean checkout = request.checkout() != null;
        if (checkout) {
            Row savedRow = prepareCheckout(userId, row, claimedList, ownedList, request, today, persistedDoc, preBusinessLevel);
            if (savedRow == null) {
                return new ClaimResult(wallet(row, claimedList, ownedList, today), List.of(), Map.of(), 0, 0, row.revision());
            }
            row = savedRow;
        }
        boolean same = today.equals(row.earnedDay());
        int earnedCredits = same ? row.earnedCredits() : 0, earnedXp = same ? row.earnedXp() : 0;
        int credits = row.credits();
        Map<String, Integer> skills = allSkills(row.skills());
        Set<String> claimed = new HashSet<>(claimedList);
        List<String> granted = new ArrayList<>();
        Map<String, String> refused = new LinkedHashMap<>();
        int addEarned = 0, addSpent = 0, activityCredits = 0, activityXp = 0;

        boolean sale = marketSale(row.doc());
        for (ClaimBatch b : request.batches()) {
            if (!checkout && b.requestId() != null && !games.remember(userId, "reward:" + b.requestId(), json.valueToTree(b))) continue;
            int uniqueCredits = 0;
            Map<String, Integer> uniqueXp = new HashMap<>();
            for (String key : Optional.ofNullable(b.uniques()).orElse(List.of())) {
                Reward reward = economy.uniques.get(key);
                if (reward == null) { refused.put(key, "UNKNOWN"); continue; }
                // What V3 granted for it is accounted to the unique reward whether or not it is new (never a repeatable earning).
                uniqueCredits += reward.credits();
                reward.xp().forEach((k, v) -> uniqueXp.merge(k, v, Integer::sum));
                if (claimed.contains(key)) { refused.put(key, "ALREADY_CLAIMED"); continue; }
                if (key.startsWith("choice:")) {
                    String prefix = key.substring(0, key.lastIndexOf(':') + 1);
                    if (claimed.stream().anyMatch(existing -> existing.startsWith(prefix))) {
                        refused.put(key, "CHOICE_ALREADY_MADE");
                        continue;
                    }
                }
                if (key.startsWith("mission:")) {
                    List<String> req = economy.missionRequires.getOrDefault(key.substring(8), List.of());
                    if (!req.stream().allMatch(r -> claimed.contains("mission:" + r))) { refused.put(key, "PREREQUISITE"); continue; }
                }
                if (!games.claim(userId, key, reward.credits(), reward.xpTotal())) { refused.put(key, "ALREADY_CLAIMED"); continue; }
                claimed.add(key);
                claimedList.add(key);
                granted.add(key);
                credits = Math.min(economy.maxBalance, credits + reward.credits());
                addEarned += reward.credits();
                reward.xp().forEach((k, v) -> { if (skills.containsKey(k)) skills.merge(k, v, Integer::sum); });
            }
            // Older clients can still redeem catalogue rewards by their unique keys. A repeatable
            // earning or debit needs an operation ID to distinguish a new action from a retry.
            if (b.requestId() == null) {
                boolean extraXp = Optional.ofNullable(b.xp()).orElse(Map.of()).entrySet().stream()
                        .anyMatch(e -> e.getValue() != null && e.getValue() > uniqueXp.getOrDefault(e.getKey(), 0));
                if (b.credits() > uniqueCredits || extraXp || (b.spent() != null && !b.spent().isEmpty())) {
                    refused.put("activity:" + b.source(), "REQUEST_ID_REQUIRED");
                }
                continue;
            }
            // The rest of the report is a repeatable earning: bounded per report and per day.
            int extraCredits = Math.max(0, Math.max(0, b.credits()) - uniqueCredits);
            int grantCredits = Math.min(Math.min(extraCredits, economy.reportActivityCredits), Math.max(0, economy.dailyActivityCredits - earnedCredits));
            if (grantCredits > 0) {
                credits = Math.min(economy.maxBalance, credits + grantCredits);
                earnedCredits += grantCredits; addEarned += grantCredits; activityCredits += grantCredits;
            }
            int xpRoom = Math.min(economy.reportActivityXp, Math.max(0, economy.dailyActivityXp - earnedXp));
            for (Map.Entry<String, Integer> e : Optional.ofNullable(b.xp()).orElse(Map.of()).entrySet()) {
                if (!skills.containsKey(e.getKey()) || e.getValue() == null) continue;
                int extra = Math.max(0, Math.max(0, e.getValue()) - uniqueXp.getOrDefault(e.getKey(), 0));
                int give = Math.min(extra, xpRoom);
                if (give <= 0) continue;
                skills.merge(e.getKey(), give, Integer::sum);
                xpRoom -= give; earnedXp += give; activityXp += give;
            }
            for (Spend sp : Optional.ofNullable(b.spent()).orElse(List.of())) {
                double standingRate = spendStandingDiscount(persistedDoc, preBusinessLevel, sp.kind(), sale);
                int price = marketPrice(sp, sale, standingRate);
                if (price < 0) { refused.put("spend:" + b.source(), "UNKNOWN_PRODUCT"); continue; }
                if (!checkout && "market".equals(sp.kind()) && sale && !consumeMarketSaleQuota(userId, Optional.ofNullable(sp.items()).map(List::size).orElse(0))) {
                    refused.put("spend:" + b.source(), "SALE_COOLDOWN");
                    continue;
                }
                if (price > credits) { refused.put("spend:" + b.source(), "INSUFFICIENT_CREDITS"); continue; }
                credits -= price; addSpent += price;
            }
        }
        JsonNode workshop = row.workshop();
        long workshopRevision = row.workshopRevision();
        if (granted.stream().anyMatch(key -> key.startsWith("side:"))) {
            Row updatedRow = new Row(row.saveVersion(), row.revision(), row.doc(), credits, skills, today, earnedCredits, earnedXp, row.updatedAt(), workshop, workshopRevision);
            var projected = runWorkshopProjection(userId, updatedRow, ownedList, claimedList, null);
            if (projected.path("ok").asBoolean()) {
                workshop = projected.path("progression");
                if (workshop.toString().length() > MAX_DOC_BYTES) throw new EchoLifeException(413, "WORKSHOP_TOO_LARGE");
                workshopRevision = games.writeWorkshopAndEconomy(userId, workshop, credits, skills, today, earnedCredits, earnedXp, addEarned, addSpent);
            } else {
                games.writeEconomy(userId, credits, skills, today, earnedCredits, earnedXp, addEarned, addSpent);
            }
        } else {
            games.writeEconomy(userId, credits, skills, today, earnedCredits, earnedXp, addEarned, addSpent);
        }
        Row after = new Row(row.saveVersion(), row.revision(), row.doc(), credits, skills, today, earnedCredits, earnedXp, row.updatedAt(), workshop, workshopRevision);
        return new ClaimResult(wallet(after, claimedList, ownedList, today), granted, refused, activityCredits, activityXp,
                checkout ? after.revision() : null);
    }

    /** Commit the checked-out inventory, narrative rewards and debit under one learner lock. Returns updated Row or null on idempotent replay. */
    private Row prepareCheckout(long userId, Row row, List<String> claimedList, List<Owned> ownedList, ClaimRequest request,
                                LocalDate today, JsonNode persistedDoc, int businessLevel) {
        if (request.batches().size() != 1) throw invalid();
        var batch = request.batches().getFirst();
        if (batch.requestId() == null || !"checkout".equals(batch.source()) ||
                batch.spent() == null || batch.spent().size() != 1) throw invalid();
        var snapshot = request.checkout();
        var receipt = json.createObjectNode();
        receipt.set("batch", json.valueToTree(batch));
        receipt.put("revision", snapshot.revision());
        if (!games.remember(userId, "reward:" + batch.requestId(), receipt)) {
            if (!snapshot.doc().equals(row.doc())) throw new EchoLifeException(409, "STALE_REVISION", null, game(row, claimedList, ownedList, today));
            return null;
        }
        var spend = batch.spent().getFirst();
        if (spend == null || !Set.of("market", "bistro").contains(spend.kind())) throw invalid();
        // Validate & write narrative doc directly under existing owner lock (no extra SELECTs).
        JsonNode objects = prevalidateDoc(userId, snapshot.doc());
        validateOwnedObjects(userId, objects, ownedList);
        validateMonotonicClock(row.doc(), snapshot.doc());
        long base = snapshot.revision() == null ? 0 : snapshot.revision();
        long current = row.doc() == null ? 0 : row.revision();
        if (current != base) throw new EchoLifeException(409, "STALE_REVISION", null, game(row, claimedList, ownedList, today));

        // Validate sale price, credits, and hourly sale quota BEFORE writing the updated inventory document.
        boolean sale = marketSale(snapshot.doc());
        double standingRate = spendStandingDiscount(persistedDoc, businessLevel, spend.kind(), sale);
        int price = marketPrice(spend, sale, standingRate);
        if (price <= 0 || spend.sale() != ("market".equals(spend.kind()) && sale)) throw invalid();
        if (price > row.credits()) throw new EchoLifeException(409, "INSUFFICIENT_CREDITS", null, game(row, claimedList, ownedList, today));
        if ("market".equals(spend.kind()) && sale && !consumeMarketSaleQuota(userId, Optional.ofNullable(spend.items()).map(List::size).orElse(0))) {
            throw new EchoLifeException(429, "SALE_COOLDOWN", null, game(row, claimedList, ownedList, today));
        }

        var saved = games.writeDocReturning(userId, SAVE_VERSION, snapshot.doc(), row.revision());
        if (saved.isEmpty()) throw new EchoLifeException(409, "STALE_REVISION", null, game(row, claimedList, ownedList, today));
        return new Row(SAVE_VERSION, saved.get().revision(), snapshot.doc(), row.credits(), row.skills(),
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), saved.get().updatedAt(), row.workshop(), row.workshopRevision());
    }

    private int marketPrice(Spend spend, boolean sale, double standingDiscountRate) {
        List<String> items = Optional.ofNullable(spend.items()).orElse(List.of());
        if (items.isEmpty() || items.size() > MAX_SPEND_ITEMS) return -1;
        double safeStanding = Double.isFinite(standingDiscountRate)
                ? Math.max(0.0, Math.min(EchoLifeEconomy.MAX_STANDING_DISCOUNT, standingDiscountRate))
                : 0.0;
        if ("bistro".equals(spend.kind())) {
            if (items.size() > MAX_BISTRO_ITEMS) return -1;
            int total = 0;
            for (String item : items) {
                Integer price = economy.bistroMenu.get(item);
                if (price == null) return -1;
                total += price;
            }
            return safeStanding > 0 ? Math.max(1, (int) Math.round(total * (1.0 - safeStanding))) : total;
        }
        if (!"market".equals(spend.kind())) return -1;
        int total = 0;
        for (String item : items) {
            Integer price = economy.products.get(item);
            if (price == null) return -1;
            total += sale ? Math.max(1, (int) Math.round(price * economy.marketSaleFactor)) : price;
        }
        if (!sale && safeStanding > 0) {
            total = Math.max(1, (int) Math.round(total * (1.0 - safeStanding)));
        }
        return total;
    }

    private double spendStandingDiscount(JsonNode persistedDoc, int businessLevel, String kind, boolean sale) {
        if ("bistro".equals(kind)) {
            double fromDoc = districtStandingDiscount(persistedDoc, "bistro");
            double fromBusiness = economy.standingFromBusiness(businessLevel);
            return Math.min(EchoLifeEconomy.MAX_STANDING_DISCOUNT, Math.max(fromDoc, fromBusiness));
        }
        if ("market".equals(kind) && !sale) {
            return districtStandingDiscount(persistedDoc, "market");
        }
        return 0.0;
    }

    private double districtStandingDiscount(JsonNode persistedDoc, String storeOrZone) {
        if (persistedDoc == null || !persistedDoc.path("save").isTextual()) return 0.0;
        try {
            JsonNode worldV3 = json.readTree(persistedDoc.path("save").asText()).path("worldV3");
            if (!worldV3.isObject()) return 0.0;
            String district = EchoLifeEconomy.resolveDistrict(storeOrZone);
            int bestScore = 0;
            JsonNode npcRep = worldV3.path("npcSim").path("rep").path(district);
            if (npcRep.isNumber() && Double.isFinite(npcRep.asDouble())) {
                bestScore = Math.max(bestScore, (int) Math.round(Math.max(0.0, Math.min(100.0, npcRep.asDouble()))));
            }
            JsonNode metaRep = worldV3.path("lifeMeta").path("districtRep").path(district);
            if (metaRep.isNumber() && Double.isFinite(metaRep.asDouble())) {
                bestScore = Math.max(bestScore, (int) Math.round(Math.max(0.0, Math.min(100.0, metaRep.asDouble()))));
            }
            return economy.standingDiscountFor(bestScore);
        } catch (JsonProcessingException ex) {
            return 0.0;
        }
    }

    private boolean marketSale(JsonNode doc) {
        if (doc == null || !doc.path("save").isTextual()) return false;
        try {
            JsonNode clockNode = json.readTree(doc.path("save").asText()).path("clock");
            if (!clockNode.isNumber() || !Double.isFinite(clockNode.asDouble())) return false;
            long minute = clockNode.asLong();
            if (minute < 0 || minute > MAX_CLOCK_MINUTE) return false;
            int weekday = (int) ((minute / 1440) % 7);
            int hour = (int) ((minute % 1440) / 60);
            return economy.saleDays.contains(weekday) && hour >= economy.saleStart && hour < economy.saleEnd;
        } catch (JsonProcessingException ex) {
            return false;
        }
    }

    // ── Purchases ───────────────────────────────────────────────────────────────────────────────────────────

    @Transactional
    public PurchaseResult purchase(long userId, PurchaseRequest request) {
        Snapshot snap = lockAndEnsure(userId);
        Row row = snap.row();
        List<String> claimedList = snap.claimed();
        List<Owned> ownedList = new ArrayList<>(snap.owned());
        LocalDate today = today();
        var repeat = games.byRequest(userId, request.requestId());
        if (repeat.isPresent()) {
            Owned o = repeat.get();
            if (!o.storeId().equals(request.storeId()) || !o.sku().equals(request.sku())) throw new EchoLifeException(409,"REQUEST_ID_REUSED");
            return new PurchaseResult(wallet(row, claimedList, ownedList, today), o.instanceId(), o.price(), o.itemType());
        }
        Item item = economy.item(request.storeId(), request.sku()).orElseThrow(() -> new EchoLifeException(404, "UNKNOWN_ITEM"));
        Map<String, Integer> skills = allSkills(row.skills());
        int total = skills.values().stream().mapToInt(Integer::intValue).sum();
        if (EchoLifeEconomy.playerLevel(total) < item.reqLevel()) throw new EchoLifeException(409, "REQUIREMENTS_NOT_MET");
        for (Map.Entry<String, Integer> req : item.reqSkill().entrySet()) {
            if (economy.skillLevel(skills.getOrDefault(req.getKey(), 0)) < req.getValue()) throw new EchoLifeException(409, "REQUIREMENTS_NOT_MET");
        }
        int businessLevel = economy.skillLevel(skills.getOrDefault("business", 0));
        double standingRate = districtStandingDiscount(row.doc(), request.storeId());
        double rate = economy.combinedShopDiscount(businessLevel, standingRate);
        int price = Math.max(1, (int) Math.round(item.price() * (1 - rate)));
        if (price > row.credits()) throw new EchoLifeException(409, "INSUFFICIENT_CREDITS");
        String id = newInstanceId();
        games.buy(userId, id, item.storeId(), item.sku(), item.itemType(), price, request.requestId());
        ownedList.add(new Owned(id, item.storeId(), item.sku(), item.itemType(), price));
        int nextCredits = row.credits() - price;
        Row updatedRow = new Row(row.saveVersion(), row.revision(), row.doc(), nextCredits, skills,
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), row.updatedAt(), row.workshop(), row.workshopRevision());
        var reply = runWorkshopProjection(userId, updatedRow, ownedList, claimedList, null);
        JsonNode workshop = row.workshop();
        long workshopRevision = row.workshopRevision();
        if (reply.path("ok").asBoolean()) {
            workshop = reply.path("progression");
            if (workshop.toString().length() > MAX_DOC_BYTES) throw new EchoLifeException(413, "WORKSHOP_TOO_LARGE");
            workshopRevision = games.writeWorkshopAndEconomy(userId, workshop, nextCredits, skills, row.earnedDay(), row.earnedCredits(), row.earnedXp(), 0, price);
        } else {
            games.writeEconomy(userId, nextCredits, skills, row.earnedDay(), row.earnedCredits(), row.earnedXp(), 0, price);
        }
        Row after = new Row(row.saveVersion(), row.revision(), row.doc(), nextCredits, skills,
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), row.updatedAt(), workshop, workshopRevision);
        return new PurchaseResult(wallet(after, claimedList, ownedList, today), id, price, item.itemType());
    }

    @Transactional
    public SaleResult sell(long userId, SaleRequest request) {
        games.lockOwner(userId);
        Long owner = games.ownerOf(request.instanceId()).orElseThrow(() -> new EchoLifeException(404, "NOT_FOUND"));
        if (owner != userId) throw new EchoLifeException(403, "OWNERSHIP_VIOLATION");
        Snapshot snap = games.loadSnapshot(userId);
        Row row = snap.row();
        List<String> claimedList = snap.claimed();
        List<Owned> ownedList = new ArrayList<>(snap.owned());
        Owned o = ownedList.stream().filter(x -> x.instanceId().equals(request.instanceId())).findFirst()
                .orElseThrow(() -> new EchoLifeException(404, "NOT_FOUND"));
        if (!Set.of("vehicle","owned_object").contains(o.itemType())) throw new EchoLifeException(409,"ITEM_NOT_RESELLABLE");
        int base = economy.item(o.storeId(), o.sku()).map(Item::price).orElse(o.price());
        int refund = Math.max(1, (int) Math.floor(base * economy.resaleRatio));
        if (!games.sell(userId, o.instanceId(), refund)) throw new EchoLifeException(404, "NOT_FOUND");
        ownedList.removeIf(x -> x.instanceId().equals(o.instanceId()));
        Map<String, Integer> skills = allSkills(row.skills());
        int nextCredits = Math.min(economy.maxBalance, row.credits() + refund);
        Row updatedRow = new Row(row.saveVersion(), row.revision(), row.doc(), nextCredits, skills,
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), row.updatedAt(), row.workshop(), row.workshopRevision());
        var reply = runWorkshopProjection(userId, updatedRow, ownedList, claimedList, null);
        JsonNode workshop = row.workshop();
        long workshopRevision = row.workshopRevision();
        if (reply.path("ok").asBoolean()) {
            workshop = reply.path("progression");
            if (workshop.toString().length() > MAX_DOC_BYTES) throw new EchoLifeException(413, "WORKSHOP_TOO_LARGE");
            workshopRevision = games.writeWorkshopAndEconomy(userId, workshop, nextCredits, skills, row.earnedDay(), row.earnedCredits(), row.earnedXp(), refund, 0);
        } else {
            games.writeEconomy(userId, nextCredits, skills, row.earnedDay(), row.earnedCredits(), row.earnedXp(), refund, 0);
        }
        Row after = new Row(row.saveVersion(), row.revision(), row.doc(), nextCredits, skills,
                row.earnedDay(), row.earnedCredits(), row.earnedXp(), row.updatedAt(), workshop, workshopRevision);
        return new SaleResult(wallet(after, claimedList, ownedList, today()), refund);
    }

    @Transactional
    public WorkshopResult configure(long uid, WorkshopRequest request) {
        EchoLifeWorkshop.validate(request.action());
        Snapshot snap = lockAndEnsure(uid);
        Row row = snap.row();
        List<String> claimedList = snap.claimed();
        List<Owned> ownedList = snap.owned();
        LocalDate today = today();
        if (!games.remember(uid, "build:" + request.requestId(), request.action()))
            return new WorkshopResult(wallet(row, claimedList, ownedList, today), true, "Already applied.");
        if (row.workshopRevision() != request.revision())
            throw new EchoLifeException(409, "STALE_REVISION", null, game(row, claimedList, ownedList, today));
        var reply = runWorkshopProjection(uid, row, ownedList, claimedList, request.action());
        if (!reply.path("ok").asBoolean()) {
            games.forget(uid, "build:" + request.requestId());
            return new WorkshopResult(wallet(row, claimedList, ownedList, today), false, reply.path("msg").asText());
        }
        JsonNode progression = reply.path("progression");
        if (progression.toString().length() > MAX_DOC_BYTES) throw new EchoLifeException(413, "WORKSHOP_TOO_LARGE");
        Map<String, Integer> skills = new LinkedHashMap<>();
        reply.path("skills").fields().forEachRemaining(e -> skills.put(e.getKey(), e.getValue().intValue()));
        int credits = reply.path("credits").intValue();
        int spent = Math.max(0, row.credits() - credits);
        int earned = Math.max(0, credits - row.credits());
        boolean sameDay = today.equals(row.earnedDay());
        int earnedToday = (sameDay ? row.earnedCredits() : 0) + earned;
        int xpToday = sameDay ? row.earnedXp() : 0;
        long nextWorkshopRev = games.writeWorkshopAndEconomy(uid, progression, credits, skills, today, earnedToday, xpToday, earned, spent);
        Row after = new Row(row.saveVersion(), row.revision(), row.doc(), credits, skills,
                today, earnedToday, xpToday, row.updatedAt(), progression, nextWorkshopRev);
        return new WorkshopResult(wallet(after, claimedList, ownedList, today), true, reply.path("msg").asText());
    }

    private JsonNode runWorkshopProjection(long uid, Row row, List<Owned> ownedList, List<String> claimedList, JsonNode action) {
        var input = json.createObjectNode().put("owner", owner(uid)).put("credits", row.credits());
        input.set("skills", json.valueToTree(allSkills(row.skills())));
        input.set("owned", json.valueToTree(ownedList));
        input.set("claimed", json.valueToTree(claimedList));
        input.set("previous", row.workshop());
        if (action != null && "job_step".equals(action.path("type").asText())) {
            int prior = today().equals(row.earnedDay()) ? row.earnedCredits() : 0;
            input.put("serverNow", System.currentTimeMillis());
            input.put("shiftAllowance", Math.max(0, Math.min(economy.maxBalance - row.credits(), economy.dailyActivityCredits - prior)));
        }
        input.set("action", action);
        return EchoLifeWorkshop.run(json, input);
    }

    static String newInstanceId() {
        byte[] b = new byte[10];
        RANDOM.nextBytes(b);
        StringBuilder sb = new StringBuilder("ec_");
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static EchoLifeException invalid() {
        return new EchoLifeException(400, "INVALID_GAME");
    }
}
