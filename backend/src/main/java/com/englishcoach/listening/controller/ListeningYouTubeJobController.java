package com.englishcoach.listening.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.dto.ImportListeningMaterialRequest;
import com.englishcoach.listening.service.ListeningYouTubeJobs;
import com.englishcoach.auth.service.LoginThrottleService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/v1/listening/youtube-jobs")
public class ListeningYouTubeJobController {
    private final ListeningYouTubeJobs jobs;
    private final LoginThrottleService throttle;
    @PostMapping public ResponseEntity<ListeningYouTubeJobs.Job> create(@AuthenticationPrincipal UserDetailsImpl user,
            @Valid @RequestBody ImportListeningMaterialRequest request) {
        Long owner=owner(user);
        if(!throttle.countRequest("LISTENING_YOUTUBE_CREATE","user:"+owner,10,1))
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Vui lòng chờ trước khi thử lại.");
        // Quota is reserved by the service and completed WITH the saved lesson, never on this HTTP 202.
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(jobs.create(owner,request));
    }
    @GetMapping public ResponseEntity<List<ListeningYouTubeJobs.Job>> recent(@AuthenticationPrincipal UserDetailsImpl user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(jobs.recent(owner(user)));
    }
    @GetMapping("/{id}") public ResponseEntity<ListeningYouTubeJobs.Job> get(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(jobs.get(owner(user),id));
    }
    @DeleteMapping("/{id}") public ResponseEntity<ListeningYouTubeJobs.Job> cancel(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(jobs.cancel(owner(user),id));
    }
    private static Long owner(UserDetailsImpl user){if(user==null)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Vui lòng đăng nhập.");return user.getId();}
}
