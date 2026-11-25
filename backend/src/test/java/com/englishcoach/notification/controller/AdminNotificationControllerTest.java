package com.englishcoach.notification.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.notification.dto.AdminCreateNotificationRequest;
import com.englishcoach.notification.dto.AdminNotificationDto;
import com.englishcoach.notification.entity.NotificationScope;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
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

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@ExtendWith(MockitoExtension.class)
class AdminNotificationControllerTest {

    @Mock
    private NotificationService notificationService;

    @InjectMocks
    private AdminNotificationController adminNotificationController;

    private MockMvc mockMvc;
    private UserDetailsImpl adminUserDetails;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        objectMapper.registerModule(new JavaTimeModule());

        User adminUser = User.builder()
                .id(99L)
                .email("admin@englishcoach.com")
                .name("Admin User")
                .role(Role.ROLE_ADMIN)
                .build();
        adminUserDetails = UserDetailsImpl.build(adminUser);

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
                return adminUserDetails;
            }
        };

        mockMvc = MockMvcBuilders.standaloneSetup(adminNotificationController)
                .setCustomArgumentResolvers(principalResolver)
                .build();
    }

    @Test
    @DisplayName("18: ROLE_ADMIN can create notification successfully")
    void testCreateNotification_Success() throws Exception {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.GLOBAL,
                NotificationType.SYSTEM_UPDATE,
                "Version 2.0 Update",
                "New learning features launched",
                "/profile",
                Instant.now(),
                null,
                null
        );

        AdminNotificationDto responseDto = new AdminNotificationDto(
                1L,
                "GLOBAL",
                "SYSTEM_UPDATE",
                "Version 2.0 Update",
                "New learning features launched",
                "/profile",
                request.publishAt(),
                null,
                null,
                99L,
                "PUBLISHED",
                Instant.now()
        );

        when(notificationService.createNotificationByAdmin(eq(99L), any(AdminCreateNotificationRequest.class)))
                .thenReturn(responseDto);

        mockMvc.perform(post("/api/v1/admin/notifications")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(1))
                .andExpect(jsonPath("$.scope").value("GLOBAL"))
                .andExpect(jsonPath("$.type").value("SYSTEM_UPDATE"))
                .andExpect(jsonPath("$.title").value("Version 2.0 Update"))
                .andExpect(jsonPath("$.actionUrl").value("/profile"))
                .andExpect(jsonPath("$.createdByUserId").value(99))
                .andExpect(jsonPath("$.state").value("PUBLISHED"));

        verify(notificationService).createNotificationByAdmin(eq(99L), any(AdminCreateNotificationRequest.class));
    }

    @Test
    @DisplayName("19: Title and Body validation rejects blank values")
    void testCreateNotification_Validation_RejectsBlankTitleAndBody() throws Exception {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.GLOBAL,
                NotificationType.SYSTEM_UPDATE,
                "", // Blank title
                "", // Blank body
                null,
                null,
                null,
                null
        );

        mockMvc.perform(post("/api/v1/admin/notifications")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isBadRequest());

        verify(notificationService, never()).createNotificationByAdmin(any(), any());
    }

    @Test
    @DisplayName("Admin list endpoint returns created notifications history")
    void testGetAdminNotifications() throws Exception {
        AdminNotificationDto responseDto = new AdminNotificationDto(
                1L,
                "GLOBAL",
                "SYSTEM_UPDATE",
                "System Notice",
                "Body",
                null,
                Instant.now(),
                null,
                null,
                99L,
                "PUBLISHED",
                Instant.now()
        );

        when(notificationService.getAdminNotifications(eq(0), eq(50)))
                .thenReturn(List.of(responseDto));

        mockMvc.perform(get("/api/v1/admin/notifications"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(1))
                .andExpect(jsonPath("$[0].scope").value("GLOBAL"));

        verify(notificationService).getAdminNotifications(eq(0), eq(50));
    }
}
