package com.englishcoach.learningpath;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.learningpath.OdysseyDtos.*;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/v1/learning-path/odyssey")
public class OdysseyController {
    private final OdysseyService service;
    private final OdysseyCatalog catalog;
    public OdysseyController(OdysseyService service,OdysseyCatalog catalog) { this.service=service;this.catalog=catalog; }
    @PostMapping("/world") public ResponseEntity<World> world(@AuthenticationPrincipal UserDetailsImpl u) { return ok(service.world(owner(u))); }
    @GetMapping("/regions/{id}") public ResponseEntity<RegionDetail> region(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable String id) { return ok(service.region(owner(u),id)); }
    @GetMapping("/competencies") public ResponseEntity<List<OdysseyCatalog.Competency>> competencies(@AuthenticationPrincipal UserDetailsImpl u) { owner(u);return ok(catalog.competencies()); }
    @PostMapping("/discover") public ResponseEntity<List<Exploration>> discover(@AuthenticationPrincipal UserDetailsImpl u,@Valid @RequestBody ExploreRequest r) { return ok(service.discover(owner(u),r)); }
    @PutMapping("/navigation") public ResponseEntity<Navigation> navigate(@AuthenticationPrincipal UserDetailsImpl u,@Valid @RequestBody NavigateRequest r) { return ok(service.navigate(owner(u),r)); }
    @PutMapping("/preferences") public ResponseEntity<Navigation> preferences(@AuthenticationPrincipal UserDetailsImpl u,@Valid @RequestBody PreferencesRequest r) { return ok(service.preferences(owner(u),r)); }
    @PostMapping("/launch") public ResponseEntity<LaunchView> launch(@AuthenticationPrincipal UserDetailsImpl u,@Valid @RequestBody LaunchRequest r) { return ok(service.launch(owner(u),r)); }
    @GetMapping("/active") public ResponseEntity<LaunchView> active(@AuthenticationPrincipal UserDetailsImpl u) { return ok(service.active(owner(u))); }
    @GetMapping("/launches/{id}") public ResponseEntity<LaunchView> launchById(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id) { return ok(service.launchById(owner(u),id)); }
    @GetMapping("/journal") public ResponseEntity<List<Reward>> journal(@AuthenticationPrincipal UserDetailsImpl u,@RequestParam(defaultValue="0") int offset) { return ok(service.journal(owner(u),offset)); }
    private static long owner(UserDetailsImpl u) { if(u==null||u.getId()==null)throw new LearningPathException(401,"AUTH_REQUIRED");return u.getId(); }
    private static <T> ResponseEntity<T> ok(T value) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value); }
}
