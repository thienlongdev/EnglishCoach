package com.englishcoach.user.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.user.dto.UserProfileDto;
import com.englishcoach.user.service.UserProfileService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.MethodParameter;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class UserProfileControllerTest {

    @Mock
    private UserProfileService userProfileService;

    @InjectMocks
    private UserProfileController userProfileController;

    private MockMvc mockMvc;
    private UserDetailsImpl userDetails;

    @BeforeEach
    void setUp() {
        User user = User.builder()
                .id(1L)
                .email("test@englishcoach.com")
                .name("Alex Johnson")
                .role(Role.ROLE_USER)
                .build();
        userDetails = UserDetailsImpl.build(user);

        HandlerMethodArgumentResolver principalResolver = new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                          NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
                return userDetails;
            }
        };

        mockMvc = MockMvcBuilders.standaloneSetup(userProfileController)
                .setCustomArgumentResolvers(principalResolver)
                .build();
    }

    @Test
    @DisplayName("GET /api/v1/users/me/avatar returns 200 with PNG and ETag when avatar present")
    void testGetAvatar_Returns200WithEtag() throws Exception {
        byte[] fakePng = new byte[]{1, 2, 3};
        Resource resource = new ByteArrayResource(fakePng);
        Instant lastModified = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        long lastModifiedMillis = lastModified.toEpochMilli();
        String expectedEtag = "\"1-" + lastModifiedMillis + "\"";

        when(userProfileService.loadAvatarResource(1L)).thenReturn(resource);
        when(userProfileService.getAvatarLastModified(1L)).thenReturn(lastModified);

        mockMvc.perform(get("/api/v1/users/me/avatar"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", MediaType.IMAGE_PNG_VALUE))
                .andExpect(header().string("Cache-Control", "max-age=3600, private"))
                .andExpect(header().string("ETag", expectedEtag));
    }

    @Test
    @DisplayName("GET /api/v1/users/me/avatar returns 304 when If-None-Match matches ETag")
    void testGetAvatar_ConditionalRequest_Returns304() throws Exception {
        byte[] fakePng = new byte[]{1, 2, 3};
        Resource resource = new ByteArrayResource(fakePng);
        Instant lastModified = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        long lastModifiedMillis = lastModified.toEpochMilli();
        String expectedEtag = "\"1-" + lastModifiedMillis + "\"";

        when(userProfileService.loadAvatarResource(1L)).thenReturn(resource);
        when(userProfileService.getAvatarLastModified(1L)).thenReturn(lastModified);

        mockMvc.perform(get("/api/v1/users/me/avatar")
                        .header("If-None-Match", expectedEtag))
                .andExpect(status().isNotModified());
    }

    @Test
    @DisplayName("GET /api/v1/users/me/avatar returns 404 when avatar is absent")
    void testGetAvatar_Absent_Returns404() throws Exception {
        when(userProfileService.loadAvatarResource(1L)).thenReturn(null);

        mockMvc.perform(get("/api/v1/users/me/avatar"))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("GET /api/v1/users/me/profile returns 200 with profile DTO")
    void testGetProfile_Returns200() throws Exception {
                List<String> authMethods = List.of("CREDENTIALS");
        UserProfileDto dto = new UserProfileDto(
                "test@englishcoach.com",
                "Alex Johnson",
                "Alex Johnson",
                null,
                null,
                "Hanoi",
                java.time.LocalDate.of(1995, 5, 20),
                Instant.now(),
                false,
                null,
                authMethods,
                true,
                "purple"
        );

        when(userProfileService.getProfile(1L)).thenReturn(dto);

        mockMvc.perform(get("/api/v1/users/me/profile"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.email").value("test@englishcoach.com"))
                .andExpect(jsonPath("$.displayName").value("Alex Johnson"))
                .andExpect(jsonPath("$.province").value("Hanoi"))
                .andExpect(jsonPath("$.dateOfBirth").value("1995-05-20"))
                .andExpect(jsonPath("$.avatarPresent").value(false));
    }

    @Test
    @DisplayName("DELETE /api/v1/users/me/avatar returns 204 No Content")
    void testDeleteAvatar_Returns204() throws Exception {
        doNothing().when(userProfileService).deleteAvatar(1L);

        mockMvc.perform(delete("/api/v1/users/me/avatar"))
                .andExpect(status().isNoContent());

        verify(userProfileService).deleteAvatar(1L);
    }
}
