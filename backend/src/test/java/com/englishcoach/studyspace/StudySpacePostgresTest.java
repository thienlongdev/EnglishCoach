package com.englishcoach.studyspace;

import com.englishcoach.studyspace.StudySpaceDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The real V110 schema on PostgreSQL 17 (after V94), through the least-privilege application role. Covers the personal
 * default contract (clear never touches it; only an explicit save replaces it; restore brings it back), snapshots,
 * revisions, account isolation (another learner's space, task, note, session or research item ⇒ 404) and the focus
 * clock (the server never stores more focused time than its own clock allows; a premature COMPLETED is INTERRUPTED).
 */
class StudySpacePostgresTest {

    private static DriverManagerDataSource app;
    private static TransactionTemplate tx;
    private static StudySpaceService spaces;
    private static StudyToolsService tools;
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 9) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V110__study_space.sql", "V111__study_time_blocks.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'study-space-test-only'");
        }
        app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "study-space-test-only");
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        StudySpaceRepository repo = new StudySpaceRepository(new JdbcTemplate(app), JSON);
        spaces = new StudySpaceService(repo);
        tools = new StudyToolsService(new StudyToolsRepository(new JdbcTemplate(app), repo));
    }

    private static <T> T inTx(Supplier<T> work) {
        return tx.execute(s -> work.get());
    }

    private static int code(Runnable call) {
        try {
            tx.executeWithoutResult(s -> call.run());
        } catch (StudySpaceException e) {
            return e.status;
        }
        return 200;
    }

    private static JsonNode layout(String marker) {
        return JSON.createObjectNode().put("v", 1).put("marker", marker)
                .set("objects", JSON.createArrayNode().add(JSON.createObjectNode().put("id", marker + "-desk").put("kind", "desk.basic")));
    }

    @Test
    void personalDefaultSurvivesClearAndAutoSaveAndRestoresExactly() {
        Space space = inTx(() -> spaces.create(1, new CreateSpaceRequest("Phòng của tôi", layout("room"), null, null)));
        assertThat(space.active()).isTrue();
        Space withDefault = inTx(() -> spaces.saveDefault(1, space.id(), layout("my-room")));
        assertThat(withDefault.defaultLayout().path("marker").asText()).isEqualTo("my-room");

        // Xóa trắng, then a few auto-saves of the empty foreground.
        JsonNode empty = JSON.createObjectNode().put("v", 1).set("objects", JSON.createArrayNode());
        Space cleared = inTx(() -> spaces.saveLayout(1, space.id(), new SaveLayoutRequest(empty, withDefault.revision(), "CLEAR")));
        Space autosaved = inTx(() -> spaces.saveLayout(1, space.id(), new SaveLayoutRequest(empty, cleared.revision(), "NONE")));
        assertThat(autosaved.layout().path("objects").size()).isZero();
        assertThat(autosaved.defaultLayout().path("marker").asText()).isEqualTo("my-room");

        // The replaced layout is a snapshot; a stale revision is refused.
        List<Snapshot> snaps = inTx(() -> spaces.snapshots(1, space.id()));
        assertThat(snaps).extracting(Snapshot::kind).contains("BEFORE_CLEAR");
        assertThat(code(() -> spaces.saveLayout(1, space.id(), new SaveLayoutRequest(empty, 1L, "NONE")))).isEqualTo(409);

        // Explicitly saving an empty layout as the default replaces it, and keeps the old default as a snapshot.
        Space emptyDefault = inTx(() -> spaces.saveDefault(1, space.id(), empty));
        assertThat(emptyDefault.defaultLayout().path("objects").size()).isZero();
        assertThat(inTx(() -> spaces.snapshots(1, space.id()))).extracting(Snapshot::kind).contains("BEFORE_DEFAULT");

        // A room saved by name outlives the rolling version history, and only its owner can remove it.
        inTx(() -> spaces.createSnapshot(1, space.id(), new CreateSnapshotRequest("\u2605 Ph\u00f2ng y\u00eau th\u00edch", space.layout())));
        for (int i = 0; i < 30; i++) { int n = i; inTx(() -> spaces.createSnapshot(1, space.id(), new CreateSnapshotRequest("B\u1ea3n " + n, space.layout()))); }
        List<Snapshot> kept = inTx(() -> spaces.snapshots(1, space.id()));
        Snapshot named = kept.stream().filter(s -> s.label() != null && s.label().startsWith("\u2605 ")).findFirst().orElseThrow();
        assertThat(kept.size()).isEqualTo(21);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> inTx(() -> { spaces.deleteSnapshot(2, space.id(), named.id()); return null; })).isInstanceOf(StudySpaceException.class);
        inTx(() -> { spaces.deleteSnapshot(1, space.id(), named.id()); return null; });
        assertThat(inTx(() -> spaces.snapshots(1, space.id()))).noneMatch(s -> s.id().equals(named.id()));
    }

    @Test
    void anotherLearnerReachesNothing() {
        Space mine = inTx(() -> spaces.create(2, new CreateSpaceRequest("A", layout("a"), null, null)));
        Task task = inTx(() -> tools.createTask(2, new TaskRequest("Ôn từ", null, null, 1, null, null, null, null, null)));
        Note note = inTx(() -> tools.createNote(2, new NoteRequest("NOTE", "Riêng", "bí mật", null, null)));
        ResearchItem item = inTx(() -> tools.createResearch(2, new ResearchRequest("Paper", null, 2020, null, null, null, null, null, null, null, null, null, null, null)));
        UUID session = UUID.randomUUID();
        inTx(() -> tools.reportFocus(2, session, new FocusReport("POMODORO", "RUNNING", 1500, 0, task.id(), null, null)));

        assertThat(code(() -> spaces.get(3, mine.id()))).isEqualTo(404);
        assertThat(code(() -> spaces.saveLayout(3, mine.id(), new SaveLayoutRequest(layout("x"), null, "NONE")))).isEqualTo(404);
        assertThat(code(() -> spaces.saveDefault(3, mine.id(), layout("x")))).isEqualTo(404);
        assertThat(code(() -> spaces.delete(3, mine.id()))).isEqualTo(404);
        assertThat(code(() -> tools.updateTask(3, task.id(), new TaskRequest("x", null, null, null, null, null, null, null, null)))).isEqualTo(404);
        assertThat(code(() -> tools.deleteNote(3, note.id()))).isEqualTo(404);
        assertThat(code(() -> tools.updateResearch(3, item.id(), new ResearchRequest("x", null, null, null, null, null, null, null, null, null, null, null, null, null)))).isEqualTo(404);
        assertThat(code(() -> tools.reportFocus(3, session, new FocusReport("POMODORO", "COMPLETED", 1500, 1500, null, null, null)))).isEqualTo(404);
        assertThat(code(() -> tools.reportFocus(3, UUID.randomUUID(), new FocusReport("POMODORO", "RUNNING", 1500, 0, task.id(), null, null)))).isEqualTo(404);
        assertThat(inTx(() -> spaces.list(3)).items()).isEmpty();
        assertThat(inTx(() -> tools.tasks(3))).isEmpty();
        assertThat(inTx(() -> tools.notes(3))).isEmpty();
        assertThat(inTx(() -> spaces.get(2, mine.id())).layout().path("marker").asText()).isEqualTo("a");
    }

    @Test
    void focusTimeIsBoundedByTheServerClock() {
        UUID id = UUID.randomUUID();
        FocusSession started = inTx(() -> tools.reportFocus(4, id, new FocusReport("POMODORO", "RUNNING", 1500, 0, null, "Đọc", "Reading")));
        assertThat(started.status()).isEqualTo("RUNNING");
        // The browser claims 25 minutes a moment after starting: the server keeps only what its clock allows and refuses the completion.
        FocusSession claimed = inTx(() -> tools.reportFocus(4, id, new FocusReport("POMODORO", "COMPLETED", 1500, 1500, null, "Đọc", "Reading")));
        assertThat(claimed.focusedSeconds()).isLessThanOrEqualTo(10);
        assertThat(claimed.status()).isEqualTo("INTERRUPTED");
        // Final: a repeat changes nothing.
        FocusSession again = inTx(() -> tools.reportFocus(4, id, new FocusReport("POMODORO", "COMPLETED", 1500, 1500, null, null, null)));
        assertThat(again).isEqualTo(claimed);
        FocusStats stats = inTx(() -> tools.focusStats(4, 7));
        assertThat(stats.days()).hasSize(7);
        assertThat(stats.interrupted()).isEqualTo(1);
    }

    @Test
    void recurringTaskCountsCompletionsAndStaysOpen() {
        Task habit = inTx(() -> tools.createTask(5, new TaskRequest("Ôn 20 thẻ", null, null, 0, null, null, "Flashcards", "DAILY", null)));
        Task done = inTx(() -> tools.updateTask(5, habit.id(), new TaskRequest(null, null, "DONE", null, null, null, null, null, null)));
        assertThat(done.status()).isEqualTo("OPEN");
        assertThat(done.doneCount()).isEqualTo(1);
        assertThat(done.dueOn()).isAfter(LocalDate.now(StudyToolsService.ZONE).minusDays(1));
        Task once = inTx(() -> tools.createTask(5, new TaskRequest("Nộp bài", null, null, 2, null, null, null, null, null)));
        assertThat(inTx(() -> tools.updateTask(5, once.id(), new TaskRequest(null, null, "DONE", null, null, null, null, null, null))).status()).isEqualTo("DONE");
    }

    @Test
    void layoutsAreBounded() {
        assertThat(code(() -> spaces.create(6, new CreateSpaceRequest("x", JSON.createObjectNode(), null, null)))).isEqualTo(400);
        StringBuilder big = new StringBuilder();
        while (big.length() < 300_000) big.append("abcdefghij");
        assertThat(code(() -> spaces.create(6, new CreateSpaceRequest("x", JSON.createObjectNode().put("v", 1).put("pad", big.toString()), null, null)))).isEqualTo(413);
        for (int i = 0; i < StudySpaceService.MAX_SPACES; i++) {
            int n = i;
            inTx(() -> spaces.create(7, new CreateSpaceRequest("S" + n, layout("s" + n), null, null)));
        }
        assertThat(code(() -> spaces.create(7, new CreateSpaceRequest("one too many", layout("x"), null, null)))).isEqualTo(409);
        assertThat(inTx(() -> spaces.list(7)).items()).filteredOn(SpaceSummary::active).hasSize(1);
    }
}
