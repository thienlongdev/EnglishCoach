package com.englishcoach.speaking.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Start-up data check of the Shadowing tables: legacy rows get a generation version, sequence numbers are normalised
 * to positive generation-local positions, and the identity invariant is verified (start-up fails if it does not hold).
 * Rows only: the schema facts this class once re-applied with DDL at every start (nullable segment, extra columns,
 * identity constraint and its indexes) live in Flyway V94, because the application's database role may not change
 * the schema (least privilege, 2026-10).
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SpeakingShadowingSchemaRepair {

    private final JdbcTemplate jdbcTemplate;
    private volatile boolean ready;

    @EventListener(ApplicationReadyEvent.class)
    @Order(0)
    @Transactional
    public void repairLegacyShadowingSchema() {
        ensureReady();
    }

    /** Also gates an early lazy-generation request that arrives before ApplicationReadyEvent. */
    public synchronized void ensureReady() {
        if (ready) {
            return;
        }
        jdbcTemplate.execute(
                "UPDATE speaking_scenarios SET is_system = TRUE WHERE is_system IS NULL"
        );
        int versioned = jdbcTemplate.update(
                "UPDATE speaking_shadowing_units SET generation_version = 1 WHERE generation_version IS NULL"
        );

        Boolean needsNormalization = jdbcTemplate.queryForObject(
                "SELECT EXISTS (" +
                "  SELECT 1 FROM (" +
                "    SELECT sequence_number, ROW_NUMBER() OVER (" +
                "      PARTITION BY material_id, generation_version " +
                "      ORDER BY CASE WHEN sequence_number > 0 THEN sequence_number ELSE ABS(sequence_number::bigint) END, id" +
                "    )::integer AS target_sequence " +
                "    FROM speaking_shadowing_units" +
                "  ) s " +
                "  WHERE s.sequence_number IS NULL OR s.sequence_number <= 0 OR s.sequence_number <> s.target_sequence" +
                ")",
                Boolean.class
        );

        int normalized = 0;
        if (Boolean.TRUE.equals(needsNormalization)) {
            jdbcTemplate.execute("DROP TABLE IF EXISTS shd_sequence_repair");
            jdbcTemplate.execute(
                    "CREATE TEMP TABLE shd_sequence_repair ON COMMIT DROP AS " +
                    "SELECT id, material_id, generation_version, sequence_number, ROW_NUMBER() OVER (" +
                    "PARTITION BY material_id, generation_version " +
                    "ORDER BY CASE WHEN sequence_number > 0 THEN sequence_number ELSE ABS(sequence_number::bigint) END, id" +
                    ")::integer AS target_sequence FROM speaking_shadowing_units"
            );
            jdbcTemplate.update(
                    "UPDATE speaking_shadowing_units u " +
                    "SET sequence_number = 1000000000 + r.target_sequence " +
                    "FROM shd_sequence_repair r " +
                    "WHERE r.id = u.id " +
                    "  AND EXISTS (SELECT 1 FROM shd_sequence_repair d " +
                    "              WHERE d.material_id = r.material_id AND d.generation_version = r.generation_version " +
                    "                AND (d.sequence_number IS NULL OR d.sequence_number <= 0 OR d.sequence_number <> d.target_sequence))"
            );
            normalized = jdbcTemplate.update(
                    "UPDATE speaking_shadowing_units u SET sequence_number = r.target_sequence " +
                    "FROM shd_sequence_repair r " +
                    "WHERE r.id = u.id AND u.sequence_number IS DISTINCT FROM r.target_sequence"
            );
        }

        Integer violations = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM speaking_shadowing_units " +
                "WHERE generation_version IS NULL OR sequence_number IS NULL OR sequence_number <= 0",
                Integer.class
        );
        if (violations == null || violations != 0) {
            throw new IllegalStateException("Shadowing generation identity migration left " + violations + " invalid rows");
        }
        ready = true;
        log.info(
                "Verified Shadowing schema: {} rows versioned, {} generation-local sequences normalized",
                versioned,
                normalized
        );
    }
}
