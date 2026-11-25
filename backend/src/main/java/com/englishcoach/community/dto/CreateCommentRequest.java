package com.englishcoach.community.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreateCommentRequest {

    @Size(max = 2000, message = "Bình luận tối đa 2,000 ký tự")
    private String content;

    private Long parentCommentId;

    private String mediaUrl;

    private String mediaType;

    @Builder.Default
    private List<CommentMediaItemRequest> media = new ArrayList<>();

    private List<String> mediaUrls;

    @JsonProperty("parentId")
    public void setParentId(Long parentId) {
        if (this.parentCommentId == null) {
            this.parentCommentId = parentId;
        }
    }

    @JsonProperty("parentCommentId")
    public void setParentCommentId(Long parentCommentId) {
        this.parentCommentId = parentCommentId;
    }

    @JsonProperty("parentId")
    public Long getParentId() {
        return parentCommentId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CommentMediaItemRequest {
        private String mediaUrl;
        private String mediaType;
    }
}
