package com.englishcoach.flashcard.pvp.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.dto.PvPMessage;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.*;
import com.englishcoach.flashcard.pvp.model.CardBlastRoom;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.user.service.UserProfileService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.security.Principal;
import java.util.Map;

@Controller
@Slf4j
@RequiredArgsConstructor
public class CardBlastPvPController {

    private final CardBlastPvPService pvpService;
    private final SimpMessagingTemplate messagingTemplate;
    private final UserProfileService userProfileService;

    private record UserIdentity(String userId, String displayName, String avatar) {}

    private UserIdentity resolveIdentity(Principal principal) {
        if (principal == null) {
            return new UserIdentity("anon-" + System.currentTimeMillis(), "Guest", null);
        }

        String userId = principal.getName();
        String displayName = "Player";
        String avatar = null;

        if (principal instanceof Authentication auth && auth.getPrincipal() instanceof UserDetailsImpl userDetails) {
            userId = String.valueOf(userDetails.getId());
            String fallbackName = "Player #" + userDetails.getId();
            displayName = fallbackName;
            if (userProfileService != null) {
                try {
                    displayName = userProfileService.findPublicDisplayName(userDetails.getId()).orElse(fallbackName);
                } catch (Exception ignored) {
                    displayName = fallbackName;
                }
                if (userProfileService.loadAvatarResource(userDetails.getId()) != null) {
                    avatar = "/api/v1/users/" + userDetails.getId() + "/avatar";
                }
            }
        }

        return new UserIdentity(userId, displayName, avatar);
    }

    private UserIdentity preparedIdentity(Principal principal, StompHeaderAccessor accessor) {
        Map<String, Object> attributes = accessor != null ? accessor.getSessionAttributes() : null;
        if (attributes == null) return resolveIdentity(principal);
        // Bound to this authenticated WebSocket session, removed with the session.
        // Warm presentation data during the existing readiness/clock probe so the
        // create click never waits for profile database/filesystem lookups.
        synchronized (attributes) {
            String principalName = principal != null ? principal.getName() : "";
            if (!principalName.equals(attributes.get("PVP_IDENTITY_PRINCIPAL"))) {
                attributes.put("PVP_PREPARED_IDENTITY", resolveIdentity(principal));
                attributes.put("PVP_IDENTITY_PRINCIPAL", principalName);
            }
            return (UserIdentity) attributes.get("PVP_PREPARED_IDENTITY");
        }
    }

    private Map<String, Object> buildRoomPayload(CardBlastRoom room) {
        Map<String, Object> map = new java.util.HashMap<>();
        map.put("roomCode", room.getRoomCode());
        map.put("deckId", room.getDeckId());
        map.put("deckTitle", room.getDeckTitle());
        map.put("direction", room.getDirection());
        map.put("mode", room.getMode() != null ? room.getMode().name() : null);
        map.put("botLevel", room.getBotLevel() != null ? room.getBotLevel().name() : null);
        map.put("status", room.getStatus() != null ? room.getStatus().name() : "WAITING");
        map.put("host", room.getHost());
        map.put("guest", room.getGuest());
        map.put("speedLevel", room.getSpeedLevel());
        map.put("hintLevel", room.getHintLevel());
        map.put("winnerId", room.getWinnerId());
        map.put("endReason", room.getEndReason());
        if (room.getStatus() == com.englishcoach.flashcard.pvp.model.RoomStatus.COUNTDOWN || room.getStatus() == com.englishcoach.flashcard.pvp.model.RoomStatus.IN_GAME) {
            map.put("matchStartServerMs", room.getMatchStartServerMs());
            map.put("seed", room.getSeed());
            map.put("schedule", room.getSchedule());
        }
        return map;
    }

