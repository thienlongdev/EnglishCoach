package com.englishcoach.background;

import com.englishcoach.background.BackgroundPreferenceDtos.BackgroundPreferencesResponse;
import com.englishcoach.background.BackgroundPreferenceDtos.SaveBackgroundPreferencesRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.DoubleNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Real PostgreSQL 17 integration tests for V139 ({@code public.user_background_preferences}) after V94,
 * exercised through the least-privilege {@code english_coach_app} role exactly as production runs.
 */
class BackgroundPreferencePostgresTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static DriverManagerDataSource raw;
    private static DriverManagerDataSource app;
    private static TransactionTemplate tx;
    private static BackgroundPreferenceService service;

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 12) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V139__user_background_preferences.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            // Re-run V139 to verify idempotency.
            st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V139__user_background_preferences.sql")));
            st.execute("ALTER ROLE english_coach_app PASSWORD 'background-test-only'");
        }
        app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "background-test-only");
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        service = freshService();
    }

    private static BackgroundPreferenceService freshService() {
        return new BackgroundPreferenceService(
                new BackgroundPreferenceRepository(new JdbcTemplate(app), JSON),
                new BackgroundPreferenceValidator(JSON));
    }

    private static <T> T inTx(Supplier<T> work) {
        return tx.execute(s -> work.get());
    }

    private static BackgroundPreferenceException expectError(Runnable call) {
        try {
            call.run();
        } catch (BackgroundPreferenceException e) {
            return e;
        }
        throw new AssertionError("Expected BackgroundPreferenceException");
    }

    private static ObjectNode validStop(String id, String color, double position, double opacity, Double x, Double y) {
        ObjectNode stop = JSON.createObjectNode();
        stop.put("id", id);
        stop.put("color", color);
        stop.put("position", position);
        stop.put("opacity", opacity);
        if (x != null) stop.put("x", x);
        if (y != null) stop.put("y", y);
        return stop;
    }

    private static ObjectNode validConfig() {
        ObjectNode color = JSON.createObjectNode();
        color.put("gradientType", "mesh");
        ArrayNode stops = color.putArray("stops");
        stops.add(validStop("stop-1", "#0B1633", 0, 1.0, 15.0, 20.0));
        stops.add(validStop("stop-2", "#2DE2E6", 55, 0.85, 68.0, 42.0));
        stops.add(validStop("stop-3", "#8A63D2", 100, 0.9, 84.0, 82.0));
        color.put("gradientAngle", 135);
        color.put("centerX", 50);
        color.put("centerY", 48);
        color.put("gradientSpread", 72);
        color.put("blendMode", "soft-light");
        color.put("blendIntensity", 55);
        color.put("baseLayerOpacity", 100);
        color.put("depthLayerOpacity", 65);
        color.put("brightness", 104);
        color.put("saturation", 118);
        color.put("contrast", 102);
        color.put("opacity", 96);
        color.put("blur", 6);
        color.put("glow", 48);
        color.put("colorIntensity", 85);

        ObjectNode motion = JSON.createObjectNode();
        ArrayNode effects = motion.putArray("effects");
        effects.add("pearl-shimmer");
        effects.add("ambient-glow");
        effects.add("light-drift");
        motion.put("animationSpeed", 0.85);
        motion.put("motionIntensity", 62);
        motion.put("lightIntensity", 58);
        motion.put("movementDirection", 215);
        motion.put("movementScale", 110);
        motion.put("glowRadius", 64);
        motion.put("shimmerIntensity", 52);
        motion.put("animationSmoothness", 88);
        motion.put("performanceMode", "auto");

        ObjectNode config = JSON.createObjectNode();
        config.set("color", color);
        config.set("motion", motion);
        config.put("grainOpacity", 18);
        return config;
    }

    private static ObjectNode validTheme(String id, String name) {
        ObjectNode theme = JSON.createObjectNode();
        theme.put("id", id);
        theme.put("name", name);
        theme.put("favorite", true);
        theme.put("basedOnPresetId", "pearlescent-abyss");
        theme.set("config", validConfig());
        theme.put("createdAt", "2026-11-23T11:30:00Z");
        theme.put("updatedAt", "2026-11-23T11:45:00Z");
        return theme;
    }

    private static ObjectNode validState() {
        ObjectNode state = JSON.createObjectNode();
        state.put("schemaVersion", 1);
        state.put("activeSource", "custom");
        state.put("activeThemeId", "my-pearl-01");
        state.set("activeConfig", validConfig());
        ArrayNode favorites = state.putArray("favoritePresetIds");
        favorites.add("pearlescent-abyss");
        favorites.add("aurora-flow");
        ArrayNode themes = state.putArray("customThemes");
        themes.add(validTheme("my-pearl-01", "Pearlescent Study"));
        return state;
    }

    @Test
    void defaultReadWhenAbsentReturnsEmptyCanonicalState() {
        BackgroundPreferencesResponse response = service.get(1);
        assertThat(response.schemaVersion()).isEqualTo(1);
        assertThat(response.revision()).isZero();
        assertThat(response.updatedAt()).isNull();
        assertThat(response.state().get("schemaVersion").asInt()).isEqualTo(1);
        assertThat(response.state().get("activeSource").asText()).isEqualTo("none");
        assertThat(response.state().get("activeThemeId").isNull()).isTrue();
        assertThat(response.state().get("activeConfig").isNull()).isTrue();
        assertThat(response.state().get("favoritePresetIds")).isEmpty();
        assertThat(response.state().get("customThemes")).isEmpty();
    }

    @Test
    void saveAndCrossSessionReadPersistAndIncrementRevision() {
        ObjectNode firstState = validState();
        BackgroundPreferencesResponse saved = inTx(() -> service.save(2, new SaveBackgroundPreferencesRequest(1, firstState)));
        assertThat(saved.schemaVersion()).isEqualTo(1);
        assertThat(saved.revision()).isEqualTo(1L);
        assertThat(saved.updatedAt()).isNotNull();
        assertThat(saved.state().get("activeThemeId").asText()).isEqualTo("my-pearl-01");
        assertThat(saved.state().get("activeConfig").get("color").get("stops").get(0).get("color").asText()).isEqualTo("#0b1633");

        // Fresh service instance simulates a new login / another device.
        BackgroundPreferenceService later = freshService();
        BackgroundPreferencesResponse loaded = later.get(2);
        assertThat(loaded.revision()).isEqualTo(1L);
        assertThat(loaded.state()).isEqualTo(saved.state());
        assertThat(loaded.updatedAt()).isEqualTo(saved.updatedAt());

        // Second save omits top-level schemaVersion (relying on state.schemaVersion = 1) and increments revision.
        ObjectNode secondState = validState();
        secondState.put("activeSource", "preset");
        secondState.put("activeThemeId", "aurora-flow");
        secondState.putNull("activeConfig");
        BackgroundPreferencesResponse updated = inTx(() -> later.save(2, new SaveBackgroundPreferencesRequest(null, secondState)));
        assertThat(updated.revision()).isEqualTo(2L);
        assertThat(updated.state().get("activeSource").asText()).isEqualTo("preset");
        assertThat(updated.state().get("activeThemeId").asText()).isEqualTo("aurora-flow");
        assertThat(updated.state().get("activeConfig").isNull()).isTrue();
        assertThat(service.get(2).revision()).isEqualTo(2L);
    }

    @Test
    void strictUserIsolationAcrossReadWriteAndDelete() {
        ObjectNode userAState = validState();
        userAState.put("activeThemeId", "user-a-theme");
        ((ObjectNode) userAState.get("customThemes").get(0)).put("id", "user-a-theme").put("name", "User A Theme");

        ObjectNode userBState = validState();
        userBState.put("activeSource", "preset");
        userBState.put("activeThemeId", "oceanic-glow");
        ((ObjectNode) userBState.get("customThemes").get(0)).put("id", "user-b-theme").put("name", "User B Theme");

        inTx(() -> service.save(3, new SaveBackgroundPreferencesRequest(1, userAState)));

        // User B sees nothing from User A.
        assertThat(service.get(4).revision()).isZero();
        assertThat(service.get(4).state().get("customThemes")).isEmpty();

        inTx(() -> service.save(4, new SaveBackgroundPreferencesRequest(1, userBState)));

        assertThat(service.get(3).state().get("activeThemeId").asText()).isEqualTo("user-a-theme");
        assertThat(service.get(3).state().get("customThemes").get(0).get("name").asText()).isEqualTo("User A Theme");
        assertThat(service.get(4).state().get("activeThemeId").asText()).isEqualTo("oceanic-glow");
        assertThat(service.get(4).state().get("customThemes").get(0).get("name").asText()).isEqualTo("User B Theme");

        // Deleting User B never touches User A.
        inTx(() -> {
            service.reset(4);
            return null;
        });
        assertThat(service.get(4).revision()).isZero();
        assertThat(service.get(3).revision()).isEqualTo(1L);
        assertThat(service.get(3).state().get("activeThemeId").asText()).isEqualTo("user-a-theme");
    }

    @Test
    void invalidPayloadsAreRejectedWith400AndStableErrorCodes() {
        // Invalid colors
        for (String badColor : List.of("#fff", "rgb(10,20,30)", "#GGGGGG", "red", "url(javascript:alert(1))", "")) {
            ObjectNode st = validState();
            ((ObjectNode) st.get("activeConfig").get("color").get("stops").get(0)).put("color", badColor);
            BackgroundPreferenceException ex = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, st)));
            assertThat(ex.status()).as("color=" + badColor).isEqualTo(400);
            assertThat(ex.code()).isEqualTo("INVALID_COLOR");
        }

        // Out-of-range sliders + NaN / Infinity
        ObjectNode badBrightness = validState();
        ((ObjectNode) badBrightness.get("activeConfig").get("color")).put("brightness", 151);
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badBrightness))).status()).isEqualTo(400);

        ObjectNode badOpacity = validState();
        ((ObjectNode) badOpacity.get("activeConfig").get("color")).put("opacity", 14);
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badOpacity))).status()).isEqualTo(400);

        ObjectNode badSpeed = validState();
        ((ObjectNode) badSpeed.get("activeConfig").get("motion")).put("animationSpeed", 2.6);
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badSpeed))).status()).isEqualTo(400);

        ObjectNode nanSlider = validState();
        ((ObjectNode) nanSlider.get("activeConfig").get("color")).set("blur", DoubleNode.valueOf(Double.NaN));
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, nanSlider))).status()).isEqualTo(400);

        ObjectNode infSlider = validState();
        ((ObjectNode) infSlider.get("activeConfig").get("motion")).set("glowRadius", DoubleNode.valueOf(Double.POSITIVE_INFINITY));
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, infSlider))).status()).isEqualTo(400);

        // < 2 stops
        ObjectNode oneStop = validState();
        ArrayNode shortStops = ((ObjectNode) oneStop.get("activeConfig").get("color")).putArray("stops");
        shortStops.add(validStop("s1", "#112233", 0, 1.0, null, null));
        BackgroundPreferenceException oneStopEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, oneStop)));
        assertThat(oneStopEx.status()).isEqualTo(400);
        assertThat(oneStopEx.code()).isEqualTo("INVALID_COLOR_STOPS");

        // > 8 stops
        ObjectNode nineStops = validState();
        ArrayNode manyStops = ((ObjectNode) nineStops.get("activeConfig").get("color")).putArray("stops");
        for (int i = 0; i < 9; i++) {
            manyStops.add(validStop("s" + i, "#112233", i * 10, 1.0, null, null));
        }
        BackgroundPreferenceException nineStopsEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, nineStops)));
        assertThat(nineStopsEx.status()).isEqualTo(400);
        assertThat(nineStopsEx.code()).isEqualTo("INVALID_COLOR_STOPS");

        // > 40 custom themes
        ObjectNode tooManyThemes = validState();
        ArrayNode themes = tooManyThemes.putArray("customThemes");
        for (int i = 0; i < 41; i++) {
            themes.add(validTheme("theme-" + i, "Theme " + i));
        }
        BackgroundPreferenceException themesEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, tooManyThemes)));
        assertThat(themesEx.status()).isEqualTo(400);
        assertThat(themesEx.code()).isEqualTo("TOO_MANY_CUSTOM_THEMES");

        // Unknown blendMode
        ObjectNode badBlend = validState();
        ((ObjectNode) badBlend.get("activeConfig").get("color")).put("blendMode", "exclusion");
        BackgroundPreferenceException blendEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badBlend)));
        assertThat(blendEx.status()).isEqualTo(400);
        assertThat(blendEx.code()).isEqualTo("INVALID_BLEND_MODE");

        // Unknown effect
        ObjectNode badEffect = validState();
        ((ObjectNode) badEffect.get("activeConfig").get("motion")).putArray("effects").add("matrix-rain");
        assertThat(expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badEffect))).code())
                .isEqualTo("INVALID_MOTION_EFFECT");

        // XSS-ish & control-char-only theme names rejected cleanly
        for (String badName : List.of(
                "<script>alert(1)</script>",
                "<img src=x onerror=alert(1)>",
                "\u0000\u0001\r\n   ",
                "   ",
                "x".repeat(61))) {
            ObjectNode badNameState = validState();
            ((ObjectNode) badNameState.get("customThemes").get(0)).put("name", badName);
            BackgroundPreferenceException nameEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, badNameState)));
            assertThat(nameEx.status()).as("name=" + badName).isEqualTo(400);
            assertThat(nameEx.code()).isEqualTo("INVALID_THEME_NAME");
        }

        // Oversized JSON (> 240 KB) rejected cleanly with HTTP 400
        ObjectNode oversized = validState();
        oversized.put("paddingBlob", "A".repeat(BackgroundPreferenceValidator.MAX_STATE_BYTES + 1024));
        BackgroundPreferenceException sizeEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(1, oversized)));
        assertThat(sizeEx.status()).isEqualTo(400);
        assertThat(sizeEx.code()).isEqualTo("PAYLOAD_TOO_LARGE");

        // Invalid schemaVersion rejected
        BackgroundPreferenceException verEx = expectError(() -> service.save(5, new SaveBackgroundPreferencesRequest(2, validState())));
        assertThat(verEx.status()).isEqualTo(400);
        assertThat(verEx.code()).isEqualTo("INVALID_SCHEMA_VERSION");

        // Nothing invalid was persisted
        assertThat(service.get(5).revision()).isZero();
    }

    @Test
    void unknownJsonFieldsAreStrippedAndControlCharsSanitizedOnReserialization() {
        ObjectNode dirty = validState();
        dirty.put("evilTopField", "drop-me");
        dirty.put("__proto__", "polluted");
        dirty.put("constructor", "bad");
        ((ArrayNode) dirty.get("favoritePresetIds")).add("pearlescent-abyss"); // duplicate

        ObjectNode theme = (ObjectNode) dirty.get("customThemes").get(0);
        theme.put("name", "  Bình minh\u0000\u202E đại dương  ");
        theme.put("extraThemeBlob", "strip-me");
        ((ObjectNode) theme.get("config")).put("extraConfigField", 123);
        ((ObjectNode) theme.get("config").get("color")).put("secretColorFlag", true);
        ((ObjectNode) theme.get("config").get("color").get("stops").get(0)).put("unknownStopKey", "gone");
        ((ObjectNode) theme.get("config").get("motion")).put("unknownMotionKey", "gone");
        ((ArrayNode) theme.get("config").get("motion").get("effects")).add("pearl-shimmer"); // duplicate

        BackgroundPreferencesResponse saved = inTx(() -> service.save(6, new SaveBackgroundPreferencesRequest(1, dirty)));
        JsonNode persisted = freshService().get(6).state();

        assertThat(persisted.has("evilTopField")).isFalse();
        assertThat(persisted.has("__proto__")).isFalse();
        assertThat(persisted.has("constructor")).isFalse();
        assertThat(persisted.get("favoritePresetIds")).hasSize(2);

        JsonNode persistedTheme = persisted.get("customThemes").get(0);
        assertThat(persistedTheme.get("name").asText()).isEqualTo("Bình minh đại dương");
        assertThat(persistedTheme.has("extraThemeBlob")).isFalse();
        assertThat(persistedTheme.get("config").has("extraConfigField")).isFalse();
        assertThat(persistedTheme.get("config").get("color").has("secretColorFlag")).isFalse();
        assertThat(persistedTheme.get("config").get("color").get("stops").get(0).has("unknownStopKey")).isFalse();
        assertThat(persistedTheme.get("config").get("motion").has("unknownMotionKey")).isFalse();
        assertThat(persistedTheme.get("config").get("motion").get("effects")).hasSize(3);
    }

    @Test
    void deleteResetIsIdempotentAndRestoresDefaultState() {
        inTx(() -> service.save(7, new SaveBackgroundPreferencesRequest(1, validState())));
        assertThat(service.get(7).revision()).isEqualTo(1L);

        inTx(() -> {
            service.reset(7);
            return null;
        });
        assertThat(service.get(7).revision()).isZero();
        assertThat(service.get(7).updatedAt()).isNull();
        assertThat(service.get(7).state().get("activeSource").asText()).isEqualTo("none");

        // Second delete when absent is an idempotent no-op.
        inTx(() -> {
            service.reset(7);
            return null;
        });
        assertThat(service.get(7).revision()).isZero();

        // Saving again after delete begins cleanly at revision 1.
        BackgroundPreferencesResponse resaved = inTx(() -> service.save(7, new SaveBackgroundPreferencesRequest(1, validState())));
        assertThat(resaved.revision()).isEqualTo(1L);
    }

    @Test
    void concurrentSavesSerializeCleanlyWithAdvisoryLock() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(6);
        List<Future<Long>> futures = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            int angle = (i * 30) % 360;
            futures.add(pool.submit(() -> {
                ObjectNode state = validState();
                ((ObjectNode) state.get("activeConfig").get("color")).put("gradientAngle", angle);
                return inTx(() -> service.save(8, new SaveBackgroundPreferencesRequest(1, state))).revision();
            }));
        }
        List<Long> revisions = new ArrayList<>();
        for (Future<Long> f : futures) {
            revisions.add(f.get(30, TimeUnit.SECONDS));
        }
        pool.shutdown();
        assertThat(revisions).containsExactlyInAnyOrder(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L, 10L, 11L, 12L);
        assertThat(service.get(8).revision()).isEqualTo(12L);
    }

    @Test
    void controllerEnforcesPrincipalAndNoStoreCachingAndHandlerReturnsStableCode() {
        BackgroundPreferenceController controller = new BackgroundPreferenceController(service);
        BackgroundPreferenceExceptionHandler handler = new BackgroundPreferenceExceptionHandler();

        BackgroundPreferenceException authEx = expectError(() -> controller.get(null));
        assertThat(authEx.status()).isEqualTo(401);
        assertThat(authEx.code()).isEqualTo("AUTH_REQUIRED");

        ResponseEntity<Map<String, String>> errResp = handler.domain(authEx);
        assertThat(errResp.getStatusCode().value()).isEqualTo(401);
        assertThat(errResp.getHeaders().getCacheControl()).contains("no-store");
        assertThat(errResp.getBody()).containsEntry("code", "AUTH_REQUIRED");
    }

    @Test
    void databaseEnforcesConstraintsLeastPrivilegeAndOnDeleteRestrict() {
        JdbcTemplate appJdbc = new JdbcTemplate(app);
        JdbcTemplate ownerJdbc = new JdbcTemplate(raw);

        String insert = "INSERT INTO public.user_background_preferences (user_id, schema_version, revision, state) VALUES (?, ?, ?, ?::jsonb)";
        // Invalid schema_version
        assertThatThrownBy(() -> appJdbc.update(insert, 9L, 0, 1L, "{}")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> appJdbc.update(insert, 9L, 11, 1L, "{}")).isInstanceOf(DataIntegrityViolationException.class);
        // Invalid revision
        assertThatThrownBy(() -> appJdbc.update(insert, 9L, 1, 0L, "{}")).isInstanceOf(DataIntegrityViolationException.class);
        // Non-object JSONB
        assertThatThrownBy(() -> appJdbc.update(insert, 9L, 1, 1L, "[]")).isInstanceOf(DataIntegrityViolationException.class);
        // Oversized JSONB (> 262144 bytes)
        String hugeJson = "{\"x\":\"" + "a".repeat(262150) + "\"}";
        assertThatThrownBy(() -> appJdbc.update(insert, 9L, 1, 1L, hugeJson)).isInstanceOf(DataIntegrityViolationException.class);

        // Insert valid row for user 9, then verify ON DELETE RESTRICT blocks deleting user 9.
        inTx(() -> service.save(9, new SaveBackgroundPreferencesRequest(1, validState())));
        assertThatThrownBy(() -> ownerJdbc.update("DELETE FROM public.users WHERE id = 9"))
                .isInstanceOf(DataIntegrityViolationException.class);

        // Least-privilege runtime role cannot run DDL.
        assertThatThrownBy(() -> appJdbc.execute("ALTER TABLE public.user_background_preferences ADD COLUMN extra INT"))
                .isInstanceOf(Exception.class);
    }
}
