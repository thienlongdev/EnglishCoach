package com.englishcoach.community.dto;

import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.entity.PostType;
import com.englishcoach.community.entity.ReactionType;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityPostDto {
    private Long id;
    private AuthorSummaryDto author;
    private PostStatus status;
    private PostType postType;
    private String content;
    private boolean isPinned;
    private boolean isFeatured;
    private String seriesType;
    private Instant publishedAt;
    private Instant createdAt;
    private int likeCount;
    private int commentCount;
    private int saveCount;
    private ReactionType myReaction;
    private boolean isSaved;
    private boolean commentsDisabled;
    private boolean commentsDisabledByOwner;
    private boolean commentsLockedByAdmin;

    @Builder.Default
    private List<ReactionType> topReactions = new ArrayList<>();

    @Builder.Default
    private List<CommunityPostMediaDto> media = new ArrayList<>();

    private SharedLearningEmbedDto learningEmbed;
    private String moderationReason;
    private Long reportCount;

    @JsonProperty("savedByMe")
    public boolean isSavedByMe() {
        return isSaved;
    }

    @JsonProperty("pinned")
    public boolean isPinnedAlias() {
        return isPinned;
    }

    @JsonProperty("featured")
    public boolean isFeaturedAlias() {
        return isFeatured;
    }

    @JsonProperty("reactionCount")
    public int getReactionCountAlias() {
        return likeCount;
    }

    @JsonProperty("sharedEmbed")
    public SharedLearningEmbedDto getSharedEmbed() {
        return learningEmbed;
    }

    @JsonProperty("seriesName")
    public String getSeriesNameAlias() {
        return seriesType;
    }
}
