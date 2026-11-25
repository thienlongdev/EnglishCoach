package com.englishcoach.ai.voice;

import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.SessionCookies;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Registers `/ws-card-blast/echo-voice` under the frozen Nginx unbuffered `/ws-card-blast` prefix with strict Origin
 * allowlist checking and handshake-time `SessionCookies` JWT authentication (`CREDENTIALS` / `GOOGLE` only).
 */
@Configuration
@EnableWebSocket
@Slf4j
public class EchoVoiceWebSocketConfig implements WebSocketConfigurer {

    public static final String ENDPOINT = "/ws-card-blast/echo-voice";

    private final EchoVoiceWebSocketHandler handler;
    private final JwtDecoder jwtDecoder;
    private final CustomJwtAuthenticationConverter jwtConverter;
    private final ObjectProvider<AuthSecurityProperties> authSecurityProperties;

    @Value("${CORS_ALLOWED_ORIGINS:${app.security.cors-allowed-origins:https://englishcoach.io.vn,https://www.englishcoach.io.vn,http://localhost:3000,http://127.0.0.1:3000}}")
    private String allowedOriginsConfig;

    public EchoVoiceWebSocketConfig(
            EchoVoiceWebSocketHandler handler,
            JwtDecoder jwtDecoder,
            CustomJwtAuthenticationConverter jwtConverter,
            ObjectProvider<AuthSecurityProperties> authSecurityProperties) {
        this.handler = handler;
        this.jwtDecoder = jwtDecoder;
        this.jwtConverter = jwtConverter;
        this.authSecurityProperties = authSecurityProperties;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        Set<String> allowedOriginSet = parseAllowedOrigins(allowedOriginsConfig);
        String[] origins = allowedOriginSet.toArray(String[]::new);

        registry.addHandler(handler, ENDPOINT)
                .setAllowedOrigins(origins)
                .addInterceptors(handshakeInterceptor(allowedOriginSet));
    }

    HandshakeInterceptor handshakeInterceptor(Set<String> allowedOrigins) {
        return new HandshakeInterceptor() {
            @Override
            public boolean beforeHandshake(
                    ServerHttpRequest request,
                    ServerHttpResponse response,
                    WebSocketHandler wsHandler,
                    Map<String, Object> attributes) {
                String origin = request.getHeaders().getOrigin();
                if (origin != null && !origin.isBlank() && !allowedOrigins.contains(origin.trim())) {
                    log.warn("[ECHO VOICE WS] Rejected handshake from disallowed Origin: {}", origin);
                    response.setStatusCode(HttpStatus.FORBIDDEN);
                    return false;
                }

                String token = extractHandshakeToken(request);
                if (token == null || token.isBlank()) {
                    response.setStatusCode(HttpStatus.UNAUTHORIZED);
                    return false;
                }

                try {
                    Jwt jwt = jwtDecoder.decode(token);
                    if (EchoVoiceWebSocketHandler.isForbiddenAuthMethod(jwt.getClaimAsString("authMethod"))) {
                        log.warn("[ECHO VOICE WS] Rejected handshake: forbidden authMethod claim");
                        response.setStatusCode(HttpStatus.UNAUTHORIZED);
                        return false;
                    }
                    AbstractAuthenticationToken authentication = jwtConverter.convert(jwt);
                    if (EchoVoiceWebSocketHandler.isForbiddenAuthentication(authentication)) {
                        log.warn("[ECHO VOICE WS] Rejected handshake: forbidden session scope");
                        response.setStatusCode(HttpStatus.UNAUTHORIZED);
                        return false;
                    }
                    UserDetailsImpl principal = (UserDetailsImpl) authentication.getPrincipal();
                    attributes.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, principal.getId());
                    attributes.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, authentication);
                    return true;
                } catch (Exception ex) {
                    log.warn("[ECHO VOICE WS] Rejected handshake due to invalid/revoked token: {}", ex.getMessage());
                    response.setStatusCode(HttpStatus.UNAUTHORIZED);
                    return false;
                }
            }

            @Override
            public void afterHandshake(
                    ServerHttpRequest request,
                    ServerHttpResponse response,
                    WebSocketHandler wsHandler,
                    Exception exception) {
            }
        };
    }

    private String extractHandshakeToken(ServerHttpRequest request) {
        if (request instanceof ServletServerHttpRequest servletRequest) {
            HttpServletRequest httpReq = servletRequest.getServletRequest();
            AuthSecurityProperties props = authSecurityProperties.getIfAvailable();
            String cookieToken = SessionCookies.accessToken(httpReq, props == null || props.isProduction());
            if (cookieToken != null && !cookieToken.isBlank()) {
                return cookieToken;
            }
        }
        String authHeader = request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (authHeader != null && authHeader.regionMatches(true, 0, "Bearer ", 0, 7)) {
            String bearer = authHeader.substring(7).trim();
            if (!bearer.isEmpty()) return bearer;
        }
        return null;
    }

    static Set<String> parseAllowedOrigins(String raw) {
        if (raw == null || raw.isBlank()) return Set.of();
        return Arrays.stream(raw.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty() && !"*".equals(s))
                .collect(Collectors.toCollection(java.util.LinkedHashSet::new));
    }
}
