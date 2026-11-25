package com.englishcoach.studyspace;
import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import java.time.Instant;
import java.util.*;
@RestController
@RequestMapping("/api/v1/study-space/time-blocks")
public class StudyPlannerController {
    private final StudyPlannerService service;
    public StudyPlannerController(StudyPlannerService service){this.service=service;}
    private long owner(UserDetailsImpl u){if(u==null||u.getId()==null)throw new StudySpaceException(401,"AUTH_REQUIRED");return u.getId();}
    private <T> ResponseEntity<T> ok(T data){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(data);}
    @GetMapping public ResponseEntity<List<StudyPlannerService.Occurrence>> list(@AuthenticationPrincipal UserDetailsImpl u,@RequestParam Instant from,@RequestParam Instant to){return ok(service.calendar(owner(u),from,to));}
    @PostMapping public ResponseEntity<StudyPlannerService.Block> create(@AuthenticationPrincipal UserDetailsImpl u,@RequestBody StudyPlannerService.Block b){return ok(service.save(owner(u),null,b));}
    @PutMapping("/{id}") public ResponseEntity<StudyPlannerService.Block> update(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@RequestBody StudyPlannerService.Block b){return ok(service.save(owner(u),id,b));}
    @DeleteMapping("/{id}") public ResponseEntity<Void> remove(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){service.delete(owner(u),id);return ok(null);}
    @PutMapping("/{id}/sessions/{session}") public ResponseEntity<Void> link(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@PathVariable UUID session){service.link(owner(u),id,session);return ok(null);}
}
