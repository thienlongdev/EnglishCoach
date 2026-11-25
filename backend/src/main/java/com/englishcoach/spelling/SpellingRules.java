package com.englishcoach.spelling;

import java.util.Locale;

/** Versioned spelling rules. Browser clocks, scores and chosen words never enter adjudication. */
public final class SpellingRules {
    private SpellingRules() {}
    public static final String VERSION = "echo-spelling-1";
    public static final int CAPACITY = 10, MAX_ROOMS = 64, MAX_TEXT = 32;
    public static final long ANSWER_MS = 15_000, SPRINT_MS = 120_000, AUDIO_GRACE_MS = 45_000;
    public static final long LEASE_MS = 35_000, ROOM_MS = 45 * 60_000;
    public enum Mode { MULTIPLAYER, ENDLESS, SPRINT, PRACTICE }
    public enum Difficulty { EASY, MEDIUM, HARD }
    public enum Phase { LOBBY, COUNTDOWN, APPROACH, LOADING_AUDIO, HEAR, SPELL, RESULT, FINISHED, ABORTED }
    public static String normalize(String text) {
        if (text == null) return "";
        String s = text.strip().toLowerCase(Locale.ROOT);
        if (s.length() > MAX_TEXT || !s.matches("[a-z]*")) throw new IllegalArgumentException("INVALID_SPELLING");
        return s;
    }
    public static int tier(Difficulty base, Mode mode, int correct, int rotation) {
        int increase = mode == Mode.PRACTICE ? 0 : (mode == Mode.MULTIPLAYER ? Math.max(0, rotation - 1) / 3 : correct / 3);
        return Math.min(2, base.ordinal() + increase);
    }
    public static int score(int letters, int tier, int streak) { return letters * (tier + 1) * 10 + Math.min(streak, 20) * 5; }
    /** Valid audible alternatives where this recording has no sense clue. Clued flower/morning stay exact. */
    public static boolean accepts(String canonical,String typed) {
        if(canonical.equals(typed))return true;
        return switch(canonical){
            case "bread" -> typed.equals("bred");
            case "lesson" -> typed.equals("lessen");
            case "cousin" -> typed.equals("cozen");
            case "yogurt" -> typed.equals("yoghurt");
            case "coconut" -> typed.equals("cocoanut");
            default -> false;
        };
    }
    public static double wpm(int letters, long elapsedMs) {
        return Math.round(letters * 12_000.0 / Math.max(250, elapsedMs) * 10) / 10.0;
    }
    public static double accuracy(int correct, int wrong) { return correct + wrong == 0 ? 0 : Math.round(1000.0 * correct / (correct + wrong)) / 10.0; }
    public static boolean terminal(Phase phase) { return phase == Phase.FINISHED || phase == Phase.ABORTED; }
}
