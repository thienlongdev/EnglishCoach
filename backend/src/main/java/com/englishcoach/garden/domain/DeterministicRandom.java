package com.englishcoach.garden.domain;

import java.nio.charset.StandardCharsets;

/**
 * Reproducible pseudo-randomness (GDD 03 §3): a 64-bit FNV-1a hash of the key finished with the MurmurHash3 fmix64
 * avalanche, mapped to [0, 1). The same key always gives the same value, so a replayed or re-evaluated action never
 * re-rolls (mutation, question order). Not for security.
 */
public final class DeterministicRandom {

    private DeterministicRandom() {}

    public static long hash(String key) {
        long h = 0xcbf29ce484222325L;
        for (byte b : key.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xff);
            h *= 0x100000001b3L;
        }
        h ^= h >>> 33;
        h *= 0xff51afd7ed558ccdL;
        h ^= h >>> 33;
        h *= 0xc4ceb9fe1a85ec53L;
        h ^= h >>> 33;
        return h;
    }

    public static double unit(String key) {
        return (hash(key) >>> 11) * 0x1.0p-53;
    }
}
