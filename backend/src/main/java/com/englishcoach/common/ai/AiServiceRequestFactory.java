package com.englishcoach.common.ai;

import org.springframework.http.client.SimpleClientHttpRequestFactory;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * {@link SimpleClientHttpRequestFactory} that presents the internal AI service credential ({@link AiServiceAuth}) on
 * connections to the AI service (and explicitly authorized companion internal origins such as OmniVoice) only, and
 * disables automatic HTTP redirects so credentials never cross to a redirected host.
 */
public class AiServiceRequestFactory extends SimpleClientHttpRequestFactory {

    private final Set<String> extraAuthorizedOrigins;
    private final String explicitCredential;

    public AiServiceRequestFactory() {
        this(Set.of(), null);
    }

    public AiServiceRequestFactory(Collection<String> extraAuthorizedOrigins, String explicitCredential) {
        Set<String> normalized = new LinkedHashSet<>();
        if (extraAuthorizedOrigins != null) {
            for (String candidate : extraAuthorizedOrigins) {
                String origin = AiServiceAuth.originOf(candidate);
                if (origin != null) {
                    normalized.add(origin);
                }
            }
        }
        this.extraAuthorizedOrigins = Set.copyOf(normalized);
        this.explicitCredential = (explicitCredential != null && !explicitCredential.isBlank())
                ? explicitCredential.trim()
                : null;
    }

    @Override
    protected void prepareConnection(HttpURLConnection connection, String httpMethod) throws IOException {
        super.prepareConnection(connection, httpMethod);
        connection.setInstanceFollowRedirects(false);
        String credential = AiServiceAuth.credentialFor(connection.getURL());
        if (credential == null && explicitCredential != null && !extraAuthorizedOrigins.isEmpty() && connection.getURL() != null) {
            try {
                String targetOrigin = AiServiceAuth.originOf(connection.getURL().toURI().toString());
                if (targetOrigin != null && extraAuthorizedOrigins.contains(targetOrigin)) {
                    credential = explicitCredential;
                }
            } catch (Exception ignored) {
            }
        }
        if (credential != null) {
            connection.setRequestProperty(AiServiceAuth.HEADER, credential);
        }
    }
}
