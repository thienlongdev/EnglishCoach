package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.CalibrationPackage;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.CalibrationPackageRequest;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

/** Calibration package gates; existing scoring schemes are never rewritten. */
@Service
@RequiredArgsConstructor
public class ExamCalibrationService {

    private final ExamMeasurementRepository repository;

    @Transactional
    public UUID create(CalibrationPackageRequest request, Long actorId) {
        validate(request);
        if (!repository.scoringSchemeBelongsToForm(request.formId(), request.scoringSchemeId())) {
            throw new IllegalArgumentException("Calibration must reference the form's existing scoring scheme");
        }
        if (!repository.runHasApprovalEvidence(request.measurementRunId())) {
            throw new IllegalStateException("A FINAL measurement run is required before calibration packaging");
        }
        return repository.createCalibrationPackage(request, actorId);
    }

    @Transactional(readOnly = true)
    public Optional<CalibrationPackage> getPackage(UUID packageId) {
        return repository.findCalibrationPackage(packageId);
    }

    @Transactional
    public void approve(UUID packageId, Long approverId) {
        CalibrationPackage pkg = repository.findCalibrationPackage(packageId)
                .orElseThrow(() -> new IllegalArgumentException("Calibration package not found"));
        if (!"PENDING_APPROVAL".equals(pkg.approvalState())) throw new IllegalStateException("Calibration package is not pending approval");
        if (!repository.scoringSchemeBelongsToForm(pkg.formId(), pkg.scoringSchemeId())) {
            throw new IllegalStateException("Scoring scheme reference no longer matches form");
        }
        if (!repository.runHasApprovalEvidence(pkg.measurementRunId())) throw new IllegalStateException("Approval evidence is not final");
        repository.approveCalibration(packageId, approverId, Instant.now());
    }

    static void validate(CalibrationPackageRequest request) {
        if (request == null || request.logicalCode() == null || request.logicalCode().isBlank()
                || request.version() <= 0 || request.formId() == null || request.scoringSchemeId() == null
                || request.measurementRunId() == null) throw new IllegalArgumentException("Calibration identity is incomplete");
        if (request.evidenceHash() == null || !request.evidenceHash().matches("[0-9a-fA-F]{64}"))
            throw new IllegalArgumentException("Calibration evidence hash is required");
        if (request.validationReport() == null || request.validationReport().isBlank())
            throw new IllegalArgumentException("Calibration validation report is required");
        if (request.mappingTable() == null || request.mappingTable().isEmpty())
            throw new IllegalArgumentException("Calibration mapping must be evidence-backed and non-empty");
        if (request.uncertaintyModel() == null || request.uncertaintyModel().isEmpty())
            throw new IllegalArgumentException("Uncertainty model is required");
        validateMapping(request.mappingTable());
    }

    @SuppressWarnings("unchecked")
    private static void validateMapping(Map<String, Object> table) {
        Object rangesValue = table.get("ranges");
        if (rangesValue instanceof List<?> ranges) {
            double previous = Double.NEGATIVE_INFINITY;
            for (Object value : ranges) {
                if (!(value instanceof Map<?, ?> range)) throw new IllegalArgumentException("Invalid calibration range");
                Object min = range.get("min"), max = range.get("max"), scaled = range.get("scaled");
                if (!(min instanceof Number nMin) || !(max instanceof Number nMax) || !(scaled instanceof Number nScaled)
                        || nMin.doubleValue() > nMax.doubleValue() || nScaled.doubleValue() < previous) {
                    throw new IllegalArgumentException("Calibration mapping must be ordered and monotonic");
                }
                previous = nScaled.doubleValue();
            }
            if (ranges.isEmpty()) throw new IllegalArgumentException("Calibration ranges are empty");
            return;
        }
        List<Map.Entry<Integer, Double>> points = new ArrayList<>();
        for (Map.Entry<String, Object> entry : table.entrySet()) {
            if (entry.getKey().equals("ranges") || !(entry.getValue() instanceof Number n)) continue;
            try { points.add(Map.entry(Integer.parseInt(entry.getKey()), n.doubleValue())); }
            catch (NumberFormatException e) { throw new IllegalArgumentException("Calibration keys must be raw-score integers"); }
        }
        points.sort(Map.Entry.comparingByKey());
        if (points.isEmpty()) throw new IllegalArgumentException("Calibration mapping has no numeric points");
        for (int i = 1; i < points.size(); i++) if (points.get(i).getValue() < points.get(i - 1).getValue())
            throw new IllegalArgumentException("Calibration mapping must be monotonic");
    }
}
