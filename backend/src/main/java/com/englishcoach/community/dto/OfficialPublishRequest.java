package com.englishcoach.community.dto;

import com.englishcoach.community.entity.PostType;
import com.englishcoach.community.entity.SharedEntityType;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class OfficialPublishRequest {

    @NotBlank(message = "Nội dung bài viết không được để trống")
    @Size(max = 10000, message = "Nội dung bài viết tối đa 10,000 ký tự")
    private String content;

    @Builder.Default
    private PostType postType = PostType.OFFICIAL;

    private String seriesType;

    private boolean isPinned;

    private boolean isFeatured;

    private Instant scheduledFor;

    @Size(max = 12, message = "Tối đa 12 tệp đính kèm (tối đa 10 ảnh và 2 video)")
    private List<Long> mediaIds;

    @Size(max = 12, message = "Tối đa 12 tệp đính kèm (tối đa 10 ảnh và 2 video)")
    private List<String> mediaUrls;

    private SharedEntityType sharedEntityType;

    private String sharedEntityId;

    @JsonProperty("isPinned")
    public boolean isPinned() {
        return isPinned;
    }

    @JsonProperty("isPinned")
    public void setIsPinned(boolean isPinned) {
        this.isPinned = isPinned;
    }

    @JsonProperty("pinned")
    public void setPinned(boolean pinned) {
        this.isPinned = pinned;
    }

    @JsonProperty("isFeatured")
    public boolean isFeatured() {
        return isFeatured;
    }

    @JsonProperty("isFeatured")
    public void setIsFeatured(boolean isFeatured) {
        this.isFeatured = isFeatured;
    }

    @JsonProperty("featured")
    public void setFeatured(boolean featured) {
        this.isFeatured = featured;
    }

    @JsonProperty("seriesName")
    public void setSeriesName(String seriesName) {
        this.seriesType = seriesName;
    }

    @JsonProperty("scheduledAt")
    public void setScheduledAt(String scheduledAt) {
        if (scheduledAt != null && !scheduledAt.isBlank()) {
            try {
                this.scheduledFor = Instant.parse(scheduledAt);
            } catch (Exception ignored) {}
        }
    }
}
