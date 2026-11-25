package com.englishcoach.exams.controller;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamContentRecords.FormDetailDto;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.service.ExamContentService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams")
@RequiredArgsConstructor
public class ExamCatalogController {

    private final ExamContentService contentService;
    private final ExamsProperties examsProperties;

    @GetMapping("/capabilities")
    public ResponseEntity<Map<String, Object>> getCapabilities() {
        return ResponseEntity.ok(Map.of(
                "enabled", examsProperties.isEnabled(),
                "supportedFamilies", List.of("IELTS", "TOEIC"),
                "primaryAreas", List.of("IELTS", "TOEIC", "COMPETENCY_PROFILE"),
                "limits", Map.of(
                        "maxBatchSize", examsProperties.getLimits().getMaxResponseBatchSize(),
                        "maxChunkBytes", examsProperties.getLimits().getMaxUploadChunkBytes(),
                        "sessionLeaseSeconds", examsProperties.getLimits().getSessionLeaseSeconds()
                )
        ));
    }

    @GetMapping("/catalog")
    public ResponseEntity<?> getCatalog(
            @RequestParam(required = false) String family,
            @RequestParam(required = false) String variant,
            @RequestParam(required = false) String scope,
            @RequestParam(required = false) Boolean strictProduction,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(required = false) String availability,
            @RequestParam(required = false) String query,
            @RequestParam(required = false) UUID formId
    ) {
        ExamFamily fam = family != null ? ExamFamily.fromString(family) : null;
        boolean allowPilot = Boolean.TRUE.equals(strictProduction) ? false : !examsProperties.isStrictMode();
        if (availability != null) return ResponseEntity.ok(contentService.getCatalogWindow(fam, variant, scope,
                limit, offset, allowPilot, availability, query, formId));
        List<CatalogFormDto> forms = contentService.getCatalog(fam, variant, scope, limit, offset, allowPilot);
        return ResponseEntity.ok(forms);
    }

    @GetMapping("/forms/{id}")
    public ResponseEntity<FormDetailDto> getFormDetails(@PathVariable UUID id) {
        return contentService.getFormDetails(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
