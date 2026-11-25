package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Cambridge Dictionary API adapter.
 * Configurable, disabled by default.
 * Only active when legitimate licensed access is configured.
 * Does NOT scrape Cambridge web pages.
 */
@Slf4j
@Component
public class CambridgeProvider implements LexicalProvider {

    @Value("${dictionary.cambridge.enabled:false}")
    private boolean enabled;

    @Value("${dictionary.cambridge.api-key:}")
    private String apiKey;

    @Value("${dictionary.cambridge.base-url:https://dictionary.cambridge.org/api/v1}")
    private String baseUrl;

    @Override
    public String getName() {
        return "Cambridge";
    }

    @Override
    public boolean isAvailable() {
        return enabled && apiKey != null && !apiKey.isBlank();
    }

    @Override
    public Optional<CanonicalDictionaryResponse> lookup(String query, String mode) {
        if (!isAvailable()) {
            return Optional.empty();
        }
        // When licensed API access is configured, query Cambridge endpoint here.
        return Optional.empty();
    }
}
