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
public class PlanSectionDto {

    @JsonProperty("section_title")
    private String sectionTitle;

    @Builder.Default
    private List<String> points = new ArrayList<>();
}
