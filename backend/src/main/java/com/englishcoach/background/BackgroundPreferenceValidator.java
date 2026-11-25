package com.englishcoach.background;

import com.englishcoach.background.BackgroundPreferenceDtos.BackgroundPreferencesResponse;
import com.englishcoach.background.BackgroundPreferenceDtos.SaveBackgroundPreferencesRequest;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Strict schema validator and allowlist re-serializer for Echo Background Studio preferences.
 *
 * <p>Every accepted payload is reconstructed from scratch into brand-new Jackson nodes containing ONLY allowlisted
 * fields, guaranteeing zero prototype pollution and zero arbitrary JSON blob storage.
 */
@Component
public class BackgroundPreferenceValidator {

    public static final int SCHEMA_VERSION = 1;
    /** Application cap strictly below the 262,144-byte (256 KB) PostgreSQL CHECK constraint. */
    public static final int MAX_STATE_BYTES = 240 * 1024;
    public static final int MAX_FAVORITE_PRESETS = 32;
    public static final int MAX_CUSTOM_THEMES = 40;
    public static final int MAX_THEME_NAME_LENGTH = 60;
    public static final int MAX_RAW_THEME_NAME_LENGTH = 240;
    public static final int MIN_STOPS = 2;
    public static final int MAX_STOPS = 8;
    public static final int MIN_EFFECTS = 1;
    public static final int MAX_EFFECTS = 6;

    private static final Instant MIN_TIMESTAMP = Instant.parse("2000-01-01T00:00:00Z");
    private static final Instant MAX_TIMESTAMP = Instant.parse("2100-01-01T00:00:00Z");

