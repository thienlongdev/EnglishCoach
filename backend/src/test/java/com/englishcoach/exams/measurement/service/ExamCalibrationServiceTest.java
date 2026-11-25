package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.CalibrationPackageRequest;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;

class ExamCalibrationServiceTest {

    @Test
    void rejectsEmptyOrNonMonotonicMappings() {
        var base = new CalibrationPackageRequest("ielts-reading", 1, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                "CTT_PRELIMINARY", "PILOT", Map.of(), Map.of("method", "bootstrap"), "a".repeat(64), "report");
        assertThrows(IllegalArgumentException.class, () -> ExamCalibrationService.validate(base));

        var nonMonotonic = new CalibrationPackageRequest("ielts-reading", 1, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                "CTT_PRELIMINARY", "PILOT", Map.of("1", 7.0, "2", 6.0), Map.of("method", "bootstrap"),
                "a".repeat(64), "report");
        assertThrows(IllegalArgumentException.class, () -> ExamCalibrationService.validate(nonMonotonic));
    }
}
