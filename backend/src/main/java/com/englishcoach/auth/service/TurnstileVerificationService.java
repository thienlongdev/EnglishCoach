package com.englishcoach.auth.service;

import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;

import java.util.Map;
import java.util.Set;

@Service
@RequiredArgsConstructor
@Slf4j
public class TurnstileVerificationService {

    private static final String CLOUDFLARE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    private static final Set<String> PRODUCTION_ALLOWED_HOSTNAMES = Set.of(
            "englishcoach.io.vn",
            "www.englishcoach.io.vn"
    );

    private final AuthSecurityProperties securityProperties;

    @Autowired(required = false)
    private RestTemplate restTemplate;

    void setRestTemplate(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    private RestTemplate getRestTemplate() {
        if (this.restTemplate != null) {
            return this.restTemplate;
        }
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(5000);
        return new RestTemplate(factory);
    }

    public boolean verifyToken(String token, String clientIp, String actionContext) {
        boolean enabled = securityProperties != null && securityProperties.isTurnstileEnabled();
        boolean required = securityProperties != null && securityProperties.isTurnstileRequired();
        String secretKey = securityProperties != null ? securityProperties.getTurnstileSecretKey() : null;

        // If turnstile is completely disabled, allow request
        if (!enabled) {
            return true;
        }

        // If token is missing
        if (token == null || token.isBlank()) {
            if (required) {
                log.warn("[Turnstile] Verification failed: missing token for action '{}' from IP {}", actionContext, clientIp);
                throw new IllegalArgumentException("Anti-bot verification challenge is required.");
            }
            return true;
        }

        // Validate token against Cloudflare Siteverify API
        try {
            RestTemplate restTemplate = getRestTemplate();
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);

            MultiValueMap<String, String> params = new LinkedMultiValueMap<>();
            params.add("secret", secretKey != null && !secretKey.isBlank() ? secretKey : "1x0000000000000000000000000000000AA");
            params.add("response", token);
            if (isPublicIp(clientIp)) {
                params.add("remoteip", clientIp);
            }

            HttpEntity<MultiValueMap<String, String>> request = new HttpEntity<>(params, headers);
            ResponseEntity<Map> response = restTemplate.postForEntity(CLOUDFLARE_SITEVERIFY_URL, request, Map.class);

            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                log.warn("[Turnstile] Siteverify returned non-2xx status: {}", response.getStatusCode());
                if (required) {
                    throw new IllegalArgumentException("Anti-bot verification service is temporarily unavailable. Please try again.");
                }
                return true;
            }

            Map body = response.getBody();
            Object successObj = body.get("success");
            boolean success = Boolean.TRUE.equals(successObj);

            if (!success) {
                Object errorCodesObj = body.get("error-codes");
                String errorCodesStr = errorCodesObj != null ? errorCodesObj.toString() : "";
                log.warn("[Turnstile] Verification REJECTED for action '{}' from IP {}: error-codes={}",
                        actionContext, clientIp, errorCodesStr);

                if (errorCodesStr.contains("timeout-or-duplicate")) {
                    throw new IllegalArgumentException("Anti-bot verification challenge expired or already used. Please complete it again.");
                }
                throw new IllegalArgumentException("Anti-bot verification challenge failed. Please try again.");
            }

            // Validate Hostname
            validateHostname(body);

            // Validate Action if present
            validateAction(body, actionContext);

            log.info("[Turnstile] Verification SUCCESS for action '{}' from IP {}", actionContext, clientIp);
            return true;

        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            log.error("[Turnstile] Verification call exception for action '{}' from IP {}: {}",
                    actionContext, clientIp, e.getMessage());
            if (required) {
                // Fail closed in production when Turnstile is required
                throw new IllegalArgumentException("Anti-bot verification service is temporarily unavailable. Please try again.");
            }
            return true;
        }
    }

    private void validateHostname(Map body) {
        String secretKey = securityProperties != null ? securityProperties.getTurnstileSecretKey() : null;
        boolean isProd = securityProperties != null && securityProperties.isProduction();
        boolean isTestSecret = secretKey == null || secretKey.startsWith("1x0000000000")
                || secretKey.startsWith("2x0000000000") || secretKey.startsWith("3x0000000000");

        // In production with real Cloudflare secret key, enforce production hostnames
        if (isProd && !isTestSecret) {
            Object hostnameObj = body.get("hostname");
            String hostname = hostnameObj != null ? hostnameObj.toString().trim().toLowerCase() : null;
            if (hostname == null || !PRODUCTION_ALLOWED_HOSTNAMES.contains(hostname)) {
                log.warn("[Turnstile] Hostname mismatch in production: '{}' (allowed: {})", hostname, PRODUCTION_ALLOWED_HOSTNAMES);
                throw new IllegalArgumentException("Anti-bot verification hostname mismatch.");
            }
        }
    }

    private void validateAction(Map body, String expectedActionContext) {
        if (expectedActionContext == null || expectedActionContext.isBlank()) {
            return;
        }
        Object actionObj = body.get("action");
        if (actionObj == null) {
            return; // Action not passed or not configured in widget
        }
        String returnedAction = normalizeAction(actionObj.toString());
        String expectedAction = normalizeAction(expectedActionContext);

        if (!returnedAction.isBlank() && !returnedAction.equals(expectedAction)) {
            log.warn("[Turnstile] Action mismatch: expected '{}', got '{}'", expectedAction, returnedAction);
            throw new IllegalArgumentException("Anti-bot verification action mismatch.");
        }
    }

    private String normalizeAction(String action) {
        if (action == null) return "";
        return action.trim().toLowerCase().replace('_', '-');
    }

    private boolean isPublicIp(String ip) {
        if (ip == null || ip.isBlank() || "unknown".equalsIgnoreCase(ip)) return false;
        if (ip.startsWith("127.") || ip.equals("::1") || ip.equals("0:0:0:0:0:0:0:1")) return false;
        if (ip.startsWith("10.") || ip.startsWith("192.168.")) return false;
        if (ip.matches("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*")) return false;
        if (ip.startsWith("fc00:") || ip.startsWith("fe80:")) return false;
        return true;
    }
}
