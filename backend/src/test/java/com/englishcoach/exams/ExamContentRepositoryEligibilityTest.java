package com.englishcoach.exams;

import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExamContentRepositoryEligibilityTest {

    @Mock
    private NamedParameterJdbcTemplate jdbcTemplate;

    @Test
    void productionEligibilityUsesPublishedAndApprovedCalibrationChain() {
        when(jdbcTemplate.queryForObject(anyString(), any(MapSqlParameterSource.class), eq(Boolean.class)))
                .thenReturn(Boolean.TRUE);

        ExamContentRepository repository = new ExamContentRepository(jdbcTemplate, new ObjectMapper());

        assertTrue(repository.isProductionEligibleForProfileEvidence(UUID.randomUUID()));

        ArgumentCaptor<String> sql = ArgumentCaptor.forClass(String.class);
        verify(jdbcTemplate).queryForObject(sql.capture(), any(MapSqlParameterSource.class), eq(Boolean.class));
        String query = sql.getValue();
        assertTrue(query.contains("f.lifecycle_state = 'PUBLISHED'"));
        assertTrue(query.contains("f.published_at IS NOT NULL"));
        assertTrue(query.contains("s.approved_at IS NOT NULL"));
        assertTrue(query.contains("c.approved_at IS NOT NULL"));
        assertTrue(query.contains("c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED',"));
        assertTrue(query.contains("'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')"));
    }

    @Test
    void missingApprovalIsFailClosed() {
        when(jdbcTemplate.queryForObject(anyString(), any(MapSqlParameterSource.class), eq(Boolean.class)))
                .thenReturn(Boolean.FALSE);

        ExamContentRepository repository = new ExamContentRepository(jdbcTemplate, new ObjectMapper());

        assertFalse(repository.isProductionEligibleForProfileEvidence(UUID.randomUUID()));
    }
}
