package com.englishcoach.echolife;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echolife.EchoLifeDtos.SaveWorldRequest;
import com.englishcoach.echolife.EchoLifeDtos.World;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Controller contract for {@code /api/v1/echo-life/world}: unauthenticated callers receive 401,
 * authenticated principals bind strictly to their own user id, no-store cache headers are enforced,
 * and 409 conflicts return the current world document.
 */
class EchoLifeControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private EchoLifeService service;
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        SecurityContextHolder.clearContext();
        service = Mockito.mock(EchoLifeService.class);
        mvc = MockMvcBuilders.standaloneSetup(new EchoLifeController(service))
                .setControllerAdvice(new EchoLifeExceptionHandler())
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .build();
    }

    private static void authenticate(long userId, String email) {
        UserDetailsImpl principal = new UserDetailsImpl(
                userId, email, "pw",
                List.of(new SimpleGrantedAuthority("ROLE_USER")));
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, principal.getAuthorities()));
    }

    private static ObjectNode emptyState() {
        ObjectNode s = JSON.createObjectNode().put("v", 1);
        s.putObject("places");
        s.putObject("doors");
        s.putObject("objects");
        return s;
    }

    @Test
    void anonymousGetAndPutAreRejectedWith401() throws Exception {
        mvc.perform(get("/api/v1/echo-life/world"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));

        mvc.perform(put("/api/v1/echo-life/world")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"revision\":0,\"state\":{\"v\":1,\"places\":{},\"doors\":{},\"objects\":{}}}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));

        verifyNoInteractions(service);
    }

    @Test
    void authenticatedGetAndPutBindPrincipalAndReturnNoStore() throws Exception {
        authenticate(42L, "learner42@example.test");
        World w = new World(1, 3L, emptyState(), Instant.parse("2026-11-20T12:00:00Z"));
        when(service.get(42L)).thenReturn(w);
        when(service.save(eq(42L), any(SaveWorldRequest.class))).thenReturn(new World(1, 4L, emptyState(), Instant.parse("2026-11-20T12:01:00Z")));

        mvc.perform(get("/api/v1/echo-life/world"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.revision").value(3))
                .andExpect(jsonPath("$.saveVersion").value(1));

        mvc.perform(put("/api/v1/echo-life/world")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"revision\":3,\"state\":{\"v\":1,\"places\":{},\"doors\":{},\"objects\":{}}}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.revision").value(4));

        verify(service).get(42L);
        verify(service).save(eq(42L), any(SaveWorldRequest.class));
    }

    @Test
    void staleRevisionReturns409WithCurrentDocument() throws Exception {
        authenticate(7L, "learner7@example.test");
        World current = new World(1, 5L, emptyState(), Instant.parse("2026-11-20T12:02:00Z"));
        when(service.save(eq(7L), any(SaveWorldRequest.class)))
                .thenThrow(new EchoLifeException(409, "STALE_REVISION", current));

        mvc.perform(put("/api/v1/echo-life/world")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"revision\":2,\"state\":{\"v\":1,\"places\":{},\"doors\":{},\"objects\":{}}}"))
                .andExpect(status().isConflict())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.code").value("STALE_REVISION"))
                .andExpect(jsonPath("$.current.revision").value(5));
    }

    @Test
    void malformedJsonReturns400WithStableCode() throws Exception {
        authenticate(7L, "learner7@example.test");
        mvc.perform(put("/api/v1/echo-life/world")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{not-json"))
                .andExpect(status().isBadRequest())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }
}
