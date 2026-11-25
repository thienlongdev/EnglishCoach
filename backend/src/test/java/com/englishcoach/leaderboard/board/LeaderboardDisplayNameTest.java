package com.englishcoach.leaderboard.board;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Public names on the boards: profile name, else account name, e-mail fragments removed, distinct fallback. */
class LeaderboardDisplayNameTest {

    @Test
    @DisplayName("Profile display name wins; account name next; e-mail tokens stripped; never an address; distinct fallback")
    void publicName() {
        assertEquals("Lan", LeaderboardDisplayRepository.publicName("Lan", "Nguyen Lan", 1));
        assertEquals("Nguyen Lan", LeaderboardDisplayRepository.publicName("  ", "Nguyen Lan", 1));
        assertEquals("Test User", LeaderboardDisplayRepository.publicName(null, "Test User (learner@englishcoach.app)", 664));
        assertEquals("Minh", LeaderboardDisplayRepository.publicName("minh@example.com - Minh", null, 2));
        assertEquals("Học viên #41", LeaderboardDisplayRepository.publicName(null, "x41@example.test", 41));
        assertEquals("Học viên #7", LeaderboardDisplayRepository.publicName("", "", 7));
        assertNotEquals(LeaderboardDisplayRepository.publicName(null, null, 8), LeaderboardDisplayRepository.publicName(null, null, 9),
                "no repeated placeholder");
        assertFalse(LeaderboardDisplayRepository.publicName(null, "a@b", 3).contains("@"));
    }
}
