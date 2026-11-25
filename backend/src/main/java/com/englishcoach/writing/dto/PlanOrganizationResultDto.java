package com.englishcoach.writing.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

import java.util.ArrayList;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PlanOrganizationResultDto {

    @JsonProperty("organized_sections")
    @Builder.Default
    private List<PlanSectionDto> organizedSections = new ArrayList<>();

    @Builder.Default
    private List<String> suggestions = new ArrayList<>();
}
