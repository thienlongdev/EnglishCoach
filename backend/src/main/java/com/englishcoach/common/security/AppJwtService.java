package com.englishcoach.common.security;

import com.englishcoach.auth.entity.User;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class AppJwtService {

    private final AuthSecurityProperties securityProperties;

    private SecretKey getSigningKey() {
        return Keys.hmacShaKeyFor(securityProperties.getJwtSecret().getBytes(StandardCharsets.UTF_8));
    }

    public String generateAccessToken(User user, UUID sessionId) {
        Instant now = Instant.now();
        Instant expiresAt = now.plus(securityProperties.getJwtLifetimeMinutes(), ChronoUnit.MINUTES);

        return Jwts.builder()
                .subject(user.getId().toString())
                .claim("userId", user.getId())
                .claim("email", user.getEmail())
                .claim("name", user.getName())
                .claim("role", user.getRole().name())
                .claim("sid", sessionId != null ? sessionId.toString() : null)
                .claim("generation", user.getCredentialVersion())
                .issuedAt(Date.from(now))
                .expiration(Date.from(expiresAt))
                .signWith(getSigningKey(), Jwts.SIG.HS256)
                .compact();
    }

    public Claims parseAndValidateToken(String token) {
        try {
            return Jwts.parser()
                    .verifyWith(getSigningKey())
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
        } catch (JwtException e) {
            log.warn("[JWT] Invalid token: {}", e.getMessage());
            throw e;
        }
    }
}
