package com.englishcoach.content.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Thin network layer for fetching RSS feeds with strict timeout, security, and body size guards.
 */
@Slf4j
@Component
public class RssFeedFetcher {

    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap
    private static final String USER_AGENT = "EnglishCoach/2.0 (+https://englishcoach.io.vn; bot)";

    private final HttpClient httpClient;

    public RssFeedFetcher() {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NORMAL) // NORMAL never redirects HTTPS -> HTTP
                .build();
    }

    // Constructor for testing with mock HttpClient
    public RssFeedFetcher(HttpClient httpClient) {
        this.httpClient = httpClient;
    }

    /**
     * Fetches raw XML body string for a given feed URL.
     * Enforces: 5s connect timeout, 10s request timeout, 2MB body cap, redirect guard.
     */
    public String fetchFeed(String url) throws Exception {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("Feed URL must not be null or blank");
        }

        URI uri = URI.create(url);
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("Only HTTP/HTTPS URLs are supported: " + url);
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(Duration.ofSeconds(10))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/rss+xml, application/xml, text/xml, */*")
                .GET()
                .build();

        HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

        int statusCode = response.statusCode();
        if (statusCode < 200 || statusCode >= 300) {
            throw new RuntimeException("Feed fetch failed with HTTP status " + statusCode + " for " + url);
        }

        try (InputStream in = response.body(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int totalBytes = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                totalBytes += read;
                if (totalBytes > MAX_BODY_BYTES) {
                    log.warn("Feed response exceeded 2MB limit for {}, truncating", url);
                    out.write(buffer, 0, read - (totalBytes - MAX_BODY_BYTES));
                    break;
                }
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8);
        }
    }
}
