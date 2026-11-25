package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.WritingSourceType;
import jakarta.validation.constraints.NotNull;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CreateSessionFromSourceRequest {
    @NotNull
    private WritingSourceType sourceType;
    private String sourceId;
}
