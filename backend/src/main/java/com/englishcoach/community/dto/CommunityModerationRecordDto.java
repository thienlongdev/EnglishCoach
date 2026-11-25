package com.englishcoach.community.dto;

import com.englishcoach.community.entity.CommunityModerationRecord;
import com.englishcoach.community.entity.ModerationAction;

import java.time.Instant;

public record CommunityModerationRecordDto(
        Long id,
        Long postId,
        Long moderatorId,
        String previousStatus,
        String newStatus,
        ModerationAction action,
        String reason,
        String note,
        Instant createdAt
) {
    public static CommunityModerationRecordDto fromEntity(CommunityModerationRecord record) {
        return new CommunityModerationRecordDto(
                record.getId(),
                record.getPost() != null ? record.getPost().getId() : null,
                record.getAdmin() != null ? record.getAdmin().getId() : null,
                record.getPreviousStatus(),
                record.getNewStatus(),
                record.getAction(),
                record.getReason(),
                record.getNote(),
                record.getCreatedAt()
        );
    }
}
