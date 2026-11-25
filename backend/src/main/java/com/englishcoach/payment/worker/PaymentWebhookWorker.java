package com.englishcoach.payment.worker;

import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.repository.PaymentTransactionRepository;
import com.englishcoach.payment.service.PaymentReconciliationService;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Component
@RequiredArgsConstructor
public class PaymentWebhookWorker {

    private static final long[] IDLE_BACKOFF_MS = {5_000L, 15_000L, 30_000L};

    private final PaymentTransactionRepository paymentTransactionRepository;
    private final PaymentReconciliationService paymentReconciliationService;

    private final Object scheduleLock = new Object();
    private final AtomicBoolean pollRunning = new AtomicBoolean(false);
    private volatile boolean workerStarted;
    private boolean wakeRequested;
    private int idleStep;
    private ScheduledFuture<?> nextPoll;

    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "payment-webhook-worker");
        t.setDaemon(true);
        return t;
    });

    @EventListener(ApplicationReadyEvent.class)
    public void startWorker() {
        synchronized (scheduleLock) {
            workerStarted = true;
            idleStep = 0;
            nextPoll = worker.schedule(this::pollLoop, IDLE_BACKOFF_MS[0], TimeUnit.MILLISECONDS);
        }
    }

    /** Immediately resets idle backoff and schedules a reconciliation pass when a RECEIVED webhook arrives. */
    public void wakePoller() {
        synchronized (scheduleLock) {
            idleStep = 0;
            if (!workerStarted || worker.isShutdown()) return;
            if (pollRunning.get()) {
                wakeRequested = true;
                return;
            }
            if (nextPoll != null) nextPoll.cancel(false);
            nextPoll = worker.schedule(this::pollLoop, 0L, TimeUnit.MILLISECONDS);
        }
    }

    @PreDestroy
    public void stopWorker() {
        synchronized (scheduleLock) {
            workerStarted = false;
            if (nextPoll != null) nextPoll.cancel(false);
        }
        worker.shutdownNow();
    }

    private void pollLoop() {
        pollRunning.set(true);
        int processedCount = 0;
        try {
            processedCount = processPendingAndReport();
        } catch (Exception e) {
            log.warn("[PaymentWebhookWorker] Sweep failed ({})", e.getClass().getSimpleName());
        } finally {
            pollRunning.set(false);
            synchronized (scheduleLock) {
                if (workerStarted && !worker.isShutdown()) {
                    long delayMs;
                    if (wakeRequested) {
                        wakeRequested = false;
                        idleStep = 0;
                        delayMs = 0L;
                    } else if (processedCount > 0) {
                        idleStep = 0;
                        delayMs = processedCount >= 50 ? 250L : IDLE_BACKOFF_MS[0];
                    } else {
                        delayMs = IDLE_BACKOFF_MS[Math.min(idleStep, IDLE_BACKOFF_MS.length - 1)];
                        if (idleStep < IDLE_BACKOFF_MS.length - 1) idleStep++;
                    }
                    nextPoll = worker.schedule(this::pollLoop, delayMs, TimeUnit.MILLISECONDS);
                }
            }
        }
    }

    public void processPendingTransactions() {
        processPendingAndReport();
    }

    private int processPendingAndReport() {
        List<PaymentTransaction> pendingList = paymentTransactionRepository
                .findTop50ByProcessingStatusInOrderByReceivedAtAsc(List.of(PaymentTransactionStatus.RECEIVED));

        if (!pendingList.isEmpty()) {
            log.info("[PaymentWebhookWorker] Found {} RECEIVED transactions to reconcile", pendingList.size());
            for (PaymentTransaction tx : pendingList) {
                try {
                    paymentReconciliationService.reconcileReceived(tx.getId());
                } catch (Exception e) {
                    log.error("[PaymentWebhookWorker] Error reconciling transaction id={}: {}",
                            tx.getProviderTransactionId(), e.getClass().getSimpleName());
                }
            }
        }
        return pendingList.size();
    }
}
