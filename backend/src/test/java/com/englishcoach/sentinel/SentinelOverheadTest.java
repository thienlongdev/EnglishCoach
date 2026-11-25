package com.englishcoach.sentinel;

import org.junit.jupiter.api.*;
import java.time.Clock;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Measured cost of the hot paths (memory only): a page report and an accepted game action. Prints the numbers. */
class SentinelOverheadTest {
    static final class NullStore extends SentinelStore {
        NullStore() { super(null); }
        @Override public void write(SentinelAttempt.Change c) { }
        @Override public void writeLater(SentinelAttempt.Change c) { }
    }
    @Test void hotPathsCostMicroseconds() {
        var s = new SentinelService(new NullStore(), Clock.systemUTC());
        var attempts = new ArrayList<SentinelService.Begun>();
        for (long u = 1; u <= 500; u++) attempts.add(s.begin(u, SentinelPolicy.KING_CONQUEST, true, SentinelPolicy.POLICY_VERSION));
        var live = new ArrayList<SentinelAttempt>();
        for (int i = 0; i < attempts.size(); i++) {
            var b = attempts.get(i); var a = s.bind(i + 1, b.id() + "." + b.token(), SentinelPolicy.KING_CONQUEST, "R"); s.playStarted(a, "M"); live.add(a);
        }
        // warm-up then measure
        for (int r = 0; r < 20_000; r++) { var b = attempts.get(r % 500); s.heartbeat(r % 500 + 1, b.id(), b.token(), true); s.action(live.get(r % 500)); }
        int n = 200_000;
        long t0 = System.nanoTime();
        for (int r = 0; r < n; r++) { var b = attempts.get(r % 500); s.heartbeat(r % 500 + 1, b.id(), b.token(), true); }
        long hb = (System.nanoTime() - t0) / n;
        t0 = System.nanoTime();
        for (int r = 0; r < n; r++) s.action(live.get(r % 500));
        long act = (System.nanoTime() - t0) / n;
        t0 = System.nanoTime();
        for (int r = 0; r < 2_000; r++) { var b = attempts.get(r % 500); s.resolve(r % 500 + 1, b.id() + "." + b.token()); }
        long resolve = (System.nanoTime() - t0) / 2_000;
        System.out.println("SENTINEL_OVERHEAD heartbeat_ns=" + hb + " action_ns=" + act + " resolve_ns=" + resolve + " live=" + s.liveCount());
        assertTrue(hb < 50_000, "heartbeat " + hb + " ns");
        assertTrue(act < 10_000, "action " + act + " ns");
        s.close();
    }
}
