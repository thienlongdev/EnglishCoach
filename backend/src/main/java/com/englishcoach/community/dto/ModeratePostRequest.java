package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ModerationAction;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModeratePostRequest {

    @NotNull(message = "Hành động duyệt không được để trống")
    private ModerationAction action;

    private String reason; // e.g. "Spam", "Nội dung không phù hợp", "Quảng cáo", etc.

    private String note;
}
