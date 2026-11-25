package com.englishcoach.background;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;

/**
 * Wire DTOs for Echo Background Studio preferences ({@code /api/v1/users/me/background-preferences}).
 * Every request and response is scoped exclusively to the authenticated principal; no DTO carries a user id.
 */
public final class BackgroundPreferenceDtos {

    private BackgroundPreferenceDtos() {
    }

    /**
     * Current learner's background preferences document.
     * {@code revision == 0} and {@code updatedAt == null} indicate the learner has not saved preferences yet.
     */
    public record BackgroundPreferencesResponse(
            int schemaVersion,
            long revision,
            JsonNode state,
            Instant updatedAt
    ) {
    }

    /**
     * Save payload accepted by {@code PUT /api/v1/users/me/background-preferences}.
     * Accepts either {@code { schemaVersion, state }} or {@code { state }} (with {@code state.schemaVersion = 1}).
     */
    public record SaveBackgroundPreferencesRequest(
            Integer schemaVersion,
            @NotNull JsonNode state
    ) {
    }
}
