package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeDtos.SaveWorldRequest;
import com.englishcoach.echolife.EchoLifeDtos.World;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The real V129 schema on PostgreSQL 17 (after V94 and V110), through the least-privilege application role: the world save is
 * the learner's own (another learner's spaces never enter it), revisions refuse a stale write with the current document, every
 * number and id is checked, and the study-space layout is never touched.
 */
class EchoLifeWorldPostgresTest {

    private static PostgreSQLContainer<?> pg;
    private static TransactionTemplate tx;
    private static EchoLifeService worlds;
    private static JdbcTemplate jdbc;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID MINE = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID MINE_TOO = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID THEIRS = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID RESTART_SPACE = UUID.fromString("44444444-4444-4444-8444-444444444444");

    @BeforeAll
    static void start() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 12) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V110__study_space.sql", "V129__echo_life_world.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'echo-life-test-only'");
        }
        DriverManagerDataSource app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "echo-life-test-only");
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        jdbc = new JdbcTemplate(app);
        for (Object[] row : new Object[][]{{MINE, 1}, {MINE_TOO, 1}, {THEIRS, 2}, {RESTART_SPACE, 10}}) {
            jdbc.update("INSERT INTO public.study_spaces (id, user_id, name, layout) VALUES (?, ?, 'Phòng', '{\"v\":1,\"objects\":[]}'::jsonb)", row[0], row[1]);
        }
        worlds = new EchoLifeService(new EchoLifeRepository(jdbc, JSON));
    }

    private static <T> T inTx(Supplier<T> work) {
        return tx.execute(s -> work.get());
    }

    private static EchoLifeException refused(Runnable call) {
        try {
            tx.executeWithoutResult(s -> call.run());
        } catch (EchoLifeException e) {
            return e;
        }
        return null;
    }

    private static ObjectNode world() {
        ObjectNode s = JSON.createObjectNode().put("v", 1);
        s.putObject("places");
        s.putObject("doors");
        s.putObject("objects");
        return s;
    }

    private static ObjectNode place(ObjectNode s, UUID space, double x, double z, String region, long at) {
        ((ObjectNode) s.get("places")).putObject(space.toString()).put("x", x).put("y", -3.2).put("z", z).put("rotY", 1.2).put("region", region).put("at", at);
        return s;
    }

    @Test
    void emptyWorldThenSaveAndReadBack() {
        World none = inTx(() -> worlds.get(5));
        assertThat(none.revision()).isZero();
        assertThat(none.updatedAt()).isNull();
        assertThat(none.state().get("places").size()).isZero();

        ObjectNode s = place(world(), MINE, 12.5, 18, "sidewalk", 1000);
        ((ObjectNode) s.get("doors")).putObject("house:" + MINE + ":entrance").put("open", true).put("angle", -1.4).put("at", 1001);
        ((ObjectNode) s.get("doors")).putObject("city:cafe-front").put("open", false).put("angle", 0).put("at", 1002);
        ObjectNode obj = ((ObjectNode) s.get("objects")).putObject(MINE + "/o-mug").putObject("object");
        obj.put("id", "o-mug").put("kind", "mug.ceramic").put("rotY", .3).put("scale", 1);
        obj.putArray("pos").add(6.4).add(.9).add(-1.2);
        obj.putObject("state").put("sips", 3);
        ((ObjectNode) s.get("objects").get(MINE + "/o-mug")).put("region", "living").put("at", 1003);

        World saved = inTx(() -> worlds.save(1, new SaveWorldRequest(s, 0L)));
        assertThat(saved.revision()).isEqualTo(1);
        World back = inTx(() -> worlds.get(1));
        assertThat(back.state().at("/places/" + MINE + "/x").asDouble()).isEqualTo(12.5);
        assertThat(back.state().at("/doors/house:" + MINE + ":entrance/open").asBoolean()).isTrue();
        assertThat(back.state().at("/doors/city:cafe-front/open").asBoolean()).isFalse();
        assertThat(back.state().at("/objects/" + MINE + "~1o-mug/object/state/sips").asInt()).isEqualTo(3);
        assertThat(back.state().at("/objects/" + MINE + "~1o-mug/region").asText()).isEqualTo("living");
        // The study-space layout is the room's own record: the world save never writes it.
        assertThat(jdbc.queryForObject("SELECT layout::text FROM public.study_spaces WHERE id = ?", String.class, MINE)).doesNotContain("o-mug");
    }

    @Test
    void anotherLearnersSpaceNeverEntersAWorld() {
        ObjectNode s = place(place(world(), MINE_TOO, 1, 2, "street", 5), THEIRS, 3, 4, "street", 5);
        ((ObjectNode) s.get("doors")).putObject("house:" + THEIRS + ":hall").put("open", true).put("angle", 1).put("at", 6);
        World saved = inTx(() -> worlds.save(3, new SaveWorldRequest(s, null)));
        // Learner 3 owns no space at all: every space-keyed entry is dropped, nothing of learner 1 or 2 appears.
        assertThat(saved.state().get("places").size()).isZero();
        assertThat(saved.state().get("doors").size()).isZero();
        // Learner 2 sees only its own space; learner 1's world is not readable by anyone else.
        World two = inTx(() -> worlds.save(2, new SaveWorldRequest(place(place(world(), MINE, 1, 1, "street", 1), THEIRS, 2, 2, "street", 1), null)));
        assertThat(two.state().get("places").has(THEIRS.toString())).isTrue();
        assertThat(two.state().get("places").has(MINE.toString())).isFalse();
        assertThat(inTx(() -> worlds.get(4)).revision()).isZero();
    }

    @Test
    void staleWriteAnswersTheCurrentWorldAndChangesNothing() {
        World first = inTx(() -> worlds.save(6, new SaveWorldRequest(world(), 0L)));
        assertThat(first.revision()).isEqualTo(1);
        World second = inTx(() -> worlds.save(6, new SaveWorldRequest(world(), 1L)));
        assertThat(second.revision()).isEqualTo(2);
        EchoLifeException stale = refused(() -> worlds.save(6, new SaveWorldRequest(world(), 1L)));
        assertThat(stale).isNotNull();
        assertThat(stale.status).isEqualTo(409);
        assertThat(stale.code).isEqualTo("STALE_REVISION");
        assertThat(stale.current.revision()).isEqualTo(2);
        // A first save that claims a revision is stale too.
        EchoLifeException ghost = refused(() -> worlds.save(7, new SaveWorldRequest(world(), 4L)));
        assertThat(ghost.status).isEqualTo(409);
        assertThat(ghost.current.revision()).isZero();
        assertThat(inTx(() -> worlds.get(6)).revision()).isEqualTo(2);
    }

    @Test
    void malformedDocumentsAreRefusedWholesale() throws Exception {
        List<String> bad = List.of(
                "{\"v\":2}", "{\"v\":1,\"credits\":999999}", "[]",
                "{\"v\":1,\"places\":{\"not-a-uuid\":{\"x\":0,\"z\":0,\"rotY\":0,\"region\":\"street\",\"at\":1}}}",
                "{\"v\":1,\"places\":{\"" + MINE + "\":{\"x\":1e9,\"z\":0,\"rotY\":0,\"region\":\"street\",\"at\":1}}}",
                "{\"v\":1,\"places\":{\"" + MINE + "\":{\"x\":0,\"z\":0,\"rotY\":0,\"region\":\"<script>\",\"at\":1}}}",
                "{\"v\":1,\"doors\":{\"bank:vault\":{\"open\":true,\"angle\":0,\"at\":1}}}",
                "{\"v\":1,\"doors\":{\"city:shop\":{\"open\":\"yes\",\"angle\":0,\"at\":1}}}",
                "{\"v\":1,\"objects\":{\"" + MINE + "/o-1\":{\"object\":{\"id\":\"o-2\",\"kind\":\"mug\",\"pos\":[0,0,0],\"rotY\":0},\"region\":\"living\",\"at\":1}}}",
                "{\"v\":1,\"objects\":{\"" + MINE + "/o-1\":{\"object\":{\"id\":\"o-1\",\"kind\":\"mug\",\"pos\":[0,0,0],\"rotY\":0,\"owner\":7},\"region\":\"living\",\"at\":1}}}",
                "{\"v\":1,\"objects\":{\"" + MINE + "/o-1\":{\"object\":{\"id\":\"o-1\",\"kind\":\"mug\",\"pos\":[0,0],\"rotY\":0},\"region\":\"living\",\"at\":1}}}");
        for (String text : bad) {
            JsonNode s = JSON.readTree(text);
            EchoLifeException e = refused(() -> worlds.save(8, new SaveWorldRequest(s, 0L)));
            assertThat(e).as(text).isNotNull();
            assertThat(e.status).as(text).isEqualTo(400);
        }
        ObjectNode huge = world();
        huge.putObject("places");
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 105_000; i++) big.append('x');
        huge.put("padding", big.toString());
        assertThat(refused(() -> worlds.save(8, new SaveWorldRequest(huge, 0L))).status).isEqualTo(413);
        assertThat(inTx(() -> worlds.get(8)).revision()).isZero();
    }

    @Test
    void characterCreatorAvatarPersistsInWorldJsonbAndComputesServerWireCode() {
        ObjectNode s = world();
        ObjectNode av = s.putObject("avatar");
        av.put("version", 2).put("hero", "KAI").put("hairId", "side_part")
                .put("hairColor", "#3A2A22").put("skinTone", "#CB9578").put("irisColor", "#2D4F6C");
        av.putObject("face").put("jawWidth", 0.2).put("eyeSize", -0.1);
        av.putObject("body").put("heightScale", 1.05).put("buildScale", 1.02);
        var o0 = av.putArray("outfits").addObject();
        o0.put("slot", "everyday").put("name", "Library Smart").put("top", "shirt").put("bottom", "chinos").put("shoes", "loafers");
        o0.putArray("accessories").add("glasses");
        o0.putObject("colors").put("top", "#F2EFE9").put("bottom", "#54657F").put("shoes", "#8A5A3B");
        o0.putObject("fabrics").put("top", "cotton").put("bottom", "canvas");
        o0.putObject("patterns").put("top", "solid");
        av.put("activeOutfit", 0).put("autoSeasonalOutfit", true);

        World saved = inTx(() -> worlds.save(11, new SaveWorldRequest(s, 0L)));
        assertThat(saved.revision()).isEqualTo(1);
        String wire = saved.state().at("/avatar/wireCode").asText();
        assertThat(com.englishcoach.common.AvatarLookCode.isV2(wire)).isTrue();

        World loaded = inTx(() -> worlds.get(11));
        assertThat(loaded.state().at("/avatar/hero").asText()).isEqualTo("KAI");
        assertThat(loaded.state().at("/avatar/wireCode").asText()).isEqualTo(wire);

        // Malicious avatar payload is refused without mutating the stored row.
        ObjectNode bad = world();
        bad.putObject("avatar").put("version", 2).put("hero", "KAI").put("hairId", "https://evil.example/h.glb")
                .put("hairColor", "#3a2a22").put("skinTone", "#cb9578").put("irisColor", "#2d4f6c")
                .put("activeOutfit", 0).putArray("outfits");
        EchoLifeException rejected = refused(() -> worlds.save(11, new SaveWorldRequest(bad, 1L)));
        assertThat(rejected).isNotNull();
        assertThat(rejected.status).isEqualTo(400);
        assertThat(inTx(() -> worlds.get(11)).revision()).isEqualTo(1);
    }

    @Test
    void aWorldWrittenByANewerReleaseIsNeverOverwritten() {
        jdbc.update("INSERT INTO public.echo_life_worlds (user_id, save_version, revision, state) VALUES (9, 7, 3, '{\"v\":7,\"future\":true}'::jsonb)");
        World w = inTx(() -> worlds.get(9));
        assertThat(w.saveVersion()).isEqualTo(7);
        assertThat(w.state().path("future").asBoolean()).isTrue();
        EchoLifeException e = refused(() -> worlds.save(9, new SaveWorldRequest(world(), 3L)));
        assertThat(e.status).isEqualTo(409);
        assertThat(e.code).isEqualTo("SAVE_VERSION_UNSUPPORTED");
        assertThat(jdbc.queryForObject("SELECT revision FROM public.echo_life_worlds WHERE user_id = 9", Long.class)).isEqualTo(3);
    }

    @Test
    void persistedWorldSurvivesFreshServiceAndRepositoryRestart() {
        ObjectNode s = place(world(), RESTART_SPACE, 145.5, -82.25, "library", 2000);
        ((ObjectNode) s.get("doors")).putObject("city:library-main").put("open", true).put("angle", -1.28).put("at", 2001);
        ObjectNode obj = ((ObjectNode) s.get("objects")).putObject(RESTART_SPACE + "/o-book").putObject("object");
        obj.put("id", "o-book").put("kind", "books.stack").put("rotY", .5).put("scale", 1).put("color", "#446688");
        obj.putArray("pos").add(5.2).add(0.0).add(-1.4);
        obj.putArray("drawers").add(0.5);
        ((ObjectNode) s.get("objects").get(RESTART_SPACE + "/o-book")).put("region", "living").put("at", 2002);

        World beforeRestart = inTx(() -> worlds.save(10, new SaveWorldRequest(s, 0L)));

        // Simulate a backend process restart: brand new datasource, repository and service instances.
        DriverManagerDataSource freshDs = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "echo-life-test-only");
        TransactionTemplate freshTx = new TransactionTemplate(new DataSourceTransactionManager(freshDs));
        EchoLifeService restarted = new EchoLifeService(new EchoLifeRepository(new JdbcTemplate(freshDs), new ObjectMapper()));

        World afterRestart = freshTx.execute(st -> restarted.get(10));
        assertThat(afterRestart).isNotNull();
        assertThat(afterRestart.revision()).isEqualTo(beforeRestart.revision());
        assertThat(afterRestart.state().at("/places/" + RESTART_SPACE + "/region").asText()).isEqualTo("library");
        assertThat(afterRestart.state().at("/places/" + RESTART_SPACE + "/x").asDouble()).isEqualTo(145.5);
        assertThat(afterRestart.state().at("/doors/city:library-main/open").asBoolean()).isTrue();
        assertThat(afterRestart.state().at("/objects/" + RESTART_SPACE + "~1o-book/region").asText()).isEqualTo("living");
    }

    @Test
    void runtimeRoleCannotExecuteDdlOrTruncateOnWorldTable() {
        assertThat(org.assertj.core.api.Assertions.catchThrowable(() ->
                jdbc.execute("TRUNCATE TABLE public.echo_life_worlds"))).isNotNull();
        assertThat(org.assertj.core.api.Assertions.catchThrowable(() ->
                jdbc.execute("DROP TABLE public.echo_life_worlds"))).isNotNull();
    }

    @Test
    void invalidObjectFieldTypesAreRefused() throws Exception {
        List<String> badObjects = List.of(
                "{\"v\":1,\"objects\":{\"" + RESTART_SPACE + "/o-1\":{\"object\":{\"id\":\"o-1\",\"kind\":\"mug\",\"pos\":[0,0,0],\"rotY\":0,\"drawers\":[2.5]},\"region\":\"living\",\"at\":1}}}",
                "{\"v\":1,\"objects\":{\"" + RESTART_SPACE + "/o-1\":{\"object\":{\"id\":\"o-1\",\"kind\":\"mug\",\"pos\":[0,0,0],\"rotY\":0,\"color\":123},\"region\":\"living\",\"at\":1}}}",
                "{\"v\":1,\"objects\":{\"" + RESTART_SPACE + "/o-1\":{\"object\":{\"id\":\"o-1\",\"kind\":\"mug\",\"pos\":[0,0,0],\"rotY\":0,\"action\":42},\"region\":\"living\",\"at\":1}}}"
        );
        for (String text : badObjects) {
            JsonNode s = JSON.readTree(text);
            EchoLifeException e = refused(() -> worlds.save(8, new SaveWorldRequest(s, 0L)));
            assertThat(e).as(text).isNotNull();
            assertThat(e.status).as(text).isEqualTo(400);
        }
    }
}
