package com.englishcoach.community.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityPostMediaDto {
    private Long id;
    private String url;
    private String fileName;
    private Long fileSize;
    private String mimeType;
    private Integer width;
    private Integer height;
    private String type;
    @Builder.Default
    private int order = 0;

    @JsonProperty("type")
    public String getType() {
        if (type != null && !type.isBlank()) return type;
        if (mimeType != null && mimeType.toLowerCase().startsWith("video/")) {
            return "VIDEO";
        }
        return "IMAGE";
    }

    @JsonProperty("mediaType")
    public String getMediaType() {
        return mimeType != null ? mimeType : (getType().equals("VIDEO") ? "video/mp4" : "image/jpeg");
    }

    @JsonProperty("mediaUrl")
    public String getMediaUrl() {
        return url;
    }

    @JsonProperty("order")
    public int getOrder() {
        return order;
    }

    @JsonProperty("sortOrder")
    public int getSortOrder() {
        return order;
    }

    @JsonProperty("displayOrder")
    public int getDisplayOrder() {
        return order;
    }
}
