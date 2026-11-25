package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * Sketch Engine Word Sketch adapter.
 * Configurable, disabled by default.
 * Only active when legitimate licensed access is configured.
 */
@Slf4j
@Component
public class SketchEngineProvider {

    @Value("${dictionary.sketchengine.enabled:false}")
    private boolean enabled;

    @Value("${dictionary.sketchengine.api-key:}")
    private String apiKey;

    public boolean isAvailable() {
        return enabled && apiKey != null && !apiKey.isBlank();
    }

    public Optional<List<CanonicalDictionaryResponse.CollocationDto>> getCollocations(String word) {
        if (!isAvailable()) {
            return Optional.empty();
        }
        // When licensed Sketch Engine API access is configured, query Word Sketch here.
        return Optional.empty();
    }
}
