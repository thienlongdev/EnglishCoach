package com.englishcoach.avatarframe.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.dto.AvatarFrameOwnershipDto;
import com.englishcoach.avatarframe.dto.AvatarFrameProgressDto;
import com.englishcoach.avatarframe.dto.AvatarFrameSeriesDto;
import com.englishcoach.avatarframe.service.AvatarFrameService;
import com.englishcoach.common.security.UserDetailsImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class AvatarFrameControllerTest {

    @Mock
    private AvatarFrameService avatarFrameService;

    @InjectMocks
    private AvatarFrameController avatarFrameController;

    private MockMvc mockMvc;
    private UserDetailsImpl userDetails;

    private AvatarFrameDto sampleDto;

    @BeforeEach
    void setUp() {
        User user = User.builder()
                .id(1L)
                .email("learner@englishcoach.com")
                .name("Alex Learner")
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

        mockMvc = MockMvcBuilders.standaloneSetup(avatarFrameController)
                .setCustomArgumentResolvers(principalResolver)
                .build();

        sampleDto = new AvatarFrameDto(
                1L,
                "streak_flame_stage_1",
                new AvatarFrameSeriesDto(1L, "streak_flame", "Streak Flame"),
                "Đốm Lửa",
                "C",
                "ACHIEVEMENT",
                "STATIC_SVG",
                "/assets/frames/streak_flame_c.svg",
                "/assets/frames/streak_flame_c.svg",
                new AvatarFrameOwnershipDto(true, true, null),
                new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "EQUIPPED", "7 ngày", "7 ngày")
        );
    }

    @Test
    @DisplayName("GET /api/v1/frames/catalogue returns 200 with list of frames")
    void testGetCatalogue_authenticated() throws Exception {
        when(avatarFrameService.getCatalogue(1L)).thenReturn(List.of(sampleDto));

        mockMvc.perform(get("/api/v1/frames/catalogue")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].slug").value("streak_flame_stage_1"))
                .andExpect(jsonPath("$[0].name").value("Đốm Lửa"))
                .andExpect(jsonPath("$[0].tier").value("C"))
                .andExpect(jsonPath("$[0].lineage").value("ACHIEVEMENT"))
                .andExpect(jsonPath("$[0].renderType").value("STATIC_SVG"))
                .andExpect(jsonPath("$[0].ownership.owned").value(true))
                .andExpect(jsonPath("$[0].ownership.equipped").value(true))
                .andExpect(jsonPath("$[0].progress.status").value("EQUIPPED"))
                .andExpect(jsonPath("$[0].progress.percent").value(100.0));
    }

    @Test
    @DisplayName("GET /api/v1/frames/inventory returns 200 with owned frames")
    void testGetInventory_authenticated() throws Exception {
        when(avatarFrameService.getInventory(1L)).thenReturn(List.of(sampleDto));

        mockMvc.perform(get("/api/v1/frames/inventory")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].slug").value("streak_flame_stage_1"))
                .andExpect(jsonPath("$[0].ownership.owned").value(true));
    }

    @Test
    @DisplayName("GET /api/v1/frames/{slug} returns 200 with single frame details")
    void testGetFrameBySlug_authenticated() throws Exception {
        when(avatarFrameService.getFrameBySlug(1L, "streak_flame_stage_1")).thenReturn(sampleDto);

        mockMvc.perform(get("/api/v1/frames/streak_flame_stage_1")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.slug").value("streak_flame_stage_1"))
                .andExpect(jsonPath("$.tier").value("C"));
    }

    @Test
    @DisplayName("POST /api/v1/frames/reconcile returns 200 with newly unlocked frames")
    void testReconcile_authenticated() throws Exception {
        when(avatarFrameService.reconcileUserEligibility(1L)).thenReturn(List.of(sampleDto));

        mockMvc.perform(post("/api/v1/frames/reconcile")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].slug").value("streak_flame_stage_1"));
    }

    @Test
    @DisplayName("POST /api/v1/frames/{slug}/equip returns 200 on success")
    void testEquipFrame_success() throws Exception {
        when(avatarFrameService.equipFrame(1L, "streak_flame_stage_1")).thenReturn(sampleDto);

        mockMvc.perform(post("/api/v1/frames/streak_flame_stage_1/equip")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.slug").value("streak_flame_stage_1"))
                .andExpect(jsonPath("$.ownership.equipped").value(true));
    }

    @Test
    @DisplayName("POST /api/v1/frames/{slug}/equip returns 403 when unowned")
    void testEquipFrame_unowned() throws Exception {
        when(avatarFrameService.equipFrame(1L, "unowned_frame"))
                .thenThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "User does not own this avatar frame"));

        mockMvc.perform(post("/api/v1/frames/unowned_frame/equip")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("POST /api/v1/frames/{slug}/equip returns 400 when expired")
    void testEquipFrame_expired() throws Exception {
        when(avatarFrameService.equipFrame(1L, "expired_frame"))
                .thenThrow(new ResponseStatusException(HttpStatus.BAD_REQUEST, "Avatar frame ownership has expired"));

        mockMvc.perform(post("/api/v1/frames/expired_frame/equip")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("POST /api/v1/frames/unequip returns 204 No Content")
    void testUnequipFrame_success() throws Exception {
        doNothing().when(avatarFrameService).unequipFrame(1L);

        mockMvc.perform(post("/api/v1/frames/unequip")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isNoContent());

        verify(avatarFrameService).unequipFrame(1L);
    }
}
