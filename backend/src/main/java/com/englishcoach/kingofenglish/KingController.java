package com.englishcoach.kingofenglish;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.stereotype.Controller;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.security.Principal;
import java.util.*;

@Controller
public class KingController {
    private final KingService game;private final SimpMessagingTemplate messages;private final KingBank bank;
    public KingController(KingService game,SimpMessagingTemplate messages,KingBank bank){this.game=game;this.messages=messages;this.bank=bank;}
    @MessageMapping("/king-of-english/{action}")
    public void command(@DestinationVariable String action,@Payload KingService.Command c,Principal principal,StompHeaderAccessor headers){
        if(!(principal instanceof Authentication a)||!(a.getPrincipal() instanceof UserDetailsImpl user))return;
        String id=Objects.toString(c.messageId(),"");
        try{
            // Harmless retryable handshake: a delivered response proves that the
            // private subscription is registered before any room mutation.
            if(action.equals("sync")){
                reply(principal.getName(),headers.getSessionId(),Map.of("type","SYNC","messageId",id));
                return;
            }
            var cmd=new KingService.Command(action,c.roomCode(),c.mode(),c.flow(),c.length(),c.difficulty(),c.bot(),
                c.matchId(),c.round(),c.revision(),c.messageId(),c.answer(),c.order(),c.size(),c.sentinel());
            var state=game.act(user.getId(),principal.getName(),headers.getSessionId(),cmd);
            reply(principal.getName(),headers.getSessionId(),Map.of("type","ACK","messageId",id,"state",state));
        }catch(KingService.Rejection e){error(principal,id,e.code,headers.getSessionId());}
        catch(Exception e){error(principal,id,"SERVER_UNAVAILABLE",headers.getSessionId());}
    }
    private void reply(String user,String sessionId,Map<String,Object> payload){
        var accessor=SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        accessor.setSessionId(sessionId);accessor.setLeaveMutable(true);
        messages.convertAndSendToUser(user,"/queue/king-of-english",payload,accessor.getMessageHeaders());
    }
    private void error(Principal p,String id,String code,String sessionId){reply(p.getName(),sessionId,Map.of("type","ERROR","messageId",id,"code",code));}
    @EventListener public void disconnect(SessionDisconnectEvent e){game.disconnect(e.getSessionId());}
    @GetMapping("/api/v1/king-of-english/history") @ResponseBody
    public ResponseEntity<?> history(@AuthenticationPrincipal UserDetailsImpl user){
        return user==null?ResponseEntity.status(401).build():ResponseEntity.ok(game.history(user.getId()));
    }
    @GetMapping("/api/v1/king-of-english/results/{match}") @ResponseBody
    public ResponseEntity<?> result(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable String match){
        if(user==null)return ResponseEntity.status(401).build();
        try{return ResponseEntity.ok(game.result(user.getId(),match));}
        catch(KingService.Rejection e){return ResponseEntity.notFound().build();}
    }
    /** Soán ngôi Top 5 + the caller's own best for one board size and category (SOLO / DUEL). */
    @GetMapping("/api/v1/king-of-english/conquest/leaderboard") @ResponseBody
    public ResponseEntity<?> conquestLeaderboard(@AuthenticationPrincipal UserDetailsImpl user,@RequestParam(defaultValue="5") int size,
                                                 @RequestParam(defaultValue="SOLO") String category){
        if(user==null)return ResponseEntity.status(401).build();
        try{return ResponseEntity.ok(game.conquestBoard(user.getId(),size,category));}
        catch(KingService.Rejection e){return ResponseEntity.badRequest().body(Map.of("code",e.code));}
    }
    @GetMapping("/api/v1/king-of-english/config") @ResponseBody
    public Map<String,Object> config(){return game.publicConfig();}
}

