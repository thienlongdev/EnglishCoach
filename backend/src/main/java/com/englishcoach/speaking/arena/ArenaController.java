package com.englishcoach.speaking.arena;

import static com.englishcoach.speaking.arena.ArenaProtocol.*;
import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.server.ResponseStatusException;
import java.security.Principal;
import java.util.*;

@Controller
public class ArenaController {
    private final ArenaService service;private final ArenaEvents events;
    public ArenaController(ArenaService service,ArenaEvents events){this.service=service;this.events=events;}
    @GetMapping("/api/v1/speaking/arena/config") @ResponseBody
    public ResponseEntity<?> config(@AuthenticationPrincipal UserDetailsImpl user){auth(user);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(Map.of("available",service.available(),"provider","LiveKit Cloud","maxRoomSize",8,"recording",false));}
    @PostMapping("/api/v1/speaking/arena/voice") @ResponseBody
    public ResponseEntity<VoiceTicket> voice(@AuthenticationPrincipal UserDetailsImpl user,@RequestBody VoiceRequest request){auth(user);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.ticket(user.getId(),request.roomId()));}
    @GetMapping("/api/v1/speaking/arena/rooms/{id}") @ResponseBody
    public ResponseEntity<State> room(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){auth(user);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.get(user.getId(),id));}
    @GetMapping("/api/v1/speaking/arena/usage") @ResponseBody
    @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> usage(@AuthenticationPrincipal UserDetailsImpl user){auth(user);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.usage());}
    private static void auth(UserDetailsImpl user){if(user==null)throw ArenaService.fail(401,"AUTH_REQUIRED");}
    @MessageMapping("/speaking-arena/{action}")
    public void command(@DestinationVariable String action,@Payload Command command,Principal principal,StompHeaderAccessor headers){
        if(!(principal instanceof Authentication a)||!(a.getPrincipal() instanceof UserDetailsImpl user))return;
        String session=headers.getSessionId();
        Runnable work=()->{try{State state=service.act(user.getId(),principal.getName(),session,action,command);
            if(!Set.of("move","row","ping").contains(action))events.send(principal.getName(),session,new Event(action.equals("sync")?"SYNC":"ACK",command.requestId(),null,state));
        }catch(ResponseStatusException e){events.send(principal.getName(),session,new Event("ERROR",command.requestId(),e.getReason(),null));}
        catch(Exception e){events.send(principal.getName(),session,new Event("ERROR",command.requestId(),"ROOM_UNAVAILABLE",null));}};
        if(Set.of("move","row","ping","sync").contains(action))work.run();else try{service.submit(work);}catch(ResponseStatusException e){events.send(principal.getName(),session,new Event("ERROR",command.requestId(),"ARENA_BUSY",null));}
    }
    @EventListener public void disconnect(SessionDisconnectEvent e){service.disconnected(e.getSessionId());}
}