    private static final Pattern ID_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,63}$");
    private static final Pattern STOP_ID_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    private static final Pattern HEX_COLOR_PATTERN = Pattern.compile("^#[0-9a-fA-F]{6}$");

    private static final Set<String> ALLOWED_ACTIVE_SOURCES = Set.of("none", "preset", "custom");
    private static final Set<String> ALLOWED_GRADIENT_TYPES = Set.of("linear", "radial", "conic", "mesh");
    private static final Set<String> ALLOWED_BLEND_MODES = Set.of(
            "normal", "screen", "overlay", "soft-light", "color-dodge", "lighten", "multiply");
    private static final Set<String> ALLOWED_EFFECTS = Set.of(
            "static", "color-flow", "aurora", "liquid-flow", "pearl-shimmer",
            "ambient-glow", "light-drift", "color-breathing", "gradient-morph");
    private static final Set<String> ALLOWED_PERFORMANCE_MODES = Set.of("auto", "high", "eco");

    public record ValidatedPreferences(int schemaVersion, ObjectNode state, String serializedJson) {
    }

    private final ObjectMapper objectMapper;

    public BackgroundPreferenceValidator(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** Returns the canonical default response for a learner who has not yet saved preferences. */
    public static BackgroundPreferencesResponse defaultResponse() {
        ObjectNode state = JsonNodeFactory.instance.objectNode();
        state.put("schemaVersion", SCHEMA_VERSION);
        state.put("activeSource", "none");
        state.putNull("activeThemeId");
        state.putNull("activeConfig");
        state.putArray("favoritePresetIds");
        state.putArray("customThemes");
        return new BackgroundPreferencesResponse(SCHEMA_VERSION, 0L, state, null);
    }

    /**
     * Validates every field of the request and produces a sanitized canonical JSON representation containing only
     * allowlisted properties.
     */
    public ValidatedPreferences validateAndSanitize(SaveBackgroundPreferencesRequest request) {
        if (request == null || request.state() == null || !request.state().isObject()) {
            throw badRequest("INVALID_STATE");
        }
        JsonNode rawState = request.state();
        ensureWithinByteLimit(rawState);

        int resolvedVersion = resolveSchemaVersion(request.schemaVersion(), rawState.get("schemaVersion"));

        String activeSource = requireEnum(rawState, "activeSource", ALLOWED_ACTIVE_SOURCES, "INVALID_ACTIVE_SOURCE");
        String activeThemeId = optionalId(rawState, "activeThemeId", "INVALID_THEME_ID");
        ObjectNode activeConfig = optionalConfig(rawState, "activeConfig");
        ArrayNode favoritePresetIds = validateFavoritePresetIds(rawState.get("favoritePresetIds"));
        ArrayNode customThemes = validateCustomThemes(rawState.get("customThemes"));

        ObjectNode sanitized = JsonNodeFactory.instance.objectNode();
        sanitized.put("schemaVersion", resolvedVersion);
        sanitized.put("activeSource", activeSource);
        if (activeThemeId == null) {
            sanitized.putNull("activeThemeId");
        } else {
            sanitized.put("activeThemeId", activeThemeId);
        }
        if (activeConfig == null) {
            sanitized.putNull("activeConfig");
        } else {
            sanitized.set("activeConfig", activeConfig);
        }
        sanitized.set("favoritePresetIds", favoritePresetIds);
        sanitized.set("customThemes", customThemes);

        String serialized = serializeChecked(sanitized);
        return new ValidatedPreferences(resolvedVersion, sanitized, serialized);
    }

    private int resolveSchemaVersion(Integer requestVersion, JsonNode stateVersionNode) {
        if (requestVersion != null && requestVersion != SCHEMA_VERSION) {
            throw badRequest("INVALID_SCHEMA_VERSION");
        }
        if (stateVersionNode != null && !stateVersionNode.isNull()) {
            if (!stateVersionNode.isIntegralNumber() || stateVersionNode.asInt() != SCHEMA_VERSION) {
                throw badRequest("INVALID_SCHEMA_VERSION");
            }
            return SCHEMA_VERSION;
        }
        if (requestVersion == null) {
            throw badRequest("INVALID_SCHEMA_VERSION");
        }
        return SCHEMA_VERSION;
    }

    private ArrayNode validateFavoritePresetIds(JsonNode node) {
        ArrayNode out = JsonNodeFactory.instance.arrayNode();
        if (node == null || node.isMissingNode()) {
            return out;
        }
        if (!node.isArray()) {
            throw badRequest("INVALID_FAVORITE_PRESETS");
        }
        if (node.size() > MAX_FAVORITE_PRESETS) {
            throw badRequest("TOO_MANY_FAVORITE_PRESETS");
        }
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode item : node) {
            if (item == null || !item.isTextual()) {
                throw badRequest("INVALID_PRESET_ID");
            }
            String id = item.asText();
            if (!ID_PATTERN.matcher(id).matches()) {
                throw badRequest("INVALID_PRESET_ID");
            }
            if (seen.add(id)) {
                out.add(id);
            }
        }
        return out;
    }

    private ArrayNode validateCustomThemes(JsonNode node) {
        ArrayNode out = JsonNodeFactory.instance.arrayNode();
        if (node == null || node.isMissingNode()) {
            return out;
        }
        if (!node.isArray()) {
            throw badRequest("INVALID_CUSTOM_THEMES");
        }
        if (node.size() > MAX_CUSTOM_THEMES) {
            throw badRequest("TOO_MANY_CUSTOM_THEMES");
        }
        Set<String> seenIds = new HashSet<>();
        for (JsonNode item : node) {
            if (item == null || !item.isObject()) {
                throw badRequest("INVALID_CUSTOM_THEME");
            }
            String id = requireId(item, "id", "INVALID_THEME_ID");
            if (!seenIds.add(id)) {
                throw badRequest("DUPLICATE_THEME_ID");
            }
            String name = sanitizeThemeName(item.get("name"));
            boolean favorite = optionalBoolean(item, "favorite", false, "INVALID_THEME_FAVORITE");
            String basedOnPresetId = optionalId(item, "basedOnPresetId", "INVALID_PRESET_ID");
            ObjectNode config = requireConfig(item.get("config"));
            String createdAt = requireIsoTimestamp(item, "createdAt");
            String updatedAt = requireIsoTimestamp(item, "updatedAt");

            ObjectNode theme = JsonNodeFactory.instance.objectNode();
            theme.put("id", id);
            theme.put("name", name);
            theme.put("favorite", favorite);
            if (basedOnPresetId == null) {
                theme.putNull("basedOnPresetId");
            } else {
                theme.put("basedOnPresetId", basedOnPresetId);
            }
            theme.set("config", config);
            theme.put("createdAt", createdAt);
            theme.put("updatedAt", updatedAt);
            out.add(theme);
        }
        return out;
    }

    private ObjectNode optionalConfig(JsonNode parent, String field) {
        JsonNode node = parent.get(field);
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        return requireConfig(node);
    }

    private ObjectNode requireConfig(JsonNode node) {
        if (node == null || !node.isObject()) {
            throw badRequest("INVALID_CONFIG");
        }
        ObjectNode color = validateColorConfig(node.get("color"));
        ObjectNode motion = validateMotionConfig(node.get("motion"));
        Double grainOpacity = optionalNumber(node, "grainOpacity", 0.0, 100.0, "INVALID_GRAIN_OPACITY");

        ObjectNode out = JsonNodeFactory.instance.objectNode();
        out.set("color", color);
        out.set("motion", motion);
        if (grainOpacity != null) {
            putNumber(out, "grainOpacity", grainOpacity);
        }
        return out;
    }

    private ObjectNode validateColorConfig(JsonNode node) {
        if (node == null || !node.isObject()) {
            throw badRequest("INVALID_COLOR_CONFIG");
        }
        String gradientType = requireEnum(node, "gradientType", ALLOWED_GRADIENT_TYPES, "INVALID_GRADIENT_TYPE");
        ArrayNode stops = validateStops(node.get("stops"));
        double gradientAngle = requireNumber(node, "gradientAngle", 0.0, 360.0, "INVALID_COLOR_VALUE");
        double centerX = requireNumber(node, "centerX", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double centerY = requireNumber(node, "centerY", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double gradientSpread = requireNumber(node, "gradientSpread", 10.0, 100.0, "INVALID_COLOR_VALUE");
        String blendMode = requireEnum(node, "blendMode", ALLOWED_BLEND_MODES, "INVALID_BLEND_MODE");
        double blendIntensity = requireNumber(node, "blendIntensity", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double baseLayerOpacity = requireNumber(node, "baseLayerOpacity", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double depthLayerOpacity = requireNumber(node, "depthLayerOpacity", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double brightness = requireNumber(node, "brightness", 50.0, 150.0, "INVALID_COLOR_VALUE");
        double saturation = requireNumber(node, "saturation", 0.0, 200.0, "INVALID_COLOR_VALUE");
        double contrast = requireNumber(node, "contrast", 60.0, 150.0, "INVALID_COLOR_VALUE");
        double opacity = requireNumber(node, "opacity", 15.0, 100.0, "INVALID_COLOR_VALUE");
        double blur = requireNumber(node, "blur", 0.0, 40.0, "INVALID_COLOR_VALUE");
        double glow = requireNumber(node, "glow", 0.0, 100.0, "INVALID_COLOR_VALUE");
        double colorIntensity = requireNumber(node, "colorIntensity", 0.0, 100.0, "INVALID_COLOR_VALUE");

        ObjectNode out = JsonNodeFactory.instance.objectNode();
        out.put("gradientType", gradientType);
        out.set("stops", stops);
        putNumber(out, "gradientAngle", gradientAngle);
        putNumber(out, "centerX", centerX);
        putNumber(out, "centerY", centerY);
        putNumber(out, "gradientSpread", gradientSpread);
        out.put("blendMode", blendMode);
        putNumber(out, "blendIntensity", blendIntensity);
        putNumber(out, "baseLayerOpacity", baseLayerOpacity);
        putNumber(out, "depthLayerOpacity", depthLayerOpacity);
        putNumber(out, "brightness", brightness);
        putNumber(out, "saturation", saturation);
        putNumber(out, "contrast", contrast);
        putNumber(out, "opacity", opacity);
        putNumber(out, "blur", blur);
        putNumber(out, "glow", glow);
        putNumber(out, "colorIntensity", colorIntensity);
        return out;
    }

    private ArrayNode validateStops(JsonNode node) {
        if (node == null || !node.isArray()) {
            throw badRequest("INVALID_COLOR_STOPS");
        }
        int count = node.size();
        if (count < MIN_STOPS || count > MAX_STOPS) {
            throw badRequest("INVALID_COLOR_STOPS");
        }
        ArrayNode out = JsonNodeFactory.instance.arrayNode();
        for (JsonNode item : node) {
            if (item == null || !item.isObject()) {
                throw badRequest("INVALID_COLOR_STOP");
            }
            String id = requireStopId(item.get("id"));
            String color = requireHexColor(item.get("color"));
            double position = requireNumber(item, "position", 0.0, 100.0, "INVALID_STOP_POSITION");
            double opacity = requireNumber(item, "opacity", 0.0, 1.0, "INVALID_STOP_OPACITY");
            Double x = optionalNumber(item, "x", 0.0, 100.0, "INVALID_STOP_COORDINATE");
            Double y = optionalNumber(item, "y", 0.0, 100.0, "INVALID_STOP_COORDINATE");

            ObjectNode stop = JsonNodeFactory.instance.objectNode();
            stop.put("id", id);
            stop.put("color", color);
            putNumber(stop, "position", position);
            putNumber(stop, "opacity", opacity);
            if (x != null) {
                putNumber(stop, "x", x);
            }
            if (y != null) {
                putNumber(stop, "y", y);
            }
            out.add(stop);
        }
        return out;
    }

    private ObjectNode validateMotionConfig(JsonNode node) {
        if (node == null || !node.isObject()) {
            throw badRequest("INVALID_MOTION_CONFIG");
        }
        ArrayNode effects = validateEffects(node.get("effects"));
        double animationSpeed = requireNumber(node, "animationSpeed", 0.1, 2.5, "INVALID_MOTION_VALUE");
        double motionIntensity = requireNumber(node, "motionIntensity", 0.0, 100.0, "INVALID_MOTION_VALUE");
        double lightIntensity = requireNumber(node, "lightIntensity", 0.0, 100.0, "INVALID_MOTION_VALUE");
        double movementDirection = requireNumber(node, "movementDirection", 0.0, 360.0, "INVALID_MOTION_VALUE");
        double movementScale = requireNumber(node, "movementScale", 20.0, 200.0, "INVALID_MOTION_VALUE");
        double glowRadius = requireNumber(node, "glowRadius", 10.0, 100.0, "INVALID_MOTION_VALUE");
        double shimmerIntensity = requireNumber(node, "shimmerIntensity", 0.0, 100.0, "INVALID_MOTION_VALUE");
        double animationSmoothness = requireNumber(node, "animationSmoothness", 0.0, 100.0, "INVALID_MOTION_VALUE");
        String performanceMode = requireEnum(node, "performanceMode", ALLOWED_PERFORMANCE_MODES, "INVALID_PERFORMANCE_MODE");

        ObjectNode out = JsonNodeFactory.instance.objectNode();
        out.set("effects", effects);
        putNumber(out, "animationSpeed", animationSpeed);
        putNumber(out, "motionIntensity", motionIntensity);
        putNumber(out, "lightIntensity", lightIntensity);
        putNumber(out, "movementDirection", movementDirection);
        putNumber(out, "movementScale", movementScale);
        putNumber(out, "glowRadius", glowRadius);
        putNumber(out, "shimmerIntensity", shimmerIntensity);
        putNumber(out, "animationSmoothness", animationSmoothness);
        out.put("performanceMode", performanceMode);
        return out;
    }

    private ArrayNode validateEffects(JsonNode node) {
        if (node == null || !node.isArray()) {
            throw badRequest("INVALID_MOTION_EFFECTS");
        }
        int size = node.size();
        if (size < MIN_EFFECTS || size > MAX_EFFECTS) {
            throw badRequest("INVALID_MOTION_EFFECTS");
        }
        Set<String> seen = new LinkedHashSet<>();
        ArrayNode out = JsonNodeFactory.instance.arrayNode();
        for (JsonNode item : node) {
            if (item == null || !item.isTextual()) {
                throw badRequest("INVALID_MOTION_EFFECT");
            }
            String effect = item.asText();
            if (!ALLOWED_EFFECTS.contains(effect)) {
                throw badRequest("INVALID_MOTION_EFFECT");
            }
            if (seen.add(effect)) {
                out.add(effect);
            }
        }
        return out;
    }

    private String sanitizeThemeName(JsonNode node) {
        if (node == null || !node.isTextual()) {
            throw badRequest("INVALID_THEME_NAME");
        }
        String raw = node.asText();
        if (raw.length() > MAX_RAW_THEME_NAME_LENGTH) {
            throw badRequest("INVALID_THEME_NAME");
        }
        if (raw.indexOf('<') >= 0 || raw.indexOf('>') >= 0) {
            throw badRequest("INVALID_THEME_NAME");
        }
        StringBuilder cleaned = new StringBuilder(raw.length());
        raw.codePoints()
                .filter(cp -> !Character.isISOControl(cp) && Character.getType(cp) != Character.FORMAT)
                .forEach(cleaned::appendCodePoint);
        String trimmed = cleaned.toString().strip();
        int len = trimmed.codePointCount(0, trimmed.length());
        if (len < 1 || len > MAX_THEME_NAME_LENGTH) {
            throw badRequest("INVALID_THEME_NAME");
        }
        return trimmed;
    }

    private String requireId(JsonNode parent, String field, String code) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isTextual()) {
            throw badRequest(code);
        }
        String value = node.asText();
        if (!ID_PATTERN.matcher(value).matches()) {
            throw badRequest(code);
        }
        return value;
    }

    private String optionalId(JsonNode parent, String field, String code) {
        JsonNode node = parent.get(field);
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (!node.isTextual()) {
            throw badRequest(code);
        }
        String value = node.asText();
        if (!ID_PATTERN.matcher(value).matches()) {
            throw badRequest(code);
        }
        return value;
    }

    private String requireStopId(JsonNode node) {
        if (node == null || !node.isTextual()) {
            throw badRequest("INVALID_STOP_ID");
        }
        String value = node.asText();
        if (!STOP_ID_PATTERN.matcher(value).matches()) {
            throw badRequest("INVALID_STOP_ID");
        }
        return value;
    }

    private String requireHexColor(JsonNode node) {
        if (node == null || !node.isTextual()) {
            throw badRequest("INVALID_COLOR");
        }
        String value = node.asText();
        if (!HEX_COLOR_PATTERN.matcher(value).matches()) {
            throw badRequest("INVALID_COLOR");
        }
        return value.toLowerCase(Locale.ROOT);
    }

    private String requireEnum(JsonNode parent, String field, Set<String> allowed, String code) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isTextual()) {
            throw badRequest(code);
        }
        String value = node.asText();
        if (!allowed.contains(value)) {
            throw badRequest(code);
        }
        return value;
    }

    private boolean optionalBoolean(JsonNode parent, String field, boolean defaultValue, String code) {
        JsonNode node = parent.get(field);
        if (node == null || node.isMissingNode() || node.isNull()) {
            return defaultValue;
        }
        if (!node.isBoolean()) {
            throw badRequest(code);
        }
        return node.asBoolean();
    }

    private double requireNumber(JsonNode parent, String field, double min, double max, String code) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isNumber()) {
            throw badRequest(code);
        }
        double value = node.doubleValue();
        if (!Double.isFinite(value) || value < min || value > max) {
            throw badRequest(code);
        }
        return value == 0.0 ? 0.0 : value;
    }

    private Double optionalNumber(JsonNode parent, String field, double min, double max, String code) {
        JsonNode node = parent.get(field);
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (!node.isNumber()) {
            throw badRequest(code);
        }
        double value = node.doubleValue();
        if (!Double.isFinite(value) || value < min || value > max) {
            throw badRequest(code);
        }
        return value == 0.0 ? 0.0 : value;
    }

    private String requireIsoTimestamp(JsonNode parent, String field) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isTextual()) {
            throw badRequest("INVALID_TIMESTAMP");
        }
        String raw = node.asText();
        if (raw.length() < 10 || raw.length() > 40) {
            throw badRequest("INVALID_TIMESTAMP");
        }
        try {
            Instant instant = OffsetDateTime.parse(raw).toInstant();
            if (instant.isBefore(MIN_TIMESTAMP) || instant.isAfter(MAX_TIMESTAMP)) {
                throw badRequest("INVALID_TIMESTAMP");
            }
            return instant.toString();
        } catch (DateTimeParseException e) {
            throw badRequest("INVALID_TIMESTAMP");
        }
    }

    private void ensureWithinByteLimit(JsonNode node) {
        try {
            byte[] rawBytes = objectMapper.writeValueAsBytes(node);
            if (rawBytes.length > MAX_STATE_BYTES) {
                throw badRequest("PAYLOAD_TOO_LARGE");
            }
        } catch (JsonProcessingException e) {
            throw badRequest("INVALID_STATE");
        }
    }

    private String serializeChecked(ObjectNode node) {
        try {
            byte[] bytes = objectMapper.writeValueAsBytes(node);
            if (bytes.length > MAX_STATE_BYTES) {
                throw badRequest("PAYLOAD_TOO_LARGE");
            }
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize validated background preferences", e);
        }
    }

    private static void putNumber(ObjectNode target, String field, double value) {
        if (value == Math.floor(value) && value >= Long.MIN_VALUE && value <= Long.MAX_VALUE) {
            target.put(field, (long) value);
        } else {
            target.put(field, value);
        }
    }

    private static BackgroundPreferenceException badRequest(String code) {
        return new BackgroundPreferenceException(400, code);
    }
}
