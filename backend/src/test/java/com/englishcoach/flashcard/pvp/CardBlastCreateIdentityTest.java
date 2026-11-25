package com.englishcoach.flashcard.pvp;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.controller.CardBlastPvPController;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.*;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.user.service.UserProfileService;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import java.util.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class CardBlastCreateIdentityTest {
    @Test void readinessWarmsIdentityOnceAndCreateUsesTheSameAuthenticatedSession() {
        var service = mock(CardBlastPvPService.class);
        var template = mock(SimpMessagingTemplate.class);
        var profiles = mock(UserProfileService.class);
        var controller = new CardBlastPvPController(service, template, profiles);
        var details = new UserDetailsImpl(1L, "owner@example.test", "", List.of());
        var principal = new UsernamePasswordAuthenticationToken(details, null, details.getAuthorities());
        var accessor = StompHeaderAccessor.create(StompCommand.SEND);
        accessor.setSessionId("game-session"); accessor.setSessionAttributes(new HashMap<>());
        when(profiles.findPublicDisplayName(1L)).thenReturn(Optional.of("Fixture owner"));
        var room = CardBlastRoom.builder().roomCode("TEST01").status(RoomStatus.WAITING).mode(RoomMode.HUMAN)
                .host(PlayerState.builder().userId("1").build()).build();
        when(service.createRoom(eq("1"), eq("Fixture owner"), isNull(), any(), eq("owner@example.test"), eq("game-session"))).thenReturn(room);
        var ping = new PingRequest(); ping.setClientTimeMs(System.currentTimeMillis());
        controller.handlePing(principal, ping, accessor);
        controller.handlePing(principal, ping, accessor);
        controller.createRoom(principal, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build(), accessor);
        when(service.getActiveRoomCodeForUser("1")).thenReturn("TEST01");
        when(service.rejoinRoom("1", "TEST01", "owner@example.test", "game-session")).thenReturn(room);
        controller.rejoinRoom(principal, new RejoinRoomRequest(), accessor);
        verify(service).getActiveRoomCodeForUser("1");
        verify(service).rejoinRoom("1", "TEST01", "owner@example.test", "game-session");
        verify(profiles, times(1)).findPublicDisplayName(1L);
        verify(profiles, times(1)).loadAvatarResource(1L);
        verify(service).createRoom(eq("1"), eq("Fixture owner"), isNull(), any(), eq("owner@example.test"), eq("game-session"));
        verify(template, times(4)).convertAndSendToUser(eq("owner@example.test"), eq("/queue/pvp"), any());
    }
}
