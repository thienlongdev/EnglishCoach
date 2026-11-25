package com.englishcoach.extension;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.ClientIpResolver;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.proficiency.ProficiencyLevelQuery;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Echo Anywhere (browser extension) endpoints. Pairing is created by a website session; every other call comes from the
 * extension's own session (Authorization header), limited by {@link EchoAnywhereScopeFilter}.
 */
@RestController
@RequestMapping("/api/v1/extension")
public class EchoAnywhereController {

    /** The code default of the usage ledger for a feature without a definition row (PremiumUsageService). */
    static final int AI_MONTHLY_LIMIT = 300;

    private final EchoAnywhereSessionService sessions;
    private final EchoAnywhereAiService ai;
    private final PremiumEntitlementService entitlements;
    private final PremiumUsageService usage;
    private final LoginThrottleService throttle;
    private final ObjectProvider<ProficiencyLevelQuery> levels;
    private final EchoAnywhereConfig config;

    public EchoAnywhereController(EchoAnywhereSessionService sessions, EchoAnywhereAiService ai,
                                  PremiumEntitlementService entitlements, PremiumUsageService usage,
                                  LoginThrottleService throttle, ObjectProvider<ProficiencyLevelQuery> levels,
                                  EchoAnywhereConfig config) {
        this.sessions = sessions;
        this.ai = ai;
        this.entitlements = entitlements;
        this.usage = usage;
        this.throttle = throttle;
        this.levels = levels;
        this.config = config;
    }

    public record PairingRequest(String extensionId, String codeChallenge, String browser) {}

    public record TokenRequest(String grantType, String code, String codeVerifier, String refreshToken, String extensionId) {}

    /** The learner approved "Kết nối" on the website (cookie session + CSRF). Never from an extension session. */
    @PostMapping("/pairings")
    public ResponseEntity<Map<String, Object>> pair(@AuthenticationPrincipal UserDetailsImpl user,
                                                    @RequestBody PairingRequest body) {
        Long userId = requireUser(user);
        AuthSessionContext session = AuthSessionContext.current();
        if (session == null || EchoAnywhereConfig.AUTH_METHOD.equals(session.authMethod())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Hãy kết nối từ trang web English Coach.");
        }
        if (session.adminAuthorityWithheld()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "MFA_REQUIRED");
        }
        if (body == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        var pairing = sessions.createPairing(userId, body.extensionId(), body.codeChallenge(), body.browser());
        return noStore(Map.of("code", pairing.code(), "expiresInSeconds", pairing.expiresInSeconds()));
    }

    /** Public (no website cookie is used): redeem a pairing code, or refresh. Rate-limited per address. */
    @PostMapping("/token")
    public ResponseEntity<Map<String, Object>> token(@RequestBody TokenRequest body, HttpServletRequest request) {
        if (!throttle.countRequest("ECHO_ANYWHERE_TOKEN_IP", ClientIpResolver.resolve(request), 60, 15)) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Quá nhiều yêu cầu. Hãy thử lại sau ít phút.");
        }
        if (body == null || body.grantType() == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        EchoAnywhereSessionService.Tokens t = switch (body.grantType()) {
            case "authorization_code" -> sessions.redeem(body.code(), body.codeVerifier(), body.extensionId());
            case "refresh_token" -> sessions.refresh(body.refreshToken(), body.extensionId());
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported grant type");
        };
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("accessToken", t.accessToken());
        out.put("refreshToken", t.refreshToken());
        out.put("expiresIn", t.expiresInSeconds());
        out.put("account", Map.of("id", t.userId(), "displayName", t.displayName()));
        return noStore(out);
    }

    /** "Ngắt kết nối" in the extension: ends this extension session only. */
    @PostMapping("/session/revoke")
    public ResponseEntity<Void> revoke(@AuthenticationPrincipal UserDetailsImpl user) {
        Long userId = requireUser(user);
        AuthSessionContext session = AuthSessionContext.current();
        if (session != null) sessions.revoke(session.sessionId(), userId);
        return ResponseEntity.noContent().build();
    }

    /** What the extension shows about the account: name, Premium, this month's Echo Anywhere AI use, level. */
    @GetMapping("/me")
    public ResponseEntity<Map<String, Object>> me(@AuthenticationPrincipal UserDetailsImpl user) {
        Long userId = requireUser(user);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("userId", userId);
        var active = entitlements.getActiveSubscription(userId);
        out.put("premium", active.isPresent());
        Instant until = active.map(s -> s.getExpiresAt()).orElse(null);
        if (until != null) out.put("premiumUntil", until.toString());
        int used = usage.getMonthlyPremiumUsedByFeature(userId, usage.getCurrentBillingCycleMonth())
                .getOrDefault(EchoAnywhereConfig.AI_FEATURE, 0);
        out.put("ai", Map.of("limit", AI_MONTHLY_LIMIT, "used", used, "remaining", Math.max(0, AI_MONTHLY_LIMIT - used)));
        try {
            ProficiencyLevelQuery q = levels.getIfAvailable();
            if (q != null) q.currentLevel(userId).ifPresent(c -> out.put("level", c.name()));
        } catch (Exception ignored) {
            // no level: the extension says "chưa xác định"
        }
        return noStore(out);
    }

    /** Premium AI (explicit learner action). Authentication + the shared AI bulkhead come from the interceptor. */
    @PostMapping("/ai")
    @RequirePremiumAi(value = EchoAnywhereConfig.AI_FEATURE, serviceManagedReservation = true)
    public ResponseEntity<JsonNode> ai(@AuthenticationPrincipal UserDetailsImpl user,
                                       @RequestBody EchoAnywhereAiService.Request body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ai.run(requireUser(user), body));
    }

    /** Public: which extension ids may pair (the website's connect page refuses any other). */
    @GetMapping("/config")
    public ResponseEntity<Map<String, Object>> publicConfig() {
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(10)).cachePublic())
                .body(Map.of("extensionIds", config.extensionIds()));
    }

    private static Long requireUser(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return user.getId();
    }

    private static ResponseEntity<Map<String, Object>> noStore(Map<String, Object> body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
