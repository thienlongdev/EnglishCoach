package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReactionType;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommentReactionResponseDto {
    private Long commentId;
    private ReactionType myReaction;
    private int likeCount;

    @Builder.Default
    private Map<String, Integer> countsByType = new HashMap<>();

    @Builder.Default
    private List<CommentReactorPreviewDto> topReactors = new ArrayList<>();

    @JsonProperty("reactionCount")
    public int getReactionCountAlias() {
        return likeCount;
    }
}
