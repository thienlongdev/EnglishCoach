package com.englishcoach.speaking.shadowing;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Lightweight card projection for the paginated Shadowing library catalog.
 * Excludes transcript_segments, words_json, exercises, and audio storage internals.
 */
public record ShadowingMaterialCardDto(
        Long id,
        String title,
        String topic,
        String channel,
        String youtubeVideoId,
        String thumbnail,
        int durationSeconds,
        String cefrLevel,
        String accent,
        @JsonProperty("isSystem") boolean isSystem,
        String sourceType
) {}
