package com.englishcoach.cosmos;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Echo Neural Cosmos (Vũ trụ tri thức). Reads of the caller's own evidence; no AI, no write of learning data. */
@RestController
@RequestMapping("/api/v1/cosmos")
public class CosmosController {
    private final CosmosOverlayService overlay;
    private final CosmosPassageService passages;

    public CosmosController(CosmosOverlayService overlay, CosmosPassageService passages) {
        this.overlay = overlay;
        this.passages = passages;
    }

    @GetMapping("/overlay")
    public ResponseEntity<CosmosDtos.Overlay> overlay(@AuthenticationPrincipal UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(overlay.overlay(user.getId()));
    }

    /** Sentences of the caller's visible sources in which a concept's forms occur (deterministic; read-only; no AI). */
    @PostMapping("/passages")
    public ResponseEntity<CosmosDtos.Passages> passages(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody CosmosDtos.PassageQuery query) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(passages.passages(user.getId(), query));
    }
}
