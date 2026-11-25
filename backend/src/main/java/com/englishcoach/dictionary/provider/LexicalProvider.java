package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;

import java.util.Optional;

public interface LexicalProvider {
    String getName();
    boolean isAvailable();
    Optional<CanonicalDictionaryResponse> lookup(String query, String mode);
}
