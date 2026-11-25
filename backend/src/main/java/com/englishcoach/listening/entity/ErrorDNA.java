package com.englishcoach.listening.entity;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import lombok.*;

@Embeddable
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ErrorDNA {
    @Enumerated(EnumType.STRING)
    private ErrorCategory errorCategory;

    private Integer occurrenceCount;
    private Double historicalWeight;
}
