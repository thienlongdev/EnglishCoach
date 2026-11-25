package com.englishcoach.echolife;

import com.englishcoach.common.AvatarLookCode;
import com.englishcoach.echolife.EchoLifeDtos.SaveWorldRequest;
import com.englishcoach.echolife.EchoLifeDtos.World;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Echo Life — the learner's world save (version 1).
 *
 * <pre>
 * { "v": 1,
 *   "places":  { "&lt;spaceId&gt;": { "x", "y"?, "z", "rotY", "region", "at" } },          where the body stands outside that room
 *   "doors":   { "house:&lt;spaceId&gt;:&lt;door&gt;" | "city:&lt;door&gt;": { "open", "angle", "at" } },  doors left open or shut
 *   "objects": { "&lt;spaceId&gt;/&lt;objectId&gt;": { "object": {…study object…}, "region", "at" } } } things set down outside their room
 * </pre>
 *
 * The client authors this document (it is where its own body and hands left things); the server bounds it, checks every
 * number and id, and keeps only the learner's own spaces: a key naming any other space is dropped. The objects are the
 * learner's own study-room objects (the room editor adds catalogue objects freely, so they carry no value); nothing of value
 * (credits, purchases, rewards, owned progression items) is ever read from this document. {@code at} is the client's own
 * clock, used by the client to merge two tabs' changes after a 409.
 */
@Service
public class EchoLifeService {

    static final int SAVE_VERSION = 1;
    /** Application cap safely inside V129's 128 KB (131,072 byte) JSONB CHECK constraint (leaves room for 24 KB avatar + world state). */
    static final int MAX_STATE_BYTES = 96 * 1024;
    static final int MAX_AVATAR_BYTES = 24 * 1024;
    static final int MAX_PLACES = 12, MAX_DOORS = 128, MAX_OBJECTS = 64, MAX_OBJECT_BYTES = 4096;
    static final double MAX_XZ = 800, MAX_Y = 60;
    /** 2100-01-01: an `at` beyond it is not a time. */
    static final double MAX_AT = 4_102_444_800_000d;

    private static final Pattern UUID_TEXT = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern REGION = Pattern.compile("^[A-Za-z0-9:_-]{1,40}$");
    private static final Pattern HOUSE_DOOR = Pattern.compile("^house:([0-9a-f-]{36}):([a-z][a-z0-9_-]{0,23})$");
    private static final Pattern CITY_DOOR = Pattern.compile("^city:[a-z0-9][a-z0-9_-]{0,47}$");
    private static final Pattern OBJECT_KEY = Pattern.compile("^([0-9a-f-]{36})/([A-Za-z0-9_-]{1,40})$");
    private static final Pattern KIND = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$");
    private static final Pattern HEX_COLOR = Pattern.compile("^#[0-9a-fA-F]{6}$");
    private static final Pattern HAIR_ID = Pattern.compile("^[a-z0-9_]{1,32}$");
    private static final Pattern GARMENT_ID = Pattern.compile("^[a-z0-9_-]{1,32}$");
    private static final Pattern SAFE_ID = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
    private static final Pattern OUTFIT_NAME = Pattern.compile("^[A-Za-z0-9 _.,'-]{1,32}$");
    private static final Set<String> TOP = Set.of("v", "places", "doors", "objects", "avatar");
    private static final Set<String> PLACE = Set.of("x", "y", "z", "rotY", "region", "at");
    private static final Set<String> DOOR = Set.of("open", "angle", "at");
    private static final Set<String> OBJECT_ENTRY = Set.of("object", "region", "at","held");
    /** The study-room object fields (lib/study-space/types.ts SpaceObject) a carried object may keep. */
    private static final Set<String> OBJECT_FIELDS = Set.of("id", "kind", "pos", "rotY", "scale", "hidden", "locked", "group", "color",
            "action", "lightOn", "quat", "drawers", "state");

