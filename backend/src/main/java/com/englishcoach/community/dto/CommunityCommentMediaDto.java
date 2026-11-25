package com.englishcoach.community.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityCommentMediaDto {
    private Long id;
    private String mediaUrl;
    private String mediaType;
    private int displayOrder;
}
