package com.englishcoach.listening.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.dto.ErrorDNADto;
import com.englishcoach.listening.dto.SegmentHeatmapDto;
import com.englishcoach.listening.service.ListeningAnalyticsService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/listening/analytics")
@RequiredArgsConstructor
public class ListeningAnalyticsController {

    private final ListeningAnalyticsService analyticsService;

    @GetMapping("/dna")
    public ResponseEntity<ErrorDNADto> getErrorDNA(@AuthenticationPrincipal UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new AccessDeniedException("Authentication required for listening analytics");
        }
        return ResponseEntity.ok(analyticsService.getUserErrorDNA(userDetails.getId()));
    }

    @GetMapping("/materials/{materialId}/heatmap")
    public ResponseEntity<List<SegmentHeatmapDto>> getMaterialHeatmap(
            @PathVariable Long materialId,
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new AccessDeniedException("Authentication required for listening heatmap");
        }
        return ResponseEntity.ok(analyticsService.getMaterialHeatmap(materialId, userDetails.getId()));
    }
}
