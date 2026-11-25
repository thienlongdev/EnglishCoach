package com.englishcoach.community.dto;

import com.englishcoach.community.entity.CommunityRestrictionType;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreateRestrictionRequest {

    @NotNull(message = "Mã người dùng không được để trống")
    private Long targetUserId;

    @NotNull(message = "Loại hạn chế không được để trống")
    private CommunityRestrictionType restrictionType;

    @NotBlank(message = "Lý do hạn chế không được để trống")
    @Size(max = 500, message = "Lý do tối đa 500 ký tự")
    private String reason;

    // "1_DAY", "3_DAYS", "7_DAYS", "30_DAYS", "PERMANENT", "CUSTOM"
    @NotBlank(message = "Thời gian hạn chế không được để trống")
    private String duration;

    private Instant customExpiresAt;
}
