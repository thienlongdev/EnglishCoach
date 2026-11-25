package com.englishcoach.listening.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ImportListeningMaterialRequest {
    @NotBlank(message = "YouTube URL is required")
    private String youtubeUrl;
    private String title;
    private String cefrLevel;
    private String topic;
    private String accent;
    private String channel;
}
