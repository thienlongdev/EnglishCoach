package com.englishcoach.speaking.profile;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.speaking.dto.SpeakingSessionDetailDto;
import com.englishcoach.speaking.dto.SpeakingSessionHistoryPageDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingHubEntryDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingProfileOverviewDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingProfilePronunciationDto;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingProfileControllerTest {

    @Mock
    private SpeakingProfileAnalyticsService analyticsService;

    private SpeakingProfileController controller;
    private UserDetailsImpl principalA;

    @BeforeEach
    void setUp() {
        controller = new SpeakingProfileController(analyticsService);
        User userA = User.builder()
                .id(42L)
                .email("learner-a@englishcoach.io.vn")
                .role(Role.ROLE_USER)
                .build();
        principalA = UserDetailsImpl.build(userA);
    }

    @Test
    @DisplayName("P0 Isolation: No endpoint on SpeakingProfileController accepts a userId parameter")
    void noEndpointAcceptsUserIdParam() {
        for (Method method : SpeakingProfileController.class.getDeclaredMethods()) {
            for (Parameter param : method.getParameters()) {
                assertThat(param.getName().toLowerCase()).doesNotContain("userid");
                RequestParam rp = param.getAnnotation(RequestParam.class);
                if (rp != null) {
                    assertThat(rp.value().toLowerCase()).doesNotContain("userid");
                    assertThat(rp.name().toLowerCase()).doesNotContain("userid");
                }
            }
        }
    }

    @Test
    @DisplayName("P0 Auth Gate: Null principal throws 401 UNAUTHORIZED across all 5 endpoints with zero service calls")
    void unauthenticatedPrincipalRejected() {
        assertThatThrownBy(() -> controller.getHubEntry(null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> controller.getOverview(null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> controller.getPronunciation(null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> controller.getHistory(null, 0, 10, "ALL", "ALL"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> controller.getSessionDetail(null, 99L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

        verifyNoInteractions(analyticsService);
    }

    @Test
    @DisplayName("Cache-Control: Every SpeakingProfileController response enforces no-store and scopes to principal ID")
    void responsesEnforceCacheControlNoStoreAndPrincipalScope() {
        SpeakingHubEntryDto entryDto = SpeakingHubEntryDto.builder()
                .currentStreakDays(3)
                .activeTargetsCount(1L)
                .lifetimeCompletedSessions(5L)
                .generatedAt(LocalDateTime.now())
                .build();
        SpeakingProfileOverviewDto overviewDto = SpeakingProfileOverviewDto.builder()
                .policyVersion("SPEAKING_PROFILE_ANALYTICS_v2")
                .generatedAt(LocalDateTime.now())
                .build();
        SpeakingProfilePronunciationDto pronDto = SpeakingProfilePronunciationDto.builder()
                .policyVersion("SPEAKING_PROFILE_ANALYTICS_v2")
                .generatedAt(LocalDateTime.now())
                .build();
        SpeakingSessionHistoryPageDto historyDto = SpeakingSessionHistoryPageDto.builder()
                .content(List.of())
                .page(0)
                .size(50)
                .totalElements(0L)
                .totalPages(0)
                .hasNext(false)
                .build();
        SpeakingSessionDetailDto detailDto = SpeakingSessionDetailDto.builder()
                .sessionId(77L)
                .mode("SHADOWING")
                .status("COMPLETED")
                .build();

        when(analyticsService.getHubEntry(42L)).thenReturn(entryDto);
        when(analyticsService.getOverview(42L)).thenReturn(overviewDto);
        when(analyticsService.getPronunciation(42L)).thenReturn(pronDto);
        when(analyticsService.getHistory(42L, "SHADOWING", "COMPLETED", 0, 50)).thenReturn(historyDto);
        when(analyticsService.getSessionDetail(42L, 77L)).thenReturn(detailDto);

        ResponseEntity<SpeakingHubEntryDto> r1 = controller.getHubEntry(principalA);
        ResponseEntity<SpeakingProfileOverviewDto> r2 = controller.getOverview(principalA);
        ResponseEntity<SpeakingProfilePronunciationDto> r3 = controller.getPronunciation(principalA);
        ResponseEntity<SpeakingSessionHistoryPageDto> r4 = controller.getHistory(principalA, -5, 999, "SHADOWING", "COMPLETED");
        ResponseEntity<SpeakingSessionDetailDto> r5 = controller.getSessionDetail(principalA, 77L);

        for (ResponseEntity<?> res : List.of(r1, r2, r3, r4, r5)) {
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(res.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        }

        verify(analyticsService).getHubEntry(42L);
        verify(analyticsService).getOverview(42L);
        verify(analyticsService).getPronunciation(42L);
        verify(analyticsService).getHistory(42L, "SHADOWING", "COMPLETED", 0, 50);
        verify(analyticsService).getSessionDetail(42L, 77L);
    }
}
