package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.security.ExamPermissionService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.access.AccessDeniedException;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ExamMeasurementAuthorizationTest {

    @Mock ExamPermissionService permissions;

    @Test
    void usesExistingPermissionServiceAndFailsClosed() {
        var authorization = new ExamMeasurementAuthorizationService(permissions);
        when(permissions.hasOperatorPermission(7L, ExamMeasurementAuthorizationService.OPERATE)).thenReturn(false);
        assertThrows(AccessDeniedException.class, () -> authorization.require(7L, ExamMeasurementAuthorizationService.OPERATE));
        verify(permissions).hasOperatorPermission(7L, ExamMeasurementAuthorizationService.OPERATE);
        assertThrows(AccessDeniedException.class, () -> authorization.require(null, ExamMeasurementAuthorizationService.OPERATE));
    }

    @Test
    void permitsOnlyTheExistingGrantedCode() {
        var authorization = new ExamMeasurementAuthorizationService(permissions);
        when(permissions.hasOperatorPermission(7L, ExamMeasurementAuthorizationService.CALIBRATE)).thenReturn(true);
        authorization.require(7L, ExamMeasurementAuthorizationService.CALIBRATE);
        verify(permissions).hasOperatorPermission(7L, ExamMeasurementAuthorizationService.CALIBRATE);
    }
}
