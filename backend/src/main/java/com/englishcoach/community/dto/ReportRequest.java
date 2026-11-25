package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReportReason;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReportRequest {

    @NotNull(message = "Lý do báo cáo không được để trống")
    private ReportReason reason;

    @Size(max = 1000, message = "Chi tiết báo cáo tối đa 1,000 ký tự")
    private String details;
}
