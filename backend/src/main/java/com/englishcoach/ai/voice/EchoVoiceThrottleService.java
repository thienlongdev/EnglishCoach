package com.englishcoach.ai.voice;

import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Shared rate-limit and GPU concurrency guard across BOTH HTTP ({@code /api/v1/ai/chat/transcribe},
 * {@code /api/v1/ai/chat/turn-check}) and full-duplex WebSocket ({@code /ws-card-blast/echo-voice}).
 *
 * <p>Guarantees that final ASR commits always win priority over speculative partial ASR frames, and bounds
 * per-user minute/day budgets to prevent any single socket or REST loop from saturating the GPU Whisper worker.</p>
 */
@Service
public class EchoVoiceThrottleService {

    private static final int MAX_TRACKED_USERS = 10_000;
    private static final int ASR_FINAL_PER_MIN = 36;
    private static final int ASR_FINAL_PER_DAY = 360;
    private static final int ASR_PARTIAL_PER_MIN = 90;
    private static final int ASR_PARTIAL_PER_DAY = 1_800;
    private static final int TURN_CHECK_PER_MIN = 120;
    private static final int TURN_CHECK_PER_DAY = 2_400;
    private static final int BARGE_PROBE_PER_MIN = 60;
    private static final int BARGE_PROBE_PER_DAY = 1_200;

    private record Budget(long minute, int recent, long day, int total) {}

    private final Semaphore asrSlots = new Semaphore(4, true);
    private final Map<Long, Budget> finalAsrBudgets = new HashMap<>();
    private final Map<Long, Budget> partialAsrBudgets = new HashMap<>();
    private final Map<Long, Budget> turnCheckBudgets = new HashMap<>();
    private final Map<Long, Budget> bargeProbeBudgets = new HashMap<>();

    public synchronized boolean admitFinalAsr(long userId) {
        return admit(finalAsrBudgets, userId, ASR_FINAL_PER_MIN, ASR_FINAL_PER_DAY);
    }

    public synchronized boolean admitPartialAsr(long userId) {
        return admit(partialAsrBudgets, userId, ASR_PARTIAL_PER_MIN, ASR_PARTIAL_PER_DAY);
    }

    public synchronized boolean admitTurnCheck(long userId) {
        return admit(turnCheckBudgets, userId, TURN_CHECK_PER_MIN, TURN_CHECK_PER_DAY);
    }

    public synchronized boolean admitBargeInProbe(long userId) {
        return admit(bargeProbeBudgets, userId, BARGE_PROBE_PER_MIN, BARGE_PROBE_PER_DAY);
    }

    /**
     * Final ASR commits wait up to 400 ms for a GPU slot; partial ASR acquires immediately ONLY when at least
     * 2 permits remain so final commits never stall behind speculative partial updates.
     */
    public boolean acquireAsrSlot(boolean isFinal) {
        if (!isFinal) {
            if (asrSlots.availablePermits() < 2) {
                return false;
            }
            return asrSlots.tryAcquire();
        }
        try {
            return asrSlots.tryAcquire(400, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public void releaseAsrSlot() {
        asrSlots.release();
    }

    private static boolean admit(Map<Long, Budget> store, long owner, int maxPerMinute, int maxPerDay) {
        long minute = System.currentTimeMillis() / 60_000L;
        long day = minute / 1_440L;
        store.values().removeIf(b -> b.day() != day);
        Budget b = store.getOrDefault(owner, new Budget(minute, 0, day, 0));
        int recent = b.minute() == minute ? b.recent() : 0;
        if (recent >= maxPerMinute || b.total() >= maxPerDay
                || (store.size() >= MAX_TRACKED_USERS && !store.containsKey(owner))) {
            return false;
        }
        store.put(owner, new Budget(minute, recent + 1, day, b.total() + 1));
        return true;
    }
}
