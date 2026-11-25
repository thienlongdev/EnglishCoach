package com.englishcoach.reading.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.reading.dto.BilingualReadingCatalogResponse;
import com.englishcoach.reading.dto.BilingualReadingDetailResponse;
import com.englishcoach.reading.service.BilingualReadingImporter;
import com.englishcoach.reading.service.BilingualReadingService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/reading/bilingual")
@RequiredArgsConstructor
public class BilingualReadingController {
    private final BilingualReadingService service;
    private void requireUser(UserDetailsImpl user) { if (user == null || user.getId() == null) throw new org.springframework.security.access.AccessDeniedException("Authentication required"); }
    @GetMapping("/catalog")
    public ResponseEntity<BilingualReadingCatalogResponse> catalog(@AuthenticationPrincipal UserDetailsImpl user, @RequestParam(defaultValue="") String contentType, @RequestParam(defaultValue="") String revision) {
        requireUser(user);
        var catalog = service.catalog(contentType);
        if (catalog.catalogRevision().equals(revision)) return ResponseEntity.status(304).cacheControl(CacheControl.noStore()).eTag(catalog.catalogRevision()).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).eTag(catalog.catalogRevision()).body(catalog);
    }
    @GetMapping("/materials/{id}")
    public ResponseEntity<BilingualReadingDetailResponse> detail(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable Long id) { requireUser(user); return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.detail(id)); }

    @RestController
    @RequestMapping("/api/v1/reading/admin/bilingual")
    @PreAuthorize("hasRole('ADMIN')")
    public static class AdminController {
        private final BilingualReadingImporter importer;
        private final AdminIdentityService adminIdentity;
        public AdminController(BilingualReadingImporter importer, AdminIdentityService adminIdentity) { this.importer = importer; this.adminIdentity = adminIdentity; }
        public record Request(boolean apply, boolean allowUpdates, String manifestSha256) {}
        @PostMapping
        public ResponseEntity<BilingualReadingImporter.Result> run(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody Request request) {
            adminIdentity.requireOfficialAdmin(user == null ? null : user.getId());
            return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(importer.run(request.apply(), request.allowUpdates(), request.manifestSha256()));
        }
    }
}
