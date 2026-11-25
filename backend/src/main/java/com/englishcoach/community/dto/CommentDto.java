package com.englishcoach.community.dto;

import com.englishcoach.community.entity.ReactionType;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommentDto {
    private Long id;
    private Long postId;
    private AuthorSummaryDto author;
    private Long parentCommentId;
    private String replyToAuthorName;
    private String content;
    private String mediaUrl;
    private String mediaType;

    @Builder.Default
    private List<CommunityCommentMediaDto> media = new ArrayList<>();

    private String status;
    private int likeCount;
    private int replyCount;
    private boolean isLiked;
    private ReactionType myReaction;

    @Builder.Default
    private Map<String, Integer> reactionCounts = new HashMap<>();

    @Builder.Default
    private List<CommentReactorPreviewDto> topReactors = new ArrayList<>();

    private Instant createdAt;

    @Builder.Default
    private List<CommentDto> replies = new ArrayList<>();

    @JsonProperty("parentId")
    public Long getParentId() {
        return parentCommentId;
    }

    @JsonProperty("reactionCount")
    public int getReactionCountAlias() {
        return likeCount;
    }

    @JsonProperty("children")
    public List<CommentDto> getChildren() {
        return replies;
    }

    @JsonProperty("childrenCount")
    public int getChildrenCount() {
        return replyCount;
    }
}
