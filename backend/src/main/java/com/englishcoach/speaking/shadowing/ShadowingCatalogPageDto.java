package com.englishcoach.speaking.shadowing;

import java.util.List;

/**
 * Server-side paginated response for {@code GET /api/v1/speaking/shadowing/catalog}.
 */
public record ShadowingCatalogPageDto(
        List<ShadowingMaterialCardDto> content,
        int page,
        int size,
        long totalElements,
        int totalPages,
        boolean hasNext,
        boolean hasPrevious
) {}
