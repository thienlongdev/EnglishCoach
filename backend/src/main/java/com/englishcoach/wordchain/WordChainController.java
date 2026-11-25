package com.englishcoach.wordchain;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.stereotype.Controller;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.security.Principal;
import java.util.*;

@Controller
public class WordChainController {
    private final WordChainService game;
    private final SimpMessagingTemplate messages;
    public WordChainController(WordChainService game,SimpMessagingTemplate messages) {
        this.game=game;this.messages=messages;
    }
    @MessageMapping("/word-chain/{action}")
    public void command(@DestinationVariable String action, @Payload WordChainService.Command c,
                        Principal principal,StompHeaderAccessor headers) {
        if(!(principal instanceof Authentication auth) || !(auth.getPrincipal() instanceof UserDetailsImpl user)) return;
        try {
            var cmd=new WordChainService.Command(action,c.roomCode(),c.mode(),c.difficulty(),c.word(),c.messageId(),c.revision(),c.level());
            var state=game.actWithProfile(user.getId(),principal.getName(),headers.getSessionId(),cmd);
            messages.convertAndSendToUser(principal.getName(),"/queue/word-chain",
                    Map.of("type","ACK","messageId",Objects.toString(c.messageId(),""),"state",state));
        } catch(WordChainRules.Rejection e) { error(principal,c,e.code); }
        catch(Exception e) { error(principal,c,"SERVER_UNAVAILABLE"); }
    }
    private void error(Principal p,WordChainService.Command c,String code) {
        messages.convertAndSendToUser(p.getName(),"/queue/word-chain",Map.of("type","ERROR","code",code,
                "messageId",Objects.toString(c.messageId(),"")));
    }
    @EventListener public void disconnected(SessionDisconnectEvent event) { game.disconnect(event.getSessionId()); }
    @GetMapping("/api/v1/word-chain/history") @ResponseBody
    public ResponseEntity<?> history(@AuthenticationPrincipal UserDetailsImpl user) {
        if(user==null) return ResponseEntity.status(401).body(Map.of("code","AUTH_REQUIRED"));
        try { return ResponseEntity.ok(game.history(user.getId())); }
        catch(Exception e) { return ResponseEntity.status(503).body(Map.of("code","HISTORY_UNAVAILABLE")); }
    }
    @GetMapping(value="/api/v1/word-chain/results/{match}",produces="application/json") @ResponseBody
    public ResponseEntity<?> result(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID match) {
        if(user==null) return ResponseEntity.status(401).body(Map.of("code","AUTH_REQUIRED"));
        try { return ResponseEntity.ok(game.result(user.getId(),match)); }
        catch(WordChainRules.Rejection e) {return ResponseEntity.status(404).body(Map.of("code",e.code));}
        catch(Exception e) {return ResponseEntity.status(503).body(Map.of("code","HISTORY_UNAVAILABLE"));}
    }
}
