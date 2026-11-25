package com.englishcoach.avatarframe.dto;

public record AvatarFrameDto(
    Long id,
    String slug,
    AvatarFrameSeriesDto series,
    String name,
    String tier,
    String lineage,
    String renderType,
    String posterAsset,
    String previewAsset,
    AvatarFrameOwnershipDto ownership,
    AvatarFrameProgressDto progress,
    String visualTheme
) {
    public AvatarFrameDto(
        Long id,
        String slug,
        AvatarFrameSeriesDto series,
        String name,
        String tier,
        String lineage,
        String renderType,
        String posterAsset,
        String previewAsset,
        AvatarFrameOwnershipDto ownership,
        AvatarFrameProgressDto progress
    ) {
        this(id, slug, series, name, tier, lineage, renderType, posterAsset, previewAsset, ownership, progress, null);
    }
}
