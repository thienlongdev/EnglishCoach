package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphAssistanceSegmentDto {
    private Integer segmentIndex;
    private String sourceVi;
    private Integer tokenCount;
    private Boolean revealed;
    private String text; // Present only if segment is revealed
    private List<String> tokens; // Present with revealed tokens or mask placeholders (e.g. "••••")
}
