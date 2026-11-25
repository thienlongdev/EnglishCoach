package com.englishcoach.quizrush;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.stereotype.Controller;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.*;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import java.security.Principal;
import java.util.*;

@Controller
public class RushCompetitiveController {
    private final RushCompetitiveService service;private final SimpMessagingTemplate messages;
    public RushCompetitiveController(RushCompetitiveService service,SimpMessagingTemplate messages){this.service=service;this.messages=messages;}
    @MessageMapping("/quiz-rush/{action}")
    public void command(@DestinationVariable String action,@Payload RushCompetitiveService.Command command,Principal principal,StompHeaderAccessor h){
        if(!(principal instanceof Authentication a)||!(a.getPrincipal() instanceof UserDetailsImpl user))return;
        var payload=new LinkedHashMap<String,Object>();payload.put("requestId",command.requestId());
        try{
            if(action.equals("sync"))payload.put("type","SYNC");
            else{var state=service.act(user.getId(),principal.getName(),h.getSessionId(),action,command);if(state==null)return;payload.put("type","ACK");payload.put("state",state);}
        }catch(RushException e){payload.put("type","ERROR");payload.put("code",e.getMessage());}
        catch(Exception e){payload.put("type","ERROR");payload.put("code","ROOM_UNAVAILABLE");}
        var headers=SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);headers.setSessionId(h.getSessionId());headers.setLeaveMutable(true);
        messages.convertAndSendToUser(principal.getName(),"/queue/quiz-rush",payload,headers.getMessageHeaders());
    }
    @EventListener public void disconnect(SessionDisconnectEvent e){service.disconnect(e.getSessionId());}
    @GetMapping("/api/v1/games/echo-quiz-rush/competitive/rooms/{id}") @ResponseBody
    public ResponseEntity<?> get(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){if(user==null)throw new RushException(401,"AUTH_REQUIRED");return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.get(user.getId(),id));}
    @GetMapping("/api/v1/games/echo-quiz-rush/competitive/history") @ResponseBody
    public ResponseEntity<?> history(@AuthenticationPrincipal UserDetailsImpl user){if(user==null)throw new RushException(401,"AUTH_REQUIRED");return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.history(user.getId()));}
}
