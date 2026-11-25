package com.englishcoach.community.dto;

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
public class PostReactionSummaryDto {
    private int totalCount;

    @Builder.Default
    private Map<String, Integer> countsByType = new HashMap<>();

    @Builder.Default
    private List<PostReactorDto> reactors = new ArrayList<>();
}
