package com.englishcoach.background;

import com.englishcoach.background.BackgroundPreferenceDtos.BackgroundPreferencesResponse;
import com.englishcoach.background.BackgroundPreferenceDtos.SaveBackgroundPreferencesRequest;
import com.englishcoach.background.BackgroundPreferenceValidator.ValidatedPreferences;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Echo Background Studio preferences service. Strictly scoped to the authenticated learner's {@code userId}.
 * Pure local database persistence: zero AI calls, zero external requests.
 */
@Service
public class BackgroundPreferenceService {

    private final BackgroundPreferenceRepository repository;
    private final BackgroundPreferenceValidator validator;

    public BackgroundPreferenceService(
            BackgroundPreferenceRepository repository,
            BackgroundPreferenceValidator validator) {
        this.repository = repository;
        this.validator = validator;
    }

    @Transactional(readOnly = true)
    public BackgroundPreferencesResponse get(long userId) {
        return repository.find(userId).orElseGet(BackgroundPreferenceValidator::defaultResponse);
    }

    @Transactional
    public BackgroundPreferencesResponse save(long userId, SaveBackgroundPreferencesRequest request) {
        ValidatedPreferences validated = validator.validateAndSanitize(request);
        repository.lockOwner(userId);
        return repository.upsert(userId, validated.schemaVersion(), validated.serializedJson());
    }

    @Transactional
    public void reset(long userId) {
        repository.lockOwner(userId);
        repository.delete(userId);
    }
}
