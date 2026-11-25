package com.englishcoach.garden;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import static org.junit.jupiter.api.Assertions.*;

/** Release qualification against an owner-authorized, schema-only V76 production dump.
 * No production connection, credentials or learner rows are used by this test. */
@EnabledIfSystemProperty(named = "garden.productionSchema", matches = ".+")
class GardenMigrationCompatibilityTest {
    /**
     * Combined release: V79 Rush Solo, V80 Garden economy, V81 Rush competition, V82 Garden living knowledge, V83 Garden
     * estate (Phase 3C).
     */
    static final int LATEST = 85;

    @Test
    void laterMigrationsPreserveExistingProductionSchemaAndAddRestrictiveGardenOwnership() throws Exception {
        try (var db = new PostgreSQLContainer<>("postgres:17")) {
            db.start();
            String schema = Files.readString(Path.of(System.getProperty("garden.productionSchema")))
                .replaceAll("(?m)^\\\\(?:un)?restrict.*$", "");
            try (var connection = DriverManager.getConnection(db.getJdbcUrl(), db.getUsername(), db.getPassword());
                 var sql = connection.createStatement()) {
                sql.execute(schema);
                String referenceData = System.getProperty("garden.productionReferenceData");
                if (referenceData != null) {
                    sql.execute(Files.readString(Path.of(referenceData))
                        .replaceAll("(?m)^\\\\(?:un)?restrict.*$", ""));
                }
                sql.execute("DROP TABLE exams.flyway_schema_history"); // isolated dump contains the table, no rows
                String existingColumns = "SELECT string_agg(table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), '|' ORDER BY table_schema,table_name,ordinal_position) FROM information_schema.columns WHERE table_schema IN ('public','exams') AND table_name <> 'flyway_schema_history' AND table_name NOT LIKE 'garden_%' AND table_name <> 'v_garden_daily_kpi'";
                var before = sql.executeQuery(existingColumns);
                assertTrue(before.next()); String columns = before.getString(1);
                // later migrations may ADD tables (Echo Quiz Rush V79): compare only the tables that existed before
                var tables = new java.util.ArrayList<String>();
                var existing = sql.executeQuery("SELECT DISTINCT table_schema||'.'||table_name FROM information_schema.columns WHERE table_schema IN ('public','exams')");
                while (existing.next()) tables.add("'" + existing.getString(1) + "'");
                String preExistingColumns = existingColumns + " AND table_schema||'.'||table_name IN (" + String.join(",", tables) + ")";
                var flyway = Flyway.configure().dataSource(db.getJdbcUrl(), db.getUsername(), db.getPassword())
                    .schemas("exams").defaultSchema("exams").baselineOnMigrate(true)
                    .baselineVersion(System.getProperty("garden.productionSchemaVersion", "76"))
                    .locations("classpath:db/migration/exams").load();
                var checksums = new java.util.TreeMap<String,Integer>();
                for(var migration : flyway.info().all())
                    if(migration.getVersion()!=null&&migration.getChecksum()!=null)
                        checksums.put(migration.getVersion().toString(),migration.getChecksum());
                int baseline = Integer.parseInt(System.getProperty("garden.productionSchemaVersion", "76"));
                assertEquals(LATEST - baseline, flyway.migrate().migrationsExecuted, "Only migrations after the observed production schema");
                assertEquals(String.valueOf(LATEST), flyway.info().current().getVersion().toString());
                assertEquals(0, flyway.migrate().migrationsExecuted);
                String evidence = System.getProperty("release.migrationEvidence");
                if(evidence!=null)Files.writeString(Path.of(evidence),new com.fasterxml.jackson.databind.ObjectMapper()
                    .writerWithDefaultPrettyPrinter().writeValueAsString(java.util.Map.of("baseline",baseline,"head",LATEST,
                        "applied",LATEST-baseline,"repeatApplied",0,"sourceChecksums",checksums)));
                var after = sql.executeQuery(preExistingColumns);
                assertTrue(after.next()); assertEquals(columns, after.getString(1), "Existing column names/types/nullability/defaults remain identical");
                var owners = sql.executeQuery("SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname LIKE 'garden_%' AND c.contype='f' AND c.confdeltype <> 'r'");
                assertTrue(owners.next()); assertEquals(0, owners.getInt(1), "All garden foreign keys restrict deletion");
                var rushOwners = sql.executeQuery("SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname LIKE 'quiz_rush_%' AND c.contype='f' AND c.confdeltype <> 'r'");
                assertTrue(rushOwners.next());assertEquals(0,rushOwners.getInt(1),"All Rush foreign keys restrict deletion");
                var seeds = sql.executeQuery("SELECT count(*) FROM public.garden_crop_def");
                assertTrue(seeds.next()); assertEquals(11, seeds.getInt(1));
                var economy = sql.executeQuery("SELECT count(*) FROM public.garden_config WHERE key IN ('market','orders','expansion')");
                assertTrue(economy.next()); assertEquals(3, economy.getInt(1), "V80 farm-economy configuration present");
                var band = sql.executeQuery("SELECT value::text FROM public.garden_config WHERE key = 'harvest.dailyXp'");
                assertTrue(band.next()); assertEquals("[[40, 1.0], [90, 0.4], [999999, 0.05]]", band.getString(1), "V80 calibrated harvest-XP band");
                var water = sql.executeQuery("SELECT in_fixed_shop FROM public.garden_item_def WHERE code = 'WATER'");
                assertTrue(water.next()); assertFalse(water.getBoolean(1), "water is never sold at the market");
                var sources = new com.englishcoach.garden.infra.LearningSourceRepository(
                    new org.springframework.jdbc.core.JdbcTemplate(ds(db)));
                for (String source : java.util.List.of("DICTATION", "SHADOWING", "WRITING", "EXAM", "CARD_BLAST", "WORD_CHAIN")) {
                    assertDoesNotThrow(() -> sources.find(source, 1L, java.time.Instant.EPOCH, 1, 1),
                        "Phase 2 completion adapter must match the actual production schema: " + source);
                }
            }
        }
    }

    private javax.sql.DataSource ds(PostgreSQLContainer<?> db) {
        return new org.springframework.jdbc.datasource.DriverManagerDataSource(
            db.getJdbcUrl(), db.getUsername(), db.getPassword());
    }
}
