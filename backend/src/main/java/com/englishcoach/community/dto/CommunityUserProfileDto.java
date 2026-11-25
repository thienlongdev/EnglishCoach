package com.englishcoach.community.dto;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityUserProfileDto {
    private Long id;
    private String name;
    private String avatarUrl;
    private AvatarFrameDto frame;
    private boolean isPremium;
    private int streakDays;
    private String cefrLevel;
    private long followerCount;
    private long followingCount;
    private boolean isFollowing;
}
