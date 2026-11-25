package com.englishcoach.spelling;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.core.io.Resource;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.server.ResponseStatusException;
import java.security.Principal;
import java.util.*;
import static com.englishcoach.spelling.SpellingProtocol.*;

@Controller
public class SpellingController {
    private final SpellingService service;private final SpellingEvents events;
    public SpellingController(SpellingService service,SpellingEvents events){this.service=service;this.events=events;}
    private static long user(UserDetailsImpl u){if(u==null)throw SpellingService.fail(401,"AUTH_REQUIRED");return u.getId();}
    private static <T> ResponseEntity<T> ok(T body){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);}
    @GetMapping("/api/v1/spelling/config") @ResponseBody public ResponseEntity<?> config(@AuthenticationPrincipal UserDetailsImpl u){user(u);return ok(service.config());}
    @GetMapping("/api/v1/spelling/records") @ResponseBody public ResponseEntity<Records> records(@AuthenticationPrincipal UserDetailsImpl u){return ok(service.records(user(u)));}
    @GetMapping("/api/v1/spelling/leaderboard") @ResponseBody public ResponseEntity<?> leaderboard(@AuthenticationPrincipal UserDetailsImpl u,@RequestParam(defaultValue="EASY") String difficulty){user(u);return ok(service.leaderboard(difficulty));}
    @GetMapping("/api/v1/spelling/rooms/{id}") @ResponseBody public ResponseEntity<State> state(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){return ok(service.state(user(u),id));}
    @GetMapping("/api/v1/spelling/rooms/{id}/audio/{turn}") @ResponseBody
    public ResponseEntity<Resource> audio(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@PathVariable UUID turn){return wav(service.audio(user(u),id,turn));}
    @GetMapping("/api/v1/spelling/announcements/{key}") @ResponseBody
    public ResponseEntity<Resource> phrase(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable String key){user(u);return wav(service.phrase(key));}
    private ResponseEntity<Resource> wav(SpellingCatalog.Clip clip){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.parseMediaType("audio/wav")).header("X-Audio-Duration-Ms",Long.toString(clip.durationMs())).body(SpellingCatalog.resource(clip));}
    @MessageMapping("/spelling/{action}") public void command(@DestinationVariable String action,@Payload Command command,Principal principal,StompHeaderAccessor h){
        if(!(principal instanceof Authentication a)||!(a.getPrincipal() instanceof UserDetailsImpl u))return;
        String session=h.getSessionId();Runnable work=()->{
            try{State state=service.act(u.getId(),session,action,command);
                if(!Set.of("move","ping","draft").contains(action))events.send(session,new Event(action.equals("sync")?"SYNC":"ACK",command.requestId(),null,state));
            }catch(ResponseStatusException e){events.send(session,new Event("ERROR",command.requestId(),e.getReason(),null));}
            catch(IllegalArgumentException e){String code=e.getMessage();events.send(session,new Event("ERROR",command.requestId(),code!=null&&code.matches("[A-Z_]{2,48}")?code:"INVALID_COMMAND",null));}
            catch(Exception e){events.send(session,new Event("ERROR",command.requestId(),"SPELLING_UNAVAILABLE",null));}
        };
        if(Set.of("move","ping","draft","answer","heard","repeat","sync").contains(action))work.run();else try{service.submit(work);}catch(ResponseStatusException e){events.send(session,new Event("ERROR",command.requestId(),"SPELLING_BUSY",null));}
    }
    @EventListener public void disconnected(SessionDisconnectEvent event){service.disconnected(event.getSessionId());}
}
