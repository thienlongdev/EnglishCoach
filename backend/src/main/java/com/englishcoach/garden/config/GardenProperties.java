package com.englishcoach.garden.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

/**
 * Echo Garden release gate ({@code app.garden.*}, features/echo-garden.md). Gameplay is OFF unless
 * {@code enabled} is true (env {@code APP_GARDEN_ENABLED}); while on, only {@code allowlist-user-ids}
 * (env {@code APP_GARDEN_ALLOWLIST_USER_IDS}, comma list) may play, and an empty list means every user (the owner opens
 * the garden that way after Phase 3). {@code qa-user-ids} additionally see the 60-second {@code QA_SPROUT} crop.
 * Everyone else keeps the visual preview and receives 404 from every gameplay endpoint.
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.garden")
public class GardenProperties {

    private boolean enabled = false;

    private List<Long> allowlistUserIds = new ArrayList<>();

    /**
     * Phase 4 bulkhead ({@code app.garden.max-concurrent-transactions}, env
     * {@code APP_GARDEN_MAX_CONCURRENT_TRANSACTIONS}): the most garden transactions that may run at once in this
     * backend. Every garden transaction holds one connection of the shared pool for its whole duration, and against the
     * external database one state read is dozens of network round trips: without a bound, a burst of garden players
     * takes every connection and sign-in, learning and payments wait behind them. Keep it BELOW the pool size
     * ({@code spring.datasource.hikari.maximum-pool-size}, 20): the difference is what the rest of the site always
     * keeps. 0 switches the bound off.
     */
    private int maxConcurrentTransactions = 14;

    /**
     * How long a garden request waits for a free slot before it is told {@code 503 GARDEN_BUSY}
     * ({@code app.garden.busy-wait-millis}); the client retries a 5xx with the same idempotency key.
     */
    private long busyWaitMillis = 15000;

    /**
     * Phase 5 ({@code app.garden.batch-reads}): the garden sends the reads of a request to the database together and
     * remembers them for the transaction (see {@code GardenJdbc}). false makes every statement its own exchange again,
     * exactly as before Phase 5: an operational switch, no behaviour depends on it.
     */
    private boolean batchReads = true;

    private List<Long> qaUserIds = new ArrayList<>();

    /**
     * Phase 3C kill switch of the Echo Rewards counter ({@code app.garden.rewards-enabled}, env
     * {@code APP_GARDEN_REWARDS_ENABLED}). OFF by default: contribution is still recorded and the catalogue is shown,
     * but nothing can be redeemed. Turning it on opens only rewards that are enabled in the catalogue AND have a real
     * delivery mechanism (today: the in-garden cultivar); it can never grant a Premium, AI-quota or avatar-frame
     * entitlement, because no such delivery exists in the code.
     */
    private boolean rewardsEnabled = false;

    /**
     * Phase 3E kill switch of direct (real-money) cosmetic purchases ({@code app.garden.cosmetic-checkout-enabled}, env
     * {@code APP_GARDEN_COSMETIC_CHECKOUT_ENABLED}). OFF by default and set in no environment file. Turning it on is
     * not enough: an order also needs a payment gateway bean (none exists) and an enabled, priced SKU (none is seeded).
     * Buying with Đồng Echo never depends on this switch.
     */
    private boolean cosmeticCheckoutEnabled = false;

    /**
     * Phase 3F: Premium 7-day reward for Echo Coins ({@code app.garden.premium-reward.*}). Every redemption is a real
     * week of Premium, i.e. an ongoing service cost, so the reward is CLOSED unless the switch is on AND the owner has
     * configured all three budget numbers: the most redemptions per Vietnam month, the estimated cost of one, and the
     * monthly cost budget. A missing or zero number keeps it closed (never "unlimited").
     */
    private boolean premiumRewardEnabled = false;
    private int premiumRewardMonthlyCap = 0;
    private long premiumRewardUnitCostVnd = 0;
    private long premiumRewardMonthlyBudgetVnd = 0;

    /**
     * Phase 3F: AI voucher sales for Echo Coins ({@code app.garden.ai-voucher.*}). A voucher is one paid AI request, so
     * issuing is CLOSED unless the switch is on AND the monthly credit cap, the estimated cost of one credit and the
     * monthly cost budget are all configured. Spending an issued voucher has its own switch ({@code app.ai-voucher}).
     */
    private boolean aiVoucherEnabled = false;
    private int aiVoucherMonthlyCreditCap = 0;
    private long aiVoucherUnitCostVnd = 0;
    private long aiVoucherMonthlyBudgetVnd = 0;

    /** Phase 3F: the twenty Echo Garden profile frames (art only, no service cost): ON unless switched off. */
    private boolean framesEnabled = true;

    public boolean premiumRewardOpen() {
        return premiumRewardEnabled && premiumRewardMonthlyCap > 0 && premiumRewardUnitCostVnd > 0 && premiumRewardMonthlyBudgetVnd > 0;
    }

    public boolean aiVoucherOpen() {
        return aiVoucherEnabled && aiVoucherMonthlyCreditCap > 0 && aiVoucherUnitCostVnd > 0 && aiVoucherMonthlyBudgetVnd > 0;
    }
}
