package com.englishcoach.exams.measurement.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.englishcoach.exams.measurement.service.ExamCalibrationService;
import com.englishcoach.exams.measurement.service.ExamMeasurementAuthorizationService;
import com.englishcoach.exams.measurement.service.ExamMeasurementService;
import com.englishcoach.exams.measurement.service.ExamRaterService;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Internal, authenticated measurement endpoints. */
@RestController
@RequestMapping("/api/v1/admin/exams/measurement")
@RequiredArgsConstructor
public class ExamMeasurementController {

    private final ExamMeasurementAuthorizationService authorization;
    private final ExamMeasurementService measurementService;
    private final ExamCalibrationService calibrationService;
    private final ExamRaterService raterService;

    @PostMapping("/consent")
    public ResponseEntity<Map<String, Object>> consent(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestBody ConsentRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        // Exams Phase 9A: every admin measurement endpoint re-checks the Exams operator permission server-side
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.OPERATE);
        UUID id = measurementService.recordPilotConsent(user.getId(), user.getId(), request.status(), request.consentHash());
        return ResponseEntity.ok(Map.of("consentId", id, "status", request.status()));
    }

    @PostMapping("/consent/human-rating")
    public ResponseEntity<Map<String, Object>> humanRatingConsent(@AuthenticationPrincipal UserDetailsImpl user,
                                                                   @RequestBody ConsentRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.OPERATE);
        UUID id = measurementService.recordHumanRatingConsent(user.getId(), user.getId(), request.status(), request.consentHash());
        return ResponseEntity.ok(Map.of("consentId", id, "status", request.status(), "purpose", "EXAMS_HUMAN_RATING"));
    }

    @PostMapping("/attempts/{attemptId}/collect")
    public ResponseEntity<Map<String, Object>> collect(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @PathVariable UUID attemptId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.OPERATE);
        List<UUID> eventIds = measurementService.collectRuntimeAttempt(attemptId, user.getId());
        return ResponseEntity.ok(Map.of("attemptId", attemptId, "eventIds", eventIds, "evidenceClass", "RUNTIME_OPERATIONAL"));
    }

    @GetMapping("/attempts/{attemptId}/events")
    public ResponseEntity<List<MeasurementEvent>> export(@AuthenticationPrincipal UserDetailsImpl user,
                                                          @PathVariable UUID attemptId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.OPERATE);
        return ResponseEntity.ok(measurementService.getAttemptEvents(attemptId));
    }

    @PostMapping("/runs")
    public ResponseEntity<Map<String, Object>> createRun(@AuthenticationPrincipal UserDetailsImpl user,
                                                          @RequestBody RunRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        UUID id = measurementService.createRun(request.family(), request.skill(), request.formId(), request.attemptIds(),
                request.filter(), request.consentPolicyVersion(), user.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("runId", id, "status", "RAW"));
    }

    @PostMapping("/runs/{runId}/calculate")
    public ResponseEntity<AnalysisReport> calculate(@AuthenticationPrincipal UserDetailsImpl user,
                                                     @PathVariable UUID runId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        return ResponseEntity.ok(measurementService.calculateRun(runId));
    }

    @GetMapping("/runs/{runId}")
    public ResponseEntity<Map<String, Object>> getRun(@AuthenticationPrincipal UserDetailsImpl user,
                                                       @PathVariable UUID runId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        return measurementService.getRunWithItemStatistics(runId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/runs/{runId}/events")
    public ResponseEntity<List<MeasurementEvent>> getRunEvents(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @PathVariable UUID runId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        return ResponseEntity.ok(measurementService.getRunEvents(runId));
    }

    @PostMapping("/calibration/packages")
    public ResponseEntity<Map<String, Object>> createCalibration(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @RequestBody CalibrationPackageRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        UUID id = calibrationService.create(request, user.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("packageId", id, "approvalState", "PENDING_APPROVAL"));
    }

    @PostMapping("/calibration/packages/{packageId}/approve")
    public ResponseEntity<Map<String, Object>> approveCalibration(@AuthenticationPrincipal UserDetailsImpl user,
                                                                    @PathVariable UUID packageId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        calibrationService.approve(packageId, user.getId());
        return ResponseEntity.ok(Map.of("packageId", packageId, "approvalState", "APPROVED"));
    }

    @GetMapping("/calibration/packages/{packageId}")
    public ResponseEntity<CalibrationPackage> getCalibration(@AuthenticationPrincipal UserDetailsImpl user,
                                                               @PathVariable UUID packageId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.CALIBRATE);
        return calibrationService.getPackage(packageId)
                .map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/gold/datasets")
    public ResponseEntity<Map<String, Object>> createGoldDataset(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @RequestBody GoldDatasetRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        UUID id = raterService.createDataset(request.logicalCode(), request.version(), request.family(), request.skill(),
                request.rubricVersionId(), request.consentPolicyVersion(), request.provenanceStatement(), user.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("datasetId", id, "status", "DRAFT"));
    }

    @PostMapping("/gold/datasets/{datasetId}/members")
    public ResponseEntity<Map<String, Object>> addGoldMember(@AuthenticationPrincipal UserDetailsImpl user,
                                                               @PathVariable UUID datasetId,
                                                               @RequestBody GoldMemberRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        UUID id = raterService.addMember(datasetId, request.responseId(), request.attemptId(), request.consentId(), request.split(), user.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("memberId", id, "datasetId", datasetId));
    }

    @PostMapping("/gold/datasets/{datasetId}/lock")
    public ResponseEntity<Map<String, Object>> lockGoldDataset(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @PathVariable UUID datasetId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        raterService.lockDataset(datasetId, user.getId());
        return ResponseEntity.ok(Map.of("datasetId", datasetId, "status", "LOCKED"));
    }

    @PostMapping("/gold/datasets/{datasetId}/assignments")
    public ResponseEntity<Map<String, Object>> assignRater(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @PathVariable UUID datasetId,
                                                            @RequestBody AssignmentRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        UUID id = raterService.assign(datasetId, request.responseId(), request.attemptId(), request.raterUserId(), user.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("assignmentId", id, "blind", true));
    }

    @PostMapping("/raters/assignments/{assignmentId}/ratings")
    public ResponseEntity<Map<String, Object>> submitRating(@AuthenticationPrincipal UserDetailsImpl user,
                                                              @PathVariable UUID assignmentId,
                                                              @RequestBody RatingRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        // The assignment owner is read from the database; the request cannot choose the rater identity.
        raterService.rate(new RatingSubmission(assignmentId, user.getId(), request.rubricVersionId(), request.criterionScores(),
                request.overallScore(), request.confidence(), request.ratingHash()), user.getId());
        return ResponseEntity.ok(Map.of("assignmentId", assignmentId, "status", "SUBMITTED"));
    }

    @PostMapping("/gold/datasets/{datasetId}/adjudications")
    public ResponseEntity<Map<String, Object>> adjudicate(@AuthenticationPrincipal UserDetailsImpl user,
                                                           @PathVariable UUID datasetId,
                                                           @RequestBody AdjudicationRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        raterService.adjudicate(request.responseId(), datasetId, request.selectedRatingId(), request.finalScores(),
                request.disagreementReason(), request.decisionHash(), user.getId());
        return ResponseEntity.ok(Map.of("responseId", request.responseId(), "status", "ADJUDICATED"));
    }

    @PostMapping("/gold/datasets/{datasetId}/evaluations")
    public ResponseEntity<EvaluationReport> evaluate(@AuthenticationPrincipal UserDetailsImpl user,
                                                       @PathVariable UUID datasetId,
                                                       @RequestBody EvaluationRequest request) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.EVALUATE);
        return ResponseEntity.ok(raterService.evaluate(datasetId, request.scorerName(), request.scorerVersion(),
                request.lockedTestHash(), request.records(), user.getId()));
    }

    @GetMapping("/gold/datasets/{datasetId}")
    public ResponseEntity<GoldDataset> getGoldDataset(@AuthenticationPrincipal UserDetailsImpl user,
                                                       @PathVariable UUID datasetId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        return raterService.getGoldDataset(datasetId)
                .map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/gold/datasets/{datasetId}/assignments")
    public ResponseEntity<List<RaterAssignment>> getMyAssignments(@AuthenticationPrincipal UserDetailsImpl user,
                                                                   @PathVariable UUID datasetId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        return ResponseEntity.ok(raterService.getRaterAssignments(datasetId, user.getId()));
    }

    @GetMapping("/gold/datasets/{datasetId}/responses/{responseId}/ratings")
    public ResponseEntity<List<RaterRatingSummary>> getRatingsForAdjudication(
            @AuthenticationPrincipal UserDetailsImpl user,
            @PathVariable UUID datasetId,
            @PathVariable UUID responseId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        return ResponseEntity.ok(raterService.getRatingsForAdjudication(datasetId, responseId, user.getId()));
    }

    @GetMapping("/raters/assignments/{assignmentId}")
    public ResponseEntity<RaterAssignmentView> getAssignmentView(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @PathVariable UUID assignmentId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        return raterService.getAssignmentView(assignmentId, user.getId())
                .map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/raters/assignments/{assignmentId}/recording")
    public ResponseEntity<InputStreamResource> streamAssignedRecording(
            @AuthenticationPrincipal UserDetailsImpl user,
            @PathVariable UUID assignmentId) {
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        authorization.require(user.getId(), ExamMeasurementAuthorizationService.RATE);
        try {
            ExamRaterService.RaterRecordingStream recording = raterService.openRecording(assignmentId, user.getId());
            MediaType mediaType = ExamMediaService.sanitizeAudioMediaType(recording.contentType());
            boolean allowlistedAudio = ExamMediaService.isAllowlistedAudioMediaType(mediaType);
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                    .contentType(mediaType)
                    .contentLength(recording.contentLength())
                    .header("Content-Security-Policy", "default-src 'none'; media-src 'self'; sandbox")
                    .header("X-Content-Type-Options", "nosniff")
                    .cacheControl(CacheControl.noStore().cachePrivate());
            if (allowlistedAudio) {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, "inline");
            } else {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"recording.bin\"");
            }
            return builder.body(new InputStreamResource(recording.stream()));
        } catch (SecurityException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        }
    }

    public record ConsentRequest(String status, String consentHash) {}

    public record RunRequest(ExamFamily family, SkillType skill, UUID formId, List<UUID> attemptIds,
                             Map<String, Object> filter, String consentPolicyVersion) {}

    public record GoldDatasetRequest(String logicalCode, int version, ExamFamily family, SkillType skill,
                                     UUID rubricVersionId, String consentPolicyVersion, String provenanceStatement) {}

    public record GoldMemberRequest(UUID responseId, UUID attemptId, UUID consentId, Split split) {}

    public record AssignmentRequest(UUID responseId, UUID attemptId, Long raterUserId) {}

    public record RatingRequest(UUID rubricVersionId, Map<String, Object> criterionScores,
                                Double overallScore, Double confidence, String ratingHash) {}

    public record AdjudicationRequest(UUID responseId, UUID selectedRatingId, Map<String, Object> finalScores,
                                      String disagreementReason, String decisionHash) {}

    public record EvaluationRequest(String scorerName, String scorerVersion, String lockedTestHash,
                                    List<EvaluationRecord> records) {}
}
