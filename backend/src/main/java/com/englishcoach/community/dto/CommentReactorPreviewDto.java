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
public class CommentReactorPreviewDto {
    private String displayName;
    private ReactionType reactionType;
}
