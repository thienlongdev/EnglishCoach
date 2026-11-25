package com.englishcoach.common.ai;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** SEC-01: the AI service credential goes to the AI service origin only. */
class AiServiceAuthTest {

    private static final String KEY = "x".repeat(48);

    @AfterEach
    void reset() {
        AiServiceAuth.configure("", "http://localhost:8000");
    }

    @Test
    void credentialOnlyForTheConfiguredOrigin() throws Exception {
        AiServiceAuth.configure(KEY, "http://198.51.100.16:8000");
        assertThat(AiServiceAuth.credentialFor(URI.create("http://198.51.100.16:8000/api/v1/writing/x").toURL())).isEqualTo(KEY);
        assertThat(AiServiceAuth.credentialFor(URI.create("http://198.51.100.16:8005/tts/omnivoice").toURL())).isNull();
        assertThat(AiServiceAuth.credentialFor(URI.create("https://openrouter.ai/api/v1/chat").toURL())).isNull();
        assertThat(AiServiceAuth.credentialFor(URI.create("https://198.51.100.16:8000/api").toURL())).isNull();
    }

    @Test
    void noKeyMeansNoHeader() throws Exception {
        AiServiceAuth.configure("  ", "http://ai-service:8000");
        assertThat(AiServiceAuth.credentialFor(URI.create("http://ai-service:8000/api/v1/health").toURL())).isNull();
    }

    @Test
    void productionRefusesAShortKeyButStartsWithoutOne() {
        MockEnvironment prod = new MockEnvironment();
        prod.setActiveProfiles("prod");
        assertThatThrownBy(() -> new AiServiceAuth("short", "http://ai:8000", prod)).isInstanceOf(IllegalStateException.class);
        new AiServiceAuth("", "http://ai:8000", prod);
        new AiServiceAuth(KEY, "http://ai:8000", prod);
    }

    @Test
    void theFactorySetsTheHeaderOnTheConnection() throws Exception {
        AiServiceAuth.configure(KEY, "http://127.0.0.1:8000");
        var factory = new AiServiceRequestFactory();
        var request = factory.createRequest(URI.create("http://127.0.0.1:8000/api/v1/coach/chat"), org.springframework.http.HttpMethod.POST);
        assertThat(request).isNotNull();
        var connection = (java.net.HttpURLConnection) URI.create("http://127.0.0.1:8000/api/v1/coach/chat").toURL().openConnection();
        new AiServiceRequestFactory() {
            void prepare() throws java.io.IOException { prepareConnection(connection, "POST"); }
        }.prepare();
        assertThat(connection.getRequestProperty(AiServiceAuth.HEADER)).isEqualTo(KEY);
    }
}
