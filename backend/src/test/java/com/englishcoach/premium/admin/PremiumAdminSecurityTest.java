package com.englishcoach.premium.admin;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.exception.GlobalExceptionHandler;
import com.englishcoach.common.security.UserDetailsImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Method-security gate of the Premium admin API: a ROLE_USER principal is rejected before the service runs (the
 * global handler turns {@link AccessDeniedException} into 403, never 500); the official admin principal passes. The
 * service itself re-checks the DB row ({@code PremiumAdminServiceTest}).
 */
@SpringJUnitConfig(PremiumAdminSecurityTest.Config.class)
class PremiumAdminSecurityTest {

    @Configuration
    @EnableMethodSecurity
    static class Config {
        @Bean PremiumAdminService premiumAdminService() { return mock(PremiumAdminService.class); }
        @Bean PremiumAdminController premiumAdminController(PremiumAdminService s) { return new PremiumAdminController(s); }
    }

    @Autowired PremiumAdminController controller;
    @Autowired PremiumAdminService service;

    static UserDetailsImpl principal(long id, String email, Role role) {
        return UserDetailsImpl.build(User.builder().id(id).email(email).name("x").password("p").role(role).build());
    }

    void login(UserDetailsImpl p) {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(p, null, p.getAuthorities()));
    }

    @BeforeEach
    void reset() {
        clearInvocations(service);
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("ROLE_USER: grant / revoke / view / search rejected (AccessDenied ⇒ 403), service never called")
    void learnerDenied() {
        UserDetailsImpl learner = principal(676, "learner@gmail.com", Role.ROLE_USER);
        login(learner);
        assertThrows(AccessDeniedException.class, () -> controller.grant(learner, 676, new PremiumAdminDtos.GrantRequest(12, false, "self")));
        assertThrows(AccessDeniedException.class, () -> controller.revoke(learner, 676, new PremiumAdminDtos.RevokeRequest("x")));
        assertThrows(AccessDeniedException.class, () -> controller.view(learner, 676));
        assertThrows(AccessDeniedException.class, () -> controller.search(learner, "a"));
        verifyNoInteractions(service);
    }

    @Test
    @DisplayName("Official admin principal reaches the service")
    void adminAllowed() {
        UserDetailsImpl admin = principal(1, "longntt872006@gmail.com", Role.ROLE_ADMIN);
        login(admin);
        controller.grant(admin, 676, new PremiumAdminDtos.GrantRequest(1, false, "gift"));
        verify(service).grant(eq(1L), eq(676L), any(), any());
    }

    @Test
    @DisplayName("AccessDenied is mapped to 403 by the global handler; admin URLs are behind hasRole('ADMIN')")
    void mappedTo403() throws Exception {
        String handler = Files.readString(Path.of("src/main/java/com/englishcoach/common/exception/GlobalExceptionHandler.java"));
        assertTrue(handler.contains("@ExceptionHandler(AccessDeniedException.class)") && handler.contains("FORBIDDEN"));
        String sec = Files.readString(Path.of("src/main/java/com/englishcoach/common/security/WebSecurityConfig.java"));
        assertTrue(sec.contains(".requestMatchers(\"/api/v1/admin/**\""), "URL rule covers /api/v1/admin/premium/**");
        assertNotNull(GlobalExceptionHandler.class);
    }
}
