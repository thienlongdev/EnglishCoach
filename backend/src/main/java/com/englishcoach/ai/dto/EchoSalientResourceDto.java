package com.englishcoach.ai.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * A validated, recently surfaced English Coach resource (from Echo cards or recent navigation) that the learner can
 * refer to anaphorically ("open it", "open the second one", "mở bài thứ hai"). Every {@code href} is re-verified on
 * the server against {@code EchoDestinations.HREF_ALLOW} before use.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record EchoSalientResourceDto(
        @Min(0) @Max(20) int index,
        @Size(max = 160) String title,
        @Size(max = 200) String href,
        @Size(max = 40) String kind
) {
}
