package com.englishcoach.content.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class RssRefreshResultDto {
    private boolean success;
    private int totalSources;
    private int totalInserted;
    @Builder.Default
    private List<SourceRefreshResult> sources = new ArrayList<>();

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class SourceRefreshResult {
        private String key;
        private String name;
        private int fetched;
        private int inserted;
        private int skipped;
        private int failed;
        private String error;
    }
}
