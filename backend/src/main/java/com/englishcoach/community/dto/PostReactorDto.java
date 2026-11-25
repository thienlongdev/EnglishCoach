package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReactionType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PostReactorDto {
    private AuthorSummaryDto user;
    private ReactionType reactionType;
    private Instant createdAt;
}
