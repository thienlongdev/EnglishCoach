package com.englishcoach.payment.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreatePaymentOrderRequest {

    @com.fasterxml.jackson.annotation.JsonAnySetter
    public void rejectUnknownField(String field, Object value) {
        throw new IllegalArgumentException("Only planCode is accepted");
    }

    @NotBlank(message = "planCode is required")
    private String planCode;
}
