package com.englishcoach.writing.service;

import com.englishcoach.premium.exception.PremiumLimitReachedException;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.voucher.AiVoucherService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.UUID;

/** Only a fresh document evaluation incurs a paid model call. Reading or reusing a grade is free. */
@Service
@RequiredArgsConstructor
public class WritingGradingBudget {
    private static final String FEATURE = "WRITING_AI_FEEDBACK";
    private final PremiumEntitlementService entitlements;
    private final PremiumUsageService usage;
    private final AiVoucherService vouchers;

    public record Charge(Long reservation, Long voucher) {}

    public Charge reserve(long user) {
        if (!entitlements.isUserPremium(user)) throw new PremiumRequiredException(FEATURE, 0, "/premium",
                "Chấm bài viết bằng mô hình trả phí yêu cầu Premium.", null);
        String id = UUID.randomUUID().toString();
        try {
            return new Charge(usage.reserveUsage(user, FEATURE, id, true), null);
        } catch (PremiumLimitReachedException exhausted) {
            Long voucher = vouchers.reserve(user, FEATURE, id);
            if (voucher == null) throw exhausted;
            return new Charge(null, voucher);
        }
    }

    public void settle(Charge charge, boolean success) {
        if (charge.reservation() != null) {
            if (success) usage.commitReservation(charge.reservation());
            else usage.releaseReservation(charge.reservation());
        }
        if (charge.voucher() != null) {
            if (success) vouchers.consume(charge.voucher());
            else vouchers.release(charge.voucher());
        }
    }
}
