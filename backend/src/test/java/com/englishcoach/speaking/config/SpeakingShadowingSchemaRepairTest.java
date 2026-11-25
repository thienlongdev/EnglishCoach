package com.englishcoach.speaking.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingShadowingSchemaRepairTest {

    @Mock
    private JdbcTemplate jdbcTemplate;

    @Test
    void normalisesGenerationLocalIdentityIdempotently() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Boolean.class))).thenReturn(Boolean.TRUE);
        when(jdbcTemplate.queryForObject(anyString(), eq(Integer.class))).thenReturn(0);
        SpeakingShadowingSchemaRepair repair = new SpeakingShadowingSchemaRepair(jdbcTemplate);

        repair.ensureReady();
        repair.ensureReady();

        ArgumentCaptor<String> statements = ArgumentCaptor.forClass(String.class);
        verify(jdbcTemplate, atLeastOnce()).execute(statements.capture());
        List<String> sql = statements.getAllValues();
        assertThat(sql).anyMatch(value -> value.contains("PARTITION BY material_id, generation_version"));
        verify(jdbcTemplate, times(1)).queryForObject(anyString(), eq(Integer.class));
    }

    @Test
    void skipsSequenceRewriteWhenAlreadyNormalized() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Boolean.class))).thenReturn(Boolean.FALSE);
        when(jdbcTemplate.queryForObject(anyString(), eq(Integer.class))).thenReturn(0);
        SpeakingShadowingSchemaRepair repair = new SpeakingShadowingSchemaRepair(jdbcTemplate);

        repair.ensureReady();

        ArgumentCaptor<String> executed = ArgumentCaptor.forClass(String.class);
        verify(jdbcTemplate, atLeastOnce()).execute(executed.capture());
        assertThat(executed.getAllValues()).noneMatch(value -> value.contains("CREATE TEMP TABLE shd_sequence_repair"));
        verify(jdbcTemplate, times(1)).queryForObject(anyString(), eq(Integer.class));
    }

    @Test
    void changesRowsOnlyNeverTheSchema() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Boolean.class))).thenReturn(Boolean.TRUE);
        when(jdbcTemplate.queryForObject(anyString(), eq(Integer.class))).thenReturn(0);
        new SpeakingShadowingSchemaRepair(jdbcTemplate).ensureReady();

        ArgumentCaptor<String> executed = ArgumentCaptor.forClass(String.class);
        verify(jdbcTemplate, atLeastOnce()).execute(executed.capture());
        // the application's least-privilege database role cannot ALTER a table or CREATE an index (Flyway V94)
        assertThat(executed.getAllValues()).noneMatch(value -> value.matches("(?is).*\\b(ALTER\\s+TABLE|CREATE\\s+INDEX|ADD\\s+CONSTRAINT)\\b.*"));
    }

    @Test
    void schemaFactsLiveInTheMigration() throws Exception {
        String v94 = Files.readString(Path.of("src/main/resources/db/migration/exams/V94__database_runtime_least_privilege.sql"));
        assertThat(v94).contains("ALTER COLUMN segment_id DROP NOT NULL", "DROP CONSTRAINT IF EXISTS uk_shadowing_unit_material_seq",
                "uk_shadowing_unit_material_gen_seq", "idx_shadowing_unit_material_gen_seq", "idx_shadowing_unit_material_gen_start");
    }
}