    // ── Character Creator (`avatar`) strict allowlists ──────────────────────────────────────────────────────────
    private static final Set<String> AVATAR_TOP_KEYS = Set.of(
            "version", "hero", "hairId", "hairColor", "hairTipColor", "hairTipMix",
            "skinTone", "irisColor", "lipColor",
            "face", "body", "outfits", "activeOutfit", "autoSeasonalOutfit",
            "identity", "wireCode", "at");
    private static final Set<String> AVATAR_HEROES = Set.of("LYRA", "KAI");
    private static final List<String> FACE_MORPH_ORDER = List.of(
            "jawWidth", "jawHeight", "chinLength", "chinWidth",
            "cheekboneWidth", "cheekboneHeight", "faceLength", "faceWidth",
            "eyeSize", "eyeSpacing", "eyeHeight", "eyeTilt",
            "browHeight", "noseLength", "noseWidth", "lipFullness");
    private static final Set<String> FACE_MORPH_KEYS = Set.of(
            "jawWidth", "jawHeight", "chinLength", "chinWidth",
            "cheekboneWidth", "cheekboneHeight", "cheekFullness",
            "faceLength", "faceWidth", "foreheadHeight",
            "eyeSize", "eyeSpacing", "eyeHeight", "eyeTilt",
            "browHeight", "browTilt", "browThickness",
            "noseLength", "noseWidth", "noseBridge", "noseTip",
            "mouthWidth", "lipFullness", "mouthHeight",
            "sculpt_stylized", "sculpt_eastAsian", "sculpt_jawWidth", "sculpt_jawSharp",
            "sculpt_chinHeight", "sculpt_chinWidth", "sculpt_cheekFull",
            "sculpt_eyeSize", "sculpt_eyeSpacing", "sculpt_eyeTilt", "sculpt_eyeMonolid",
            "sculpt_browHeight", "sculpt_noseLength", "sculpt_noseWidth", "sculpt_noseBridge",
            "sculpt_noseTip", "sculpt_lipFullness", "sculpt_mouthWidth", "sculpt_lipArch",
            "sculpt_mouthCorner");
    private static final Set<String> MAKEUP_KEYS = Set.of(
            "blush", "lip", "freckles", "brow", "facialHair",
            "browThickness", "browDarkness", "lipColor", "lipOpacity",
            "blushColor", "blushIntensity", "freckleDensity");
    private static final Set<String> BROW_STYLES = Set.of("natural", "arched", "straight", "thick", "thin", "soft");
    private static final Set<String> FACIAL_HAIR_STYLES = Set.of("none", "stubble", "short_beard", "goatee", "mustache", "full_beard");
    private static final Set<String> BODY_KEYS = Set.of(
            "heightScale", "buildScale", "shoulderWidth", "legRatio", "torsoDepth", "hipWidth");
    private static final Set<String> OUTFIT_KEYS = Set.of(
            "slot", "name", "top", "outerwear", "bottom", "shoes", "accessories", "colors", "fabrics", "patterns");
    private static final Set<String> OUTFIT_SLOTS = Set.of(
            "everyday", "campus", "formal", "athletic", "sport", "sportswear", "sleep", "sleepwear",
            "lounge", "party", "swimwear", "outerwear", "winter", "cold_weather", "rain",
            "summer", "hot_weather", "work", "street", "casual",
            "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "custom_7", "custom_8");
    private static final Set<String> OUTFIT_COLOR_KEYS = Set.of(
            "top", "outerwear", "bottom", "shoes", "hair", "accessory", "accent", "trim", "bag", "hat", "socks", "scarf");
    private static final Set<String> OUTFIT_PART_KEYS = Set.of("top", "outerwear", "bottom", "shoes", "accessory", "dress");
    private static final Set<String> ALLOWED_FABRICS = Set.of(
            "cotton", "denim", "knit", "fleece", "canvas", "leather", "puffer",
            "wool", "silk", "linen", "velvet", "nylon", "suede", "satin", "corduroy", "tweed", "mesh");
    private static final Set<String> ALLOWED_PATTERNS = Set.of(
            "solid", "stripe", "stripes", "plaid", "houndstooth", "polka", "floral", "herringbone", "check",
            "argyle", "camo", "ribbed", "heather", "gradient", "tie_dye", "botanical", "geometric");
    private static final Set<String> IDENTITY_KEYS = Set.of("traitIds", "desiredLifeId", "values", "favorites");
    private static final Set<String> ALLOWED_TRAITS = Set.of(
            "curious", "creative", "sociable", "ambitious", "diligent", "empathetic",
            "cheerful", "calm", "foodie", "athletic", "tech_savvy", "bookworm",
            "music_lover", "nature_lover", "night_owl", "early_bird", "minimalist", "perfectionist",
            "adventurous", "romantic", "pragmatic", "charming", "tidy", "crafty",
            "charmer", "dreamer", "leader", "mediator", "entertainer", "volunteer",
            "scholar", "sentinel", "individualist", "collaborator", "explorer",
            "artisan", "athlete", "bon_vivant", "strategist");
    private static final Set<String> FORBIDDEN_IDS = Set.of("prototype", "constructor", "__proto__");

    private final EchoLifeRepository worlds;

    public EchoLifeService(EchoLifeRepository worlds) {
        this.worlds = worlds;
    }

    /** The world, or an empty one (revision 0) when nothing was saved yet. Keys of spaces the learner no longer has are left out. */
    @Transactional(readOnly = true)
    public World get(long userId) {
        var loaded = worlds.findWithSpaces(userId);
        return loaded.world() == null ? empty() : readable(loaded.world(), loaded.ownSpaces());
    }

    /**
     * Replaces the world when {@code request.revision} is the stored revision (0 / null: nothing stored yet). A stale write
     * answers 409 with the current world. A malformed document answers 400 and changes nothing.
     */
    @Transactional
    public World save(long userId, SaveWorldRequest request) {
        long base = request.revision() == null ? 0 : request.revision();
        // Fast-fail malformed/oversized payloads before borrowing locks or issuing DB updates.
        JsonNode raw = request.state();
        if (raw == null || !raw.isObject()) throw invalid();
        if (raw.toString().getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES) throw new EchoLifeException(413, "WORLD_TOO_LARGE");

        // Steady-state path: row-lock existing world + fetch own spaces in 1 SQL RTT, then UPDATE RETURNING in 1 SQL RTT.
        var locked = worlds.findForUpdateWithSpaces(userId);
        EchoLifeRepository.Loaded loaded;
        if (locked.isPresent()) {
            loaded = locked.get();
        } else {
            worlds.lockOwner(userId);
            loaded = worlds.findWithSpaces(userId);
        }
        Set<UUID> ownSpaces = loaded.ownSpaces();
        ObjectNode state = normalize(raw, ownSpaces);
        World stored = loaded.world();
        if (stored != null) {
            if (stored.saveVersion() > SAVE_VERSION) throw new EchoLifeException(409, "SAVE_VERSION_UNSUPPORTED");
            if (stored.revision() != base) throw new EchoLifeException(409, "STALE_REVISION", readable(stored, ownSpaces));
            var saved = worlds.updateReturning(userId, SAVE_VERSION, state, base);
            if (saved.isEmpty()) throw new EchoLifeException(409, "STALE_REVISION", get(userId));
            return new World(SAVE_VERSION, saved.get().revision(), state, saved.get().updatedAt());
        } else {
            if (base != 0) throw new EchoLifeException(409, "STALE_REVISION", empty());
            var saved = worlds.insertReturning(userId, SAVE_VERSION, state);
            return new World(SAVE_VERSION, saved.revision(), state, saved.updatedAt());
        }
    }

    static World empty() {
        return new World(SAVE_VERSION, 0, emptyState(), null);
    }

    static ObjectNode emptyState() {
        ObjectNode s = JsonNodeFactory.instance.objectNode();
        s.put("v", SAVE_VERSION);
        s.putObject("places");
        s.putObject("doors");
        s.putObject("objects");
        return s;
    }

    /** A stored document as the client reads it: upgraded to the current version, own spaces only. */
    private World readable(World stored, Set<UUID> ownSpaces) {
        if (stored.saveVersion() > SAVE_VERSION) return stored; // a newer release wrote it: answered as is, never rewritten
        ObjectNode state;
        try {
            state = normalize(upgrade(stored.saveVersion(), stored.state()), ownSpaces);
        } catch (EchoLifeException e) {
            state = emptyState(); // never answer a document this release cannot read as if it were valid
        }
        return new World(SAVE_VERSION, stored.revision(), state, stored.updatedAt());
    }

    /** Version 1 is the first: nothing to upgrade yet. A later version adds its step here (1 → 2 → …), never a rewrite in SQL. */
    static JsonNode upgrade(int fromVersion, JsonNode state) {
        return state;
    }

    // ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────

    ObjectNode normalize(JsonNode raw, Set<UUID> own) {
        if (raw == null || !raw.isObject()) throw invalid();
        if (raw.toString().getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES) throw new EchoLifeException(413, "WORLD_TOO_LARGE");
        onlyKeys(raw, TOP);
        if (!raw.path("v").isInt() || raw.get("v").asInt() != SAVE_VERSION) throw invalid();
        ObjectNode out = emptyState();
        ObjectNode places = (ObjectNode) out.get("places"), doors = (ObjectNode) out.get("doors"), objects = (ObjectNode) out.get("objects");

        JsonNode p = map(raw.get("places"), MAX_PLACES);
        for (Iterator<Map.Entry<String, JsonNode>> it = p.fields(); it.hasNext(); ) {
            var e = it.next();
            UUID space = space(e.getKey());
            JsonNode v = e.getValue();
            if (!v.isObject()) throw invalid();
            onlyKeys(v, PLACE);
            ObjectNode place = places.putObject(space.toString());
            place.put("x", number(v.get("x"), -MAX_XZ, MAX_XZ));
            if (v.has("y")) place.put("y", number(v.get("y"), -MAX_Y, MAX_Y));
            place.put("z", number(v.get("z"), -MAX_XZ, MAX_XZ));
            place.put("rotY", number(v.get("rotY"), -100, 100));
            place.put("region", region(v.get("region")));
            place.put("at", at(v.get("at")));
            if (!own.contains(space)) places.remove(space.toString());
        }

        JsonNode d = map(raw.get("doors"), MAX_DOORS);
        for (Iterator<Map.Entry<String, JsonNode>> it = d.fields(); it.hasNext(); ) {
            var e = it.next();
            String key = e.getKey();
            var house = HOUSE_DOOR.matcher(key);
            boolean keep;
            if (house.matches()) keep = own.contains(space(house.group(1)));
            else if (CITY_DOOR.matcher(key).matches()) keep = true;
            else throw invalid();
            JsonNode v = e.getValue();
            if (!v.isObject() || !v.path("open").isBoolean()) throw invalid();
            onlyKeys(v, DOOR);
            if (!keep) continue;
            ObjectNode door = doors.putObject(key);
            door.put("open", v.get("open").asBoolean());
            door.put("angle", number(v.get("angle"), -Math.PI, Math.PI));
            door.put("at", at(v.get("at")));
        }

        JsonNode o = map(raw.get("objects"), MAX_OBJECTS);
        for (Iterator<Map.Entry<String, JsonNode>> it = o.fields(); it.hasNext(); ) {
            var e = it.next();
            var key = OBJECT_KEY.matcher(e.getKey());
            if (!key.matches()) throw invalid();
            UUID space = space(key.group(1));
            JsonNode v = e.getValue();
            if (!v.isObject()) throw invalid();
            onlyKeys(v, OBJECT_ENTRY);
            ObjectNode object = object(v.get("object"), key.group(2));
            if (!own.contains(space)) continue;
            ObjectNode entry = objects.putObject(space + "/" + key.group(2));
            entry.set("object", object);
            if (v.has("held")) {
                if (!v.get("held").isBoolean()) throw invalid();
                if (v.get("held").booleanValue()) entry.put("held", true);
            }
            entry.put("region", region(v.get("region")));
            entry.put("at", at(v.get("at")));
        }

        if (raw.has("avatar") && !raw.get("avatar").isNull()) {
            out.set("avatar", normalizeAvatar(raw.get("avatar")));
        }
        if (out.toString().getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES) {
            throw new EchoLifeException(413, "WORLD_TOO_LARGE");
        }
        return out;
    }

    /**
     * Strictly validates and normalizes the optional per-account Character Creator {@code avatar} object (&le; 24 KB).
     * Fail-closed: rejects URLs, file paths, script tags, out-of-range morph/body sliders, and unknown keys.
     * Validates client-supplied {@code wireCode} or computes a canonical V2 {@code wireCode} via {@link AvatarLookCode}.
     */
    private ObjectNode normalizeAvatar(JsonNode raw) {
        if (raw == null || !raw.isObject()) throw invalid();
        if (raw.toString().getBytes(StandardCharsets.UTF_8).length > MAX_AVATAR_BYTES) {
            throw new EchoLifeException(413, "AVATAR_TOO_LARGE");
        }
        onlyKeys(raw, AVATAR_TOP_KEYS);

        ObjectNode out = JsonNodeFactory.instance.objectNode();
        JsonNode verNode = raw.get("version");
        if (verNode == null || !verNode.isInt() || verNode.asInt() < 1 || verNode.asInt() > 2) throw invalid();
        out.put("version", verNode.asInt());

        String hero = raw.path("hero").asText("");
        if (!AVATAR_HEROES.contains(hero)) throw invalid();
        out.put("hero", hero);

        String hairId = raw.path("hairId").asText("");
        if (!HAIR_ID.matcher(hairId).matches() || FORBIDDEN_IDS.contains(hairId)) throw invalid();
        out.put("hairId", hairId);

        String hairColor = hexColor(raw.get("hairColor"));
        out.put("hairColor", hairColor);
        if (raw.has("hairTipColor") && !raw.get("hairTipColor").isNull()) {
            out.put("hairTipColor", hexColor(raw.get("hairTipColor")));
        }
        if (raw.has("hairTipMix") && !raw.get("hairTipMix").isNull()) {
            out.put("hairTipMix", number(raw.get("hairTipMix"), 0.0, 1.0));
        }
        String skinTone = hexColor(raw.get("skinTone"));
        out.put("skinTone", skinTone);
        String irisColor = hexColor(raw.get("irisColor"));
        out.put("irisColor", irisColor);
        if (raw.has("lipColor") && !raw.get("lipColor").isNull()) {
            out.put("lipColor", hexColor(raw.get("lipColor")));
        }

        ObjectNode faceOut = null;
        if (raw.has("face") && !raw.get("face").isNull()) {
            JsonNode face = raw.get("face");
            if (!face.isObject()) throw invalid();
            faceOut = out.putObject("face");
            int morphCount = 0;
            for (Iterator<Map.Entry<String, JsonNode>> it = face.fields(); it.hasNext(); ) {
                var e = it.next();
                String key = e.getKey();
                JsonNode val = e.getValue();
                if ("makeup".equals(key)) {
                    faceOut.set("makeup", normalizeMakeup(val));
                } else if (FACE_MORPH_KEYS.contains(key)) {
                    if (++morphCount > 24) throw invalid();
                    faceOut.put(key, number(val, -1.0, 1.0));
                } else {
                    throw invalid();
                }
            }
        }

        ObjectNode bodyOut = null;
        if (raw.has("body") && !raw.get("body").isNull()) {
            JsonNode body = raw.get("body");
            if (!body.isObject()) throw invalid();
            onlyKeys(body, BODY_KEYS);
            bodyOut = out.putObject("body");
            if (body.has("heightScale")) bodyOut.put("heightScale", number(body.get("heightScale"), 0.88, 1.12));
            if (body.has("buildScale")) bodyOut.put("buildScale", number(body.get("buildScale"), 0.88, 1.16));
            if (body.has("shoulderWidth")) bodyOut.put("shoulderWidth", number(body.get("shoulderWidth"), 0.88, 1.15));
            if (body.has("legRatio")) bodyOut.put("legRatio", number(body.get("legRatio"), 0.92, 1.08));
            if (body.has("torsoDepth")) bodyOut.put("torsoDepth", number(body.get("torsoDepth"), 0.90, 1.14));
            if (body.has("hipWidth")) bodyOut.put("hipWidth", number(body.get("hipWidth"), 0.90, 1.14));
        }

        JsonNode outfitsRaw = raw.get("outfits");
        if (outfitsRaw == null || !outfitsRaw.isArray() || outfitsRaw.isEmpty() || outfitsRaw.size() > 8) throw invalid();
        ArrayNode outfitsOut = out.putArray("outfits");
        for (JsonNode slotNode : outfitsRaw) {
            outfitsOut.add(normalizeOutfit(slotNode));
        }

        JsonNode activeNode = raw.get("activeOutfit");
        if (activeNode == null || !activeNode.isInt()) throw invalid();
        int activeOutfit = activeNode.asInt();
        if (activeOutfit < 0 || activeOutfit > 7 || activeOutfit >= outfitsOut.size()) throw invalid();
        out.put("activeOutfit", activeOutfit);

        if (raw.has("autoSeasonalOutfit") && !raw.get("autoSeasonalOutfit").isNull()) {
            if (!raw.get("autoSeasonalOutfit").isBoolean()) throw invalid();
            out.put("autoSeasonalOutfit", raw.get("autoSeasonalOutfit").asBoolean());
        } else {
            out.put("autoSeasonalOutfit", false);
        }

        if (raw.has("identity") && !raw.get("identity").isNull()) {
            out.set("identity", normalizeIdentity(raw.get("identity")));
        }

        if (raw.has("at") && !raw.get("at").isNull()) {
            out.put("at", at(raw.get("at")));
        }

        if (raw.has("wireCode") && !raw.get("wireCode").isNull()) {
            if (!raw.get("wireCode").isTextual()) throw invalid();
            String cleaned = AvatarLookCode.clean(raw.get("wireCode").asText());
            if (cleaned.isEmpty()) throw invalid();
            out.put("wireCode", cleaned);
        } else {
            String computed = computeAvatarWireCode(hero, hairId, skinTone, irisColor, hairColor,
                    bodyOut, faceOut, (ObjectNode) outfitsOut.get(activeOutfit));
            String cleaned = AvatarLookCode.clean(computed);
            if (cleaned.isEmpty()) throw invalid();
            out.put("wireCode", cleaned);
        }

        if (out.toString().getBytes(StandardCharsets.UTF_8).length > MAX_AVATAR_BYTES) {
            throw new EchoLifeException(413, "AVATAR_TOO_LARGE");
        }
        return out;
    }

    private ObjectNode normalizeMakeup(JsonNode raw) {
        if (raw == null || !raw.isObject()) throw invalid();
        onlyKeys(raw, MAKEUP_KEYS);
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        for (String key : List.of("blush", "lip", "freckles", "browThickness", "browDarkness", "lipOpacity", "blushIntensity", "freckleDensity")) {
            if (raw.has(key) && !raw.get(key).isNull()) {
                out.put(key, number(raw.get(key), 0.0, 1.0));
            }
        }
        for (String colorKey : List.of("lipColor", "blushColor")) {
            if (raw.has(colorKey) && !raw.get(colorKey).isNull()) {
                out.put(colorKey, hexColor(raw.get(colorKey)));
            }
        }
        if (raw.has("brow") && !raw.get("brow").isNull()) {
            JsonNode brow = raw.get("brow");
            if (brow.isNumber()) out.put("brow", number(brow, 0.0, 1.0));
            else if (brow.isTextual() && BROW_STYLES.contains(brow.asText())) out.put("brow", brow.asText());
            else throw invalid();
        }
        if (raw.has("facialHair") && !raw.get("facialHair").isNull()) {
            JsonNode fh = raw.get("facialHair");
            if (fh.isNumber()) out.put("facialHair", number(fh, 0.0, 1.0));
            else if (fh.isTextual() && FACIAL_HAIR_STYLES.contains(fh.asText())) out.put("facialHair", fh.asText());
            else throw invalid();
        }
        return out;
    }

    private ObjectNode normalizeOutfit(JsonNode raw) {
        if (raw == null || !raw.isObject()) throw invalid();
        onlyKeys(raw, OUTFIT_KEYS);
        ObjectNode out = JsonNodeFactory.instance.objectNode();

        JsonNode slotNode = raw.get("slot");
        if (slotNode == null || slotNode.isNull()) throw invalid();
        if (slotNode.isInt()) {
            int idx = slotNode.asInt();
            if (idx < 0 || idx > 7) throw invalid();
            out.put("slot", idx);
        } else if (slotNode.isTextual() && OUTFIT_SLOTS.contains(slotNode.asText())) {
            out.put("slot", slotNode.asText());
        } else {
            throw invalid();
        }

        if (raw.has("name") && !raw.get("name").isNull()) {
            if (!raw.get("name").isTextual()) throw invalid();
            String name = raw.get("name").asText().trim();
            if (!OUTFIT_NAME.matcher(name).matches()) throw invalid();
            out.put("name", name);
        }

        out.put("top", garmentId(raw.get("top"), false));
        if (raw.has("outerwear") && !raw.get("outerwear").isNull()) {
            out.put("outerwear", garmentId(raw.get("outerwear"), true));
        }
        out.put("bottom", garmentId(raw.get("bottom"), false));
        out.put("shoes", garmentId(raw.get("shoes"), false));

        ArrayNode accOut = out.putArray("accessories");
        if (raw.has("accessories") && !raw.get("accessories").isNull()) {
            JsonNode acc = raw.get("accessories");
            if (!acc.isArray() || acc.size() > 4) throw invalid();
            for (JsonNode item : acc) {
                if (item == null || !item.isTextual() || !HAIR_ID.matcher(item.asText()).matches()
                        || FORBIDDEN_IDS.contains(item.asText())) throw invalid();
                accOut.add(item.asText());
            }
        }

        if (raw.has("colors") && !raw.get("colors").isNull()) {
            JsonNode colors = raw.get("colors");
            if (!colors.isObject() || colors.size() > 8) throw invalid();
            ObjectNode cOut = out.putObject("colors");
            for (Iterator<Map.Entry<String, JsonNode>> it = colors.fields(); it.hasNext(); ) {
                var e = it.next();
                if (!OUTFIT_COLOR_KEYS.contains(e.getKey())) throw invalid();
                cOut.put(e.getKey(), hexColor(e.getValue()));
            }
        }

        if (raw.has("fabrics") && !raw.get("fabrics").isNull()) {
            JsonNode fabrics = raw.get("fabrics");
            if (!fabrics.isObject() || fabrics.size() > 6) throw invalid();
            ObjectNode fOut = out.putObject("fabrics");
            for (Iterator<Map.Entry<String, JsonNode>> it = fabrics.fields(); it.hasNext(); ) {
                var e = it.next();
                if (!OUTFIT_PART_KEYS.contains(e.getKey()) || !e.getValue().isTextual()
                        || !ALLOWED_FABRICS.contains(e.getValue().asText())) throw invalid();
                fOut.put(e.getKey(), e.getValue().asText());
            }
        }

        if (raw.has("patterns") && !raw.get("patterns").isNull()) {
            JsonNode patterns = raw.get("patterns");
            if (!patterns.isObject() || patterns.size() > 6) throw invalid();
            ObjectNode pOut = out.putObject("patterns");
            for (Iterator<Map.Entry<String, JsonNode>> it = patterns.fields(); it.hasNext(); ) {
                var e = it.next();
                if (!OUTFIT_PART_KEYS.contains(e.getKey()) || !e.getValue().isTextual()
                        || !ALLOWED_PATTERNS.contains(e.getValue().asText())) throw invalid();
                pOut.put(e.getKey(), e.getValue().asText());
            }
        }
        return out;
    }

    private ObjectNode normalizeIdentity(JsonNode raw) {
        if (raw == null || !raw.isObject()) throw invalid();
        onlyKeys(raw, IDENTITY_KEYS);
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        if (raw.has("traitIds") && !raw.get("traitIds").isNull()) {
            JsonNode traits = raw.get("traitIds");
            if (!traits.isArray() || traits.size() > 3) throw invalid();
            ArrayNode tOut = out.putArray("traitIds");
            for (JsonNode t : traits) {
                if (t == null || !t.isTextual() || !ALLOWED_TRAITS.contains(t.asText())) throw invalid();
                tOut.add(t.asText());
            }
        }
        if (raw.has("desiredLifeId") && !raw.get("desiredLifeId").isNull()) {
            out.put("desiredLifeId", safeId(raw.get("desiredLifeId")));
        }
        if (raw.has("values") && !raw.get("values").isNull()) {
            JsonNode vals = raw.get("values");
            if (!vals.isArray() || vals.size() > 3) throw invalid();
            ArrayNode vOut = out.putArray("values");
            for (JsonNode v : vals) vOut.add(safeId(v));
        }
        if (raw.has("favorites") && !raw.get("favorites").isNull()) {
            JsonNode favs = raw.get("favorites");
            if (favs.isArray()) {
                if (favs.size() > 4) throw invalid();
                ArrayNode fOut = out.putArray("favorites");
                for (JsonNode f : favs) fOut.add(safeId(f));
            } else if (favs.isObject()) {
                if (favs.size() > 4) throw invalid();
                ObjectNode fOut = out.putObject("favorites");
                for (Iterator<Map.Entry<String, JsonNode>> it = favs.fields(); it.hasNext(); ) {
                    var e = it.next();
                    if (!SAFE_ID.matcher(e.getKey()).matches() || FORBIDDEN_IDS.contains(e.getKey())) throw invalid();
                    fOut.put(e.getKey(), safeId(e.getValue()));
                }
            } else {
                throw invalid();
            }
        }
        return out;
    }

    private static String computeAvatarWireCode(String hero, String hairId, String skinTone, String irisColor,
                                                String hairColor, ObjectNode body, ObjectNode face, ObjectNode outfit) {
        String heroCode = "LYRA".equals(hero) ? "l" : "k";
        String hairSeg = hairId.length() > 24 ? hairId.substring(0, 24) : hairId;
        String skinHex = skinTone.substring(1);
        String irisHex = irisColor.substring(1);

        StringBuilder bodyHex = new StringBuilder(12);
        appendQuantized(bodyHex, body, "heightScale", 0.88, 1.12);
        appendQuantized(bodyHex, body, "buildScale", 0.88, 1.16);
        appendQuantized(bodyHex, body, "shoulderWidth", 0.88, 1.15);
        appendQuantized(bodyHex, body, "legRatio", 0.92, 1.08);
        appendQuantized(bodyHex, body, "torsoDepth", 0.90, 1.14);
        appendQuantized(bodyHex, body, "hipWidth", 0.90, 1.14);

        StringBuilder faceHex = new StringBuilder(32);
        for (String key : FACE_MORPH_ORDER) {
            appendQuantized(faceHex, face, key, -1.0, 1.0);
        }

        String top = outfitToken(outfit.path("top").asText("signature"));
        String outerwear = outfitToken(outfit.path("outerwear").asText(""));
        String bottom = outfitToken(outfit.path("bottom").asText("signature"));
        String shoes = outfitToken(outfit.path("shoes").asText("signature"));
        StringBuilder acc = new StringBuilder();
        JsonNode accArr = outfit.get("accessories");
        if (accArr != null && accArr.isArray() && !accArr.isEmpty()) {
            for (int i = 0; i < accArr.size(); i++) {
                if (i > 0) acc.append('_');
                acc.append(outfitToken(accArr.get(i).asText("")));
            }
        } else {
            acc.append('-');
        }
        JsonNode colors = outfit.path("colors");
        String hairHex = hairColor.substring(1);
        String topHex = hexOrDefault(colors.get("top"), "2f3a55");
        String botHex = hexOrDefault(colors.get("bottom"), "2c3e5e");
        String shoeHex = hexOrDefault(colors.get("shoes"), "f2efe6");
        String accHex = hexOrDefault(colors.get("accessory"), "3b3f55");

        String outfitSeg = top + "." + outerwear + "." + bottom + "." + shoes + "." + acc
                + "." + hairHex + "." + topHex + "." + botHex + "." + shoeHex + "." + accHex;
        if (outfitSeg.length() > 140) {
            outfitSeg = top + "." + outerwear + "." + bottom + "." + shoes + ".-."
                    + hairHex + "." + topHex + "." + botHex + "." + shoeHex + "." + accHex;
        }
        if (outfitSeg.length() > 140) {
            outfitSeg = "signature.-.signature.signature.-." + hairHex + ".2f3a55.2c3e5e.f2efe6.3b3f55";
        }
        return "v2:" + heroCode + ":" + hairSeg + ":" + skinHex + ":" + irisHex + ":" + bodyHex + ":" + faceHex + ":" + outfitSeg;
    }

    private static void appendQuantized(StringBuilder out, ObjectNode node, String key, double min, double max) {
        if (node == null || !node.has(key) || !node.get(key).isNumber()) {
            out.append("80");
            return;
        }
        double norm = (node.get(key).asDouble() - min) / (max - min);
        int q = Math.max(0, Math.min(255, (int) Math.round(norm * 255.0)));
        out.append(String.format(Locale.ROOT, "%02x", q));
    }

    private static String outfitToken(String value) {
        if (value == null || value.isEmpty()) return "-";
        String clean = value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_-]", "");
        return clean.isEmpty() ? "-" : clean;
    }

