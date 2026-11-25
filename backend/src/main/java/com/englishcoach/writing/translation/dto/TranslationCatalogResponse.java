package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationCatalogResponse {
    private List<String> availableModes;
    private List<TranslationTopicDto> topics;
    private List<TranslationDifficultyDto> difficulties;
    private List<TranslationCollectionDto> collections;
    private TranslationSessionSummaryDto activeSession;
    private boolean paragraphModeEnabled;
}
