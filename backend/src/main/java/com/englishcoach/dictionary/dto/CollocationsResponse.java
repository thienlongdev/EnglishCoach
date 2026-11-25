package com.englishcoach.dictionary.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CollocationsResponse {
    private String word;
    private List<CollocationPatternGroup> groups;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CollocationPatternGroup {
        private String pattern; // e.g., "Verb + Noun", "Adjective + Noun"
        private List<CanonicalDictionaryResponse.CollocationDto> items;
    }
}