    private static String hexOrDefault(JsonNode node, String fallback) {
        if (node != null && node.isTextual() && HEX_COLOR.matcher(node.asText()).matches()) {
            return node.asText().substring(1).toLowerCase(Locale.ROOT);
        }
        return fallback;
    }

    private static String hexColor(JsonNode node) {
        if (node == null || !node.isTextual() || !HEX_COLOR.matcher(node.asText()).matches()) throw invalid();
        return node.asText().toLowerCase(Locale.ROOT);
    }

    private static String garmentId(JsonNode node, boolean allowEmpty) {
        if (node == null || !node.isTextual()) throw invalid();
        String s = node.asText();
        if (allowEmpty && s.isEmpty()) return "";
        if (!GARMENT_ID.matcher(s).matches() || FORBIDDEN_IDS.contains(s)) throw invalid();
        return s;
    }

    private static String safeId(JsonNode node) {
        if (node == null || !node.isTextual()) throw invalid();
        String s = node.asText();
        if (!SAFE_ID.matcher(s).matches() || FORBIDDEN_IDS.contains(s)) throw invalid();
        return s;
    }

    /** A study-room object set down outside its room: its own fields only, bounded; its place is in the world's metres. */
    private ObjectNode object(JsonNode raw, String id) {
        if (raw == null || !raw.isObject()) throw invalid();
        onlyKeys(raw, OBJECT_FIELDS);
        if (!id.equals(raw.path("id").asText(null))) throw invalid();
        String kind = raw.path("kind").asText("");
        if (!KIND.matcher(kind).matches()) throw invalid();
        if (raw.toString().getBytes(StandardCharsets.UTF_8).length > MAX_OBJECT_BYTES) throw invalid();
        JsonNode pos = raw.get("pos");
        if (pos == null || !pos.isArray() || pos.size() != 3) throw invalid();
        ObjectNode out = raw.deepCopy();
        ArrayNode at = out.putArray("pos");
        at.add(number(pos.get(0), -MAX_XZ, MAX_XZ)).add(number(pos.get(1), -MAX_Y, MAX_Y)).add(number(pos.get(2), -MAX_XZ, MAX_XZ));
        out.put("rotY", number(raw.get("rotY"), -100, 100));
        if (raw.has("scale")) out.put("scale", number(raw.get("scale"), .2, 4));
        if (raw.has("quat")) {
            JsonNode q = raw.get("quat");
            if (!q.isArray() || q.size() != 4) throw invalid();
            ArrayNode quat = out.putArray("quat");
            for (JsonNode n : q) quat.add(number(n, -1.001, 1.001));
        }
        for (String flag : new String[]{"hidden", "locked", "lightOn"}) if (raw.has(flag) && !raw.get(flag).isBoolean()) throw invalid();
        if (raw.has("color") && (!raw.get("color").isTextual() || raw.get("color").asText().length() > 32)) throw invalid();
        if (raw.has("group") && (!raw.get("group").isTextual() || raw.get("group").asText().length() > 48)) throw invalid();
        if (raw.has("drawers")) {
            JsonNode dr = raw.get("drawers");
            if (!dr.isArray() || dr.size() > 16) throw invalid();
            ArrayNode drawers = out.putArray("drawers");
            for (JsonNode n : dr) drawers.add(number(n, 0, 1));
        }
        if (raw.has("action")) {
            JsonNode act = raw.get("action");
            if (!act.isTextual() && !act.isObject()) throw invalid();
            if (act.toString().getBytes(StandardCharsets.UTF_8).length > 512) throw invalid();
        }
        if (raw.has("state") && !raw.get("state").isObject()) throw invalid();
        return out;
    }

    private static JsonNode map(JsonNode node, int max) {
        if (node == null || node.isNull()) return JsonNodeFactory.instance.objectNode();
        if (!node.isObject() || node.size() > max) throw invalid();
        return node;
    }

    private static UUID space(String text) {
        if (text == null || !UUID_TEXT.matcher(text).matches()) throw invalid();
        return UUID.fromString(text);
    }

    private static double number(JsonNode n, double min, double max) {
        if (n == null || !n.isNumber()) throw invalid();
        double v = n.asDouble();
        if (!Double.isFinite(v) || v < min || v > max) throw invalid();
        return v;
    }

    private static long at(JsonNode n) {
        return (long) number(n, 0, MAX_AT);
    }

    private static String region(JsonNode n) {
        if (n == null || !n.isTextual() || !REGION.matcher(n.asText()).matches()) throw invalid();
        return n.asText();
    }

    private static void onlyKeys(JsonNode node, Set<String> allowed) {
        for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) if (!allowed.contains(it.next())) throw invalid();
    }

    private static EchoLifeException invalid() {
        return new EchoLifeException(400, "INVALID_WORLD");
    }
}
