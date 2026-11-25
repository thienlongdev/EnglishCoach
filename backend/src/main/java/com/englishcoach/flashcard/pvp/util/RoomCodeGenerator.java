package com.englishcoach.flashcard.pvp.util;

import java.security.SecureRandom;

public final class RoomCodeGenerator {

    public static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public static final int CODE_LENGTH = 6;
    private static final SecureRandom RANDOM = new SecureRandom();

    private RoomCodeGenerator() {
    }

    public static String generate() {
        StringBuilder sb = new StringBuilder(CODE_LENGTH);
        for (int i = 0; i < CODE_LENGTH; i++) {
            int idx = RANDOM.nextInt(ALPHABET.length());
            sb.append(ALPHABET.charAt(idx));
        }
        return sb.toString();
    }

    public static String sanitize(String rawInput) {
        if (rawInput == null) {
            return "";
        }
        return rawInput.trim().toUpperCase().replaceAll("[^A-Z0-9]", "");
    }

    public static String formatDisplay(String sanitizedCode) {
        if (sanitizedCode == null) return "";
        return sanitize(sanitizedCode);
    }
}
