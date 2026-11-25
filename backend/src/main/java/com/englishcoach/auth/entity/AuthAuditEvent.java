package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_audit_events", schema = "public")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthAuditEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @CreationTimestamp
    @Column(name = "event_time", nullable = false, updatable = false)
    private Instant eventTime;

    @Column(name = "event_type", nullable = false, length = 64)
    private String eventType;

    @Column(nullable = false, length = 32)
    private String outcome;

    @Column(name = "actor_user_id")
    private Long actorUserId;

    @Column(name = "target_user_id")
    private Long targetUserId;

    @Column(name = "correlation_id", length = 128)
    private String correlationId;

    @Column(name = "ip_address", length = 64)
    private String ipAddress;

    @Column(name = "user_agent")
    private String userAgent;

    @Column(name = "reason_code", length = 64)
    private String reasonCode;

    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    @Column(name = "details", columnDefinition = "jsonb")
    private String details;
}
