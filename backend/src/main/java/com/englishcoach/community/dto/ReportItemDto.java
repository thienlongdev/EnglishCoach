package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReportReason;
import com.englishcoach.community.entity.ReportStatus;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReportItemDto {
    private Long id;
    private Long postId;
    private Long reporterId;
    private ReportReason reason;
    private String details;
    private ReportStatus status;
    private Instant createdAt;
}
