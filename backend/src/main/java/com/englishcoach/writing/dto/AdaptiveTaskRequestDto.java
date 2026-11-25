package com.englishcoach.writing.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AdaptiveTaskRequestDto {

    @Pattern(regexp = "^(A1|A2|B1|B2|C1|C2)$", message = "CEFR level must be one of A1, A2, B1, B2, C1, C2")
    private String cefrLevel;

    @Size(max = 64, message = "Category must not exceed 64 characters")
    @Pattern(regexp = "^[A-Za-z0-9 _/-]{1,64}$", message = "Invalid category")
    private String category;

    @Size(max = 64, message = "Register must not exceed 64 characters")
    @Pattern(
            regexp = "(?i)^(formal|informal|neutral|standard|casual|semi-formal|academic|business|professional|academic formal|formal academic|professional business|professional formal|professional / courteous|casual / friendly|neutral / informative|reflective / expressive)$",
            message = "Invalid register"
    )
    private String register;

    @Size(max = 10, message = "At most 10 focus pattern codes are allowed")
    private List<@Size(max = 64, message = "Focus pattern code must not exceed 64 characters")
            @Pattern(regexp = "^[A-Za-z0-9_:-]{1,64}$", message = "Invalid focus pattern code") String> focusPatternCodes;
}
