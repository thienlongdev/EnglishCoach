package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthAuditEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface AuthAuditEventRepository extends JpaRepository<AuthAuditEvent, UUID> {
    List<AuthAuditEvent> findByTargetUserIdOrderByEventTimeDesc(Long targetUserId);
    List<AuthAuditEvent> findByEventTypeOrderByEventTimeDesc(String eventType);
}
