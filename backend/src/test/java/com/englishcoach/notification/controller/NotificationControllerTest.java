package com.englishcoach.notification.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.notification.dto.LearnerNotificationDto;
import com.englishcoach.notification.dto.UnreadCountDto;
import com.englishcoach.notification.service.NotificationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.time.Instant;
import java.util.List;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class NotificationControllerTest {

    @Mock
    private NotificationService notificationService;

    @InjectMocks
    private NotificationController notificationController;

    private MockMvc mockMvc;
    private UserDetailsImpl userDetails;

    @BeforeEach
    void setUp() {
        User user = User.builder()
                .id(1L)
                .email("learner@englishcoach.com")
                .name("Learner")
                .role(Role.ROLE_USER)
                .build();
        userDetails = UserDetailsImpl.build(user);

        HandlerMethodArgumentResolver principalResolver = new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter,
                                          ModelAndViewContainer mavContainer,
                                          NativeWebRequest webRequest,
                                          WebDataBinderFactory binderFactory) {
                return userDetails;
            }
        };

        mockMvc = MockMvcBuilders.standaloneSetup(notificationController)
                .setCustomArgumentResolvers(principalResolver)
                .build();
    }

    @Test
    @DisplayName("GET /api/v1/notifications returns learner notifications list")
    void testGetNotifications() throws Exception {
        LearnerNotificationDto dto = new LearnerNotificationDto(
                10L,
                "SYSTEM_UPDATE",
                "New Feature",
                "Try out our new reader",
                "/reading",
                Instant.now(),
                false
        );

        when(notificationService.getLearnerNotifications(eq(1L), any())).thenReturn(List.of(dto));

        mockMvc.perform(get("/api/v1/notifications").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(10))
                .andExpect(jsonPath("$[0].type").value("SYSTEM_UPDATE"))
                .andExpect(jsonPath("$[0].title").value("New Feature"))
                .andExpect(jsonPath("$[0].actionUrl").value("/reading"))
                .andExpect(jsonPath("$[0].read").value(false));

        verify(notificationService).getLearnerNotifications(eq(1L), any());
    }

    @Test
    @DisplayName("GET /api/v1/notifications/unread-count returns unread count")
    void testGetUnreadCount() throws Exception {
        when(notificationService.getUnreadCount(1L)).thenReturn(new UnreadCountDto(5L));

        mockMvc.perform(get("/api/v1/notifications/unread-count"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.unreadCount").value(5));

        verify(notificationService).getUnreadCount(1L);
    }

    @Test
    @DisplayName("POST /api/v1/notifications/{id}/read marks notification read")
    void testMarkAsRead() throws Exception {
        mockMvc.perform(post("/api/v1/notifications/10/read"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));

        verify(notificationService).markAsRead(1L, 10L);
    }

    @Test
    @DisplayName("POST /api/v1/notifications/read-all marks all notifications read")
    void testMarkAllAsRead() throws Exception {
        mockMvc.perform(post("/api/v1/notifications/read-all"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));

        verify(notificationService).markAllAsRead(1L);
    }

    @Test
    @DisplayName("POST /api/v1/notifications/{id}/dismiss dismisses notification")
    void testDismiss() throws Exception {
        mockMvc.perform(post("/api/v1/notifications/10/dismiss"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));

        verify(notificationService).dismiss(1L, 10L);
    }
}
