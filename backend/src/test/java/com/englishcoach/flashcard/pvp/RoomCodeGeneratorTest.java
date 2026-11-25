package com.englishcoach.flashcard.pvp;

import com.englishcoach.flashcard.pvp.util.RoomCodeGenerator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class RoomCodeGeneratorTest {

    @Test
    @DisplayName("Should generate 6-character codes using only unambiguous characters")
    void shouldGenerateValidCodes() {
        Set<Character> validChars = new HashSet<>();
        for (char c : RoomCodeGenerator.ALPHABET.toCharArray()) {
            validChars.add(c);
        }

        for (int i = 0; i < 100; i++) {
            String code = RoomCodeGenerator.generate();
            assertNotNull(code);
            assertEquals(RoomCodeGenerator.CODE_LENGTH, code.length());
            for (char c : code.toCharArray()) {
                assertTrue(validChars.contains(c), "Character " + c + " not in unambiguous alphabet");
            }
        }
    }

    @Test
    @DisplayName("Should sanitize input by trimming, uppercase conversion, and stripping non-alphanumeric chars")
    void shouldSanitizeInput() {
        assertEquals("ABC234", RoomCodeGenerator.sanitize("  abc-234  "));
        assertEquals("DEFGH8", RoomCodeGenerator.sanitize("def_gh#8!"));
        assertEquals("", RoomCodeGenerator.sanitize(null));
        assertEquals("", RoomCodeGenerator.sanitize("   "));
    }

    @Test
    @DisplayName("Should format 6-character code without hyphens")
    void shouldFormatDisplay() {
        assertEquals("ABCDEF", RoomCodeGenerator.formatDisplay("ABCDEF"));
        assertEquals("ABCDEF", RoomCodeGenerator.formatDisplay("abc-def"));
        assertEquals("123", RoomCodeGenerator.formatDisplay("123"));
        assertEquals("", RoomCodeGenerator.formatDisplay(null));
    }
}
