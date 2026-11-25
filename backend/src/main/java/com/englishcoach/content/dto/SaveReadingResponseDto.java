package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SaveReadingResponseDto {
    private boolean saved;
    private boolean alreadySaved;
    private Long libraryArticleId;
}
