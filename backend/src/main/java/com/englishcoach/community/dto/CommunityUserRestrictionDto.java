package com.englishcoach.community.dto;

import com.englishcoach.community.entity.CommunityRestrictionType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityUserRestrictionDto {
    private Long id;
    private Long targetUserId;
    private String targetUserName;
    private CommunityRestrictionType restrictionType;
    private String reason;
    private Long createdByAdminId;
    private String createdByAdminName;
    private Instant createdAt;
    private Instant expiresAt;
    private Instant revokedAt;
    private boolean active;
    private String userMessage;
}
