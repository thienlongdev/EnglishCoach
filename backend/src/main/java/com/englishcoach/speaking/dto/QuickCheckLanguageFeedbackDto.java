package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonAlias;
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
@JsonIgnoreProperties(ignoreUnknown = true)
public class QuickCheckLanguageFeedbackDto {
    private String status; // CORRECT | NEEDS_IMPROVEMENT
    @JsonAlias("positive_feedback")
    private String positiveFeedback;
    @Builder.Default
    private List<QuickCheckCorrectionDto> corrections = new ArrayList<>();
    @JsonAlias("natural_version")
    private String naturalVersion;
    @JsonAlias("meaning_note_vi")
    private String meaningNoteVi;
    @JsonAlias("is_mocked")
    @Builder.Default
    private Boolean isMocked = false;
}
