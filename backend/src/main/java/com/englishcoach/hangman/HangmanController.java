package com.englishcoach.hangman;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.validation.Valid;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/games/hangman")
public final class HangmanController {
    private final HangmanService game; private final LoginThrottleService throttle;
    public HangmanController(HangmanService game,LoginThrottleService throttle){this.game=game;this.throttle=throttle;}
    @GetMapping("/bootstrap") public ResponseEntity<HangmanDtos.Bootstrap> bootstrap(@AuthenticationPrincipal UserDetailsImpl user){return response(game.bootstrap(owner(user)));}
    @GetMapping("/rounds/{id}") public ResponseEntity<HangmanDtos.Round> get(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){return response(game.get(owner(user),id));}
    @PostMapping("/rounds") public ResponseEntity<HangmanDtos.Round> start(@AuthenticationPrincipal UserDetailsImpl user,@Valid @RequestBody HangmanDtos.StartRequest request){return response(game.start(mutation(user),request));}
    @PostMapping("/rounds/{id}/guesses") public ResponseEntity<HangmanDtos.Round> guess(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id,@Valid @RequestBody HangmanDtos.GuessRequest request){return response(game.guess(mutation(user),id,request));}
    @PostMapping("/rounds/{id}/hints") public ResponseEntity<HangmanDtos.Round> hint(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id,@Valid @RequestBody HangmanDtos.HintRequest request){return response(game.hint(mutation(user),id,request));}
    @PostMapping("/rounds/{id}/retry") public ResponseEntity<HangmanDtos.Round> retry(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id,@Valid @RequestBody HangmanDtos.RetryRequest request){return response(game.retry(mutation(user),id,request));}
    private long owner(UserDetailsImpl user){if(user==null||user.getId()==null)throw new HangmanException(401,"AUTH_REQUIRED");return user.getId();}
    private long mutation(UserDetailsImpl user){long id=owner(user);if(!throttle.checkAndIncrementRateLimit("HANGMAN_COMMAND","user:"+id,120,1))throw new HangmanException(429,"RATE_LIMITED");return id;}
    private <T> ResponseEntity<T> response(T body){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);}
}
