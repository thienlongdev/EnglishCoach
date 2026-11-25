package com.englishcoach.auth.service;

import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The one place a Google ID token is trusted. A token counts only when Google's own published key signed it (RS256),
 * it names Google as issuer, it is inside its lifetime, and it was issued to THIS application (audience, and the
 * authorized party when present). Parsing a token proves nothing: anyone can write the claims of a token they sign.
 *
 * The keys come from one fixed Google address: a key location or key written inside the token ({@code jku},
 * {@code jwk}, {@code x5u}) is never followed. When the keys cannot be fetched the token cannot be proven and is
 * refused. Without a configured Google client id nothing can be proven to be meant for this application, so every
 * token is refused (Google sign-in is off; the rest of the application is unaffected).
 */
@Component
@Slf4j
public class GoogleIdTokenVerifier {

    static final String GOOGLE_JWK_SET_URI = "https://www.googleapis.com/oauth2/v3/certs";
    private static final List<String> GOOGLE_ISSUERS = List.of("https://accounts.google.com", "accounts.google.com");
    /** Tolerated difference between Google's clock and ours. */
    static final Duration CLOCK_SKEW = Duration.ofSeconds(60);
    /** Google: at most 255 case-sensitive ASCII characters; never an address, a path or blank. */
    private static final Pattern SUBJECT = Pattern.compile("^[A-Za-z0-9._-]{1,255}$");

    private final AuthSecurityProperties securityProperties;
    /** Checks the signature only; every claim is checked here so that each refusal keeps its own reason. */
    private final JwtDecoder signatureDecoder;

    @Autowired
    public GoogleIdTokenVerifier(AuthSecurityProperties securityProperties) {
        this(securityProperties, googleSignatureDecoder());
    }

    public GoogleIdTokenVerifier(AuthSecurityProperties securityProperties, JwtDecoder signatureDecoder) {
        this.securityProperties = securityProperties;
        this.signatureDecoder = signatureDecoder;
    }

    /**
     * Google's keys are fetched on first use and cached by the decoder (it fetches again when a token names a key it
     * does not know yet, which is how Google's rotation is followed); nothing is contacted at startup. The fetch is
     * bounded: a sign-in never waits on Google longer than a few seconds.
     */
    static JwtDecoder googleSignatureDecoder() {
        SimpleClientHttpRequestFactory http = new SimpleClientHttpRequestFactory();
        http.setConnectTimeout(3000);
        http.setReadTimeout(5000);
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(GOOGLE_JWK_SET_URI)
                .jwsAlgorithm(SignatureAlgorithm.RS256)
                .restOperations(new RestTemplate(http))
                .build();
        decoder.setJwtValidator(jwt -> OAuth2TokenValidatorResult.success());
        return decoder;
    }

    public Jwt verify(String idToken) {
        String clientId = securityProperties != null ? securityProperties.getGoogleClientId() : null;
        if (clientId == null || clientId.isBlank()) {
            log.error("[GoogleAuth] GOOGLE_CLIENT_ID is not configured: Google sign-in is refused");
            throw new IllegalArgumentException("Google sign-in is not configured");
        }
        clientId = clientId.trim();
        if (idToken == null || idToken.isBlank()) {
            throw new IllegalArgumentException("Missing Google token");
        }

        Jwt jwt;
        try {
            jwt = signatureDecoder.decode(idToken);
        } catch (JwtException e) {
            // wrong key, wrong algorithm, no signature, malformed, or Google's keys unreachable: not proven either way
            log.warn("[GoogleAuth] Google token not proven: {}", e.getClass().getSimpleName());
            throw new IllegalArgumentException("Google token signature is not valid");
        }

        String issuer = jwt.getClaimAsString("iss");
        if (issuer == null || !GOOGLE_ISSUERS.contains(issuer)) {
            throw new IllegalArgumentException("Invalid Google token issuer");
        }

        Instant now = Instant.now();
        Instant expiresAt = jwt.getExpiresAt();
        if (expiresAt == null || expiresAt.isBefore(now.minus(CLOCK_SKEW))) {
            throw new IllegalArgumentException("Google token has expired");
        }
        Instant issuedAt = jwt.getIssuedAt();
        if (issuedAt != null && issuedAt.isAfter(now.plus(CLOCK_SKEW))) {
            throw new IllegalArgumentException("Google token is not valid yet");
        }
        Instant notBefore = jwt.getNotBefore();
        if (notBefore != null && notBefore.isAfter(now.plus(CLOCK_SKEW))) {
            throw new IllegalArgumentException("Google token is not valid yet");
        }

        List<String> audiences = jwt.getAudience();
        if (audiences == null || !audiences.contains(clientId)) {
            throw new IllegalArgumentException("Invalid Google token audience");
        }
        String azp = jwt.getClaimAsString("azp");
        if (azp != null && !azp.isBlank() && !azp.equals(clientId)) {
            throw new IllegalArgumentException("Invalid Google token azp");
        }
        if (audiences.size() > 1 && (azp == null || azp.isBlank())) {
            throw new IllegalArgumentException("Invalid Google token azp");
        }

        String subject = jwt.getSubject();
        if (subject == null || subject.isBlank()) {
            throw new IllegalArgumentException("Missing subject in Google token");
        }
        if (!SUBJECT.matcher(subject).matches()) {
            throw new IllegalArgumentException("Invalid subject in Google token");
        }
        return jwt;
    }

    /**
     * Whether Google itself is the authority for this e-mail address: a Gmail address, or an address of a Google
     * Workspace domain (the token then carries the hosted-domain claim). For any other address Google only says the
     * user proved the mailbox once; the mailbox may have another owner today.
     */
    public static boolean googleIsAuthoritativeFor(Jwt jwt, String normalizedEmail) {
        if (normalizedEmail == null) return false;
        if (normalizedEmail.endsWith("@gmail.com") || normalizedEmail.endsWith("@googlemail.com")) return true;
        String hostedDomain = jwt.getClaimAsString("hd");
        return hostedDomain != null && !hostedDomain.isBlank()
                && normalizedEmail.endsWith("@" + hostedDomain.trim().toLowerCase());
    }
}
