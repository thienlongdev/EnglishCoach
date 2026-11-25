package com.englishcoach.speaking.dto;

import java.util.List;

public record ScenarioCatalogMetadataDto(
        List<CefrLevelCountDto> availableLevels,
        List<CategoryCountDto> availableCategories,
        long totalScenarios
) {
    public record CefrLevelCountDto(
            String level,
            long count
    ) {}

    public record CategoryCountDto(
            String category,
            String displayName,
            long count
    ) {}
}
