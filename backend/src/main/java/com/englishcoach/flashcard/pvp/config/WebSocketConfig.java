package com.englishcoach.flashcard.pvp.config;

import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

import java.util.Arrays;

@Configuration
@EnableWebSocketMessageBroker
@RequiredArgsConstructor
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final StompAuthChannelInterceptor stompAuthChannelInterceptor;
    // Optional so that the hand-built broker contexts of the realtime tests still start. Without it only the
    // host-prefixed production cookie is read (the strict reading), never the development name.
    private final org.springframework.beans.factory.ObjectProvider<com.englishcoach.common.security.AuthSecurityProperties> authSecurityProperties;

    @Value("${CORS_ALLOWED_ORIGINS:${app.security.cors-allowed-origins:https://englishcoach.io.vn,https://www.englishcoach.io.vn,http://localhost:3000,http://127.0.0.1:3000}}")
    private String allowedOriginsConfig;

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        String[] origins = Arrays.stream(allowedOriginsConfig.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty() && !s.equals("*"))
                .toArray(String[]::new);

        // The handshake is an ordinary same-origin HTTP request: the browser sends the session cookie with it and the
        // origin allow-list above refuses any other site (cross-site WebSocket hijacking). The token the cookie
        // carries is kept for the STOMP CONNECT frame, which authenticates it exactly as a header token.
        registry.addEndpoint("/ws-card-blast", "/ws")
                .setAllowedOrigins(origins)
                .addInterceptors(new org.springframework.web.socket.server.HandshakeInterceptor() {
                    @Override
                    public boolean beforeHandshake(org.springframework.http.server.ServerHttpRequest request,
                            org.springframework.http.server.ServerHttpResponse response,
                            org.springframework.web.socket.WebSocketHandler handler,
                            java.util.Map<String, Object> attributes) {
                        if (request instanceof org.springframework.http.server.ServletServerHttpRequest servlet) {
                            com.englishcoach.common.security.AuthSecurityProperties properties = authSecurityProperties.getIfAvailable();
                            String token = com.englishcoach.common.security.SessionCookies.accessToken(
                                    servlet.getServletRequest(), properties == null || properties.isProduction());
                            if (token != null) {
                                attributes.put(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN, token);
                            }
                        }
                        return true;
                    }

                    @Override
                    public void afterHandshake(org.springframework.http.server.ServerHttpRequest request,
                            org.springframework.http.server.ServerHttpResponse response,
                            org.springframework.web.socket.WebSocketHandler handler, Exception exception) {
                    }
                });
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        ThreadPoolTaskScheduler taskScheduler = new ThreadPoolTaskScheduler();
        taskScheduler.setPoolSize(2);
        taskScheduler.setThreadNamePrefix("stomp-heartbeat-");
        taskScheduler.initialize();

        config.enableSimpleBroker("/topic", "/queue")
                .setHeartbeatValue(new long[]{10000L, 10000L})
                .setTaskScheduler(taskScheduler);

        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper DIAGNOSTICS_JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    @Override
    public void configureWebSocketTransport(org.springframework.web.socket.config.annotation.WebSocketTransportRegistration registration) {
        registration.setMessageSizeLimit(32 * 1024);
        registration.setSendTimeLimit(15 * 1000);
        registration.setSendBufferSizeLimit(256 * 1024);
        registration.setTimeToFirstMessage(15 * 1000);
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(stompAuthChannelInterceptor);
        registration.taskExecutor()
                .corePoolSize(4)
                .maxPoolSize(16)
                .queueCapacity(512)
                .keepAliveSeconds(60);
    }

    @Override
    public void configureClientOutboundChannel(ChannelRegistration registration) {
        registration.taskExecutor()
                .corePoolSize(4)
                .maxPoolSize(16)
                .queueCapacity(512)
                .keepAliveSeconds(60);
        // Scope diagnostics to room-create responses; never log frame bodies,
        // credentials, identities or unrelated realtime traffic.
        registration.interceptors(new org.springframework.messaging.support.ChannelInterceptor() {
            @Override
            public org.springframework.messaging.Message<?> preSend(org.springframework.messaging.Message<?> message,
                    org.springframework.messaging.MessageChannel channel) {
                Object destHeader = message.getHeaders().get(org.springframework.messaging.simp.SimpMessageHeaderAccessor.DESTINATION_HEADER);
                if (destHeader instanceof String destination && destination.contains("/queue/pvp") && message.getPayload() instanceof byte[] bytes) {
                    try {
                        var json = DIAGNOSTICS_JSON.readTree(bytes);
                        if ("ROOM_CREATED".equals(json.path("type").asText())) {
                            org.slf4j.LoggerFactory.getLogger(WebSocketConfig.class).info(
                                    "[PVP TIMING] room={} userDestinationRoutedMs={}",
                                    json.path("payload").path("roomCode").asText(), System.currentTimeMillis());
                        }
                    } catch (java.io.IOException ignored) { /* diagnostics cannot interrupt delivery */ }
                }
                return message;
            }
        });
    }
}
