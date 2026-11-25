package com.englishcoach.community.dto;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.community.entity.AuthorType;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthorSummaryDto {
    private Long id;
    private String name;
    private AuthorType authorType;
    private String avatarUrl;
    private AvatarFrameDto frame;
    private boolean isOfficial;
    private boolean isPremium;
    private Integer streakDays;
    private String cefrLevel;
    private Boolean isFollowing;

    @JsonProperty("userId")
    public Long getUserId() {
        return id;
    }

    @JsonProperty("displayName")
    public String getDisplayName() {
        return name != null && !name.isBlank() ? name : "Học viên";
    }

    @JsonProperty("equippedFrameId")
    public String getEquippedFrameId() {
        if (frame == null) return null;
        if (frame.slug() != null && !frame.slug().isBlank()) return frame.slug();
        return frame.id() != null ? String.valueOf(frame.id()) : null;
    }

    public boolean isOfficial() {
        return isOfficial;
    }

    public boolean isPremium() {
        return isPremium;
    }

    @JsonProperty("official")
    public boolean getOfficial() {
        return isOfficial;
    }

    @JsonProperty("premium")
    public boolean getPremium() {
        return isPremium;
    }

    @JsonProperty("followedByMe")
    public Boolean getFollowedByMe() {
        return isFollowing;
    }
}
