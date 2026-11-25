package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReactionType;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReactionRequest {
    @NotNull(message = "Loại tương tác không được để trống")
    private ReactionType reactionType;
}
