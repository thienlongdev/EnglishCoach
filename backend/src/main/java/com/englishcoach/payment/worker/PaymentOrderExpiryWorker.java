package com.englishcoach.payment.worker;

import com.englishcoach.payment.repository.PaymentOrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Slf4j
@Component
@RequiredArgsConstructor
public class PaymentOrderExpiryWorker {

    private final PaymentOrderRepository paymentOrderRepository;

    @Scheduled(fixedDelay = 60000) // Sweeps every 60 seconds
    @Transactional
    public void sweepExpiredOrders() {
        int count = paymentOrderRepository.expirePending(Instant.now());
        if (count > 0) log.info("[PaymentOrderExpiryWorker] Expired {} pending orders", count);
    }
}
