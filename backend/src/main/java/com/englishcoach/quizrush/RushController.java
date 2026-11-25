package com.englishcoach.quizrush;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.auth.service.LoginThrottleService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.http.*;
import java.util.*;

@RestController
@RequestMapping("/api/v1/games/echo-quiz-rush")
public class RushController {
    private final RushService service;private final LoginThrottleService throttle;
    public RushController(RushService service,LoginThrottleService throttle){this.service=service;this.throttle=throttle;}
    long owner(UserDetailsImpl user){if(user==null||user.getId()==null)throw new RushException(401,"AUTH_REQUIRED");return user.getId();}
    long mutation(UserDetailsImpl user){long id=owner(user);if(!throttle.checkAndIncrementRateLimit("QUIZ_RUSH","user:"+id,120,1))throw new RushException(429,"RATE_LIMITED");return id;}
    <T> ResponseEntity<T> response(T body){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);}
    @GetMapping("/config") public ResponseEntity<?> config(@AuthenticationPrincipal UserDetailsImpl user){owner(user);return response(service.config());}
    @GetMapping("/active") public ResponseEntity<?> active(@AuthenticationPrincipal UserDetailsImpl user){return response(service.active(owner(user)));}
    @GetMapping("/history") public ResponseEntity<?> history(@AuthenticationPrincipal UserDetailsImpl user){return response(service.history(owner(user)));}
    @GetMapping("/sessions/{id}") public ResponseEntity<?> get(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){return response(service.get(owner(user),id));}
    @PostMapping("/sessions") public ResponseEntity<?> start(@AuthenticationPrincipal UserDetailsImpl user,@Valid @RequestBody RushDtos.Start request){return response(service.start(mutation(user),request));}
    @PostMapping("/sessions/{id}/answers") public ResponseEntity<?> answer(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id,@Valid @RequestBody RushDtos.Answer request){return response(service.answer(mutation(user),id,request));}
    @PostMapping("/sessions/{id}/finish") public ResponseEntity<?> finish(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){return response(service.finish(mutation(user),id));}
    @PostMapping("/sessions/{id}/abandon") public ResponseEntity<?> abandon(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){return response(service.abandon(mutation(user),id));}
}
