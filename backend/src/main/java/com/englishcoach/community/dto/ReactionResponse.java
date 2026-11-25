package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReactionType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReactionResponse {
    private Long postId;
    private ReactionType myReaction;
    private int likeCount;
}
