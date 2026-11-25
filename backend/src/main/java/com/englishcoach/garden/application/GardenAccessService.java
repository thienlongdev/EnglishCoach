package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import org.springframework.stereotype.Service;

/** Feature flag + allowlist (GDD 03 §14.4). A user without access is told nothing beyond 404. */
@Service
public class GardenAccessService {

    private final GardenProperties properties;

    public GardenAccessService(GardenProperties properties) {
        this.properties = properties;
    }

    public boolean allowed(long userId) {
        if (!properties.isEnabled()) return false;
        var allow = properties.getAllowlistUserIds();
        return allow == null || allow.isEmpty() || allow.contains(userId);
    }

    public boolean qa(long userId) {
        return allowed(userId) && properties.getQaUserIds() != null && properties.getQaUserIds().contains(userId);
    }

    public void require(long userId) {
        if (!allowed(userId)) throw new GardenException(404, "GARDEN_NOT_FOUND");
    }
}
