package com.englishcoach.community.dto;

import com.englishcoach.community.entity.SharedEntityType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SharedLearningEmbedDto {
    private SharedEntityType type;
    private String entityId;
    private String title;
    private String description;
    private String thumbnail;
    private String badge;
    private Map<String, Object> metrics;
    private String actionUrl;
    private String actionLabel;
}
