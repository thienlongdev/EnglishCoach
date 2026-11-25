package com.englishcoach.premium.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.dto.PremiumMeResponseDto;
import com.englishcoach.premium.dto.PremiumPlanDto;
import com.englishcoach.premium.service.PremiumEntitlementService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/premium")
@RequiredArgsConstructor
public class PremiumController {

    private final PremiumEntitlementService entitlementService;

    /**
     * GET /api/v1/premium/plans
     * Public endpoint returning active subscription plans and pricing.
     */
    @GetMapping("/plans")
    public ResponseEntity<List<PremiumPlanDto>> getPlans() {
        return ResponseEntity.ok(entitlementService.getActivePlans());
    }

    /**
     * GET /api/v1/premium/me
     * Authenticated endpoint returning user's Premium subscription state and feature entitlements.
     */
    @GetMapping("/me")
    public ResponseEntity<PremiumMeResponseDto> getMyEntitlement(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required to view entitlement");
        }
        return ResponseEntity.ok(entitlementService.getPremiumMe(userDetails.getId()));
    }
}
