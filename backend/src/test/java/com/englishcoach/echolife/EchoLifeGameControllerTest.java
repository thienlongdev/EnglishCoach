package com.englishcoach.echolife;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echolife.EchoLifeGameDtos.*;
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
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Controller contract for {@code /api/v1/echo-life/game}: 401 without a principal, every call bound to the principal's own id,
 * no-store responses, stable error codes (403 ownership, 409 conflict with the current game, 400 malformed or invalid shape).
 */
class EchoLifeGameControllerTest {

    private EchoLifeGameService service;
    private MockMvc mvc;
    private static final Wallet WALLET = new Wallet(120, Map.of("social", 0), 1, List.of(), List.of(), 0, 0);

    @BeforeEach
    void setup() {
        SecurityContextHolder.clearContext();
        service = Mockito.mock(EchoLifeGameService.class);
        LocalValidatorFactoryBean validator = new LocalValidatorFactoryBean();
        validator.afterPropertiesSet();
        mvc = MockMvcBuilders.standaloneSetup(new EchoLifeGameController(service))
                .setControllerAdvice(new EchoLifeExceptionHandler())
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setValidator(validator)
                .build();
    }

    private static void authenticate(long userId) {
        UserDetailsImpl principal = new UserDetailsImpl(userId, "learner" + userId + "@example.test", "pw", List.of(new SimpleGrantedAuthority("ROLE_USER")));
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(principal, null, principal.getAuthorities()));
    }

    @Test
    void anonymousCallsAreRejectedWith401AndNeverReachTheService() throws Exception {
        mvc.perform(get("/api/v1/echo-life/game")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
        mvc.perform(post("/api/v1/echo-life/game/claims").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"batches\":[{\"source\":\"x\",\"uniques\":[],\"credits\":0,\"xp\":{},\"spent\":[]}]}"))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(service);
    }

    @Test
    void readsAndWritesBindThePrincipalAndAreNotCached() throws Exception {
        authenticate(42L);
        when(service.get(42L)).thenReturn(new Game(1, 0, null, WALLET, null));
        when(service.claim(eq(42L), any(ClaimRequest.class))).thenReturn(new ClaimResult(WALLET, List.of("mission:tidy"), Map.of(), 0, 0));
        when(service.purchase(eq(42L), any(PurchaseRequest.class))).thenReturn(new PurchaseResult(WALLET, "ec_0123456789abcdef0123", 2, "grocery"));
        mvc.perform(get("/api/v1/echo-life/game"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.revision").value(0)).andExpect(jsonPath("$.wallet.credits").value(120));
        mvc.perform(post("/api/v1/echo-life/game/claims").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"batches\":[{\"source\":\"rack\",\"uniques\":[\"mission:tidy\"],\"credits\":45,\"xp\":{\"diy_design\":49},\"spent\":[]}]}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.granted[0]").value("mission:tidy"));
        mvc.perform(post("/api/v1/echo-life/game/purchases").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"storeId\":\"market\",\"sku\":\"sku_food_eggs\",\"requestId\":\"req-12345678\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.instanceId").value("ec_0123456789abcdef0123"));
        verify(service).get(42L);
        verify(service).claim(eq(42L), any(ClaimRequest.class));
        verify(service).purchase(eq(42L), any(PurchaseRequest.class));
    }

    @Test
    void ownershipConflictAndMalformedRequestsAnswerStableCodes() throws Exception {
        authenticate(7L);
        when(service.sell(eq(7L), any(SaleRequest.class))).thenThrow(new EchoLifeException(403, "OWNERSHIP_VIOLATION"));
        when(service.save(eq(7L), any(SaveGameRequest.class)))
                .thenThrow(new EchoLifeException(409, "STALE_REVISION", null, new Game(1, 5, null, WALLET, null)));
        mvc.perform(post("/api/v1/echo-life/game/sales").contentType(MediaType.APPLICATION_JSON).content("{\"instanceId\":\"ec_0123456789abcdef0123\"}"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("OWNERSHIP_VIOLATION"));
        mvc.perform(put("/api/v1/echo-life/game").contentType(MediaType.APPLICATION_JSON).content("{\"revision\":2,\"doc\":{\"v\":1,\"save\":\"{}\",\"places\":{}}}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("STALE_REVISION")).andExpect(jsonPath("$.current.revision").value(5));
        // A client-made instance id, an unknown shape or broken JSON never reaches the service.
        mvc.perform(post("/api/v1/echo-life/game/sales").contentType(MediaType.APPLICATION_JSON).content("{\"instanceId\":\"obj_101\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        mvc.perform(post("/api/v1/echo-life/game/purchases").contentType(MediaType.APPLICATION_JSON).content("{\"storeId\":\"market\",\"sku\":\"sku_food_eggs\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/echo-life/game").contentType(MediaType.APPLICATION_JSON).content("{not-json"))
                .andExpect(status().isBadRequest()).andExpect(header().string("Cache-Control", "no-store"));
    }
}
