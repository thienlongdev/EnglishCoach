package com.englishcoach.listening.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.service.ListeningWorkspaceService;
import com.englishcoach.auth.service.LoginThrottleService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/v1/listening/materials/{id}")
@RequiredArgsConstructor
public class ListeningWorkspaceController {
    private final ListeningWorkspaceService workspace;
    private final LoginThrottleService throttle;
    @GetMapping("/progress")
    public ResponseEntity<ListeningWorkspaceService.Checkpoint> get(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable long id){
        return response(workspace.get(principal(user),id));
    }
    @PutMapping("/progress")
    public ResponseEntity<ListeningWorkspaceService.Checkpoint> save(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable long id,@RequestBody ListeningWorkspaceService.Save request){
        long owner=principal(user);limit(owner,"LISTENING_CHECKPOINT",60);return response(workspace.save(owner,id,request));
    }
    @GetMapping("/translations")
    public ResponseEntity<ListeningWorkspaceService.Translations> translations(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable long id){return response(workspace.translations(principal(user),id));}
    @PostMapping("/translations")
    public ResponseEntity<ListeningWorkspaceService.Translations> submit(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable long id,@RequestBody ListeningWorkspaceService.TranslationSubmit request){
        long owner=principal(user);limit(owner,"LISTENING_TRANSLATE",40);return response(workspace.submit(owner,id,request));
    }
    private static long principal(UserDetailsImpl user){if(user==null)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Vui lòng đăng nhập.");return user.getId();}
    private void limit(long user,String kind,int max){if(!throttle.countRequest(kind,"user:"+user,max,1))throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Vui lòng chờ trước khi thử lại.");}
    private static <T> ResponseEntity<T> response(T body){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);}
}
