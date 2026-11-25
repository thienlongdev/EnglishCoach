package com.englishcoach.premium.interceptor;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.exception.PremiumLimitReachedException;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.UUID;

@Slf4j
@Component
@RequiredArgsConstructor
public class PremiumFeatureGatingInterceptor implements HandlerInterceptor {

    public static final String RESERVATION_ATTR = "PREMIUM_RESERVATION_ID";
    public static final String FEATURE_KEY_ATTR = "PREMIUM_FEATURE_KEY";

    private final PremiumEntitlementService entitlementService;
    private final PremiumUsageService usageService;

    public static final String VOUCHER_USE_ATTR = "AI_VOUCHER_USE_ID";

    /** The shared AI voucher wallet (absent in slim unit tests: quota behaviour is then exactly as before). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.premium.voucher.AiVoucherService voucherService;

    static final String BULKHEAD_ATTR = "AI_BULKHEAD_PERMIT";

    /** Bound on AI requests in progress (absent in slim unit tests: then unbounded, exactly as before). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private AiRequestBulkhead aiBulkhead;

    private void leaveBulkhead(HttpServletRequest request) {
        if (aiBulkhead != null && request.getAttribute(BULKHEAD_ATTR) != null) {
            request.removeAttribute(BULKHEAD_ATTR);
            aiBulkhead.leave();
        }
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }

        RequirePremiumAi annotation = handlerMethod.getMethodAnnotation(RequirePremiumAi.class);
        if (annotation == null) {
            annotation = handlerMethod.getBeanType().getAnnotation(RequirePremiumAi.class);
        }

        if (annotation == null) {
            return true;
        }

        if (request.getDispatcherType() == jakarta.servlet.DispatcherType.ASYNC
                && (request.getAttribute(RESERVATION_ATTR) != null || request.getAttribute(VOUCHER_USE_ATTR) != null)) {
            return true;
        }

        // Bounded number of AI requests in progress (AiRequestBulkhead). Taken before any quota work, so a refused request
        // reserves and charges nothing; an asynchronous re-dispatch of the same request keeps its one permit.
        if (aiBulkhead != null && request.getAttribute(BULKHEAD_ATTR) == null) {
            if (!aiBulkhead.tryEnter()) {
                log.warn("AI request refused: {} of {} AI requests already in progress", aiBulkhead.inUse(), aiBulkhead.max());
                response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
                response.setHeader("Retry-After", "10");
                response.setHeader("Cache-Control", "no-store");
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write("{\"code\":\"AI_BUSY\",\"status\":503,\"message\":\"Trợ lý AI đang bận, vui lòng thử lại "
                        + "sau ít giây. / The AI assistant is busy, please try again in a few seconds.\"}");
                return false;
            }
            request.setAttribute(BULKHEAD_ATTR, Boolean.TRUE);
        }
        try {
            return reserve(request, annotation);
        } catch (Exception refused) {
            // a refused request never reaches afterCompletion of this interceptor: give the permit back here
            leaveBulkhead(request);
            throw refused;
        }
    }

    private boolean reserve(HttpServletRequest request, RequirePremiumAi annotation) throws Exception {
        String featureKey = annotation.value();
        request.setAttribute(FEATURE_KEY_ATTR, featureKey);

        // Extract Authenticated User
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        Long userId = null;
        if (auth != null && auth.isAuthenticated()) {
            Object principal = auth.getPrincipal();
            if (principal instanceof UserDetailsImpl userDetails) {
                userId = userDetails.getId();
            } else if (principal instanceof Long id) {
                userId = id;
            }
        }

        if (userId == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED,
                    "Authentication required to use AI features"
            );
        }

        // A durable replay service must look up its completed response before checking a now-exhausted quota.
        // It owns reservation + settlement atomically with its receipt; the interceptor still authenticates and bounds it.
        if (annotation.serviceManagedReservation()) return true;

        // By default (reuseClientRequestId = false), mint a fresh server UUID per execution, ignoring every client
        // identifier so X-Request-Id / Idempotency-Key cannot bypass quotas or vouchers (EC-SEC-2026-002).
        String clientRequestId;
        if (!annotation.reuseClientRequestId()) {
            clientRequestId = UUID.randomUUID().toString();
        } else {
            clientRequestId = !annotation.requestIdParam().isBlank()
                    ? request.getParameter(annotation.requestIdParam())
                    : null;
            if (clientRequestId == null || clientRequestId.isBlank()) {
                clientRequestId = request.getHeader("X-Client-Turn-Id");
            }
            if (clientRequestId == null || clientRequestId.isBlank()) {
                clientRequestId = request.getHeader("X-Client-Attempt-Id");
            }
            if (clientRequestId == null || clientRequestId.isBlank()) {
                clientRequestId = request.getHeader("X-Request-Id");
            }
            if (clientRequestId == null || clientRequestId.isBlank()) {
                clientRequestId = request.getHeader("Idempotency-Key");
            }
        }

        boolean isPremium = entitlementService.isUserPremium(userId);

        // Atomic check & reservation: throws PremiumRequiredException, PremiumLimitReachedException, or 409 Conflict if in-flight
        PremiumUsageService.ReservationResult usageResult;
        try {
            usageResult = usageService.reserveUsageWithReplayStatus(userId, featureKey, clientRequestId, isPremium);
            if (usageResult == null) {
                // Compatibility with Mockito unit tests that stub only reserveUsage(...)
                Long legacyReservationId = usageService.reserveUsage(userId, featureKey, clientRequestId, isPremium);
                usageResult = new PremiumUsageService.ReservationResult(legacyReservationId, false);
            }
        } catch (PremiumRequiredException | PremiumLimitReachedException quotaExhausted) {
            // The included quota (free trial / Premium monthly limit) always goes first. Only when it is exhausted may an
            // AI voucher pay for this one request; without an eligible, unexpired voucher the original refusal stands.
            // Interceptor-managed voucher reservations never replay for free (eliminates 3x voucher multiplication).
            com.englishcoach.premium.voucher.AiVoucherService.VoucherReservation voucherResult = null;
            if (voucherService != null) {
                voucherResult = voucherService.reserveForInterceptor(userId, featureKey, clientRequestId);
                if (voucherResult == null) {
                    // Compatibility with Mockito unit tests that stub only reserve(...)
                    Long legacyUseId = voucherService.reserve(userId, featureKey, clientRequestId);
                    voucherResult = new com.englishcoach.premium.voucher.AiVoucherService.VoucherReservation(legacyUseId, false);
                }
            }
            if (voucherResult == null || voucherResult.useId() == null) {
                throw quotaExhausted;
            }
            if (!voucherResult.idempotentReplay()) {
                request.setAttribute(VOUCHER_USE_ATTR, voucherResult.useId());
            }
            return true;
        }
        // Only record RESERVATION_ATTR when THIS request actually created the RESERVED row so an idempotent replay
        // can never commit or release another request's reservation in afterCompletion.
        if (usageResult.reservationId() != null && !usageResult.idempotentReplay()) {
            request.setAttribute(RESERVATION_ATTR, usageResult.reservationId());
        }

        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        try {
            settle(request, response, ex);
        } finally {
            leaveBulkhead(request);
        }
    }

    private void settle(HttpServletRequest request, HttpServletResponse response, Exception ex) {
        Long reservationId = (Long) request.getAttribute(RESERVATION_ATTR);
        if (reservationId == null && voucherService != null) {
            // a request is paid either by the included quota (a reservation) or by one AI voucher, never both.
            // Charge policy (also for streamed responses): the voucher is spent when the exchange completes with 2xx / 3xx
            // and goes back to its grant otherwise. Internal retries and several model calls inside the handler are one request.
            Long voucherUseId = (Long) request.getAttribute(VOUCHER_USE_ATTR);
            if (voucherUseId != null) {
                int voucherStatus = response.getStatus();
                if (ex == null && voucherStatus >= 200 && voucherStatus < 400) {
                    voucherService.consume(voucherUseId);
                } else {
                    voucherService.release(voucherUseId);
                }
            }
        }
        if (reservationId != null) {
            int status = response.getStatus();
            boolean isSuccess = (ex == null && status >= 200 && status < 400);

            if (isSuccess) {
                usageService.commitReservation(reservationId);
            } else {
                log.info("AI operation failed or aborted with status {} (ex={}), releasing reservation #{}",
                        status, ex != null ? ex.getMessage() : "none", reservationId);
                usageService.releaseReservation(reservationId);
            }
        }
    }
}
