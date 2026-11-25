package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthAuditEvent;
import com.englishcoach.auth.repository.AuthAuditEventRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class SecurityAuditService {

    private final AuthAuditEventRepository auditEventRepository;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordEvent(String eventType, String outcome, Long actorUserId, Long targetUserId,
                            String correlationId, String ipAddress, String userAgent,
                            String reasonCode, String detailsJson) {
        try {
            AuthAuditEvent event = AuthAuditEvent.builder()
                    .eventType(eventType)
                    .outcome(outcome)
                    .actorUserId(actorUserId)
                    .targetUserId(targetUserId)
                    .correlationId(correlationId)
                    .ipAddress(ipAddress)
                    .userAgent(userAgent)
                    .reasonCode(reasonCode)
                    .details(detailsJson)
                    .build();

            auditEventRepository.save(event);
            String alertKind = SecurityAlertService.kindOfAudit(eventType, outcome, reasonCode);
            if (alertKind != null) com.englishcoach.common.security.SecuritySignals.signal(alertKind, reasonCode);
        } catch (Exception e) {
            log.error("[Audit] Failed to record security audit event {}: {}", eventType, e.getMessage());
        }
    }
}
