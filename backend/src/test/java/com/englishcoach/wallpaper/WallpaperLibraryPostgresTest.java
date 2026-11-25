package com.englishcoach.wallpaper;

import com.englishcoach.wallpaper.WallpaperLibraryDtos.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
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
import java.util.UUID;
import java.util.concurrent.*;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The real V103 schema on PostgreSQL 17 (after V94), used as production does: through the least-privilege application
 * role. Covers account isolation (read / change / delete of another learner's entry ⇒ 404), persistence across
 * "sessions" (a fresh service on the same database), duplicates, the per-learner limit under concurrency, the one-time
 * device-list import, link / file-name validation and the database's own constraints.
 */
class WallpaperLibraryPostgresTest {

    private static DriverManagerDataSource raw;
    private static DriverManagerDataSource app;
    private static TransactionTemplate tx;
    private static WallpaperLibraryService service;

    private static final String A = "dQw4w9WgXcQ";
    private static final String B = "M7lc1UVf-VE";

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 9) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V103__wallpaper_youtube_library.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'wallpaper-test-only'");
        }
        app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "wallpaper-test-only");
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        service = freshService();
    }

    /** A new service + repository on the same database: what a later sign-in (or another device) talks to. */
    private static WallpaperLibraryService freshService() {
        return new WallpaperLibraryService(new WallpaperLibraryRepository(new JdbcTemplate(app)));
    }

    private static <T> T inTx(Supplier<T> work) {
        return tx.execute(s -> work.get());
    }

    private static int code(Runnable call) {
        try {
            call.run();
        } catch (WallpaperLibraryException e) {
            return e.status;
        }
        return 200;
    }

    @Test
    void savedEntriesPersistAndStayWithTheirOwner() {
        SaveResponse first = inTx(() -> service.save(1, A));
        assertThat(first.created()).isTrue();
        assertThat(first.entry().videoId()).isEqualTo(A);

        // "sign out and back in", or another device: a fresh service reads the same account-owned row
        WallpaperLibraryService later = freshService();
        assertThat(later.list(1).items()).extracting(Entry::videoId).containsExactly(A);

        // learner 2 sees nothing of learner 1, and cannot read, change or delete the entry by its id
        UUID id = first.entry().id();
        assertThat(later.list(2).items()).isEmpty();
        assertThat(code(() -> later.get(2, id))).isEqualTo(404);
        assertThat(code(() -> inTx(() -> later.setBackground(2, id, new BackgroundRequest("LINK", "https://cdn.example.org/a.mp4", null))))).isEqualTo(404);
        assertThat(code(() -> inTx(() -> { later.delete(2, id); return null; }))).isEqualTo(404);
        assertThat(later.get(1, id).background()).isNull();

        // learner 2's own entry is invisible to learner 1
        SaveResponse other = inTx(() -> service.save(2, B));
        assertThat(service.list(1).items()).extracting(Entry::videoId).containsExactly(A);
        assertThat(code(() -> service.get(1, other.entry().id()))).isEqualTo(404);
        assertThat(service.list(2).items()).extracting(Entry::videoId).containsExactly(B);
    }

    @Test
    void savingTwiceReturnsTheSameEntry() {
        SaveResponse first = inTx(() -> service.save(3, A));
        SaveResponse again = inTx(() -> service.save(3, A));
        assertThat(again.created()).isFalse();
        assertThat(again.entry().id()).isEqualTo(first.entry().id());
        assertThat(service.list(3).items()).hasSize(1);
    }

    @Test
    void invalidIdsAreRefused() {
        for (String bad : new String[]{"", "short", "dQw4w9WgXcQx", "videoseries", "dQw4w9WgX!Q", null}) {
            assertThat(code(() -> inTx(() -> service.save(4, bad)))).as(String.valueOf(bad)).isEqualTo(400);
        }
        assertThat(service.list(4).items()).isEmpty();
    }

    @Test
    void theLimitHoldsUnderConcurrentSaves() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        List<Future<Integer>> results = new ArrayList<>();
        for (int i = 0; i < WallpaperLibraryRules.MAX_ENTRIES + 10; i++) {
            String id = String.format("abcdefg%04d", i);
            results.add(pool.submit(() -> code(() -> inTx(() -> service.save(5, id)))));
        }
        int ok = 0, full = 0;
        for (Future<Integer> f : results) {
            int c = f.get(60, TimeUnit.SECONDS);
            if (c == 200) ok++;
            else if (c == 409) full++;
        }
        pool.shutdown();
        assertThat(ok).isEqualTo(WallpaperLibraryRules.MAX_ENTRIES);
        assertThat(full).isEqualTo(10);
        assertThat(service.list(5).items()).hasSize(WallpaperLibraryRules.MAX_ENTRIES);
    }

    @Test
    void deviceListImportKeepsOrderSkipsSavedAndIsAllOrNothingOnBadIds() {
        inTx(() -> service.save(6, B));
        ImportResponse imported = inTx(() -> service.importDeviceList(6, List.of(A, B, "k2qgadSvNyU", A)));
        assertThat(imported.imported()).isEqualTo(2);
        assertThat(imported.alreadySaved()).isEqualTo(1);
        assertThat(imported.overLimit()).isZero();
        // the existing (newest) entry stays first; the device list keeps its newest-first order below it
        assertThat(imported.items()).extracting(Entry::videoId).containsExactly(B, A, "k2qgadSvNyU");

        assertThat(code(() -> inTx(() -> service.importDeviceList(6, List.of("ScMzIvxBSi4", "bad"))))).isEqualTo(400);
        assertThat(service.list(6).items()).hasSize(3);
        assertThat(code(() -> inTx(() -> service.importDeviceList(6, java.util.Collections.nCopies(13, A))))).isEqualTo(400);

        // the import of learner 7 never touches learner 6
        inTx(() -> service.importDeviceList(7, List.of("ScMzIvxBSi4")));
        assertThat(service.list(6).items()).extracting(Entry::videoId).doesNotContain("ScMzIvxBSi4");
    }

    @Test
    void backgroundSourcesAreValidatedAndClearable() {
        UUID id = inTx(() -> service.save(8, A)).entry().id();

        Entry link = inTx(() -> service.setBackground(8, id, new BackgroundRequest("LINK", "  https://media.example.org/clips/ocean.mp4?v=2  ", null)));
        assertThat(link.background().kind()).isEqualTo("LINK");
        assertThat(link.background().url()).isEqualTo("https://media.example.org/clips/ocean.mp4?v=2");
        assertThat(link.background().fileName()).isNull();

        for (String bad : new String[]{"http://media.example.org/a.mp4", "https://user:pw@media.example.org/a.mp4",
                "https://localhost/a.mp4", "https://127.0.0.1/a.mp4", "https://10.0.0.5/a.mp4", "https://[::1]/a.mp4",
                "https://intranet/a.mp4", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ",
                "https://rr1---sn.googlevideo.com/videoplayback", "https://media.example.org", "https://media.example.org/",
                "https://media.example.org/a b.mp4", "javascript:alert(1)", "https://x.local/a.mp4", "", null}) {
            assertThat(code(() -> inTx(() -> service.setBackground(8, id, new BackgroundRequest("LINK", bad, null))))).as(String.valueOf(bad)).isEqualTo(400);
        }
        assertThat(code(() -> inTx(() -> service.setBackground(8, id, new BackgroundRequest("LINK", "https://cdn.example.org/" + "a".repeat(2100) + ".mp4", null))))).isEqualTo(400);
        assertThat(code(() -> inTx(() -> service.setBackground(8, id, new BackgroundRequest("STREAM", "https://cdn.example.org/a.mp4", null))))).isEqualTo(400);

        Entry file = inTx(() -> service.setBackground(8, id, new BackgroundRequest("FILE", null, " my\u0000/clip‮.mp4 ")));
        assertThat(file.background().kind()).isEqualTo("FILE");
        assertThat(file.background().fileName()).isEqualTo("myclip.mp4");
        assertThat(file.background().url()).isNull();
        assertThat(code(() -> inTx(() -> service.setBackground(8, id, new BackgroundRequest("FILE", null, " \u0001 "))))).isEqualTo(400);
        Entry longName = inTx(() -> service.setBackground(8, id, new BackgroundRequest("FILE", null, "x".repeat(300))));
        assertThat(longName.background().fileName()).hasSize(160);

        Entry cleared = inTx(() -> service.setBackground(8, id, new BackgroundRequest(null, null, null)));
        assertThat(cleared.background()).isNull();

        inTx(() -> { service.delete(8, id); return null; });
        assertThat(service.list(8).items()).isEmpty();
        assertThat(code(() -> inTx(() -> { service.delete(8, id); return null; }))).isEqualTo(404);
    }

    @Test
    void theDatabaseRefusesWhatTheServiceNeverWrites() {
        JdbcTemplate jdbc = new JdbcTemplate(app);
        String insert = "INSERT INTO public.wallpaper_youtube_videos (id, user_id, video_id, background_kind, background_url, background_file_name) VALUES (?, 9, ?, ?, ?, ?)";
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), "bad", null, null, null)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), A, "LINK", "http://x.example/a.mp4", null)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), A, "LINK", null, null)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), A, "FILE", "https://x.example/a.mp4", "a.mp4")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), A, null, null, "a.mp4")).isInstanceOf(DataIntegrityViolationException.class);
        jdbc.update(insert, UUID.randomUUID(), A, null, null, null);
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), A, null, null, null)).isInstanceOf(DataIntegrityViolationException.class);
        // the owner key never cascades: a learner who still owns entries cannot be deleted from under them
        assertThatThrownBy(() -> new JdbcTemplate(raw).update("DELETE FROM public.users WHERE id = 9")).isInstanceOf(DataIntegrityViolationException.class);
        // the runtime role cannot change the table's shape
        assertThatThrownBy(() -> jdbc.execute("ALTER TABLE public.wallpaper_youtube_videos ADD COLUMN x int")).isInstanceOf(Exception.class);
    }
}
