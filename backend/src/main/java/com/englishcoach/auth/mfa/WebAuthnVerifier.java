package com.englishcoach.auth.mfa;

import com.englishcoach.common.security.AuthSecurityProperties;
import com.webauthn4j.WebAuthnManager;
import com.webauthn4j.converter.AttestedCredentialDataConverter;
import com.webauthn4j.converter.util.ObjectConverter;
import com.webauthn4j.credential.CredentialRecord;
import com.webauthn4j.credential.CredentialRecordImpl;
import com.webauthn4j.data.AuthenticationData;
import com.webauthn4j.data.AuthenticationParameters;
import com.webauthn4j.data.AuthenticatorTransport;
import com.webauthn4j.data.PublicKeyCredentialParameters;
import com.webauthn4j.data.PublicKeyCredentialType;
import com.webauthn4j.data.RegistrationData;
import com.webauthn4j.data.RegistrationParameters;
import com.webauthn4j.data.attestation.authenticator.AttestedCredentialData;
import com.webauthn4j.data.attestation.authenticator.AuthenticatorData;
import com.webauthn4j.data.attestation.statement.COSEAlgorithmIdentifier;
import com.webauthn4j.data.attestation.statement.NoneAttestationStatement;
import com.webauthn4j.data.client.Origin;
import com.webauthn4j.data.client.challenge.DefaultChallenge;
import com.webauthn4j.server.ServerProperty;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Verification of WebAuthn ceremonies (passkeys, security keys) with the library Spring Security builds on. What is
 * checked for every response: the challenge this server issued for this ceremony, the origin (one of this site's
 * own), the relying-party id hash, the type of ceremony, user presence AND user verification, the signature under
 * the credential's public key, and the signature counter (a counter that goes backwards is refused as a cloned
 * authenticator).
 *
 * Attestation: none is requested and none is trusted ("none" conveyance): the factor proves possession of the key
 * that was enrolled, not the make of the device; no device identifier beyond what the authenticator volunteers is
 * stored. Only public material is ever kept.
 */
@Component
public class WebAuthnVerifier {

    /** ES256, EdDSA, RS256: what platform authenticators and security keys offer. */
    static final List<PublicKeyCredentialParameters> ALGORITHMS = List.of(
            new PublicKeyCredentialParameters(PublicKeyCredentialType.PUBLIC_KEY, COSEAlgorithmIdentifier.ES256),
            new PublicKeyCredentialParameters(PublicKeyCredentialType.PUBLIC_KEY, COSEAlgorithmIdentifier.EdDSA),
            new PublicKeyCredentialParameters(PublicKeyCredentialType.PUBLIC_KEY, COSEAlgorithmIdentifier.RS256));

    private final WebAuthnManager manager = WebAuthnManager.createNonStrictWebAuthnManager();
    private final AttestedCredentialDataConverter credentialDataConverter =
            new AttestedCredentialDataConverter(new ObjectConverter());
    private final String rpId;
    private final Set<Origin> origins;

    public record Registered(String credentialId, byte[] attestedCredentialData, long signCount, String transports,
                             boolean backupEligible, boolean backupState) {}

    public record Asserted(long signCount, boolean backupState) {}

    /** A response that does not verify; the message is for the log, never for the caller. */
    public static class WebAuthnRejectedException extends RuntimeException {
        public WebAuthnRejectedException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    @org.springframework.beans.factory.annotation.Autowired
    public WebAuthnVerifier(AuthSecurityProperties properties,
            @Value("${app.security.cors-allowed-origins:http://localhost:3000,http://127.0.0.1:3000}") String allowedOrigins) {
        this(resolveRpId(properties), originsOf(properties.getBaseUrl(), allowedOrigins));
    }

    WebAuthnVerifier(String rpId, Set<String> origins) {
        this.rpId = rpId;
        this.origins = origins.stream().map(Origin::new).collect(Collectors.toCollection(LinkedHashSet::new));
    }

    static String resolveRpId(AuthSecurityProperties properties) {
        String configured = properties.getWebauthnRpId();
        if (configured != null && !configured.isBlank()) return configured.trim().toLowerCase();
        return URI.create(properties.getBaseUrl().trim()).getHost().toLowerCase();
    }

    /** The site's own origins whose host is the relying-party id or below it. */
    static Set<String> originsOf(String baseUrl, String allowedOrigins) {
        String rpHost = URI.create(baseUrl.trim()).getHost().toLowerCase();
        Set<String> out = new LinkedHashSet<>();
        out.add(stripTrailingSlash(baseUrl.trim()));
        Arrays.stream(allowedOrigins.split(",")).map(String::trim).filter(s -> !s.isEmpty() && !"*".equals(s))
                .filter(s -> {
                    try {
                        String host = URI.create(s).getHost();
                        return host != null && (host.equalsIgnoreCase(rpHost) || host.toLowerCase().endsWith("." + rpHost));
                    } catch (IllegalArgumentException e) {
                        return false;
                    }
                })
                .map(WebAuthnVerifier::stripTrailingSlash).forEach(out::add);
        return out;
    }

    private static String stripTrailingSlash(String value) {
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }

    public String rpId() {
        return rpId;
    }

    public Registered verifyRegistration(String responseJson, byte[] challenge) {
        try {
            RegistrationData data = manager.verifyRegistrationResponseJSON(responseJson,
                    new RegistrationParameters(serverProperty(challenge), ALGORITHMS, true, true));
            AuthenticatorData<?> authenticatorData = data.getAttestationObject().getAuthenticatorData();
            AttestedCredentialData attested = authenticatorData.getAttestedCredentialData();
            if (attested == null) throw new IllegalStateException("no attested credential data");
            String transports = data.getTransports() == null ? null : data.getTransports().stream()
                    .map(AuthenticatorTransport::getValue).sorted().collect(Collectors.joining(","));
            return new Registered(base64Url(attested.getCredentialId()), credentialDataConverter.convert(attested),
                    authenticatorData.getSignCount(), transports,
                    authenticatorData.isFlagBE(), authenticatorData.isFlagBS());
        } catch (RuntimeException e) {
            throw new WebAuthnRejectedException("registration: " + e.getClass().getSimpleName(), e);
        }
    }

    /** The credential id the response names (base64url), before anything about it is trusted. */
    public String credentialIdOf(String responseJson) {
        try {
            return base64Url(manager.parseAuthenticationResponseJSON(responseJson).getCredentialId());
        } catch (RuntimeException e) {
            throw new WebAuthnRejectedException("assertion parse: " + e.getClass().getSimpleName(), e);
        }
    }

    public Asserted verifyAssertion(String responseJson, byte[] challenge, MfaStore.WebAuthnCredential stored) {
        try {
            AttestedCredentialData attested = credentialDataConverter.convert(stored.attestedCredentialData());
            CredentialRecord record = new CredentialRecordImpl(new NoneAttestationStatement(), true,
                    stored.backupEligible(), stored.backupState(), stored.signCount(), attested, null, null, null,
                    null);
            AuthenticationData data = manager.verifyAuthenticationResponseJSON(responseJson,
                    new AuthenticationParameters(serverProperty(challenge), record,
                            List.of(attested.getCredentialId()), true, true));
            return new Asserted(data.getAuthenticatorData().getSignCount(), data.getAuthenticatorData().isFlagBS());
        } catch (RuntimeException e) {
            throw new WebAuthnRejectedException("assertion: " + e.getClass().getSimpleName(), e);
        }
    }

    private ServerProperty serverProperty(byte[] challenge) {
        return new ServerProperty(origins, rpId, new DefaultChallenge(challenge));
    }

    static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