    @MessageMapping("/pvp/create")
    public void createRoom(Principal principal, @Payload CreateRoomRequest req, StompHeaderAccessor accessor) {
        long receivedMs = System.currentTimeMillis();
        long started = System.nanoTime();
        try {
            UserIdentity identity = preparedIdentity(principal, accessor);
            long identityDone = System.nanoTime();
            String principalName = principal != null ? principal.getName() : null;
            CardBlastRoom room = pvpService.createRoom(identity.userId(), identity.displayName(), identity.avatar(), req, principalName, accessor.getSessionId());
            long roomDone = System.nanoTime();
            Map<String, Object> payload = buildRoomPayload(room);
            payload.put("createTiming", Map.of("receivedMs", receivedMs,
                    "identityMs", (identityDone - started) / 1_000_000.0,
                    "serviceMs", (roomDone - identityDone) / 1_000_000.0,
                    "responseMs", System.currentTimeMillis()));
            messagingTemplate.convertAndSendToUser(
                    principal.getName(),
                    "/queue/pvp",
                    PvPMessage.of("ROOM_CREATED", room.getRoomCode(), payload)
            );
            log.info("[PVP TIMING] room={} identityMs={} serviceMs={} sendMs={}", room.getRoomCode(),
                    (identityDone - started) / 1_000_000.0, (roomDone - identityDone) / 1_000_000.0,
                    (System.nanoTime() - roomDone) / 1_000_000.0);
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] createRoom error: {}", e.getMessage());
            sendError(principal, null, e.getMessage());
        }
    }

    @MessageMapping("/pvp/join")
    public void joinRoom(Principal principal, @Payload JoinRoomRequest req, StompHeaderAccessor accessor) {
        try {
            UserIdentity identity = preparedIdentity(principal, accessor);
            String principalName = principal != null ? principal.getName() : null;
            CardBlastRoom room = pvpService.joinRoom(identity.userId(), identity.displayName(), identity.avatar(), req.getRoomCode(), principalName, accessor.getSessionId());
            messagingTemplate.convertAndSendToUser(
                    principal.getName(),
                    "/queue/pvp",
                    PvPMessage.of("ROOM_JOINED", room.getRoomCode(), buildRoomPayload(room))
            );
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] joinRoom error: {}", e.getMessage());
            sendError(principal, req.getRoomCode(), e.getMessage());
        }
    }

    @MessageMapping("/pvp/leave")
    public void leaveRoom(Principal principal, @Payload(required = false) LeaveRoomRequest req) {
        String roomCode = (req != null) ? req.getRoomCode() : null;
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.leaveRoom(identity.userId(), roomCode);
            messagingTemplate.convertAndSendToUser(
                    principal.getName(),
                    "/queue/pvp",
                    PvPMessage.of("ROOM_LEFT", roomCode, Map.of("roomCode", roomCode != null ? roomCode : ""))
            );
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] leaveRoom error: {}", e.getMessage());
            sendError(principal, roomCode, e.getMessage());
        }
    }

    @MessageMapping("/pvp/ready")
    public void setReady(Principal principal, @Payload ReadyRoomRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            boolean isReady = req.getReady() != null ? req.getReady() : true;
            pvpService.setReady(identity.userId(), req.getRoomCode(), isReady, req.getSkills(), req.getSentinel());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] setReady error: {}", e.getMessage());
            sendError(principal, req.getRoomCode(), e.getMessage());
        }
    }

    @MessageMapping("/pvp/skill")
    public void castSkill(Principal principal, @Payload SkillRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.castSkill(identity.userId(), req.getRoomCode(), req.getSkillId());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] castSkill error: {}", e.getMessage());
        }
    }

    @MessageMapping("/pvp/hit")
    public void submitHit(Principal principal, @Payload HitRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.applyHit(req.getRoomCode(), identity.userId(), req.getSeq(), req.getTMs());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] submitHit error: {}", e.getMessage());
        }
    }

    @MessageMapping("/pvp/gameover")
    public void submitGameOver(Principal principal, @Payload GameOverRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.handleClientGameOver(identity.userId(), req.getRoomCode(), req.getReason());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] submitGameOver error: {}", e.getMessage());
        }
    }

    @MessageMapping("/pvp/rejoin")
    public void rejoinRoom(Principal principal, @Payload RejoinRoomRequest req, StompHeaderAccessor accessor) {
        try {
            UserIdentity identity = preparedIdentity(principal, accessor);
            String principalName = principal != null ? principal.getName() : null;
            String requestedCode = req.getRoomCode();
            if (requestedCode == null || requestedCode.isBlank()) {
                requestedCode = pvpService.getActiveRoomCodeForUser(identity.userId());
            }
            CardBlastRoom room = pvpService.rejoinRoom(identity.userId(), requestedCode, principalName, accessor.getSessionId());
            messagingTemplate.convertAndSendToUser(
                    principal.getName(),
                    "/queue/pvp",
                    PvPMessage.of("ROOM_REJOINED", room.getRoomCode(), buildRoomPayload(room))
            );
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] rejoinRoom error: {}", e.getMessage());
            sendError(principal, req.getRoomCode(), e.getMessage());
        }
    }

    @MessageMapping("/pvp/rematch")
    public void requestRematch(Principal principal, @Payload RematchRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.requestRematch(identity.userId(), req.getRoomCode());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] rematch error: {}", e.getMessage());
            sendError(principal, req.getRoomCode(), e.getMessage());
        }
    }

    @MessageMapping("/pvp/ping")
    public void handlePing(Principal principal, @Payload PingRequest req, StompHeaderAccessor accessor) {
        if (principal == null) return;
        preparedIdentity(principal, accessor);
        long serverTime = System.currentTimeMillis();
        messagingTemplate.convertAndSendToUser(
                principal.getName(),
                "/queue/pvp",
                PvPMessage.of("PONG", null, new PongResponse(req.getClientTimeMs(), serverTime))
        );
    }

    @MessageMapping("/pvp/react")
    public void react(Principal principal, @Payload ReactRequest req) {
        try {
            UserIdentity identity = resolveIdentity(principal);
            pvpService.handleReaction(identity.userId(), req.getRoomCode(), req.getReactionId());
        } catch (Exception e) {
            log.warn("[PVP CONTROLLER] react error: {}", e.getMessage());
        }
    }

    @EventListener
    public void handleSessionDisconnect(SessionDisconnectEvent event) {
        StompHeaderAccessor accessor = StompHeaderAccessor.wrap(event.getMessage());
        Principal principal = accessor.getUser();
        String userId = null;
        if (principal != null) {
            UserIdentity identity = resolveIdentity(principal);
            userId = identity.userId();
        } else if (accessor.getSessionAttributes() != null) {
            Object attr = accessor.getSessionAttributes().get("PVP_USER_ID");
            if (attr != null) {
                userId = String.valueOf(attr);
            }
        }
        if (userId != null) {
            pvpService.handleUserDisconnect(userId, accessor.getSessionId());
        }
    }

    @org.springframework.messaging.handler.annotation.MessageExceptionHandler
    public void handleMessageException(Exception ex, Principal principal) {
        log.warn("[PVP CONTROLLER] Handled unhandled STOMP exception: {}", ex.getMessage());
        if (principal != null) {
            sendError(principal, null, ex.getMessage());
        }
    }

    private void sendError(Principal principal, String roomCode, String message) {
        if (principal == null) return;
        messagingTemplate.convertAndSendToUser(
                principal.getName(),
                "/queue/pvp",
                PvPMessage.of("ERROR", roomCode, Map.of("message", message != null ? message : "An error occurred"))
        );
    }
}
