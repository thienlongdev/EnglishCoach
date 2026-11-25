package com.englishcoach.community.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TrendingTopicDto {
    private String tag;
    private String label;
    private int postCount;
    private int reactionCount;
    private int commentCount;
    private double score;
}
