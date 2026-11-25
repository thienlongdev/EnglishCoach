package com.englishcoach.speaking.shadowing;

import com.englishcoach.common.security.UserDetailsImpl;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Authenticated REST controller for the server-side paginated Shadowing catalog.
 * Protected under {@code /api/v1/speaking/**} in {@code WebSecurityConfig} and principal-checked per request.
 */
@RestController
@RequestMapping("/api/v1/speaking/shadowing")
@RequiredArgsConstructor
public class SpeakingShadowingCatalogController {

    private final SpeakingShadowingCatalogService catalogService;

    private static Long requireUserId(UserDetailsImpl user) {
        if (user == null || user.getId() == null) {
            throw new AccessDeniedException("Authentication required");
        }
        return user.getId();
    }

    @GetMapping("/catalog")
    public ResponseEntity<ShadowingCatalogPageDto> getCatalog(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "12") int size,
            @RequestParam(required = false) String cefr,
            @RequestParam(required = false) String cefrLevel,
            @RequestParam(required = false) String accent,
            @RequestParam(defaultValue = "ALL") String source,
            @RequestParam(required = false) String q
    ) {
        String effectiveCefr = (cefr != null && !cefr.isBlank()) ? cefr : cefrLevel;
        ShadowingCatalogPageDto body = catalogService.getCatalog(
                requireUserId(userDetails),
                page,
                size,
                effectiveCefr,
                accent,
                source,
                q
        );
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(body);
    }

    @GetMapping("/catalog/{materialId}")
    public ResponseEntity<ShadowingMaterialCardDto> getCatalogCardById(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long materialId
    ) {
        ShadowingMaterialCardDto card = catalogService.findVisibleCardById(requireUserId(userDetails), materialId);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(card);
    }
}
