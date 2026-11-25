package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.security.ExamPermissionService;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;

/** Centralizes permission checks for every measurement mutation/export. */
@Service
@RequiredArgsConstructor
public class ExamMeasurementAuthorizationService {

    public static final String OPERATE = "EXAMS_OPERATE";
    public static final String CALIBRATE = "EXAMS_CALIBRATE";
    public static final String RATE = "EXAMS_HUMAN_RATE";
    public static final String EVALUATE = "EXAMS_SCORER_EVALUATE";

    private final ExamPermissionService permissionService;

    public void require(Long actorId, String permissionCode) {
        if (actorId == null || !permissionService.hasOperatorPermission(actorId, permissionCode)) {
            throw new AccessDeniedException("Missing Exams permission: " + permissionCode);
        }
    }
}
