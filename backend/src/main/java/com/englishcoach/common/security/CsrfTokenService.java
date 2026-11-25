package com.englishcoach.common.security;

import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

/**
 * The CSRF token of a cookie-authenticated session: HMAC-SHA256 of the session id under a key derived from the
 * application secret. It is bound to the session (another session's token never matches), needs no storage, and a
 * site that can plant a cookie on this host still cannot compute it.
 */
@Service
public class CsrfTokenService {

    private final byte[] key;

    public CsrfTokenService(AuthSecurityProperties properties) {
        this.key = DerivedKeys.derive(properties.getJwtSecret(), DerivedKeys.CSRF);
    }

    public String tokenFor(UUID sessionId) {
        byte[] mac = DerivedKeys.hmac(key, sessionId.toString().getBytes(StandardCharsets.UTF_8));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac);
    }

    public boolean matches(UUID sessionId, String presented) {
        if (sessionId == null || presented == null || presented.isBlank() || presented.length() > 128) return false;
        return DerivedKeys.constantTimeEquals(tokenFor(sessionId), presented.trim());
    }
}
