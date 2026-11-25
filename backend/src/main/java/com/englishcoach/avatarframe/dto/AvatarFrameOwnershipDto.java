package com.englishcoach.avatarframe.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

public record AvatarFrameOwnershipDto(
    boolean owned,
    @JsonProperty("equipped") boolean isEquipped,
    Instant expiresAt,
    String source,
    Instant unlockedAt,
    Long ownerCount
) {
    public AvatarFrameOwnershipDto(boolean owned, boolean isEquipped, Instant expiresAt) {
        this(owned, isEquipped, expiresAt, null, null, null);
    }

    @JsonProperty("equipped")
    public boolean equipped() {
        return isEquipped;
    }

    @JsonProperty("isEquipped")
    public boolean isEquipped() {
        return isEquipped;
    }
}
