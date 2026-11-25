package com.englishcoach.user.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;

public record UpdateUserProfileRequest(
        @Size(max = 100, message = "Display name cannot exceed 100 characters")
        String displayName,

        @Size(max = 32, message = "Phone cannot exceed 32 characters")
        String phone,

        @Size(max = 100, message = "City cannot exceed 100 characters")
        String city,

        @Size(max = 100, message = "Province cannot exceed 100 characters")
        String province,

        @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd")
        LocalDate dateOfBirth
) {
    public UpdateUserProfileRequest(String displayName, String phone, String city, String province) {
        this(displayName, phone, city, province, null);
    }
}
