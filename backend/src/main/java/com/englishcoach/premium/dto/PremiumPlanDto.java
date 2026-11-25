package com.englishcoach.premium.dto;

import lombok.Builder;
import lombok.Value;

@Value
@Builder
public class PremiumPlanDto {
    Long id;
    String code;
    String name;
    Integer durationMonths;
    Long priceVnd;
    Integer displayOrder;
    String badge;
    boolean active;
}
